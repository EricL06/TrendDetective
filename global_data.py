"""Gridded global temperature data for the Global Explorer.

The station pipeline of TrendDetective (``api_wrapper``/``area_analysis``) asks
weather services for measurements around one point or region at a time. To
compare *any* regions of the planet with each other in seconds, the explorer
uses a gridded, quality-controlled analysis product instead:

**NASA GISTEMP v4** (GHCNv4 land stations + ERSSTv5 ocean), monthly surface
temperature anomalies on a 2° × 2° grid since January 1880, relative to the
1951–1980 mean. Each grid value is interpolated by NASA from the stations
within 1200 km; cells without a station in reach stay empty (NaN). No key or
registration is needed; the file (~26 MB gzip) is downloaded once into
``data/cache/gistemp/``.

Citation: GISTEMP Team (2026): GISS Surface Temperature Analysis (GISTEMP),
version 4. NASA Goddard Institute for Space Studies.
Lenssen et al. (2019), J. Geophys. Res. Atmos., 124, 6307–6326.
"""

from __future__ import annotations

import gzip
import shutil
import threading
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from scipy.io import netcdf_file

BASE_DIR: Path = Path(__file__).resolve().parent
CACHE_DIR: Path = BASE_DIR / "data" / "cache" / "gistemp"
GISTEMP_URL: str = "https://data.giss.nasa.gov/pub/gistemp/gistemp1200_GHCNv4_ERSSTv5.nc.gz"
GISTEMP_FILE: Path = CACHE_DIR / "gistemp1200_GHCNv4_ERSSTv5.nc"
USER_AGENT: str = "TrendDetective/0.1 (climate trend explorer)"


@dataclass
class GriddedDataset:
    """Monthly anomaly grid ``values[time, lat, lon]`` (float32, NaN = no data)."""

    key: str
    name: str
    variable: str
    unit: str
    baseline: tuple[int, int]
    citation: str
    url: str
    lats: np.ndarray  # cell centres, ascending (south → north)
    lons: np.ndarray  # cell centres, ascending (-180 → 180)
    years: np.ndarray  # year of each time step
    months: np.ndarray  # month (1–12) of each time step
    values: np.ndarray
    created: str = ""
    _annual_cache: dict = field(default_factory=dict, repr=False)

    @property
    def lat_step(self) -> float:
        return float(abs(self.lats[1] - self.lats[0]))

    @property
    def lon_step(self) -> float:
        return float(abs(self.lons[1] - self.lons[0]))

    @property
    def first_year(self) -> int:
        return int(self.years[0])

    @property
    def last_month(self) -> tuple[int, int]:
        return int(self.years[-1]), int(self.months[-1])

    def meta(self) -> dict:
        """JSON-ready description of the grid and its provenance."""
        last_year, last_month = self.last_month
        return {
            "key": self.key,
            "name": self.name,
            "variable": self.variable,
            "unit": self.unit,
            "baseline": list(self.baseline),
            "citation": self.citation,
            "url": self.url,
            "created": self.created,
            "grid": {
                "lat_step": self.lat_step,
                "lon_step": self.lon_step,
                "nlat": int(self.lats.size),
                "nlon": int(self.lons.size),
                "lat0": float(self.lats[0]),
                "lon0": float(self.lons[0]),
            },
            "first": [int(self.years[0]), int(self.months[0])],
            "last": [last_year, last_month],
        }


_lock = threading.Lock()
_dataset: GriddedDataset | None = None


def _download(url: str, target: Path) -> None:
    """Download a gzip file and unpack it to ``target`` (atomically)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_gz = target.with_suffix(".nc.gz.part")
    tmp_nc = target.with_suffix(".nc.part")
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=120) as response, tmp_gz.open("wb") as out:
        shutil.copyfileobj(response, out)
    with gzip.open(tmp_gz, "rb") as src, tmp_nc.open("wb") as out:
        shutil.copyfileobj(src, out)
    tmp_nc.replace(target)
    tmp_gz.unlink(missing_ok=True)


def _decode_time(days: np.ndarray, units: str) -> tuple[np.ndarray, np.ndarray]:
    """Turn ``days since YYYY-MM-DD`` into year and month arrays."""
    origin_text = units.split("since", 1)[1].strip().split()[0]
    origin = date.fromisoformat(origin_text)
    stamps = [origin + timedelta(days=int(d)) for d in days]
    return (
        np.array([s.year for s in stamps], dtype=np.int32),
        np.array([s.month for s in stamps], dtype=np.int32),
    )


def load_gistemp(path: Path = GISTEMP_FILE) -> GriddedDataset:
    """Read the GISTEMP netCDF3 file into a :class:`GriddedDataset`."""
    with netcdf_file(str(path), "r", mmap=False) as nc:
        lats = np.asarray(nc.variables["lat"][:], dtype=np.float64)
        lons = np.asarray(nc.variables["lon"][:], dtype=np.float64)
        time_var = nc.variables["time"]
        years, months = _decode_time(time_var[:], time_var.units.decode())
        var = nc.variables["tempanomaly"]
        raw = np.asarray(var[:])
        fill = var._attributes.get("_FillValue", 32767)
        scale = float(var._attributes.get("scale_factor", 1.0))
        values = raw.astype(np.float32) * np.float32(scale)
        values[raw == fill] = np.nan
        history = nc._attributes.get("history", b"").decode(errors="ignore")
    lat_order = np.argsort(lats)
    lon_order = np.argsort(lons)
    values = values[:, lat_order][:, :, lon_order]
    created = history.split("Created", 1)[1].split("by")[0].strip() if "Created" in history else ""
    return GriddedDataset(
        key="gistemp",
        name="NASA GISTEMP v4 (GHCNv4 + ERSSTv5)",
        variable="Oberflächentemperatur-Anomalie",
        unit="°C",
        baseline=(1951, 1980),
        citation=(
            "GISTEMP Team (2026): GISS Surface Temperature Analysis, v4. NASA GISS. "
            "Lenssen et al. (2019), JGR Atmospheres 124, 6307–6326."
        ),
        url="https://data.giss.nasa.gov/gistemp/",
        lats=lats[lat_order],
        lons=lons[lon_order],
        years=years,
        months=months,
        values=values,
        created=created,
    )


def get_dataset() -> GriddedDataset:
    """Return the loaded dataset, downloading it on first use."""
    global _dataset
    with _lock:
        if _dataset is None:
            if not GISTEMP_FILE.exists():
                _download(GISTEMP_URL, GISTEMP_FILE)
            _dataset = load_gistemp(GISTEMP_FILE)
        return _dataset


def set_dataset(dataset: GriddedDataset | None) -> None:
    """Replace the loaded dataset (used by tests with a synthetic grid)."""
    global _dataset
    with _lock:
        _dataset = dataset
