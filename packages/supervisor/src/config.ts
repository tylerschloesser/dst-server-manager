// @dst/supervisor: env + @dst/shared config (docs/game-server.md §3, §8). user-data writes
// /opt/dst/run/supervisor.env, which systemd loads into this process's environment via
// `EnvironmentFile=` on `dst-supervisor.service` (docs/game-server.md §6) — this module never
// reads the file itself. Falling back to the `@dst/shared` constants keeps a local invocation
// (e.g. `node dist/supervisor.js --help`-style smoke checks) from throwing on a missing env var.
import { CONTROL_REGION, DATA_BUCKET, GAME_REGION, TABLE_NAME } from '@dst/shared';

export interface SupervisorConfig {
  readonly dataBucket: string;
  readonly gameRegion: string;
  readonly tableName: string;
  readonly controlRegion: string;
  readonly dstRoot: string;
}

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : fallback;
}

export function loadConfig(): SupervisorConfig {
  return {
    dataBucket: readEnv('DST_BUCKET', DATA_BUCKET),
    gameRegion: readEnv('DST_REGION', GAME_REGION),
    tableName: readEnv('DST_TABLE', TABLE_NAME),
    controlRegion: readEnv('DST_TABLE_REGION', CONTROL_REGION),
    dstRoot: readEnv('DST_ROOT', '/opt/dst'),
  };
}
