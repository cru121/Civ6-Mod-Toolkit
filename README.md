# Civ6 Mod Toolkit

A mod toolkit for Sid Meier's Civilization VI that runs outside the game:

- **Dashboard** — how many Workshop and local mods you have (and how many are
  enabled), your saved game configurations, whether the game is running, and
  where the toolkit looks for everything.
- **Config editor** — add or remove mods in an existing `.Civ6Cfg` game
  configuration **without** recreating it by hand. Your customized game settings
  are preserved — only the mod list is touched.
- **Mod manager** — *coming next:* turn mods on and off without starting the
  game.

Not affiliated with or endorsed by Firaxis Games or 2K.

## Run it (easiest)

You need [Node.js](https://nodejs.org) installed once (any recent version).

Then just **double-click `Civ6 Mod Toolkit.cmd`** in this folder. The first
run installs what it needs (one-time), then your browser opens to the toolkit
automatically. A small window stays open while the toolkit runs — **close that
window to stop it**.

Reading which mods are enabled needs Node.js **22.5 or newer**; with an older
version everything else still works.

Tip: right-click `Civ6 Mod Toolkit.cmd` → *Send to* → *Desktop (create
shortcut)* to launch it from your desktop. You can rename the shortcut and change
its icon.

### Or from a terminal

```bash
npm install
npm start
```

Both open `http://127.0.0.1:8673`. Double-clicking the launcher again while it's
already running just reopens the browser tab.

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
- The game's mod database is only ever opened **read-only** so far.

## What's under the hood

A small Node server (`src/server.js`) exposes a JSON API used by the browser UI
in `public/`. The format engine is `src/civ6cfg.js`; mod discovery is
`src/modinfo.js` + `src/paths.js`; the safe-save logic is `src/editor.js`; the
game's mod database is read by `src/modsdb.js`, and `src/game.js` detects
whether Civ6 is running. There
is also a CLI, `src/edit-config.js` (`npm run edit -- --help`-style flags), which
the server reuses. See `FINDINGS.md` for the reverse-engineered file format.
