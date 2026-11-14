import earcut from "earcut";
import type { Position } from "geojson";

/**
 * Triangle mesh of a polygon with local refinement along its border.
 *
 * Method (quadtree + exact clipping):
 * 1. Project the ring to Web Mercator (x = lng, y = mercator latitude in degrees). MapLibre draws
 *    polygon edges as straight lines in this space, so meshing here makes the mesh border coincide
 *    with the drawn selection border at any size.
 * 2. Cover the bounding box with square base cells.
 * 3. Cells cut by the border are split into 4, recursively, up to `borderRefinement` levels.
 *    Cells entirely inside become 2 triangles; cells entirely outside are dropped.
 * 4. Border cells at the finest level are clipped exactly against the polygon and triangulated
 *    (earcut). The union of all triangles therefore equals the polygon.
 *
 * Neighbouring cells of different levels share edges with hanging nodes. That is fine for flat
 * per-triangle colouring (no shading interpolation across triangles).
 */
export interface MeshOptions {
  /** Number of base cells along the longer side of the bounding box. Default 16. */
  baseCells?: number;
  /** Extra subdivision levels for cells on the border (each level halves the cell size). Default 3. */
  borderRefinement?: number;
}

export interface MeshTriangle {
  /** Closed ring: 3 corners + closing point, [lng, lat]. */
  ring: Position[];
  /** Centroid [lng, lat], used to sample values. */
  centroid: Position;
  /** Refinement level of the cell the triangle came from (0 = base cell). */
  level: number;
}

const MAX_LAT = 85.051129; // Web Mercator limit
const DEG = 180 / Math.PI;

const mercY = (lat: number) => {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) / DEG;
  return DEG * Math.log(Math.tan(Math.PI / 4 + phi / 2));
};
const invMercY = (y: number) => DEG * (2 * Math.atan(Math.exp(y / DEG)) - Math.PI / 2);

type Pt = [number, number];
type Edge = [Pt, Pt];
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function triangulateArea(ring: Position[], opts: MeshOptions = {}): MeshTriangle[] {
  const baseCells = Math.max(1, Math.round(opts.baseCells ?? 16));
  const maxLevel = Math.max(0, Math.round(opts.borderRefinement ?? 3));

  const poly: Pt[] = ring.map(([lng, lat]) => [lng, mercY(lat)]);
  if (poly.length < 4) return [];
  const edges: Edge[] = [];
  for (let i = 0; i < poly.length - 1; i++) edges.push([poly[i], poly[i + 1]]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const size = Math.max(maxX - minX, maxY - minY) / baseCells;
  if (!(size > 0)) return [];

  const out: MeshTriangle[] = [];
  const emit = (pts: Pt[], level: number) => {
    const lngLat = pts.map(([x, y]) => [x, invMercY(y)]);
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    out.push({ ring: [...lngLat, lngLat[0]], centroid: [cx, invMercY(cy)], level });
  };

  const visit = (r: Rect, level: number, candidates: Edge[]) => {
    const cut = candidates.filter((e) => segmentIntersectsRect(e, r));
    if (cut.length === 0) {
      // Entirely inside or outside: decide by the centre.
      if (!pointInPolygon([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], poly)) return;
      // Alternate the diagonal for a less directional pattern.
      const flip = (Math.round(r.x0 / size) + Math.round(r.y0 / size)) % 2 === 0;
      const a: Pt = [r.x0, r.y0];
      const b: Pt = [r.x1, r.y0];
      const c: Pt = [r.x1, r.y1];
      const d: Pt = [r.x0, r.y1];
      if (flip) {
        emit([a, b, c], level);
        emit([a, c, d], level);
      } else {
        emit([a, b, d], level);
        emit([b, c, d], level);
      }
      return;
    }
    if (level < maxLevel) {
      const mx = (r.x0 + r.x1) / 2;
      const my = (r.y0 + r.y1) / 2;
      visit({ x0: r.x0, y0: r.y0, x1: mx, y1: my }, level + 1, cut);
      visit({ x0: mx, y0: r.y0, x1: r.x1, y1: my }, level + 1, cut);
      visit({ x0: r.x0, y0: my, x1: mx, y1: r.y1 }, level + 1, cut);
      visit({ x0: mx, y0: my, x1: r.x1, y1: r.y1 }, level + 1, cut);
      return;
    }
    // Finest border cell: exact polygon ∩ cell, then triangulate.
    const clipped = clipToRect(poly, r);
    if (clipped.length < 3) return;
    const flat = clipped.flat();
    const idx = earcut(flat);
    for (let i = 0; i < idx.length; i += 3) {
      const tri: Pt[] = [clipped[idx[i]], clipped[idx[i + 1]], clipped[idx[i + 2]]];
      if (Math.abs(area2(tri)) > size * size * 1e-9) emit(tri, level);
    }
  };

  for (let i = 0; i * size < maxX - minX || i === 0; i++) {
    for (let j = 0; j * size < maxY - minY || j === 0; j++) {
      const x0 = minX + i * size;
      const y0 = minY + j * size;
      visit({ x0, y0, x1: x0 + size, y1: y0 + size }, 0, edges);
    }
  }
  return out;
}

function area2([a, b, c]: Pt[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
}

function pointInPolygon([x, y]: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Liang–Barsky: does the segment touch the (closed) rectangle? */
function segmentIntersectsRect([[ax, ay], [bx, by]]: Edge, r: Rect): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks: [number, number][] = [
    [-dx, ax - r.x0],
    [dx, r.x1 - ax],
    [-dy, ay - r.y0],
    [dy, r.y1 - ay],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Sutherland–Hodgman: polygon ∩ axis-aligned rectangle (the rectangle is convex, so this is exact). */
function clipToRect(ring: Pt[], r: Rect): Pt[] {
  let pts = ring.slice(0, -1); // open ring
  const planes: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= r.x0, (a, b) => atX(a, b, r.x0)],
    [(p) => p[0] <= r.x1, (a, b) => atX(a, b, r.x1)],
    [(p) => p[1] >= r.y0, (a, b) => atY(a, b, r.y0)],
    [(p) => p[1] <= r.y1, (a, b) => atY(a, b, r.y1)],
  ];
  for (const [inside, cross] of planes) {
    const next: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const aIn = inside(a);
      const bIn = inside(b);
      if (aIn) next.push(a);
      if (aIn !== bIn) next.push(cross(a, b));
    }
    pts = next;
    if (pts.length === 0) break;
  }
  return pts;
}

const atX = (a: Pt, b: Pt, x: number): Pt => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
const atY = (a: Pt, b: Pt, y: number): Pt => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y];

/**
 * Inverse-distance-weighted value at `p` from point samples (power 2).
 * Longitude differences are wrapped, so samples on either side of ±180° work.
 */
export function idwValue(p: Position, samples: { lng: number; lat: number; value: number }[]): number | null {
  if (samples.length === 0) return null;
  const cosLat = Math.cos((p[1] * Math.PI) / 180);
  let num = 0;
  let den = 0;
  for (const s of samples) {
    let dLng = s.lng - p[0];
    dLng -= 360 * Math.round(dLng / 360);
    const dx = dLng * cosLat;
    const dy = s.lat - p[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-18) return s.value;
    const w = 1 / d2;
    num += w * s.value;
    den += w;
  }
  return num / den;
}
