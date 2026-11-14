# Map Widget – Integration Guide

The widget is a React component. The user draws an area on a map; you get that area as GeoJSON.
You send data back; the widget draws it on the same map.

```
user draws ──► MapWidget ──onAreaSelected(area)──► your page ──► Data Loader
                   ▲                                                  │
                   └──────────────── resultData ◄─────────────────────┘
```

All coordinates are `[longitude, latitude]` in WGS84.

---

## 1. Add it to the website

Copy (or reference) the folder `map-widget/src/widget/` and install its dependencies:

```bash
npm install maplibre-gl terra-draw terra-draw-maplibre-gl-adapter earcut
```

The project must use **Vite** (the widget loads a MapLibre file with Vite's `?url` import).

```tsx
import { useState } from "react";
import { MapWidget, type AreaFeature, type MapData } from "./widget";

export function MapSection() {
  const [data, setData] = useState<MapData>();
  const [loading, setLoading] = useState(false);

  return (
    <div style={{ height: 600 }}>                 {/* the widget fills its parent: give it a height */}
      <MapWidget
        onAreaSelected={async (area: AreaFeature) => {
          setLoading(true);
          setData(await dataLoader.load(area));  // ← your Data Loader
          setLoading(false);
        }}
        onAreaCleared={() => setData(undefined)}
        resultData={data}
        loading={loading}
      />
    </div>
  );
}
```

A working example: [`src/demo/App.tsx`](src/demo/App.tsx).

---

## 2. What the widget needs (props)

| Prop | Type | Required | What it is |
|---|---|---|---|
| `onAreaSelected` | `(area: AreaFeature) => void` | **yes** | Called when the user finishes drawing or editing an area. |
| `onAreaCleared` | `() => void` | no | Called when the user deletes the area. |
| `resultData` | `MapData` or `MapData[]` | no | The data to show (see §4). `undefined` = show nothing. |
| `loading` | `boolean` | no | Shows "Loading data…" while `true`. |
| `initialArea` | GeoJSON polygon feature | no | An area to show when the page opens. |
| `basemap` | `"streets"`, `"light"`, `"dark"`, `"satellite"` | no | Start map. Default `"streets"`. |
| `projection` | `"globe"` or `"mercator"` | no | Start view. Default `"globe"`. |

---

## 3. What the widget delivers: `AreaFeature`

`onAreaSelected` receives a GeoJSON Feature:

```json
{
  "type": "Feature",
  "bbox": [6.0, 50.0, 8.0, 52.0],
  "properties": {
    "selectionId": "area-001",
    "shape": "rectangle",
    "crossesAntimeridian": false,
    "areaKm2": 31193.4
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[6.0, 50.0], [8.0, 50.0], [8.0, 52.0], [6.0, 52.0], [6.0, 50.0]]]
  }
}
```

| Field | Meaning |
|---|---|
| `geometry` | The drawn area. Closed polygon, one ring. |
| `bbox` | `[west, south, east, north]`. Easiest input for most APIs. |
| `selectionId` | Same id while the user edits the area; new id for a new area. |
| `shape` | `"rectangle"`, `"polygon"` or `"freehand"`. |
| `areaKm2` | Size of the area. |
| `crossesAntimeridian` | `true` if the area spans the ±180° line. Then `bbox` has `west > east`. |

There is only ever one area at a time.

---

## 4. What the widget needs back: `MapData`

Pick the type that matches your data.

### Values to fill the area with (recommended for trends) – `field`

Send points with a number; the widget fills the area with coloured triangles.

```ts
{
  type: "field",
  samples: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { value: 0.42 }, geometry: { type: "Point", coordinates: [6.5, 50.5] } },
    // … more points, spread over the whole area
  ] },
  area,                                   // the AreaFeature you received
  colorScale: { min: -1, max: 1 },        // optional
}
```

### Points, lines, shapes – `geojson`

```ts
{ type: "geojson", data: featureCollection }
```

Optional `properties.color` per feature (e.g. `"#d7301f"`). Clicking a feature shows its properties.

### Map tiles – `raster`

```ts
{
  type: "raster",
  tiles: ["https://…/{z}/{x}/{y}.png"],   // Web Mercator XYZ tiles, e.g. NASA GIBS
  bounds: area.bbox,                      // optional: only load tiles here
  maxzoom: 7,                             // optional
}
```

### One image – `image`

```ts
{ type: "image", url: "https://…/picture.png", bounds: [west, south, east, north] }
```

Several layers at once: pass an array, e.g. `resultData={[rasterLayer, stationPoints]}`.

---

## 5. Optional: control it from your page

```tsx
const ref = useRef<MapWidgetHandle>(null);
<MapWidget ref={ref} … />

ref.current?.getArea();      // current area or null
ref.current?.clearArea();    // remove the area
ref.current?.fitToArea();    // zoom to the area
```
