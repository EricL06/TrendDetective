# TrendDetective
Be An Earth System Trend Detective!

## Run the website

```bash
python3 app.py
```

Open http://127.0.0.1:8000. Choose a timestamp, an interval and topics in the sidebar, draw an
area on the world map, and click **Apply**.

## Map widget

The world map is the widget in [`map-widget/`](map-widget/), built into [`static/map-widget/`](static/map-widget/).

- [map-widget/API.md](map-widget/API.md) – how the page uses the widget (what it needs, what it delivers)
- [map-widget/DEVELOPMENT.md](map-widget/DEVELOPMENT.md) – how the widget works internally

After changing widget code, rebuild the bundle and commit `static/map-widget/`:

```bash
cd map-widget && npm install && npm run build:embed
```

## Mock weather data

[`mock_data.py`](mock_data.py) generates synthetic but realistic weather data for testing methods
and visualisations (standard library only). Pass a GeoJSON point or area, a `(from, to)` time range
and a variable:

```python
import mock_data

area = {"type": "Polygon", "coordinates": [[[6, 47.5], [15, 47.5], [15, 55], [6, 55], [6, 47.5]]]}
data = mock_data.query(area, ("2025-07-01", "2025-07-31"), "temperature")
data.values          # values[time_index][point_index]
data.spatial_mean()  # [(timestamp, mean), ...]
data.to_geojson(0)   # FeatureCollection for the map widget
```

Variables: temperature, relative_humidity, wind_speed, precipitation, air_pressure, cloud_cover,
solar_radiation and dew_point. Every result is checked: values must lie in a plausible range, and
neighbouring points of an area must not differ more than a per-variable limit per km.

```bash
python3 -m unittest discover tests
```
