# Changelog

All notable changes to this project are recorded here.

This project is a fork of [cru121/Civ6-Mod-Toolkit](https://github.com/cru121/Civ6-Mod-Toolkit),
which was last updated on 25 September 2026. Everything from **v1.1.0** onward is
new in this fork; **v1.0.0** and earlier are upstream's work, under the same MIT
licence and with the original copyright left intact.

Versions are tagged, and each tag produces a Windows zip on the
[releases page](https://github.com/Klear2012/Civ6-Mod-Toolkit/releases/latest).

## v1.9.1 — 3 October 2026

### Fixed and added

- The Conflicts differential is grouped by responsible mod with per-mod counts,
  repeated same-failure files collapsed into one finding, attributed groups
  first, exact-match mod search, and a toggle hiding unnamed findings.
- Game-log error attribution (workshop mapping, Modding.log bracketing,
  calibration divergences) plus assumed-setup verdicts in view and replay.
- Dashboard folder setup lists the game Logs and Cache folders.
- Packaging checks scope to the active profile, silence asset noise and DLC
  content, and window large result lists.
- Game-setup round toggles for rulesets, modes, and settings with assumed
  verdict labeling (multi-value criteria split into singles, OR semantics).

## v1.9.0 — 2 October 2026

### Added

- **Game errors name their mod.** The Conflicts differential joins each
  `Database.log` error with its same-timestamp context (statement, row values,
  workshop file path), falls back to file-hint matching, and brackets the rest
  against `Modding.log`'s load timeline — every row says how it knows
  (*traced to this mod*, *matched by file name*, *best guess*, *found by
  replay*), approximate rows say so, and calibration lists game-observed vs
  assumed load-order divergences.
- **The differential reads mod-first**: per-mod groups with counts, repeated
  same-failure files collapsed into one finding, attributed before
  unattributed, exact-match mod search, and a toggle hiding unnamed findings.
  Gated-out rows name mods instead of ids.
- The Dashboard folder setup lists the **game Logs** and **game Cache**
  folders with the same detect/edit/override plumbing as every other path.
- Conflict warnings stay silent on base-game and DLC content, and shadowing
  claimant names resolve like every other screen.

## v1.8.0 — 1 October 2026

### Added

- **Conflict diagnosis** on a new **Conflicts** page, read-only throughout. A
  **DB collision replay** runs your mods' database writes in load order against
  a disposable copy and names the winning and losing file per contested
  row and column; a **UI file-shadowing** pass lists every interface file
  claimed by more than one mod with its winner or an honest *undefined*; and a
  **Database.log differential** shows where the replay and the game agree and
  where each saw what the other missed. The game database is never written and
  the reports run only when you click.
- The replay finds the game's `Cache` folder and `Database.log` on both sides
  of its two homes (Documents and Local AppData), with folder overrides still
  winning when set.
- The block editor's before-anchor sits snug below the anchor instead of
  jumping to the far end of a wide gap; spill-above is gone (headroom targeting
  covers it); overrides entries show their files; whole-mod reset-all and
  discard-all arrive on the ledger.
- The load order view filters by exact mod name or by action-type dropdown,
  condition lines render mod names instead of raw tags, and bands are divided
  by rules while expanded editor blocks read as one group.

## v1.7.0 — 1 October 2026

### Added

- **A **Load order** tab**, showing one profile's load order as a single list:
  every action of every mod that profile has on, in the order the game will use
  them, with the gaps between values as rows of their own. Load order is declared
  per *action* rather than per mod, so the question it answers — where does mine
  sit — is answered by its neighbours. A gap between two actions you can see is a
  gap you could put something in.
- **The gaps are computed inside the profile**, not across the whole 1–1000 band.
  A profile whose highest action is 50000000 does not care that 701–898 is free.
- **Ties are shown as ties.** Where several actions claim one value the game picks
  arbitrarily, and so does this, rather than listing them in an order that
  implies a ranking which does not exist.
- **Actions that declare no position get their own block**, grouped by mod. In a
  real library that is several hundred actions whose order is decided by nothing
  anyone controls, and a mod with a long list there is relying on undocumented
  ordering.
- **Rows say what an action is gated on** — `needs Civilizations Diversity`,
  `not in this profile`, `needs a game ruleset` — and are marked as not running
  only where that can be proven. Where it cannot, the row says the toolkit could
  not decide rather than guessing. That distinction is the point: the view exists
  so that "my load order is fine" is not a conclusion you reach by accident.
- **`ModInUse` is now decided, by measurement rather than inference.** A probe run
  in the game established that it means *switched on in the active profile*, not
  merely present on disk: an action gated on a mod that was installed, off in the
  active profile and on in eleven others did not run. It was the commonest
  condition in a real library by a wide margin — 604 of 1356, against 1 for
  `ModIsEnabled` — and every one of those was previously reported as
  undecidable. In Harmony in Diversity's profile, provably-off actions go from 160
  to 331 and decided actions from 47% to 59%.
- **An undecidable row now names the specific thing it cannot see**, instead of
  `depends on something this view cannot see`. A row gated on Monopolies mode and
  Expansion 2 now says both, by name, and who chooses them — which shows the row
  is fine and merely unanswerable here, rather than looking like a fault. Where
  several conditions are unreadable, the row says how many it is not showing.
- **A condition with several properties is one condition, not several.** The
  conditions query was returning one row per property, so a game-option condition
  — which carries three — was listed as three unreadable reasons, and the row's
  own count of hidden conditions was counting one as three.
- **Comparing two profiles** marks the rows that would come and go. It is cheap,
  because an action's row belongs to the database rather than to a profile — two
  profiles differ only in which mods are switched on.
- **Your own overrides on an individual action's load order**, on a separate
  **Load order overrides** page. The view above is read-only and stays that way:
  its button reads *Manage overrides* and navigates. An override survives the mod
  it is on updating, and keeps working without making that mod local or
  unsubscribing it from Steam.
- **A re-apply pass at startup**, and a **Re-apply all** button for a server left
  running across a Steam sync. The mod list warns when a mod with an override has
  updated since the last pass.
- `npm run phase7`, which covers the store, the action identity, the write path,
  the sync and the view — 163 checks, or 171 given a path to a real `Mods.sqlite`
  to measure the identity collision rate against.
- A malformed `civ6-paths.json` is now **reported** instead of silently ignored.
  It used to fall back to the default folders with no message, so a typo made the
  whole library look empty. The write path also honours `CIV6_PATHS_FILE` now, so
  a test or a relocated install no longer overwrites the project root's copy, and
  it is written atomically — a half-written file is not a partial override, it is
  every mod gone.
- **The overrides page is now a block-move editor.** Pick a mod and see its
  positioned actions as one block with its span and width; target a value, another
  mod, or a free band and get proposed numbers preserving the internal spread.
  When the block does not fit, the page says how wide the gap is and offers even
  re-spacing, overflowing below or above, or per-action manual entry — one
  transaction, one backup, refused while Civ6 runs. A before-anchor sits snug
  below the anchor rather than sliding to the far end of the gap.
- **The view toolbar filters by mod or by action, separately.** The mod box
  matches exactly — *Harmony in Diversity* no longer drags in its District
  Expansion sibling — and the action box is a dropdown of the profile's own
  action types rather than typed text.
- **Action rows show the files they contribute**, on demand and collapsible, in
  both the view and the editor. The names come from the database, never from a
  path the page supplies, and the lookup works while Civ6 runs.
- **Mod names display the way the mod manager shows them, everywhere.** Markup
  renders in page rows and warnings, strips to plain text in dropdowns and
  dialogs, and the ledger resolves localisation tags. A release-gate check names
  any new spot that leaks raw tags or keys.
- Expanded action blocks read as one grouped block, and bands in the view are
  separated by a rule rather than a tint.

### Notes

- An override writes the game's own database, and it writes **two** things in one
  transaction: the value, and the `ScannedFiles` stamp that stops the game
  re-deriving it. Without the stamp the value is removed on the next launch, so
  the two are never written apart.
- **Per-profile load order is not supported, and the schema cannot hold it.**
  `ComponentProperties` carries one row per action, so there is nowhere to put two
  values. Switching profile therefore never rewrites anything: `LoadOrder` is
  fixed against an action, so switching changes *which actions run*, not the order
  they run in.
- A mod that misspells `LoadOrder` as `LaodOrder` or `LoadingOrder` is overridden
  anyway, by writing a correctly spelled row. The mod's own row is left exactly as
  it shipped it.
- 42 of 427 rows in a real library are base-game or DLC assets whose `.modinfo` is
  not on disk. Nothing can keep their stamp, so an override on one is re-derived on
  the next rescan, and the view says *not protected* rather than implying otherwise.

## v1.6.0 — 29 September 2026

Two features in the mod manager: your own labels on mods, and an order for the
list. Neither changes what the game loads — they are about finding your way
round a library of several hundred.

There is no v1.5.1. **v1.5.0** is tagged but was never published: the release
build failed its checks, so no zip and no release page were produced for it. It
is skipped here rather than backfilled, and this is the first release since
v1.3.1.

### Added

- **The mod list can be sorted**, from a dropdown beside the label filters. Six
  orders: **Name** (default), **State**, **Source**, **Label**, **Needs
  attention** and **Last changed**. Your choice is remembered, and hovering the
  dropdown explains whichever key is selected. Sorting only changes the order,
  never which mods are shown, and it composes with every filter rather than
  replacing one.
- **Needs attention** is the one worth knowing about: it puts mods with a missing
  dependency or an active conflict at the top, which is what you want when
  something is broken and you are working out why.
- **State** counts a mod you have switched on but not yet applied as on, so the
  list agrees with the rows and the warning count rather than the last saved
  state.
- `npm run phase6`, which checks the six orderings. They are pure functions over
  plain objects, so they need no browser and no DOM, and the awkward cases —
  stability, unlabelled-last, pending-as-current — are checked rather than
  eyeballed.
- **Labels can be renamed and deleted**, on every mod that carries them, and
  both report how many mods changed. Renaming a label to one that already exists
  merges the two rather than refusing, so a name you want is never unreachable.

- **Your own labels on mods** — *favourite*, *needs-testing*, *mp-safe*, whatever
  names you want. The mod list has filters for source, state and name, and
  nothing for the judgement only you can make about which mods you actually
  want. Labels are global rather than per profile, so the same set applies
  whichever profile is in use.
- **A labels editor on every mod row.** Unlabelled mods show a small **+**;
  labelled ones show their labels. The editor lists every label in use as a
  one-click toggle with a count, plus a field to make a new one, and saves the
  lot in one write. A mod can carry as many labels as are useful and counts
  towards each — capping it would force a choice nobody has a basis to make.
- **A label filter dropdown** under the profile bar, with a **Manage…** button
  beside it. Open the dropdown and tick the labels you want — several at once,
  and you get the mods carrying **any** of them, not all of them. Each line
  shows how many mods have that label, so you can see whether it would leave
  you nothing before ticking it. And-ing would show only mods carrying every
  one, which is rarely what anyone wants and quietly returns nothing.
- **`npm run phase5`**, which checks the label store against a scratch
  directory. Its centrepiece is a rescan that renumbers every `ModRowId`, plus
  a deliberately wrong file keyed by `ModRowId` that is read across the same
  rescan and asserted to lose its labels — so the passing case cannot pass for
  an unrelated reason.

### Notes

- Labels live in `mod-labels.json` beside `civ6-paths.json`, keyed by the mod's
  own GUID from its `.modinfo` and **not** by `ModRowId`, which the game
  renumbers on every rescan. Anything keyed by the row id loses every label the
  next time Civ6 launches. This was found the hard way during the load-order
  work, and is now covered by a test.
- This is the only write in the toolkit that is **not** refused while Civ6 is
  running, and the only one with no backup — both because it writes a file the
  game has never heard of, rather than the game's database. Losing it costs a
  few minutes of re-labelling; backing it up would leave `.bak-` files in the
  project root.
- A `mod-labels.json` that has been corrupted shows one warning and carries on
  with no labels — a syntax error in a file the toolkit wrote itself must not be
  able to take the mod list down. The toolkit also refuses to *write* over a file
  it cannot read, so a bad one can still be fixed by hand.
- The left half of the filter row is no longer reserved — it holds the sort
  control now, and the two halves read as a pair.
- The label filter was a row of chips first, and it was not kept. With a dozen
  labels the chips took six lines on a phone and pushed the mod list off the
  bottom of the screen. A dropdown whose menu scrolls has no such problem, at
  any number of labels.
- **Last changed** sorts by the `.modinfo` file's timestamp, read from the
  database rather than the disk. Measured on a real install: 4 ms from the
  database against 1,194 ms for walking every mod folder and 28 ms for one
  `stat` each, and only the database covers official DLC, whose stored paths are
  relative and have nothing on disk to look at. It is therefore **not** the same
  number as **Last changed** in a mod's details panel, which reports the newest
  file anywhere in the folder — they matched exactly for 30 mods in 40 and
  differed by hours otherwise.
- That timestamp is 18 digits of 100-nanosecond ticks since 1601, which is a
  `RangeError` in JavaScript — this codebase has hit that twice already. It is
  cast to text in the query, and a test asserts the cast is still there, because
  a conversion that works tells you nothing about whether the thing that throws
  has been removed.

## v1.5.0 — 28 September 2026

A mod manager you can actually drive: it finds new mods by itself, and you can
open a mod's folder, open its Workshop page, take it out of the game, or read
its name properly.

The work that was drafted as a separate v1.4.0 shipped as part of this one
release, so there is no v1.4.0 tag or download — v1.3.1 is the version before
this one.

### Added

- **The toolkit adds new mods itself, when it starts.** Anything on disk the
  game has never scanned is registered, and anything the game knows but that has
  no row in the profile in use gets one, so it can be ticked. No button, and no
  game launch.
- **Rescan & add new mods** (was *Rescan*) on the dashboard does the same thing
  on demand, for mods subscribed to while the toolkit is already open — which is
  how you normally subscribe, in batches. Renamed because it now writes to the
  game's database; a button labelled *Rescan* that silently registered thirty
  mods would be a nasty surprise.
- **A folder button on every Workshop and local mod**, which opens its folder in
  Explorer. A page cannot start Explorer itself — `file://` links are blocked from
  an `http://` page — so the server does it, taking ids only and re-deriving the
  folder from the database. A mod whose folder is gone shows the button disabled,
  labelled *folder not found*.
- **Remove mod**, in a mod's details panel. It takes the mod out of the game and
  out of every profile, and deletes its folder from disk. The dialog names the
  exact folder first, because the files cannot be undone — only the database is
  backed up.
- The dashboard lists mods that are recorded by the game but no longer on disk
  (unsubscribed, or deleted by hand) and points at the same button. They are only
  ever listed, never removed automatically: a mod part-way through a Steam
  download looks exactly like one just unsubscribed, and quietly deleting those
  would be a nasty way to lose a mod you had just subscribed to.
- The dashboard says what the last sync did — how many mods were added, and by
  name — and which could not be read, and why.
- If Civ6 is running, a sync is skipped and the reason is shown, rather than
  attempted and failed.

### Changed

- **Nothing is ever switched on.** Added mods come up off, with a row in every
  profile. This is the whole reason the above can run unattended: the toolkit
  can put a mod in front of you, but it cannot change what the game loads.
- The mod manager no longer has a Register button, an *Add to profile* button, or
  the *Add them all* banner. Its only write is **Apply changes**. A mod that
  needs adding is tagged **not added** and points at the dashboard.

### Fixed

- **Rescan & add new mods dropped every mod's conditions**, so a newly registered
  mod's actions ran whether or not the mod they depend on was present — the one
  thing this toolkit exists not to change. Two faults, both shipped:
  `xmlActions` read a condition reference from a `criteria="NAME"` **attribute**,
  which no real mod uses — every mod that has conditions names it with a
  `<Criteria>NAME</Criteria>` **element** inside the action — and `writeActions`
  never wrote the `ComponentCriteria` link at all, despite building the `Criteria`
  rows directly above it and commenting that they were built first so actions could
  point at one. The rows were created and nothing pointed at them.
- **An inverted condition was skipped rather than inverted.** A set whose only
  condition was `NOT ModInUse(X)` fell through to "will run", so an action was
  reported as running that provably does not. 225 `ModInUse` conditions and 1
  `GameCoreInUse` are inverted, so this was live rather than hypothetical.
- **`Criteria.Any` was treated as AND**, so a set the author marked `any="1"`
  could be reported as not running when one of its conditions was satisfied. 82
  sets carry the flag and 76 hold more than one condition.
- **Clicking the `workshop` label toggled the mod instead of opening the Workshop
  page.** The whole row is the on/off switch, and `paneClick` only spared what was
  a `<button>` or an `<a>`; the label was a `<span>`, so it was neither. It is now
  a real link, which fixes it structurally rather than adding another case to the
  handler. The separate `↗` it replaces, and the CSS only it used, are gone.
- A mod whose name contains an XML entity rendered as a literal `&amp;amp;`, and
  its colour markup showed as visible `<span>` text. Two causes: the text was
  escaped a second time after the colour tags had already become HTML, and the
  entity was never decoded. The game stores the raw `&amp;`, so the fix is at the
  point of display only — decoding earlier would have stopped the database
  matching what the game writes.
- The `workshop` and `enabled`/`disabled` labels in a mod's details sat on
  different baselines, because they were different components: a `.tag` at 11px
  beside a `.chip` at 12px. The state is now a `.tag` too, with colour variants.
  The dashboard's found/not-found badge and the change list are `.chip` and are
  deliberately left alone — those are meant to be read across a room.
- **The folder button didn't open the mod's folder.** Two separate faults, stacked,
  each masking the other:
  - It opened **Documents** instead, because the game records paths with forward
    slashes even on Windows and `explorer.exe` reads the first field of an argument
    beginning with `/` as a *switch* — given `D:/Steam/…/289070/2573589760` it saw
    `/Steam`, `/steamapps` and `/workshop` as unknown switches, was left with no
    path at all, and fell back to its default folder. Paths are now converted to
    native separators where they cross into a native program, and nowhere else.
  - Even with the right path, **no window appeared at all** — a flicker and
    nothing more. `windowsHide: true` sets `STARTUPINFO.wShowWindow = SW_HIDE`,
    which Explorer inherits, so it built the window and the shell hid it. A hidden
    window is still a real entry in Explorer's window list, so it looks like it
    worked. The flag is not repeated there on purpose: it belongs on the
    `tasklist` and `reg` calls, which are console programs that would otherwise
    flash one. `explorer.exe` is GUI-subsystem and never allocates a console, so
    the flag bought nothing and cost the window.
- `removeMods` skipped its folder checks entirely when given no source roots, so
  a destructive call could proceed because nobody passed an argument. It now
  refuses: it cannot prove the folder is safe.
- `registerMods()` ignored its `enabled` argument and always switched a mod on in
  the built-in group and the profile in use. Harmless while the only caller
  always wanted it on; under automatic syncing it would have switched mods on
  behind your back. Test 17 is the test that would have caught it.
- "What needs adding" was worked out in three separate places, and the copies
  had drifted: the dashboard's version looked only at the mod folders, so it
  never noticed a mod the game knew but that had no row in the profile. There is
  now one function, `findUnregistered()`, that all of them read.
- A second sync with nothing new to do used to make a fresh backup, so every
  Rescan click spent one of the ten backups kept. It now returns before writing.

### Note

Removing does not unsubscribe from Steam. The dialog links the Workshop page so
that is one click away, but doing it for you would mean guessing at a `steam://`
handler that may not exist for workshop items.

**For anyone on v1.3.x: _Add to profile_ used to switch a mod on. It now leaves
it off**, like everything else. Tick it in the mod manager as you would any
other mod.

## v1.3.1 — 28 September 2026

No code changes — this fixes what v1.3.0 shipped with.

### Fixed

- The `docs/` copy inside the v1.3.0 zip was the pre-fork one: its download
  button and release links still pointed at cru121, and its release-lookup
  script fetched cru121's newest release. The live site was already correct;
  this corrects the copy in the zip.
- The app footer credited Claude and sent **Open an issue** to
  `cru121/Civ6-Mod-Toolkit`, where nothing is being worked on. Both now point
  here.
- `package.json`'s `author` and `repository` fields also still named cru121 and
  Claude.

### Changed

- README trimmed by about a sixth, mostly by dropping the "what's new here"
  section that now duplicates this file, and fixing a "(see below)" that pointed
  at nothing.
- Claude removed from the README, the app footer, the docs site and
  `package.json`. cru121's original authorship, Steam name and MIT copyright
  are kept — that attribution is not optional under the licence, and it was
  never mine to remove.

## v1.3.0 — 27 September 2026

Two ways a mod could be unusable in the mod manager, one button for both.

### Added

- **Add to profile** for a mod the game has already scanned but that has no row
  in the profile you are editing. It showed as *not available* and could not be
  ticked, and the Register button only appeared for mods the game had never
  seen — so a mod left behind by an earlier run, or discovered by the game after
  the profile was made, had no way out of the toolkit.
- The banner and the mod list report how many profiles a mod will be added to,
  and say so before you click.

### Changed

- **Registering a mod now writes a row in every profile**, not just the built-in
  group and the one you are editing. Previously the mod became *not available*
  again as soon as you switched profile. It is switched on in the profile being
  edited and the built-in group, and present-but-off in the rest — which is what
  a profile created by the toolkit already looks like. Re-registering never
  switches a mod on in a profile you did not ask for.
- The registration is read back and checked for a row in *every* profile, so a
  partial write fails and restores the backup instead of leaving a mod stuck.

### Fixed

- `<File>` elements that carry attributes (`<File priority="2">`) were being
  dropped, which lost 53 files across 30 mods when re-registering them. Recorded
  in `FINDINGS.md`.

## v1.2.0 — 27 September 2026

### Added

- **Register a mod without launching Civ6.** A mod you have just subscribed to
  gets the same rows in the game's mod database that the game itself would have
  written, so it can be switched on straight away. A banner button registers
  everything at once; a per-row button does one. Both are disabled while Civ6 is
  running, with the reason shown.
- `FINDINGS.md` records how a mod is registered, derived by matching the game's
  own output row for row.

### Changed

- The README, the docs site and the dashboard no longer tell you to start Civ6
  once to make it notice a new mod.

### Notes

- Registering many mods at once is all-or-nothing, and your database is backed
  up first either way.
- A mod is only *registered and enabled* — it takes effect the next time you
  start Civ6, not instantly.

## v1.1.0 — 27 September 2026

### Added

- **Player profiles** — Civ6 calls them *mod groups*, and upstream could list
  them and show which was in use but could not change any of them. The **Profile**
  bar above the filters now switches which group you are editing, and
  **Manage…** creates an empty one, duplicates the selected one, renames it, or
  deletes it. Deleting the profile in use switches to the one you had before it.
- **Export** and **Import…** for profiles, as `.json`, so a set-up can be moved to
  another computer or shared. Mods in the file that you do not have installed
  are reported and left out. Import always creates a new profile.

### Changed

- The release zip is now built by a workflow on a version tag, so a release no
  longer needs a machine to do it by hand.

## v1.0.0 and earlier — upstream

By **cru121**. Dashboard, config editor, mod manager, and the Windows launcher.
See the [upstream repository](https://github.com/cru121/Civ6-Mod-Toolkit) for the
full history.
