/* Historical-case scouting is a browser-only illustration. All locations,
   people and flight below are simulated; nothing is sent to live ingest. */
(function (root) {
  const RAD = Math.PI / 180, START = 8, SPEED = 9;
  /** Make repeatable replay randomness from a per-session unsigned seed. */
  function random(seed) {
    let n = seed >>> 0;
    return () => { n += 0x6D2B79F5; let v = n; v = Math.imul(v ^ v >>> 15, v | 1); v ^= v + Math.imul(v ^ v >>> 7, v | 61); return ((v ^ v >>> 14) >>> 0) / 4294967296; };
  }
  /** Convert metres east/north of the historical ignition to map coordinates. */
  function ll(scene, e, n) {
    return [scene.lat + n / 111320, scene.lon + e / (111320 * Math.cos(scene.lat * RAD))];
  }
  /** Choose 3–7 fictional people within the initial rendered fire footprint. */
  function create(fire, seed = Math.floor(Math.random() * 4294967296), startedAt = Date.now()) {
    const rng = random(seed), targets = [], count = 3 + Math.floor(rng() * 5), angle = fire.directionDeg * RAD;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2 + (rng() - .5) * .35;
      const u = 40.5 + Math.cos(a) * (22 + rng() * 12), v = Math.sin(a) * (12 + rng() * 6);
      const e = u * Math.sin(angle) + v * Math.cos(angle), n = u * Math.cos(angle) - v * Math.sin(angle);
      targets.push({id: `scout-${seed}-${i + 1}`, number: i + 1, e, n, samples: [], acknowledged: null, closed: null});
    }
    return {seed, lat: fire.lat, lon: fire.lon, targets, startedAt, sampled: -1, elapsed: 0, initialBattery: fire.drone?.telemetry.battery_pct ?? 90};
  }
  /** Build an ingress and a short orbit at each person; units are metres and seconds. */
  function route(scene, anchor) {
    const points = [{e: anchor.e, n: anchor.n, at: START}], holds = [];
    let at = START, last = points[0];
    for (const target of scene.targets) {
      const next = {e: target.e + 18, n: target.n, target};
      at += Math.hypot(next.e - last.e, next.n - last.n) / SPEED;
      next.at = at; points.push(next); holds.push({from: at, until: at + 9, target}); at += 9; last = next;
    }
    return {points, holds, end: at};
  }
  /** Return the single camera/map/telemetry pose, entering the fire in simulation only. */
  function pose(scene, t, anchor) {
    if (t < START) return null;
    const path = route(scene, anchor);
    let prev = path.points[0], e = prev.e, n = prev.n, focus = scene.targets[0], phase = 'Entering fire · simulated', moving = true;
    for (let i = 1; i < path.points.length; i++) {
      const next = path.points[i], depart = i === 1 ? START : prev.at + 9;
      phase = i === 1 ? 'Entering fire · simulated' : 'Scouting people · simulated';
      focus = next.target;
      if (t < next.at) {
        const k = Math.max(0, Math.min(1, (t - depart) / (next.at - depart)));
        e = prev.e + (next.e - prev.e) * k; n = prev.n + (next.n - prev.n) * k; break;
      }
      if (t < next.at + 9 || i === path.points.length - 1) {
        moving = false;
        const a = Math.max(0, t - next.at) / 9 * Math.PI * 2;
        e = focus.e + 18 * Math.cos(a); n = focus.n + 18 * Math.sin(a);
        phase = t < path.end ? 'Scouting people · simulated' : 'Rechecking people · simulated'; break;
      }
      prev = next;
    }
    const alt = Math.min(85, anchor.alt + (t - START) * 2), de = focus.e - e, dn = focus.n - n;
    const [lat, lon] = ll(scene, e, n);
    return {e, n, lat, lon, alt, heading: (Math.atan2(de, dn) / RAD + 360) % 360,
      pitch: Math.atan2(alt, Math.hypot(de, dn)) / RAD, phase,
      range: Math.hypot(e, n), battery: Math.max(15, scene.initialBattery - t / 40),
      speed: moving ? SPEED : 18 * Math.PI * 2 / 9,
      climbRate: alt < 85 ? 2 : 0};
  }
  /** Project a fictional person through the same 69-degree camera used by the replay. */
  function visible(p, target) {
    const yaw = p.heading * RAD, pitch = p.pitch * RAD, de = target.e - p.e, dn = target.n - p.n;
    const forward = (de * Math.sin(yaw) + dn * Math.cos(yaw)) * Math.cos(pitch) + p.alt * Math.sin(pitch);
    if (forward <= 0) return null;
    const right = de * Math.cos(yaw) - dn * Math.sin(yaw);
    const up = (de * Math.sin(yaw) + dn * Math.cos(yaw)) * Math.sin(pitch) - p.alt * Math.cos(pitch);
    const tan = Math.tan(69 * RAD / 2), u = .5 + right / (forward * 2 * tan), v = .5 - up / (forward * 2 * tan * 540 / 960);
    return u > .04 && u < .96 && v > .08 && v < .92 && Math.hypot(de, dn) < 180 ? {u, v} : null;
  }
  /** Record only people visible from the moving simulated camera, once each second. */
  function observe(scene, t, anchor) {
    for (let s = scene.sampled + 1; s <= Math.floor(t); s++) {
      const p = pose(scene, s, anchor); if (!p) continue;
      for (const target of scene.targets) if (visible(p, target)) {
        const az = (Math.atan2(target.e - p.e, target.n - p.n) / RAD + 360) % 360;
        target.samples.push({t: s, az, range: Math.hypot(target.e - p.e, target.n - p.n)});
      }
    }
    scene.sampled = Math.max(scene.sampled, Math.floor(t));
  }
  /** Format session-owned fictional leads using the existing dashboard card contract. */
  function snapshot(scene, t, anchor) {
    observe(scene, t, anchor);
    const p = pose(scene, t, anchor), time = s => new Date(scene.startedAt + s * 1000).toISOString();
    const leads = scene.targets.filter(x => x.samples.length).map(target => {
      const samples = target.samples, last = samples.at(-1), [latitude, longitude] = ll(scene, target.e, target.n);
      const angles = [...new Set(samples.map(s => Math.round(s.az / 30) * 30 % 360))];
      const span = Math.max(0, ...angles.flatMap(a => angles.map(b => Math.min(Math.abs(a-b), 360-Math.abs(a-b)))));
      const multi = angles.length >= 2 && span >= 35;
      const accuracy = Math.max(3, Math.round(12 / Math.sqrt(samples.length)));
      return {id: target.id, number: target.number, title: `${multi ? 'Possible person' : 'Candidate'} — Target ${target.number}`,
        latitude, longitude, uncertainty: {major_95_m: accuracy, minor_95_m: accuracy, bearing_deg: 0, method: 'illustrative simulated uncertainty'},
        status: target.closed ? 'closed' : multi ? 'possible-person' : 'needs-another-view', status_text: 'Simulated camera sighting',
        first_seen_at: time(samples[0].t), last_seen_at: time(last.t), last_seen_age_s: Math.round(t - last.t),
        views: angles.length, angle_span_deg: span, view_azimuths_deg: angles, sensors: ['visible'], observations: samples.length,
        movement: {status: 'stationary', detail: 'Simulated person at a fixed location'}, missed_looks: 0,
        delayed: {any: false, max_delay_s: 0}, fire_distance_m: Math.round(Math.hypot(target.e, target.n)),
        fire_arrival: {minutes: 0, basis: 'inside the simulated fire footprint'}, at_fire: !target.closed,
        priority: {tier: target.closed ? 9 : 0, base_tier: multi ? 2 : 4, reasons: ['SIMULATED: fictional person for presentation']},
        acknowledged: target.acknowledged, closed: target.closed, provenance: 'demo-simulated', next_look: null,
        evidence: samples.slice(-6).reverse().map((s, i) => ({id: `${target.id}-${s.t}`, at: time(s.t), sensor: 'visible', from: 'camera',
          view_az_deg: s.az, range_m: Math.round(s.range), individual_95_m: accuracy, crop: false, latitude, longitude})),
      };
    });
    const open = leads.filter(l => !l.closed);
    return {simulated: true, historical_scout: true, t, duration_s: route(scene, anchor).end + 30, leads,
      counts: {open: open.length, possible_people: open.filter(l => l.views >= 2).length, unacknowledged: open.filter(l => !l.acknowledged).length},
      coverage: {cells: []},
      mission: {mode: 'survey', phase: 'scout', link: 'up', stored: 0,
        log: [{at: time(t), text: `SIMULATED: ${p?.phase || 'Confirming fire'}; ${leads.length} people spotted.`},
          ...leads.map(l => ({at: l.first_seen_at, text: `Simulated Target ${l.number} seen by ANAFI-01 inside the fire.`}))]},
    };
  }
  /** Keep acknowledgement/closure local to this fictional case, never live ingest. */
  function action(scene, id, kind, by, outcome) {
    const target = scene.targets.find(x => x.id === id);
    if (!target || !by.trim()) throw new Error('A named responder and known target are required');
    const record = {by: by.trim(), at: new Date().toISOString()};
    if (kind === 'ack') target.acknowledged = record;
    else if (kind === 'close' && ['found', 'not-a-person', 'duplicate', 'handed-off'].includes(outcome)) target.closed = {...record, outcome};
    else throw new Error('Choose a supported lead action');
  }
  root.BoscoScout = {START, create, pose, visible, snapshot, action};
})(globalThis);
