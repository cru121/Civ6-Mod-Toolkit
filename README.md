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
  slow.

Website: <https://cru121.github.io/Civ6-Mod-Toolkit/>

Not affiliated with or endorsed by Firaxis Games or 2K.

## Install and run

Windows 10 or 11.

1. **Download** `Civ6-Mod-Toolkit-vX.Y.Z.zip` from the
   [latest release](https://github.com/cru121/Civ6-Mod-Toolkit/releases/latest).
2. **Unblock it** (recommended): right-click the zip → *Properties* → tick
   **Unblock** → *OK*. Otherwise Windows may show a blue *"Windows protected
   your PC"* warning when you start the launcher — if it does, click
   *More info* → *Run anyway*.
3. **Extract** the zip anywhere (e.g. your Documents folder).
4. **Double-click `Civ6 Mod Toolkit.cmd`.** Your browser opens to the toolkit.

The toolkit needs [Node.js](https://nodejs.org) **22.5 or newer**. If it's
missing or too old, the launcher tells you and offers to install it for you
(using Windows' built-in `winget`) or to open the download page.

A small window stays open while the toolkit runs, with a menu — just press a
key:

- **O** — open the toolkit in your browser (e.g. if you closed the tab)
- **R** — restart the toolkit
- **S** — stop it and close the window

Closing the window also stops the toolkit. (The launcher uses `curl`, which is
built into Windows 10 and newer.)

Tip: right-click `Civ6 Mod Toolkit.cmd` → *Send to* → *Desktop (create
shortcut)* to launch it from your desktop. You can rename the shortcut and change
its icon.

### From the source code / a terminal

If you cloned the repository or downloaded the *Source code* zip instead, the
launcher installs the dependencies on first run (needs internet once). Or:

```bash
npm install
npm start
```

Both open `http://127.0.0.1:8673` (from a terminal, stop it with Ctrl+C).
Double-clicking the launcher again while it's already running just reopens the
browser tab.

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

If you've just installed or subscribed to a mod, the dashboard tells you when
the game hasn't picked it up yet — start Civ6 once and it will.

### Mod manager

1. Pick what to show: **All mods** (Workshop + local), **Workshop**, **Local**,
   or **Official DLC**, optionally only **Enabled** / **Disabled** ones, and
   filter by name.
2. Tick or untick mods. **Enable all shown** / **Disable all shown** work on
   whatever the current filter shows. Changed rows are highlighted.

   Prefer moving mods between lists? Switch to **Two panes**: *Available* on
   the left, *Enabled* on the right — click a mod to move it across, or use
   **Enable all →** / **← Disable all**. The toolkit remembers which view you
   picked.
3. Click **i** on any mod for its details: description, authors, version,
   whether it affects saved games, what it changes (gameplay, UI, art, maps…),
   what it needs, what needs it, what it's incompatible with, which of your
   `.Civ6Cfg` configurations use it, and its folder, size and Workshop page.
4. Warnings appear under a mod that is turned on but needs something that's off
   or missing (**Turn it on** fixes it), or that conflicts with another mod
   that's on.
5. Click **Apply changes** (or **Discard**). The game must be **closed** —
   applying is blocked while Civ6 runs. Changes take effect the next time you
   start the game.

Mods you've only just installed show **not scanned yet**: start Civ6 once so it
registers them, then they can be toggled here. The toolkit edits the game's
currently selected mod group (normally *Default*).

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
  changes only the enabled/disabled flags, and checks the result — if anything
  looks wrong, the backup is put back.

## Authors & feedback

Made by **cru121** (Steam: *evzenhouzvicka*) together with Claude, Anthropic's
AI assistant. Questions, bugs or ideas? Please
[open an issue](https://github.com/cru121/Civ6-Mod-Toolkit/issues).

## What's under the hood

A small Node server (`src/server.js`) exposes a JSON API used by the browser UI
in `public/`. The format engine is `src/civ6cfg.js`; mod discovery is
`src/modinfo.js` + `src/paths.js`; the safe-save logic is `src/editor.js`; the
game's mod database is read and updated by `src/modsdb.js`, and `src/game.js` detects
whether Civ6 is running. There
is also a CLI, `src/edit-config.js` (`npm run edit -- --help`-style flags), which
the server reuses. See `FINDINGS.md` for the reverse-engineered file format.
