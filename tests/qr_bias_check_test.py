import importlib.util
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check_qr_bias', Path(__file__).parents[1]/'scripts/check_qr_bias.py')
bias = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bias)


def point(height, estimate, horizontal=.75, estimated_horizontal=.75):
    return {'id': str(height), 'measured_horizontal_m': horizontal,
            'measured_down_m': height, 'estimated_horizontal_m': estimated_horizontal,
            'estimated_down_m': estimate}


class BiasCheckTests(unittest.TestCase):
    def test_real_offset_across_heights_passes_residuals_without_authorizing_flight(self):
        result = bias.assess([point(.6, .8), point(.8, 1.), point(1.8, 2.)])
        self.assertTrue(result['models'][1]['validation_within_tolerance'])
        self.assertFalse(result['flight_verified'])
        self.assertFalse(result['flight_calibration_modified'])

    def test_single_height_cannot_validate_scale_for_takeoff(self):
        result = bias.assess([point(.8, 1.), point(.8, 1.01)])
        self.assertTrue(any('same target height' in s for s in result['limitations']))
        self.assertFalse(result['flight_verified'])

    def test_scale_error_is_not_fixed_by_subtracting_constant_at_flight_height(self):
        result = bias.assess([point(.8, 1.), point(1.8, 2.25)])
        self.assertFalse(result['models'][1]['validation_within_tolerance'])
        scale = result['models'][3]
        self.assertTrue(scale['validation_within_tolerance'])
        self.assertTrue(scale['rows'][0]['used_for_fit'])
        self.assertFalse(scale['rows'][1]['used_for_fit'])
        self.assertEqual(scale['validation_setups'], 1)

    def test_vertical_fix_cannot_hide_bad_horizontal_range(self):
        result = bias.assess([point(.8, 1., estimated_horizontal=.86)])
        self.assertFalse(result['models'][1]['validation_within_tolerance'])
        self.assertAlmostEqual(result['models'][1]['rows'][0]['position_error_m'], .11)

    def test_invalid_measurements_are_rejected(self):
        for value in (0, -1, math.nan, math.inf):
            with self.assertRaises(ValueError):
                bias.assess([point(.8, value)])


if __name__ == '__main__':
    unittest.main()
