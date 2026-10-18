/* Historical-case scouting is a browser-only illustration. All locations,
   people and flight below are simulated; nothing is sent to live ingest. */
(function (root) {
  const RAD = Math.PI / 180, START = 8, SLOT = 48, DESCENT = 18, SEARCH = 8;
  const COLORS = ['#61d6cc', '#eebf66', '#a8a4ff', '#f18dac'];
  /** Make repeatable replay randomness from a per-session unsigned seed. */
  function random(seed) {
    let n = seed >>> 0;
    return () => { n += 0x6D2B79F5; let v = n; v = Math.imul(v ^ v >>> 15, v | 1); v ^= v + Math.imul(v ^ v >>> 7, v | 61); return ((v ^ v >>> 14) >>> 0) / 4294967296; };
  }
  /** Convert metres east/north of the historical ignition to map coordinates. */
  function ll(scene, e, n) {
    return [scene.lat + n / 111320, scene.lon + e / (111320 * Math.cos(scene.lat * RAD))];
  }
  /** Match the camera/map's growing ellipse, in metres from the ignition. */
  function boundary(scene, t, angle, offset = 0) {
    const a = Math.min(300, 90 + t * .8), b = a / 2.4, w = scene.direction * RAD;
    const u = a * .45 + (a + offset) * Math.cos(angle), v = (b + offset) * Math.sin(angle);
    return {e: u * Math.sin(w) - v * Math.cos(w), n: u * Math.cos(w) + v * Math.sin(w)};
  }
  /** Estimate signed ground clearance to the rendered ellipse, in metres. */
  function clearance(scene, t, point) {
    let distance = Infinity;
    for (let i = 0; i < 96; i++) {
      const a = boundary(scene, t, i * Math.PI / 48), b = boundary(scene, t, (i + 1) * Math.PI / 48);
      const dx = b.e - a.e, dy = b.n - a.n;
      const k = Math.max(0, Math.min(1, ((point.e - a.e) * dx + (point.n - a.n) * dy) / (dx * dx + dy * dy)));
      distance = Math.min(distance, Math.hypot(point.e - a.e - k * dx, point.n - a.n - k * dy));
    }
    const a = Math.min(300, 90 + t * .8), w = scene.direction * RAD;
    const u = point.e * Math.sin(w) + point.n * Math.cos(w) - a * .45, v = -point.e * Math.cos(w) + point.n * Math.sin(w);
    return ((u / a) ** 2 + (v / (a / 2.4)) ** 2 < 1 ? -1 : 1) * distance;
  }
  /** Put fictional people beyond the largest rendered fire so growth never engulfs them. */
  function create(fire, seed = Math.floor(Math.random() * 4294967296), startedAt = Date.now()) {
    const rng = random(seed), targets = [];
    const drones = COLORS.map((color, index) => ({id: `ANAFI-0${index + 1}`, index, color,
      sector: `${index * 90}–${(index + 1) * 90}° sector`, role: 'Perimeter observation',
      slot: SLOT + Math.floor(rng() * 4)}));
    const scene = {seed, lat: fire.lat, lon: fire.lon, direction: fire.directionDeg, targets, drones,
      startedAt, sampled: -1, elapsed: 0, selectedId: drones[0].id, initialBattery: fire.drone?.telemetry.battery_pct ?? 90};
    let start = START;
    for (const drone of drones) {
      drone.firstSearch = start;
      const t = start + DESCENT + SEARCH / 2;
      const angle = drone.index * Math.PI / 2 + t * .018;
      const count = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < count; i++) {
        const {e, n} = boundary(scene, 300, angle + (i ? .10 : -.06), 75 + rng() * 5);
        targets.push({id: `fleet-${seed}-${targets.length + 1}`, number: targets.length + 1,
          e, n, assignedDrone: drone.id, samples: [], seenBy: [], total: 0, first: null,
          acknowledged: null, closed: null});
      }
      start += drone.slot;
    }
    scene.period = start - START;
    return scene;
  }
  /** Smooth motion at descent/ascent boundaries, without teleporting between phases. */
  function smooth(k) { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); }
  /** Return a coordinated slot: only one aircraft can leave perimeter observation. */
  function assignment(scene, t, drone) {
    const since = t - drone.firstSearch;
    if (since < 0) return {phase: 'Observing', depth: 0, next: -since};
    const s = since % scene.period;
    if (s < DESCENT) return {phase: 'Descending', depth: smooth(s / DESCENT), next: scene.period - s};
    if (s < DESCENT + SEARCH) return {phase: 'Searching perimeter', depth: 1, next: scene.period - s};
    if (s < DESCENT * 2 + SEARCH) return {phase: 'Ascending', depth: 1 - smooth((s - DESCENT - SEARCH) / DESCENT), next: scene.period - s};
    return {phase: 'Observing', depth: 0, next: scene.period - s};
  }
  /** Orbit the maximum replay envelope; descend toward exterior people with 110+ m clearance. */
  function position(scene, t, drone) {
    const task = assignment(scene, t, drone), angle = drone.index * Math.PI / 2 + t * .018;
    const {e, n} = boundary(scene, 300, angle, 210 - 90 * task.depth);
    const edge = boundary(scene, 300, angle, 78), centre = boundary(scene, t, 0, -Math.min(300, 90 + t * .8));
    const focus = {e: centre.e + (edge.e - centre.e) * task.depth, n: centre.n + (edge.n - centre.n) * task.depth};
    return {e, n, alt: 78 + drone.index * 2 - (42 + drone.index) * task.depth,
      heading: (Math.atan2(focus.e - e, focus.n - n) / RAD + 360) % 360,
      pitch: Math.atan2(78 + drone.index * 2 - (42 + drone.index) * task.depth, Math.hypot(focus.e - e, focus.n - n)) / RAD,
      roll: 3 * Math.sin(angle) + 4 * Math.sin(task.depth * Math.PI), ...task};
  }
  /** One shared clock supplies each drone's camera, map, telemetry and sighting pose. */
  function pose(scene, t, droneId = scene.selectedId) {
    const drone = scene.drones.find(x => x.id === droneId) || scene.drones[0];
    const p = position(scene, t, drone), next = position(scene, t + .01, drone);
    const {e, n} = p;
    const [lat, lon] = ll(scene, e, n);
    const sector = (drone.index * 90 + t * .018 / RAD) % 360;
    return {...p, lat, lon, drone_id: drone.id, color: drone.color, sector: `${Math.round(sector)}–${Math.round((sector + 90) % 360)}° sector`,
      role: p.depth > 0 ? 'Perimeter person search' : 'Fire observation', reason: 'Scheduled sector revisit',
      range: Math.hypot(e, n), battery: Math.max(15, scene.initialBattery - drone.index * 3 - t / 40),
      speed: Math.hypot(next.e - e, next.n - n) / .01, climbRate: (next.alt - p.alt) / .01};
  }
  /** Project a fictional person through the same 69-degree camera used by the replay. */
  function visible(p, target) {
    if (p.alt > 55 || p.depth === 0) return null;
    const yaw = p.heading * RAD, pitch = p.pitch * RAD, de = target.e - p.e, dn = target.n - p.n;
    const forward = (de * Math.sin(yaw) + dn * Math.cos(yaw)) * Math.cos(pitch) + p.alt * Math.sin(pitch);
    if (forward <= 0) return null;
    const r = de * Math.cos(yaw) - dn * Math.sin(yaw);
    const u0 = (de * Math.sin(yaw) + dn * Math.cos(yaw)) * Math.sin(pitch) - p.alt * Math.cos(pitch);
    const roll = (p.roll || 0) * RAD, right = r * Math.cos(roll) + u0 * Math.sin(roll), up = u0 * Math.cos(roll) - r * Math.sin(roll);
    const tan = Math.tan(69 * RAD / 2), u = .5 + right / (forward * 2 * tan), v = .5 - up / (forward * 2 * tan * 540 / 960);
    return u > .04 && u < .96 && v > .08 && v < .92 && Math.hypot(de, dn) < 180 ? {u, v} : null;
  }
  /** Record only people visible from the moving simulated camera, once each second. */
  function observe(scene, t) {
    for (let s = scene.sampled + 1; s <= Math.floor(t); s++) {
      for (const drone of scene.drones) {
        const p = pose(scene, s, drone.id);
        for (const target of scene.targets) if (visible(p, target)) {
          const az = (Math.atan2(target.e - p.e, target.n - p.n) / RAD + 360) % 360;
          const sample = {t: s, az, drone_id: drone.id, range: Math.hypot(target.e - p.e, target.n - p.n)};
          target.first ??= sample; target.total++;
          if (!target.seenBy.includes(drone.id)) target.seenBy.push(drone.id);
          target.samples.push(sample);
          if (target.samples.length > 240) target.samples.shift();
        }
      }
    }
    scene.sampled = Math.max(scene.sampled, Math.floor(t));
  }
  /** Format session-owned fictional leads using the existing dashboard card contract. */
  function snapshot(scene, t) {
    observe(scene, t);
    const time = s => new Date(scene.startedAt + s * 1000).toISOString();
    const fleet = scene.drones.map(d => ({...pose(scene, t, d.id), observed_at: time(t),
      people: scene.targets.filter(x => x.seenBy.includes(d.id)).length}));
    const leads = scene.targets.filter(x => x.samples.length).map(target => {
      const samples = target.samples, last = samples.at(-1), [latitude, longitude] = ll(scene, target.e, target.n);
      const angles = [...new Set(samples.map(s => Math.round(s.az / 30) * 30 % 360))];
      const span = Math.max(0, ...angles.flatMap(a => angles.map(b => Math.min(Math.abs(a-b), 360-Math.abs(a-b)))));
      const multi = angles.length >= 2 && span >= 35;
      const accuracy = Math.max(3, Math.round(12 / Math.sqrt(samples.length)));
      return {id: target.id, number: target.number, title: `${multi ? 'Possible person' : 'Candidate'} — Target ${target.number}`,
        latitude, longitude, uncertainty: {major_95_m: accuracy, minor_95_m: accuracy, bearing_deg: 0, method: 'illustrative simulated uncertainty'},
        status: target.closed ? 'closed' : multi ? 'possible-person' : 'needs-another-view', status_text: 'Simulated camera sighting',
        first_seen_at: time(target.first.t), last_seen_at: time(last.t), last_seen_age_s: Math.round(t - last.t),
        observed_by: [...target.seenBy],
        views: angles.length, angle_span_deg: span, view_azimuths_deg: angles, sensors: ['visible'], observations: target.total,
        movement: {status: 'stationary', detail: 'Simulated person at a fixed location'}, missed_looks: 0,
        delayed: {any: false, max_delay_s: 0}, fire_distance_m: Math.round(clearance(scene, t, target)),
        fire_arrival: {minutes: null, basis: 'fictional person outside the maximum rendered replay fire'}, at_fire: false,
        priority: {tier: target.closed ? 9 : 0, base_tier: multi ? 2 : 4, reasons: ['SIMULATED: fictional person for presentation']},
        acknowledged: target.acknowledged, closed: target.closed, provenance: 'demo-simulated', next_look: null,
        evidence: samples.slice(-6).reverse().map(s => ({id: `${target.id}-${s.drone_id}-${s.t}`, drone_id: s.drone_id, at: time(s.t), sensor: 'visible', from: `${s.drone_id} camera`,
          view_az_deg: s.az, range_m: Math.round(s.range), individual_95_m: accuracy, crop: false, latitude, longitude})),
      };
    });
    const open = leads.filter(l => !l.closed);
    const searching = fleet.find(p => p.phase !== 'Observing');
    return {simulated: true, historical_scout: true, fleet_demo: true, t, duration_s: scene.period, leads, fleet,
      counts: {open: open.length, possible_people: open.filter(l => l.views >= 2).length, unacknowledged: open.filter(l => !l.acknowledged).length},
      coverage: {cells: []},
      mission: {mode: 'survey', phase: 'perimeter', link: 'up', stored: 0,
        log: [{at: time(t), text: `SIMULATED: ${searching ? searching.drone_id + ' ' + searching.phase.toLowerCase() : 'Fleet observing'}; ${leads.length} unique fictional people spotted. Other aircraft maintain observation.`},
          ...leads.map(l => ({at: l.first_seen_at, text: `Simulated Target ${l.number} seen by ${l.observed_by.join(', ')} at the perimeter.`}))]},
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
  root.BoscoScout = {START, create, pose, visible, snapshot, action, boundary, clearance};
})(globalThis);
