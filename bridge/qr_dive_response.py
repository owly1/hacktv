#!/usr/bin/env python3
"""One SDK owner: accepted QR -> circle -> D measured person search -> reacquire -> circle.

Starts disarmed. Both the original QR flight lease and a separate browser-owned
search lease must remain current during a descent. No import-time radio access.
"""
import os
import signal
import threading
import time
from dive_surveillance import DiveSurveillance,OlympeDiveDriver


class SearchHandover(Exception):
    """Unwind the orbit through its neutral/stop-piloting cleanup without requesting LAND."""


class SharedDiveDriver(OlympeDiveDriver):
    """Use the QR receiver's existing sensor subscriptions and confirmed landing driver."""
    def snapshot(self):
        """Expose actual SDK values and event ages from the same aircraft connection."""
        b=self.bridge
        if b.connected and b.drone is not None:b._poll_telemetry()
        t=b.telemetry or {};attitude=t.get('attitude_deg') or {}
        self.events=b.sensor_ages.ages if b.sensor_ages else {}
        return {'connected':bool(b.connected and b._aircraft_link()),'state':t.get('state'),
            'altitude_m':t.get('altitude_m'),'battery_pct':t.get('battery_pct'),'speed_mps':t.get('ground_speed_mps'),
            'roll_deg':attitude.get('roll'),'pitch_deg':attitude.get('pitch'),'yaw_deg':attitude.get('yaw'),
            'camera_pitch_deg':b._gimbal_pitch(),
            'ages':{**{key:time.monotonic()-self.events.get(key,float('-inf')) for key in ('altitude','speed','attitude','camera')},
                    'video':time.time()-b.last_frame_time}}

    def _land_once(self):
        """Keep urgent landing and shutdown serialized by the QR driver's existing lock."""
        confirmed=bool(self.bridge.driver.land())
        self.bridge.report('landed' if confirmed else 'error',
            'Aircraft confirmed landed' if confirmed else 'LANDING UNCONFIRMED: inspect the aircraft')
        return confirmed


class CircleSearch(DiveSurveillance):
    """Queue D onto the existing mission worker, never start a competing maneuver thread."""
    def __init__(self,bridge,**kwargs):
        """Track the handover separately from the independently refreshed movement lease."""
        super().__init__(bridge,**kwargs);self.requested=threading.Event()

    def reason(self,starting=False):
        """Allow requests during a healthy circle; require stationary hover when executing."""
        b=self.bridge
        if not b.takeoff_used or b._is_contour() or not b.circle_active.is_set():
            if not self.busy.is_set():return 'Establish the QR circle before requesting D'
        if b.checkout_reason_control():return 'The original BOSCO flight session is no longer authorized'
        if starting and b.circle_active.is_set():
            # Circling may be faster than search motion. Use the QR flight's
            # own measured vehicle gates here; execution rechecks stationary hover.
            from qr_orbit_core import vehicle_reason
            vehicle=b._preset_vehicle()
            return vehicle_reason(vehicle,b.limits,self.clock(),min_battery_pct=40)
        if self.phase=='pausing':return super().reason(False,motion_limit=.75)
        return super().reason(starting)

    def launch(self,command):
        """Signal the orbit worker; its finally block must neutralize piloting first."""
        self.requested.set()

    def check(self):
        """Require the original QR owner session throughout every search movement."""
        if self.bridge.checkout_reason_control():raise InterruptedError('Original BOSCO flight permission expired')
        return super().check()

    def _idle_land(self):
        """Route X outside a search through the original mission's landing cleanup."""
        self.bridge._request_landing(force=False)
        self.phase='landed' if self.bridge.land_confirmed or (self.bridge.telemetry or {}).get('state')=='landed' else 'landing'
        self.busy.clear()

    def execute_handover(self):
        """Wait for orbit cleanup and camera ownership, then run the measured search inline."""
        b=self.bridge;command=self.command
        b.circle_active.clear();self.phase='pausing';b.camera_pause.set()
        try:
            self.refresh()
            deadline=self.clock()+4
            while not b.camera_paused.is_set():
                self.check()
                if self.clock()>=deadline:raise TimeoutError('QR camera did not release ownership')
                self.sleep(.03)
            self.driver.settle(self.check)
            super()._execute(command)
            if b.abort_flight.is_set():raise InterruptedError('Search stopped; landing requested')
            if self.phase!='hovering':raise RuntimeError(self.last_error or 'Search did not complete')
        except Exception as error:
            b._request_landing(force=False)
            if command is not None and command['id'] not in self.outcomes:
                try:self._ack(command,'aborted',str(error))
                except Exception:pass
            raise
        finally:
            self.requested.clear();self.busy.clear();self.command=None
            b.camera_pause.clear()


def combined_response_class(base):
    """Create the SDK receiver extension while allowing SDK-free orchestration tests."""
    class QRDiveResponse(base):
        """Keep QR takeoff, circle, dive and landing within the inherited SDK connection."""
        def __init__(self,args,publisher):
            """Prepare shared control locks; actual flight remains dashboard-gated."""
            super().__init__(args,publisher)
            self.flight_lock=threading.Lock();self.circle_active=threading.Event()
            self.camera_pause=threading.Event();self.camera_paused=threading.Event()
            self.dive=CircleSearch(self,driver=SharedDiveDriver(self));self.reacquire_after=None

        def _sample_fire(self):
            """Prioritize LAND, then allow D to unwind the continuous orbit safely."""
            sample=super()._sample_fire()
            if self.dive.requested.is_set():raise SearchHandover()
            vehicle,target=sample
            if self.reacquire_after is not None and (target is None or target.at<=self.reacquire_after):target=None
            return vehicle,target

        def _is_contour(self):
            """Keep GPS contour takeoff disabled in this explicitly combined QR runtime."""
            return False

        def _contour_reason(self):
            """Advertise why the separate GPS contour action is unavailable here."""
            return 'QR + D receiver supports circular Start BOSCO; use the separate runtime for GPS contour flight'

        def _after_hover(self):
            """Resume only from newly measured QR geometry after each completed search."""
            if self._is_contour():raise ValueError('Use circular Start BOSCO for QR + D; contour is a separate runtime')
            while self.running and not self.abort_flight.is_set():
                self.circle_active.set();self.dive.phase='circling'
                try:
                    super()._after_hover()
                    return
                except SearchHandover:
                    # orbit_continuously has returned through neutral and
                    # stop_piloting before any moveBy/gimbal search command.
                    self.dive.execute_handover()
                    self.orbit_target=None;self.orbit_target_updated_at=float('-inf')
                    self.camera_aim_sample=None;self.reacquire_after=time.monotonic()
                    self.report('recover','Search complete; reacquiring measured QR before circling')
                finally:self.circle_active.clear()

        def run(self):
            """Refresh search status independently of blocking movement or camera upload."""
            worker=threading.Thread(target=self.dive.poll,daemon=True);worker.start()
            try:super().run()
            finally:
                worker.join(timeout=2)
                self.dive.phase='landed' if self.land_confirmed else 'error'
                try:self.dive.refresh()
                except Exception:pass
    return QRDiveResponse


def main():
    """Start one disarmed circle/search receiver with normal battery and landing guards."""
    from anafi_bridge import Publisher,argument_parser
    from fire_response import FireResponse
    parser=argument_parser();parser.description=__doc__
    parser.add_argument('--camera-calibration',default='camera.local.json')
    args=parser.parse_args()
    if args.controller!='direct' or args.demo_flight or args.gimbal_pitch is not None or not args.backend:
        parser.error('Use direct control and a backend, without another flight/gimbal mode')
    if not os.environ.get('INGEST_TOKEN'):parser.error('INGEST_TOKEN required')
    args.until_stop=True;args.short_test=False;args.adaptive_qr=True;args.lap_seconds=15.
    args.no_window=args.no_auto_gimbal=args.terminal_control=True
    args.checkout_one_segment=False;args.hover_seconds=1
    bridge=combined_response_class(FireResponse)(args,Publisher(args.out_dir,args.backend,os.environ['INGEST_TOKEN']))
    def stop(*_):
        """End permission and let the mission's finally block confirm actual landing."""
        bridge._request_landing(force=False);bridge.running=False
    for name in ('SIGTERM','SIGHUP','SIGINT'):
        if hasattr(signal,name):signal.signal(getattr(signal,name),stop)
    bridge.run()


if __name__=='__main__':main()
