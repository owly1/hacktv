#!/usr/bin/env python3
"""Read-only readiness check. No drone connection, installation or flight commands."""
import argparse
import json
import platform
import subprocess
import sys
from pathlib import Path


def read_text(path):
    try:
        return Path(path).read_text().strip().strip("\x00")
    except OSError:
        return None


def package_import(name):
    # Import in a bounded child process; native SDK imports can fail or hang.
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import " + name],
            capture_output=True, timeout=20, check=False,
        )
        return "imported" if result.returncode == 0 else "unavailable_or_import_failed"
    except subprocess.TimeoutExpired:
        return "import_timed_out"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", action="store_true", help="Also check OpenCV for JPEG snapshots")
    args = parser.parse_args()
    report = {
        "purpose": "software readiness only; no hardware verification",
        "platform": platform.system(),
        "architecture": platform.machine(),
        "python": platform.python_version(),
        "board_model": read_text("/proc/device-tree/model"),
        "olympe": package_import("olympe"),
        "drone_connection": "not_attempted",
        "backend_connection": "not_attempted",
        "camera": package_import("cv2") if args.camera else "not_checked",
    }
    system_ok = report["platform"] == "Linux"
    sdk_ok = report["olympe"] == "imported"
    camera_ok = not args.camera or report["camera"] == "imported"
    report["software_import_checks_passed"] = system_ok and sdk_ok and camera_ok
    if report["architecture"] in ("aarch64", "arm64", "armv7l"):
        report["arm_note"] = "Parrot Olympe currently requires a source build on ARM; an import does not prove hardware compatibility."
    print(json.dumps(report, indent=2))
    return 0 if report["software_import_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
