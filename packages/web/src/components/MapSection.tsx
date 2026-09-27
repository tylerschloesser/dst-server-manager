// docs/web.md §3 Map (docs/decisions.md §19): each player's map, directly under the recap, the
// viewer's own by default and any other player's through "Whose map". The API has already cut
// each to its own player's reveal; this draws the selected one. One pixel per tile is painted once
// into an offscreen canvas, then redrawn through the game camera's projection (turned and mirrored
// like the in-game map, lib/map.ts `project`; no smoothing) on every pan/zoom/turn, with the
// markers on top, upright and at a fixed on-screen size so they stay tappable when zoomed out.
//
// Touch: one finger pans, two pinch; a short tap near storage lists what is in it. Mouse: drag,
// wheel to zoom. Buttons do the same for anyone who can do neither, and turn the map ±45° like
// the game's Q/E.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ActionIcon,
  Chip,
  CloseButton,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import {
  IconFocusCentered,
  IconHome,
  IconRotate,
  IconRotateClockwise,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import type {
  ClusterStatus,
  MapContainer,
  MapResponse,
  MapShardView,
  PlayerMap,
  RecapShard,
  WorldSummary,
} from '@dst/shared';
import { useWorldMap } from '../api/map';
import {
  DEFAULT_HEADING,
  FOG_RGB,
  FRESH_RGB,
  STOP_COLOR,
  STORAGE_COLOR,
  centreOn,
  containerText,
  containersNear,
  decodeShard,
  fitView,
  mapAsOfText,
  paintTerrain,
  revealedExtent,
  rotateView,
  screenToTile,
  tileToScreen,
  zoomAt,
} from '../lib/map';
import type { DecodedShard, MapLayers, MapView } from '../lib/map';

const WRAP = { overflowWrap: 'anywhere' } as const;
const SHARD_LABEL: Record<RecapShard, string> = { master: 'Surface', caves: 'Caves' };
const TAP_SLOP_PX = 8;
const TAP_MS = 400;
const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

type Layer = 'trail' | 'fresh' | 'storage';

interface CanvasProps {
  shard: DecodedShard;
  layers: MapLayers & { storage: boolean };
  label: string;
  onTap: (found: MapContainer[]) => void;
}

function MapCanvas({ shard, layers, label, onTap }: CanvasProps) {
  const { ref: boxRef, width } = useElementSize();
  const height = Math.round(Math.min(Math.max(width, 1) * 0.85, 460));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<MapView | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);

  const minScale = Math.min(width / shard.width, height / shard.height) * 0.8 || 0.1;
  const fit = (heading: number): MapView | null => {
    const e = width > 0 ? revealedExtent(shard, heading) : null;
    return e !== null ? fitView(e, width, height, heading) : null;
  };

  // A new shard (or the first real size) starts fitted to what its player has seen, keeping the
  // heading it was turned to. The heading is not remembered between visits: the game resets too.
  const fittedFor = useRef<DecodedShard | null>(null);
  const heading = view?.heading ?? DEFAULT_HEADING;
  useEffect(() => {
    if (width === 0 || fittedFor.current === shard) return;
    fittedFor.current = shard;
    const e = revealedExtent(shard, heading);
    setView(e !== null ? fitView(e, width, height, heading) : null);
  }, [shard, heading, width, height]);

  const terrain = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = shard.width;
    c.height = shard.height;
    const ctx = c.getContext('2d');
    ctx?.putImageData(new ImageData(paintTerrain(shard, layers), shard.width, shard.height), 0, 0);
    return c;
  }, [shard, layers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || view === null || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = rgb(FOG_RGB);
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    const s = view.scale;
    // One image pixel is one tile at world (x, z); this is lib/map.ts `project` as a canvas matrix.
    const r = (view.heading * Math.PI) / 180;
    const sin = Math.sin(r);
    const cos = Math.cos(r);
    const k = dpr * s;
    ctx.setTransform(-k * sin, k * cos, k * cos, k * sin, dpr * view.ox, dpr * view.oy);
    ctx.drawImage(terrain, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const at = (tx: number, ty: number) => {
      const p = tileToScreen(view, tx + 0.5, ty + 0.5);
      return [p.x, p.y];
    };

    if (layers.storage) {
      const size = Math.max(7, s * 0.9);
      const seen = new Set<string>();
      for (const c of shard.containers) {
        const k = `${c.tx},${c.ty}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const [x, y] = at(c.tx, c.ty);
        ctx.fillStyle = STORAGE_COLOR;
        ctx.strokeStyle = '#1b1b1b';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x! - size / 2, y! - size / 2, size, size);
        ctx.strokeRect(x! - size / 2, y! - size / 2, size, size);
      }
    }
    if (shard.base !== null) {
      const [x, y] = at(shard.base.tx, shard.base.ty);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x!, y!, Math.max(12, s * 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (shard.stop !== null) {
      const [x, y] = at(shard.stop.tx, shard.stop.ty);
      ctx.fillStyle = STOP_COLOR;
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x!, y!, Math.max(5, s * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [view, terrain, shard, layers.storage, width, height]);

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setView((v) =>
        v === null ? v : zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top, minScale),
      );
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [minScale]);

  const local = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    gesture.current =
      pointers.current.size === 1 ? { x: p.x, y: p.y, t: performance.now(), moved: false } : null;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (prev === undefined || view === null) return;
    const p = local(e);
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);
    if (others.length === 0) {
      const g = gesture.current;
      if (g !== null && Math.hypot(p.x - g.x, p.y - g.y) > TAP_SLOP_PX) g.moved = true;
      setView({ ...view, ox: view.ox + p.x - prev.x, oy: view.oy + p.y - prev.y });
    } else {
      const o = others[0]![1];
      const before = Math.hypot(prev.x - o.x, prev.y - o.y);
      const after = Math.hypot(p.x - o.x, p.y - o.y);
      const mid = { x: (p.x + o.x) / 2, y: (p.y + o.y) / 2 };
      const moved = { x: (p.x - prev.x) / 2, y: (p.y - prev.y) / 2 };
      const zoomed = before > 0 ? zoomAt(view, after / before, mid.x, mid.y, minScale) : view;
      setView({ ...zoomed, ox: zoomed.ox + moved.x, oy: zoomed.oy + moved.y });
    }
    pointers.current.set(e.pointerId, p);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    gesture.current = null;
    if (g === null || g.moved || performance.now() - g.t > TAP_MS || view === null) return;
    const p = local(e);
    const t = screenToTile(view, p.x, p.y);
    onTap(
      layers.storage
        ? containersNear(shard.containers, t.x, t.y, Math.max(1.5, 12 / view.scale))
        : [],
    );
  };

  const zoomBy = (factor: number) =>
    setView((v) => (v === null ? v : zoomAt(v, factor, width / 2, height / 2, minScale)));

  const rotate = (delta: number) =>
    setView((v) => (v === null ? v : rotateView(v, delta, width, height)));

  return (
    <Stack gap={6}>
      <div ref={boxRef} style={{ position: 'relative', width: '100%' }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          data-testid="map-canvas"
          style={{
            display: 'block',
            width: '100%',
            height,
            borderRadius: 8,
            touchAction: 'none',
            cursor: 'grab',
            background: rgb(FOG_RGB),
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            gesture.current = null;
          }}
        />
      </div>
      <Group gap={6} justify="flex-end">
        <ActionIcon variant="default" aria-label="Rotate left" onClick={() => rotate(-45)}>
          <IconRotate size={18} />
        </ActionIcon>
        <ActionIcon variant="default" aria-label="Rotate right" onClick={() => rotate(45)}>
          <IconRotateClockwise size={18} />
        </ActionIcon>
        {shard.base !== null && (
          <ActionIcon
            variant="default"
            aria-label="Centre on base"
            onClick={() =>
              setView(centreOn(shard.base!, Math.max(view?.scale ?? 0, 10), width, height, heading))
            }
          >
            <IconHome size={18} />
          </ActionIcon>
        )}
        <ActionIcon
          variant="default"
          aria-label="Fit the explored area"
          onClick={() => setView(fit(heading))}
        >
          <IconFocusCentered size={18} />
        </ActionIcon>
        <ActionIcon variant="default" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>
          <IconZoomOut size={18} />
        </ActionIcon>
        <ActionIcon variant="default" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>
          <IconZoomIn size={18} />
        </ActionIcon>
      </Group>
    </Stack>
  );
}

function Swatch({ color, round = false }: { color: string; round?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        marginRight: 4,
        verticalAlign: -1,
        borderRadius: round ? 5 : 2,
        background: color,
        border: '1px solid #0006',
      }}
    />
  );
}

type Decoded = Partial<Record<RecapShard, DecodedShard>>;

function MapPanel({
  world,
  map,
}: {
  world: WorldSummary;
  map: Extract<MapResponse, { status: 'ok' }>;
}) {
  const [playerIdx, setPlayerIdx] = useState(0);
  // A refetch can return fewer maps than before: fall back to the first (the viewer's, if any).
  const idx = playerIdx < map.maps.length ? playerIdx : 0;
  const player: PlayerMap = map.maps[idx]!;
  const shards = (['master', 'caves'] as const).filter((s) => player.shards[s] !== undefined);
  const [shardPick, setShard] = useState<RecapShard>(shards[0] ?? 'master');
  const shard = shards.includes(shardPick) ? shardPick : (shards[0] ?? 'master');
  const [layerList, setLayerList] = useState<string[]>(['trail', 'fresh', 'storage']);
  // Decoded lazily, one player at a time, and kept per PlayerMap object (a refetch makes new ones).
  const cache = useRef(new WeakMap<PlayerMap, Decoded>());
  const [decodedFor, setDecoded] = useState<{ player: PlayerMap; shards: Decoded } | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<MapContainer[]>([]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    const hit = cache.current.get(player);
    if (hit !== undefined) {
      setDecoded({ player, shards: hit });
      return;
    }
    const views = Object.entries(player.shards) as [RecapShard, MapShardView][];
    Promise.all(views.map(async ([s, v]) => [s, await decodeShard(v)] as const))
      .then((pairs) => {
        const d: Decoded = Object.fromEntries(pairs);
        cache.current.set(player, d);
        if (live) setDecoded({ player, shards: d });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [player]);

  const layers = useMemo(() => {
    const has = (l: Layer) => layerList.includes(l);
    return { trail: has('trail'), fresh: has('fresh'), storage: has('storage') };
  }, [layerList]);
  // Never the previous player's shards under this player's name while these decode.
  const current = decodedFor?.player === player ? decodedFor.shards[shard] : undefined;
  const mine = player.isViewer;
  const whose = mine ? 'Your' : `${player.label}'s`;

  return (
    <Paper
      component="section"
      aria-label={`${world.displayName} map`}
      withBorder
      radius="md"
      p={{ base: 'sm', sm: 'md' }}
    >
      <Stack gap="sm">
        <Title order={4} style={WRAP}>
          {whose} map
          <Text span size="sm" c="dimmed" fw={400}>
            {' '}
            · {mapAsOfText(player.day, player.stoppedAt)}
          </Text>
        </Title>

        {map.maps.length > 1 && (
          <Select
            aria-label="Whose map"
            size="sm"
            allowDeselect={false}
            searchable={false}
            value={String(idx)}
            onChange={(v) => {
              if (v === null) return;
              const next = map.maps[Number(v)];
              setPlayerIdx(Number(v));
              setShard(next?.shards.master !== undefined ? 'master' : 'caves');
              setSelected([]);
            }}
            data={map.maps.map((m, i) => ({
              value: String(i),
              label: m.isViewer ? `${m.label} (you)` : m.label,
            }))}
          />
        )}

        {shards.length > 1 && (
          <SegmentedControl
            aria-label="Surface or caves"
            value={shard}
            onChange={(v) => {
              setShard(v as RecapShard);
              setSelected([]);
            }}
            data={shards.map((s) => ({ value: s, label: SHARD_LABEL[s] }))}
          />
        )}
        <Chip.Group
          multiple
          value={layerList}
          onChange={(v) => {
            setLayerList(v);
            if (!v.includes('storage')) setSelected([]);
          }}
        >
          <Group gap={6}>
            <Chip value="trail" size="xs">
              Trail
            </Chip>
            <Chip value="fresh" size="xs">
              New last session
            </Chip>
            <Chip value="storage" size="xs">
              Storage
            </Chip>
          </Group>
        </Chip.Group>

        {failed && (
          <Text size="sm" c="dimmed">
            Couldn&apos;t draw the map.
          </Text>
        )}
        {current !== undefined && (
          <MapCanvas
            shard={current}
            layers={layers}
            label={`${whose} map of the ${SHARD_LABEL[shard].toLowerCase()}: ${mine ? 'your' : 'their'} trail, ${current.containers.length} storage spots`}
            onTap={setSelected}
          />
        )}

        {selected.length > 0 && (
          <Paper withBorder radius="sm" p="xs" data-testid="map-selection">
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
              <Stack gap={2} style={{ minWidth: 0 }}>
                {selected.map((c, i) => (
                  <Text key={i} size="sm" style={WRAP}>
                    {containerText(c)}
                  </Text>
                ))}
              </Stack>
              <CloseButton size="sm" aria-label="Close" onClick={() => setSelected([])} />
            </Group>
          </Paper>
        )}

        <Group gap="sm" style={{ rowGap: 2 }}>
          <Text size="xs" c="dimmed">
            <Swatch color="#dfe6cf" />
            trail
          </Text>
          {current !== undefined && current.freshCount > 0 && (
            <Text size="xs" c="dimmed">
              <Swatch color={`rgb(${FRESH_RGB.join(',')})`} />
              {current.freshCount} new tiles
            </Text>
          )}
          <Text size="xs" c="dimmed">
            <Swatch color={STORAGE_COLOR} />
            storage
          </Text>
          <Text size="xs" c="dimmed">
            <Swatch color={STOP_COLOR} round />
            where {mine ? 'you' : player.label} stopped
          </Text>
        </Group>
        <Text size="xs" c="dimmed" style={WRAP}>
          Only what {mine ? 'you have' : `${player.label} has`} seen: everything within{' '}
          {map.revealRadius} tiles of where {mine ? 'you' : 'they'} walked (roughly the in-game
          fog). Tap a yellow square for what is in it.
        </Text>
      </Stack>
    </Paper>
  );
}

export interface MapSectionProps {
  world: WorldSummary;
  status: ClusterStatus;
}

/** Renders nothing until there is a map for this world (none yet, or still loading). */
export function MapSection({ world, status }: MapSectionProps) {
  const { data } = useWorldMap(world.worldId, status);
  if (data?.status !== 'ok') return null;
  return <MapPanel world={world} map={data} />;
}
