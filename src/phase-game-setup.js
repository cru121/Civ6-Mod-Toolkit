'use strict';

// Phase proof for tasks 1.1 and 1.2: the assumed game-setup JSON store and the
// option catalog mined from the library.
//
// Operates only on a synthetic game-setup file in a scratch dir. A real
// game-setup.json is never read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('./gamesetup');
const { DatabaseSync } = require('node:sqlite');

// Resolved, for the same reason as phase4's: on Windows a GitHub runner's TEMP
// is under an 8.3 short name, and anything that later compares one of these
// paths against a path the product canonicalised would be comparing two
// spellings of one folder. Cheap to do once here rather than to discover per
// check.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-gamesetup-')));
const FILE = path.join(TMP, 'game-setup.json');
process.env.CIV6_GAMESETUP_FILE = FILE;
console.log(`scratch dir: ${TMP}\n`);

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const put = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const cap = (fn, ...args) => {
  try { fn(...args); return ''; } catch (e) { return e.message; }
};
const RULESET = 'RULESET:RULESET_STANDARD';
const MODE = 'GAMEMODE:GAMEMODE_MONOPOLIES';
const CONFIG = 'CONFIG:Map/MapSize=MAPSIZE_DUEL';

// --- Test 1: a file that is not there is not a failure -----------------------
console.log('Test 1: no file asserts nothing');
{
  const v = setup.readSetup(FILE);
  check('a missing file reads as no assertions', Object.keys(v.asserted).length === 0);
  check('  and says nothing is wrong', v.error === null, String(v.error));
  check('  and nothing was pruned', v.pruned === 0);
  check('  and the key list is empty', v.keys.length === 0);
  check('  and nothing counts as asserted', !setup.isAsserted(v, RULESET));
}

// --- Test 2: empty and malformed ---------------------------------------------
console.log('\nTest 2: empty and malformed files never take the verdicts down');
{
  put('');
  check('an empty file asserts nothing', Object.keys(setup.readSetup(FILE).asserted).length === 0);
  put('   \n\t  ');
  const blank = setup.readSetup(FILE);
  check('a whitespace-only file asserts nothing', Object.keys(blank.asserted).length === 0);
  check('  and is not reported as an error', blank.error === null, String(blank.error));

  put('{ this is not json');
  const broken = setup.readSetup(FILE);
  check('a syntax error yields no assertions', Object.keys(broken.asserted).length === 0);
  check('  and a message saying why', /not valid JSON/.test(broken.error || ''), String(broken.error));
  check('  and the file is marked unusable', broken.unusable === true);

  put('[1, 2, 3]');
  check('a JSON array is refused', /does not contain an object/.test(setup.readSetup(FILE).error || ''));
  put({ version: 1, asserted: 'nope' });
  check('an asserted value that is not an object is refused', /no "asserted" object/.test(setup.readSetup(FILE).error || ''));
  put({ version: 99, asserted: { [RULESET]: true } });
  const future = setup.readSetup(FILE);
  check('a version we did not write is refused whole', Object.keys(future.asserted).length === 0
    && /version 99/.test(future.error || ''), String(future.error));

  // One bad entry must not cost the good ones.
  put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true, '': true, [MODE]: 'yes' } });
  const mixed = setup.readSetup(FILE);
  check('a good entry survives a bad one', mixed.asserted[RULESET] === true, JSON.stringify(mixed.asserted));
  check('  and the bad ones are reported', /could not be read/.test(mixed.error || ''), String(mixed.error));
  check('  and none of the bad ones became keys',
    !Object.keys(mixed.asserted).some((k) => k === 'junk-without-a-kind' || k === ''));
  check('  and a half-asserted value is not kept', mixed.asserted[MODE] === undefined);

  // A directory in the file's place is an unreadable file, not a missing one.
  fs.rmSync(FILE, { force: true });
  fs.mkdirSync(FILE);
  const unreadable = setup.readSetup(FILE);
  check('an unreadable path is reported, not silently empty', !!unreadable.error && unreadable.unusable === true);
  fs.rmdirSync(FILE);
}

// --- Test 3: reading a good file ---------------------------------------------
console.log('\nTest 3: keys, lists and key normalisation');
{
  put({ version: 1, asserted: { [RULESET]: true, [MODE]: true, [CONFIG]: true } });
  const v = setup.readSetup(FILE);
  check('every asserted key reads back', setup.isAsserted(v, RULESET) && setup.isAsserted(v, MODE) && setup.isAsserted(v, CONFIG));
  check('the key list is sorted', v.keys.join('|') === [CONFIG, MODE, RULESET].sort().join('|'), v.keys.join('|'));
  check('a well-formed file reports no error', v.error === null, String(v.error));
  check('a key that was never asserted answers false', !setup.isAsserted(v, 'RULESET:RULESET_XP2'));
  check('a hand-edit typo answers false, never throws', !setup.isAsserted(v, 'junk'));

  put({ asserted: { [RULESET]: true } });
  check('a file with no version field still loads', setup.isAsserted(setup.readSetup(FILE), RULESET));
}

// --- Test 4: pruning ----------------------------------------------------------
console.log('\nTest 4: pruning options the catalog no longer lists');
{
  put({ version: 1, asserted: { [RULESET]: true, [MODE]: true } });
  const known = new Set([RULESET]); // the mode left the library
  const v = setup.readSetup(FILE, known);
  check('an assertion the catalog no longer lists is dropped', v.asserted[RULESET] === true && v.asserted[MODE] === undefined);
  check('  and is counted', v.pruned === 1, `pruned=${v.pruned}`);
  check('  and leaves the key list', !v.keys.includes(MODE), v.keys.join());

  check('a read never writes', Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).asserted).length === 2);

  const unsure = setup.readSetup(FILE, null);
  check('an unvouched set prunes nothing', Object.keys(unsure.asserted).length === 2 && unsure.pruned === 0);
}

// --- Test 5: key validation ----------------------------------------------------
console.log('\nTest 5: what an option key may look like');
{
  check('surrounding space is trimmed', setup.cleanKey('  RULESET:X  ') === 'RULESET:X');
  check('a key at the cap is kept', setup.cleanKey(`RULESET:${'x'.repeat(200 - 8)}`).length === 200);
  check('an over-long key is refused', /longer than 200/.test(cap(setup.cleanKey, `RULESET:${'x'.repeat(201 - 8)}`)));
  check('an empty key is refused', /cannot be empty/.test(cap(setup.cleanKey, '')));
  check('a key with no kind is refused', /KIND:value/.test(cap(setup.cleanKey, 'just-an-id')));
  check('a lowercase kind is refused', /uppercase/.test(cap(setup.cleanKey, 'ruleset:X')));

  check('simpleKey uppercases the kind', setup.simpleKey('ruleset', 'RULESET_STANDARD') === 'RULESET:RULESET_STANDARD');
  check('simpleKey trims the id', setup.simpleKey('GAMEMODE', '  GAMEMODE_MONOPOLIES ') === MODE);
  check('configKey joins the triple', setup.configKey('Map', 'MapSize', 'MAPSIZE_DUEL') === CONFIG);
  check('configKey trims each part', setup.configKey(' Map ', ' MapSize ', ' MAPSIZE_DUEL ') === CONFIG);
  check('a bad simpleKey id is refused', /unsupported character/.test(cap(setup.simpleKey, 'RULESET', 'has space')));
  check('a bad config part is refused', /unsupported character/.test(cap(setup.configKey, 'Map', 'Map Size', 'X')));

  const simple = setup.parseKey(MODE);
  check('parseKey takes a simple key apart', simple && simple.kind === 'GAMEMODE' && simple.id === 'GAMEMODE_MONOPOLIES', JSON.stringify(simple));
  const cfg = setup.parseKey(CONFIG);
  check('parseKey takes a config key apart',
    cfg && cfg.kind === 'CONFIG' && cfg.group === 'Map' && cfg.configId === 'MapSize' && cfg.value === 'MAPSIZE_DUEL',
    JSON.stringify(cfg));
  check('parseKey answers null for junk', setup.parseKey('junk') === null);
}

// --- Test 6: writing ------------------------------------------------------------
console.log('\nTest 6: asserting and withdrawing');
{
  fs.rmSync(FILE, { force: true });

  const v = setup.setOption(FILE, RULESET, true);
  check('an assertion is written and read back', v.asserted[RULESET] === true);
  check('the file appears on disk', fs.existsSync(FILE));
  check('  with the version it was written as', JSON.parse(fs.readFileSync(FILE, 'utf8')).version === 1);
  check('  and no temp file left beside it', !fs.readdirSync(TMP).some((f) => /\.tmp-/.test(f)), fs.readdirSync(TMP).join());

  setup.setOption(FILE, MODE, true);
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  check('keys are stored sorted, so the file is diffable by hand',
    JSON.stringify(Object.keys(onDisk.asserted)) === JSON.stringify([MODE, RULESET]), Object.keys(onDisk.asserted).join());

  const off = setup.setOption(FILE, RULESET, false);
  check('withdrawing leaves no entry behind', off.asserted[RULESET] === undefined && setup.isAsserted(off, MODE));
  const cleared = setup.clearSetup(FILE);
  check('clearing asserts nothing', Object.keys(cleared.asserted).length === 0 && cleared.error === null);

  check('an empty key is refused whole', /cannot be empty/.test(cap(setup.setOption, FILE, '  ', true)));
  check('  and nothing was written', Object.keys(setup.readSetup(FILE).asserted).length === 0);

  // A second tab toggling a different option must not lose the first tab's work.
  setup.setOption(FILE, RULESET, true);
  setup.setOption(FILE, MODE, true);
  const both = setup.readSetup(FILE);
  check('two toggles to different options both survive',
    both.asserted[RULESET] === true && both.asserted[MODE] === true, JSON.stringify(both.asserted));
}

// --- Test 7: the write leaves nothing half-done ----------------------------------
console.log('\nTest 7: a file that cannot be built on');
{
  put('{ broken');
  const before = fs.readFileSync(FILE, 'utf8');
  const msg = cap(setup.setOption, FILE, RULESET, true);
  check('a toggle over a corrupt file is refused', /not valid JSON/.test(msg), msg);
  check('  and the message says nothing was written', /nothing was written/.test(msg), msg);
  check('  and the file is left exactly as it was', fs.readFileSync(FILE, 'utf8') === before);
  check('  and reads still assert nothing', Object.keys(setup.readSetup(FILE).asserted).length === 0);
  check('a file of the wrong version is refused the same way', (() => {
    put({ version: 42, asserted: {} });
    return /nothing was written/.test(cap(setup.setOption, FILE, RULESET, true));
  })());
  check('clearing a corrupt file is refused too', (() => {
    put('{ broken');
    return /nothing was written/.test(cap(setup.clearSetup, FILE));
  })());
  // The recoverable case still writes: one bad entry among good ones costs only
  // that entry, so there is a real map to build on.
  put({ version: 1, asserted: { [RULESET]: true, 'junk-without-a-kind': true } });
  const ok = setup.setOption(FILE, MODE, true);
  check('a file with one bad entry is still writable', setup.isAsserted(ok, RULESET) && setup.isAsserted(ok, MODE));
  check('  and the bad entry is gone from the file',
    !JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8'))).includes('junk-without-a-kind'));
}

// --- Test 8: deleting the store returns measured-only verdicts -------------------
console.log('\nTest 8: the store file is deleted');
{
  setup.setOption(FILE, RULESET, true);
  check('an option is asserted before the delete', setup.isAsserted(setup.readSetup(FILE), RULESET));
  fs.rmSync(FILE, { force: true });
  const gone = setup.readSetup(FILE);
  check('after the delete nothing is asserted', !setup.isAsserted(gone, RULESET) && gone.keys.length === 0);
  check('  and the absence itself is not an error', gone.error === null, String(gone.error));
}

// --- Test 9: global store, no game-database writes ---------------------------------
console.log('\nTest 9: global scope and no game writes');
{
  delete process.env.CIV6_GAMESETUP_FILE;
  const def = setup.gameSetupFile();
  check('the default file is game-setup.json beside the store', path.basename(def) === 'game-setup.json', def);
  check('  next to mod-labels.json, not in a profile dir',
    path.dirname(def) === path.dirname(path.join(__dirname, '..', 'mod-labels.json')), def);
  process.env.CIV6_GAMESETUP_FILE = FILE;
  check('  and the path is overridable for tests', setup.gameSetupFile() === FILE);
  check('no function takes a profile', !/profile/i.test(
    setup.setOption.toString() + setup.readSetup.toString() + setup.clearSetup.toString()));

  const src = fs.readFileSync(path.join(__dirname, 'gamesetup.js'), 'utf8');
  check('the module names sqlite only for the read-only catalog table list',
    !/sqlite/i.test(src.replace(/sqlite_master/gi, '')), (src.match(/sqlite/gi) || []).join());
  check('  nor the game database by name', !/Mods\.sqlite|DebugGameplay|DebugConfiguration/.test(src));
  check('  nor writes one with SQL', !/INSERT INTO|UPDATE |DELETE FROM/.test(src));
  check('  and writes only through the shared atomic writer', /atomicWrite\(file, JSON\.stringify/.test(src));
}

// --- Test 10: the catalog is exactly what the fixture library gates on -------
console.log('\nTest 10: catalog matches the library, nothing more');
const LIB = path.join(TMP, 'Lib.sqlite');
{
  const seed = new DatabaseSync(LIB);
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const comp = (id) => seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, ?, 'UpdateDatabase')").run(id).lastInsertRowid;
  const gateNew = (compId, type, inverse, props) => {
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, ?)').run(s, type, inverse).lastInsertRowid;
    for (const [n, v] of props) seed.prepare('INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)').run(c, n, v);
    seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(compId, s);
    return s;
  };
  const rs = gateNew(comp('A'), 'RuleSetInUse', 0, [['Value', 'RULESET_EXPANSION_2']]);
  gateNew(comp('B'), 'RuleSetInUse', 0, [['Value', 'RULESET_EXPANSION_2']]);
  gateNew(comp('C'), 'ConfigurationValueMatches', 0, [['Group', 'Game'], ['ConfigurationId', 'GAMEMODE_MONOPOLIES'], ['Value', '1']]);
  gateNew(comp('D'), 'ConfigurationValueMatches', 0, [['Group', 'Map'], ['ConfigurationId', 'MapSize'], ['Value', 'MAPSIZE_DUEL']]);
  gateNew(comp('E'), 'GameCoreInUse', 0, [['Value', 'Expansion1']]);
  gateNew(comp('F'), 'LeaderPlayable', 0, [['Value', 'LEADER_ALEXANDER_MACEDON']]);
  gateNew(comp('G'), 'ModInUse', 0, [['Value', 'AAAAAAAA-1111-4111-8111-111111111111']]);
  gateNew(comp('H'), 'RuleSetInUse', 1, [['Value', 'RULESET_STANDARD']]);
  gateNew(comp('I'), 'ConfigurationValueMatches', 0, [['ConfigurationId', 'MapSize'], ['Value', 'MAPSIZE_DUEL']]);
  { // a set nothing points at gates nothing, whatever it names
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'Orphan', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, 0)').run(s, 'RuleSetInUse').lastInsertRowid;
    seed.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, 'Value', 'RULESET_ORPHAN')").run(c);
  }
  seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (9999, ?)').run(rs);
  seed.close();
}
{
  const before = fs.readFileSync(LIB);
  const lib = new DatabaseSync(LIB);
  const { options, error } = setup.buildCatalog(lib);
  lib.close();
  const after = fs.readFileSync(LIB);
  const byKey = new Map(options.map((o) => [o.key, o]));
  check('mining reports no error', error === null, String(error));
  check('the catalog holds exactly the referenced options',
    JSON.stringify([...byKey.keys()].sort()) === JSON.stringify([
      'CONFIG:Map/MapSize=MAPSIZE_DUEL',
      'CORE:Expansion1',
      'GAMEMODE:GAMEMODE_MONOPOLIES',
      'LEADER:LEADER_ALEXANDER_MACEDON',
      'RULESET:RULESET_EXPANSION_2',
      'RULESET:RULESET_STANDARD',
    ]), [...byKey.keys()].sort().join());
  const counts = {};
  for (const o of options) counts[o.key] = o.count;
  check('a value two actions share counts both', counts['RULESET:RULESET_EXPANSION_2'] === 2, JSON.stringify(counts));
  check('  and single-gated options count one',
    counts['GAMEMODE:GAMEMODE_MONOPOLIES'] === 1 && counts['CONFIG:Map/MapSize=MAPSIZE_DUEL'] === 1
    && counts['CORE:Expansion1'] === 1 && counts['LEADER:LEADER_ALEXANDER_MACEDON'] === 1
    && counts['RULESET:RULESET_STANDARD'] === 1, JSON.stringify(counts));
  check('an inverted reference still lists its value', byKey.has('RULESET:RULESET_STANDARD'));
  check('a set nothing points at lists nothing', ![...byKey.keys()].some((k) => k.includes('ORPHAN')));
  check('a link to a missing action inflates no count', counts['RULESET:RULESET_EXPANSION_2'] === 2);
  check('mining never writes the library', before.equals(after));
}
// --- Test 11: readable names, panel order, and reference fields ----------------
console.log('\nTest 11: names, order and references');
{
  const lib = new DatabaseSync(LIB);
  const { options } = setup.buildCatalog(lib);
  lib.close();
  const names = {};
  for (const o of options) names[o.key] = o.name;
  check('ids read as words', names['RULESET:RULESET_EXPANSION_2'] === 'Expansion 2'
    && names['GAMEMODE:GAMEMODE_MONOPOLIES'] === 'Monopolies'
    && names['LEADER:LEADER_ALEXANDER_MACEDON'] === 'Alexander Macedon'
    && names['CORE:Expansion1'] === 'Expansion 1', JSON.stringify(names));
  check('a config triple reads as option = value',
    names['CONFIG:Map/MapSize=MAPSIZE_DUEL'] === 'Map Size = Duel', JSON.stringify(names));
  check('options run rulesets, modes, config, cores, leaders',
    options.map((o) => o.kind).join() === 'RULESET,RULESET,GAMEMODE,CONFIG,CORE,LEADER',
    options.map((o) => o.kind).join());
  const cfg = options.find((o) => o.kind === 'CONFIG');
  check('a config entry carries its triple',
    cfg.group === 'Map' && cfg.configId === 'MapSize' && cfg.value === 'MAPSIZE_DUEL', JSON.stringify(cfg));
  const mode = options.find((o) => o.kind === 'GAMEMODE');
  check('a mode entry carries its id', mode.id === 'GAMEMODE_MONOPOLIES', JSON.stringify(mode));
  check('a junk key labels as given', setup.displayName('junk') === 'junk');
  check('criterionKey refuses what is not setup',
    setup.criterionKey('ModInUse', { Value: 'X' }) === null
    && setup.criterionKey('ConfigurationValueMatches', { ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' }) === null
    && setup.criterionKey('RuleSetInUse', {}) === null
    && setup.criterionKey('Nope', { Value: 'X' }) === null);
  check('criterionKey folds modes and keeps triples',
    setup.criterionKey('ConfigurationValueMatches', { Group: 'Game', ConfigurationId: 'GAMEMODE_X', Value: '1' }) === 'GAMEMODE:GAMEMODE_X'
    && setup.criterionKey('ConfigurationValueMatches', { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' }) === 'CONFIG:Map/MapSize=MAPSIZE_DUEL'
    && setup.criterionKey('RuleSetInUse', { Value: 'RULESET_STANDARD' }) === 'RULESET:RULESET_STANDARD');
  const bare = new DatabaseSync(':memory:');
  const empty = setup.buildCatalog(bare);
  bare.close();
  check('missing tables mine as empty, not as failure', empty.options.length === 0 && empty.error === null);
  const noDb = setup.buildCatalog(null);
  check('no database mines as empty with a reason', noDb.options.length === 0 && !!noDb.error, String(noDb.error));
}
// --- Test 12: the catalog is the known set the store prunes against -----------
console.log('\nTest 12: catalog-driven pruning');
{
  const lib = new DatabaseSync(LIB);
  const known = new Set(setup.buildCatalog(lib).options.map((o) => o.key));
  lib.close();
  put({ version: 1, asserted: { 'RULESET:RULESET_EXPANSION_2': true, 'RULESET:RULESET_GONE': true } });
  const v = setup.readSetup(FILE, known);
  check('an assertion still in the library survives', v.asserted['RULESET:RULESET_EXPANSION_2'] === true);
  check('  and one that left it is pruned and counted', v.asserted['RULESET:RULESET_GONE'] === undefined && v.pruned === 1);
}

// --- Test 13: TEXT-affinity links still join (the live-DB shape) ------------
console.log('\nTest 13: TEXT-affinity linkage still yields options');
const LIB_TXT = path.join(TMP, 'LibText.sqlite');
{
  const seed = new DatabaseSync(LIB_TXT);
  // ComponentCriteria.CriteriaRowId declared TEXT, exactly like the live
  // Mods.sqlite; every other id column stays INTEGER. Integer set ids bound
  // into a TEXT-affinity column come back as strings, while Criterion hands
  // the same ids back as numbers - the split that once emptied the panel.
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId TEXT NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const a = seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, 'A', 'UpdateDatabase')").run().lastInsertRowid;
  const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
  const c = seed.prepare("INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, 'RuleSetInUse', 0)").run(s).lastInsertRowid;
  seed.prepare("INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, 'Value', 'RULESET_STANDARD')").run(c);
  seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(a, s);
  seed.close();
}
{
  const probe = new DatabaseSync(LIB_TXT, { readOnly: true });
  const linkType = probe.prepare('SELECT typeof(CriteriaRowId) AS t FROM ComponentCriteria LIMIT 1').get().t;
  const critType = probe.prepare('SELECT typeof(CriteriaRowId) AS t FROM Criterion LIMIT 1').get().t;
  probe.close();
  check('the fixture reproduces the live affinity split (text vs integer)',
    linkType === 'text' && critType === 'integer', `${linkType} vs ${critType}`);
  const lib = new DatabaseSync(LIB_TXT);
  const { options, error } = setup.buildCatalog(lib);
  lib.close();
  check('mining reports no error', error === null, String(error));
  check('the linked option is mined despite the affinity split',
    options.length === 1 && options[0].key === 'RULESET:RULESET_STANDARD' && options[0].count === 1,
    JSON.stringify(options));
}

// --- Test 14: comma lists split into single options -------------------------
console.log('\nTest 14: comma lists split into single options');
const LIB_OR = path.join(TMP, 'LibOr.sqlite');
{
  const seed = new DatabaseSync(LIB_OR);
  seed.exec(`CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  const comp = (id) => seed.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (1, ?, 'UpdateDatabase')").run(id).lastInsertRowid;
  const gateNew = (compIds, type, props) => {
    const s = seed.prepare("INSERT INTO Criteria (ModRowId, CriteriaId, Any) VALUES (1, 'C', 0)").run().lastInsertRowid;
    const c = seed.prepare('INSERT INTO Criterion (CriteriaRowId, CriterionType, Inverse) VALUES (?, ?, 0)').run(s, type).lastInsertRowid;
    for (const [n, v] of props) seed.prepare('INSERT INTO CriterionProperties (CriterionRowId, Name, Value) VALUES (?, ?, ?)').run(c, n, v);
    for (const compId of compIds) seed.prepare('INSERT INTO ComponentCriteria (ComponentRowId, CriteriaRowId) VALUES (?, ?)').run(compId, s);
  };
  // Two actions share one comma-listed set: each single counts both.
  gateNew([comp('A'), comp('A2')], 'RuleSetInUse', [['Value', 'RULESET_STANDARD, RULESET_EXPANSION_1']]);
  gateNew([comp('B')], 'GameCoreInUse', [['Value', 'Expansion1,Expansion2']]);
  gateNew([comp('C')], 'LeaderPlayable', [['Value', 'Players:StandardPlayers::LEADER_X,StandardPlayers::LEADER_Y']]);
  gateNew([comp('D')], 'RuleSetInUse', [['Value', 'RULESET_OK, has space']]);
  gateNew([comp('E')], 'RuleSetInUse', [['Value', 'has space']]);
  gateNew([comp('F')], 'RuleSetInUse', [['Value', 'RULESET_SOLO,, ']]);
  seed.close();
}
{
  const lib = new DatabaseSync(LIB_OR);
  const { options, error } = setup.buildCatalog(lib);
  lib.close();
  const byKey = new Map(options.map((o) => [o.key, o]));
  check('mining reports no error', error === null, String(error));
  check('a spaced comma list yields both singles',
    byKey.has('RULESET:RULESET_STANDARD') && byKey.has('RULESET:RULESET_EXPANSION_1'),
    [...byKey.keys()].sort().join());
  check('each single counts every action naming it',
    byKey.get('RULESET:RULESET_STANDARD').count === 2 && byKey.get('RULESET:RULESET_EXPANSION_1').count === 2,
    JSON.stringify([...byKey.values()].map((o) => `${o.key}=${o.count}`)));
  check('a game-core list yields both cores',
    byKey.get('CORE:Expansion1').count === 1 && byKey.get('CORE:Expansion2').count === 1);
  check('a per-slot leader list yields both leader tails',
    byKey.has('LEADER:LEADER_X') && byKey.has('LEADER:LEADER_Y'), [...byKey.keys()].sort().join());
  check('no raw list or slot prefix becomes an option',
    ![...byKey.keys()].some((k) => /[, ]/.test(k) || k.includes('Players')), [...byKey.keys()].sort().join());
  check('a mixed list keeps the good single and drops the junk',
    byKey.has('RULESET:RULESET_OK') && ![...byKey.keys()].some((k) => k.includes('has space')));
  check('a junk-only row yields nothing', ![...byKey.keys()].some((k) => k.includes('space')));
  check('trailing empties yield just the single', byKey.has('RULESET:RULESET_SOLO'));
}

// --- Test 15: criterionKeys unit shape --------------------------------------
console.log('\nTest 15: criterionKeys splits, criterionKey stays first-or-null');
{
  check('comma input yields one key per single',
    JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: 'RULESET_A,RULESET_B' }))
    === JSON.stringify(['RULESET:RULESET_A', 'RULESET:RULESET_B']));
  check('surrounding space is trimmed and empties dropped',
    JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: ' RULESET_A ,, RULESET_B ' }))
    === JSON.stringify(['RULESET:RULESET_A', 'RULESET:RULESET_B']));
  check('leader singles reduce to their tails',
    JSON.stringify(setup.criterionKeys('LeaderPlayable', { Value: 'Players:StandardPlayers::LEADER_X,StandardPlayers::LEADER_Y' }))
    === JSON.stringify(['LEADER:LEADER_X', 'LEADER:LEADER_Y']));
  check('a bare leader still maps as before',
    JSON.stringify(setup.criterionKeys('LeaderPlayable', { Value: 'LEADER_ALEXANDER_MACEDON' }))
    === JSON.stringify(['LEADER:LEADER_ALEXANDER_MACEDON']));
  check('junk singles are refused one by one',
    JSON.stringify(setup.criterionKeys('RuleSetInUse', { Value: 'RULESET_OK, has space,,' }))
    === JSON.stringify(['RULESET:RULESET_OK'])
    && setup.criterionKeys('RuleSetInUse', { Value: 'has space' }).length === 0);
  check('config comma values split the triple',
    JSON.stringify(setup.criterionKeys('ConfigurationValueMatches', { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL,MAPSIZE_TINY' }))
    === JSON.stringify(['CONFIG:Map/MapSize=MAPSIZE_DUEL', 'CONFIG:Map/MapSize=MAPSIZE_TINY']));
  check('criterionKey answers the first single',
    setup.criterionKey('RuleSetInUse', { Value: 'RULESET_A,RULESET_B' }) === 'RULESET:RULESET_A');
  check('criterionKey still answers null for junk and non-setup',
    setup.criterionKey('RuleSetInUse', { Value: 'has space' }) === null
    && setup.criterionKey('ModInUse', { Value: 'X' }) === null
    && setup.criterionKey('RuleSetInUse', {}) === null);
  check('splitCommaList splits, trims and drops empties',
    JSON.stringify(setup.splitCommaList(' a ,,b, ')) === JSON.stringify(['a', 'b'])
    && setup.splitCommaList(null).length === 0);
  check('leaderTail takes the tail after the last slot separator',
    setup.leaderTail('Players:StandardPlayers::LEADER_X') === 'LEADER_X'
    && setup.leaderTail('LEADER_X') === 'LEADER_X');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'GAME-SETUP: ALL CHECKS PASSED' : 'GAME-SETUP: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
