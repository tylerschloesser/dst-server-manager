// @dst/supervisor: on-instance entrypoint — env -> adapters -> loop (docs/game-server.md §1, §8).
// This is the one impure module allowed to read the wall clock, touch the filesystem, spawn a
// process or call an AWS SDK directly (besides `src/adapters/*` and `src/tasks/*`, which it
// wires together). `core/` (pure) decides *what* to do via `reduce()`; this file decides *how*.
import { randomInt } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Route53Client } from '@aws-sdk/client-route-53';
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
  lobbyScratchPaths,
  shardsFor,
  shouldRecoverLobbyRegistration,
  shouldReportLobbyFailure,
  trackPeakPlayers,
} from './core';
import type {
  DnsPort,
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
import {
  buildSessionSnapshot,
  canResumeFrom,
  idleStateFromResumeInfo,
  readSessionSnapshot,
  toResumeInfo,
  writeSessionSnapshot,
  type ResumeInfo,
} from './adapters/sessionFile';
import { ShardLogState } from './adapters/shardLogState';
import { createShardAdapter } from './adapters/shards';
import { createRoute53Adapter } from './adapters/route53';
import { createS3Adapter } from './adapters/s3';
import { createSsmAdapter } from './adapters/ssm';
import { loadConfig, type SupervisorConfig } from './config';
import { installBinaries, repackBinariesInBackground } from './tasks/install';
import { readPauseWhenEmptyFromDisk, restoreOrGenerateWorld } from './tasks/restore';
import { packAndPushSave } from './tasks/savePush';
import { resolveSecretsToScrub, uploadSessionLogs } from './tasks/logsUpload';
import { createInflightCopier } from './tasks/inflight';
import { haltNow, publishJoinRecord } from './tasks/joinDns';
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
  readonly dns: DnsPort;
}

/** Rewritten on every phase change and every heartbeat (docs/game-server.md §8 "Crash handling").
 *  Never fatal: a full disk or a permissions problem here must not crash the loop, any more than a
 *  bad file on read should (`readSessionSnapshot`'s contract). */
async function persistSession(
  deps: Deps,
  input: {
    readonly phase: 'installing' | 'starting' | 'running' | 'stopping';
    readonly worldId: string;
    readonly sessionId: string;
    readonly startedAt: Date;
    readonly joinableAt: Date | null;
    readonly lastNonZeroAt: Date;
    readonly zeroStreak: number;
    readonly peakPlayers: number;
    readonly preStartVersionId: string | null;
    readonly dstBuildId: string;
  },
): Promise<void> {
  try {
    await writeSessionSnapshot(deps.config.dstRoot, buildSessionSnapshot(input));
  } catch (err) {
    deps.logger.warn('session_snapshot_write_failed', { error: String(err) });
  }
}

/** One nonce'd count round trip on one shard (docs/game-server.md §7).
 *
 * `pollLog` **must** advance that shard's `LogTailer`: the reply is only ever seen through the
 * tailed stream, and it lands ~100 ms after the console write. Without polling inside this wait
 * the reply is still unread when the 5 s deadline passes, every reading is UNKNOWN, no shard ever
 * completes a round trip, and the world never becomes joinable even though everything else about
 * it is healthy — measured on the first real boot (docs/_first-boot-notes.md round 1). */
async function queryShard(
  deps: Deps,
  log: ShardLogState,
  shard: Shard,
  pollLog: () => void,
  onConsoleFailure?: (error: string) => void,
): Promise<ShardReading> {
  const nonce = randomInt(1, 2 ** 31);
  try {
    await deps.shardPort.writeConsole(shard, buildCountQueryLine(nonce));
  } catch (err) {
    deps.logger.debug('write_console_failed', { shard, error: String(err) });
    onConsoleFailure?.(String(err));
    return { kind: 'unknown' };
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    pollLog();
    const reading = log.findCountReply(nonce);
    if (reading !== null) return reading;
    await sleep(100);
  }
  pollLog();
  const lateReading = log.findCountReply(nonce);
  return lateReading ?? { kind: 'unknown' };
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

/** The idle-clock snapshot threaded into `finishStop` purely so it can write `session.json`'s
 *  `phase: 'stopping'` line with real values instead of placeholders (docs/game-server.md §8:
 *  "rewritten on every phase change"). `stopping` is never itself resumed into (`toResumeInfo`),
 *  so nothing downstream depends on these being exact once a stop has begun. */
interface IdleSnapshot {
  readonly zeroStreak: number;
  readonly lastNonZeroAt: Date;
}

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
  idle: IdleSnapshot,
): Promise<SessionOutcome> {
  const { logger, clock, ddb, objects, shardPort, config } = deps;
  const { sessionId, instanceId, worldId, world } = params;
  const { reason } = stopping;
  // A `next` that names the world being stopped is not a switch: it is this session's own
  // `desiredWorldId`, which nothing has cleared. Treat it as "halt" (see `releaseDesire` below).
  const next = stopping.next === worldId ? null : stopping.next;

  // The stop sequence used to log nothing at all between `joinable` and the next session's
  // `joinable`, so an in-place switch that went wrong left a session log with a silent hole where
  // the whole shard stop, save push and switch commit should be (docs/_first-boot-notes.md
  // round 2). Each step below announces itself; the logs are uploaded with the session.
  logger.info('stop_begin', { worldId, sessionId, reason, next, loadCompleted });

  await persistSession(deps, {
    phase: 'stopping',
    worldId,
    sessionId,
    startedAt: params.startedAt,
    joinableAt,
    lastNonZeroAt: idle.lastNonZeroAt,
    zeroStreak: idle.zeroStreak,
    peakPlayers,
    preStartVersionId,
    dstBuildId,
  });

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

  // S8, and only when this stop ends the session (`next === null`). S6 is conditional on
  // `desiredWorldId` already being null, which is true only when a user pressed stop (W3) or the
  // reaper went graceful (R1). A world that stops on the supervisor's own initiative — `idle`, or
  // `crash` — is still its own `desiredWorldId`, so S6's condition failed and the "someone asked
  // for a world during shutdown" branch restarted the world that had just timed out, under a new
  // sessionId, forever: an idle world could never stop itself and the instance ran until the
  // reaper's 12-hour max age (measured on the first full lifecycle run,
  // docs/_first-boot-notes.md round 3). Released here, at the *start* of the stop rather than just
  // before S6, so a start arriving during the (tens of seconds of) shard stop, save push and log
  // upload still sets the desire again and still wins the S6 race as designed.
  if (!abandoned && next === null && reason !== 'user') {
    const released = await ddb.write({ kind: 'S8', sessionId, instanceId, worldId });
    logger.info('desire_released', { worldId, sessionId, reason, released });
  }

  await stopShardsInOrder({ shards: shardsFor(world.hasCaves), shardPort, logger });
  logger.info('shards_stopped', { worldId, sessionId });

  let postStopVersionId: string | null = null;
  if (loadCompleted) {
    const key = abandoned ? `inflight/${worldId}/save.tar.zst` : `worlds/${worldId}/save.tar.zst`;
    const outPath = `${config.dstRoot}/tmp/save-${sessionId}.tar.zst`;
    try {
      const result = await packAndPushSave({ clusterDir, outPath, key, objects });
      postStopVersionId = abandoned ? null : result.versionId;
      logger.info('save_pushed', { worldId, key, versionId: result.versionId });
    } catch (err) {
      logger.error('save_push_failed', { worldId, error: String(err) });
    }
  } else {
    logger.warn('save_push_skipped_world_never_loaded', { worldId, sessionId });
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
      secretsToScrub: await resolveSecretsToScrub(deps.secrets),
      manifest,
      objects,
    });
    logger.info('logs_uploaded', { worldId, sessionId });
  } catch (err) {
    logger.error('logs_upload_failed', { worldId, error: String(err) });
  }

  if (abandoned) {
    await haltNow(deps);
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
    logger.info('switch_commit', { from: worldId, to: next, newSessionId: newSid, s5Ok: ok });
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

  logger.info('halting', { worldId, sessionId, reason });
  await haltNow(deps);
  return { kind: 'halted' };
}

interface RunningLoopInput {
  readonly deps: Deps;
  readonly params: SessionParams;
  readonly clusterDir: string;
  readonly world: WorldRegistryItem;
  readonly masterLog: ShardLogState;
  readonly cavesLog: ShardLogState | null;
  readonly masterTailer: LogTailer;
  readonly cavesTailer: LogTailer | null;
  readonly joinableAt: Date;
  readonly dstBuildId: string;
  readonly preStartVersionId: string | null;
  readonly pauseWhenEmpty: boolean;
  readonly initialIdle: IdleState;
  readonly initialPeakPlayers: number;
  readonly initialLoadCompleted: boolean;
}

/** `running`: idle maths, heartbeats, inflight copies, reconciliation, and — on every heartbeat —
 *  the `session.json` write that makes a supervisor restart resumable instead of a silent idle-
 *  clock reset (docs/game-server.md §8). Shared by the normal post-joinable path and a resumed
 *  `running` session (docs/game-server.md §8 "Crash handling"). */
async function runRunningLoop(input: RunningLoopInput): Promise<SessionOutcome> {
  const { deps, params, clusterDir, world, masterLog, cavesLog, masterTailer, cavesTailer } = input;
  const { logger, clock, ddb, objects, shardPort, config } = deps;
  const { sessionId, instanceId, worldId } = params;
  const { joinableAt, dstBuildId, preStartVersionId } = input;
  const idleMinutes = world.idleMinutes;

  let idleState = input.initialIdle;
  let crossCheckEnabled = input.pauseWhenEmpty;
  let loadCompleted = input.initialLoadCompleted;
  let peakPlayers = input.initialPeakPlayers;

  await persistSession(deps, {
    phase: 'running',
    worldId,
    sessionId,
    startedAt: params.startedAt,
    joinableAt,
    lastNonZeroAt: idleState.lastNonZeroAt,
    zeroStreak: idleState.zeroStreak,
    peakPlayers,
    preStartVersionId,
    dstBuildId,
  });

  const inflightCopy = createInflightCopier({
    worldId,
    clusterDir,
    outPath: `${config.dstRoot}/tmp/inflight-${sessionId}.tar.zst`,
    objects,
    logger,
  });

  // Wall-clock schedules, not accumulated tick counts: every `await` inside the loop body (two
  // `systemctl is-active` calls, up to 5 s per shard for a count round trip, two DynamoDB writes)
  // used to push the next poll further out, so the heartbeat cadence drifted past 40 s under load
  // — measured on the first real boot, where the background binaries repack is running while the
  // world is first joinable (docs/_first-boot-notes.md round 1). Each deadline is now relative to
  // the previous poll's start, so work inside a cycle cannot stretch the period.
  let lastDesiredPollAt = clock.now().getTime();
  let lastCountPollAt = clock.now().getTime();
  let lastInflightAt = clock.now().getTime();

  const idleSnapshot = (): IdleSnapshot => ({
    zeroStreak: idleState.zeroStreak,
    lastNonZeroAt: idleState.lastNonZeroAt,
  });

  while (true) {
    masterTailer.poll();
    cavesTailer?.poll();
    if (masterLog.loadCompleted) loadCompleted = true;

    await sleep(RUNNING_TICK_MS);
    const tickAt = clock.now().getTime();

    if (tickAt - lastDesiredPollAt >= DESIRED_POLL_MS) {
      lastDesiredPollAt = tickAt;
      const [masterActive, cavesActive] = await Promise.all([
        shardPort.isActive('Master'),
        world.hasCaves ? shardPort.isActive('Caves') : Promise.resolve(true),
      ]);
      if (!masterActive || !cavesActive) {
        return finishStop(
          deps,
          params,
          clusterDir,
          loadCompleted,
          { reason: 'crash', next: null },
          joinableAt,
          dstBuildId,
          preStartVersionId,
          peakPlayers,
          idleSnapshot(),
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
          params,
          clusterDir,
          loadCompleted,
          { reason, next: state.desiredWorldId },
          joinableAt,
          dstBuildId,
          preStartVersionId,
          peakPlayers,
          idleSnapshot(),
        );
      }
    }

    if (tickAt - lastInflightAt >= INFLIGHT_INTERVAL_MS) {
      lastInflightAt = tickAt;
      void inflightCopy();
    }

    if (tickAt - lastCountPollAt >= PLAYER_POLL_MS) {
      lastCountPollAt = tickAt;
      const masterReading = await queryShard(deps, masterLog, 'Master', () => masterTailer.poll());
      const cavesReading =
        world.hasCaves && cavesLog !== null && cavesTailer !== null
          ? await queryShard(deps, cavesLog, 'Caves', () => cavesTailer.poll())
          : null;
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

      // The whole idle decision, once per 30 s poll, in one line. The running loop used to log
      // nothing at all, so a world that would not stop itself left a session log in which the idle
      // clock was entirely invisible and the only evidence was the state item's `playerCount`
      // (docs/_first-boot-notes.md round 3). Two lines a minute, uploaded with the session.
      logger.info('count_poll', {
        worldId,
        players: overall,
        master: masterReading,
        caves: cavesReading,
        simPaused: masterLog.pauseEdge,
        crossCheckEnabled,
        zeroStreak: idleState.zeroStreak,
        unknownStreak: idleState.unknownStreak,
        lastNonZeroAt: idleState.lastNonZeroAt.toISOString(),
        idleDeadline: deadline.toISOString(),
        secondsToDeadline: Math.round((deadline.getTime() - now.getTime()) / 1000),
      });

      await ddb.heartbeat({
        sessionId,
        instanceId,
        playerCount: overall === 'unknown' ? null : overall,
        idleDeadline: deadline.toISOString(),
        now,
      });

      // docs/game-server.md §8: rewritten on every heartbeat — this, plus `lastNonZeroAt` below,
      // is the whole crash-recovery property: a restart resumes the idle clock instead of
      // silently extending it (CLAUDE.md "Cost safety").
      await persistSession(deps, {
        phase: 'running',
        worldId,
        sessionId,
        startedAt: params.startedAt,
        joinableAt,
        lastNonZeroAt: idleState.lastNonZeroAt,
        zeroStreak: idleState.zeroStreak,
        peakPlayers,
        preStartVersionId,
        dstBuildId,
      });

      const decision = decideIdleStop(idleState, deadline, now);
      if (decision.stop) {
        return finishStop(
          deps,
          params,
          clusterDir,
          loadCompleted,
          { reason: decision.reason, next: null },
          joinableAt,
          dstBuildId,
          preStartVersionId,
          peakPlayers,
          idleSnapshot(),
        );
      }
    }
  }
}

async function runSession(
  deps: Deps,
  params: SessionParams,
  resume: ResumeInfo | null,
): Promise<SessionOutcome> {
  const { logger, clock, ddb, objects, secrets, shardPort, config } = deps;
  const { sessionId, instanceId, worldId, world } = params;
  const clusterDir = `${config.dstRoot}/klei/DoNotStarveTogether/${worldId}`;
  await mkdir(clusterDir, { recursive: true });
  logger.info('session_begin', {
    worldId,
    sessionId,
    hasCaves: world.hasCaves,
    skipInstall: params.skipInstall,
    resuming: resume !== null,
  });

  let activeParams = params;
  let preStartVersionId: string | null;
  let pauseWhenEmpty: boolean;
  /** Set by this session's single `installBinaries()` call; consumed once the world is joinable.
   *  Stays false on a resume or an in-place switch — neither touches the binaries cache again. */
  let repackNeeded = false;

  if (resume === null) {
    await persistSession(deps, {
      phase: 'installing',
      worldId,
      sessionId,
      startedAt: params.startedAt,
      joinableAt: null,
      lastNonZeroAt: params.startedAt,
      zeroStreak: 0,
      peakPlayers: 0,
      preStartVersionId: null,
      dstBuildId: '',
    });

    if (!params.skipInstall) {
      // The one and only install of this session (docs/game-server.md §4). Its `repackNeeded`
      // is carried to the joinable point below, where the repack is kicked off detached —
      // installing a second time there would block the loop (and re-extract the binaries
      // tarball over a live server): measured on the first real boot, that second install held
      // the running loop for 52 s warm and minutes cold, so no heartbeat was written right
      // after the world became joinable (docs/_first-boot-notes.md round 1).
      const installResult = await installBinaries({
        bucket: config.dataBucket,
        region: config.gameRegion,
        dstRoot: config.dstRoot,
        objects,
        logger,
      });
      repackNeeded = installResult.repackNeeded;
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
    preStartVersionId = restoreResult.preStartVersionId;
    pauseWhenEmpty = restoreResult.pauseWhenEmpty;
    await writeShardEnv(config.dstRoot, worldId);

    // docs/game-server.md §8 "installing": a cancellation mid-install starts no shards at all.
    const midState = await ddb.getState();
    if (midState.sessionId !== sessionId || midState.instanceId !== instanceId) {
      logger.warn('session_superseded_during_install', { worldId });
      await haltNow(deps);
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
        preStartVersionId,
        0,
        { zeroStreak: 0, lastNonZeroAt: params.startedAt },
      );
    }

    const desiredWorldId = midState.desiredWorldId;
    activeParams = {
      ...params,
      desiredWorldId,
      desiredBy: midState.desiredBy,
      desiredByNickname: midState.desiredByNickname,
    };

    const shards = shardsFor(world.hasCaves);
    for (const shard of shards) await shardPort.start(shard);
    logger.info('shards_started', { worldId, sessionId, shards, preStartVersionId });

    await persistSession(deps, {
      phase: 'starting',
      worldId,
      sessionId,
      startedAt: params.startedAt,
      joinableAt: null,
      lastNonZeroAt: params.startedAt,
      zeroStreak: 0,
      peakPlayers: 0,
      preStartVersionId,
      dstBuildId: '',
    });
  } else {
    // Resuming a crashed supervisor (docs/game-server.md §8 "Crash handling"): the shard units and
    // the on-disk cluster directory are exactly as the pre-crash process left them. Re-running
    // install/restore/start here would re-extract the tarball over a LIVE cluster directory or
    // fight the already-running shard units — never do either.
    logger.info('session_resumed', { phase: resume.phase, worldId, sessionId });
    preStartVersionId = resume.preStartVersionId;
    pauseWhenEmpty = await readPauseWhenEmptyFromDisk(clusterDir);
  }

  // One `ShardLogState` + `LogTailer` pair per shard generation. They are rebuilt (not reset) when
  // the lobby-registration recovery below restarts the shards, because every derived flag —
  // `registered`, `pauseEdge`, the broadcast-error count — must describe the *current* generation
  // of the shard processes, and a fresh `LogTailer` starts at offset 0 over the log the restarted
  // shard truncates.
  const allShards = shardsFor(world.hasCaves);
  const makeLogState = (): {
    masterLog: ShardLogState;
    cavesLog: ShardLogState | null;
    masterTailer: LogTailer;
    cavesTailer: LogTailer | null;
  } => {
    const master = new ShardLogState();
    const caves = world.hasCaves ? new ShardLogState() : null;
    return {
      masterLog: master,
      cavesLog: caves,
      masterTailer: new LogTailer(`${clusterDir}/Master/server_log.txt`, (l) => master.onLine(l)),
      cavesTailer:
        caves !== null
          ? new LogTailer(`${clusterDir}/Caves/server_log.txt`, (l) => caves.onLine(l))
          : null,
    };
  };
  let { masterLog, cavesLog, masterTailer, cavesTailer } = makeLogState();
  // docs/game-server.md §8: "re-scans the shard logs from 0 for the latest pause edge and the
  // joinable lines" — a fresh `LogTailer` already starts at offset 0, so one immediate poll
  // replays everything written before the crash and reconstructs `registered`/`cavesLinked`/
  // `pauseEdge`/`loadCompleted` before this function makes its first decision. A no-op on a truly
  // cold boot (the log does not exist yet).
  masterTailer.poll();
  cavesTailer?.poll();

  if (resume !== null && resume.phase === 'running') {
    const joinableAt = resume.joinableAt ?? clock.now();
    return runRunningLoop({
      deps,
      params: activeParams,
      clusterDir,
      world,
      masterLog,
      cavesLog,
      masterTailer,
      cavesTailer,
      joinableAt,
      dstBuildId: resume.dstBuildId,
      preStartVersionId,
      pauseWhenEmpty,
      initialIdle: idleStateFromResumeInfo(resume),
      initialPeakPlayers: resume.peakPlayers,
      initialLoadCompleted: masterLog.loadCompleted,
    });
  }

  const desiredWorldId = activeParams.desiredWorldId;
  const startedAt = resume?.startedAt ?? params.startedAt;
  const bootDeadline = startedAt.getTime() + BOOT_TIMEOUT_MS;
  let masterOk = false;
  let cavesOk = !world.hasCaves;
  let dstBuildId = resume?.dstBuildId ?? '';
  let lobbyRecoveries = 0;
  let lobbyFailureReported = false;

  // A console that never accepts a write is fatal to the boot — no count query can be answered, so
  // the joinable predicate can never complete — and it used to say so only in a `debug` line
  // repeated hundreds of times (docs/_first-boot-notes.md round 2: 281 of them over one 10-minute
  // hang, with `/opt/dst/run/Master.fifo` sitting there as a regular file). Say it once, loudly,
  // with the shard's own message, and put it in `lastError` where the UI and the state item can
  // show it.
  const consoleFailuresReported = new Set<Shard>();
  const noteConsoleFailure = (shard: Shard, error: string): void => {
    if (consoleFailuresReported.has(shard)) return;
    consoleFailuresReported.add(shard);
    logger.warn('shard_console_unwritable', { worldId, shard, error });
    void ddb
      .errorNote({
        sessionId,
        instanceId,
        error: `${shard} console is unwritable (see supervisor.log)`,
        now: clock.now(),
      })
      .catch(() => undefined);
  };

  // --- starting: poll the joinable predicate every 2 s until success or the 15-minute timeout.
  while (true) {
    masterTailer.poll();
    cavesTailer?.poll();

    if (!masterOk) {
      const reading = await queryShard(
        deps,
        masterLog,
        'Master',
        () => masterTailer.poll(),
        (e) => noteConsoleFailure('Master', e),
      );
      if (reading.kind !== 'unknown') masterOk = true;
    }
    if (world.hasCaves && cavesLog !== null && cavesTailer !== null && !cavesOk) {
      const tailer = cavesTailer;
      const reading = await queryShard(
        deps,
        cavesLog,
        'Caves',
        () => tailer.poll(),
        (e) => noteConsoleFailure('Caves', e),
      );
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
      // Which clause of the joinable predicate was still false is the whole diagnosis, and
      // `lastError` is capped at one short string (docs/control-plane.md §2), so it goes here.
      logger.error('boot_timeout', {
        worldId,
        minutes: BOOT_TIMEOUT_MS / 60_000,
        registered: masterLog.registered,
        cavesLinked: masterLog.cavesLinked,
        pauseEdgeSeen: masterLog.pauseEdge !== null,
        masterOk,
        cavesOk,
        loadCompleted: masterLog.loadCompleted,
        broadcastErrors: masterLog.broadcastErrorCount,
        lastBroadcastError: masterLog.lastBroadcastError,
        lobbyRecoveries,
      });
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
        preStartVersionId,
        0,
        { zeroStreak: 0, lastNonZeroAt: startedAt },
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
        preStartVersionId,
        0,
        { zeroStreak: 0, lastNonZeroAt: startedAt },
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
        preStartVersionId,
        0,
        { zeroStreak: 0, lastNonZeroAt: startedAt },
      );
    }

    // The Master is alive and healthy by every local signal but its Klei lobby broadcast keeps
    // failing, so `Server registered via geo DNS` — the real joinable gate — will never appear and
    // this boot would otherwise burn the whole 15-minute timeout in silence (spike §5,
    // docs/game-server.md §13, docs/_first-boot-notes.md round 2). Say so once, early, so the
    // state item and the UI carry a reason; `core/lobby.ts` explains why nothing is restarted on
    // the strength of it.
    const lobbyState = {
      registered: masterLog.registered,
      broadcastErrorCount: masterLog.broadcastErrorCount,
      recoveriesDone: lobbyRecoveries,
      reported: lobbyFailureReported,
    };
    if (shouldReportLobbyFailure(lobbyState)) {
      lobbyFailureReported = true;
      const code = masterLog.lastBroadcastError ?? 'unknown';
      logger.warn('lobby_registration_failing', {
        worldId,
        code,
        errors: masterLog.broadcastErrorCount,
      });
      await ddb.errorNote({
        sessionId,
        instanceId,
        error: `Klei lobby registration failing (${code}); retrying`,
        now: clock.now(),
      });
    }

    // Waiting has not worked, so try the other cause: a cluster carrying another server's lobby
    // identity in its per-session scratch. Clearing those three entries and restarting the shards
    // is what the spike measured as the cure; they hold no world data (they are three of the save
    // tarball's excludes), so this cannot lose a save.
    if (shouldRecoverLobbyRegistration(lobbyState)) {
      lobbyRecoveries++;
      const code = masterLog.lastBroadcastError ?? 'unknown';
      logger.warn('lobby_registration_stuck', {
        worldId,
        code,
        errors: masterLog.broadcastErrorCount,
        attempt: lobbyRecoveries,
      });
      await ddb.errorNote({
        sessionId,
        instanceId,
        error: `lobby registration failing (${code}); clearing per-session scratch`,
        now: clock.now(),
      });
      await stopShardsInOrder({ shards: allShards, shardPort, logger });
      for (const scratchPath of lobbyScratchPaths(clusterDir, allShards)) {
        try {
          await rm(scratchPath, { recursive: true, force: true });
        } catch (err) {
          logger.warn('lobby_scratch_rm_failed', { path: scratchPath, error: String(err) });
        }
      }
      ({ masterLog, cavesLog, masterTailer, cavesTailer } = makeLogState());
      masterOk = false;
      cavesOk = !world.hasCaves;
      lobbyFailureReported = false; // a fresh shard generation gets its own report
      try {
        for (const shard of allShards) await shardPort.start(shard);
        logger.info('lobby_registration_recovery_started_shards', {
          worldId,
          attempt: lobbyRecoveries,
        });
      } catch (err) {
        // Never throw out of the loop here: past S5 an uncaught throw restarts the supervisor into
        // a `stopping` snapshot it cannot resume from, and the boot-orphan check then powers the
        // instance off. Letting the next `systemctl is-active` see a dead shard takes the ordinary
        // crash-stop path instead, which still pushes whatever save exists.
        logger.error('lobby_registration_recovery_start_failed', { worldId, error: String(err) });
      }
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
  const idleDeadline = computeIdleDeadline(joinableAt, joinableAt, world.idleMinutes);
  await ddb.joinable({
    sessionId,
    instanceId,
    worldId,
    idleDeadline: idleDeadline.toISOString(),
    now: joinableAt,
  });
  logger.info('joinable', { worldId, sessionId });

  // §4 step 5: kick off the (best-effort, detached) repack now that the world is up, using the
  // `repackNeeded` the install phase already computed. Nothing is installed here: a second
  // install would block this function before the running loop starts, so no heartbeat would be
  // written for as long as it took. `repackNeeded` is false after a resume or an in-place switch,
  // neither of which touches the binaries cache again.
  if (repackNeeded) {
    repackBinariesInBackground({
      bucket: config.dataBucket,
      region: config.gameRegion,
      dstRoot: config.dstRoot,
      objects,
      logger,
    });
  }

  return runRunningLoop({
    deps,
    params: activeParams,
    clusterDir,
    world,
    masterLog,
    cavesLog,
    masterTailer,
    cavesTailer,
    joinableAt,
    dstBuildId,
    preStartVersionId,
    pauseWhenEmpty,
    initialIdle: initialIdleState(joinableAt),
    initialPeakPlayers: 0,
    initialLoadCompleted: masterLog.loadCompleted,
  });
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
  // Route 53 is global; its endpoint lives in us-east-1 regardless of where this instance runs.
  const route53Client = new Route53Client({ region: config.controlRegion });

  const ddb = createDdbAdapter(ddbDoc, config.tableName, () => clock.now());
  const objects = createS3Adapter(s3Client, config.dataBucket);
  const secrets = createSsmAdapter(ssmClient);
  const dns = createRoute53Adapter(route53Client);

  const deps: Deps = { config, logger, clock, ddb, objects, secrets, shardPort, host, dns };

  let identity;
  try {
    identity = await imds.getIdentity();
  } catch (err) {
    logger.error('imds_identity_failed', { error: String(err) });
    await haltNow(deps);
    return;
  }

  const initialState = await ddb.getState();

  // docs/game-server.md §8 "Crash handling": `Restart=on-failure` can bring this process back
  // while the shard units keep running untouched. Never let a bad/absent file do anything but
  // fall through to the ordinary boot-orphan/claim path below (readSessionSnapshot's contract).
  const snapshot = await readSessionSnapshot(config.dstRoot);
  const resumable = canResumeFrom(
    snapshot,
    {
      sessionId: initialState.sessionId,
      instanceId: initialState.instanceId,
      worldId: initialState.worldId,
    },
    identity.instanceId,
  );

  let worldId: string;
  let sessionId: string;
  let desiredWorldId: string | null;
  let desiredBy: string | null;
  let desiredByNickname: string | null;
  let startedByNickname: string | null;
  let skipInstall: boolean;
  let resumeInfo: ResumeInfo | null = null;

  // `canResumeFrom` already checked the phase is `starting`/`running`, so `toResumeInfo` returning
  // null here is unreachable — but the fallback (cold boot) is one branch away regardless, so a
  // parallel invariant is never trusted blindly.
  const resumeCandidate = resumable && snapshot !== null ? toResumeInfo(snapshot) : null;

  if (resumeCandidate !== null && snapshot !== null) {
    // Not a boot at all — the state item is already ours (S1 already ran before the crash) — so
    // no `isBootOrphan` check and no re-claim.
    worldId = snapshot.worldId;
    sessionId = snapshot.sessionId;
    desiredWorldId = initialState.desiredWorldId;
    desiredBy = initialState.desiredBy;
    desiredByNickname = initialState.desiredByNickname;
    startedByNickname = initialState.startedByNickname;
    skipInstall = true;
    resumeInfo = resumeCandidate;
    logger.info('session_json_resume', { phase: resumeInfo.phase, worldId, sessionId });
    // The IP has not changed (same instance, same boot), but the record may have been sunk by the
    // reaper while this process was down, so a resume republishes it rather than assuming.
    await publishJoinRecord(deps, identity.publicIp);
  } else {
    if (snapshot !== null) {
      logger.warn('session_json_present_but_not_resumable', {
        snapshotSessionId: snapshot.sessionId,
        snapshotWorldId: snapshot.worldId,
        stateSessionId: initialState.sessionId,
      });
    }

    if (isBootOrphan(identity.sessionIdTag, initialState)) {
      logger.warn('boot_orphan', {
        ownSessionId: identity.sessionIdTag,
        stateSessionId: initialState.sessionId,
        status: initialState.status,
      });
      await haltNow(deps);
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
      await haltNow(deps);
      return;
    }

    // The session is ours: point `JOIN_HOSTNAME` at this instance now, before the ~2.5 min of
    // install/restore/boot, so the record has propagated by the time the world is joinable
    // (docs/decisions.md §17, docs/game-server.md §8).
    await publishJoinRecord(deps, identity.publicIp);

    if (initialState.worldId === null) {
      logger.error('claimed_state_missing_worldId', {});
      await ddb.errorNote({
        sessionId: identity.sessionIdTag,
        instanceId: identity.instanceId,
        error: 'state item has no worldId at claim time',
        now: clock.now(),
      });
      await haltNow(deps);
      return;
    }

    worldId = initialState.worldId;
    sessionId = identity.sessionIdTag;
    desiredWorldId = initialState.desiredWorldId;
    desiredBy = initialState.desiredBy;
    desiredByNickname = initialState.desiredByNickname;
    startedByNickname = initialState.startedByNickname;
    skipInstall = false;
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
      await haltNow(deps);
      return;
    }

    const outcome = await runSession(
      deps,
      {
        sessionId,
        instanceId: identity.instanceId,
        worldId,
        world,
        desiredWorldId,
        desiredBy,
        desiredByNickname,
        startedByNickname,
        startedAt: resumeInfo?.startedAt ?? clock.now(),
        instanceType: identity.instanceType,
        skipInstall,
      },
      resumeInfo,
    );
    resumeInfo = null; // only the very first iteration may resume from a crash

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
