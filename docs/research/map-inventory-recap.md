# Per-player map, inventory, and session recap — research

Date: 2026-09-27. Question asked, after a week of real play:

> 1) A rendered map, but from the perspective of the authenticated steam user — since each user
> has their own revealed state (i.e. no spoilers). Updated e.g. at the end of a session. Including
> caves. 2) Similar to 1 — a rendered inventory. Maybe storage inventories as well. 3) … A sort of
> LLM summary of what happened during a session … how many days passed … a sample of locations
> throughout the session. If a few days pass, I struggle to remember what was happening, and what I
> was currently doing, or what I was planning to do. Taking notes is a PITA.

Nothing was built. The evidence is in `docs/research/save-anatomy.md` (the save, decoded by hand
from our real world); what other people do is in `docs/research/community-servers-and-mods.md`.
This file is the design space and a recommendation for the follow-up session. Read-only history,
like everything in `docs/research/`.

**Verdict: all three are buildable, and most of the value needs no change to the game server at
all.** Our S3 bucket already holds, for every session, the save before and after it plus its logs.
A small offline "digest" of those files gives the days that passed, where each player went (a real
per-tile trail, not samples), their daily positions, what got built, what changed in storage, deaths,
cave trips and each player's current inventory. The one thing that needs the live engine is the exact
fog of war for the spoiler-free map. Getting it is a console dump the supervisor can already send.

## The short answer, as a table

| Feature | Source | Needs a server change? | Effort | Verdict |
|---|---|---|---|---|
| **Recap: days, season, deaths, cave trips** | `manifest.json` + chat/server logs + snapshot `.meta` | no | small | **Do first** |
| **Recap: where each player went this session** | visited-tile bitmap, before vs after (save-anatomy §3.3) | no | small | **Do first**: it is exact, not sampled |
| **Recap: daily positions, named by biome** | the ~6 snapshots in each save + `nodeidtilemap` | no | small | **Do first** |
| **Recap: built / learned / storage changes** | entity counts vs placeable recipes; `builder.recipes`; container contents | no | small | **Do first**. On the real 2026-09-27 session: "built an Endothermic Fire Pit and a chest; learned Endothermic Fire" |
| **Inventory: each player's own** | player file, Lua part | no | small | **Do**, with the recap |
| **Inventory: shared storage** | world file containers with x/z | no | small | **Do**. Show only containers the viewer has discovered |
| **Map: terrain + my trail + my containers** | tiles + visited bitmap | no | medium (the renderer) | **Do**. Visited-dilated is a good-enough reveal to start |
| **Map: exact fog of war** | `MapExplorer:IsTileSeeable` over the console | yes, supervisor only, no mod | medium | **Second step**. Needs one experiment on a `test-` world |
| **Map: game-accurate look** (Klei textures + icons) | `binaries/` tarball (already in S3) | no | medium-large | Later, optional. Never commit the art |
| **Timeline within a session** (a path with times) | extend the existing 30 s count poll with positions | yes, supervisor only | small | Nice-to-have. The trail + daily positions cover most of it |
| **"What we were planning"** | a notes box on the site, shown with the recap | no | small | **Do**. It is the only reliable source of *intent* |
| **LLM prose** | the digest JSON + notes + previous recap | no | small | Optional polish on top of the deterministic recap |
| **Rich event log** (every craft, kill, meal, boss) | a server-only Lua mod printing JSON to `server_log` | yes, adds our first mod | medium | Only if the above feels thin |

## 1. Architecture: capture, digest, serve

Three layers. Each runs where it is cheapest and where it cannot threaten the invariants.

```
 instance (supervisor)            us-west-2 Lambda "digest"            us-east-1 API + web
 ─────────────────────            ─────────────────────────            ───────────────────
 only engine-only facts:          triggered by                          GET /api/worlds/:id/recap
  - fog dumps (IsTileSeeable)      sessions/<w>/<s>/manifest.json       GET /api/worlds/:id/map?shard=
  - optional position samples      reads worlds/<w> @pre + @post        GET /api/worlds/:id/inventory
  - Steam↔KU↔userdir mapping       + the session's logs                  - resolves viewer → KU
 written into sessions/<w>/<s>/    writes sessions/<w>/<s>/digest/*       - serves only the viewer's
 before logs_uploaded (§9 step 5)  (never touches worlds/ or seed/)        own reveal and inventory
```

**Why the digest is not in the supervisor.** The stop path is budgeted, measured and ordered
(docs/game-server.md §9: save → logs → state → `haltNow`, 8 min global budget), and it is the path
that protects the save. Parsing two 4 MB Lua files and rendering is exactly the kind of work that
should never sit on it. A Lambda triggered by the manifest upload is decoupled from it: it can fail
or be redeployed without touching a session, it can **re-run over past sessions** (a backfill is
just re-sending the event), and it can be tested offline against a downloaded save. The instance
only captures what *only a live engine can answer*, as small text files, inside the step that
already uploads the logs.

**Parsing.** Both save files are pure Lua table constructors that evaluate in an empty environment
(save-anatomy §2). In Node, a Lua VM (`wasmoon` is Lua 5.4 compiled to WASM; `fengari` is pure JS)
reads them with no custom grammar. The binary map tail is `zlib` plus a bit unpack, which is stdlib.
A regex parser in the style of dst-admin-go is the fragile alternative.

**Retention matters now.** `worlds/` noncurrent versions expire after 30 days once 10 newer exist
(docs/storage.md §2). There are 13 versions today, so the oldest sessions' before/after pairs start
disappearing around **2026-10-21**. Two consequences:
- the digest must be computed at stop time (and written under `sessions/`, which never expires);
- **a backfill of the ten existing sessions is only possible until then**. Doing it in the first
  implementation session would keep the whole history from day 28 onward.

**Output.** Per session, under `sessions/<w>/<s>/digest/` (proposed, small):
- `recap.json`: the deterministic facts of §3;
- `players/<KU>.json`: each player's inventory, equipment, recipes and stats at the stop, and daily
  positions;
- `trail/<KU>/<shard>.bin`: the visited bitmap after the session, and the *new* bits;
- `fog/<KU>/<shard>.bin`: only once the console dump exists.

**The world render** (terrain only) changes rarely and can be one per world, per shard.

**Serving and "no spoilers".** The API already knows the viewer's SteamID64 (docs/auth.md). The
Steam → KU link is in `server_log.txt` on every join (`userid=<KU> netid=<steamid64>`, save-anatomy
§7). The digest writes a `players.json` mapping per world, readable only by the API role. Two rules:

1. **Mask server-side.** The API sends the viewer the terrain *already cut to their reveal*. It never
   sends the full grid with a client-side mask: a browser that holds the full map is one devtools
   click from spoilers.
2. **Serve only the viewer's own.** Reveal, trail and inventory come from the viewer's own KU. A KU
   or SteamID64 is never echoed to the page. The API role gets `s3:GetObject` on
   `sessions/*/digest/*` only (today it has no access to the data bucket at all). Shared storage is
   filtered the same way: a container is shown only if its tile is in the viewer's reveal. That
   hides world-gen loot like the `terrariumchest`.

## 2. The map (feature 1)

### 2.1 What "revealed" means, and three ways to get it

The in-game map shows the *seeable* set: fog cleared in a radius around everywhere you have been.
The save holds two things per player per shard (save-anatomy §3):
- a decoded 1-bit **visited** bitmap (the trail);
- an undecoded, compressed blob that is almost certainly the **seeable** set.

| Route | Accuracy | Works after an idle stop? | Cost |
|---|---|---|---|
| **A. Dilate the visited bitmap** by the reveal radius | close in the interior, wrong at the edges | yes | none. Offline, today |
| **B. Console dump** of `MapExplorer:IsTileSeeable(tx,ty)` over every tile, RLE-printed to `server_log` | exact | only if taken **before** the player leaves | supervisor change, no mod |
| **C. Decode the blob**, using B's output as the oracle | exact | yes | a reverse-engineering session. Undocumented; can break in any patch |

**Recommendation: A first, then B.**
- A gives a useful "where have I been" map immediately.
- B is the exact, spoiler-correct version. It has one catch: an idle stop happens with *nobody
  online*, so there is no player to ask. The fix is to take the dump when each player leaves.
  - After each shard is joinable, the supervisor sends one line through the console. It defines a
    `DSTMAP_DUMP(player)` function and hooks the world's `ms_playerdisconnected` and
    `ms_playerdespawnandmigrate` events. `mainfunctions.lua` fires the first while the player
    entity still exists; the second fires on every cave-entrance trip.
  - Add a periodic dump for crash cover.
  - The supervisor picks `DSTMAP …` lines out of the tailed log the same way it already picks
    `DSTQ` replies (`packages/supervisor/src/core/parse.ts`), and writes the newest one per player
    per shard into `sessions/`.
  - The console Lua and the engine calls are from the game's own scripts [code]. Whether 180,625
    `IsTileSeeable` calls fit comfortably in one console line's execution has **not** been measured.
- C is only worth it if B turns out awkward.

**The experiment that settles B** (about 30 minutes, `test-` world, one client):
1. Walk a known path and go into the caves once.
2. Run the dump by hand on each shard's console.
3. Overlay it on the decoded tiles.
4. Disconnect and confirm the listener fired.
5. Measure how long the dump takes.
6. In the same minute, save the player file. That gives C its oracle pair, and gives A its reveal
   radius by comparing the dump with the visited bitmap.

### 2.2 Rendering

- **v1, flat colours.** One colour per tile-name prefix (OCEAN_*, FOREST, GRASS, SAVANNA, MARSH,
  ROCKY, DESERT_DIRT, DECIDUOUS; caves: SINKHOLE, MUD, CAVE, FUNGUS*, UNDERROCK, ARCHIVE; IMPASSABLE
  as background).
  - This was prototyped against the real save for both shards. It is instantly recognisable: the
    base, the coast walks and the far-island trip all read clearly.
  - Carries no licensing question.
  - Overlays: the viewer's trail, this session's new tiles in a second colour, daily positions,
    their containers, a death marker (§3).
- **Where to draw.** Either render a PNG in the digest Lambda (`sharp` or `@napi-rs/canvas`), or ship
  a compact masked grid (425×425 u8 palette indices ≈ 180 KB raw, far less gzipped) and draw it on a
  `<canvas>` in the page.
  - The canvas route fits the phone-first Mantine UI better (pinch-zoom, tap a chest to see its
    contents).
  - It keeps the Lambda trivial.
- **Later, the game's own look.** The dedicated-server install ships:
  - the minimap ground textures (`levels/textures/mini_*_noise.tex`);
  - the icon atlases (`minimap/minimap_atlas*.tex` + `minimap_data*.xml`);
  - the inventory icons (`images/inventoryimages*.tex`).

  All are KTEX (DXT-compressed) and already inside our S3 `binaries/` tarball. `ktech`
  (nsimplex/ktools, GPL-2.0) converts them. Klei's fan-content guidelines permit a free,
  non-commercial, private tool.

  **This repo is public, so the art is extracted at build or deploy time and never committed.** The
  same applies to any image derived from the save, including the maps rendered during this
  research, which stayed in a scratch directory.
- **Caves.** Same formats, their own 425×425 grid, their own shard session id in the player file.
  Show them as a second tab.

## 3. The recap (feature 3), and what it would have said

### 3.1 Deterministic first

Everything below comes from files that already exist, computed on the real 2026-09-27 session
(player names withheld):

> **Days 53 → 60** · spring → summer (summer began day 56; 11 days of it left) · 64 min real time
>
> - **Built:** Endothermic Fire Pit, Chest. **Learned:** Endothermic Fire (both), Boards.
> - **Died:** player B, *Overheating*, revived by player A 4 min later.
> - **Caves:** several trips down and back.
> - **Storage:** +18 thulecite fragments, +3 moon glass, −28 light bulbs, −21 ice, +35 spoiled food.
> - **Where you went:** player A walked 857 tiles they had never stood on (map, in red), player B
>   223. Player A's days: west Rocky biome (57), base (58–59), the southern Forest (60), home at
>   the stop.
> - **You are carrying:** …your 15 slots, backpack and equipment, with durability.

That is roughly the "previously on" the question asks for. Every line is a fact. The filters used,
all prototyped:
- **Structures:** entity-count changes restricted to *placeable* recipes (143 of them, grepped from
  `recipes.lua`). Without the filter the list is noise: `burntground +200`, `rabbit +51`.
- **Recipes:** `builder.recipes` after minus before.
- **Storage:** the sum of container items after minus before.
- **Deaths and revives:** the chat log, deduped across the two shards.
- **Days:** `cycles` + 1 from the `.meta` files and the boot-time `setting cycles` line.

Things worth adding that are pure computation:
- **Season warnings.** "Summer day 4 of 15; you have no ice box stocked" follows from the state.
  Novice-friendly, and it does not make the game easier: every number is on the in-game clock.
- **"Last time you were heading…".** The direction of the last new trail segment, named by biome.

### 3.2 Intent needs a human, so make it one tap

The save records what *happened*, never what you *meant to do*. The user said notes are a PITA, and
the logs show the two players never type in chat: a week of chat logs holds zero `[Say]` lines. So
the in-game `#todo` chat convention the research turned up will not be used.

Ranked options:

1. **A "next time" box on the recap page.** It is shown right after a stop, and when the world card
   says `stopped`: one line, phone keyboard, optional. The next recap shows it at the top. Stored
   per world in DynamoDB. That is the whole feature, and it is the only thing that captures
   intent.
2. **Welcome-back line in game.** On the first join of a session, the supervisor sends a
   `c_announce("Last time: day 53→60 … Next: <note>")` through the console it already owns. Keep it
   to one line.
3. **In-world notes** (signs) are already in the save (`writeable.text`, save-anatomy §2). Show any
   that exist on the map. Our world has none today.

### 3.3 The LLM layer, if wanted

**Not needed for the core.** It is a small, optional polish step. Feed it:
- the structured `recap.json`;
- the note;
- the previous recap.

Do not feed it raw logs: ~90% of `server_log.txt` is engine noise or our own poll echo.

Ask it for:
- three bullets of "previously on";
- "open threads", listing only what the notes or the state support, with anything inferred
  labelled as inferred.

One call per session, a few KB of input, costs cents a month on a small model. It needs a new
secret (an API key in SSM, human-managed like the Klei token) and an egress call from the digest
Lambda. It should degrade to the deterministic recap when it fails.

### 3.4 A finer timeline, if the trail is not enough

The supervisor already sends each shard a Lua snippet every 30 s and parses a `DSTQ` reply
(`packages/supervisor/src/core/parse.ts`). A second function can be defined once at boot and then
called, so the echo stays short: `DSTP()` prints day, phase and each player's x/z, and optionally
health, hunger, sanity and the biome from `Map:GetTopologyIDAtPoint`. That is about 16 samples per
in-game day, enough to draw an ordered path with times. The per-shard caveat applies: `AllPlayers`
is that shard only. Keep it off the count-poll's parsing path so a bad sample can never affect idle
detection.

### 3.5 A server-side event mod: only if the recap feels thin

A ~100-line **server-only** mod (`all_clients_require_mod = false`, so clients download nothing)
could print one JSON line per craft, structure, kill, boss death, meal, recipe unlock, day and season.
Prior art: `IamFlea/Deerclops-Lite-Logger` does exactly this into `server_log`.

Reasons to wait:
- it would be the project's first mod;
- it needs a `mods/` install step on each boot and `modoverrides.lua` on both shards;
- Klei has been tightening the mod API after a 2025 malicious-mod incident.

The save diff already answers "what got built and what changed". The mod adds *when*, and kills.

## 4. Inventory (feature 2)

- **Each player's own.** 15 inventory slots, equipment (hands/head/body), the backpack nested under
  body, with durability, fuel, armour condition and spoilage (save-anatomy §4). Sourced from the
  newest player file across both shards, since a player saves on whichever shard they were on last.
- **Storage.** The containers in the viewer's reveal, placed on the map, with a "find item" search:
  "where did we put the gears?" is a question the site can answer and the game cannot.
  - Our surface has 5 chests, an ice box, Chester, 2 crock pots and 3 drying racks.
  - Chester's contents move with Chester; show the saved position.
- **Change since last session** comes from the digest ("you used 4 healing salves").
- **Icons.** v1 uses text names and quantities, which need no art. The inventory atlas can come
  later, extracted at deploy time like the map textures.
- **Display names.** `STRINGS.NAMES.<PREFAB>` in `strings.lua` (in the same `scripts.zip`) turns
  `smallmeat_dried` into "Small Jerky". Generate the table at build time from the cached binaries.

## 5. What else people do with their servers (summary)

See `community-servers-and-mods.md`. The short version:
- The ecosystem is always-on web panels (mostly Chinese) and small Discord relays.
- Nobody else runs scale-to-zero.
- Nobody renders a per-player revealed map or inventories outside the game, so features 1 and 2
  are genuinely new.
- dst-admin-go renders the *whole* map from the same `tiles` field.
- The closest thing to a recap is a chat-log analyzer gist.
- For "QoL that doesn't make it easier", the right answer is mostly **client-only** mods, which
  each player subscribes to and the server never sees. The one server-side candidate is Global
  Positions (map sharing between the two of you). It is also the one that would *change* this
  design, because shared exploration makes the two players' reveals the same.

## 6. Risks and invariants

- **Public repo.** Never commit anything derived from the save: renders, dumps, recap text, player
  or KU ids, SteamID64s. Never commit Klei art. Fixtures for tests use a `test-` world's save, and
  even then only the synthetic generated one.
- **The save is precious.** The digest reads `worlds/` and writes only under `sessions/`. The
  instance-side capture writes small text files inside the existing log-upload step, which already
  sits after the save push. Nothing touches `seed/`.
- **Stop path.** No new work between `shards_stopped` and `save_pushed`. Fog dumps are taken while
  the world is running, so the stop path only uploads what is already on disk.
- **Scale to zero and cost.** A Lambda per session and a few KB to MB of S3 per session. No
  always-on anything.
- **Patches.** The visited bitmap, the player-file tail and the `VRSN` grid are undocumented engine
  formats. Put a strict parser with loud failure in front of each: log `digest_parse_failed` and
  show "recap unavailable", never a wrong map. The console route (B) survives format changes better
  than the parser route (C).
- **Two players' views.** Without map-sharing mods, each player's reveal is their own. If Global
  Positions is ever added, reveals converge and the per-player map becomes a shared one.

## 7. Suggested order for the implementation session

1. **Digest v0, offline, no infra.** A `scripts/digest-session.ts` run locally against a session id:
   download before/after, parse, print `recap.json`. Prove it on the ten real sessions.
2. **Backfill** those ten into `sessions/*/digest/` before the old versions expire (§1).
3. **Digest Lambda** on the manifest upload, plus `players.json` (Steam ↔ KU) from the logs.
4. **API + page:** recap card and "next time" note on the world page. Inventory view. Map tab with
   flat colours, the visited-dilated reveal, trail, containers. Caves tab.
5. **Test-world experiment for B** (§2.1), then the supervisor listener and fog dump.
6. Optional: poll samples, LLM prose, game textures, the event mod.

## 8. Confidence and open questions

- **Measured on our real save:**
  - every format in save-anatomy §1–5;
  - the trail decode and its orientation;
  - the 19/20 position check;
  - the structure / recipe / storage diffs of the 2026-09-27 session;
  - the Steam ↔ KU log line.
- **From the game's own scripts, not exercised:**
  - `IsTileSeeable` and the disconnect/migrate events as a capture point;
  - `GetTopologyIDAtPoint`;
  - `c_announce`;
  - `writeable` text in saves.
- **Open:**
  - the dump's run time (B);
  - the reveal radius (for A);
  - the prefix encoding (C);
  - whether `wasmoon`/`fengari` parse a 4 MB save within a small Lambda's memory and time (Lua 5.4
    locally parses it in well under a second).
