"""SDK adapter behavior with fake message modules and expectations; no SDK or radio."""
from pathlib import Path
import sys
import time
from types import SimpleNamespace,ModuleType
import unittest
from unittest.mock import Mock,MagicMock,patch
sys.path.insert(0,str(Path(__file__).parents[1]/'bridge'))
from dive_surveillance import OlympeDiveDriver


class DriverTests(unittest.TestCase):
    def setUp(self):
        """Install only fake SDK message factories; a fake drone records every call."""
        self.modules={}
        for name in ('olympe','olympe.messages','olympe.messages.ardrone3',
                     'olympe.messages.ardrone3.Piloting','olympe.messages.ardrone3.PilotingState',
                     'olympe.messages.ardrone3.SpeedSettings','olympe.messages.ardrone3.SpeedSettingsState',
                     'olympe.messages.gimbal'):
            self.modules[name]=ModuleType(name)
        for module,names in [('Piloting',['Landing','moveBy']),('PilotingState',['FlyingStateChanged','AltitudeChanged','SpeedChanged','AttitudeChanged']),
                             ('SpeedSettings',['MaxVerticalSpeed']),('SpeedSettingsState',['MaxVerticalSpeedChanged'])]:
            for name in names:setattr(self.modules['olympe.messages.ardrone3.'+module],name,MagicMock(name=name))
        self.modules['olympe.messages'].gimbal=self.modules['olympe.messages.gimbal']
        self.modules['olympe.messages.gimbal'].attitude=MagicMock()
        self.modules['olympe.messages.gimbal'].set_target=MagicMock()
        guard=patch.dict(sys.modules,self.modules);guard.start();self.addCleanup(guard.stop)
        self.pending=Mock();self.pending.done.return_value=True;self.pending.success.return_value=True
        self.pending.wait.return_value=self.pending
        self.bridge=SimpleNamespace(drone=Mock(connected=True,return_value=self.pending),connected=True,
            _poll_telemetry=Mock(),_state=Mock(return_value={'current':1.}),telemetry={
            'state':'hovering','altitude_m':1.,'battery_pct':80,'ground_speed_mps':0.,
            'attitude_deg':{'roll':0.,'pitch':0.,'yaw':0.},'extra':{'gimbal_pitch_deg':-10.}},
            last_frame_time=time.time(),publisher=Mock(),flight_phase=None)
        self.driver=OlympeDiveDriver(self.bridge)

    def test_cached_values_do_not_refresh_sensor_arrival_ages(self):
        sample=self.driver.snapshot();self.assertTrue(all(sample['ages'][name]>100 for name in ('altitude','speed','attitude','camera')))
        self.driver.attach(self.bridge.drone)
        self.assertEqual(self.bridge.drone.subscribe.call_count,4)
        for call in self.bridge.drone.subscribe.call_args_list:call.args[0](object(),object())
        self.assertTrue(all(self.driver.snapshot()['ages'][name]<1 for name in ('altitude','speed','attitude','camera')))
        self.bridge._poll_telemetry.assert_called()

    def test_move_is_bounded_and_requires_hover_confirmation(self):
        def measured_check():
            """Deliver a new measurement after each expectation poll in the fake adapter."""
            self.driver.events['altitude']=time.monotonic()
            return {'state':'hovering','speed_mps':0.}
        check=Mock(side_effect=measured_check)
        self.driver.move(dz=.2,yaw=0.,check=check)
        self.modules['olympe.messages.ardrone3.Piloting'].moveBy.assert_called_once_with(0.,0.,.2,0.)
        self.assertGreater(check.call_count,1)
        with self.assertRaises(ValueError):self.driver.move(dz=.3,yaw=0.,check=check)

    def test_wait_polls_abort_and_cancels_an_unfinished_expectation(self):
        self.pending.done.return_value=False
        with self.assertRaisesRegex(InterruptedError,'stop'):
            self.driver._wait(self.pending,Mock(side_effect=InterruptedError('stop')))
        self.pending.cancel.assert_called_once()

    def test_failed_landing_is_never_reported_as_landed(self):
        self.pending.success.return_value=False
        self.assertFalse(self.driver.land());self.assertEqual(self.bridge.flight_phase,'error')
        self.assertEqual(self.bridge.publisher.flight.call_args.args[0],'error')
        self.pending.success.return_value=True
        self.assertTrue(self.driver.land());self.assertEqual(self.bridge.flight_phase,'landed')

    def test_disconnected_landing_never_claims_delivery(self):
        self.bridge.connected=False
        self.assertFalse(self.driver.land());self.bridge.drone.assert_not_called()


if __name__=='__main__':unittest.main()
