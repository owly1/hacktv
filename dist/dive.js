(function (root) {
  'use strict';
  /** Own one browser-authorized dive; status polling never adopts another browser's lease. */
  class DiveDashboard {
    constructor({getJson, mode, toast, document = root.document, window = root, uuid = () => root.crypto.randomUUID()}) {
      this.getJson = getJson; this.mode = mode; this.toast = toast; this.document = document;
      this.window = window; this.uuid = uuid; this.owner = null; this.status = null;
      this.pending = false; this.polling = false; this.connectionLost = false;
    }
    /** Retrieve the dedicated panel's element without sharing simulation controls. */
    element(id) { return this.document.getElementById(id); }
    /** Show detector availability, actual phase/outcome and camera sightings as separate evidence. */
    render() {
      const status = this.status; const command = status?.commands?.at(-1);
      this.element('dive-start').disabled = this.pending || !!this.owner || this.connectionLost || this.mode() !== 'live' || !status?.ready;
      this.element('dive-height').disabled = this.pending || !!this.owner;
      this.element('dive-status').textContent = this.connectionLost ? 'Control connection unavailable; new searches blocked' :
        this.mode() !== 'live' ? 'Replay: aircraft search disabled' : status?.reason || 'Checking dive receiver and person detector…';
      const detector = status?.person_detection;
      this.element('dive-detector').textContent = detector?.fresh ? `Person detection active · ${detector.people_in_last_frame ?? 0} in the latest frame` :
        detector?.error || `Person detection: ${detector?.model_status || 'waiting'}`;
      this.element('dive-progress').textContent = command ? `${command.status} · ${status?.receiver?.phase || 'waiting'} · ${command.note || ''}` : 'No search requested';
      this.element('dive-people').textContent = command ? `${command.person_observations || 0} camera observations during this search; repeated sightings may be the same person.` :
        'Detected people will appear here. Camera observations are not verified identities.';
      const sightings = command?.sightings || [];
      this.element('dive-sightings').textContent = sightings.slice(-5).map(s => `${new Date(s.captured_at).toLocaleTimeString()}: ${s.count} visible · ${Math.round(s.confidence * 100)}% confidence`).join('\n');
    }
    /** Renew this page's exact command, retry transient loss, and stop renewing on terminal outcomes. */
    async refresh() {
      if (this.polling) return;
      this.polling = true;
      try {
        if (this.owner && this.mode() !== 'live') { await this.land(); return; }
        if (this.owner) {
          try { await this.getJson(`/api/commands/${this.owner.id}/heartbeat`, {method:'POST',body:{session_id:this.owner.session_id},timeout:1000}); }
          catch (error) { if (error.status === 409) this.owner = null; else throw error; }
        }
        const status = await this.getJson('/api/dive', {timeout:1000});
        this.status = status; this.connectionLost = false;
        if (this.owner && status.commands?.some(c => c.id === this.owner.id && ['done','aborted','failed'].includes(c.status))) this.owner = null;
      } catch (error) { this.connectionLost = true; }
      finally { this.polling = false; this.render(); }
    }
    /** Queue one explicit search and acknowledge ownership before the receiver may move. */
    async start() {
      if (this.pending || this.owner || this.mode() !== 'live' || this.connectionLost || !this.status?.ready) return;
      const target = Number(this.element('dive-height').value);
      if (!Number.isFinite(target) || target < .3 || target > 2) { this.toast('Choose a search height from 0.3 to 2 m above takeoff.'); return; }
      this.pending = true; this.render();
      try {
        const body = {type:'dive-surveillance',target_altitude_m:target,sweep_deg:360,request_id:this.uuid()};
        let command;
        try { command = await this.getJson('/api/commands',{method:'POST',body,timeout:1000}); }
        catch (error) {
          if (error.status) throw error;
          command = await this.getJson('/api/commands',{method:'POST',body,timeout:1000});
        }
        this.owner = command;
        await this.getJson(`/api/commands/${command.id}/heartbeat`,{method:'POST',body:{session_id:command.session_id},timeout:1000});
        this.toast('Person-search descent requested; watch the measured progress below.');
      } catch (error) { this.owner = null; this.toast('Search not started: ' + error.message); }
      finally { this.pending = false; await this.refresh(); }
    }
    /** Stop renewing first; failed LAND delivery must not prolong movement permission. */
    async land() {
      this.owner = null;
      try { await this.getJson('/api/dive/land',{method:'POST',body:{},timeout:1000}); this.toast('Landing requested; confirm actual touchdown.'); }
      catch (error) { this.connectionLost = true; this.toast('Landing request not confirmed: ' + error.message); }
      this.render();
    }
    /** Ignore text entry/repeats/modifiers; D starts only Live, while X requests landing. */
    key(event) {
      if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
          || event.target?.isContentEditable || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const key = String(event.key).toLowerCase();
      if (key === 'd' && this.mode() === 'live') { event.preventDefault(); return this.start(); }
      if (key === 'x') { event.preventDefault(); return this.land(); }
    }
    /** Bind visible controls and release local ownership when the controlling page exits. */
    bind() {
      this.element('dive-start').onclick = () => this.start();
      this.element('dive-land').onclick = () => this.land();
      this.window.addEventListener('keydown', event => this.key(event));
      this.window.addEventListener('pagehide', () => { this.owner = null; });
      this.render();
    }
    /** Entering Replay immediately relinquishes this page's aircraft authorization. */
    modeChanged() { if (this.owner && this.mode() !== 'live') void this.land(); this.render(); }
  }
  root.BoscoDive = DiveDashboard;
})(typeof window === 'undefined' ? globalThis : window);
