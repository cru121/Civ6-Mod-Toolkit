# Changelog

All notable changes to this project are recorded here.

## v2.0.0 — unreleased

A combined release. It merges the mod manager work from
[Klear2012's fork](https://github.com/Klear2012/Civ6-Mod-Toolkit) (which went through
its own v1.1.0 to v1.9.1 between 27 September and 3 October 2026) with the v1.1.0 and
v1.2.0 work in this repository (Save editor, command-line tools, config editor
warning). The two lines used the same version numbers for different things, so the
fork's numbers are not used here and the combined release gets a new one. The MIT
licence and the original copyright are unchanged.

### Added — mod manager (from the fork)

- **Profiles** (Civ6's *mod groups*): create, duplicate, rename, delete and switch
  between them, and export or import a profile as `.json`. Deleting the profile in
  use switches to the one you had before.
- **The toolkit adds new mods itself.** At startup, and on the dashboard's **Rescan
  & add new mods**, anything on disk the game has never scanned is registered in
  the game's mod database, and anything the game knows but that has no row in the
  profile in use gets one. **Nothing is ever switched on**: added mods come up off,
  with a row in every profile. No game launch is needed, and it is skipped while
  Civ6 runs.
- **Mod folder and Workshop links**: a folder button opens a mod's folder in
  Explorer, and the `workshop` label opens its Workshop page.
- **Remove mod** in a mod's details panel takes it out of the game and every
  profile and deletes its folder. The dialog names the folder first. The dashboard
  lists mods the game records that are no longer on disk, but never removes them
  automatically. Removing does not unsubscribe from Steam.
- **Labels**: your own labels on mods (*favourite*, *needs-testing*, …), a
  multi-select label filter (any of the ticked labels), and rename, merge and
  delete across every mod. Stored in `mod-labels.json`, keyed by the mod's GUID so
  labels survive the game renumbering rows. This is the one write that is not
  refused while Civ6 runs and has no backup, because it is not the game's file.
- **Sorting** the mod list by Name, State, Source, Label, **Needs attention**
  (missing dependency or active conflict first) and Last changed. The choice is
  remembered.
- **Load order** page: one profile's load order as a single list, with gaps shown
  as rows, ties shown as ties, actions with no position grouped by mod, and each
  row saying what it is gated on. `ModInUse` is decided by measurement in the game.
  Compare two profiles, filter by mod or action type, and see the files an action
  contributes.
- **Load order overrides**: a block-move editor for individual actions' load order,
  written in one transaction with one backup and refused while Civ6 runs. An
  override survives its mod updating and is re-applied at startup; **Re-apply all**
  covers a server left running across a Steam sync. Per-profile load order is not
  possible, because the game's schema holds one value per action.
- **Conflicts** page (read-only): a **DB collision replay** runs your mods'
  database writes in load order against a disposable copy and names the winning
  and losing file per contested row; a **UI file-shadowing** pass lists every
  interface file claimed by more than one mod; and a **Database.log differential**
  shows where the replay and the game agree. Game errors are attributed to the mod
  that caused them (each row says how it knows), grouped mod-first. The game
  database is never written, and reports run only when you click.
- **Game-setup toggles** for rulesets, modes and settings. Verdicts that rely on a
  setup you assumed are labelled as assumed, and a banner lets you review or
  withdraw it.
- **Packaging checks** scoped to the active profile: unregistered files, schema
  mismatches, duplicate mod ids and XML problems.
- The dashboard's folder setup lists the game's **Logs** and **Cache** folders. A
  malformed `civ6-paths.json` is now reported instead of silently ignored, and
  `CIV6_PATHS_FILE` is honoured when writing it.
- A release workflow builds the Windows zip on a version tag, and
  `npm run check:release` runs the fork's ten test suites (about 1,250 checks).

### Changed

- **The command-line tools share one grammar.** `mods-cli.js`, `saves-cli.js` and
  the new `config-cli.js` use the same verbs and flags: `list [--search]`,
  `check [<target>]`, `add|remove <target> <mod>...`, `--dry-run`, `--overwrite`
  and `--as <name>`. `mods-cli.js` keeps `enable`/`disable` for the game's own mod
  list, since removing a mod there would mean uninstalling it. `status` still works
  as an alias for `check`. Shared code is in `src/cli-common.js`.
- **`config-cli.js` replaces `edit-config.js`** (this is a breaking change for
  scripts). It takes `add`/`remove` subcommands instead of `--add`/`--remove`
  flags, prints JSON, and **writes a new copy by default**
  (`<name> (edited).Civ6Cfg`, or `--as`). `--overwrite` replaces the original after
  a backup. `--config`, `--out` and `--no-backup` are gone, and `npm run edit` is
  now `npm run config`.
- Save editor now comes before Mod manager in the top menu, so Load order and
  Conflicts sit next to the mod manager.
- The mod list shown by the web server and `mods-cli.js` is now the same code
  (`src/modlist.js`) and carries labels, sort names and sync flags.
- Mod names display the way the mod manager shows them everywhere, including
  Civ colour markup and localisation tags.
- The version in `package.json` is `2.0.0-dev`; the repository and author fields
  credit cru121 with contributions by Klear2012.

### Fixed (from the fork)

- A mod registered by the toolkit used to lose its conditions, so its actions ran
  whether or not the mod they depend on was present. Inverted conditions and
  `Criteria.Any` were also read wrongly.
- `<File>` elements with attributes were dropped on registration, losing 53 files
  across 30 mods.
- The folder button opened Documents instead of the mod's folder, and then opened
  no visible window at all.
- Registering a mod no longer switches it on in a profile you did not ask for, and
  a sync with nothing to do no longer spends one of the ten kept backups.
- Names containing XML entities rendered as literal `&amp;amp;`.

### Notes

- Everything above that writes `Mods.sqlite` backs it up first, rolls back on
  failure, and is refused while Civ6 runs. The Conflicts page and the label store
  are the exceptions described above.
- The fork's own history is kept in the git log. Its detailed per-release notes
  (v1.1.0 to v1.9.1) described version numbers that were never released from this
  repository, so they are summarised here instead.
- **Not yet tested by hand:** the merged interface has been run against real data
  only through the automated suites and a short look at the menu.

## v1.2.0 — 3 October 2026

### Added

- **Save editor can add mods to a saved game**, as well as remove them. Adding or
  removing a mod that changes gameplay is experimental and may stop the save from
  loading.
- **Command-line tools for scripts and AI assistants**: `mods-cli.js`
  (`status`, `list`, `enable`, `disable`) and `saves-cli.js` (`list`, `check`,
  `add`, `remove`). Output is JSON, writes honour the same safety rules as the web
  UI, and `CLAUDE.md` explains the commands so an assistant needn't read the code.

### Changed

- The config editor warns when you add a mod the game has not scanned yet, since a
  configuration listing a mod the game does not know can be rejected.

## v1.1.0 — 1 October 2026

### Added

- **Save editor** *(experimental)*: remove mods from a `.Civ6Save`, for example so a
  save no longer asks for a missing mod. Writes a new copy by default.

### Changed

- Website and version bump.

## v1.0.0 and earlier

By **cru121**. Dashboard, config editor, mod manager, and the Windows launcher.
