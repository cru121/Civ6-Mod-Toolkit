'use strict';

const { MOD_NAME_SQL, prettyName } = require('./modsdb');

// UI file-shadowing enumeration (conflict-diagnosis task 3.1).
//
// Enumerates every UI path claimed by more than one enabled mod, sourcing
// file claims from Components/ComponentFiles/ModFiles UNION script-replacement
// claims from ComponentProperties.LuaReplace.
//
// The union is the whole point: a ReplaceUIScript action carries NO
// ComponentFiles links (see phase4 Test 14 - "the action with no <File> gets
// no link"), so its LuaReplace target is invisible to any file-list-only scan.
// A contest that exists only via LuaReplace reads as uncontested without it.
//
// Read-only: every query below is a SELECT. Callers open the database with
// node:sqlite { readOnly: true } and pass the handle in; this module never
// opens or writes anything itself.
//
// Scope: task 3.1 is enumeration with per-path claimant lists; task 3.2 adds
// the winner rule (strictly-greatest declared LoadOrder, else undefined with
// reason) in decideContestedPath / resolveWinners below; task 3.3 adds the
// timed envelope (scope counts + contested/decidable/undefined-by-reason +
// wall-clock) in buildEnvelope / formatEnvelope. The winner rule itself reads
// no secondary signal: the only table it consults beyond the claimant lists
// is ComponentProperties LoadOrder. Pairing + wrong-context warnings
// (detectSplitBrain / detectWrongContext, riding in the envelope via
// collectWarnings) are a separate, explicitly sound-but-incomplete layer:
// every warning names a provable problem, but a clean report proves nothing.

// Slash-unify and trim so a ModFiles row of `UI\Panel.lua` and a LuaReplace
// value of `UI/Panel.lua` join on one key. Case is preserved: the database
// stores the strings as written and this module does not second-guess them.
function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').trim();
}

// The selected mod group, or null when the database names none (a minimal
// fixture without ModGroups). Null means "no scoping" downstream.
function activeGroupId(db) {
  try {
    const g = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1 LIMIT 1').get();
    return g ? g.id : null;
  } catch (_) {
    return null;
  }
}

// ModRowIds switched on in the group, or null when there is no group to scope
// to. A mod with no ModGroupItems row in the group is NOT enabled (same rule
// as the load-order profile read: membership is by row, not by ModId).
function enabledModRowIds(db, groupId) {
  if (groupId == null) return null;
  try {
    const rows = db.prepare(
      'SELECT ModRowId AS id FROM ModGroupItems WHERE ModGroupRowId = ? AND Disabled = 0'
    ).all(groupId);
    return new Set(rows.map((r) => r.id));
  } catch (_) {
    return null;
  }
}

// A resolved name, or a readable one when nothing localised the tag.
// Same rule as the load-order view (displayNameOf over MOD_NAME_SQL +
// prettyName): a bare LOC_ tag is never a display name. Client-side
// renderCivText renders markup, not tags, so this lives here, server-side.
function displayNameOf(resolved, modId) {
  if (resolved && !/LOC_[A-Z0-9_]+/i.test(resolved)) return resolved;
  if (resolved) {
    try {
      return prettyName(resolved) || resolved;
    } catch (_) {
      return resolved;
    }
  }
  return modId;
}

// ModRowId -> { modId, name }. Best-effort English name via the shared
// MOD_NAME_SQL reader: the mod's own text for its Name tag, else the tag's
// text from any mod, else the raw tag prettified, else the ModId.
// Never throws; a bare Mods table is enough.
function modIndex(db) {
  try {
    const rows = db.prepare(
      `SELECT m.ModRowId AS rowId, m.ModId AS modId, ${MOD_NAME_SQL('p')} AS name
         FROM Mods m
         LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'`
    ).all();
    const out = new Map();
    for (const r of rows) {
      const modId = String(r.modId);
      out.set(r.rowId, { modId, name: displayNameOf(r.name, modId) });
    }
    return out;
  } catch (_) {
    // Minimal fixture without ModProperties/LocalizedText: tolerant read below.
  }
  const out = new Map();
  try {
    for (const m of db.prepare('SELECT ModRowId AS rowId, ModId AS modId FROM Mods').all()) {
      out.set(m.rowId, { modId: String(m.modId), name: String(m.modId) });
    }
  } catch (_) {
    return out;
  }
  let props = [];
  try {
    props = db.prepare("SELECT ModRowId AS rowId, Value AS value FROM ModProperties WHERE Name = 'Name'").all();
  } catch (_) {
    return out;
  }
  let texts = [];
  try {
    texts = db.prepare("SELECT ModRowId AS rowId, Tag AS tag, Text AS text FROM LocalizedText WHERE Locale = 'en_US'").all();
  } catch (_) {
    texts = [];
  }
  const ownText = new Map();
  const anyText = new Map();
  for (const t of texts) {
    ownText.set(`${t.rowId}\n${t.tag}`, t.text);
    if (!anyText.has(t.tag)) anyText.set(t.tag, t.text);
  }
  for (const p of props) {
    const e = out.get(p.rowId);
    if (!e || p.value == null) continue;
    const resolved = ownText.get(`${p.rowId}\n${p.value}`) || anyText.get(p.value) || String(p.value);
    e.name = displayNameOf(resolved, e.modId);
  }
  return out;
}

// Every claim in the database: normalized path -> Map(modRowId -> entry).
// Unscoped and unfiltered - scoping and the >1-claimant cut happen in
// enumerateContested, so a caller that wants the raw union can have it.
function collectClaims(db) {
  const byPath = new Map();
  const add = (rawPath, modRowId, claim) => {
    const path = normalizePath(rawPath);
    if (!path) return;
    let mods = byPath.get(path);
    if (!mods) {
      mods = new Map();
      byPath.set(path, mods);
    }
    let entry = mods.get(modRowId);
    if (!entry) {
      entry = { sources: new Set(), components: [] };
      mods.set(modRowId, entry);
    }
    entry.sources.add(claim.source);
    entry.components.push(claim);
  };

  for (const r of db.prepare(
    `SELECT c.ModRowId AS modRowId, c.ComponentRowId AS componentRowId,
            c.ComponentType AS componentType, c.ComponentId AS componentId,
            f.Path AS filePath
       FROM ComponentFiles cf
       JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId`
  ).all()) {
    add(r.filePath, r.modRowId, {
      source: 'file',
      componentRowId: r.componentRowId,
      componentType: r.componentType,
      componentId: r.componentId,
    });
  }

  // ReplaceUIScript targets live ONLY here, with zero ComponentFiles links.
  for (const r of db.prepare(
    `SELECT c.ModRowId AS modRowId, c.ComponentRowId AS componentRowId,
            c.ComponentType AS componentType, c.ComponentId AS componentId,
            p.Value AS target
       FROM ComponentProperties p
       JOIN Components c ON c.ComponentRowId = p.ComponentRowId
      WHERE p.Name = 'LuaReplace'`
  ).all()) {
    add(r.target, r.modRowId, {
      source: 'LuaReplace',
      componentRowId: r.componentRowId,
      componentType: r.componentType,
      componentId: r.componentId,
    });
  }
  return byPath;
}

// [{ path, claimants: [{ modId, name, sources, components }] }], sorted by
// path (claimants sorted by modId). Only paths with more than one ENABLED
// claimant mod appear; a path claimed twice by one mod, or by one enabled
// mod plus disabled ones, is uncontested and omitted.
function enumerateContested(db) {
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const mods = modIndex(db);
  const byPath = collectClaims(db);
  const out = [];
  for (const [path, claimants] of byPath) {
    const list = [];
    for (const [modRowId, entry] of claimants) {
      if (enabled && !enabled.has(modRowId)) continue;
      const m = mods.get(modRowId) || { modId: String(modRowId), name: String(modRowId) };
      list.push({
        modId: m.modId,
        name: m.name,
        sources: [...entry.sources].sort(),
        components: entry.components.map((c) => ({ ...c })),
      });
    }
    if (list.length > 1) {
      list.sort((a, b) => (a.modId < b.modId ? -1 : a.modId > b.modId ? 1 : 0));
      out.push({ path, claimants: list });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

module.exports = {
  normalizePath,
  activeGroupId,
  enabledModRowIds,
  modIndex,
  collectClaims,
  enumerateContested,
  parseLoadOrderValue,
  componentLoadOrders,
  claimantLoadOrder,
  decideContestedPath,
  resolveWinners,
  baseDlcModRowIds,
  modRowIdByModId,
  detectSplitBrain,
  detectWrongContext,
  collectWarnings,
  scopeCounts,
  buildEnvelope,
  formatEnvelope,
};

// Winner rule (task 3.2): strictly-greatest declared LoadOrder wins, else the
// path is undefined with reason no-declared-order (no claimant declares) or
// tie (shared max). Read-only; never picks, ranks, or implies a winner by any
// secondary signal (no content hashing, no filename heuristics, no install or
// scan order).

// A declared LoadOrder value, or null when there is none. Only the correctly
// spelled ComponentProperties row counts: a misspelled row (LaodOrder,
// LoadingOrder) is invisible to the engine, so for winner purposes the action
// declares nothing. Non-integer values are likewise undeclared rather than
// guessed at.
function parseLoadOrderValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) return null;
  return n;
}

// ComponentRowId -> declared integer LoadOrder, for every component carrying
// a correctly spelled, integer-parsable LoadOrder row. One SELECT per
// enumeration, shared by every contested path.
function componentLoadOrders(db) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT ComponentRowId AS cr, Value AS value FROM ComponentProperties WHERE Name = 'LoadOrder'"
  ).all()) {
    const n = parseLoadOrderValue(r.value);
    if (n !== null) out.set(r.cr, n);
  }
  return out;
}

// One claimant mod's declared value for a path: the max LoadOrder across the
// claiming components only (the components array of one enumerateContested
// claimant), or null when none of them declares. A LoadOrder on some other
// action of the same mod does not contend for this path, so it must not
// count: only the actions actually claiming the path decide. Two components
// of one mod claiming one path fold to their max, since the mod's
// latest-loading claim is the one that would contend.
function claimantLoadOrder(loadMap, components) {
  let best = null;
  for (const c of components || []) {
    const n = loadMap.get(c.componentRowId);
    if (n === undefined) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

// One enumerateContested entry ->
//   { path, status, reason, winner, tied, claimants }
// where status is 'decided' (winner { modId, name, value }, reason null) or
// 'undefined' (winner null, reason 'no-declared-order' with tied null, or
// reason 'tie' with value and tied [{ modId, name }] listing the sharers of
// the max). claimants carries every claimant with its per-mod value (null
// when that mod declares nothing for this path), in the entry's existing
// (modId-sorted) order. Tied claimants keep that order and are never ranked:
// a sorted claimant list is deterministic output order, not a verdict, and
// winner stays null on every undefined path.
function decideContestedPath(loadMap, entry) {
  const claimants = (entry.claimants || []).map((c) => ({
    modId: c.modId,
    name: c.name,
    sources: [...c.sources],
    value: claimantLoadOrder(loadMap, c.components),
  }));
  const declared = claimants.filter((c) => c.value !== null);
  if (!declared.length) {
    return { path: entry.path, status: 'undefined', reason: 'no-declared-order', winner: null, tied: null, claimants };
  }
  const max = declared.reduce((m, c) => (c.value > m ? c.value : m), declared[0].value);
  const top = declared.filter((c) => c.value === max);
  if (top.length === 1) {
    return {
      path: entry.path, status: 'decided', reason: null,
      winner: { modId: top[0].modId, name: top[0].name, value: max },
      tied: null, claimants,
    };
  }
  return {
    path: entry.path, status: 'undefined', reason: 'tie', value: max,
    winner: null, tied: top.map((c) => ({ modId: c.modId, name: c.name })), claimants,
  };
}

// Every contested path with its winner decision, sorted by path. Builds the
// LoadOrder map once; contested may be supplied (e.g. from
// enumerateContested) or read when omitted.
function resolveWinners(db, contested) {
  const list = contested || enumerateContested(db);
  const loadMap = componentLoadOrders(db);
  return list.map((e) => decideContestedPath(loadMap, e));
}

// Pairing + wrong-context warnings. Both read only the rows the enumeration
// already reads (action/file claims, LoadOrder decisions, mod names) plus the
// front-end mirror of the same action rows (Settings/SettingFiles); no disk
// reads, no new sources. Both warn only where provable and stay silent
// otherwise: an undefined pair side, a same-winner pair, and any file whose
// kind fits its action produce nothing. Base-game/DLC rows (relative
// ../../../ .modinfo paths, the load-order unprotectable shape) likewise
// produce nothing: a warning fires only when a real mod is involved.

// A UI screen and its layout load as a pair: UI/TopPanel.lua with
// UI/TopPanel.xml. { stem, ext } when path is one half of such a pair, else
// null. Stem folds directory and basename case (the paths join case-
// sensitively upstream, but a lua/xml split across case variants is the same
// screen either way); only .lua/.xml halves pair, never .lua/.lua.
function pairStem(path) {
  const p = normalizePath(path);
  const slash = p.lastIndexOf('/');
  const dir = slash < 0 ? '' : p.slice(0, slash);
  const base = slash < 0 ? p : p.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext !== 'lua' && ext !== 'xml') return null;
  return { stem: `${dir.toLowerCase()}/${base.slice(0, dot).toLowerCase()}`, ext };
}

// Base-game / DLC identity: the warning layer only. The game records its own
// content with .modinfo paths relative to the install folder
// (`../../../Base/...`, `../../../DLC/...`) while real mods carry absolute
// paths to a .modinfo on disk - the same predicate the load-order code uses
// to mark rows unprotectable (no .modinfo on disk). Enumeration and winner
// math never consult it: DLC claimants are still listed and still win. A
// database without the ScannedFiles linkage filters nothing.
function baseDlcModRowIds(db) {
  try {
    const rows = db.prepare(
      `SELECT m.ModRowId AS id, s.Path AS path
         FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId`
    ).all();
    const out = new Set();
    for (const r of rows) {
      const p = String(r.path == null ? '' : r.path).replace(/\\/g, '/').trim();
      if (p.startsWith('..')) out.add(r.id);
    }
    return out;
  } catch (_) {
    return new Set();
  }
}

// Lowercased ModId -> ModRowId, or null when unreadable. An id the map
// cannot place counts as real: the filter silences only provable base/DLC
// rows, never a mod it cannot place.
function modRowIdByModId(db) {
  try {
    const out = new Map();
    for (const r of db.prepare('SELECT ModRowId AS id, ModId AS modId FROM Mods').all()) {
      out.set(String(r.modId).toLowerCase(), r.id);
    }
    return out;
  } catch (_) {
    return null;
  }
}

// Lua/XML split-brain: a decided .lua whose matching .xml is decided for a
// DIFFERENT winning mod (or vice versa). The game loads each file from its
// named winner, so screen and layout can silently disagree. Either side
// undefined (no-declared-order or tie) means no winner is named, so there is
// nothing provable to warn about and the pair stays silent. DLC-vs-DLC pairs
// are likewise silent (intentional same-author layering): a pair warns only
// when a real mod wins at least one half, so mod-vs-DLC still fires. The
// optional db enables that filter; without it every split pair warns, as
// before.
function detectSplitBrain(decided, db) {
  const groups = new Map();
  for (const d of decided || []) {
    if (!d || d.status !== 'decided' || !d.winner) continue;
    const s = pairStem(d.path);
    if (!s) continue;
    let g = groups.get(s.stem);
    if (!g) {
      g = { luas: [], xmls: [] };
      groups.set(s.stem, g);
    }
    (s.ext === 'lua' ? g.luas : g.xmls).push(d);
  }
  const dlc = db ? baseDlcModRowIds(db) : null;
  const idOf = db ? modRowIdByModId(db) : null;
  const winnerIsReal = (winner) => {
    if (!dlc || !idOf) return true;
    const rowId = idOf.get(String(winner.modId).toLowerCase());
    return rowId === undefined || !dlc.has(rowId);
  };
  const out = [];
  for (const g of groups.values()) {
    for (const lua of g.luas) {
      for (const xml of g.xmls) {
        if (String(lua.winner.modId).toLowerCase() === String(xml.winner.modId).toLowerCase()) continue;
        if (!winnerIsReal(lua.winner) && !winnerIsReal(xml.winner)) continue;
        out.push({
          kind: 'split-brain',
          luaPath: lua.path,
          xmlPath: xml.path,
          luaWinner: { modId: lua.winner.modId, name: lua.winner.name },
          xmlWinner: { modId: xml.winner.modId, name: xml.winner.name },
        });
      }
    }
  }
  out.sort((a, b) => (a.luaPath < b.luaPath ? -1 : a.luaPath > b.luaPath ? 1
    : a.xmlPath < b.xmlPath ? -1 : a.xmlPath > b.xmlPath ? 1 : 0));
  return out;
}

// Action types whose content only runs inside a loaded game. A front-end
// (Settings) action of one of these never runs in the menu shell, files or
// no files. Matched exactly: the engine names its actions exactly, so a
// near-miss spelling is an unknown action and stays silent.
const GAMEPLAY_SCRIPT_TYPES = new Set(['AddGameplayScripts', 'GameplayScripts']);
// Actions whose files the game reads as database content: a .lua file here is
// parsed as data and fails. The mirror: actions whose files the game loads as
// scripts, where a .sql file fails as code. A .xml alongside a .lua under a
// script action is the screen/layout pair mechanism, not a bug, and never
// warns: only .sql is provably a database file in a script action.
const DATA_ACTION_TYPES = new Set(['UpdateDatabase', 'UpdateText']);
const SCRIPT_ACTION_TYPES = new Set(['AddGameplayScripts', 'GameplayScripts', 'AddUIScript', 'AddUserInterfaces']);

function fileExt(p) {
  const base = String(p == null ? '' : p).split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

// Every action-file claim in the database: in-game actions from
// Components/ComponentFiles/ModFiles, front-end actions from the
// Settings/SettingFiles/ModFiles mirror. File-less actions yield one row with
// a null filePath. Either half is guarded: a minimal database without the
// front-end tables (or without action tables at all) simply has no claims
// there instead of failing the whole report.
function actionClaims(db) {
  const out = [];
  try {
    for (const r of db.prepare(
      `SELECT c.ComponentRowId AS rowId, c.ModRowId AS modRowId,
              c.ComponentType AS type, c.ComponentId AS id, f.Path AS filePath
         FROM Components c
         LEFT JOIN ComponentFiles cf ON cf.ComponentRowId = c.ComponentRowId
         LEFT JOIN ModFiles f ON f.FileRowId = cf.FileRowId`
    ).all()) {
      out.push({ key: `c${r.rowId}`, scope: 'ingame', modRowId: r.modRowId, type: r.type, id: r.id, filePath: r.filePath });
    }
  } catch (_) {
    // No in-game action claims without the action tables.
  }
  try {
    for (const r of db.prepare(
      `SELECT s.SettingRowId AS rowId, s.ModRowId AS modRowId,
              s.SettingType AS type, s.SettingId AS id, f.Path AS filePath
         FROM Settings s
         LEFT JOIN SettingFiles sf ON sf.SettingRowId = s.SettingRowId
         LEFT JOIN ModFiles f ON f.FileRowId = sf.FileRowId`
    ).all()) {
      out.push({ key: `s${r.rowId}`, scope: 'frontend', modRowId: r.modRowId, type: r.type, id: r.id, filePath: r.filePath });
    }
  } catch (_) {
    // No front-end action claims without the front-end tables.
  }
  return out;
}

// Wrong-context placement, one row per offending file (or per file-less
// misplaced gameplay action). Enabled mods only, same scoping rule as the
// enumeration; mod names from the same index the panel shows.
function detectWrongContext(db) {
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const mods = modIndex(db);
  const dlc = baseDlcModRowIds(db);
  const claims = actionClaims(db);
  const filesOf = (key) => claims
    .filter((x) => x.key === key && x.filePath != null)
    .map((x) => normalizePath(x.filePath))
    .sort();
  const out = [];
  const warned = new Set();
  for (const c of claims) {
    if (enabled && !enabled.has(c.modRowId)) continue;
    if (dlc.has(c.modRowId)) continue;
    const m = mods.get(c.modRowId) || { modId: String(c.modRowId), name: String(c.modRowId) };
    if (c.scope === 'frontend' && GAMEPLAY_SCRIPT_TYPES.has(c.type)) {
      // One warning per misplaced action, not per file: the action itself is
      // in the wrong context whether or not it carries files.
      if (!warned.has(c.key)) {
        warned.add(c.key);
        out.push({
          kind: 'wrong-context', dir: 'gameplay-in-frontend', scope: c.scope,
          modId: m.modId, name: m.name, actionType: c.type, actionId: c.id,
          files: filesOf(c.key),
        });
      }
      continue;
    }
    if (c.filePath == null) continue;
    const file = normalizePath(c.filePath);
    const ext = fileExt(file);
    const dir = ext === 'lua' && DATA_ACTION_TYPES.has(c.type) ? 'script-in-data-action'
      : ext === 'sql' && SCRIPT_ACTION_TYPES.has(c.type) ? 'data-in-script-action'
      : null;
    if (!dir) continue;
    out.push({
      kind: 'wrong-context', dir, scope: c.scope,
      modId: m.modId, name: m.name, actionType: c.type, actionId: c.id,
      files: [file],
    });
  }
  out.sort((a, b) => {
    const am = a.modId.toLowerCase();
    const bm = b.modId.toLowerCase();
    if (am !== bm) return am < bm ? -1 : 1;
    if (a.actionType !== b.actionType) return a.actionType < b.actionType ? -1 : 1;
    const aa = String(a.actionId == null ? '' : a.actionId);
    const ba = String(b.actionId == null ? '' : b.actionId);
    if (aa !== ba) return aa < ba ? -1 : 1;
    const af = a.files[0] || '';
    const bf = b.files[0] || '';
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
  return out;
}

// Both warning layers over one decided list. decided may be supplied (as
// buildEnvelope does, reusing its own resolve pass) or read when omitted.
// Split-brain rows come first, then wrong-context rows; each layer is already
// internally sorted, so the concatenation is deterministic.
function collectWarnings(db, decided) {
  const list = decided || resolveWinners(db);
  return [...detectSplitBrain(list, db), ...detectWrongContext(db)];
}

// Enumeration envelope (task 3.3): the enabled scope plus the timed
// enumerate-then-decide outcome. Read-only; wall-clock covers the
// enumerateContested + resolveWinners pass only, never fixture seeding.
function scopeCounts(db) {
  const enabled = enabledModRowIds(db, activeGroupId(db));
  if (!enabled) {
    return {
      mods: db.prepare('SELECT count(*) AS n FROM Mods').get().n,
      components: db.prepare('SELECT count(*) AS n FROM Components').get().n,
    };
  }
  const ids = [...enabled];
  if (!ids.length) return { mods: 0, components: 0 };
  const holes = ids.map(() => '?').join(',');
  return {
    mods: ids.length,
    components: db.prepare(
      `SELECT count(*) AS n FROM Components WHERE ModRowId IN (${holes})`
    ).get(...ids).n,
  };
}

function buildEnvelope(db) {
  const t0 = Date.now();
  const contested = enumerateContested(db);
  const decided = resolveWinners(db, contested);
  const warnings = collectWarnings(db, decided);
  const wallClockMs = Date.now() - t0;
  let decidable = 0;
  let noDeclaredOrder = 0;
  let ties = 0;
  for (const d of decided) {
    if (d.status === 'decided') decidable += 1;
    else if (d.reason === 'tie') ties += 1;
    else noDeclaredOrder += 1;
  }
  const scope = scopeCounts(db);
  return {
    mods: scope.mods,
    components: scope.components,
    contested: contested.length,
    decidable,
    undefined: decided.length - decidable,
    noDeclaredOrder,
    ties,
    wallClockMs,
    warnings,
  };
}

function formatEnvelope(env) {
  const base = `envelope: ${env.mods} mods / ${env.components} components / ` +
    `${env.contested} contested (${env.decidable} decidable / ` +
    `${env.noDeclaredOrder} no-declared-order / ${env.ties} tie) in ${env.wallClockMs}ms`;
  const n = (env.warnings || []).length;
  // The zero case keeps the long-standing line byte-identical; a nonzero
  // count appends rather than reformats.
  return n ? `${base} + ${n} pairing/placement warning${n === 1 ? '' : 's'}` : base;
}
