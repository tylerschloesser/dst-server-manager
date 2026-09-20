# Idle detection for an on-demand DST dedicated server

Research for: "Idle" = zero connected players. Shut down after 30 continuous idle minutes.
The clock starts when the server becomes **joinable**. Two shards (Master + Caves), no mods,
password protected, `pause_when_empty = true`, max 6 players.

Every claim below is tagged:

- **[SOURCE]** — verified against Klei's own game scripts (the `scripts/` folder shipped in the
  game, mirrored at <https://github.com/penguin0616/dst_gamescripts>), or against a config file /
  code that I read directly.
- **[LOGS]** — verified against **real `server_log.txt` / `server_chat_log.txt` files** from six
  independent clusters (see Sources). This is the strongest evidence class for log-line questions,
  because it is observed behaviour of the shipped engine rather than a claim about it.
- **[FIELD]** — taken from a working third-party implementation (a real DST server manager that
  people run). Strong evidence, but it is somebody else's reverse-engineering, not Klei's docs.
- **[FORUM]** — a forum/wiki/host-provider claim. Treat as a hint.
- **[INFERENCE]** — my reasoning from the above. Must be confirmed in the spike.

---

## TL;DR — recommendation

**Primary signal: console command into the shard's stdin + sentinel parse of `server_log.txt`.**

Poll **both** shards every 30 s, writing this one line to each shard's stdin:

```lua
local ok,s,c,a = pcall(function() return TheWorld.shard.components.shard_players:GetNumPlayers(), #GetPlayerClientTable(), #AllPlayers end) print("DSTQ "..NONCE.." "..tostring(ok).." "..tostring(s).." "..tostring(c).." "..tostring(a))
```

where `NONCE` is a fresh integer per poll. Then read the tail of each shard's `server_log.txt`
for `DSTQ <NONCE> <ok> <shardplayers> <clients> <allplayers>`.

Three numbers, because they have genuinely different meanings:

- **`shard_players:GetNumPlayers()` — the cluster-wide count, source-verified.** This is Klei's
  own engine-maintained total: `_numPlayers:set(_localPlayers + _secondaryShardPlayers)` where the
  secondary term comes from `TheShard:GetSecondaryShardPlayerCounts()` **[SOURCE]**
  `components/shard_players.lua:52-56`. It is a synced netvar, so it reads correctly from *either*
  shard. This single call answers the cluster-wide question outright. **It counts spawned player
  entities**, so a client sitting in character select is not yet counted.
- **`#GetPlayerClientTable()` — connected clients on this shard.** Klei's own helper, whose comment
  states its purpose exactly ("returns the client table with only the players in it, removing the
  dedicate host object if needed") **[SOURCE]** `networking.lua:924`. Unlike the above, this
  **does** include a client who is connected but still picking a character — which is precisely the
  player you must not shut the server down on.
- **`#AllPlayers` — spawned player entities in *this* shard.** **[SOURCE]**; only ever appended to
  in `prefabs/player_common.lua:2172`.

Idle decision — take the max, so no single definition can produce a false zero:

```
players = max(master.shardplayers, caves.shardplayers,
              master.clients, caves.clients,
              master.allplayers + caves.allplayers)
```

Treat a poll where the nonce did not come back as **UNKNOWN**, never as zero.

**Cross-check signal: `Sim paused` / `Sim unpaused` in the Master's `server_log.txt`.**

This turned out to be far better than expected. Against real logs **[LOGS]**:

- `Sim paused` / `Sim unpaused` track the **cluster-wide** player count, not the per-shard one.
  In one 3-shard cluster the Master logged `Sim paused` at the moment the only player
  disconnected from the **Loot** shard — a shard the Master has no players on.
- They are **mirrored into every shard's log** with matching (±1 s) timestamps.
- They **do not fire on shard migration**. A cluster with 8 recorded migrations logged exactly 6
  pause/unpause transitions, all matching genuine connects/disconnects.

So `Sim paused` is, in practice, a direct "cluster player count is now zero" edge. It is
edge-triggered (so on manager restart you must scan backwards for the most recent edge), and it
depends on `pause_when_empty = true`, which is already the configuration. Because it comes from a
completely different engine path than the client table, it is a genuinely independent cross-check.

**Third signal (change trigger): `[Join Announcement]` / `[Leave Announcement]` in
`Master/server_chat_log.txt`.** Confirmed migration-safe **[LOGS]** and **[SOURCE]**. Parse the
**Master's chat log only** — the file is byte-duplicated on every shard, so parsing both double
counts.

**Joinable signal (two-shard cluster):** on the **Master** log,

```
[00:01:03]: [Shard] Secondary shard Caves(2) connected: [LAN] 127.0.0.1
[00:01:03]: [Shard] Secondary Caves(2) ready!
[00:01:03]: World 2 is now connected
```

plus `Sim paused` (also Master). Require both, plus a successful console round-trip on each shard.
All of these are **[LOGS]**-verified verbatim. Note the shard id is **not always 2** — see §7.

---

## 1. Console command + log parse (RECOMMENDED PRIMARY)

### 1.1 Mechanism

The DST dedicated server on Linux reads Lua off **stdin** and `print()` output goes to stdout,
which the engine also writes to `<cluster>/<Shard>/server_log.txt` with a `[HH:MM:SS]: ` prefix.
So: write Lua to the process's stdin, read the answer out of the log file.

#### Two prerequisites that will silently break this if missed

1. **`console_enabled` must be on.** `cluster.ini` `[MISC] console_enabled` — *"Allow lua commands
   to be entered in the command prompt or terminal"* — defaults to **true** **[FORUM]** (Klei staff
   settings guide, <https://kleiforums.com/forums/topic/64552-dedicated-server-settings-guide/>).
   Klei's own `run_dedicated_servers.sh` additionally passes `-console`. Set it explicitly rather
   than relying on the default, and assert it in the spike.

2. **Caves needs its own stdin, and by default it does not have one.** Klei's shipped launch script
   **backgrounds the Caves shard**, so only the Master gets an interactive stdin **[FIELD]**. Since
   the recommended design polls **both** shards, the launcher must be written to give *each* shard
   its own FIFO — this does not come for free, and a naive copy of Klei's script will leave the
   Caves poll permanently UNKNOWN. This is the most likely way to get the wiring wrong.

   (It is also an argument for leaning on `shard_players:GetNumPlayers()`, which is a synced netvar
   and therefore returns the cluster total from the Master alone — so a Caves stdin failure
   degrades gracefully rather than blinding the poller.)

Three ways people actually deliver the stdin write, all field-proven:

| Method | How | Source |
|---|---|---|
| Named pipe (FIFO) as stdin | start the shard with `< /path/console_pipe`, hold the pipe open with a dummy writer, then `open(O_WRONLY\|O_NONBLOCK)` + write | `JemiloII/dst-manager` `src/server/services/monitor.ts:47-52` **[FIELD]** |
| `screen -X stuff` | `screen -S <name> -p 0 -X stuff "<lua>$(printf \\r)"` | `miracleEverywhere/dst-management-platform-api` `dst/world.go:384` **[FIELD]** |
| `tmux send-keys` | `tmux send-keys -t DST-dedicated '<lua>' Enter` | `TotalLag/dst-server-apprunner` `common/game_commands.py:44` **[FIELD]** |

For a systemd-managed instance the FIFO is cleanest — it survives without a terminal multiplexer
and needs no TTY. Gotcha: a FIFO with no writer gives the server EOF on stdin; keep a writer fd
open for the lifetime of the shard (e.g. `sleep infinity > pipe &` or hold the fd from the
supervisor).

Another gotcha, reported by a working tool: **do not close the pipe immediately after writing** —
"Closing the pipe before the command gets executed by the process cancels the output, so we sleep"
(`jaakkytt/dst-server-status-bot` `print.py`) **[FIELD]**. Budget ~1-2 s between write and read.

### 1.2 The exact Lua

#### Do NOT use `c_listallplayers()` as the primary

**[SOURCE]** `consolecommands.lua:291-295`:

```lua
--- Return a listing of AllPlayers table
function c_listallplayers()
    for i, v in ipairs(AllPlayers) do
        print(string.format("[%d] (%s) %s <%s>", i, v.userid, v.name, v.prefab))
    end
end
```

So the log lines look like:

```
[00:12:34]: [1] (KU_aBcDeFgH) Tyler <wilson>
```

Regex: `^\[\d\d:\d\d:\d\d\]: \[(\d+)\] \((KU_[A-Za-z0-9_-]+)\) (.*) <([a-z0-9_]+)>`

Two problems:

1. `AllPlayers` is **per-shard**. **[SOURCE]** — the only insertion site in the whole script
   tree is `prefabs/player_common.lua:2172` (`table.insert(AllPlayers, inst)`), i.e. it is
   populated when a *player entity spawns in this shard's simulation*, and removed at
   `player_common.lua:1122`. A player in Caves is not in the Master's `AllPlayers`.
2. **Zero players prints nothing at all.** An empty loop emits no line, so "no output" is
   ambiguous between "zero players" and "the command never ran / the server is wedged". That is
   exactly the ambiguity that must not exist in an auto-shutdown path.

`c_listallplayers` is still useful as a *human* debugging command and as a secondary
cross-check, but not as the primary.

There is also `c_getnumplayers()` **[SOURCE]** `consolecommands.lua:270-272`:

```lua
function c_getnumplayers()
    print(#AllPlayers)
end
```

which at least always prints a number — but it is still `#AllPlayers`, so it is per-shard and
misses clients on the character-select screen. Handy at a human console; not the primary.

#### `c_listplayers()` — the right idea, still not ideal

**[SOURCE]** `consolecommands.lua:279-288`:

```lua
function c_listplayers()
    local isdedicated = not TheNet:GetServerIsClientHosted()
    local index = 1
    for i, v in ipairs(TheNet:GetClientTable() or {}) do
        if not isdedicated or v.performance == nil then
            print(string.format("%s[%d] (%s) %s <%s>", v.admin and "*" or " ", index, v.userid, v.name, v.prefab))
            index = index + 1
        end
    end
end
```

This is the canonical, Klei-authored way to **exclude the dedicated-server host entry**: on a
dedicated server the host's row in the client table is the one that carries a `performance`
field. Same "zero players prints nothing" problem, though.

#### USE THIS: `GetPlayerClientTable()`

**[SOURCE]** `networking.lua:923-940` — this is Klei's own helper and its comment states its
purpose exactly:

```lua
-- returns the client table with only the players in it, removing the dedicate host object if needed
function GetPlayerClientTable()
    local ClientObjs = TheNet:GetClientTable()
    if ClientObjs == nil then
        return {}
    elseif TheNet:GetServerIsClientHosted() then
        return ClientObjs
    end

    --remove dedicate host from player list
    for i, v in ipairs(ClientObjs) do
        if v.performance ~= nil then
            table.remove(ClientObjs, i)
            break
        end
    end
    return ClientObjs
end
```

It is a global in `networking.lua`, which is core server script, so it exists on a dedicated
server with no mods. Klei uses it themselves for "am I the only player here" logic in
`screens/redux/pausescreen.lua:46` (`#GetPlayerClientTable() == 1`). **[SOURCE]**

Therefore `#GetPlayerClientTable()` is the real-player count on that shard's client table, host
already excluded, no mods needed.

#### BEST: `TheWorld.shard.components.shard_players:GetNumPlayers()`

This is the one signal that is **source-verified cluster-wide**, and it makes Open question #1
largely moot. **[SOURCE]** `components/shard_players.lua`:

```lua
local UpdatePlayerCounts = _ismastershard and function()
    if _localDirty then
        _localPlayers, _localGhosts = 0, 0
        for i, v in ipairs(AllPlayers) do
            _localPlayers = _localPlayers + 1
            ...
    end
    if _secondaryShardDirty then
        _secondaryShardPlayers, _secondaryShardGhosts = TheShard:GetSecondaryShardPlayerCounts(USERFLAGS.IS_GHOST)
        _secondaryShardDirty = false
    end
    _numPlayers:set(_localPlayers + _secondaryShardPlayers)
    _numGhosts:set(_localGhosts + _secondaryShardGhosts)
end or nil
```

Key properties, all **[SOURCE]**:

- It is computed **on the master shard** (`_ismastershard`) as `local AllPlayers` **plus**
  `TheShard:GetSecondaryShardPlayerCounts()` — an explicit cluster-wide sum. This is Klei's own
  answer to "how many players are on this whole cluster".
- `_numPlayers` is a `net_byte` (`shard_players._numPlayers`), i.e. a **synced network variable**,
  so `GetNumPlayers()` returns the same cluster-wide total when called on the **Caves** shard too.
- Registered on the shard network entity in `prefabs/shard_network.lua:35`
  (`inst:AddComponent("shard_players")`), so the accessor path is
  `TheWorld.shard.components.shard_players`.
- Public API: `GetNumPlayers()`, `GetNumGhosts()`, `GetNumAlive()`.
- Klei uses it for genuinely cluster-wide mechanics: `components/sanity.lua:357-358` reads
  `GetNumGhosts()` / `GetNumAlive()` for the dead-player sanity drain (which must count ghosts in
  caves), and `components/worldreset.lua:199-201` uses all three.

**Caveat — it counts entities, not connections.** `_localPlayers` is derived from `AllPlayers`, so
a client who is connected but still in the character-select lobby, or mid-migration, is **not**
counted. For a shutdown decision that is the dangerous direction, which is why the recommended
command also reports `#GetPlayerClientTable()` and takes the max.

A second caveat: `net_byte` saturates at 255. Irrelevant at 6 players.

If this proves out in the spike, it is strictly the best primary — it is the only option that is
cluster-wide *by construction* rather than by inference.

#### The command to actually send

```lua
local ok,s,c,a = pcall(function() return TheWorld.shard.components.shard_players:GetNumPlayers(), #GetPlayerClientTable(), #AllPlayers end) print("DSTQ 1737412345 "..tostring(ok).." "..tostring(s).." "..tostring(c).." "..tostring(a))
```

Healthy line: `DSTQ 1737412345 true 2 2 1`. Not-ready line: `DSTQ 1737412345 false <err> nil nil`.

Regex: `DSTQ (\d+) (true|false) (\S+) (\S+) (\S+)`

The `pcall` matters: `TheWorld.shard` does not exist before the shard network entity spawns, and
indexing it would throw. Wrapping makes "the command ran but the game is not ready" a *third*,
distinguishable state rather than being lumped in with "the command never ran". Parse
`ok == "true"` before trusting any of the three numbers.

Notes:

- **Always use string concatenation, not multiple `print` args.** **[SOURCE]** `debugprint.lua`
  `packstring()` joins args with `"\t"` *and appends a trailing tab*, so `print("A", 5)` yields
  `A\t5\t`. Concatenation yields `A 5\t` — still one trailing tab, so anchor your regex on the
  left and tolerate trailing whitespace.
- The `1737412345` is the **nonce**. Without it you cannot distinguish "the server answered 0"
  from "the server never answered". This is the single most important detail in the whole design.
- Emitting all three numbers costs nothing and lets the poller cross-check them against each other
  at runtime, rather than betting the design on one of them being right.
- `GetPlayerClientTable()` collapses a nil client table to `{}` (count 0), so on its own it cannot
  distinguish "not ready" from "empty" — the `ok` flag and the other two numbers cover that.

For readability the spike steps below use a shortened `DSTQ <n> <shard> <clients> <all>` form.
Ship the `pcall` version.

If the Lua throws anyway, `ExecuteConsoleCommand` catches it with `pcall` and `nolineprint`s the error
**[SOURCE]** `mainfunctions.lua:2093-2110`:

```lua
function ExecuteConsoleCommand(fnstr, guid, x, z)
    ...
    local status, r = pcall(loadstring(fnstr))
    if not status then
        nolineprint(r)
    end
    ...
end
```

so a broken command shows up as an error line in the log, not a crash. Good — but also means a
typo silently yields "no nonce", i.e. UNKNOWN. Test the exact string in the spike.

### 1.3 Field-proven variants (corroboration)

`JemiloII/dst-manager` (`src/server/services/monitor.ts:27`) sends, **to the Master shard only**,
and parses `__PC:` out of the Master log **[FIELD]**:

```lua
local t=TheNet:GetClientTable() if t then local k={} for i,v in ipairs(t) do if v.userid~="" and v.netid~=nil and v.netid~="" then k[#k+1]=v.userid end end print("__PC:"..#k..":"..table.concat(k,",")) end
```

It excludes the host by `netid` (Steam ID) being empty rather than by `performance`. Its poll
interval is 15 s (`setInterval(queryPlayers, 15000)`), with a first poll 3 s after start.
Note this tool **assumes the Master's client table is cluster-wide** — it never queries Caves for
player data. That is corroborating but not proof.

`miracleEverywhere/dst-management-platform-api` (`dst/world.go:384`) does the same via `screen`,
with delimiter sentinels and a 2 s sleep, then reads the **last 4 KB** of `server_log.txt`
backwards to the sentinel **[FIELD]**:

```go
listScreenCmd := fmt.Sprintf("screen -S \"%s\" -p 0 -X stuff \"for i, v in ipairs(TheNet:GetClientTable()) do  print(string.format(\\\"playerlist %%s [%%d] %%s <-@dmp@-> %%s <-@dmp@-> %%s\\\", 99999999, i-1, v.userid, v.name, v.prefab )) end$(printf \\\\r)\"\n", world.screenName)
```

and filters the host by **name**:

```go
playerListPattern = regexp.MustCompile(`playerlist 99999999 \[[0-9]+\] (KU_.+) <-@dmp@-> (.*) <-@dmp@-> (.+)?`)
hostPattern       = regexp.MustCompile(`\[Host]`)
```

This independently confirms that the dedicated host's row appears in the client table with the
display name literally `[Host]` — which also matches `widgets/redux/serverpausewidget.lua:20`
(`elseif source == "[Host]" then`) **[SOURCE]**.

**Three independent host-exclusion filters** therefore exist: `performance ~= nil` (Klei's own),
`netid == ""`, and `name == "[Host]"`. Use Klei's; assert in the spike that all three agree.

### 1.4 Client table fields

**[SOURCE]** from `screens/playerstatusscreen.lua`, the fields present on each client row are:
`admin`, `base_skin`, `colour`, `muted`, `netid`, `netscore`, `performance`, `playerage`,
`prefab`, `userflags`, `userid`.

**There is no `shard` / `shardid` field.** If the table were cluster-wide you might expect one, so
its absence is mild evidence toward per-shard.

But the strongest source-level evidence points the other way — **the voting system**.
`components/worldvoter.lua` gates almost everything on `_ismastershard`, i.e. it runs **only on
the Master**, and `OnStartVote` builds the entire voter roster from the Master's client table
**[SOURCE]** (`worldvoter.lua:347-351`):

```lua
local OnStartVote = _ismastershard and function(src, data)
    ...
    for i, v in ipairs(TheNet:GetClientTable() or {}) do
        if v.performance == nil or TheNet:GetServerIsClientHosted() then
            _voterdata[v.userid] = ... VOTE_PENDING
        end
    end
```

DST votes (vote-kick, vote-rollback) are cluster-wide — a player in Caves can vote, and can be
the target. Likewise `usercommands.lua:216-226` computes vote quorum as
`numclients = isdedicated and #clients - 1 or #clients` from the same table **[SOURCE]**. If the
Master's client table were per-shard, every Caves player would be silently excluded from both the
roster and the quorum, and vote-kick would be broken on every caves cluster — which it is not.

Corroborating from a different direction: `Sim paused` demonstrably tracks **cluster-wide**
population **[LOGS]** (§3.1), so the engine certainly maintains a cluster-wide count somewhere.

**[INFERENCE], now fairly strong: the client table on the Master is cluster-wide.** Still listed
as Open question #1 because it is inference from how Klei's code would have to behave, not an
observation. The `max()` formula in the design makes it moot either way.

### 1.5 Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Command never executes (process wedged, FIFO writer gone, stdin EOF) | no nonce in log | UNKNOWN, not zero. After K consecutive UNKNOWNs, escalate to the crash path. |
| Read too soon after write | no nonce yet | sleep 1-2 s; also tolerate the nonce arriving on the *next* poll's read. |
| Log rotation / truncation | offset past EOF | `if stat.size < offset then offset = 0` — exactly what `monitor.ts` does **[FIELD]**. Read by tail-bytes (last 8-16 KB) rather than by offset for robustness. |
| Very early boot | `GetClientTable()` is nil → count 0 | the `true/false` field in the payload; plus don't start the idle clock until joinable. |
| `print` arg tabs | regex fails | concatenate, tolerate trailing `\t`. |
| Lua error | error text in log, no nonce | UNKNOWN. Log the error line for diagnosis. |

### 1.6 Works with no mods?

Yes. `GetPlayerClientTable`, `AllPlayers`, `c_listplayers`, `c_listallplayers` are all core game
scripts. **[SOURCE]**

---

## 2. Passive log parsing

### 2.1 The two log files, and which one matters

**[LOGS]** — grepping 11 real `server_log.txt` files from 6 independent clusters: **zero**
occurrences of `Announcement` in any of them. Join/leave announcements exist **only** in
`server_chat_log.txt`. Conversely, `Sim paused`, connection lines and shard lines exist only in
`server_log.txt`.

**`server_chat_log.txt` is byte-duplicated on every shard.** **[LOGS]** A 3-shard cluster produced
three copies of the same announcement list, timestamps identical or +1 s. Parsing both Master and
Caves chat logs double counts. **Parse `Master/server_chat_log.txt` only.**

Real content, verbatim (`chientrm/dst-configs`, `3Shards/Master/server_chat_log.txt`, complete
file) **[LOGS]**:

```
[00:03:30]: [Join Announcement] chientrm
[00:04:26]: [Leave Announcement] chientrm
[00:12:03]: [Join Announcement] chientrm
[00:24:49]: [Leave Announcement] chientrm
[00:34:28]: [Skin Announcement] chientrm hand_wendy_gladiator
[00:37:33]: [Death Announcement] chientrm was killed by Darkness. He became a spooky ghost!
[00:37:33]: [Resurrect Announcement] chientrm was resurrected by TMIR Console.
```

Multi-player, with a name containing a space (`brofathan/dst-test`) **[LOGS]**:

```
[00:04:42]: [Join Announcement] profiling profiling
[01:13:31]: [Leave Announcement] profiling profiling
[01:13:31]: [Leave Announcement] johnpork
```

Regexes:

```
^\[(\d+):(\d\d):(\d\d)\]: \[Join Announcement\] (.+)$
^\[(\d+):(\d\d):(\d\d)\]: \[Leave Announcement\] (.+)$
```

Two traps, both **[LOGS]**:

- **The hours field is not two digits.** The timestamp is server **uptime**, not wall clock, so it
  grows past `99:` on a long-running server. Use `\d+`, not `\d{2}`.
- **Player names contain spaces and non-ASCII** (`profiling profiling`, `果断就会白给`). Capture
  with `(.+)$`, never `(\S+)`.

The `[Join Announcement]` / `[Leave Announcement]` tags are **not localised** — a Portuguese
server localises the death text but keeps the English announcement tags **[LOGS]**.

### 2.2 The migration question — resolved, and the answer is good

The worry was that a player walking down a sinkhole would produce a spurious `[Leave
Announcement]` on Master and `[Join Announcement]` on Caves. **It does not.**

**[SOURCE]** `mainfunctions.lua:1731-1740` — Klei explicitly moved this:

```lua
function OnPlayerLeave(player_guid, expected)
    if TheWorld.ismastersim and player_guid ~= nil then
        local player = Ents[player_guid]
        if player ~= nil then
            --V2C: #spawn #despawn
            --     This was where we used to announce player left.
            --     Now we announce it when you actually disconnect
            --     but not during a shard migration disconnection.
```

**[LOGS]** — and this is confirmed empirically on two independent clusters:

- `brofathan/dst-test` migrated at `00:19:52`→`00:20:07` and `00:23:18`→`00:23:31`. Its chat log
  has **nothing** between `00:16:55` and `00:40:24`.
- `chientrm/dst-configs` performed **8** migrations. Its chat logs contain **zero** announcements
  at any of those 8 timestamps.

The announcement functions are invoked from the engine, not Lua — `networking.lua:105` carries
`-- TODO V2C: Call these appropriately from C` **[SOURCE]**.

### 2.3 What a migration DOES emit — and why `server_log.txt` counting is wrong

**[LOGS]**, Master side of a sinkhole transit:

```
[00:19:52]: [Shard] Migration request: (KU_LTP5EzVJ) to Caves(4023110734)
[00:19:52]: [Shard] Begin migration #1 for (KU_LTP5EzVJ)
[00:19:52]: CloseConnectionWithReason: ID_DST_SHARD_SILENT_DISCONNECT
[00:19:53]: [Shard] (KU_LTP5EzVJ) disconnected from Master(1)
[00:20:07]: [Shard] Completed migration #1 for player (KU_LTP5EzVJ)
```

Caves side of the same transit:

```
[00:20:06]: New incoming connection 30.73.66.126|1 <4940430371463236824>
[00:20:06]: Client connected from 30.73.66.126|1 <4940430371463236824>
[00:20:06]: ValidateGameSessionToken GUID<4940430371463236824>
[00:20:07]: Client authenticated: (KU_LTP5EzVJ) johnpork
[00:20:07]: [Shard] Completed incoming migration #1 for (KU_LTP5EzVJ)
```

**Therefore: counting on `Client authenticated` / `New incoming connection` / `Connection lost to`
/ `[Shard] (...) disconnected from ...` is WRONG.** All four fire on every shard hop. This is the
single biggest trap in the naive approach, and it is exactly the failure the task asked about.

Also note `[Shard] (<userid>) disconnected from <ShardName>(<id>)` is logged **Master-only, for
every shard** — tempting as a cluster-wide signal, but it fires on migration, so it is not a leave
signal.

### 2.4 Lines that do NOT exist — do not write regexes for these

**[LOGS]** — searched across all 12 real logs plus forum pastes, zero occurrences:

- `Client timed out` — does not exist.
- `Client disconnected: ...` — does not exist. The engine prints `Connection lost to <ip>|<port>
  <guid>`.
- `AddClient` / `RemoveClient` — do not exist.
- `ID_CONNECTION_LOST` / `ID_DISCONNECTION_NOTIFICATION` — RakNet constants, never printed by DST.
  The reasons DST actually prints are `ID_DST_SHARD_SILENT_DISCONNECT`, `ID_DST_USER_KICKED`,
  `ID_DST_USER_CONNECTION_FAILED`, `ID_DST_DESTINATION_SERVER_NOT_AVAILABLE`.
- `PushMigrationData` / `[Shard] ... migrated` — do not exist.

### 2.5 Why passive counting still isn't the primary

- A running `joins - leaves` counter cannot resynchronise. A missed line, log rotation, a rollback,
  or a manager restart leaves it permanently wrong. Wrong-high means the instance never stops
  (costs money); wrong-low means it stops on live players (worse).
- Kicks emit `[Kick] (KU_x) admin kicked (KU_y) name` in `server_log.txt` and their own
  announcement type, so a "Leave Announcement only" counter misses kicked players **[LOGS]**.
- Client crash/timeout: the leave announcement only appears once the engine declares the peer dead,
  i.e. after a RakNet timeout — lag of seconds to tens of seconds, unmeasured.

**Correct use:** tail the Master chat log to *trigger an immediate poll* on any join/leave, and to
raise an alarm if passive and authoritative counts disagree. Do not let it drive shutdown.

---

## 3. `pause_when_empty` log lines (RECOMMENDED CROSS-CHECK)

### 3.1 `Sim paused` IS a cluster-wide zero-player signal

This was the biggest upgrade from the real-log research. The exact strings are `Sim paused` and
`Sim unpaused`, no decoration, **no trailing whitespace** **[LOGS]**.

Complete pause list from one 3-shard cluster, Master vs Caves side by side **[LOGS]**:

```
Master:                        Caves:
[00:01:03]: Sim paused         [00:01:04]: Sim paused
[00:12:31]: Sim unpaused       [00:12:32]: Sim unpaused
[00:12:52]: Sim paused         [00:12:52]: Sim paused
[00:14:13]: Sim unpaused       [00:14:13]: Sim unpaused
[00:24:50]: Sim paused         [00:24:50]: Sim paused
[00:26:20]: Sim unpaused       [00:26:20]: Sim unpaused
```

Three things follow, all **[LOGS]**:

1. **It is cluster-wide.** At `00:24:50` the only player disconnected from the **Loot** shard —
   not Master, not Caves — and *both* Master and Caves logged `Sim paused`. The signal tracks the
   whole cluster's population.
2. **It is mirrored to every shard**, ±1 s. Either log works; use the Master's.
3. **It does not fire on migration.** That cluster performed 8 migrations and logged only these 6
   transitions, each matching a genuine connect or disconnect.

So on a `pause_when_empty = true` cluster, the most recent of `Sim paused` / `Sim unpaused` is a
direct statement of whether the cluster currently has zero players. That is a strong, free,
passive cross-check from a completely different engine path than the client table — exactly the
independence you want in a cross-check.

Caveats:

- **Edge-triggered.** On manager start you must scan backwards through the log for the most recent
  of the two, rather than waiting for the next edge.
- **Depends on `pause_when_empty = true`.** If that is ever turned off (including as the fallback
  in §3.3), this signal disappears entirely. Confirm it is on by reading the startup settings
  block, which prints `PauseWhenEmpty: true` verbatim **[LOGS]**.
- There are old reports that `pause_when_empty` sometimes does not engage **[FORUM]** (Klei bug
  tracker, "Game does not pause when empty"). Another reason it is a cross-check, not the primary.

### 3.2 The `Server Autopaused` trap — critical

There is a **second, unrelated** pause feature whose log lines look confusingly similar and which
is extremely noisy. One 45-minute session logged **154** `Server Autopaused` and **154**
`Server Unpaused` lines **[LOGS]**:

```
[00:12:35]: Server Autopaused	
[00:12:36]: Server Unpaused	
[00:15:55]: Server Autopaused	
[00:15:55]: Server Unpaused	
```

A third variant, `Server Paused\t`, is the manual admin pause (`SetServerPaused`, **[SOURCE]**
`mainfunctions.lua:850-859`; and the lone-player menu autopause at `pausescreen.lua:46`,
`#GetPlayerClientTable() == 1` **[SOURCE]**).

`Server Autopaused` / `Server Paused` / `Server Unpaused` have **nothing** to do with player count
and all carry a **trailing TAB**. `Sim paused` / `Sim unpaused` do not.

**Therefore: anchor the regex at both ends.**

```
^\[[\d:]+\]: Sim paused$
^\[[\d:]+\]: Sim unpaused$
```

A substring match on `paused` — or even `Unpaused` — will drown in autopause noise and produce
nonsense. Note that `JemiloII/dst-manager` uses `line.includes('Sim paused')` **[FIELD]**, which is
safe only because `Sim ` is in the needle; do not relax it.

### 3.3 Does pausing block console commands? (CRITICAL)

This matters enormously: if a paused server ignores stdin, the primary signal dies exactly when
you need it — on an empty server.

**[SOURCE]** The game scripts show the Lua VM keeps running while paused:

- `update.lua:32` — `function WallUpdate(dt)` is introduced by the comment
  `--this is an update that always runs on wall time (not sim time)`, and it begins with
  `local server_paused = TheNet:IsServerPaused()` — i.e. it runs *and knows* it is paused.
  It calls `HandleRPCQueue()` and `HandleUserCmdQueue()` unconditionally.
- `update.lua:184` — `StaticUpdate` has an explicit `if TheNet:IsServerPaused() then` branch that
  keeps ticking static components and `SGManager:UpdateEvents()` while paused.
- `update.lua:229` — `assert(not TheNet:IsServerPaused(), "Update() called on paused server!")`,
  i.e. only the *sim* `Update` is suppressed.

So the process, its main loop, its network handling and its Lua VM are all alive while "paused";
only simulation stepping stops.

**[FIELD]** Corroborating: `JemiloII/dst-manager` polls the player count every 15 s
unconditionally, including while the server is empty and therefore paused, and drives a live UI
from it. If stdin were ignored while paused, that product would not work.

**A contrary report, and why it does not apply.** A 2015 Klei thread on exactly this use case
(detecting an empty server from a script, on EC2) has a poster stating that "all of the LUA code is
paused" when the server is empty and paused **[FORUM]**
(<https://forums.kleientertainment.com/forums/topic/51460-detecting-an-empty-server-via-a-script/>).

That report is *correct but about something else*, and the source shows exactly why — DST has
**two schedulers**:

| API | Scheduler | Runs while paused? |
|---|---|---|
| `inst:DoPeriodicTask(t, fn)` | `scheduler` (`entityscript.lua:1401`) | **No** — `RunScheduler` is called from `Update`, which asserts `not TheNet:IsServerPaused()` |
| `inst:DoStaticPeriodicTask(t, fn)` | `staticScheduler` (`entityscript.lua:1376`) | **Yes** — `RunStaticScheduler` is called from `StaticUpdate`, which has an explicit paused branch |

All **[SOURCE]** (`entityscript.lua:1374-1405`, `update.lua:176-229`). So a mod using
`DoPeriodicTask` genuinely stops on an empty server — which is what that poster hit — while
`DoStaticPeriodicTask` keeps running. This is corroborated by a modern implementation:
`LetsStarveTogether/dst-server` uses `DoStaticPeriodicTask(60, ...)` with the code comment
*"Static tasks keep observing lobby connections while the simulation is paused"* **[FIELD]**.

**Console stdin is a third path again** — neither scheduler. The engine reads stdin and calls
`ExecuteConsoleCommand` directly, and the Lua VM is kept alive by `WallUpdate`, which runs on wall
time regardless of pause. **[SOURCE] + [INFERENCE]: stdin commands should run normally while
paused. Confidence high — but this remains the #1 thing the spike must prove**, because the whole
design rests on it and no Klei statement says so directly.

Cheap belt-and-braces if it turns out to be false: set `pause_when_empty = false` and accept world
time advancing for up to 30 idle minutes (~half an in-game day) — a trivial cost here. Note this
also costs Cross-check A (§3.1), so decide up front that that trade is acceptable.

---

## 4. Network-level detection

### 4.0 The decisive objection: most clients do not arrive over the game port at all

The real logs settle this more firmly than any reasoning about sockets. Connections come in over
**Steam P2P / Steam Datagram Relay**, not as ordinary UDP flows to port 10999 **[LOGS]**:

```
[00:03:04]: [P2P] Session request for '76561199127037806'
[00:03:09]: [P2P] Create session: 16.33.107.147|1 '76561199127037806'
[00:03:10]: New incoming connection 16.33.107.147|1 <16530650002521004379>
[00:03:10]: Client connected from 16.33.107.147|1 <16530650002521004379>
```

Look at the peer address: `16.33.107.147|1`. The part after the `|` is the port, and it is **1** —
not an ephemeral port. That is a Steam virtual/relay address, not a real UDP endpoint. A LAN client
by contrast shows a genuine port **[LOGS]**:

```
[00:00:55]: Client connected from [LAN] 127.0.0.1|61178 <2820723834946044976>
```

So for internet clients joining through Steam, there is **no per-player UDP flow on 10999 to
count** — conntrack, `ss`, and packet counters would all see relay traffic that does not decompose
into one flow per player. This alone disqualifies network-level counting for this project, before
any of the arguments below.

### 4.1 Why the obvious tools do not work anyway

DST shards use **RakNet over UDP** (10999 Master, 10998 Caves by default). A UDP server socket is
typically a single **unconnected** socket that receives from all peers via `recvfrom`.

**[INFERENCE]**, well-founded in how Linux works:

- `ss -u -a -n` and `/proc/net/udp` enumerate *sockets*, not peers. A DST shard will show exactly
  **one** line (`0.0.0.0:10999`) whether 0 or 6 players are connected. Useless for counting.
  It *is* useful as a liveness check: the absence of that line means the shard is not listening.
- `conntrack -L -p udp --dport 10999` would show one flow per peer — but `nf_conntrack` is not
  necessarily loaded on a box with no iptables/nftables rules, and UDP conntrack entries are
  timer-based (`nf_conntrack_udp_timeout` default 30 s, `nf_conntrack_udp_timeout_stream` default
  120 s), so they linger well past a disconnect and also appear for **any** stray packet — including
  lobby/NAT-punch traffic. Counting these would overcount and lag.
- iptables packet counters give you bytes/packets, not peers. They can tell you "no traffic at all
  for N minutes", which is a *coarse* idle hint, but a connected-but-AFK player still exchanges
  RakNet keepalives, so zero traffic and zero players are not the same thing — and that
  distinction is the wrong way round for safety (a quiet link would look idle).

Two refinements, both source-verified against the kernel and RakNet:

- **conntrack is probably not even recording.** `nf_conntrack_standalone.c` has
  `static bool enable_hooks` defaulting to **false**, and only calls `nf_ct_netns_get` when set.
  Per <https://github.com/torvalds/linux/commit/ba3fbe663635ae7b33a2d972c5d2def036258e42>, a dummy
  rule (`iptables -I INPUT -m state --state NEW`) or `modprobe nf_conntrack enable_hooks=1` is
  needed to register the hooks. Worse, **the sysctls still appear once the module loads even though
  the table stays empty**, so a naive check looks healthy and silently returns zero flows.
- **The ASSURED heuristic is tempting and still wrong.** `nf_conntrack_proto_udp.c` sets ASSURED
  only once a reply has been seen *and* a packet arrives >2 s after entry creation, giving 120 s
  (`nf_conntrack_udp_timeout_stream`) versus 30 s (`nf_conntrack_udp_timeout`) for a one-shot
  exchange. So a browser ping decays in 30 s and a player holds ASSURED — but repeated browser
  refreshes can also become ASSURED, and stale entries linger 120 s, so reconnects overcount.

RakNet timing, for reference **[SOURCE]** (`RakPeer.cpp`): `defaultTimeoutTime = 10000` (10 s in
release), and an idle connected peer sends a reliable ping about every 5 s
(`timeMS - lastReliableSend > GetTimeoutTime()/2`). A DST client `settings.ini`
`connection_timeout = 8000` is reported but unconfirmed **[FORUM]**. Either way a connected player
generates constant traffic at the 15 Hz tick, so "no traffic" ≠ "no players" in the unsafe
direction.

### 4.2 Lobby pings vs. real players — measured

Correcting an assumption: **the browser ping does hit your server directly.** Klei developer
*nome*: *"The ping is sent by the client to the server via a UDP packet to the dedi's listen port
(usually 10999). Klei doesn't ping your server, the connecting client does."* **[FORUM]**
(<https://forums.kleientertainment.com/forums/topic/136918-how-does-klei-ping-dedicated-servers/>).
Only the *listing* data comes from the CDN.

This was then tested directly against live servers by sending RakNet `ID_UNCONNECTED_PING`
(byte `0x01`, 8-byte time, magic `00ffff00fefefefefdfdfdfd12345678`, 8-byte client id):

- Every reply was **exactly 33 bytes**: `0x1C`, echoed time, 8-byte server GUID, magic.
- The reply was **identical for servers with 0, 3 and 6-of-6 players** — the pong carries **no
  player data at all**.

So the unconnected ping is useless for counting but is a clean, cheap **liveness probe** that needs
no shell access: a valid 33-byte pong means the shard's socket is alive and the game is answering.

A ping *is* distinguishable from session traffic at the packet level (byte 0 is `0x01`, magic at
offset 9 — RakNet's own offline check does the same test) and creates no RemoteSystem. But
identifying sessions would mean parsing RakNet framing, which is far too fragile here.

### 4.3 Verdict

**Reject as a player-count signal** — decisively, on the §4.0 grounds. Keep exactly one
network-level check, as a *liveness* probe only:

```sh
ss -ulnp 'sport = :10999 or sport = :10998'
```

"is something listening on both shard ports". That feeds the crash path, not the count.

Optionally add the **RakNet unconnected ping** (§4.2) as a second liveness probe — it is better
than `ss` because it proves the *game* is answering, not merely that a socket exists, and it works
from off-instance. Never use it to infer population.

---

## 5. Steam A2S query / Klei lobby API

### 5.1 A2S

A DST `server.ini` can carry **[SOURCE]** (read from `dockhippie/dst`
`latest/overlay/etc/templates/server.ini.tmpl`):

```ini
[NETWORK]
server_port = 10999

[SHARD]
is_master = true

[STEAM]
master_server_port = 27016
authentication_port = 8766
```

**Correction to a common assumption:** the defaults are **27016 / 8766 for every shard** — there is
no built-in 27017/8767 for caves. You must hand-assign different values per shard or the second
shard fails to start. Klei's own settings guide documents both as "Make sure that this is different
for each server you run on the same machine" **[FORUM]**
(<https://kleiforums.com/forums/topic/64552-dedicated-server-settings-guide/>, post by Klei staff).
The canonical wiki example uses **12346 / 10166** for caves, not 27017/8767.

The server prints the effective values at startup **[LOGS]**, which beats guessing:

```
[00:00:07]:   SteamAuthPort: 8768
[00:00:07]:   SteamMasterServerPort: 27018
```

### 5.1a A2S does not work — measured, not assumed

This was tested empirically against live servers rather than reasoned about:

- **A2S_INFO sweep: 1,988 live dedicated servers × 5 candidate ports = 9,940 probes → 0 DST
  responses.** The 8 responses received were all from *other games* co-hosted on the same IPs
  (The Forest, KF2, DayZ, CS:S, Garry's Mod, …), which also proves the prober and its challenge
  handling worked.
- **Deep sweep: 25 populated servers × 134 ports** (27000–27060, 12340–12360, 8760–8780,
  10990–11020) **= 3,400 probes → 0 responses.** This included the game ports, which are certainly
  open, so DST does not answer A2S there either.
- **Steam master-server registration: 600 server IPs via `ISteamApps/GetServersAtAddress` → 0
  entries with appid 322330.** Plenty of Valheim/PZ/Abiotic Factor entries on the same IPs.

`gamedig` *looks* like it supports DST but does not really: there is no `dontstarvetogether`
protocol file; `lib/games.js` just has
`dst: { options: { port: 10999, port_query: 27016, protocol: 'valve' } }` — the generic Valve A2S
probe pointed at 27016. (`rust-gamedig` additionally has the wrong appid, `322_320` vs `322330`.)
A gamedig maintainer puts it plainly in issue #276: *"I don't believe DST has a query protocol at
all."* Probers were validated against a control TF2 server, which answered the identical packet.
LinuxGSM independently ships DST with `querymode="1"` (session-only) and `steammaster="false"` —
i.e. it too treats DST as unqueryable.

Corroborating: a Klei developer answering a Feb 2026 thread that explicitly asked "lobby API or
Steam A2S?" answered only about the lobby JSON and ignored A2S entirely **[FORUM]**
(<https://kleiforums.com/forums/topic/169699-how-to-get-an-up-to-date-dst-server-list-server-info-api-lobby-listings-a2s/>).

**Verdict: drop A2S.** DST creates an anonymous Steam *game-server account* (the lobby row carries
a `steamid` like `90290428497389599`) but does not publish to the Steam master server and does not
serve A2S. Spike step S11 is now a 10-minute sanity check, not a design dependency.

### 5.2 Klei lobby — the right answer for the web UI

Much better than expected, and **no token needed for player counts**.

```bash
curl -s --compressed https://lobby-v2-cdn.klei.com/us-west-2-Steam.json.gz | jq '.GET | length'
# regions: curl -s https://lobby-v2-cdn.klei.com/regioncapabilities-v2.json
#   -> us-east-1, eu-central-1, ap-southeast-1, ap-east-1
```

Note the region list does **not** include `us-west-2`; the server picks its lobby region by ping
(the Master log's `Server registered via geo DNS in <region>` line tells you which one **[LOGS]**),
so a us-west-2 EC2 instance will most likely register in `us-east-1`. Read the region from the log
rather than assuming.

Every row carries `connected` and `maxconnections` — verified present on 100% of 1,550 live rows,
along with `__addr`, `__rowId`, `host`, `port`, `guid`, `session`, `password`, `mods`, `dedicated`,
`clienthosted`, `serverpaused`, `allownewplayers`, `steamid`, `secondaries`.

```json
{"__addr":"100.19.44.181","__rowId":"24fa8977a8c0ecd0cd92155c467f08fc","name":"Ecofuse",
 "port":11000,"connected":0,"maxconnections":9,"dedicated":true,"clienthosted":false,
 "password":true,"serverpaused":false,"allownewplayers":true,
 "secondaries":{"3226639018":{"__addr":"100.19.44.181","id":"3226639018","port":11001}}}
```

Findings that matter:

- **`connected` excludes the dedicated host** — established empirically: 34% of 1,988 *dedicated*
  servers report `connected: 0`, versus 0 of 208 client-hosted ones (where the host is a real
  player). Matches `GetPlayerClientTable()`'s host-stripping.
- **`connected` is cluster-wide [INFERENCE, strong].** There is exactly **one lobby row per
  cluster** — Caves appears only as a `secondaries` stub with no count of its own. `maxconnections`
  is the cluster-wide `max_players`, and the client's browser compares the two directly. Combined
  with `shard_players.lua` computing `local + secondary` (§1.2), a per-shard `connected` would make
  the whole server browser wrong.
- **Klei explicitly permits this.** Klei developer "nome", Feb 2026: *"They're not an official API
  that we guarantee stability on but third party tools are welcome to use the lobbylisting JSON
  files. We try not to break them needlessly."* **[FORUM]**
- **Freshness is excellent** — measured: 8 polls over 2 min, every response `Miss from cloudfront`
  with `last-modified` 1–3 s before the request. Polling every 15–30 s is near-real-time.
- Per-server detail (`POST https://lobby-v2-{region}.klei.com/lobby/read`, body
  `{"__gameId":"DontStarveTogether","__token":"...","query":{"__rowId":"..."}}`) **does** require a
  token and returns 403 `E_AUTH_FAILURE` without one. Only needed for player names/characters.
- Find your own server without a token by matching `__addr` + `port` in the regional listing.
  **`__rowId`, `guid` and `steamid` all change on restart, and `session` changes on world regen**,
  so none of them is a stable identifier. Klei's own dev suggests matching on `host` (your
  cluster's `KU_` id) plus the server name; `__addr` + `port` also works while the IP is stable,
  which for a stop/start EC2 instance it will not be unless an Elastic IP is attached.
- A server started with `-offline`, or configured LAN-only, will **not** be listed at all.
- Independent measurement of freshness: 68 of 1,457 rows changed their `connected` value between
  two polls a few minutes apart; the file regenerates every 10-15 s.

**Verdict:** still **do not use it for the shutdown decision** — it is third-party infrastructure on
someone else's uptime, and a bad answer costs either money or a server killed under live players.
But it is now a genuinely good option for the **web UI**, and a useful out-of-band sanity check
against the instance's own count during the spike.

For the UI specifically, the cheapest correct answer remains: the instance already computes the
count every 30 s, so have it report `{players, idle_since, joinable_at, shutdown_at}` to the
webapp. That needs no Klei dependency at all and gives the countdown for free.

---

## 6. Server-side mod that writes a count to a file

**Fallback only.** Mechanism: a mod with `modinfo.lua` setting `all_clients_require_mod = false`,
running `TheWorld:DoPeriodicTask(10, ...)` to write `#GetPlayerClientTable()` to a file.

Why it is undesirable here:

- The save has no mods and Tyler wants to keep it that way.
- **What `all_clients_require_mod = false` actually does [SOURCE]:** it only keeps the mod out of
  the client-side verification and config-sync lists. `mods.lua:908-916` builds `mods_to_verify`
  from `GetEnabledServerModNames()` filtered by `if modinfo.all_clients_require_mod`, and
  `mods.lua:161-164` syncs config only for those same mods. But `GetEnabledServerModNames()` itself
  (`mods.lua:234-243`) includes **every** enabled mod that is not `client_only_mod` — so the mod is
  still a server mod as far as the server is concerned.
- **[SOURCE]** `components/worldoverseer.lua:304` reports `modded = TheNet:GetServerModsEnabled()`
  in the session heartbeat. `AreServerModsEnabled()` in `mods.lua` counts **every** enabled mod
  unless `client_only_mod` is set — it never reads `all_clients_require_mod`. So
  `all_clients_require_mod = false` spares clients the download; it does **not** make the server
  un-modded.
- **The consequences are concrete and user-visible [SOURCE]:** the mod icon and filter appear in
  the server browser; the server is **excluded from Quick Join** (`CalcQuickJoinServerScore`
  requires `not server.mods_enabled`); joining players get a *"Mods Enabled… Klei won't be able to
  help"* popup; the mod name is listed in the browser's Mods popup; and `server_filter_tags` leak
  into the public tags. The lobby listing's `mods` boolean comes from this — it was `true` on
  1,055 of 1,541 live rows sampled.
- **`server_only_mod` is not a real flag** — zero hits across the entire script tree **[SOURCE]**.
  Do not expect one.
- The only known way to hide the flag is the hack
  `GLOBAL.AreServerModsEnabled = function() return false end` in a modmain **[FORUM]**
  (<https://kleiforums.com/forums/topic/93670-hide-server-only-mods/>), which is unsafe alongside
  any mod that sets `all_clients_require_mod = true`. Not worth it here.
- It adds a failure mode (mod breaks on a game update → count stops → either false-idle shutdown
  or never-shutdown).

The stdin/FIFO approach gets the identical data with no mod, so there is no reason to take this on
unless the spike proves stdin does not work while paused **and** `pause_when_empty = false` is
unacceptable.

---

## 7. Joinable detection

The clock starts "when the server becomes joinable". For a two-shard cluster, players need **both**
shards up, because a player whose character was last in Caves cannot resume until Caves is ready,
and the sinkholes are dead until the shard link is established.

### 7.1 The real startup sequence, verbatim

**[LOGS]** — `chientrm/dst-configs`, `Master/server_log.txt`, contiguous (portal-validation lines
elided):

```
[00:01:01]: About to start a shard with these settings:
[00:01:01]:   ShardName: [SHDMASTER]
[00:01:01]:   ShardID: 1
[00:01:01]:   ShardRole: MASTER
[00:01:01]: [Shard] Starting master server
[00:01:01]: [Shard] Shard server started on port: 10889
[00:01:01]: Telling Client our new session identifier: 60FBFFE311F33058
[00:01:03]: Server registered via geo DNS in ap-southeast-1
[00:01:03]: Sim paused
[00:01:03]: [Shard] Secondary shard Caves(2) connected: [LAN] 127.0.0.1
[00:01:03]: [Shard] Secondary Caves(2) ready!
[00:01:03]: World 2 is now connected
[00:01:16]: [Shard] Secondary shard Loot(3) connected: [LAN] 127.0.0.1
[00:01:18]: World 3 is now connected
```

And the **Caves** log for the same boot **[LOGS]**:

```
[00:00:36]: [Shard] Secondary shard is waiting for LUA...
[00:00:41]: [Shard] Connecting to master...
[00:00:41]: [Shard] Connection to master failed. Waiting to reconnect...
[00:01:01]: [Shard] Connecting to master...
[00:01:01]: [Shard] Sending secondary shard information to master...
[00:01:03]: [Shard] secondary shard is now ready!
[00:01:03]: World 1 is now connected
[00:01:04]: [Shard] secondary shard LUA is now ready!
[00:01:04]: Sim paused
```

Note `[Shard] Connection to master failed. Waiting to reconnect...` is **normal** on first boot —
Caves starts before the Master's shard server is listening. Do not treat it as an error.

The startup settings block is also worth capturing for config assertion **[LOGS]**:

```
[00:00:07]: About to start a server with the following settings:
[00:00:07]:   Dedicated: true
[00:00:07]:   Passworded: false
[00:00:07]:   ServerPort: 11000
[00:00:07]:   SteamAuthPort: 8768
[00:00:07]:   SteamMasterServerPort: 27018
[00:00:07]:   MaxPlayers: 32
[00:00:07]:   PauseWhenEmpty: true
[00:00:07]:   IdleTimeout: 1800s
[00:00:07]: Online Server Started on port: 11000
```

`PauseWhenEmpty: true` confirms the cross-check of §3 is armed. `IdleTimeout: 1800s` is a
**client** AFK setting, not a server auto-shutdown — see §7.4.

### 7.2 `World <N> is now connected` — verified, but the id is not always 2

**[SOURCE]** `shardnetworking.lua:64-66`:

```lua
function Shard_UpdateWorldState(world_id, state, tags, world_data)
    local ready = state == REMOTESHARDSTATE.READY
    print("World "..world_id.." is now "..(ready and 'connected' or 'disconnected'))
```

**Trap [LOGS]: shard ids are not small integers on every cluster.** If `[SHARD] id` is not pinned
in `Caves/server.ini`, DST generates a random 32-bit id, and real logs show
`World 2211143081 is now connected` and `World 4023110734 is now connected`. Only `SHARDID.MASTER`
is fixed — it is the string `"1"` **[SOURCE]** `constants.lua:2333-2337`.

So:

- **Master** log gets `World <cavesShardId> is now connected`
- **Caves** log gets `World 1 is now connected`

Regex: `^\[[\d:]+\]: World (\d+) is now (connected|disconnected)\s*$`

Note the line has a **trailing TAB** **[LOGS]** (as do `[SyncWorldSettings]` lines) — tolerate
trailing whitespace.

Two robust ways to avoid the id problem entirely:

1. **Pin the id.** Set `id = 2` explicitly under `[SHARD]` in `Caves/server.ini`, then `World 2`
   is deterministic. Recommended — it also makes the logs readable.
2. **Watch the Caves log instead** for `World 1 is now connected`, where the id *is* fixed.

Either way this is also the **shard-loss** signal: `World <N> is now disconnected` on the Master
means Caves died and the cluster is only half joinable. Feed it to the crash path.

### 7.3 The shard-ready lines

**[LOGS]**, Master-only, and clearer than the `World N` line because they name the shard:

```
[00:01:03]: [Shard] Secondary shard Caves(2) connected: [LAN] 127.0.0.1
[00:01:03]: [Shard] Secondary Caves(2) ready!
```

**Trap [LOGS]:** some builds contain the typo `[Shard] Secondary shar Caves(...) connected` —
literally in the game. Do not anchor on the word `shard`.

On the Caves side, the equivalent is `[Shard] secondary shard LUA is now ready!` (note lowercase
"secondary shard"). Older builds used the **"Slave"** wording **[LOGS]**:

```
[00:00:39]: [Shard] Slave LUA is now ready!
```

So `Slave LUA is now ready!` *does* exist — it is the legacy form of
`secondary shard LUA is now ready!`. Match case-insensitively on `LUA is now ready` to cover both.

Other lines, now **[LOGS]**-verified verbatim:

- `Telling Client our new session identifier: <HEX16>` — both shards, different ids each.
- `Server registered via geo DNS in <region>` — **Master only**. Seen as `ap-southeast-1`,
  `us-east-1`, `eu-central-1`. The older wording, on pre-geo-DNS builds, is
  `Registering master server in EU lobby` preceded by `Best lobby region is aws/EU (ping 51)`.
  This is about *listing*, not readiness; a password-protected server joined by invite or direct
  connect does not depend on it.
- `Online Server Started on port: 10999` — socket listening, both shards on their own ports.

### 7.4 `IdleTimeout: 1800s` is not what you want

**[LOGS]** the startup block prints `IdleTimeout: 1800s`. The coincidence with the 30-minute
requirement is a trap: this is DST's **client** idle/AFK handling, and it kicks an AFK *player* —
it does not stop the server.

**[SOURCE]** confirms this directly. `ID_DST_IDLE_TIMEOUT` appears only in `strings.lua` as a
client-facing **disconnect reason**, inside the `POPUPDIALOG` title and body tables, alongside
`ID_DST_USER_KICKED`, `ID_CONNECTION_LOST` and friends:

```lua
-- strings.lua:9381 (TITLE)
ID_DST_IDLE_TIMEOUT = "Disconnected",
-- strings.lua:9448 (BODY)
ID_DST_IDLE_TIMEOUT = "You have lost connection to the server.",
```

There is **no** built-in "shut down the server when empty" option in `cluster.ini` / `server.ini`.
Klei's full command-line options guide and the staff settings guide were both read end to end; the
only empty-server setting is `pause_when_empty`, which pauses the sim and never exits, and the
wiki states plainly that a standalone DST server *"will not shutdown even if no player is online"*.
The closest CLI option is `-monitor_parent_process` (see §8.3).

Note also that **`pause_when_empty` defaults to `false`** — it must be set explicitly.

**Prior art check:** a survey of the DST server-management ecosystem (Docker images, admin panels,
shell script suites, LinuxGSM, an EKS deployment, and a Terraform project) found **no project that
pairs empty-server detection with stopping a cloud VM**. Several detect players; none act on it by
powering anything down. So this design has no reference implementation to copy — which is the
reason the spike matters.

Worth noting a second-order effect in our favour: because DST kicks idle clients after 30 minutes,
a forgotten-but-connected player eventually becomes a real disconnect, so the idle timer cannot be
held open indefinitely by someone who wandered away from the keyboard.

### 7.5 Recommended joinable predicate

```
joinable := Master log has  "^...: Sim paused$" or "^...: Sim unpaused$"
        AND Master log has  "World <cavesId> is now connected"   (pin cavesId = 2)
        AND a DSTQ nonce round-trip has succeeded on BOTH shards
```

The last clause is the strongest and is free: if both shards answer a console query, both Lua VMs
are alive and the shard link is up. **Start the 30-minute clock when this first becomes true.** A
fresh start with no joins then lives ~30 minutes, as specified.

Add a hard **boot timeout** (e.g. not joinable within 15 min of instance start → failed boot →
shut down) so a botched start cannot leave an instance running forever.

---

## 8. Making the idle timer robust

### 8.1 State machine

Per poll, each shard yields `OK(n_clients, n_allplayers)` or `UNKNOWN`.

```
cluster_players = max(master.clients,
                      caves.clients,
                      master.allplayers + caves.allplayers)
```

Taking the `max` means the design is correct whether the client table is cluster-wide (the first
two terms win) or per-shard (the third term wins). This is the key trick that lets you ship
without first resolving Open question #1.

Independently, maintain `sim_paused` from the Master log: the most recent anchored match of
`Sim paused` (→ true) or `Sim unpaused` (→ false), scanning backwards on startup.

| Condition | Action |
|---|---|
| any shard UNKNOWN | idle clock **holds** (neither advances nor resets); increment `unknown_streak` |
| `cluster_players > 0` | reset idle clock to 0; `unknown_streak = 0` |
| `cluster_players == 0` **but** `sim_paused == false` | **disagreement** — hold the clock, log loudly. Do not accumulate. |
| `cluster_players == 0` **and** `sim_paused == true` | increment consecutive-zero counter |
| consecutive zeros ≥ 3 (i.e. ~90 s at 30 s poll) | idle clock is running; accumulate |
| idle clock ≥ 30 min | trigger shutdown |
| `unknown_streak` ≥ 10 (~5 min) | treat as crashed → crash path |

The disagreement row is what makes the migration transient harmless: a player mid-hop can make the
client-table count read 0, but the sim does **not** pause during a migration **[LOGS]**, so
`sim_paused` stays false and the clock refuses to run. The two signals fail in different
directions, which is the whole point of choosing independent ones.

If `pause_when_empty` is ever set false, `sim_paused` is permanently false and this rule would
deadlock the timer — so gate it on the startup block reporting `PauseWhenEmpty: true`, and fall
back to "count only" if it does not.

### 8.2 Parameters

- **Poll interval: 30 s.** `dst-manager` uses 15 s **[FIELD]**; 30 s is ample for a 30-minute
  timer and halves the log noise. The cost is that the shutdown fires within 30 s of the true
  30-minute mark, which is irrelevant here.
- **Require N=3 consecutive zeros** before the clock is considered running, to absorb a transient
  during a shard migration (a player may briefly be in neither shard's `AllPlayers` mid-migration —
  this is exactly the window the `max()` formula and the N-consecutive rule both guard against).
- **Never treat "no output" as zero.** The nonce is what makes this enforceable. This is the
  requirement that most naive implementations get wrong, and it is the one that shuts the server
  down on top of live players.
- **Accumulate wall-clock, not poll counts.** Store `idle_since` as a timestamp so a manager
  restart or a missed poll does not silently reset or double-count. Persist it to disk so the
  timer survives a manager crash.

### 8.3 Crash of the DST process

If the DST process has died, that is **not** idle — it is broken — but the required outcome is the
same (stop paying for the instance), with different handling:

- Detect: PID gone (`kill(pid, 0)` **[FIELD]** `monitor.ts:34-40`), **or** nothing listening on
  UDP 10999/10998, **or** no RakNet pong (§4.2), **or** `unknown_streak` exceeded.
- Useful supervisor primitive: the documented CLI flag **`-monitor_parent_process <pid>`** —
  *"automatically close the server when the `<process_id>` process dies"* **[SOURCE]**, from Klei's
  command-line options guide. Pointing both shards at the manager process means a manager crash
  cleanly tears down the shards instead of orphaning them.
- Then: do **not** wait the full 30 minutes. Attempt a clean `c_save()` only if the process is
  still alive and responsive; otherwise go straight to the shutdown path.
- Because the save is the valuable thing, the shutdown path must back up the save **before**
  terminating, and must tolerate the save being mid-write.

### 8.4 Shutdown sequencing gotcha (out of scope, but load-bearing)

**[FIELD]** `JemiloII/dst-manager` `monitor.ts:68-73` documents, from experience:

> DST on Linux does not exit after `c_shutdown()` — the process hangs after writing
> "Shutting down" as its final log line. The world/player save completes BEFORE that message, but
> we wait 15 seconds as a safety buffer to ensure all data is fully flushed to disk before killing
> the process. Without this delay, killing too early corrupts save files and wipes player data.

Flagging it here because it directly constrains whoever designs the shutdown sequence: watch for
`Shutting down` in each shard's log, then wait, then SIGTERM, then SIGKILL.

Also **[SOURCE]** `consolecommands.lua:179-197`: `c_shutdown(save)` with `save ~= false` calls
`ShardGameIndex:SaveCurrent(Shutdown, true)` on the master sim — so `c_shutdown()` (no arg) does
save. Send it to **both** shards.

---

## 9. Recommended design summary

| Role | Signal | Confidence |
|---|---|---|
| **Primary count** | `DSTQ <nonce>` console query → `shard_players:GetNumPlayers()` + `#GetPlayerClientTable()` + `#AllPlayers`, both shards, combined with `max()` | High |
| **Cross-check A** | `^...: Sim paused$` / `^...: Sim unpaused$` in `Master/server_log.txt` — cluster-wide, migration-safe zero-player edge | High **[LOGS]** |
| **Cross-check B** | `[Join Announcement]` / `[Leave Announcement]` in `Master/server_chat_log.txt` — change trigger + disagreement alarm | High **[LOGS]** |
| **Web UI (optional)** | Klei lobby CDN `lobby-v2-cdn.klei.com/{region}-Steam.json.gz` → `connected` / `maxconnections`, no token, Klei-sanctioned | High **(measured)** |
| **Joinable** | `World 2 is now connected` (Master, id pinned) **AND** `Sim paused`/`Sim unpaused` (Master) **AND** nonce round-trip on both shards | High |
| **Liveness / crash** | PID alive + `ss -ulnp` shows 10999 & 10998 + nonce round-trip + `World 2 is now disconnected` | High |
| **Rejected** | **Steam A2S (measured dead)**; conntrack / `ss -u` peer counting (clients arrive via Steam relay); counting `Client authenticated` / `Connection lost` (fires on migration); Klei lobby for the *timer*; a server mod | — |

Three signals, three independent engine paths: the Lua client table, the sim pause state, and the
chat announcement stream. All three agree on "zero" before the clock runs; any disagreement is an
alarm rather than a decision.

For the **web UI**: the instance already computes the count every 30 s, so have it report
`{players, idle_since, joinable_at, shutdown_at}` to the webapp. Player count and time-to-auto-stop
are then both free, with no dependency on Klei or Steam. `shutdown_at = idle_since + 30min`
lets the UI count down client-side without polling.

---

## 10. Spike test plan

Run on one x86_64 Linux EC2 instance in us-west-2 with a **throwaway** cluster (NOT Tyler's save),
two shards, `pause_when_empty = true`, password set, no mods. Start each shard with stdin on a
FIFO and a held-open writer. Have a helper that writes a nonce query to both shards and greps both
logs, plus `tail -F` on all four log files (2 × `server_log.txt`, 2 × `server_chat_log.txt`).

You need **two** real clients to test migration and multi-player cases (a second Steam account or
a friend).

### S0 — Harness sanity

- **Steps:** Start the cluster. Write `print("DSTQ 1 hello")` to the Master FIFO. Grep the Master log.
- **Confirms:** stdin→log round-trip works at all; measure the write→appears latency.
- **Refutes if:** nothing appears. Then FIFO wiring is wrong (check the held-open writer, check
  the server was actually started with `< pipe`), or try `screen`/`tmux` instead.
- **Also record:** the exact prefix format of the log line and whether a trailing tab is present.

### S1 — Zero players, server paused (THE CRITICAL TEST)

- **Steps:** With the cluster up and nobody connected, wait for `Sim paused` in the Master log.
  Then send the full `pcall` query (§1.2) to **both** shards. Repeat 5 times over 5 minutes.
- **Expect:** `DSTQ <n> true 0 0 0` from both shards, every time, promptly. In particular `ok` must
  be `true` — if it is `false`, the `TheWorld.shard.components.shard_players` path is wrong on a
  dedicated server and must be corrected before anything else.
- **Confirms:** (a) console commands execute while the sim is paused — the linchpin assumption;
  (b) zero players reads as an explicit 0, not as silence.
- **Refutes if:** no response while paused → **fall back to `pause_when_empty = false`** and
  re-run. Note this fallback *also* removes Cross-check A, so the design would then rest on the
  poll plus the chat log only.
- **Also run:** `c_listallplayers()` and confirm it prints **nothing** — documenting the ambiguity
  that motivates the nonce.
- **Also verify the pause regexes:** grep the Master log for `Sim paused` (anchored) and for
  `Server Autopaused` / `Server Unpaused`. Confirm the anchored regex matches only the former, and
  count how many of the latter appear — on a 2-shard idle cluster this should be near zero, but
  the count will explode once a player connects (154 in 45 min in one real log). Confirm the
  trailing-TAB distinction holds on this build.
- **Also confirm** the startup block prints `PauseWhenEmpty: true`.

### S2 — One player in Master (resolves Open question #1, part 1)

- **Steps:** One client joins and stays on the surface. Query both shards.
- **Expect:** `shardplayers == 1` on **both** shards (it is a synced netvar, so Caves must agree).
  Master `allplayers == 1`, Caves `allplayers == 0`.
- **Then read off the `clients` value on Caves:** `1` means the client table is cluster-wide, `0`
  means per-shard. This settles open question #2 without the design depending on it.
- **Also:** dump the raw table once —
  `for i,v in ipairs(TheNet:GetClientTable()) do print("ROW "..i.." "..tostring(v.name).." perf="..tostring(v.performance).." netid="..tostring(v.netid).." userid="..tostring(v.userid)) end`
  on **both** shards. Confirms the `[Host]` row exists on each shard, carries `performance ~= nil`,
  and that all three host filters (`performance`, `netid`, name `[Host]`) agree.
- **Record:** the `[Join Announcement]` line verbatim, and confirm the **[LOGS]** finding that it
  appears in *both* shards' chat logs (so the poller must read the Master's only).

### S3 — One player in Caves only (resolves Open question #1, part 2)

- **Steps:** That player goes down a sinkhole and stays in Caves. Query both shards.
- **Expect:** `shardplayers == 1` on **both** shards — this is the key assertion, because it is
  the claim that `_localPlayers + _secondaryShardPlayers` really does cross the shard boundary.
  Master `allplayers == 0`, Caves `allplayers == 1`.
- **Confirms:** the `max()` formula produces 1 — verify it does.
- **Refutes the whole design if:** all three numbers read 0 on both shards with a player
  demonstrably in Caves.
- **CRITICAL:** if per-shard, confirm that Master-only polling (what `dst-manager` does) would have
  read 0 here — i.e. that polling both shards is mandatory, not optional. This is the failure that
  would shut the server down on a player spelunking alone.

### S4 — Migration between shards (calibrates N — SAFETY CRITICAL)

- **Steps:** With all four logs tailing, have the player go Master→Caves and back, several times.
  Poll **every 2 s** throughout (much tighter than production, to catch transients).
- **Expect (already [LOGS]-confirmed, just re-confirm on a 2-shard cluster):** no
  `[Join Announcement]` / `[Leave Announcement]`; no `Sim paused` / `Sim unpaused`; but
  `CloseConnectionWithReason: ID_DST_SHARD_SILENT_DISCONNECT` and `[Shard] (KU_x) disconnected
  from Master(1)` on the source, and `Client authenticated` on the destination.
- **THE MEASUREMENT:** record the **maximum number of consecutive 2 s polls where the `max()`
  formula reads 0**. Real logs show a ~14 s gap between the source-shard disconnect and the
  destination-shard authentication, so if the client table is per-shard this window could be
  ~7 consecutive 2 s polls, i.e. ~14 s. At a 30 s production poll interval that is potentially
  **one** zero reading — which is why N ≥ 3 consecutive zeros matters.
- **Set N such that `N × poll_interval` comfortably exceeds the worst observed transient.**
  With N=3 at 30 s that is 90 s versus a ~14 s transient: a 6× margin. Verify that margin holds.
- **Also verify** that `Sim paused` did **not** fire during the transient — if it did not (as
  expected), Cross-check A independently vetoes the false zero, which is the belt-and-braces that
  makes this safe even if N were miscalibrated.

### S5 — Two players, one per shard

- **Steps:** Client A on the surface, client B in Caves. Query both shards.
- **Expect:** `max()` yields 2.
- **Confirms:** the formula does not double-count when the client table *is* cluster-wide
  (naive `master.clients + caves.clients` would read 4 here — verify that `max()` is right and
  summing client tables is wrong).

### S6 — Client crash / timeout, no clean disconnect

- **Steps:** With one player connected, hard-kill the client (kill the process, or pull its network
  — `sudo pfctl`/airplane mode, not a menu quit). Poll every 5 s. Tail chat logs.
- **Measure:** how long until the count drops to 0, and whether a `[Leave Announcement]` appears.
- **Confirms:** that RakNet timeout eventually cleans up and the count self-heals — the key
  advantage of polling over passive counting.
- **Sets:** a lower bound on N and on the poll interval. If the count takes, say, 60 s to drop,
  that is fine against a 30-minute budget, but it must be *bounded* — if it never drops, the server
  would never shut down, which is the expensive failure.
- **Also record:** whether `Sim paused` fires on the timeout (it should, since the cluster is now
  empty), and whether a `[Leave Announcement]` appears. If `Sim paused` fires but the announcement
  does not, that confirms the ordering of the three signals and tells you which is fastest.

### S7 — Kicked player

- **Steps:** `TheNet:Kick(<userid>)` a connected player.
- **Expect:** count drops; chat log shows a kick announcement, **not** a `[Leave Announcement]`
  (per `networking.lua:99-103`).
- **Confirms:** why passive leave-counting under-counts departures.

### S8 — Joinable detection

- **Steps:** Cold-start the cluster from stopped, with all logs tailing and timestamps recorded.
- **Record in order:** `Online Server Started on port`, `Telling Client our new session
  identifier`, `Server registered via geo DNS in <region>`, `[Shard] Secondary shard Caves(N)
  connected`, `[Shard] Secondary Caves(N) ready!`, `World N is now connected`, `Sim paused`, and
  the first successful nonce round-trip on each shard.
- **Confirms:** which line is last, and therefore what the joinable predicate should require.
- **Then:** try to actually join right after each milestone, to find the earliest line after which
  a join genuinely succeeds — **including a character whose save location is in Caves**, which is
  the case that needs the shard link. Real logs show this path emits `[Shard] Forwarding player to
  Caves(N)` and a migration, so it is the strictest joinable test **[LOGS]**.
- **CRITICAL config check:** confirm what shard id this cluster actually uses. If `Caves/server.ini`
  has no `[SHARD] id`, expect a random 32-bit id (real logs show `2211143081`, `4023110734`), and
  `World 2 is now connected` will never match. **Pin `id = 2` and re-verify.**
- **Also:** confirm whether this build says `Secondary shard` or the typo `Secondary shar`.

### S9 — Shard death

- **Steps:** `kill -9` the Caves process while a player is on the surface.
- **Expect:** `World 2 is now disconnected` in the Master log.
- **Confirms:** the shard-loss signal, and that the Caves poll starts returning UNKNOWN rather
  than 0 — verify it is UNKNOWN (nonce absent), because 0 here would be a false idle reading.

### S10 — Master death

- **Steps:** `kill -9` the Master process.
- **Confirms:** the crash path fires from PID-gone / `ss` / UNKNOWN-streak, and does **not** wait
  30 minutes.

### S11 — Klei lobby cross-check (for the UI), and a 10-minute A2S sanity check

**Lobby (the useful half).** With 0, 1 (surface), 1 (caves) and 2 players:

```bash
REGION=$(grep -o 'geo DNS in [a-z0-9-]*' Master/server_log.txt | tail -1 | awk '{print $NF}')
curl -s --compressed "https://lobby-v2-cdn.klei.com/$REGION-Steam.json.gz" \
  | jq --arg ip "$PUBIP" '.GET[] | select(.__addr==$ip) | {name,connected,maxconnections,serverpaused,secondaries}'
```

- **Confirms:** that `connected` matches the instance's own count in all four cases — in
  particular that the **caves-only** case reports 1 and not 0, which is the inferred-but-unproven
  claim in §5.2.
- **Also record:** the propagation delay between a join and `connected` changing, and whether
  `serverpaused` tracks `Sim paused`.
- **Note:** the region is whatever the Master registered in (read it from the log), *not*
  `us-west-2` — Klei's lobby regions are only us-east-1, eu-central-1, ap-southeast-1, ap-east-1.

**A2S (expected to fail; 10 minutes to confirm, then drop it).**

```bash
PORT=$(grep -o 'SteamMasterServerPort: [0-9]*' Master/server_log.txt | tail -1 | awk '{print $NF}')
python3 -c "import a2s;print(a2s.info(('127.0.0.1',$PORT)))"
```

- **Expect:** timeout. Large-scale probing of live DST servers returned zero A2S responses (§5.1a).
- **If it unexpectedly answers:** note it, but do not restructure the design around it.
- Run **from the instance itself**; do not open the query port in the security group for this.

### S12 — Log rotation, long-run, and the AFK kick

- **Steps:** Leave the cluster idle for >30 min with the poller running (shutdown action stubbed
  out to a log line). Check log file sizes and whether DST rotates/truncates.
- **Confirms:** the tail-reader handles truncation (`size < offset → offset = 0`), and that a real
  fresh-start-no-joins run trips at ~30 minutes.
- **Separately:** connect a client and leave it completely idle for >30 minutes. Confirm the server
  drops it with `ID_DST_IDLE_TIMEOUT` at ~1800 s, that the count then goes to 0, and that
  `Sim paused` fires. This bounds how long an AFK player can hold the idle timer open — a useful
  safety property, since it means "someone left the game running overnight" still ends in a
  shutdown roughly 60 minutes later rather than never.
- **Also check** the hours field in log timestamps as uptime crosses 10 h and 100 h, confirming the
  `\d+` hours regex (the timestamp is uptime, not wall clock).

### S13 — End-to-end

- **Steps:** Fresh start, nobody joins. Confirm shutdown fires at joinable + 30 min ± 1 min.
  Then: fresh start, one player joins at minute 5 and leaves at minute 10; confirm shutdown fires
  at minute 40, not minute 30.
- **Confirms:** the clock resets on activity and starts from the right origin.

---

## Open questions the spike must settle

1. **Does `shard_players:GetNumPlayers()` behave as the source says?** This has *replaced* the old
   question #1 as the thing to prove, and it is a much easier one, because the answer is
   source-verified rather than inferred: `_numPlayers:set(_localPlayers + _secondaryShardPlayers)`
   **[SOURCE]** `shard_players.lua:52-56`. Spike must confirm (a) the accessor path
   `TheWorld.shard.components.shard_players` resolves on a dedicated server, (b) it returns the
   cluster total when read from the **Caves** shard (it is a synced netvar, so it should), and
   (c) how it behaves for a client in character select and mid-migration, where it is expected to
   under-report. **S2/S3/S4.**
2. **Is `TheNet:GetClientTable()` cluster-wide or per-shard?** Now a secondary question, since the
   design no longer depends on the answer. Evidence *for* cluster-wide: the vote system runs
   Master-only and builds its roster and quorum from this table (`worldvoter.lua:347`,
   `usercommands.lua:218` **[SOURCE]**), and vote-kick is not broken on caves clusters; the
   scoreboard renders from it **[SOURCE]** `playerstatusscreen.lua:352`; `dst-manager` polls only
   the Master **[FIELD]**. Evidence *against*: no `shardid` field on the rows, and the very
   existence of `shard_players.lua`'s explicit `local + secondary` sum suggests the engine does
   **not** hand you a cluster-wide player list for free. **S2/S3 settle it.** If it turns out to be
   per-shard, the `max()` formula already covers it and S5 is the check that you must not sum
   client tables.
3. **Do stdin console commands execute while the sim is paused?** Strong source evidence yes
   (`update.lua` keeps `WallUpdate` and `StaticUpdate` running while paused) **[SOURCE]** plus
   `dst-manager` polling empty (therefore paused) servers **[FIELD]**, but no direct proof.
   **S1 settles it.** Fallback: `pause_when_empty = false` — but note that costs us Cross-check A.
4. **How long is the transient zero-count window during a migration?** The client is genuinely
   disconnected from the source shard for ~14 s in real logs (`00:19:53` disconnect →
   `00:20:07` authenticated on Caves) **[LOGS]**. If the client table is per-shard, the `max()`
   formula could read **0** for most of that window. **This is now the most important
   safety question after #1** and sets N. **S4.**
5. **How long after a client hard-crash does the count drop?** Sets the lower bound on N and
   confirms the count self-heals. **S6.**
6. **Is `Sim paused` reliable on a 2-shard cluster specifically?** All the `Sim paused` evidence
   comes from a 3-shard cluster. **S1/S3.**
7. ~~Is `IdleTimeout: 1800s` server-side?~~ **RESOLVED [SOURCE]:** no — `ID_DST_IDLE_TIMEOUT` is a
   client disconnect reason in `strings.lua`'s popup tables. It kicks AFK players, not the server.
   Confirm in **S12** that a connected-but-idle client is actually dropped at 1800 s, since that
   conveniently bounds how long an AFK player can hold the idle timer open.
8. ~~Does DST answer A2S on 27016?~~ **RESOLVED (measured):** no — 13,340 probes across 2,013
   live servers returned zero DST responses, and no DST server is registered with the Steam master
   server. S11 downgraded to a sanity check.
9. ~~Do `[Join Announcement]` lines appear in one chat log or both?~~ **RESOLVED [LOGS]:** both —
   the chat log is byte-duplicated on every shard. Parse the Master's only.
10. ~~Do shard migrations emit join/leave announcements?~~ **RESOLVED [SOURCE] + [LOGS]:** no. But
   they *do* emit `Client authenticated` / `Connection lost` / `[Shard] ... disconnected from`, so
   those must not be counted.
11. ~~Which log line marks Caves being up?~~ **RESOLVED [LOGS]:** `[Shard] Secondary Caves(N)
    ready!` then `World N is now connected` on the Master; `Slave LUA is now ready!` is the legacy
    form of the Caves-side `secondary shard LUA is now ready!`.

---

## Sources

Game scripts (Klei's shipped `scripts/`, mirrored):

- <https://github.com/penguin0616/dst_gamescripts> — `consolecommands.lua`, `networking.lua`,
  `shardnetworking.lua`, `mainfunctions.lua`, `update.lua`, `debugprint.lua`, `strings.lua`,
  `prefabs/player_common.lua`, `screens/playerstatusscreen.lua`, `screens/redux/pausescreen.lua`,
  `components/worldoverseer.lua`, `usercommands.lua`, `mods.lua`,
  `widgets/redux/serverpausewidget.lua`

Real `server_log.txt` / `server_chat_log.txt` files (the **[LOGS]** evidence — six independent
clusters, including two with recorded shard migrations):

- <https://github.com/chientrm/dst-configs/tree/58d13d4e59ebfc79b7a3b7fde97b310b21bb4b86/3Shards>
  — `Master/`, `Caves/`, `Loot/`; 3 shards, 8 migrations, full `Sim paused` list
- <https://github.com/brofathan/dst-test/tree/e301d4dc906c2e97c701ced7e47221c24482bebc> —
  `Master/`, `Caves/`; the verbatim two-way migration traces
- <https://github.com/wellbritto98/dontstarvecluster/tree/a4713c3338e3e71fce5dc50cb0ebe2be27b21893/cluster_1>
  — Portuguese server, `Server Paused` manual-pause variant
- <https://github.com/exyexin/dont_starve_bak> — `Cluster_1/Master/backup/server_log/` (kick lines)
- <https://github.com/simonmysun/dont_starve_together-save>,
  <https://github.com/JLU-Neal/DST> — additional Master/Caves pairs
- <https://steamcommunity.com/app/322330/discussions/0/3377008022028484831/> — legacy "Slave"
  wording, full Caves log
- <https://forums.kleientertainment.com/forums/topic/131540-dst-server-stuck-on-registering-master-server-in-eu-lobby/>
  — pre-geo-DNS `Registering master server in EU lobby`, and the `Secondary shar` typo
- <https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/players-got-disconnected-while-migrating-from-master-or-caves-on-dedicated-server-r12552/>
  — migration timeout/cancel lines
- <https://forums.kleientertainment.com/forums/topic/168205-connection-lost/> — clean-disconnect
  sequence
- <https://gist.github.com/w1ndy/ee18a9f73a277642806fe3c0d5d55dcd> — the only other public chat-log
  parser found

(Klei's forums 301 to `kleiforums.com` and both 403 ordinary fetchers; those three threads were
read through a text-extraction proxy.)

Working third-party implementations:

- <https://github.com/JemiloII/dst-manager> — `src/server/services/monitor.ts` (FIFO console pipe,
  `__PC:` player query, `Sim paused` as running marker, shutdown timing note)
- <https://github.com/miracleEverywhere/dst-management-platform-api> — `dst/world.go` (screen-based
  query, `[Host]` filter, tail-from-end log read), `dst/player.go` (chat log regex)
- <https://github.com/carrot-hu23/dst-admin-go> — `internal/service/player/player_service.go`
- <https://github.com/jaakkytt/dst-server-status-bot> — `print.py` (stdin write + sleep caveat)
- <https://github.com/TotalLag/dst-server-apprunner> — `common/game_commands.py` (tmux send-keys)
- <https://github.com/dockhippie/dst> — `latest/overlay/etc/templates/server.ini.tmpl` (`[STEAM]`
  ports)
- <https://github.com/adzil/dstcluster> — per-shard stdin routing
- <https://github.com/Jamesits/docker-dst-server>, <https://github.com/ysc3839/docker-dst-server>

Klei lobby / A2S:

- <https://lobby-v2-cdn.klei.com/regioncapabilities-v2.json> — region list
- `https://lobby-v2-cdn.klei.com/{region}-{Steam|PSN|Rail|XBone|Switch}.json.gz` — bulk listing,
  no auth, top-level key `GET`
- `POST https://lobby-v2-{region}.klei.com/lobby/read` — per-server detail, token required
- <https://kleiforums.com/forums/topic/169699-how-to-get-an-up-to-date-dst-server-list-server-info-api-lobby-listings-a2s/>
  — Klei dev "nome" sanctioning third-party use of the listing JSON, Feb 2026
- <https://kleiforums.com/forums/topic/64552-dedicated-server-settings-guide/> — Klei staff
  settings guide (the `[STEAM]` port defaults)
- <https://github.com/gamedig/node-gamedig/blob/master/lib/games.js> — the `dst` entry (generic
  valve protocol at 27016)
- Reference lobby clients: <https://github.com/dstgo/lobbyapi>,
  <https://github.com/Crestwave/dst-misc> (`util/lobby/fetch-row.sh`),
  <https://github.com/LetsStarveTogether/dst-server>,
  <https://github.com/ilyfairy/DstServerQuery>,
  <https://github.com/IamFlea/antlion-dst-discord-bot>

Network / kernel / RakNet:

- <https://docs.kernel.org/networking/nf_conntrack-sysctl.html> — UDP conntrack timeouts (30/120 s)
- <https://github.com/torvalds/linux/commit/ba3fbe663635ae7b33a2d972c5d2def036258e42> —
  conntrack hooks are off until a ruleset needs them
- RakNet `RakPeer.cpp` — `defaultTimeoutTime = 10000`, ~5 s reliable keepalive, the unconnected-ping
  magic `00ffff00fefefefefdfdfdfd12345678`
- <https://forums.kleientertainment.com/forums/topic/136918-how-does-klei-ping-dedicated-servers/> —
  Klei dev: the browser ping comes from the *client*, direct to the shard port
- <https://github.com/Wollwolke/dst-ping> — a working RakNet unconnected-ping liveness prober

Existing DST server-management projects surveyed (none do idle shutdown):

- <https://github.com/Jamesits/docker-dst-server>, <https://github.com/ysc3839/docker-dst-server>,
  <https://github.com/suppaduppax/dst-dedicated-server-scripts> — process liveness only
- <https://github.com/qwertyuiop6/DST-Server-Build> `dst-admin.sh:306` — the nonce + log-grep
  pattern, in its clearest form
- <https://github.com/ChengTu-Lazy/Linux_DST_SCRIPT> — `-NOBODY` flag defers updates while players
  are online (the only empty-gated action found anywhere)
- <https://github.com/LetsStarveTogether/dst-server> — `DoStaticPeriodicTask(60, ...)` over
  `GetPlayerClientTable()`, with the "static tasks keep running while paused" comment
- <https://github.com/TotalLag/dst-server-apprunner> — log Grok patterns, EKS
- <https://github.com/vmorganp/Lazytainer> — generic pcap-threshold container idler (not DST)

Background / forum-grade:

- <https://support.klei.com/hc/en-us/articles/360029556192-Dedicated-Server-Command-Line-Options-Guide>
- <https://dontstarve.fandom.com/wiki/Guides/Don%E2%80%99t_Starve_Together_Dedicated_Servers>
- <https://rocketnode.com/help/dont-starve-together/how-to-enable-pause-when-empty-on-your-dont-starve-together-server>
- <https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/game-does-not-pause-when-empty-r36807/>
- <https://forums.kleientertainment.com/forums/topic/92439-player-count/>
- <https://steamcommunity.com/sharedfiles/filedetails/?id=590565473> (caves on Linux)
