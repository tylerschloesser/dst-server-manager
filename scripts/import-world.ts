#!/usr/bin/env -S pnpm tsx
// scripts/import-world.ts — docs/control-plane.md §9, docs/storage.md §7. Registers a world in
// DynamoDB and, with --zip, uploads its save to S3, in one pass. Run once per world, by Tyler,
// with AWS_PROFILE=admin. Never modifies the source zip; never prints the Klei token (this script
// never even reads it — that's a separate SSM parameter the supervisor reads at boot).
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import {
  CONTROL_REGION,
  DATA_BUCKET,
  DEFAULT_IDLE_MINUTES,
  GAME_REGION,
  TABLE_NAME,
  WORLD_ID_RE,
  isTestWorldId,
} from '@dst/shared';
import type { WorldRegistryItem, WorldSource } from '@dst/shared';

import {
  assertPasswordBlank,
  packStagedCluster,
  stageCluster,
  verifySaveTarball,
} from './lib/save-tarball';

// Importing the SDK classes above makes no network call and constructs no client (that happens
// only inside main(), after the --help / AWS_PROFILE checks below — decisions §16.40).
const execFileAsync = promisify(execFile);

const SOURCES: readonly WorldSource[] = ['import', 'generated', 'test'];

export const USAGE = `Usage: pnpm tsx scripts/import-world.ts --world-id <id> [--zip <path>]
  [--display-name <name>] [--server-name <name>] [--no-caves] [--idle-minutes <n>]
  [--source import|generated|test] [--world-only] [--force] [--help]

Registers a world in DynamoDB and, with --zip, uploads its save (docs/storage.md §7,
docs/control-plane.md §9). Run once per world with AWS_PROFILE=admin.

Flags:
  --world-id <id>          required. Must match ${WORLD_ID_RE.source}. A "test-" id
                            requires --source test.
  --zip <path>              path to the cluster zip. Without it, no S3 object is written and
                             --display-name/--server-name are required.
  --display-name <name>     UI display name. Defaults to --server-name (or the zip's cluster_name).
  --server-name <name>      overrides the zip's [NETWORK] cluster_name.
  --no-caves                 force hasCaves=false, overriding what the zip contains.
  --idle-minutes <n>         integer >= 1. Default ${DEFAULT_IDLE_MINUTES}.
  --source <s>                import | generated | test. Default: import.
  --world-only                skip the seed/ upload and the registry write; only (re)builds
                               worlds/<id>/save.tar.zst from --zip (disaster recovery,
                               docs/storage.md §10.5). Requires --zip.
  --force                      skip the "already registered" guard on the registry write.
  --help                       print this message and exit 0. Makes no AWS call.
`;

export interface ImportWorldArgs {
  help: false;
  worldId: string;
  zip: string | null;
  displayName: string | null;
  serverName: string | null;
  noCaves: boolean;
  idleMinutes: number;
  source: WorldSource;
  worldOnly: boolean;
  force: boolean;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

/** Pure argument parsing — no filesystem or network access, safe to unit test directly. `--help`
 * is recognised before anything else is validated (docs/decisions.md §16.40). */
export function parseArgs(argv: string[]): { help: true } | ImportWorldArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let worldId: string | null = null;
  let zip: string | null = null;
  let displayName: string | null = null;
  let serverName: string | null = null;
  let noCaves = false;
  let idleMinutes = DEFAULT_IDLE_MINUTES;
  let source: WorldSource = 'import';
  let worldOnly = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--world-id':
        worldId = requireValue(argv, ++i, '--world-id');
        break;
      case '--zip':
        zip = requireValue(argv, ++i, '--zip');
        break;
      case '--display-name':
        displayName = requireValue(argv, ++i, '--display-name');
        break;
      case '--server-name':
        serverName = requireValue(argv, ++i, '--server-name');
        break;
      case '--no-caves':
        noCaves = true;
        break;
      case '--idle-minutes': {
        const raw = requireValue(argv, ++i, '--idle-minutes');
        idleMinutes = Number(raw);
        if (!Number.isInteger(idleMinutes) || idleMinutes < 1) {
          throw new Error(`--idle-minutes must be an integer >= 1, got ${raw}`);
        }
        break;
      }
      case '--source': {
        const raw = requireValue(argv, ++i, '--source');
        if (!SOURCES.includes(raw as WorldSource)) {
          throw new Error(`--source must be one of ${SOURCES.join('|')}, got ${raw}`);
        }
        source = raw as WorldSource;
        break;
      }
      case '--world-only':
        worldOnly = true;
        break;
      case '--force':
        force = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (worldId === null) throw new Error('--world-id is required');
  if (!WORLD_ID_RE.test(worldId)) {
    throw new Error(`--world-id must match ${WORLD_ID_RE.source}, got ${worldId}`);
  }
  if (isTestWorldId(worldId) && source !== 'test') {
    throw new Error(
      `refuses a test- id without --source test: ${worldId} looks like a lifecycle-test world; ` +
        'pass --source test to register it deliberately (docs/control-plane.md §9)',
    );
  }
  if (worldOnly && zip === null) {
    throw new Error('--world-only requires --zip (docs/storage.md §10.5)');
  }
  if (zip === null && !worldOnly && (displayName === null || serverName === null)) {
    throw new Error('--display-name and --server-name are required without --zip');
  }

  return {
    help: false,
    worldId,
    zip,
    displayName,
    serverName,
    noCaves,
    idleMinutes,
    source,
    worldOnly,
    force,
  };
}

/** docs/control-plane.md §9 / docs/testing.md's `refuses to overwrite seed/` test: refuses when
 * `seed/<worldId>/` already holds any object. Pure — takes the existing key list rather than
 * calling S3 itself, so it is unit-testable without AWS. */
export function assertSeedNotPresent(existingKeys: readonly string[], worldId: string): void {
  const prefix = `seed/${worldId}/`;
  if (existingKeys.some((k) => k.startsWith(prefix))) {
    throw new Error(
      `refuses to overwrite seed/${worldId}/ — it already exists; the seed zip is uploaded ` +
        'once and never touched again (docs/storage.md §7)',
    );
  }
}

async function findClusterIni(root: string, maxDepth: number): Promise<string | null> {
  async function walk(dir: string, depth: number): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'cluster.ini') return path.join(dir, entry.name);
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await walk(path.join(dir, entry.name), depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  }
  return walk(root, 0);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** docs/storage.md §7 step 3: the cluster_name value under [NETWORK], read without printing the
 * whole file. Returns null when no such line exists. */
function readClusterName(iniText: string): string | null {
  const re = /^[ \t]*cluster_name[ \t]*=[ \t]*(.*)$/m;
  const match = re.exec(iniText);
  return match !== null ? (match[1] ?? '').trim() : null;
}

async function main(): Promise<number> {
  let args: { help: true } | ImportWorldArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${USAGE}\nError: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (process.env['AWS_PROFILE'] !== 'admin') {
    process.stderr.write('REFUSED: AWS_PROFILE=admin is required to run scripts/import-world.ts\n');
    return 1;
  }

  const s3 = new S3Client({ region: GAME_REGION });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: CONTROL_REGION }));

  const work = await mkdtemp(path.join(tmpdir(), 'dst-import-world-'));
  try {
    let serverName = args.serverName;
    let displayName = args.displayName;
    let hasCaves = !args.noCaves;
    let clusterDir: string | null = null;

    if (args.zip !== null) {
      const zipDir = path.join(work, 'zip');
      await execFileAsync('unzip', ['-q', args.zip, '-d', zipDir]);
      const clusterIni = await findClusterIni(zipDir, 4);
      if (clusterIni === null) {
        throw new Error(`no cluster.ini found inside ${args.zip}`);
      }
      clusterDir = path.dirname(clusterIni);

      if (serverName === null) {
        const iniText = await readFile(clusterIni, 'utf8');
        serverName = readClusterName(iniText);
        if (serverName === null) {
          throw new Error(`no cluster_name found in ${clusterIni}`);
        }
      }
      if (!args.noCaves) {
        hasCaves = await fileExists(path.join(clusterDir, 'Caves', 'server.ini'));
      }
      if (displayName === null) displayName = serverName;

      if (!args.worldOnly) {
        const seedPrefix = `seed/${args.worldId}/`;
        const existing = await s3.send(
          new ListObjectsV2Command({ Bucket: DATA_BUCKET, Prefix: seedPrefix }),
        );
        const existingKeys = (existing.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => k !== undefined);
        assertSeedNotPresent(existingKeys, args.worldId);

        const zipBaseName = path.basename(args.zip);
        const zipBody = await readFile(args.zip);
        await s3.send(
          new PutObjectCommand({
            Bucket: DATA_BUCKET,
            Key: `${seedPrefix}${zipBaseName}`,
            Body: zipBody,
          }),
        );
      }

      const stageDir = path.join(work, 'stage');
      const outFile = path.join(work, 'save.tar.zst');
      await stageCluster(clusterDir, stageDir);
      await assertPasswordBlank(path.join(stageDir, 'cluster.ini'));
      await packStagedCluster(stageDir, outFile);
      await verifySaveTarball(outFile);

      const saveBody = await readFile(outFile);
      await s3.send(
        new PutObjectCommand({
          Bucket: DATA_BUCKET,
          Key: `worlds/${args.worldId}/save.tar.zst`,
          Body: saveBody,
        }),
      );
    }

    if (args.worldOnly) {
      process.stdout.write(`worlds/${args.worldId}/save.tar.zst rebuilt from ${args.zip!}\n`);
      return 0;
    }

    if (displayName === null || serverName === null) {
      // Unreachable given parseArgs' validation, but keeps this function's types honest.
      throw new Error('--display-name and --server-name are required');
    }

    const item: WorldRegistryItem = {
      pk: 'WORLD',
      sk: args.worldId,
      worldId: args.worldId,
      displayName,
      serverName,
      hasCaves,
      idleMinutes: args.idleMinutes,
      createdAt: new Date().toISOString(),
      source: args.source,
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item,
          ...(args.force ? {} : { ConditionExpression: 'attribute_not_exists(pk)' }),
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        process.stderr.write('world already registered; pass --force to replace\n');
        return 1;
      }
      throw err;
    }

    process.stdout.write(`registered world ${args.worldId} (source=${args.source})\n`);
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
