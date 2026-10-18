#!/usr/bin/env python3
"""
Make either pinned Emberwatch fire QR: the original Alpha scenario or the
one-square-metre Tiny scenario for the separate forecast-contour mode.

    python3 bridge/make_test_marker.py
    python3 bridge/make_test_marker.py --marker tiny

The bridge accepts these exact identities and ignores other payloads. The
default preserves Alpha's test-marker paths; --marker tiny writes tiny-marker
files. --html-only refreshes the printable page without rewriting its image.
"""

import argparse
import os
from types import SimpleNamespace

import segno

QR_PREFIX = "EW1:"
# Must match FIRE_MARKER_PAYLOAD in bridge/fire_detection.py and backend/validation.mjs.
FIRE_MARKER_PAYLOAD = "EW1:Alpha|120|X|35|M|30|60|31|18|18"
TINY_FIRE_MARKER_PAYLOAD = "EW1:Tiny|0.0001|L|0.01|G|0.2|60|22|45|18"
FIRE_MARKER_PAYLOADS = (FIRE_MARKER_PAYLOAD, TINY_FIRE_MARKER_PAYLOAD)
INTENSITY = {"L": "low", "M": "moderate", "H": "high", "X": "extreme"}
FUEL = {"F": "dry conifer forest", "G": "cured grass", "M": "dry mixed forest and grass", "S": "brush and shrub"}
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")
FIRE = SimpleNamespace(name="Alpha", area=120.0, intensity="X", spread=35.0, fuel="M", wind=30.0,
                       dir=60.0, temp=31.0, rh=18.0, size_cm=18.0)
TINY_FIRE = SimpleNamespace(name="Tiny", area=0.0001, intensity="L", spread=0.01, fuel="G", wind=0.2,
                           dir=60.0, temp=22.0, rh=45.0, size_cm=18.0)


def generate(marker, *, html_only=False):
    """Write one pinned scenario's 18 cm print sheet and, unless omitted, QR PNG."""
    tiny = marker == 'tiny'
    a = TINY_FIRE if tiny else FIRE
    expected = TINY_FIRE_MARKER_PAYLOAD if tiny else FIRE_MARKER_PAYLOAD
    stem = 'tiny-marker' if tiny else 'test-marker'
    # Short payload -> few, large modules, so the code still reads from ~2 m away.
    values = [a.name, a.area, a.intensity, a.spread, a.fuel, a.wind, a.dir, a.temp, a.rh, a.size_cm]
    text = QR_PREFIX + "|".join(f"{v:g}" if isinstance(v, float) else str(v) for v in values)
    assert text == expected, f"marker {text!r} drifted from {expected!r}"
    png = os.path.join(DIST, stem + '.png')
    if not html_only:
        qr = segno.make(text, error="m", micro=False)
        qr.save(png, scale=24, border=0, dark="#111111")

    rows = "".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in [
        ("Name", a.name), ("Area", "1 m² (0.0001 ha)" if tiny else f"{a.area:g} ha"), ("Intensity", INTENSITY[a.intensity]),
        ("Spread rate", f"{a.spread:g} m/min"), ("Fuel", FUEL[a.fuel]), ("Wind", f"{a.wind:g} km/h toward {a.dir:g}°"),
        ("Temperature", f"{a.temp:g} °C"), ("Humidity", f"{a.rh:g} %")])
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Emberwatch {a.name} fire marker</title>
<style>
@page{{size:A4 portrait;margin:10mm}}
body{{font-family:Inter,"Segoe UI",Arial,sans-serif;color:#263337;margin:0;padding:16px 0;background:#fff}}
.sheet{{max-width:190mm;margin:0 auto;text-align:center}}
h1{{font-size:20px;margin:0 0 4px}} p{{margin:4px 0;color:#5b6673;font-size:13px}}
.code{{width:{a.size_cm:g}cm;height:{a.size_cm:g}cm;margin:0;display:block;image-rendering:pixelated}}
.frame{{display:inline-block;padding:4mm;margin-top:3mm;background:#fff}}
table{{margin:2mm auto 0;border-collapse:collapse;font-size:11px;text-align:left}}
th,td{{padding:2px 10px;border-bottom:1px solid #e4e8eb}} th{{color:#7b858b;font-weight:600}}
.tips{{font-size:11px;text-align:left;max-width:180mm;margin:3mm auto 0}}
.tips p{{font-size:11px}}
@media print{{body{{padding:0}}.noprint{{display:none}}.sheet{{break-inside:avoid}}}}
</style></head><body><div class="sheet">
<h1>Emberwatch {a.name} fire test marker</h1>
<p>{'Small contour demo · 1 m² fire · 0.2 km/h wind · 1 cm/min spread' if tiny else 'Original circular demo · 120 ha fire · 35 m/min spread'}</p>
<p class="noprint"><a href="{'test-marker.html' if tiny else 'tiny-marker.html'}">{'Original Alpha marker' if tiny else 'Tiny fire marker for contour demo'}</a></p>
<div class="frame"><img class="code" src="{stem}.png" alt="Emberwatch {a.name} QR test marker"></div>
<table>{rows}</table>
<div class="tips"><p><b>Print at 100% scale</b> (no "fit to page"); the code must measure {a.size_cm:g} cm per side —
the bridge uses that size to estimate marker position. Lay it flat in an open, well-lit spot, away from glare.</p>
<p>{'Select Forecast Contour in Live for this scenario. The marker identifies the general fire area; the separate flight runtime follows GPS forecast coordinates. A tiny scenario does not imply centimetre-accurate GPS.' if tiny else 'Alpha retains the original circular movement. Follow the flight guide for setup and launch spacing.'}</p>
<p class="noprint"><button onclick="print()">Print</button></p></div>
</div></body></html>
"""
    with open(os.path.join(DIST, stem + '.html'), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Marker: {text}")
    print(f"Wrote {stem + '.html' if html_only else stem + '.png and ' + stem + '.html'} (print at 100%, {a.size_cm:g} cm side)")


def main():
    """Select the original or tiny scenario without permitting arbitrary fire payloads."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--marker', choices=('alpha', 'tiny'), default='alpha')
    parser.add_argument('--html-only', action='store_true')
    args = parser.parse_args()
    generate(args.marker, html_only=args.html_only)


if __name__ == "__main__":
    main()
