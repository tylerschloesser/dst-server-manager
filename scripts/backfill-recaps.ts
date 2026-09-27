#!/usr/bin/env -S pnpm tsx
// scripts/backfill-recaps.ts — docs/decisions.md §18, docs/storage.md §8. Digests every session of
// a world in chronological order (so each LLM summary sees the ones before it) and, only with
// --write, uploads `sessions/<w>/<s>/digest/*`. DRY RUN BY DEFAULT.
//
// Time-sensitive: a digest needs the session's before/after save VERSIONS, and `worlds/` keeps
// noncurrent versions for 30 days once 10 newer exist (docs/storage.md §2) — for tylerni2026 the
// oldest start expiring ~2026-10-21. A session whose versions are gone digests as 'partial'.
import { WORLD_ID_RE } from '@dst/shared';
import type { RecapSummaryMeta } from '@dst/shared';

import {
  MODELS,
  PROMPT_VARIANTS,
  SaveFormatError,
  createFsSource,
  runPipeline,
  writeDigestLocally,
} from '@dst/recap';
import type { DigestFile, SessionSource } from '@dst/recap';

export const USAGE = `Usage: pnpm tsx scripts/backfill-recaps.ts --world-id <id> [--from-dir <dir>] [--write]
  [--summaries] [--force] [--sessions <id,…>] [--out <dir>] [--variant <id>] [--model <id>] [--help]

Digests every session of a world, oldest first (docs/decisions.md §18). DRY RUN unless --write:
prints what each session digests to and writes nothing to S3.

Flags:
  --world-id <id>    required.
  --from-dir <dir>   offline: read a local mirror (layout: scripts/digest-session.ts --help).
                     Cannot be combined with --write. Without it: reads S3 with AWS_PROFILE=admin.
  --write            upload each session's files to s3://…/sessions/<w>/<s>/digest/ — and nowhere
                     else: any other key is refused before the first upload.
  --summaries        also generate the LLM summaries (ANTHROPIC_API_KEY from the environment),
                     in order, each fed the previous sessions' summaries.
  --force            redo sessions that already have a digest. Without it a session is skipped
                     when its digest exists (and, with --summaries, already has an ok summary).
                     Without --summaries an existing summary is never overwritten, so
                     --write --force re-digests the facts and keeps the paid-for summaries.
  --sessions <list>  only these session ids (comma-separated); earlier digests are still read.
  --out <dir>        also write the files locally under <dir>/sessions/<w>/<s>/digest/.
  --variant <id>     prompt variant (default: the committed default).
  --model <id>       one of: ${Object.keys(MODELS).join(', ')}
  --help             print this message and exit 0. Makes no AWS or network call.

The "next time" note is NOT applied to past sessions (it describes the future, not those days).
Exit code 1 if any session failed to digest.
`;

export interface BackfillArgs {
  help: false;
  worldId: string;
  fromDir: string | null;
  write: boolean;
  summaries: boolean;
  force: boolean;
  sessions: string[] | null;
  out: string | null;
  variant: string | null;
  model: string | null;
}

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): { help: true } | BackfillArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const a: BackfillArgs = {
    help: false,
    worldId: '',
    fromDir: null,
    write: false,
    summaries: false,
    force: false,
    sessions: null,
    out: null,
    variant: null,
    model: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === '--world-id') a.worldId = value(argv, ++i, f);
    else if (f === '--from-dir') a.fromDir = value(argv, ++i, f);
    else if (f === '--write') a.write = true;
    else if (f === '--summaries') a.summaries = true;
    else if (f === '--force') a.force = true;
    else if (f === '--sessions') a.sessions = value(argv, ++i, f).split(',');
    else if (f === '--out') a.out = value(argv, ++i, f);
    else if (f === '--variant') a.variant = value(argv, ++i, f);
    else if (f === '--model') a.model = value(argv, ++i, f);
    else throw new Error(`unknown argument ${f}`);
  }
  if (!WORLD_ID_RE.test(a.worldId))
    throw new Error(`--world-id is required and must match ${WORLD_ID_RE.source}`);
  if (a.write && a.fromDir !== null)
    throw new Error('--write uploads to S3 and cannot be combined with --from-dir');
  if (a.variant !== null && PROMPT_VARIANTS[a.variant] === undefined)
    throw new Error(`unknown --variant ${a.variant}`);
  if (a.model !== null && MODELS[a.model] === undefined)
    throw new Error(`unknown --model ${a.model}`);
  return a;
}

/** Digests produced earlier in this run, visible to later sessions (continuity in a dry run). */
export function withOverlay(source: SessionSource, overlay: Map<string, Buffer>): SessionSource {
  return {
    ...source,
    async readDigestFile(worldId, sessionId, name) {
      return (
        overlay.get(`${worldId}/${sessionId}/${name}`) ??
        source.readDigestFile(worldId, sessionId, name)
      );
    },
  };
}

/** True when the session needs (re)digesting. */
export async function needsDigest(
  source: SessionSource,
  worldId: string,
  sessionId: string,
  opts: { force: boolean; summaries: boolean },
): Promise<boolean> {
  if (opts.force) return true;
  const recap = await source.readDigestFile(worldId, sessionId, 'recap.json');
  if (recap === null) return true;
  if (!opts.summaries) return false;
  const meta = await source.readDigestFile(worldId, sessionId, 'summary.json');
  try {
    return meta === null || (JSON.parse(meta.toString('utf8')) as RecapSummaryMeta).status !== 'ok';
  } catch {
    return true;
  }
}

const SUMMARY_FILES = new Set(['summary.json', 'summary.md']);

/** Without --summaries the pipeline marks the summary `disabled`; uploading that over a session
 *  that already has one would throw away a paid-for summary to re-digest the facts (e.g. a digest
 *  version bump that only adds the map). So an existing summary is kept, untouched. */
export function withoutSummaryOverwrite(
  files: DigestFile[],
  opts: { summaries: boolean; existingSummary: boolean },
): { files: DigestFile[]; kept: boolean } {
  if (opts.summaries || !opts.existingSummary) return { files, kept: false };
  return { files: files.filter((f) => !SUMMARY_FILES.has(f.path)), kept: true };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = (e: Record<string, unknown>) => process.stderr.write(JSON.stringify(e) + '\n');

  let source: SessionSource;
  let upload: ((w: string, s: string, files: DigestFile[]) => Promise<string[]>) | null = null;
  if (args.fromDir !== null) {
    source = createFsSource(args.fromDir);
  } else {
    if (process.env['AWS_PROFILE'] !== 'admin') {
      process.stderr.write('REFUSED: reading S3 needs AWS_PROFILE=admin (or pass --from-dir)\n');
      return 2;
    }
    const aws = await import('@dst/recap/aws');
    const s3 = aws.createS3Client();
    source = aws.createS3Source(s3, log);
    if (args.write) upload = aws.createS3DigestWriter(s3);
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? null;
  if (args.summaries && (apiKey === null || apiKey === '')) {
    process.stderr.write('REFUSED: --summaries needs ANTHROPIC_API_KEY in the environment\n');
    return 2;
  }

  const overlay = new Map<string, Buffer>();
  const layered = withOverlay(source, overlay);
  const all = await source.listSessions(args.worldId);
  const targets = args.sessions ?? all;
  for (const s of targets)
    if (!all.includes(s)) throw new Error(`no session ${s} for ${args.worldId}`);
  process.stdout.write(
    `${args.write ? 'WRITE' : 'DRY RUN'}: ${targets.length} of ${all.length} sessions of ${args.worldId}` +
      `${args.summaries ? ', with summaries' : ''}\n`,
  );

  let failed = 0;
  let totalCost = 0;
  for (const sessionId of all) {
    if (!targets.includes(sessionId)) continue;
    if (!(await needsDigest(source, args.worldId, sessionId, args))) {
      process.stdout.write(`${sessionId}  skip (digest exists; --force to redo)\n`);
      continue;
    }
    try {
      const out = await runPipeline({
        source: layered,
        worldId: args.worldId,
        sessionId,
        summary: args.summaries,
        apiKey,
        ...(args.variant !== null ? { variant: PROMPT_VARIANTS[args.variant]! } : {}),
        ...(args.model !== null ? { model: args.model } : {}),
        log: (e) => log({ sessionId, ...e }),
      });
      for (const f of out.files) overlay.set(`${args.worldId}/${sessionId}/${f.path}`, f.body);
      if (args.out !== null) await writeDigestLocally(args.out, args.worldId, sessionId, out.files);
      const { files, kept } = withoutSummaryOverwrite(out.files, {
        summaries: args.summaries,
        existingSummary:
          (await source.readDigestFile(args.worldId, sessionId, 'summary.json')) !== null,
      });
      let wrote = 'dry';
      if (upload !== null) wrote = `wrote ${(await upload(args.worldId, sessionId, files)).length}`;
      const r = out.recap;
      const m = out.summaryMeta;
      if (m.status === 'ok' && m.costUsd !== null) totalCost += m.costUsd;
      process.stdout.write(
        `${sessionId}  ${r.status.padEnd(7)} days ${r.time.start?.day ?? '?'}->${r.time.end?.day ?? '?'}` +
          `  players ${r.players.length}  built ${r.built.length}  deaths ${r.deaths.length}` +
          `  continuous ${String(r.continuous)}  summary ${kept ? 'kept' : m.status === 'ok' ? `ok $${m.costUsd}` : m.reason}` +
          `  ${wrote}${r.notes.length > 0 ? `  notes: ${r.notes.join(' | ')}` : ''}\n`,
      );
    } catch (err) {
      failed++;
      const why =
        err instanceof SaveFormatError
          ? `save format: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      process.stdout.write(`${sessionId}  FAILED ${why}\n`);
    }
  }
  process.stdout.write(
    `done: ${failed} failed${args.summaries ? `, LLM cost $${totalCost.toFixed(4)}` : ''}\n`,
  );
  return failed > 0 ? 1 : 0;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(
        `backfill-recaps: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
