// One code path for the Lambda, `scripts/digest-session.ts`, `scripts/backfill-recaps.ts` and the
// prompt lab (docs/decisions.md §18): read one session's inputs through a `SessionSource`,
// digest it, optionally summarize it, and return the files to write under `digest/`. Writing is
// the caller's job, so a dry run is just "don't write".
import type { Recap, RecapPlayersFile, RecapSummaryMeta } from '@dst/shared';

import { digestSession } from './core/digest';
import type { DigestFile, ManifestLike } from './core/digest';
import type { SessionLogs } from './core/logs';
import type { PreviousSession } from './summary/context';
import type { PromptVariant } from './summary/prompts';
import { summarize } from './summary/summarize';

/** Read-only access to one world's sessions (S3 in prod, a local mirror offline). */
export interface SessionSource {
  /** Session ids of the world, ascending (they sort chronologically). */
  listSessions(worldId: string): Promise<string[]>;
  readManifest(worldId: string, sessionId: string): Promise<ManifestLike | null>;
  /** `master/server_log.txt` etc.; null when absent. */
  readText(worldId: string, sessionId: string, relPath: string): Promise<string | null>;
  /** `worlds/<w>/save.tar.zst` at a version; null when that version no longer exists. */
  readSaveVersion(worldId: string, versionId: string): Promise<Buffer | null>;
  /** A digest file already written for a session, or null. */
  readDigestFile(worldId: string, sessionId: string, name: string): Promise<Buffer | null>;
}

export interface NoteSource {
  /** The world's "next time" notes' texts, newest first. */
  getNotes(worldId: string): Promise<string[]>;
}

export interface PipelineInput {
  source: SessionSource;
  worldId: string;
  sessionId: string;
  note?: NoteSource | null;
  /** null/undefined/'' = no summary (marked unavailable, reason no_api_key). */
  apiKey?: string | null;
  /** false skips the LLM call entirely (summary.json reason 'disabled'). */
  summary?: boolean;
  variant?: PromptVariant;
  model?: string;
  now?: () => Date;
  /** How many earlier sessions to read for continuity. */
  historyDepth?: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface PipelineOutput {
  recap: Recap;
  players: RecapPlayersFile;
  summaryText: string | null;
  summaryMeta: RecapSummaryMeta;
  /** Everything to write, relative to `sessions/<w>/<s>/digest/`. */
  files: DigestFile[];
  context: string | null;
}

export class SessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInputError';
  }
}

function parseJson<T>(buf: Buffer | null): T | null {
  if (buf === null) return null;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

const LOG_FILES: Record<keyof SessionLogs, string> = {
  masterChat: 'master/server_chat_log.txt',
  cavesChat: 'caves/server_chat_log.txt',
  masterServer: 'master/server_log.txt',
  cavesServer: 'caves/server_log.txt',
};

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { source, worldId, sessionId } = input;
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => {});

  const manifest = await source.readManifest(worldId, sessionId);
  if (manifest === null)
    throw new SessionInputError(`no manifest.json for ${worldId}/${sessionId}`);

  const [before, after] = await Promise.all([
    manifest.preStartVersionId ? source.readSaveVersion(worldId, manifest.preStartVersionId) : null,
    manifest.postStopVersionId ? source.readSaveVersion(worldId, manifest.postStopVersionId) : null,
  ]);
  if (manifest.preStartVersionId && before === null)
    log({ event: 'save_version_missing', which: 'pre' });
  if (manifest.postStopVersionId && after === null)
    log({ event: 'save_version_missing', which: 'post' });

  const logs = Object.fromEntries(
    await Promise.all(
      (Object.keys(LOG_FILES) as (keyof SessionLogs)[]).map(async (k) => [
        k,
        await source.readText(worldId, sessionId, LOG_FILES[k]),
      ]),
    ),
  ) as unknown as SessionLogs;

  // Earlier sessions: continuity of the save chain, known players, and the summary history.
  const all = await source.listSessions(worldId);
  const earlier = all.filter((s) => s < sessionId);
  const depth = input.historyDepth ?? 3;
  const previousId = earlier.at(-1);
  const previousManifest =
    previousId !== undefined ? await source.readManifest(worldId, previousId) : null;
  const previous: PreviousSession[] = [];
  const knownPlayers: RecapPlayersFile['players'] = [];
  // (`slice(-0)` would be the whole list, so depth 0 must mean "none" explicitly.)
  for (const sid of depth > 0 ? earlier.slice(-depth) : []) {
    const recap = parseJson<Recap>(await source.readDigestFile(worldId, sid, 'recap.json'));
    const players = parseJson<RecapPlayersFile>(
      await source.readDigestFile(worldId, sid, 'players.json'),
    );
    for (const p of players?.players ?? []) {
      const i = knownPlayers.findIndex((k) => k.userdir !== null && k.userdir === p.userdir);
      if (i === -1) knownPlayers.push(p);
      else knownPlayers[i] = p; // newer session wins
    }
    if (recap === null) continue;
    const summaryMeta = parseJson<RecapSummaryMeta>(
      await source.readDigestFile(worldId, sid, 'summary.json'),
    );
    const summaryMd = await source.readDigestFile(worldId, sid, 'summary.md');
    previous.push({
      recap,
      summary:
        summaryMeta?.status === 'ok' && summaryMd !== null ? summaryMd.toString('utf8') : null,
    });
  }

  const notes = input.note ? await input.note.getNotes(worldId) : [];
  const digest = await digestSession({
    worldId,
    sessionId,
    manifest,
    before,
    after,
    logs,
    previousPostStopVersionId: previousManifest?.postStopVersionId ?? null,
    knownPlayers,
    notes,
    now: now(),
  });

  let summaryText: string | null = null;
  let summaryMeta: RecapSummaryMeta;
  let context: string | null = null;
  if (input.summary === false) {
    summaryMeta = {
      status: 'unavailable',
      reason: 'disabled',
      detail: null,
      promptVersion: input.variant?.version ?? 'none',
      generatedAt: now().toISOString(),
    };
  } else {
    const result = await summarize({
      recap: digest.recap,
      notes,
      previous,
      apiKey: input.apiKey,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      now,
    });
    summaryText = result.text;
    summaryMeta = result.meta;
    context = result.context;
  }

  const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v, null, 2) + '\n');
  const files: DigestFile[] = [
    { path: 'recap.json', body: json(digest.recap), contentType: 'application/json' },
    { path: 'players.json', body: json(digest.players), contentType: 'application/json' },
    ...digest.files,
    { path: 'summary.json', body: json(summaryMeta), contentType: 'application/json' },
  ];
  if (summaryText !== null) {
    files.push({
      path: 'summary.md',
      body: Buffer.from(summaryText + '\n'),
      contentType: 'text/markdown; charset=utf-8',
    });
  }
  return { recap: digest.recap, players: digest.players, summaryText, summaryMeta, files, context };
}
