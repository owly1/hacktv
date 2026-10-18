# QR recognition rehearsal and legacy orbit

## Recognition-only browser preview

With a grounded camera receiver and backend running:

```sh
python bridge/qr_orbit_rehearsal.py
```

Open <http://127.0.0.1:8789/>, confirm **LIVE DRONE CAMERA**, then **Reset** →
**Arm rehearsal**. Five fresh selected-QR frames across ≥0.8 seconds animate
a simulated orbit. No flight driver is available; this does not create a fire
incident. For a decoder-only check without hardware:

```sh
python bridge/qr_orbit_rehearsal.py --image dist/test-marker.png --port 8790
```

That page says **test image**. It proves neither a camera link nor flight.
The exact selected payload is pinned in `bridge/orbit-marker.txt`.

## Legacy measured flight runtime

`qr_orbit_bridge.py` requires a **pre-existing stable hover**; it does not
take off. Prefer the [integrated checkout](QR_FLIGHT_CHECKOUT.md) for takeoff
on the same connection. The standalone hover checkout always lands first.

Before execution, complete [measured calibration/preflight](QR_DEMO_FROM_OFF.md)
and physically verify the selected landing-control path with the Pi connected.
Do not run competing receivers or infer controller override from camera-only tests.

From the installed SDK in an interactive operator terminal, the controller route is:

```sh
python bridge/qr_orbit_bridge.py --no-window --controller skycontroller3 --ip 192.168.53.1 --backend http://127.0.0.1:8788 --drone-id ANAFI-H084882 --execute --radius 1 --height 1 --camera-calibration /absolute/path/to/measured-camera.json --preflight-file /absolute/path/to/current-preflight.json
```

Direct route uses `--controller direct --terminal-control`, controller off,
and its corresponding physical preflight fields. It is a separate runtime,
not the Windows USB camera relay. Omitting `--execute` constructs no flight driver.

Type `ARM QR ORBIT`; the arming window is 20 seconds. Defaults: 1 m radius,
1 m height, 12 polygon chords, ≤0.25 m/s horizontal and ≤25°/s yaw, 75-second
mission cap, ≥40% battery. Radius range is 0.75–1.5 m; height range 0.8–1.5 m.
The marker must be flat on the launch floor and geometrically consistent.

X/Esc, `LAND` + Enter, local video `l`, Ctrl+C, terminal closure or a failed
freshness/motion/pose guard requests landing. There is no QR search or repeated
arming; require an actual landed event. Source-only and mocked-SDK tests do
not verify physical accuracy or landing delivery through a lost link.
