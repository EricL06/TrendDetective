"""Run a fixed live NOAA NCEI integration request and print returned data.

The example requests daily precipitation observations near Washington, DC,
for January 2020. It saves the NOAA JSON response under ``data/noaa_test/``
and prints up to ten returned records. The NCEI Access Data Service does not
require an API key.

Run from the repository root with::

    python noaa_test.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

from api_wrapper import PointDataRequest, fetch_data_single_topic_single_coordinate
from noaa_api import NOAAError


REQUEST: PointDataRequest = PointDataRequest(
    latitude=38.8951,
    longitude=-77.0364,
    topic="precipitation",
    start_date=date(2020, 1, 1),
    end_date=date(2020, 5, 31),
)
"""Fixed integration request: precipitation near Washington, DC, in January 2020."""

OUTPUT_DIR: Path = Path("data/noaa_test")
"""Directory for the saved NOAA response."""

MAX_PREVIEW_RECORDS: int = 10
"""Maximum number of returned records printed to the console."""


def display_response(path: Path, *, max_records: int = MAX_PREVIEW_RECORDS) -> None:
    """Print a bounded preview of a saved JSON response.

    :param path: Path to the NOAA response JSON file.
    :type path: pathlib.Path
    :param max_records: Maximum number of observation records to print.
    :type max_records: int
    :returns: ``None``. Output is written to standard output.
    :rtype: None
    """
    with path.open("r", encoding="utf-8") as response_file:
        payload: Any = json.load(response_file)
    records: Any = payload.get("results", payload) if isinstance(payload, dict) else payload
    print(f"\n--- NOAA response: {path} ---")
    if isinstance(records, list):
        print(f"Returned {len(records)} record(s); showing up to {max_records}:")
        record: Any
        for record in records[:max_records]:
            print(json.dumps(record, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2)[:8000])
        if len(json.dumps(payload, ensure_ascii=False)) > 8000:
            print("... (preview limited to 8,000 characters)")


def run_noaa_test() -> list[Path]:
    """Fetch the fixed NOAA request and show its returned records.

    :returns: Paths to saved NOAA JSON responses.
    :rtype: list[pathlib.Path]
    :raises NOAAError: If the NOAA service rejects or fails the request.
    :raises ValueError: If the request parameters are invalid.
    """
    print("Submitting NOAA NCEI integration request:")
    print(
        f"  topic={REQUEST.topic}, coordinate=({REQUEST.latitude}, "
        f"{REQUEST.longitude}), dates={REQUEST.start_date} to {REQUEST.end_date}"
    )
    paths: list[Path] = fetch_data_single_topic_single_coordinate(
        REQUEST,
        provider="noaa",
        output_dir=OUTPUT_DIR,
    )
    for path in paths:
        display_response(path)
    return paths


def main() -> int:
    """Run the NOAA integration example as a command-line program.

    :returns: Process exit status (0 for success, 1 for request failure).
    :rtype: int
    """
    try:
        run_noaa_test()
    except (NOAAError, ValueError) as error:
        print(f"NOAA NCEI integration request failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
