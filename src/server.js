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
const { readModState, applyChanges } = require('./modsdb');
const { gameStatus } = require('./game');

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
        id: f.id, idNorm: f.idNorm, name: f.name, source: f.type, enabled: null, scanned: false,
        workshopId: f.workshopId || null, folder: f.folder, requires: [], blocks: [],
      });
    }
  }
  const plain = (n) => n.replace(/\[[^\]]*\]/g, '').trim(); // sort without Civ [COLOR_*] markup
  out.sort((a, b) => plain(a.name).localeCompare(plain(b.name), undefined, { sensitivity: 'base' }));
  return { modsDb, ok: st.ok, error: st.error || null, activeGroup: st.activeGroup || null, mods: out };
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
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
  console.log('Press Ctrl+C to stop.');
  openBrowser();
});
