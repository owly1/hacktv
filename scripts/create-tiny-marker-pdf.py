#!/usr/bin/env python3
"""Build the printable second fire marker without regenerating either QR image.

Run ``python3 scripts/create-tiny-marker-pdf.py`` with ReportLab installed. The
existing borderless Tiny PNG is placed at exactly 18 cm so its encoded physical
size remains valid for camera pose estimation. Print at 100%, never fit to page.
"""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_PAYLOAD = "EW1:Tiny|0.0001|L|0.01|G|0.2|60|22|45|18"
OUTPUT = ROOT / "dist/tiny-marker.pdf"


def create_pdf():
    """Write one deterministic A4 sheet using the pinned existing 18 cm QR PNG."""
    payload = (ROOT / "bridge/tiny-marker.txt").read_text(encoding="utf-8").strip()
    if payload != EXPECTED_PAYLOAD:
        raise ValueError("Tiny marker identity changed; review the PDF scenario labels.")

    width, _ = A4
    pdf = canvas.Canvas(str(OUTPUT), pagesize=A4, invariant=1, pageCompression=1)
    pdf.setTitle("Marker 2 - Tiny contour fire")
    pdf.setAuthor("BOSCO / Emberwatch")
    pdf.setSubject("18 cm Tiny fire QR; 1 square metre; wind 0.2 km/h; spread 1 cm/min")

    pdf.setFont("Helvetica-Bold", 24)
    pdf.drawCentredString(width / 2, 285 * mm, "MARKER 2")
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawCentredString(width / 2, 277 * mm, "TINY CONTOUR FIRE")

    # Keep all the available 15 mm A4 side margin and at least 25 mm above/below
    # the QR free of text. The source PNG has no border: its full 180 mm extent
    # is the measured marker, not an image that includes a white quiet zone.
    pdf.drawImage(str(ROOT / "dist/tiny-marker.png"), 15 * mm, 72 * mm,
                  width=180 * mm, height=180 * mm)

    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawCentredString(width / 2, 44 * mm, "1 m\u00b2 fire  |  Wind 0.2 km/h  |  Spread 1 cm/min")
    pdf.setFont("Helvetica", 9)
    pdf.drawCentredString(width / 2, 37 * mm,
                         "Low intensity - cured grass - wind toward 60\u00b0 - 22\u00b0C - 45% humidity")
    pdf.setFont("Helvetica-Bold", 10)
    pdf.drawCentredString(width / 2, 25 * mm,
                         "PRINT AT 100% / ACTUAL SIZE. TURN OFF FIT TO PAGE.")
    pdf.setFont("Helvetica", 9)
    pdf.drawCentredString(width / 2, 19 * mm,
                         "The QR square must measure exactly 18 cm on each side.")
    pdf.drawCentredString(width / 2, 12 * mm,
                         "Marker 2 is Tiny. The original Alpha marker remains unchanged.")
    pdf.showPage()
    pdf.save()
    print(OUTPUT)


if __name__ == "__main__":
    create_pdf()
