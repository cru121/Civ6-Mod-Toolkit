# Civ6 Mod Toolkit: instructions for AI agents

To **check, enable or disable Civ6 mods, don't read the source.** Use the CLI below. Each command prints JSON and
exits non-zero on error. Run from this folder (Node.js required; dependencies are already installed).

```
node src/mods-cli.js status                       # game running? active mod group, counts
node src/mods-cli.js list                         # every mod: id, name, source, enabled
node src/mods-cli.js list --enabled|--disabled    # filter by state
node src/mods-cli.js list --search "city" --source workshop   # source: workshop | local | dlc
node src/mods-cli.js enable  "<name or id>" ["<name or id>" ...] [--dry-run]
node src/mods-cli.js disable "<name or id>" ["<name or id>" ...] [--dry-run]
```

## Rules

- A mod can be given by its GUID, its exact name, or a unique part of its name (case-insensitive; Civ's
  `[COLOR_...]` markup is ignored). An ambiguous name fails and returns `candidates`. Retry with the `id`.
- **Preview first.** Run with `--dry-run` and check `changed` / `alreadyInState` before applying.
- **Civ6 must be closed.** Writes fail with an error while `CivilizationVI.exe` runs (`status` shows
  `gameRunning`). Don't try to work around it; ask the user to close the game.
- Only mods in the game's active mod group can be toggled. A mod that is installed but has `scanned: false`
  needs the game started once so it scans the mod.
- Official DLC and expansions (`source: dlc`) are listed too. Don't toggle those unless the user explicitly asks.
- What gets changed is the `Disabled` flag in `Mods.sqlite` (the game's own mod list, in
  `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI`). Every write backs it up first to
  `Mods.sqlite.bak-YYYYMMDD-HHMMSS` (newest few are kept) and rolls back on failure. The change takes effect the next
  time the game starts.
- `list` and `enable`/`disable` show each mod's `requires` / `blocks` (with their current state), and
  `warnings` flags broken dependencies, e.g. disabling a mod that an enabled mod requires. Relay warnings to the user.
- `shipsGameCoreDll: true` marks a mod that contains a native `.dll` (a replacement GameCore). Such mods can conflict
  with each other and with game updates; `status` and `enable` warn when more than one is enabled.

## Typical task

"Disable all UI mods that make the report screen slow" translates to: `list --enabled`, pick the matching mods,
`disable ... --dry-run`, show the user the list, then run again without `--dry-run`.

## Other things in this repo (only if the user asks)

- Browser UI with a mod manager, `.Civ6Cfg` editor and save editor: `npm start` (http://127.0.0.1:8673).
- `.Civ6Cfg` game-configuration editing from the command line: `node src/edit-config.js --help`-style flags
  (`--config <file> --add/--remove <mod> [--dry-run]`).
- Folder paths are auto-detected; overrides go in `civ6-paths.json` (see `civ6-paths.example.json`).
