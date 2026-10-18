"""Bridge contract checks with a fake SDK; never connects to an aircraft."""
import contextlib
import importlib.util
import io
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "anafi_observer", Path(__file__).parents[1] / "bridge" / "anafi_observer.py"
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeContractTests(unittest.TestCase):
    def test_camera_rate_allows_full_source_rate_or_explicit_throttling(self):
        self.assertEqual(bridge.camera_fps('0'),0)
        self.assertEqual(bridge.camera_fps('30'),30)
        self.assertEqual(bridge.camera_fps('0.5'),.5)
        for value in ('-1','nan','inf','0.1','61'):
            with self.assertRaises(bridge.argparse.ArgumentTypeError):bridge.camera_fps(value)

    def test_camera_watchdog_covers_startup_and_stalled_stream(self):
        self.assertFalse(bridge.session_stalled(None, 100, 110))
        self.assertTrue(bridge.session_stalled(None, 100, 116))
        self.assertFalse(bridge.session_stalled(120, 100, 121))
        self.assertTrue(bridge.session_stalled(120, 100, 136))

    def run_bridge(self, camera=False, connect=True, lose_stream=False):
        modules = {}
        for name in ["olympe", "olympe.messages", "olympe.messages.common",
                     "olympe.messages.common.CommonState", "olympe.messages.ardrone3",
                     "olympe.messages.ardrone3.PilotingState", "cv2", "olympe_deps",
                     "olympe.features", "olympe.features.video", "olympe.features.video.pdraw"]:
            modules[name] = types.ModuleType(name)
        common = modules["olympe.messages.common.CommonState"]
        piloting = modules["olympe.messages.ardrone3.PilotingState"]
        common.BatteryStateChanged = object()
        piloting.AltitudeChanged = object()
        piloting.SpeedChanged = object()
        piloting.PositionChanged = object()
        states = {
            common.BatteryStateChanged: {"percent": 80},
            piloting.AltitudeChanged: {"altitude": 0.5},
            piloting.SpeedChanged: {"speedX": 3, "speedY": 4},
            piloting.PositionChanged: {"latitude": 500, "longitude": 500},
        }
        controller = Mock(spec=["connect", "disconnect", "get_state",
                                "drone_connection_state", "streaming"])
        controller.connect.return_value = connect
        connection_states = iter([True, False])

        def connection_state():
            connected = next(connection_states)
            if not connected and lose_stream:
                controller.streaming = None
            return connected

        controller.drone_connection_state.side_effect = connection_state
        controller.get_state.side_effect = states.__getitem__
        modules["olympe"].Anafi = Mock(return_value=controller)
        modules["olympe"].SkyController3 = Mock()
        modules["olympe_deps"].VDEF_FRAME_TYPE_RAW = 1
        pdraw = modules["olympe.features.video.pdraw"]
        pdraw.Callbacks = types.SimpleNamespace
        pdraw.StreamInfoDefault = types.SimpleNamespace
        retained = [0]
        frame = Mock(spec=["ref", "unref"])
        frame.ref.side_effect = lambda: retained.__setitem__(0, retained[0] + 1)
        frame.unref.side_effect = lambda: retained.__setitem__(0, retained[0] - 1)

        def play(*, streams_list):
            callbacks = streams_list[0].callbacks[0]
            # Repeated flush/drain requests must release each retained frame once.
            callbacks.video_frame(frame)
            self.assertTrue(callbacks.flush({}))
            self.assertTrue(callbacks.drain({}))
            callbacks.video_frame(frame)  # Outstanding frame at shutdown.
            return False  # Camera failure must not fabricate images or kill telemetry.

        controller.streaming.play_multiple_stream.side_effect = play
        argv = ["bridge", "--drone-id", "ANAFI-TEST"] + (["--camera"] if camera else [])
        with patch.dict(sys.modules, modules), patch.object(sys, "argv", argv), \
             patch.dict(bridge.os.environ, {"INGEST_TOKEN": "unit-test-token"}), \
             patch.object(bridge, "post_json") as post, \
             patch.object(bridge.time, "sleep"), \
             patch.object(bridge.threading, "Thread"), \
             patch.object(bridge.threading, "Timer"), \
             contextlib.redirect_stdout(io.StringIO()):
            result = bridge.main()
        self.assertEqual(result, 75, 'A lost link must request a new observation session')
        if not connect:
            controller.disconnect.assert_not_called()
            post.assert_not_called()
            return None, retained[0]
        controller.disconnect.assert_called_once()
        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args[2], "/api/ingest/telemetry")
        return post.call_args.args[3], retained[0]

    def test_unknown_gps_stays_unknown_and_units_are_preserved(self):
        sample, _ = self.run_bridge()
        self.assertEqual(sample["provenance"], "live")
        self.assertIsNone(sample["latitude"])
        self.assertIsNone(sample["longitude"])
        self.assertEqual(sample["altitude_m"], 0.5)
        self.assertEqual(sample["ground_speed_mps"], 5)

    def test_camera_failure_and_flush_do_not_leak_frames(self):
        sample, references = self.run_bridge(camera=True)
        self.assertEqual(sample["battery_pct"], 80)
        self.assertEqual(references, 0)

    def test_power_loss_can_clear_sdk_stream_before_cleanup(self):
        _, references = self.run_bridge(camera=True, lose_stream=True)
        self.assertEqual(references, 0)

    def test_drone_off_at_start_requests_retry_without_fake_telemetry(self):
        self.run_bridge(connect=False)


if __name__ == "__main__":
    unittest.main()
