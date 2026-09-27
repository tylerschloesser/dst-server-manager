#!/usr/bin/env -S pnpm tsx
// scripts/digest-session.ts — docs/decisions.md §18, docs/testing.md §7. Digests ONE session and
// prints its recap.json: the same `runPipeline` the digest Lambda runs. Read-only against AWS:
// it never writes to S3 (the backfill does that, behind --write).
//
//   AWS_PROFILE=admin pnpm tsx scripts/digest-session.ts --world-id tylerni2026 --session-id <id>
//   pnpm tsx scripts/digest-session.ts --from-dir <mirror> --world-id <w> --session-id <id> --summary
import { WORLD_ID_RE } from '@dst/shared';

// No AWS client is constructed until main() has passed the --help and AWS_PROFILE checks.
import {
  MODELS,
  PROMPT_VARIANTS,
  createFsSource,
  runPipeline,
  writeDigestLocally,
} from '@dst/recap';
import type { SessionSource } from '@dst/recap';

export const USAGE = `Usage: pnpm tsx scripts/digest-session.ts --world-id <id> --session-id <id>
  [--from-dir <dir>] [--summary] [--variant <id>] [--model <id>] [--out <dir>] [--help]

Digests one session and prints its recap.json to stdout (docs/decisions.md §18). With --summary
the output is { recap, summary, summaryMeta } and the LLM "where you left off" summary is
generated too (key from ANTHROPIC_API_KEY; without it the summary is marked unavailable and the
recap is still printed). Never writes to S3.

Flags:
  --world-id <id>     required.
  --session-id <id>   required, e.g. 20260927T033435Z-776769.
  --from-dir <dir>    offline: read a local mirror instead of S3 (no credentials needed).
                        <dir>/sessions/<w>/<s>/{manifest.json,master/…,caves/…}
                        <dir>/worlds/<w>/<versionId>.tar.zst   (one file per save version)
                      Earlier digests for continuity are read from <dir>/sessions/<w>/<s>/digest/.
                      Without it: reads S3 (AWS_PROFILE=admin), read-only.
  --summary           also run the LLM summary.
  --variant <id>      prompt variant (default: the committed default). One of:
                        ${Object.keys(PROMPT_VARIANTS).join(', ')}
  --model <id>        one of: ${Object.keys(MODELS).join(', ')}
  --out <dir>         also write every digest file under <dir>/sessions/<w>/<s>/digest/ (local).
  --help              print this message and exit 0. Makes no AWS call.
`;

export interface DigestSessionArgs {
  help: false;
  worldId: string;
  sessionId: string;
  fromDir: string | null;
  summary: boolean;
  variant: string | null;
  model: string | null;
  out: string | null;
}

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): { help: true } | DigestSessionArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const a: DigestSessionArgs = {
    help: false,
    worldId: '',
    sessionId: '',
    fromDir: null,
    summary: false,
    variant: null,
    model: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === '--world-id') a.worldId = value(argv, ++i, f);
    else if (f === '--session-id') a.sessionId = value(argv, ++i, f);
    else if (f === '--from-dir') a.fromDir = value(argv, ++i, f);
    else if (f === '--summary') a.summary = true;
    else if (f === '--variant') a.variant = value(argv, ++i, f);
    else if (f === '--model') a.model = value(argv, ++i, f);
    else if (f === '--out') a.out = value(argv, ++i, f);
    else throw new Error(`unknown argument ${f}`);
  }
  if (!WORLD_ID_RE.test(a.worldId))
    throw new Error(`--world-id is required and must match ${WORLD_ID_RE.source}`);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(a.sessionId)) throw new Error('--session-id is required');
  if (a.variant !== null && PROMPT_VARIANTS[a.variant] === undefined)
    throw new Error(`unknown --variant ${a.variant}`);
  if (a.model !== null && MODELS[a.model] === undefined)
    throw new Error(`unknown --model ${a.model}`);
  return a;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let source: SessionSource;
  if (parsed.fromDir !== null) {
    source = createFsSource(parsed.fromDir);
  } else {
    if (process.env['AWS_PROFILE'] !== 'admin') {
      process.stderr.write('REFUSED: reading S3 needs AWS_PROFILE=admin (or pass --from-dir)\n');
      return 2;
    }
    const aws = await import('@dst/recap/aws');
    source = aws.createS3Source(aws.createS3Client(), (e: Record<string, unknown>) =>
      process.stderr.write(JSON.stringify(e) + '\n'),
    );
  }

  const out = await runPipeline({
    source,
    worldId: parsed.worldId,
    sessionId: parsed.sessionId,
    summary: parsed.summary,
    apiKey: process.env['ANTHROPIC_API_KEY'] ?? null,
    ...(parsed.variant !== null ? { variant: PROMPT_VARIANTS[parsed.variant]! } : {}),
    ...(parsed.model !== null ? { model: parsed.model } : {}),
    log: (e) => process.stderr.write(JSON.stringify(e) + '\n'),
  });
  if (parsed.out !== null) {
    const dir = await writeDigestLocally(parsed.out, parsed.worldId, parsed.sessionId, out.files);
    process.stderr.write(`wrote ${out.files.length} files to ${dir}\n`);
  }
  const body = parsed.summary
    ? { recap: out.recap, summary: out.summaryText, summaryMeta: out.summaryMeta }
    : out.recap;
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  return 0;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`digest-session: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
