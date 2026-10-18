import crypto from 'node:crypto';
import {ApiError} from './validation.mjs';

const ACTIVE = new Set(['pending', 'delivered', 'in_progress']);
const TERMINAL = new Set(['done', 'aborted', 'failed']);
const fresh = (at, now, age) => Number.isFinite(at) && at <= now && now - at < age;

/** A single receiver owns one expiring, dashboard-authorized search at a time. */
export class DiveControl {
  constructor(now = Date.now) {
    this.now = now; this.receiver = null; this.commands = []; this.stopId = null;
  }
  /** Invalidate old commands; never retain an unclaimed maneuver for a later connection. */
  tick() {
    for (const command of this.commands.filter(c => ACTIVE.has(c.status))) {
      if (!fresh(command.heartbeat, this.now(), 5000) || !this.receiverFresh()
          || command.receiver_id !== this.receiver?.receiver_id) {
        command.cancel_requested = true;
        command.note = 'Control or receiver contact expired; landing requested';
        if (command.status !== 'in_progress') command.status = 'aborted';
      }
    }
  }
  /** Require a current control receiver rather than merely an old video frame. */
  receiverFresh() { return this.receiver && fresh(this.receiver.at, this.now(), 3000); }
  /** Return the only live command, including one waiting for confirmed cancellation. */
  active() { return this.commands.find(c => ACTIVE.has(c.status)) ?? null; }
  /** Validate receiver identity/readiness and terminate permissions on receiver replacement. */
  status(body) {
    if (!body || typeof body.receiver_id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(body.receiver_id)
        || typeof body.ready !== 'boolean' || typeof body.reason !== 'string'
        || body.reason.length > 300 || !['idle','circling','pausing','descending','searching','ascending','hovering','landing','landed','error'].includes(body.phase))
      throw new ApiError(400, 'Invalid dive receiver status');
    this.tick();
    if (this.receiver && this.receiver.receiver_id !== body.receiver_id) {
      for (const command of this.commands.filter(c => ACTIVE.has(c.status))) {
        command.status = 'aborted'; command.note = 'Receiver replaced; request a new search';
      }
    }
    this.receiver = {receiver_id:body.receiver_id,ready:body.ready,reason:body.reason,phase:body.phase,at:this.now()};
    if (body.phase === 'landed' && body.stop_id === this.stopId) this.stopId = null;
  }
  /** Explain the first unmet condition without silently enabling aircraft controls. */
  readiness(context) {
    if (!this.receiverFresh()) return 'Dive receiver offline; run scripts/Start-QrDive.ps1';
    if (context.flight_authorized===false) return 'Start BOSCO and establish the QR circle first';
    if (this.stopId) return 'Landing requested; waiting for aircraft confirmation';
    if (this.active()) return 'A search is already active';
    if (!this.receiver.ready) return this.receiver.reason;
    if (!context.video_fresh || !context.telemetry_fresh) return 'Fresh camera and telemetry are required';
    if (!context.person_detection?.fresh) return context.person_detection?.error || 'Person detector is not ready';
    return null;
  }
  /** Return progress without exposing the controlling browser's heartbeat token. */
  snapshot(context) {
    this.tick();
    const reason = this.readiness(context);
    return {ready: !reason, reason: reason || 'Ready for a controlled person search',
      receiver: this.receiverFresh() ? this.receiver : null,
      person_detection: context.person_detection, land_requested: !!this.stopId,
      commands: this.commands.slice(-20).map(({session_id, heartbeat, ...command}) => command)};
  }
  /** Create an idempotent, five-second leased search for the current receiver only. */
  enqueue(body, context) {
    this.tick();
    if (body?.type !== 'dive-surveillance') throw new ApiError(400, 'type must be dive-surveillance');
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(body.request_id ?? '')) throw new ApiError(400, 'request_id is required');
    const previous = this.commands.find(c => c.request_id === body.request_id);
    if (previous) return {id: previous.id, status: previous.status, session_id: previous.session_id};
    const reason = this.readiness(context); if (reason) throw new ApiError(409, reason);
    const height = body.target_altitude_m ?? body.floor_agl_m ?? 0.4;
    const sweep = body.sweep_deg ?? 360;
    if (typeof height !== 'number' || !Number.isFinite(height) || height < .3 || height > 2)
      throw new ApiError(400, 'target_altitude_m must be between 0.3 and 2 metres above takeoff');
    if (typeof sweep !== 'number' || !Number.isFinite(sweep) || sweep < 45 || sweep > 360)
      throw new ApiError(400, 'sweep_deg must be between 45 and 360');
    const command = {id: crypto.randomUUID(), request_id: body.request_id, session_id: crypto.randomUUID(),
      receiver_id: this.receiver.receiver_id, type: body.type,
      params: {target_altitude_m: height, sweep_deg: sweep}, status: 'pending',
      created_at: new Date(this.now()).toISOString(), heartbeat: this.now(), confirmed: false, delivered_at: null,
      acked_at: null, note: 'Waiting for the aircraft receiver', cancel_requested: false,
      person_observations: 0, sightings: []};
    this.commands.push(command); if (this.commands.length > 50) this.commands.shift();
    return {id: command.id, status: command.status, session_id: command.session_id};
  }
  /** Renew only the exact browser-owned command; polling cannot inherit ownership. */
  heartbeat(id, sessionId) {
    this.tick(); const command = this.commands.find(c => c.id === id);
    if (!command || command.session_id !== sessionId || !ACTIVE.has(command.status) || command.cancel_requested)
      throw new ApiError(409, 'Search permission expired');
    command.heartbeat = this.now(); command.confirmed = true; return {renewed: true};
  }
  /** Deliver at most one command, retrying a lost delivery to its original receiver. */
  next(receiverId) {
    this.tick();
    if (!this.receiverFresh() || receiverId !== this.receiver.receiver_id) throw new ApiError(409, 'Receiver is not registered');
    const command = this.active();
    if (!command || !command.confirmed || command.cancel_requested || command.receiver_id !== receiverId || command.status === 'in_progress') return null;
    command.status = 'delivered'; command.delivered_at ||= new Date(this.now()).toISOString();
    return {id: command.id, type: command.type, params: command.params};
  }
  /** Reject forged/out-of-order completion and retain the receiver's measured outcome. */
  ack(id, body) {
    this.tick(); const command = this.commands.find(c => c.id === id);
    if (!command) throw new ApiError(404, 'Unknown command');
    if (body.receiver_id !== command.receiver_id) throw new ApiError(409, 'Command belongs to another receiver');
    if (!['in_progress', ...TERMINAL].includes(body.status)) throw new ApiError(400, 'Invalid command status');
    if (command.status === body.status && TERMINAL.has(body.status)) return {acked: true};
    if (!ACTIVE.has(command.status) || command.status === 'pending'
        || (body.status === 'done' && (command.status !== 'in_progress' || command.cancel_requested)))
      throw new ApiError(409, 'Command transition is not allowed');
    command.status = body.status; command.acked_at = new Date(this.now()).toISOString();
    command.note = String(body.note ?? '').slice(0, 300);
    return {acked: true};
  }
  /** Request landing independently of readiness; never pretend the aircraft has landed. */
  land() {
    this.stopId = crypto.randomUUID();
    for (const command of this.commands.filter(c => ACTIVE.has(c.status))) {
      command.cancel_requested = true; command.note = 'Operator requested landing';
      if (command.status !== 'in_progress') command.status = 'aborted';
    }
    return {landing_requested: true};
  }
  /** Return a receiver-specific movement lease and the separate urgent landing signal. */
  control(receiverId, commandId, context) {
    this.tick(); const command = this.commands.find(c => c.id === commandId);
    return {authorized: !!command && command.receiver_id === receiverId && this.receiver?.receiver_id === receiverId
      && this.receiverFresh() && ACTIVE.has(command.status) && !command.cancel_requested
      && !this.stopId && context.flight_authorized!==false && !!context.person_detection?.fresh && context.video_fresh && context.telemetry_fresh,
      stop_id: this.stopId, person_detection: context.person_detection};
  }
  /** Attribute real camera observations to the current search without counting identities. */
  observePersons(capturedAtMs, persons) {
    const command = this.active();
    if (!command || command.status !== 'in_progress' || capturedAtMs < Date.parse(command.created_at)) return;
    command.person_observations += persons.length;
    if (persons.length) command.sightings.push({captured_at: new Date(capturedAtMs).toISOString(),
      count: persons.length, confidence: Math.max(...persons.map(p => p.score))});
    command.sightings = command.sightings.slice(-30);
  }
}
