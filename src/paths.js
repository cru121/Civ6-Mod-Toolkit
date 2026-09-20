'use strict';

// Resolves where Civ6 mods live. Guesses sensible Windows defaults, but every
// path is overridable so the eventual UI can let the user fix them by hand.
//
// Override precedence (highest first):
//   1. civ6-paths.json in the project root (or CIV6_PATHS_FILE)
//   2. env vars CIV6_LOCAL_MODS / CIV6_WORKSHOP / CIV6_SAVES
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

// --- Assemble sources -------------------------------------------------------

function loadOverrides() {
  const file = process.env.CIV6_PATHS_FILE || path.join(__dirname, '..', 'civ6-paths.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function getSources() {
  const ov = loadOverrides();
  const sources = [];

  // Local mods
  const localRoot = ov.localMods || process.env.CIV6_LOCAL_MODS || path.join(myGamesRoot(), 'Mods');
  sources.push({ type: 'local', label: 'Local / custom mods', root: localRoot, exists: existsDir(localRoot) });

  // Workshop mods (may be several library roots; overrides win if provided)
  let wsRoots;
  if (ov.workshop) wsRoots = Array.isArray(ov.workshop) ? ov.workshop : [ov.workshop];
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
  const ov = loadOverrides();
  const dir = ov.saves || process.env.CIV6_SAVES || path.join(myGamesRoot(), 'Saves', 'Single');
  return { root: dir, exists: existsDir(dir) };
}

module.exports = { getSources, getSavesDir, myGamesRoot };
