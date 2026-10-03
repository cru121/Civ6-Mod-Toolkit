'use strict';

// Overrides for individual mod actions' LoadOrder, in one JSON file beside
// civ6-paths.json. Global, not per profile: LoadOrder is a property of the
// installation, and two profiles holding the same mod should load that mod's
// actions at the same position.
//
// Keys are modinfo.normId() output - the mod's own GUID from its .modinfo,
// lowercased and unbraced - and NOT ModRowId, which the game renumbers on every
// rescan. The action key inside a mod is (ComponentType, id, file list); see
// actionKey() for why those three and nothing else.
//
// Reading never throws and never writes. A file we wrote ourselves that we can
// no longer parse must degrade to "no overrides with a message", never take the
// mod list down with it.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normId } = require('./modinfo');
const { atomicWrite } = require('./editor');
const { fileTimeOf, mutateDb, MOD_NAME_SQL, prettyName } = require('./modsdb');
const { gameStatus } = require('./game');
const { readSetup, isAsserted, gameSetupFile, splitCommaList, leaderTail, idKey } = require('./gamesetup');

const VERSION = 1;
// A key is a type, an id and a file list. Nothing in the library makes one this
// long; the cap is here so a hand-edited file cannot put megabytes in a key.
const MAX_KEY = 4000;
// The library contains -200, 4, 1e8 and 22222 as legitimate author choices, so
// values are checked for being whole numbers and not for being in a range.
const MIN_VALUE = -1e9;
const MAX_VALUE = 1e12;
// The bulk cap the design left open ("bulk limit (e.g. 200 actions) to be
// set at implementation"). 1000: a block move is one mod's positioned
// actions, and the largest single-mod counts seen in the library are in the
// low hundreds (Harmony in Diversity: 222 actions; 48 mods share 286 actions
// across 65 identical-key groups) against 3176 actions in 426 mods - so 1000
// never binds a real block move but stops a runaway or hand-built packet
// becoming an unbounded single transaction. Checked up front in applyBulk,
// before the game guard and before any write, so an oversized batch costs
// nothing.
const MAX_BULK_ENTRIES = 1000;

// Where the file lives. Overridable, for tests and for a relocated install.
function overridesFile() {
  return process.env.CIV6_LOADORDER_FILE || path.join(__dirname, '..', 'load-order-overrides.json');
}

// ---------------------------------------------------------------------------
// Action identity
// ---------------------------------------------------------------------------

// The key is (ComponentType, id, sorted file list), newline separated.
//
// The components were chosen by measuring collisions within a mod across all
// 3176 actions in the library:
//
//   id alone                        760 (23.91%)  - Civ6's editor leaves NewAction
//   (id, type)                       99 ( 3.12%)
//   (file list, type)               286 ( 9.00%)  - 8.2% of actions have no files
//   (file list, type, id)            11 ( 0.35%)  <- chosen
//   the same, plus an ordinal          0           <- rejected, see below
//
// The declared LoadOrder is deliberately NOT part of the key: it is the one
// thing that changes on exactly the updates an override has to survive, so
// including it would orphan every override the moment its author bumped it.
//
// An ordinal was rejected rather than added. It is unique within a mod by
// construction, so it drives the count to zero - and that is why it is wrong.
// 48 mods hold 286 actions in 65 groups sharing an identical type and file list;
// in 38 of those the file list is empty, so the ordinal would be the only
// discriminator. Those are the large multi-action mods, and an author inserting
// one action renumbers everything after it. A wrong ordinal does not error: it
// silently moves a neighbour's action, and the user finds out three sessions
// later. A dropped override is noticed immediately. For a tool writing to a
// live game database the loud failure is worth more than the quiet one.

// Newlines would make the key ambiguous, and a path cannot contain one, but an
// XML attribute value could. Collapse whitespace so every part is one line.
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function keyFor(type, id, files) {
  const lines = [oneLine(type), oneLine(id)];
  for (const f of [...(files || [])].map((x) => oneLine(x).split('\\').join('/')).sort()) {
    if (f) lines.push(f);
  }
  return lines.join('\n');
}

// Read one action's identity out of the database. The game wrote these rows, and
// they were measured to agree with the .modinfo on disk for 384 of 384 mods, so
// there is no need to parse any file here.
function actionKey(db, componentRowId) {
  const c = db.prepare('SELECT ComponentType AS type, ComponentId AS id FROM Components WHERE ComponentRowId = ?')
    .get(componentRowId);
  if (!c) return null;
  const files = db.prepare(
    `SELECT f.Path AS path
       FROM ComponentFiles cf
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId
      WHERE cf.ComponentRowId = ?
      ORDER BY f.Path`
  ).all(componentRowId).map((r) => r.path);
  return keyFor(c.type, c.id, files);
}

const FIND = 'found';
const MISSING = 'missing';
const AMBIGUOUS = 'ambiguous';

// Find the action one stored key names, inside one mod.
//
// Exactly one match, or a report. Never a best guess, and never an ordinal
// fallback: the 0.35% that do not resolve uniquely are actions their own author
// never told apart, so the user cannot say which one they meant either.
function resolveAction(db, modIdNorm, key) {
  const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modIdNorm);
  if (!mod) return { state: MISSING, candidates: [] };

  const wanted = String(key == null ? '' : key);
  const rows = db.prepare('SELECT ComponentRowId FROM Components WHERE ModRowId = ? ORDER BY ComponentRowId')
    .all(mod.ModRowId);
  const hits = [];
  for (const r of rows) {
    if (actionKey(db, r.ComponentRowId) === wanted) hits.push(r.ComponentRowId);
  }
  if (hits.length === 1) return { state: FIND, componentRowId: hits[0], candidates: hits };
  if (hits.length === 0) return { state: MISSING, candidates: [] };
  return { state: AMBIGUOUS, componentRowId: null, candidates: hits };
}

// ---------------------------------------------------------------------------
// Action files
// ---------------------------------------------------------------------------

// Basenames only. Full relative paths never leave the server: the client gets
// `Data.sql`, never `Patches/Data.sql`, and no request-supplied path is ever
// echoed back.
function fileBase(p) {
  return String(p == null ? '' : p).split(/[/\\]/).pop();
}

// One action's file list, resolved strictly from the database
// (ComponentFiles -> ModFiles). Null when no action has that row id, so the
// route can answer 404: an empty list is a real answer (the action genuinely
// has no files), while an unknown id is not.
function actionFiles(db, componentRowId) {
  const row = db.prepare('SELECT ComponentRowId FROM Components WHERE ComponentRowId = ?').get(componentRowId);
  if (!row) return null;
  return db.prepare(
    `SELECT f.Path AS path
       FROM ComponentFiles cf
       JOIN ModFiles f ON f.FileRowId = cf.FileRowId
      WHERE cf.ComponentRowId = ?
      ORDER BY f.Path`
  ).all(componentRowId).map((r) => fileBase(r.path));
}

function notFound(msg) {
  const e = new Error(msg);
  e.code = 'NOT_FOUND';
  return e;
}

// The route's single-action shape. A malformed id is a 400 about the request;
// an unknown one carries NOT_FOUND, which the route maps to 404.
function actionFilesOf(dbPath, rawId) {
  const t = String(rawId == null ? '' : rawId).trim();
  if (!/^-?\d+$/.test(t)) throw new Error('that action id is not a whole number');
  const db = openDb(dbPath);
  try {
    const files = actionFiles(db, Number(t));
    if (files === null) throw notFound('no such action');
    return { componentRowId: Number(t), files };
  } finally {
    db.close();
  }
}

// The route's batch shape: every action of one mod, in row order. Read-only,
// so like every other GET it works while Civ6 runs.
function modActionFilesOf(dbPath, rawMod) {
  const id = cleanModId(rawMod);
  const db = openDb(dbPath);
  try {
    const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(id);
    if (!mod) throw notFound('no such mod');
    const rows = db.prepare('SELECT ComponentRowId FROM Components WHERE ModRowId = ? ORDER BY ComponentRowId')
      .all(mod.ModRowId);
    return {
      modId: id,
      actions: rows.map((r) => ({ componentRowId: r.ComponentRowId, files: actionFiles(db, r.ComponentRowId) || [] })),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

// A whole number, and in range. Not a range check on the author - the library
// uses -200 and 100000001 - but a bound wide enough that a typo cannot put a
// 10^30 into the database.
function cleanValue(v) {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new Error('a load order must be a whole number');
  if (n < MIN_VALUE || n > MAX_VALUE) throw new Error('that load order is out of range');
  return n;
}

// A Civ6 mod id is a GUID. Every one of the 426 distinct ModIds in a real
// library is GUID-shaped once normId has stripped the braces some mods carry -
// measured, not assumed, because a check that could reject a real mod would be
// worse than the junk it filters.
//
// normId itself does not validate: it lowercases and strips braces, so a
// hand-edited key of "not-a-guid" survives it. That is right for a comparison
// key and wrong for a storage key, because such an entry can never match a mod
// and would sit in the file forever claiming to be an override.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isModId(k) {
  return !!k && GUID.test(k);
}

// A key arrives from the database or from a hand-edited file, so it is checked
// for shape rather than trusted.
function cleanKey(k) {
  const s = String(k == null ? '' : k);
  if (!s) throw new Error('which action?');
  if (s.length > MAX_KEY) throw new Error(`that action key is longer than ${MAX_KEY} characters`);
  return s;
}

function cleanModId(id) {
  const k = normId(id);
  if (!k) throw new Error('which mod?');
  if (!isModId(k)) throw new Error(`"${k}" is not a mod id`);
  return k;
}

// The file's own text -> { overrides, error, unusable }. Two levels of failure,
// and the difference matters: a file that is not the shape we write is unusable
// as a whole, while one bad entry among good ones costs only that entry.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { overrides: {}, error: `load-order-overrides.json is not valid JSON (${e.message})`, unusable: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides: {}, error: 'load-order-overrides.json does not contain an object', unusable: true };
  }
  // A missing version is treated as the current one, so a file written before
  // the field existed still loads. A different one we did not write, and whose
  // shape we cannot vouch for, is refused rather than half-understood.
  if (raw.version !== undefined && raw.version !== VERSION) {
    return {
      overrides: {},
      error: `load-order-overrides.json is version ${JSON.stringify(raw.version)}; this toolkit reads version ${VERSION}`,
      unusable: true,
    };
  }
  if (raw.overrides === undefined || raw.overrides === null) return { overrides: {}, error: null };
  if (typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
    return { overrides: {}, error: 'load-order-overrides.json has no "overrides" object', unusable: true };
  }

  const overrides = {};
  let dropped = 0;
  for (const [rawId, byKey] of Object.entries(raw.overrides)) {
    const id = normId(rawId);
    if (!isModId(id) || !byKey || typeof byKey !== 'object' || Array.isArray(byKey)) { dropped++; continue; }
    const set = {};
    for (const [rawKey, entry] of Object.entries(byKey)) {
      // A bare number is accepted so a hand-written file works. The richer form
      // carries the author's declared value, which is the only copy left once
      // we have overwritten the database - see setOverride.
      const value = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry.value : entry;
      let n;
      try { n = cleanValue(value); } catch (_) { dropped++; continue; }
      const out = { value: n };
      if (entry && typeof entry === 'object' && entry.declared !== undefined) {
        try { out.declared = cleanValue(entry.declared); } catch (_) { /* not fatal - reset is the only thing it is for */ }
      }
      set[cleanKey(rawKey)] = out;
    }
    if (Object.keys(set).length) overrides[id] = set;
  }
  return {
    overrides,
    error: dropped
      ? `${dropped} entr${dropped === 1 ? 'y' : 'ies'} in load-order-overrides.json could not be read and ${dropped === 1 ? 'was' : 'were'} ignored`
      : null,
  };
}

function view(overrides, error, unusable = false) {
  let count = 0;
  for (const set of Object.values(overrides)) count += Object.keys(set).length;
  return { overrides, count, error: error || null, unusable };
}

// Read the file. Nothing is written here, ever.
//
// `known` is the set of mod ids the caller can vouch for, or null when it
// cannot - the database would not read, or the game is part-way through a
// rescan. Pruning against an incomplete set would delete real overrides, so
// those reads prune nothing.
function readOverrides(file = overridesFile(), known = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state. Having no overrides is not a failure.
    if (e.code === 'ENOENT') return view({}, null);
    return view({}, `load-order-overrides.json could not be read (${e.message})`, true);
  }
  if (!text.trim()) return view({}, null); // an empty file is no overrides

  const { overrides, error, unusable } = parse(text);
  if (known) {
    for (const id of Object.keys(overrides)) {
      if (!known.has(id)) delete overrides[id];
    }
  }
  return view(overrides, error, unusable);
}

// Write the map out. One plain file and no backups, on the same reasoning as
// mod-labels.json: it is a few kilobytes, written by one synchronous handler,
// and a lost override is a nuisance rather than a hazard. Mods.sqlite earns its
// ten backups because the game writes it too and can be interrupted mid-write.
//
// Keys are written in sorted order so the file is stable and diffable by hand -
// which matters because the action key is a readable string on purpose, so a
// user reporting "my override stopped matching" can be answered by looking.
function writeOverrides(file, overrides) {
  const body = { version: VERSION, overrides: {} };
  for (const id of Object.keys(overrides).sort()) {
    const set = overrides[id];
    if (!set || !Object.keys(set).length) continue;
    const out = {};
    for (const k of Object.keys(set).sort()) {
      const e = set[k];
      out[k] = e && e.declared !== undefined ? { value: e.value, declared: e.declared } : e.value;
    }
    body.overrides[id] = out;
  }
  atomicWrite(file, JSON.stringify(body, null, 2));
}

// The read a write is built on. Refuses outright if the file exists but is not
// the shape we write: building on an unreadable file would replace whatever it
// holds, and a corrupt file is fixed or deleted by hand rather than overwritten
// by a click the user did not think of as destructive.
function readForWrite(file, known) {
  const v = readOverrides(file, known);
  if (v.unusable) {
    throw new Error(`${v.error} - nothing was written. Fix or delete load-order-overrides.json, then try again.`);
  }
  return v;
}

// Store one action's override, and return the refreshed view.
//
// `declared` is the author's value as the game currently has it, and it is kept
// because the moment we write the override the database no longer holds it -
// nothing else does. Reset needs it, and it is what the view shows as
// "author declares 5000".
//
// The file is re-read inside the call rather than sent by the caller: two tabs
// open, each overriding a different action, and a client that PUT the whole file
// would silently discard the other tab's change. Node handles one request at a
// time on one thread, so read-modify-write needs no lock.
function setOverride(file, modId, key, value, declared) {
  const id = cleanModId(modId);
  const k = cleanKey(key);
  const v = cleanValue(value);
  const current = readForWrite(file, null);

  const entry = { value: v };
  if (declared !== undefined && declared !== null) {
    try { entry.declared = cleanValue(declared); } catch (_) { /* optional */ }
  }
  const set = { ...(current.overrides[id] || {}) };
  // A new declared value is only recorded when we have one. Losing a recorded
  // one because the caller could not read the current value would be worse than
  // not having recorded it.
  if (entry.declared === undefined && set[k] && set[k].declared !== undefined) {
    entry.declared = set[k].declared;
  }
  set[k] = entry;

  const next = { ...current.overrides, [id]: set };
  writeOverrides(file, next);
  return readOverrides(file, null);
}

// Forget one action's override. The caller restores the author's value in the
// database; this only stops the toolkit putting it back on the next sync.
function clearOverride(file, modId, key) {
  const id = cleanModId(modId);
  const k = cleanKey(key);
  const current = readForWrite(file, null);
  if (!current.overrides[id] || !(k in current.overrides[id])) {
    throw new Error('no override is stored for that action');
  }
  const set = { ...current.overrides[id] };
  delete set[k];
  const next = { ...current.overrides };
  if (Object.keys(set).length) next[id] = set; else delete next[id];

  writeOverrides(file, next);
  return readOverrides(file, null);
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

// Read-only, and closed by the caller. modsdb.readModState opens its own the
// same way: one connection per operation, no cache, so a value written a
// moment ago is always the value read.
function openDb(dbPath, { readOnly = true } = {}) {
  return new DatabaseSync(dbPath, { readOnly });
}

// The mod's .modinfo on disk, and whether we could find it.
//
// 42 of 427 rows are base-game or DLC assets recorded with relative ../../../
// paths, so they are not on disk under any local or workshop root and their
// mtime cannot be read. Nothing can keep their stamp, so an override on one of
// them is re-derived on the next rescan. They are reported as not protected
// rather than quietly treated as safe.
function modFile(db, modRowId) {
  const row = db.prepare(
    `SELECT s.ScannedFileRowId AS scannedFileRowId, s.Path AS path
       FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
      WHERE m.ModRowId = ?`
  ).get(modRowId);
  if (!row) return null;
  try {
    fs.statSync(row.path);
    return { ...row, onDisk: true };
  } catch (_) {
    return { ...row, onDisk: false };
  }
}

// The stamp the game compares the file's mtime against, and the value we must
// write to make it see "nothing changed". A string, always - the column does not
// fit a JavaScript number and throws RangeError on conversion.
//
// fileTimeOf carries the file's FULL nanosecond mtime. Rounding to whole
// milliseconds leaves the stamp about half a millisecond behind, which reads as
// exactly the change we are trying to hide, and an experiment that did that
// reported a confident false FAIL.
function stampFor(filePath) {
  return fileTimeOf(filePath).toString();
}

// Whether the game will re-register this mod on its next launch: it will, if
// the stamp in the database does not already match the file. Null when the
// file is not on disk, because then there is nothing to compare and nothing to
// keep up to date.
function stampIsStale(db, modRowId) {
  const file = modFile(db, modRowId);
  if (!file || !file.onDisk) return null;
  // CAST to TEXT, always. A Windows FILETIME is ~1.34e17, which does not fit a
  // JavaScript number, and the driver throws RangeError rather than rounding.
  // This has bitten three times in this project; the cast is not optional and
  // the column must never be read as a number.
  const row = db.prepare('SELECT CAST(LastWriteTime AS TEXT) AS t FROM ScannedFiles WHERE ScannedFileRowId = ?')
    .get(file.scannedFileRowId);
  if (!row) return true;
  return String(row.t) !== stampFor(file.path);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

// Civ6's "load last, override everything" sentinel. Moving an action off one of
// these changes the author's intent, so the caller is told - it is not refused,
// because a refusal here would be the toolkit overruling a decision the user
// made on purpose.
const SENTINEL = 10000000;

function modRowOf(db, modIdNorm) {
  const r = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modIdNorm);
  return r ? r.ModRowId : null;
}

// The two real misspellings in the wild, read but never written. A mod that
// ships `LaodOrder` has told us its position, and refusing to look at it would
// leave reset with nothing to go back to and the view unable to say what the
// author declared. Reading it is not the same as touching it: writeValue only
// ever writes the correctly spelled row.
const MISSPELLINGS = ['LaodOrder', 'LoadingOrder'];

// What the game currently has for one action. The correctly spelled row wins;
// a misspelled one is the fallback, because it is the only other record of what
// the mod asked for.
function currentValue(db, componentRowId) {
  const row = db.prepare("SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
    .get(componentRowId);
  if (row) return String(row.v);
  for (const name of MISSPELLINGS) {
    const alt = db.prepare('SELECT Value AS v FROM ComponentProperties WHERE ComponentRowId = ? AND Name = ?')
      .get(componentRowId, name);
    if (alt) return String(alt.v);
  }
  return null;
}

// Always the correctly spelled row: update it if it exists, and add it if not,
// so an action that declared no position can be given one. A misspelled row is
// left exactly as the mod shipped it, and never blocks the write.
function writeValue(db, componentRowId, value) {
  const r = db.prepare("UPDATE ComponentProperties SET Value = ? WHERE ComponentRowId = ? AND Name = 'LoadOrder'")
    .run(String(value), componentRowId);
  if (r.changes === 0) {
    db.prepare("INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, 'LoadOrder', ?)")
      .run(componentRowId, String(value));
  }
}

function writeStamp(db, scannedFileRowId, value) {
  db.prepare('UPDATE ScannedFiles SET LastWriteTime = ? WHERE ScannedFileRowId = ?').run(value, scannedFileRowId);
}

// One stored override, and what is actually true of it right now.
function inspect(db, modIdNorm, key, wanted) {
  const res = resolveAction(db, modIdNorm, key);
  const out = { modId: modIdNorm, key, state: res.state, componentRowId: res.componentRowId, candidates: res.candidates };
  if (res.state !== FIND) return out;
  const before = currentValue(db, res.componentRowId);
  return {
    ...out,
    before,
    wanted: String(wanted),
    // A missing row is drift too: the action declares nothing, and the override
    // is what gives it a position.
    drifted: before !== String(wanted),
  };
}

// One mod's worth of work: the overrides on it, and whether its stamp needs
// re-writing. The stamp is maintained whether or not any value drifted, because
// it is what stops the game re-deriving the whole mod.
function planMod(db, modIdNorm, set) {
  const modRowId = modRowOf(db, modIdNorm);
  if (modRowId === null) {
    return { modId: modIdNorm, missing: true, entries: [], stale: false, protectable: false };
  }
  const entries = Object.entries(set).map(([key, e]) => inspect(db, modIdNorm, key, e.value));
  const file = modFile(db, modRowId);
  return {
    modId: modIdNorm,
    modRowId,
    missing: false,
    entries,
    // null means not on disk: nothing to stamp, and nothing to claim.
    stale: stampIsStale(db, modRowId),
    protectable: !!(file && file.onDisk),
    scannedFileRowId: file ? file.scannedFileRowId : null,
  };
}

function needsWrite(mods) {
  return mods.some((m) => !m.missing && (m.stale === true || m.entries.some((e) => e.drifted && e.state === FIND)));
}

// Fold what was applied into the store, in one file write.
//
// A declared value already on file always wins over one read out of the database
// during this apply. By then the database holds the override, not the author's
// choice, so taking the fresh reading would replace 9999 with 4242 and leave
// reset restoring the override. Only a first apply, which has nothing on file,
// takes the value it read.
function recordApplied(file, applied) {
  const current = readForWrite(file, null);
  const next = { ...current.overrides };
  for (const a of applied) {
    const id = normId(a.modId);
    const set = { ...(next[id] || {}) };
    const onFile = set[a.key] ? set[a.key].declared : undefined;
    const declared = onFile !== undefined ? onFile : a.declared;
    set[a.key] = declared === undefined || declared === null ? { value: a.value } : { value: a.value, declared };
    next[id] = set;
  }
  writeOverrides(file, next);
  return readOverrides(file, null);
}

// The write itself, shared by apply and sync so the two cannot drift.
//
// Every entry's value and the mod's stamp go in the same transaction, because
// a value committed with a stale stamp is a value the game removes on its next
// launch: the user watches it apply and then vanish. If the stamp cannot be
// written, the value must not be either.
function writeAll(db, mods) {
  const applied = [];
  for (const m of mods) {
    if (m.missing) continue;
    for (const e of m.entries) {
      if (e.state !== FIND || !e.drifted) continue;
      // `wanted`, not `value`: inspect() returns the wanted value under that
      // name, and reading e.value wrote the string "undefined" into the
      // database while every check that only counted rows went green.
      writeValue(db, e.componentRowId, e.wanted);
      // The row it landed on, so a caller can show or re-check it. It is the
      // NEW id after a rescan, which is the whole point of resolving by key.
      applied.push({ modId: m.modId, key: e.key, value: Number(e.wanted), declared: e.before, componentRowId: e.componentRowId });
    }
    if (m.protectable && m.stale === true) writeStamp(db, m.scannedFileRowId, stampFor(modFile(db, m.modRowId).path));
  }
  return applied;
}

function summarise(mods, applied, backupPath) {
  const drifted = [];
  const orphans = [];
  const ambiguous = [];
  const unprotectable = [];
  for (const m of mods) {
    if (m.missing) { orphans.push({ modId: m.modId, reason: 'no such mod' }); continue; }
    if (!m.protectable) unprotectable.push(m.modId);
    for (const e of m.entries) {
      const at = { modId: m.modId, key: e.key, candidates: e.candidates };
      if (e.state === MISSING) orphans.push({ ...at, reason: 'no action matches that key' });
      else if (e.state === AMBIGUOUS) ambiguous.push({ ...at, reason: `${e.candidates.length} actions match that key` });
      else if (e.drifted) drifted.push({ ...at, from: e.before, to: e.wanted });
    }
  }
  const sentinels = applied.filter((a) => a.value >= SENTINEL).map((a) => ({ modId: a.modId, key: a.key, value: a.value }));
  return {
    changed: applied.length > 0 || mods.some((m) => m.stale === true),
    applied, drifted, orphans, ambiguous, unprotectable, sentinels, backupPath,
  };
}

// Apply a set of overrides by hand. One transaction, one backup, whatever the
// size of the set.
//
// The game check is inside this function and awaited, not left to the caller.
// An experiment script during the investigation read the result of an async
// gameStatus() as a plain object, so `running` was always undefined and the
// guard never fired - it looked like it was refusing to write while Civ6 ran
// and was not. A safety check that cannot fail is not a safety check.
async function applyOverrides(dbPath, entries, opts = {}) {
  const file = opts.file || overridesFile();
  // Injectable so the guard can be tested without starting Civilization VI.
  // The default is the real check, and there is no way to pass "skip it".
  const status = opts.statusFn || gameStatus;
  if (!Array.isArray(entries) || !entries.length) throw new Error('no overrides to apply');

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);

  const clean = entries.map((e) => ({
    modId: cleanModId(e.modId), key: cleanKey(e.key), value: cleanValue(e.value),
  }));

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const mods = clean.map((e) => planMod(db, e.modId, { [e.key]: { value: e.value } }));
    return summarise(mods, writeAll(db, mods), null);
  });
  // The store is written after the database commits, never before. A store
  // write that failed would leave an override that works but is not recorded, so
  // it is not re-applied after an update - loud, and fixable. The other order
  // would leave an override that does not work at all.
  recordApplied(file, result.applied);
  return { ...result, backupPath };
}

// Bulk apply for a block move (load-order-edit 2.1). One transaction, one
// backup, whatever the size of the set: entries are grouped by mod and go
// through the same planMod/writeAll/summarise path as applyOverrides, so a
// value and its mod's stamp land together or not at all.
//
// Entries take one of two shapes, mixed freely:
//   { modId, key, value }              - a stored action key, as applyOverrides takes
//   { modId, componentRowId, value }   - the editor packet: the key is derived
//     server-side via actionKey and resolved via resolveAction, so a stale row
//     reports orphaned and twins report ambiguous, never written.
// Values pass cleanValue (whole numbers; >= SENTINEL warns, never refuses).
// The store folds in after commit with the same declared-wins recordApplied
// rule. Refused while Civ6 runs, via the awaited gameStatus check.
// Out: { changed, applied, drifted, orphans, ambiguous, unprotectable,
// sentinels, backupPath } - the summarise shape, so the bulk route (2.2) can
// answer with it unchanged.
async function applyBulk(dbPath, entries, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  if (!Array.isArray(entries) || !entries.length) throw new Error('no overrides to apply');
  if (entries.length > MAX_BULK_ENTRIES) {
    throw new Error(`that batch names ${entries.length} actions (limit ${MAX_BULK_ENTRIES}) - nothing was written`);
  }

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);

  const clean = entries.map((e) => {
    const modId = cleanModId(e.modId);
    const value = cleanValue(e.value);
    if (e.key !== undefined && e.key !== null) return { modId, key: cleanKey(e.key), value };
    const cr = Number(e.componentRowId);
    if (!Number.isInteger(cr) || cr <= 0) throw new Error('that action id is not a whole number');
    return { modId, componentRowId: cr, value };
  });

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const byMod = new Map();
    const earlyOrphans = [];
    const setOf = (id) => {
      let m = byMod.get(id);
      if (!m) { m = new Map(); byMod.set(id, m); }
      return m;
    };
    for (const e of clean) {
      if (e.key !== undefined) { setOf(e.modId).set(e.key, e.value); continue; }
      const row = db.prepare(
        'SELECT m.ModId AS mid FROM Components c JOIN Mods m ON m.ModRowId = c.ModRowId WHERE c.ComponentRowId = ?'
      ).get(e.componentRowId);
      if (!row || normId(row.mid) !== e.modId) {
        earlyOrphans.push({ modId: e.modId, key: null, componentRowId: e.componentRowId, candidates: [],
          reason: row ? 'that action is not part of this mod' : 'no action matches that key' });
        continue;
      }
      const key = actionKey(db, e.componentRowId);
      if (key === null) {
        earlyOrphans.push({ modId: e.modId, key: null, componentRowId: e.componentRowId, candidates: [],
          reason: 'no action matches that key' });
        continue;
      }
      setOf(e.modId).set(key, e.value); // last wins; twins resolve AMBIGUOUS below anyway
    }
    const mods = [...byMod].map(([id, m]) =>
      planMod(db, id, Object.fromEntries([...m].map(([k, v]) => [k, { value: v }]))));
    const summary = summarise(mods, writeAll(db, mods), null);
    summary.orphans.push(...earlyOrphans);
    return summary;
  });
  recordApplied(file, result.applied);
  return { ...result, backupPath };
}

// Put one action back to the author's value, in the database and in the store.
async function resetOverride(dbPath, modId, key, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);
  const k = cleanKey(key);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);
  const entry = (stored.overrides[id] || {})[k];
  if (!entry) throw new Error('no override is stored for that action');
  if (entry.declared === undefined) {
    throw new Error("the author's value for that action was never recorded, so there is nothing to go back to");
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const mods = [planMod(db, id, { [k]: { value: entry.declared } })];
    return summarise(mods, writeAll(db, mods), null);
  });
  clearOverride(file, id, k);
  return { ...result, restored: entry.declared, backupPath };
}

// Put every override of one mod back to its recorded author value, in the
// database and in the store. One transaction, one backup, whatever the size
// of the set: the entries are folded into a single planMod so a value and
// its mod's stamp land together or not at all, reusing the single-entry
// write path (planMod/writeAll/summarise).
//
// Refuses when any entry lacks a recorded declared value, before any write,
// so nothing is half-done: neither the database nor the store is touched.
async function resetModOverrides(dbPath, modId, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const stored = readOverrides(file);
  if (stored.unusable) throw new Error(`${stored.error} - nothing was written`);
  const set = stored.overrides[id];
  if (!set || !Object.keys(set).length) throw new Error('no overrides are stored for that mod');
  const entries = Object.entries(set);
  const missing = entries.filter(([, e]) => e.declared === undefined);
  if (missing.length) {
    throw new Error(`the author's value for ${missing.length} action${missing.length === 1 ? '' : 's'} was never recorded, so there is nothing to go back to - nothing was written`);
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    const wanted = Object.fromEntries(entries.map(([k, e]) => [k, { value: e.declared }]));
    const mods = [planMod(db, id, wanted)];
    return summarise(mods, writeAll(db, mods), null);
  });
  const current = readForWrite(file, null);
  const next = { ...current.overrides };
  delete next[id];
  writeOverrides(file, next);
  return { ...result, restored: entries.map(([k, e]) => ({ key: k, value: e.declared })), backupPath };
}

// Forget every override of one mod WITHOUT touching the database. The values
// stay where the last apply put them, which the client says in its confirm:
// discarding is not the same as resetting, and only one of them undoes what
// the override did. One file write, reusing the single-entry clear path's
// read-and-write shape. Refused while Civ6 runs like all writes.
async function discardModOverrides(dbPath, modId, opts = {}) {
  const file = opts.file || overridesFile();
  const status = opts.statusFn || gameStatus;
  const id = cleanModId(modId);

  const game = await status();
  if (game.running) throw new Error('close Civilization VI first - it has the mod database open');

  const current = readForWrite(file, null);
  if (!current.overrides[id] || !Object.keys(current.overrides[id]).length) {
    throw new Error('no overrides are stored for that mod');
  }
  const count = Object.keys(current.overrides[id]).length;
  const next = { ...current.overrides };
  delete next[id];
  writeOverrides(file, next);
  return { discarded: count, modId: id };
}

// Run on server start, before the mod list is served. That is what makes an
// override correct on the FIRST launch after a mod update, which is the only
// launch that matters.
//
// Reads first and opens the write path only if something is actually wrong: the
// app keeps ten database backups and spends them deliberately, and this runs on
// every launch.
function syncOverrides(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  if (stored.unusable) {
    return { ok: false, deferred: false, error: stored.error, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }
  if (opts.gameRunning) {
    // Reported, never silently skipped: the overrides stay as they are and the
    // mod list says the sync was deferred.
    return { ok: true, deferred: true, reason: 'Civilization VI is running', changed: false, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }
  if (stored.count === 0) {
    return { ok: true, deferred: false, changed: false, applied: [], drifted: [], orphans: [], ambiguous: [], unprotectable: [] };
  }

  const d = openDb(dbPath);
  let mods;
  try {
    mods = Object.keys(stored.overrides).map((id) => planMod(d, id, stored.overrides[id]));
  } finally {
    d.close();
  }

  if (!needsWrite(mods)) {
    const survey = summarise(mods, [], null);
    return { ...survey, ok: true, deferred: false, changed: false, backupPath: null };
  }

  const { result, backupPath } = mutateDb(dbPath, (db) => {
    // Re-planned inside the transaction, so what is written is decided from the
    // state being written to rather than from a read that has since gone stale.
    const fresh = Object.keys(stored.overrides).map((id) => planMod(db, id, stored.overrides[id]));
    return summarise(fresh, writeAll(db, fresh), null);
  });
  return { ...result, ok: true, deferred: false, backupPath };
}

// Which mods have an override and a stamp the game will not agree with - that
// is, the ones it will re-register and re-derive on its next launch. Read-only,
// one stat per overridden mod, and the thing the mod list turns into
// "N mods updated since your last sync".
function staleMods(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  if (stored.unusable) return { stale: [], error: stored.error, unusable: true };
  if (stored.count === 0) return { stale: [], error: null, unusable: false };

  const d = openDb(dbPath);
  const stale = [];
  try {
    for (const id of Object.keys(stored.overrides)) {
      const modRowId = modRowOf(d, id);
      if (modRowId === null) continue;
      if (stampIsStale(d, modRowId) === true) stale.push(id);
    }
  } finally {
    d.close();
  }
  return { stale, error: null, unusable: false };
}

// Appended to src/loadorder.js: the read side behind the load order view.
//
// The view is the profile's load order as one flat list, sorted by the value the
// game will use. This builds that list. It reads only - there is no write
// anywhere in this section, and phase7 asserts that no write route is reachable
// from the page which renders it.

// The smallest gap worth showing as a row. A free run of two is real but says
// nothing you could act on, and a 183-mod profile has hundreds of them, so below
// this the list simply steps from one value to the next.
const MIN_FREE_RUN = 5;

// The six criterion types in a real library, measured:
//
//   ModInUse                   604   a mod with this GUID is switched on in the
//                                        ACTIVE profile. 225 of them are inverted.
//   RuleSetInUse               318   a game ruleset
//   ConfigurationValueMatches  215   a config value
//   LeaderPlayable             150   which leaders are playable
//   GameCoreInUse               68   which game core
//   ModIsEnabled                 1   a mod is switched on in the profile
//
// ModInUse was measured in game rather than inferred, and the answer settled
// more than the question asked. A probe action gated on ModInUse of a mod that
// was installed, switched OFF in the active profile and switched ON in eleven
// others did NOT run. So it is not "subscribed and present" - the eleven
// profiles rule that out - and it is not "on in any profile" either, because
// the criterion was still false. It is scoped to the active profile, and it
// behaves the same as ModIsEnabled.
//
// The first plan assumed the opposite and was wrong. It proposed warning that
// switching profile would stop 214 of Harmony in Diversity's 222 actions
// running, on the strength of "ModInUse is the commonest, 604 uses" - true
// across the library and misleading about the one mod it was cited for. HiD's
// dominant gate is RuleSetInUse, at 213 rows against 97, and a game ruleset
// does not change when you switch profile.
const DECIDABLE = new Set(['ModInUse', 'ModIsEnabled']);

function groupsOf(db) {
  return db.prepare('SELECT ModGroupRowId AS id, Name AS name, Selected AS selected FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all();
}

function activeGroupId(db) {
  const g = db.prepare('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1 LIMIT 1').get();
  return g ? g.id : null;
}

// A resolved name, or a readable one when nothing localised the tag.
//
// ModProperties.Name holds a localization TAG, not text - the game resolves it
// through LocalizedText, which MOD_NAME_SQL does. The base game and DLC rows have
// no such entry, because they are not mods and nothing localises them, so they
// arrive here still tagged. prettyName is modsdb's reader for that case, reused
// rather than rewritten, so the mod manager and this view call a DLC row the same
// thing.
//
// A GUID is left alone: it is not a tag, and dressing it up as one would be worse
// than showing it.
function displayNameOf(resolved, modId) {
  if (resolved && !/LOC_[A-Z0-9_]+/i.test(resolved)) return resolved;
  if (resolved) return prettyName(resolved) || resolved;
  return modId;
}

// Every mod the game knows. Needed to say whether a criterion names a mod you
// have, which is the difference between "will not run, ever" and "cannot tell".
function installedMods(db) {
  const byId = new Map();
  for (const m of db.prepare(
    `SELECT m.ModRowId AS modRowId, m.ModId AS modId, ${MOD_NAME_SQL('p')} AS name
       FROM Mods m
       LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'`
  ).all()) {
    const id = normId(m.modId);
    byId.set(id, { modRowId: m.modRowId, modId: id, name: displayNameOf(m.name, m.modId) });
  }
  return byId;
}

function enabledMods(db, groupId) {
  const on = new Map();
  const rowToNorm = new Map();
  for (const m of db.prepare(
    `SELECT m.ModRowId AS modRowId, m.ModId AS modId, ${MOD_NAME_SQL('p')} AS name
       FROM ModGroupItems i
       JOIN Mods m ON m.ModRowId = i.ModRowId
       LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0`
  ).all(groupId)) {
    const id = normId(m.modId);
    on.set(id, { modRowId: m.modRowId, modId: id, name: displayNameOf(m.name, m.modId) });
    rowToNorm.set(m.modRowId, id);
  }
  return { on, rowToNorm };
}

// Everything in one profile, in four queries.
//
// The identity key is deliberately NOT built here for every action: that would
// be 3176 key builds per request, each reading a file list. Only the actions an
// override names need one, and there are a handful of those.
function readProfile(db, groupId) {
  const { on, rowToNorm } = enabledMods(db, groupId);

  const actions = db.prepare(
    `SELECT c.ComponentRowId AS componentRowId, c.ModRowId AS modRowId,
            c.ComponentType AS type, c.ComponentId AS id
       FROM Components c
       JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
       JOIN Mods m         ON m.ModRowId = c.ModRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0
      ORDER BY c.ComponentRowId`
  ).all(groupId);

  // Correctly spelled row and both misspellings, kept apart so the view can say
  // a mod spelled it wrong.
  const declared = new Map();
  for (const p of db.prepare(
    `SELECT cp.ComponentRowId AS cr, cp.Name AS name, cp.Value AS value
       FROM ComponentProperties cp
       JOIN Components c     ON c.ComponentRowId = cp.ComponentRowId
       JOIN ModGroupItems i  ON i.ModRowId = c.ModRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0
        AND cp.Name IN ('LoadOrder','LaodOrder','LoadingOrder')`
  ).all(groupId)) {
    if (!declared.has(p.cr)) declared.set(p.cr, {});
    declared.get(p.cr)[p.name] = String(p.value);
  }

  // One item per CONDITION, not per property. The obvious join is wrong here:
  // a ConfigurationValueMatches condition carries three properties -
  // ConfigurationId, Group and Value - so joining CriterionProperties into the
  // condition query yields three rows for one condition.
  //
  // No verdict was wrong, because every criterion type the view can decide
  // happens to carry exactly one property, measured. But 22 criteria in the
  // active profile inflated that way, all ConfigurationValueMatches, and each
  // of those rows listed the same unreadable reason three times - and the row's
  // own "and N more it cannot see" count was counting one condition as three.
  // The duplication was already putting wrong information on screen.
  const condRows = db.prepare(
    `SELECT cc.ComponentRowId AS cr, k.Any AS any, cr.CriterionRowId AS id,
            cr.CriterionType AS type, cr.Inverse AS inverse
       FROM ComponentCriteria cc
       JOIN Components c    ON c.ComponentRowId = cc.ComponentRowId
       JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
       JOIN Criteria k      ON k.CriteriaRowId = cc.CriteriaRowId
       JOIN Criterion cr    ON cr.CriteriaRowId = k.CriteriaRowId
      WHERE i.ModGroupRowId = ? AND i.Disabled = 0`
  ).all(groupId);

  // Properties are read whole and attached, rather than pivoted into columns,
  // because which property carries the meaning depends on the criterion type and
  // the reasons below need to name it. Keyed through idKey like the catalog:
  // the same two id domains meet in JS here, and an affinity split must never
  // silently detach properties from their conditions.
  const critProps = new Map();
  for (const p of db.prepare('SELECT CriterionRowId AS id, Name AS name, Value AS value FROM CriterionProperties').all()) {
    const id = idKey(p.id);
    if (!critProps.has(id)) critProps.set(id, {});
    critProps.get(id)[p.name] = p.value;
  }

  const conds = new Map();
  for (const c of condRows) {
    if (!conds.has(c.cr)) conds.set(c.cr, { any: !!c.any, items: [] });
    const kv = critProps.get(idKey(c.id)) || {};
    conds.get(c.cr).items.push({
      type: c.type,
      inverse: !!c.inverse,
      value: kv.Value === undefined ? null : kv.Value,
      props: kv,
    });
  }

  return { on, rowToNorm, actions, declared, conds };
}

// The author's position: the correctly spelled row, else a misspelling, else
// nothing. Mirrors currentValue, so the view and the write path cannot disagree
// about what the mod asked for.
function declaredValueOf(declared, componentRowId) {
  const row = declared.get(componentRowId);
  if (!row) return null;
  if (row.LoadOrder !== undefined) return row.LoadOrder;
  for (const m of MISSPELLINGS) if (row[m] !== undefined) return row[m];
  return null;
}

// Whether this action will run, and how sure we are. true or false only where
// it is provable; null where the toolkit cannot tell.
//
// Sound but incomplete beats complete but unsound. This view exists to stop a
// user concluding "my load order is fine" when it is not, so a row that
// over-reports costs a glance and one that under-reports recreates the exact
// confusion being removed. Every branch below is chosen with that asymmetry in
// mind, and two of them exist because the first version got them wrong.
const MAYBE = null;

// Why this view cannot read a condition, in the words that help someone looking at
// the row. "Depends on something this view cannot see" reads like a fault in the
// row; the specific reason shows it is merely unanswerable here, which is a very
// different thing to someone deciding whether to worry.
//
// These are measurements, not guesses, and one of them corrected me.
//
// I first wrote that nothing on disk holds these values, having searched for
// GAMEMODE_ as a VALUE. That search was wrong: DebugConfiguration.sqlite has a
// `Parameters` table (75 rows) and DebugGameplay.sqlite has `GlobalParameters`
// (476 rows), and neither is keyed by the column I was matching. Checked properly,
// across every ConfigurationId-bearing table:
//
//   Parameters        75 rows  1 of the 41 ids appears: RULESET
//   QueryParameters   23 rows  9 rows, all the same id: RULESET
//   ParameterDependencies, ParameterCriteria, the Domain/Value* columns: 0
//
// So one of the forty-one ids the library names is known to the game at all, and
// that one row has DefaultValue NULL - the game recording that it has no default,
// which is the clearest statement available that the value is chosen at game start.
// The other forty appear in no game database on this machine.
//
// No verdict is available from any of this, and none is claimed. What it buys is a
// reason a user can check, which is the difference between a row that looks broken
// and a row that is merely unanswerable here.
function unreadableWhy(c) {
  const v = c.value;
  switch (c.type) {
    case 'ConfigurationValueMatches':
      return `needs ${(c.props && c.props.ConfigurationId) || 'a game option'} to be ${v}`
        + ' - a game option picked in the main menu, so it is not known until the game starts';
    case 'RuleSetInUse':
      return `needs the ${v} ruleset - the game records RULESET with no default value`
        + ' precisely because you choose it when you start a game';
    case 'GameCoreInUse':
      return `needs the ${v} game core - that is a matter of which DLC is installed`;
    case 'LeaderPlayable':
      return `needs ${v} to be playable - which depends on who is in the game, not on the profile`;
    default:
      return `depends on ${c.type}, which this view cannot see`;
  }
}

// Assumed game setup: which store keys satisfy one undecidable condition.
//
// The store (src/gamesetup.js) holds KIND:BODY keys - RULESET:<id>, CORE:<id>,
// LEADER:<id>, GAMEMODE:<id>, CONFIG:<Group>/<ConfigurationId>=<Value> - and
// asserting one marks matching RuleSetInUse / GameCoreInUse / LeaderPlayable /
// ConfigurationValueMatches conditions satisfied. Nothing else is readable
// here, and ModInUse / ModIsEnabled measurement is untouched by design.
//
// A non-matching assertion proves nothing: one ruleset asserted does not prove
// another ruleset is off for verdict purposes, so only an exact match satisfies
// and everything else stays undecided. The inverted form of a match (NOT X
// where X is asserted) is the one assumed false.
//
// Comma lists read as OR: one condition naming "Expansion1,Expansion2" yields
// one key per single (LeaderPlayable singles reduce to their leader tail, the
// same reduction the catalog mines), and isAssumedMatch below satisfies the
// condition when ANY listed single is asserted.
function setupKeysFor(c) {
  if (!c) return [];
  if (c.type === 'RuleSetInUse' || c.type === 'GameCoreInUse' || c.type === 'LeaderPlayable') {
    if (c.value == null) return [];
    const kind = c.type === 'RuleSetInUse' ? 'RULESET' : c.type === 'GameCoreInUse' ? 'CORE' : 'LEADER';
    const out = [];
    for (const s of splitCommaList(c.value)) {
      const single = c.type === 'LeaderPlayable' ? leaderTail(s) : s;
      if (!single) continue;
      out.push(`${kind}:${single}`);
    }
    return [...new Set(out)];
  }
  if (c.type === 'ConfigurationValueMatches') {
    const p = c.props || {};
    if (p.Group == null || p.ConfigurationId == null || p.Value == null) return [];
    const g = String(p.Group).trim();
    const cid = String(p.ConfigurationId).trim();
    if (!g || !cid) return [];
    const out = [];
    for (const single of splitCommaList(p.Value)) {
      out.push(`CONFIG:${g}/${cid}=${single}`);
      // Game-mode shorthand: the library gates modes as ConfigurationValueMatches
      // with Group Game, ConfigurationId GAMEMODE_*, Value 1. Asserting
      // GAMEMODE:<id> satisfies that enable triple, so a catalog that lists modes
      // by id still matches. A triple asking for another value (e.g. 0) is not
      // satisfied by the mode being on - only the exact triple is.
      if (single === '1' && (g === 'Game' || cid.startsWith('GAMEMODE_'))) {
        out.push(`GAMEMODE:${cid}`);
      }
    }
    return [...new Set(out)];
  }
  return [];
}

// Whether an asserted store holds a key satisfying this condition. The store
// reader never throws (a hand-edit typo answers false), and a Set or array of
// keys is accepted as well as the readSetup view or raw map, so callers and
// tests can pass whichever they hold. Null or empty asserts nothing.
function isAssumedMatch(c, asserted) {
  if (!asserted) return false;
  const keys = setupKeysFor(c);
  if (!keys.length) return false;
  for (const k of keys) {
    try {
      if (isAsserted(asserted, k)) return true;
    } catch (_) { /* isAsserted never throws; a typo answers false */ }
    if (asserted instanceof Set && asserted.has(k)) return true;
    if (Array.isArray(asserted) && asserted.includes(k)) return true;
  }
  return false;
}

// One condition, three ways: satisfied, not satisfied, or not something this
// view can read. Never a guess, and an inverted condition is inverted here
// rather than skipped - skipping it made "NOT ModInUse(X)" read as satisfied
// whenever X was on, which is the one case where the old code reported an
// action as running that provably does not.
function evalCondition(c, ctx) {
  if (!DECIDABLE.has(c.type)) {
    // `needs`, not `why`: verdictOf reads one key off every branch, and a branch
    // that spells it differently yields a reason of undefined - which is a row
    // saying "cannot tell" with nothing after it.
    //
    // Assumed setup, read-only: a matching assertion satisfies the condition,
    // flagged assumed so the verdict can label it. Anything else stays
    // undecided with byte-identical wording, so measured verdicts never move
    // when nothing is asserted.
    if (ctx && ctx.asserted && isAssumedMatch(c, ctx.asserted)) {
      if (c.inverse) return { sat: false, needs: unreadableWhy(c), assumed: true };
      return { sat: true, needs: null, assumed: true };
    }
    return { sat: MAYBE, needs: unreadableWhy(c), assumed: false };
  }
  const target = ctx.installed.get(normId(c.value));
  if (!target) {
    // Nothing installed, so nothing switched on, whichever way the type is
    // meant - the case that was decidable before the probe too. Inverted, the
    // absence is exactly what is being asked for.
    return c.inverse
      ? { sat: true, needs: null, assumed: false }
      : { sat: false, needs: `needs ${c.value}, which is not installed`, assumed: false };
  }
  // ModInUse and ModIsEnabled come to the same test, which is what the probe
  // measured rather than assumed. They stay separate names so the code says
  // what the database says.
  const on = ctx.on.has(target.modId);
  return {
    sat: c.inverse ? !on : on,
    needs: c.inverse
      ? `needs ${target.name} to be off in this profile`
      : `needs ${target.name} to be on in this profile`,
    assumed: false,
  };
}

function verdictOf(entry, ctx) {
  if (!entry || entry.items.length === 0) return { willRun: true, reason: null, unknown: [], assumed: false };

  const unknown = [];
  const unmet = [];
  let read = 0;
  let met = 0;
  let metAssumed = 0;
  let metMeasured = 0;
  let unmetAssumed = 0;
  let unmetMeasured = 0;
  for (const c of entry.items) {
    const r = evalCondition(c, ctx);
    if (r.sat === MAYBE) { unknown.push({ type: c.type, why: r.needs }); continue; }
    read++;
    if (r.sat) {
      met++;
      if (r.assumed) metAssumed++;
      else metMeasured++;
    } else {
      unmet.push(r.needs);
      if (r.assumed) unmetAssumed++;
      else unmetMeasured++;
    }
  }

  // Criteria.Any is the author's own declaration and means what it says. Measured
  // over every multi-condition set whose .modinfo is on disk: stored Any=1 exactly
  // when the modinfo declares any= - 2 sets with a declaration, 278 without one, no
  // exceptions. (104 further sets belong to base-game and DLC mods with no
  // .modinfo on disk, and the column holds the value the game recorded either way.)
  //
  // An earlier note here called the flag unreadable, on the strength of "5 mods
  // declare any=1 but 82 sets have it". That count was of declaration sites rather
  // than sets and had ignored the 104, so the flag was never the mystery it looked
  // like - the measurement was.
  //
  // Three-valued, because a condition this view cannot read is not false: an OR
  // needs one met condition however the rest read, and an AND is defeated by one
  // unmet condition however the rest read. Every path that leaves willRun undecided
  // has at least one entry in `unknown`, so a row never says "cannot tell" without
  // saying what it could not tell.
  let willRun = MAYBE;
  if (entry.any) {
    if (met > 0) willRun = true;
    else if (read > 0 && unknown.length === 0) willRun = false;
  } else {
    if (unmet.length > 0) willRun = false;
    else if (read > 0 && unknown.length === 0) willRun = true;
  }

  // Assumed verdicts: true only where the outcome relies on an assertion -
  // removing the asserted values would leave a different willRun. An OR runs
  // when one met condition carries it, so it depends on assumed only when no
  // measured condition is met; an AND runs only when every decided condition
  // is met with nothing unread, so any assumed met means without it the row
  // would be undecided. The false cases mirror: an OR is false only when every
  // decided condition is unmet with nothing unread, so any assumed unmet makes
  // it dependent, while an AND is defeated by one unmet, so it depends on
  // assumed only when no measured unmet defeats it alone. Undecided rows are
  // never flagged: fewer unknowns is not running.
  let assumed = false;
  if (willRun === true) {
    assumed = entry.any ? (metAssumed > 0 && metMeasured === 0) : metAssumed > 0;
  } else if (willRun === false) {
    assumed = entry.any ? unmetAssumed > 0 : (unmetAssumed > 0 && unmetMeasured === 0);
  }

  if (willRun === true) return { willRun: true, reason: null, unknown, assumed };
  if (willRun === false) return { willRun: false, reason: unmet.join('; ') || 'a condition is not met', unknown, assumed };
  return { willRun: null, reason: null, unknown, assumed: false };
}

// Which overrides point where, so a row can be labelled without building an
// identity key for every action in the library.
function overrideIndex(db, stored) {
  const index = new Map();
  const unmatched = [];
  for (const [id, set] of Object.entries(stored.overrides)) {
    for (const [key, entry] of Object.entries(set)) {
      const res = resolveAction(db, id, key);
      if (res.state === FIND) {
        index.set(res.componentRowId, { state: 'overridden', entry, key, modId: id });
      } else {
        unmatched.push({
          modId: id,
          key,
          value: entry.value,
          declared: entry.declared === undefined ? null : entry.declared,
          state: res.state === AMBIGUOUS ? 'ambiguous' : 'orphaned',
          candidates: res.state === AMBIGUOUS ? res.candidates.length : 0,
        });
      }
    }
  }
  return { index, unmatched };
}

// The list. One band per value, ties grouped and never ordered within the
// group, with the free runs between them as rows of their own.
function buildList(rows) {
  const withPos = rows.filter((r) => r.effective !== null);
  const undeclared = rows.filter((r) => r.effective === null);
  withPos.sort((a, b) => Number(a.effective) - Number(b.effective)
    || a.modName.localeCompare(b.modName) || a.componentRowId - b.componentRowId);

  const bands = [];
  let i = 0;
  while (i < withPos.length) {
    const value = Number(withPos[i].effective);
    const members = [];
    while (i < withPos.length && Number(withPos[i].effective) === value) { members.push(withPos[i]); i++; }
    bands.push({ kind: 'value', value, actions: members, tie: members.length > 1 });
    const next = i < withPos.length ? Number(withPos[i].effective) : null;
    if (next !== null && next - value - 1 >= MIN_FREE_RUN) {
      bands.push({ kind: 'free', from: value + 1, to: next - 1, count: next - value - 1 });
    }
  }
  if (withPos.length) {
    const last = Number(withPos[withPos.length - 1].effective);
    bands.push({ kind: 'headroom', from: last + 1, to: null, count: null });
  }
  return { bands, undeclared };
}

// The whole view, for one profile. Read-only.
function profileLoadOrder(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  const db = openDb(dbPath);
  try {
    const groups = groupsOf(db);
    const groupId = opts.groupId != null ? Number(opts.groupId) : activeGroupId(db);
    const blank = { ok: false, error: 'the mod database has no active profile', groups, profile: null, bands: [], undeclared: [], undeclaredTotal: 0, unmatched: [], summary: {} };
    if (groupId === null || !groups.some((g) => g.id === groupId)) return blank;
    const group = groups.find((g) => g.id === groupId);

    const { on, rowToNorm, actions, declared, conds } = readProfile(db, groupId);
    // Assumed game setup, read-only. opts.asserted overrides the file for
    // tests; opts.gameSetupFile / opts.gameSetupKnown override the path and
    // the prune set the catalog will supply. A missing, empty or unusable file
    // reads as no assertions - measured-only, byte-identical - and nothing
    // here ever writes the store or the game database.
    let asserted = null;
    if (opts.asserted !== undefined && opts.asserted !== null) {
      asserted = opts.asserted;
    } else {
      try {
        const v = readSetup(opts.gameSetupFile || gameSetupFile(), opts.gameSetupKnown || null);
        asserted = (v && v.asserted) || {};
      } catch (_) {
        asserted = null;
      }
    }
    const ctx = { installed: installedMods(db), on, asserted };
    const { index, unmatched } = overrideIndex(db, stored);

    // Comparing two profiles is cheaper than it looks: ComponentRowId belongs to
    // the database, not to a profile, so a mod's actions have the same row ids in
    // both. Two profiles differ only in which mods are switched on, and a row is
    // in the other profile exactly when its mod is.
    const compareGroupId = opts.compareGroupId != null ? Number(opts.compareGroupId) : null;
    const compareOn = compareGroupId != null && groups.some((g) => g.id === compareGroupId)
      ? enabledMods(db, compareGroupId).on
      : null;

    // 42 of 427 rows are base-game or DLC assets whose .modinfo is not on disk.
    // Nothing can keep their stamp, so an override on one is re-derived on the
    // next rescan, and the view says so instead of implying protection.
    const unprotectable = new Set();
    for (const [id, m] of on) if (!modFile(db, m.modRowId).onDisk) unprotectable.add(id);

    const rows = actions.map((a) => {
      const modId = rowToNorm.get(a.modRowId);
      const mod = on.get(modId);
      const props = declared.get(a.componentRowId) || {};
      const declaredValue = declaredValueOf(declared, a.componentRowId);
      const misspelled = declaredValue !== null && props.LoadOrder === undefined;
      const ov = index.get(a.componentRowId);
      const v = verdictOf(conds.get(a.componentRowId), ctx);
      // Two different values, and conflating them is how a view ends up telling
      // the user their own override is what the mod declared. `effective` is
      // what the game will use - it is what the list sorts by, and it is the
      // database row. `declared` is what the author asked for, which once an
      // override is applied is only in the store, because the database now holds
      // ours.
      return {
        modId,
        modName: (mod && mod.name) || modId || 'unknown mod',
        componentRowId: a.componentRowId,
        type: a.type,
        id: a.id,
        effective: declaredValue,
        declared: ov && ov.entry.declared !== undefined ? String(ov.entry.declared) : declaredValue,
        misspelled,
        override: ov ? { value: ov.entry.value, declared: ov.entry.declared === undefined ? null : ov.entry.declared } : null,
        state: ov ? (String(props.LoadOrder) === String(ov.entry.value) ? 'overridden' : 'drifted') : 'author default',
        protected: !unprotectable.has(modId),
        willRun: v.willRun,
        reason: v.reason,
        unknown: v.unknown,
        assumed: !!v.assumed,
        // null when nothing is being compared, so the client can tell "not
        // compared" from "compared and absent".
        inCompare: compareOn ? compareOn.has(modId) : null,
      };
    });

    const { bands, undeclared } = buildList(rows);

    // The undeclared block, grouped by mod. 1579 actions in the library declare
    // nothing at all, and that number is what says a mod is relying on ordering
    // nobody controls. The verdict counts ride along, because "declares no
    // position and will not run anyway" is a different thing from either alone.
    const byMod = new Map();
    for (const r of undeclared) {
      if (!byMod.has(r.modId)) byMod.set(r.modId, { modId: r.modId, name: r.modName, count: 0, willNotRun: 0, unknown: 0 });
      const e = byMod.get(r.modId);
      e.count++;
      if (r.willRun === false) e.willNotRun++;
      else if (r.willRun === null) e.unknown++;
    }
    const undeclaredList = [...byMod.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const values = rows.filter((r) => r.effective !== null).map((r) => Number(r.effective));
    const distinct = [...new Set(values)].sort((a, b) => a - b);

    return {
      ok: true,
      error: null,
      groups,
      profile: { id: group.id, name: group.name },
      bands,
      undeclared: undeclaredList,
      undeclaredTotal: undeclared.length,
      undeclaredWillNotRun: undeclared.filter((r) => r.willRun === false).length,
      unmatched,
      compare: compareOn && groups.some((g) => g.id === compareGroupId)
        ? { id: compareGroupId, name: (groups.find((g) => g.id === compareGroupId) || {}).name, modsOn: compareOn.size }
        : null,
      stale: staleMods(dbPath, { file }),
      labelsError: stored.error,
      labelsUnusable: stored.unusable,
      summary: {
        modsOn: on.size,
        actions: rows.length,
        positioned: rows.length - undeclared.length,
        undeclared: undeclared.length,
        willNotRun: rows.filter((r) => r.willRun === false).length,
        unknown: rows.filter((r) => r.willRun === null).length,
        assumed: rows.filter((r) => r.assumed).length,
        distinctValues: distinct.length,
        min: distinct.length ? distinct[0] : null,
        max: distinct.length ? distinct[distinct.length - 1] : null,
        overrides: index.size,
        unmatched: unmatched.length,
        unprotectable: unprotectable.size,
      },
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Block-move proposal (load-order-edit 1.1, 1.2). Read-only: nothing below
// writes the database, the store, or a backup. describeBlock/proposeBlock
// read one mod plus caller-supplied profile bands; the builders are pure
// functions of those inputs. ComponentFiles is never read here: shared
// filenames are not conflicts and never warn. Identity is ComponentRowId;
// key mapping goes through resolveAction per key, never for all actions.
// Shapes: a block is describeBlock's return ({ actions:[{componentRowId,
// effective, offset, misspelled, drifted}], min/max/width/count/tie,
// undeclared, protectable }); a mapping row is {componentRowId, from, to}.
// Targets (proposeBlock/resolveBase): {base} literal start, {after} first
// value above it, {before} snug fit ending below it, {gap:{from,to}} an
// explicit free run (to null = headroom, unbounded). Fit returns
// {fits:true, base, need, gap, mapping, warnings}; no-fit returns
// {fits:false, need, gap, options:['even','overflow','manual']} and writes
// nothing. Builders return {strategy, mapping, warnings} plus their own
// extras (gap / direction+base / invalid+hints). Warnings (collectWarnings)
// are {kind, message} with kind tie/sentinel/range/misspelling/drifted/
// unprotectable; they never block, only no-fit does.
// One mod's positioned actions as a movable block. Reads only this mod's
// rows, never the library. Undeclared actions are counted and EXCLUDED from
// actions so no builder moves one by accident. opts.driftedByRow marks rows
// as { [componentRowId]: true | { before, wanted } } for the drift warning.
// Returns { modId, modRowId, missing, protectable, stale, actions, min, max,
// width, count, tie, undeclared, undeclaredCount }. Undeclared actions are
// counted only, never positioned, so no builder can move one by accident.
function describeBlock(db, modIdNorm, opts = {}) {
  const modId = normId(modIdNorm);
  const mod = db.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId) = lower(?)').get(modId);
  if (!mod) return { modId, modRowId: null, missing: true, protectable: false, stale: null,
    actions: [], min: null, max: null, width: 0, count: 0, tie: false,
    undeclared: [], undeclaredCount: 0 };
  const rows = db.prepare(
    `SELECT c.ComponentRowId AS cr, cp.Name AS name, cp.Value AS value
       FROM Components c
       LEFT JOIN ComponentProperties cp ON cp.ComponentRowId = c.ComponentRowId
         AND cp.Name IN ('LoadOrder','LaodOrder','LoadingOrder')
      WHERE c.ModRowId = ? ORDER BY c.ComponentRowId`
  ).all(mod.ModRowId);
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.cr)) seen.set(r.cr, {});
    if (r.name) seen.get(r.cr)[r.name] = String(r.value);
  }
  const positioned = [];
  const undeclared = [];
  for (const [cr, props] of seen) {
    if (props.LoadOrder !== undefined) {
      positioned.push({ componentRowId: cr, effective: Number(props.LoadOrder), misspelled: false });
    } else {
      const bad = MISSPELLINGS.find((m) => props[m] !== undefined);
      if (bad) positioned.push({ componentRowId: cr, effective: Number(props[bad]), misspelled: bad });
      else undeclared.push(cr);
    }
  }
  positioned.sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId);
  const min = positioned.length ? positioned[0].effective : null;
  const marks = opts.driftedByRow || {};
  for (const a of positioned) {
    a.offset = a.effective - min;
    const d = marks[a.componentRowId];
    a.drifted = !!d;
    a.drift = d && typeof d === 'object' ? d : null;
  }
  const file = modFile(db, mod.ModRowId);
  return { modId, modRowId: mod.ModRowId, missing: false,
    protectable: !!(file && file.onDisk), stale: stampIsStale(db, mod.ModRowId),
    actions: positioned, min, max: positioned.length ? positioned[positioned.length - 1].effective : null,
    width: positioned.length ? positioned[positioned.length - 1].effective - min : 0,
    count: positioned.length,
    tie: new Set(positioned.map((a) => a.effective)).size < positioned.length,
    undeclared, undeclaredCount: undeclared.length };
}
// Occupied values from profile bands. A value counts as taken by others
// only when a holder from another mod sits on it; the moving block's own
// values free up once it moves. Bands without holder ids (fixtures) fall
// back to treating the block's own values as its own.
function occupiedOf(bands, block) {
  const all = new Set();
  const other = new Set();
  const own = new Set((block && block.actions ? block.actions : []).map((a) => a.effective));
  const want = block ? normId(block.modId) : null;
  for (const b of bands || []) {
    if (!b || b.kind !== 'value') continue;
    all.add(b.value);
    const tagged = (b.actions || []).filter((h) => h && h.modId);
    if (tagged.length) {
      if (tagged.some((h) => normId(h.modId) !== want)) other.add(b.value);
    } else if (!own.has(b.value)) other.add(b.value);
  }
  return { all: [...all].sort((x, y) => x - y), other };
}

// Preserve offsets: new = base + offset, so spread and order never change.
function fitMapping(block, base) {
  return [...block.actions]
    .sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId)
    .map((a) => ({ componentRowId: a.componentRowId, from: a.effective, to: base + a.offset }));
}
// Target shapes: { base } literal start; { after } first value above it;
// { before } snug fit ending below it; { gap: { from, to } } an explicit
// free run, to null meaning headroom (unbounded). Reports the free-slot
// count from the base, so no-fit can state need-vs-gap numbers.
function resolveBase(block, bands, target) {
  const t = target || {};
  const occ = occupiedOf(bands, block);
  const need = block.width;
  const slots = need + 1; // [base, base+width] holds width+1 integers
  const freeFrom = (b) => {
    let next = null;
    for (const v of occ.all) if (occ.other.has(v) && v >= b && (next === null || v < next)) next = v;
    return { base: b, gap: next === null ? null : next - b, end: next === null ? null : next - 1 };
  };
  if (t.gap) {
    const from = Math.trunc(t.gap.from);
    if (!Number.isInteger(from)) throw new Error('that gap has no start');
    if (t.gap.to === null || t.gap.to === undefined) return { ...freeFrom(from), fits: true, need };
    const to = Math.trunc(t.gap.to);
    if (!Number.isInteger(to) || to < from) throw new Error('that gap ends before it starts');
    const r = freeFrom(from);
    const inside = to - from + 1;
    const clash = [...occ.other].some((v) => v >= from && v <= from + need);
    return { base: from, gap: Math.min(inside, r.gap === null ? inside : r.gap),
      end: to, fits: inside >= slots && !clash, need };
  }
  if (t.before !== undefined) {
    const end = Math.trunc(t.before);
    if (!Number.isInteger(end)) throw new Error('that anchor is not a whole number');
    let prev = null;
    for (const v of occ.all) if (occ.other.has(v) && v < end && (prev === null || v > prev)) prev = v;
    const gap = prev === null ? null : end - prev - 1;
    return { base: end - slots, gap, end: end - 1, fits: gap === null || gap >= slots, need };
  }
  const anchor = t.after !== undefined ? t.after : t.base;
  const b = Math.trunc(anchor === undefined ? NaN : anchor) + (t.after !== undefined ? 1 : 0);
  if (!Number.isInteger(b)) throw new Error('that target is not a whole number');
  const r = freeFrom(b);
  return { ...r, fits: r.gap === null || r.gap >= slots, need };
}
// Honest warnings, never blocks (no-fit is reported, not warned).
// Tie/sentinel/range read the mapping; misspelling/unprotectable/drifted
// read the block. Filenames are never examined here on purpose.
// One entry per kind: tie (with holders), sentinel (load-last range),
// range (outside MIN/MAX_VALUE, will be refused), misspelling, drifted,
// unprotectable. Warnings describe; no-fit is reported, not warned.
function collectWarnings(block, bands, mapping, opts = {}) {
  const warnings = [];
  const occ = occupiedOf(bands, block);
  const list = mapping || [];
  for (const m of list) {
    if (!occ.other.has(m.to)) continue;
    const band = (bands || []).find((b) => b && b.kind === 'value' && b.value === m.to);
    const holders = band && band.actions
      ? [...new Set(band.actions.filter((h) => h && h.modId && normId(h.modId) !== normId(block.modId))
        .map((h) => h.modName || h.modId))]
      : [];
    warnings.push({ kind: 'tie', componentRowId: m.componentRowId, value: m.to, holders,
      message: `load order ${m.to} is already taken`
        + (holders.length ? ` by ${holders.join(', ')}` : ' by another action')
        + ' - the game picks between tied actions arbitrarily' });
  }
  const pastLast = list.filter((m) => m.to >= SENTINEL);
  if (pastLast.length) warnings.push({ kind: 'sentinel',
    componentRowIds: pastLast.map((m) => m.componentRowId),
    message: `values at or past ${SENTINEL} load last - that changes the author's intent` });
  for (const m of list) {
    if (m.to < MIN_VALUE || m.to > MAX_VALUE) warnings.push({ kind: 'range',
      componentRowId: m.componentRowId, value: m.to,
      message: `load order ${m.to} is outside the writable range and will be refused` });
  }
  const byRow = new Map((block.actions || []).map((a) => [a.componentRowId, a]));
  for (const m of list) {
    const a = byRow.get(m.componentRowId);
    if (a && a.misspelled) warnings.push({ kind: 'misspelling', componentRowId: m.componentRowId,
      message: `that action ships ${a.misspelled} instead of LoadOrder`
        + ' - the write goes to a correctly spelled row and the typo stays untouched' });
    if (a && a.drifted) warnings.push({ kind: 'drifted', componentRowId: m.componentRowId, drift: a.drift || null,
      message: 'the database already differs from the stored override'
        + (a.drift && a.drift.before !== undefined ? ` (${a.drift.before} vs ${a.drift.wanted})` : '')
        + ' - applying overwrites that drift' });
  }
  if (!block.protectable) warnings.push({ kind: 'unprotectable',
    message: 'that mod has no .modinfo on disk, so nothing can keep its stamp'
      + ' - the value applies but the game may re-derive it' });
  return warnings;
}
// The 1.1 entry point. Read-only: measures the target gap from profile
// bands and either preserves offsets (fit) or reports need-vs-gap with
// the three no-fit options. Writes nothing, ever.
// In: (db, modIdNorm, target, { bands, driftedByRow }); bands is required
// and comes from profileLoadOrder. Missing mod -> {missing:true}; a mod with
// no positioned actions -> {empty:true, reason}. Otherwise fit or no-fit.
function proposeBlock(db, modIdNorm, target, opts = {}) {
  if (!opts.bands) throw new Error('proposeBlock needs profile bands - pass { bands } from profileLoadOrder');
  const block = describeBlock(db, modIdNorm, { driftedByRow: opts.driftedByRow });
  if (block.missing) return { missing: true, modId: block.modId, mapping: [], warnings: [] };
  if (!block.actions.length) return { empty: true, modId: block.modId, mapping: [], warnings: [],
    undeclaredCount: block.undeclaredCount, reason: 'that mod has no positioned actions to move' };
  const r = resolveBase(block, opts.bands, target);
  if (r.fits) {
    const mapping = fitMapping(block, r.base);
    return { fits: true, modId: block.modId, base: r.base, need: r.need, gap: r.gap,
      mapping, warnings: collectWarnings(block, opts.bands, mapping, opts) };
  }
  return { fits: false, modId: block.modId, base: r.base, need: r.need, gap: r.gap,
    mapping: [], warnings: [], options: ['even', 'overflow', 'manual'] };
}
// No-fit path 1: order-preserving even re-space inside an explicit gap.
// A headroom gap (to null) falls back to sequential placement from `from`.
// In: (block, bands, gap{from,to|null}, opts). Out: {strategy:'even', gap, mapping, warnings}.
function buildEvenSpacing(block, bands, gap, opts = {}) {
  if (!block || !block.actions.length) throw new Error('that mod has no positioned actions to move');
  if (!gap || gap.from === null || gap.from === undefined) throw new Error('even re-space needs a gap to fill');
  const from = Math.trunc(gap.from);
  if (!Number.isInteger(from)) throw new Error('that gap has no start');
  const ordered = [...block.actions].sort((a, b) => a.effective - b.effective || a.componentRowId - b.componentRowId);
  let values;
  if (gap.to === null || gap.to === undefined) {
    values = ordered.map((_, i) => from + i);
  } else {
    const to = Math.trunc(gap.to);
    if (!Number.isInteger(to) || to < from) throw new Error('that gap ends before it starts');
    if (ordered.length === 1) values = [from];
    else {
      const step = (to - from) / (ordered.length - 1);
      values = ordered.map((_, i) => Math.round(from + i * step));
    }
  }
  const mapping = ordered.map((a, i) => ({ componentRowId: a.componentRowId, from: a.effective, to: values[i] }));
  return { strategy: 'even', gap: { from, to: gap.to == null ? null : Math.trunc(gap.to) },
    mapping, warnings: collectWarnings(block, bands, mapping, opts) };
}
// No-fit path 2: below the occupied range, preserving offsets. The block ends
// at globalMin - 1; the end is unbounded and negatives are allowed (the
// library ships -200). Spill is below-only; the open-ended free band covers
// the other end explicitly.
// In: (block, bands, opts). Out: {strategy:'overflow', direction:'below', base, mapping, warnings}.
function buildOverflow(block, bands, opts = {}) {
  if (!block || !block.actions.length) throw new Error('that mod has no positioned actions to move');
  if (typeof opts === 'string' || typeof bands === 'string') throw new Error('spill is below-only - target the open-ended free band for the other end');
  const { all } = occupiedOf(bands, block);
  const base = !all.length ? -(block.width + 1) : all[0] - 1 - block.width;
  const mapping = fitMapping(block, base);
  return { strategy: 'overflow', direction: 'below', base, mapping,
    warnings: collectWarnings(block, bands, mapping, opts) };
}
// No-fit path 3: per-action whole numbers. Undeclared actions are
// accepted ONLY here and only when explicitly listed; every other path
// excludes them. Unknown rows and non-integers land in invalid, never in
// mapping. hints reuses the profile's own free/headroom runs.
// In: (block, bands, {componentRowId:value}, opts). Out: {strategy:'manual',
// mapping, invalid:[{componentRowId, reason}], warnings, hints}.
function buildManual(block, bands, valuesByRowId, opts = {}) {
  const entries = Object.entries(valuesByRowId || {});
  if (!entries.length) throw new Error('no manual values to map');
  const byRow = new Map((block.actions || []).map((a) => [a.componentRowId, a]));
  const undeclared = new Set(block.undeclared || []);
  const mapping = [];
  const invalid = [];
  for (const [rawRow, rawVal] of entries) {
    const cr = Number(rawRow);
    if (!Number.isInteger(cr)) { invalid.push({ componentRowId: rawRow, reason: 'not an action id' }); continue; }
    let v;
    try { v = cleanValue(rawVal); } catch (e) { invalid.push({ componentRowId: cr, reason: e.message }); continue; }
    const known = byRow.get(cr);
    if (!known && !undeclared.has(cr)) {
      invalid.push({ componentRowId: cr, reason: 'that action is not part of this mod' }); continue;
    }
    mapping.push({ componentRowId: cr, from: known ? known.effective : null, to: v });
  }
  mapping.sort((a, b) => a.componentRowId - b.componentRowId);
  const hints = (bands || []).filter((b) => b && (b.kind === 'free' || b.kind === 'headroom'))
    .map((b) => (b.kind === 'free' ? { kind: 'free', from: b.from, to: b.to, count: b.count }
      : { kind: 'headroom', from: b.from }));
  const warnings = collectWarnings(block, bands, mapping.filter((m) => m.from !== null), opts);
  return { strategy: 'manual', mapping, invalid, warnings, hints };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

// Every stored override, with what is actually true of it right now: does its
// key still resolve, is the database carrying the value, and can the stamp be
// maintained for the mod it is on.
//
// The identity key is stored as a readable string on purpose, so a user
// reporting "my override stopped matching" can be answered by looking at the
// file rather than at a hash.
function listOverrides(dbPath, opts = {}) {
  const file = opts.file || overridesFile();
  const stored = readOverrides(file);
  const out = [];
  const groups = [];
  const db = openDb(dbPath);
  try {
    for (const [id, set] of Object.entries(stored.overrides)) {
      const modRowId = modRowOf(db, id);
      const meta = modRowId === null ? null : db.prepare(
        `SELECT ${MOD_NAME_SQL('p')} AS name FROM Mods m LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name' WHERE m.ModRowId = ?`
      ).get(modRowId);
      const onDisk = modRowId !== null && modFile(db, modRowId).onDisk;
      const modName = displayNameOf(meta && meta.name, id);

      for (const [key, entry] of Object.entries(set)) {
        const row = { modId: id, modName, modInstalled: modRowId !== null, protected: onDisk, key, value: entry.value, declared: entry.declared === undefined ? null : entry.declared };
        if (modRowId === null) {
          out.push({ ...row, state: 'orphaned', reason: 'that mod is not in the database' });
          continue;
        }
        const res = resolveAction(db, id, key);
        if (res.state === AMBIGUOUS) {
          out.push({ ...row, state: 'ambiguous', candidates: res.candidates.length, reason: `${res.candidates.length} actions in that mod match this key` });
          continue;
        }
        if (res.state === MISSING) {
          out.push({ ...row, state: 'orphaned', reason: 'no action in that mod matches this key any more' });
          continue;
        }
        const comp = db.prepare('SELECT ComponentType AS type, ComponentId AS id FROM Components WHERE ComponentRowId = ?')
          .get(res.componentRowId);
        const before = currentValue(db, res.componentRowId);
        out.push({
          ...row,
          state: before === String(entry.value) ? 'applied' : 'drifted',
          componentRowId: res.componentRowId,
          type: comp.type,
          id: comp.id,
          inDatabase: before,
          reason: before === String(entry.value) ? null : `the database has ${before === null ? 'no value' : before}`,
        });
      }
    }
    for (const g of groupsOf(db)) groups.push({ id: g.id, name: g.name, selected: !!g.selected });
    return {
      ok: true,
      error: stored.error,
      unusable: stored.unusable,
      groups,
      stale: staleMods(dbPath, { file }),
      count: out.length,
      overrides: out,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  VERSION, FIND, MISSING, AMBIGUOUS, SENTINEL, MIN_FREE_RUN, MAX_BULK_ENTRIES,
  overridesFile, openDb,
  keyFor, actionKey, resolveAction, isModId,
  readOverrides, writeOverrides, setOverride, clearOverride,
  modFile, stampFor, stampIsStale,
  applyOverrides, applyBulk, resetOverride, resetModOverrides, discardModOverrides, syncOverrides, staleMods, listOverrides,
  profileLoadOrder, verdictOf, evalCondition, setupKeysFor, isAssumedMatch,
  actionFiles, actionFilesOf, modActionFilesOf,
  describeBlock, proposeBlock, occupiedOf,
  buildEvenSpacing, buildOverflow, buildManual,
};
