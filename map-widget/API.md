# Map Widget – API Reference

What goes **into** the widget and what comes **out** of it, written for the
interface developer (Hauptfrontend) and the data developer (Data Loader).
Source of truth: [`src/widget/types.ts`](src/widget/types.ts). Import everything from `src/widget`:

```ts
import { MapWidget, splitAtAntimeridian, type AreaFeature, type MapData } from "./map-widget/src/widget";
```

Conventions everywhere: WGS84 / EPSG:4326, coordinates are `[longitude, latitude]`, polygons are closed.

---

## 1. Data flow at a glance

```
User draws ──► MapWidget ──onAreaSelected(area: AreaFeature)──► Hauptfrontend ──► Data Loader
                  ▲                                                                   │
                  └────────────── resultData: MapData | MapData[] ◄───────────────────┘
```

| Direction | Name | Type | Who uses it |
|---|---|---|---|
| Widget → Frontend | `onAreaSelected` | `(area: AreaFeature) => void` | Frontend passes `area` to the Data Loader |
| Widget → Frontend | `onAreaCleared` | `() => void` | Frontend clears results |
| Frontend → Widget | `resultData` | `MapData \| MapData[]` | Data Loader output, unchanged |
| Frontend → Widget | `loading` | `boolean` | `true` while the Data Loader is working |
| Frontend → Widget | `initialArea` | `Feature<Polygon>` | Optional preset selection |

**Data Loader contract (suggested signature):**

```ts
async function loadData(area: AreaFeature /* + your own params, e.g. dataset, date */): Promise<MapData | MapData[]>
```

---

## 2. `<MapWidget>` component

```tsx
function MapWidget(props: MapWidgetProps & { ref?: Ref<MapWidgetHandle> }): JSX.Element
```

The widget fills its parent element. Give the parent a height.

### Props – `MapWidgetProps`

| Prop | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `onAreaSelected` | `(area: AreaFeature) => void` | **yes** | – | Fired when the user **finishes** drawing a shape and after **every edit** (move, resize, vertex drag). Same `selectionId` while editing. |
| `onAreaCleared` | `() => void` | no | – | Fired when the user deletes the selection. |
| `resultData` | `MapData \| MapData[]` | no | – | Data to show. An array is drawn bottom → top. Pass `undefined` to clear. Replacing the object re-renders. |
| `loading` | `boolean` | no | `false` | Shows a "Loading data…" badge. |
| `initialArea` | `Feature<Polygon>` | no | – | Selection shown on mount (read once). The map zooms to it. Does **not** fire `onAreaSelected`. |
| `basemap` | `"streets" \| "light" \| "dark" \| "satellite" \| string \| StyleSpecification` | no | `"streets"` | Preset, MapLibre style URL, or style object. The user can also switch in the toolbar. |
| `projection` | `"globe" \| "mercator"` | no | `"globe"` | Starting projection. The user can switch in the toolbar. |
| `hideToolbar` | `boolean` | no | `false` | Hide built-in buttons (drive it via `ref` instead). |
| `className` | `string` | no | – | Extra class on the root element. |
| `style` | `CSSProperties` | no | – | Inline style on the root element. |

### Imperative handle – `MapWidgetHandle` (via `ref`)

```ts
interface MapWidgetHandle {
  getArea(): AreaFeature | null;   // current selection, or null
  clearArea(): void;               // remove selection (does NOT fire onAreaCleared)
  fitToArea(): void;               // zoom the map to the selection
  setTool(tool: DrawTool): void;   // "select" | "rectangle" | "polygon" | "freehand"
}
```

### Minimal integration

```tsx
const [area, setArea] = useState<AreaFeature | null>(null);
const [data, setData] = useState<MapData>();
const [loading, setLoading] = useState(false);

<div style={{ height: 600 }}>
  <MapWidget
    onAreaSelected={async (a) => {
      setArea(a);
      setLoading(true);
      setData(await dataLoader.load(a));   // ← Data Loader
      setLoading(false);
    }}
    onAreaCleared={() => setData(undefined)}
    resultData={data}
    loading={loading}
  />
</div>
```

A complete example (including race handling for fast re-selections) is in [`src/demo/App.tsx`](src/demo/App.tsx).

---

## 3. Output type – `AreaFeature` (Widget → Data Loader)

```ts
type AreaFeature = Feature<Polygon, AreaProperties> & { bbox: BBox };

interface AreaProperties {
  selectionId: string;            // "area-001", "area-002", … stable while the user edits
  shape: "rectangle" | "polygon" | "freehand";
  crossesAntimeridian: boolean;   // true if the area spans the ±180° line
  areaKm2: number;                // geodesic area, 0.1 km² precision
}

type BBox = [west: number, south: number, east: number, north: number];
```

Guarantees:
- Exactly **one** outer ring, **closed** (first point = last point), **counter-clockwise** (RFC 7946).
- Coordinates rounded to 6 decimals (~0.1 m); latitudes within [-90, 90].
- `bbox` is always present. If `crossesAntimeridian` is `true`, then `west > east` (RFC 7946 §5.2), e.g. `[170, -10, -170, 10]`.
- If the area crosses the antimeridian, the ring stays **continuous**, so some longitudes are outside ±180
  (e.g. `-197.9`). Use `splitAtAntimeridian()` if your API needs strictly wrapped coordinates.
- Only one selection exists at a time; drawing a new one replaces the old one.

Example:

```json
{
  "type": "Feature",
  "bbox": [6.0, 50.0, 8.0, 52.0],
  "properties": { "selectionId": "area-001", "shape": "rectangle", "crossesAntimeridian": false, "areaKm2": 31193.4 },
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[6.0, 50.0], [8.0, 50.0], [8.0, 52.0], [6.0, 52.0], [6.0, 50.0]]]
  }
}
```

Tip for NASA APIs: CMR / Earthdata `bounding_box=W,S,E,N` accepts `area.bbox` directly (including `W > E`).

---

## 4. Input type – `MapData` (Data Loader → Widget)

```ts
type MapData = GeoJsonMapData | RasterMapData | ImageMapData;
```

All variants accept two optional fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Name for the layer (used in layer ids). |
| `opacity` | `number` (0–1) | Layer opacity. |

### 4.1 Vector – `GeoJsonMapData`

```ts
{ type: "geojson"; data: FeatureCollection; id?: string; opacity?: number }
```

- Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon are drawn automatically.
- `feature.properties.color` (any CSS color, e.g. `"#d7301f"` or `"rgb(200,30,30)"`) sets the color per feature.
  Without it, features are blue.
- All other properties are shown in a popup when the user clicks the feature (in "Pan & edit" mode).

### 4.2 Raster tiles – `RasterMapData`

```ts
{
  type: "raster";
  tiles: string[];        // XYZ URL templates with {z}/{x}/{y}, Web Mercator tile grid (EPSG:3857)
  bounds?: BBox;          // only request tiles inside this box
  tileSize?: number;      // default 256
  minzoom?: number;
  maxzoom?: number;       // highest zoom the server has; MapLibre upscales beyond it
  attribution?: string;
  id?: string;
  opacity?: number;       // default 0.8
}
```

NASA GIBS example:

```ts
{
  type: "raster",
  tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/default/2025-07-01/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png"],
  bounds: area.bbox,
  maxzoom: 7,
}
```

Note: `bounds` limits which tiles are **loaded**; it does not cut tiles exactly at the box edge.

### 4.3 Single image – `ImageMapData` (extension of the spec)

```ts
{ type: "image"; url: string; bounds: BBox; id?: string; opacity?: number }
```

Stretches one image (PNG/JPEG, e.g. a WMS `GetMap` result) over `bounds`.
The image should be in Web Mercator (EPSG:3857). An EPSG:4326 image will be shifted in latitude over large areas.

---

## 5. Helper functions (exported)

```ts
splitAtAntimeridian<P>(feature: Feature<Polygon, P>): Feature<Polygon | MultiPolygon, P>
```
Input: a polygon feature (e.g. an `AreaFeature`). Output: the same feature with all longitudes in [-180, 180];
becomes a `MultiPolygon` if the area crosses the antimeridian (RFC 7946 §3.1.9). Non-crossing input is returned unchanged.

```ts
wrapLng(lng: number): number
```
Input: any longitude. Output: the same longitude in [-180, 180] (180 stays 180).

```ts
geodesicAreaKm2(ring: Position[]): number
```
Input: closed ring of `[lng, lat]`. Output: area in km² (spherical Earth).

```ts
BASEMAPS: Record<BasemapId, { label: string; style: string | StyleSpecification }>
```
The built-in basemap presets (all key-free: OpenFreeMap and NASA GIBS Blue Marble).

---

## 6. Internal modules (for widget developers)

Not needed for integration. Listed so the module boundaries from the spec are visible.

### `MapEngine` – [`src/widget/MapEngine.ts`](src/widget/MapEngine.ts)

| Member | Input | Output | Purpose |
|---|---|---|---|
| `new MapEngine(opts)` | `{ container: HTMLElement; style: string \| StyleSpecification; projection: ProjectionType; center?: [lng, lat]; zoom?: number }` | instance | Creates the MapLibre map and controls. |
| `map` | – | `maplibregl.Map` | The raw map. |
| `onStyleReady(fn)` | `() => void` | unsubscribe `() => void` | Called after every style load. |
| `onBeforeStyleChange(fn)` | `() => void` | unsubscribe `() => void` | Called right before the basemap is replaced. |
| `setStyle(style)` | `string \| StyleSpecification` | `void` | Switch basemap. |
| `setProjection(p)` | `"globe" \| "mercator"` | `void` | Switch projection. |
| `fitToBBox(bbox, opts?)` | `BBox`, `{ padding?: number; maxZoom?: number }` | `void` | Zoom to a box (antimeridian-aware). |
| `firstBasemapSymbolLayerId(ignore)` | `string[]` (layer id prefixes) | `string \| undefined` | First label layer, so data goes below labels. |
| `destroy()` | – | `void` | Removes the map. |

### `SelectionManager` – [`src/widget/SelectionManager.ts`](src/widget/SelectionManager.ts)

| Member | Input | Output | Purpose |
|---|---|---|---|
| `new SelectionManager(cb)` | `{ onChange: (area: AreaFeature \| null) => void; onToolChange: (tool: DrawTool) => void }` | instance | Wraps Terra Draw. |
| `attach(map)` | `maplibregl.Map` | `void` | Start Terra Draw (after style load). Restores a parked selection. |
| `detach()` | – | `void` | Stop Terra Draw, keep the selection (before style change / unmount). |
| `setTool(tool)` | `DrawTool` | `void` | Switch drawing mode. |
| `currentTool` | – | `DrawTool` | Active mode. |
| `getArea()` | – | `AreaFeature \| null` | Export the selection as GeoJSON. |
| `setArea(feature)` | `Feature<Polygon>` | `boolean` (false = rejected) | Set the selection from code. Does not fire `onChange`. |
| `clear(notify)` | `boolean` | `void` | Remove the selection; `notify = true` fires `onChange(null)`. |

### `DataRenderer` – [`src/widget/DataRenderer.ts`](src/widget/DataRenderer.ts)

| Member | Input | Output | Purpose |
|---|---|---|---|
| `new DataRenderer(map, opts)` | `maplibregl.Map`, `{ beforeLayerId: () => string \| undefined; popupsEnabled: () => boolean }` | instance | Draws result layers. |
| `setData(data)` | `MapData[]` | `void` | Replace all result layers. |
| `suspend()` | – | `void` | Call before the style is replaced. |
| `reapply()` | – | `void` | Re-add layers after a style load. |
| `destroy()` | – | `void` | Remove listeners and popup. |

### `geo.ts` (internal helpers besides the exported ones)

| Function | Input | Output |
|---|---|---|
| `normalizeRing(ring)` | `Position[]` | `{ ring: Position[]; bbox: BBox; crossesAntimeridian: boolean }` – closed, CCW, rounded, shifted to centre within ±180 |
| `isAxisAlignedRectangle(ring)` | `Position[]` | `boolean` |

Map layer id prefixes: `mw-data-*` (results), `mw-sel-*` (selection). Avoid these in host styles.
