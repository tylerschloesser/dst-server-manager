// @dst/supervisor core: world templates for a *generated* cluster (docs/decisions.md §5,
// docs/game-server.md §5, §12). Used only for `source: 'generated' | 'test'` worlds — v1 restricts
// this path to `test-*` worlds. Every function returns file **contents** as a string; core/ never
// writes a file (that is a later task's `tasks/restore.ts`).
//
// The `cluster_password` line is always the literal placeholder below, never a real value:
// `scripts/check-secrets.sh` blocks any other value on that key's line, and the real value is
// written at boot by `core/ini.ts`'s `enforceClusterPassword` from `/dst/cluster-password`.
import { CAVES_SHARD_ID } from '@dst/shared';

export const CLUSTER_PASSWORD_PLACEHOLDER = 'cluster_password = <injected from SSM at boot>';

export interface GenerateClusterIniInput {
  readonly serverName: string;
  readonly hasCaves: boolean;
  /** 32 random hex characters, minted by the caller (core/ never generates randomness). */
  readonly clusterKey: string;
}

/** `cluster.ini` for a newly generated world (docs/game-server.md §5). */
export function generateClusterIni(input: GenerateClusterIniInput): string {
  return `[GAMEPLAY]
game_mode = survival
max_players = 6
pvp = false
pause_when_empty = true
vote_kick_enabled = false

[NETWORK]
cluster_name = ${input.serverName}
cluster_description =
${CLUSTER_PASSWORD_PLACEHOLDER}
cluster_intention = cooperative
lan_only_cluster = false
offline_cluster = false
cluster_language = en
autosaver_enabled = true

[MISC]
console_enabled = true
max_snapshots = 6

[SHARD]
shard_enabled = ${input.hasCaves}
bind_ip = 127.0.0.1
master_ip = 127.0.0.1
master_port = 10888
cluster_key = ${input.clusterKey}

[STEAM]
steam_group_only = false
steam_group_id = 0
steam_group_admins = false
`;
}

/** `Master/server.ini` (docs/game-server.md §5) — static, no per-world substitution. */
export const MASTER_SERVER_INI = `[NETWORK]
server_port = 10999
[SHARD]
is_master = true
[ACCOUNT]
encode_user_path = true
[STEAM]
master_server_port = 27016
authentication_port = 8766
`;

/** `Caves/server.ini` (docs/game-server.md §5); `cavesShardId` is `CAVES_SHARD_ID` from
 *  `@dst/shared`, threaded through as a parameter so core/ never hardcodes it twice. */
export function generateCavesServerIni(cavesShardId: number): string {
  return `[NETWORK]
server_port = 10998
[SHARD]
is_master = false
name = Caves
id = ${cavesShardId}
[ACCOUNT]
encode_user_path = true
[STEAM]
master_server_port = 27017
authentication_port = 8767
`;
}

/**
 * `<Shard>/worldgenoverride.lua` — how a generated cluster picks its level.
 *
 * **Not `leveldataoverride.lua`.** Measured on the first real boot
 * (docs/_first-boot-notes.md round 1): a hand-written `leveldataoverride.lua` is rejected clause
 * by clause by worldgen (`map/level.lua:92 Must specify the task set for a level!`, then
 * `map/storygen.lua:865 Must specify a layout mode for your level.`, ...) and the shard never
 * writes a `save/`, so the world is never joinable. Klei's own `scripts/shardindex.lua` says why:
 *
 *     -- leveldataoverride is for GAME USE. It contains a _complete level definition_ ...
 *     -- worldgenoverride is for USER USE. It contains optionally:
 *     --   a) a preset name. If present, this preset will be loaded and completely override
 *     --      existing save data ...
 *     --   b) a partial list of overrides that are layered on top of ...
 *
 * So a generated cluster names a **preset** and lets DST supply the complete definition.
 * `SURVIVAL_TOGETHER` (`scripts/map/levels/forest.lua`) and `DST_CAVE`
 * (`scripts/map/levels/caves.lua`) are the stock forest and caves presets; naming `DST_CAVE`
 * explicitly is also what keeps the Caves shard from silently generating a second forest, since
 * the no-override default is the forest survival level. The keys this file may carry, per
 * `SanityCheckWorldGenOverride`, are `override_enabled`, `preset`, `worldgen_preset`,
 * `settings_preset` and `overrides`.
 */
export const MASTER_WORLDGENOVERRIDE_LUA = `return { override_enabled = true, preset = "SURVIVAL_TOGETHER" }
`;

/** `Caves/worldgenoverride.lua` — the stock caves preset, for the same reasons as above. */
export const CAVES_WORLDGENOVERRIDE_LUA = `return { override_enabled = true, preset = "DST_CAVE" }
`;

export interface GeneratedClusterFile {
  /** Path relative to the cluster directory root, e.g. `"cluster.ini"` or `"Caves/server.ini"`. */
  readonly path: string;
  readonly content: string;
}

/**
 * The full set of files a **generated** cluster is made of (docs/game-server.md §5: "write no
 * `save/` directory anywhere, since DST decides generate-vs-load per shard by its presence"). No
 * `hasCaves=false` cluster gets a `Caves/` entry at all — never started, never polled.
 */
export function buildGeneratedClusterFiles(input: GenerateClusterIniInput): GeneratedClusterFile[] {
  const files: GeneratedClusterFile[] = [
    { path: 'cluster.ini', content: generateClusterIni(input) },
    { path: 'Master/server.ini', content: MASTER_SERVER_INI },
    { path: 'Master/worldgenoverride.lua', content: MASTER_WORLDGENOVERRIDE_LUA },
  ];
  if (input.hasCaves) {
    files.push(
      { path: 'Caves/server.ini', content: generateCavesServerIni(CAVES_SHARD_ID) },
      { path: 'Caves/worldgenoverride.lua', content: CAVES_WORLDGENOVERRIDE_LUA },
    );
  }
  return files;
}
