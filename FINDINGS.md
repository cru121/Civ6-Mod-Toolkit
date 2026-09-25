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
- `ModProperties` / `LocalizedText` — display name etc.; `ModRelationships` /
  `ComponentRelationships` — dependencies, already parsed by the game.

Behaviour verified in-game (2026-09-25): setting `Disabled=1` with the game
closed shows the mod as disabled in *Additional Content*, and the flag survives
a launch + exit. On launch the game rescans and adds newly installed mods
(enabled by default) — until then, a mod on disk has no row. **`ModRowId` can
change on rescan**, so always key by `ModId`. The `Migrations` table (run on
schema upgrades) copies `ModGroupItems` without `Disabled`, so a game patch that
bumps the schema would re-enable everything.

## Possible follow-ups

- Proper UTF-8/UTF-16 handling for non-Latin mod titles (cosmetic only today).
- One-click launcher (e.g. a `.cmd` / packaged app) so there's no terminal at all.
- Extend beyond mods to other config settings (needs more of the format mapped).
