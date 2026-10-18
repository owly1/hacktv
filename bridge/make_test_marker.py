#!/usr/bin/env python3
"""
Make the Emberwatch QR fire marker: the printable QR code that the bridge treats
as a large fire. The fire's details ride inside the code, so pointing the
drone's camera at it drives the whole pipeline (detection -> map pin ->
spread -> Gemini analysis -> plan) without a real fire.

    python3 bridge/make_test_marker.py

This is the only QR code the drone reacts to as a fire (the FireSimulationDemo
printout). The bridge accepts FIRE_MARKER_PAYLOAD byte for byte and ignores
every other code, so the fire details are fixed here rather than options.

Writes dist/test-marker.png and dist/test-marker.html (open it at
http://127.0.0.1:8787/test-marker.html and print at 100% scale).
"""

import os
from types import SimpleNamespace

import segno

QR_PREFIX = "EW1:"
# Must match FIRE_MARKER_PAYLOAD in bridge/fire_detection.py and backend/validation.mjs.
FIRE_MARKER_PAYLOAD = "EW1:Alpha|120|X|35|M|30|60|31|18|18"
INTENSITY = {"L": "low", "M": "moderate", "H": "high", "X": "extreme"}
FUEL = {"F": "dry conifer forest", "G": "cured grass", "M": "dry mixed forest and grass", "S": "brush and shrub"}
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")
FIRE = SimpleNamespace(name="Alpha", area=120.0, intensity="X", spread=35.0, fuel="M", wind=30.0,
                       dir=60.0, temp=31.0, rh=18.0, size_cm=18.0)


def main():
    """Generate the pinned fire QR image and its printable page without changing its payload."""
    a = FIRE
    # Short payload -> few, large modules, so the code still reads from ~2 m away.
    values = [a.name, a.area, a.intensity, a.spread, a.fuel, a.wind, a.dir, a.temp, a.rh, a.size_cm]
    text = QR_PREFIX + "|".join(f"{v:g}" if isinstance(v, float) else str(v) for v in values)
    assert text == FIRE_MARKER_PAYLOAD, f"marker {text!r} drifted from {FIRE_MARKER_PAYLOAD!r}"
    qr = segno.make(text, error="m", micro=False)
    png = os.path.join(DIST, "test-marker.png")
    qr.save(png, scale=24, border=0, dark="#111111")

    rows = "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in [
        ("Name", a.name), ("Area", f"{a.area:g} ha"), ("Intensity", INTENSITY[a.intensity]),
        ("Spread rate", f"{a.spread:g} m/min"), ("Fuel", FUEL[a.fuel]), ("Wind", f"{a.wind:g} km/h toward {a.dir:g}°"),
        ("Temperature", f"{a.temp:g} °C"), ("Humidity", f"{a.rh:g} %")])
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Emberwatch test marker</title>
<style>
@page{{size:auto;margin:12mm}}
body{{font-family:Inter,"Segoe UI",Arial,sans-serif;color:#263337;margin:0;padding:16px;background:#fff}}
.sheet{{max-width:190mm;margin:0 auto;text-align:center}}
h1{{font-size:20px;margin:0 0 4px}} p{{margin:4px 0;color:#5b6673;font-size:13px}}
.code{{width:{a.size_cm:g}cm;height:{a.size_cm:g}cm;margin:10mm auto 6mm;display:block;image-rendering:pixelated}}
.frame{{display:inline-block;padding:8mm;border:2px solid #111}}
table{{margin:6mm auto 0;border-collapse:collapse;font-size:12px;text-align:left}}
th,td{{padding:3px 10px;border-bottom:1px solid #e4e8eb}} th{{color:#7b858b;font-weight:600}}
.tips{{font-size:12px;text-align:left;max-width:150mm;margin:6mm auto 0}}
@media print{{.noprint{{display:none}}}}
</style></head><body><div class="sheet">
<h1>Emberwatch fire test marker</h1>
<p>The drone treats this code, and only this code, as a large fire with the details below.</p>
<div class="frame"><img class="code" src="test-marker.png" alt="Emberwatch QR test marker"></div>
<table>{rows}</table>
<div class="tips"><p><b>Print at 100% scale</b> (no "fit to page"); the code must measure {a.size_cm:g} cm per side —
the bridge uses that size to work out how far away the fire is. Lay it flat on the floor or a table in an open,
well-lit spot, away from glare. The drone flies its demo circle with the camera tilted down, so the marker
should sit about 1–2 m from the take-off point.</p>
<p class="noprint"><button onclick="print()">Print</button></p></div>
</div></body></html>
"""
    with open(os.path.join(DIST, "test-marker.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Marker: {text}")
    print(f"Wrote {os.path.abspath(png)} and test-marker.html (print at 100%, {a.size_cm:g} cm side)")


if __name__ == "__main__":
    main()
