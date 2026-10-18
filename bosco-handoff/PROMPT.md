# BOSCO UI — build brief for Claude Code

You are implementing the BOSCO front end (Bushfire Observation, Simulation and Coordination Operations) in this repository: a Home page with a scroll-driven drone teardown, an incident Dashboard, and a light theme for the Dashboard. The finished design lives in `reference/`. Match it closely. Visual fidelity and the transitions matter as much as the features.

## 0. Before writing code

1. Inspect this repo and use its existing stack (framework, router, styling approach, component conventions). Do not add a new framework. If the repo has no front end yet, build plain HTML, CSS and vanilla JS under `web/`.
2. State in one short paragraph which stack you're using and where the files will go, then start. Don't stop to ask questions; make the reasonable call and note it.
3. Work in this order and commit after each step: tokens → logo mark → Home → teardown → Home→Dashboard transition → Dashboard → Dashboard→Home transition → light theme.

## 1. Files in this folder

- `reference/home.dc.html`, `reference/dashboard.dc.html`, `reference/dashboard-light.dc.html` are the design source. They are written in a design-tool component format, **not** runnable as-is:
  - markup sits inside `<x-dc>`; page CSS sits in `<helmet><style>`
  - `{{name}}` is a value from `renderVals()`; `<sc-if value>` is a conditional; `<sc-for list as>` is a loop
  - `onClick="{{fn}}"` / `ref="{{fn}}"` bind handlers and refs
  - the `<script type="text/x-dc">` block holds a React-style class component: `state`, `setState` and `renderVals()` returning the template's values

  Translate this into the repo's idiom. Copy exact values (colours, sizes, copy text, timings, keyframes) from these files. Never ship `support.js`, `<x-dc>`, `sc-*` tags or the design format itself. The files are long: read them in parts.
- `assets/teardown/frame-000.webp … frame-119.webp` are the 120 exploded-view frames, 1440×810, in order.
- `assets/drone-hover.mp4` and `assets/drone-hover-poster.jpg` are the hovering drone clip used on Home.
- `assets/bosco-mark.svg` is the animated logo mark (reference for the component in §3).

## 2. Design tokens (dark — Home and Dashboard)

Define these once as CSS custom properties (or the repo's token system). Use tokens everywhere, never hard-coded hex in components.

| Token | Value | Use |
|---|---|---|
| bg | `#08080A` | page background |
| surface | `#111114` | panels, cards |
| surface-sunk | `#0C0C0F` | fleet panel, lead cards, log |
| surface-raised | `#18181C` | active rail item, disabled buttons |
| line-1 / line-2 / line-3 | `#1C1D21` / `#222327` / `#2E2F35` | dividers / panel rings / control rings |
| text | `#D8D7D2` | primary text |
| text-2 | `#C4C3BE` | body copy in cards |
| muted | `#A9ABB0` | secondary text |
| label | `#94959B` | mono labels |
| faint | `#7A7B81` | timestamps, footer |
| accent | `#E2574C` | **the only contrast colour on the Dashboard** |
| accent-text | `#F08178` | red text on dark |
| accent-soft | `rgba(226,87,76,0.09)` | tinted fills |
| drone-blue | `#4C7DFF` | **only** the logo's orbiting dot and Home's small status lights |

Rules:
- The Dashboard uses red as its single accent. Everything else is greyscale: drones are told apart by grey lightness, and the selected item is off-white.
- No striped or hatched fills anywhere. Use solid 1px outlines or flat tints.
- Panels: radius 16 px; cards: 14 px; pill buttons: 999 px. Borders are `box-shadow: 0 0 0 1px <line>`.

## 3. Typography

- Load from Google Fonts: **Archivo** (variable, `wdth 62..125`, `wght 100..900`) and **IBM Plex Mono** 400/500/600.
- Extra-wide display style (`font-stretch: 125%`, weight 800–900) is **only** for the BOSCO wordmarks, the Home hero and the incident title.
- Panel headings: Archivo 700 at normal width. Stat numbers: Archivo 700, 24–28 px, normal width.
- Labels: Plex Mono at 11–12 px, sentence case (avoid all caps except short tags such as `FIRE DETECTED`).
- Body: Archivo 14–16 px. Minimum text size is 11 px.

## 4. Logo mark component

Build one reusable `BoscoMark` component (props: `size`, `animated`, `ringColor`, `bgColor`), matching `assets/bosco-mark.svg`:
- A segmented reticle ring: circle r=40, stroke 15, `stroke-dasharray 52.8 10`, `stroke-dashoffset -5`, rotated −90°.
- The flame core path in accent red. When animated, it sways from its base (`transform-origin 50px 67px`, 2.6 s ease-in-out, keyframes in the SVG).
- The blue dot at (50,3), r=6, stroke = page background width 3, orbiting the centre every 9 s, linear. The ring itself does not spin.
- The wordmark is `B` + mark + `SCO`, with the mark at 0.86em replacing the O.
- Honour `prefers-reduced-motion`: all motion stops.

## 5. Home (`reference/home.dc.html`)

- Full-viewport dark page. Faint contour-line SVG behind everything (stroke at 6% opacity, slow 9 s "breathing" animation).
- Header: small wide `BOSCO` wordmark on the left; on the right a static blue dot and "Training exercise" in mono.
- Hero: giant wordmark (`clamp(76px, 12vw, 184px)`). Beside it sits the **drone chip**: a 240×135 looping muted `drone-hover.mp4` with a gentle 3.2 s hover bob. It has no box or border: the video fades to transparent at its edges with a radial mask, and has white corner brackets and a `BSC-01` label. Under it is the mono label "Take it apart ↗". Clicking it opens the teardown.
- Acronym line: **B**ushfire **O**bservation, **S**imulation and **C**oordination **O**perations, with the capitals in accent red.
- A divider, then the description on the left and the **Get started** pill button (accent background, dark text, arrow icon) on the right.
- Footer: "Observe · Simulate · Coordinate" and "A person decides" in faint mono.

## 6. Drone teardown (inside Home)

Full-screen dialog over Home (`role="dialog"`, `aria-modal`). Performance is the main requirement here; the first version lagged.
- A scroll container with content height `520vh` and a sticky 100vh stage inside.
- **Render frames to a single `<canvas>`**, never stacked `<img>`s, and never re-render the whole page per scroll event:
  - Preload all 120 frames when the dialog opens. Load coarse-to-fine: every 8th frame first, then every 4th, every 2nd, then the rest, with at most 6 requests in flight. Call `img.decode()` on each.
  - On scroll, use one `requestAnimationFrame` per frame. Compute `p = scrollTop / (scrollHeight − clientHeight)` and frame `round(min(1, p/0.85) × 119)`, then draw it with object-fit "contain" maths. If that frame hasn't loaded, draw the nearest loaded one. Size the canvas to its box × devicePixelRatio (cap 2) and redraw on resize.
  - Only update framework state when the stage index or the 5% progress counter changes.
- Overlay UI:
  - top bar: "BSC-01 · Teardown · N%" plus a 44 px round close button
  - left rail: the letters B-O-S-C-O. The current stage is accent red with its word beside it, passed stages are text colour and future stages `#3A3B40`. Stage = `floor(min(0.999, p/0.9) × 5)`.
  - bottom-right callout card: kicker, title and body per stage, cross-fading over 0.35 s. The copy is in the reference file.
  - "Scroll to take it apart ↓" hint only at 0%; the **Get started** button appears only at 100%.
- The teardown's Get started uses the same transition as Home's (§7).

## 7. Transitions (must feel like one continuous motion)

**Home → Dashboard** (Get started):
1. Home content fades out with a slight shrink: `opacity 0, scale .985`, 0.4 s.
2. A full-screen bg-coloured cover fades in (0.4 s). The mark spins in at 132 px: from `scale 1.25, rotate −120°, opacity 0` to rest, 0.45 s, `cubic-bezier(.2,.7,.2,1)`.
3. After 420 ms, navigate.
4. The Dashboard mounts with the same cover. The mark continues the spin out: from rest to `scale .35, rotate 150°, opacity 0`, 0.6 s. The cover holds for 30% of 0.8 s, then fades. The content rises 12 px into place over 0.7 s.

**Dashboard → Home** (clicking the logo in the Dashboard's left rail): the exact mirror.
- The Dashboard plays steps 1–3, stopping the fire-timeline playback first, then navigates to Home.
- Set a one-shot flag (e.g. `sessionStorage['bx-home-intro']`) before navigating. Home plays step 4 only when that flag is present, then clears it. A direct visit to Home shows no intro.

Respect `prefers-reduced-motion`: navigate immediately with no cover.

## 8. Dashboard (`reference/dashboard.dc.html`)

The layout is a 72 px left rail plus fluid content (max-width 1440, padding 24/28). Every panel below exists and works; **don't add features that aren't listed**.

1. **Rail.** The logo (triggers §7's return transition), Map, Leads (with a red badge showing the open-lead count) and Fleet. These are anchor links to the sections.
2. **Top bar.**
   - `BOSCO / Incident workspace`.
   - A status pill showing `Replay`, or `Live demo` in off-white.
   - A **Live demo** toggle.
   - **Exit replay**, which links to Home.
   - A connection chip for ANAFI (connected) and TigerData (dashed, not connected).
3. **Incident header.**
   - A kicker: "Historical incident · Fleet".
   - The wide title "Horse River (Fort McMurray)" with a red `FIRE DETECTED` tag.
   - A subtitle line.
   - An **Export brief** button.
4. **Fleet banner.** A flat red tint with a 1px red outline. Its text is live: "{drone} {state}; 4 drones in aerial observation · {n} unique people spotted."
5. **Five stat cards.**
   - Fire area (ha), which grows with the timeline as `9.6 × k²`, where `k = 1 + minute/60 × 0.9`.
   - Wind: 40 km/h toward NE.
   - Detection: 96%.
   - **People found**: open leads, plus "{n} seen from 2+ angles · {n} not acknowledged". This card is red-tinted and links to the leads section.
   - Drone power: the selected drone's battery.
6. **Fire spread explorer.**
   - **Header:** a mode tag, plus **Conditions** (toggles wind arrows on the map) and expand buttons.
   - **Map:** illustrative greyscale terrain SVG with a 1 px red outline.
     - The fire outline scales with the timeline.
     - It shows the ignition marker, the patrol route and the 7 numbered lead markers (faded once closed).
     - It shows 4 numbered drone markers; the selected drone shows its camera cone.
     - **Overlays:** location pill, incident `<select>`, recentre button, zoom/locate/fit controls, intensity legend (faint red → red) and the "Illustrative terrain · not for navigation" scale.
   - **Timeline:**
     - The "T + N min / Projected from now" readout.
     - **Now / +30 / +60** preset buttons.
     - Play/pause; while playing, if Follow searcher is on, the selected drone rotates every 15 min.
     - A 0–60 range slider over a small growth curve.
     - A speed button cycling 1× / 2× / 4×.
7. **Fleet POV.**
   - **Header:** "{drone} · Fleet POV", a `4 DRONE FLEET` tag and expand.
   - **Controls:** a **Follow searcher** toggle and a **Replay speed** select (1/2/4/8×).
   - **Drone carousel:** a horizontal scroll-snap row of 4 drone cards (ID, battery, mini camera thumbnail, state, altitude/speed, people spotted). Clicking one selects it and turns Follow off.
   - **Camera feed:** a large feed with corner brackets, a centre reticle and HUD text (REC dot — the **only** pulsing light on the Dashboard — heading, ALT/SPD/BAT, distance to the fire edge, fps, state).
   - **Stats:** a 2×2 grid (altitude above takeoff, ground speed, drone power, flight state) and a telemetry footer line.
   - **Keep the camera feeds dark** in both themes.
8. **People · rescue leads.**
   - **Header:** a **Responder** text input (name or call sign) and expand.
   - **Counts:** open leads, seen from 2+ angles, not acknowledged (red), ground observed (leads closed as Rescued or Confirmed safe; "—" if none).
   - **Lead cards (7):**
     - Number badge, title (Possible person / Candidate), tag (POSSIBLE PERSON / NEEDS ANOTHER ANGLE) and a bearing compass.
     - Details: location, accuracy, last seen + image link, evidence, source drones, movement, and a red fire ETA that shrinks as the timeline advances.
     - "Person seen at the perimeter", plus an expandable Sightings section.
     - **Actions:**
       - **Acknowledge** records the responder's name and logs an event.
       - **Close lead** is a reason `<select>` (Rescued, Confirmed safe, Duplicate, Not a person) plus a **Close** button. Close is disabled until a reason is chosen, and closing logs an event.
     - **States:** acknowledged cards get an off-white ring; closed cards dim to 50%.
   - **Search log:** filter chips (All, People, Fire, Drones, Reviews), an Export button and a timestamped list. New acknowledge/close events go at the top.
9. **Footer.** BOSCO wordmark and a "Data sources →" link.

**Data:** every lead, drone, log entry and number in the reference is **placeholder fixture data**. Put it all in one fixtures module, shaped so real API data can replace it later. Don't scatter literals through components.

## 9. Light theme (`reference/dashboard-light.dc.html`)

Implement light mode as a **theme of the same Dashboard**, switched by a `data-theme="light"` attribute and token overrides. Do not build a second page. Light mode applies to the Dashboard only; Home stays dark.

| Token | Light value |
|---|---|
| bg / surface / surface-sunk / surface-raised | `#F4F3EF` / `#FFFFFF` / `#FAFAF8` / `#EDECE7` |
| line-1 / line-2 / line-3 | `#E6E4DE` / `#E2E0DA` / `#D3D1CA` |
| text / text-2 / muted / label / faint | `#111114` / `#2A2B30` / `#55575D` / `#64666C` / `#7A7C82` |
| accent / accent-text | `#D12F22` / `#C42A1D` (white text on accent buttons) |

- Selected states invert: dark fill, light text.
- The map becomes light grey terrain.
- The camera feeds and the transition cover stay dark.
- Apply the same no-stripes and typography rules as dark mode. The reference light file predates those fixes, so follow this brief where they differ.
- Add a theme toggle in the Dashboard top bar and persist the choice in `localStorage` (wrapped in try/catch).

## 10. Quality bar

- Accessibility:
  - Real `<button>`, `<a>`, `<label>` and `<select>` elements.
  - `aria-label` on icon-only buttons.
  - `aria-pressed` on toggles.
  - Visible focus rings.
  - Touch targets ≥ 40 px.
  - Text contrast ≥ 4.5:1.
- Responsive: panels wrap to one column on narrow screens and the rail stacks above the content. No horizontal page scroll at 375 px.
- `prefers-reduced-motion` disables every animation and transition.
- No console errors. Timers and listeners are cleaned up on unmount.

## 11. Done when

- [ ] Home matches the reference, and the drone chip opens the teardown.
- [ ] The teardown scrolls at 60 fps through all 120 frames, with stages, progress, the hint and the end CTA working.
- [ ] Get started (from the hero and from the teardown) plays the spin-in → spin-out transition into the Dashboard.
- [ ] The Dashboard logo plays the mirrored transition back to Home, and Home's intro only plays after it.
- [ ] Every Dashboard control in §8 works: timeline, presets, play, speed, conditions, drone select, follow, replay speed, acknowledge, close, log filters, live/replay toggle.
- [ ] Red is the only accent on the Dashboard, and there are no stripes.
- [ ] The light theme toggle works, persists, and keeps the camera feeds dark.
- [ ] Fixtures live in one module.

When finished, reply with what you built, where it lives, how to run it, and anything you couldn't match.
