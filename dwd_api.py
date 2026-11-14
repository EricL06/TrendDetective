"""Daily climate observations of the German weather service (DWD), from its Open Data server.

No registration is needed. Station list and data come from the Climate Data
Center (CDC) directory ``observations_germany/climate/daily/kl``: one zip per
station with the whole history up to last year (``historical/``) and one with
the last ~500 days (``recent/``). Both are cached in :data:`station_sources.CACHE_DIR`.

DWD numbers its stations itself (``00403``). WMO numbers, needed to recognise
the same station in GHCN-Daily, come from the Bright Sky API, which mirrors
DWD's data; if it is unreachable, duplicates are still found by position.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import Any

from station_sources import (
    CACHE_DIR,
    SourceError,
    SourceTopic,
    Station,
    StationSource,
    cached_download,
    distance_km,
    http_get,
    http_get_json,
    in_box,
    with_coverage,
    wmo_key,
)

BASE_URL: str = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl/"
STATION_LIST_URL: str = BASE_URL + "historical/KL_Tageswerte_Beschreibung_Stationen.txt"
BRIGHT_SKY_SOURCES_URL: str = "https://api.brightsky.dev/sources"

_MISSING: float = -999.0

_COLUMNS: dict[str, tuple[str, str, float]] = {
    # DWD column: (shared description, unit, factor)
    "TXK": ("tmax", "°C", 1.0),
    "TNK": ("tmin", "°C", 1.0),
    "TMK": ("tavg", "°C", 1.0),
    "RSK": ("prcp", "mm", 1.0),
    "SHK_TAG": ("snwd", "mm", 10.0),  # cm
    "FM": ("awnd", "m/s", 1.0),
    "FX": ("wsfg", "m/s", 1.0),
}
"""Columns of ``produkt_klima_tag_*.txt`` mapped to NOAA's codes and units."""


def _parse_station_list(text: str) -> list[dict[str, Any]]:
    """Rows of the fixed-width ``KL_Tageswerte_Beschreibung_Stationen.txt``."""
    pattern = re.compile(
        r"^(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(.+?)\s{2,}"
    )
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        rows.append(
            {
                "id": match.group(1),
                "first": datetime.strptime(match.group(2), "%Y%m%d").date(),
                "last": datetime.strptime(match.group(3), "%Y%m%d").date(),
                "elevation": float(match.group(4)),
                "latitude": float(match.group(5)),
                "longitude": float(match.group(6)),
                "name": match.group(7).strip(),
            }
        )
    return rows


def _parse_product(text: str) -> list[dict[str, str]]:
    """Rows of a ``produkt_klima_tag_*.txt`` file, keys and values stripped."""
    reader = csv.reader(io.StringIO(text), delimiter=";")
    header = [name.strip() for name in next(reader, [])]
    return [
        {name: value.strip() for name, value in zip(header, row)}
        for row in reader
        if len(row) >= len(header) - 1
    ]


class DWDClient(StationSource):
    """German weather service daily climate data (temperature, precipitation, snow, wind)."""

    SOURCE = "DWD"
    PRIORITY = 0
    COVERAGE = (5.5, 47.0, 15.5, 55.2)
    TOPICS = {
        "temperature": SourceTopic(
            "Daily air temperature", ("tmax", "tmin", "tavg"),
            "Daily maximum, minimum and mean air temperature (2 m).",
        ),
        "precipitation": SourceTopic("Daily precipitation", ("prcp",), "Daily precipitation total."),
        "snow_depth": SourceTopic("Snow depth", ("snwd",), "Snow depth in the morning."),
        "wind_speed": SourceTopic(
            "Daily wind speed", ("awnd", "wsfg"), "Daily mean wind speed and peak gust."
        ),
    }

    _station_rows: list[dict[str, Any]] | None = None
    _wmo_numbers: dict[str, str] = {}
    _historical_files: dict[str, str] | None = None

    # ------------------------------------------------------------ stations

    @classmethod
    def _all_stations(cls) -> list[dict[str, Any]]:
        if cls._station_rows is None:
            path = cached_download(
                STATION_LIST_URL, CACHE_DIR / "dwd" / "kl_stations.txt",
                source="DWD", max_age_days=1.0,
            )
            cls._station_rows = _parse_station_list(path.read_text(encoding="latin-1"))
        return cls._station_rows

    @classmethod
    def _load_wmo_numbers(cls, bbox: tuple[float, float, float, float]) -> None:
        """Fill :attr:`_wmo_numbers` (DWD id → WMO number) around ``bbox`` from Bright Sky."""
        west, south, east, north = bbox
        latitude, longitude = (south + north) / 2, (west + east) / 2
        radius_m = min(500_000, int(distance_km(latitude, longitude, north, east) * 1000) + 10_000)
        try:
            payload = http_get_json(
                BRIGHT_SKY_SOURCES_URL,
                {"lat": latitude, "lon": longitude, "max_dist": radius_m},
                source="Bright Sky", timeout=20, max_seconds=40,
            )
        except SourceError:
            return  # co-location still finds most duplicates
        for source in payload.get("sources", []) if isinstance(payload, dict) else []:
            dwd_id, wmo = source.get("dwd_station_id"), source.get("wmo_station_id")
            if dwd_id and wmo and str(wmo).isdigit():
                cls._wmo_numbers.setdefault(str(dwd_id), str(wmo))

    def stations(
        self, bbox: tuple[float, float, float, float], topic: str, start_date: date, end_date: date
    ) -> list[Station]:
        rows = [row for row in self._all_stations() if in_box(row["latitude"], row["longitude"], bbox)]
        if not rows:
            return []
        if any(row["id"] not in self._wmo_numbers for row in rows):
            self._load_wmo_numbers(bbox)
        stations: list[Station] = []
        for row in rows:
            keys = {f"dwd:{row['id']}"}
            wmo = wmo_key(self._wmo_numbers.get(row["id"]))
            if wmo:
                keys.add(wmo)
            station = Station(
                source=self.SOURCE,
                id=f"DWD:{row['id']}",
                name=row["name"],
                latitude=row["latitude"],
                longitude=row["longitude"],
                elevation=row["elevation"],
                first_date=row["first"],
                last_date=row["last"],
                ids=frozenset(keys),
                priority=self.PRIORITY,
                extra={"dwd_id": row["id"]},
            )
            station = with_coverage(station, start_date, end_date)
            if station.coverage > 0:
                stations.append(station)
        return stations

    # ---------------------------------------------------------------- data

    @classmethod
    def _historical_file_names(cls) -> dict[str, str]:
        """DWD id → file name in ``historical/`` (the name holds the record's dates)."""
        if cls._historical_files is None:
            listing = http_get(BASE_URL + "historical/", source="DWD").decode("latin-1")
            cls._historical_files = {
                match.group(1): match.group(0)
                for match in re.finditer(r"tageswerte_KL_(\d{5})_\d{8}_\d{8}_hist\.zip", listing)
            }
        return cls._historical_files

    def _zip_rows(self, url: str, path: Path, max_age_days: float) -> list[dict[str, str]]:
        try:
            cached_download(url, path, source="DWD", max_age_days=max_age_days)
        except SourceError as error:
            if "404" in str(error):
                return []
            raise
        try:
            with zipfile.ZipFile(path) as archive:
                product = next(
                    (name for name in archive.namelist() if name.startswith("produkt_klima_tag")), None
                )
                if product is None:
                    return []
                return _parse_product(archive.read(product).decode("latin-1"))
        except zipfile.BadZipFile:
            path.unlink(missing_ok=True)
            return []

    def _station_rows_for(self, dwd_id: str, start_date: date, end_date: date) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        historical = self._historical_file_names().get(dwd_id)
        if historical:
            last_year = int(historical.split("_")[4][:4])
            if start_date.year <= last_year:
                rows += self._zip_rows(
                    BASE_URL + "historical/" + historical,
                    CACHE_DIR / "dwd" / historical,
                    max_age_days=30.0,
                )
        if end_date >= date(date.today().year - 2, 1, 1):
            name = f"tageswerte_KL_{dwd_id}_akt.zip"
            rows += self._zip_rows(BASE_URL + "recent/" + name, CACHE_DIR / "dwd" / name, max_age_days=1.0)
        return rows

    def fetch(
        self, stations: list[Station], topic: str, start_date: date, end_date: date
    ) -> list[dict[str, Any]]:
        wanted = set(self.TOPICS[topic].variables)
        columns = {column: spec for column, spec in _COLUMNS.items() if spec[0] in wanted}
        start_text, end_text = start_date.strftime("%Y%m%d"), end_date.strftime("%Y%m%d")
        records: list[dict[str, Any]] = []
        for station in stations:
            seen_days: set[str] = set()
            for row in self._station_rows_for(station.extra["dwd_id"], start_date, end_date):
                day = row.get("MESS_DATUM", "")
                if not (start_text <= day <= end_text) or day in seen_days:
                    continue  # historical and recent overlap by a few months
                seen_days.add(day)
                iso_day = f"{day[:4]}-{day[4:6]}-{day[6:8]}"
                for column, (description, unit, factor) in columns.items():
                    try:
                        value = float(row.get(column, ""))
                    except ValueError:
                        continue
                    if value == _MISSING:
                        continue
                    records.append(station.record(iso_day, round(value * factor, 3), description, unit))
        return records


__all__ = ["DWDClient"]
