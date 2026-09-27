# What other people run around DST servers, and which QoL mods are fair — research

Date: 2026-09-27. Question asked: *"research what other people are doing with custom servers. I'm
not super interested in overhaul mods. Though QoL mods I'll consider, if they don't make the game
easier."* Companion to `docs/research/map-inventory-recap.md` (our three feature ideas) and
`docs/research/save-anatomy.md` (the save, decoded).

Nothing was built or installed. **This file is secondary research**: star and subscriber counts come
from the GitHub and Steam `GetPublishedFileDetails` APIs, pulled on 2026-09-27 by a research agent.
The Klei forums returned HTTP 403 to every fetch, so anything sourced there is a search snippet and
is marked **[forum]**. Other markers: **[code]** source read, **[doc]** README or wiki,
**[inference]** reasoning. Read-only history, like everything in `docs/research/`.

## The short answer

- **Tooling.** The ecosystem is always-on web panels, mostly Chinese, plus small Discord relays.
  - The panels: dst-admin-go 918★, DMP 349★, dst-admin 598★. They do config editing, mod
    management, backups with restore, allowlists, a live console, and join/leave history.
  - **Nobody else runs scale-to-zero.** The nearest peer is a 2★ EC2 repo. This project's shape
    (on-demand EC2, self-stop, S3 saves) has no visible equivalent.
- **Our three ideas are genuinely new.** No public tool renders a *per-player* revealed map, or
  inventories, outside the game.
  - dst-admin-go and a few viewers render the *whole* map from the save's `tiles` field.
  - The closest thing to a recap is a chat-log analyzer gist.
- **"QoL but not easier" is mostly client-only mods.** Each player subscribes in their own Steam
  client, and the server never knows. This needs **no change to this project at all**.
  - The one server-side candidate worth discussing is Global Positions. It shares map discovery
    between the two of you, and it would change the per-player-map design.

## 1. What people build

### 1.1 Panels (the bulk)

| Project | ★ | What |
|---|---|---|
| [carrot-hu23/dst-admin-go](https://github.com/carrot-hu23/dst-admin-go) | 918 | Go binary + web UI: visual cluster/world config, mod management, backups with restore, lists, live log/console, update detection, player log collection, **whole-world PNG from the save's `tiles`** (`internal/service/dstMap/dst_map.go`) [code] |
| [miracleEverywhere/dst-management-platform-api](https://github.com/miracleEverywhere/dst-management-platform-api) (DMP) | 349 | Go + Vue: multi-room and multi-user, automatic backups, world/chat/runtime logs [doc] |
| [nchuhkstu/DST-view2](https://github.com/nchuhkstu/DST-view2) | 128 | Dashboard: map data, day and settings, online players, a **survival-days leaderboard**, chat history [doc] |
| [phil616/dst-server-icp](https://github.com/phil616/dst-server-icp) | 30 | Drives shards through **FIFO stdin** like ours. Downloads mods via SteamCMD, "bypassing the broken in-game downloader" [doc] |
| [sukeme/DstServerHelper](https://github.com/sukeme/DstServerHelper) | 37 | Watchdog: update polling, chat-log backup, restart on crash [doc] |
| LinuxGSM `dstserver`, Pterodactyl/Pelican eggs, Docker images ([Jamesits](https://github.com/Jamesits/docker-dst-server) 599★, [mathielo](https://github.com/mathielo/dst-dedicated-server) 340★) | | Install, update and backup plumbing |

**How the panels list players.** They inject a `print` loop over `AllPlayers` into the console and
grep `server_log.txt` for the result. That is the same pattern as our `DSTQ` count poll [code].

### 1.2 Discord and chat relays

These are small and fragmented (0–3★ each). Examples:
- [jaakkytt/dst-server-status-bot](https://github.com/jaakkytt/dst-server-status-bot) shows
  "Winter · Day 8/12 · 2 players" as the bot's presence, from `c_dumpseasons()` plus a log tail.
- [kharidiron/DSTcord](https://github.com/kharidiron/DSTcord) is a two-way chat bridge.

Workshop server mods that post to webhooks:
- Discord Death Announcements `2202942881`;
- Discord Announcements `2873805099`.

The first one's page now warns about Klei's 2025 mod-API changes, which followed a malicious,
self-spreading mod [forum].

### 1.3 Stats and recaps

- The [w1ndy chat-log analyzer](https://gist.github.com/w1ndy/ee18a9f73a277642806fe3c0d5d55dcd)
  parses joins, leaves, `[Say]`, deaths with cause, and resurrections. From those it derives session
  length, deaths by cause, and "most helpful" and "most bonded" pairs [code].
- [IamFlea/Deerclops-Lite-Logger](https://github.com/IamFlea/Deerclops-Lite-Logger) is a
  **server-only** mod that prints `[DFTA] {json}` events into `server_log` for an external bot. It
  is the pattern for the optional event mod in `map-inventory-recap.md` §3.5 [code].
- Other games:
  - Minecraft's [Plan](https://github.com/plan-player-analytics/Plan) (per-session analytics,
    calendar, heatmaps) and [Recap](https://modrinth.com/plugin/recapplugin) (replays a session's
    changes).
  - Valheim's log-tailing Discord notifiers.
  - The tabletop-RPG session recappers ([DM Scribe](https://dmscribe.com/),
    [Archivist](https://www.myarchivist.ai/dnd-session-recap)) are the closest match to "remember
    what we were doing". Their shared shape is a 3–5 bullet "previously on" plus an **open threads /
    next steps** list, with memory carried across sessions. That is the shape the recap design
    borrows [doc, inference].

## 2. QoL mods, classified

**Type:**
- **C**: client-only. Each player subscribes; nothing on the server.
- **A**: all clients require it. Installed on the server; clients auto-download it on join.
- **S**: server-only.

**Download path:**
- **UGC**: fetched through Steam UGC.
- **V1**: legacy `file_url` download.

This matters for ephemeral boots (§3).

**Verdict:**
- **INFO**: shows what you could count, see or look up yourself.
- **CONV**: fewer clicks, no new capability.
- **EASIER**: changes rules or economy, or removes a risk.

These verdicts are the research agent's, informed by how the community labels the mods.

| Mod | Workshop | Subs | Type | DL | Verdict |
|---|---|---|---|---|---|
| Combined Status | 376333686 | 10.3M | C | UGC | **INFO**: numbers on the meters, temperature, day/season clock, moon phase |
| Minimap HUD | 345692228 | 8.4M | C | UGC | **CONV**: corner minimap of what you have already explored |
| Geometric Placement | 351325790 | 7.5M | C | UGC | **CONV**: placement grid |
| Craft Pot | 727774324 | 5.4M | C | UGC | **INFO**: crock-pot recipe preview (wiki-equivalent) |
| Snapping tills | 2302837868 | 1.3M | C | UGC | **CONV**: farm-grid tilling |
| Status Announcements | 343753877 | 408k | C | UGC | **CONV/social**: alt-click to say "I'm starving" |
| ActionQueue Reborn | 1608191708 | 1.9M | C | V1 | **CONV**: box-select to repeat an action. Community calls it QoL, but it removes grind |
| Waypoint | 714735102 | 316k | C | UGC | **CONV**: named waypoints, stored per player per world |
| Global Positions | 378160973 | 8.5M | A | UGC | **INFO/CONV**: see each other on the map, pings, **shared map discovery**. Mildly easier: you never lose each other |
| Wormhole Marks | 362175979 | 3.5M | A | V1 | **INFO**: colour-pairs wormholes once used. Last updated 2016 |
| Show Me / Insight / health bars | 666155465 / 2189004162 / 1207269058 | 1.5–5.3M | A | UGC | **Grey zone**: container contents on hover, spoil timers, boss health, hound-wave timers. Many would call Insight easier |
| Increased Stack Size, Extra Equip Slots, Storeroom | 374550642 / 375850593 / 623749604 | | A | | **EASIER** (economy) |
| Don't Drop Everything, Restart (`#resurrect`), Quick Pick, No Thermal Stone Durability, Fast Travel, Auto Stack | | | S/A | | **EASIER** |
| Map Revealer | 363112314 | | S | V1 | **Cheat** |
| Global Pause | 758532836 | | A | V1 | Obsolete: vanilla has admin pause now |

**Suggested shortlist** [inference]:
- **Client-only, subscribe in Steam, done:** Combined Status, Geometric Placement, Minimap HUD,
  Snapping tills, Craft Pot, and Status Announcements if wanted. ActionQueue Reborn is fine if grind
  removal does not count as "easier" to you.
- **Server-side, if anything:** Global Positions, for map sharing between the two of you. It would
  make the per-player map (feature 1) a shared map. Decide that before building feature 1's
  spoiler model.
- **Avoid, for the stated goal:** the Show Me/Insight family and everything marked EASIER.

## 3. What server-side mods would cost this project

This only applies if a server mod is ever wanted. Client-only mods cost nothing.

- **Declaring and enabling.**
  - `<install>/mods/dedicated_server_mods_setup.lua` declares downloads with `ServerModSetup("<id>")`.
  - **Each shard's** `modoverrides.lua` enables them: `["workshop-<id>"] = { enabled = true }`.
  - Master and Caves both need the entry. The #1 support issue is a mod present in one file only
    [doc].
  - Our clusters currently ship empty `modoverrides.lua` files.
- **Downloads on an ephemeral box.**
  - UGC mods land per shard under `ugc_mods/`; `-ugc_directory` shares one copy.
  - `-only_update_server_mods` updates the mods and exits. It is the natural pre-step, and it lets
    a Workshop outage fail loudly instead of hanging a boot.
  - SteamCMD anonymous `workshop_download_item 322330 <id>` works for UGC mods. **V1 mods do not
    come through it**: DMP fetches them from `file_url` instead [code].
  - The built-in downloader has open reports of timeouts and partial downloads [forum].
  - Nobody else caches mods in object storage, because nobody else is ephemeral. The analogue here
    is the `binaries/` cache: tar the mods to S3, restore them before start, and let the version
    check run [inference].
- **Mid-session updates.** A Workshop update during a session makes new joiners mismatch until the
  server restarts. We restart every session, so the exposure is small [forum].
- **Saves remember mods.** Pure UI/info mods add no prefabs and are safe to drop. Mods that add
  prefabs leave entities in the save, and removing a mod whose item sits in an inventory can crash
  the load [forum]. Given "the save is precious", **trial any server mod on a `test-` world first**,
  and prefer `enabled = false` to deleting it.

## 4. The three ideas: prior art

| Idea | What exists | Gap |
|---|---|---|
| Per-player revealed map | Whole-map renderers (dst-admin-go, a forum-era exporter, hinamizawa.ai's browser viewer). Global Positions merges players' maps in game | Nothing renders *one player's* reveal. The data is server-side per player (`MapExplorer:RecordAllMaps()` in the player save; decoded in `save-anatomy.md` §3) |
| Inventory and storage outside the game | Dashboards list online players, character and age. In game only: Show Me/Insight hover | Nothing renders inventories or chests. Both are plain Lua in the save (`save-anatomy.md` §4) |
| Recap / journal / notes | Chat-log analyzers, DST-view2 chat history, the Waypoint mod (per-player named points), an abandoned 2017 "Notebook" mod (`892636139`, needs all clients) | Nothing summarises a session or carries "what we were doing" forward. A notes box on our own page is new and needs no mod |

## Sources

- **GitHub projects:** linked inline. Code read by the research agent:
  - `carrot-hu23/dst-admin-go`: `internal/service/dstMap/dst_map.go`, `player_service.go`
  - `miracleEverywhere/dst-management-platform-api`: `dst/mod.go`
  - `Cybrancee/Yolks`: `Games/dont_starve/entrypoint.sh`
  - `rezecib/Global-Positions`
  - `IamFlea/Deerclops-Lite-Logger`
- **Steam:** `ISteamRemoteStorage/GetPublishedFileDetails` and the Workshop most-subscribed list for
  app 322330.
- **Docs and issues:**
  - [dontstarve.wiki.gg dedicated server guide](https://dontstarve.wiki.gg/wiki/Guides/Don%E2%80%99t_Starve_Together_Dedicated_Servers)
  - [Jamesits/docker-dst-server#53](https://github.com/Jamesits/docker-dst-server/issues/53)
    (built-in downloader skipping V1 mods)
  - [Klei Player Creation Guidelines](https://support.klei.com/hc/en-us/articles/360029880791-Player-Creation-Guidelines)
    (free, non-commercial fan tools permitted)
- **Klei forum threads** (snippets only, 403 to fetches):
  - [Mod API thread 163519](https://forums.kleientertainment.com/forums/topic/163519-mod-api-discussion-thread/)
  - [World map viewer 61519](https://forums.kleientertainment.com/forums/topic/61519-tool-world-map-viewer-export-minimap-to-large-png/)
  - [map exploration storage 121418](https://forums.kleientertainment.com/forums/topic/121418-where-are-the-player%E2%80%99s-map-exploration-data-stored-in-dst/)
