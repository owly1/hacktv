#!/usr/bin/env python3
"""Dive-surveillance maneuver + backend command poller for anafi_bridge.py.

The dashboard's 'd' key POSTs a command to the backend; the bridge polls
GET /api/commands/next, executes the maneuver, and acks the result — the
bridge stays the only process that can move the drone.

Maneuver: descend to ~floor_agl_m above the floor (default 0.4 m), yaw a
full sweep (default 360 deg) so the camera covers everything around the
drone — the sweep is where person CV sees people low near the fire — then
climb back to the starting altitude.

Integration (one line in anafi_bridge.Bridge.__init__/run):
    self.dive = DiveSurveillance(self)
    workers.append(self.dive.poll)          # alongside the other workers

Safety: requires the drone already airborne and hovering ('flying'). If it
is landed or in another phase the command is acked 'aborted'. The existing
abort_flight flag (typed x / 'l' key / Ctrl+C) cancels mid-maneuver and the
existing _land() path still applies. NOT hardware-tested yet — verify on
the real ANAFI before the demo.
"""

import json
import math
import threading
import time

POLL_INTERVAL_S = 1.0
MIN_ALTITUDE_M = 0.6          # never dive when already at/below this — nothing to gain
SEGMENT_YAW_RAD = math.pi / 2  # 360 sweep in 4 quarter turns: camera dwells each quadrant


class DiveSurveillance:
    def __init__(self, bridge):
        self.bridge = bridge          # anafi_bridge.Bridge instance
        self.busy = threading.Event()  # one maneuver at a time

    # ---------- command polling ----------
    def poll(self):
        """Worker loop: ask the backend for the next pending command."""
        while self.bridge.running:
            try:
                cmd = (self._poll_next() or {}).get("command")
            except Exception:
                cmd = None
            if cmd:
                self._execute(cmd)
            time.sleep(POLL_INTERVAL_S)

    def _poll_next(self):
        """GET /api/commands/next on the publisher's keep-alive connection."""
        pub = self.bridge.publisher
        if not pub.url:
            return None
        conn = pub._conn()
        conn.request("GET", "/api/commands/next",
                     headers={"Authorization": f"Bearer {pub.token}"})
        data = conn.getresponse().read()
        return json.loads(data) if data else {}

    def _ack(self, cmd_id, status, note=""):
        try:
            self.bridge.publisher._post(
                f"/api/commands/{cmd_id}/ack",
                json.dumps({"status": status, "note": note}).encode())
        except Exception as e:
            print(f"[!] command ack failed: {e!r}")

    def _execute(self, cmd):
        if cmd["type"] != "dive-surveillance":
            self._ack(cmd["id"], "failed", f"unknown type {cmd['type']}")
            return
        if self.busy.is_set():
            self._ack(cmd["id"], "aborted", "a maneuver is already running")
            return
        self.busy.set()
        try:
            self._run_dive(cmd["id"], cmd.get("params") or {})
        finally:
            self.busy.clear()

    # ---------- the maneuver ----------
    def _run_dive(self, cmd_id, params):
        b = self.bridge
        floor_agl = float(params.get("floor_agl_m", 0.4))
        sweep_deg = float(params.get("sweep_deg", 360.0))
        sweep_rad = math.radians(sweep_deg)

        t = b.telemetry or {}
        if t.get("state") != "flying":
            self._ack(cmd_id, "aborted",
                      f"drone not airborne (state {t.get('state')}); requires hovering flight")
            return
        alt = t.get("altitude_m")
        if not isinstance(alt, (int, float)):
            self._ack(cmd_id, "aborted", "no altitude telemetry")
            return
        drop = alt - floor_agl
        if drop < 0.1 or alt <= MIN_ALTITUDE_M:
            self._ack(cmd_id, "aborted",
                      f"already at {alt:.1f} m — dive needs more than {MIN_ALTITUDE_M} m")
            return

        self._ack(cmd_id, "in_progress", f"descending to {floor_agl} m AGL")
        b.flight_phase = "dive"
        b.publisher.flight("dive", f"descend to {floor_agl} m AGL, sweep {sweep_deg:.0f} deg")
        try:
            b._move(0.0, drop, 0.0, "dive descent")           # +dz descends (see _demo_flight)
            segments = max(1, round(sweep_rad / SEGMENT_YAW_RAD))
            for i in range(segments):
                if b.abort_flight.is_set():
                    raise InterruptedError
                b.flight_phase = "surveil"
                b.publisher.flight("surveil", f"sweep segment {i + 1}/{segments}",
                                   step=i + 1, steps=segments)
                b._move(0.0, 0.0, sweep_rad / segments, f"surveil sweep {i + 1}")
            b.flight_phase = "climb"
            b.publisher.flight("climb", f"returning to {alt:.1f} m")
            b._move(0.0, -drop, 0.0, "climb back")
            self._ack(cmd_id, "done", f"swept {sweep_deg:.0f} deg at {floor_agl} m AGL")
        except InterruptedError:
            b.publisher.flight("aborted", "operator abort during dive-surveillance")
            self._ack(cmd_id, "aborted", "operator abort")
            raise
        except Exception as e:
            b.publisher.flight("error", str(e))
            self._ack(cmd_id, "failed", str(e))
        finally:
            b.flight_phase = "hovering"
