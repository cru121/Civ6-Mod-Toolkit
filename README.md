# Civ6 Mod Toolkit

A mod toolkit for Sid Meier's Civilization VI that runs outside the game:

- **Dashboard** — how many Workshop and local mods you have (and how many are
  enabled), your saved game configurations, whether the game is running, and
  where the toolkit looks for everything.
- **Config editor** — add or remove mods in an existing `.Civ6Cfg` game
  configuration **without** recreating it by hand. Your customized game settings
  are preserved — only the mod list is touched.
- **Mod manager** — turn mods (and official DLC) on and off without starting
  the game, with warnings for missing dependencies and conflicts. Handy when a
  broken mod stops the game from starting, or when the in-game mod screen is
  slow. A mod you have just subscribed to can be registered and switched on
  here, without starting the game once so it notices the mod.
- **Profiles** — Civ6 calls them *mod groups*. Create, duplicate, rename, delete
  and switch between them here, and export/import a profile as a `.json` file,
  so a set-up can be moved to another computer or shared.
- **Save editor** *(experimental)* — add or remove mods in a `.Civ6Save`, e.g. so
  it no longer asks for a missing mod. UI-only mods are safe either way; gameplay
  mods may stop the save from loading. Writes a new copy by default.

Website: <https://cru121.github.io/Civ6-Mod-Toolkit/>


Not affiliated with or endorsed by Firaxis Games or 2K.

## Install and run

Windows 10 or 11.

1. **Download** `Civ6-Mod-Toolkit-vX.Y.Z.zip` from the
   [latest release](https://github.com/cru121/Civ6-Mod-Toolkit/releases/latest).
2. **Unblock it** (recommended): right-click the zip → *Properties* → tick
   **Unblock** → *OK*. Otherwise Windows may show a blue *"Windows protected
   your PC"* warning — if it does, click *More info* → *Run anyway*.
3. **Extract** the zip anywhere (e.g. your Documents folder).
4. **Double-click `Civ6 Mod Toolkit.cmd`.** Your browser opens to the toolkit.

The toolkit needs [Node.js](https://nodejs.org) **22.5 or newer**. If it's
missing or too old, the launcher offers to install it for you (using Windows'
built-in `winget`) or to open the download page.

A small window stays open while the toolkit runs — press a key to pick:

- **O** — open it in your browser again, if you closed the tab
- **R** — restart it
- **S** — stop it and close the window

Closing the window also stops it. Tip: right-click the `.cmd` → *Send to* →
*Desktop (create shortcut)* to launch it from your desktop.

### From the source code

If you cloned the repository instead, the launcher installs the dependencies on
first run (needs internet once). Or:

```bash
npm install
npm start
```

Both open `http://127.0.0.1:8673` (from a terminal, stop it with Ctrl+C).

## Using it

### Dashboard

The start page. The cards show enabled / installed counts for **Workshop** and
**local** mods, the number of `.Civ6Cfg` files, and official DLC. The badge in
the top-right corner shows whether Civ6 is currently running.

**Folder setup** lists everything the toolkit uses — local mods, Steam Workshop,
the configurations folder, and the game's mod database (`Mods.sqlite`, under
`%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI`). They're
auto-detected; if one shows **not found**, click **Edit paths**, fix it, and
**Save paths**.

**Rescan & add new mods** picks up anything you've subscribed to since last
time. See below — you rarely need to click it, because the toolkit does this
when it starts. It also re-registers a mod you have edited locally, which is how
a corrected `LoadOrder` gets picked up.

### Mod manager

1. Pick what to show: **All mods** (Workshop + local), **Workshop**, **Local**,
   or **Official DLC**, optionally only **Enabled** / **Disabled** ones, and
   filter by name. The **Sorting** dropdown picks the order — see below.
2. Tick or untick mods. **Enable all shown** / **Disable all shown** work on
   whatever the current filter shows. Changed rows are highlighted.

   Prefer moving mods between lists? Switch to **Two panes** and click a mod to
   move it across. The toolkit remembers which view you picked.
3. Each row has four controls. The **workshop** label opens the mod's Workshop
   page, the **folder** icon opens its folder in Explorer, and the **labels**
   chip opens the label editor — none of them changes whether the mod is on. The
   **arrow** moves it on or off, and so does clicking anywhere else in the row. A
   mod whose folder is gone (unsubscribed, or deleted) shows the icon greyed out.
4. Click **i** on any mod for its details: description, authors, version, what
   it changes, what it needs, what needs it, what it's incompatible with, which
   of your `.Civ6Cfg` configurations use it, its folder, size and Workshop
   page.
5. Warnings appear under a mod that is turned on but needs something that's off
   or missing (**Turn it on** fixes it), or that conflicts with another mod
   that's on.
6. Click **Apply changes** (or **Discard**). The game must be **closed** —
   applying is blocked while Civ6 runs. Changes take effect the next time you
   start the game.

### New mods

A mod you've just subscribed to isn't in the game's database yet, so the game
can't load it. The toolkit adds it for you:

- **When the toolkit starts**, anything on disk the game hasn't got is added
  straight away.
- **If you subscribe while the toolkit is already open**, click **Rescan & add
  new mods** on the dashboard. That covers subscribing to a batch at once, which
  is the normal way.

Added mods come up **switched off**, with a row in every profile so you can tick
them from any of them. Nothing is ever switched on for you — that's your
decision to make, and it's why this can run unattended. Civ6 must be **closed**,
the database is backed up first, and the result is read back and checked.

A mod tagged **not added** is one the game can't load yet. Same fix: rescan.

### Removing a mod

Open a mod's details (**i**) and click **Remove mod**. It takes the mod out of
the game and out of every profile, and deletes its folder from disk. The dialog
names the exact folder first, because the files are gone for good — the database
is backed up, your mods are not.

It does not unsubscribe you from Steam; the dialog links the mod's Workshop page
so that is one click away if you want it out of your library too.

If you unsubscribed in Steam instead, the dashboard lists the mods the game still
remembers that are no longer on disk, with the same button. Base game and DLC
content is never offered — only Workshop and local mods.

### Profiles (mod groups)

The **Profile** bar above the filters picks which group of mods you are
editing — the same thing as Civ6's *Additional Content → Mod Groups*. Each entry
shows how many mods it has on. The game must be **closed** to change them.

- Pick one from the dropdown to make it the group the game uses.
- **Manage…** creates an empty profile (every mod off), duplicates the selected
  one, renames it, or deletes it. The built-in *Default* profile and your last
  remaining profile can't be deleted; deleting the profile in use switches to
  the one you had before it.
- **Export** saves the selected profile as a `.json` file, **Import…** creates a
  new profile from such a file. Mods in the file that you don't have installed
  are reported and left out.

Worth exporting a profile as a backup now and then: a game patch that changes
the mod database format can switch every mod back on.

### Sorting

The **Sorting** dropdown above the filters orders the list. Your choice is
remembered between sessions, and hovering the dropdown explains whichever key
is selected.

| Order | What it means |
|---|---|
| **Name** | Alphabetical, ignoring Civ colour markup. The default. |
| **State** | Enabled first. A mod you've switched on but not applied counts as on. |
| **Source** | Workshop, then local, then official DLC. |
| **Label** | By your first label; mods with no label go last. |
| **Needs attention** | Mods with a missing dependency or an active conflict first — the useful one when something is broken. |
| **Last changed** | Newest `.modinfo` file first. It means *the file changed*, not that the author released something: a Steam file repair also bumps it. |

Sorting only changes the order, never which mods are shown, and it composes
with the source, state, name and label filters — it orders whatever they left.

**Last changed** is offered only when the toolkit can read a timestamp for at
least one mod. It is also not the same number as **Last changed** in a mod's
details panel, which reports the newest file anywhere in the folder rather than
the `.modinfo`. They agree exactly for about three mods in four and differ by
hours otherwise, because Steam writes a mod's files in a batch.

### Labels

Your own labels on mods — *favourite*, *needs-testing*, *mp-safe* — for the
things the game's own filters can't express. A mod can carry as many as are
useful and counts towards each one.

- Click the **+** on a mod's row to open the editor. Every label in use is a
  one-click toggle showing how many mods carry it; type a new name to make one.
  **Save** writes all of it at once, and the row updates straight away.
- The **Label filters** dropdown above the filters narrows the list. Open it and
  tick the labels you want — several at once, and you get the mods carrying
  **any** of them, not all of them. Each line shows how many mods have that
  label, so you can see whether it would leave you nothing before ticking it.
  **Clear** puts the list back.
- **Manage…** beside it renames or deletes a label, and does so on every mod
  that has it, saying how many mods changed. Renaming a label to one that
  already exists merges the two.
- Labels are **yours**, stored in `mod-labels.json` beside `civ6-paths.json`.
  They are the same in every profile, and survive Civ6 rescanning its database
  and moving a mod between the Workshop and your local folder.

A label that no mod carries stops being offered, and is forgotten. If you want
to set a label up before the mods that use it, give it to one mod for now.

### Load order

Civ6 decides when each mod action runs from a number called `LoadOrder`, and it
is set **per action, not per mod**. There is no display of it anywhere in the
game, so if you are writing a sub-mod and need to know where to file something,
you are working it out by hand.

The **Load order** tab is that display. It lists every action of every mod the
selected profile has on, in the order the game will use them, and:

- **The gaps between values are rows of their own.** A gap between two actions
  you can see is a gap you could put something in. They are computed inside the
  profile, so a profile whose highest action is 50000000 is not told that
  701-898 is free.
- **Ties are shown as ties.** Where several actions claim one value the game
  picks arbitrarily, and so does this, rather than implying a ranking that does
  not exist.
- **Actions that declare no position have their own block**, grouped by mod. In a
  large library that is several hundred actions whose order is decided by nothing
  anyone controls - and a mod with a long list there is relying on undocumented
  ordering.
- **Rows say what an action is gated on**, and mark it as not running only where
  that can be proven. Where it cannot, the row says what specifically it could
  not see rather than shrugging — `needs GAMEMODE_MONOPOLIES to be 1, a game
  option picked in the main menu` — and, if several conditions are unreadable, how
  many it is not showing. That distinction matters: the view exists so that "my
  load order is fine" is not a conclusion you reach by accident, and a row that
  cannot be decided should not look like a row that is broken.
- **`ModInUse` is decided, and was measured rather than assumed.** It means
  *switched on in the active profile*, not merely present on disk — established by
  running a probe in the game, where an action gated on a mod that was installed,
  off in the active profile and on in eleven others did not run. It is by a wide
  margin the commonest condition in a real library (604 of 1356, against 1 for
  `ModIsEnabled`), and all 604 were previously reported as undecidable.
- **Compare** with a second profile marks the rows that would come and go.
- A mod row's **arrow button** opens this list with that mod's rows **marked**,
  not filtered to. A list showing only that mod would answer none of the question
  you clicked the button to ask.

### Load order overrides

Some mods are filed in the wrong band. **Load order overrides** lets you move one
action's `LoadOrder` and keep it.

The view above is read-only and stays that way - its button reads *Manage
overrides* and navigates here. Finding the right place and changing it are two
different jobs, and the load order tab is only the first.

What this does:

- Writes the value into the game's own database, so **Civ6 must be closed**. It
  is refused otherwise, and the check is inside the code that writes rather than
  something the page asks about first.
- **Keeps working when the mod updates**, and **keeps Steam auto-updates**. You
  do not have to make a mod local or unsubscribe it. That is the whole reason
  it works: alongside the value it also writes the one column the game uses to
  decide whether a mod has changed, so the game does not re-derive the value away
  again. Both writes happen in one transaction, because a value without the
  stamp is a value the next launch removes.
- **Survives the toolkit being closed and a Steam sync happening.** It re-applies
  at startup, and the mod list warns when a mod carrying an override has updated
  since. **Re-apply all** does it on demand.
- Records the author's own value, so **Reset** can put it back. **Discard** is a
  different thing and says so: it forgets the intent and leaves the value where
  the last apply put it.

What it is **not**:

- **Not per profile.** `LoadOrder` is a single value per action and the schema
  has nowhere to hold two. Switching profile never rewrites anything: it changes
  *which actions run*, not the order they run in.
- **Not a suggestion.** The toolkit re-applies what you set. It never works out
  a value for you, and it will not move an action whose key matches more than one
  candidate - it reports that and stops, because a wrong guess would silently
  move something else.

### Config editor

1. Pick a **Configuration file** from the dropdown.
2. **Left column** — mods currently enabled. Uncheck an installed mod to remove
   it. Official DLC and mods not found in your folders are hidden by default;
   tick **Show official DLC / mods** to see them (they're read-only).
3. **Right column** — mods you have installed but haven't enabled. Check the ones
   you want to add.
4. **Save (overwrite + backup)** writes the changes back to the same file after
   copying the original to a timestamped `.bak-…`. **Save as new file…** writes a
   fresh config and leaves the original untouched.
5. **Delete config…** removes the selected configuration file (a timestamped
   backup is kept, so it can be restored).

Then load the configuration in-game (Single Player → Create Game → load
configuration).

## Safety

- Overwrites always create a timestamped backup first (`name.Civ6Cfg.bak-…`).
- Before saving, the edited file is re-parsed and checked (mods added/removed in
  every mod block, counts consistent, header intact); a failed check aborts the
  write.
- Only the mod-list region of the file is ever modified.
- The toolkit only listens on `127.0.0.1`, and its API only accepts requests
  from its own page (other websites open in your browser can't talk to it).
- The mod manager only writes to the game's mod database while Civ6 is closed,
  copies it to a timestamped `Mods.sqlite.bak-…` first (the newest 10 are kept),
  and checks the result — if anything looks wrong, the backup is put back. The
  same applies to profile changes and to adding new mods.
- Adding new mods at startup is the one write that happens without you asking.
  It **never switches anything on** — a new mod is registered and left off, and
  only appears in the list. It is skipped entirely if Civ6 is running, and it
  writes nothing at all when there is nothing new to add.
- Removing a mod only ever touches Workshop and local mods. The folder comes
  from the database, never from the page, and is refused if it is a mod source
  folder, a folder containing one, or anything the game recorded as base game or
  DLC. The same rules guard the folder button, and they live in one place so the
  two cannot drift.
- **A load order override writes the game's own database**, and it writes two
  things: the value, and the `ScannedFiles` stamp that stops the game re-deriving
  it. Both go in one transaction, because a value committed without the stamp is
  one the next launch removes — the game would silently undo what you just set.
  It is refused while Civ6 is running, and the check is inside the code that
  writes, not a question the page asks first.
- An override is keyed by the mod's own id and by what the action *is* — its type,
  its name and its files — never by a row number. Row numbers are replaced every
  time the game re-registers a mod, which is exactly when you would lose the
  override. A key that matches more than one action is reported, never guessed at.
- A mod whose `.modinfo` is not on disk — 42 of 427 rows in a real library are
  base-game or DLC assets like this — cannot have its stamp maintained, so an
  override on one is re-derived on the next rescan. Those rows are marked *not
  protected* rather than being left to look safe.
- **Labels are the one write that is not refused while Civ6 runs, and the one
  with no backup.** Both because it writes `mod-labels.json` — a file the game
  has never heard of and cannot be holding open — rather than the game's
  database. Everything else in this list guards the game's files; this one
  guards nothing but a few kilobytes of your own notes.
- Labels are written to a temporary file and renamed into place, so an
  interrupted save cannot leave a half-written file. A `mod-labels.json` that
  has been corrupted, or hand-edited into a state the toolkit cannot read, shows
  a warning and carries on with no labels rather than taking the mod list down
  with it — and the toolkit refuses to overwrite it, so a bad file can still be
  fixed by hand.

## Authors & feedback

By **cru121** (Steam: *evzenhouzvicka*), with contributions from
**Klear2012**. MIT licence — see [LICENSE](LICENSE).

Questions, bugs or ideas? Please
[open an issue on this repo](https://github.com/cru121/Civ6-Mod-Toolkit/issues).

## What's under the hood

A small Node server (`src/server.js`) exposes a JSON API used by the browser UI
in `public/`. The `.Civ6Cfg` format engine is `src/civ6cfg.js`, mod discovery is
`src/modinfo.js` + `src/paths.js`, safe saving is `src/editor.js`, the game's
mod database, mod groups and registration are read and updated by
`src/modsdb.js`, user-defined mod labels are stored by `src/labels.js` in
`mod-labels.json`, the mod list's orderings are in `public/modsort.js`, and
load order overrides and the load order view are `src/loadorder.js` and
`public/loadorder.js`, with your overrides in `load-order-overrides.json`.
`npm run check:release` runs the four suites that have to pass before anything is
published. `phase4` checks the profile and registration operations against a
throwaway database. `phase5` checks the label store, including that labels
survive a simulated rescan that renumbers every `ModRowId` — the thing that
would silently lose them all. `phase6` checks the six orderings, which are pure
functions and so need no browser. `phase7` checks the load order work: the
override store, the action identity, the write path, the sync and the view —
including that the view is genuinely read-only, which is the one property most
likely to erode as features are added. Given a path to a real `Mods.sqlite` it
also measures the identity collision rate against your own library rather than
trusting a number written down once. The release workflow runs that same script,
so a change that breaks any of them cannot be published.
script, so a change that breaks any of them cannot be published.
`npm run phase0`, `phase1` and `phase2` check the `.Civ6Cfg` format itself and
need a real config of your own in `fixtures/`; see
[fixtures/README.md](fixtures/README.md).

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release, and
`FINDINGS.md` for the reverse-engineered file format and mod database schema.
