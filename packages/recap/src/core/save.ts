// Picks the files the digest needs out of one `save.tar.zst` (docs/research/save-anatomy.md §1):
// per shard, the newest world snapshot, every snapshot's `.meta`, and every player directory's
// snapshots. Everything else in the archive (cluster.ini, shardindex, mod files, macOS `._*`
// AppleDouble twins from imported zips) is skipped without being copied.
import type { RecapShard } from '@dst/shared';

import { SaveFormatError } from './lua';
import { readSaveTarball } from './tar';
import type { TarEntry } from './tar';

const SHARD_DIRS: Record<string, RecapShard> = { Master: 'master', Caves: 'caves' };

// <Shard>/save/session/<16 hex>/<file> or /<userdir>/<file>
const SESSION_FILE_RE =
  /^(Master|Caves)\/save\/session\/([0-9A-F]{16})\/(?:([A-Z0-9]{8,16})\/)?(\d{10}(?:\.meta)?|savelocation)$/;

export interface PlayerDirFiles {
  userdir: string;
  /** snapshot number -> player file bytes */
  snapshots: Map<number, Buffer>;
  metas: Map<number, string>;
  savelocation: Buffer | null;
}

export interface ShardFiles {
  shard: RecapShard;
  sessionId: string; // the shard's 16-hex session directory
  newestWorld: { n: number; data: Buffer };
  metas: Map<number, string>; // world snapshot number -> `.meta` text
  players: Map<string, PlayerDirFiles>;
}

export type SaveFiles = Partial<Record<RecapShard, ShardFiles>>;

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function pickSaveFiles(entries: TarEntry[]): SaveFiles {
  // shard -> session id -> { worlds, metas, players }
  const bySession = new Map<
    string,
    {
      shard: RecapShard;
      sessionId: string;
      worlds: Map<number, Buffer>;
      metas: Map<number, string>;
      players: Map<string, PlayerDirFiles>;
    }
  >();

  for (const e of entries) {
    if (basename(e.path).startsWith('._')) continue;
    const m = SESSION_FILE_RE.exec(e.path);
    if (m === null) continue;
    const shardDir = m[1]!;
    const sessionId = m[2]!;
    const userdir = m[3];
    const file = m[4]!;
    const shard = SHARD_DIRS[shardDir]!;
    const key = `${shard}/${sessionId}`;
    let s = bySession.get(key);
    if (s === undefined) {
      s = { shard, sessionId, worlds: new Map(), metas: new Map(), players: new Map() };
      bySession.set(key, s);
    }

    if (userdir === undefined) {
      if (file === 'savelocation') continue;
      const n = parseInt(file, 10);
      if (file.endsWith('.meta')) s.metas.set(n, e.data.toString('utf8'));
      else s.worlds.set(n, e.data);
      continue;
    }

    let p = s.players.get(userdir);
    if (p === undefined) {
      p = { userdir, snapshots: new Map(), metas: new Map(), savelocation: null };
      s.players.set(userdir, p);
    }
    if (file === 'savelocation') p.savelocation = e.data;
    else if (file.endsWith('.meta')) p.metas.set(parseInt(file, 10), e.data.toString('utf8'));
    else p.snapshots.set(parseInt(file, 10), e.data);
  }

  const out: SaveFiles = {};
  for (const s of bySession.values()) {
    if (s.worlds.size === 0) continue; // a session dir with no world snapshot is not a world
    const newestN = Math.max(...s.worlds.keys());
    const existing = out[s.shard];
    // After a regeneration an old session directory can linger; the live one is the one holding
    // the newest snapshot. Two dirs with equally new snapshots cannot be told apart: refuse.
    if (existing !== undefined) {
      if (existing.newestWorld.n === newestN) {
        throw new SaveFormatError(`${s.shard}: two session directories with snapshot ${newestN}`);
      }
      if (existing.newestWorld.n > newestN) continue;
    }
    out[s.shard] = {
      shard: s.shard,
      sessionId: s.sessionId,
      newestWorld: { n: newestN, data: s.worlds.get(newestN)! },
      metas: s.metas,
      players: s.players,
    };
  }
  return out;
}

export function loadSaveFiles(compressed: Buffer): SaveFiles {
  const entries = readSaveTarball(compressed, (p) => SESSION_FILE_RE.test(p));
  const files = pickSaveFiles(entries);
  if (files.master === undefined) throw new SaveFormatError('save has no Master world snapshot');
  return files;
}
