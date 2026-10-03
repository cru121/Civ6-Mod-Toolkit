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
const savelist = require('./savelist');
const { listSaves, isSavePath, saveMods } = savelist;
const {
  readModState, readModDetails, applyChanges,
  listGroups, createGroup, duplicateGroup, renameGroup, deleteGroup, activateGroup, previewGroup,
  exportGroup, importGroup, registerMods, findUnregistered,
  findRemoved, removeMods, classifyPath, modFolderFault,
} = require('./modsdb');
const { gameStatus } = require('./game');
const labelStore = require('./labels');
const setupStore = require('./gamesetup');
const loOrder = require('./loadorder');
const shadowing = require('./shadowing');
const packaging = require('./packaging');
const conflictReplay = require('./phase9-conflict-replay');
const { modList } = require('./modlist');

const { version: VERSION } = require('../package.json');
const STARTED = new Date().toISOString();
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

// Mod group ids are the integer primary key. Anything else is no group.
function groupId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
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

// What the last sync did, for the dashboard to report. Held in memory only -
// it describes one run, and the next run overwrites it.
let lastSync = null;

// Bring the game's database up to date with the mod folders: register anything
// the game has never scanned, and give anything it knows but that has no row in
// the profile in use a row in every profile.
//
// NOTHING is ever switched on. A newly added mod comes up visible and tickable
// but off, which is the state every mod is already in inside a profile the
// toolkit created. That is the whole reason this is safe to run without asking:
// it can put a mod in front of you, but it cannot change what the game loads.
//
// Runs at startup and whenever the dashboard's Rescan is used, so subscribing
// to mods after the toolkit is already open is handled the same way. Every
// write is refused while Civ6 runs, and the reason is returned rather than
// attempted and failed.
async function syncMods() {
  const run = { at: new Date().toISOString(), added: [], failed: [], skipped: null, error: null, pending: 0, backupPath: null };
  lastSync = run;

  const game = await gameStatus();
  if (game.running) {
    run.skipped = 'civ6-running';
    return run;
  }
  const modsDb = paths.getModsDb();
  if (!modsDb.exists) {
    run.error = 'Mod database not found.';
    return run;
  }
  const todo = findUnregistered(modsDb.path, paths.getSources());
  if (!todo.ok) {
    run.error = todo.error;
    return run;
  }
  run.pending = todo.count;
  // Nothing new: return before registerMods so no backup is made. Otherwise
  // every Rescan click would spend one of the ten backups the app keeps.
  if (!todo.count) return run;

  const active = listGroups(modsDb.path).active;
  if (!active) {
    run.error = 'the mod database has no mod group';
    return run;
  }
  try {
    const r = registerMods(modsDb.path, todo.pending.map((p) => p.path), false, active.id);
    run.added = r.registered.map((x) => ({ modId: x.modId, name: x.name, isNew: x.isNew }));
    run.failed = r.failed.map((f) => ({ file: path.basename(f.file), error: f.error }));
    run.backupPath = r.backupPath;
  } catch (e) {
    // registerMods restores its own backup and says so in the message.
    run.error = e.message;
  }
  return run;
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

// GET /api/load-order -> one profile's load order, as a flat sorted list.
//
// Read-only. The whole page is built from this, and there is deliberately no
// write route anywhere near it: changing a value is problem 2 and lives at
// /api/load-overrides, which is a different screen. phase7 asserts that this
// route is a GET and that no POST under /api/load-order exists, because
// "read-only" erodes quietly as features get added.
function loadOrderResponse(modsDb, url) {
  const num = (name) => {
    const v = url.searchParams.get(name);
    return v != null && /^\d+$/.test(v) ? Number(v) : null;
  };
  try {
    return loOrder.profileLoadOrder(modsDb.path, { groupId: num('profile'), compareGroupId: num('compare') });
  } catch (e) {
    return {
      ok: false, error: e.message, groups: [], profile: null,
      bands: [], undeclared: [], undeclaredTotal: 0, unmatched: [], summary: {},
    };
  }
}

// Every label write answers with the refreshed state, so the page updates in
// place instead of refetching 421 mods. `moved`, `merged` and `removed` are set
// only by the rename and delete routes; JSON.stringify drops the undefined ones,
// so one shape serves all three rather than three near-identical bodies.
function labelResponse(v, game) {
  return {
    ok: true, game,
    labels: v.labels, labelCounts: v.counts, labelNames: v.names, labelsError: v.error,
    moved: v.moved, merged: v.merged, removed: v.removed,
  };
}

// The prune set is the same question in all three write routes: only prune
// against a mod list we can vouch for, which needs the game closed. Kept here so
// a fourth write cannot answer it differently, and given the caller's list
// because modList() re-reads the database and rescans the mod folders - too
// expensive to run twice for one click.
function labelPruneSet(list, running) {
  return list.ok && !running ? new Set(list.mods.map((m) => m.idNorm)) : null;
}

// -------- Assumed game setup ("I always play with X on") ----------------------
//
// GET /api/game-setup -> the option catalog mined from the library (rulesets,
// game modes and config values actions actually gate on, each with its
// gated-action count) plus the asserted options from game-setup.json.
//
// POST /api/game-setup { key, on } -> assert (on true) or withdraw (on false)
// one option. POST /api/game-setup/clear -> withdraw every assertion.
//
// Like labels, and unlike every mod-database write, these are NEVER refused
// while Civ6 runs: game-setup.json is a file the game has never heard of, and
// the store only changes verdicts, never the game database. Refusing would
// copy a rule whose reason does not apply.
//
// Every answer carries the refreshed state, so the panel updates in place
// instead of refetching - the same shape the label writes use.

// The catalog the panel offers: distinct setup options actually gating
// library actions, mined at request time so the list can neither drift from
// the library nor invent an option. Read-only open, like every other GET -
// works while Civ6 runs. A missing database gates nothing: empty options with
// a reason, never a failed request.
function gameSetupCatalog() {
  const modsDb = paths.getModsDb();
  if (!modsDb.exists) return { options: [], error: 'Mod database not found.' };
  const db = loOrder.openDb(modsDb.path);
  try {
    return setupStore.buildCatalog(db);
  } finally {
    db.close();
  }
}

// The known set a store read or write prunes against: only prune against a
// catalog we could actually mine. An unvouched set prunes nothing, so a
// missing database never costs assertions.
function gameSetupKnown(catalog) {
  if (!catalog || catalog.error) return null;
  return new Set(catalog.options.map((o) => o.key));
}

function gameSetupResponse(view, catalog, game) {
  return {
    ok: true, game,
    options: catalog.options, catalogError: catalog.error,
    asserted: view.asserted, keys: view.keys,
    error: view.error, unusable: !!view.unusable, pruned: view.pruned,
  };
}

// -------- Conflict diagnosis (read-only reports) ----------------------------------
//
// Scope: the ACTIVE profile only. The shadowing backend scopes itself to the
// active group internally (enabledModRowIds(activeGroupId)), so a per-profile
// parameter would need a second enumeration implementation to honour - this
// keeps one honest scope instead of two half-matching ones.
//
// Shadowing opens Mods.sqlite read-only and works while Civ6 runs, like every
// other GET. Replay copies DebugGameplay.sqlite into the OS temp dir and
// replays there; the live file's bytes and mtime are never touched, and the
// report names the temp copy used.

// The active profile's id and name, or null when the database names none.
function conflictActiveProfile(db) {
  try {
    const g = db.prepare('SELECT ModGroupRowId AS id, Name AS name FROM ModGroups WHERE Selected = 1 LIMIT 1').get();
    return g ? { id: g.id, name: g.name } : null;
  } catch (_) {
    return null;
  }
}

function conflictShadowing(modsDbPath) {
  const db = loOrder.openDb(modsDbPath);
  try {
    const profile = conflictActiveProfile(db);
    if (!profile) return { ok: false, error: 'the mod database has no active profile' };
    const contested = shadowing.enumerateContested(db);
    const results = shadowing.resolveWinners(db, contested);
    const envelope = shadowing.buildEnvelope(db);
    return {
      ok: true,
      profile,
      envelope,
      envelopeLine: shadowing.formatEnvelope(envelope),
      contested: results,
    };
  } finally {
    db.close();
  }
}

// Static packaging findings over Mods.sqlite: files no action references,
// actions loading one .sql file into the wrong database, mods sharing one
// id, and database files the game skips. Scope is the ACTIVE profile's
// enabled mods, in load order — the backend (packaging.js) scopes itself to
// the active group internally, the same scoping as the shadowing report, so
// a switched-off mod's findings never reach the page: switched off, it
// cannot affect the game. The profile and the enabled count ride along so
// the panel states its scope instead of implying the whole library.
//
// Read-only like every other GET: packaging opens Mods.sqlite read-only and
// only lists mod folders, never writes, so it works while Civ6 runs. The
// backend (packaging.js) is reused, not reimplemented; display names ride
// along on every finding so the page renders names, never raw ids.
function conflictPackaging(modsDbPath) {
  const db = loOrder.openDb(modsDbPath);
  try {
    const profile = conflictActiveProfile(db);
    const enabled = shadowing.enabledModRowIds(db, shadowing.activeGroupId(db));
    const warnings = packaging.collectPackagingWarnings(db);
    return { ok: true, profile, enabledMods: enabled ? enabled.size : null, warnings };
  } finally {
    db.close();
  }
}

// Where the game keeps the database replay copies, and the log it is
// validated against. Both overridable for tests and relocated installs.
function debugGameplayCandidates() {
  const out = [];
  if (process.env.CIV6_DEBUG_GAMEPLAY) out.push(process.env.CIV6_DEBUG_GAMEPLAY);
  const root = paths.myGamesRoot();
  if (root) {
    out.push(path.join(root, 'Cache', 'DebugGameplay.sqlite'));
    out.push(path.join(root, 'DebugGameplay.sqlite'));
  }
  const localRoot = paths.localGamesRoot ? paths.localGamesRoot() : null;
  if (localRoot) {
    out.push(path.join(localRoot, 'Cache', 'DebugGameplay.sqlite'));
    out.push(path.join(localRoot, 'DebugGameplay.sqlite'));
  }
  return out;
}

function findDebugGameplay() {
  for (const p of debugGameplayCandidates()) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

// Where the game keeps Database.log, overridable for tests and relocated
// installs. Mirrors debugGameplayCandidates: env first, then the
// Documents-side root, then the Local-side root
// (%LOCALAPPDATA%\Firaxis Games\<GAME_DIR>), Logs dir before the bare root.
function databaseLogCandidates() {
  const out = [];
  if (process.env.CIV6_DATABASE_LOG) out.push(process.env.CIV6_DATABASE_LOG);
  const root = paths.myGamesRoot();
  if (root) out.push(path.join(root, 'Logs', 'Database.log'));
  const localRoot = paths.localGamesRoot ? paths.localGamesRoot() : null;
  if (localRoot) {
    out.push(path.join(localRoot, 'Logs', 'Database.log'));
    out.push(path.join(localRoot, 'Database.log'));
  }
  return out;
}

function findDatabaseLog() {
  for (const p of databaseLogCandidates()) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

// Where the game keeps Modding.log, read beside Database.log for the
// log-pairing bracketing timeline (same ms clock, nearest-preceding Loading
// line). Same shape as the Database.log lookup: env first, then the
// Documents-side root, then the Local-side root, Logs dir before bare root.
function moddingLogCandidates() {
  const out = [];
  if (process.env.CIV6_MODDING_LOG) out.push(process.env.CIV6_MODDING_LOG);
  const root = paths.myGamesRoot();
  if (root) out.push(path.join(root, 'Logs', 'Modding.log'));
  const localRoot = paths.localGamesRoot ? paths.localGamesRoot() : null;
  if (localRoot) {
    out.push(path.join(localRoot, 'Logs', 'Modding.log'));
    out.push(path.join(localRoot, 'Modding.log'));
  }
  return out;
}

function findModdingLog() {
  for (const p of moddingLogCandidates()) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

// Caps so one click cannot replay the whole Steam library into a temp copy.
// Counted BEFORE anything runs: over the cap is a 400 naming the counts,
// never a truncated report that reads as complete.
const MAX_CONFLICT_FILES = 2000;
const MAX_CONFLICT_STATEMENTS = 100000;
// Database.log is read whole for the differential; past this it is a log
// archive, not a diagnosis input.
const MAX_CONFLICT_LOG_BYTES = 10 * 1024 * 1024;

// One component's gate in the replay backend's shape. Merges every linked
// criteria set the way readProfile does (items accumulate, Any comes from
// the first set); a component with no sets is ungated and replays.
function conflictGateOf(db, componentRowId) {
  const links = db.prepare('SELECT CriteriaRowId AS id FROM ComponentCriteria WHERE ComponentRowId = ? ORDER BY CriteriaRowId')
    .all(componentRowId);
  if (!links.length) return null;
  const sets = [];
  for (const l of links) {
    const k = db.prepare('SELECT Any AS any FROM Criteria WHERE CriteriaRowId = ?').get(l.id);
    if (k) sets.push({ any: !!k.any, id: l.id });
  }
  if (!sets.length) return null;
  const conditions = [];
  for (const s of sets) {
    for (const c of db.prepare('SELECT CriterionRowId AS id, CriterionType AS type, Inverse AS inverse FROM Criterion WHERE CriteriaRowId = ? ORDER BY CriterionRowId').all(s.id)) {
      const props = db.prepare('SELECT Name AS name, Value AS value FROM CriterionProperties WHERE CriterionRowId = ?').all(c.id);
      const byName = {};
      for (const p of props) byName[p.name] = p.value;
      conditions.push({ type: c.type, value: byName.Value === undefined ? null : byName.Value, inverse: !!c.inverse });
    }
  }
  if (!conditions.length) return null;
  return { any: sets[0].any, conditions };
}

// The author's position for ordering: the correctly spelled row, else a
// misspelling, else null (undeclared sorts last - its order is uncontrolled).
// Mirrors currentValue/declaredValueOf so replay and the load-order view
// cannot disagree about what a mod asked for.
function conflictEffectiveOf(db, componentRowId) {
  const row = db.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
    .get(componentRowId);
  const raw = row ? row.v : null;
  if (raw === null || raw === undefined) {
    for (const name of ['LaodOrder', 'LoadingOrder']) {
      const alt = db.prepare('SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = ?')
        .get(componentRowId, name);
      if (alt) return alt.v;
    }
    return null;
  }
  return raw;
}

// The mod set replay executes: enabled UpdateDatabase/UpdateText actions of
// the active profile, mods ordered by their smallest declared value
// (undeclared mods last - nothing controls their order), files in row order,
// statements in file order. Only .sql/.xml ride along; anything else the
// action carries is counted as skipped-non-db, never executed. Files that
// cannot be read are listed as unreadable with their reason and skipped.
function collectConflictModSet(db) {
  const profile = conflictActiveProfile(db);
  if (!profile) throw new Error('the mod database has no active profile');
  const enabled = new Set(db.prepare(
    'SELECT ModRowId AS id FROM ModGroupItems WHERE ModGroupRowId = ? AND Disabled = 0'
  ).all(profile.id).map((r) => r.id));
  const installed = db.prepare('SELECT ModId AS id FROM Mods').all().map((r) => String(r.id));
  const modRow = new Map(db.prepare('SELECT ModRowId AS rowId, ModId AS modId FROM Mods').all()
    .map((r) => [r.rowId, String(r.modId)]));
  const modDir = new Map();
  for (const [rowId] of modRow) {
    const f = loOrder.modFile(db, rowId);
    modDir.set(rowId, f ? path.dirname(f.path) : null);
  }

  const comps = db.prepare(
    `SELECT c.ComponentRowId AS cr, c.ModRowId AS modRowId, c.ComponentType AS type
       FROM Components c
      WHERE c.ComponentType IN ('UpdateDatabase', 'UpdateText')
      ORDER BY c.ComponentRowId`
  ).all().filter((c) => enabled.has(c.modRowId));

  const byMod = new Map();
  const unreadable = [];
  let skippedNonDb = 0;
  // Which enabled mods claim each database file path (ComponentFiles rows in
  // the replay's own action scope). Calibration divergence rows name the
  // owning mod(s) under each path, and a path two mods ship must list both.
  const claimants = new Map();
  for (const c of comps) {
    const modId = modRow.get(c.modRowId);
    const dir = modDir.get(c.modRowId);
    const files = db.prepare(
      `SELECT f.Path AS rel, f.FileRowId AS fr
         FROM ComponentFiles cf
         JOIN ModFiles f ON f.FileRowId = cf.FileRowId
        WHERE cf.ComponentRowId = ?
        ORDER BY f.FileRowId`
    ).all(c.cr);
    const eff = conflictEffectiveOf(db, c.cr);
    const num = eff === null || eff === undefined || String(eff).trim() === '' || !Number.isInteger(Number(String(eff).trim()))
      ? null : Number(String(eff).trim());
    const gate = conflictGateOf(db, c.cr);
    for (const f of files) {
      const rel = String(f.rel || '').replace(/\\/g, '/');
      if (!/\.(sql|xml)$/i.test(rel)) { skippedNonDb += 1; continue; }
      // Claimed whether or not its copy is readable: ownership is about the
      // ComponentFiles row, not the disk state checked below.
      if (!claimants.has(rel)) claimants.set(rel, new Set());
      claimants.get(rel).add(modId);
      if (!dir) {
        unreadable.push({ modId, file: rel, reason: 'the mod folder is not on disk' });
        continue;
      }
      const full = path.normalize(path.join(dir, rel));
      const inside = path.resolve(full).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)
        || path.resolve(full).toLowerCase() === path.resolve(dir).toLowerCase();
      if (!inside) {
        unreadable.push({ modId, file: rel, reason: 'the file points outside the mod folder' });
        continue;
      }
      let isFile = false;
      try { isFile = fs.statSync(full).isFile(); } catch (_) { /* absent */ }
      if (!isFile) {
        unreadable.push({ modId, file: rel, reason: 'the file is not on disk' });
        continue;
      }
      if (!byMod.has(modId)) byMod.set(modId, { modId, min: null, files: [] });
      const entry = byMod.get(modId);
      if (num !== null && (entry.min === null || num < entry.min)) entry.min = num;
      entry.files.push({ label: rel, filePath: full, gate });
    }
  }
  const modSet = [...byMod.values()]
    .filter((m) => m.files.length > 0)
    .sort((a, b) => {
      const am = a.min === null ? Infinity : a.min;
      const bm = b.min === null ? Infinity : b.min;
      if (am !== bm) return am - bm;
      return a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : 0;
    })
    .map((m) => ({ modId: m.modId, files: m.files.map(({ label, filePath, gate }) => ({ label, filePath, gate })) }));
  return {
    profile,
    modSet,
    gates: { enabled: installed.filter((id) => [...enabled].some((rowId) => modRow.get(rowId) === id)), installed },
    unreadable,
    skippedNonDb,
    fileClaimants: [...claimants].map(([file, modIds]) => ({ file, modIds: [...modIds] })),
  };
}

function conflictStageTotals(collected) {
  const totals = { xmlToSql: 0, doubleQuoteRewrite: 0, makeHashStub: 0, triggerAwareSplit: 0 };
  for (const f of (collected && collected.files) || []) {
    for (const s of f.stages || []) {
      if (s.stage === 'xml-to-sql' && s.outcome === 'transformed') totals.xmlToSql += 1;
      else if (s.stage === 'double-quote-rewrite' && s.outcome === 'transformed') totals.doubleQuoteRewrite += 1;
      else if (s.stage === 'make-hash-stub' && s.outcome === 'installed-at-replay') totals.makeHashStub += 1;
      else if (s.stage === 'splitter' && s.outcome === 'transformed') totals.triggerAwareSplit += 1;
    }
  }
  return totals;
}

// Log-pairing folder map for workshop-ID/mod-folder attribution: workshop ids
// from the installed workshop mods, absolute mod folders (workshop and local
// alike) as local prefixes so non-workshop-shaped paths still resolve, plus
// the backend's base-game heuristic for the rest. Never throws: an empty map
// leaves every path stated as unmapped, never dropped.
function conflictLogFolderMap() {
  let installed = [];
  try { installed = scanMods(paths.getSources()); } catch (_) { installed = []; }
  const workshop = {};
  const local = [];
  for (const m of installed) {
    if (!m) continue;
    if (m.workshopId != null && String(m.workshopId).trim() !== '') {
      workshop[String(m.workshopId)] = { modId: m.id, name: m.name };
    }
    if (m.folder) local.push({ folder: m.folder, modId: m.id, name: m.name });
  }
  return { workshop, local };
}

// Replay-side mod ids are GUIDs from the game database; resolve each to the
// installed display name for the report, falling back to the id itself.
function conflictModNameIndex() {
  const byId = new Map();
  try {
    for (const m of scanMods(paths.getSources())) {
      if (!m || !m.id) continue;
      if (!byId.has(m.id)) byId.set(m.id, m.name);
      const nn = normId(m.id);
      if (nn && !byId.has(nn)) byId.set(nn, m.name);
    }
  } catch (_) { /* names fall back to ids below */ }
  return byId;
}

function conflictDisplayName(modId, nameById) {
  if (modId == null) return null;
  if (modId === 'base-game') return 'Base game';
  return (nameById && (nameById.get(modId) || nameById.get(normId(modId)))) || String(modId);
}

// Modding.log Loading timeline for bracketing. Absent, oversized, or
// unreadable is an empty timeline, never a failed report: context and hint
// strengths still attribute, and unbracketable rows say so via their reason.
function readModdingLoadings() {
  const moddingPath = findModdingLog();
  if (!moddingPath) return [];
  try {
    if (fs.statSync(moddingPath).size > MAX_CONFLICT_LOG_BYTES) return [];
    return conflictReplay.parseModdingLog(fs.readFileSync(moddingPath, 'utf8'));
  } catch (_) {
    return [];
  }
}

// Collision rows name display names, never raw mod ids: winner/loser mods
// resolve through the installed display-name index, falling back to the mod
// id only when unresolvable (the mod-name-display fallback: the page renders
// modName with renderCivText, never raw markup). Same-mod pairs (every loser
// shares the winner's mod) are tagged and sort after cross-mod pairs; the
// collision count and the envelope are untouched.
function conflictCollisionDisplay(collisions, nameById) {
  const rows = (collisions || []).map((c) => {
    const winnerModId = c && c.winner ? c.winner.modId : null;
    const sameMod = !!(c && c.winner && Array.isArray(c.losers) && c.losers.length
      && c.losers.every((w) => w && w.modId === winnerModId));
    return {
      ...c,
      winner: c && c.winner ? { ...c.winner, modName: conflictDisplayName(c.winner.modId, nameById) } : c && c.winner,
      losers: ((c && c.losers) || []).map((w) => ({ ...w, modName: conflictDisplayName(w && w.modId, nameById) })),
      sameMod,
    };
  });
  // Stable: internal (same-mod) pairs after cross-mod pairs, replay order
  // within each half.
  rows.sort((a, b) => (a.sameMod ? 1 : 0) - (b.sameMod ? 1 : 0));
  return rows;
}

// Log-pairing follow-up: every skipped/stopped file row names its mod the way
// the mod manager shows it, resolved here so the page never renders a raw
// mod id. Additive: modName rides alongside modId; unknown mods fall back to
// the id itself (the mod-name-display fallback: render, never raw markup).
function withModDisplayNames(rows, nameById) {
  return (rows || []).map((r) => ({ ...r, modName: conflictDisplayName(r && r.modId, nameById) }));
}

// Calibration divergence rows name the owning mod(s) under each path: the
// claimant mod ids collected above, resolved to display names here so the
// page renders names, never raw ids (mod-name-display fallback: the id
// itself when unresolvable). Exact rel-path match first, then a basename
// match mirroring the calibration's own basename pairing; a path two mods
// ship lists both, deduped by mod id. Additive: assumedFirstMods /
// assumedSecondMods ride alongside the existing divergence label fields.
function conflictFileClaimants(fileClaimants, label, nameById) {
  const norm = String(label == null ? '' : label).replace(/\\/g, '/');
  const base = (norm.split('/').pop() || '').toLowerCase();
  if (!base) return [];
  const seen = new Set();
  const out = [];
  for (const c of fileClaimants || []) {
    const rel = String((c && c.file) || '');
    if (rel !== norm && (rel.split('/').pop() || '').toLowerCase() !== base) continue;
    for (const id of (c && c.modIds) || []) {
      if (id == null || seen.has(String(id))) continue;
      seen.add(String(id));
      out.push({ modId: id, modName: conflictDisplayName(id, nameById) });
    }
  }
  return out;
}

// Log-pairing 3.1: thread per-row attribution onto the existing differential
// rows using the backend's three-strength fallback (attributeErrorWithFallback
// owns the strengths; this only carries them). Agreements and replay-only rows
// name the replay mod - the replay is its own oracle - with agreements also
// carrying the log-side strength and log-attributed mod for cross-checking.
// Log-only rows name the log-attributed mod. Every row gains
// responsibleModId/responsibleModName plus strength; log-side rows also carry
// the full attribution (kind/reason/candidates) so the page states unmapped
// paths and same-ms ambiguity instead of dropping them.
function attributeDifferential(diff, entries, loadings, folderMap, nameById) {
  const byLine = new Map((entries || []).map((e) => [e.line, e]));
  const ofLogLine = (logLine) => {
    const entry = byLine.get(logLine) || null;
    if (!entry) {
      return {
        strength: 'unattributed', approximate: false,
        attribution: { kind: 'unattributed', modId: null, modName: null, workshopId: null, reason: 'no-log-entry' },
      };
    }
    return conflictReplay.attributeErrorWithFallback(entry, loadings, folderMap);
  };
  const replaySide = (row) => ({
    ...row,
    responsibleModId: row.modId || null,
    responsibleModName: row.modId ? conflictDisplayName(row.modId, nameById) : null,
  });
  const logSide = (row, fb) => {
    const attr = (fb && fb.attribution) || {};
    const modId = attr.modId || null;
    const hasCandidates = attr.kind === 'bracket-ambiguous'
      && Array.isArray(attr.candidates) && attr.candidates.length > 0;
    // An unattributed row must not carry an attributing strength: with no
    // named mod and no named candidates the strength is unattributed. The
    // original detail (file hint, reason, loading path) stays on attribution
    // for the page note, so nothing is lost by the relabel.
    const strength = (modId || hasCandidates) ? fb.strength : 'unattributed';
    return {
      ...row,
      responsibleModId: modId,
      responsibleModName: modId ? (attr.modName || conflictDisplayName(modId, nameById)) : null,
      strength,
      approximate: strength === 'unattributed' ? false : !!fb.approximate,
      attribution: attr,
    };
  };
  return {
    agreements: (diff.agreements || []).map((a) => {
      const fb = ofLogLine(a.logLine);
      const attr = fb.attribution || {};
      const base = replaySide(a);
      // The replay named the mod; the log side only cross-checks. When the
      // log names nothing, the row would otherwise pair a named mod with an
      // unattributed label, so it falls back to the replay strength.
      const strength = fb.strength === 'unattributed' ? 'replay' : fb.strength;
      return {
        ...base,
        strength,
        approximate: strength === 'replay' ? false : !!fb.approximate,
        attribution: attr,
        logModId: attr.modId || null,
        logModName: attr.modId ? (attr.modName || conflictDisplayName(attr.modId, nameById)) : null,
      };
    }),
    replayOnly: (diff.replayOnly || []).map((r) => ({
      ...replaySide(r),
      strength: 'replay',
      approximate: false,
    })),
    logOnly: (diff.logOnly || []).map((l) => logSide(l, ofLogLine(l.logLine))),
  };
}

async function conflictReplayReport(modsDbPath, { foreignKeys = false } = {}) {
  const debugPath = findDebugGameplay();
  if (!debugPath) {
    throw new Error('DebugGameplay.sqlite was not found (looked in the game Cache folder; set CIV6_DEBUG_GAMEPLAY to point at it)');
  }
  // Assumed game setup ("I always play with X on"), same prune pattern as the
  // setup routes: only prune against a catalog actually mined here, so a
  // missing database never costs assertions. Read on every replay so toggling
  // options moves live verdicts; an unreadable store reads as empty, never
  // half-applied, per the store's failure contract.
  const setupCatalog = gameSetupCatalog();
  const setupView = setupStore.readSetup(setupStore.gameSetupFile(), gameSetupKnown(setupCatalog));
  const db = loOrder.openDb(modsDbPath);
  let collected;
  let scope;
  try {
    scope = collectConflictModSet(db);
  } finally {
    db.close();
  }
  if (!scope.modSet.length) {
    throw new Error('the active profile has no database files to replay');
  }
  collected = conflictReplay.collectStatements(scope.modSet, { preprocess: true });
  const fileCount = collected.files.length;
  if (fileCount > MAX_CONFLICT_FILES || collected.total > MAX_CONFLICT_STATEMENTS) {
    throw new Error(`that profile is too large to replay here (${collected.total} statements in ${fileCount} files; limits are ${MAX_CONFLICT_STATEMENTS} statements / ${MAX_CONFLICT_FILES} files)`);
  }
  const { tmpDir, tempDbPath } = conflictReplay.createTempCopy(debugPath);
  let report;
  try {
    report = conflictReplay.replayOrdered(tempDbPath, collected, {
      foreignKeys,
      // Asserted values satisfy matching undecidable gates, flagged assumed
      // in gate reporting - never presented as measured.
      gates: { ...scope.gates, asserted: setupView.asserted },
      provenance: true,
    });
  } finally {
    conflictReplay.destroyTempCopy(tmpDir);
  }
  const envelope = conflictReplay.buildReplayEnvelope(report);
  const nameById = conflictModNameIndex();
  const folderMap = conflictLogFolderMap();
  const perFile = report.perFile.map((f) => ({
    modId: f.modId,
    modName: conflictDisplayName(f.modId, nameById),
    fileLabel: f.fileLabel,
    statements: f.statements,
    executed: f.executed,
    status: f.status,
    error: f.error,
    failedAt: f.failedAt,
    gate: f.gate || null,
    gateUnknown: !!f.gateUnknown,
    flags: conflictReplay.fileLimitationFlags(
      (collected.files.find((c) => c.modId === f.modId && c.fileLabel === f.fileLabel) || {}).stages),
  }));
  const limitationFlags = [...new Set((report.provenance.collisions || []).flatMap((c) => c.fidelityLimited))].sort();

  // Differential validation against Database.log, when the log is there to
  // read. Absent or oversized is reported, never silent and never fatal.
  // The Modding.log Loading timeline is read once here: it feeds both the
  // per-row bracketing below and the load-order calibration beside it.
  let differential;
  const loadings = readModdingLoadings();
  const logPath = findDatabaseLog();
  if (!logPath) {
    differential = { available: false, reason: 'Database.log was not found (looked in the game Logs folder; set CIV6_DATABASE_LOG to point at it)' };
  } else if (fs.statSync(logPath).size > MAX_CONFLICT_LOG_BYTES) {
    differential = { available: false, reason: `Database.log is larger than ${MAX_CONFLICT_LOG_BYTES} bytes`, logPath };
  } else {
    const entries = conflictReplay.parseDatabaseLog(fs.readFileSync(logPath, 'utf8'));
    const diff = conflictReplay.differentialValidate(report, entries, collected);
    const attributed = attributeDifferential(
      diff, entries, loadings, folderMap, nameById);
    differential = {
      available: true, logPath,
      agreements: attributed.agreements,
      replayOnly: attributed.replayOnly,
      logOnly: attributed.logOnly,
      replayErrors: diff.replayErrors,
      logErrors: diff.logErrors,
    };
  }

  // Load-order calibration against Modding.log, beside the differential.
  // Report-only: divergences are listed, replay assumptions stay as-is.
  // Absent or oversized is reported, never silent and never fatal.
  let calibration;
  const moddingPath = findModdingLog();
  if (!moddingPath) {
    calibration = { available: false, reason: 'Modding.log was not found (looked in the game Logs folder; set CIV6_MODDING_LOG to point at it)' };
  } else if (fs.statSync(moddingPath).size > MAX_CONFLICT_LOG_BYTES) {
    calibration = { available: false, reason: `Modding.log is larger than ${MAX_CONFLICT_LOG_BYTES} bytes`, logPath: moddingPath };
  } else {
    calibration = {
      available: true, logPath: moddingPath,
      ...conflictReplay.calibrateLoadOrder(collected.files, loadings),
    };
    // Owning mods under each divergence path, resolved server-side so the
    // page never maps ids to names itself. Additive: the existing divergence
    // label fields are untouched.
    for (const dv of calibration.divergences || []) {
      dv.assumedFirstMods = conflictFileClaimants(scope.fileClaimants, dv.assumedFirst, nameById);
      dv.assumedSecondMods = conflictFileClaimants(scope.fileClaimants, dv.assumedSecond, nameById);
    }
  }

  return {
    ok: true,
    profile: scope.profile,
    modsOn: scope.gates.enabled.length,
    tempCopy: tempDbPath,
    fkMode: report.fkMode,
    makeHashStub: report.makeHashStub,
    total: report.total,
    executed: report.executed,
    rolledBack: report.rolledBack,
    skippedGated: report.skippedGated,
    envelope,
    envelopeLine: conflictReplay.formatReplayEnvelope(envelope),
    collisions: conflictCollisionDisplay(report.provenance.collisions, nameById),
    limitationFlags,
    stages: conflictStageTotals(collected),
    gatedOut: withModDisplayNames(report.gatedOut, nameById),
    gatedUnknown: withModDisplayNames(report.gatedUnknown, nameById),
    gatedAssumed: withModDisplayNames(report.gatedAssumed, nameById),
    // Statements that ran clean but matched nothing, named with display
    // names like every other mod list. Additive: the replay core already
    // flags them; this only carries them alongside, never renames.
    zeroRows: withModDisplayNames(report.zeroRows, nameById),
    unreadable: withModDisplayNames(scope.unreadable, nameById),
    skippedNonDb: scope.skippedNonDb,
    perFile,
    differential,
    calibration,
  };
}

async function handleApi(req, res, url) {
  // GET /api/state -> paths, config list, installed inventory
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sources = paths.getSources();
    const installed = scanMods(sources);
    return send(res, 200, {
      sources,
      saves: paths.getSavesDir(),
      logs: paths.getLogsDir(),
      cache: paths.getCacheDir(),
      pathsError: paths.overridesStatus().error,
      ...listConfigs(),
      installed: installed.map((m) => ({ id: m.id, idNorm: m.idNorm, name: m.name, type: m.type })),
    });
  }

  // GET /api/load-order -> the profile's load order, read-only.
  if (req.method === 'GET' && url.pathname === '/api/load-order') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 200, { ok: false, error: 'Mod database not found.', groups: [], profile: null, bands: [], summary: {} });
    return send(res, 200, loadOrderResponse(modsDb, url));
  }

  // GET /api/action-files -> one action's file list (?componentRowId=N) or one
  // mod's actions with theirs (?modId=<guid>). Read-only: resolved strictly
  // from the database (ComponentFiles -> ModFiles), basenames only, and like
  // every other GET it works while Civ6 runs. No path parameter is accepted
  // and none is ever echoed.
  if (req.method === 'GET' && url.pathname === '/api/action-files') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const cr = url.searchParams.get('componentRowId');
    const mid = url.searchParams.get('modId');
    try {
      if (cr !== null) return send(res, 200, loOrder.actionFilesOf(modsDb.path, cr));
      if (mid !== null) return send(res, 200, loOrder.modActionFilesOf(modsDb.path, mid));
      return send(res, 400, { error: 'which action?' });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return send(res, 404, { error: e.message });
      return send(res, 400, { error: e.message });
    }
  }

  // ===== Conflict diagnosis: read-only reports (no .Civ6Cfg writes, ======
  // no live game-DB writes) =================================================
  //
  // Both reports reuse the phase backends and reimplement nothing:
  // shadowing enumerates contested UI paths from Mods.sqlite (read-only
  // open), and replay runs ordered statements into a TEMP COPY of
  // DebugGameplay.sqlite (the live game DB is only read, via the copy).
  // Both routes are GETs served only when the Conflicts page's buttons are
  // clicked - never on page load and never at server start. There is
  // deliberately no POST anywhere under /api/conflicts.

  // GET /api/conflicts/shadowing -> contested UI paths for the active
  // profile, with winners decided only by max declared LoadOrder.
  if (req.method === 'GET' && url.pathname === '/api/conflicts/shadowing') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    try {
      return send(res, 200, conflictShadowing(modsDb.path));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // GET /api/conflicts/replay?fk=off|on -> ordered DB-collision replay for
  // the active profile into a temp copy, with provenance collisions and a
  // Database.log differential. Expensive: the page runs it only on click.
  if (req.method === 'GET' && url.pathname === '/api/conflicts/replay') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const fk = url.searchParams.get('fk');
    if (fk !== null && fk !== 'off' && fk !== 'on') return send(res, 400, { error: 'fk must be off or on' });
    try {
      return send(res, 200, await conflictReplayReport(modsDb.path, { foreignKeys: fk === 'on' }));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // GET /api/conflicts/packaging -> static packaging findings for the active
  // profile's enabled mods, with display names on every finding. Cheap enough to run on
  // click like the other two reports, and like them a GET only: there is
  // deliberately no POST anywhere under /api/conflicts.
  if (req.method === 'GET' && url.pathname === '/api/conflicts/packaging') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    try {
      return send(res, 200, conflictPackaging(modsDb.path));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // ===== Load order overrides: problem 2, a separate screen =============
  // Every route here writes, and every one of them refuses while Civ6 has the
  // database open. loadorder does that check itself and awaits it, because a
  // check that cannot fail is not a check - the investigation's own script read
  // an async gameStatus() as a plain object and its guard never fired.

  // GET /api/load-overrides -> every stored override and its current state
  if (req.method === 'GET' && url.pathname === '/api/load-overrides') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 200, { ok: false, error: 'Mod database not found.', overrides: [], count: 0, groups: [] });
    try {
      return send(res, 200, loOrder.listOverrides(modsDb.path));
    } catch (e) {
      return send(res, 500, { error: e.message, overrides: [], count: 0, groups: [] });
    }
  }

  // POST /api/load-overrides -> set one action's position
  if (req.method === 'POST' && url.pathname === '/api/load-overrides') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    try {
      const r = await loOrder.applyOverrides(modsDb.path, [{ modId: body.modId, key: body.key, value: body.value }]);
      return send(res, 200, {
        ...loOrder.listOverrides(modsDb.path),
        applied: r.applied,
        orphans: r.orphans,
        ambiguous: r.ambiguous,
        unprotectable: r.unprotectable,
        sentinels: r.sentinels,
        backupPath: r.backupPath,
      });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/bulk -> apply a block move: one entry per action,
  // each { modId, key?, componentRowId?, value }. Entries naming a
  // componentRowId are resolved server-side via resolveAction inside applyBulk,
  // so a stale row reports orphaned and twins report ambiguous, never written.
  // One mutateDb transaction, one backup; refused while Civ6 runs.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/bulk') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    if (!Array.isArray(body.entries) || !body.entries.length) return send(res, 400, { error: 'no overrides to apply' });
    const g = await gameStatus();
    if (g.running) return send(res, 409, { error: 'close Civilization VI first - it has the mod database open' });
    try {
      const r = await loOrder.applyBulk(modsDb.path, body.entries);
      return send(res, 200, {
        ...loOrder.listOverrides(modsDb.path),
        applied: r.applied,
        orphans: r.orphans,
        ambiguous: r.ambiguous,
        unprotectable: r.unprotectable,
        sentinels: r.sentinels,
        backupPath: r.backupPath,
      });
    } catch (e) {
      if (/close Civilization VI first/.test(e.message)) return send(res, 409, { error: e.message });
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/reset -> put one action back to the author's value,
  // in the database and in the store.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/reset') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    try {
      const r = await loOrder.resetOverride(modsDb.path, body.modId, body.key);
      return send(res, 200, { ...loOrder.listOverrides(modsDb.path), restored: r.restored, backupPath: r.backupPath });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/discard -> forget an override WITHOUT touching the
  // database. The value stays where the last apply put it, which the client
  // says in its confirm: discarding is not the same as resetting, and only one
  // of them undoes what the override did.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/discard') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    try {
      loOrder.clearOverride(loOrder.overridesFile(), body.modId, body.key);
      return send(res, 200, loOrder.listOverrides(modsDb.path));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/reset-mod -> put every override of one mod back
  // to its recorded author value, in the database and in the store. One
  // transaction, one backup; refused when any entry lacks a recorded value
  // with nothing half-done. Refused while Civ6 runs like all writes.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/reset-mod') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const gResetMod = await gameStatus();
    if (gResetMod.running) return send(res, 409, { error: 'close Civilization VI first - it has the mod database open' });
    try {
      const r = await loOrder.resetModOverrides(modsDb.path, body.modId);
      return send(res, 200, { ...loOrder.listOverrides(modsDb.path), restored: r.restored, backupPath: r.backupPath });
    } catch (e) {
      if (/close Civilization VI first/.test(e.message)) return send(res, 409, { error: e.message });
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/discard-mod -> forget every override of one mod
  // WITHOUT touching the database. The values stay where the last apply put
  // them, which the client says in its confirm. Refused while Civ6 runs like
  // all writes.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/discard-mod') {
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const gDiscardMod = await gameStatus();
    if (gDiscardMod.running) return send(res, 409, { error: 'close Civilization VI first - it has the mod database open' });
    try {
      const r = await loOrder.discardModOverrides(modsDb.path, body.modId);
      return send(res, 200, { ...loOrder.listOverrides(modsDb.path), discarded: r.discarded });
    } catch (e) {
      if (/close Civilization VI first/.test(e.message)) return send(res, 409, { error: e.message });
      return send(res, 400, { error: e.message });
    }
  }

  // POST /api/load-overrides/sync -> re-apply everything now, for a server that
  // has been left running across a Steam sync.
  if (req.method === 'POST' && url.pathname === '/api/load-overrides/sync') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const g = await gameStatus();
    if (g.running) return send(res, 409, { error: 'close Civilization VI first - it has the mod database open' });
    try {
      const r = loOrder.syncOverrides(modsDb.path);
      return send(res, 200, {
        ...loOrder.listOverrides(modsDb.path),
        sync: { changed: r.changed, applied: r.applied.length, drifted: r.drifted, orphans: r.orphans, ambiguous: r.ambiguous },
      });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
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
    // Same list the mod manager and the sync use, so "needs adding" can never
    // read differently in two places. This used to be worked out a third time,
    // here, from the folders alone - which missed the mods the game knew but
    // had no row for.
    const todo = dbState.ok ? findUnregistered(modsDb.path, sources, dbState) : { pending: [] };
    const types = new Map(installed.map((m) => [m.idNorm, m.type]));
    return send(res, 200, {
      version: VERSION,
      sources,
      saves: paths.getSavesDir(),
      logs: paths.getLogsDir(),
      cache: paths.getCacheDir(),
      pathsError: paths.overridesStatus().error,
      modsDb: { ...modsDb, ok: dbState.ok, error: dbState.error || null, activeGroup: dbState.activeGroup || null },
      game: await gameStatus(),
      counts: {
        workshop: count('workshop'),
        local: count('local'),
        dlc: { total: official.length, enabled: official.filter((m) => m.disabled === false).length },
        configs: configs.length,
      },
      // On disk but not yet switchable: never scanned by the game, or known to
      // it but with no row in the profile in use. A sync adds them all.
      needsSync: todo.pending.map((p) => ({ id: p.id, name: p.name, type: types.get(p.idNorm) || 'local', reason: p.reason })),
      // Recorded by the game but no longer on disk: unsubscribed, or deleted by
      // hand. Listed, never removed on our own initiative - a mod still
      // downloading looks exactly like one just unsubscribed.
      gone: dbState.ok ? findRemoved(modsDb.path, sources) : { removed: [], removable: 0 },
      // What the last sync did, so the page can say so rather than the user
      // having to remember.
      sync: lastSync,
    });
  }

  // GET /api/mods -> mod manager list
  if (req.method === 'GET' && url.pathname === '/api/mods') {
    // The game status is read first so the list can decide whether it is a
    // complete one. A rescan in progress means the database is not currently a
    // statement about which mods exist, and a mod missing from the list for a
    // moment must not take its labels with it.
    const game = await gameStatus();
    const list = modList({ prune: !game.running });
    return send(res, 200, { ...list, game });
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

  // POST /api/mods/labels { id, labels:[...] } -> set one mod's labels.
  //
  // The one write in the toolkit that is NOT refused while Civ6 runs, and the
  // one with no backup. Both follow from the same fact: it writes
  // mod-labels.json, a file the game has never heard of and cannot be holding
  // open. Refusing it would copy a rule whose reason does not apply, and it
  // would make labelling impossible during a game - which is exactly when
  // someone wants to record what they just tried.
  //
  // The whole set is replaced, because the editor is a set of toggles and one
  // write should either land or not. A name the server cannot read comes back
  // as a 400 and nothing is written.
  if (req.method === 'POST' && url.pathname === '/api/mods/labels') {
    const body = await readBody(req);
    const idNorm = normId(body.id);
    const list = modList();
    const mod = list.mods.find((m) => m.idNorm === idNorm);
    if (!mod) return send(res, 404, { error: 'mod not found' });
    if (!Array.isArray(body.labels)) return send(res, 400, { error: 'labels must be a list' });
    // Checked here rather than left to throw from the store, so that a name the
    // user typed is a 400 about their request and anything that goes wrong
    // after this point is a 500 about ours. The store re-checks on the way in;
    // this is about which status the answer carries, not about trusting it.
    for (const name of body.labels) {
      try { labelStore.cleanLabel(name); } catch (e) { return send(res, 400, { error: e.message }); }
    }

    const game = await gameStatus();
    try {
      const v = labelStore.setLabels(labelStore.labelsFile(), mod.id, body.labels, labelPruneSet(list, game.running));
      return send(res, 200, labelResponse(v, game));
    } catch (e) {
      // A mod-labels.json we can no longer read is the only thing left that can
      // land here, and setLabels says so in the message rather than overwriting
      // whatever the file holds.
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/mods/labels/rename { from, to } -> rename a label on every mod
  // that carries it. Renaming onto a name already in use merges the two, and the
  // answer says so rather than letting it pass unnoticed.
  if (req.method === 'POST' && url.pathname === '/api/mods/labels/rename') {
    const body = await readBody(req);
    // A name the user typed is a 400 about their request; anything after this
    // point is a 500 about ours. Same split as the route above.
    let to;
    try { to = labelStore.cleanLabel(body.to); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!String(body.from || '').trim()) return send(res, 400, { error: 'which label?' });

    const list = modList();
    const game = await gameStatus();
    try {
      const v = labelStore.renameLabel(labelStore.labelsFile(), body.from, to, labelPruneSet(list, game.running));
      return send(res, 200, labelResponse(v, game));
    } catch (e) {
      return send(res, /no mod is labelled/.test(e.message) ? 404 : 500, { error: e.message });
    }
  }

  // POST /api/mods/labels/delete { name } -> take a label off every mod that
  // carries it. A label no mod has cannot be deleted, because there is nothing
  // to delete and saying otherwise would be a lie about what happened.
  if (req.method === 'POST' && url.pathname === '/api/mods/labels/delete') {
    const body = await readBody(req);
    if (!String(body.name || '').trim()) return send(res, 400, { error: 'which label?' });

    const list = modList();
    const game = await gameStatus();
    try {
      const v = labelStore.deleteLabel(labelStore.labelsFile(), body.name, labelPruneSet(list, game.running));
      return send(res, 200, labelResponse(v, game));
    } catch (e) {
      return send(res, /no mod is labelled/.test(e.message) ? 404 : 500, { error: e.message });
    }
  }

  // GET /api/game-setup -> the option catalog plus the asserted options.
  // Read-only, like every other GET: works while Civ6 runs.
  if (req.method === 'GET' && url.pathname === '/api/game-setup') {
    const catalog = gameSetupCatalog();
    const view = setupStore.readSetup(setupStore.gameSetupFile(), gameSetupKnown(catalog));
    return send(res, 200, gameSetupResponse(view, catalog, await gameStatus()));
  }

  // POST /api/game-setup { key, on } -> assert (on true) or withdraw (on
  // false) one option. The key is an exact catalog key (KIND:value); anything
  // else is a 400 about the request. A store file the toolkit can no longer
  // read is a 500 about ours: the store refuses to build on it rather than
  // overwrite whatever it holds, and the message says so.
  if (req.method === 'POST' && url.pathname === '/api/game-setup') {
    const body = await readBody(req);
    let key;
    try {
      key = setupStore.cleanKey(body.key);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    if (typeof body.on !== 'boolean') return send(res, 400, { error: 'on must be true or false' });
    const catalog = gameSetupCatalog();
    try {
      const view = setupStore.setOption(setupStore.gameSetupFile(), key, body.on, gameSetupKnown(catalog));
      return send(res, 200, gameSetupResponse(view, catalog, await gameStatus()));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/game-setup/clear -> withdraw every assertion. The file stays,
  // asserting nothing - the same state deleting it reads as.
  if (req.method === 'POST' && url.pathname === '/api/game-setup/clear') {
    const catalog = gameSetupCatalog();
    try {
      const view = setupStore.clearSetup(setupStore.gameSetupFile(), gameSetupKnown(catalog));
      return send(res, 200, gameSetupResponse(view, catalog, await gameStatus()));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
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
      if (!m.scanned) return send(res, 400, { error: `"${m.name}" can't be changed until the game has scanned it (close Civ6 and click "Rescan & add new mods" on the dashboard).` });
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

  // POST /api/save-edit { path, add:[id], remove:[id], mode:'new'|'overwrite', newName } -> change a save's mods
  if (req.method === 'POST' && url.pathname === '/api/save-edit') {
    const { path: p, add = [], remove = [], mode = 'new', newName } = await readBody(req);
    if (!Array.isArray(add) || !Array.isArray(remove)) return send(res, 400, { error: 'add and remove must be lists' });
    try {
      const summary = savelist.editSave(p, { add, remove, mode, newName });
      return send(res, 200, { ok: true, ...summary });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message, problems: e.problems || null });
    }
  }

  // POST /api/sync -> add everything on disk that is not yet switchable, and
  // switch on nothing. The dashboard's Rescan calls this; so does startup.
  // Without it a newly subscribed mod cannot be turned on until Civ6 has
  // launched once.
  // No ids, no paths: the server works out for itself what is missing, from the
  // mod folders and the database. The browser cannot name a file. Writes nothing
  // if there is nothing to add. See syncMods() and FINDINGS.md.
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    const run = await syncMods();
    return send(res, 200, { ok: !run.error, ...run });
  }

  // POST /api/mods/open-folder { ids: [id] } -> show a mod's folder in Explorer.
  //
  // A page cannot open Explorer by itself - file:// links are blocked from an
  // http:// page - so the server does it. It cannot delete anything, but it does
  // hand a path to another program, so it takes the same care as removal: ids
  // only from the request, the folder re-derived from the database, and the same
  // modFolderFault() rules. Not blocked while Civ6 runs - this reads nothing.
  if (req.method === 'POST' && url.pathname === '/api/mods/open-folder') {
    const { ids } = await readBody(req);
    const list = Array.isArray(ids) ? ids.map(normId) : [];
    if (!list.length) return send(res, 400, { error: 'no mods were named' });
    if (list.length > 1) return send(res, 400, { error: 'one mod at a time' });

    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const sources = paths.getSources();
    const roots = sources.filter((s) => s.exists)
      .map((s) => String(s.root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());

    const st = readModState(modsDb.path);
    if (!st.ok) return send(res, 400, { error: st.error });
    const rec = st.mods.find((m) => m.idNorm === list[0]);
    if (!rec) return send(res, 400, { error: 'that mod is not in the database' });

    const folder = path.dirname(String(rec.path || '').replace(/\\/g, '/'));
    const fault = modFolderFault(folder, rec.path, roots);
    if (fault) return send(res, 400, { error: fault });
    try {
      if (!fs.statSync(folder).isDirectory()) return send(res, 400, { error: 'that path is not a folder' });
    } catch (e) {
      return send(res, 400, { error: e.code === 'ENOENT' ? 'folder not found' : e.message });
    }
    // Two separate things went wrong here, and each hid the other.
    //
    // 1. The path. explorer.exe reads each "/segment" of its argument as a
    //    switch, so the game's forward-slash path left it with no path at all and
    //    it opened Documents. Convert at this boundary and nowhere else.
    //
    // 2. The window. windowsHide: true sets STARTUPINFO.wShowWindow = SW_HIDE,
    //    which Explorer inherits: it builds the window and the shell hides it.
    //    The result is a flicker and nothing else, and a hidden window is still a
    //    real entry in the shell's window list, so it looks like it opened. The
    //    flag is not repeated here on purpose - it belongs on the tasklist and reg
    //    calls, which are console programs that would otherwise flash a console.
    //    explorer.exe is GUI-subsystem and never allocates one, so it bought
    //    nothing and cost the window. Verified by launching the same path both
    //    ways: with the flag nothing appeared, without it the folder opened.
    //
    // The exit code is not a success flag either - it is 1 whether the folder
    // opened or not - so it is ignored, and the statSync above is what proves the
    // folder is there. Only Explorer failing to launch at all is worth a line.
    execFile('explorer.exe', [paths.toNativePath(folder)], (err) => {
      if (err && err.code === 'ENOENT') console.error('explorer.exe could not be launched');
    });
    return send(res, 200, { ok: true, folder });
  }

  // POST /api/mods/remove { ids: [...] } -> take mods out of the game and
  // delete their folders.
  //
  // The browser sends mod ids only. Folders come from the database and are
  // re-checked against the mod sources before anything is deleted, so a stale or
  // tampered request cannot name a path to delete - least of all a base-game or
  // DLC one, which the game also records and which must never be touched.
  if (req.method === 'POST' && url.pathname === '/api/mods/remove') {
    const { ids } = await readBody(req);
    const list = Array.isArray(ids) ? ids.map(normId) : [];
    if (!list.length) return send(res, 400, { error: 'no mods were named' });
    if (list.length > 200) return send(res, 400, { error: 'too many mods at once' });

    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then remove mods.' });
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });

    const sources = paths.getSources();
    const roots = sources.filter((s) => s.exists)
      .map((s) => String(s.root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
    // Folders come from the database, never from the request.
    const st = readModState(modsDb.path);
    if (!st.ok) return send(res, 400, { error: st.error });
    const byId = new Map(st.mods.map((m) => [m.idNorm, m]));
    const expected = {};
    const rejected = [];
    for (const id of list) {
      const rec = byId.get(id);
      if (!rec) { rejected.push({ modId: id, reason: 'not in the database' }); continue; }
      const folder = path.dirname(String(rec.path || '').replace(/\\/g, '/'));
      const fault = modFolderFault(folder, rec.path, roots);
      if (fault) { rejected.push({ modId: id, name: rec.name, reason: fault }); continue; }
      expected[id] = folder;
    }
    if (!Object.keys(expected).length) return send(res, 400, { error: 'none of those could be removed', refused: rejected });

    let r;
    try {
      // roots go too, so the data layer can refuse a folder that is - or holds -
      // a mod source folder. That check is what stands between a bug here and
      // deleting somebody's entire mod library.
      r = removeMods(modsDb.path, Object.keys(expected), expected, sources.filter((s) => s.exists).map((s) => s.root));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }

    // Files last. The mod is already out of the game, so a failure here is
    // reported rather than fatal - but it matters, because files left behind
    // are re-registered by the game on its next scan.
    const kept = [];
    for (const m of r.removed) {
      // Checked again immediately before deleting, not just earlier. Passing the
      // folder where the .modinfo path would go is deliberate: classifyPath keys
      // off the same root markers, and "workshop/.../12345" and the folder
      // ".../12345" classify the same way.
      const fault = modFolderFault(m.folder, m.folder, roots);
      if (fault) { kept.push({ ...m, error: fault }); continue; }
      try {
        if (!fs.lstatSync(m.folder).isDirectory()) { kept.push({ ...m, error: 'that path is not a folder' }); continue; }
        fs.rmSync(m.folder, { recursive: true, force: true });
      } catch (e) {
        kept.push({ modId: m.modId, name: m.name, folder: m.folder, error: e.code === 'ENOENT' ? 'already gone' : e.message });
      }
    }
    return send(res, 200, { ok: true, removed: r.removed, kept, refused: [...rejected, ...r.refused], backupPath: r.backupPath });
  }

  // ---- mod groups (player profiles) ---------------------------------------
  // Every write here changes Mods.sqlite, so it is refused while the game runs
  // and each one returns the refreshed group list for the UI.

  if (req.method === 'GET' && url.pathname === '/api/modgroups') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const list = listGroups(modsDb.path);
    if (!list.ok) return send(res, 500, { error: list.error });
    return send(res, 200, { ...list, game: await gameStatus() });
  }

  // GET /api/modgroups/preview?id=... -> what using this profile would change:
  // the mods that would start loading, and the ones that would stop. Read-only,
  // so like export it works while the game is running.
  if (req.method === 'GET' && url.pathname === '/api/modgroups/preview') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const id = groupId(url.searchParams.get('id'));
    if (id === null) return send(res, 400, { error: 'which profile?' });
    try {
      return send(res, 200, previewGroup(modsDb.path, id));
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // GET /api/modgroups/export?id=... -> the profile as a downloadable .json
  // file. Read-only, so it also works while the game is running.
  if (req.method === 'GET' && url.pathname === '/api/modgroups/export') {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });
    const id = groupId(url.searchParams.get('id'));
    if (id === null) return send(res, 400, { error: 'which profile?' });
    let file;
    try {
      file = exportGroup(modsDb.path, id);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
    // Keep the name readable but out of the file name: quotes, slashes and
    // Windows' forbidden characters would break the download.
    const safe = file.name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'profile';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="civ6-profile-${safe}.json"`,
    });
    return res.end(JSON.stringify(file, null, 2));
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/modgroups/')) {
    const action = url.pathname.slice('/api/modgroups/'.length);
    const body = await readBody(req);
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return send(res, 400, { error: 'Mod database not found.' });

    // A mod group can't be changed while the game has the database open.
    const game = await gameStatus();
    if (game.running) return send(res, 409, { error: 'Civilization VI is running. Close the game first, then try again.' });

    const id = groupId(action === 'import' ? null : body.id);
    if (id === null && action !== 'create' && action !== 'import') return send(res, 400, { error: 'which profile?' });
    try {
      let r;
      if (action === 'create') r = createGroup(modsDb.path, body.name);
      else if (action === 'duplicate') r = duplicateGroup(modsDb.path, id, body.name);
      else if (action === 'rename') r = renameGroup(modsDb.path, id, body.name);
      else if (action === 'delete') r = deleteGroup(modsDb.path, id, body.fallbackId);
      else if (action === 'activate') r = activateGroup(modsDb.path, id);
      else if (action === 'import') r = importGroup(modsDb.path, body.profile);
      else return send(res, 404, { error: 'not found' });
      // Re-read so the UI always gets the state that is really on disk.
      const list = listGroups(modsDb.path);
      return send(res, 200, { ok: true, ...r, groups: list.groups, active: list.active, game });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // POST /api/ping -> does this server know about the page it just served?
  //
  // A stale server and a freshly reloaded page are an easy pair to end up with:
  // the HTML and scripts are read from disk on every request, so a reload picks
  // up new UI code while the process behind it is still running the code from
  // whenever it started. The symptom is a bare "not found" from a route that
  // plainly exists on disk, which looks like a bug in the feature rather than a
  // server that needs restarting. An old server has never heard of this route,
  // so a 404 here is the answer rather than the problem.
  if (req.method === 'POST' && url.pathname === '/api/ping') {
    return send(res, 200, { ok: true, version: VERSION, started: STARTED });
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
    const modsDb = paths.getModsDb();
    const dbState = modsDb.exists ? readModState(modsDb.path) : { ok: false, mods: [] };
    const scanned = dbState.ok ? new Set(dbState.mods.map((m) => m.idNorm)) : null;
    try { view = inventory.configView(fs.readFileSync(p), installed, scanned); }
    catch (e) { return send(res, 500, { error: `parse failed: ${e.message}` }); }
    return send(res, 200, { path: p, name: path.basename(p), ...view });
  }

  // POST /api/paths -> persist overrides to civ6-paths.json
  //
  // The whole write lives in paths.writeOverrides: which file it goes to, the
  // type check on each value, the atomic replace, the cache invalidation and the
  // refusal to build on a file it cannot read. Keeping it there is what stops
  // the read and the write disagreeing about where the file is - which is how a
  // test or a relocated install ends up writing to the project root while
  // reading its overrides from somewhere else.
  if (req.method === 'POST' && url.pathname === '/api/paths') {
    const body = await readBody(req);
    try {
      return send(res, 200, paths.writeOverrides(body));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
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

if (process.argv.includes('--selfcheck')) {
  // No process.exit: the loop drains on its own once the scratch server is
  // closed (fetch-style pooled sockets would break that, so the selfcheck
  // uses agent:false above). The exit code carries the verdict.
  runConflictSelfcheck().then((ok) => { process.exitCode = ok ? 0 : 1; },
    (e) => { console.error(e); process.exitCode = 1; });
} else {
server.listen(PORT, HOST, () => {
  console.log(`Civ6 Mod Toolkit running at ${addr}`);
  if (!process.env.CIV6_LAUNCHER) console.log('Press Ctrl+C to stop.'); // the launcher has its own menu
  openBrowser();

  // Pick up anything subscribed to since last time, the way the game would on
  // its own next launch - but without waiting for a launch, and without
  // switching anything on. Not awaited: the browser is already open, and a
  // first run over a large library can take a moment.
  syncMods().then((run) => {
    if (run.error) console.log(`Sync: ${run.error}`);
    else if (run.skipped === 'civ6-running') console.log('Sync: skipped, Civ6 is running. Close it and rescan.');
    else if (run.added.length) {
      console.log(`Sync: added ${run.added.length} mod${run.added.length === 1 ? '' : 's'} (off in every profile)` +
        (run.failed.length ? `, ${run.failed.length} could not be read` : ''));
    } else if (run.pending) console.log(`Sync: ${run.pending} mod${run.pending === 1 ? '' : 's'} could not be read.`);
  }).catch((e) => console.log(`Sync: ${e.message}`));

  // Then the load order overrides, which the spec says sync on start and which
  // until now only ran when someone clicked "Re-apply all". A mod that updated
  // while the toolkit was closed gets the author's LoadOrder back on the next
  // launch otherwise, and the user finds out from a broken load order rather
  // than from a message.
  //
  // Ordered after syncMods deliberately: syncMods re-registers newly subscribed
  // mods, which replaces rows, and repairing an override against row ids that are
  // about to be replaced would be repairing the wrong thing.
  syncLoadOrderOverrides();
});
}

// -------- Conflict diagnosis selfcheck (task 4.1) ----------------------------------
//
// node src/server.js --selfcheck: a scratch server on an ephemeral test port
// against fake DBs in the OS temp dir - never the live DB. Exercises both new
// routes over HTTP plus the static read-only guards, then exits.

function conflictSelfcheckSeed(dir) {
  const fsSc = require('fs');
  const pathSc = require('path');
  const { DatabaseSync: DbSc } = require('node:sqlite');
  const MOD_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const MOD_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const GONE = 'dddddddd-4444-4444-8444-444444444444';
  const modsDir = pathSc.join(dir, 'Mods');
  fsSc.mkdirSync(pathSc.join(modsDir, 'ModA', 'data'), { recursive: true });
  fsSc.mkdirSync(pathSc.join(modsDir, 'ModB', 'data'), { recursive: true });
  const modinfoA = pathSc.join(modsDir, 'ModA', 'ModA.modinfo');
  const modinfoB = pathSc.join(modsDir, 'ModB', 'ModB.modinfo');
  fsSc.writeFileSync(modinfoA, '<Mod></Mod>');
  fsSc.writeFileSync(modinfoB, '<Mod></Mod>');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'a.sql'), "UPDATE ProvCheck SET Value = 1 WHERE Id = 'hero';\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'gated.sql'), "INSERT INTO ProvCheck VALUES('gated', 7);\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModA', 'data', 'setup.sql'), 'CREATE TABLE SetupGated(Id TEXT);\nINSERT INTO SetupGated VALUES(\'s1\');\n');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'b.sql'), "UPDATE ProvCheck SET Value = 2 WHERE Id = 'hero';\n");
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'bad1.sql'), 'INSERT INTO NoSuchB1 VALUES(1);\n');
  fsSc.writeFileSync(pathSc.join(modsDir, 'ModB', 'data', 'bad2.sql'), 'INSERT INTO NoSuchB2 VALUES(1);\n');
  // missing.sql is referenced by the database but absent on disk (unreadable).

  const modsDb = pathSc.join(dir, 'Mods.sqlite');
  const w = new DbSc(modsDb);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const sfA = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(modinfoA).lastInsertRowid;
  const sfB = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(modinfoB).lastInsertRowid;
  const mA = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sfA, MOD_A).lastInsertRowid;
  const mB = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sfB, MOD_B).lastInsertRowid;
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)').run(mA);
  w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)').run(mB);
  const addAction = (modRowId, type, id, files, props) => {
    const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
      .run(modRowId, id, type).lastInsertRowid;
    for (const [k, v] of Object.entries(props || {})) {
      w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)').run(cr, k, v);
    }
    for (const f of files) {
      const fr = w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid;
      w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId) VALUES (?, ?)').run(cr, fr);
    }
    return cr;
  };
  // UI contests: file-vs-LuaReplace with no declared order, file-vs-file with
  // a single max, a genuine tie, and one solo path that must be omitted.
  addAction(mA, 'AddUIScript', 'ShipPanel', ['UI/Panel.lua']);
  addAction(mA, 'AddUIScript', 'BothA', ['UI/Both.lua'], { LoadOrder: '100' });
  addAction(mA, 'AddUIScript', 'TieA', ['UI/Tie.lua'], { LoadOrder: '300' });
  addAction(mA, 'AddUIScript', 'SoloA', ['UI/Solo.lua']);
  addAction(mB, 'ReplaceUIScript', 'PanelReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Panel.lua' });
  addAction(mB, 'AddUIScript', 'BothB', ['UI/Both.lua'], { LoadOrder: '200' });
  addAction(mB, 'AddUIScript', 'TieB', ['UI/Tie.lua'], { LoadOrder: '300' });
  // DB files: A(100) writes hero=1, B(200) writes hero=2, so B wins in order.
  addAction(mA, 'UpdateDatabase', 'GoodA', ['data/a.sql'], { LoadOrder: '100' });
  const gatedCr = addAction(mA, 'UpdateDatabase', 'GatedA', ['data/gated.sql']);
  const setupCr = addAction(mA, 'UpdateDatabase', 'SetupA', ['data/setup.sql']);
  addAction(mA, 'UpdateDatabase', 'MissA', ['data/missing.sql']);
  addAction(mB, 'UpdateDatabase', 'GoodB', ['data/b.sql'], { LoadOrder: '200' });
  addAction(mB, 'UpdateDatabase', 'BadB1', ['data/bad1.sql']);
  addAction(mB, 'UpdateDatabase', 'BadB2', ['data/bad2.sql']);
  // GatedA runs only with a mod that is not installed: skipped with reason.
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (1, ?, ?, 0)').run(mA, 'GateOff');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (1, 1, ?, 0)').run('ModInUse');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (1, 'Value', ?)").run(GONE);
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 1)').run(gatedCr);
  // SetupA runs only with RULESET_STANDARD asserted: undecidable with nothing
  // asserted (replays, flagged unknown), assumed-satisfied once asserted.
  w.prepare('INSERT INTO Criteria (CriteriaRowId, ModRowId, CriteriaId, Any) VALUES (2, ?, ?, 0)').run(mA, 'SetupGate');
  w.prepare('INSERT INTO Criterion (CriterionRowId, CriteriaRowId, CriterionType, Inverse) VALUES (2, 2, ?, 0)').run('RuleSetInUse');
  w.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (2, 'Value', ?)").run('RULESET_STANDARD');
  w.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, 2)').run(setupCr);
  w.close();

  const debugDb = pathSc.join(dir, 'DebugGameplay.sqlite');
  const seed = new DbSc(debugDb);
  try {
    seed.exec("CREATE TABLE ProvCheck(Id TEXT PRIMARY KEY, Value INTEGER); INSERT INTO ProvCheck VALUES('hero', 0);");
  } finally {
    seed.close();
  }
  return { modsDb, debugDb, logPath: pathSc.join(dir, 'Database.log'), moddingPath: pathSc.join(dir, 'Modding.log'), MOD_A, MOD_B, GONE };
}

async function runConflictSelfcheck() {
  const fsSc = require('fs');
  const osSc = require('os');
  const pathSc = require('path');
  const cryptoSc = require('crypto');
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };
  console.log('conflict-diagnosis --selfcheck (task 4.1)');
  const scratch = fsSc.realpathSync.native(fsSc.mkdtempSync(pathSc.join(osSc.tmpdir(), 'civ6-conflict-selfcheck-')));
  console.log(`scratch dir: ${scratch}`);
  const fx = conflictSelfcheckSeed(scratch);
  const sha = (p) => cryptoSc.createHash('sha256').update(fsSc.readFileSync(p)).digest('hex');
  const modsBefore = sha(fx.modsDb);
  const debugBefore = sha(fx.debugDb);
  const debugMtime = fsSc.statSync(fx.debugDb).mtimeMs;
  // Config files present before the run, so the run can prove it wrote none.
  const cfgBefore = fsSc.readdirSync(pathSc.join(__dirname, '..'))
    .filter((f) => /\.Civ6Cfg$/i.test(f))
    .map((f) => [f, fsSc.statSync(pathSc.join(__dirname, '..', f)).mtimeMs]);

  // Isolate: a paths file that does not exist, so env vars below win and no
  // real Steam/library path is ever consulted.
  process.env.CIV6_PATHS_FILE = pathSc.join(scratch, 'no-such-civ6-paths.json');
  process.env.CIV6_MODS_DB = fx.modsDb;
  process.env.CIV6_DEBUG_GAMEPLAY = fx.debugDb;
  process.env.CIV6_DATABASE_LOG = fx.logPath;
  process.env.CIV6_MODDING_LOG = fx.moddingPath;
  // Hermetic game setup: the replay report reads game-setup.json on every run,
  // so point it at a scratch file (absent = nothing asserted) rather than any
  // repo file a developer may have left behind.
  process.env.CIV6_GAMESETUP_FILE = pathSc.join(scratch, 'game-setup.json');

  // Learn the exact replay error text first (in-process, same code the route
  // calls), so the fixture Database.log carries one matching error plus one
  // ghost error no replay statement raised.
  const prelim = await conflictReplayReport(fx.modsDb, { foreignKeys: false });
  const bad1 = (prelim.perFile.find((f) => f.fileLabel === 'data/bad1.sql') || {}).error || 'no such table: NoSuchB1';
  fsSc.writeFileSync(fx.logPath, [
    `[100.001] [Gameplay] ERROR: ${bad1} -- file: bad1.sql statement 0`,
    '[100.002] [Gameplay] Validating Foreign Key Constraints...',
    '[100.003] [Gameplay] ERROR: UNIQUE constraint failed: ProvCheck.Id -- file: ghost.sql statement 3',
  ].join('\n'));
  // Modding.log Loading timeline with one inverted pair: the replay assumes
  // data/a.sql before data/b.sql, the game loaded b.sql before a.sql. Later
  // timestamps than the Database.log errors so bracketing is untouched.
  fsSc.writeFileSync(fx.moddingPath, [
    '[100.010] [Modding] UpdateDatabase - Loading D:/Synthetic/ModB/data/b.sql',
    '[100.011] [Modding] UpdateDatabase - Loading D:/Synthetic/ModA/data/a.sql',
  ].join('\n'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const port = server.address().port;
  OWN_HOSTS.add(`127.0.0.1:${port}`);
  console.log(`scratch server: http://127.0.0.1:${port}`);
  // agent:false, like server-harness: fetch pools sockets and a pooled socket
  // can hold (or break, at teardown) the event loop after the suite finishes.
  const httpSc = require('http');
  const get = (p) => new Promise((resolve, reject) => {
    const req = httpSc.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });

  console.log('\nShadowing route (read-only enumeration)');
  const sh = await get('/api/conflicts/shadowing');
  check('shadowing answers 200 with ok', sh.status === 200 && sh.body && sh.body.ok === true,
    `status=${sh.status} ok=${sh.body && sh.body.ok}`);
  const paths = (sh.body.contested || []).map((c) => c.path);
  check('exactly the three contested paths', JSON.stringify(paths) === JSON.stringify(['UI/Both.lua', 'UI/Panel.lua', 'UI/Tie.lua']),
    JSON.stringify(paths));
  const byPath = new Map((sh.body.contested || []).map((c) => [c.path, c]));
  const both = byPath.get('UI/Both.lua');
  check('single max wins with its declared value',
    !!both && both.status === 'decided' && both.winner && both.winner.value === 200
    && String(both.winner.modId).toLowerCase() === fx.MOD_B.toLowerCase(),
    JSON.stringify(both && both.winner));
  const panel = byPath.get('UI/Panel.lua');
  const panelSources = panel ? panel.claimants.map((c) => c.sources.join('+')).sort() : [];
  check('LuaReplace-only contest is undefined with both sources named',
    !!panel && panel.status === 'undefined' && panel.reason === 'no-declared-order' && panel.winner === null
    && JSON.stringify(panelSources) === JSON.stringify(['LuaReplace', 'file']),
    JSON.stringify(panelSources));
  const tie = byPath.get('UI/Tie.lua');
  check('genuine tie is undefined, unranked, value named',
    !!tie && tie.status === 'undefined' && tie.reason === 'tie' && tie.value === 300 && tie.winner === null
    && tie.tied && tie.tied.length === 2,
    JSON.stringify(tie && { reason: tie.reason, value: tie.value, tied: tie.tied }));
  check('uncontested path omitted', !paths.includes('UI/Solo.lua'));
  const env = sh.body.envelope || {};
  check('envelope counts reported', env.mods === 2 && env.contested === 3 && env.decidable === 1
    && env.noDeclaredOrder === 1 && env.ties === 1, JSON.stringify(env));
  check('envelope line present', typeof sh.body.envelopeLine === 'string' && /contested/.test(sh.body.envelopeLine),
    sh.body.envelopeLine);

  console.log('\nReplay route (temp copy only, user-triggered)');
  const rp = await get('/api/conflicts/replay?fk=off');
  check('replay answers 200 with ok', rp.status === 200 && rp.body && rp.body.ok === true,
    `status=${rp.status} ok=${rp.body && rp.body.ok} err=${rp.body && rp.body.error}`);
  const tmp = require('os').tmpdir();
  const realTmp = fsSc.realpathSync.native(tmp);
  check('report names a temp copy under the OS temp dir',
    typeof rp.body.tempCopy === 'string' && rp.body.tempCopy.startsWith(realTmp)
    && /DebugGameplay\.sqlite$/.test(rp.body.tempCopy), rp.body.tempCopy);
  check('fk mode recorded', rp.body.fkMode === 'OFF', rp.body.fkMode);
  check('exactly one collision', (rp.body.collisions || []).length === 1,
    JSON.stringify((rp.body.collisions || []).map((c) => `${c.table}/${c.pk}/${c.column}`)));
  const col = (rp.body.collisions || [])[0];
  check('collision names winner plus loser in replay order',
    !!col && col.table === 'ProvCheck' && col.pk === 'hero' && col.column === 'Value'
    && col.winner.modId.toLowerCase() === fx.MOD_B.toLowerCase() && col.winner.fileLabel === 'data/b.sql'
    && col.losers.length === 1 && col.losers[0].modId.toLowerCase() === fx.MOD_A.toLowerCase()
    && col.losers[0].fileLabel === 'data/a.sql', col ? JSON.stringify(col) : 'none');
  // Collision display names (readability): winner/loser mods resolve through
  // the installed display-name index with mod-id fallback, same-mod pairs
  // tag and sort after cross-mod pairs, counts and envelope untouched.
  // In-process over the mapping itself: no fixture change, no new DB rows.
  {
    const byId = new Map([[fx.MOD_A, 'Alpha Mod'], [fx.MOD_B, 'Beta Mod']]);
    const cross = {
      table: 'T', pk: 'k', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: fx.MOD_B, fileLabel: 'b.sql', stmtIndex: 0, globalIndex: 1 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a.sql', stmtIndex: 0, globalIndex: 0 }],
    };
    const inner = {
      table: 'T', pk: 'k2', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: fx.MOD_A, fileLabel: 'a2.sql', stmtIndex: 1, globalIndex: 3 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a1.sql', stmtIndex: 0, globalIndex: 2 }],
    };
    const ghost = {
      table: 'T', pk: 'k3', column: 'V', writes: 2, fidelityLimited: [],
      winner: { modId: 'missing-mod-id', fileLabel: 'g.sql', stmtIndex: 0, globalIndex: 5 },
      losers: [{ modId: fx.MOD_A, fileLabel: 'a.sql', stmtIndex: 0, globalIndex: 4 }],
    };
    const shown = conflictCollisionDisplay([inner, cross, ghost], byId);
    check('collision winner/loser carry display names, never bare ids',
      shown.every((c) => typeof c.winner.modName === 'string' && typeof c.losers[0].modName === 'string')
      && shown.some((c) => c.winner.modName === 'Beta Mod')
      && shown.some((c) => c.losers[0].modName === 'Alpha Mod'),
      JSON.stringify(shown.map((c) => [c.winner.modName, c.losers[0].modName])));
    check('unresolvable mods fall back to the mod id',
      shown.some((c) => c.winner.modName === 'missing-mod-id'),
      JSON.stringify(shown.map((c) => c.winner.modName)));
    check('same-mod pairs tag and sort after cross-mod pairs',
      shown[shown.length - 1].sameMod === true && shown[shown.length - 1].table === 'T'
      && shown[0].sameMod === false && shown[1].sameMod === false
      && shown.filter((c) => !c.sameMod).length === 2,
      JSON.stringify(shown.map((c) => c.sameMod)));
    check('the live route response already carries names and the tag',
      col && typeof col.winner.modName === 'string' && typeof col.losers[0].modName === 'string'
      && col.sameMod === false, col ? JSON.stringify({ winner: col.winner, sameMod: col.sameMod }) : 'none');
  }
  const pf = new Map((rp.body.perFile || []).map((f) => [f.fileLabel, f]));
  check('bad files aborted with their errors',
    pf.get('data/bad1.sql').status === 'aborted' && pf.get('data/bad2.sql').status === 'aborted'
    && !!pf.get('data/bad1.sql').error, JSON.stringify([...pf].map(([k, v]) => `${k}:${v.status}`)));
  check('gated file skipped with reason naming the missing mod',
    pf.get('data/gated.sql').status === 'skipped-gated'
    && new RegExp(fx.GONE, 'i').test((pf.get('data/gated.sql').gate || {}).reason || ''),
    JSON.stringify(pf.get('data/gated.sql')));
  check('missing file listed as unreadable, never executed',
    (rp.body.unreadable || []).some((u) => u.file === 'data/missing.sql'),
    JSON.stringify(rp.body.unreadable));
  check('envelope covers every statement',
    rp.body.envelope && rp.body.envelope.executed + rp.body.envelope.skipped === rp.body.envelope.statements
    && typeof rp.body.envelopeLine === 'string', rp.body.envelopeLine);
  const diff = rp.body.differential || {};
  check('differential names agreement plus both divergences',
    diff.available === true && diff.agreements.length === 1 && diff.replayOnly.length === 1 && diff.logOnly.length === 1
    && diff.agreements[0].fileLabel === 'data/bad1.sql' && diff.replayOnly[0].fileLabel === 'data/bad2.sql'
    && diff.replayOnly[0].side === 'replay-only' && diff.logOnly[0].fileLabel === 'ghost.sql'
    && diff.logOnly[0].side === 'log-only' && diff.logPath === fx.logPath,
    JSON.stringify({ a: diff.agreements, r: diff.replayOnly, l: diff.logOnly }));
  // Log-pairing calibration: one inverted pair in the payload, and the
  // display mapping renders it. The fixture Modding.log loads b.sql before
  // a.sql against the assumed a-before-b replay order.
  const cal = rp.body.calibration || {};
  const inv = (cal.divergences || [])[0] || {};
  check('calibration carries the one inverted pair with both sides named',
    cal.available === true && (cal.divergences || []).length === 1 && cal.logPath === fx.moddingPath
    && /data\/a\.sql/.test(inv.assumedFirst || '') && /data\/b\.sql/.test(inv.assumedSecond || '')
    && /assumed replay order/.test(inv.assumedOrder || '') && /game-observed order/.test(inv.observedOrder || ''),
    JSON.stringify(cal.divergences));
  // Divergence owning mods (polish): each divergence file resolves
  // server-side to its claiming mod(s) with display names - data/a.sql is
  // Mod A's file, data/b.sql Mod B's.
  const firstMods = inv.assumedFirstMods || [];
  const secondMods = inv.assumedSecondMods || [];
  check('divergence files resolve to their owning mods with display names',
    firstMods.length === 1 && String(firstMods[0].modId).toLowerCase() === fx.MOD_A.toLowerCase()
    && typeof firstMods[0].modName === 'string' && firstMods[0].modName.length > 0
    && secondMods.length === 1 && String(secondMods[0].modId).toLowerCase() === fx.MOD_B.toLowerCase()
    && typeof secondMods[0].modName === 'string' && secondMods[0].modName.length > 0,
    JSON.stringify({ first: firstMods, second: secondMods }));
  {
    // The lookup itself, in-process with no fixture change: a path two mods
    // ship lists both with display names, deduped; basename fallback mirrors
    // the calibration's own basename pairing; unknown paths resolve empty.
    const byId = new Map([[fx.MOD_A, 'Alpha Mod'], [fx.MOD_B, 'Beta Mod']]);
    const fake = [
      { file: 'data/shared.sql', modIds: [fx.MOD_A, fx.MOD_B, fx.MOD_A] },
      { file: 'other/shared.sql', modIds: [fx.MOD_B] },
    ];
    const both = conflictFileClaimants(fake, 'data/shared.sql', byId);
    check('a path two mods ship lists both with display names',
      both.length === 2 && both[0].modName === 'Alpha Mod' && both[1].modName === 'Beta Mod',
      JSON.stringify(both));
    const byBase = conflictFileClaimants([{ file: 'data/only.sql', modIds: [fx.MOD_A] }], 'elsewhere/only.sql', byId);
    check('basename fallback mirrors the calibration pairing',
      byBase.length === 1 && byBase[0].modName === 'Alpha Mod', JSON.stringify(byBase));
    check('unknown paths resolve to an empty list, never a bare id',
      conflictFileClaimants(fake, 'data/nowhere.sql', byId).length === 0
      && conflictFileClaimants([], 'data/shared.sql', byId).length === 0, 'empty');
  }
  {
    // Display mapping runs in a stubbed-DOM vm (phase7 precedent): the page
    // script only needs $, esc/n/renderCivText, api/toast, and pages to load.
    const vmSc = require('vm');
    const cfSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
    const stubEl = () => ({ addEventListener() {}, disabled: false, textContent: '', innerHTML: '', value: 'off' });
    const cfCx = {
      console,
      esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      renderCivText: (s) => String(s == null ? '' : s),
      $: () => stubEl(),
      api: async () => ({}),
      toast: () => {},
      pages: {},
    };
    vmSc.createContext(cfCx);
    vmSc.runInContext(cfSrc, cfCx, { filename: 'conflicts.js' });
    const calHtml = vmSc.runInContext(`cfCalibrationHtml(${JSON.stringify(cal)})`, cfCx);
    check('display mapping names both files and which side each order came from',
      typeof calHtml === 'string' && /data\/a\.sql/.test(calHtml) && /data\/b\.sql/.test(calHtml)
      && /assumed replay order/.test(calHtml) && /game-observed order/.test(calHtml),
      String(calHtml).slice(0, 200));
    const calOwnHtml = vmSc.runInContext(`cfCalibrationHtml(${JSON.stringify({ available: true, divergences: [{
      assumedFirst: 'data/a.sql', assumedSecond: 'data/b.sql',
      assumedOrder: 'data/a.sql before data/b.sql (assumed replay order)',
      observedOrder: 'data/b.sql before data/a.sql (game-observed order)',
      assumedFirstMods: [{ modId: 'mid-a', modName: 'Green A' }],
      assumedSecondMods: [{ modId: 'mid-b', modName: 'Plain B' }, { modId: 'mid-c', modName: 'Plain C' }],
    }] })})`, cfCx);
    check('display mapping shows owning mods under each divergence file, all claimants',
      typeof calOwnHtml === 'string' && /Green A/.test(calOwnHtml) && /Plain B/.test(calOwnHtml)
      && /Plain C/.test(calOwnHtml) && !/mid-a|mid-b|mid-c/.test(calOwnHtml),
      String(calOwnHtml).slice(0, 200));
    const calNoOwnHtml = vmSc.runInContext(
      'cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "x.sql", assumedSecond: "y.sql", assumedOrder: "x before y", observedOrder: "y before x", assumedFirstMods: [], assumedSecondMods: [] }] })', cfCx);
    check('display mapping states unowned files in plain words',
      typeof calNoOwnHtml === 'string' && /owning mod unknown/.test(calNoOwnHtml),
      String(calNoOwnHtml).slice(0, 160));
    const calZeroHtml = vmSc.runInContext(
      'cfCalibrationHtml({ available: true, divergences: [], assumedOnly: [], observedOnly: [] })', cfCx);
    check('display mapping states the zero-divergence case',
      typeof calZeroHtml === 'string' && /match/i.test(calZeroHtml), String(calZeroHtml).slice(0, 160));
  }
  const rpOn = await get('/api/conflicts/replay?fk=on');
  check('fk=on replays with FK mode recorded', rpOn.status === 200 && rpOn.body.fkMode === 'ON',
    `status=${rpOn.status} fkMode=${rpOn.body && rpOn.body.fkMode}`);
  const rpBad = await get('/api/conflicts/replay?fk=sideways');
  check('bad fk is a 400 about the request', rpBad.status === 400 && !!rpBad.body.error, `status=${rpBad.status}`);

  console.log('\nAssumed game setup feeds replay gates (game-setup micro-fix)');
  {
    // End to end through the route: the fixture gates data/setup.sql on
    // RULESET_STANDARD, which nothing can measure here. Asserting it must move
    // the live replay verdict to assumed; withdrawing it must move it back.
    const setupKey = 'RULESET:RULESET_STANDARD';
    const setupFile = process.env.CIV6_GAMESETUP_FILE;
    const setupOf = (body) => ((body && body.perFile) || []).find((f) => f.fileLabel === 'data/setup.sql');
    const rpPlain = await get('/api/conflicts/replay?fk=off');
    const plainRec = setupOf(rpPlain.body);
    check('with nothing asserted the setup-gated file replays undecided, never assumed',
      rpPlain.status === 200 && plainRec && plainRec.status === 'committed'
      && plainRec.gate && plainRec.gate.willRun === null && !plainRec.gate.assumed
      && ((rpPlain.body.gatedAssumed || []).length === 0),
      JSON.stringify(plainRec && plainRec.gate));
    // Same prune pattern as the setup routes: assert against the mined catalog.
    setupStore.setOption(setupFile, setupKey, true, gameSetupKnown(gameSetupCatalog()));
    const rpAssumed = await get('/api/conflicts/replay?fk=off');
    const assumedRec = setupOf(rpAssumed.body);
    check('with the ruleset asserted the gated file replays as assumed, not measured',
      rpAssumed.status === 200 && assumedRec && assumedRec.status === 'committed'
      && assumedRec.gate && assumedRec.gate.willRun === true && assumedRec.gate.assumed === true,
      JSON.stringify(assumedRec && assumedRec.gate));
    const namedAssumed = (rpAssumed.body.gatedAssumed || []).find((g) => g.fileLabel === 'data/setup.sql');
    check('the payload names it in gatedAssumed with a display name',
      !!namedAssumed && typeof namedAssumed.modName === 'string' && namedAssumed.modName.length > 0,
      JSON.stringify(namedAssumed));
    {
      // The gated list marks it: render the live payload headless through the
      // real page script with a capturing $ (phase7 precedent).
      const vmA = require('vm');
      const cfSrcA = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
      const capA = {};
      const capElA = () => ({ addEventListener() {}, disabled: false, textContent: '', innerHTML: '', value: 'off' });
      const cfCxA = {
        console,
        esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        n: (v) => (v == null ? '' : Number(v).toLocaleString()),
        renderCivText: (s) => String(s == null ? '' : s),
        $: (id) => (capA[id] || (capA[id] = capElA())),
        api: async () => ({}),
        toast: () => {},
        pages: {},
      };
      vmA.createContext(cfCxA);
      vmA.runInContext(cfSrcA, cfCxA, { filename: 'conflicts.js' });
      vmA.runInContext(`cfState.replay = ${JSON.stringify(rpAssumed.body)}`, cfCxA);
      vmA.runInContext('cfRenderReplay()', cfCxA);
      const gatedHtml = capA.cfReplayGated && capA.cfReplayGated.innerHTML;
      check('the gated list marks the assumed file with the view tag language, never as measured',
        typeof gatedHtml === 'string' && /data\/setup\.sql/.test(gatedHtml) && /lo-assumed/.test(gatedHtml)
        && /assumed setup/.test(gatedHtml),
        String(gatedHtml).slice(0, 300));
      vmA.runInContext(`cfState.replay = ${JSON.stringify(rpPlain.body)}`, cfCxA);
      vmA.runInContext('cfRenderReplay()', cfCxA);
      const plainHtml = capA.cfReplayGated && capA.cfReplayGated.innerHTML;
      check('with nothing asserted the gated list carries no assumed marker',
        typeof plainHtml === 'string' && !/assum/i.test(plainHtml),
        String(plainHtml).slice(0, 200));
    }
    setupStore.setOption(setupFile, setupKey, false, gameSetupKnown(gameSetupCatalog()));
    const rpBack = await get('/api/conflicts/replay?fk=off');
    const backRec = setupOf(rpBack.body);
    check('withdrawing the assertion returns the file to undecided',
      rpBack.status === 200 && backRec && backRec.gate && backRec.gate.willRun === null && !backRec.gate.assumed
      && ((rpBack.body.gatedAssumed || []).length === 0),
      JSON.stringify(backRec && backRec.gate));
  }

  console.log('\nDebugGameplay candidates (Local Cache fallback)');
  {
    const docsRoot = pathSc.join(scratch, 'docs-root');
    const localRoot = pathSc.join(scratch, 'local-root');
    const localCacheDb = pathSc.join(localRoot, 'Cache', 'DebugGameplay.sqlite');
    const envDb = pathSc.join(scratch, 'env-override.sqlite');
    fsSc.mkdirSync(docsRoot, { recursive: true });
    fsSc.mkdirSync(pathSc.dirname(localCacheDb), { recursive: true });
    fsSc.copyFileSync(fx.debugDb, localCacheDb);
    fsSc.copyFileSync(fx.debugDb, envDb);
    const savedEnv = process.env.CIV6_DEBUG_GAMEPLAY;
    const pathsMod = require('./paths');
    const savedMy = pathsMod.myGamesRoot;
    const savedLocal = pathsMod.localGamesRoot;
    pathsMod.myGamesRoot = () => docsRoot;
    pathsMod.localGamesRoot = () => localRoot;
    try {
      delete process.env.CIV6_DEBUG_GAMEPLAY;
      const cands = debugGameplayCandidates();
      check('candidates list env, Documents then Local Cache and bare',
        JSON.stringify(cands) === JSON.stringify([
          pathSc.join(docsRoot, 'Cache', 'DebugGameplay.sqlite'),
          pathSc.join(docsRoot, 'DebugGameplay.sqlite'),
          pathSc.join(localRoot, 'Cache', 'DebugGameplay.sqlite'),
          pathSc.join(localRoot, 'DebugGameplay.sqlite'),
        ]), JSON.stringify(cands));
      check('Local-side Cache found when Documents-side has none',
        findDebugGameplay() === localCacheDb, String(findDebugGameplay()));
      process.env.CIV6_DEBUG_GAMEPLAY = envDb;
      check('env override still wins over Local-side Cache',
        findDebugGameplay() === envDb, String(findDebugGameplay()));
    } finally {
      if (savedEnv === undefined) delete process.env.CIV6_DEBUG_GAMEPLAY;
      else process.env.CIV6_DEBUG_GAMEPLAY = savedEnv;
      pathsMod.myGamesRoot = savedMy;
      pathsMod.localGamesRoot = savedLocal;
    }
  }

  console.log('\nDatabase.log candidates (Local Logs fallback)');
  {
    const docsRoot = pathSc.join(scratch, 'docs-log-root');
    const localRoot = pathSc.join(scratch, 'local-log-root');
    const localLogsDb = pathSc.join(localRoot, 'Logs', 'Database.log');
    const envLog = pathSc.join(scratch, 'env-override.log');
    fsSc.mkdirSync(docsRoot, { recursive: true });
    fsSc.mkdirSync(pathSc.dirname(localLogsDb), { recursive: true });
    fsSc.writeFileSync(localLogsDb, '[100.001] [Gameplay] ERROR: stub\n');
    fsSc.writeFileSync(envLog, '[100.001] [Gameplay] ERROR: stub\n');
    const savedEnv = process.env.CIV6_DATABASE_LOG;
    const pathsMod = require('./paths');
    const savedMy = pathsMod.myGamesRoot;
    const savedLocal = pathsMod.localGamesRoot;
    pathsMod.myGamesRoot = () => docsRoot;
    pathsMod.localGamesRoot = () => localRoot;
    try {
      delete process.env.CIV6_DATABASE_LOG;
      const cands = databaseLogCandidates();
      check('candidates list Documents then Local Logs and bare',
        JSON.stringify(cands) === JSON.stringify([
          pathSc.join(docsRoot, 'Logs', 'Database.log'),
          pathSc.join(localRoot, 'Logs', 'Database.log'),
          pathSc.join(localRoot, 'Database.log'),
        ]), JSON.stringify(cands));
      check('Local-side Logs found when Documents-side has none',
        findDatabaseLog() === localLogsDb, String(findDatabaseLog()));
      process.env.CIV6_DATABASE_LOG = envLog;
      check('env override still wins over Local-side Logs',
        findDatabaseLog() === envLog, String(findDatabaseLog()));
    } finally {
      if (savedEnv === undefined) delete process.env.CIV6_DATABASE_LOG;
      else process.env.CIV6_DATABASE_LOG = savedEnv;
      pathsMod.myGamesRoot = savedMy;
      pathsMod.localGamesRoot = savedLocal;
    }
  }

  console.log('\nRead-only guards (live DBs and configs untouched, no writes)');
  check('fixture Mods.sqlite unchanged', sha(fx.modsDb) === modsBefore);
  check('live game DB content unchanged', sha(fx.debugDb) === debugBefore);
  check('live game DB mtime unchanged', fsSc.statSync(fx.debugDb).mtimeMs === debugMtime);
  const cfgAfter = fsSc.readdirSync(pathSc.join(__dirname, '..'))
    .filter((f) => /\.Civ6Cfg$/i.test(f))
    .map((f) => [f, fsSc.statSync(pathSc.join(__dirname, '..', f)).mtimeMs]);
  check('no .Civ6Cfg file written', JSON.stringify(cfgAfter) === JSON.stringify(cfgBefore),
    `${cfgBefore.length} config(s) before, ${cfgAfter.length} after`);
  const srvSrc = fsSc.readFileSync(pathSc.join(__dirname, 'server.js'), 'utf8');
  check('no POST route under /api/conflicts',
    !/req\.method === 'POST' && url\.pathname === '\/api\/conflicts/.test(srvSrc));
  const viewSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'conflicts.js'), 'utf8');
  const htmlSrc = fsSc.readFileSync(pathSc.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('report page issues no writes (no POST, no form)',
    !/postJson/.test(viewSrc) && !/method:\s*['"]POST['"]/i.test(viewSrc) && !/<form/i.test(viewSrc));
  check("the conflicts page is registered", /pages\s*\[\s*['"]conflicts['"]\s*\]/.test(viewSrc));
  check('navigation links to it', /data-nav="conflicts"/.test(htmlSrc));
  check('its script is loaded', /<script src="conflicts\.js"><\/script>/.test(htmlSrc));
  // The page loads nothing on show: every api("/api/conflicts...") call lives
  // in a click-triggered runner, never in show(). Extract show() by brace
  // matching rather than trusting a regex to find its end.
  const showAt = viewSrc.indexOf('cfShowConflicts');
  let depth = 0; let showBody = ''; let started = false;
  for (let i = showAt; i < viewSrc.length && showAt >= 0; i += 1) {
    const c = viewSrc[i];
    if (c === '{') { depth += 1; started = true; }
    if (started) showBody += c;
    if (c === '}') { depth -= 1; if (started && depth === 0) break; }
  }
  check('page show binds buttons but fetches nothing', showBody && !/api\s*\(\s*['"]\/api\/conflicts/.test(showBody));
  const calls = (srvSrc.match(/conflict(Shadowing|ReplayReport)\(/g) || []).length;
  const defs = (srvSrc.match(/function conflict(Shadowing|ReplayReport|SelfcheckSeed|GateOf|EffectiveOf|ActiveProfile|StageTotals)\b/g) || []).length;
  check('reports run only from their routes and the selfcheck', calls > 0 && calls <= defs + 4, `${calls} call site(s)`);
  // Drop idle keep-alive connections before closing: otherwise process.exit
  // below can race libuv handle teardown on Windows (UV_HANDLE_CLOSING).
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (pass) fsSc.rmSync(scratch, { recursive: true, force: true });
  else console.log(`  note: scratch kept at ${scratch}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-DIAGNOSIS 4.1: ALL SELFCHECK CHECKS PASSED' : 'CONFLICT-DIAGNOSIS 4.1: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// A missing mod database is not a reason to refuse the rest, and neither is a
// store that cannot be read - both are reported and the server carries on, the
// same way every other startup step does.
async function syncLoadOrderOverrides() {
  try {
    const modsDb = paths.getModsDb();
    if (!modsDb.exists) return;
    const g = await gameStatus();
    const r = loOrder.syncOverrides(modsDb.path, { gameRunning: g.running });
    if (r.deferred) {
      console.log('Load order: overrides not re-applied, Civ6 is running. Close it and resync.');
    } else if (r.changed) {
      const drift = `${r.drifted.length} drift${r.drifted.length === 1 ? "" : "s"} from a mod updating`;
      const odd = (r.orphans.length ? `, ${r.orphans.length} orphaned` : "")
        + (r.ambiguous.length ? `, ${r.ambiguous.length} ambiguous` : "");
      console.log(`Load order: re-applied ${r.applied.length} override${r.applied.length === 1 ? "" : "s"} (${drift}${odd})`);
    }
  } catch (e) {
    console.log(`Load order: overrides not re-applied - ${e.message}`);
  }
}
