// @dst/shared: names, regions, ports, intervals, thresholds (docs/control-plane.md §1.1).
// Every other package imports these instead of redefining them (decisions §16.2).

export const PROJECT = 'dst-server-manager';
export const ACCOUNT_ID = '063257577013';

export const CONTROL_REGION = 'us-east-1'; // API, reaper, DynamoDB, site bucket
export const GAME_REGION = 'us-west-2'; // EC2, data bucket, game SSM params

export const TABLE_NAME = 'dst-server-manager';
export const LAUNCH_TEMPLATE_NAME = 'dst-server-manager-game';
export const SECURITY_GROUP_NAME = 'dst-server-manager-game';
export const INSTANCE_ROLE_NAME = 'dst-server-manager-instance';
export const DATA_BUCKET = 'dst-server-manager-data-063257577013';
export const SITE_BUCKET = 'dst-server-manager-site-063257577013';
export const API_FUNCTION_NAME = 'dst-server-manager-api';
export const REAPER_FUNCTION_NAME = 'dst-server-manager-reaper';

export const DOMAIN_NAME = 'dst.ty.ler.dev';
export const PUBLIC_ORIGIN_PROD = 'https://dst.ty.ler.dev';
export const HOSTED_ZONE_ID = 'Z038502736IM0QLQT7VFN';
export const ZONE_NAME = 'ty.ler.dev';

/** The stable join hostname (docs/decisions.md §17, docs/infra.md §4.4). An A record in the
 *  existing zone, written at RUNTIME by the supervisor (and sunk by the reaper) — never a CDK
 *  resource, so the stacks still own exactly two `AWS::Route53::RecordSet`s. Its whole purpose is
 *  that `c_connect` accepts a hostname, so the join command a friend saves stays correct across
 *  sessions even though the instance gets a fresh public IP on every boot. */
export const JOIN_HOSTNAME = 'play.dst.ty.ler.dev';
export const JOIN_DNS_TTL = 60;
/** RFC 5737 TEST-NET-1: parked, routes nowhere. Every stop UPSERTs the record to this instead of
 *  deleting it — a record left pointing at a released EC2 address would aim friends at whatever
 *  stranger AWS hands that IP to next, and UPSERT needs no knowledge of the current value. */
export const JOIN_DNS_SINK_IP = '192.0.2.1';
/** DST's Steam app id. `steam://run/<appid>` launches the game and nothing more: Steam ignores
 *  arguments passed through `steam://run/<appid>//<args>`, `steam://connect` is Source-only, and
 *  the DST client has no join launch parameter — there is no browser -> Steam -> DST auto-connect
 *  (docs/decisions.md §17). */
export const STEAM_LAUNCH_URL = 'steam://run/322330';

export const INSTANCE_TYPE = 'c6i.large'; // m6i.large is the upgrade path
export const INSTANCE_NAME_TAG = 'dst-game';
export const MASTER_PORT = 10999;
export const CAVES_PORT = 10998;
export const CAVES_SHARD_ID = 2; // pinned Caves shard id (decisions §16.5)

export const LOCAL_ONLY_MARKER = 'DST_LOCAL_ONLY'; // decisions §16.4

/** Exact string from docs/auth.md §8.3; `DstWeb` imports this instead of duplicating it. */
export const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; " +
  "base-uri 'self'; object-src 'none'";

export const PARAM_KLEI_TOKEN = '/dst/klei-token'; // us-west-2, SecureString
export const PARAM_CLUSTER_PASSWORD = '/dst/cluster-password'; // us-west-2, SecureString
export const PARAM_USERS = '/dst/users'; // us-east-1, String
export const PARAM_SESSION_SECRET = '/dst/session-secret'; // us-east-1, SecureString

export const DEFAULT_IDLE_MINUTES = 30;
export const PLAYER_POLL_MS = 30_000; // supervisor player-count poll
export const ZERO_READINGS_REQUIRED = 3; // consecutive zero polls before "empty"
export const DESIRED_POLL_MS = 10_000; // supervisor poll of the state item
export const STALE_HEARTBEAT_MS = 120_000; // 2 min -> API sets stale:true
export const MAX_SESSION_MS = 12 * 3_600_000; // 12 h -> reaper nulls desiredWorldId
export const MAX_SESSION_GRACE_MS = 600_000; // +10 min -> reaper terminates
export const REAPER_HEARTBEAT_STALE_MS = 600_000; // 10 min with no heartbeat
export const REAPER_BOOT_GRACE_MS = 900_000; // 15 min: too young to judge
export const STARTING_WITHOUT_INSTANCE_MS = 180_000; // 3 min in `starting`, no instance
export const PARAM_CACHE_MS = 60_000; // in-process SSM cache for the cluster password

export const WORLD_ID_RE = /^[a-z0-9-]{1,32}$/;
export const TEST_WORLD_PREFIX = 'test-';
