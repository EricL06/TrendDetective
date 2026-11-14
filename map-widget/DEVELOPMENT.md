# Map Widget – Developer Reference

Internal notes for working on the widget: what is used, how it works, and what to watch out for.
For embedding the widget in the website, see [API.md](API.md).

---

## 1. Purpose and scope

- The widget lets a user select **one** area on a world map and returns it as GeoJSON.
- It draws the Data Loader's results on the same map.
- It knows nothing about NASA APIs or the rest of the website. Everything goes through props and callbacks.
- Based on the team spec "Technische Spezifikation – Interactive Map Widget". We extended it with
  the `image` and `field` data types, `onAreaCleared`, a `ref` handle, and extra area properties.

## 2. Commands

Run these in `map-widget/`:

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Demo at http://localhost:5173 (also startable from the app via `.claude/launch.json`) |
| `npx tsc -b` | Type check |
| `npm run lint` | oxlint |
| `npm run build` | Production build to `dist/` (type check + Vite) |

There are no automated tests yet. Checks are done by hand in the demo (see §11).

## 3. Stack

| Package | Version | Used for |
|---|---|---|
| `react`, `react-dom` | 19.3 | Component. Uses React 19 `ref` as a prop. |
| `maplibre-gl` | 6.18 | Map engine: globe/mercator, sources, layers, popups |
| `terra-draw` | 1.39 | Drawing and editing shapes |
| `terra-draw-maplibre-gl-adapter` | 1.5 | Connects Terra Draw to MapLibre |
| `earcut` | 3.2 | Polygon → triangles (border cells of the mesh) |
| `vite` | 8.3 | Dev server and build |
| `typescript` | 7.0 | Types (`erasableSyntaxOnly`: no `enum`, no constructor parameter properties) |
| `@types/geojson` | – | GeoJSON types |

Basemaps need no API key: **OpenFreeMap** (vector styles liberty/positron/dark) and **NASA GIBS Blue Marble** (raster, tiles up to z8).

## 4. Folder layout

```
map-widget/
├── API.md                 integration guide (for the website team)
├── DEVELOPMENT.md         this file
├── src/
│   ├── main.tsx           mounts the demo
│   ├── demo/              demo host page ("Hauptfrontend" stand-in)
│   │   ├── App.tsx        wires widget ↔ mock loader, mesh sliders, event log
│   │   └── mockDataLoader.ts  fake Data Loader: field / stations / MODIS raster
│   └── widget/            THE WIDGET — self-contained, no imports from outside
│       ├── index.ts       public exports
│       ├── types.ts       all public types (props, AreaFeature, MapData…)
│       ├── MapWidget.tsx  React component: wiring, toolbar, status line
│       ├── MapWidget.css  styles, all scoped under .mw-root
│       ├── MapEngine.ts   MapLibre: map, controls, basemap, projection, camera
│       ├── SelectionManager.ts  Terra Draw: tools, editing, single selection, export
│       ├── DataRenderer.ts      result layers: geojson / field / raster / image, popups
│       ├── mesh.ts        border-refined triangle mesh + IDW interpolation
│       ├── geo.ts         ring normalisation, antimeridian, area, split
│       └── basemaps.ts    basemap presets
```

Rule: `src/widget/` must never import from `src/demo/` or the website.

## 5. Architecture

```
MapWidget.tsx (React)
 ├── MapEngine          owns the maplibregl.Map
 ├── SelectionManager   owns the TerraDraw instance   (attached to engine.map)
 └── DataRenderer       owns result sources/layers    (attached to engine.map)
```

The three modules don't know about each other. `MapWidget` connects them with callbacks.

### Lifecycle

**Mount** (effect runs once; React StrictMode mounts twice in dev, which is fine):
1. `new MapEngine(...)` creates the map with the start basemap.
2. `new SelectionManager(...)` and `new DataRenderer(...)` are created but not drawn yet.
3. On every `style.load`, `MapEngine` applies the projection and calls `onStyleReady`. Then:
   - `renderer.reapply()` adds the data layers.
   - `selection.attach(map)` starts Terra Draw. Its layers come last, so they sit on top.
   - The first time only, `initialArea` is set and the map zooms to it.

**Basemap switch** (`engine.setStyle`):
1. `onBeforeStyleChange` → `selection.detach()` parks the selection and stops Terra Draw; `renderer.suspend()`.
2. `map.setStyle(style, { diff: false })` — `diff:false` forces a full reload, so `style.load` fires.
3. `style.load` → same as mount step 3. The parked selection and current data come back.

**Unmount**: `selection.detach()` → `renderer.destroy()` → `engine.destroy()` (`map.remove()`).

**Props after mount**:
- `resultData` → `renderer.setData()`.
- `basemap` / `projection` → engine.
- Callbacks are read from `propsRef`, so changing them doesn't rebuild the map.
- `initialArea` is read only once.

## 6. MapEngine

- Creates the map with center `[10, 25]`, zoom 1.4, `renderWorldCopies: true`, compact attribution, navigation control (top right) and scale bar (bottom left).
- **Worker fix**: MapLibre v6 loads its worker from a separate file found relative to `import.meta.url`. Vite's dependency pre-bundling breaks that path ("Worker failed to load"). We import `maplibre-gl/dist/maplibre-gl-worker.mjs?url` and call `setWorkerUrl()`. This works in dev and production. A non-Vite bundler needs its own asset import here.
- The projection is part of the style in MapLibre 5+, so it's set again after every style load.
- `fitToBBox` handles `west > east` by adding 360 to east.
- `firstBasemapSymbolLayerId` finds the first label layer of the basemap, so data can go below labels.

## 7. SelectionManager (Terra Draw)

### Tools and modes
| Tool | Terra Draw mode | Interaction |
|---|---|---|
| `select` ("Pan & edit") | `TerraDrawSelectMode` | Pan the map; click the area to select it; drag it, drag corners or vertices; Delete key removes it |
| `rectangle` | `TerraDrawRectangleMode` (`click-move-or-drag`) | Drag, or click twice |
| `polygon` | `TerraDrawPolygonMode` | Click corners; click the first point or press Enter to finish; Esc cancels |
| `freehand` | `TerraDrawFreehandMode` | Click, move, click |

Edit rules per shape (select-mode `flags`):
- **rectangle**: move it, or resize it from the opposite corner.
- **polygon**: move it, drag/add/delete vertices.
- **freehand**: move it, drag/delete vertices.

Polygon and freehand reject self-intersecting shapes (`ValidateNotSelfIntersecting`).

### Behaviour
- **One area at a time.** When a drawing finishes (`finish` with `action === "draw"`), all other areas are removed. Removal sets `suppressDelete`, so it doesn't fire "cleared".
- After drawing, the tool switches back to `select` and the new area is selected. This runs in a `setTimeout(0)`, because Terra Draw is still handling its own event.
- **Edits** (`finish` with any other action on the current feature) fire `onAreaSelected` again with the same `selectionId`.
- **Delete** (`change` event of type `delete` for the current feature) fires `onAreaCleared`.
- `selectionId` comes from a counter: `area-001`, `area-002`, … Terra Draw's own UUIDs stay internal.
- **Basemap switch**: `detach()` saves the area features (properties stripped to `{ mode }`) and `attach()` adds them back with the same ids.
- `setArea()` (used for `initialArea`) tries rectangle mode for axis-aligned rectangles, else polygon. It returns `false` if Terra Draw rejects the geometry.

### Export (`getArea` → `geo.normalizeRing`)
1. Round to 6 decimals and clamp latitude to ±90.
2. Close the ring.
3. Shift the whole ring by a multiple of 360° so its centre is within ±180.
4. Make it counter-clockwise (RFC 7946).
5. Compute `bbox`. If the ring goes past ±180, set `crossesAntimeridian = true` and use a wrapped bbox with `west > east` (RFC 7946 §5.2).
6. Compute `areaKm2` with the spherical ring-area formula.

### Antimeridian
- **Mercator**: MapLibre's `unproject` already returns continuous longitudes across world copies (e.g. 196°).
- **Globe**: MapLibre returns wrapped longitudes. `ContinuousLngAdapter` (a subclass of the Terra Draw adapter) shifts each longitude to within ±180° of the view centre, so a shape drawn across 180° stays in one piece.
- The exported ring therefore stays **continuous** (values like −197.9 can appear). `splitAtAntimeridian()` in `geo.ts` cuts it into a MultiPolygon within ±180 for consumers that need that.
- Terra Draw's `addFeatures` validation rejects longitudes outside ±180. So an `initialArea` that crosses 180° in continuous form can't be loaded (a warning is logged). Drawing interactively works.

## 8. DataRenderer

- Layer and source ids: `mw-data-<index>-<id|type>-<suffix>`. The selection uses `mw-sel-*`. Host styles must not use these prefixes.
- **Order**: data goes below the first basemap label layer if there is one, otherwise below the selection layer. The selection is always on top.
- `setData()` removes all previous data layers and rebuilds them. Nothing is diffed; fine for the current data sizes.
- **geojson**: three layers (fill / line / circle) filtered by geometry type. Colour = `properties.color`, or blue if missing.
- **raster**: raster source. `bounds` limits which tiles are **requested**; it does not cut tiles at the box edge. Antimeridian bounds get +360 on east.
- **image**: image source stretched over the four corners. The image must be in Web Mercator. EPSG:4326 images drift in latitude over large areas.
- **field**: see §9. Fill layer with `fill-antialias: false` (otherwise thin seams show between triangles), plus an optional edge layer (`showMesh`).
- **Popups**: click on geojson or field features in the `select` tool → table of properties (except `color`). They are off while a drawing tool is active.

## 9. Triangle mesh (`mesh.ts`)

Used for `field` data. Goal: fill the selected polygon **exactly**, with small triangles only where the border is.

**Algorithm (`triangulateArea`)**:
1. Project the ring to Web Mercator: `x = lng`, `y = mercator(lat)` in degree units, latitude clamped to ±85.05°. MapLibre draws polygon edges straight in this space, so the mesh border matches the drawn selection border even for very large areas.
2. Split the bounding box into square base cells, `baseCells` (default 16) along the longer side.
3. For each cell (quadtree recursion), find the polygon edges that touch it (Liang–Barsky segment/rectangle test). Only the parent cell's edges are checked.
   - **No edge touches it** → it is entirely inside or outside. Test the centre (point in polygon); if inside, emit 2 triangles. The diagonal alternates in a checkerboard pattern.
   - **An edge touches it and level < `borderRefinement`** (default 3) → split into 4 and recurse.
   - **At the finest level** → clip the polygon to the cell (Sutherland–Hodgman; exact because the cell is convex) and triangulate the result with `earcut`. Slivers with near-zero area are dropped.
4. Convert back to lng/lat. Each triangle has `ring`, `centroid` and `level`.

**Properties**:
- The triangles' total area equals the polygon's to about 1e-15 relative error. Checked on concave, star-shaped and antimeridian-crossing polygons.
- Cells of different levels meet with **hanging nodes**: a triangle corner sits on a neighbour's edge without being shared. That's fine for flat per-triangle colour. It must be fixed (conforming mesh) before any smooth shading or FEM-style use.
- Cost: defaults ~3,000 triangles in ~3 ms; 16/5 ~10,000 in ~10 ms; 40/6 ~52,000 in ~40 ms.

**Values (`idwValue`)**:
- Inverse distance weighting, power 2, over **all** samples, evaluated at each triangle centroid.
- Distance in degrees with longitude scaled by `cos(lat)`. The longitude difference is wrapped, so samples on either side of 180° work.
- Cost grows with triangles × samples. Thousands of samples combined with a fine mesh can get slow. If so, use a spatial index or k-nearest neighbours.
- IDW makes "bullseye" spots around sparse samples. For regular grids, bilinear interpolation from the grid would be better (not implemented).

**Colours**: a MapLibre `interpolate` expression on the value property. Colour stops are spread evenly between `min` and `max`. Default `min`/`max` = sample range; default colours = 5-step blue–white–red.

## 10. Styling / UI

- All CSS is scoped under `.mw-root`, plus `.mw-popup` for popups. Accent colour `#ff6b2c`.
- The selection fill is very light (6 % while drawing, 5 % when selected), so it doesn't tint field colours.
- Toolbar on the left; basemap and projection panel at top left; status line at the bottom (area id, size, hint for the current tool); loading badge at the top.
- Below 560 px width the panel and status line move so they don't overlap.

## 11. Manual test checklist

Run `npm run dev`, then in the demo:

1. The map loads (no "Worker failed to load" in the console); the initial rectangle over NRW is visible.
2. Draw a rectangle, a polygon (also a concave one) and a freehand shape → each fires `onAreaSelected`, the old area disappears, and data loads.
3. In Pan & edit: drag a corner or the whole area → the event fires again with the same `selectionId`.
4. Trash button → `onAreaCleared`, data disappears.
5. Switch basemap (Streets → Blue Marble) → the area and data stay.
6. Globe ↔ Flat; draw across 180° in both → `crossesAntimeridian: true`, `bbox` west > east.
7. Field data: zoom into the border and check that the triangles end on the orange line. Try the sliders.
8. MODIS raster and stations datasets load; clicking a feature opens a popup.
9. `npm run build` and `npx vite preview`: the map loads (worker asset served from `/assets/`).

## 12. Known limitations / ideas

- The whole widget ships as one ~1.5 MB JS chunk (mostly MapLibre). It could be lazy-loaded by the host.
- Only one selection at a time. Multiple selections would need `onAreaSelected` to handle a list.
- An `initialArea` crossing the antimeridian can't be loaded (Terra Draw validation, §7).
- Mesh: hanging nodes and IDW over all samples (§9).
- No automated tests. `geo.ts` and `mesh.ts` are pure functions and the easiest place to start (e.g. with Vitest).
- Raster tiles stick out past `bounds`. Exact clipping would need a mask layer.
