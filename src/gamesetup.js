'use strict';

// Assumed game setup ("I always play with X on"), in one JSON file beside
// mod-labels.json. Asserting an option marks matching
// ConfigurationValueMatches / RuleSetInUse / GameCoreInUse / LeaderPlayable
// conditions satisfied for verdict purposes; it never writes the game
// database, and deleting the file returns every verdict to measured-only.
//
// The store is global, not per profile: game setup is chosen per game start,
// not per mod group. No function here takes a profile.
//
// Failure contract mirrors src/labels.js: reading never throws and never
// writes. A missing or empty file is empty state, not a failure. A file that
// is not the shape we write is unusable as a whole, while one bad entry among
// good ones costs only that entry. Writes refuse to build on an unreadable
// file rather than replace whatever it holds.

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./editor');

const VERSION = 1;
const MAX_KEY = 200;
const FILE_NAME = 'game-setup.json';

// Where the file lives. Overridable, for tests and for a relocated install.
function gameSetupFile() {
  return process.env.CIV6_GAMESETUP_FILE || path.join(__dirname, '..', FILE_NAME);
}

// Option keys are machine ids, not typed names: KIND:BODY, e.g.
//   RULESET:RULESET_STANDARD
//   GAMEMODE:GAMEMODE_MONOPOLIES
//   CORE:GAMECORE_STANDARD
//   LEADER:LEADER_ALEXANDER_MACEDON
//   CONFIG:Map/MapSize=MAPSIZE_DUEL
// The catalog (a later task) builds these with simpleKey/configKey; the store
// accepts any KIND:BODY so a future kind still round-trips instead of being
// dropped by an older reader.
const KIND_RE = /^[A-Z][A-Z0-9_]*$/;
// One id segment: the charset game ids actually use. Anything else in a hand
// edit is a typo, and costs only that entry.
const SEG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

// Trimmed, well-formed, and within the cap, or refused. The UI sends exact
// catalog keys, so a refusal here is always a hand-edit typo or a bad caller.
function cleanKey(raw) {
  const k = String(raw == null ? '' : raw).trim();
  if (!k) throw new Error('a game-setup option cannot be empty');
  if (k.length > MAX_KEY) throw new Error(`a game-setup option cannot be longer than ${MAX_KEY} characters`);
  if (/[\x00-\x1f\x7f]/.test(k)) throw new Error('a game-setup option contains an unsupported character');
  const at = k.indexOf(':');
  if (at === -1) throw new Error(`a game-setup option must look like KIND:value (got ${JSON.stringify(k)})`);
  const kind = k.slice(0, at);
  const body = k.slice(at + 1);
  if (!KIND_RE.test(kind)) throw new Error(`a game-setup option kind must be uppercase letters (got ${JSON.stringify(kind)})`);
  if (!body || /[\s]/.test(body)) throw new Error(`a game-setup option value cannot be empty or contain spaces (got ${JSON.stringify(k)})`);
  if (kind === 'CONFIG') {
    const m = /^([^/=]+)\/([^/=]+)=([^/=]+)$/.exec(body);
    if (!m || !SEG_RE.test(m[1]) || !SEG_RE.test(m[2]) || !SEG_RE.test(m[3])) {
      throw new Error(`a CONFIG option must look like CONFIG:Group/ConfigurationId=Value (got ${JSON.stringify(k)})`);
    }
  } else if (!SEG_RE.test(body)) {
    throw new Error(`a game-setup option value uses an unsupported character (got ${JSON.stringify(k)})`);
  }
  return k;
}

// One id under a kind: rulesets, game modes, cores, leaders.
function simpleKey(kind, id) {
  const k = String(kind == null ? '' : kind).trim().toUpperCase();
  if (!KIND_RE.test(k)) throw new Error(`unknown game-setup kind (got ${JSON.stringify(kind)})`);
  const seg = String(id == null ? '' : id).trim();
  if (!SEG_RE.test(seg)) throw new Error(`a game-setup id uses an unsupported character (got ${JSON.stringify(id)})`);
  return cleanKey(`${k}:${seg}`);
}

// A ConfigurationValueMatches triple: Group + ConfigurationId + Value, which
// is what makes one config option distinct from another on the same screen.
function configKey(group, configId, value) {
  for (const [name, part] of [['group', group], ['configuration id', configId], ['value', value]]) {
    const s = String(part == null ? '' : part).trim();
    if (!SEG_RE.test(s)) throw new Error(`a config ${name} uses an unsupported character (got ${JSON.stringify(part)})`);
  }
  return cleanKey(`CONFIG:${String(group).trim()}/${String(configId).trim()}=${String(value).trim()}`);
}

// A key back apart, for grouping the panel by kind. Null when the key is not
// one the store would keep, so callers can sort without try/catch.
function parseKey(key) {
  let k;
  try {
    k = cleanKey(key);
  } catch (_) {
    return null;
  }
  const at = k.indexOf(':');
  const kind = k.slice(0, at);
  const body = k.slice(at + 1);
  if (kind === 'CONFIG') {
    const m = /^([^/=]+)\/([^/=]+)=([^/=]+)$/.exec(body);
    if (!m) return null;
    return { kind, group: m[1], configId: m[2], value: m[3] };
  }
  return { kind, id: body };
}

// The file's own text -> { asserted, error, unusable }. Same two levels of
// failure as labels: a file that is not the shape we write is unusable as a
// whole, while one bad entry among good ones costs only that entry. Neither
// is allowed to take the rest of the file down.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { asserted: {}, error: `game-setup.json is not valid JSON (${e.message})`, unusable: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { asserted: {}, error: 'game-setup.json does not contain an object', unusable: true };
  }
  // A missing version is treated as the current one, so a file written before
  // the field existed still loads. A different one we did not write, and whose
  // shape we cannot vouch for, is refused rather than half-understood.
  if (raw.version !== undefined && raw.version !== VERSION) {
    return { asserted: {}, error: `game-setup.json is version ${JSON.stringify(raw.version)}; this toolkit reads version ${VERSION}`, unusable: true };
  }
  if (raw.asserted === undefined || raw.asserted === null) return { asserted: {}, error: null };
  if (typeof raw.asserted !== 'object' || Array.isArray(raw.asserted)) {
    return { asserted: {}, error: 'game-setup.json has no "asserted" object', unusable: true };
  }

  const asserted = {};
  let dropped = 0;
  for (const [id, value] of Object.entries(raw.asserted)) {
    try {
      const key = cleanKey(id);
      if (value !== true) throw new Error('not asserted');
      asserted[key] = true;
    } catch (_) {
      dropped++;
    }
  }
  return {
    asserted,
    error: dropped ? `${dropped} entr${dropped === 1 ? 'y' : 'ies'} in game-setup.json could not be read and ${dropped === 1 ? 'was' : 'were'} ignored` : null,
  };
}

// Everything verdicts need: the asserted map, the sorted key list the panel
// shows, and whether the file can be built on.
//
// `unusable` is the one distinction a read and a write both need: a file with
// a bad entry is readable and its good entries are real, while a file that is
// not the shape we write is not something to build on.
function view(asserted, error, pruned, unusable = false) {
  return {
    asserted,
    keys: Object.keys(asserted).sort(),
    error: error || null,
    unusable,
    pruned,
  };
}

function asKnownSet(known) {
  if (!known) return null;
  const out = new Set();
  for (const k of known) {
    try {
      out.add(cleanKey(k));
    } catch (_) {
      // A caller that cannot spell a key simply never matches it.
    }
  }
  return out;
}

// Read the file, pruning keys that `known` does not contain.
//
// `known` is the set of option keys the caller can actually see (the mined
// catalog), or null when it cannot vouch for the set. Pruning against an
// incomplete set would delete real assertions, so those reads prune nothing.
// Pruned entries are dropped in memory and counted in `pruned`; the next write
// persists the pruned form. Nothing is written here, ever.
function readSetup(file = gameSetupFile(), known = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state. Asserting nothing is not a failure, and it
    // is what deleting the store returns verdicts to: measured-only.
    if (e.code === 'ENOENT') return view({}, null, 0);
    return view({}, `game-setup.json could not be read (${e.message})`, 0, true);
  }
  if (!text.trim()) return view({}, null, 0); // an empty file asserts nothing

  const { asserted, error, unusable } = parse(text);
  let pruned = 0;
  const wanted = asKnownSet(known);
  if (wanted) {
    for (const key of Object.keys(asserted)) {
      if (!wanted.has(key)) { delete asserted[key]; pruned++; }
    }
  }
  return view(asserted, error, pruned, unusable);
}

// Write the map out. Same single-plain-file treatment as labels: a few
// kilobytes, written by one synchronous handler, and a lost assertion is a
// nuisance rather than a hazard. Nobody but this toolkit has ever heard of
// this file, so there is no game writer to race.
//
// Keys are written in sorted order so the file is stable and diffable by hand.
// Entries that fail validation are skipped rather than persisted as junk.
function writeSetup(file, asserted) {
  const body = { version: VERSION, asserted: {} };
  for (const key of Object.keys(asserted || {}).sort()) {
    try {
      const k = cleanKey(key);
      if (asserted[key] === true) body.asserted[k] = true;
    } catch (_) {
      // Never persist junk a hand edit left behind.
    }
  }
  atomicWrite(file, JSON.stringify(body, null, 2));
}

// The read a write is built on.
//
// Refuses outright if the file exists but is not the shape we write. Building
// on an unreadable file would replace whatever it holds, so a corrupt file is
// fixed or deleted by hand rather than overwritten by a click the user did not
// think of as destructive.
function readForWrite(file, known) {
  const v = readSetup(file, known);
  if (v.unusable) {
    throw new Error(`${v.error} - nothing was written. Fix or delete it, then try again.`);
  }
  return v;
}

// Assert one option (on) or withdraw it (off), and return the refreshed view.
//
// The file is re-read inside the call rather than sent by the caller. Two tabs
// open, each toggling a different option: a client that PUT the whole file
// would silently discard the other tab's change. Node serves one request at a
// time on one thread, so read-modify-write needs no lock here.
function setOption(file, key, on = true, known = null) {
  const k = cleanKey(key);
  const current = readForWrite(file, known);
  if (on) current.asserted[k] = true;
  else delete current.asserted[k]; // withdrawn: the entry goes, so it cannot come back
  writeSetup(file, current.asserted);

  return readSetup(file, known);
}

// Withdraw every assertion. The file stays, asserting nothing - the same state
// deleting it reads as.
function clearSetup(file, known = null) {
  readForWrite(file, known); // refused on an unreadable file, like any write
  writeSetup(file, {});
  return readSetup(file, known);
}

// Whether a key is asserted in a view or a raw asserted map. Readers use this
// rather than touching the map: a hand-edit typo answers false, never throws.
function isAsserted(viewOrMap, key) {
  const map = viewOrMap && typeof viewOrMap === 'object' && viewOrMap.asserted ? viewOrMap.asserted : viewOrMap;
  if (!map || typeof map !== 'object') return false;
  let k;
  try {
    k = cleanKey(key);
  } catch (_) {
    return false;
  }
  return map[k] === true;
}

// --- Option catalog: what the library actually gates on ----------------------
//
// Mined from the library at request time, never hardcoded, so the panel can
// neither drift from the library nor invent an option no action checks. Only a
// criterion row that gates a real action (a ComponentCriteria link to a row in
// Components) becomes an option; a set nothing points at gates nothing and
// stays off the panel. Referenced either way counts: an inverted condition
// still reads differently once its value is asserted.
//
// One criterion row maps to one option key per comma-separated single:
// RuleSetInUse to RULESET:<Value>, GameCoreInUse to CORE:<Value>,
// LeaderPlayable to LEADER:<leader id> (the tail of a per-slot value like
// Players:StandardPlayers::LEADER_X), and ConfigurationValueMatches to
// GAMEMODE:<ConfigurationId> when the id names a game mode, else to the
// CONFIG triple. A row with N values yields N options under OR semantics.
// Anything else is not game setup. A row missing the property its key needs
// is skipped, not guessed.

// Criterion types that describe game setup rather than the mod list.
const SETUP_TYPES = new Set(['RuleSetInUse', 'ConfigurationValueMatches', 'GameCoreInUse', 'LeaderPlayable']);

// The panel's group order: rulesets, modes, config values, cores, leaders.
const KIND_ORDER = ['RULESET', 'GAMEMODE', 'CONFIG', 'CORE', 'LEADER'];

function kindRank(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

// One database id into its join key. ComponentCriteria.CriteriaRowId is
// declared TEXT while Criterion and Criteria declare it INTEGER, so the driver
// hands one side back as strings and the other as numbers: a Map keyed on one
// misses the other every time and the panel mines zero options with no error.
// Worse, a TEXT column stores a REAL-bound write as '1.0' while the game
// stores '11544' for the same set, so plain String() still misses. Numeric
// strings therefore name their integer; anything else keeps its text.
function idKey(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  const s = String(v == null ? '' : v).trim();
  const n = Number(s);
  return s !== '' && Number.isInteger(n) ? String(n) : (typeof v === 'number' ? String(v) : s);
}
// One comma-separated library value into its singles: split on commas, trim,
// drop empties. Real rows carry OR lists - GameCoreInUse "Expansion1,
// Expansion2", RuleSetInUse "RULESET_EXPANSION_1,RULESET_EXPANSION_2" - that
// single-value key validation would refuse whole, so each single goes through
// the grammar on its own below and junk singles are still refused there.
function splitCommaList(value) {
  return String(value == null ? '' : value).split(',').map((s) => s.trim()).filter((s) => s);
}

// One LeaderPlayable single into its leader id. Real rows name per-slot
// values ("Players:StandardPlayers::LEADER_X"), never a bare leader, so the
// tail after the last slot separator is the assertable id. A single with no
// separator is already bare and goes through unchanged; anything the key
// grammar still refuses costs only that single.
function leaderTail(single) {
  const s = String(single == null ? '' : single).trim();
  if (!s) return '';
  return s.includes('::') ? s.slice(s.lastIndexOf('::') + 2).trim() : s;
}

// One criterion row (type + its CriterionProperties map) to its option keys,
// or [] when the row is not game setup or names nothing assertable. One row
// with N comma-separated values yields N single options (OR semantics: the
// view and replay verdicts satisfy the gate when ANY listed single is
// asserted, and the catalog counts the row's actions toward each single they
// name). Never throws: a library value that fails key validation is skipped,
// so one odd row cannot take the panel down.
function criterionKeys(type, props) {
  const p = props || {};
  const text = (v) => String(v == null ? '' : v).trim();
  if (type === 'ConfigurationValueMatches') {
    const group = text(p.Group);
    const configId = text(p.ConfigurationId);
    if (!group || !configId) return [];
    const out = [];
    for (const single of splitCommaList(p.Value)) {
      try {
        // A game mode is a config switch whose ConfigurationId names the mode;
        // the panel offers the mode, not the triple.
        if (/^GAMEMODE_/.test(configId)) out.push(simpleKey('GAMEMODE', configId));
        else out.push(configKey(group, configId, single));
      } catch (_) {
        // One odd single costs only itself.
      }
    }
    return [...new Set(out)];
  }
  const kind = { RuleSetInUse: 'RULESET', GameCoreInUse: 'CORE', LeaderPlayable: 'LEADER' }[type];
  if (!kind) return [];
  const raw = text(p.Value);
  if (!raw) return [];
  const singles = type === 'LeaderPlayable'
    ? splitCommaList(raw).map(leaderTail).filter((s) => s)
    : splitCommaList(raw);
  const out = [];
  for (const s of singles) {
    try {
      out.push(simpleKey(kind, s));
    } catch (_) {
      // Junk singles are still refused, one by one.
    }
  }
  return [...new Set(out)];
}

// The first key of criterionKeys, or null. Kept for single-value callers: a
// row with one value maps exactly as before.
function criterionKey(type, props) {
  const keys = criterionKeys(type, props);
  return keys.length ? keys[0] : null;
}

// A game id in readable words: underscores and camel humps become spaces, each
// word titled. Mechanical, so an obscure id still reads as something; the raw
// id is the fallback when there is nothing to prettify.
function splitIdWords(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[\s_]+/).filter(Boolean);
}

function humanWords(s) {
  const words = splitIdWords(s).map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w));
  return words.length ? words.join(' ') : String(s);
}

// The kind prefix repeats the group heading, so it goes: RULESET_EXPANSION_2
// under rulesets reads "Expansion 2", not "Ruleset Expansion 2".
const KIND_PREFIX = {
  RULESET: /^RULESET_/i,
  GAMEMODE: /^GAMEMODE_/i,
  CORE: /^(GAME_?CORE_|CORE_)/i,
  LEADER: /^LEADER_/i,
};

function humanSimple(kind, id) {
  const pre = KIND_PREFIX[kind];
  let rest = pre ? String(id).replace(pre, '') : String(id);
  if (!rest) rest = String(id);
  return humanWords(rest);
}

// A config value often repeats its ConfigurationId (MapSize / MAPSIZE_DUEL),
// so the shared stem goes and "Map Size = Duel" is left.
function stripConfigStem(configId, value) {
  const words = splitIdWords(configId);
  if (!words.length) return String(value);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${words.map((w) => `${esc(w)}_?`).join('')}`, 'i');
  const rest = String(value).replace(re, '').replace(/^_+/, '');
  return rest || String(value);
}

// The panel label for an option key. Anything the store would refuse comes back
// as given: a label is no place to lose information.
function displayName(key) {
  const p = parseKey(key);
  if (!p) return String(key);
  if (p.kind === 'CONFIG') return `${humanWords(p.configId)} = ${humanWords(stripConfigStem(p.configId, p.value))}`;
  return humanSimple(p.kind, p.id);
}

// The distinct setup options actually gating library actions, with per-option
// gated-action counts. Read-only: four SELECTs and nothing else, and a library
// without these tables simply gates nothing (an empty catalog, not an error).
// Returns { options, error }; options run in panel-group order, then by name.
function buildCatalog(db) {
  if (!db || typeof db.prepare !== 'function') {
    return { options: [], error: 'no mod database to mine for game-setup options' };
  }
  let tables;
  try {
    tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((r) => r.name));
  } catch (e) {
    return { options: [], error: `game-setup options could not be read (${e.message})` };
  }
  for (const t of ['Criterion', 'CriterionProperties', 'ComponentCriteria', 'Components']) {
    if (!tables.has(t)) return { options: [], error: null };
  }
  let critRows;
  let propRows;
  let linkRows;
  let compRows;
  try {
    critRows = db.prepare('SELECT CriterionRowId AS id, CriteriaRowId AS setId, CriterionType AS type FROM Criterion').all();
    propRows = db.prepare('SELECT CriterionRowId AS id, Name AS name, Value AS value FROM CriterionProperties').all();
    linkRows = db.prepare('SELECT ComponentRowId AS cr, CriteriaRowId AS setId FROM ComponentCriteria').all();
    compRows = db.prepare('SELECT ComponentRowId AS cr FROM Components').all();
  } catch (e) {
    return { options: [], error: `game-setup options could not be read (${e.message})` };
  }

  // Id joins coerce through idKey on both sides (see its note): affinity can
  // never silently empty the catalog again. (SQL-side joins apply affinity
  // themselves and are immune; only these JS-side lookups need it.
  // CriterionRowId and ComponentRowId agree today but are coerced the same
  // way, so a future affinity change there degrades to no surprise either.)
  const propsById = new Map();
  for (const p of propRows) {
    const id = idKey(p.id);
    if (!propsById.has(id)) propsById.set(id, {});
    propsById.get(id)[p.name] = p.value;
  }
  const real = new Set(compRows.map((r) => idKey(r.cr)));
  const compsBySet = new Map();
  for (const l of linkRows) {
    if (!real.has(idKey(l.cr))) continue; // a link to no action gates nothing
    const set = idKey(l.setId);
    if (!compsBySet.has(set)) compsBySet.set(set, new Set());
    compsBySet.get(set).add(l.cr);
  }

  const byKey = new Map();
  for (const c of critRows) {
    if (!SETUP_TYPES.has(c.type)) continue;
    // One row with N comma-separated values yields N single options, and the
    // row's actions count toward each single they name.
    const keys = criterionKeys(c.type, propsById.get(idKey(c.id)));
    if (!keys.length) continue;
    const comps = compsBySet.get(idKey(c.setId));
    if (!comps || comps.size === 0) continue; // declared but gating no action
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, { key, actions: new Set() });
      for (const cr of comps) byKey.get(key).actions.add(cr);
    }
  }

  const options = [...byKey.values()].map((e) => {
    const p = parseKey(e.key);
    const ref = p.kind === 'CONFIG'
      ? { group: p.group, configId: p.configId, value: p.value }
      : { id: p.id };
    return { key: e.key, kind: p.kind, name: displayName(e.key), count: e.actions.size, ...ref };
  });
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  options.sort((a, b) => kindRank(a.kind) - kindRank(b.kind)
    || byName(a.name.toLowerCase(), b.name.toLowerCase()) || byName(a.key, b.key));
  return { options, error: null };
}

module.exports = {
  VERSION, MAX_KEY, FILE_NAME, gameSetupFile, cleanKey, simpleKey, configKey,
  parseKey, readSetup, writeSetup, setOption, clearSetup, isAsserted,
  criterionKey, criterionKeys, splitCommaList, leaderTail, idKey, displayName, buildCatalog,
};
