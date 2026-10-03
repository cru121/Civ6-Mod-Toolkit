# Civ6 `.Civ6Cfg` format — Phase 0 findings

Goal: add/remove mods in an existing `.Civ6Cfg` (game setup) file without
recreating all the customized settings by hand.

## File format

- `.Civ6Cfg` uses the same typed-marker binary format as a `.Civ6Save` **header**
  (magic `CIV6`), but has **no trailing compressed game-state blob**. Everything is
  plain typed records, so there is no zlib/64KB-chunk decompression to deal with.
- Records are `marker(4) type(4) payload`. Types: 1=bool, 2=int, 5=ascii-string,
  6=utf16-string, 0x0A/0x0B=arrays.

## Where the mod list lives

- Mods are stored in **two parallel `0x0B` arrays**, marked `MOD_BLOCK_4`
  (`bb 5e 30 88`) and `MOD_BLOCK_2` (`c8 d1 8c 1b`). Both hold the same mod list.
- Each block: `marker(4) 0B(4) + 8 filler + count(uint32 LE) + N elements`.
  Each element starts with `0x0A`, then holds a `MOD_ID` (`54 5f c4 04`, the GUID
  string) and a `MOD_TITLE` (`72 e1 34 30`, localized-name JSON), ending in a
  terminator entry whose value is the string `"1"`.
- GUIDs appear uppercase (official DLC), lowercase (workshop/local mods) and
  brace-wrapped `{...}`. Matching is case-insensitive.

## Why pydt/civ6-save-parser can't be used directly on configs

pydt's low-level byte readers are correct and are reused here (MIT), but its
top-level `parse()` / `addMod()` / `deleteMod()` are save-only: they anchor on a
`GAME_SPEED` marker (absent in configs) and break on the first `END_UNCOMPRESSED`
byte pattern (which occurs ~52 times in a config). So this project provides its
own config-aware navigation in `src/civ6cfg.js`.

## Editing model (safe by construction)

Edits are **pure buffer splices** limited to the mod-block regions: to add a mod
we clone the last element, swap its `MOD_ID`/`MOD_TITLE`, append it, and bump the
count; to remove one we drop its element and decrement the count. Every byte
outside the edited blocks is preserved verbatim.

## Phase 0 result (all 5 fixtures)

- Block scan: `count` field matches actual element count in every block.
- Mod extraction: 45–46 mods listed correctly (DLC + user's workshop/local mods).
- Round-trip: `addMod` re-parses with count+1 in every block, and
  `addMod` → `removeMod` returns a **byte-identical** file.

Run: `npm run phase0`

## Phase 1 — mod inventory + diff (done)

- `src/paths.js` auto-detects mod sources on Windows and lets the user override
  any of them:
  - **local/custom mods**: `<Documents or OneDrive\Documents>\My Games\Sid Meier's
    Civilization VI\Mods` (handles the OneDrive-redirected Documents case).
  - **Steam Workshop** (app id `289070`): resolved from the `HKCU\Software\Valve\
    Steam\SteamPath` registry value plus `libraryfolders.vdf` (multiple library
    drives supported), de-duped case-insensitively.
  - Overrides: `civ6-paths.json` in the project root (see
    `civ6-paths.example.json`) or env vars `CIV6_LOCAL_MODS` / `CIV6_WORKSHOP` /
    `CIV6_SAVES`. The eventual UI will edit these.
- `src/modinfo.js` scans each source for `.modinfo` (XML), reading the `<Mod id>`
  GUID and `<Properties><Name>`. When `Name` is a raw `LOC_*` key it falls back
  to the (readable) `.modinfo` filename. GUIDs are normalized (lowercase, braces
  stripped) so config vs `.modinfo` match.
- `src/inventory.js` diffs a config against the installed inventory into:
  enabled+installed (removable), enabled-but-not-installed (official DLC or
  uninstalled), and **installed-but-not-enabled (candidates to add)**.

Run: `npm run phase1 -- "path\to\file.Civ6Cfg"` (defaults to a bundled fixture).

Note: config `MOD_TITLE` stores a resolved localized JSON title; the same mod can
show a different (stale) version string there than the installed `.modinfo`, but
GUID matching still identifies it correctly (e.g. Got Lakes v37.0 vs v37.2).

## Phase 2 — safe add/remove + save (done)

- `src/editor.js` applies edits and saves with guardrails:
  - re-parses the edited buffer and asserts adds present / removes absent in
    **every** mod block, block counts stay consistent, and `CIV6` magic intact;
  - for add-only edits, asserts the change is byte-reversible (proves nothing
    outside the mod blocks moved);
  - copies the original to a timestamped `.bak-YYYYMMDD-HHMMSS` before replacing;
  - writes atomically (temp file + rename); supports `outPath` (non-destructive
    save to a new file) and `dryRun`.
- Title style: Civ stores a user mod as `{"<display name>":[]}` (literal name as
  JSON key, empty array; DLC uses a `LOC_*` key). We mirror the user-mod form.
  Note: titles are ASCII-encoded (pydt writer), so non-latin names degrade to
  `?` in the *display* title only — the mod still loads because the game keys off
  `MOD_ID`.
- `src/edit-config.js` is the CLI the Phase 3 UI will call:
  `npm run edit -- --config "x.Civ6Cfg" --add "Terra Mirabilis" --remove "..." [--out "y.Civ6Cfg"] [--dry-run] [--no-backup]`.

`npm run phase2` runs the automated proof (operates only on scratch copies).

## Phase 3 — local server + browser UI (done)

- `src/server.js`: dependency-free Node HTTP server bound to `127.0.0.1:8673`.
  API: `GET /api/state` (paths + config list + installed inventory),
  `GET /api/config?path=` (enabled + available-to-add view), `POST /api/save`
  (apply edits; `mode: overwrite|new`), `POST /api/paths` (persist overrides).
  `npm start` launches it and opens the browser.
- `public/` (index.html / style.css / app.js): two-column UI — enabled mods
  (uncheck installed ones to remove; DLC/missing shown read-only) and
  installed-but-not-enabled (check to add), with a filter, editable folder paths,
  and Save-overwrite / Save-as-new actions. Light/dark aware, no build step.
- Verified end to end against the live game folders: state/config/save endpoints
  work, a `mode:new` save produced a valid 46-mod file with the added mod in both
  blocks. The user confirmed an edited config loads in-game.

Status: v1 (add/remove mods) complete. See `README.md` to run.

## Mod database (`Mods.sqlite`) — which mods are enabled

The game records enabled/disabled state in a SQLite database, **not** in
Documents: `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI\Mods.sqlite`
(a Civ VII install has its own `Mods.sqlite` in a sibling folder). Observed
schema `user_version` 24:

- `ModGroups(ModGroupRowId, Name, CanDelete, Selected, SortIndex)` — the
  in-game mod groups; `Selected=1` is the active one. The built-in group is
  `LOC_MODS_GROUP_DEFAULT_NAME` (`CanDelete=0`).
- `ModGroupItems(ModGroupRowId, ModRowId, Disabled)` — **the enable flag**:
  `Disabled=1` means the mod is off in that group.
- `Mods(ModRowId, ScannedFileRowId, ModId, Version)` + `ScannedFiles(Path)` —
  user mods have absolute paths; DLC / base content is relative
  (`../../../DLC/...`, `../../../Base/...`).
- `ModProperties` / `LocalizedText` — display name etc. DLC titles are often
  missing from the DLC's own `LocalizedText` rows (the text lives in game
  files); the same tag under another mod, or the `OtherModTitle` other mods use
  when referencing it, usually resolves it.
- `ModRelationships(ModRowId, OtherModId, Relationship, OtherModTitle)` —
  `Dependency` (needs), `Block` (incompatible), `Reference` / `ReverseReference`
  (load-order hints). The mod manager warns on the first two.
  `ComponentRelationships` holds per-component `Include` / `Required`.

Observed on a real database (2026-09-27), `user_version 24`:

- `ModGroups` is `INTEGER PRIMARY KEY AUTOINCREMENT`; every user-created group
  has `CanDelete=1, Selected=0, SortIndex=100` (only the built-in group differs:
  `CanDelete=0, SortIndex=0`), so new groups are created the same way.
- `ModGroupItems` is keyed `(ModGroupRowId, ModRowId)` with
  `ON DELETE CASCADE` to both parents, and there is no unique `Selected` — more
  than one group could be marked selected, so writes clear the flag first and
  then check that exactly one group is left selected.
- Groups are **not** full mod lists: real ones held between 1 and 422 rows
  (422 mods installed). A group only carries the mods that were ever touched in
  it, and a mod with no row reads as "not in this group" rather than off. A new
  group is therefore created with a row per mod, all disabled, so it can be
  toggled straight away; a group with no rows would be untoggleable.
- The database has no "last used profile" column, so the toolkit remembers the
  recently used groups in the browser's `localStorage` and falls back to the
  built-in group, then the oldest one, when the profile in use is deleted.

Behaviour verified in-game (2026-09-25): setting `Disabled=1` with the game
closed shows the mod as disabled in *Additional Content*, and the flag survives
a launch + exit. On launch the game rescans and adds newly installed mods
(enabled by default) — until then, a mod on disk has no row. **`ModRowId` can
change on rescan**, so always key by `ModId`. The `Migrations` table (run on
schema upgrades) copies `ModGroupItems` without `Disabled`, so a game patch that
bumps the schema would re-enable everything.

## Registering a mod without launching the game (done)

A mod on disk has no database row until the game scans it, which is why the mod
manager says *not scanned yet* and refuses to switch it on. The game can be
skipped: writing the same rows the game would makes it adopt the mod, scan it,
and fill in the rest. Verified on a real database (2026-09-27) with a subscribed
Workshop mod that had never been scanned.

What the game writes, and how to reproduce it exactly:

- `ScannedFiles.Path` — absolute, **forward slashes even on Windows**, pointing
  at the `.modinfo` file itself (not its folder).
- `ScannedFiles.LastWriteTime` — a **Windows FILETIME**: 100-nanosecond ticks
  since 1601-01-01, equal to the `.modinfo`'s mtime. Verified to match the file
  mtime exactly for every row checked. It is far larger than a JavaScript number
  can hold, so it must be read back as TEXT/BigInt, never as a number.
- `Mods.Version` — the `version=` attribute of the `<Mod>` tag (matched for
  every mod checked), not a schema or library version.
- `ModProperties` — `Name`, `Description`, `Teaser`, `Authors` and
  `CompatibleVersions` are copied straight out of the `.modinfo`. `Name` matters:
  without it the mod manager lists the mod by its raw GUID.

Two behaviours that are easy to get wrong, both found the hard way:

1. **A newly discovered mod is registered in the built-in group**
   (`CanDelete=0`, `LOC_MODS_GROUP_DEFAULT_NAME`), never in the group in use.
   Every one of the 423 mods in a real database has a row there. When the game
   adopts a mod it *rebuilds that mod's group membership from scratch*, so a row
   written into another group is silently deleted on the next launch — which is
   exactly what happened on the first attempt: the mod was registered, enabled,
   and then wiped from the profile by the game on its next run.
2. **Registration is not two-phase any more.** An earlier version wrote only the
   three rows the game needs to *notice* a mod and left the rest to the game,
   which added 127 `ModFiles`, 6 `Components` and 5 `Settings` of its own on the
   next launch. A profile toggle written before that launch was then lost, and
   this file said so. The complete registration below removes the need for the
   game's pass entirely, so **the two-phase caveat no longer applies** and a
   profile toggle written at registration time is permanent. What survives from
   the old behaviour: a newly discovered mod lands in the built-in group, so the
   registration must write the built-in row itself rather than only the profile.

### The complete registration, and the two details that make it stick

Everything the game records about a mod comes out of the `.modinfo`, so the
game's own scan is not needed at all. Rules established by comparing 380 real
mods against the game's rows, then confirmed by replaying a registration and
diffing it against the output the game had actually produced — an exact match
on all eleven tables.

| Table | Derived from |
|---|---|
| `ModFiles` | `<Files>/<File>`, in order. **Not** a folder listing: 69 of 380 mods have files on disk that the game does not record, and none matched a walk instead. |
| `Components` | one per action element in `<InGameActions>`, document order. Actions may carry `criteria="..."` and some carry no `id` at all. |
| `ComponentProperties` | that action's own `<Properties>` children (`LoadOrder`, `LuaContext`, `LuaReplace`) |
| `ComponentFiles` | the action's `<File>` children only, `Priority=0`. An action with no `<File>` gets none, even when it names a Lua file to replace. |
| `Settings` / `SettingFiles` | the same, from `<FrontEndActions>` |
| `Criteria` / `Criterion` / `CriterionProperties` | `<ActionCriteria>/<Criteria id>`, one `Criterion` per condition element, its text stored as a `Value` property |
| `ModRelationships` | `<Dependencies>/<Mod id title/>` — **self-closing** elements, so a regex expecting a closing tag silently misses them |
| `ModProperties` | every child of the mod's own `<Properties>`, not a fixed list of known names (`Created`, `AffectsSavedGames`, `SubscriptionID`… are real) |

Two details decide whether the game treats the mod as already scanned, and both
cost a launch to discover:

- **`ScannedFiles.LastWriteTime` must carry the full mtime precision.** The
  value is 100-nanosecond ticks, but JavaScript only exposes milliseconds, and
  a millisecond-rounded value differs from the real one by a few hundred ticks
  (2089 for one mod). The game reads that as a changed file, rescans, and
  *rebuilds the mod's profile membership* — silently undoing a profile toggle
  written beforehand. This, not the game policing us, is what caused that reset.
  Node's `statSync(file, { bigint: true }).mtimeNs` gives the exact value.
- **The path must be the canonical on-disk casing.** A Steam library path read
  from the registry can be all lower case (`d:\steam\…`); the game records
  `D:\Steam\…`. `fs.realpathSync.native` normalises it.

A file referenced by an action but absent from `<Files>` is skipped by both the
game and the toolkit (verified: the game created no `ModFiles` row for it), so a
broken reference in a mod stays broken rather than becoming a dangling link.

Verified end to end (2026-09-27): a newly subscribed mod registered by the
toolkit was launched in Civ6 once, and the game added **no rows at all** to any
table and left the profile toggle in place. The flow is now: subscribe →
register → launch and play, already enabled.

## Mod manager (done)

`POST /api/mods/apply` refuses while the game runs (process check), backs up
`Mods.sqlite` (keeps the newest 10 `.bak-YYYYMMDD-HHMMSS`), updates
`ModGroupItems.Disabled` for the active group in one `BEGIN IMMEDIATE`
transaction keyed by `ModId`, runs `PRAGMA quick_check`, reads the flags back,
and restores the backup if anything fails after the commit. Mods on disk that
the game hasn't scanned, and DB mods with no row in the active group (e.g.
unowned DLC), are shown but can't be toggled.

## Mod groups (profiles) — done

`GET /api/modgroups` lists the profiles with their enabled/total counts;
`POST /api/modgroups/{create,duplicate,rename,delete,activate}` changes them, and
`GET /api/modgroups/export` / `POST /api/modgroups/import` move one as a `.json`
file. Everything goes through the same `mutateDb()` path as `applyChanges`:
backup, one `BEGIN IMMEDIATE` transaction, `PRAGMA quick_check`, read-back, and
the backup restored if anything fails after the commit. All writes are refused
with 409 while Civ6 runs.

Export files hold `{toolkit, version, name, exportedAt, mods:[{modId, enabled}]}`
— `ModId`, never `ModRowId`, which changes on every rescan. Import always
creates a new group (name suffixed ` (2)`, ` (3)`… when taken) and reports mods
this installation doesn't know rather than failing.

`npm run phase4` proves the operations against a throwaway database and, when
given a path, against a copy of a real `Mods.sqlite`.

## Verification — what has to pass before a release

**`npm run check:release` is the gate.** It runs `phase4`, `phase5` and `phase6`,
and `.github/workflows/release.yml` runs that script and nothing else decides
whether a release happens. Those three are in the gate because each seeds its own
throwaway data — a temp SQLite database, a temp label store, pure functions — and
so can run on any machine, including a clean CI one.

| Suite | Covers | In the gate |
|---|---|---|
| `phase0` | round-trips a real `.Civ6Cfg` | **no** — needs a fixture you supply |
| `phase1` | scan a Saves folder, diff it | **no** — needs a fixture you supply |
| `phase2` | add/remove/save a config | **no** — needs a fixture you supply |
| `phase4` | profiles, registration, removal, native paths | yes |
| `phase5` | the label store, including a rescan that renumbers `ModRowId` | yes |
| `phase6` | the six sort orderings, and the page's wiring to them | yes |

`phase0`, `phase1` and `phase2` need a real `.Civ6Cfg` in `fixtures/`, which is
git-ignored because a real config names your game and session. They are
deliberately kept out: a suite that fails on every machine, CI included, makes a
gate permanently red, and a permanently red gate is one people learn to read
past. `phase0` now says so and exits non-zero rather than reporting a pass it
did not earn.

**A new area adds a suite, and the suite joins the gate.** The list is in
`package.json` as `check:release`, so adding a suite and adding it to the gate
are the same edit and `release.yml` cannot drift out of step.

**Running the checks without publishing.** Dispatch `release.yml` with
`mode=verify` and leave the tag empty to check whatever branch you are on. Every
check runs, the job still goes red on a failure, and the zip and the release are
skipped. This is the only workflow in the repo, and it otherwise speaks up only
when a tag is pushed — which is how a defect that broke `phase4` went unnoticed
on `main` and was only found by trying to release v1.5.0. An always-on `ci.yml`
on every push was considered and declined, on the grounds that this is a
single-developer project with no PR flow.

**A suite that fails on the CI runner is a finding, not an obstacle.** Repair the
suite. Do not drop it from the gate and do not add `continue-on-error` — that
converts a finding into a silence, and the point of a gate is that the finding
arrives before the release rather than after it. Note that CI pins Node 22 while
a local checkout is likely on 24; the suites use `node:sqlite`, so a difference
between the two is a real possibility rather than a hypothetical one.

## Possible follow-ups

- Delete local mods / "open Steam page to unsubscribe" for Workshop mods.
- Sync a profile with a `.Civ6Cfg`'s mod list (the other direction of this).

- Proper UTF-8/UTF-16 handling for non-Latin mod titles (cosmetic only today).
- One-click launcher (e.g. a `.cmd` / packaged app) so there's no terminal at all.
- Extend beyond mods to other config settings (needs more of the format mapped).
- Backup names only have second resolution, so two writes in the same second
  share a file name and the second overwrites the first.
