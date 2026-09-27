#!/usr/bin/env -S pnpm tsx
// scripts/recap-prompt-lab.ts — docs/testing.md §7. Runs prompt variants × models over real,
// already-downloaded sessions and writes the outputs side by side, so a prompt change can be
// judged on real play before it becomes the default in packages/recap/src/summary/prompts.ts.
//
// Offline except for the Anthropic API (key from ANTHROPIC_API_KEY, never printed). The output
// directory must be OUTSIDE the repo: summaries of real sessions are never committed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORLD_ID_RE } from '@dst/shared';
import type { Recap } from '@dst/shared';

import {
  DEFAULT_MODEL,
  MODELS,
  PROMPT_VARIANTS,
  createFsSource,
  runPipeline,
  summarize,
} from '@dst/recap';
import type { PreviousSession } from '@dst/recap';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `Usage: pnpm tsx scripts/recap-prompt-lab.ts --data <dir> --world-id <id> --out <dir>
  [--sessions <id,id,…|all|last:N>] [--variants <id,…|all>] [--models <id,…>] [--chain] [--help]

Summarizes real sessions with several prompt variants and models and writes the results side by
side into --out (docs/testing.md §7). Digests are computed locally from --data (the same layout
as scripts/digest-session.ts --from-dir) and cached in <out>/_digests.

Flags:
  --data <dir>        local mirror: <dir>/sessions/<w>/<s>/…, <dir>/worlds/<w>/<versionId>.tar.zst
  --world-id <id>     required.
  --out <dir>         required; must be outside the repository.
  --sessions <list>   comma-separated session ids, "all" (default) or "last:N".
  --variants <list>   comma-separated, or "all" (default). Known: ${Object.keys(PROMPT_VARIANTS).join(', ')}
  --models <list>     comma-separated (default ${DEFAULT_MODEL}). Known: ${Object.keys(MODELS).join(', ')}
  --chain             continuity: each variant×model sees ITS OWN summaries of the earlier sessions
                      (as the Lambda would). Without it, earlier sessions are passed as fact sheets
                      only (previous summaries unknown).
  --help              print this message and exit 0. Makes no network call.

Needs ANTHROPIC_API_KEY. Output: <out>/<variant>@<model>/<session>.{md,context.txt,meta.json},
<out>/compare/<session>.md (all variants side by side) and <out>/report.tsv (tokens, latency, $).
`;

export interface LabArgs {
  help: false;
  data: string;
  worldId: string;
  out: string;
  sessions: string;
  variants: string[];
  models: string[];
  chain: boolean;
}

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): { help: true } | LabArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let data = '';
  let worldId = '';
  let out = '';
  let sessions = 'all';
  let variants = 'all';
  let models = DEFAULT_MODEL;
  let chain = false;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === '--data') data = value(argv, ++i, f);
    else if (f === '--world-id') worldId = value(argv, ++i, f);
    else if (f === '--out') out = value(argv, ++i, f);
    else if (f === '--sessions') sessions = value(argv, ++i, f);
    else if (f === '--variants') variants = value(argv, ++i, f);
    else if (f === '--models') models = value(argv, ++i, f);
    else if (f === '--chain') chain = true;
    else throw new Error(`unknown argument ${f}`);
  }
  if (data === '') throw new Error('--data is required');
  if (!WORLD_ID_RE.test(worldId)) throw new Error('--world-id is required');
  if (out === '') throw new Error('--out is required');
  const outAbs = path.resolve(out);
  if (outAbs === REPO_ROOT || outAbs.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(
      '--out must be outside the repository (real-session summaries are never committed)',
    );
  }
  const variantList = variants === 'all' ? Object.keys(PROMPT_VARIANTS) : variants.split(',');
  for (const v of variantList)
    if (PROMPT_VARIANTS[v] === undefined) throw new Error(`unknown variant ${v}`);
  const modelList = models.split(',');
  for (const m of modelList) if (MODELS[m] === undefined) throw new Error(`unknown model ${m}`);
  return {
    help: false,
    data,
    worldId,
    out: outAbs,
    sessions,
    variants: variantList,
    models: modelList,
    chain,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write('REFUSED: ANTHROPIC_API_KEY is not set\n');
    return 2;
  }
  const digestRoot = path.join(parsed.out, '_digests');
  const source = createFsSource(parsed.data, digestRoot);
  const all = await source.listSessions(parsed.worldId);
  let chosen: string[];
  if (parsed.sessions === 'all') chosen = all;
  else if (parsed.sessions.startsWith('last:'))
    chosen = all.slice(-Number(parsed.sessions.slice(5)));
  else chosen = parsed.sessions.split(',');
  for (const s of chosen) if (!all.includes(s)) throw new Error(`no session ${s} under --data`);

  // 1. Digests for every session up to the last chosen one (continuity needs the earlier ones).
  const lastIndex = Math.max(...chosen.map((s) => all.indexOf(s)));
  const recaps = new Map<string, Recap>();
  for (const sid of all.slice(0, lastIndex + 1)) {
    const cached = path.join(digestRoot, 'sessions', parsed.worldId, sid, 'digest', 'recap.json');
    try {
      recaps.set(sid, JSON.parse(await readFile(cached, 'utf8')) as Recap);
      continue;
    } catch {
      // not cached yet
    }
    const out = await runPipeline({
      source,
      worldId: parsed.worldId,
      sessionId: sid,
      summary: false,
    });
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, JSON.stringify(out.recap, null, 2));
    await writeFile(
      path.join(path.dirname(cached), 'players.json'),
      JSON.stringify(out.players, null, 2),
    );
    recaps.set(sid, out.recap);
    process.stderr.write(`digested ${sid}\n`);
  }

  // 2. Summaries.
  const report: string[] = [
    'variant\tmodel\tsession\tstatus\tinput\toutput\tlatency_ms\tcost_usd\twords',
  ];
  const compare = new Map<string, string[]>();
  for (const variantId of parsed.variants) {
    const variant = PROMPT_VARIANTS[variantId]!;
    for (const model of parsed.models) {
      const dir = path.join(parsed.out, `${variantId}@${model}`);
      await mkdir(dir, { recursive: true });
      const own = new Map<string, string | null>(); // this variant×model's summaries so far
      const sessions = parsed.chain ? all.slice(0, lastIndex + 1) : chosen;
      for (const sid of sessions) {
        const idx = all.indexOf(sid);
        const previous: PreviousSession[] = all.slice(Math.max(0, idx - 3), idx).map((p) => ({
          recap: recaps.get(p)!,
          summary: parsed.chain ? (own.get(p) ?? null) : null,
        }));
        const r = await summarize({
          recap: recaps.get(sid)!,
          note: null,
          previous,
          apiKey,
          variant,
          model,
        });
        own.set(sid, r.text);
        await writeFile(
          path.join(dir, `${sid}.md`),
          r.text ?? `(unavailable: ${JSON.stringify(r.meta)})\n`,
        );
        await writeFile(
          path.join(dir, `${sid}.context.txt`),
          `${variant.system}\n\n----- user -----\n\n${r.context ?? ''}`,
        );
        await writeFile(path.join(dir, `${sid}.meta.json`), JSON.stringify(r.meta, null, 2));
        const m = r.meta;
        const words = r.text?.split(/\s+/).filter(Boolean).length ?? 0;
        report.push(
          m.status === 'ok'
            ? `${variantId}\t${model}\t${sid}\tok\t${m.usage.inputTokens}\t${m.usage.outputTokens}\t${m.latencyMs}\t${m.costUsd}\t${words}`
            : `${variantId}\t${model}\t${sid}\t${m.reason}\t\t\t\t\t`,
        );
        if (chosen.includes(sid)) {
          const lines = compare.get(sid) ?? [];
          lines.push(`## ${variantId} @ ${model}\n\n${r.text ?? '(unavailable)'}\n`);
          compare.set(sid, lines);
        }
        process.stderr.write(`${variantId}@${model} ${sid}: ${m.status}\n`);
      }
    }
  }
  await mkdir(path.join(parsed.out, 'compare'), { recursive: true });
  for (const [sid, lines] of compare) {
    await writeFile(
      path.join(parsed.out, 'compare', `${sid}.md`),
      `# ${sid}\n\n${lines.join('\n')}`,
    );
  }
  await writeFile(path.join(parsed.out, 'report.tsv'), report.join('\n') + '\n');
  process.stdout.write(`wrote ${parsed.out}\n`);
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
      process.stderr.write(
        `recap-prompt-lab: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
