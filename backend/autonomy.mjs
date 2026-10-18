import crypto from 'node:crypto';
import {ApiError, FIRE_MARKER_PAYLOAD, FIRE_MARKER_DETAILS, FIRE_MARKER_PAYLOADS,
  TINY_FIRE_MARKER_PAYLOAD, TINY_FIRE_MARKER_DETAILS} from './validation.mjs';
import {OUTDOOR_CONTOUR_PROFILE,OUTDOOR_CONTOUR_DETAILS,matchesOutdoorDetails,
  measuredContourWeather} from './contour-profile.mjs';

/** Recover the allowlisted marker identity from an accepted incident's scenario. */
function markerIdentity(details) {
  return [[FIRE_MARKER_PAYLOAD,FIRE_MARKER_DETAILS],[TINY_FIRE_MARKER_PAYLOAD,TINY_FIRE_MARKER_DETAILS]]
    .find(([,expected])=>Object.entries(expected).every(([key,value])=>details?.[key]===value))?.[0];
}

/** Sanitize the receiver's fixed GPS anchor; this is reporting, never a waypoint API. */
function contourStatus(value, mission) {
  // A status request may race LAND/expiry; acknowledge the receiver while
  // dropping its old plan instead of obscuring the authoritative disable.
  if (value==null || !mission?.contour) return null;
  const anchor=value.anchor;
  const weather=measuredContourWeather(value);
  if (!anchor || anchor.position_source!=='gps'
      || !Number.isFinite(anchor.latitude) || Math.abs(anchor.latitude)>90
      || !Number.isFinite(anchor.longitude) || Math.abs(anchor.longitude)>180
      || value.forecast_minutes!==5 || value.started_at!==mission.contour.started_at
      || value.profile!==OUTDOOR_CONTOUR_PROFILE || mission.contour.profile!==OUTDOOR_CONTOUR_PROFILE
      || !matchesOutdoorDetails(value.details) || !weather
      || !Number.isFinite(value.speed_mps) || value.speed_mps<0 || value.speed_mps>1)
    throw new ApiError(400,'Invalid GPS contour status');
  return {anchor:{latitude:anchor.latitude,longitude:anchor.longitude,position_source:'gps'},
    profile:OUTDOOR_CONTOUR_PROFILE,forecast_minutes:5,started_at:value.started_at,
    details:{...OUTDOOR_CONTOUR_DETAILS},marker_details:{...TINY_FIRE_MARKER_DETAILS},
    speed_mps:value.speed_mps,...weather};
}

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
  // Match the Pi control watchdog: two approximately one-second HTTP timeouts
  // may recover, but three seconds without receiver contact ends permission.
  receiverFresh() { return this.receiver && fresh(this.receiver.at, this.now(), 3000); }
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
    if (body.localization_sources!=null && (!Array.isArray(body.localization_sources)
        || body.localization_sources.some(source=>!['qr-test','yolo'].includes(source))))
      throw new ApiError(400,'Invalid fire localization sources');
    if (body.blocked_source!=null && !['qr-test','yolo'].includes(body.blocked_source))
      throw new ApiError(400,'Invalid blocked fire source');
    if (body.qr_scale_mode!=null && !['measured','adaptive'].includes(body.qr_scale_mode))
      throw new ApiError(400,'Invalid QR scale mode');
    if (['contour_supported','contour_ready','airborne_search_supported'].some(key=>body[key]!=null && typeof body[key]!=='boolean')
        || (body.contour_reason!=null && (typeof body.contour_reason!=='string' || body.contour_reason.length>300)))
      throw new ApiError(400,'Invalid contour receiver readiness');
    const c=body.calibration;
    if (c!=null && (typeof c!=='object' || Array.isArray(c)
        || Object.keys(c).some(k=>!['qr_side_m','offset_body_m','image_size','rms_px','qr_verified','profile_verified'].includes(k))
        || (!(body.qr_scale_mode==='adaptive' && c.qr_side_m===null)
          && (!Number.isFinite(c.qr_side_m) || c.qr_side_m<.03 || c.qr_side_m>.6))
        || !Array.isArray(c.offset_body_m) || c.offset_body_m.length!==3
        || !c.offset_body_m.every(Number.isFinite) || Math.hypot(...c.offset_body_m)>.3
        || !Array.isArray(c.image_size) || c.image_size.length!==2
        || !c.image_size.every(Number.isInteger) || c.image_size[0]<32 || c.image_size[0]>3840
        || c.image_size[1]<32 || c.image_size[1]>2160
        || !Number.isFinite(c.rms_px) || c.rms_px<0 || c.rms_px>10
        || typeof c.qr_verified!=='boolean' || ![null,true,false].includes(c.profile_verified)))
      throw new ApiError(400,'Invalid receiver calibration summary');
    if (this.receiver && this.receiver.receiver_id !== body.receiver_id) this.disable('Receiver restarted; enable a new session');
    const contour=contourStatus(body.contour,this.session?.mission);
    this.receiver = {receiver_id: body.receiver_id, ready: body.ready, reason: body.reason,
      phase: String(body.phase ?? 'waiting').slice(0,40), at: this.now(), position: body.position ?? null,
      camera_ready: body.camera_ready === true,short_test:body.short_test===true,
      localization_sources:body.localization_sources??null,blocked_source:body.blocked_source??null,
      qr_scale_mode:body.qr_scale_mode??'measured',
      lap_seconds:body.lap_seconds===15?15:null,
      calibration:c?{...c,offset_body_m:[...c.offset_body_m],image_size:[...c.image_size]}:null,
      camera_search_supported:body.camera_search_supported===true,
      contour_supported:body.contour_supported===true,contour_ready:body.contour_ready===true,
      contour_profile:body.contour_profile===OUTDOOR_CONTOUR_PROFILE?OUTDOOR_CONTOUR_PROFILE:null,
      wind_reason:typeof body.wind_reason==='string'?body.wind_reason.slice(0,300):'Aircraft wind estimate unavailable',
      airborne_search_supported:body.airborne_search_supported===true,
      contour_reason:body.contour_reason??'This receiver does not support GPS contour flight',
      contour,
      search_state:['scanning','airborne-search','acquiring','tracking','holding','error'].includes(body.search_state)?body.search_state:'off'};
    if (this.session && (body.aircraft_connected===false || (!this.session.mission && !this.session.search && !body.ready)))
      this.disable('Aircraft disconnected or preflight no longer ready; start BOSCO again when ready');
    if (this.session && (this.receiver.phase==='error' || this.receiver.search_state==='error' || ((this.session.mission || this.session.search) && this.receiver.phase==='landed')))
      this.disable('Response stopped; enable a new session when ready');
    this.tick(); return this.snapshot();
  }
  control(body) {
    this.tick();
    if (body?.action === 'disable' || body?.action === 'land') {
      this.disable('Operator requested landing and disabled autonomous response');
    } else if (body?.action === 'camera') {
      if (this.session || !this.receiverFresh() || !this.receiver.camera_ready)
        throw new ApiError(409,'Camera preview requires a connected, stationary drone with autonomous response OFF');
      if (![0,-30,-45,-55,-70].includes(body.pitch_deg)) throw new ApiError(400,'Select level, down 30°, down 45°, down 55°, or down 70°');
      this.camera={id:crypto.randomUUID(),pitch_deg:body.pitch_deg,at:this.now(),receiver_id:this.receiver.receiver_id};
    } else if (body?.action === 'enable') {
      const mode=body.mode??'circle';
      if (!['circle','contour'].includes(mode)) throw new ApiError(400,'Select circle or contour response mode');
      if (body.camera_search!=null && typeof body.camera_search!=='boolean') throw new ApiError(400,'camera_search must be boolean');
      if (this.session) throw new ApiError(409,'An autonomous session is already enabled');
      if (!this.receiverFresh() || !this.receiver.ready) throw new ApiError(409,this.receiver?.reason || 'Response receiver is offline');
      if (mode==='contour' && (!this.receiver.contour_supported || !this.receiver.contour_ready))
        throw new ApiError(409,this.receiver.contour_reason || 'GPS contour flight is not ready');
      if (mode==='contour' && !this.receiver.airborne_search_supported)
        throw new ApiError(409,'Update the receiver to support airborne contour search');
      if (mode==='contour' && this.receiver.contour_profile!==OUTDOOR_CONTOUR_PROFILE)
        throw new ApiError(409,'Update the receiver for the outdoor 50 m live-wind course');
      if (body.camera_search && (!this.receiver.camera_ready || !this.receiver.camera_search_supported))
        throw new ApiError(409,'Automatic camera search is not ready on this receiver');
      this.session = {id: crypto.randomUUID(), enabled_at: this.now(), heartbeat: this.now(), mission: null, search: null,
        heartbeat_confirmed:false,camera_search:body.camera_search===true,mode};
      this.target = null; this.camera = null;
      this.consumed.clear(); // A deliberate new session authorizes one new response, including to the same QR.
      this.reason = mode==='contour'?'Takeoff authorized for one drone to search at 1 m':
        body.camera_search?'BOSCO is searching; a confirmed fire will trigger takeoff':'Waiting for a newly confirmed fire';
    } else if (body?.action === 'heartbeat') {
      if (!this.session || body.session_id !== this.session.id) throw new ApiError(409,'Session expired');
      this.session.heartbeat = this.now();
      this.session.heartbeat_confirmed = true;
    } else throw new ApiError(400,'Use enable, disable, land, camera or heartbeat');
    return this.snapshot();
  }
  incident(record) {
    if (record.label !== 'fire') return;
    this.accepted.set(record.episode_id, {at:this.now(), id:record.id, source:record.source,
      qr_text:record.source==='qr-test'?markerIdentity(record.details):undefined});
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
        || (h.source==='qr-test' && !FIRE_MARKER_PAYLOADS.includes(h.qr_text))
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
    const tracked=['optical-flow','visual-template'].includes(h.qr_tracking);
    const template=h.qr_tracking==='visual-template', mission=this.session?.mission;
    if (h.qr_tracking!=null && !['decoded','optical-flow','visual-template'].includes(h.qr_tracking)) throw new ApiError(400,'Invalid QR tracking method');
    if (h.qr_tracking==='optical-flow' && (h.source!=='qr-test' || !corners || !fresh(h.qr_decoded_at,at,2501)))
      throw new ApiError(400,'Visual QR tracking requires a recent decode and current corners');
    if (template && (h.source!=='qr-test' || !corners || !mission
        || mission.episode_id!==body.episode_id || mission.source!=='qr-test'
        || mission.qr_text!==h.qr_text
        || !fresh(h.qr_decoded_at,at,300001) || h.qr_decoded_at<mission.qr_seed_at
        || !fresh(mission.last_visual_at,at,15000)
        || !Number.isFinite(h.qr_template_score) || h.qr_template_score<.85 || h.qr_template_score>1
        || !Number.isFinite(h.qr_template_data_score) || h.qr_template_data_score<.65 || h.qr_template_data_score>1
        || !Number.isFinite(h.qr_template_module_error) || h.qr_template_module_error<0 || h.qr_template_module_error>.055
        || !Number.isFinite(h.qr_template_module_coverage) || h.qr_template_module_coverage<.55 || h.qr_template_module_coverage>1))
      throw new ApiError(400,'QR template tracking requires a claimed matching fire and fresh verified visual evidence');
    this.lastFrameAt=at;
    const previous=this.target;
    const continuous=previous && previous.source===h.source && previous.episode_id===body.episode_id
      && (h.source!=='qr-test' || previous.qr_text===h.qr_text)
      && (!this.session || previous.first>=this.session.enabled_at)
      && fresh(previous.at,at,600) && overlap(previous.bbox,h.bbox)>=.1;
    this.target={at,captured_at:body.captured_at,width:body.width,height:body.height,
      source:h.source,bbox:h.bbox,confidence:h.confidence,episode_id:body.episode_id,qr_corners:corners,
      qr_text:h.source==='qr-test'?h.qr_text:undefined,
      qr_tracking:h.qr_tracking??'decoded',qr_decoded_at:h.qr_decoded_at,
      qr_template_score:template?h.qr_template_score:undefined,
      qr_template_data_score:template?h.qr_template_data_score:undefined,
      qr_template_module_error:template?h.qr_template_module_error:undefined,
      qr_template_module_coverage:template?h.qr_template_module_coverage:undefined,
      hits:continuous?previous.hits+(tracked?0:1):(tracked?0:1), first:continuous?previous.first:at};
    if (mission && mission.episode_id===body.episode_id && mission.source===h.source
        && (h.source!=='qr-test' || mission.qr_text===h.qr_text) && h.qr_tracking!=='optical-flow')
      mission.last_visual_at=at;
  }
  candidate() {
    const t=this.target, s=this.session, accepted=this.accepted.get(t?.episode_id);
    // Receiving enable's response and renewing that exact session is part of
    // authorization. A lost enable reply must never create an ownerless flight.
    if (!s || !s.heartbeat_confirmed || !t || !fresh(t.at,this.now(),1000)) return null;
    // Contour authorization is bounded to the explicit tiny scenario. The
    // original Alpha/RGB circle remains independent of this new restriction.
    if (s.mode==='contour' && (t.source!=='qr-test' || t.qr_text!==TINY_FIRE_MARKER_PAYLOAD)) return null;
    if (s.mission) {
      if (s.mission.episode_id!==t.episode_id || s.mission.source!==t.source || t.at<s.mission.target_at) return null;
      if (t.source==='qr-test' && s.mission.qr_text!==t.qr_text) return null;
      if (t.qr_tracking==='optical-flow' && !fresh(t.qr_decoded_at,this.now(),2501)) return null;
      if (t.qr_tracking==='visual-template' && !fresh(t.qr_decoded_at,this.now(),300001)) return null;
      return {...t,incident_id:s.mission.incident_id};
    }
    if (['optical-flow','visual-template'].includes(t.qr_tracking) || t.hits<5 || t.at-t.first<800
        || t.first<s.enabled_at || !accepted || accepted.source!==t.source || !fresh(accepted.at,this.now(),7000)) return null;
    if (s.mode==='contour' && accepted.qr_text!==t.qr_text) return null;
    if (t.source==='qr-test' && accepted.qr_text && accepted.qr_text!==t.qr_text) return null;
    return {...t,incident_id:accepted.id};
  }
  claim(body) {
    this.tick(); const s=this.session;
    if (body?.stage!=null && !['search','fire'].includes(body.stage))
      throw new ApiError(400,'Select search or fire claim stage');
    if (body?.stage==='search') return this.claimSearch(body);
    const t=this.candidate();
    if (!s || body?.session_id!==s.id || body?.receiver_id!==this.receiver?.receiver_id || !t
        || body.episode_id!==t.episode_id) throw new ApiError(409,'No fresh unconsumed fire is authorized');
    if (s.mode==='contour' && (!this.receiver.contour_supported || !this.receiver.airborne_search_supported
        || s.search?.receiver_id!==body.receiver_id))
      throw new ApiError(409,'Claim the airborne search before its contour fire');
    if (s.mission) {
      // A reply can disappear after committing a claim. Return that same
      // authorization to its owner; never mint another mission on retry.
      if (s.mission.receiver_id===body.receiver_id && s.mission.episode_id===body.episode_id
          && s.mission.source===t.source) return this.snapshot();
      throw new ApiError(409,'No fresh unconsumed fire is authorized');
    }
    if (this.consumed.has(t.episode_id)) throw new ApiError(409,'No fresh unconsumed fire is authorized');
    s.mission={id:crypto.randomUUID(),episode_id:t.episode_id,source:t.source,incident_id:t.incident_id,
      mode:s.mode,qr_text:t.qr_text,
      ...(s.mode==='contour'?{contour:{profile:OUTDOOR_CONTOUR_PROFILE,forecast_minutes:5,started_at:this.now(),
        details:{...OUTDOOR_CONTOUR_DETAILS},marker_details:{...TINY_FIRE_MARKER_DETAILS}}}:{}),
      receiver_id:body.receiver_id,claimed_at:this.now(),target_at:t.at,qr_seed_at:t.qr_decoded_at??t.at,last_visual_at:t.at}; this.consumed.add(t.episode_id);
    this.reason='Responding to confirmed fire'; return this.snapshot();
  }
  /** Grant one receiver takeoff/search ownership after the controlling page acknowledges enable. */
  claimSearch(body) {
    const s=this.session,r=this.receiver;
    if (!s || s.mode!=='contour' || !s.heartbeat_confirmed || body.session_id!==s.id
        || !this.receiverFresh() || body.receiver_id!==r.receiver_id
        || !r.contour_supported || !r.airborne_search_supported || r.contour_profile!==OUTDOOR_CONTOUR_PROFILE)
      throw new ApiError(409,'No airborne search is authorized');
    // Retrying a lost reply must retain the same flight, even after takeoff.
    if (s.search?.receiver_id===body.receiver_id) return this.snapshot();
    if (!r.ready || !r.contour_ready || s.mission)
      throw new ApiError(409,r.contour_reason || 'GPS contour search is not ready');
    s.search={id:crypto.randomUUID(),receiver_id:body.receiver_id,claimed_at:this.now(),height_m:1};
    this.reason='One drone taking off to search for Marker 2 at 1 m';
    return this.snapshot();
  }
  waitingReason() {
    const s=this.session,t=this.target;
    if (!s || s.mission) return null;
    if (!s.heartbeat_confirmed) return 'Waiting for the controlling dashboard to acknowledge this session';
    if (s.mode==='contour' && !s.search) return 'Checking GPS and takeoff readiness for one drone to search at 1 m';
    if (!t || !fresh(t.at,this.now(),1000)) return 'Searching for a fresh fire observation';
    if (s.mode==='contour' && (t.source!=='qr-test' || t.qr_text!==TINY_FIRE_MARKER_PAYLOAD))
      return 'Contour mode requires Marker 2 (Tiny), selecting the 50 m outdoor fire; Alpha remains available with circular response';
    if (s.mode==='contour' && !s.search && !this.receiver?.contour_ready)
      return this.receiver?.contour_reason || 'Waiting for accurate GPS for contour flight';
    if (t.qr_tracking!=='decoded') return s.search?'Waiting for an exact QR decode to anchor the contour':'Waiting for an exact QR decode before takeoff';
    if (t.first<s.enabled_at) return 'Waiting for fresh observations captured after this session started';
    if (t.hits<5 || t.at-t.first<800) return `Confirming fire: ${Math.min(t.hits,5)}/5 fresh observations over at least 0.8 seconds`;
    const accepted=this.accepted.get(t.episode_id);
    if (!accepted || accepted.source!==t.source || !fresh(accepted.at,this.now(),7000))
      return 'Fire detected; waiting for its incident record to be accepted';
    if (s.mode==='contour' && accepted.qr_text!==t.qr_text)
      return 'Waiting for the matching Tiny fire incident record';
    return s.search?'Marker 2 confirmed; measuring its location and using the best available wind input':
      'Fire confirmed; checking measured position and takeoff readiness';
  }
  snapshot() {
    this.tick(); const s=this.session;
    return {enabled:!!s,session_id:s?.id??null,mission:s?.mission??null,search:s?.search??null,reason:this.reason,
      mode:s?.mode??'circle',
      fire_presence:s?.mission?{episode_id:s.mission.episode_id,last_seen_at:s.mission.last_visual_at,
        expires_at:s.mission.last_visual_at+15000,present:fresh(s.mission.last_visual_at,this.now(),15000)}:null,
      waiting_reason:this.waitingReason(),
      camera_search:!!s?.camera_search,
      receiver:this.receiverFresh()?this.receiver:null,target:this.candidate(),
      observed_target:this.target && fresh(this.target.at,this.now(),1000)?this.target:null,
      camera:!s && this.receiverFresh() && this.camera && fresh(this.camera.at,this.now(),5000)?this.camera:null,
      radius_m:1,height_m:1,
      lap_seconds:this.receiverFresh()?this.receiver.lap_seconds:null,
      flight_seconds:this.receiverFresh()&&this.receiver.short_test?60:s?.mode==='contour'?null:300,
      min_start_battery_pct:this.receiverFresh()&&this.receiver.short_test?30:40,
      min_flight_battery_pct:this.receiverFresh()&&this.receiver.short_test?25:40};
  }
}
