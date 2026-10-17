#!/usr/bin/env python3
"""
Make the Emberwatch QR test marker: a printable QR code that the bridge treats
as a large fire. The fire's details ride inside the code, so pointing the
drone's camera at it drives the whole pipeline (detection -> map pin ->
spread -> Gemini analysis -> plan) without a real fire.

    python3 bridge/make_test_marker.py                     # default fire "Alpha"
    python3 bridge/make_test_marker.py --name Ravine --area 300 --wind 45 --dir 90

Writes dist/test-marker.png and dist/test-marker.html (open it at
http://127.0.0.1:8787/test-marker.html and print at 100% scale).
"""

import argparse
import os

import segno

QR_PREFIX = "EW1:"  # must match bridge/anafi_bridge.py
INTENSITY = {"L": "low", "M": "moderate", "H": "high", "X": "extreme"}
FUEL = {"F": "dry conifer forest", "G": "cured grass", "M": "dry mixed forest and grass", "S": "brush and shrub"}
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")


def main():
    p = argparse.ArgumentParser(description="Generate the Emberwatch QR test marker")
    p.add_argument("--name", default="Alpha", help="fire name, up to 12 characters")
    p.add_argument("--area", type=float, default=120.0, help="fire area in hectares")
    p.add_argument("--intensity", default="X", choices=["L", "M", "H", "X"],
                   help="L low, M moderate, H high, X extreme")
    p.add_argument("--spread", type=float, default=35.0, help="head-fire spread rate, metres/minute")
    p.add_argument("--fuel", default="M", choices=["F", "G", "M", "S"],
                   help="F conifer forest, G grass, M mixed forest/grass, S brush")
    p.add_argument("--wind", type=float, default=30.0, help="wind speed km/h")
    p.add_argument("--dir", type=float, default=60.0, help="direction the fire spreads toward, degrees")
    p.add_argument("--temp", type=float, default=31.0, help="air temperature °C")
    p.add_argument("--rh", type=float, default=18.0, help="relative humidity %%")
    p.add_argument("--size-cm", type=float, default=18.0, help="printed side length of the code, cm")
    a = p.parse_args()

    if "|" in a.name or len(a.name) > 12:
        p.error("--name must be at most 12 characters, without '|'")
    # Short payload -> few, large modules, so the code still reads from ~2 m away.
    values = [a.name, a.area, a.intensity, a.spread, a.fuel, a.wind, a.dir, a.temp, a.rh, a.size_cm]
    text = QR_PREFIX + "|".join(f"{v:g}" if isinstance(v, float) else str(v) for v in values)
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
<p>The drone treats this code as a large fire with the details below.</p>
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
