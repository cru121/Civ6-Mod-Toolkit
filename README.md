# Civilization VI — Config Mod Editor

Add or remove mods in an existing `.Civ6Cfg` game configuration **without**
recreating it by hand. Your customized game settings are preserved — only the
mod list is touched.

## Run it (easiest)

You need [Node.js](https://nodejs.org) installed once (any recent version).

Then just **double-click `Civ6 Config Editor.cmd`** in this folder. The first
run installs what it needs (one-time), then your browser opens to the editor
automatically. A small window stays open while the editor runs — **close that
window to stop it**.

Tip: right-click `Civ6 Config Editor.cmd` → *Send to* → *Desktop (create
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

1. It auto-detects your **local mods**, **Steam Workshop** mods, and **Saves**
   folder. If any are wrong, expand **Mod folders**, fix the path, and click
   **Save paths**.
2. Pick a **Configuration file** from the dropdown.
3. **Left column** — mods currently enabled. Uncheck an installed mod to remove
   it. (Official DLC and mods not found in your folders are shown greyed for
   reference.)
4. **Right column** — mods you have installed but haven't enabled. Check the ones
   you want to add.
5. **Save (overwrite + backup)** writes the changes back to the same file after
   copying the original to a timestamped `.bak-…`. **Save as new file…** writes a
   fresh config and leaves the original untouched.

Then load the configuration in-game (Single Player → Create Game → load
configuration).

## Safety

- Overwrites always create a timestamped backup first (`name.Civ6Cfg.bak-…`).
- Before saving, the edited file is re-parsed and checked (mods added/removed in
  every mod block, counts consistent, header intact); a failed check aborts the
  write.
- Only the mod-list region of the file is ever modified.

## What's under the hood

A small Node server (`src/server.js`) exposes a JSON API used by the browser UI
in `public/`. The format engine is `src/civ6cfg.js`; mod discovery is
`src/modinfo.js` + `src/paths.js`; the safe-save logic is `src/editor.js`. There
is also a CLI, `src/edit-config.js` (`npm run edit -- --help`-style flags), which
the server reuses. See `FINDINGS.md` for the reverse-engineered file format.

## Credits & license

MIT licensed (see `LICENSE`). The low-level file-format reader
(`src/civ6-save-parser.js`) is vendored from
[pydt/civ6-save-parser](https://github.com/pydt/civ6-save-parser) (MIT, Mike
Rosack); the config-specific navigation, editing, inventory, UI, and launcher
are original to this project.

Not affiliated with or endorsed by Firaxis Games or 2K. "Civilization" is a
trademark of its respective owner.
