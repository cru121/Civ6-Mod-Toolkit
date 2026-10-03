'use strict';

// Resolves where Civ6 mods live. Guesses sensible Windows defaults, but every
// path is overridable so the eventual UI can let the user fix them by hand.
//
// Override precedence (highest first):
//   1. civ6-paths.json in the project root (or CIV6_PATHS_FILE)
//   2. env vars CIV6_LOCAL_MODS / CIV6_WORKSHOP / CIV6_SAVES / CIV6_MODS_DB /
//      CIV6_LOGS_DIR / CIV6_CACHE_DIR
//   3. guessed defaults (probed for existence)
//
// A "source" is { type: 'local'|'workshop', label, root, exists }.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CIV6_APP_ID = '289070';
const GAME_DIR = "Sid Meier's Civilization VI";

function existsDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function firstExisting(candidates) {
  for (const c of candidates) if (existsDir(c)) return c;
  return null;
}

// --- "My Games" root (Documents may be redirected to OneDrive) --------------

function documentsCandidates() {
  const home = os.homedir();
  const out = [];
  // Known localized "Documents" folder names we might encounter.
  const docNames = ['Documents', 'Dokumenty', 'Dokumente', 'Documenti', 'Documentos'];
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
  if (oneDrive) out.push(oneDrive);
  for (const d of docNames) {
    out.push(path.join(home, 'OneDrive', d));
    out.push(path.join(home, d));
  }
  return out;
}

function myGamesRoot() {
  const roots = documentsCandidates().map((d) => path.join(d, 'My Games', GAME_DIR));
  return firstExisting(roots) || path.join(os.homedir(), 'Documents', 'My Games', GAME_DIR);
}

// Local Firaxis root (%LOCALAPPDATA%\Firaxis Games\<GAME_DIR>) — the same
// Local root getModsDb() uses. The game may keep Cache here instead of the
// Documents-side My Games root.
function localGamesRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Firaxis Games', GAME_DIR);
}

// --- Steam / Workshop -------------------------------------------------------

function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8',
    });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

// All Steam library roots (default install + any from libraryfolders.vdf).
function steamLibraryRoots(steamPath) {
  const roots = [];
  if (steamPath) roots.push(steamPath);
  const vdfCandidates = steamPath
    ? [path.join(steamPath, 'steamapps', 'libraryfolders.vdf'),
       path.join(steamPath, 'config', 'libraryfolders.vdf')]
    : [];
  for (const vdf of vdfCandidates) {
    try {
      const text = fs.readFileSync(vdf, 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
        roots.push(m[1].replace(/\\\\/g, '\\'));
      }
    } catch (_) { /* ignore */ }
  }
  return [...new Set(roots)];
}

function workshopRoots() {
  const steam = steamPathFromRegistry();
  const extraGuesses = [
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    'D:/Steam', 'D:/SteamLibrary', 'E:/SteamLibrary',
  ];
  const libs = [...steamLibraryRoots(steam), ...extraGuesses];
  const roots = [];
  const seen = new Set();
  for (const lib of libs) {
    const wc = path.join(lib, 'steamapps', 'workshop', 'content', CIV6_APP_ID);
    // De-dupe case-insensitively (Windows paths) and by resolved real path.
    let key = wc.toLowerCase();
    try {
      key = fs.realpathSync.native(wc).toLowerCase();
    } catch (_) { /* not present; fall back to lowercased string */ }
    if (existsDir(wc) && !seen.has(key)) {
      seen.add(key);
      roots.push(wc);
    }
  }
  return roots;
}

// --- Handing a path to a native program -------------------------------------

// Node accepts the game's forward-slash paths everywhere, so nothing inside the
// toolkit needs converting: fs, path and the SQL all cope. A native program is
// different, and explorer.exe is the sharpest example.
//
// explorer.exe reads the first field of an argument that begins with "/" as a
// switch. Given "D:/Steam/.../289070/12345" it sees /Steam, /steamapps,
// /workshop as unknown switches, is left with no path at all, and quietly opens
// Documents instead. It exits non-zero whether it worked or not, so nothing
// reports the mistake - the window opens, just in the wrong place.
//
// Convert at the boundary, once, only for the program being launched. Internal
// comparisons must keep the game's own form, or "is this folder ours" starts
// depending on which separator some layer happened to use.
//
// On POSIX the forward-slash form already *is* native, so this is a no-op there.
function toNativePath(p) {
  const s = String(p || '');
  return process.platform === 'win32' ? s.replace(/\//g, '\\') : s;
}

// --- Assemble sources -------------------------------------------------------

// Where the overrides live. Honoured on the write path too, not just the read
// one - a test or a relocated install that reads overrides from somewhere else
// and writes them to the project root is how a real config gets clobbered.
function overridesFile() {
  return process.env.CIV6_PATHS_FILE || path.join(__dirname, '..', 'civ6-paths.json');
}

// What each key is allowed to be. 'workshop' is the odd one: a single path or a
// list, because a Steam install often spans several library roots.
//
// A key whose value is the wrong shape is dropped rather than passed through.
// getSources() reads `ov.localMods || fallback`, so a number or an object here
// was truthy, survived the guard and reached statSync as a path - which
// reported the folder as merely missing rather than the file as broken.
const OVERRIDE_KEYS = {
  localMods: (v) => (typeof v === 'string' && v.trim() ? v : null),
  saves: (v) => (typeof v === 'string' && v.trim() ? v : null),
  modsDb: (v) => (typeof v === 'string' && v.trim() ? v : null),
  logsDir: (v) => (typeof v === 'string' && v.trim() ? v : null),
  cacheDir: (v) => (typeof v === 'string' && v.trim() ? v : null),
  workshop: (v) => {
    if (typeof v === 'string' && v.trim()) return [v];
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x.trim())) return v.slice();
    return null;
  },
};

// Reading the overrides must never take the mod list down with it. A typo in
// this file means every mod looks like it vanished, and before this reported
// itself the user had no way to tell that from an empty library.
//
// Two levels of failure, the same distinction labels.js draws: a file that is
// not the shape we write is unusable *as a whole*, while one bad key among good
// ones costs only that key. An unknown key is ignored without complaint, so a
// hand-added note or a `_comment` is not an error.
let overridesCache = null;

function loadOverrides() {
  if (overridesCache) return overridesCache;
  const file = overridesFile();
  const name = path.basename(file);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state: nothing overridden, nothing wrong. Anything
    // else - permissions, a directory in its place - is not.
    return (overridesCache = e.code === 'ENOENT'
      ? { overrides: {}, error: null, unusable: false, file }
      : { overrides: {}, error: `${name} could not be read (${e.message})`, unusable: true, file });
  }
  if (!text.trim()) return (overridesCache = { overrides: {}, error: null, unusable: false, file });

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return (overridesCache = {
      overrides: {}, error: `${name} is not valid JSON (${e.message})`, unusable: true, file,
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return (overridesCache = {
      overrides: {}, error: `${name} does not contain an object`, unusable: true, file,
    });
  }

  const overrides = {};
  const bad = [];
  for (const [key, check] of Object.entries(OVERRIDE_KEYS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = check(raw[key]);
    if (value) overrides[key] = value;
    else bad.push(key);
  }
  return (overridesCache = {
    overrides,
    error: bad.length
      ? `${bad.join(' and ')} in ${name} could not be read and ${bad.length === 1 ? 'was' : 'were'} ignored`
      : null,
    unusable: false,
    file,
  });
}

// What the UI needs to say about the overrides file: a message to show, and
// whether a write may proceed at all.
function overridesStatus() {
  const { error, unusable, file } = loadOverrides();
  return { error, unusable, file };
}

// Write the overrides back.
//
// Refuses outright when the file exists but is not the shape we write, for the
// same reason labels.js does: building on an unreadable file would replace
// whatever it holds, and a user whose paths stopped working deserves to fix or
// delete the file by hand rather than have it overwritten by a click they did
// not think of as destructive.
//
// Written through atomicWrite rather than writeFileSync, because this file is
// what says where the mods are. A half-written one is not a partial override -
// it is every mod gone, and reads of a broken file fall back to the defaults.
function writeOverrides(obj) {
  const current = loadOverrides();
  if (current.unusable) {
    throw new Error(`${current.error} - nothing was written. Fix or delete ${path.basename(current.file)}, then try again.`);
  }
  const next = {};
  for (const key of Object.keys(OVERRIDE_KEYS)) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') continue;
    const value = OVERRIDE_KEYS[key](Array.isArray(obj[key]) && key !== 'workshop' ? obj[key][0] : obj[key]);
    if (value) next[key] = value;
  }
  const { atomicWrite } = require('./editor');
  atomicWrite(current.file, JSON.stringify(next, null, 2));
  overridesCache = null; // re-read on next use, so the cache cannot go stale
  return { ok: true, file: current.file };
}

function getSources() {
  const { overrides: ov } = loadOverrides();
  const sources = [];

  // Local mods
  const localRoot = ov.localMods || process.env.CIV6_LOCAL_MODS || path.join(myGamesRoot(), 'Mods');
  sources.push({ type: 'local', label: 'Local / custom mods', root: localRoot, exists: existsDir(localRoot) });

  // Workshop mods (may be several library roots; overrides win if provided).
  // loadOverrides has already normalised 'workshop' to a list, so a single
  // string in the file is handled by the same code path as three.
  let wsRoots;
  if (ov.workshop) wsRoots = ov.workshop;
  else if (process.env.CIV6_WORKSHOP) wsRoots = [process.env.CIV6_WORKSHOP];
  else wsRoots = workshopRoots();
  if (wsRoots.length === 0) {
    sources.push({ type: 'workshop', label: 'Steam Workshop mods', root: null, exists: false });
  } else {
    for (const r of wsRoots) {
      sources.push({ type: 'workshop', label: 'Steam Workshop mods', root: r, exists: existsDir(r) });
    }
  }
  return sources;
}

function getSavesDir() {
  const { overrides: ov } = loadOverrides();
  const dir = ov.saves || process.env.CIV6_SAVES || path.join(myGamesRoot(), 'Saves', 'Single');
  return { root: dir, exists: existsDir(dir) };
}

// The game's mod database (holds which mods are enabled). Lives under
// LocalAppData, not Documents. Note the sibling "...Civilization VII" folder has
// its own Mods.sqlite — never pick that one.
function getModsDb() {
  const { overrides: ov } = loadOverrides();
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const file = ov.modsDb || process.env.CIV6_MODS_DB ||
    path.join(local, 'Firaxis Games', GAME_DIR, 'Mods.sqlite');
  let exists = false;
  try { exists = fs.statSync(file).isFile(); } catch (_) { /* missing */ }
  return { path: file, exists };
}

// The game's log folder (Database.log, Modding.log) and cache folder
// (DebugGameplay.sqlite). Both live under the Local-side Firaxis root, not
// Documents. Same shape as getSavesDir: { root, exists }.
function getLogsDir() {
  const { overrides: ov } = loadOverrides();
  const dir = ov.logsDir || process.env.CIV6_LOGS_DIR || path.join(localGamesRoot(), 'Logs');
  return { root: dir, exists: existsDir(dir) };
}

function getCacheDir() {
  const { overrides: ov } = loadOverrides();
  const dir = ov.cacheDir || process.env.CIV6_CACHE_DIR || path.join(localGamesRoot(), 'Cache');
  return { root: dir, exists: existsDir(dir) };
}

module.exports = {
  getSources, getSavesDir, getModsDb, getLogsDir, getCacheDir,
  myGamesRoot, localGamesRoot, toNativePath,
  overridesFile, overridesStatus, writeOverrides,
};
