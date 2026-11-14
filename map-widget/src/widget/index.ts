// Public entry point of the Interactive Map Widget.
export { MapWidget } from "./MapWidget";
export { BASEMAPS } from "./basemaps";
export { splitAtAntimeridian, wrapLng, geodesicAreaKm2 } from "./geo";
export { triangulateArea, idwValue, type MeshOptions, type MeshTriangle } from "./mesh";
export type {
  AreaFeature,
  AreaProperties,
  BasemapId,
  BBox,
  DrawTool,
  FieldMapData,
  GeoJsonMapData,
  ImageMapData,
  MapData,
  MapWidgetHandle,
  MapWidgetProps,
  ProjectionType,
  RasterMapData,
  SelectionShape,
} from "./types";
