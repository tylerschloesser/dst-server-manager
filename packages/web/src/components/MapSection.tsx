// docs/web.md §3 Map (docs/decisions.md §19): the viewer's own map, directly under the recap.
// The API has already cut it to their reveal; this draws it. One pixel per tile is painted once
// into an offscreen canvas, then redrawn scaled (no smoothing) on every pan/zoom, with the markers
// on top at a fixed on-screen size so they stay tappable when zoomed out.
//
// Touch: one finger pans, two pinch; a short tap near storage lists what is in it. Mouse: drag,
// wheel to zoom. Buttons do the same for anyone who can do neither.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ActionIcon,
  Chip,
  CloseButton,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconFocusCentered, IconHome, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import type {
  ClusterStatus,
  MapContainer,
  MapResponse,
  MapShardView,
  RecapShard,
  WorldSummary,
} from '@dst/shared';
import { useWorldMap } from '../api/map';
import {
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
  revealedBounds,
  screenToTile,
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

  const bounds = useMemo(() => revealedBounds(shard), [shard]);
  const minScale = Math.min(width / shard.width, height / shard.height) * 0.8 || 0.1;
  const fit = (): MapView | null =>
    bounds !== null && width > 0 ? fitView(bounds, width, height) : null;

  // A new shard (or the first real size) starts fitted to what the viewer has seen.
  const fittedFor = useRef<DecodedShard | null>(null);
  useEffect(() => {
    if (width === 0 || fittedFor.current === shard) return;
    fittedFor.current = shard;
    setView(bounds !== null ? fitView(bounds, width, height) : null);
  }, [shard, bounds, width, height]);

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
    ctx.drawImage(terrain, view.ox, view.oy, shard.width * s, shard.height * s);
    const at = (tx: number, ty: number) => [view.ox + (tx + 0.5) * s, view.oy + (ty + 0.5) * s];

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
        {shard.base !== null && (
          <ActionIcon
            variant="default"
            aria-label="Centre on base"
            onClick={() =>
              setView(centreOn(shard.base!, Math.max(view?.scale ?? 0, 10), width, height))
            }
          >
            <IconHome size={18} />
          </ActionIcon>
        )}
        <ActionIcon
          variant="default"
          aria-label="Fit what you have explored"
          onClick={() => setView(fit())}
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

function MapPanel({
  world,
  map,
}: {
  world: WorldSummary;
  map: Extract<MapResponse, { status: 'ok' }>;
}) {
  const shards = (['master', 'caves'] as const).filter((s) => map.shards[s] !== undefined);
  const [shard, setShard] = useState<RecapShard>(shards[0] ?? 'master');
  const [layerList, setLayerList] = useState<string[]>(['trail', 'fresh', 'storage']);
  const [decoded, setDecoded] = useState<Partial<Record<RecapShard, DecodedShard>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<MapContainer[]>([]);

  useEffect(() => {
    let live = true;
    setDecoded(null);
    setFailed(false);
    const views = Object.entries(map.shards) as [RecapShard, MapShardView][];
    Promise.all(views.map(async ([s, v]) => [s, await decodeShard(v)] as const))
      .then((pairs) => {
        if (live) setDecoded(Object.fromEntries(pairs));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [map]);

  const layers = useMemo(() => {
    const has = (l: Layer) => layerList.includes(l);
    return { trail: has('trail'), fresh: has('fresh'), storage: has('storage') };
  }, [layerList]);
  const current = decoded?.[shard];

  return (
    <Paper
      component="section"
      aria-label={`${world.displayName} map`}
      withBorder
      radius="md"
      p="md"
    >
      <Stack gap="sm">
        <Title order={4}>
          Your map
          <Text span size="sm" c="dimmed" fw={400}>
            {' '}
            · {mapAsOfText(map.day, map.stoppedAt)}
          </Text>
        </Title>

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
            label={`Your map of the ${SHARD_LABEL[shard].toLowerCase()}: your trail, ${current.containers.length} storage spots`}
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
            where you stopped
          </Text>
        </Group>
        <Text size="xs" c="dimmed" style={WRAP}>
          Only what you have seen: everything within {map.revealRadius} tiles of where you walked
          (roughly the in-game fog). Tap a yellow square for what is in it.
        </Text>
      </Stack>
    </Paper>
  );
}

export interface MapSectionProps {
  world: WorldSummary;
  status: ClusterStatus;
}

/** Renders nothing until there is a map for this viewer (none yet, or still loading). */
export function MapSection({ world, status }: MapSectionProps) {
  const { data } = useWorldMap(world.worldId, status);
  if (data?.status !== 'ok') return null;
  return <MapPanel world={world} map={data} />;
}
