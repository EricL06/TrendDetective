// TrendDetective · Global Explorer – main application.
import * as maplibregl from "/static/vendor/maplibre/maplibre-gl.mjs";
import { renderGrid, drawColorbar, niceCeil, MERC_MAX_LAT, cssColor } from "./colormap.js";
import * as charts from "./charts.js";

maplibregl.setWorkerUrl("/static/vendor/maplibre/maplibre-gl-worker.mjs");

const API = "/api/global/";
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
const MAX_REGIONS = COLORS.length;
const BASEMAP = "https://tiles.openfreemap.org/styles/dark";
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1420" } }],
};

const LAYER_UI = [
  { id: "trend", short: "Trend", hint: "Lineare Erwärmungsrate je Gitterzelle (°C pro Dekade). Punkte = Trend nicht signifikant (p ≥ 0,05, autokorrelationskorrigiert)." },
  { id: "anomaly", short: "Anomalie", hint: "Mittlere Abweichung im gewählten Zeitraum gegenüber der Referenzperiode." },
  { id: "year", short: "Einzeljahr ▶", hint: "Anomalie jedes einzelnen Jahres – mit ▶ als Animation über alle Jahre." },
  { id: "acceleration", short: "Beschleunigung", hint: "Trend der zweiten minus Trend der ersten Hälfte des Zeitraums. Rot = Erwärmung wird schneller. Punkte = Unterschied nicht signifikant." },
  { id: "snr", short: "Signal/Rauschen", hint: "Lineare Änderung im Zeitraum geteilt durch die natürliche Jahr-zu-Jahr-Schwankung. Ab ≈ 2 hebt sich der Trend deutlich vom Rauschen ab." },
  { id: "gradient", short: "Räuml. Gradient", hint: "Wie stark sich der Erwärmungstrend zwischen Nachbarregionen ändert (°C/Dekade pro 1000 km) – zeigt Grenzen wie Meereis- oder Küstenkanten." },
];

const PERIOD_PRESETS = [
  { label: "1880–heute", start: 1880 },
  { label: "1951–heute", start: 1951 },
  { label: "1975–heute", start: 1975 },
  { label: "Letzte 30 J.", recent: 30 },
];

const DEFAULT_REGIONS = [{ preset: "mediterranean" }, { preset: "antarctica" }, { preset: "south_pacific" }, { preset: "nrw" }];

// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = {
  meta: null,
  kind: "trend",
  start: 1975,
  end: null,
  season: "annual",
  baseline: "1951-1980",
  sig: true,
  smooth: true,
  globe: true,
  opacity: 0.82,
  scaleMax: null,
  year: null,
  regions: [], // {uid, spec, name, color}
  tab: "series",
  layer: null, // last layer response
  grid: null, // Float32Array of the displayed grid
  sigMask: null,
  regionData: null,
  frames: null, // {key, years, data: Int16Array}
  playing: false,
};
let map;
let overlayCanvas;
let uidCounter = 0;
const presetById = {};

// ---------------------------------------------------------------------------
// Utilities

async function getJSON(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const res = await fetch(API + path + (qs ? "?" + qs : ""));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

let loadingCount = 0;
function loading(on, text = "Berechne …") {
  loadingCount += on ? 1 : -1;
  $("loading").hidden = loadingCount <= 0;
  if (on) $("loading-text").textContent = text;
}

let toastTimer;
function toast(msg, kind = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "info" ? " info" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function lastFullYear() {
  const [y, m] = state.meta.dataset.last;
  return m === 12 ? y : y - 1;
}

function commonParams() {
  return { season: state.season, baseline: state.baseline };
}

function periodParams() {
  return { start: state.start, end: state.end, ...commonParams() };
}

function baselineLabel() {
  const b = state.meta.baselines.find((x) => x.id === state.baseline);
  return b ? b.label : "1951–1980";
}

function seasonLabel() {
  return state.meta.seasons.find((s) => s.id === state.season)?.label || state.season;
}

// ---------------------------------------------------------------------------
// URL hash (shareable state)

function writeHash() {
  const p = new URLSearchParams();
  p.set("k", state.kind);
  p.set("p", `${state.start}-${state.end}`);
  p.set("s", state.season);
  p.set("b", state.baseline);
  if (state.kind === "year" && state.year) p.set("y", state.year);
  p.set("r", state.regions.map((r) => (r.spec.preset ? r.spec.preset : JSON.stringify(r.spec))).join("|"));
  if (state.tab !== "series") p.set("t", state.tab);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.toString()) return false;
  if (LAYER_UI.some((l) => l.id === p.get("k"))) state.kind = p.get("k");
  const per = (p.get("p") || "").split("-").map(Number);
  if (per.length === 2 && per.every(Number.isFinite)) [state.start, state.end] = per;
  if (p.get("s")) state.season = p.get("s");
  if (p.get("b")) state.baseline = p.get("b");
  if (p.get("y")) state.year = Number(p.get("y"));
  if (p.get("t")) state.tab = p.get("t");
  const r = p.get("r");
  if (r == null) {
    for (const spec of DEFAULT_REGIONS) addRegion(spec, { silent: true });
  } else {
    state.regions = [];
    for (const part of r.split("|").filter(Boolean)) {
      try {
        const spec = part.startsWith("{") ? JSON.parse(part) : { preset: part };
        addRegion(spec, { silent: true });
      } catch { /* ignore broken entries */ }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Controls

function buildControls() {
  const seg = $("layer-seg");
  seg.innerHTML = "";
  for (const l of LAYER_UI) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.dataset.kind = l.id;
    b.textContent = l.short;
    b.addEventListener("click", () => setKind(l.id));
    seg.appendChild(b);
  }
  const season = $("season");
  season.innerHTML = "";
  const groupMain = document.createElement("optgroup");
  groupMain.label = "Jahr & Jahreszeiten";
  const groupMonths = document.createElement("optgroup");
  groupMonths.label = "Einzelne Monate";
  for (const s of state.meta.seasons) {
    const o = new Option(s.label, s.id);
    (s.id.startsWith("m") ? groupMonths : groupMain).appendChild(o);
  }
  season.append(groupMain, groupMonths);
  const baseline = $("baseline");
  baseline.innerHTML = "";
  for (const b of state.meta.baselines) {
    const label = b.id === "1880-1900" ? `${b.label} (≈ vorindustriell)` : b.id === "1951-1980" ? `${b.label} (NASA-Standard)` : b.id === "1991-2020" ? `${b.label} (WMO-Normal)` : b.label;
    baseline.appendChild(new Option(label, b.id));
  }
  const pp = $("period-presets");
  pp.innerHTML = "";
  for (const p of PERIOD_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = p.label;
    b.addEventListener("click", () => {
      const end = lastFullYear();
      setPeriod(p.recent ? end - p.recent + 1 : p.start, end);
    });
    pp.appendChild(b);
  }
  const first = state.meta.dataset.first[0];
  for (const id of ["start-year", "end-year"]) {
    $(id).min = first;
    $(id).max = state.meta.dataset.last[0];
  }

  $("start-year").addEventListener("change", (e) => setPeriod(Number(e.target.value), state.end));
  $("end-year").addEventListener("change", (e) => setPeriod(state.start, Number(e.target.value)));
  season.addEventListener("change", (e) => { state.season = e.target.value; state.frames = null; refreshAll(); });
  baseline.addEventListener("change", (e) => { state.baseline = e.target.value; state.frames = null; refreshAll(); });
  $("opt-sig").addEventListener("change", (e) => { state.sig = e.target.checked; redrawOverlay(); });
  $("opt-smooth").addEventListener("change", (e) => { state.smooth = e.target.checked; redrawOverlay(); });
  $("opt-globe").addEventListener("change", (e) => { state.globe = e.target.checked; applyProjection(); });
  $("opacity").addEventListener("input", (e) => {
    state.opacity = Number(e.target.value);
    if (map?.getLayer("overlay")) map.setPaintProperty("overlay", "raster-opacity", state.opacity);
    if (map?.getLayer("caps")) map.setPaintProperty("caps", "fill-opacity", state.opacity);
  });
  $("scale-max").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    state.scaleMax = v > 0 ? v : null;
    redrawOverlay();
  });
  $("btn-collapse-controls").addEventListener("click", () => {
    const c = $("controls");
    c.classList.toggle("collapsed");
    $("btn-collapse-controls").textContent = c.classList.contains("collapsed") ? "+" : "–";
  });
  $("btn-toggle-analysis").addEventListener("click", () => {
    const l = document.querySelector(".layout");
    l.classList.toggle("analysis-collapsed");
    $("btn-toggle-analysis").textContent = l.classList.contains("analysis-collapsed") ? "▴" : "▾";
    setTimeout(() => { map?.resize(); renderAnalysis(); }, 60);
  });
  for (const b of $("tabs").querySelectorAll("button")) {
    b.addEventListener("click", () => { state.tab = b.dataset.tab; syncControls(); renderAnalysis(); writeHash(); });
  }
  $("btn-play").addEventListener("click", togglePlay);
  $("year-slider").addEventListener("input", (e) => { state.year = Number(e.target.value); showYear(); });
  $("btn-about").addEventListener("click", () => $("about").showModal());
  $("btn-draw").addEventListener("click", () => setDrawMode(!drawMode));
  $("btn-csv").addEventListener("click", downloadCsv);
  $("btn-link").addEventListener("click", async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); toast("Link mit allen Einstellungen kopiert.", "info"); }
    catch { toast("Kopieren nicht möglich – bitte die Adresszeile kopieren.", "info"); }
  });
  setupResize();
  if (window.matchMedia("(max-width: 760px)").matches) {
    $("controls").classList.add("collapsed");
    $("btn-collapse-controls").textContent = "+";
  }
  buildPresets();
  buildSearch();
  buildAbout();
}

function syncControls() {
  for (const b of $("layer-seg").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.kind === state.kind));
  $("layer-hint").textContent = LAYER_UI.find((l) => l.id === state.kind)?.hint || "";
  $("start-year").value = state.start;
  $("end-year").value = state.end;
  $("season").value = state.season;
  $("baseline").value = state.baseline;
  $("timeline").hidden = state.kind !== "year";
  const end = lastFullYear();
  for (const [i, b] of [...$("period-presets").children].entries()) {
    const p = PERIOD_PRESETS[i];
    const start = p.recent ? end - p.recent + 1 : p.start;
    b.classList.toggle("active", state.start === start && state.end === end);
  }
  for (const b of $("tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  // the period inputs are irrelevant for the single-year view
  document.querySelectorAll("#start-year,#end-year").forEach((e) => (e.disabled = false));
}

function setKind(kind) {
  if (state.playing) togglePlay();
  state.kind = kind;
  syncControls();
  refreshLayer();
  writeHash();
}

function setPeriod(start, end) {
  const first = state.meta.dataset.first[0];
  const last = state.meta.dataset.last[0];
  start = Math.max(first, Math.min(last, Math.round(start || first)));
  end = Math.max(first, Math.min(last, Math.round(end || last)));
  if (end - start < 9) {
    toast("Der Zeitraum braucht mindestens 10 Jahre – ich habe ihn erweitert.");
    if (start + 9 <= last) end = start + 9; else start = end - 9;
  }
  state.start = start;
  state.end = end;
  syncControls();
  refreshAll();
}

// ---------------------------------------------------------------------------
// Map

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: BASEMAP,
    center: [15, 32],
    zoom: initialZoom(),
    minZoom: 0.6,
    maxZoom: 7,
    attributionControl: { compact: true, customAttribution: "Daten: NASA GISTEMP v4" },
    renderWorldCopies: true,
    boxZoom: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  let fellBack = false;
  map.on("error", (e) => {
    console.warn("map error:", e?.error?.message || e);
    // If the basemap cannot be loaded (offline), continue with a plain background.
    if (!fellBack && !map.isStyleLoaded() && String(e?.error?.message || "").match(/style|fetch|Failed/i)) {
      fellBack = true;
      map.setStyle(FALLBACK_STYLE);
    }
  });
  if (location.search.includes("debug")) window.__map = map; // for automated UI checks
  overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = 1536;
  overlayCanvas.height = 1536;
  map.on("style.load", () => {
    applyProjection();
    try { tuneBasemap(); } catch { /* fallback style */ }
    addOverlayLayers();
    redrawOverlay();
    drawRegionsOnMap();
  });
  map.on("mousemove", onMapHover);
  map.on("mouseout", () => ($("hover-card").hidden = true));
  map.on("click", onMapClick);
  setupDrawing();
}

function initialZoom() {
  // Fit the globe into the map area (globe diameter ≈ 512·2^z / π px).
  const el = $("map");
  const size = Math.min(el.clientWidth - 40, el.clientHeight * 0.94);
  return Math.max(0.2, Math.log2((size * Math.PI) / 512));
}

function applyProjection() {
  if (!map) return;
  try { map.setProjection({ type: state.globe ? "globe" : "mercator" }); } catch { /* style not ready */ }
}

function tuneBasemap() {
  // Keep the basemap quiet: only country names and large cities, light borders.
  for (const l of map.getStyle()?.layers || []) {
    if (l.type === "symbol") {
      const keep = /place_country_major|place_country_minor/.test(l.id);
      if (!keep) { map.setLayoutProperty(l.id, "visibility", "none"); continue; }
      map.setLayoutProperty(l.id, "text-size", ["interpolate", ["linear"], ["zoom"], 1, 9, 4, 12]);
      map.setLayoutProperty(l.id, "text-transform", "none");
      map.setPaintProperty(l.id, "text-color", "rgba(235,240,247,0.78)");
      map.setPaintProperty(l.id, "text-halo-color", "rgba(5,8,13,0.7)");
      map.setPaintProperty(l.id, "text-halo-width", 1);
    } else if (/^boundary_country/.test(l.id)) {
      map.setPaintProperty(l.id, "line-color", "rgba(10,14,20,0.55)");
    } else if (/^boundary_state/.test(l.id)) {
      map.setLayoutProperty(l.id, "visibility", "none");
    }
  }
}

function firstLabelLayer() {
  // Overlay goes above water/land/roads but below borders and place labels.
  const layers = map.getStyle()?.layers || [];
  const hit = layers.find((l) => /^boundary|admin/.test(l.id)) || layers.find((l) => l.type === "symbol" && !/water_name|road|highway/.test(l.id));
  return hit?.id;
}

function addOverlayLayers() {
  if (map.getSource("overlay")) return;
  map.addSource("overlay", {
    type: "image",
    url: overlayUrl || BLANK_PNG,
    coordinates: OVERLAY_COORDS,
  });
  map.addLayer({
    id: "overlay", type: "raster", source: "overlay",
    paint: { "raster-opacity": state.opacity, "raster-fade-duration": 0, "raster-resampling": "linear" },
  }, firstLabelLayer());
  // Mercator images stop at ±85.05°; caps in the zonal-mean colour close the globe.
  map.addSource("caps", { type: "geojson", data: polarCaps() });
  map.addLayer({
    id: "caps", type: "fill", source: "caps",
    paint: { "fill-color": ["coalesce", ["get", "color"], "#1a2230"], "fill-opacity": state.opacity, "fill-antialias": false },
  }, firstLabelLayer());
  map.addSource("coast", { type: "geojson", data: "/static/vendor/natural-earth/coastline_50m.geojson" });
  map.addLayer({
    id: "coast", type: "line", source: "coast",
    paint: { "line-color": "#0b1018", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 1.4] },
  }, firstLabelLayer());
  map.addSource("regions", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "regions-fill", type: "fill", source: "regions", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.08 } });
  map.addLayer({ id: "regions-halo", type: "line", source: "regions", paint: { "line-color": "#05080d", "line-width": 4, "line-opacity": 0.6 } });
  map.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": ["get", "color"], "line-width": 2 } });
  map.addSource("draw", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "draw-line", type: "line", source: "draw", paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 2] } });
}

// The overlay is an image source fed from an off-screen canvas via blob URLs.
// (A MapLibre canvas source stalls rendering in globe mode, so it is not used.)
const OVERLAY_COORDS = [[-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT]];
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let overlayUrl = null;
let overlayBusy = false;
let overlayQueued = false;

function touchOverlay() {
  if (overlayBusy) { overlayQueued = true; return; }
  overlayBusy = true;
  overlayCanvas.toBlob((blob) => {
    const old = overlayUrl;
    overlayUrl = URL.createObjectURL(blob);
    const src = map?.getSource("overlay");
    if (src) src.updateImage({ url: overlayUrl, coordinates: OVERLAY_COORDS });
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    overlayBusy = false;
    if (overlayQueued) { overlayQueued = false; touchOverlay(); }
  }, "image/png");
}

function polarCaps(colors = {}) {
  const ring = (a, b) => {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 30) pts.push([lon, a]);
    for (let lon = 180; lon >= -180; lon -= 30) pts.push([lon, b]);
    pts.push([-180, a]);
    return pts;
  };
  const cap = (name, a, b) => ({ type: "Feature", properties: { color: colors[name] || null }, geometry: { type: "Polygon", coordinates: [ring(a, b)] } });
  return { type: "FeatureCollection", features: [cap("n", MERC_MAX_LAT - 0.05, 90), cap("s", -90, -MERC_MAX_LAT + 0.05)] };
}

function updateCaps(scale) {
  const src = map?.getSource("caps");
  if (!src || !state.grid) return;
  const g = geom();
  const rowMean = (r) => {
    let s = 0, n = 0;
    for (let c = 0; c < g.nlon; c++) { const v = state.grid[r * g.nlon + c]; if (v === v) { s += v; n++; } }
    return n ? s / n : null;
  };
  const north = rowMean(g.nlat - 1), south = rowMean(0);
  src.setData(polarCaps({
    n: north == null ? null : cssColor(north, scale),
    s: south == null ? null : cssColor(south, scale),
  }));
}

function currentScale() {
  const L = state.layer;
  if (state.kind === "year") {
    const m = state.scaleMax || 4;
    return { kind: "diverging", min: -m, max: m };
  }
  if (!L) return { kind: "diverging", min: -1, max: 1 };
  if (L.kind === "gradient") {
    const m = state.scaleMax || niceCeil(absPercentile(state.grid, 0.97) || 1);
    return { kind: "sequential", min: 0, max: m };
  }
  const auto = niceCeil(absPercentile(state.grid, 0.96) || 1);
  const m = state.scaleMax || auto;
  return { kind: "diverging", min: -m, max: m };
}

function absPercentile(grid, q) {
  if (!grid) return null;
  const vals = [];
  for (const v of grid) if (v === v) vals.push(Math.abs(v));
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
}

function geom() {
  const g = state.meta.dataset.grid;
  return { nlat: g.nlat, nlon: g.nlon, lat0: g.lat0, lon0: g.lon0, dlat: g.lat_step, dlon: g.lon_step };
}

function redrawOverlay() {
  if (!state.grid || !overlayCanvas) return;
  const scale = currentScale();
  const mask = state.sig && state.sigMask ? state.sigMask : null;
  renderGrid(overlayCanvas, state.grid, geom(), scale, { smooth: state.smooth, mask });
  touchOverlay();
  updateCaps(scale);
  updateLegend(scale);
}

function updateLegend(scale) {
  const L = state.layer;
  const unit = state.kind === "year" ? "°C" : L?.unit || "";
  let title;
  if (state.kind === "year") title = `Anomalie ${state.year} (${seasonLabel()}) ggü. ${baselineLabel()}`;
  else title = `${L?.label || ""} · ${seasonLabel()} · ${L?.period?.[0]}–${L?.period?.[1]}`;
  $("legend-title").innerHTML = `${charts.escapeHtml(title)} <span class="unit">${charts.escapeHtml(unit)}</span>`;
  drawColorbar($("legend-bar"), scale);
  const ticks = $("legend-ticks");
  ticks.innerHTML = "";
  const n = 5;
  for (let i = 0; i < n; i++) {
    const v = scale.min + (i / (n - 1)) * (scale.max - scale.min);
    const s = document.createElement("span");
    s.style.left = `${(i / (n - 1)) * 100}%`;
    const digits = Math.abs(scale.max) < 1 ? 2 : 1;
    s.textContent = charts.fmt(v, digits, scale.kind === "diverging");
    if (i === 0) s.style.transform = "none";
    if (i === n - 1) { s.style.transform = "translateX(-100%)"; }
    ticks.appendChild(s);
  }
  const st = $("legend-stats");
  if (state.kind === "year") {
    const gm = globalMean(state.grid);
    st.innerHTML = `<span>Globales Mittel</span><b>${charts.fmt(gm, 2)} °C</b>`;
  } else if (L) {
    const s = L.summary;
    const rows = [[`Flächenmittel`, `${charts.fmt(s.area_mean, 2, L.kind !== "gradient")} ${L.unit}`]];
    if (s.significant_area != null) rows.push(["Signifikante Fläche", `${Math.round(s.significant_area * 100)} %`]);
    rows.push(["Datenabdeckung", `${Math.round((s.coverage || 0) * 100)} %`]);
    st.innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("");
  }
}

function globalMean(grid) {
  const g = geom();
  let s = 0, w = 0;
  for (let r = 0; r < g.nlat; r++) {
    const cw = Math.cos(((g.lat0 + r * g.dlat) * Math.PI) / 180);
    for (let c = 0; c < g.nlon; c++) {
      const v = grid[r * g.nlon + c];
      if (v === v) { s += v * cw; w += cw; }
    }
  }
  return w ? s / w : null;
}

function cellIndex(lng, lat) {
  const g = geom();
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const r = Math.round((lat - g.lat0) / g.dlat);
  const c = ((Math.round((lng - g.lon0) / g.dlon) % g.nlon) + g.nlon) % g.nlon;
  if (r < 0 || r >= g.nlat) return null;
  return { r, c, k: r * g.nlon + c, lat: g.lat0 + r * g.dlat, lon: g.lon0 + c * g.dlon };
}

function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(0)}°${lon >= 0 ? "O" : "W"}`;
}

function onMapHover(e) {
  const card = $("hover-card");
  if (!state.grid || drawStart) { card.hidden = true; return; }
  const cell = cellIndex(e.lngLat.lng, e.lngLat.lat);
  if (!cell) { card.hidden = true; return; }
  const v = state.grid[cell.k];
  const unit = state.kind === "year" ? "°C" : state.layer?.unit || "";
  let extra = "";
  if (state.sigMask && v === v && state.kind !== "anomaly" && state.kind !== "year" && state.kind !== "gradient") {
    extra = state.sigMask[cell.k] ? " · <span class=muted>signifikant</span>" : " · <span class=muted>nicht signifikant</span>";
  }
  card.innerHTML = `<span class="muted">Zelle ${fmtLatLon(cell.lat, cell.lon)}</span><br>`
    + (v === v ? `<b>${charts.fmt(v, 2, state.kind !== "gradient")} ${unit}</b>${extra}` : `<span class="muted">keine Daten</span>`);
  card.hidden = false;
  const W = $("map").clientWidth;
  const x = e.point.x + 14 + card.offsetWidth > W ? e.point.x - card.offsetWidth - 14 : e.point.x + 14;
  card.style.left = `${x}px`;
  card.style.top = `${e.point.y + 12}px`;
}

let popup;
async function onMapClick(e) {
  if (drawMode) return;
  const cell = cellIndex(e.lngLat.lng, e.lngLat.lat);
  if (!cell) return;
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: "280px", closeButton: true })
    .setLngLat([cell.lon, cell.lat])
    .setHTML(`<div class="cell-pop"><h4>Gitterzelle ${fmtLatLon(cell.lat, cell.lon)}</h4><span class="muted">Lade …</span></div>`)
    .addTo(map);
  try {
    const data = await getJSON("cell", { lat: cell.lat, lon: cell.lon, ...periodParams() });
    const r = data.regions[0];
    const s = r.stats;
    const spark = charts.sparkline(data.years, r.values, r.running, { color: "#ef8a62" });
    const html = `<div class="cell-pop"><h4>Gitterzelle ${fmtLatLon(cell.lat, cell.lon)}</h4>`
      + (s.trend != null
        ? `<div class="big">${charts.fmt(s.trend, 2)} <small>°C/Dekade</small></div>`
          + `<div class="row"><span>${data.period[0]}–${data.period[1]}, ${data.season_label}</span><span>p ${charts.fmtP(s.trend_p)}</span></div>`
        : `<div class="muted">${s.error || "Keine Daten"}</div>`)
      + spark
      + (s.change != null ? `<div class="row"><span>Änderung im Zeitraum</span><b>${charts.fmt(s.change, 2)} °C</b></div>` : "")
      + (s.vs_global != null ? `<div class="row"><span>× globaler Trend</span><b>${s.vs_global.toFixed(2).replace(".", ",")}</b></div>` : "")
      + (s.emergence_year ? `<div class="row"><span>Signal tritt hervor ab</span><b>${s.emergence_year}</b></div>` : "")
      + `<button class="primary" type="button" id="pop-add">+ Zum Vergleich</button></div>`;
    popup.setHTML(html);
    popup.getElement().querySelector("#pop-add")?.addEventListener("click", () => {
      addRegion({ point: [cell.lon, cell.lat], name: `Zelle ${fmtLatLon(cell.lat, cell.lon)}` });
      popup.remove();
    });
  } catch (err) {
    popup.setHTML(`<div class="cell-pop">${charts.escapeHtml(err.message)}</div>`);
  }
}

// --- rectangle drawing -------------------------------------------------------
let drawMode = false;
let drawStart = null;
function setDrawMode(on) {
  drawMode = on;
  $("btn-draw").classList.toggle("active", on);
  document.querySelector(".map-area").classList.toggle("drawing", on);
  if (on) map.dragPan.disable(); else map.dragPan.enable();
}

function boxFeature(a, b) {
  const w = Math.min(a.lng, b.lng), e = Math.max(a.lng, b.lng);
  const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
  const ring = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) ring.push([w + ((e - w) * i) / steps, s]);
  for (let i = 0; i <= steps; i++) ring.push([e - ((e - w) * i) / steps, n]);
  ring.push([w, s]);
  return { bbox: [w, s, e, n], feature: { type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: {} } };
}

function setupDrawing() {
  map.on("mousedown", (e) => {
    if (!drawMode) return;
    drawStart = e.lngLat;
  });
  map.on("mousemove", (e) => {
    if (!drawMode || !drawStart) return;
    const { feature } = boxFeature(drawStart, e.lngLat);
    map.getSource("draw")?.setData({ type: "FeatureCollection", features: [feature] });
  });
  map.on("mouseup", (e) => {
    if (!drawMode || !drawStart) return;
    const { bbox } = boxFeature(drawStart, e.lngLat);
    drawStart = null;
    map.getSource("draw")?.setData({ type: "FeatureCollection", features: [] });
    setDrawMode(false);
    if (bbox[2] - bbox[0] < 0.5 || bbox[3] - bbox[1] < 0.5) { toast("Rechteck zu klein – bitte größer aufziehen."); return; }
    const name = `Rechteck ${fmtLatLon(bbox[3], bbox[0])} – ${fmtLatLon(bbox[1], bbox[2])}`;
    addRegion({ bbox: bbox.map((v) => Math.round(v * 100) / 100), name });
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawMode) { drawStart = null; setDrawMode(false); } });
}

// ---------------------------------------------------------------------------
// Layer loading

let layerReq = 0;
async function refreshLayer() {
  const req = ++layerReq;
  if (state.kind === "year") return showYearMode();
  loading(true, "Berechne Karte …");
  try {
    const L = await getJSON("layer", { kind: state.kind, ...periodParams() });
    if (req !== layerReq) return;
    state.layer = L;
    state.grid = Float32Array.from(L.values, (v) => (v == null ? NaN : v));
    state.sigMask = L.significant ? Uint8Array.from(L.significant, (b) => (b ? 1 : 0)) : null;
    if (L.period[0] !== state.start || L.period[1] !== state.end) {
      state.start = L.period[0];
      state.end = L.period[1];
      syncControls();
    }
    redrawOverlay();
  } catch (err) {
    toast(err.message);
  } finally {
    loading(false);
  }
}

async function loadFrames() {
  const key = `${state.season}|${state.baseline}`;
  if (state.frames?.key === key) return state.frames;
  loading(true, "Lade alle Jahreskarten …");
  try {
    const qs = new URLSearchParams(commonParams()).toString();
    const res = await fetch(API + "frames?" + qs);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const [y0, y1] = res.headers.get("X-Years").split("-").map(Number);
    const buf = await res.arrayBuffer();
    const years = [];
    for (let y = y0; y <= y1; y++) years.push(y);
    state.frames = { key, years, data: new Int16Array(buf) };
    return state.frames;
  } finally {
    loading(false);
  }
}

async function showYearMode() {
  try {
    const f = await loadFrames();
    const slider = $("year-slider");
    slider.min = f.years[0];
    slider.max = f.years[f.years.length - 1];
    if (!state.year || state.year > f.years[f.years.length - 1] || state.year < f.years[0]) state.year = f.years[f.years.length - 1];
    slider.value = state.year;
    state.sigMask = null;
    showYear();
  } catch (err) {
    toast(err.message);
  }
}

function showYear() {
  const f = state.frames;
  if (!f) return;
  const i = f.years.indexOf(state.year);
  if (i < 0) return;
  const g = geom();
  const n = g.nlat * g.nlon;
  const grid = state.grid && state.grid.length === n && state.kind === "year" ? state.grid : new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = f.data[i * n + k];
    grid[k] = v === -32768 ? NaN : v / 100;
  }
  state.grid = grid;
  $("year-out").textContent = state.year;
  $("year-slider").value = state.year;
  redrawOverlay();
  if (!state.playing) writeHash();
}

let playTimer;
function togglePlay() {
  state.playing = !state.playing;
  $("btn-play").textContent = state.playing ? "❚❚" : "▶";
  if (state.playing) {
    const f = state.frames;
    if (!f) { state.playing = false; return; }
    if (state.year >= f.years[f.years.length - 1]) state.year = f.years[0];
    playTimer = setInterval(() => {
      const last = f.years[f.years.length - 1];
      if (state.year >= last) { togglePlay(); return; }
      state.year += 1;
      showYear();
    }, 160);
  } else {
    clearInterval(playTimer);
    writeHash();
  }
}

// ---------------------------------------------------------------------------
// Regions

function buildPresets() {
  const host = $("preset-groups");
  host.innerHTML = "";
  const groups = {};
  for (const p of state.meta.presets) {
    presetById[p.id] = p;
    (groups[p.group] ||= []).push(p);
  }
  for (const [name, items] of Object.entries(groups)) {
    const g = document.createElement("div");
    g.className = "preset-group";
    g.innerHTML = `<h4>${name}</h4>`;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const p of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.preset = p.id;
      b.textContent = p.name;
      b.title = p.note || p.name;
      b.addEventListener("click", () => togglePreset(p.id));
      chips.appendChild(b);
    }
    g.appendChild(chips);
    host.appendChild(g);
  }
}

function togglePreset(id) {
  const existing = state.regions.find((r) => r.spec.preset === id);
  if (existing) removeRegion(existing.uid);
  else addRegion({ preset: id });
}

function specKey(spec) {
  return spec.preset ? `p:${spec.preset}` : JSON.stringify(spec.bbox || spec.point || spec.polygon);
}

function addRegion(spec, { silent = false } = {}) {
  if (state.regions.some((r) => specKey(r.spec) === specKey(spec))) return;
  if (state.regions.length >= MAX_REGIONS) {
    toast(`Höchstens ${MAX_REGIONS} Regionen gleichzeitig – bitte erst eine entfernen.`);
    return;
  }
  const used = new Set(state.regions.map((r) => r.color));
  const color = COLORS.find((c) => !used.has(c));
  const name = spec.preset ? presetById[spec.preset]?.name || spec.preset : spec.name || "Eigene Region";
  state.regions.push({ uid: ++uidCounter, spec, name, color });
  if (!silent) { renderSelected(); drawRegionsOnMap(); refreshRegions(); writeHash(); }
}

function removeRegion(uid) {
  state.regions = state.regions.filter((r) => r.uid !== uid);
  renderSelected();
  drawRegionsOnMap();
  refreshRegions();
  writeHash();
}

function regionInfo(r) {
  return state.regionData?.regions?.find((x) => x._uid === r.uid);
}

function renderSelected() {
  const ul = $("selected");
  ul.innerHTML = "";
  for (const r of state.regions) {
    const info = regionInfo(r);
    const li = document.createElement("li");
    const trend = info?.stats?.trend;
    li.innerHTML = `<span class="swatch" style="background:${r.color}"></span>`
      + `<span class="name" title="${charts.escapeHtml(r.name)}">${charts.escapeHtml(r.name)}</span>`
      + `<span class="val" title="Trend °C/Dekade">${trend != null ? charts.fmt(trend, 2) : ""}</span>`
      + `<button type="button" aria-label="Entfernen" title="Entfernen">✕</button>`;
    li.querySelector("button").addEventListener("click", () => removeRegion(r.uid));
    li.querySelector(".name").addEventListener("click", () => zoomToRegion(r));
    li.querySelector(".name").style.cursor = "pointer";
    ul.appendChild(li);
  }
  $("selected-hint").hidden = state.regions.length > 0 && state.regions.length >= 2;
  for (const b of document.querySelectorAll("[data-preset]")) {
    b.classList.toggle("active", state.regions.some((r) => r.spec.preset === b.dataset.preset));
  }
}

function outlineFor(r) {
  if (r.spec.preset) return presetById[r.spec.preset]?.outline;
  const info = regionInfo(r);
  if (info?.outline) return info.outline;
  if (r.spec.bbox) {
    const [w, s, e, n] = r.spec.bbox;
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  }
  if (r.spec.point) {
    const c = cellIndex(r.spec.point[0], r.spec.point[1]);
    const g = geom();
    const [w, e, s, n] = [c.lon - g.dlon / 2, c.lon + g.dlon / 2, c.lat - g.dlat / 2, c.lat + g.dlat / 2];
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
  }
  return null;
}

function drawRegionsOnMap() {
  const src = map?.getSource("regions");
  if (!src) return;
  const features = [];
  for (const r of state.regions) {
    const ring = outlineFor(r);
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))) continue;
    const clamped = ring.map(([x, y]) => [x, Math.max(-MERC_MAX_LAT + 0.5, Math.min(MERC_MAX_LAT - 0.5, y))]);
    features.push({ type: "Feature", properties: { color: r.color, name: r.name }, geometry: { type: "Polygon", coordinates: [clamped] } });
  }
  src.setData({ type: "FeatureCollection", features });
}

function zoomToRegion(r) {
  const ring = outlineFor(r);
  if (!ring) return;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const b = [[Math.min(...xs), Math.max(-80, Math.min(...ys))], [Math.max(...xs), Math.min(80, Math.max(...ys))]];
  if (b[1][0] - b[0][0] > 300) map.flyTo({ center: [0, (b[0][1] + b[1][1]) / 2], zoom: 1.2 });
  else map.fitBounds(b, { padding: 60, maxZoom: 5.5, duration: 900 });
}

let regionReq = 0;
async function refreshRegions() {
  const req = ++regionReq;
  if (!state.regions.length) {
    state.regionData = null;
    renderSelected();
    renderAnalysis();
    return;
  }
  loading(true, "Berechne Regionen …");
  try {
    const custom = state.regions.map((r) => ({ ...r.spec, id: String(r.uid), name: r.name }));
    const data = await getJSON("regions", { custom: JSON.stringify(custom), ...periodParams() });
    if (req !== regionReq) return;
    data.regions.forEach((x, i) => { x._uid = state.regions[i]?.uid; });
    state.regionData = data;
    renderSelected();
    drawRegionsOnMap();
    renderAnalysis();
  } catch (err) {
    toast(err.message);
  } finally {
    loading(false);
  }
}

// --- search -------------------------------------------------------------------
function buildSearch() {
  const input = $("search");
  const list = $("search-results");
  let items = [];
  let active = -1;
  const render = () => {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = i === active ? "active" : "";
      li.innerHTML = `${charts.escapeHtml(it.name)} <span class="kind">${charts.escapeHtml(it.kind)}</span>`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(it); });
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const choose = (it) => {
    addRegion(it.spec);
    input.value = "";
    items = [];
    render();
    const r = state.regions[state.regions.length - 1];
    if (r) zoomToRegion(r);
  };
  const search = debounce(async (q) => {
    const local = state.meta.presets
      .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ name: p.name, kind: "Vordefiniert", spec: { preset: p.id } }));
    items = local;
    active = items.length ? 0 : -1;
    render();
    if (q.length < 3) return;
    try {
      const res = await fetch("/api/places?q=" + encodeURIComponent(q));
      const body = await res.json();
      if (input.value.trim() !== q) return;
      const remote = (body.places || []).map((p) => {
        const [w, s, e, n] = p.bbox;
        const tiny = e - w < 0.05 && n - s < 0.05;
        const spec = tiny ? { point: [p.lon, p.lat], name: p.name } : { bbox: [w, s, e, n], name: p.name };
        return { name: p.label || p.name, kind: tiny ? "Punkt → 2°-Zelle" : p.kind || "Gebiet", spec };
      });
      items = local.concat(remote);
      active = items.length ? 0 : -1;
      render();
    } catch { /* place search is optional */ }
  }, 300);
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) { items = []; render(); return; }
    search(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && items[active]) { choose(items[active]); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  input.addEventListener("focus", () => { if (items.length) list.hidden = false; });
}

// ---------------------------------------------------------------------------
// Analysis drawer

function setupResize() {
  const handle = $("resize-handle");
  let startY = 0, startH = 0;
  const move = (e) => {
    const h = Math.min(window.innerHeight * 0.8, Math.max(140, startH - (e.clientY - startY)));
    document.documentElement.style.setProperty("--analysis-h", `${h}px`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    map?.resize();
    renderAnalysis();
  };
  handle.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    startH = $("analysis").getBoundingClientRect().height;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  });
}

function downloadCsv() {
  const d = state.regionData;
  if (!d) { toast("Keine Regionen gewählt.", "info"); return; }
  const series = seriesForCharts();
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [
    `# TrendDetective Global Explorer – ${state.meta.dataset.name}`,
    `# Anomalie in °C gegenüber ${d.baseline[0]}-${d.baseline[1]}, ${d.season_label}; flächengewichtetes Mittel je Region`,
    `# Quelle: ${state.meta.dataset.url}`,
    ["year", ...series.flatMap((s) => [q(`${s.name} anomaly_C`), q(`${s.name} mean11y_C`), q(`${s.name} trend30y_C_per_decade`), q(`${s.name} coverage`)])].join(","),
  ];
  d.years.forEach((y, i) => {
    const row = [y];
    for (const s of series) row.push(s.values[i] ?? "", s.running[i] ?? "", s.rolling?.[i] ?? "", s.coverage[i] ?? "");
    lines.push(row.join(","));
  });
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trenddetective_${state.season}_${d.period[0]}-${d.period[1]}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function seriesForCharts() {
  const d = state.regionData;
  if (!d) return [];
  return d.regions.map((x) => {
    const r = state.regions.find((y) => y.uid === x._uid);
    return {
      uid: x._uid, name: r?.name || x.name, color: r?.color || "#888", values: x.values, running: x.running,
      coverage: x.coverage, stats: x.stats, monthly: x.monthly_trends, rolling: x.rolling_trend, rollingCi: x.rolling_ci, raw: x,
    };
  });
}

let rankingCache = null;
let zonalCache = null;

async function renderAnalysis() {
  const body = $("analysis-body");
  if (document.querySelector(".layout").classList.contains("analysis-collapsed")) return;
  const d = state.regionData;
  $("analysis-meta").textContent = `${seasonLabel()} · ${state.start}–${state.end} · Referenz ${baselineLabel()} · NASA GISTEMP v4`;
  const series = seriesForCharts();
  const needRegions = ["series", "tempo", "stripes", "seasons", "stats", "dist"].includes(state.tab);
  if (needRegions && !series.length) {
    body.innerHTML = `<div class="empty">Wähle rechts Regionen aus – oder klicke eine Stelle auf der Karte an.</div>`;
    return;
  }
  try {
    if (state.tab === "series") {
      charts.timeSeries(body, { years: d.years, series, period: d.period, baselineLabel: baselineLabel() });
    } else if (state.tab === "tempo") {
      charts.rollingTrend(body, { years: d.years, series, window: d.rolling_window, global: null });
    } else if (state.tab === "dist") {
      await renderDistribution(body, series);
    } else if (state.tab === "stripes") {
      charts.stripes(body, { years: d.years, series });
      const note = document.createElement("p");
      note.className = "hint";
      note.style.marginTop = "6px";
      note.textContent = `Jeder Streifen = ein Jahr (${seasonLabel()}), Farbe = Anomalie ggü. ${baselineLabel()}. Gemeinsame Farbskala für alle Regionen; grau = keine ausreichende Datenabdeckung.`;
      body.appendChild(note);
    } else if (state.tab === "seasons") {
      charts.seasons(body, { series });
    } else if (state.tab === "stats") {
      renderStats(body, series, d);
    } else if (state.tab === "ranking") {
      const key = JSON.stringify(periodParams());
      if (rankingCache?.key !== key) {
        body.innerHTML = `<div class="empty">Berechne Ranking aller Regionen …</div>`;
        const data = await getJSON("ranking", periodParams());
        rankingCache = { key, data };
      }
      if (state.tab !== "ranking") return;
      const colors = {};
      for (const r of state.regions) if (r.spec.preset) colors[r.spec.preset] = r.color;
      charts.ranking(body, {
        rows: rankingCache.data.rows,
        global: rankingCache.data.global.trend,
        selectedIds: state.regions.filter((r) => r.spec.preset).map((r) => r.spec.preset),
        colors,
        onPick: (id) => { togglePreset(id); setTimeout(renderAnalysis, 0); },
      });
    } else if (state.tab === "zonal") {
      const key = JSON.stringify(commonParams());
      if (zonalCache?.key !== key) {
        body.innerHTML = `<div class="empty">Berechne Zonalmittel …</div>`;
        zonalCache = { key, data: await getJSON("zonal", commonParams()) };
      }
      if (state.tab !== "zonal") return;
      const z = zonalCache.data;
      const highlight = state.regions.map((r) => {
        const ring = outlineFor(r);
        if (!ring) return null;
        const ys = ring.map((p) => p[1]);
        return { lat: [Math.min(...ys), Math.max(...ys)], color: r.color };
      }).filter(Boolean);
      body.innerHTML = "";
      const split = document.createElement("div");
      split.className = "split";
      const left = document.createElement("div");
      left.style.minHeight = "0";
      const right = document.createElement("div");
      right.className = "side-note";
      right.innerHTML = `<h4>Hovmöller-Diagramm</h4><p>Mittlere Anomalie jedes Breitenkreises (über alle Längengrade) für jedes Jahr. So sieht man, <b>wo</b> und <b>wann</b> die Erwärmung eingesetzt hat.</p><p>Die rote Fläche oben rechts ist die <b>arktische Verstärkung</b>: Seit etwa 2000 erwärmt sich der hohe Norden viel stärker als der Rest der Welt.</p><p>Leere Flächen: weniger als ein Viertel des Breitenkreises hat Messungen (z. B. Antarktis vor 1957).</p><p>Farbige Balken rechts = Breitenbereich deiner Regionen; gestrichelt = gewählter Zeitraum.</p>`;
      split.append(left, right);
      body.appendChild(split);
      charts.hovmoller(left, { years: z.years, lats: z.lats, values: z.values, period: [state.start, state.end], highlight });
    }
  } catch (err) {
    body.innerHTML = `<div class="empty">${charts.escapeHtml(err.message)}</div>`;
  }
}

let distCache = null;
async function renderDistribution(body, series) {
  if (!series.some((s) => s.uid === state.distUid)) state.distUid = series[0].uid;
  const r = state.regions.find((x) => x.uid === state.distUid);
  const spec = { ...r.spec, name: r.name };
  const params = { region: JSON.stringify(spec), season: state.season, baseline: state.baseline };
  const key = JSON.stringify(params);
  if (distCache?.key !== key) {
    body.innerHTML = `<div class="empty">Berechne Verteilung …</div>`;
    distCache = { key, data: await getJSON("distribution", params) };
  }
  if (state.tab !== "dist") return;
  const d = distCache.data;
  body.innerHTML = "";
  const split = document.createElement("div");
  split.className = "split";
  const left = document.createElement("div");
  left.style.cssText = "min-height:0;display:flex;flex-direction:column";
  const pick = document.createElement("div");
  pick.className = "chips small";
  pick.style.marginBottom = "6px";
  for (const s of series) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (s.uid === state.distUid ? " active" : "");
    b.innerHTML = `<span style="color:${s.color}">■</span> ${charts.escapeHtml(charts.truncate(s.name, 26))}`;
    b.addEventListener("click", () => { state.distUid = s.uid; renderAnalysis(); });
    pick.appendChild(b);
  }
  const chartHost = document.createElement("div");
  chartHost.style.cssText = "flex:1;min-height:0;position:relative";
  left.append(pick, chartHost);
  const right = document.createElement("div");
  right.className = "side-note";
  split.append(left, right);
  body.appendChild(split);
  const colors = charts.distributionChart(chartHost, d);
  const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0).replace(".", ",")} %`);
  right.innerHTML = `<h4>${charts.escapeHtml(r.name)} · ${charts.escapeHtml(d.season_label)}</h4>`
    + `<table class="stats"><thead><tr><th>Zeitraum</th><th>Mittel</th><th>&gt; 2σ</th><th>&gt; 3σ</th></tr></thead><tbody>`
    + d.periods.map((p, k) => `<tr><td><span style="color:${colors[Math.min(k, colors.length - 1)]}">■</span> ${p.period[0]}–${p.period[1]}</td><td>${charts.fmt(p.mean, 1)}σ</td><td>${pct(p.above2)}</td><td>${pct(p.above3)}</td></tr>`).join("")
    + `</tbody></table>`
    + `<p style="margin-top:8px">Jede Gitterzelle und jedes Jahr wird an der <b>eigenen</b> Jahr-zu-Jahr-Schwankung (σ) der Referenzperiode ${d.baseline[0]}–${d.baseline[1]} gemessen. In einem stabilen Klima läge nur ≈ 2 % der Fläche über 2σ und ≈ 0,1 % über 3σ.</p>`
    + `<p>Rechtsverschiebung = was früher eine seltene Hitze-${d.season_label === "Jahr" ? "jahr" : "saison"} war, ist heute normal (nach Hansen et al. 2012, PNAS).</p>`
    + `<p class="hint">${d.cells} Gitterzellen. Vorsicht beim Vergleich mit Stationsdaten: GISTEMP glättet über bis zu 1200 km, und über dem Meer schwankt die Temperatur wenig – beides macht σ klein und die Verschiebung in σ größer als an einer einzelnen Wetterstation. Am aussagekräftigsten ist der Sommer (JJA) über Land.</p>`;
}

const STAT_ROWS = [
  { group: "Trend im Zeitraum" },
  { key: "trend", label: "Linearer Trend (OLS)", unit: "°C/Dek.", digits: 3, info: "Kleinste-Quadrate-Gerade durch die Jahreswerte." },
  { key: "trend_ci", label: "± 95-%-Konfidenz", unit: "°C/Dek.", digits: 3, signed: false, info: "Autokorrelationskorrigiert (effektive Stichprobengröße, Santer et al. 2000)." },
  { key: "trend_p", label: "p-Wert (t-Test, AR1-korr.)", p: true },
  { key: "sen", label: "Theil-Sen-Steigung", unit: "°C/Dek.", digits: 3, info: "Robuster Median aller paarweisen Steigungen – unempfindlich gegen Ausreißer." },
  { key: "mk_p", label: "Mann-Kendall p-Wert", p: true, info: "Nichtparametrischer Trendtest (ohne Autokorrelationskorrektur)." },
  { key: "change", label: "Änderung über den Zeitraum", unit: "°C", digits: 2, info: "Trend × Länge des Zeitraums." },
  { key: "vs_global", label: "Faktor ggü. globalem Trend", unit: "×", digits: 2, signed: false },
  { group: "Dynamik" },
  { key: "trend_first_half", label: "Trend 1. Hälfte", unit: "°C/Dek.", digits: 3, halves: 0 },
  { key: "trend_second_half", label: "Trend 2. Hälfte", unit: "°C/Dek.", digits: 3, halves: 1 },
  { key: "acceleration", label: "Beschleunigung", unit: "°C/Dek.", digits: 3, info: "Trend 2. Hälfte minus Trend 1. Hälfte; fett = signifikant (|Δ| > 1,96·σ)." },
  { key: "snr", label: "Signal / Rauschen", unit: "σ", digits: 1, signed: false, info: "Lineare Änderung geteilt durch Standardabweichung der trendbereinigten Jahreswerte." },
  { key: "emergence_year", label: "Signal tritt hervor ab", year: true, info: "Erstes Jahr, ab dem das 11-Jahres-Mittel dauerhaft über 2σ der Jahresschwankung der Referenzperiode liegt (Hawkins & Sutton 2012)." },
  { group: "Niveau" },
  { key: "mean_last10", label: "Mittel letzte 10 Jahre", unit: "°C", digits: 2 },
  { key: "warmest", label: "Wärmste Jahre", list: true },
  { key: "noise_std", label: "Jahr-zu-Jahr-Schwankung (σ)", unit: "°C", digits: 2, signed: false },
  { group: "Region" },
  { key: "_area", label: "Fläche", area: true },
  { key: "_cells", label: "2°-Gitterzellen", cells: true },
];

function renderStats(body, series, d) {
  body.innerHTML = "";
  // Key figures first
  const kpis = document.createElement("div");
  kpis.className = "kpis";
  for (const s of series) {
    const st = s.stats;
    kpis.innerHTML += `<div class="kpi"><div class="k-name"><i style="background:${s.color}"></i>${charts.escapeHtml(charts.truncate(s.name, 24))}</div>`
      + `<div class="k-val">${charts.fmt(st.trend, 2)} <small>°C/Dek.</small></div>`
      + `<div class="k-sub">${st.vs_global != null ? "× " + st.vs_global.toFixed(1).replace(".", ",") + " global · " : ""}${charts.fmt(st.change, 1)} °C seit ${d.period[0]}</div></div>`;
  }
  body.appendChild(kpis);
  body.appendChild(summaryText(series, d));
  const table = document.createElement("table");
  table.className = "stats";
  let html = `<thead><tr><th>${d.season_label}, ${d.period[0]}–${d.period[1]}</th>${series.map((s) => `<th><span style="color:${s.color}">■</span> ${charts.escapeHtml(charts.truncate(s.name, 20))}</th>`).join("")}</tr></thead><tbody>`;
  for (const row of STAT_ROWS) {
    if (row.group) { html += `<tr class="grp"><td colspan="${series.length + 1}">${row.group}</td></tr>`; continue; }
    let label = row.label;
    if (row.halves != null) {
      const h = series[0]?.stats?.halves?.[row.halves];
      if (h) label += ` (${h[0]}–${h[1]})`;
    }
    html += `<tr><td>${row.info ? `<span class="info" title="${charts.escapeHtml(row.info)}">${label}</span>` : label}</td>`;
    for (const s of series) {
      const st = s.stats || {};
      let cell = "–", cls = "";
      if (row.p) { cell = charts.fmtP(st[row.key]); cls = st[row.key] != null && st[row.key] < 0.05 ? "sig" : "nsig"; }
      else if (row.year) cell = st[row.key] ?? "noch nicht";
      else if (row.list) cell = (st[row.key] || []).map(([y, v]) => `${y} (${charts.fmt(v, 1)})`).join(", ") || "–";
      else if (row.area) cell = s.raw.area_km2 != null ? `${Math.round(s.raw.area_km2).toLocaleString("de-DE")} km²` : "–";
      else if (row.cells) cell = s.raw.cells;
      else {
        cell = charts.fmt(st[row.key], row.digits, row.signed !== false);
        if (cell !== "–" && row.unit) cell += ` ${row.unit}`;
        if (row.key === "acceleration" && st.acceleration_significant) cell = `<b>${cell}</b>`;
      }
      html += `<td class="${cls}">${cell}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  table.innerHTML = html;
  body.appendChild(table);
  const notes = series.filter((s) => s.raw.note).map((s) => `<b>${charts.escapeHtml(s.name)}:</b> ${charts.escapeHtml(s.raw.note)}`);
  if (notes.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.marginTop = "8px";
    p.innerHTML = notes.join("<br>");
    body.appendChild(p);
  }
}

function summaryText(series, d) {
  const p = document.createElement("p");
  p.className = "hint";
  p.style.margin = "0 0 10px";
  p.style.fontSize = "12.5px";
  p.style.color = "var(--text-2)";
  const valid = series.filter((s) => s.stats?.trend != null);
  if (!valid.length) return p;
  const sorted = [...valid].sort((a, b) => b.stats.trend - a.stats.trend);
  const fast = sorted[0], slow = sorted[sorted.length - 1];
  const g = d.global?.trend;
  let txt = `Im Zeitraum ${d.period[0]}–${d.period[1]} (${d.season_label}) erwärmt sich <b>${charts.escapeHtml(fast.name)}</b> am schnellsten mit ${charts.fmt(fast.stats.trend, 2)} °C pro Dekade`;
  if (fast.stats.vs_global != null) txt += ` – ${fast.stats.vs_global.toFixed(1).replace(".", ",")}-mal so schnell wie die Welt im Mittel (${charts.fmt(g, 2)} °C/Dek.)`;
  txt += ".";
  if (sorted.length > 1) {
    txt += ` Am langsamsten: <b>${charts.escapeHtml(slow.name)}</b> (${charts.fmt(slow.stats.trend, 2)} °C/Dek.`;
    if (slow.stats.trend_p != null && slow.stats.trend_p >= 0.05) txt += `, statistisch nicht signifikant`;
    txt += ").";
  }
  const acc = valid.filter((s) => s.stats.acceleration_significant && s.stats.acceleration > 0);
  if (acc.length) txt += ` Signifikant beschleunigt hat sich die Erwärmung in: ${acc.map((s) => charts.escapeHtml(s.name)).join(", ")}.`;
  p.innerHTML = txt;
  return p;
}

function buildAbout() {
  const ds = state.meta.dataset;
  $("about-body").innerHTML = `
    <h3>Daten</h3>
    <p><b>${ds.name}</b> – monatliche Oberflächentemperatur-Anomalien auf einem 2°×2°-Gitter (≈ 220 km), ${ds.first[0]} bis ${ds.last[1]}/${ds.last[0]}, relativ zu ${ds.baseline[0]}–${ds.baseline[1]}. Über Land aus rund 27 000 Wetterstationen (GHCNv4), über dem Meer aus Schiffs- und Bojenmessungen (ERSSTv5). NASA interpoliert jede Zelle aus Stationen im Umkreis von 1200 km – Zellen ohne Station in Reichweite bleiben <b>leer</b>, es wird nichts erfunden.</p>
    <p class="hint">${charts.escapeHtml(ds.citation)} · <a href="${ds.url}" target="_blank" rel="noopener">${ds.url}</a></p>
    <h3>Karte</h3>
    <p>Die Werte gehören zu den Mittelpunkten der Gitterzellen. Für die glatte Darstellung wird zwischen den vier benachbarten Mittelpunkten <b>bilinear interpoliert</b>; wo Nachbarn fehlen, wird nur zwischen vorhandenen Werten gemittelt und nicht über Datenlücken hinaus extrapoliert. Mit „Zwischen Gitterpunkten interpolieren“ aus siehst du die Rohzellen.</p>
    <h3>Statistik</h3>
    <ul>
      <li><b>Trend</b>: lineare Regression (kleinste Quadrate) der Jahres- bzw. Jahreszeitenmittel. Konfidenzintervall und p-Wert sind für Autokorrelation erster Ordnung korrigiert (Santer et al. 2000). Eine Zelle bekommt nur einen Trend, wenn mindestens ⅔ der Jahre und jedes Drittel des Zeitraums Daten haben.</li>
      <li><b>Robuste Prüfung</b>: Theil-Sen-Steigung und Mann-Kendall-Test.</li>
      <li><b>Beschleunigung</b>: Trend der zweiten minus Trend der ersten Hälfte des Zeitraums – die „zweite Ableitung“ der Temperatur.</li>
      <li><b>Signal/Rauschen &amp; Zeitpunkt des Hervortretens</b>: wie deutlich sich die Erwärmung von der natürlichen Jahr-zu-Jahr-Schwankung abhebt (Hawkins &amp; Sutton 2012).</li>
      <li><b>Räumlicher Gradient</b>: Betrag des räumlichen Gradienten des Trendfelds (zentrale Differenzen) in °C/Dekade pro 1000 km.</li>
      <li><b>Regionen</b>: flächengewichtetes Mittel (cos Breite × Anteil der Zelle in der Region). Jahre mit weniger als ⅓ Datenabdeckung der Region werden nicht gezeigt.</li>
      <li><b>Referenzperiode</b> verschiebt nur das Nullniveau der Anomalien, Trends bleiben gleich.</li>
    </ul>
    <h3>Grenzen</h3>
    <p>2° sind für kleine Regionen wie NRW grob (wenige Zellen); dafür ist die stationsbasierte Analyse dieses Projekts besser geeignet. Frühe Jahre (vor ~1950) haben besonders in Polarregionen, Afrika und auf den Südmeeren wenige Messungen – die Flächenabdeckung steht im Tooltip der Zeitreihe.</p>`;
}

// ---------------------------------------------------------------------------

function refreshAll() {
  rankingCache = null;
  writeHash();
  refreshLayer();
  refreshRegions();
}

async function main() {
  try {
    state.meta = await getJSON("meta");
  } catch (err) {
    $("dataset-line").textContent = "Datensatz konnte nicht geladen werden: " + err.message;
    return;
  }
  const ds = state.meta.dataset;
  $("dataset-line").textContent = `${ds.name} · 2°-Gitter · ${ds.first[0]}–${String(ds.last[1]).padStart(2, "0")}/${ds.last[0]} · monatlich`;
  state.end = lastFullYear();
  state.year = state.end;
  buildControls();
  if (!readHash()) for (const spec of DEFAULT_REGIONS) addRegion(spec, { silent: true });
  if (!state.end) state.end = lastFullYear();
  syncControls();
  renderSelected();
  initMap();
  refreshLayer();
  refreshRegions();
  window.addEventListener("resize", debounce(() => renderAnalysis(), 150));
}

main();
