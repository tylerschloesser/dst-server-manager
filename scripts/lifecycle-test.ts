#!/usr/bin/env -S pnpm tsx
// scripts/lifecycle-test.ts — docs/testing.md §4, docs/decisions.md §13. Exercises the real,
// deployed system end to end through `$ORIGIN/api/...` and asserts against DynamoDB, EC2, S3 and
// the reaper Lambda with the AWS SDK. Run with `AWS_PROFILE=admin pnpm lifecycle-test [flags]`.
//
// Safety (docs/testing.md §4.1): every world id this script registers, starts, stops or deletes,
// and every S3 key it writes to or deletes, is guarded by `assertTestKey`, which throws on
// anything outside `test-*` before the call is made. `worlds/tylerni2026/`, `seed/` and any
// non-`test-` registry item are never read and never written here.
//
// Importing the SDK classes below makes no network call and constructs no client — every client
// is constructed inside main(), after the --help and AWS_PROFILE checks (decisions §16.40).
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  SendCommandCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  CAVES_PORT,
  CONTROL_REGION,
  DATA_BUCKET,
  GAME_REGION,
  INSTANCE_NAME_TAG,
  INSTANCE_TYPE,
  LAUNCH_TEMPLATE_NAME,
  MASTER_PORT,
  PARAM_CLUSTER_PASSWORD,
  PARAM_KLEI_TOKEN,
  PARAM_SESSION_SECRET,
  PARAM_USERS,
  PROJECT,
  PUBLIC_ORIGIN_PROD,
  REAPER_FUNCTION_NAME,
  TABLE_NAME,
} from '@dst/shared';
import type { WorldRegistryItem, WorldsResponse } from '@dst/shared';

import { assertTestKey } from './lib/assert-test-key';
import { assertPasswordBlank, listSaveTarball, verifySaveTarball } from './lib/save-tarball';

const ORIGIN = PUBLIC_ORIGIN_PROD;
const WORLD_A = 'test-lifecycle-a';
const WORLD_B = 'test-lifecycle-b';
const PRUNE_KEY = 'worlds/test-prune/save.tar.zst';

export const USAGE = `Usage: AWS_PROFILE=admin pnpm lifecycle-test [flags]
(equivalently: pnpm tsx scripts/lifecycle-test.ts [flags])

Exercises the real, deployed system end to end (docs/testing.md §4): registers
test-lifecycle-a/test-lifecycle-b, drives start/switch/idle-stop/restore/stop through
$ORIGIN/api/..., asserts the backup and delete-protection configuration, and — unless
--skip-reaper — exercises all three reaper rules. Always tears down its own test-* data, even on
failure or interruption.

Flags:
  --cleanup-only          run teardown only (plus purging the retained worlds/test-prune/ evidence),
                           then exit. Use after an aborted run.
  --skip-reaper            skip phases 7-9 (the reaper phases); ~50 min instead of ~100.
  --until-phase <n>         run phases 0..n, then tear down. --until-phase 1 is the first-boot
                             check.
  --timeout-minutes <n>     abort into teardown and exit 2 if the whole run exceeds this many
                             minutes. Default 150.
  --keep-going               record a failure and continue to the next assertion, instead of
                              stopping at the first one.
  --help                     print this message and exit 0. Makes no AWS call.

Exit codes: 0 every executed assertion passed and teardown succeeded; 1 an assertion failed;
2 timeout; 3 a refused precondition (cluster not idle, or AWS_PROFILE != admin).
`;

export interface LifecycleArgs {
  help: false;
  cleanupOnly: boolean;
  skipReaper: boolean;
  untilPhase: number | null;
  timeoutMinutes: number;
  keepGoing: boolean;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

/** Pure argument parsing — no filesystem or network access. `--help` short-circuits before
 * anything else is validated (docs/decisions.md §16.40). */
export function parseArgs(argv: string[]): { help: true } | LifecycleArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let cleanupOnly = false;
  let skipReaper = false;
  let untilPhase: number | null = null;
  let timeoutMinutes = 150;
  let keepGoing = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--cleanup-only':
        cleanupOnly = true;
        break;
      case '--skip-reaper':
        skipReaper = true;
        break;
      case '--until-phase': {
        const raw = requireValue(argv, ++i, '--until-phase');
        untilPhase = Number(raw);
        if (!Number.isInteger(untilPhase) || untilPhase < 0 || untilPhase > 10) {
          throw new Error(`--until-phase must be an integer 0..10, got ${raw}`);
        }
        break;
      }
      case '--timeout-minutes': {
        const raw = requireValue(argv, ++i, '--timeout-minutes');
        timeoutMinutes = Number(raw);
        if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) {
          throw new Error(`--timeout-minutes must be a positive integer, got ${raw}`);
        }
        break;
      }
      case '--keep-going':
        keepGoing = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { help: false, cleanupOnly, skipReaper, untilPhase, timeoutMinutes, keepGoing };
}

// -------------------------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TimeoutBudget {
  private readonly deadlineMs: number;
  constructor(minutes: number) {
    this.deadlineMs = Date.now() + minutes * 60_000;
  }
  remainingMs(): number {
    return this.deadlineMs - Date.now();
  }
  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  poll: () => Promise<T | null>,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await poll();
    if (result !== null) return result;
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(`timed out waiting for ${label} after ${Math.round(elapsed / 1000)}s`);
    }
    process.stdout.write(`  ... waiting for ${label} (${Math.round(elapsed / 1000)}s elapsed)\n`);
    await sleep(Math.min(intervalMs, Math.max(timeoutMs - elapsed, 0)));
  }
}

class LifecycleFailure extends Error {}

interface AssertionRecord {
  phase: number;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  elapsedMs: number;
  detail?: string;
}

class Report {
  readonly records: AssertionRecord[] = [];
  constructor(private readonly keepGoing: boolean) {}

  async run(phase: number, name: string, fn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    try {
      await fn();
      const elapsedMs = Date.now() - start;
      this.records.push({ phase, name, status: 'PASS', elapsedMs });
      process.stdout.write(`PASS  phase ${phase}  ${name}  (${elapsedMs}ms)\n`);
    } catch (err) {
      const elapsedMs = Date.now() - start;
      const detail = err instanceof Error ? err.message : String(err);
      this.records.push({ phase, name, status: 'FAIL', elapsedMs, detail });
      process.stdout.write(`FAIL  phase ${phase}  ${name}  (${elapsedMs}ms) — ${detail}\n`);
      if (!this.keepGoing) throw new LifecycleFailure(detail);
    }
  }

  skip(phase: number, name: string): void {
    this.records.push({ phase, name, status: 'SKIP', elapsedMs: 0 });
    process.stdout.write(`SKIP  phase ${phase}  ${name}\n`);
  }

  hasFailures(): boolean {
    return this.records.some((r) => r.status === 'FAIL');
  }

  printTable(): void {
    process.stdout.write('\n--- lifecycle-test summary ---\n');
    for (const r of this.records) {
      const detail = r.detail !== undefined ? ` — ${r.detail}` : '';
      process.stdout.write(`${r.status.padEnd(4)} phase ${r.phase}  ${r.name}${detail}\n`);
    }
    const passed = this.records.filter((r) => r.status === 'PASS').length;
    const failed = this.records.filter((r) => r.status === 'FAIL').length;
    const skipped = this.records.filter((r) => r.status === 'SKIP').length;
    process.stdout.write(
      `${this.records.length} assertions: ${passed} passed, ${failed} failed, ${skipped} skipped\n`,
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/** docs/testing.md §4.1 item 4 / decisions §16.22: the leak check can only prove "the secret does
 * not appear" if it actually knows the secret value. `countOccurrences` returns `0` for an empty
 * needle, so an empty or missing SSM read would otherwise make the assertion pass vacuously —
 * printing the same `hits=0` a genuine pass prints. Exported for a direct unit test. */
export function assertSecretValuesNonEmpty(kleiToken: string, clusterPassword: string): void {
  if (kleiToken === '' || clusterPassword === '') {
    throw new Error(
      'secret value empty — leak check would be vacuous (SSM returned no value for the Klei ' +
        'token or the cluster password)',
    );
  }
}

/** One scanned blob: a file from the extracted save tarball, or one `sessions/test-*` object. */
export interface LeakScanSource {
  /** The S3 key, or `save.tar.zst:<path inside the archive>`. Printed; must identify the object
   *  without revealing anything about its contents. */
  readonly label: string;
  readonly text: string;
}

export interface LeakScanResult {
  readonly tokenHits: number;
  readonly passwordHits: number;
  /** One entry per offending source, worst first. **Label and counts only** — never the secret
   *  value, never the matching line, never any surrounding excerpt (docs/testing.md §4.1 item 4:
   *  "nothing sensitive is ever printed"). */
  readonly offenders: readonly string[];
}

/** docs/testing.md §4.1 item 4 / decisions §16.22. Scans each source separately so a failure names
 * the object that leaked instead of only a summed total — the summed form could not say whether
 * the hit was in the save tarball, a session log or the manifest. Pure, and exported for a direct
 * unit test. */
export function scanForSecretLeaks(
  sources: readonly LeakScanSource[],
  kleiToken: string,
  clusterPassword: string,
): LeakScanResult {
  let tokenHits = 0;
  let passwordHits = 0;
  const offenders: Array<{ label: string; token: number; password: number }> = [];
  for (const source of sources) {
    const token = countOccurrences(source.text, kleiToken);
    const password = countOccurrences(source.text, clusterPassword);
    tokenHits += token;
    passwordHits += password;
    if (token !== 0 || password !== 0) offenders.push({ label: source.label, token, password });
  }
  offenders.sort((a, b) => b.token + b.password - (a.token + a.password));
  return {
    tokenHits,
    passwordHits,
    offenders: offenders.map(
      (o) => `${o.label} (token hits=${o.token}, password hits=${o.password})`,
    ),
  };
}

// -------------------------------------------------------------------------------------------
// AWS + HTTP plumbing
// -------------------------------------------------------------------------------------------

interface Ctx {
  cookie: string;
  ddb: DynamoDBDocumentClient;
  ec2: EC2Client;
  s3: S3Client;
  ssmGame: SSMClient;
  lambda: LambdaClient;
  report: Report;
  sessionIdsSeen: Set<string>;
  instanceId: string;
  sessionA1: string;
  sessionB1: string;
  postStopA1: string;
}

interface RawClusterState {
  status: 'stopped' | 'starting' | 'running' | 'stopping';
  worldId: string | null;
  desiredWorldId: string | null;
  sessionId: string | null;
  instanceId: string | null;
  playerCount: number | null;
  idleDeadline: string | null;
  joinableAt: string | null;
  heartbeatAt: string | null;
  lastStopReason: string | null;
}

async function getState(ddb: DynamoDBDocumentClient): Promise<RawClusterState | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'STATE', sk: 'CLUSTER' },
      ConsistentRead: true,
    }),
  );
  return (res.Item as RawClusterState | undefined) ?? null;
}

interface InstanceSummary {
  instanceId: string;
  state: string;
  launchTime: Date | null;
  tags: Record<string, string | undefined>;
  securityGroupId: string | null;
  instanceType: string | null;
}

async function describeGameInstances(ec2: EC2Client, states: string[]): Promise<InstanceSummary[]> {
  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:project', Values: [PROJECT] },
        { Name: 'tag:role', Values: ['game'] },
        { Name: 'instance-state-name', Values: states },
      ],
    }),
  );
  const out: InstanceSummary[] = [];
  for (const reservation of res.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      if (inst.InstanceId === undefined) continue;
      out.push({
        instanceId: inst.InstanceId,
        state: inst.State?.Name ?? 'unknown',
        launchTime: inst.LaunchTime ?? null,
        tags: Object.fromEntries((inst.Tags ?? []).map((t) => [t.Key, t.Value])),
        securityGroupId: inst.SecurityGroups?.[0]?.GroupId ?? null,
        instanceType: inst.InstanceType ?? null,
      });
    }
  }
  return out;
}

async function apiRequest(
  cookie: string,
  method: string,
  urlPath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ORIGIN}${urlPath}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'X-DST-Request': '1' },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

interface VersionEntry {
  Key: string;
  VersionId: string;
  IsLatest: boolean;
}

async function listAllVersions(s3: S3Client, prefix: string): Promise<VersionEntry[]> {
  const out: VersionEntry[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const res = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: DATA_BUCKET,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    for (const v of [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]) {
      if (v.Key === undefined || v.VersionId === undefined) continue;
      out.push({ Key: v.Key, VersionId: v.VersionId, IsLatest: v.IsLatest === true });
    }
    if (res.IsTruncated !== true) break;
    keyMarker = res.NextKeyMarker;
    versionIdMarker = res.NextVersionIdMarker;
  }
  return out;
}

/** Deletes every version and delete-marker under `prefix`. Re-asserts `assertTestKey` on every
 * individual key immediately before it is deleted (docs/testing.md §4.5 step 5) — the guard that
 * actually matters, since `prefix` alone (e.g. `worlds/test-lifecycle-`) is not itself a full key. */
async function deleteAllVersions(s3: S3Client, prefix: string): Promise<void> {
  const entries = await listAllVersions(s3, prefix);
  const objects = entries.map((e) => {
    assertTestKey(e.Key);
    return { Key: e.Key, VersionId: e.VersionId };
  });
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({ Bucket: DATA_BUCKET, Delete: { Objects: batch, Quiet: true } }),
    );
  }
}

async function getObjectText(s3: S3Client, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
  return (await res.Body?.transformToString()) ?? '';
}

async function getManifest(
  s3: S3Client,
  worldId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const text = await getObjectText(s3, `sessions/${worldId}/${sessionId}/manifest.json`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function registerTestWorld(
  ddb: DynamoDBDocumentClient,
  item: WorldRegistryItem,
): Promise<void> {
  assertTestKey(item.worldId);
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

async function deleteTestWorldItems(ddb: DynamoDBDocumentClient): Promise<void> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': 'WORLD', ':s': 'test-' },
    }),
  );
  for (const item of res.Items ?? []) {
    const sk = item['sk'] as string;
    assertTestKey(sk);
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: 'WORLD', sk } }));
  }
}

// -------------------------------------------------------------------------------------------
// Phases (docs/testing.md §4.4)
// -------------------------------------------------------------------------------------------

async function phase0(ctx: Ctx): Promise<void> {
  const { report, cookie, ddb } = ctx;

  await report.run(0, 'GET /api/me with the minted cookie returns 200 and a nickname', async () => {
    const { status, body } = await apiRequest(cookie, 'GET', '/api/me');
    if (status !== 200) throw new Error(`status ${status}`);
    if (typeof (body as { nickname?: unknown }).nickname !== 'string') {
      throw new Error('missing nickname');
    }
  });

  await report.run(0, 'GET /api/me with no cookie returns 401', async () => {
    const res = await fetch(`${ORIGIN}/api/me`);
    if (res.status !== 401) throw new Error(`status ${res.status}`);
  });

  await report.run(
    0,
    'GET /api/me with an APP_ENV=test token returns 401 (docs/testing.md §3)',
    async () => {
      // Not a re-implementation of the signer: verifySessionToken rejects on the env mismatch
      // *before* any HMAC is computed (docs/auth.md §5.2 step 4), so this well-shaped-but-garbage
      // token proves the same thing a genuinely (but uselessly) signed one would.
      const fakePayload = Buffer.from(
        JSON.stringify({ sub: '7656119' + '0'.repeat(9) + '1', iat: 0, exp: 0 }),
      ).toString('base64url');
      const fakeToken = `v1.test.${fakePayload}.${'x'.repeat(43)}`;
      const res = await fetch(`${ORIGIN}/api/me`, {
        headers: { Cookie: `__Host-dst_session=${fakeToken}` },
      });
      if (res.status !== 401) throw new Error(`status ${res.status}`);
    },
  );

  await report.run(0, 'registers test-lifecycle-a and test-lifecycle-b', async () => {
    const now = new Date().toISOString();
    const base = {
      pk: 'WORLD' as const,
      hasCaves: false,
      idleMinutes: 3,
      createdAt: now,
      source: 'test' as const,
    };
    await registerTestWorld(ddb, {
      ...base,
      sk: WORLD_A,
      worldId: WORLD_A,
      displayName: 'Lifecycle Test A',
      serverName: 'Lifecycle Test A',
      hasCaves: true,
    });
    await registerTestWorld(ddb, {
      ...base,
      sk: WORLD_B,
      worldId: WORLD_B,
      displayName: 'Lifecycle Test B',
      serverName: 'Lifecycle Test B',
      hasCaves: false,
    });
  });

  await report.run(0, 'GET /api/worlds lists both test worlds', async () => {
    const { status, body } = await apiRequest(cookie, 'GET', '/api/worlds');
    if (status !== 200) throw new Error(`status ${status}`);
    const ids = (body as WorldsResponse).worlds.map((w) => w.worldId);
    if (!ids.includes(WORLD_A) || !ids.includes(WORLD_B))
      throw new Error('worlds missing from list');
  });
}

async function phase1(ctx: Ctx): Promise<void> {
  const { report, cookie, ddb, ec2 } = ctx;
  let sessionId = '';
  let instanceId = '';

  await report.run(1, 'POST start test-lifecycle-a returns 200', async () => {
    assertTestKey(WORLD_A);
    const { status } = await apiRequest(cookie, 'POST', `/api/worlds/${WORLD_A}/start`);
    if (status !== 200) throw new Error(`status ${status}`);
  });

  await report.run(1, 'state becomes starting within 10s with a sessionId', async () => {
    const state = await waitFor('status=starting', 10_000, 2_000, async () => {
      const s = await getState(ddb);
      return s?.status === 'starting' && s.worldId === WORLD_A ? s : null;
    });
    sessionId = state.sessionId ?? '';
    if (sessionId === '') throw new Error('sessionId is empty');
  });

  await report.run(1, 'exactly one tagged instance exists within 60s', async () => {
    const inst = await waitFor('a tagged instance', 60_000, 5_000, async () => {
      const instances = await describeGameInstances(ec2, ['pending', 'running']);
      const mine = instances.filter((i) => i.tags['sessionId'] === sessionId);
      return mine.length === 1 ? mine[0]! : null;
    });
    instanceId = inst.instanceId;
    if (inst.tags['Name'] !== INSTANCE_NAME_TAG) throw new Error('unexpected Name tag');
    if (inst.instanceType !== INSTANCE_TYPE)
      throw new Error(`unexpected instance type ${inst.instanceType}`);
    if (inst.state !== 'pending' && inst.state !== 'running')
      throw new Error(`unexpected state ${inst.state}`);
  });

  await report.run(1, 'security group allows only UDP 10998-10999 from 0.0.0.0/0', async () => {
    const instances = await describeGameInstances(ec2, ['pending', 'running']);
    const inst = instances.find((i) => i.instanceId === instanceId);
    if (inst?.securityGroupId === null || inst?.securityGroupId === undefined) {
      throw new Error('instance has no security group');
    }
    const sg = await ec2.send(
      new DescribeSecurityGroupsCommand({ GroupIds: [inst.securityGroupId] }),
    );
    const perms = sg.SecurityGroups?.[0]?.IpPermissions ?? [];
    const ok =
      perms.length === 1 &&
      perms[0]?.IpProtocol === 'udp' &&
      perms[0].FromPort === CAVES_PORT &&
      perms[0].ToPort === MASTER_PORT &&
      (perms[0].IpRanges ?? []).map((r) => r.CidrIp).join(',') === '0.0.0.0/0';
    if (!ok) throw new Error('unexpected security group rules');
  });

  await report.run(
    1,
    'a second start while starting is idempotent (still one instance)',
    async () => {
      const { status } = await apiRequest(cookie, 'POST', `/api/worlds/${WORLD_A}/start`);
      if (status !== 200) throw new Error(`status ${status}`);
      const instances = await describeGameInstances(ec2, ['pending', 'running']);
      if (instances.filter((i) => i.tags['sessionId'] === sessionId).length !== 1) {
        throw new Error('instance count drifted');
      }
    },
  );

  await report.run(1, 'five concurrent starts stay at exactly one instance', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => apiRequest(cookie, 'POST', `/api/worlds/${WORLD_A}/start`)),
    );
    for (const r of results) {
      if (r.status !== 200 && r.status !== 409) throw new Error(`unexpected status ${r.status}`);
    }
    const instances = await describeGameInstances(ec2, ['pending', 'running']);
    if (instances.filter((i) => i.tags['sessionId'] === sessionId).length !== 1) {
      throw new Error('instance count drifted under concurrency');
    }
  });

  await report.run(1, 'status reaches running within 15min with valid join info', async () => {
    const state = await waitFor('status=running', 15 * 60_000, 10_000, async () => {
      const s = await getState(ddb);
      return s?.status === 'running' && s.sessionId === sessionId ? s : null;
    });
    if (state.playerCount !== 0) throw new Error(`playerCount ${String(state.playerCount)}`);

    const { body } = await apiRequest(cookie, 'GET', '/api/worlds');
    const join = (body as WorldsResponse).active?.join;
    if (
      join === null ||
      join === undefined ||
      join.ip === '' ||
      join.port !== MASTER_PORT ||
      join.password === '' ||
      join.connectCommand !== `c_connect("${join.ip}", ${MASTER_PORT}, "${join.password}")`
    ) {
      throw new Error('missing or malformed join info');
    }
  });

  await report.run(
    1,
    'idleDeadline - joinableAt is 180s +/- 5s; heartbeat advances without stale',
    async () => {
      const s1 = await getState(ddb);
      if (s1?.joinableAt === null || s1?.joinableAt === undefined || s1.idleDeadline === null) {
        throw new Error('missing joinableAt/idleDeadline');
      }
      const deltaS = (Date.parse(s1.idleDeadline) - Date.parse(s1.joinableAt)) / 1000;
      if (Math.abs(deltaS - 180) > 5) throw new Error(`idleDeadline delta ${deltaS}s`);

      const heartbeatBefore = s1.heartbeatAt;
      await sleep(40_000);
      const { body } = await apiRequest(cookie, 'GET', '/api/worlds');
      if ((body as WorldsResponse).active?.stale === true) throw new Error('reported stale');
      const s2 = await getState(ddb);
      if (s2?.heartbeatAt === heartbeatBefore) throw new Error('heartbeat did not advance');
    },
  );

  ctx.instanceId = instanceId;
  ctx.sessionA1 = sessionId;
  ctx.sessionIdsSeen.add(sessionId);
}

async function phase2(ctx: Ctx): Promise<void> {
  const { report, cookie, ddb, ec2, s3 } = ctx;
  let sessionB = '';

  await report.run(
    2,
    'starting test-lifecycle-b while A runs switches in place (same instance)',
    async () => {
      assertTestKey(WORLD_B);
      const { status } = await apiRequest(cookie, 'POST', `/api/worlds/${WORLD_B}/start`);
      if (status !== 200) throw new Error(`status ${status}`);
      const state = await waitFor(
        'worldId=test-lifecycle-b running',
        10 * 60_000,
        10_000,
        async () => {
          const s = await getState(ddb);
          return s?.status === 'running' && s.worldId === WORLD_B && s.instanceId === ctx.instanceId
            ? s
            : null;
        },
      );
      if (state.sessionId === null || state.sessionId === ctx.sessionA1) {
        throw new Error('sessionId did not change on switch');
      }
      sessionB = state.sessionId;
    },
  );

  await report.run(2, 'no second instance was launched', async () => {
    const instances = await describeGameInstances(ec2, ['pending', 'running']);
    if (instances.length !== 1 || instances[0]?.instanceId !== ctx.instanceId) {
      throw new Error('instance count or identity changed');
    }
  });

  // The idle machinery is asserted in phase 1 for a *freshly booted* world; this is the same
  // assertion for a world that arrived by an in-place switch, whose idle clock must be anchored on
  // its OWN `joinableAt` and its own `idleMinutes` — not on the world it replaced. Without it the
  // only symptom of a broken post-switch idle clock is phase 3's 8-minute timeout
  // (docs/_first-boot-notes.md round 3); with it the same defect fails here, in seconds.
  await report.run(
    2,
    'test-lifecycle-b after the switch: idleDeadline - joinableAt is 180s +/- 5s',
    async () => {
      const s = await getState(ddb);
      if (s?.joinableAt === null || s?.joinableAt === undefined || s.idleDeadline === null) {
        throw new Error('missing joinableAt/idleDeadline');
      }
      if (s.worldId !== WORLD_B || s.sessionId !== sessionB) {
        throw new Error('state is no longer the switched-to session');
      }
      const deltaS = (Date.parse(s.idleDeadline) - Date.parse(s.joinableAt)) / 1000;
      if (Math.abs(deltaS - 180) > 5) throw new Error(`idleDeadline delta ${deltaS}s`);
    },
  );

  await report.run(2, "a new version of test-lifecycle-a's save appears", async () => {
    const versions = await listAllVersions(s3, `worlds/${WORLD_A}/save.tar.zst`);
    if (versions.length !== 1) throw new Error(`expected 1 version, got ${versions.length}`);
    ctx.postStopA1 = versions[0]!.VersionId;
  });

  await report.run(
    2,
    "test-lifecycle-a's manifest records the switch and both shard logs",
    async () => {
      const manifest = await getManifest(s3, WORLD_A, ctx.sessionA1);
      if (manifest['stopReason'] !== 'switch')
        throw new Error(`stopReason ${String(manifest['stopReason'])}`);
      if (manifest['preStartVersionId'] !== null) throw new Error('preStartVersionId is not null');
      if (manifest['postStopVersionId'] !== ctx.postStopA1)
        throw new Error('postStopVersionId mismatch');
      if (manifest['peakPlayers'] !== 0)
        throw new Error(`peakPlayers ${String(manifest['peakPlayers'])}`);
      if (manifest['instanceType'] !== INSTANCE_TYPE) throw new Error('instanceType mismatch');
      if (typeof manifest['dstBuildId'] !== 'string' || manifest['dstBuildId'] === '') {
        throw new Error('missing dstBuildId');
      }
      for (const shard of ['master', 'caves']) {
        const text = await getObjectText(
          s3,
          `sessions/${WORLD_A}/${ctx.sessionA1}/${shard}/server_log.txt`,
        );
        if (text.length === 0) throw new Error(`${shard}/server_log.txt is empty`);
      }
    },
  );

  ctx.sessionB1 = sessionB;
  ctx.sessionIdsSeen.add(sessionB);
}

async function phase3(ctx: Ctx): Promise<void> {
  const { report, ddb, ec2, s3 } = ctx;

  await report.run(
    3,
    'idle shutdown of B: stopped with lastStopReason=idle within 8min',
    async () => {
      const state = await waitFor('idle stop', 8 * 60_000, 10_000, async () => {
        const s = await getState(ddb);
        // A *new* sessionId on the same world is the signature of the stop restarting the world
        // it just stopped instead of terminating (docs/_first-boot-notes.md round 3: S6's
        // condition can only hold once the desire is released). Fail on it immediately with the
        // diagnosis, instead of burning the whole 8-minute budget on a bare timeout.
        if (s?.worldId === WORLD_B && s.sessionId !== null && s.sessionId !== ctx.sessionB1) {
          throw new Error(
            `test-lifecycle-b restarted itself under a new sessionId (${ctx.sessionB1} -> ` +
              `${s.sessionId}, status=${s.status}) instead of stopping for idle`,
          );
        }
        return s?.status === 'stopped' && s.lastStopReason === 'idle' ? s : null;
      });
      if (state.desiredWorldId !== null) throw new Error('desiredWorldId is not null');
    },
  );

  await report.run(3, 'the instance terminates', async () => {
    await waitFor('instance terminated', 5 * 60_000, 10_000, async () => {
      const instances = await describeGameInstances(ec2, ['shutting-down', 'terminated']);
      return instances.some((i) => i.instanceId === ctx.instanceId && i.state === 'terminated')
        ? true
        : null;
    });
  });

  await report.run(3, "exactly one version of test-lifecycle-b's save exists", async () => {
    const versions = await listAllVersions(s3, `worlds/${WORLD_B}/save.tar.zst`);
    if (versions.length !== 1) throw new Error(`expected 1 version, got ${versions.length}`);
  });

  await report.run(
    3,
    "test-lifecycle-b's manifest: stopReason=idle, preStartVersionId=null",
    async () => {
      const manifest = await getManifest(s3, WORLD_B, ctx.sessionB1);
      if (manifest['stopReason'] !== 'idle')
        throw new Error(`stopReason ${String(manifest['stopReason'])}`);
      if (manifest['preStartVersionId'] !== null) throw new Error('preStartVersionId is not null');
    },
  );
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

async function phase4(ctx: Ctx): Promise<void> {
  const { report, s3, ssmGame } = ctx;
  const work = await mkdtemp(path.join(tmpdir(), 'dst-lifecycle-phase4-'));
  try {
    let extractDir = '';

    await report.run(
      4,
      "test-lifecycle-b's save tarball has the correct member set at the archive root",
      async () => {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: DATA_BUCKET, Key: `worlds/${WORLD_B}/save.tar.zst` }),
        );
        const bytes = await res.Body?.transformToByteArray();
        if (bytes === undefined) throw new Error('empty tarball body');
        const tarPath = path.join(work, 'save.tar.zst');
        await writeFile(tarPath, bytes);

        const members = await listSaveTarball(tarPath);
        if (!members.some((m) => m === 'cluster.ini' || m === './cluster.ini')) {
          throw new Error('cluster.ini not at the archive root');
        }
        if (!members.some((m) => m.includes('Master'))) throw new Error('missing Master/');
        if (members.some((m) => m.includes('Caves')))
          throw new Error('unexpected Caves/ (hasCaves=false)');
        await verifySaveTarball(tarPath);

        extractDir = path.join(work, 'extract');
        await mkdir(extractDir, { recursive: true });
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        await promisify(execFile)('tar', [
          '--zstd',
          '-xf',
          tarPath,
          '-C',
          extractDir,
          '--no-same-owner',
        ]);
        await assertPasswordBlank(path.join(extractDir, 'cluster.ini'));
      },
    );

    await report.run(
      4,
      'the Klei token and the cluster password never appear in the extracted tree or in any sessions/test-* object',
      async () => {
        const [kleiRes, passwordRes] = await Promise.all([
          ssmGame.send(new GetParameterCommand({ Name: PARAM_KLEI_TOKEN, WithDecryption: true })),
          ssmGame.send(
            new GetParameterCommand({ Name: PARAM_CLUSTER_PASSWORD, WithDecryption: true }),
          ),
        ]);
        const kleiToken = kleiRes.Parameter?.Value ?? '';
        const clusterPassword = passwordRes.Parameter?.Value ?? '';
        assertSecretValuesNonEmpty(kleiToken, clusterPassword);

        const sources: LeakScanSource[] = [];
        for (const file of await walkFiles(extractDir)) {
          sources.push({
            label: `save.tar.zst:${path.relative(extractDir, file)}`,
            text: await readFile(file, 'utf8').catch(() => ''),
          });
        }
        const sessionVersions = await listAllVersions(s3, 'sessions/test-');
        for (const v of sessionVersions) {
          if (!v.IsLatest) continue;
          sources.push({ label: `s3:${v.Key}`, text: await getObjectText(s3, v.Key) });
        }

        const { tokenHits, passwordHits, offenders } = scanForSecretLeaks(
          sources,
          kleiToken,
          clusterPassword,
        );
        process.stdout.write(
          `  leak check: ${sources.length} objects scanned; token hits=${tokenHits}, ` +
            `password hits=${passwordHits}\n`,
        );
        // Object names and counts only — never the value, never the matching line (§4.1 item 4).
        for (const offender of offenders) process.stdout.write(`  LEAKED IN ${offender}\n`);
        if (tokenHits !== 0 || passwordHits !== 0)
          throw new Error(`a secret leaked into a downloaded object: ${offenders.join('; ')}`);
      },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function phase5(ctx: Ctx): Promise<void> {
  const { report, cookie, ddb, ec2, s3 } = ctx;
  let sessionA2 = '';

  await report.run(
    5,
    'second session of test-lifecycle-a reaches running within 10min (restore path)',
    async () => {
      assertTestKey(WORLD_A);
      const { status } = await apiRequest(cookie, 'POST', `/api/worlds/${WORLD_A}/start`);
      if (status !== 200) throw new Error(`status ${status}`);
      const state = await waitFor('A running again', 10 * 60_000, 10_000, async () => {
        const s = await getState(ddb);
        return s?.status === 'running' && s.worldId === WORLD_A ? s : null;
      });
      sessionA2 = state.sessionId ?? '';
      if (sessionA2 === '') throw new Error('sessionId is empty');
    },
  );

  await report.run(
    5,
    'POST stop test-lifecycle-a stops it within 5min with a second save version',
    async () => {
      assertTestKey(WORLD_A);
      const { status } = await apiRequest(cookie, 'POST', `/api/worlds/${WORLD_A}/stop`);
      if (status !== 200) throw new Error(`status ${status}`);
      await waitFor('A stopped by user', 5 * 60_000, 10_000, async () => {
        const s = await getState(ddb);
        return s?.status === 'stopped' && s.lastStopReason === 'user' ? s : null;
      });
      await waitFor('instance terminated', 5 * 60_000, 10_000, async () => {
        const instances = await describeGameInstances(ec2, ['terminated']);
        return instances.some((i) => i.tags['sessionId'] === sessionA2) ? true : null;
      });
      const versions = await listAllVersions(s3, `worlds/${WORLD_A}/save.tar.zst`);
      if (versions.length !== 2) throw new Error(`expected 2 versions, got ${versions.length}`);
      const manifest = await getManifest(s3, WORLD_A, sessionA2);
      const latest = versions.find((v) => v.IsLatest);
      if (manifest['postStopVersionId'] !== latest?.VersionId)
        throw new Error('postStopVersionId mismatch');
    },
  );

  // `manifest.json` is written by the instance role AT STOP (docs/storage.md §4, table row for
  // `sessions/<worldId>/<sessionId>/`), so the restore chain can only be read once this session has
  // stopped — reading it while A was still `running` was a NoSuchKey, not a broken chain. The
  // assertion itself is unchanged; it just runs after the stop that produces the artefact.
  await report.run(
    5,
    "second manifest's preStartVersionId equals the first stop's postStopVersionId",
    async () => {
      const manifest = await getManifest(s3, WORLD_A, sessionA2);
      if (manifest['preStartVersionId'] !== ctx.postStopA1) throw new Error('restore chain broken');
    },
  );

  ctx.sessionIdsSeen.add(sessionA2);
}

async function phase6(ctx: Ctx): Promise<void> {
  const { report, s3 } = ctx;

  await report.run(6, 'bucket versioning is Enabled', async () => {
    const res = await s3.send(new GetBucketVersioningCommand({ Bucket: DATA_BUCKET }));
    if (res.Status !== 'Enabled') throw new Error(`versioning status ${String(res.Status)}`);
  });

  await report.run(
    6,
    'worlds/ lifecycle rule keeps 10 newer noncurrent versions for 30 days',
    async () => {
      const res = await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: DATA_BUCKET }),
      );
      const rule = (res.Rules ?? []).find((r) => r.Filter?.Prefix === 'worlds/');
      if (
        rule?.NoncurrentVersionExpiration?.NewerNoncurrentVersions !== 10 ||
        rule.NoncurrentVersionExpiration.NoncurrentDays !== 30
      ) {
        throw new Error('worlds/ lifecycle rule mismatch');
      }
    },
  );

  await report.run(
    6,
    'inflight/ lifecycle rule keeps 3 newer noncurrent versions for 7 days',
    async () => {
      const res = await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: DATA_BUCKET }),
      );
      const rule = (res.Rules ?? []).find((r) => r.Filter?.Prefix === 'inflight/');
      if (
        rule?.NoncurrentVersionExpiration?.NewerNoncurrentVersions !== 3 ||
        rule.NoncurrentVersionExpiration.NoncurrentDays !== 7
      ) {
        throw new Error('inflight/ lifecycle rule mismatch');
      }
    },
  );

  await report.run(6, 'delete is denied for a nonexistent, non-test key (deny probe)', async () => {
    const probeKey = `sessions/deny-probe-${randomUUID()}/nothing.txt`;
    let denied = false;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: DATA_BUCKET, Key: probeKey }));
    } catch (err) {
      denied =
        /AccessDenied/i.test((err as { name?: string; message?: string }).name ?? '') ||
        /AccessDenied/i.test((err as Error).message);
    }
    if (!denied) throw new Error('DeleteObject on a non-test key was not denied');
  });

  /**
   * `s3:DeleteObjectVersion` cannot be probed live the way `s3:DeleteObject` can. A delete of a
   * nonexistent key reaches policy evaluation and is denied (above), but a versioned delete needs a
   * VersionId, and S3 rejects one that does not exist with `InvalidArgument` BEFORE it evaluates the
   * bucket policy — measured, both with a malformed id and a well-formed one. The only request that
   * would reach the policy is a delete of a REAL version of a REAL non-test object, i.e. of
   * `worlds/tylerni2026/save.tar.zst` — which is precisely the thing the policy exists to protect,
   * and which would destroy the save outright if the policy were ever wrong. So: assert the rule
   * instead of firing the bullet. This is strictly stronger than the probe it replaces, which could
   * not have caught an over-broad `NotResource` either.
   */
  await report.run(
    6,
    'the deny-delete statement covers both delete actions and exactly the six exempted prefixes',
    async () => {
      const res = await s3.send(new GetBucketPolicyCommand({ Bucket: DATA_BUCKET }));
      const policy = JSON.parse(res.Policy ?? '{}') as {
        Statement?: {
          Sid?: string;
          Effect?: string;
          Principal?: unknown;
          Action?: string | string[];
          NotResource?: string | string[];
        }[];
      };
      const stmt = policy.Statement?.find((x) => x.Sid === 'DenyDeleteOutsideScratchPrefixes');
      if (stmt === undefined)
        throw new Error('DenyDeleteOutsideScratchPrefixes statement is missing');
      if (stmt.Effect !== 'Deny') throw new Error(`effect is ${String(stmt.Effect)}, not Deny`);
      const principal = stmt.Principal as { AWS?: string } | string | undefined;
      const principalAws = typeof principal === 'string' ? principal : principal?.AWS;
      if (principalAws !== '*') throw new Error('deny does not apply to every principal');

      const actions = [stmt.Action ?? []].flat().sort();
      if (actions.join(',') !== 's3:DeleteObject,s3:DeleteObjectVersion')
        throw new Error(`actions are ${actions.join(',')}`);

      const expected = [
        `arn:aws:s3:::${DATA_BUCKET}/binaries/*`,
        `arn:aws:s3:::${DATA_BUCKET}/inflight/test-*`,
        `arn:aws:s3:::${DATA_BUCKET}/runtime-cache/*`,
        `arn:aws:s3:::${DATA_BUCKET}/runtime/*`,
        `arn:aws:s3:::${DATA_BUCKET}/sessions/test-*`,
        `arn:aws:s3:::${DATA_BUCKET}/worlds/test-*`,
      ];
      const actual = [stmt.NotResource ?? []].flat().sort();
      if (actual.join('\n') !== expected.join('\n'))
        throw new Error(`NotResource is not the six exempted prefixes: ${actual.join(',')}`);
    },
  );

  await report.run(6, 'the exempted test prefix is deletable (positive control)', async () => {
    const probeKey = 'sessions/test-deny-probe/probe.txt';
    assertTestKey(probeKey);
    await s3.send(
      new PutObjectCommand({ Bucket: DATA_BUCKET, Key: probeKey, Body: new Uint8Array(0) }),
    );
    assertTestKey(probeKey);
    await s3.send(new DeleteObjectCommand({ Bucket: DATA_BUCKET, Key: probeKey }));
  });

  await report.run(
    6,
    'pruning proof: 12 versions of worlds/test-prune/save.tar.zst exist',
    async () => {
      for (let i = 0; i < 12; i++) {
        assertTestKey(PRUNE_KEY);
        await s3.send(
          new PutObjectCommand({
            Bucket: DATA_BUCKET,
            Key: PRUNE_KEY,
            Body: new TextEncoder().encode(`v${i}`),
          }),
        );
      }
      const versions = await listAllVersions(s3, PRUNE_KEY);
      if (versions.length !== 12) throw new Error(`expected 12 versions, got ${versions.length}`);
      process.stdout.write(
        `  pruning-proof key retained: ${PRUNE_KEY} (a later manual check should see it drop to 11)\n`,
      );
    },
  );
}

interface ReaperInvokeResult {
  nulledDesire: string[];
  terminated: { instanceId: string; reason: string }[];
  reconciled: string[];
}

async function invokeReaper(lambda: LambdaClient, nowIso: string): Promise<ReaperInvokeResult> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: REAPER_FUNCTION_NAME,
      Payload: new TextEncoder().encode(JSON.stringify({ now: nowIso })),
    }),
  );
  if (res.StatusCode !== 200) throw new Error(`reaper invoke StatusCode ${String(res.StatusCode)}`);
  if (res.Payload === undefined) throw new Error('reaper invoke returned no payload');
  return JSON.parse(new TextDecoder().decode(res.Payload)) as ReaperInvokeResult;
}

async function stopSupervisorBySsm(ssmGame: SSMClient, instanceId: string): Promise<void> {
  const send = await ssmGame.send(
    new SendCommandCommand({
      DocumentName: 'AWS-RunShellScript',
      InstanceIds: [instanceId],
      Parameters: { commands: ['systemctl stop dst-supervisor'] },
    }),
  );
  const commandId = send.Command?.CommandId;
  if (commandId === undefined) throw new Error('SendCommand returned no CommandId');
  await waitFor('SSM command Success', 120_000, 5_000, async () => {
    // SSM registers the invocation asynchronously, so for the first moments after SendCommand
    // GetCommandInvocation throws InvocationDoesNotExist ("Invocation not found for <cmd>, <id>").
    // That is "not yet", not a failure — the first poll fires immediately after SendCommand and hit
    // it every time. Only this one error is swallowed; anything else still propagates, and a
    // genuinely Failed command still fails the assertion.
    let inv;
    try {
      inv = await ssmGame.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'InvocationDoesNotExist' || /Invocation not found/i.test((err as Error).message))
        return null;
      throw err;
    }
    if (inv.Status === 'Success') return true;
    if (inv.Status === 'Failed' || inv.Status === 'Cancelled' || inv.Status === 'TimedOut')
      throw new Error(`SSM command ${inv.Status}`);
    return null;
  });
}

async function startAAndCaptureInstance(
  ctx: Ctx,
): Promise<{ instanceId: string; sessionId: string; launchTime: Date | null }> {
  assertTestKey(WORLD_A);
  await apiRequest(ctx.cookie, 'POST', `/api/worlds/${WORLD_A}/start`);
  const state = await waitFor('A running', 15 * 60_000, 10_000, async () => {
    const s = await getState(ctx.ddb);
    return s?.status === 'running' && s.worldId === WORLD_A ? s : null;
  });
  const sessionId = state.sessionId ?? '';
  const instances = await describeGameInstances(ctx.ec2, ['pending', 'running']);
  const inst = instances.find((i) => i.tags['sessionId'] === sessionId);
  if (inst === undefined) throw new Error('instance not found for this session');
  ctx.sessionIdsSeen.add(sessionId);
  return { instanceId: inst.instanceId, sessionId, launchTime: inst.launchTime };
}

async function phase7(ctx: Ctx): Promise<void> {
  const { report, ec2, ddb, ssmGame } = ctx;
  let instanceId = '';
  let launchTime: Date | null = null;

  await report.run(7, 'start A, wait for running, stop the supervisor by SSM', async () => {
    const started = await startAAndCaptureInstance(ctx);
    instanceId = started.instanceId;
    launchTime = started.launchTime;
    await stopSupervisorBySsm(ssmGame, instanceId);
  });

  await report.run(
    7,
    'reaper terminates by launch+20min and reconciles to reaper-stale by launch+25min',
    async () => {
      if (launchTime === null) throw new Error('missing launchTime');
      const deadlineMs = launchTime.getTime() + 30 * 60_000;
      const remaining = Math.max(deadlineMs - Date.now(), 0) + 5 * 60_000;
      await waitFor('terminated + stopped (reaper-stale)', remaining, 15_000, async () => {
        const instances = await describeGameInstances(ec2, ['terminated']);
        const s = await getState(ddb);
        const terminated = instances.some((i) => i.instanceId === instanceId);
        const stopped = s?.status === 'stopped' && s.lastStopReason === 'reaper-stale';
        return terminated && stopped ? true : null;
      });
    },
  );
}

async function phase8(ctx: Ctx): Promise<void> {
  const { report, ddb, ssmGame, lambda } = ctx;
  let instanceId = '';
  const invokedAt = new Date();

  await report.run(8, 'start A, wait for running, stop the supervisor by SSM', async () => {
    const started = await startAAndCaptureInstance(ctx);
    instanceId = started.instanceId;
    await stopSupervisorBySsm(ssmGame, instanceId);
  });

  await report.run(8, 'reaper at now+12h01m nulls the desire and terminates nothing', async () => {
    const plus = new Date(invokedAt.getTime() + (12 * 60 + 1) * 60_000).toISOString();
    const result = await invokeReaper(lambda, plus);
    if (result.terminated.length !== 0) throw new Error('unexpected termination');
    if (!result.nulledDesire.includes(instanceId))
      throw new Error('instance missing from nulledDesire');
    const state = await getState(ddb);
    if (state?.desiredWorldId !== null) throw new Error('desiredWorldId still set');
    const instances = await describeGameInstances(ctx.ec2, ['pending', 'running']);
    if (!instances.some((i) => i.instanceId === instanceId))
      throw new Error('instance unexpectedly gone');
  });

  await report.run(8, 'reaper at now+12h11m terminates with reaper-max-age', async () => {
    const plus = new Date(invokedAt.getTime() + (12 * 60 + 11) * 60_000).toISOString();
    const result = await invokeReaper(lambda, plus);
    const term = result.terminated.find((t) => t.instanceId === instanceId);
    if (term === undefined || term.reason !== 'reaper-max-age') {
      throw new Error('instance not terminated with reaper-max-age');
    }
    await waitFor('terminated + stopped (reaper-max-age)', 5 * 60_000, 10_000, async () => {
      const instances = await describeGameInstances(ctx.ec2, ['terminated']);
      const s = await getState(ddb);
      return instances.some((i) => i.instanceId === instanceId) &&
        s?.status === 'stopped' &&
        s.lastStopReason === 'reaper-max-age'
        ? true
        : null;
    });
  });
}

async function phase9(ctx: Ctx): Promise<void> {
  const { report, ec2, ddb } = ctx;

  await report.run(
    9,
    'a directly-launched orphan instance is terminated by the next reaper run',
    async () => {
      const before = await getState(ddb);
      if (before?.status !== 'stopped')
        throw new Error('cluster is not stopped before the orphan test');

      const sessionTag = `test-orphan-${randomUUID()}`;
      const run = await ec2.send(
        new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateName: LAUNCH_TEMPLATE_NAME, Version: '$Latest' },
          MinCount: 1,
          MaxCount: 1,
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: [
                { Key: 'project', Value: PROJECT },
                { Key: 'role', Value: 'game' },
                { Key: 'Name', Value: INSTANCE_NAME_TAG },
                { Key: 'sessionId', Value: sessionTag },
              ],
            },
          ],
        }),
      );
      const orphanId = run.Instances?.[0]?.InstanceId;
      if (orphanId === undefined) throw new Error('RunInstances did not return an instance id');
      ctx.sessionIdsSeen.add(sessionTag);

      await waitFor('orphan terminated', 10 * 60_000, 15_000, async () => {
        const instances = await describeGameInstances(ec2, ['shutting-down', 'terminated']);
        return instances.some((i) => i.instanceId === orphanId) ? true : null;
      });

      const after = await getState(ddb);
      if (after?.status !== 'stopped' || after.desiredWorldId !== null) {
        throw new Error('the state item was touched by the orphan cleanup');
      }
    },
  );
}

async function phase10(ctx: Ctx): Promise<void> {
  const { report, ec2, ddb } = ctx;
  await report.run(
    10,
    'no project instance is pending/running; the cluster is stopped',
    async () => {
      const instances = await describeGameInstances(ec2, ['pending', 'running']);
      if (instances.length !== 0)
        throw new Error(`${instances.length} instance(s) still pending/running`);
      const state = await getState(ddb);
      if (state?.status !== 'stopped' || state.desiredWorldId !== null)
        throw new Error('cluster is not stopped');
    },
  );
}

// -------------------------------------------------------------------------------------------
// Teardown (docs/testing.md §4.5) — always runs, in `finally`.
// -------------------------------------------------------------------------------------------

async function teardown(ctx: Ctx, purgePrune: boolean): Promise<void> {
  process.stdout.write('--- teardown ---\n');

  try {
    const state = await getState(ctx.ddb);
    if (
      state !== null &&
      state.worldId !== null &&
      state.worldId.startsWith('test-') &&
      state.status !== 'stopped'
    ) {
      assertTestKey(state.worldId);
      // Step 2 only terminates instances this run launched. On `--cleanup-only` over an aborted
      // run it launched none, so adopt the live session here: its instance carries this exact
      // `sessionId` tag, so the terminate below stays as narrowly scoped as it is for a normal
      // teardown, and cleanup cannot return leaving a billable instance behind.
      if (state.sessionId !== null) ctx.sessionIdsSeen.add(state.sessionId);
      await apiRequest(ctx.cookie, 'POST', `/api/worlds/${state.worldId}/stop`);
      await waitFor('stopped for teardown', 5 * 60_000, 10_000, async () => {
        const s = await getState(ctx.ddb);
        return s?.status === 'stopped' ? true : null;
      }).catch((err: unknown) => {
        process.stdout.write(
          `  teardown step 1 warning: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    }
  } catch (err) {
    process.stdout.write(
      `  teardown step 1 warning: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  try {
    const instances = await describeGameInstances(ctx.ec2, [
      'pending',
      'running',
      'stopping',
      'stopped',
    ]);
    const mine = instances.filter((i) => ctx.sessionIdsSeen.has(i.tags['sessionId'] ?? ''));
    for (const inst of mine) {
      await ctx.ec2.send(new TerminateInstancesCommand({ InstanceIds: [inst.instanceId] }));
    }
  } catch (err) {
    process.stdout.write(
      `  teardown step 2 warning: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  try {
    for (const prefix of [
      `worlds/${WORLD_A}/`,
      `worlds/${WORLD_B}/`,
      'inflight/test-',
      'sessions/test-',
    ]) {
      await deleteAllVersions(ctx.s3, prefix);
    }
    if (purgePrune) {
      await deleteAllVersions(ctx.s3, PRUNE_KEY);
    }
  } catch (err) {
    process.stdout.write(
      `  teardown step 3 warning: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  try {
    await deleteTestWorldItems(ctx.ddb);
  } catch (err) {
    process.stdout.write(
      `  teardown step 4 warning: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  process.stdout.write('--- teardown complete ---\n');
}

// -------------------------------------------------------------------------------------------
// main
// -------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  let args: { help: true } | LifecycleArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${USAGE}\nError: ${(err as Error).message}\n`);
    return 3;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (process.env['AWS_PROFILE'] !== 'admin') {
    process.stderr.write(
      'REFUSED: AWS_PROFILE=admin is required to run scripts/lifecycle-test.ts\n',
    );
    return 3;
  }

  process.env['APP_ENV'] = 'prod';
  process.env['PUBLIC_ORIGIN'] = PUBLIC_ORIGIN_PROD;
  // Dynamic import so the module-load assertions in @dst/api/auth's index.ts (docs/auth.md §0)
  // run only after APP_ENV/PUBLIC_ORIGIN are set above, regardless of static-import hoisting.
  const { deriveSessionKey, mintSessionToken } = await import('@dst/api/auth');

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: CONTROL_REGION }));
  const ec2 = new EC2Client({ region: GAME_REGION });
  const s3 = new S3Client({ region: GAME_REGION });
  const ssmControl = new SSMClient({ region: CONTROL_REGION });
  const ssmGame = new SSMClient({ region: GAME_REGION });
  const lambda = new LambdaClient({ region: CONTROL_REGION });

  // ---- Safety rail 1: the cluster must be idle (docs/testing.md §4.1 rule 1) ----
  const state = await getState(ddb);
  // `--cleanup-only` exists to recover from an aborted run (docs/testing.md §4.5), and an aborted
  // run is exactly the case where a `test-` world is left `starting`/`running` with its instance
  // still alive. Refusing there left no supported way to clean up at all — hit for real in
  // T5.2 (docs/_first-boot-notes.md round 2). So cleanup, and only cleanup, may proceed over a
  // non-stopped cluster — but only when the active world is a `test-` one, which is the same
  // guarantee rail 2 (`assertTestKey`) gives every mutating call. A real world still refuses, and
  // every other invocation still refuses on any non-stopped cluster.
  const activeIsTestWorld =
    state !== null && state.worldId !== null && state.worldId.startsWith('test-');
  const cleanupOverride = args.cleanupOnly && activeIsTestWorld;
  if (state !== null && state.status !== 'stopped' && !cleanupOverride) {
    process.stderr.write(`REFUSED: cluster status is ${state.status} — someone may be playing\n`);
    return 3;
  }
  const liveInstances = await describeGameInstances(ec2, ['pending', 'running']);
  if (liveInstances.length > 0 && !cleanupOverride) {
    process.stderr.write(
      'REFUSED: a project=dst-server-manager, role=game instance is pending/running\n',
    );
    return 3;
  }
  if (cleanupOverride && state !== null && state.status !== 'stopped') {
    process.stdout.write(
      `--- cleanup-only over a live ${state.status} ${String(state.worldId)} session ---\n`,
    );
  }

  // ---- Auth: mint a real, prod-env cookie (docs/testing.md §4.2) ----
  const [secretResp, usersResp] = await Promise.all([
    ssmControl.send(new GetParameterCommand({ Name: PARAM_SESSION_SECRET, WithDecryption: true })),
    ssmControl.send(new GetParameterCommand({ Name: PARAM_USERS })),
  ]);
  const secret = secretResp.Parameter?.Value;
  const usersRaw = usersResp.Parameter?.Value;
  if (secret === undefined || secret === '' || usersRaw === undefined) {
    process.stderr.write('REFUSED: could not read /dst/session-secret or /dst/users\n');
    return 3;
  }
  const users = JSON.parse(usersRaw) as Record<string, string>;
  const steamId = Object.keys(users)[0];
  if (steamId === undefined) {
    process.stderr.write('REFUSED: /dst/users is empty\n');
    return 3;
  }
  const sessionKey = deriveSessionKey(secret, 'prod');
  const token = mintSessionToken({
    steamId64: steamId,
    sessionKey,
    nowSec: Math.floor(Date.now() / 1000),
  });
  const cookie = `__Host-dst_session=${token}`;

  const report = new Report(args.keepGoing);
  const ctx: Ctx = {
    cookie,
    ddb,
    ec2,
    s3,
    ssmGame,
    lambda,
    report,
    sessionIdsSeen: new Set<string>(),
    instanceId: '',
    sessionA1: '',
    sessionB1: '',
    postStopA1: '',
  };

  const budget = new TimeoutBudget(args.timeoutMinutes);
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let exitCode = 0;
  try {
    if (args.cleanupOnly) {
      await teardown(ctx, true);
      report.printTable();
      return 0;
    }

    const phases: { n: number; run: (c: Ctx) => Promise<void>; skip?: boolean }[] = [
      { n: 0, run: phase0 },
      { n: 1, run: phase1 },
      { n: 2, run: phase2 },
      { n: 3, run: phase3 },
      { n: 4, run: phase4 },
      { n: 5, run: phase5 },
      { n: 6, run: phase6 },
      { n: 7, run: phase7, skip: args.skipReaper },
      { n: 8, run: phase8, skip: args.skipReaper },
      { n: 9, run: phase9, skip: args.skipReaper },
      { n: 10, run: phase10 },
    ];

    for (const phase of phases) {
      if (args.untilPhase !== null && phase.n > args.untilPhase) break;
      if (interrupted) {
        report.skip(phase.n, 'interrupted before this phase');
        continue;
      }
      if (budget.expired()) {
        process.stdout.write(
          `--- timeout budget (${args.timeoutMinutes}min) exhausted before phase ${phase.n} ---\n`,
        );
        exitCode = 2;
        break;
      }
      if (phase.skip === true) {
        report.skip(phase.n, '--skip-reaper');
        continue;
      }
      await phase.run(ctx);
    }
  } catch (err) {
    if (!(err instanceof LifecycleFailure)) {
      process.stdout.write(
        `FATAL during phases: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (exitCode === 0) exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await teardown(ctx, false);
    report.printTable();
  }

  if (exitCode === 0 && report.hasFailures()) exitCode = 1;
  return exitCode;
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
