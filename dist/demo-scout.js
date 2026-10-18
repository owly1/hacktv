/* Historical-case scouting is a browser-only illustration. All locations,
   people and flight below are simulated; nothing is sent to live ingest. */
(function (root) {
  const RAD = Math.PI / 180, START = 8, SLOT = 48, DESCENT = 18, SEARCH = 8;
  const COLORS = ['#61d6cc', '#eebf66', '#a8a4ff', '#f18dac'];
  const PATROL_MINUTES = 20;
  /** Make a fictional forest case without changing the historical incident dataset. */
  function forestCase(template) {
    return {...template, id: 'forest-detection', name: 'Forest patrol · button detection', manualDetection: true,
      region: 'Fictional forest exercise · Alberta', lat: 56.65, lon: -111.50, areaHa: 3000,
      startDate: 'SIMULATED', cause: 'Presenter-triggered fictional fire', impacts: {},
      notes: 'Four simulated aircraft; press Detected to start the incident.', source: 'Hardcoded demonstration',
      drivers: {...template.drivers, fuel: 'Forest · simulated exercise'}};
  }
  /** Keep fire growth and search scheduling at zero until the fleet finishes its approach. */
  function fireTime(scene, t) { return scene?.manual ? Math.max(0, t - (scene.detectedAt ?? Infinity) - scene.transitDuration) : t; }
  /** Explicit presenter trigger, capturing moving patrol positions without a discontinuity. */
  function detect(scene, t) {
    if (!scene.manual || scene.detectedAt != null) return false;
    scene.departures = scene.drones.map(d => forestPosition(scene, t, d));
    scene.transitDuration = Math.max(...scene.drones.map((d, i) => {
      const a = scene.departures[i], b = patrolPosition(scene, 0, d);
      return Math.max(Math.hypot(a.e - b.e, a.n - b.n) * 1.5 / 12, Math.abs(a.alt - b.alt) * 1.5 / 2);
    }));
    scene.detectedAt = t;
    return true;
  }
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
    t = fireTime(scene, t);
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
  /** Use the exact historical map outline for the requested forecast horizon. */
  function outline(fire, t, minute = PATROL_MINUTES, scale = 1) {
    const a = Math.min(300, 90 + t * .8), initialArea = Math.PI * a * a / 2.4, finalArea = fire.areaHa * 10000;
    const k = Math.sqrt(initialArea * Math.pow(finalArea / initialArea, minute / 60) / finalArea) * scale;
    return root.EmberModel.recordedPerimeter(fire).map(p => [fire.lat + (p[0] - fire.lat) * k, fire.lon + (p[1] - fire.lon) * k]);
  }
  /** Interpolate a point and outward normal on the same +20-minute contour shown on the map. */
  function patrolPoint(scene, t, angle, offset = 0) {
    const a = Math.min(300, 90 + t * .8), initialArea = Math.PI * a * a / 2.4;
    const k = Math.sqrt(initialArea * Math.pow(scene.finalArea / initialArea, PATROL_MINUTES / 60) / scene.finalArea);
    const index = ((angle / (Math.PI * 2) % 1 + 1) % 1) * scene.perimeter.length, i = Math.floor(index), u = index - i;
    const p = scene.perimeter[i], q = scene.perimeter[(i + 1) % scene.perimeter.length];
    const e = (p.e + (q.e - p.e) * u) * k, n = (p.n + (q.n - p.n) * u) * k;
    const ne = p.ne + (q.ne - p.ne) * u, nn = p.nn + (q.nn - p.nn) * u, length = Math.hypot(ne, nn);
    return {e: e + offset * ne / length, n: n + offset * nn / length};
  }
  /** Require exterior ground in both the rendered fire and its map footprint. */
  function exterior(scene, t, target) {
    t = fireTime(scene, t);
    const a = Math.min(300, 90 + t * .8), w = scene.direction * RAD;
    const u = target.e * Math.sin(w) + target.n * Math.cos(w) - a * .45, v = -target.e * Math.cos(w) + target.n * Math.sin(w);
    if ((u / (a + 5)) ** 2 + (v / (a / 2.4 + 5)) ** 2 <= 1) return false;
    if (scene.fireCheck?.t !== t) {
      const k = Math.sqrt(Math.PI * a * a / 2.4 / scene.finalArea);
      scene.fireCheck = {t, polygon: scene.perimeter.map(p => [p.n * k, p.e * k])};
    }
    return !root.EmberModel.insidePolygon([target.n, target.e], scene.fireCheck.polygon);
  }
  /** Place fictional people outside the +20-minute border at their first scheduled search. */
  function create(fire, seed = Math.floor(Math.random() * 4294967296), startedAt = Date.now()) {
    const rng = random(seed), targets = [];
    const drones = COLORS.map((color, index) => ({id: `ANAFI-0${index + 1}`, index, color,
      sector: `${index * 90}–${(index + 1) * 90}° sector`, role: 'Perimeter observation',
      slot: SLOT + Math.floor(rng() * 4)}));
    const scene = {seed, lat: fire.lat, lon: fire.lon, direction: fire.directionDeg, targets, drones,
      startedAt, sampled: -1, elapsed: 0, selectedId: drones[0].id, initialBattery: fire.drone?.telemetry.battery_pct ?? 90};
    scene.fire = {...fire, areaHa: fire.areaHa > 0 ? fire.areaHa : 10000};
    scene.finalArea = scene.fire.areaHa * 10000;
    scene.perimeter = root.EmberModel.recordedPerimeter(scene.fire).map(([lat, lon]) => ({e: (lon - scene.lon) * 111320 * Math.cos(scene.lat * RAD), n: (lat - scene.lat) * 111320}));
    for (let i = 0; i < scene.perimeter.length; i++) {
      const p = scene.perimeter[i], before = scene.perimeter[(i + scene.perimeter.length - 1) % scene.perimeter.length], after = scene.perimeter[(i + 1) % scene.perimeter.length];
      let ne = after.n - before.n, nn = -(after.e - before.e);
      const centre = Math.sqrt(scene.finalArea * 2.4 / Math.PI) * .45, w = scene.direction * RAD;
      if (ne * (p.e - centre * Math.sin(w)) + nn * (p.n - centre * Math.cos(w)) < 0) { ne = -ne; nn = -nn; }
      const length = Math.hypot(ne, nn); p.ne = ne / length; p.nn = nn / length;
    }
    const maximumA = Math.pow(300 * 300 * Math.sqrt(scene.finalArea * 2.4 / Math.PI), 1 / 3);
    scene.angularRate = 6 / (maximumA * 1.6);
    let start = START;
    for (const drone of drones) {
      drone.firstSearch = start;
      const t = start + DESCENT + SEARCH / 2;
      const angle = drone.index * Math.PI / 2 + t * scene.angularRate;
      const count = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < count; i++) {
        const {e, n} = patrolPoint(scene, t, angle + (i ? .012 : -.012), 26 + rng() * 5);
        targets.push({id: `fleet-${seed}-${targets.length + 1}`, number: targets.length + 1,
          e, n, assignedDrone: drone.id, samples: [], seenBy: [], total: 0, first: null,
          acknowledged: null, closed: null});
      }
      start += drone.slot;
    }
    scene.period = start - START;
    scene.manual = !!fire.manualDetection; scene.detectedAt = null; scene.transitDuration = 0;
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
  /** Pace the +20-minute contour and descend only toward its exterior border. */
  function patrolPosition(scene, t, drone) {
    const task = assignment(scene, t, drone), angle = drone.index * Math.PI / 2 + t * scene.angularRate;
    const sway = 8 * Math.sin(t * .28 + drone.index * 1.7) * (1 - task.depth);
    const {e, n} = patrolPoint(scene, t, angle, 105 - 40 * task.depth + sway);
    const edge = patrolPoint(scene, t, angle, 28), centre = boundary(scene, t, 0, -Math.min(300, 90 + t * .8));
    const focus = {e: centre.e + (edge.e - centre.e) * task.depth, n: centre.n + (edge.n - centre.n) * task.depth};
    return {e, n, alt: 78 + drone.index * 2 - (42 + drone.index) * task.depth,
      heading: (Math.atan2(focus.e - e, focus.n - n) / RAD + 360) % 360,
      pitch: Math.atan2(78 + drone.index * 2 - (42 + drone.index) * task.depth, Math.hypot(focus.e - e, focus.n - n)) / RAD,
      roll: 5 * Math.sin(t * .22 + drone.index * 1.7) + 3 * Math.sin(angle) + 4 * Math.sin(task.depth * Math.PI), ...task};
  }
  /** Hold widely separated high-altitude positions before the presenter reveals any fire. */
  function forestPosition(scene, t, drone) {
    const edge = patrolPoint(scene, 0, drone.index * Math.PI / 2, 0), length = Math.hypot(edge.e, edge.n);
    const radius = [700, 2000, 2200, 2400][drone.index], e = edge.e / length * radius, n = edge.n / length * radius;
    return {e, n, alt: 150 + drone.index * 20, heading: (Math.atan2(-e, -n) / RAD + 360) % 360, pitch: 45, roll: 0,
      phase: 'Holding high', depth: 0, next: 0};
  }
  /** Fly continuously from forest patrol to the incident, then join the exterior search orbit. */
  function position(scene, t, drone) {
    if (!scene.manual) return patrolPosition(scene, t, drone);
    if (scene.detectedAt == null) return forestPosition(scene, t, drone);
    const elapsed = t - scene.detectedAt;
    if (elapsed >= scene.transitDuration) return patrolPosition(scene, fireTime(scene, t), drone);
    const a = scene.departures[drone.index], b = patrolPosition(scene, 0, drone), k = smooth(elapsed / scene.transitDuration);
    const e = a.e + (b.e - a.e) * k, n = a.n + (b.n - a.n) * k, alt = a.alt + (b.alt - a.alt) * k;
    const heading = (Math.atan2(-e, -n) / RAD + 360) % 360;
    const turn = ((heading - a.heading + 540) % 360) - 180, aim = smooth(Math.min(1, elapsed / 5));
    return {...a, e, n, alt, heading: (a.heading + turn * aim + 360) % 360,
      pitch: a.pitch + (Math.atan2(alt, Math.hypot(e, n)) / RAD - a.pitch) * aim,
      phase: 'Responding to fire', next: scene.transitDuration - elapsed};
  }
  /** One shared clock supplies each drone's camera, map, telemetry and sighting pose. */
  function pose(scene, t, droneId = scene.selectedId) {
    const drone = scene.drones.find(x => x.id === droneId) || scene.drones[0];
    const p = position(scene, t, drone), next = position(scene, t + .01, drone);
    const {e, n} = p;
    const [lat, lon] = ll(scene, e, n);
    const sector = (drone.index * 90 + fireTime(scene, t) * scene.angularRate / RAD) % 360;
    return {...p, lat, lon, elapsed_s: t, patrol_minutes: PATROL_MINUTES, drone_id: drone.id, color: drone.color, sector: `${Math.round(sector)}–${Math.round((sector + 90) % 360)}° sector`,
      role: scene.manual && scene.detectedAt == null ? 'High-altitude hold' : p.phase === 'Responding to fire' ? 'Incident approach' : p.depth > 0 ? 'Perimeter person search' : 'Fire observation', reason: 'Simulated mission',
      range: Math.hypot(e, n), battery: Math.max(15, scene.initialBattery - drone.index * 3 - t / 40),
      speed: Math.hypot(next.e - e, next.n - n) / .01, climbRate: (next.alt - p.alt) / .01};
  }
  /** Project a fictional person through the same 69-degree camera used by the replay. */
  function visible(p, target, scene) {
    if (!scene || (scene.manual && scene.detectedAt == null) || p.alt > 55 || p.depth === 0 || !exterior(scene, p.elapsed_s, target)) return null;
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
        for (const target of scene.targets) if (visible(p, target, scene)) {
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
        fire_arrival: {minutes: null, basis: 'fictional person on the exterior +20-minute forecast border'}, at_fire: false,
        priority: {tier: target.closed ? 9 : 0, base_tier: multi ? 2 : 4, reasons: ['SIMULATED: fictional person for presentation']},
        acknowledged: target.acknowledged, closed: target.closed, provenance: 'demo-simulated', next_look: null,
        evidence: samples.slice(-6).reverse().map(s => ({id: `${target.id}-${s.drone_id}-${s.t}`, drone_id: s.drone_id, at: time(s.t), sensor: 'visible', from: `${s.drone_id} camera`,
          view_az_deg: s.az, range_m: Math.round(s.range), individual_95_m: accuracy, crop: false, latitude, longitude})),
      };
    });
    const open = leads.filter(l => !l.closed);
    const searching = fleet.find(p => p.depth > 0);
    const status = scene.manual && scene.detectedAt == null ? 'High-altitude forest hold; no fire detected' : fleet.some(p => p.phase === 'Responding to fire') ? 'Fleet flying toward the detected fire' : searching ? searching.drone_id + ' ' + searching.phase.toLowerCase() : 'Fleet observing';
    return {simulated: true, historical_scout: true, fleet_demo: true, t, duration_s: scene.period, leads, fleet,
      counts: {open: open.length, possible_people: open.filter(l => l.views >= 2).length, unacknowledged: open.filter(l => !l.acknowledged).length},
      coverage: {cells: []},
      mission: {mode: 'survey', phase: 'perimeter', link: 'up', stored: 0,
        log: [{at: time(t), text: `SIMULATED: ${status}; ${leads.length} unique fictional people spotted.`},
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
  root.BoscoScout = {START, create, pose, visible, snapshot, action, boundary, clearance, outline, patrolPoint, exterior, PATROL_MINUTES, forestCase, fireTime, detect};
})(globalThis);
