# What is inside a DST save — measured on the real world

Date: 2026-09-27. Question asked: could this project show (1) each player's own revealed map, surface
and caves, (2) their inventory and the world's storage, and (3) a recap of what happened in a
session? This file is the **evidence half**: what the save and the session logs actually contain,
decoded by hand from `worlds/tylerni2026/save.tar.zst` (current version and the version before
the 2026-09-27 session) and all ten `sessions/tylerni2026/*/` prefixes. The design half is
`docs/research/map-inventory-recap.md`, and what other people do is
`docs/research/community-servers-and-mods.md`.

Nothing was built. Nothing was written to S3; everything was read into a scratch directory. Read-only
history, like everything in `docs/research/`.

Markers: **[measured]** decoded and checked by hand on our save · **[code]** read in the game's own
Lua (`data/databundles/scripts.zip`, extracted from our cached `binaries/dst-binaries.tar.zst`,
build `24700372`) · **[inference]** reasoning, not verified.

Player-identifying values (KU ids, the hashed per-user directory names, SteamID64s, persona names)
are deliberately left out of this public file and written as `<KU>`, `<userdir>`, `<steamid64>`.

## The short answer

| Want | Where it is | How hard |
|---|---|---|
| Terrain for the map, both shards | world file, `map.tiles`: base64 `VRSN` grid, u16 per tile | **Easy** — decoded, §2 |
| Area names ("Grass", "Rocky", "Forest") | world file, `map.nodeidtilemap` + `map.topology.ids` | **Easy** — decoded, §2.3 |
| Where each player *walked* | player file, binary tail: 1 bit per tile, per shard | **Decoded**, §3.3 |
| What each player's map *shows* (fog of war) | player file, binary tail: the compressed prefix before that bitmap | **Not decoded**; get it from the engine instead, §3.4 |
| Player inventory, equipment, backpack contents | player file, Lua `data.inventory` | **Easy** — §4 |
| Every chest, icebox, cookpot, drying rack, Chester | world file, `ents.<prefab>[i].data.container.items`, with x/z | **Easy** — §4 |
| Recipes learned, health/hunger/sanity, character | player file, Lua | **Easy** — §4 |
| Day, season, phase, daily history | `*.meta` per snapshot; 6 snapshots per shard per save | **Easy** — §5 |
| What happened (deaths, revives, cave trips) | `sessions/.../server_chat_log.txt`, `server_log.txt` | Thin, §6 |
| Which Steam user is which save player | `server_log.txt`: `userid=<KU> netid=<steamid64>` | **Easy**, §7 |

**The two surprises.** First, the per-player file contains a lossless record of every tile that
player has stood on, for both shards. A before/after diff of it is "where did I go this session"
with no mod and no change to the running server. Second, the save **already holds the last ~6
days of daily snapshots**, so there is day-by-day history inside a single tarball.

## 1. Layout of one shard's `save/`

```
<Shard>/save/session/<shard session id, 16 hex>/
    0000000076 … 0000000081            world snapshots (Lua), one per autosave, ~4.0 MB Master / ~3.2 MB Caves
    0000000076.meta …                  `return {clock=…, seasons=…}` for that snapshot (~500 B)
    <userdir>/0000000076 …             per-player snapshots (Lua + binary tail), ~25-28 KB
    <userdir>/0000000076.meta          `return {character="wathgrithr"}`
    <userdir>/savelocation             one byte; Master only
<Shard>/save/shardindex, profile, modindex, …
```

- `max_snapshots = 6` (our `cluster.ini`) is why there are six of each. [measured]
- The Master session id and the Caves session id are different, and both appear inside every
  player file (§3). [measured]
- `<userdir>` is **not** the KU id; it is the engine's encoding of it, from
  `TheNet:GetUserSessionFile(sessionid, userid)` (`mainfunctions.lua:2100`). [code]
- A third, one-snapshot `<userdir>` exists with no inventory worth reading: someone who joined
  once. Filtering on "has more than one snapshot" or on the allowlist mapping (§7) handles it.
  [measured]

## 2. The world file

Executable Lua, one chunk per top-level key, ending in `return savedata` **plus one trailing NUL
byte** (Lua 5.4 refuses to load it until that byte is stripped). Top-level keys: `ents`, `map`,
`meta`, `mods`, `shard_network`, `world_network`. [measured]

It evaluates safely in an **empty environment** (`load(src, 'save', 't', {})`) because it is pure
table constructors inside `tablefunctions[...] = function() return {...} end`. [measured] That
matters for any parser: a real Lua VM (Lua 5.4 locally; `fengari` or `wasmoon` in Node) reads it
with no custom grammar.

### 2.1 `map`

- `width = 425, height = 425` on both shards (default size). [measured]
- `world_tile_map = { OCEAN_COASTAL=201, GRASS=…, … }` — name→id. **Always look ids up here**, not
  in a hard-coded table: `gamelogic.lua` remaps ids on load when Klei renumbers tiles. [code]
- `tiles`, `nodeidtilemap`, `nav` are base64 strings with the same shape [measured]:

  ```
  "VRSN" | 0x00 | u32 LE version (=1) | width*height × u16 LE, row-major (row = y)
  ```

  9-byte header, then exactly 361,250 bytes for 425×425.
- World → tile: `tx = floor(x/4 + width/2)`, `ty = floor(z/4 + height/2)` (`TILE_SCALE = 4`).
  Verified by overlaying a player's saved position: it lands in the middle of the base. [measured]

Tile make-up of our surface (top of list): OCEAN_SWELL 41,982 · OCEAN_ROUGH 36,518 · OCEAN_COASTAL
35,282 · FOREST 12,980 · IMPASSABLE 10,093 · SAVANNA 7,420 · GRASS 6,307 · DECIDUOUS 5,517 · …;
caves: IMPASSABLE 136,145 · SINKHOLE 8,900 · MUD 6,434 · CAVE 5,813 · … A flat colour per tile-name
prefix already produces a recognisable map of both shards. [measured]

### 2.2 `ents`

`ents.<prefab> = { {id=…, x=…, z=…, data={<component>={…}}}, … }`. Our surface has **15,228
entities**. Every structure, item on the ground, creature, tree and boulder, with position. [measured]

### 2.3 Area names without the engine

`nodeidtilemap` gives, per tile, an index into `map.topology.ids` (279 entries on our surface).
Entries look like `"Make a pick:BG_84:BGGrass"`, `"Dig that rock:7:Rocky"`,
`"For a nice walk:BG_64:BGForest"`. The first part is the worldgen *task* (not player-facing); the
last part is the *room* and reads as a biome ("Grass", "Rocky", "Forest", "Marsh", "DeepForest").
Mapping the five daily positions of one player through it gave Rocky → Grass (base) → Grass →
Forest → Grass. [measured] The live equivalent is `TheWorld.Map:GetTopologyIDAtPoint(x,0,z)`
(`components/map.lua`). [code]

## 3. The player file

```
3 bytes (varies per file; not decoded, not needed)
"return {x=…,z=…,data={inventory=…,builder=…,health=…,…},prefab="wathgrithr",age=0}"   -- Lua, ~3 KB
0x01                                   -- constant in every file checked (15): a version byte
repeat, once per shard the player has a map for (2 here: Caves then Master):
    u16 BE  id length (=16)
    16 B    shard session id, ASCII hex  -- matches the <Shard>/save/session/<id> directory
    u32 BE  block length (= 16 + compressed length)
    u32 LE  1
    u32 LE  16                          -- header size
    u32 LE  raw length                  -- 26,379 Caves / 39,573 Master for one player
    u32 LE  compressed length
    zlib stream
```

[measured on all 15 player files in two save versions; the Master- and Caves-side copies of a
player file both carry **both** shards' maps.]

The game side: `player:GetSaveRecord()` is dumped to Lua, then `TheNet:SerializeUserSession(…,
player.player_classified.entity, …)` hands the `MapExplorer` to C++, which appends the tail
(`networking.lua`). `RecordAllMaps()` / `LearnAllMaps()` in `prefabs/player_common.lua` are the
Lua face of the same "one map per shard" structure. [code]

### 3.1 Parsing the Lua part

Slice from `return {` up to the `0x01 0x00 0x10` that starts the map section; the result loads in
an empty environment exactly like the world file. [measured]

### 3.2 Inside the zlib payload

Two regions [measured]:

1. A **high-entropy prefix** (7.85 bits/byte; 16,994 bytes Master, 3,800 bytes Caves). zlib,
   raw deflate, LZ4, LZMA and zstd all reject it at every offset 0-15. Near its end it shows
   repeating 9-byte records beginning `00 01`. Its size tracks how much of the shard the player has
   explored. **Not decoded.**
2. A **bitmap of exactly `ceil(width*height/8)` bytes** (22,579 for 425×425) at the very end:
   1 bit per tile, **MSB-first**, row-major, same orientation as `map.tiles`. (LSB-first renders
   as a sheared mess, which is how the bit order was pinned down: MSB-first has zero row-to-row
   shift.)

### 3.3 The bitmap is the tiles the player has *visited*

Evidence [measured]:

- Rendered over the terrain, it is a 1-tile-wide network of paths that stays on land, fans out from
  the base, follows coastlines, and has one detached piece on a far island (a wormhole or boat
  trip). It is not a fog-of-war disc.
- **19 of 20** saved player positions (5 daily snapshots × 2 players × 2 save versions) sit on a
  set bit; the 20th is one tile away.
- Across the 2026-09-27 session it only grew: player A 7,268 → 8,125 tiles (+857, 0 removed),
  player B 7,751 → 7,974 (+223, 0 removed).
- The engine's Lua surface (LuaCATS stubs) has both `IsTileVisited` and `IsTileSeeable`
  ([code], via the map research agent). The tail is almost certainly the *visited* set; the
  undecoded prefix is almost certainly the *seeable* set (what the in-game map shows).

So "where did I go this session" is `after AND NOT before` on this bitmap — no mod, no poll, no
engine. The seeable fog is still wanted for a spoiler-free map; §3.4.

### 3.4 Getting the fog of war

Three routes, in order of preference:

1. **Ask the engine over the console** we already own: for each online player,
   `player.player_classified.MapExplorer:IsTileSeeable(tx, ty)` over every tile, printed
   run-length-encoded to `server_log.txt`. It is per tile, on the same grid. [code] The catch is an
   idle stop: nobody is online to ask, so the dump has to be taken when each player *leaves*
   (`ms_playerdisconnected`, `ms_playerdespawnandmigrate` listeners injected once per boot through
   the console) and periodically while they play. Details in `map-inventory-recap.md` §1.
2. **Approximate it**: dilate the visited bitmap by the reveal radius. Needs the radius
   calibrated once against route 1; `d_exploreland()` reveals the whole map by calling
   `RevealArea` every 5 tiles (`debugcommands.lua:265`), so the disc is at least ~3.5 tiles
   across. Good enough for a "where have I been" view, wrong at the edges.
3. **Decode the prefix** offline using route 1's output as the oracle (same player, same minute).
   Only worth it if route 1 turns out awkward; it is undocumented and can change in any patch.

## 4. Inventory and storage

Player file, Lua part [measured]:

```lua
data = {
  inventory = { items = { {prefab="log", data={stackable={stack=20}}}, {prefab="goldenshovel",
                data={finiteuses={uses=20}}}, … },          -- up to 15 slots
                equip = { hands={prefab="tentaclespike",…}, head={…}, body={prefab="piggyback",
                data={container={items={…}}}} } },          -- backpack contents nested here
  builder = { recipes = { "axe", "trap", …, "coldfirepit" } },
  health = { health=163.9 }, hunger = {…}, sanity = {…}, temperature = {…}, …
}
```

Durability is in the item data (`finiteuses.uses`, `fueled.fuel`, `armor.condition`,
`perishable.time`), so a real inventory view can show wear and spoilage.

World file: any entity with `data.container.items`. On our surface that is 5 `treasurechest`, 1
`icebox`, 1 `chester`, 2 `cookpot`, 3 `meatrack`, 1 `backpack` on the ground, plus world-gen
containers such as `terrariumchest` (unopened loot — a **spoiler** unless its tile is in the
viewer's revealed area). [measured]

Icons: the dedicated-server install ships the inventory atlases (`images/inventoryimages{,1-4}.xml`
+ `.tex`, KTEX format), the minimap icon atlases (`minimap/minimap_atlas{,1,2}.tex` +
`minimap_data*.xml`) and the minimap ground textures (`levels/textures/mini_*_noise.tex`, 35
files). All are already inside our cached `binaries/dst-binaries.tar.zst`. They are Klei's art, and
this repo is public: extract at build or run time, never commit (licensing notes in
`community-servers-and-mods.md`). [measured]

## 5. Days, seasons, and the snapshots already in every save

Each `*.meta` is `return {clock={cycles=…, phase=…}, seasons={season=…, elapseddaysinseason=…,
remainingdaysinseason=…}}`. The six snapshots of the two save versions [measured]:

| Save | Snapshot days (`cycles`+1) |
|---|---|
| before the 2026-09-27 session | 50, 51, 52, 53, 53, 53 (spring) |
| after it | 57, 58, 59, 60, 60, 60 (summer, day 1-4 of 15) |

- DST autosaves at every dawn, so each snapshot is one in-game day. The repeats of the last day
  are DST's own saves on pause/shutdown — **not** ours: the supervisor forces no `c_save()`
  (`packages/supervisor/src/tasks/inflight.ts`).
- So a save holds roughly the last 3-6 days, and each player's snapshots hold a **daily
  position**: player A's five snapshots put them out on the Rocky west at dawn of day 57, at the
  base (Grass) on days 58 and 59, in the southern Forest at dawn of day 60, and back at the base
  at the stop. That is the "sample of locations" asked for, for free.
- **Session length vs window:** the 2026-09-27 session ran days 53 → 60. Days 54-56 fell out of the
  6-snapshot window before the stop. `max_snapshots` is a `cluster.ini` knob (docs/game-server.md
  §5); raising it costs save size. Taking what is needed at stop time and writing it to `sessions/`
  is the better fix.
- **Retention:** `worlds/` noncurrent versions expire after 30 days once 10 newer exist
  (`docs/storage.md` §2), so anything computed from before/after versions must be computed at stop
  time and written under `sessions/` (never expires).

## 6. What the uploaded session logs contain

All ten sessions (2026-09-21 → 2026-09-27) [measured]:

- `server_chat_log.txt`: 0-7 lines per session, only `[Join Announcement]`, `[Leave
  Announcement]`, `[Death Announcement] … was killed by Overheating.`, `[Resurrect Announcement] … was
  resurrected by …`, `[Skin Announcement]`. **No typed chat at all** in a week of play: the two
  players talk out loud. An LLM summary built from chat would have nothing to summarise.
- Every announcement is in **both** shards' chat logs.
- `server_log.txt` (~1,000 lines/hour Master): 126 of 1,212 lines in the last session are the echo
  of our own count poll (`RemoteCommandInput: "local ok,s,c,a = …"`). Useful lines: boot-time
  `setting cycles 52` / `setting season spring` (the start day), `[Shard] Migration request: (<KU>)
  to Caves(2)` (cave trips), `Spawning player at: [Load] (x, 0, z)`, `Server Paused`/`Unpaused`,
  `Serializing world: session/<sid>/<n>` (one per autosave).
- Times are seconds since process start, not wall clock; anchor with `manifest.json`.
- `supervisor.log`: JSON lines, a `count_poll` every 30 s per shard. The poll is the natural place
  to add a position sample (see the design doc).

## 7. Mapping the signed-in Steam user to a save player

- `server_log.txt` has `[ClientObject] Initialized (authenticated) on server: … userid=<KU>
  netid=<steamid64> admin=1` on every join (35 lines with a SteamID64 in the last session's Master
  log). That is the Steam → KU link. [measured]
- `TheNet:GetUserSessionFile(sessionid, userid)` gives KU → `<userdir>`. [code] A console one-liner
  at join, or the `Resuming user: session/<sid>/<userdir>/…` line that follows `Client
  authenticated: (<KU>) <name>`, gives the other half. [measured]
- **Privacy:** the uploaded logs already contain SteamID64s and KU ids today (the scrub in
  `docs/storage.md` §8 removes only the token and password). They sit in the private bucket, which is
  fine; any new derived artifact the web API serves must be keyed by our own user id and never echo
  a KU or SteamID64 to a page other than its owner's.

## 8. How the analysis was done (to reproduce)

```bash
export AWS_PROFILE=admin
B=dst-server-manager-data-063257577013
aws s3 cp s3://$B/worlds/tylerni2026/save.tar.zst . --region us-west-2
zstd -dc save.tar.zst | tar -xf -                     # never extract into the repo
# previous version: aws s3api get-object --version-id <preStartVersionId from manifest.json> …
# game scripts: stream binaries/dst-binaries.tar.zst through `tar -xf - --include '*databundles*'`
#   (bsdtar syntax; GNU tar uses --wildcards), then unzip data/databundles/scripts.zip
```

Parsing used Lua 5.4 (`load(src, 'save', 't', {})` after stripping the NUL) for the Lua parts and
Python `zlib` + `numpy.unpackbits(…, bitorder='big')` for the map tail. None of the scratch output
(renders, dumps) is committed: it is derived from the save, and the save never enters this repo.
