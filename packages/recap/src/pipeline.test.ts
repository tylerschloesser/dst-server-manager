import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Recap, RecapPlayersFile, RecapSummaryMeta } from '@dst/shared';

import type { ManifestLike } from './core/digest';
import { SessionInputError, runPipeline } from './pipeline';
import type { SessionSource } from './pipeline';
import { PROMPT_VARIANTS } from './summary/prompts';
import { summarize } from './summary/summarize';
import {
  DIR,
  KU,
  MANIFEST,
  afterSaveSpec,
  beforeSaveSpec,
  scenarioLogs,
} from './test-support/scenario';
import { saveTarZst } from './test-support/synthetic';

// The real summarize, wrapped so a test can substitute one result (never a network call).
vi.mock('./summary/summarize', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./summary/summarize')>();
  return { ...mod, summarize: vi.fn(mod.summarize) };
});
const summarizeMock = vi.mocked(summarize);

const W = 'test-recap';
const S = MANIFEST.sessionId!; // 20260101T000000Z-abc123
const PREV = '20251231T000000Z-prev01';
const NOW = new Date('2026-01-01T02:00:00.000Z');

interface Memory extends SessionSource {
  reads: string[];
}

/** An in-memory bucket: `sessions/<w>/<s>/<rel>` text/buffers and save versions by id. */
function memorySource(
  objects: Record<string, string | Buffer>,
  versions: Record<string, Buffer>,
): Memory {
  const reads: string[] = [];
  const get = (key: string): Buffer | null => {
    reads.push(key);
    const v = objects[key];
    return v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(v);
  };
  return {
    reads,
    async listSessions(worldId) {
      const ids = new Set<string>();
      for (const k of Object.keys(objects)) {
        const m = new RegExp(`^sessions/${worldId}/([^/]+)/`).exec(k);
        if (m) ids.add(m[1]!);
      }
      return [...ids].sort();
    },
    async readManifest(w, s) {
      const b = get(`sessions/${w}/${s}/manifest.json`);
      return b === null ? null : (JSON.parse(b.toString()) as ManifestLike);
    },
    async readText(w, s, rel) {
      return get(`sessions/${w}/${s}/${rel}`)?.toString() ?? null;
    },
    async readSaveVersion(w, vid) {
      reads.push(`worlds/${w}/save.tar.zst@${vid}`);
      return versions[vid] ?? null;
    },
    async readDigestFile(w, s, name) {
      return get(`sessions/${w}/${s}/digest/${name}`);
    },
  };
}

const json = (v: unknown) => JSON.stringify(v);

function prevRecap(id: string): Recap {
  return {
    schemaVersion: 1,
    digestVersion: 'digest-1',
    worldId: W,
    sessionId: id,
    generatedAt: '2025-12-31T01:00:00.000Z',
    hasCaves: true,
    session: {
      startedAt: null,
      joinableAt: null,
      stoppedAt: null,
      stopReason: 'idle',
      realMinutes: 30,
      peakPlayers: 1,
      startedBy: null,
      dstBuildId: null,
    },
    continuous: null,
    status: 'ok',
    notes: [],
    time: { start: null, end: null, daysPassed: null, seasonChanges: [] },
    built: [],
    destroyed: [],
    storage: [],
    containers: [],
    deaths: [],
    players: [],
    noteAtDigest: null,
  };
}

const OK_META: RecapSummaryMeta = {
  status: 'ok',
  model: 'claude-opus-5',
  promptVersion: 'v-test',
  generatedAt: NOW.toISOString(),
  latencyMs: 1,
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0,
  contextSessions: [PREV],
};

const OLD = '20251230T000000Z-old000';

function world(over: { prevPostStop?: string; noDigest?: boolean; manifest?: ManifestLike } = {}) {
  const logs = scenarioLogs();
  const danFromEarlier: RecapPlayersFile = {
    schemaVersion: 1,
    players: [
      {
        ref: 'p1',
        ku: KU.dan,
        steamId64: '76561190000000044',
        persona: 'dan',
        userdir: DIR.dan,
      },
    ],
  };
  const objects: Record<string, string | Buffer> = {
    [`sessions/${W}/${PREV}/manifest.json`]: json({
      sessionId: PREV,
      postStopVersionId: over.prevPostStop ?? 'vPRE',
    }),
    [`sessions/${W}/${S}/manifest.json`]: json(over.manifest ?? MANIFEST),
    [`sessions/${W}/${S}/master/server_chat_log.txt`]: logs.masterChat!,
    [`sessions/${W}/${S}/caves/server_chat_log.txt`]: logs.cavesChat!,
    [`sessions/${W}/${S}/master/server_log.txt`]: logs.masterServer!,
    [`sessions/${W}/${S}/caves/server_log.txt`]: logs.cavesServer!,
    // an older session with a digest but no summary
    [`sessions/${W}/${OLD}/manifest.json`]: json({ sessionId: OLD, postStopVersionId: 'vOLD' }),
    [`sessions/${W}/${OLD}/digest/recap.json`]: json(prevRecap(OLD)),
    // a later session must never feed history
    [`sessions/${W}/20260102T000000Z-later1/manifest.json`]: json({ postStopVersionId: 'vLATER' }),
    [`sessions/${W}/20260102T000000Z-later1/digest/recap.json`]: json(
      prevRecap('20260102T000000Z-later1'),
    ),
  };
  if (!over.noDigest) {
    objects[`sessions/${W}/${PREV}/digest/recap.json`] = json(prevRecap(PREV));
    objects[`sessions/${W}/${PREV}/digest/players.json`] = json(danFromEarlier);
    objects[`sessions/${W}/${PREV}/digest/summary.json`] = json(OK_META);
    objects[`sessions/${W}/${PREV}/digest/summary.md`] = 'PREVIOUS SUMMARY TEXT\n';
  }
  const versions = {
    vPRE: saveTarZst(beforeSaveSpec()),
    vPOST: saveTarZst(afterSaveSpec()),
  };
  return memorySource(objects, versions);
}

afterEach(() => {
  summarizeMock.mockClear();
});

describe('runPipeline', () => {
  it('summary:false -> recap, players, trail and summary.json (disabled), no summary.md', async () => {
    const source = world();
    const out = await runPipeline({
      source,
      worldId: W,
      sessionId: S,
      summary: false,
      now: () => NOW,
    });
    const paths = out.files.map((f) => f.path);
    expect(paths[0]).toBe('recap.json');
    expect(paths[1]).toBe('players.json');
    expect(paths.at(-1)).toBe('summary.json');
    expect(paths).not.toContain('summary.md');
    expect(paths.filter((p) => p.startsWith('trail/'))).toContain('trail/index.json');
    expect(out.summaryMeta).toEqual({
      status: 'unavailable',
      reason: 'disabled',
      detail: null,
      promptVersion: 'none',
      generatedAt: NOW.toISOString(),
    });
    expect(out.summaryText).toBeNull();
    expect(out.context).toBeNull();
    expect(summarizeMock).not.toHaveBeenCalled();
    // the bodies are the JSON of what is returned
    const body = (p: string) => out.files.find((f) => f.path === p)!;
    expect(JSON.parse(body('recap.json').body.toString())).toEqual(out.recap);
    expect(JSON.parse(body('players.json').body.toString())).toEqual(out.players);
    expect(body('recap.json').contentType).toBe('application/json');
    // recap.json never carries an account id
    expect(body('recap.json').body.toString()).not.toContain('KU_');
  });

  it('summary:false with a variant records that variant’s version', async () => {
    const variant = PROMPT_VARIANTS['prose']!;
    const out = await runPipeline({
      source: world(),
      worldId: W,
      sessionId: S,
      summary: false,
      variant,
    });
    expect(out.summaryMeta.promptVersion).toBe(variant.version);
  });

  it('no API key -> summary.json no_api_key, no summary.md, never a network call', async () => {
    const out = await runPipeline({ source: world(), worldId: W, sessionId: S, apiKey: null });
    expect(out.summaryMeta).toMatchObject({ status: 'unavailable', reason: 'no_api_key' });
    expect(out.files.map((f) => f.path)).not.toContain('summary.md');
    expect(summarizeMock).toHaveBeenCalledTimes(1);
  });

  it('an ok summary adds summary.md; history feeds summaries, the note and known players', async () => {
    summarizeMock.mockResolvedValueOnce({ text: 'NEW SUMMARY', meta: OK_META, context: 'CTX' });
    const out = await runPipeline({
      source: world(),
      worldId: W,
      sessionId: S,
      apiKey: 'test-key-not-real',
      note: { getNotes: async () => ['finish the farm', 'feed the beefalo'] },
      model: 'claude-haiku-4-5',
      now: () => NOW,
    });
    const md = out.files.find((f) => f.path === 'summary.md')!;
    expect(md.body.toString()).toBe('NEW SUMMARY\n');
    expect(md.contentType).toBe('text/markdown; charset=utf-8');
    expect(out.files.at(-2)!.path).toBe('summary.json');
    expect(out.summaryText).toBe('NEW SUMMARY');
    expect(out.context).toBe('CTX');

    const call = summarizeMock.mock.calls[0]![0];
    expect(call.apiKey).toBe('test-key-not-real');
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.notes).toEqual(['finish the farm', 'feed the beefalo']);
    // oldest first; the older session has no summary
    expect(call.previous).toEqual([
      { recap: prevRecap(OLD), summary: null },
      { recap: prevRecap(PREV), summary: 'PREVIOUS SUMMARY TEXT\n' },
    ]);
    expect(out.recap.noteAtDigest).toBe('finish the farm\nfeed the beefalo');
    // dan has no log lines this session; the earlier players.json names him
    expect(out.recap.players.map((p) => p.persona)).toEqual(['alice', 'bob', 'dan']);
    expect(out.players.players[2]).toMatchObject({ ku: KU.dan, userdir: DIR.dan });
    expect(out.recap.continuous).toBe(true);
  });

  it('a previous summary that was not ok is passed as null (its fact sheet is used)', async () => {
    const source = world();
    const failed: RecapSummaryMeta = {
      status: 'unavailable',
      reason: 'api_error',
      detail: null,
      promptVersion: 'x',
      generatedAt: NOW.toISOString(),
    };
    const orig = source.readDigestFile.bind(source);
    source.readDigestFile = async (w, s, name) =>
      name === 'summary.json' ? Buffer.from(json(failed)) : orig(w, s, name);
    await runPipeline({ source, worldId: W, sessionId: S, apiKey: null });
    expect(summarizeMock.mock.calls[0]![0].previous).toEqual([
      { recap: prevRecap(OLD), summary: null },
      { recap: prevRecap(PREV), summary: null },
    ]);
  });

  it('without the previous digest: only older history, no known players', async () => {
    await runPipeline({
      source: world({ noDigest: true }),
      worldId: W,
      sessionId: S,
      apiKey: null,
    });
    expect(summarizeMock.mock.calls[0]![0].previous).toEqual([
      { recap: prevRecap(OLD), summary: null },
    ]);
  });

  it('continuity comes from the previous session’s manifest', async () => {
    const out = await runPipeline({
      source: world({ prevPostStop: 'vSOMETHING-ELSE' }),
      worldId: W,
      sessionId: S,
      summary: false,
    });
    expect(out.recap.continuous).toBe(false);
  });

  it('reads at most historyDepth earlier sessions, and never later ones', async () => {
    const source = world();
    const out = await runPipeline({
      source,
      worldId: W,
      sessionId: S,
      summary: false,
      historyDepth: 0,
    });
    expect(source.reads.some((k) => k.includes(`${PREV}/digest/`))).toBe(false);
    expect(source.reads.some((k) => k.includes('later1/digest/'))).toBe(false);
    // without history dan is anonymous
    expect(out.recap.players.map((p) => p.persona)).toEqual(['alice', 'bob', null]);
  });

  it('historyDepth 1 reads only the newest earlier session', async () => {
    const source = world();
    await runPipeline({ source, worldId: W, sessionId: S, apiKey: null, historyDepth: 1 });
    expect(summarizeMock.mock.calls[0]![0].previous.map((p) => p.recap.sessionId)).toEqual([PREV]);
    expect(source.reads.some((k) => k.includes(`${OLD}/digest/`))).toBe(false);
  });

  it('corrupt earlier digest JSON is ignored, not fatal', async () => {
    const source = world();
    source.readDigestFile = async () => Buffer.from('{not json');
    const out = await runPipeline({ source, worldId: W, sessionId: S, summary: false });
    expect(out.recap.status).toBe('ok');
  });

  it('a missing manifest is a SessionInputError', async () => {
    await expect(
      runPipeline({ source: world(), worldId: W, sessionId: '20990101T000000Z-nope00' }),
    ).rejects.toBeInstanceOf(SessionInputError);
  });

  it('a save version that no longer exists -> logged, partial recap, no throw', async () => {
    const events: Record<string, unknown>[] = [];
    const out = await runPipeline({
      source: world({ manifest: { ...MANIFEST, postStopVersionId: 'vGONE' } }),
      worldId: W,
      sessionId: S,
      summary: false,
      log: (e) => events.push(e),
    });
    expect(events).toContainEqual({ event: 'save_version_missing', which: 'post' });
    expect(out.recap.status).toBe('partial');
    expect(out.files.map((f) => f.path)).toEqual(['recap.json', 'players.json', 'summary.json']);
  });

  it('a manifest without version ids reads no save at all', async () => {
    const source = world({
      manifest: { ...MANIFEST, preStartVersionId: null, postStopVersionId: null },
    });
    const events: Record<string, unknown>[] = [];
    const out = await runPipeline({
      source,
      worldId: W,
      sessionId: S,
      summary: false,
      log: (e) => events.push(e),
    });
    expect(source.reads.some((k) => k.startsWith('worlds/'))).toBe(false);
    expect(events).toEqual([]);
    expect(out.recap.status).toBe('partial');
  });
});
