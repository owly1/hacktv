'use strict';
/* Emberwatch simulated ANAFI camera for Demo mode. A WebGL pinhole camera
   (ANAFI horizontal FOV 69°) looks at a flat ground textured with satellite
   tiles around the scene origin. A fire scene adds a wind-driven burning
   front and a smoke plume; a pad scene is the test-marker take-off area.
   Everything drawn here is SIMULATED and labeled so in the HUD.
   Coordinates are metres east/north/up of the scene origin; headings are
   degrees clockwise from north; pitch is degrees below the horizon. */
(function (root) {
  const HFOV = 69 * Math.PI / 180;
  const RAD = Math.PI / 180;

  // Vertex main passes the full-screen quad directly into clip coordinates.
  const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }';
  // Fragment helpers: hash gives stable grain; noise interpolates it; fbm layers scales.
  // terrain blends map textures, pad draws the launch floor/QR, and main casts each
  // camera pixel onto the ground before adding fire, haze and sensor effects.
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes; uniform float uF, uTime, uMode;
uniform vec3 uPos, uFwd, uRight, uUp;
uniform sampler2D uHi, uLo, uMarker;
uniform float uHiSize, uLoSize, uMarkerSize;
uniform vec2 uWind, uMarkerPos;
uniform vec3 uFire; // semi-axis along wind, across wind, centre shift downwind (m); a = 0 means no fire

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= .5; } return s; }

vec3 terrain(vec2 g) {
  vec3 c = mix(vec3(.25, .30, .18), vec3(.42, .40, .28), fbm(g * .004));
  c = mix(c, vec3(.17, .23, .14), smoothstep(.55, .75, fbm(g * .011 + 7.)));
  vec2 lo = vec2(g.x / uLoSize + .5, .5 - g.y / uLoSize);
  if (lo.x > 0. && lo.x < 1. && lo.y > 0. && lo.y < 1.) c = texture2D(uLo, lo).rgb;
  vec2 hi = vec2(g.x / uHiSize + .5, .5 - g.y / uHiSize);
  float edge = min(min(hi.x, 1. - hi.x), min(hi.y, 1. - hi.y));
  if (edge > 0.) c = mix(c, texture2D(uHi, hi).rgb, smoothstep(0., .04, edge));
  return c;
}

vec3 pad(vec2 g) {
  vec3 c = vec3(.56, .55, .52) * (.86 + .22 * fbm(g * 3.)) + .04 * (hash(floor(g * 40.)) - .5);
  vec2 seam = abs(fract(g / .6 + .5) - .5) * .6;
  c *= mix(.78, 1., smoothstep(.0, .006, min(seam.x, seam.y)));
  vec2 m = g - uMarkerPos;
  if (abs(m.x) < .108 && abs(m.y) < .1395) c = vec3(.93, .93, .9);        // letter-size sheet
  if (abs(m.x) < uMarkerSize * .5 && abs(m.y) < uMarkerSize * .5)
    c = texture2D(uMarker, vec2(m.x / uMarkerSize + .5, .5 - m.y / uMarkerSize)).rgb * vec3(.93, .93, .9);
  return c;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x - uRes.x * .5, uRes.y * .5 - gl_FragCoord.y);
  vec3 dir = normalize(uFwd * uF + uRight * px.x - uUp * px.y);
  vec3 col;
  vec3 haze = uMode < .5 ? vec3(.74, .68, .61) : vec3(.6);
  if (dir.z > -.0005) {
    float h = clamp(dir.z * 3., 0., 1.);
    col = mix(haze, vec3(.47, .58, .70), pow(h, .6));
    col = mix(col, vec3(.55, .47, .40), .35 * smoothstep(-.4, 1., dot(normalize(dir.xy), uWind)) * (1. - h));
  } else {
    float t = uPos.z / -dir.z;
    vec2 g = uPos.xy + dir.xy * t;
    if (uMode < .5) {
      col = terrain(g);
      if (uFire.x > 0.) {
        vec2 w = uWind, n = vec2(-w.y, w.x);
        float along = dot(g, w) - uFire.z, across = dot(g, n);
        float q = length(vec2(along / uFire.x, across / uFire.y));
        q += (fbm(g * .03 + vec2(uTime * .03, 0.)) - .5) * .35;
        float head = smoothstep(-1., 1., along / uFire.x);
        if (q < 1.) {
          vec3 ash = mix(vec3(.08, .07, .065), vec3(.30, .28, .26), fbm(g * .045));
          col = mix(col * .4, ash, .7 * smoothstep(-.1, .35, 1. - q));                      // char and ash
          col = mix(col, vec3(.42, .40, .38), .18 * smoothstep(.3, .8, fbm(g * .02 - uTime * .05))); // low smoke
          float ember = smoothstep(.72, .9, fbm(g * .08 + uTime * .15)) * smoothstep(.55, 1., q);
          col += vec3(.9, .25, .03) * ember * (.6 + .4 * sin(uTime * 7. + g.x));
        }
        float band = 1. - smoothstep(0., .07 + .05 * head, abs(q - 1.));
        float flick = .55 + .45 * fbm(g * .12 + vec2(0., uTime * 1.8));
        vec3 flame = mix(vec3(1., .32, .04), vec3(1., .82, .38), flick);
        col += flame * band * (.5 + 1.4 * head) * flick;
        col += vec3(.5, .15, .02) * exp(-max(q - 1., 0.) * 6.) * .25 * head;                // glow
        col *= 1. - .35 * exp(-across * across / (uFire.y * uFire.y * 1.5)) * smoothstep(0., 2., along / uFire.x - .6); // plume shadow
      }
      col = mix(col, haze, 1. - exp(-t / 2600.));
    } else col = pad(g);
    col = mix(col, haze, smoothstep(-.02, 0., dir.z));                                      // soft horizon
  }
  vec2 uv = gl_FragCoord.xy / uRes;
  col = (col - .5) * 1.08 + .5;                                                             // contrast
  col *= 1. - .35 * pow(length(uv - .5) * 1.25, 2.2);                                       // vignette
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .035;                          // sensor grain
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

  /** Convert latitude/longitude into Web Mercator tile-pixel coordinates. */
  function lonLatToPx(lat, lon, z) {
    const s = 256 * 2 ** z, sin = Math.sin(lat * RAD);
    return [(lon + 180) / 360 * s, (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }

  /* Camera basis in east/north/up for a heading and downward pitch (degrees). */
  function basis(heading, pitch) {
    const h = heading * RAD, p = pitch * RAD, fh = [Math.sin(h), Math.cos(h), 0];
    return {
      fwd: [fh[0] * Math.cos(p), fh[1] * Math.cos(p), -Math.sin(p)],
      right: [Math.cos(h), -Math.sin(h), 0],
      up: [fh[0] * Math.sin(p), fh[1] * Math.sin(p), Math.cos(p)],
    };
  }
  /** Return the three-component dot product used by camera projection. */
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /** Initialize the WebGL terrain renderer and its offscreen camera resources. */
  function create(w = 960, h = 540) {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = w; glCanvas.height = h;
    const gl = glCanvas.getContext('webgl', {preserveDrawingBuffer: true, antialias: false});
    const f = (w / 2) / Math.tan(HFOV / 2);
    const cam = {gl, w, h, f, scene: null, smoke: [], lastSmokeT: null, video: null};
    if (!gl) return Object.assign(cam, {ok: false});

    /** Compile one shader and surface its compiler error when initialization fails. */
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {}; for (const n of ['uRes', 'uF', 'uTime', 'uMode', 'uPos', 'uFwd', 'uRight', 'uUp', 'uHi', 'uLo', 'uMarker', 'uHiSize', 'uLoSize', 'uMarkerSize', 'uWind', 'uMarkerPos', 'uFire']) U[n] = gl.getUniformLocation(prog, n);
    /** Allocate/configure one camera texture for map imagery or reference video. */
    const tex = unit => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([70, 80, 55, 255])); gl.generateMipmap(gl.TEXTURE_2D); return t; };
    cam.tex = {hi: tex(0), lo: tex(1), marker: tex(2)};
    gl.uniform1i(U.uHi, 0); gl.uniform1i(U.uLo, 1); gl.uniform1i(U.uMarker, 2);
    gl.viewport(0, 0, w, h);
    Object.assign(cam, {ok: true, glCanvas, U});
    return cam;
  }

  /** Upload an available image/video source into the selected texture unit. */
  function upload(cam, unit, source) {
    const gl = cam.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, [cam.tex.hi, cam.tex.lo, cam.tex.marker][unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); gl.generateMipmap(gl.TEXTURE_2D);
  }

  /* Satellite mosaic `size` px square at zoom z, centred on lat/lon. Tiles go
     through the backend's caching proxy, so a scene viewed once works offline.
     Returns the span in metres; the texture fills in as tiles arrive. */
  function loadMosaic(cam, unit, lat, lon, z, size, scene) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#4b5638'; ctx.fillRect(0, 0, size, size);
    const [cx, cy] = lonLatToPx(lat, lon, z), x0 = cx - size / 2, y0 = cy - size / 2, n = 2 ** z;
    let dirty = false, pending = 0;
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + size - 1) / 256); ty++) {
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + size - 1) / 256); tx++) {
        if (ty < 0 || ty >= n) continue;
        const img = new Image(); pending++;
        img.onload = () => { pending--; if (cam.scene !== scene) return; ctx.drawImage(img, tx * 256 - x0, ty * 256 - y0); dirty = true; };
        img.onerror = () => { pending--; };
        img.src = `tiles/sat/${z}/${((tx % n) + n) % n}/${ty}.png`;
      }
    }
    /** Paint the current tile mosaic into the camera texture when imagery is available. */
    const flush = () => { if (cam.scene !== scene) return; if (dirty) { dirty = false; upload(cam, unit, c); } if (pending > 0 || dirty) setTimeout(flush, 400); };
    upload(cam, unit, c); setTimeout(flush, 300);
    return size * 156543.03392 * Math.cos(lat * RAD) / n;
  }

  /* scene: {kind: 'fire', lat, lon, windDeg, windKmh} or {kind: 'pad', lat, lon, marker: {e, n, size, src}} */
  function setScene(cam, scene) {
    cam.scene = scene; cam.smoke = []; cam.lastSmokeT = null;
    if (!cam.ok) return;
    if (scene.kind === 'fire') {
      scene.hiSize = loadMosaic(cam, 0, scene.lat, scene.lon, 16, 2048, scene);
      scene.loSize = loadMosaic(cam, 1, scene.lat, scene.lon, 13, 1024, scene);
    } else {
      scene.hiSize = scene.loSize = 1;
      // WebGL 1 mipmaps need a power-of-two texture.
      const img = new Image(); img.onload = () => { if (cam.scene !== scene) return; const c = document.createElement('canvas'); c.width = c.height = 512; c.getContext('2d').drawImage(img, 0, 0, 512, 512); upload(cam, 2, c); }; img.src = scene.marker.src;
    }
  }

  /** Select the optional credited reference-video source for the simulated camera. */
  function setVideo(cam, video) { cam.video = video; }

  /* Screen position of a world point for a pose, or null when behind the camera. */
  function project(cam, pose, P) {
    const b = pose.basis, rel = [P[0] - pose.e, P[1] - pose.n, P[2] - pose.alt], z = dot(rel, b.fwd);
    if (z < .5) return null;
    return [cam.w / 2 + cam.f * dot(rel, b.right) / z, cam.h / 2 - cam.f * dot(rel, b.up) / z, z];
  }

  /* Points on the burning front, in metres from the scene origin. */
  function frontPoint(scene, fire, ang) {
    const w = scene.windDeg * RAD, wx = Math.sin(w), wy = Math.cos(w);
    const a = fire.a * Math.cos(ang) + fire.shift, c = fire.b * Math.sin(ang);
    return [wx * a - wy * c, wy * a + wx * c];
  }

  /** Advance the local smoke particles according to the simulated fire and wind. */
  function stepSmoke(cam, fire, t) {
    const scene = cam.scene, dt = cam.lastSmokeT == null ? 0 : Math.min(.5, t - cam.lastSmokeT);
    cam.lastSmokeT = t;
    const w = scene.windDeg * RAD, wind = Math.max(1.5, scene.windKmh / 3.6 * .7);
    for (const s of cam.smoke) { s.age += dt; s.e += Math.sin(w) * wind * dt + s.ve * dt; s.n += Math.cos(w) * wind * dt + s.vn * dt; s.z += s.vz * dt * Math.max(.25, 1 - s.age / 60); s.r += 2.2 * dt; }
    cam.smoke = cam.smoke.filter(s => s.age < s.life);
    cam.spawnAcc = (cam.spawnAcc || 0) + dt * 5;
    for (; cam.spawnAcc >= 1 && cam.smoke.length < 240; cam.spawnAcc--) {
      const ang = (Math.random() - .5) * Math.PI * 1.3 * (Math.random() < .8 ? 1 : 2.4), [e, n] = frontPoint(scene, fire, ang);
      cam.smoke.push({e, n, z: 4, r: 10 + Math.random() * 14, vz: 4 + Math.random() * 4, ve: (Math.random() - .5) * 1.5, vn: (Math.random() - .5) * 1.5, age: 0, life: 50 + Math.random() * 25, shade: Math.random()});
    }
  }

  /** Seed an established smoke plume before the first visible replay frame. */
  function prewarm(cam, fire) { for (let t = 0; t < 70; t += .25) stepSmoke(cam, fire, t - 70); cam.lastSmokeT = null; }

  /** Project and draw the active simulated smoke particles over the terrain image. */
  function drawSmoke(ctx, cam, pose) {
    const pts = [];
    for (const s of cam.smoke) { const p = project(cam, pose, [s.e, s.n, s.z]); if (p) pts.push([p, s]); }
    pts.sort((a, b) => b[0][2] - a[0][2]);
    for (const [[x, y, z], s] of pts) {
      const r = cam.f * s.r / z; if (r < 1 || x < -r || x > cam.w + r || y < -r || y > cam.h + r) continue;
      const a = Math.min(1, s.age / 3) * Math.max(0, 1 - s.age / s.life) * .34, lift = Math.min(1, s.z / 500);
      const c = [Math.round(88 + 110 * lift + 24 * s.shade), Math.round(80 + 104 * lift + 22 * s.shade), Math.round(72 + 100 * lift + 20 * s.shade)];
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(.6, `rgba(${c},${a * .55})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }

  /** Draw the labeled simulated detection box within the camera viewport. */
  function box(ctx, cam, x1, y1, x2, y2, label) {
    const lw = Math.max(3, cam.w / 240);
    ctx.strokeStyle = '#ff5a1f'; ctx.lineWidth = lw; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = '#ff5a1f'; ctx.font = `600 ${Math.round(cam.w / 34)}px Segoe UI`; ctx.fillText(label, x1, Math.max(cam.h / 14, y1 - 8));
  }

  /** Draw the replay's attitude, altitude, power and source labels over the camera view. */
  function hud(ctx, cam, pose, info) {
    const w = cam.w, h = cam.h, fs = Math.round(w / 34);
    ctx.save();
    ctx.font = `${fs}px Consolas, monospace`; ctx.fillStyle = '#eef6f0'; ctx.strokeStyle = '#eef6f0'; ctx.shadowColor = '#000a'; ctx.shadowBlur = 4;
    // heading tape
    const cx = w / 2, ty = h * .2, span = 60, half = w * .22;
    ctx.lineWidth = 2; ctx.textAlign = 'center';
    for (let d = Math.ceil((pose.heading - span / 2) / 5) * 5; d <= pose.heading + span / 2; d += 5) {
      const x = cx + (d - pose.heading) / (span / 2) * half, major = d % 15 === 0;
      ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x, ty - (major ? fs * .6 : fs * .3)); ctx.stroke();
      if (major) { const v = ((d % 360) + 360) % 360; ctx.fillText({0: 'N', 90: 'E', 180: 'S', 270: 'W'}[v] ?? String(v), x, ty - fs * .8); }
    }
    ctx.beginPath(); ctx.moveTo(cx, ty + 3); ctx.lineTo(cx - 7, ty + 14); ctx.lineTo(cx + 7, ty + 14); ctx.closePath(); ctx.fill();
    ctx.fillText(`${String(Math.round((pose.heading % 360 + 360) % 360)).padStart(3, '0')}°`, cx, ty + 16 + fs);
    // side readouts
    ctx.textAlign = 'left';
    const left = [`ALT ${pose.alt.toFixed(1)} m`, `SPD ${info.speed.toFixed(1)} m/s`, `GIM ${(-pose.pitch).toFixed(1)}°`];
    left.forEach((s, i) => ctx.fillText(s, w * .04, h * .44 + i * fs * 1.35));
    ctx.textAlign = 'right';
    const right = [info.range != null ? `RNG ${Math.round(info.range)} m` : '', `BAT ${Math.round(info.battery)}%`, info.zoom ?? 'ZOOM 1.0×'].filter(Boolean);
    right.forEach((s, i) => ctx.fillText(s, w * .96, h * .44 + i * fs * 1.35));
    ctx.textAlign = 'center'; ctx.font = `${Math.round(fs * .8)}px Consolas, monospace`;
    ctx.fillText(info.footer, cx, h * .78);
    ctx.restore();
  }

  /* Draws one frame into ctx. pose: {e, n, alt, heading, pitch}; opts: {t, fire, confidence,
     speed, battery, range, footer, shake}. Returns the fire box in canvas px, or null. */
  function render(ctx, cam, pose, opts) {
    const scene = cam.scene, t = opts.t, shake = opts.shake ?? 1;
    pose = {...pose, heading: pose.heading + shake * (.35 * Math.sin(t * 1.3) + .15 * Math.sin(t * 3.7)), pitch: pose.pitch + shake * (.25 * Math.sin(t * 1.7 + 1) + .1 * Math.sin(t * 4.3))};
    pose.basis = basis(pose.heading, pose.pitch);
    let found = null;
    if (cam.video && cam.video.readyState >= 2) {
      const v = cam.video, s = Math.max(cam.w / v.videoWidth, cam.h / v.videoHeight);
      ctx.drawImage(v, (cam.w - v.videoWidth * s) / 2, (cam.h - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
    } else if (cam.ok && scene) {
      const gl = cam.gl, U = cam.U, b = pose.basis, wr = (scene.windDeg ?? 0) * RAD;
      gl.uniform2f(U.uRes, cam.w, cam.h); gl.uniform1f(U.uF, cam.f); gl.uniform1f(U.uTime, t % 1000); gl.uniform1f(U.uMode, scene.kind === 'fire' ? 0 : 1);
      gl.uniform3f(U.uPos, pose.e, pose.n, Math.max(.15, pose.alt)); gl.uniform3fv(U.uFwd, b.fwd); gl.uniform3fv(U.uRight, b.right); gl.uniform3fv(U.uUp, b.up);
      gl.uniform1f(U.uHiSize, scene.hiSize); gl.uniform1f(U.uLoSize, scene.loSize); gl.uniform2f(U.uWind, Math.sin(wr), Math.cos(wr));
      const fire = opts.fire;
      gl.uniform3f(U.uFire, fire ? fire.a : 0, fire ? fire.b : 0, fire ? fire.shift : 0);
      if (scene.kind === 'pad') { gl.uniform2f(U.uMarkerPos, scene.marker.e, scene.marker.n); gl.uniform1f(U.uMarkerSize, scene.marker.size); }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.drawImage(cam.glCanvas, 0, 0);
      if (scene.kind === 'fire' && fire) {
        if (!cam.smoke.length) prewarm(cam, fire);
        stepSmoke(cam, fire, t); drawSmoke(ctx, cam, pose);
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (let i = 0; i < 36; i++) {
          const [e, n] = frontPoint(scene, fire, i / 36 * Math.PI * 2);
          for (const z of [0, 25]) { const p = project(cam, pose, [e, n, z]); if (p) { x1 = Math.min(x1, p[0]); y1 = Math.min(y1, p[1]); x2 = Math.max(x2, p[0]); y2 = Math.max(y2, p[1]); } }
        }
        x1 = Math.max(4, x1); y1 = Math.max(4, y1); x2 = Math.min(cam.w - 4, x2); y2 = Math.min(cam.h - 4, y2);
        if (x2 - x1 > 6 && y2 - y1 > 4) { found = [x1, y1, x2, y2]; box(ctx, cam, x1, y1, x2, y2, `${opts.label ?? 'FIRE'} ${Math.round(opts.confidence * 100)}%`); }
      } else if (scene.kind === 'pad') {
        const m = scene.marker, s = m.size / 2, pts = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([de, dn]) => project(cam, pose, [m.e + de, m.n + dn, 0]));
        if (pts.every(Boolean)) {
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), b2 = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          if (b2[0] > 0 && b2[1] > 0 && b2[2] < cam.w && b2[3] < cam.h) { found = b2; box(ctx, cam, ...b2, `FIRE · test marker ${Math.round(opts.confidence * 100)}%`); }
        }
      }
    } else {
      ctx.fillStyle = '#2d3c3e'; ctx.fillRect(0, 0, cam.w, cam.h);
    }
    if (!cam.video && opts.t >= 8) drawPeople(ctx, cam, pose, opts.people || []);
    hud(ctx, cam, pose, opts);
    return found;
  }

  /** Draw fictional people and their boxes through the replay camera's current pose. */
  function drawPeople(ctx, cam, pose, people) {
    ctx.save();
    for (const person of people) {
      if (Math.hypot(person.e - pose.e, person.n - pose.n) >= 180) continue;
      const feet = project(cam, pose, [person.e, person.n, 0]);
      const head = project(cam, pose, [person.e, person.n, 1.8]);
      if (!feet || !head || feet[0] < 10 || feet[0] > cam.w - 10 || feet[1] < 10 || feet[1] > cam.h - 10) continue;
      const h = Math.max(12, Math.abs(feet[1] - head[1])), x = feet[0], y = feet[1] - h;
      ctx.fillStyle = '#f4f2e8'; ctx.beginPath(); ctx.arc(x, y + h * .15, h * .12, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(x - h * .13, y + h * .3, h * .26, h * .65);
      ctx.strokeStyle = '#5CC8C0'; ctx.lineWidth = Math.max(2, cam.w / 400);
      ctx.strokeRect(x - h * .5, y - 5, h, h + 10);
      ctx.fillStyle = '#5CC8C0'; ctx.font = `600 ${Math.round(cam.w / 55)}px Consolas, monospace`;
      ctx.fillText(`PERSON ${person.number} · SIM`, x - h * .5, Math.max(18, y - 9));
    }
    ctx.restore();
  }

  root.EmberCamera = {create, setScene, setVideo, render, project, HFOV_DEG: 69};
})(globalThis);
