// @dst/supervisor: on-instance entrypoint — env -> adapters -> loop (docs/game-server.md §1, §8).
// This is the one impure module allowed to read the wall clock, touch the filesystem, spawn a
// process or call an AWS SDK directly (besides `src/adapters/*` and `src/tasks/*`, which it
// wires together). `core/` (pure) decides *what* to do via `reduce()`; this file decides *how*.
import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { newSessionId } from '@dst/shared';
import type { StopReason, WorldRegistryItem } from '@dst/shared';

import {
  applyPoll,
  buildCountQueryLine,
  buildPollOutcome,
  buildSessionManifest,
  computeIdleDeadline,
  computeOverallReading,
  decideIdleStop,
  initialIdleState,
  isBootOrphan,
  shardsFor,
  trackPeakPlayers,
} from './core';
import type {
  HostPort,
  IdleState,
  ObjectPort,
  SecretPort,
  Shard,
  ShardPort,
  ShardReading,
} from './core';
import { createClock, type Clock } from './adapters/clock';
import { createDdbAdapter, type DdbAdapter } from './adapters/ddb';
import { createHostAdapter } from './adapters/host';
import { createImdsAdapter } from './adapters/imds';
import { createLogger, type Logger } from './adapters/logger';
import { LogTailer } from './adapters/logtail';
import { revealedSecretValues } from './adapters/secret';
import { ShardLogState } from './adapters/shardLogState';
import { createShardAdapter } from './adapters/shards';
import { createS3Adapter } from './adapters/s3';
import { createSsmAdapter } from './adapters/ssm';
import { loadConfig, type SupervisorConfig } from './config';
import { installBinaries, repackBinariesInBackground } from './tasks/install';
import { restoreOrGenerateWorld } from './tasks/restore';
import { packAndPushSave } from './tasks/savePush';
import { uploadSessionLogs } from './tasks/logsUpload';
import { createInflightCopier } from './tasks/inflight';
import { stopShardsInOrder } from './tasks/stop';

const BOOT_TIMEOUT_MS = 15 * 60_000; // docs/game-server.md §8
const JOINABLE_POLL_MS = 2_000; // "every 2 s during startup until the first success" §7
const RUNNING_TICK_MS = 1_000;
const DESIRED_POLL_MS = 10_000;
const PLAYER_POLL_MS = 30_000;
const INFLIGHT_INTERVAL_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readVersion(): Promise<string> {
  try {
    return (await readFile(join(__dirname, 'VERSION'), 'utf8')).trim();
  } catch {
    return 'unknown';
  }
}

async function writeShardEnv(dstRoot: string, worldId: string): Promise<void> {
  await writeFile(`${dstRoot}/run/shard.env`, `DST_CLUSTER=${worldId}\n`, 'utf8');
}

interface Deps {
  readonly config: SupervisorConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ddb: DdbAdapter;
  readonly objects: ObjectPort;
  readonly secrets: SecretPort;
  readonly shardPort: ShardPort;
  readonly host: HostPort;
}

async function queryShard(deps: Deps, log: ShardLogState, shard: Shard): Promise<ShardReading> {
  const nonce = randomInt(1, 2 ** 31);
  try {
    await deps.shardPort.writeConsole(shard, buildCountQueryLine(nonce));
  } catch (err) {
    deps.logger.debug('write_console_failed', { shard, error: String(err) });
    return { kind: 'unknown' };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const reading = log.findCountReply(nonce);
    if (reading !== null) return reading;
    await sleep(100);
  }
  return { kind: 'unknown' };
}

interface Stopping {
  readonly reason: StopReason;
  readonly next: string | null;
}

interface SessionParams {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly worldId: string;
  readonly world: WorldRegistryItem;
  readonly desiredWorldId: string | null;
  readonly desiredBy: string | null;
  readonly desiredByNickname: string | null;
  readonly startedByNickname: string | null;
  readonly startedAt: Date;
  readonly instanceType: string;
  readonly skipInstall: boolean;
}

type SessionOutcome =
  | { readonly kind: 'halted' }
  | { readonly kind: 'switch'; readonly nextWorldId: string; readonly newSessionId: string };

/** Runs the stop sequence to completion (docs/game-server.md §9) and returns what the outer loop
 *  should do next: halt, or (in-place switch) restore+start another world on this same instance. */
async function finishStop(
  deps: Deps,
  params: SessionParams,
  clusterDir: string,
  loadCompleted: boolean,
  stopping: Stopping,
  joinableAt: Date | null,
  dstBuildId: string,
  preStartVersionId: string | null,
  peakPlayers: number,
): Promise<SessionOutcome> {
  const { logger, clock, ddb, objects, shardPort, host, config } = deps;
  const { sessionId, instanceId, worldId, world } = params;
  const { reason, next } = stopping;

  const s4Ok = await ddb.write({ kind: 'S4', sessionId, instanceId, reason });
  let abandoned = false;
  if (!s4Ok) {
    const fresh = await ddb.getState();
    if (fresh.sessionId !== sessionId || fresh.instanceId !== instanceId) {
      abandoned = true;
      logger.warn('session_abandoned', { sessionId, worldId });
    } else {
      logger.info('s4_condition_kept_reaper_reason', { sessionId, worldId });
    }
  }

  await stopShardsInOrder({ shards: shardsFor(world.hasCaves), shardPort, logger });

  let postStopVersionId: string | null = null;
  if (loadCompleted) {
    const key = abandoned ? `inflight/${worldId}/save.tar.zst` : `worlds/${worldId}/save.tar.zst`;
    const outPath = `${config.dstRoot}/tmp/save-${sessionId}.tar.zst`;
    try {
      const result = await packAndPushSave({ clusterDir, outPath, key, objects });
      postStopVersionId = abandoned ? null : result.versionId;
    } catch (err) {
      logger.error('save_push_failed', { worldId, error: String(err) });
    }
  }

  const stoppedAt = clock.now();
  const manifest = buildSessionManifest({
    sessionId,
    worldId,
    startedByNickname: params.startedByNickname,
    startedAt: params.startedAt.toISOString(),
    joinableAt: joinableAt !== null ? joinableAt.toISOString() : null,
    stoppedAt: stoppedAt.toISOString(),
    stopReason: reason,
    peakPlayers,
    instanceType: params.instanceType,
    dstBuildId,
    preStartVersionId,
    postStopVersionId,
  });
  try {
    await uploadSessionLogs({
      worldId,
      sessionId,
      hasCaves: world.hasCaves,
      clusterDir,
      supervisorLogPath: '/var/log/dst/supervisor.log',
      secretsToScrub: revealedSecretValues(),
      manifest,
      objects,
    });
  } catch (err) {
    logger.error('logs_upload_failed', { worldId, error: String(err) });
  }

  if (abandoned) {
    await host.shutdownNow();
    return { kind: 'halted' };
  }

  if (next !== null) {
    const newSid = newSessionId(clock.now());
    const ok = await ddb.write({
      kind: 'S5',
      sessionId,
      instanceId,
      newSessionId: newSid,
      newWorldId: next,
      desiredBy: params.desiredBy ?? 'reaper',
      desiredByNickname: params.desiredByNickname ?? 'reaper',
    });
    if (!ok) logger.warn('s5_write_condition_failed', { worldId, next });
    return { kind: 'switch', nextWorldId: next, newSessionId: newSid };
  }

  const s6Ok = await ddb.write({ kind: 'S6', sessionId, instanceId, reason });
  if (!s6Ok) {
    // decisions §6: the designed race — someone asked for a world during shutdown.
    const fresh = await ddb.getState();
    if (fresh.sessionId === sessionId && fresh.desiredWorldId !== null) {
      const newSid = newSessionId(clock.now());
      await ddb.write({
        kind: 'S5',
        sessionId,
        instanceId,
        newSessionId: newSid,
        newWorldId: fresh.desiredWorldId,
        desiredBy: fresh.desiredBy ?? 'reaper',
        desiredByNickname: fresh.desiredByNickname ?? 'reaper',
      });
      return { kind: 'switch', nextWorldId: fresh.desiredWorldId, newSessionId: newSid };
    }
    logger.warn('s6_condition_failed_no_pending_desire', { worldId });
  }

  await host.shutdownNow();
  return { kind: 'halted' };
}

async function runSession(deps: Deps, params: SessionParams): Promise<SessionOutcome> {
  const { logger, clock, ddb, objects, secrets, shardPort, config } = deps;
  const { sessionId, instanceId, worldId, world } = params;
  const clusterDir = `${config.dstRoot}/klei/DoNotStarveTogether/${worldId}`;
  await mkdir(clusterDir, { recursive: true });

  if (!params.skipInstall) {
    await installBinaries({
      bucket: config.dataBucket,
      region: config.gameRegion,
      dstRoot: config.dstRoot,
      objects,
      logger,
    });
  }

  const restoreResult = await restoreOrGenerateWorld({
    clusterDir,
    worldId,
    serverName: world.serverName,
    hasCaves: world.hasCaves,
    objects,
    secrets,
    logger,
  });
  await writeShardEnv(config.dstRoot, worldId);

  // docs/game-server.md §8 "installing": a cancellation mid-install starts no shards at all.
  const midState = await ddb.getState();
  if (midState.sessionId !== sessionId || midState.instanceId !== instanceId) {
    logger.warn('session_superseded_during_install', { worldId });
    await deps.host.shutdownNow();
    return { kind: 'halted' };
  }
  if (midState.desiredWorldId === null) {
    return finishStop(
      deps,
      params,
      clusterDir,
      false,
      { reason: 'user', next: null },
      null,
      '',
      restoreResult.preStartVersionId,
      0,
    );
  }

  const desiredWorldId = midState.desiredWorldId;
  const activeParams: SessionParams = {
    ...params,
    desiredWorldId,
    desiredBy: midState.desiredBy,
    desiredByNickname: midState.desiredByNickname,
  };

  const shards = shardsFor(world.hasCaves);
  for (const shard of shards) await shardPort.start(shard);

  const masterLog = new ShardLogState();
  const cavesLog = world.hasCaves ? new ShardLogState() : null;
  const masterTailer = new LogTailer(`${clusterDir}/Master/server_log.txt`, (l) =>
    masterLog.onLine(l),
  );
  const cavesTailer =
    cavesLog !== null
      ? new LogTailer(`${clusterDir}/Caves/server_log.txt`, (l) => cavesLog.onLine(l))
      : null;

  const startedAt = clock.now();
  const bootDeadline = startedAt.getTime() + BOOT_TIMEOUT_MS;
  let masterOk = false;
  let cavesOk = !world.hasCaves;
  let dstBuildId = '';

  // --- starting: poll the joinable predicate every 2 s until success or the 15-minute timeout.
  while (true) {
    masterTailer.poll();
    cavesTailer?.poll();

    if (!masterOk) {
      const reading = await queryShard(deps, masterLog, 'Master');
      if (reading.kind !== 'unknown') masterOk = true;
    }
    if (world.hasCaves && cavesLog !== null && !cavesOk) {
      const reading = await queryShard(deps, cavesLog, 'Caves');
      if (reading.kind !== 'unknown') cavesOk = true;
    }

    const joinable =
      masterLog.registered &&
      (!world.hasCaves || masterLog.cavesLinked) &&
      masterLog.pauseEdge !== null &&
      masterOk &&
      cavesOk;
    if (joinable) break;

    if (clock.now().getTime() >= bootDeadline) {
      logger.error('boot_timeout', { worldId, minutes: BOOT_TIMEOUT_MS / 60_000 });
      await ddb.errorNote({
        sessionId,
        instanceId,
        error: 'not joinable within 15m',
        now: clock.now(),
      });
      return finishStop(
        deps,
        activeParams,
        clusterDir,
        masterLog.loadCompleted,
        { reason: 'crash', next: desiredWorldId },
        null,
        dstBuildId,
        restoreResult.preStartVersionId,
        0,
      );
    }

    // A shard that died during boot, or a cancel/switch requested mid-boot.
    const [masterActive, cavesActive] = await Promise.all([
      shardPort.isActive('Master'),
      world.hasCaves ? shardPort.isActive('Caves') : Promise.resolve(true),
    ]);
    if (!masterActive || !cavesActive) {
      return finishStop(
        deps,
        activeParams,
        clusterDir,
        masterLog.loadCompleted,
        { reason: 'crash', next: desiredWorldId },
        null,
        dstBuildId,
        restoreResult.preStartVersionId,
        0,
      );
    }

    const state = await ddb.getState();
    if (state.sessionId !== sessionId || state.instanceId !== instanceId) {
      logger.warn('session_superseded_while_starting', { worldId });
      return { kind: 'halted' };
    }
    if (state.desiredWorldId !== desiredWorldId) {
      const reason: StopReason = state.desiredWorldId === null ? 'user' : 'switch';
      return finishStop(
        deps,
        activeParams,
        clusterDir,
        masterLog.loadCompleted,
        { reason, next: state.desiredWorldId },
        null,
        dstBuildId,
        restoreResult.preStartVersionId,
        0,
      );
    }

    await sleep(JOINABLE_POLL_MS);
  }

  // Now joinable. Read the build id (needed for the manifest either way).
  try {
    const acf = await readFile(`${config.dstRoot}/server/steamapps/appmanifest_343050.acf`, 'utf8');
    dstBuildId = acf.match(/"buildid"\s+"(\d+)"/)?.[1] ?? '';
  } catch {
    dstBuildId = '';
  }

  const joinableAt = clock.now();
  const idleMinutes = world.idleMinutes;
  const idleDeadline = computeIdleDeadline(joinableAt, joinableAt, idleMinutes);
  await ddb.joinable({
    sessionId,
    instanceId,
    worldId,
    idleDeadline: idleDeadline.toISOString(),
    now: joinableAt,
  });
  logger.info('joinable', { worldId, sessionId });

  // §4 step 5: kick off the (best-effort, detached) repack now that the world is up.
  const installResult = params.skipInstall
    ? null
    : await installBinaries({
        bucket: config.dataBucket,
        region: config.gameRegion,
        dstRoot: config.dstRoot,
        objects,
        logger,
      }).catch(() => null);
  if (installResult?.repackNeeded === true) {
    repackBinariesInBackground({
      bucket: config.dataBucket,
      region: config.gameRegion,
      dstRoot: config.dstRoot,
      objects,
      logger,
    });
  }

  // --- running: idle maths, heartbeats, inflight copies, and reconciliation.
  let idleState: IdleState = initialIdleState(joinableAt);
  let crossCheckEnabled = restoreResult.pauseWhenEmpty;
  let loadCompleted = masterLog.loadCompleted;
  let peakPlayers = 0;

  const inflightCopy = createInflightCopier({
    worldId,
    clusterDir,
    outPath: `${config.dstRoot}/tmp/inflight-${sessionId}.tar.zst`,
    objects,
    logger,
  });

  let msSinceDesiredPoll = 0;
  let msSinceCountPoll = 0;
  let msSinceInflight = 0;

  while (true) {
    masterTailer.poll();
    cavesTailer?.poll();
    if (masterLog.loadCompleted) loadCompleted = true;

    await sleep(RUNNING_TICK_MS);
    msSinceDesiredPoll += RUNNING_TICK_MS;
    msSinceCountPoll += RUNNING_TICK_MS;
    msSinceInflight += RUNNING_TICK_MS;

    if (msSinceDesiredPoll >= DESIRED_POLL_MS) {
      msSinceDesiredPoll = 0;
      const [masterActive, cavesActive] = await Promise.all([
        shardPort.isActive('Master'),
        world.hasCaves ? shardPort.isActive('Caves') : Promise.resolve(true),
      ]);
      if (!masterActive || !cavesActive) {
        return finishStop(
          deps,
          activeParams,
          clusterDir,
          loadCompleted,
          { reason: 'crash', next: null },
          joinableAt,
          dstBuildId,
          restoreResult.preStartVersionId,
          peakPlayers,
        );
      }

      const state = await ddb.getState();
      if (state.sessionId !== sessionId || state.instanceId !== instanceId) {
        logger.warn('session_superseded_while_running', { worldId });
        return { kind: 'halted' };
      }
      if (state.desiredWorldId !== worldId) {
        const reason: StopReason = state.desiredWorldId === null ? 'user' : 'switch';
        return finishStop(
          deps,
          activeParams,
          clusterDir,
          loadCompleted,
          { reason, next: state.desiredWorldId },
          joinableAt,
          dstBuildId,
          restoreResult.preStartVersionId,
          peakPlayers,
        );
      }
    }

    if (msSinceInflight >= INFLIGHT_INTERVAL_MS) {
      msSinceInflight = 0;
      void inflightCopy();
    }

    if (msSinceCountPoll >= PLAYER_POLL_MS) {
      msSinceCountPoll = 0;
      const masterReading = await queryShard(deps, masterLog, 'Master');
      const cavesReading =
        world.hasCaves && cavesLog !== null ? await queryShard(deps, cavesLog, 'Caves') : null;
      const overall = computeOverallReading(world.hasCaves, masterReading, cavesReading);

      if (overall !== 'unknown' && crossCheckEnabled) {
        // §7: no pause edge 3 polls after joinable disables the cross-check for the session.
        if (masterLog.pauseEdge === null) crossCheckEnabled = false;
      }
      const outcome = buildPollOutcome(overall, masterLog.pauseEdge, crossCheckEnabled);
      const now = clock.now();
      idleState = applyPoll(idleState, outcome, now);
      peakPlayers = trackPeakPlayers(peakPlayers, overall);

      const deadline = computeIdleDeadline(joinableAt, idleState.lastNonZeroAt, idleMinutes);
      await ddb.heartbeat({
        sessionId,
        instanceId,
        playerCount: overall === 'unknown' ? null : overall,
        idleDeadline: deadline.toISOString(),
        now,
      });

      const decision = decideIdleStop(idleState, deadline, now);
      if (decision.stop) {
        return finishStop(
          deps,
          activeParams,
          clusterDir,
          loadCompleted,
          { reason: decision.reason, next: null },
          joinableAt,
          dstBuildId,
          restoreResult.preStartVersionId,
          peakPlayers,
        );
      }
    }
  }
}

export async function runSupervisor(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  logger.info('runtime_version', { version: await readVersion() });

  const clock = createClock();
  const host = createHostAdapter();
  const imds = createImdsAdapter();
  const shardPort = createShardAdapter();

  const ddbDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.controlRegion }), {
    marshallOptions: { removeUndefinedValues: false },
  });
  const s3Client = new S3Client({ region: config.gameRegion });
  const ssmClient = new SSMClient({ region: config.gameRegion });

  const ddb = createDdbAdapter(ddbDoc, config.tableName, () => clock.now());
  const objects = createS3Adapter(s3Client, config.dataBucket);
  const secrets = createSsmAdapter(ssmClient);

  const deps: Deps = { config, logger, clock, ddb, objects, secrets, shardPort, host };

  let identity;
  try {
    identity = await imds.getIdentity();
  } catch (err) {
    logger.error('imds_identity_failed', { error: String(err) });
    await host.shutdownNow();
    return;
  }

  const initialState = await ddb.getState();
  if (isBootOrphan(identity.sessionIdTag, initialState)) {
    logger.warn('boot_orphan', {
      ownSessionId: identity.sessionIdTag,
      stateSessionId: initialState.sessionId,
      status: initialState.status,
    });
    await host.shutdownNow();
    return;
  }

  const claimed = await ddb.claim({
    sessionId: identity.sessionIdTag,
    instanceId: identity.instanceId,
    publicIp: identity.publicIp,
    now: clock.now(),
  });
  if (!claimed) {
    logger.warn('claim_failed_boot_orphan', {});
    await host.shutdownNow();
    return;
  }

  let worldId = initialState.worldId;
  let sessionId = identity.sessionIdTag;
  let desiredWorldId = initialState.desiredWorldId;
  let desiredBy = initialState.desiredBy;
  let desiredByNickname = initialState.desiredByNickname;
  const startedByNickname = initialState.startedByNickname;
  let skipInstall = false;

  if (worldId === null) {
    logger.error('claimed_state_missing_worldId', {});
    await ddb.errorNote({
      sessionId,
      instanceId: identity.instanceId,
      error: 'state item has no worldId at claim time',
      now: clock.now(),
    });
    await host.shutdownNow();
    return;
  }

  for (;;) {
    const world = await ddb.getWorld(worldId);
    if (world === null) {
      logger.error('world_registry_missing', { worldId });
      await ddb.errorNote({
        sessionId,
        instanceId: identity.instanceId,
        error: `world registry item missing: ${worldId}`,
        now: clock.now(),
      });
      await host.shutdownNow();
      return;
    }

    const outcome = await runSession(deps, {
      sessionId,
      instanceId: identity.instanceId,
      worldId,
      world,
      desiredWorldId,
      desiredBy,
      desiredByNickname,
      startedByNickname,
      startedAt: clock.now(),
      instanceType: identity.instanceType,
      skipInstall,
    });

    if (outcome.kind === 'halted') return;

    // In-place switch (docs/game-server.md §8): same instance, new session, binaries untouched.
    worldId = outcome.nextWorldId;
    sessionId = outcome.newSessionId;
    skipInstall = true;
    desiredWorldId = worldId;
    desiredBy = null;
    desiredByNickname = null;
  }
}

runSupervisor().catch((err: unknown) => {
  // A crash here means the loop never got to call `shutdown -h now` itself; `Restart=on-failure`
  // brings the process back, and past `StartLimitBurst` `dst-panic.service` takes over
  // (docs/game-server.md §6, §8). Never `console.error` an unredacted object.
  process.stderr.write(`supervisor_fatal ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
