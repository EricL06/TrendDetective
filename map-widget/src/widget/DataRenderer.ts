import {
  Popup,
  type ExpressionSpecification,
  type LayerSpecification,
  type Map as MapLibreMap,
  type MapLayerMouseEvent,
  type SourceSpecification,
} from "maplibre-gl";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { idwValue, triangulateArea } from "./mesh";
import type { FieldMapData, MapData } from "./types";

/** Prefix of all MapLibre sources/layers created for result data. */
export const DATA_LAYER_PREFIX = "mw-data";

const DEFAULT_COLOR = "#2563eb";
const color: ExpressionSpecification = ["to-color", ["get", "color"], DEFAULT_COLOR];
const isPolygon: ExpressionSpecification = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const isLine: ExpressionSpecification = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const isPoint: ExpressionSpecification = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];

export interface DataRendererOptions {
  /** Layer id to insert data below (e.g. basemap labels or the selection). */
  beforeLayerId: () => string | undefined;
  /** Return false to suppress feature popups (e.g. while a drawing tool is active). */
  popupsEnabled: () => boolean;
  /** Area used by `field` data that does not bring its own. */
  currentArea: () => Feature<Polygon> | null;
}

const DIVERGING = ["#2166ac", "#67a9cf", "#f7f7f7", "#ef8a62", "#b2182b"];

/**
 * Renders Data Loader results (GeoJSON vectors, triangle-meshed fields, XYZ raster tiles, single images) as MapLibre
 * sources/layers. Keeps the current data so it can be re-applied after a basemap switch.
 */
export class DataRenderer {
  private readonly map: MapLibreMap;
  private readonly opts: DataRendererOptions;
  private data: MapData[] = [];
  private sourceIds: string[] = [];
  private layerIds: string[] = [];
  private interactiveLayerIds: string[] = [];
  private readonly popup = new Popup({ closeButton: true, maxWidth: "320px", className: "mw-popup" });

  private ready = false;

  constructor(map: MapLibreMap, opts: DataRendererOptions) {
    this.map = map;
    this.opts = opts;
    map.on("click", this.handleClick);
    map.on("mousemove", this.handleMouseMove);
  }

  setData(data: MapData[]): void {
    this.data = data;
    this.render();
  }

  /** Re-adds layers after the style was replaced. */
  reapply(): void {
    this.ready = true;
    this.sourceIds = [];
    this.layerIds = [];
    this.interactiveLayerIds = [];
    this.render();
  }

  /** Call before the style is replaced; layers vanish with it. */
  suspend(): void {
    this.ready = false;
  }

  private isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    this.map.off("click", this.handleClick);
    this.map.off("mousemove", this.handleMouseMove);
    this.popup.remove();
  }

  private render(): void {
    // Not ready yet: MapWidget calls reapply() on every style load.
    if (!this.isReady()) return;
    this.clearLayers();
    this.popup.remove();
    const before = this.opts.beforeLayerId();
    this.data.forEach((item, index) => this.addItem(item, index, before));
  }

  private clearLayers(): void {
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of this.sourceIds) if (this.map.getSource(id)) this.map.removeSource(id);
    this.sourceIds = [];
    this.layerIds = [];
    this.interactiveLayerIds = [];
  }

  private addSource(id: string, spec: SourceSpecification): void {
    this.map.addSource(id, spec);
    this.sourceIds.push(id);
  }

  private addLayer(layer: LayerSpecification, before: string | undefined, interactive = false): void {
    this.map.addLayer(layer, before && this.map.getLayer(before) ? before : undefined);
    this.layerIds.push(layer.id);
    if (interactive) this.interactiveLayerIds.push(layer.id);
  }

  private addItem(item: MapData, index: number, before: string | undefined): void {
    const key = `${DATA_LAYER_PREFIX}-${index}-${sanitize(item.id ?? item.type)}`;
    const opacity = item.opacity ?? 1;

    switch (item.type) {
      case "geojson": {
        this.addSource(key, { type: "geojson", data: item.data });
        this.addLayer(
          {
            id: `${key}-fill`,
            type: "fill",
            source: key,
            filter: isPolygon,
            paint: { "fill-color": color, "fill-opacity": 0.45 * opacity },
          },
          before,
          true,
        );
        this.addLayer(
          {
            id: `${key}-line`,
            type: "line",
            source: key,
            filter: ["any", isPolygon, isLine],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": color,
              "line-opacity": opacity,
              "line-width": ["case", isLine, 2.5, 1],
            },
          },
          before,
          true,
        );
        this.addLayer(
          {
            id: `${key}-point`,
            type: "circle",
            source: key,
            filter: isPoint,
            paint: {
              "circle-color": color,
              "circle-opacity": 0.9 * opacity,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6, 12, 9],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
            },
          },
          before,
          true,
        );
        break;
      }
      case "raster": {
        this.addSource(key, {
          type: "raster",
          tiles: item.tiles,
          tileSize: item.tileSize ?? 256,
          ...(item.bounds ? { bounds: rasterBounds(item.bounds) } : {}),
          ...(item.minzoom != null ? { minzoom: item.minzoom } : {}),
          ...(item.maxzoom != null ? { maxzoom: item.maxzoom } : {}),
          ...(item.attribution ? { attribution: item.attribution } : {}),
        });
        this.addLayer(
          { id: `${key}-raster`, type: "raster", source: key, paint: { "raster-opacity": item.opacity ?? 0.8 } },
          before,
        );
        break;
      }
      case "field": {
        const mesh = buildFieldMesh(item, this.opts.currentArea());
        if (!mesh) break;
        this.addSource(key, { type: "geojson", data: mesh.collection });
        this.addLayer(
          {
            id: `${key}-mesh`,
            type: "fill",
            source: key,
            // No antialiasing: avoids hairline seams between adjacent triangles.
            paint: { "fill-color": mesh.colorExpression, "fill-opacity": item.opacity ?? 0.75, "fill-antialias": false },
          },
          before,
          true,
        );
        if (item.showMesh) {
          this.addLayer(
            {
              id: `${key}-edges`,
              type: "line",
              source: key,
              paint: { "line-color": "#1f2933", "line-opacity": 0.35, "line-width": 0.6 },
            },
            before,
          );
        }
        break;
      }
      case "image": {
        let [w, s, e, n] = item.bounds;
        if (w > e) e += 360;
        this.addSource(key, {
          type: "image",
          url: item.url,
          coordinates: [
            [w, n],
            [e, n],
            [e, s],
            [w, s],
          ],
        });
        this.addLayer(
          { id: `${key}-image`, type: "raster", source: key, paint: { "raster-opacity": item.opacity ?? 0.8 } },
          before,
        );
        break;
      }
    }
  }

  private handleMouseMove = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0) return;
    const hit = this.map.queryRenderedFeatures(e.point, { layers: this.interactiveLayerIds }).length > 0;
    const canvas = this.map.getCanvas();
    // Only touch the cursor when we own it; Terra Draw manages it while drawing.
    if (hit && this.opts.popupsEnabled()) canvas.dataset.mwHover = "1";
    else delete canvas.dataset.mwHover;
  };

  private handleClick = (e: MapLayerMouseEvent) => {
    if (this.interactiveLayerIds.length === 0 || !this.opts.popupsEnabled()) return;
    const [feature] = this.map.queryRenderedFeatures(e.point, { layers: this.interactiveLayerIds });
    if (!feature) return;
    this.popup.setLngLat(e.lngLat).setDOMContent(propertiesTable(feature.properties)).addTo(this.map);
  };
}

/** Triangulates the field's area and assigns each triangle an interpolated value. */
function buildFieldMesh(
  item: FieldMapData,
  fallbackArea: Feature<Polygon> | null,
): { collection: FeatureCollection; colorExpression: ExpressionSpecification } | null {
  const area = item.area ?? fallbackArea;
  if (!area) {
    console.warn("[MapWidget] field data needs an area (none given and no selection).");
    return null;
  }
  const prop = item.valueProperty ?? "value";
  const samples = item.samples.features.flatMap((f) => {
    const v = Number(f.properties?.[prop]);
    const [lng, lat] = f.geometry.coordinates;
    return Number.isFinite(v) ? [{ lng, lat, value: v }] : [];
  });
  if (samples.length === 0) return null;

  const triangles = triangulateArea(area.geometry.coordinates[0], item.mesh);
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: triangles.map((t) => ({
      type: "Feature",
      properties: { [prop]: round3(idwValue(t.centroid, samples) ?? 0), mesh_level: t.level },
      geometry: { type: "Polygon", coordinates: [t.ring] },
    })),
  };

  const colors = item.colorScale?.colors?.length ? item.colorScale.colors : DIVERGING;
  const min = item.colorScale?.min ?? Math.min(...samples.map((s) => s.value));
  let max = item.colorScale?.max ?? Math.max(...samples.map((s) => s.value));
  if (!(max > min)) max = min + 1;
  const stops = colors.flatMap((c, i) => [min + ((max - min) * i) / Math.max(1, colors.length - 1), c]);
  const colorExpression = (
    colors.length === 1 ? colors[0] : ["interpolate", ["linear"], ["to-number", ["get", prop]], ...stops]
  ) as ExpressionSpecification;
  return { collection, colorExpression };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** MapLibre tile bounds must have west < east; antimeridian boxes are unwrapped. */
function rasterBounds([w, s, e, n]: [number, number, number, number]): [number, number, number, number] {
  return w > e ? [w, s, e + 360, n] : [w, s, e, n];
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function propertiesTable(props: Record<string, unknown>): HTMLElement {
  const table = document.createElement("table");
  table.className = "mw-popup-table";
  const entries = Object.entries(props).filter(([k]) => k !== "color");
  if (entries.length === 0) {
    const row = table.insertRow();
    row.insertCell().textContent = "No attributes";
  }
  for (const [k, v] of entries) {
    const row = table.insertRow();
    const th = document.createElement("th");
    th.textContent = k;
    row.appendChild(th);
    row.insertCell().textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return table;
}
