import crypto from 'node:crypto';
import {ApiError, FIRE_MARKER_PAYLOAD} from './validation.mjs';

const fresh = (at, now, age) => Number.isFinite(at) && now >= at && now-at < age;
function overlap(a, b) {
  const intersection = Math.max(0, Math.min(a[2],b[2])-Math.max(a[0],b[0])) * Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  return intersection / ((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection || 1);
}

// Volatile authorization: never restore an enabled session from storage.
export class AutonomousResponse {
  constructor(now = () => Date.now()) {
    this.now = now; this.session = null; this.receiver = null; this.target = null; this.lastFrameAt = -Infinity;
    this.accepted = new Map(); this.consumed = new Set(); this.reason = 'Autonomous response is off'; this.camera = null;
  }
  disable(reason) { this.session = null; this.camera = null; this.reason = reason; }
  tick() {
    if (this.session && (!fresh(this.session.heartbeat, this.now(), 5000) || !this.receiverFresh())) {
      this.disable('Control connection expired; landing requested');
    }
  }
  receiverFresh() { return this.receiver && fresh(this.receiver.at, this.now(), 2000); }
  status(body) {
    this.tick();
    if (!body || typeof body.receiver_id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(body.receiver_id)
        || typeof body.ready !== 'boolean' || typeof body.reason !== 'string' || body.reason.length > 300) {
      throw new ApiError(400, 'Invalid response receiver status');
    }
    if (body.position!=null && (typeof body.position!=='object' ||
        !['forward_m','right_m','width_m'].every(k=>Number.isFinite(body.position[k])&&Math.abs(body.position[k])<=10)
        || (body.position.down_m!=null&&(!Number.isFinite(body.position.down_m)||Math.abs(body.position.down_m)>10)))) {
      throw new ApiError(400,'Invalid tracked fire position');
    }
    if (this.receiver && this.receiver.receiver_id !== body.receiver_id) this.disable('Receiver restarted; enable a new session');
    this.receiver = {receiver_id: body.receiver_id, ready: body.ready, reason: body.reason,
      phase: String(body.phase ?? 'waiting').slice(0,40), at: this.now(), position: body.position ?? null,
      camera_ready: body.camera_ready === true,short_test:body.short_test===true};
    if (this.session?.mission && ['landed','error'].includes(this.receiver.phase)) this.disable('Flight finished; enable a new session when ready');
    this.tick(); return this.snapshot();
  }
  control(body) {
    this.tick();
    if (body?.action === 'disable' || body?.action === 'land') {
      this.disable('Operator requested landing and disabled autonomous response');
    } else if (body?.action === 'camera') {
      if (this.session || !this.receiverFresh() || !this.receiver.camera_ready)
        throw new ApiError(409,'Camera preview requires a connected, stationary drone with autonomous response OFF');
      if (![0,-45,-70].includes(body.pitch_deg)) throw new ApiError(400,'Select level, down 45°, or down 70°');
      this.camera={id:crypto.randomUUID(),pitch_deg:body.pitch_deg,at:this.now(),receiver_id:this.receiver.receiver_id};
    } else if (body?.action === 'enable') {
      if (this.session) throw new ApiError(409,'An autonomous session is already enabled');
      if (!this.receiverFresh() || !this.receiver.ready) throw new ApiError(409,this.receiver?.reason || 'Response receiver is offline');
      this.session = {id: crypto.randomUUID(), enabled_at: this.now(), heartbeat: this.now(), mission: null};
      this.target = null; this.camera = null; this.reason = 'Waiting for a newly confirmed fire';
    } else if (body?.action === 'heartbeat') {
      if (!this.session || body.session_id !== this.session.id) throw new ApiError(409,'Session expired');
      this.session.heartbeat = this.now();
    } else throw new ApiError(400,'Use enable, disable, land, camera or heartbeat');
    return this.snapshot();
  }
  incident(record) {
    if (record.label !== 'fire') return;
    this.accepted.set(record.episode_id, {at:this.now(), id:record.id, source:record.source});
    for (const [id,value] of this.accepted) if (!fresh(value.at,this.now(),15000)) this.accepted.delete(id);
  }
  observe(body) {
    const now=this.now(), at=Date.parse(body?.captured_at);
    if (!fresh(at,now,1500) || !Number.isInteger(body?.width) || !Number.isInteger(body?.height)
        || body.width<32 || body.width>3840 || body.height<32 || body.height>2160) throw new ApiError(400,'Invalid or stale target frame');
    if (at <= this.lastFrameAt) return;
    const h=body.hit;
    if (h == null) { this.lastFrameAt=at; this.target=null; return; }
    if (h.label!=='fire' || !['yolo','qr-test'].includes(h.source)
        || !Number.isFinite(h.confidence) || h.confidence<.65 || h.confidence>1
        || (h.source==='qr-test' && h.qr_text!==FIRE_MARKER_PAYLOAD)
        || !Array.isArray(h.bbox) || h.bbox.length!==4 || !h.bbox.every(x=>Number.isFinite(x)&&x>=0&&x<=1)
        || h.bbox[2]<=h.bbox[0] || h.bbox[3]<=h.bbox[1]
        || (body.episode_id!=null && !/^[A-Za-z0-9_-]{4,64}$/.test(body.episode_id))) throw new ApiError(400,'Invalid fire target');
    let corners;
    if (h.qr_corners!=null) {
      if (h.source!=='qr-test' || !Array.isArray(h.qr_corners) || h.qr_corners.length!==4 ||
          !h.qr_corners.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)
            &&p[0]>=0&&p[0]<body.width&&p[1]>=0&&p[1]<body.height))
        throw new ApiError(400,'Invalid QR image corners');
      corners=h.qr_corners.map(p=>[...p]);
    }
    this.lastFrameAt=at;
    const previous=this.target;
    const continuous=previous && previous.source===h.source && previous.episode_id===body.episode_id
      && fresh(previous.at,at,600) && overlap(previous.bbox,h.bbox)>=.1;
    this.target={at,captured_at:body.captured_at,width:body.width,height:body.height,
      source:h.source,bbox:h.bbox,confidence:h.confidence,episode_id:body.episode_id,qr_corners:corners,
      hits:continuous?previous.hits+1:1, first:continuous?previous.first:at};
  }
  candidate() {
    const t=this.target, s=this.session, accepted=this.accepted.get(t?.episode_id);
    if (!s || !t || !fresh(t.at,this.now(),1000) || t.hits<5 || t.at-t.first<800
        || t.first<s.enabled_at || !accepted || accepted.source!==t.source || !fresh(accepted.at,this.now(),7000)) return null;
    if (s.mission && s.mission.episode_id!==t.episode_id) return null;
    return {...t,incident_id:accepted.id};
  }
  claim(body) {
    this.tick(); const t=this.candidate(), s=this.session;
    if (!s || body?.session_id!==s.id || body?.receiver_id!==this.receiver?.receiver_id || !t
        || body.episode_id!==t.episode_id || s.mission || this.consumed.has(t.episode_id)) throw new ApiError(409,'No fresh unconsumed fire is authorized');
    s.mission={id:crypto.randomUUID(),episode_id:t.episode_id}; this.consumed.add(t.episode_id);
    this.reason='Responding to confirmed fire'; return this.snapshot();
  }
  snapshot() {
    this.tick(); const s=this.session;
    return {enabled:!!s,session_id:s?.id??null,mission:s?.mission??null,reason:this.reason,
      receiver:this.receiverFresh()?this.receiver:null,target:this.candidate(),
      observed_target:this.target && fresh(this.target.at,this.now(),1000)?this.target:null,
      camera:!s && this.receiverFresh() && this.camera && fresh(this.camera.at,this.now(),5000)?this.camera:null,
      radius_m:1,height_m:1,flight_seconds:this.receiverFresh()&&this.receiver.short_test?60:300,
      min_start_battery_pct:this.receiverFresh()&&this.receiver.short_test?30:40,
      min_flight_battery_pct:this.receiverFresh()&&this.receiver.short_test?25:40};
  }
}
