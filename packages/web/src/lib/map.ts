// The per-player map's pure half (docs/decisions.md §19, docs/web.md §3 Map): tile colours,
// decoding the API's base64+gzip grids, painting pixels, the game camera's projection, fitting
// the view, hit-testing a tap.
// No DOM here beyond `DecompressionStream`/`atob` (both in Node too), so it is unit-tested.
import type { MapContainer, MapShardView, MapTile } from '@dst/shared';

export type Rgb = readonly [number, number, number];

function hex(s: string): Rgb {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

/** One flat colour per DST tile-name prefix; first match wins (research §2.2). */
const TILE_COLORS: [RegExp, Rgb][] = (
  [
    [/^OCEAN_COASTAL_SHORE/, '#5b9fc0'],
    [/^OCEAN_COASTAL/, '#4a8db3'],
    [/^OCEAN_SWELL/, '#35698f'],
    [/^OCEAN_ROUGH/, '#264e70'],
    [/^OCEAN_HAZARDOUS/, '#1b3552'],
    [/^OCEAN_BRINEPOOL/, '#3f9a9a'],
    [/^OCEAN_WATERLOG/, '#4f6f4a'],
    [/^OCEAN_ICE/, '#cfe6f0'],
    [/^OCEAN/, '#35698f'],
    [/^IMPASSABLE$/, '#111114'],
    [/^FAKE_GROUND/, '#1c1c20'],
    [/^FOREST/, '#3f6b2e'],
    [/^GRASS/, '#8fae4a'],
    [/^SAVANNA/, '#c9b35a'],
    [/^DECIDUOUS/, '#c4793a'],
    [/^MARSH/, '#4b5a4e'],
    [/^ROCKY/, '#8a8580'],
    [/^DESERT_DIRT/, '#d59a5a'],
    [/^DIRT/, '#8c6a45'],
    [/^METEOR/, '#b7b3c9'],
    [/^PEBBLEBEACH/, '#d8cfae'],
    [/^SHELLBEACH/, '#efe1c8'],
    [/^MONKEY/, '#c98f86'],
    [/^ROAD/, '#5b4f44'],
    // Player-laid turf: stands out as "the base".
    [/^(CARPET|CHECKER|WOODFLOOR|MOSAIC|COTL|BEARD)/, '#e2c16a'],
    [/^SINKHOLE/, '#6f8a3c'],
    [/^MUD/, '#5e4a36'],
    [/^CAVE$/, '#7a6d5e'],
    [/^UNDERROCK/, '#4d4a47'],
    [/^FUNGUSGREEN/, '#4f9a5a'],
    [/^FUNGUSRED/, '#b0504a'],
    [/^FUNGUSMOON/, '#9fd2d6'],
    [/^FUNGUS/, '#4f6fb0'],
    [/^(BRICK|TRIM|TILES)/, '#8a5a4a'],
    [/^VENT/, '#a0442c'],
    [/^ARCHIVE/, '#5e8e8a'],
    [/^VAULT/, '#7a5a9a'],
  ] as [RegExp, string][]
).map(([re, c]) => [re, hex(c)]);

/** A tile type this table does not know (a new DST biome) is drawn neutral, never an error. */
export const UNKNOWN_TILE_RGB: Rgb = hex('#9a8f80');
export const FOG_RGB: Rgb = hex('#1e1b18');
export const FRESH_RGB: Rgb = hex('#e8413c');
export const STORAGE_COLOR = '#ffd23f';
export const STOP_COLOR = '#ff4fd8';

export function tileColor(name: string): Rgb {
  for (const [re, c] of TILE_COLORS) if (re.test(name)) return c;
  return UNKNOWN_TILE_RGB;
}

/** base64 of gzip -> bytes. */
export async function inflateBase64(b64: string): Promise<Uint8Array> {
  const bin = atob(b64);
  const gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface DecodedShard {
  width: number;
  height: number;
  palette: string[];
  /** one byte per tile: 0 = fog, else 1-based into `palette` */
  tiles: Uint8Array;
  trail: Uint8Array; // bitmap, MSB-first
  fresh: Uint8Array; // bitmap, MSB-first
  freshCount: number;
  containers: MapContainer[];
  base: MapTile | null;
  stop: MapTile | null;
}

export async function decodeShard(view: MapShardView): Promise<DecodedShard> {
  const [tiles, trail, fresh] = await Promise.all([
    inflateBase64(view.tiles),
    inflateBase64(view.trail),
    inflateBase64(view.fresh),
  ]);
  const n = view.width * view.height;
  const bitmapLen = Math.ceil(n / 8);
  if (tiles.length !== n || trail.length !== bitmapLen || fresh.length !== bitmapLen) {
    throw new Error('map: grid sizes do not match the dimensions');
  }
  return {
    width: view.width,
    height: view.height,
    palette: view.palette,
    tiles,
    trail,
    fresh,
    freshCount: view.freshCount,
    containers: view.containers,
    base: view.base,
    stop: view.stop,
  };
}

export function bitAt(bits: Uint8Array, i: number): boolean {
  return ((bits[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
}

export interface MapLayers {
  trail: boolean;
  fresh: boolean;
}

/** RGBA pixels, one per tile, for `ImageData`. The trail lightens the terrain under it (still
 *  readable); this session's new tiles are solid red on top. */
export function paintTerrain(d: DecodedShard, layers: MapLayers): Uint8ClampedArray<ArrayBuffer> {
  const colors = d.palette.map(tileColor);
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  for (let i = 0; i < d.tiles.length; i++) {
    const v = d.tiles[i]!;
    let c: Rgb = v === 0 ? FOG_RGB : (colors[v - 1] ?? UNKNOWN_TILE_RGB);
    if (v !== 0 && layers.trail && bitAt(d.trail, i)) {
      c = [c[0] * 0.35 + 166, c[1] * 0.35 + 166, c[2] * 0.35 + 166];
    }
    if (layers.fresh && bitAt(d.fresh, i)) c = FRESH_RGB;
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The game camera's heading when nothing has turned it (followcamera.lua `SetDefault`). Q/E turn
 *  it by ±45 and the in-game map turns with it; it is client-only state, never sent to the server
 *  or saved, so the map cannot know it and starts here, as every fresh client does. */
export const DEFAULT_HEADING = 45;

function trig(heading: number): { s: number; c: number } {
  const r = (heading * Math.PI) / 180;
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v); // exact at 0/90/180/270
  return { s: snap(Math.sin(r)), c: snap(Math.cos(r)) };
}

/** World tile axes (x, z) -> screen (right, down) in tile units, as the game draws them:
 *  followcamera.lua has screen-down = (cos h, sin h) and screen-right = (-sin h, cos h) in world
 *  (x, z). The matrix [[-s, c], [c, s]] has determinant -1, a reflection: plotting x right and z
 *  down (no matter how it is turned) is the in-game map's mirror image. It is symmetric and
 *  orthogonal, so it is its own inverse. */
export function project(heading: number, x: number, y: number): { x: number; y: number } {
  const { s, c } = trig(heading);
  return { x: -s * x + c * y, y: c * x + s * y };
}

/** A box in projected (screen-axis) tile units. */
export interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The projected box around every revealed tile at `heading`, or null if nothing is. Fitting the
 *  projected tiles (not the grid's box) keeps a turned map from gaining empty diamond corners. */
export function revealedExtent(
  d: Pick<DecodedShard, 'width' | 'height' | 'tiles'>,
  heading: number,
): Extent | null {
  const { s, c } = trig(heading);
  const half = (Math.abs(s) + Math.abs(c)) / 2; // a unit tile's half-extent on either axis
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < d.tiles.length; i++) {
    if (d.tiles[i] === 0) continue;
    const tx = (i % d.width) + 0.5;
    const ty = Math.floor(i / d.width) + 0.5;
    const px = -s * tx + c * ty;
    const py = c * tx + s * ty;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return x1 === -Infinity ? null : { x0: x0 - half, y0: y0 - half, x1: x1 + half, y1: y1 + half };
}

/** Screen transform: world tile point (x, y) is at (ox, oy) + scale·project(heading, x, y) CSS
 *  pixels inside the viewport. */
export interface MapView {
  scale: number;
  ox: number;
  oy: number;
  heading: number;
}

export const MAX_SCALE = 24;

export function tileToScreen(v: MapView, x: number, y: number): { x: number; y: number } {
  const p = project(v.heading, x, y);
  return { x: v.ox + p.x * v.scale, y: v.oy + p.y * v.scale };
}

export function screenToTile(v: MapView, px: number, py: number): { x: number; y: number } {
  return project(v.heading, (px - v.ox) / v.scale, (py - v.oy) / v.scale);
}

/** Fits extent `e` (at `heading`, plus a margin in tiles) into a `vw`×`vh` viewport, centred. */
export function fitView(e: Extent, vw: number, vh: number, heading: number, margin = 3): MapView {
  const w = e.x1 - e.x0 + margin * 2;
  const h = e.y1 - e.y0 + margin * 2;
  const scale = Math.min(MAX_SCALE, vw / w, vh / h);
  const cx = (e.x0 + e.x1) / 2;
  const cy = (e.y0 + e.y1) / 2;
  return { scale, ox: vw / 2 - cx * scale, oy: vh / 2 - cy * scale, heading };
}

function centreAt(
  x: number,
  y: number,
  scale: number,
  vw: number,
  vh: number,
  heading: number,
): MapView {
  const p = project(heading, x, y);
  return { scale, ox: vw / 2 - p.x * scale, oy: vh / 2 - p.y * scale, heading };
}

/** Centres tile `t` at `scale`. */
export function centreOn(
  t: MapTile,
  scale: number,
  vw: number,
  vh: number,
  heading: number,
): MapView {
  return centreAt(t.tx + 0.5, t.ty + 0.5, scale, vw, vh, heading);
}

/** Turns the map by `delta` degrees (Q/E are ±45), keeping the point under the viewport's centre
 *  where it is. */
export function rotateView(v: MapView, delta: number, vw: number, vh: number): MapView {
  const t = screenToTile(v, vw / 2, vh / 2);
  const heading = (((v.heading + delta) % 360) + 360) % 360;
  return centreAt(t.x, t.y, v.scale, vw, vh, heading);
}

/** Zooms by `factor` keeping the screen point (px, py) fixed; clamped to [minScale, MAX_SCALE]. */
export function zoomAt(
  v: MapView,
  factor: number,
  px: number,
  py: number,
  minScale: number,
): MapView {
  const scale = Math.min(MAX_SCALE, Math.max(minScale, v.scale * factor));
  const k = scale / v.scale;
  return { ...v, scale, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
}

/** Containers whose tile centre is within `radius` tiles of the point, nearest first. Several can
 *  share a tile (three chests side by side), so a tap lists them all. */
export function containersNear(
  containers: MapContainer[],
  x: number,
  y: number,
  radius = 1.5,
): MapContainer[] {
  return containers
    .map((c) => ({ c, d: Math.hypot(c.tx + 0.5 - x, c.ty + 0.5 - y) }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => c);
}

/** "Chest: Cut Grass 60, Log 38" / "Ice Box: empty" */
export function containerText(c: MapContainer): string {
  const items = c.items.map((i) => `${i.name} ${i.count}`);
  return `${c.name}: ${items.length > 0 ? items.join(', ') : 'empty'}`;
}

/** "As of day 60 · Sun, Sep 27" (either half may be missing). */
export function mapAsOfText(day: number | null, stoppedAt: string | null, locale?: string): string {
  const parts: string[] = [];
  if (day !== null) parts.push(`day ${day}`);
  const d = stoppedAt !== null ? new Date(stoppedAt) : null;
  if (d !== null && !Number.isNaN(d.getTime())) {
    parts.push(d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }));
  }
  return parts.length > 0 ? `As of ${parts.join(' · ')}` : '';
}
