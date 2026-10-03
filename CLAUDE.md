# Civ6 Mod Toolkit: instructions for AI agents

To **check, enable or disable Civ6 mods, don't read the source.** Use the CLI below. Each command prints JSON and
exits non-zero on error. Run from this folder (Node.js required; dependencies are already installed).

```
node src/mods-cli.js check                        # game running? active mod group, counts (`status` also works)
node src/mods-cli.js list                         # every mod: id, name, source, enabled
node src/mods-cli.js list --enabled|--disabled    # filter by state
node src/mods-cli.js list --search "city" --source workshop   # source: workshop | local | dlc
node src/mods-cli.js enable  "<name or id>" ["<name or id>" ...] [--dry-run]
node src/mods-cli.js disable "<name or id>" ["<name or id>" ...] [--dry-run]
```

## One grammar for all three tools

`mods-cli.js`, `saves-cli.js` and `config-cli.js` use the same verbs and flags: `list [--search]`, `check [<target>]`,
`add|remove <target> <mod>...` (saves and configs) and `--dry-run`, `--overwrite`, `--as <name>`. Mods in the game's own
list are *switched*, not added or removed (removing would mean uninstalling), so `mods-cli.js` has `enable`/`disable`
instead of `add`/`remove`. Every answer is JSON with `ok`; a mod is named by GUID, exact name or unique part of a name.

## Rules

- A mod can be given by its GUID, its exact name, or a unique part of its name (case-insensitive; Civ's
  `[COLOR_...]` markup is ignored). An ambiguous name fails and returns `candidates`. Retry with the `id`.
- **Preview first.** Run with `--dry-run` and check `changed` / `alreadyInState` before applying.
- **Civ6 must be closed.** Writes fail with an error while `CivilizationVI.exe` runs (`check` shows
  `gameRunning`). Don't try to work around it; ask the user to close the game.
- Only mods in the game's active mod group can be toggled. A mod that is installed but has `scanned: false`
  is not registered yet: with Civ6 closed, the web UI's dashboard button "Rescan & add new mods" (or its startup
  rescan) registers it, switched off. Ask the user to do that.
- Official DLC and expansions (`source: dlc`) are listed too. Don't toggle those unless the user explicitly asks.
- What gets changed is the `Disabled` flag in `Mods.sqlite` (the game's own mod list, in
  `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI`). Every write backs it up first to
  `Mods.sqlite.bak-YYYYMMDD-HHMMSS` (newest few are kept) and rolls back on failure. The change takes effect the next
  time the game starts.
- `list` and `enable`/`disable` show each mod's `requires` / `blocks` (with their current state), and
  `warnings` flags broken dependencies, e.g. disabling a mod that an enabled mod requires. Relay warnings to the user.
- `shipsGameCoreDll: true` marks a mod that contains a native `.dll` (a replacement GameCore). Such mods can conflict
  with each other and with game updates; `check` and `enable` warn when more than one is enabled.

## Mods inside saved games (`.Civ6Save`)

A save records the mods it was made with, and the game asks for them when loading. A save that won't load because of a
missing mod can be fixed by removing that mod from the save; a mod can also be added to a save. This is a different
thing from enabling/disabling mods above: it edits the save file, not `Mods.sqlite`. It works while Civ6 runs.

```
node src/saves-cli.js list [--search "text"]                  # saves, newest first (also the auto/ subfolder)
node src/saves-cli.js check  "<save>"                         # the save's mods, what can be added, warnings
node src/saves-cli.js add    "<save>" "<mod>" ["<mod>" ...] [--dry-run] [--overwrite] [--as "<new name>"]
node src/saves-cli.js remove "<save>" "<mod>" ["<mod>" ...] [--dry-run] [--overwrite] [--as "<new name>"]
```

- `<save>` is a file name (with or without `.Civ6Save`, e.g. `AutoSave_0388` or `auto/AutoSave_0008`), a unique part
  of one, or a full path. Only files inside the saves folder are accepted. Ambiguous input returns `candidates`.
- `<mod>` is a GUID, exact name or unique part of a name, like for `mods-cli.js`. For `remove` it is matched among the
  mods in the save; for `add` among installed mods that are not in the save (`check` lists them as `addable`).
- **Start with `check`**, then `--dry-run`. By default the edit is written to a **new copy** next to the original
  (`<name> (edited).Civ6Save`, or `--as`); the original is untouched. `--overwrite` replaces it after making a
  timestamped `.bak-` backup. Prefer the default and let the user decide about overwriting.
- Each mod has a `kind`: `official` (DLC/expansion: can't be removed), `ui` (`AffectsSavedGames=0`: safe to add or
  remove), `gameplay` (changes game content, so the save may depend on it), `unknown` (not installed). Adding or
  removing `gameplay`/`unknown` mods is allowed but experimental: the result may fail to load. Relay `warnings`.
- `check` warns about mods the save needs that aren't installed, which is the usual reason a save won't load.
- The tool edits only the mod list in the file header and verifies the result before writing; the game data is untouched.

## Mods inside game configurations (`.Civ6Cfg`)

A `.Civ6Cfg` is the game setup a save is started from (it lists the mods). Same safety model as saves; it works while
Civ6 runs.

```
node src/config-cli.js list [--search "text"]
node src/config-cli.js check  "<config>"                      # mods in it, what can be added, warnings
node src/config-cli.js add    "<config>" "<mod>" [...] [--dry-run] [--overwrite] [--as "<new name>"]
node src/config-cli.js remove "<config>" "<mod>" [...] [--dry-run] [--overwrite] [--as "<new name>"]
```

- `<config>` is a file name (with or without `.Civ6Cfg`), a unique part of one, or a full path. By default the edit goes
  to a **new copy** (`<name> (edited).Civ6Cfg`, or `--as`); `--overwrite` replaces the original after a backup.
- Adding a mod the game hasn't scanned yet can make the game reject the configuration; `warnings` says so.

## Typical task

"Disable all UI mods that make the report screen slow" translates to: `list --enabled`, pick the matching mods,
`disable ... --dry-run`, show the user the list, then run again without `--dry-run`.

"This save won't load, a mod is missing" translates to: `saves-cli.js check "<save>"`, find the `unknown` mods in
`warnings`, `remove "<save>" "<mod>" --dry-run`, show the user, then run without `--dry-run` and tell them the name
of the new file.

## Other things in this repo (only if the user asks)

- Browser UI with a mod manager, `.Civ6Cfg` editor and save editor: `npm start` (http://127.0.0.1:8673).
- Folder paths are auto-detected; overrides go in `civ6-paths.json` (see `civ6-paths.example.json`).
