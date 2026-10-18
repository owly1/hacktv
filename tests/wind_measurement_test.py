"""Numerical wind is received sensor evidence, never a QR value or refreshed cache."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]/'bridge'))
from wind_measurement import WindMeasurement, wind_vector


class WindMeasurementTests(unittest.TestCase):
    """Exercise availability, capability, direction and receipt-time failure boundaries."""

    def ready(self, north=0., east=2.):
        """Provide a genuine synthetic state/vector event pair without an aircraft SDK."""
        wind = WindMeasurement()
        wind.receive_state({'is_wind_speed_available': True,
                            'default_capabilities': {'supported_features': ['WIND_SPEED_ESTIMATION']}})
        wind.receive_vector({'north': north, 'east': east}, 10., 1700000000.)
        return wind

    def test_import_does_not_establish_hardware_support(self):
        """An available SDK and even a vector cannot replace the aircraft availability flag."""
        wind = WindMeasurement()
        wind.receive_vector({'north': 0., 'east': 1.}, 10., 1700000000.)
        self.assertIsNone(wind.supported)
        self.assertIsNone(wind.snapshot(10.))
        self.assertIn('availability', wind.reason(10.))

    def test_toward_vector_units_and_exact_calm(self):
        """NED vectors use m/s and TOWARD degrees; only exact calm has no direction."""
        for components, expected in [((1., 0.), (1., 0.)), ((0., 2.), (2., 90.)),
                                      ((-1., 0.), (1., 180.)), ((0., -1.), (1., 270.)),
                                      ((0., 0.), (0., None)), ((.01, 0.), (.01, 0.))]:
            self.assertEqual(wind_vector(*components), expected)
        self.assertIsNone(self.ready(0., 0.).snapshot(10.)['direction_deg'])

    def test_reads_never_refresh_measurement_age_or_observed_time(self):
        """A cached vector expires five seconds after actual receipt even with repeated polling."""
        wind = self.ready()
        first = wind.snapshot(10.)
        last = wind.snapshot(15.)
        self.assertEqual(first['observed_at'], '2023-11-14T22:13:20Z')
        self.assertEqual(last['observed_at'], first['observed_at'])
        self.assertEqual(last['age_s'], 5.)
        self.assertEqual(last['source'], 'flight-controller')
        self.assertIsNone(wind.snapshot(15.001))
        self.assertIn('stale', wind.reason(15.001))
        self.assertEqual(wind.diagnostics(18.)['age_s'], 8.)
        self.assertIsNone(wind.snapshot(9.))

    def test_unavailable_and_unsupported_are_distinct(self):
        """Supported-but-unavailable wind is not exposed as measured calm or unsupported hardware."""
        wind = self.ready()
        wind.receive_state({'is_wind_speed_available': False})
        self.assertTrue(wind.supported)
        self.assertIn('not currently available', wind.reason(11.))
        self.assertIsNone(wind.snapshot(11.))
        wind.receive_state({'is_wind_speed_available': True})
        self.assertIsNone(wind.snapshot(11.))
        self.assertIn('Waiting for a measured', wind.reason(11.))
        wind.receive_state({'is_wind_speed_available': True,
                            'default_capabilities': {'supported_features': []}})
        self.assertFalse(wind.supported)
        self.assertIn('does not report support', wind.reason(11.))
        self.assertIsNone(wind.snapshot(11.))

    def test_partial_state_keeps_unknown_capability_and_prior_valid_support(self):
        """Absent/default capability fields are not mistaken for an explicit empty support list."""
        wind = WindMeasurement()
        wind.receive_state({'is_wind_speed_available': True, 'default_capabilities': {}})
        self.assertIsNone(wind.supported)
        wind.receive_state({'default_capabilities': {'supported_features': [0]}})
        self.assertTrue(wind.supported)
        wind.receive_state({'is_wind_speed_available': False, 'default_capabilities': None})
        self.assertTrue(wind.supported)
        self.assertFalse(wind.available)

    def test_invalid_vectors_invalidate_previous_measurement(self):
        """NaN, missing and boolean measurements cannot leave an older valid sample active."""
        for vector in ({'north': float('nan'), 'east': 1.}, {'north': 1.},
                       {'north': True, 'east': 0.}, {'north': 1., 'east': float('inf')},
                       {'north': 1.79e308, 'east': 1.79e308}):
            wind = self.ready()
            wind.receive_vector(vector, 11., 1700000001.)
            self.assertIsNone(wind.snapshot(11.))
            self.assertIn('invalid', wind.reason(11.))

    def test_missing_availability_never_defaults_to_false(self):
        """An omitted protobuf field remains unknown instead of inventing a capability result."""
        wind = WindMeasurement()
        wind.receive_state({})
        self.assertIsNone(wind.available)
        self.assertTrue(wind.state_received.is_set())

    def test_reordered_event_and_missing_sdk_are_reported(self):
        """A regressed monotonic sample invalidates the old vector; missing SDK is explicit."""
        wind = self.ready()
        wind.receive_vector({'north': 0., 'east': 1.}, 9., 1700000001.)
        self.assertIsNone(wind.snapshot(11.))
        self.assertIn('out of order', wind.reason(11.))
        self.assertIn('SDK', WindMeasurement(sdk_available=False).reason(11.))


if __name__ == '__main__':
    unittest.main()
