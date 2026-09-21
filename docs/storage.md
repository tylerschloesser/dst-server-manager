# Storage, backups, world import, disaster recovery

Implements `docs/decisions.md` §8 and §16.22–16.23 plus the S3 half of world import. `decisions.md`
is the source of truth. Evidence: `docs/research/storage-and-cost.md` §4,
`docs/spikes/game-server-spike.md` §4–5.

Related docs: `docs/game-server.md` (who writes these keys, and when) · `docs/control-plane.md`
(shared constants, the registry item, `scripts/import-world.ts` registry half) · `docs/infra.md`
(the CDK that creates the bucket, its policy and its lifecycle rules) · `docs/testing.md` (the
lifecycle test's S3 assertions).

Every command below assumes:

```bash
export AWS_PROFILE=admin
B=dst-server-manager-data-063257577013
R=(--region us-west-2)        # an ARRAY, expanded as "${R[@]}"
```

`R` is an array on purpose. `R='--region us-west-2'` + `$R` is a **bash-only** idiom: zsh does not
word-split an unquoted parameter expansion, so `$R` arrives as one argument and every command below
fails with `Unknown options: --region us-west-2`. `R=(...)` + `"${R[@]}"` is correct in both shells.
If you would rather not think about it, write `--region us-west-2` out in full.

## 1. The data bucket

Name `dst-server-manager-data-063257577013`, region **us-west-2** (same region as the game instance:
transfer is free and fast), stack `DstGame`. **Versioning enabled** — backups *are* versions (§5).
Encryption **SSE-S3 (`AES256`)** with a bucket key; no KMS (no cross-account access, no audit need, no
per-request cost). **Block Public Access: all four settings `true`.** `RemovalPolicy.RETAIN`, so
`cdk destroy` can never take the saves with it. `enforceSSL: true` (emits the TLS deny in §3).
**`autoDeleteObjects` must NOT be set** (§3).

| Key | Written by | Read by |
|---|---|---|
| `seed/<worldId>/<original>.zip` | **admin only**, once (`scripts/import-world`) | admin only |
| `worlds/<worldId>/save.tar.zst` | instance role, on the stop path | instance role (restore), admin |
| `inflight/<worldId>/save.tar.zst` | instance role, every 10 min while running | admin only, manual recovery |
| `sessions/<worldId>/<sessionId>/manifest.json`, `{master,caves}/server{,_chat}_log.txt` and `supervisor.log` | instance role, at stop | admin; a future summarizer (§8) |
| `binaries/dst-binaries.tar.zst`, `binaries/buildid` | instance role | instance role |
| `runtime/**` | CDK `BucketDeployment`, at deploy time | instance role |
| `runtime-cache/node-v22.x.y-linux-x64.tar.xz` | instance role, first boot that misses it | instance role |

One world runs at a time, so `worlds/` and `inflight/` hold exactly **one key per world** — a versioned
key, not a directory of timestamps. `caves/` is absent when `hasCaves=false`.

## 2. Lifecycle configuration

Exactly three rules: two prefix-scoped version-retention rules, plus **one bucket-wide rule that
only aborts incomplete multipart uploads and expires no object** (decisions §16.19).
**`seed/`, `sessions/`, `binaries/`, `runtime/` and `runtime-cache/` have no expiration rule at
all** — nothing there ever expires.

```json
{
  "Rules": [
    {
      "ID": "worlds-noncurrent", "Status": "Enabled", "Filter": { "Prefix": "worlds/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30, "NewerNoncurrentVersions": 10 },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    },
    {
      "ID": "inflight-noncurrent", "Status": "Enabled", "Filter": { "Prefix": "inflight/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7, "NewerNoncurrentVersions": 3 },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    },
    {
      "ID": "abort-mpu", "Status": "Enabled", "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

In CDK (`docs/infra.md` §3.1): the two prefix rules are
`{ id, prefix, enabled: true, noncurrentVersionExpiration: Duration.days(N),
noncurrentVersionsToRetain: M, expiredObjectDeleteMarker: true }` and the third is
`{ id: 'abort-mpu', enabled: true, abortIncompleteMultipartUploadAfter: Duration.days(7) }` with no
prefix and no expiration. All three are asserted by a CDK unit test.

**Why this prunes old backups but never the latest one.** Two documented S3 behaviours, quoted in
`docs/research/storage-and-cost.md` §4.3 from
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html>:

1. *"The `NoncurrentVersionExpiration` action doesn't apply to the current object versions. It removes only the
   noncurrent versions."* The **current** version of `worlds/<id>/save.tar.zst` is structurally ineligible for
   expiry — after a year, or five, of nobody playing, the latest save is still there.
2. *"For the deletion to occur, both the `NoncurrentDays` and the `NewerNoncurrentVersions` values must be
   exceeded."* **Both**, not either — so the 10 newest *older* versions also survive regardless of age. A world
   untouched since 2027 keeps its latest save plus ten predecessors.

Only a version both older than 30 days **and** further back than the 10 newest noncurrent ones is pruned: zero
lines of our own pruning code, therefore zero chance of a pruning bug eating a save. Age-based
`Expiration{Days: N}` on timestamped `backups/<id>/<ts>` keys was rejected for exactly this reason — it deletes
on *creation age* and has no notion of "newest", so a year of silence deletes every backup including the last
(research §4.3). `ExpiredObjectDeleteMarker` is belt-and-braces: a delete marker can only appear from a
version-less `DeleteObject`, which §3 makes impossible, and even then the real save would merely become
noncurrent version #1, protected by `NewerNoncurrentVersions: 10`. The bucket-wide
`AbortIncompleteMultipartUpload` rule reclaims parts from a push that died mid-upload, anywhere in
the bucket; it expires no object and so cannot touch `seed/` or `sessions/`. Lifecycle is run by the
S3 service, **not** by a principal, so it is not subject to the bucket policy in §3 — the deny and
the rules do not fight.

## 3. Bucket policy

As deployed (`aws s3api get-bucket-policy`, verbatim shape — the TLS deny comes **first**, emitted by
`enforceSSL` and carrying **no `Sid`**, and only the delete deny is ours to name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny", "Principal": "*", "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::dst-server-manager-data-063257577013",
        "arn:aws:s3:::dst-server-manager-data-063257577013/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyDeleteOutsideScratchPrefixes", "Effect": "Deny", "Principal": "*",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      "NotResource": [
        "arn:aws:s3:::dst-server-manager-data-063257577013/runtime/*",
        "arn:aws:s3:::dst-server-manager-data-063257577013/runtime-cache/*",
        "arn:aws:s3:::dst-server-manager-data-063257577013/binaries/*",
        "arn:aws:s3:::dst-server-manager-data-063257577013/worlds/test-*",
        "arn:aws:s3:::dst-server-manager-data-063257577013/inflight/test-*",
        "arn:aws:s3:::dst-server-manager-data-063257577013/sessions/test-*"
      ]
    }
  ]
}
```

`DenyDeleteOutsideScratchPrefixes` is the `sid` in `packages/infra/lib/game-stack.ts`; an assertion
or a `jq` filter must use that name, and must not assume statement **count** or **order** —
`enforceSSL` adds its own.

- `NotResource` inverts the match: the deny covers every object key **except** those six patterns. A bucket policy
  is evaluated only for requests against its own bucket, so the wildcard cannot reach anything else.
- An explicit `Deny` beats every `Allow`, including `AdministratorAccess`. Deliberate: **nobody**, not even Tyler,
  can delete a save, a seed zip or a session log without first editing this policy. The exemptions are only
  self-healing caches (§9) and `test-*` scratch that `scripts/lifecycle-test.ts` cleans up. `s3:PutObject` is
  *not* denied — overwrites are safe because versioning keeps the old bytes.
- **`BucketDeployment`** prunes destination keys missing from the source asset (`prune: true`, the default). Deploy
  it with `destinationKeyPrefix: 'runtime'` so the prune stays inside `runtime/*`, which the policy exempts;
  without that exemption every deploy fails on `AccessDenied`. Never point one at the bucket root.
- **`autoDeleteObjects: true` must never be used here.** It attaches a custom resource that empties the bucket —
  every version, every prefix — on stack delete. The bucket is `RETAIN`.

**Deliberately deleting a real world (admin only).** Do it in one sitting; never leave the bucket unprotected.

```bash
# 1. Back up the live policy.
aws s3api get-bucket-policy --bucket "$B" "${R[@]}" --query Policy --output text > /tmp/dst-policy.json
# 2. Copy to /tmp/dst-policy-open.json, append "arn:aws:s3:::$B/worlds/doomed/*" to NotResource, put back.
aws s3api put-bucket-policy --bucket "$B" "${R[@]}" --policy file:///tmp/dst-policy-open.json
# 3. Delete EVERY version (a version-less delete only adds a delete marker).
aws s3api list-object-versions --bucket "$B" "${R[@]}" --prefix worlds/doomed/ \
  --query '[Versions,DeleteMarkers][].{Key:Key,VersionId:VersionId}' --output json > /tmp/vs.json
jq -c '.[]' /tmp/vs.json | while read -r v; do
  aws s3api delete-object --bucket "$B" "${R[@]}" \
    --key "$(jq -r .Key <<<"$v")" --version-id "$(jq -r .VersionId <<<"$v")"
done
# 4. Restore the real policy IMMEDIATELY.
aws s3api put-bucket-policy --bucket "$B" "${R[@]}" --policy file:///tmp/dst-policy.json
```

Then drop the registry item (`docs/control-plane.md`) and, if the world is gone for good, repeat step 3 for
`seed/doomed/`, `inflight/doomed/` and `sessions/doomed/`. The next `cdk deploy DstGame` re-asserts the policy —
a safety net if step 4 is forgotten, not a substitute for it.

## 4. IAM per principal

Nobody but the admin writes `seed/`. No principal is granted `s3:Delete*` outside the exempt prefixes, so
the identity policies and the bucket policy agree.

| Principal | Prefixes | Actions |
|---|---|---|
| Instance role `dst-server-manager-instance` | `worlds/*`, `binaries/*`, `runtime/*`, `runtime-cache/*` (**not** `inflight/*` — it is written, never read back) | `s3:GetObject`, `s3:GetObjectVersion` |
| | `worlds/*`, `inflight/*`, `sessions/*`, `binaries/*`, `runtime-cache/*` | `s3:PutObject` |
| | bucket ARN, `s3:prefix` limited to the above | `s3:ListBucket` |
| | `seed/*` | **none**. And no delete, anywhere. |
| API Lambda `dst-server-manager-api` | — | **no S3 access at all** (decisions §16.17): every route in `decisions.md` §10 uses DynamoDB, SSM and EC2 only |
| Reaper Lambda `dst-server-manager-reaper` | — | **no S3 access** |
| CDK `BucketDeployment` role (deploy time) | `runtime/*` + bucket `ListBucket` | `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` (pruning), `s3:GetBucketLocation` |
| Admin (`AWS_PROFILE=admin`) | everything | full, minus the delete deny |

`s3:GetObjectVersion` is on the instance role so a manual "start this world from version X" intervention needs no
IAM change. `s3:ListBucketVersions` is **not** granted to any automated principal: listing backup history is an
admin operation (§5, §10) and the admin profile already has it.

## 5. Backups: "before each start and after each stop"

Both halves are S3 versions of the single key `worlds/<worldId>/save.tar.zst`.

- **After each stop** — the stop sequence pushes the cluster to that key; `PutObject` returns
  `x-amz-version-id` and the supervisor records it as `postStopVersionId` in the session manifest. That new
  immutable version *is* the backup, and the previous one stays addressable.
- **Before each start** — no copy is made, because it would be byte-identical to the version already there.
  The supervisor records the `VersionId` it restored from as `preStartVersionId`, so restoring an unchanged
  world costs nothing and still pins "what this world looked like when the session began".
- **During a session** — every 10 minutes the cluster is tarred to `inflight/<worldId>/save.tar.zst`
  (recovery path §10.4). No forced `c_save()`; DST autosaves once per in-game day, ~8 min wall clock.

A world's whole backup history, one command (newest first):

```bash
aws s3api list-object-versions --bucket "$B" "${R[@]}" --prefix worlds/tylerni2026/save.tar.zst \
  --query 'Versions[].{When:LastModified,Latest:IsLatest,Size:Size,VersionId:VersionId}' --output table
```

Cross-reference a version id against `sessions/tylerni2026/*/manifest.json` to see which session produced
it and why that session ended.

## 6. The save tarball

zstd-compressed tar of the **contents** of the cluster directory — `cluster.ini`, `Master/`, `Caves/`,
`adminlist.txt`, ... at the archive root, **no wrapper directory** (decisions §16.22), so the archive is
independent of the on-disk cluster name. Measured: a 39 MB / 81-file cluster → **5.9 MB in 0.22 s** at
`zstd -3`, uploaded in 0.83 s (spike §4). `zstd -10` buys 1.7 % of size for 50 % more CPU — use `-3`,
zstd's default. **This command and this exclude list are the single definition** (decisions §16.36):
the on-instance `dst-pack-save` (`docs/game-server.md` §10) and `scripts/import-world.ts` (§7) both
**stage a copy of the cluster directory, blank the password in the staged `cluster.ini` *and* in
every staged `<Shard>/save/shardindex`, and run exactly this command with `-C` pointing at the
staging directory**. There is no second variant and no second exclude list, so both produce the
same member set and the same archive root.

```bash
CLUSTER_DIR=...   # the supervisor owns this constant (packages/supervisor)
OUT=/opt/dst/run/save.tar.zst

ZSTD_CLEVEL=3 ZSTD_NBTHREADS=0 tar --zstd -c -f "$OUT" -C "$CLUSTER_DIR" \
    --exclude='cluster_token.txt' \
    --exclude='*/save/server_temp' \
    --exclude='*/save/client_temp' \
    --exclude='*/save/cached_userid' \
    --exclude='*/server_log.txt' \
    --exclude='*/server_chat_log.txt' \
    --exclude='*/backup' \
    .
```

Extract with `tar --zstd -x -f - -C "$CLUSTER_DIR" --no-same-owner` (the archive's numeric uid need not exist on
the new instance).

| Excluded | Why |
|---|---|
| `cluster_token.txt` | the Klei credential — never in S3, never in git, never in a log. Written from SSM `/dst/klei-token` at boot. |
| `*/save/server_temp` | **BLOCKER, measured** (spike §5, `E_ROWID_EXIST`). Restoring the previous session's `server_temp` onto a new public IP makes the Master's lobby broadcast fail forever (`Master Server Broadcast Error: E_ROWID_EXIST`, 219 retries over 20 min) and — the part that kills the session — the Caves shard then **never links**, so the cluster is unjoinable while both Lua VMs happily answer console queries. Deleting these and restarting gave `Server registered via geo DNS`, zero errors, shard link in 42 s. |
| `*/save/client_temp`, `*/save/cached_userid` | the same per-instance identity scratch, removed together in the measured fix; all three are regenerated on boot. |
| `*/server_log.txt`, `*/server_chat_log.txt` | churn — and a *fresh* log per boot is exactly what the joinable and idle parsing need. The logs are preserved under `sessions/` instead (§8). |
| `*/backup` | DST's rotated `backup/server_log/`: the log-file exclusion again, pure duplication. **Not** the rollback data — `c_rollback` reads `save/session/<id>/`, which is kept. |

| Handled, **not** excluded | Why |
|---|---|
| `*/save/shardindex` | DST's own per-shard save index — a Lua table literal into which DST **mirrors the live server settings, the password included** (measured in T5.2: 3 of 28 live cluster files held the value, and 2 of them reached `worlds/<id>/save.tar.zst`, where deletes are denied by the §3 policy). The value is **blanked in the staged copy**, exactly as in `cluster.ini`. It must **not** be excluded: a shard whose `save/` carries no index reads as an *empty slot* and DST would generate a new world over the restored one. Blanking is safe because the value there is a mirror — the supervisor rewrites `cluster.ini` from `/dst/cluster-password` on every boot and DST re-populates the index from it. |

The save zip's own `backup.sh` excludes only `backup/` and `server_log.txt`, so a naive port of it inherits the
`E_ROWID_EXIST` bug. `docs/spikes/artifacts/dst-save-push` has the correct exclude list but the **wrong archive
layout** — it wraps the cluster in a directory. **Do not copy it verbatim** (decisions §16.22): take the list,
use the command above.

**Password blanking — two files, not one.** Before tarring, the `cluster_password` key in the staged
`cluster.ini` is emptied — key, `=`, end of line — **and** the mirrored `password` value in every
staged `<Shard>/save/shardindex` is emptied in place, so the value never reaches S3. At boot the
supervisor rewrites `cluster.ini` from SSM `/dst/cluster-password` and DST re-populates the shard
indexes from it; in this repo the line is always shown as
`cluster_password = <injected from SSM at boot>`. Both key names go through a variable below on
purpose: `scripts/check-secrets.sh` blocks any tracked line where that key is followed by a
real-looking value.

```bash
KEY=cluster_password
sed -E -i "s/^([[:space:]]*${KEY}[[:space:]]*=).*\$/\\1 /" "$STAGE/cluster.ini"

# Both spellings DST's serializer can emit: password="…" and ["password"]="…"
SKEY=password
SHARD_INDEX_SED='s/((\[")?'"$SKEY"'("\])?[[:space:]]*=[[:space:]]*)"[^"]*"/\1""/g'
find "$STAGE" -type f -name shardindex -path '*/save/shardindex' \
    -exec sed -E -i "$SHARD_INDEX_SED" {} +
```

`scripts/lib/save-tarball.ts` carries the `String.replace` twins of both substitutions
(`blankClusterPassword`, `blankShardIndexPassword`), verified to produce byte-identical output on
the same fixtures, plus the assertions `assertPasswordBlank` and
`assertShardIndexPasswordsBlank` (§7 step 7). Both regexes use the `g` flag: without it
`String.replace` rewrites only the **first** match, so a `cluster.ini` carrying two
`cluster_password` lines would keep the second value while the assertion still passed on the
blanked first line.

## 7. `scripts/import-world.ts` — the S3 side

```bash
AWS_PROFILE=admin pnpm tsx scripts/import-world.ts \
  --world-id tylerni2026 --zip ~/Downloads/dst-tylerni2026.zip
```

One script; the flag list and the registry half are in `docs/control-plane.md` §9. Run once per world, by
Tyler, with `AWS_PROFILE=admin`. Produces two objects plus one registry item; never modifies the source zip;
never prints the Klei token.

1. `WORK=$(mktemp -d)` — **outside the repo** — with `trap 'rm -rf "$WORK"' EXIT`. `set -euo pipefail`;
   never `set -x`.
2. `unzip -q "$ZIP" -d "$WORK/zip"`, then find the cluster as the parent of the one `cluster.ini`:
   `CLUSTER_DIR=$(dirname "$(find "$WORK/zip" -maxdepth 4 -name cluster.ini | head -1)")`. Tyler's zip also
   holds a `README.md` and a `scripts/` dir from a previous hosting approach — not part of the cluster, not
   uploaded to `worlds/`.
3. **Registry values**, read without printing the file: `serverName` = the `cluster_name` value under
   `[NETWORK]` (`sed -nE 's/^[[:space:]]*cluster_name[[:space:]]*=[[:space:]]*(.*)$/\1/p'`), the name
   players see in the browser; `hasCaves` = `true` iff `$CLUSTER_DIR/Caves/server.ini` exists;
   `source` = `import`; `displayName` defaults to `serverName` unless `--display-name` is given.
   `--server-name` and `--no-caves` override what the zip says.
4. **Seed, unchanged** — byte-identical to Tyler's disk, written once, never touched again, never read by
   the application: `aws s3 cp "$ZIP" "s3://$B/seed/tylerni2026/$(basename "$ZIP")" "${R[@]}" --no-progress`
5. **Sanitise a copy** into `$WORK/stage`: `cp -R "$CLUSTER_DIR/." "$WORK/stage"`, then
   `rm -f "$WORK/stage/cluster_token.txt"`, blank the password in the staged `cluster.ini` **and in
   every `*/save/shardindex`** (§6), and
   `rm -rf "$WORK"/stage/*/save/{server_temp,client_temp,cached_userid}`.
6. **Tar and upload** with the exact command from §6 (`-C "$WORK/stage"`), then
   `aws s3 cp "$WORK/save.tar.zst" "s3://$B/worlds/tylerni2026/save.tar.zst" "${R[@]}" --no-progress`.
7. **Verify before exiting**, failing the script if any check trips: this must print nothing —
   `tar --zstd -tf "$WORK/save.tar.zst" | grep -E 'cluster_token|server_temp|client_temp|cached_userid'`;
   assert with `grep -c` (never `echo`) that **no** staged `cluster_password` line carries a value
   (not merely that one blank line exists); and assert the same for the mirrored `password` value in
   every staged `*/save/shardindex`. A failure reports the offending **path only**, never the value.
8. **Registry write** — `pk="WORLD"`, `sk="tylerni2026"` in DynamoDB table `dst-server-manager`
   (us-east-1). Schema and the exact `put-item`: `docs/control-plane.md`.

Re-running for an existing id overwrites `worlds/<id>/save.tar.zst`, creating a new version, so the old
world stays recoverable (§10.3). It refuses to overwrite `seed/<id>/` — a unit test named exactly
`refuses to overwrite seed/` pins that (`docs/control-plane.md` §9).

**Test fixtures for this path are generated, never committed** (decisions §16.35). The zip this
script consumes, and the `cluster.ini` / `cluster_token.txt` inside it, are built at test time in a
`mktemp -d` directory and deleted afterwards: `.gitignore` and `scripts/check-secrets.sh` forbid
tracking `*.zip`, `cluster.ini` and `cluster_token.txt`, so a committed fixture cluster would fail
the pre-push hook. In any committed template or test string the password line reads exactly
`cluster_password = <injected from SSM at boot>` or uses a `${…}` interpolation.

## 8. Session logs and `manifest.json`

```
sessions/<worldId>/<sessionId>/manifest.json
sessions/<worldId>/<sessionId>/master/{server_log.txt,server_chat_log.txt}
sessions/<worldId>/<sessionId>/caves/{server_log.txt,server_chat_log.txt}   # omitted when hasCaves=false
sessions/<worldId>/<sessionId>/supervisor.log                               # decisions §16.22
```

`<sessionId>` is `YYYYMMDDTHHMMSSZ-<6 lowercase hex>` (decisions §16.3), which is why the prefix lists
chronologically. Uploaded by the supervisor in the stop sequence, after the save push and before the final
state write, each file scrubbed by exact match against the token and password values first (§11). Cheap
(~73 KB/hour/shard of poll output plus startup, spike §2) and permanent — no expiration rule.

```jsonc
{
  "sessionId": "20260919T201355Z-a7f3k2", // time-sortable, so the prefix lists chronologically
  "worldId": "tylerni2026",
  "startedBy": "nickname",                // state.startedByNickname, written by the API.
                                          // NEVER a SteamID64; the instance never reads /dst/users.
  "startedAt": "2026-09-19T20:13:04.000Z",
  "joinableAt": "2026-09-19T20:15:49.000Z",
  "stoppedAt": "2026-09-19T22:41:10.000Z",
  "stopReason": "idle",                   // the shared StopReason union; a manifest written by the
                                          // instance is always idle|user|switch|crash
  "peakPlayers": 3,
  "instanceType": "c6i.large",
  "dstBuildId": "24700372",
  "preStartVersionId": "3sL65...",        // the worlds/<id>/save.tar.zst version restored
  "postStopVersionId": "9kQp1..."         // the version this session wrote; null if the push failed
}
```

**Future LLM session summary (designed for, not built — `decisions.md` §15).** A summarizer would read exactly
one prefix, `sessions/<worldId>/<sessionId>/`: `manifest.json` for the frame (who, when, why it stopped, peak
players) and `*/server_chat_log.txt` for what happened, with `server_log.txt` and `supervisor.log` only as a
fallback. It would write
`sessions/<worldId>/<sessionId>/summary.md` beside them. Nothing in v1 writes that key and no principal has
permission to; the schema above is the only commitment.

## 9. Caches: `binaries/`, `runtime/`, `runtime-cache/`

All three are **safe to delete** — each self-heals, costing boot time or a deploy, never data. That is why they
are exempt from the delete deny in §3. If the game looks stale after a Steam update, deleting
`binaries/buildid` is the blunt, safe way to force a rebuild of the cache.

| Prefix | Contents | Size / cost | If deleted |
|---|---|---|---|
| `binaries/dst-binaries.tar.zst` + `binaries/buildid` | the DST install + steamcmd at `zstd -3 -T0`, and the Steam build id it was made from | 3.28 GB ≈ **$0.075/mo** | one slow session: the next boot does a cold `steamcmd +app_update 343050 validate` (measured 225-239 s instead of ~50 s; click-to-joinable **333 s instead of 142-164 s**) and re-uploads the tarball ~80 s after the world becomes joinable |
| `runtime/` | supervisor bundle, bash helpers, systemd units | < 1 MB, ~$0 | **boot fails**; fix with `AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk deploy DstGame` (no `--region`: the stack sets `env`) |
| `runtime-cache/` | the pinned Node 22 tarball (sha256-checked, origin nodejs.org) | ~30 MB, < $0.01/mo | re-downloaded from nodejs.org on the next boot, a few seconds |

## 10. Disaster-recovery runbook

**No automated restore exists, by design.** Everything here is manual and deliberate. **Before touching
anything: make sure the world is `stopped`** — a running supervisor will push over whatever you restore.

```bash
aws dynamodb get-item --region us-east-1 --table-name dst-server-manager \
  --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' --query 'Item.status.S' --output text
# must print: stopped     (otherwise stop the world in the UI and wait ~2 min)
```

**10.0 First resort: DST's own rollback, while the world is still running** — the one path that does *not*
want a stopped world; every S3 path below (10.1–10.6) does. The world keeps `max_snapshots = 6` in-game
snapshots, so if a player just did something catastrophic, roll back *in the game*: faster and
finer-grained than anything in S3. Then stop the world normally from the UI — the post-stop push captures
the rolled-back world as a new version, and there is nothing else to do.

```bash
aws ssm start-session --target <instanceId> --region us-west-2
sudo dst-console Master 'c_rollback(1)'    # n = 1..6
sudo dst-console Caves  'c_rollback(1)'    # both shards, if the world has caves
```

**10.1 List a world's versions** — the `list-object-versions` command in §5, newest first.

**10.2 Download a version and inspect it locally.**

```bash
T=$(mktemp -d)
aws s3api get-object --bucket "$B" "${R[@]}" --key worlds/tylerni2026/save.tar.zst \
  --version-id '<VERSION_ID>' "$T/save.tar.zst"
zstd -t "$T/save.tar.zst"                     # integrity
tar --zstd -tvf "$T/save.tar.zst" | head -40  # layout: cluster.ini, Master/, Caves/ at the root
tar --zstd -xf "$T/save.tar.zst" -C "$T" --no-same-owner
ls "$T/Master/save/session/"                  # the in-game snapshots shipped with this version
grep -c . "$T"/*/save/shardindex 2>/dev/null || true   # the index must exist per shard (§6)
```

An extracted tree must have **no** `cluster_token.txt`, a blank `cluster_password` line in
`cluster.ini`, and an empty `password` value in every `*/save/shardindex` (§6). A tarball written
before the `shardindex` blanking landed carries the cluster password in that file; it is still a
perfectly good save, but treat the object as sensitive and see `docs/follow-ups.md`.

**10.3 Roll a world back to an older version.** Copy the old version **over the current key**: that write
creates a *new* version, so the version you are abandoning is still there. Nothing is lost and the rollback
is itself undoable. Re-run 10.1 to confirm the new current version, then start the world from the UI.

```bash
aws s3api copy-object --bucket "$B" "${R[@]}" --key worlds/tylerni2026/save.tar.zst \
  --copy-source "$B/worlds/tylerni2026/save.tar.zst?versionId=<VERSION_ID>" --metadata-directive COPY
```

**10.4 Recover from `inflight/` after an instance died mid-session.** Symptom: the world stopped with
`lastStopReason` `crash`, `reaper-stale` or `reaper-max-age`, and the last session's `manifest.json` has a
null `postStopVersionId` (or is missing). If the in-flight object's timestamp is **newer** than the current
version of `worlds/tylerni2026/save.tar.zst`, it is the better world — at most 10 minutes of play behind
the crash. Inspect it as in 10.2, then promote it; the old `worlds/` version is kept as a noncurrent
version, so this is reversible via 10.3. `inflight/` keeps 3 versions for 7 days (§2): do it within the week.

```bash
aws s3api head-object --bucket "$B" "${R[@]}" --key inflight/tylerni2026/save.tar.zst \
  --query '{When:LastModified,Size:ContentLength}'
aws s3api copy-object --bucket "$B" "${R[@]}" --key worlds/tylerni2026/save.tar.zst \
  --copy-source "$B/inflight/tylerni2026/save.tar.zst" --metadata-directive COPY
```

**10.5 Restore from the immutable seed (nuclear option).** Discards all progress since the original import
and rebuilds `worlds/<id>/save.tar.zst` from the untouched zip. `--world-only` skips the `seed/` upload and
the registry write, which already exist. The resulting `worlds/` write is a new version on top of the
history, so even this is reversible.

```bash
T=${T:-$(mktemp -d)}        # 10.2 already set it; this makes the step standalone
aws s3 cp "s3://$B/seed/tylerni2026/dst-tylerni2026.zip" "$T/seed.zip" "${R[@]}"
pnpm tsx scripts/import-world.ts --world-id tylerni2026 --zip "$T/seed.zip" --world-only
```

`--world-only` requires `--zip` (it is the only thing it reads) and makes no DynamoDB write, so the
registry item and the `seed/` object are untouched. Run `pnpm tsx scripts/import-world.ts --help`
for the authoritative flag list.

**10.6 A save tarball is corrupt** — `zstd -t` fails, or `tar -t` stops early, or the world boots to a
fresh map.

1. Walk back one version at a time (10.1 → 10.2 → `zstd -t`) until one passes; promote it (10.3).
2. If several are bad, check `inflight/` (10.4).
3. If the world *boots* but never becomes joinable, suspect `E_ROWID_EXIST` first:
   `tar --zstd -tf save.tar.zst | grep -E 'server_temp|client_temp|cached_userid'` must print **nothing**.
   If it prints something, the tarball was built with a wrong exclude list (§6) — extract, delete those
   paths, re-tar, re-upload.
4. Last resort: 10.5.

## 11. Where the secrets and human-managed parameters live

None of these is ever in an S3 tarball, an S3 log object, a manifest, or this repo.

| Item | Location | Region |
|---|---|---|
| Klei cluster token | SSM SecureString `/dst/klei-token` | us-west-2 |
| Cluster password (shared by all worlds) | SSM SecureString `/dst/cluster-password` | us-west-2 |
| Allowlist `{steamid64: nickname}` | SSM String `/dst/users` | us-east-1 |
| Session-signing secret | SSM SecureString `/dst/session-secret` | us-east-1 |
| Budget alert address | SNS subscription on `dst-server-manager-budget` | us-east-1 |
| Tyler's original save zip | `s3://<data bucket>/seed/tylerni2026/`, and his own machine | us-west-2 |

All four SSM parameters are **human-managed: CDK never creates or owns them**, so no deploy can overwrite
them. All are tagged `project=dst-server-manager`. Storage-side obligations:

- The save tarball excludes `cluster_token.txt` and carries **blanked password lines — plural**: the
  `cluster_password` line in `cluster.ini` *and* the mirrored `password` value in every
  `<Shard>/save/shardindex` (§6). DST writes that second copy itself, from `cluster.ini`, on a
  shard's first boot; it is blanked rather than excluded because a shard with no save index reads as
  an empty slot. The supervisor re-injects `cluster.ini`'s value at boot from SSM and DST
  re-populates the indexes from it. `manifest.json` records `startedBy` as the **nickname** the API
  already resolved (`state.startedByNickname`) — never a SteamID64, never an email address. The
  instance has no IAM access to `/dst/users` at all (decisions §16.6).
- Before uploading `server_log.txt`, `server_chat_log.txt` **or `supervisor.log`** to `sessions/`, the
  supervisor asserts with a fixed-string check (`grep -F -q`, exact match on the values, decisions §16.22)
  that neither the token value nor the password value it fetched from SSM appears in the file, and redacts
  any matching line. It never echoes either value, in output or in an error. The scrub list is read
  from SSM at upload time, not accumulated as a side effect of earlier reveals — otherwise a
  supervisor resumed after a crash uploads unscrubbed logs (`docs/game-server.md` §10).
- `scripts/check-secrets.sh` runs as a pre-push hook and in CI, blocking the token pattern, a real-looking
  password value, key material, and any email address. **It has no SteamID64 pattern** — see
  `docs/follow-ups.md`.
