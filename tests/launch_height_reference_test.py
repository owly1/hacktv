"""Launch-relative height is independent of terrain and marker elevation.

The physical simulation exercises the real continuous controller and vehicle
guards. No SDK, aircraft connection, or terrain-derived height correction.
"""
from dataclasses import replace
import unittest

from continuous_orbit_test import Control, FlightWorld
from qr_circle_core import camera_pitch
from qr_scale import AdaptiveQRScale


class BoxLaunchWorld(FlightWorld):
    def __init__(self, marker_below_floor=0.):
        super().__init__(upward_bias=0.)
        self.launch_height_above_floor=.30
        self.marker_below_floor=marker_below_floor
        self.clearances=[]

    def target(self):
        target=super().target()
        _,_,_,height,*_=self.historical(target.at)
        return replace(target,down_m=height+self.launch_height_above_floor+self.marker_below_floor)

    def check(self):
        # A floor drop changes AGL, not the launch-relative SDK altitude.
        floor_below_launch=0. if self.time<1 else .30 if self.time<5 else .80
        self.clearances.append(self.altitude+floor_below_launch)
        return super().check()


class LaunchHeightReferenceTests(unittest.TestCase):
    def test_box_launch_and_floor_drops_preserve_height_through_three_real_laps(self):
        worlds=[]
        for marker_below_floor in (0.,.30):
            with self.subTest(marker_below_floor=marker_below_floor):
                world=BoxLaunchWorld(marker_below_floor)
                with self.assertRaisesRegex(InterruptedError,'three physical laps'):
                    world.run()
                worlds.append(world)
                self.assertEqual(len(world.laps),3)
                durations=[world.laps[0],*(b-a for a,b in zip(world.laps,world.laps[1:]))]
                self.assertLessEqual(max(durations),15.)
                self.assertEqual(min(world.altitudes),1.)
                self.assertEqual(max(world.altitudes),1.)
                self.assertEqual(min(world.clearances),1.)
                self.assertEqual(max(world.clearances),1.8)
                self.assertTrue(all(command.gaz==0 for _,command in world.commands))
                self.assertEqual(world.commands[-1][1],Control())
                for target in world.remembered:
                    self.assertAlmostEqual(target.down_m,1.30+marker_below_floor)
                    self.assertLess(camera_pitch(target),-45.)
                started=next(data for kind,data in world.diagnostics if kind=='continuous_orbit_started')
                self.assertAlmostEqual(started['fixed_centre_m'][2],.30+marker_below_floor)
        # Only the camera's downward aim changes with the marker's elevation;
        # aircraft motion and all issued flight controls remain identical.
        self.assertEqual(worlds[0].commands,worlds[1].commands)
        self.assertLess(camera_pitch(worlds[1].remembered[-1]),camera_pitch(worlds[0].remembered[-1]))

    def test_real_launch_relative_height_error_still_stops_and_neutralizes(self):
        for height in (.7,1.3):
            with self.subTest(height=height):
                world=BoxLaunchWorld()
                world.altitude=height
                with self.assertRaisesRegex(InterruptedError,'height outside the planned hover band'):
                    world.run()
                self.assertEqual(world.commands[-1][1],Control())
                self.assertEqual(world.laps,[])

    def test_qr_scale_recovers_box_to_marker_height_without_changing_launch_reference(self):
        for marker_below_floor in (0.,.30):
            with self.subTest(marker_below_floor=marker_below_floor):
                anchor=.30+marker_below_floor
                estimator=AdaptiveQRScale(rough=True)
                heights=[0.]*4+[.25,.5]+[1.]*4
                for index,height in enumerate(heights):
                    fit=estimator.observe((anchor+height)/.12,height,at=float(index))
                self.assertIsNotNone(fit)
                self.assertAlmostEqual(fit.side_m,.12)
                self.assertAlmostEqual(fit.anchor_down_m,anchor)
                # At the one-metre launch-relative hover, the QR may be 1.3 m
                # or farther below the aircraft. That is not a height error.
                self.assertAlmostEqual((anchor+1.)-1.-fit.anchor_down_m,0.)


if __name__=='__main__':
    unittest.main()
