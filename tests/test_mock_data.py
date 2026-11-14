"""Tests for :mod:`mock_data`: realistic ranges, spatial continuity and the query API.

Run from the project root with::

    python3 -m unittest discover tests
"""

import math
import random
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mock_data  # noqa: E402

BERLIN = {"type": "Point", "coordinates": [13.40, 52.52]}
GERMANY_BOX = {
    "type": "Polygon",
    "coordinates": [[[6.0, 47.5], [15.0, 47.5], [15.0, 55.0], [6.0, 55.0], [6.0, 47.5]]],
}


def box(lon: float, lat: float, width: float, height: float) -> dict:
    """Return a rectangular GeoJSON Polygon with south-west corner ``(lon, lat)``."""
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [lon, lat],
                [lon + width, lat],
                [lon + width, lat + height],
                [lon, lat + height],
                [lon, lat],
            ]
        ],
    }


class RealismTest(unittest.TestCase):
    """Values stay physically plausible everywhere and all year round."""

    def test_all_variables_stay_in_range_around_the_globe(self) -> None:
        rng = random.Random(0)
        points = [[rng.uniform(-180, 180), rng.uniform(-90, 90)] for _ in range(40)]
        geometry = {"type": "MultiPoint", "coordinates": points}
        for variable, spec in mock_data.VARIABLES.items():
            with self.subTest(variable=variable):
                data = mock_data.query(
                    geometry, ("2024-01-01", "2024-12-31"), variable,
                    time_step=timedelta(hours=7),
                )
                flat = [v for row in data.values for v in row]
                self.assertGreaterEqual(min(flat), spec.min_value)
                self.assertLessEqual(max(flat), spec.max_value)
                self.assertTrue(all(math.isfinite(v) for v in flat))

    def test_equator_is_warmer_than_the_poles(self) -> None:
        def yearly_mean(lat: float) -> float:
            point = {"type": "Point", "coordinates": [20.0, lat]}
            data = mock_data.query(point, ("2024-01-01", "2024-12-31"), "temperature")
            return sum(row[0] for row in data.values) / len(data.values)

        self.assertGreater(yearly_mean(0.0), yearly_mean(50.0))
        self.assertGreater(yearly_mean(50.0), yearly_mean(85.0))
        self.assertGreater(yearly_mean(0.0), 20.0)
        self.assertLess(yearly_mean(85.0), 0.0)

    def test_seasons_have_the_right_sign_per_hemisphere(self) -> None:
        def monthly_mean(lat: float, month: int) -> float:
            point = {"type": "Point", "coordinates": [10.0, lat]}
            data = mock_data.query(
                point, (date(2024, month, 1), date(2024, month, 28)), "temperature"
            )
            return sum(row[0] for row in data.values) / len(data.values)

        self.assertGreater(monthly_mean(50.0, 7), monthly_mean(50.0, 1) + 10)
        self.assertGreater(monthly_mean(-40.0, 1), monthly_mean(-40.0, 7) + 10)

    def test_berlin_july_is_plausible(self) -> None:
        data = mock_data.query(BERLIN, ("2025-07-01", "2025-07-31"), "temperature")
        temps = [row[0] for row in data.values]
        mean = sum(temps) / len(temps)
        self.assertTrue(10.0 < mean < 28.0, mean)
        self.assertTrue(0.0 < min(temps) and max(temps) < 42.0, (min(temps), max(temps)))

    def test_dew_point_never_exceeds_temperature(self) -> None:
        window = ("2024-06-01", "2024-08-31")
        temp = mock_data.query(GERMANY_BOX, window, "temperature", spatial_resolution=1.0)
        dew = mock_data.query(GERMANY_BOX, window, "dew_point", spatial_resolution=1.0)
        for t_row, d_row in zip(temp.values, dew.values):
            for t, d in zip(t_row, d_row):
                self.assertLessEqual(d, t + 0.01)

    def test_solar_radiation_is_zero_at_night_and_positive_at_noon(self) -> None:
        # Berlin, local solar noon ~11:06 UTC, midnight ~23:06 UTC.
        noon = mock_data.query_value(13.4, 52.52, "2025-06-21T11:06:00Z", "solar_radiation")
        night = mock_data.query_value(13.4, 52.52, "2025-06-21T23:06:00Z", "solar_radiation")
        self.assertGreater(noon, 100.0)
        self.assertEqual(night, 0.0)

    def test_precipitation_is_intermittent(self) -> None:
        data = mock_data.query(BERLIN, ("2024-01-01", "2024-12-31"), "precipitation")
        values = [row[0] for row in data.values]
        dry = sum(v == 0.0 for v in values) / len(values)
        self.assertTrue(0.3 < dry < 0.98, dry)


class ContinuityTest(unittest.TestCase):
    """Neighbouring points of a field never differ more than the variable allows."""

    def test_random_areas_are_continuous_for_all_variables(self) -> None:
        rng = random.Random(1)
        for trial in range(4):
            area = box(rng.uniform(-170, 150), rng.uniform(-80, 70), 15, 10)
            for variable in mock_data.VARIABLES:
                with self.subTest(trial=trial, variable=variable):
                    # query() itself raises AssertionError if continuity is violated.
                    data = mock_data.query(
                        area, ("2024-03-01", "2024-03-10"), variable,
                        spatial_resolution=0.5, seed=trial,
                    )
                    self.assertTrue(data.is_area)
                    self.assertGreater(len(data.points), 100)

    def test_points_one_km_apart_are_nearly_equal(self) -> None:
        rng = random.Random(2)
        for _ in range(200):
            lon, lat = rng.uniform(-179, 179), rng.uniform(-85, 85)
            when = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(
                hours=rng.uniform(0, 24 * 365)
            )
            dlon = 1.0 / (111.32 * math.cos(math.radians(lat)))  # 1 km eastwards
            for variable, spec in mock_data.VARIABLES.items():
                a = mock_data.query_value(lon, lat, when, variable)
                b = mock_data.query_value(lon + dlon, lat, when, variable)
                self.assertLessEqual(abs(a - b), spec.max_gradient_per_km * 1.0 + 0.01)

    def test_values_are_smooth_across_the_antimeridian(self) -> None:
        a = mock_data.query_value(179.995, 10.0, "2024-05-05T12:00:00", "air_pressure")
        b = mock_data.query_value(-179.995, 10.0, "2024-05-05T12:00:00", "air_pressure")
        self.assertLess(abs(a - b), 0.05)

    def test_check_continuity_detects_a_jump(self) -> None:
        data = mock_data.query(GERMANY_BOX, ("2024-01-01", "2024-01-01"), "temperature")
        data.values[0][0] += 50.0
        with self.assertRaises(AssertionError):
            mock_data.check_continuity(data)

    def test_check_realistic_detects_absurd_values(self) -> None:
        data = mock_data.query(BERLIN, ("2024-01-01", "2024-01-01"), "temperature")
        data.values[0][0] = 10000.0
        with self.assertRaises(AssertionError):
            mock_data.check_realistic(data)


class QueryApiTest(unittest.TestCase):
    """Input formats, output shape, determinism and error handling."""

    def test_point_returns_one_series(self) -> None:
        data = mock_data.query(BERLIN, (date(2025, 1, 1), date(2025, 1, 2)), "temperature")
        self.assertFalse(data.is_area)
        self.assertEqual(len(data.points), 1)
        self.assertEqual(len(data.times), 5)  # 00, 06, 12, 18 and 00 of the next day
        self.assertEqual(data.unit, "°C")
        self.assertEqual(len(data.series()), 5)

    def test_area_shape_and_points_are_inside(self) -> None:
        data = mock_data.query(GERMANY_BOX, ("2025-01-01", "2025-01-01"), "wind_speed")
        self.assertTrue(data.is_area)
        self.assertEqual(len(data.values), 1)
        self.assertEqual(len(data.values[0]), len(data.points))
        for lon, lat in data.points:
            self.assertTrue(6.0 <= lon <= 15.0 and 47.5 <= lat <= 55.0)

    def test_accepts_feature_json_string_and_aliases(self) -> None:
        feature = {"type": "Feature", "properties": {}, "geometry": GERMANY_BOX}
        a = mock_data.query(feature, ("2025-01-01", "2025-01-01"), "Temperature")
        b = mock_data.query(
            '{"type": "FeatureCollection", "features": [%s]}' % str(feature).replace("'", '"'),
            ("2025-01-01", "2025-01-01"),
            "TMP",
        )
        self.assertEqual(a.values, b.values)
        self.assertEqual(mock_data.resolve_variable("Windvelocity").name, "wind_speed")

    def test_polygon_hole_and_multipolygon(self) -> None:
        with_hole = {
            "type": "Polygon",
            "coordinates": [
                box(0, 0, 10, 10)["coordinates"][0],
                box(3, 3, 4, 4)["coordinates"][0],
            ],
        }
        data = mock_data.query(with_hole, ("2025-01-01", "2025-01-01"), "cloud_cover")
        self.assertFalse(any(3 < lon < 7 and 3 < lat < 7 for lon, lat in data.points))

        multi = {
            "type": "MultiPolygon",
            "coordinates": [box(0, 0, 2, 2)["coordinates"], box(20, 20, 2, 2)["coordinates"]],
        }
        data = mock_data.query(multi, ("2025-01-01", "2025-01-01"), "cloud_cover")
        self.assertEqual(len(data.points), 32)

    def test_tiny_area_falls_back_to_one_point(self) -> None:
        data = mock_data.query(box(8.0, 50.0, 0.01, 0.01), ("2025-01-01", "2025-01-01"), "rh")
        self.assertEqual(len(data.points), 1)

    def test_same_seed_is_deterministic_and_other_seed_differs(self) -> None:
        window = ("2025-01-01", "2025-01-03")
        a = mock_data.query(BERLIN, window, "air_pressure", seed=7)
        b = mock_data.query(BERLIN, window, "air_pressure", seed=7)
        c = mock_data.query(BERLIN, window, "air_pressure", seed=8)
        self.assertEqual(a.values, b.values)
        self.assertNotEqual(a.values, c.values)

    def test_to_geojson(self) -> None:
        data = mock_data.query(GERMANY_BOX, ("2025-01-01", "2025-01-02"), "temperature")
        snapshot = data.to_geojson(time_index=0)
        self.assertEqual(snapshot["type"], "FeatureCollection")
        self.assertEqual(len(snapshot["features"]), len(data.points))
        self.assertIn("value", snapshot["features"][0]["properties"])
        series = data.to_geojson()
        self.assertEqual(len(series["features"][0]["properties"]["values"]), len(data.times))

    def test_invalid_inputs(self) -> None:
        window = ("2025-01-01", "2025-01-02")
        with self.assertRaises(ValueError):
            mock_data.query(BERLIN, window, "flux_capacitance")
        with self.assertRaises(ValueError):
            mock_data.query(BERLIN, ("2025-01-02", "2025-01-01"), "temperature")
        with self.assertRaises(ValueError):
            mock_data.query({"type": "LineString", "coordinates": [[0, 0], [1, 1]]}, window, "temp")
        with self.assertRaises(ValueError):
            mock_data.query({"type": "Point", "coordinates": [200, 0]}, window, "temp")
        with self.assertRaises(ValueError):
            mock_data.query(box(-100, -50, 100, 100), ("2000-01-01", "2020-01-01"), "temp")


if __name__ == "__main__":
    unittest.main()
