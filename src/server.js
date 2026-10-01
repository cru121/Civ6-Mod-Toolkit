'use strict';

// Civ6 Mod Toolkit: local web server + browser UI (dashboard, .Civ6Cfg editor,
// mod manager). Binds to 127.0.0.1 only.
//
//   npm start            # starts on http://127.0.0.1:8673 and opens a browser
//   PORT=1234 npm start  # custom port

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const paths = require('./paths');
const cfg = require('./civ6cfg');
const { scanMods, normId } = require('./modinfo');
const inventory = require('./inventory');
const editor = require('./editor');
const civ6save = require('./civ6save');
const { readModState, readModDetails, applyChanges } = require('./modsdb');
const { gameStatus } = require('./game');

const { version: VERSION } = require('../package.json');
const PORT = parseInt(process.env.PORT, 10) || 8673;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');

// -------- helpers -----------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    req.on('error', reject);
  });
}

function isConfigPath(p) {
  return typeof p === 'string' && /\.Civ6Cfg$/i.test(p);
}

function listConfigs() {
  const saves = paths.getSavesDir();
  const out = [];
  if (saves.exists) {
    for (const f of fs.readdirSync(saves.root)) {
      if (!/\.Civ6Cfg$/i.test(f)) continue;
      const full = path.join(saves.root, f);
      let mods = null;
      try { mods = cfg.listMods(fs.readFileSync(full)).mods.length; } catch (_) { /* skip */ }
      out.push({ name: f, path: full, mods });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { savesRoot: saves.root, savesExists: saves.exists, configs: out };
}

// Saves live in the Saves/Single folder and one level of subfolders (auto/, ...).
function listSaves() {
  const saves = paths.getSavesDir();
  const out = [];
  if (saves.exists) {
    const scan = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !rel) scan(full, e.name);
        else if (e.isFile() && /\.Civ6Save$/i.test(e.name)) {
          const st = fs.statSync(full);
          out.push({ name: e.name, folder: rel, path: full, size: st.size, modified: st.mtimeMs });
        }
      }
    };
    try { scan(saves.root, ''); } catch (_) { /* unreadable folder: show what we have */ }
  }
  out.sort((a, b) => b.modified - a.modified);
  return { savesRoot: saves.root, savesExists: saves.exists, saves: out };
}

// Only .Civ6Save files inside the saves folder may be read or changed.
function isSavePath(p) {
  if (typeof p !== 'string' || !/\.Civ6Save$/i.test(p)) return false;
  const root = path.resolve(paths.getSavesDir().root) + path.sep;
  return path.resolve(p).toLowerCase().startsWith(root.toLowerCase());
}

// A save's mods, each classified for the save editor:
//   official - DLC / expansion content (removing it would break the save)
//   ui       - AffectsSavedGames=0: not part of the saved game state, safe to drop
//   gameplay - changes game rules/content: may be baked into the save
//   unknown  - not installed, so we can't tell
function saveMods(buffer) {
  const { mods, blockKeys } = civ6save.listMods(buffer);
  const installed = new Map(scanMods(paths.getSources()).map((m) => [m.idNorm, m]));
  const modsDb = paths.getModsDb();
  const dlc = new Map(); // official content: idNorm -> display name
  if (modsDb.exists) {
    const st = readModState(modsDb.path);
    for (const d of st.mods) if (d.source === 'dlc' || d.source === 'base') dlc.set(d.idNorm, d.name);
  }
  const out = mods.map((m) => {
    const f = installed.get(m.idNorm);
    const title = inventory.humanTitle(m.title);
    let kind = 'unknown';
    if (dlc.has(m.idNorm) || (!f && /^LOC_[A-Z0-9_]+$/.test(title))) kind = 'official';
    else if (f) kind = f.affectsSavedGames === false ? 'ui' : 'gameplay';
    const name = f ? f.name : (dlc.get(m.idNorm) || title);
    return { id: m.id, idNorm: m.idNorm, name, kind, installed: !!f, source: f ? f.type : null, blocks: m.blocks };
  });
  return { blockKeys, mods: out };
}

// Everything the mod manager shows: the game's database joined with the mod
// folders on disk. Mods found on disk but not yet in the database (the game
// hasn't rescanned) are listed with scanned=false and can't be toggled.
function modList() {
  const installed = scanMods(paths.getSources());
  const modsDb = paths.getModsDb();
  const st = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
  const disk = new Map(installed.map((m) => [m.idNorm, m]));
  const out = [];
  const isLoc = (n) => !n || /^LOC_[A-Z0-9_]+$/i.test(n);
  for (const d of st.mods) {
    // Base-game scenarios/maps and entries the game hides aren't user-facing.
    if (d.source === 'base' || d.hidden || !/\.modinfo$/i.test(d.path)) continue;
    const f = disk.get(d.idNorm);
    out.push({
      id: d.modId,
      idNorm: d.idNorm,
      name: isLoc(d.name) && f ? f.name : d.name,
      source: f ? f.type : d.source,
      enabled: d.disabled == null ? null : !d.disabled,
      scanned: true,
      teaser: d.teaser,
      workshopId: f ? f.workshopId || null : null,
      folder: f ? f.folder : null,
      requires: d.requires,
      blocks: d.blocks,
    });
  }
  if (st.ok) {
    const inDb = new Set(st.mods.map((m) => m.idNorm));
    for (const f of installed) {
      if (inDb.has(f.idNorm)) continue;
      out.push({
        id: f.id, idNorm: f.idNorm, name: f.name, source: f.type, enabled: null, scanned: false, teaser: null,
        workshopId: f.workshopId || null, folder: f.folder, requires: [], blocks: [],
      });
    }
  }
  const plain = (n) => n.replace(/\[[^\]]*\]/g, '').trim(); // sort without Civ [COLOR_*] markup
  out.sort((a, b) => plain(a.name).localeCompare(plain(b.name), undefined, { sensitivity: 'base' }));
  return { modsDb, ok: st.ok, error: st.error || null, activeGroup: st.activeGroup || null, mods: out };
}

// Size, file count and newest modification time of a mod folder.
function folderStats(dir) {
  const st = { files: 0, bytes: 0, modified: 0 };
  (function walk(d, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      try {
        const s = fs.statSync(full);
        st.files++; st.bytes += s.size; st.modified = Math.max(st.modified, s.mtimeMs);
      } catch (_) { /* skip */ }
    }
  })(dir, 0);
  return st;
}

// -------- API ---------------------------------------------------------------

async function handleApi(req, res, url) {
  // GET /api/state -> paths, config list, installed inventory
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sources = paths.getSources();
    const installed = scanMods(sources);
    return send(res, 200, {
      sources,
      saves: paths.getSavesDir(),
      ...listConfigs(),
      installed: installed.map((m) => ({ id: m.id, idNorm: m.idNorm, name: m.name, type: m.type })),
    });
  }

  // GET /api/dashboard -> counts, folder setup, game status
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    const sources = paths.getSources();
    const installed = scanMods(sources);
    const modsDb = paths.getModsDb();
    const dbState = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
    const byNorm = new Map(dbState.mods.map((m) => [m.idNorm, m]));

    // Totals come from the folders on disk; "enabled" from the game's database.
    const count = (type) => {
      const mods = installed.filter((m) => m.type === type);
      return {
        total: mods.length,
        enabled: mods.filter((m) => { const d = byNorm.get(m.idNorm); return d && d.disabled === false; }).length,
      };
    };
    const official = dbState.mods.filter((m) => m.source === 'dlc');
    const { configs } = listConfigs();
    return send(res, 200, {
      version: VERSION,
      sources,
      saves: paths.getSavesDir(),
      modsDb: { ...modsDb, ok: dbState.ok, error: dbState.error || null, activeGroup: dbState.activeGroup || null },
      game: await gameStatus(),
      counts: {
        workshop: count('workshop'),
        local: count('local'),
        dlc: { total: official.length, enabled: official.filter((m) => m.disabled === false).length },
        configs: configs.length,
      },
      // Installed on disk but not yet in the game's database (game hasn't
      // rescanned since they were added) - can't be toggled until it has.
      unscanned: dbState.ok
        ? installed.filter((m) => !byNorm.has(m.idNorm)).map((m) => ({ id: m.id, name: m.name, type: m.type }))
        : [],
    });
  }

  // GET /api/mods -> mod manager list
  if (req.method === 'GET' && url.pathname === '/api/mods') {
    const list = modList();
    return send(res, 200, { ...list, game: await gameStatus() });
  }

  // GET /api/mods/details?id=... -> everything the details panel shows
  if (req.method === 'GET' && url.pathname === '/api/mods/details') {
    const idNorm = normId(url.searchParams.get('id'));
    const list = modList();
    const mod = list.mods.find((m) => m.idNorm === idNorm);
    if (!mod) return send(res, 404, { error: 'mod not found' });
    const inConfigs = [];
    for (const c of listConfigs().configs) {
      try {
        if (cfg.listMods(fs.readFileSync(c.path)).mods.some((m) => normId(m.id) === idNorm)) inConfigs.push(c.name);
      } catch (_) { /* unreadable config: skip */ }
    }
    return send(res, 200, {
      mod,
      db: list.ok ? readModDetails(list.modsDb.path, mod.id) : null,
      disk: mod.folder ? { folder: mod.folder, ...folderStats(mod.folder) } : null,
      requiredBy: list.mods.filter((m) => m.requires.some((r) => r.id === idNorm)).map((m) => ({ id: m.idNorm, name: m.name, enabled: m.enabled })),
      blockedBy: list.mods.filter((m) => m.blocks.some((r) => r.id === idNorm)).map((m) => ({ id: m.idNorm, name: m.name, enabled: m.enabled })),
      inConfigs,
    });
  }

  // POST /api/mods/apply { changes:[{ id, enabled }] } -> write enable flags
  if (req.method === 'POST' && url.pathname === '/api/mods/apply') {
    const { changes } = await readBody(req);
    if (!Array.isArray(changes) || !changes.length) return send(res, 400, { error: 'no changes' });
    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then apply your changes.' });

    const list = modList();
    if (!list.ok) return send(res, 400, { error: list.error });
    const byNorm = new Map(list.mods.map((m) => [m.idNorm, m]));
    const clean = [];
    for (const c of changes) {
      const m = byNorm.get(normId(c && c.id));
      if (!m) return send(res, 400, { error: `unknown mod: ${c && c.id}` });
      if (!m.scanned) return send(res, 400, { error: `"${m.name}" can't be changed until the game has scanned it (start Civ6 once).` });
      if (m.enabled == null) return send(res, 400, { error: `"${m.name}" isn't in the game's active mod group, so it can't be turned on or off.` });
      clean.push({ modId: m.id, enabled: !!c.enabled });
    }
    try {
      const r = applyChanges(list.modsDb.path, clean);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // GET /api/saves -> .Civ6Save files (newest first)
  if (req.method === 'GET' && url.pathname === '/api/saves') {
    return send(res, 200, listSaves());
  }

  // GET /api/save-mods?path=... -> the mods recorded in one save
  if (req.method === 'GET' && url.pathname === '/api/save-mods') {
    const p = url.searchParams.get('path');
    if (!isSavePath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid save path' });
    try {
      const buf = fs.readFileSync(p);
      return send(res, 200, { path: p, name: path.basename(p), size: buf.length, editable: civ6save.roundTrips(buf), ...saveMods(buf) });
    } catch (e) {
      return send(res, 500, { error: `parse failed: ${e.message}` });
    }
  }

  // POST /api/save-edit { path, remove:[id], mode:'new'|'overwrite', newName } -> drop mods from a save
  if (req.method === 'POST' && url.pathname === '/api/save-edit') {
    const { path: p, remove = [], mode = 'new', newName } = await readBody(req);
    if (!isSavePath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid save path' });
    if (!Array.isArray(remove) || !remove.length) return send(res, 400, { error: 'no mods selected' });
    try {
      const original = fs.readFileSync(p);
      const info = saveMods(original);
      const byNorm = new Map(info.mods.map((m) => [m.idNorm, m]));
      for (const id of remove) {
        const m = byNorm.get(normId(id));
        if (!m) return send(res, 400, { error: `mod not in this save: ${id}` });
        if (m.kind === 'official') return send(res, 400, { error: `"${m.name}" is official game content and can't be removed from a save.` });
      }
      const edited = civ6save.applyRemoval(original, remove);

      let outPath = p;
      if (mode === 'new') {
        let base = path.basename(String(newName || '').trim());
        if (!base) return send(res, 400, { error: 'newName required for "new" mode' });
        if (!/\.Civ6Save$/i.test(base)) base += '.Civ6Save';
        outPath = path.join(path.dirname(p), base);
        if (fs.existsSync(outPath)) return send(res, 409, { error: `file already exists: ${base}` });
      }
      const backupPath = mode === 'overwrite' ? editor.backupFile(p) : null;
      editor.atomicWrite(outPath, edited);
      return send(res, 200, {
        ok: true, outPath, backupPath, removed: remove.length,
        modsBefore: info.mods.length, modsAfter: civ6save.listMods(edited).mods.length,
        bytesBefore: original.length, bytesAfter: edited.length,
      });
    } catch (e) {
      return send(res, 500, { error: e.message, problems: e.problems || null });
    }
  }

  // GET /api/game -> is Civ6 running (polled by the UI)
  if (req.method === 'GET' && url.pathname === '/api/game') {
    return send(res, 200, await gameStatus());
  }

  // GET /api/config?path=... -> enabled + available-to-add for one config
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const p = url.searchParams.get('path');
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });
    const installed = scanMods(paths.getSources());
    let view;
    try { view = inventory.configView(fs.readFileSync(p), installed); }
    catch (e) { return send(res, 500, { error: `parse failed: ${e.message}` }); }
    return send(res, 200, { path: p, name: path.basename(p), ...view });
  }

  // POST /api/paths -> persist overrides to civ6-paths.json
  if (req.method === 'POST' && url.pathname === '/api/paths') {
    const body = await readBody(req);
    const file = path.join(__dirname, '..', 'civ6-paths.json');
    const obj = {};
    if (body.localMods) obj.localMods = body.localMods;
    if (body.workshop) obj.workshop = body.workshop;
    if (body.saves) obj.saves = body.saves;
    if (body.modsDb) obj.modsDb = body.modsDb;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return send(res, 200, { ok: true, file });
  }

  // POST /api/save -> apply edits
  if (req.method === 'POST' && url.pathname === '/api/save') {
    const body = await readBody(req);
    const { path: p, add = [], remove = [], mode = 'overwrite', newName } = body;
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });

    const installed = scanMods(paths.getSources());
    const byNorm = new Map(installed.map((m) => [m.idNorm, m]));
    const adds = [];
    for (const id of add) {
      const m = byNorm.get(normId(id));
      if (!m) return send(res, 400, { error: `mod not installed: ${id}` });
      adds.push({ id: m.id, name: m.name });
    }

    let outPath = p;
    if (mode === 'new') {
      let base = String(newName || '').trim();
      base = path.basename(base); // no directory traversal
      if (!base) return send(res, 400, { error: 'newName required for "new" mode' });
      if (!/\.Civ6Cfg$/i.test(base)) base += '.Civ6Cfg';
      outPath = path.join(path.dirname(p), base);
      if (fs.existsSync(outPath)) return send(res, 409, { error: `file already exists: ${base}` });
    }

    try {
      const summary = editor.saveConfig(p, {
        adds,
        removes: remove,
        outPath,
        backup: mode === 'overwrite',
      });
      return send(res, 200, { ok: true, summary });
    } catch (e) {
      return send(res, 500, { error: e.message, problems: e.problems || null });
    }
  }

  // POST /api/delete -> back up then delete a config file
  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = await readBody(req);
    const p = body.path;
    if (!isConfigPath(p) || !fs.existsSync(p)) return send(res, 400, { error: 'invalid config path' });
    try {
      const backupPath = editor.backupFile(p); // recoverable delete
      fs.unlinkSync(p);
      return send(res, 200, { ok: true, backupPath });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/shutdown -> stop the server (used by the launcher's menu)
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    send(res, 200, { ok: true });
    console.log('Civ6 Mod Toolkit stopped.');
    setTimeout(() => process.exit(0), 100); // let the response go out first
    return;
  }

  return send(res, 404, { error: 'not found' });
}

// -------- static files ------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// -------- server ------------------------------------------------------------

// The API changes files on disk, so only our own page (and local tools such as
// the launcher, which send no Origin) may call it. Checking Host blocks DNS
// rebinding; requiring a JSON content type on POST forces a CORS preflight for
// any cross-site request, which we never answer; checking Origin covers the rest.
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function apiAllowed(req) {
  if (!OWN_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.replace(/^https?:\/\//i, '').toLowerCase())) return false;
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/') && !apiAllowed(req)) return send(res, 403, { error: 'forbidden' });
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const addr = `http://${HOST}:${PORT}`;

function openBrowser() {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', addr], () => {});
  else if (process.platform === 'darwin') execFile('open', [addr], () => {});
  else execFile('xdg-open', [addr], () => {});
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running (e.g. launcher double-clicked twice) — just reopen the tab.
    console.log(`Civ6 Mod Toolkit is already running at ${addr} — opening browser.`);
    openBrowser();
    process.exit(0);
  }
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Civ6 Mod Toolkit running at ${addr}`);
  if (!process.env.CIV6_LAUNCHER) console.log('Press Ctrl+C to stop.'); // the launcher has its own menu
  openBrowser();
});
