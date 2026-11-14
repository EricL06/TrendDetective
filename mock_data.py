"""Mock weather database for testing analysis methods and visualisations.

The module generates synthetic but plausible weather data for any point or area on Earth and
any time range. It needs only the Python standard library.

The data is not random noise: every variable is a smooth, deterministic function of
longitude, latitude and time. It is built from

- a climatology (warmer at the equator, seasons with the right sign per hemisphere,
  a day/night cycle driven by the real position of the sun), and
- smooth "weather" fields made of a sum of slow, large-scale waves on the sphere
  (wavelengths of roughly 2 000–10 000 km, periods of a few days to weeks).

Because of that, two places close to each other always get similar values, and the same
request with the same ``seed`` always returns the same numbers.

Every result is checked before it is returned:

- **Realism**: every value lies inside the physical range of its variable
  (see :data:`VARIABLES`, e.g. temperature between −90 °C and 60 °C).
- **Continuity** (*Stetigkeit*, areas only): for every pair of neighbouring grid points,
  ``|Δvalue| <= max_gradient_per_km * distance_km``.

Both checks raise :class:`AssertionError` if they fail.

Example::

    from datetime import date
    import mock_data

    berlin = {"type": "Point", "coordinates": [13.40, 52.52]}
    result = mock_data.query(berlin, (date(2025, 7, 1), date(2025, 7, 8)), "temperature")
    for timestamp, value in result.series():
        print(timestamp, value, result.unit)
"""

from __future__ import annotations

import json
import math
import random
import zlib
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

EARTH_RADIUS_KM: float = 6371.0
_EPOCH: datetime = datetime(2000, 1, 1, tzinfo=timezone.utc)
_YEAR_DAYS: float = 365.2422
_SPRING_EQUINOX_DAY: float = 79.0  # days after 1 January, approximately 20 March


@dataclass(frozen=True)
class VariableSpec:
    """Description and plausibility limits of one mock variable.

    :param name: Canonical variable name.
    :type name: str
    :param unit: Physical unit of the values.
    :type unit: str
    :param min_value: Smallest physically plausible value.
    :type min_value: float
    :param max_value: Largest physically plausible value.
    :type max_value: float
    :param max_gradient_per_km: Largest allowed value difference per kilometre between
        neighbouring points of an area (the continuity limit).
    :type max_gradient_per_km: float
    :param description: Short human-readable description.
    :type description: str
    """

    name: str
    unit: str
    min_value: float
    max_value: float
    max_gradient_per_km: float
    description: str


VARIABLES: dict[str, VariableSpec] = {
    spec.name: spec
    for spec in (
        VariableSpec("temperature", "°C", -90.0, 60.0, 0.05, "Air temperature at 2 m"),
        VariableSpec("relative_humidity", "%", 0.0, 100.0, 0.3, "Relative humidity at 2 m"),
        VariableSpec("wind_speed", "m/s", 0.0, 75.0, 0.05, "Wind speed at 10 m"),
        VariableSpec("precipitation", "mm/h", 0.0, 150.0, 0.1, "Precipitation rate"),
        VariableSpec("air_pressure", "hPa", 870.0, 1085.0, 0.05, "Air pressure at sea level"),
        VariableSpec("cloud_cover", "%", 0.0, 100.0, 0.5, "Total cloud cover"),
        VariableSpec(
            "solar_radiation", "W/m²", 0.0, 1361.0, 5.0, "Global horizontal irradiance"
        ),
        VariableSpec("dew_point", "°C", -100.0, 35.0, 0.2, "Dew point temperature at 2 m"),
    )
}
"""All variables the mock database knows, keyed by canonical name."""

_ALIASES: dict[str, str] = {
    "temp": "temperature",
    "tmp": "temperature",
    "t2m": "temperature",
    "humidity": "relative_humidity",
    "rh": "relative_humidity",
    "wind": "wind_speed",
    "windspeed": "wind_speed",
    "windvelocity": "wind_speed",
    "wind_velocity": "wind_speed",
    "rain": "precipitation",
    "pressure": "air_pressure",
    "clouds": "cloud_cover",
    "cloudiness": "cloud_cover",
    "radiation": "solar_radiation",
    "irradiance": "solar_radiation",
    "dewpoint": "dew_point",
}


def available_variables() -> list[str]:
    """Return the canonical names of all variables, e.g. ``"temperature"``.

    :return: Sorted list of variable names.
    :rtype: list[str]
    """
    return sorted(VARIABLES)


def resolve_variable(name: str) -> VariableSpec:
    """Look up a variable by name, ignoring case, spaces, hyphens and common aliases.

    ``"Temperature"``, ``"TMP"`` and ``"temp"`` all resolve to ``"temperature"``;
    ``"Windvelocity"`` resolves to ``"wind_speed"``.

    :param name: Variable name as typed by a user or used in the UI.
    :type name: str
    :raises ValueError: If the name matches no variable.
    :return: Specification of the variable.
    :rtype: VariableSpec
    """
    key = name.strip().lower().replace(" ", "_").replace("-", "_")
    key = _ALIASES.get(key, _ALIASES.get(key.replace("_", ""), key))
    if key not in VARIABLES:
        raise ValueError(f"Unknown variable {name!r}. Available: {available_variables()}")
    return VARIABLES[key]


# --------------------------------------------------------------------------------------
# Result
# --------------------------------------------------------------------------------------


@dataclass
class MockData:
    """Values of one variable at one or more points over a list of timestamps.

    :param variable: Canonical variable name.
    :type variable: str
    :param unit: Unit of the values.
    :type unit: str
    :param times: Timestamps (UTC) of the samples.
    :type times: list[datetime]
    :param points: ``(longitude, latitude)`` of each sample location.
    :type points: list[tuple[float, float]]
    :param values: ``values[time_index][point_index]``.
    :type values: list[list[float]]
    :param grid_index: ``(row, column)`` of each point in the sampling grid; a point
        request has a single point at ``(0, 0)``.
    :type grid_index: list[tuple[int, int]]
    :param is_area: ``True`` if the request was an area (Polygon/MultiPolygon).
    :type is_area: bool
    """

    variable: str
    unit: str
    times: list[datetime]
    points: list[tuple[float, float]]
    values: list[list[float]]
    grid_index: list[tuple[int, int]] = field(default_factory=list)
    is_area: bool = False

    def series(self, point_index: int = 0) -> list[tuple[datetime, float]]:
        """Return the time series at one point.

        :param point_index: Index into :attr:`points`.
        :type point_index: int
        :return: List of ``(timestamp, value)`` pairs.
        :rtype: list[tuple[datetime, float]]
        """
        return [(t, row[point_index]) for t, row in zip(self.times, self.values)]

    def field(self, time_index: int = 0) -> list[float]:
        """Return the values of all points at one timestamp.

        :param time_index: Index into :attr:`times`.
        :type time_index: int
        :return: One value per point, in the order of :attr:`points`.
        :rtype: list[float]
        """
        return list(self.values[time_index])

    def spatial_mean(self) -> list[tuple[datetime, float]]:
        """Return the mean over all points for every timestamp.

        :return: List of ``(timestamp, mean_value)`` pairs.
        :rtype: list[tuple[datetime, float]]
        """
        return [(t, sum(row) / len(row)) for t, row in zip(self.times, self.values)]

    def to_geojson(self, time_index: int | None = None) -> dict[str, Any]:
        """Export the points as a GeoJSON ``FeatureCollection`` (e.g. for the map widget).

        :param time_index: If given, every feature gets the single property ``value`` at
            that timestamp; otherwise it gets the full series in ``values`` plus ``times``.
        :type time_index: int | None
        :return: GeoJSON FeatureCollection of Point features.
        :rtype: dict[str, Any]
        """
        features = []
        for i, (lon, lat) in enumerate(self.points):
            props: dict[str, Any] = {"variable": self.variable, "unit": self.unit}
            if time_index is None:
                props["times"] = [t.isoformat() for t in self.times]
                props["values"] = [row[i] for row in self.values]
            else:
                props["time"] = self.times[time_index].isoformat()
                props["value"] = self.values[time_index][i]
            features.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                }
            )
        return {"type": "FeatureCollection", "features": features}


# --------------------------------------------------------------------------------------
# Public query function
# --------------------------------------------------------------------------------------

DateLike = date | datetime | str


def query(
    geometry: dict[str, Any] | str,
    time_range: tuple[DateLike, DateLike],
    variable: str,
    *,
    spatial_resolution: float = 0.5,
    time_step: timedelta = timedelta(hours=6),
    seed: int = 42,
    max_samples: int = 2_000_000,
) -> MockData:
    """Return mock values of ``variable`` at a point or inside an area over a time range.

    :param geometry: GeoJSON ``Point``, ``MultiPoint``, ``Polygon`` or ``MultiPolygon``
        (a geometry, a ``Feature`` wrapping one, a ``FeatureCollection`` with exactly one
        feature, or the same as a JSON string). Coordinates are ``[longitude, latitude]``.
        Polygons crossing the antimeridian are not supported.
    :type geometry: dict[str, Any] | str
    :param time_range: ``(start, end)``, both inclusive, as :class:`date`,
        :class:`datetime` or ISO 8601 strings. Dates mean 00:00 UTC; naive datetimes are
        treated as UTC.
    :type time_range: tuple[date | datetime | str, date | datetime | str]
    :param variable: Variable name, see :func:`available_variables` (aliases such as
        ``"Temperature"`` or ``"Windvelocity"`` work too).
    :type variable: str
    :param spatial_resolution: Grid spacing in degrees used to sample an area.
    :type spatial_resolution: float
    :param time_step: Distance between two timestamps. Values are instantaneous, so
        use a sub-daily step to see the day/night cycle (e.g. of solar radiation).
    :type time_step: timedelta
    :param seed: Seed of the synthetic weather; the same seed gives the same data.
    :type seed: int
    :param max_samples: Upper limit for ``points * timestamps`` to protect against
        accidentally huge requests.
    :type max_samples: int
    :raises ValueError: On unknown variable, unsupported geometry, invalid time range or
        a request larger than ``max_samples``.
    :raises AssertionError: If a value is out of its plausible range or neighbouring
        area points differ more than the variable's continuity limit allows.
    :return: The generated data.
    :rtype: MockData
    """
    spec = resolve_variable(variable)
    if spatial_resolution <= 0:
        raise ValueError("spatial_resolution must be greater than 0.")
    if time_step <= timedelta(0):
        raise ValueError("time_step must be greater than 0.")

    points, grid_index, is_area = _sample_points(_extract_geometry(geometry), spatial_resolution)
    times = _time_axis(time_range, time_step)
    if len(points) * len(times) > max_samples:
        raise ValueError(
            f"Request has {len(points)} points x {len(times)} timestamps = "
            f"{len(points) * len(times)} samples (limit {max_samples}). "
            "Use a coarser spatial_resolution, a larger time_step or a shorter time range."
        )

    model = _WeatherModel(seed)
    prepared = [model.prepare(lon, lat) for lon, lat in points]
    values = [
        [round(model.value(spec.name, p, _days_since_epoch(t)), 3) for p in prepared]
        for t in times
    ]

    result = MockData(
        variable=spec.name,
        unit=spec.unit,
        times=times,
        points=points,
        values=values,
        grid_index=grid_index,
        is_area=is_area,
    )
    check_realistic(result)
    if is_area:
        check_continuity(result)
    return result


def query_value(lon: float, lat: float, when: DateLike, variable: str, seed: int = 42) -> float:
    """Return a single mock value at one place and time.

    :param lon: Longitude in degrees.
    :type lon: float
    :param lat: Latitude in degrees.
    :type lat: float
    :param when: Timestamp (see :func:`query` for accepted formats).
    :type when: date | datetime | str
    :param variable: Variable name.
    :type variable: str
    :param seed: Seed of the synthetic weather.
    :type seed: int
    :return: The value in the variable's unit.
    :rtype: float
    """
    point = {"type": "Point", "coordinates": [lon, lat]}
    return query(point, (when, when), variable, seed=seed).values[0][0]


# --------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------


def check_realistic(data: MockData) -> None:
    """Assert that every value is finite and inside the variable's plausible range.

    :param data: Result to check.
    :type data: MockData
    :raises AssertionError: If a value is outside ``[min_value, max_value]``.
    :return: None
    :rtype: None
    """
    spec = VARIABLES[data.variable]
    for t, row in zip(data.times, data.values):
        for (lon, lat), v in zip(data.points, row):
            if not (math.isfinite(v) and spec.min_value <= v <= spec.max_value):
                raise AssertionError(
                    f"Unrealistic {spec.name} {v} {spec.unit} at ({lon}, {lat}) {t}; "
                    f"expected [{spec.min_value}, {spec.max_value}]."
                )


def check_continuity(data: MockData) -> None:
    """Assert that neighbouring grid points never differ more than the continuity limit.

    For each pair of horizontally or vertically adjacent grid points the difference must
    satisfy ``|Δvalue| <= max_gradient_per_km * distance_km``.

    :param data: Result to check.
    :type data: MockData
    :raises AssertionError: If a pair of neighbours differs too much.
    :return: None
    :rtype: None
    """
    spec = VARIABLES[data.variable]
    position = {idx: i for i, idx in enumerate(data.grid_index)}
    pairs: list[tuple[int, int, float]] = []
    for (row, col), i in position.items():
        for neighbour in ((row + 1, col), (row, col + 1)):
            j = position.get(neighbour)
            if j is not None:
                limit = spec.max_gradient_per_km * haversine_km(data.points[i], data.points[j])
                pairs.append((i, j, limit))
    for t, values in zip(data.times, data.values):
        for i, j, limit in pairs:
            diff = abs(values[i] - values[j])
            if diff > limit + 0.01:  # tolerance for the rounding to 3 decimals
                raise AssertionError(
                    f"Field not continuous: {spec.name} jumps by {diff:.3f} {spec.unit} "
                    f"between {data.points[i]} and {data.points[j]} at {t} "
                    f"(allowed {limit:.3f})."
                )


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Return the great-circle distance between two ``(lon, lat)`` points in kilometres.

    :param a: First point ``(longitude, latitude)`` in degrees.
    :type a: tuple[float, float]
    :param b: Second point ``(longitude, latitude)`` in degrees.
    :type b: tuple[float, float]
    :return: Distance in km.
    :rtype: float
    """
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


# --------------------------------------------------------------------------------------
# Geometry and time handling
# --------------------------------------------------------------------------------------


def _extract_geometry(obj: dict[str, Any] | str) -> dict[str, Any]:
    """Unwrap a JSON string, Feature or single-feature FeatureCollection to a geometry."""
    if isinstance(obj, str):
        obj = json.loads(obj)
    if not isinstance(obj, dict) or "type" not in obj:
        raise ValueError("geometry must be a GeoJSON object.")
    if obj["type"] == "FeatureCollection":
        features = obj.get("features", [])
        if len(features) != 1:
            raise ValueError("A FeatureCollection must contain exactly one feature.")
        obj = features[0]
    if obj["type"] == "Feature":
        obj = obj.get("geometry") or {}
    if obj.get("type") not in ("Point", "MultiPoint", "Polygon", "MultiPolygon"):
        raise ValueError(f"Unsupported geometry type {obj.get('type')!r}.")
    return obj


def _check_coordinate(lon: float, lat: float) -> tuple[float, float]:
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise ValueError(f"Coordinate ({lon}, {lat}) is outside [-180, 180] x [-90, 90].")
    return float(lon), float(lat)


def _sample_points(
    geometry: dict[str, Any], step: float
) -> tuple[list[tuple[float, float]], list[tuple[int, int]], bool]:
    """Return sample points, their grid indices, and whether the geometry is an area."""
    gtype = geometry["type"]
    coords = geometry["coordinates"]
    if gtype == "Point":
        return [_check_coordinate(coords[0], coords[1])], [(0, 0)], False
    if gtype == "MultiPoint":
        points = [_check_coordinate(c[0], c[1]) for c in coords]
        return points, [(0, i) for i in range(len(points))], False

    polygons = [coords] if gtype == "Polygon" else coords
    all_vertices = [_check_coordinate(c[0], c[1]) for poly in polygons for c in poly[0]]
    west = min(p[0] for p in all_vertices)
    east = max(p[0] for p in all_vertices)
    south = min(p[1] for p in all_vertices)
    north = max(p[1] for p in all_vertices)

    points: list[tuple[float, float]] = []
    grid_index: list[tuple[int, int]] = []
    n_rows = max(1, math.ceil((north - south) / step))
    n_cols = max(1, math.ceil((east - west) / step))
    for row in range(n_rows):
        lat = south + (row + 0.5) * step
        for col in range(n_cols):
            lon = west + (col + 0.5) * step
            if any(_in_polygon(lon, lat, poly) for poly in polygons):
                points.append((round(lon, 6), round(lat, 6)))
                grid_index.append((row, col))

    if not points:  # area smaller than one grid cell: use its vertex centroid
        ring = polygons[0][0][:-1] or polygons[0][0]
        lon = sum(c[0] for c in ring) / len(ring)
        lat = sum(c[1] for c in ring) / len(ring)
        points, grid_index = [(round(lon, 6), round(lat, 6))], [(0, 0)]
    return points, grid_index, True


def _in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-ring test."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _in_polygon(x: float, y: float, polygon: list[list[list[float]]]) -> bool:
    """Point-in-polygon test honouring holes (rings after the first)."""
    return _in_ring(x, y, polygon[0]) and not any(_in_ring(x, y, hole) for hole in polygon[1:])


def _to_utc(value: DateLike) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        value = datetime(value.year, value.month, value.day)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _time_axis(time_range: tuple[DateLike, DateLike], step: timedelta) -> list[datetime]:
    if len(time_range) != 2:
        raise ValueError("time_range must be a (start, end) tuple.")
    start, end = _to_utc(time_range[0]), _to_utc(time_range[1])
    if end < start:
        raise ValueError(f"time_range end {end} is before start {start}.")
    n_steps = int((end - start) / step)
    return [start + i * step for i in range(n_steps + 1)]


def _days_since_epoch(t: datetime) -> float:
    return (t - _EPOCH).total_seconds() / 86400.0


# --------------------------------------------------------------------------------------
# Synthetic weather model
# --------------------------------------------------------------------------------------


_MAGNUS_A: float = 17.62
_MAGNUS_B: float = 243.12


def _saturation_ratio(dew_point: float, temperature: float) -> float:
    """Return ``e_s(dew_point) / e_s(temperature)`` (Magnus formula), i.e. the humidity
    fraction at which air of ``temperature`` has the given dew point."""
    return math.exp(
        _MAGNUS_A * dew_point / (_MAGNUS_B + dew_point)
        - _MAGNUS_A * temperature / (_MAGNUS_B + temperature)
    )


class _SmoothNoise:
    """Smooth random field on the sphere x time, mean 0 and standard deviation ~1.

    It is a sum of plane waves ``sin(k · p + ω t + φ)`` evaluated at the 3-D unit vector
    ``p`` of a location, so it has no seam at the antimeridian or the poles. The wave
    numbers ``|k|`` are in units of 1/Earth radius (wavelength ``2πR/|k|``), so the
    spatial gradient is bounded by ``amplitude * Σ|k| / R`` per km.
    """

    def __init__(
        self,
        seed: int,
        n_waves: int,
        k_range: tuple[float, float],
        period_days: tuple[float, float],
    ) -> None:
        rng = random.Random(seed)
        self.amplitude = math.sqrt(2.0 / n_waves)
        self.waves: list[tuple[float, float, float, float, float]] = []
        for _ in range(n_waves):
            z = rng.uniform(-1.0, 1.0)
            azimuth = rng.uniform(0.0, 2 * math.pi)
            r = math.sqrt(1.0 - z * z)
            k = rng.uniform(*k_range)
            omega = 2 * math.pi / rng.uniform(*period_days) * rng.choice((-1.0, 1.0))
            phase = rng.uniform(0.0, 2 * math.pi)
            self.waves.append(
                (k * r * math.cos(azimuth), k * r * math.sin(azimuth), k * z, omega, phase)
            )
        self.omegas = [w[3] for w in self.waves]

    def spatial_phases(self, xyz: tuple[float, float, float]) -> list[float]:
        x, y, z = xyz
        return [kx * x + ky * y + kz * z + phase for kx, ky, kz, _, phase in self.waves]

    def value(self, phases: list[float], t_days: float) -> float:
        return self.amplitude * sum(
            math.sin(p + w * t_days) for p, w in zip(phases, self.omegas)
        )


@dataclass
class _Location:
    lon: float
    lat: float
    phases: dict[str, list[float]]


class _WeatherModel:
    """Combines climatology and smooth noise fields into all mock variables."""

    def __init__(self, seed: int) -> None:
        def noise(name: str, k_range: tuple[float, float], periods: tuple[float, float]):
            sub_seed = zlib.crc32(f"{seed}:{name}".encode())
            return _SmoothNoise(sub_seed, 16, k_range, periods)

        self.noise = {
            "moisture": noise("moisture", (3.0, 14.0), (3.0, 12.0)),
            "temperature": noise("temperature", (2.0, 12.0), (4.0, 20.0)),
            "humidity": noise("humidity", (3.0, 14.0), (2.0, 10.0)),
            "wind": noise("wind", (3.0, 14.0), (2.0, 8.0)),
            "pressure": noise("pressure", (2.0, 8.0), (3.0, 10.0)),
        }

    def prepare(self, lon: float, lat: float) -> _Location:
        lam, phi = math.radians(lon), math.radians(lat)
        xyz = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))
        phases = {name: n.spatial_phases(xyz) for name, n in self.noise.items()}
        return _Location(lon, lat, phases)

    def _n(self, name: str, loc: _Location, t: float) -> float:
        return self.noise[name].value(loc.phases[name], t)

    # -- building blocks ---------------------------------------------------------------

    @staticmethod
    def _season_angle(t: float) -> float:
        """0 at the March equinox, π/2 at the June solstice."""
        return 2 * math.pi * (t - _SPRING_EQUINOX_DAY) / _YEAR_DAYS

    def _cos_zenith(self, loc: _Location, t: float) -> float:
        declination = math.radians(23.44) * math.sin(self._season_angle(t))
        hour_angle = 2 * math.pi * ((t % 1.0) + loc.lon / 360.0) - math.pi  # 0 at local noon
        phi = math.radians(loc.lat)
        return math.sin(phi) * math.sin(declination) + math.cos(phi) * math.cos(
            declination
        ) * math.cos(hour_angle)

    def _moisture(self, loc: _Location, t: float) -> float:
        # Wet tropics and mid-latitudes, dry subtropics and poles.
        return 0.5 * math.cos(6 * math.radians(loc.lat)) + self._n("moisture", loc, t)

    # -- variables ---------------------------------------------------------------------

    def temperature(self, loc: _Location, t: float) -> float:
        phi = math.radians(loc.lat)
        annual_mean = -25.0 + 53.0 * math.cos(phi)
        # Peaks ~30 days after the solstice; sin(phi) flips the sign between hemispheres.
        seasonal = 15.0 * math.sin(phi) * math.sin(self._season_angle(t - 30.0))
        hour_angle = 2 * math.pi * ((t % 1.0) + loc.lon / 360.0) - math.pi
        diurnal = 5.0 * math.cos(phi) * math.cos(hour_angle - math.pi / 4)  # max ~15:00
        weather = 4.0 * self._n("temperature", loc, t) - 1.5 * self._moisture(loc, t)
        return annual_mean + seasonal + diurnal + weather

    def relative_humidity(self, loc: _Location, t: float) -> float:
        phi = math.radians(loc.lat)
        hour_angle = 2 * math.pi * ((t % 1.0) + loc.lon / 360.0) - math.pi
        rh = (
            62.0
            + 18.0 * self._moisture(loc, t)
            + 7.0 * self._n("humidity", loc, t)
            - 8.0 * math.cos(phi) * math.cos(hour_angle - math.pi / 4)  # drier afternoons
        )
        # Hot air cannot be saturated in reality: cap humidity so the dew point stays
        # at or below ~28 °C (the real-world record is ~35 °C).
        rh_cap = 100.0 * _saturation_ratio(28.0, self.temperature(loc, t))
        return min(100.0, rh_cap, max(3.0, rh))

    def dew_point(self, loc: _Location, t: float) -> float:
        # Magnus formula; always <= temperature because humidity <= 100 %.
        temp = self.temperature(loc, t)
        gamma = math.log(self.relative_humidity(loc, t) / 100.0) + _MAGNUS_A * temp / (
            _MAGNUS_B + temp
        )
        return _MAGNUS_B * gamma / (_MAGNUS_A - gamma)

    def cloud_cover(self, loc: _Location, t: float) -> float:
        return 100.0 / (1.0 + math.exp(-(2.2 * self._moisture(loc, t) - 0.2)))

    def precipitation(self, loc: _Location, t: float) -> float:
        excess = self._moisture(loc, t) - 0.7  # dry most of the time, rain in wet systems
        return 5.0 * excess**1.5 if excess > 0 else 0.0

    def wind_speed(self, loc: _Location, t: float) -> float:
        storminess = 2.0 + 2.0 * abs(math.sin(math.radians(loc.lat)))  # windier mid-lats
        x = 1.2 * self._n("wind", loc, t) + 0.6
        softplus = x if x > 30 else math.log1p(math.exp(x))
        return storminess * softplus

    def air_pressure(self, loc: _Location, t: float) -> float:
        return 1013.0 + 10.0 * self._n("pressure", loc, t) - 4.0 * self._moisture(loc, t)

    def solar_radiation(self, loc: _Location, t: float) -> float:
        cz = self._cos_zenith(loc, t)
        if cz <= 1e-6:
            return 0.0
        clear_sky = 1361.0 * cz * 0.7 ** ((1.0 / cz) ** 0.678)  # Meinel air-mass model
        cloud_fraction = self.cloud_cover(loc, t) / 100.0
        return clear_sky * (1.0 - 0.75 * cloud_fraction**3.4)  # Kasten–Czeplak

    def value(self, variable: str, loc: _Location, t: float) -> float:
        return getattr(self, variable)(loc, t)


if __name__ == "__main__":
    demo_area = {
        "type": "Polygon",
        "coordinates": [[[5.0, 47.0], [15.0, 47.0], [15.0, 55.0], [5.0, 55.0], [5.0, 47.0]]],
    }
    demo = query(demo_area, ("2025-07-01", "2025-07-02"), "temperature")
    print(f"{len(demo.points)} points x {len(demo.times)} timestamps")
    for when, mean in demo.spatial_mean():
        print(f"{when:%Y-%m-%d %H:%M}  mean {mean:6.2f} {demo.unit}")
