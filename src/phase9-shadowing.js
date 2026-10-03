'use strict';

// Phase 9 automated proof: UI file-shadowing enumeration (task 3.1).
//
// Operates on a synthetic database in a scratch dir, plus optionally a
// read-only enumeration of a real Mods.sqlite passed as a positional argument
// (read, never written).
//
//   node src/phase9-shadowing.js --contested [path/to/Mods.sqlite]
//   node src/phase9-shadowing.js --winners
//   node src/phase9-shadowing.js --envelope
//   node src/phase9-shadowing.js --warnings
//
// The load-bearing fixture: mod B contests UI/Panel.lua ONLY via a
// ReplaceUIScript action's ComponentProperties.LuaReplace row, with zero
// ComponentFiles links. A file-list-only scan sees that path as claimed by
// mod A alone (uncontested); the Components/Files UNION LuaReplace
// enumeration must report both claimants.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const shadowing = require('./shadowing');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-shadowing-')));
const DB_PATH = path.join(TMP, 'Mods.sqlite');
const WINNERS_DB = path.join(TMP, 'Winners.sqlite');
const ENVELOPE_DB = path.join(TMP, 'Envelope.sqlite');
const WARNINGS_DB = path.join(TMP, 'Warnings.sqlite');
const TAGGED_DB = path.join(TMP, 'Tagged.sqlite');

const ARGS = process.argv.slice(2);
const WANT_WINNERS = ARGS.includes('--winners');
const WANT_ENVELOPE = ARGS.includes('--envelope');
const WANT_WARNINGS = ARGS.includes('--warnings');
// Default (no flag) is the 3.1 contested enumeration, as before; --contested
// selects it explicitly, --winners selects the 3.2 winner-rule fixtures,
// --envelope selects the 3.3 reference-scale envelope fixture, --warnings
// selects the pairing + wrong-context warning fixtures. The warnings suite
// also runs with the default (bare or --contested) invocation, so the plain
// `node src/phase9-shadowing.js` proof covers it.
const WANT_CONTESTED = ARGS.includes('--contested') || (!WANT_WINNERS && !WANT_ENVELOPE && !WANT_WARNINGS);
const RUN_WARNINGS = WANT_WARNINGS || WANT_CONTESTED;

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};

const MOD_A = 'AAAAAAAA-1111-4111-8111-111111111111'; // ships UI/Panel.lua as a file
const MOD_B = 'BBBBBBBB-2222-4222-8222-222222222222'; // replaces UI/Panel.lua via LuaReplace only
const MOD_C = 'CCCCCCCC-3333-4333-8333-333333333333'; // ships UI/Both.lua as a file
const MOD_D = 'DDDDDDDD-4444-4444-8444-444444444444'; // disabled; also ships UI/Panel.lua

function addFileAction(w, modRowId, type, id, files, properties) {
  const cr = w.prepare('INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, ?)')
    .run(modRowId, id, type).lastInsertRowid;
  for (const [name, value] of Object.entries(properties || {})) {
    w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)').run(cr, name, value);
  }
  for (const f of files) {
    let row = w.prepare('SELECT FileRowId AS id FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(modRowId, f);
    if (!row) {
      row = { id: w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid };
    }
    w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(cr, row.id);
  }
  return cr;
}

// A front-end action: a Settings row with its <File> children linked through
// SettingFiles. Settings carry no ComponentProperties in this model (mirrors
// the registration: properties are a Components-side table), so there is no
// properties argument.
function addSettingAction(w, modRowId, type, id, files) {
  const sr = w.prepare('INSERT INTO Settings (ModRowId, SettingId, SettingType) VALUES (?, ?, ?)')
    .run(modRowId, id, type).lastInsertRowid;
  for (const f of files || []) {
    let row = w.prepare('SELECT FileRowId AS id FROM ModFiles WHERE ModRowId = ? AND Path = ?').get(modRowId, f);
    if (!row) {
      row = { id: w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)').run(modRowId, f).lastInsertRowid };
    }
    w.prepare('INSERT INTO SettingFiles (SettingRowId, FileRowId, Priority) VALUES (?, ?, 0)').run(sr, row.id);
  }
  return sr;
}

function seed() {
  const w = new DatabaseSync(DB_PATH);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const addMod = (modId, name) => {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(`C:/mods/${name}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare("INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, 'Name', ?)").run(mid, `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`);
    w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)").run(mid, `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`, name);
    return mid;
  };

  const mA = addMod(MOD_A, 'File Mod');
  const mB = addMod(MOD_B, 'Replacer Mod');
  const mC = addMod(MOD_C, 'Third Mod');
  const mD = addMod(MOD_D, 'Disabled Mod');

  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, ?)');
  item.run(mA, 0);
  item.run(mB, 0);
  item.run(mC, 0);
  item.run(mD, 1); // off in the active profile: its claims must not count

  // A ships the panel as a file.
  addFileAction(w, mA, 'AddUIScript', 'PanelShip', ['UI/Panel.lua']);
  // A alone ships this one: uncontested, must be omitted from the report.
  addFileAction(w, mA, 'AddUIScript', 'SoloShip', ['UI/Solo.lua']);
  // B replaces the panel via LuaReplace and ships NO <File> for it.
  addFileAction(w, mB, 'ReplaceUIScript', 'PanelReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Panel.lua' });
  // File-vs-file contest as the control case.
  addFileAction(w, mB, 'AddUIScript', 'BothShipB', ['UI/Both.lua']);
  addFileAction(w, mC, 'AddUIScript', 'BothShipC', ['UI/Both.lua']);
  // Disabled mod's claim: same path, must not appear as a claimant.
  addFileAction(w, mD, 'AddUIScript', 'PanelShipD', ['UI/Panel.lua']);

  w.close();
}

function printReport(contested) {
  for (const c of contested) {
    console.log(`  contested: ${c.path}`);
    for (const cl of c.claimants) {
      console.log(`    - ${cl.name} (${cl.modId}) via ${cl.sources.join('+')}`);
    }
  }
  if (!contested.length) console.log('  (no contested paths)');
}

if (WANT_CONTESTED) {
seed();
console.log(`scratch dir: ${TMP}\nseeded a small test database -> ${DB_PATH}\n`);

console.log('Test 1: contested-path enumeration (--contested)');
{
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let contested;
  try {
    contested = shadowing.enumerateContested(db);
  } finally {
    db.close();
  }
  printReport(contested);

  const paths = contested.map((c) => c.path);
  check('exactly the two contested paths are reported',
    JSON.stringify(paths) === JSON.stringify(['UI/Both.lua', 'UI/Panel.lua']), JSON.stringify(paths));

  const panel = contested.find((c) => c.path === 'UI/Panel.lua');
  const panelMods = panel ? panel.claimants.map((c) => c.modId.toLowerCase()) : [];
  check('UI/Panel.lua names both claimant mods',
    panelMods.length === 2 && panelMods.includes(MOD_A.toLowerCase()) && panelMods.includes(MOD_B.toLowerCase()),
    JSON.stringify(panelMods));

  const replacer = panel ? panel.claimants.find((c) => c.modId.toLowerCase() === MOD_B.toLowerCase()) : null;
  check('the ReplaceUIScript claimant is sourced as LuaReplace',
    !!replacer && JSON.stringify(replacer.sources) === JSON.stringify(['LuaReplace']), JSON.stringify(replacer && replacer.sources));
  const shipper = panel ? panel.claimants.find((c) => c.modId.toLowerCase() === MOD_A.toLowerCase()) : null;
  check('the shipping claimant is sourced as file',
    !!shipper && JSON.stringify(shipper.sources) === JSON.stringify(['file']), JSON.stringify(shipper && shipper.sources));

  // The load-bearing fact: B's side of the contest has no file link at all,
  // so a Components/Files-only scan could never have found it.
  const probe = new DatabaseSync(DB_PATH, { readOnly: true });
  let links = -1;
  try {
    links = probe.prepare(
      `SELECT count(*) AS n FROM ComponentFiles cf
         JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
         JOIN Mods m ON m.ModRowId = c.ModRowId
        WHERE lower(m.ModId) = lower(?) AND c.ComponentType = 'ReplaceUIScript'`
    ).get(MOD_B).n;
  } finally {
    probe.close();
  }
  check('the ReplaceUIScript contest side has zero ComponentFiles links', links === 0, `${links} links`);

  // ...and indeed a file-only scan reads UI/Panel.lua as single-claimant.
  const fileOnly = new DatabaseSync(DB_PATH, { readOnly: true });
  let panelFileClaimants = -1;
  try {
    panelFileClaimants = fileOnly.prepare(
      `SELECT count(DISTINCT c.ModRowId) AS n
         FROM ComponentFiles cf
         JOIN Components c ON c.ComponentRowId = cf.ComponentRowId
         JOIN ModFiles f ON f.FileRowId = cf.FileRowId
         JOIN ModGroupItems i ON i.ModRowId = c.ModRowId
        WHERE f.Path = 'UI/Panel.lua' AND i.ModGroupRowId = 1 AND i.Disabled = 0`
    ).get().n;
  } finally {
    fileOnly.close();
  }
  check('a file-list-only scan sees UI/Panel.lua as uncontested (the gap this closes)',
    panelFileClaimants === 1, `${panelFileClaimants} file claimant(s)`);

  const both = contested.find((c) => c.path === 'UI/Both.lua');
  const bothSources = both ? both.claimants.map((c) => c.sources.join('+')).sort() : [];
  check('the file-vs-file contest still reports both shippers as file',
    JSON.stringify(bothSources) === JSON.stringify(['file', 'file']), JSON.stringify(bothSources));

  check('the uncontested path is omitted', !paths.includes('UI/Solo.lua'), JSON.stringify(paths));
  check('the disabled mod is not named as a claimant',
    !contested.some((c) => c.claimants.some((cl) => cl.modId.toLowerCase() === MOD_D.toLowerCase())),
    JSON.stringify(contested.map((c) => [c.path, c.claimants.map((cl) => cl.name)])));
}
} // end WANT_CONTESTED

// Tagged-name fixture (DLC-style): claimant Name tags with no own
// LocalizedText row. TAG_A's tag text lives under another mod's row
// (cross-mod resolution); TAG_B's tag lives nowhere (prettyName).
// Old modIndex showed the raw LOC_ tag for both; the shared reader
// (MOD_NAME_SQL + displayNameOf + prettyName) resolves/prettifies.
const TAG_A = 'e1e1e1e1-aaaa-4aaa-8aaa-aaaaaaaaaa11';
const TAG_B = 'e2e2e2e2-bbbb-4bbb-8bbb-bbbbbbbbbb22';
const TAG_HOLDER = 'e3e3e3e3-cccc-4ccc-8ccc-cccccccccc33';

function seedTagged(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const addTaggedMod = (modId, scannedPath, nameTag) => {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(scannedPath).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(mid, 'Name', nameTag);
    return mid;
  };
  const tA = addTaggedMod(TAG_A, 'C:/mods/TaggedA.modinfo', 'LOC_EXPANSION1_MOD_TITLE');
  const tB = addTaggedMod(TAG_B, 'C:/mods/TaggedB.modinfo', 'LOC_EXPANSION2_MOD_TITLE');
  const tH = addTaggedMod(TAG_HOLDER, 'C:/mods/TagHolder.modinfo', 'LOC_TAG_HOLDER_NAME');
  w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)")
    .run(tH, 'LOC_TAG_HOLDER_NAME', 'Tag Holder');
  // The DLC-style title text lives under another mod's row only.
  w.prepare("INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, 'en_US', ?)")
    .run(tH, 'LOC_EXPANSION1_MOD_TITLE', 'Expansion: Rise and Fall');
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const tItem = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  tItem.run(tA); tItem.run(tB); tItem.run(tH);
  addFileAction(w, tA, 'AddUIScript', 'TaggedShipA', ['UI/Tagged.lua']);
  addFileAction(w, tB, 'AddUIScript', 'TaggedShipB', ['UI/Tagged.lua']);
  w.close();
}

if (WANT_CONTESTED) {
  console.log('\nTest 1b: tagged DLC-style claimant names resolve (no bare LOC_ tag)');
  seedTagged(TAGGED_DB);
  const tdb = new DatabaseSync(TAGGED_DB, { readOnly: true });
  let tagged;
  try {
    tagged = shadowing.enumerateContested(tdb);
  } finally {
    tdb.close();
  }
  const tEntry = tagged.find((c) => c.path === 'UI/Tagged.lua');
  const tNames = tEntry ? tEntry.claimants.map((c) => c.name) : [];
  console.log(`  contested: UI/Tagged.lua <- ${tNames.join(' vs ')}`);
  check('the tagged contest is enumerated with both claimants',
    !!tEntry && tEntry.claimants.length === 2, JSON.stringify(tNames));
  check('no claimant name is a bare LOC_ tag',
    tNames.length === 2 && tNames.every((n) => !/LOC_[A-Z0-9_]+/i.test(n)), JSON.stringify(tNames));
  const tAName = tEntry ? (tEntry.claimants.find((c) => c.modId.toLowerCase() === TAG_A.toLowerCase()) || {}).name : null;
  const tBName = tEntry ? (tEntry.claimants.find((c) => c.modId.toLowerCase() === TAG_B.toLowerCase()) || {}).name : null;
  check('cross-mod text resolves like every other screen (Expansion: Rise and Fall)',
    tAName === 'Expansion: Rise and Fall', JSON.stringify(tAName));
  check('an unlocalised tag prettifies like every other screen (Expansion: Gathering Storm)',
    tBName === 'Expansion: Gathering Storm', JSON.stringify(tBName));
}

// Task 3.2 fixtures: one contested path per winner-rule outcome. All mods are
// enabled; LoadOrder is the only signal the rule may read.
const WS1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // SingleMax low (two actions: 50 + 100)
const WS2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2'; // SingleMax high (200)
const WP1 = '33333333-cccc-4ccc-8ccc-cccccccccc3'; // Partial declarer (150)
const WP2 = '44444444-dddd-4ddd-8ddd-dddddddddd4'; // Partial silent (no LoadOrder)
const WU1 = '55555555-eeee-4eee-8eee-eeeeeeeeee5'; // Undeclared one
const WU2 = '66666666-ffff-4fff-8fff-ffffffffff6'; // Undeclared two
const WT1 = '77777777-1111-4111-8111-1111111117'; // Tie filer (300, via file)
const WT2 = '88888888-2222-4222-8222-2222222228'; // Tie replacer (300, via LuaReplace only)
const WI1 = '99999999-3333-4333-8333-3333333339'; // Identical-content tie filer A (310, via file)
const WI2 = '00000000-4444-4444-8444-4444444400'; // Identical-content tie filer B (310, via file)

function seedWinners(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const ids = {};
  for (const [modId, name] of [[WS1, 'Single Low'], [WS2, 'Single High'], [WP1, 'Partial Declarer'],
      [WP2, 'Partial Silent'], [WU1, 'Undeclared One'], [WU2, 'Undeclared Two'],
      [WT1, 'Tie Filer'], [WT2, 'Tie Replacer'],
      [WI1, 'Tie Identical A'], [WI2, 'Tie Identical B']]) {
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)')
      .run(`C:/mods/${name.replace(/[^A-Za-z]+/g, '_')}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
      .run(sf, modId).lastInsertRowid;
    ids[modId] = mid;
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of Object.values(ids)) item.run(mid);

  // SingleMax: S1 claims via TWO file actions (50 and 100 fold to a per-mod
  // max of 100); S2 claims via one file action at 200 and wins.
  addFileAction(w, ids[WS1], 'AddUIScript', 'MaxLowA', ['UI/SingleMax.lua'], { LoadOrder: '50' });
  addFileAction(w, ids[WS1], 'AddUIScript', 'MaxLowB', ['UI/SingleMax.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[WS2], 'AddUIScript', 'MaxHigh', ['UI/SingleMax.lua'], { LoadOrder: '200' });
  // Partial: only P1 declares, so it is trivially the strictly greatest.
  addFileAction(w, ids[WP1], 'AddUIScript', 'PartialShip', ['UI/Partial.lua'], { LoadOrder: '150' });
  addFileAction(w, ids[WP2], 'AddUIScript', 'PartialSilent', ['UI/Partial.lua']);
  // Undeclared: neither side declares anything.
  addFileAction(w, ids[WU1], 'AddUIScript', 'UndShip1', ['UI/Undeclared.lua']);
  addFileAction(w, ids[WU2], 'AddUIScript', 'UndShip2', ['UI/Undeclared.lua']);
  // Genuine tie: same max (300) from different sources - file vs LuaReplace -
  // so the tie survives regardless of claim source (no secondary signal).
  addFileAction(w, ids[WT1], 'AddUIScript', 'TieShip', ['UI/Tie.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[WT2], 'ReplaceUIScript', 'TieReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Tie.lua', LoadOrder: '300' });
  // Identical-content tie: same max (310) from two file shippers. The
  // payload bytes are materialized as scratch files and asserted identical
  // in the --winners block below; the winner rule must still report tie.
  addFileAction(w, ids[WI1], 'AddUIScript', 'TieIdentShipA', ['UI/TieIdentical.lua'], { LoadOrder: '310' });
  addFileAction(w, ids[WI2], 'AddUIScript', 'TieIdentShipB', ['UI/TieIdentical.lua'], { LoadOrder: '310' });

  w.close();
}

if (WANT_WINNERS) {
  console.log('Test 2: winner rule - strictly-greatest declared LoadOrder wins (--winners)');
  seedWinners(WINNERS_DB);
  const db = new DatabaseSync(WINNERS_DB, { readOnly: true });
  let decided;
  try {
    decided = shadowing.resolveWinners(db);
  } finally {
    db.close();
  }
  for (const d of decided) {
    const extra = d.status === 'decided'
      ? `winner ${d.winner.modId.slice(0, 8)} @${d.winner.value}`
      : `${d.reason}${d.value !== undefined ? ' @' + d.value : ''}`;
    console.log(`  ${d.status}: ${d.path} <- ${extra}`);
  }

  const byPath = new Map(decided.map((d) => [d.path, d]));
  check('all five winner fixtures are contested', decided.length === 5, `${decided.length} path(s)`);

  const single = byPath.get('UI/SingleMax.lua');
  check('single-max: strictly greatest wins with its declared value',
    !!single && single.status === 'decided' && single.winner
      && single.winner.modId.toLowerCase() === WS2.toLowerCase() && single.winner.value === 200,
    JSON.stringify(single && single.winner));
  const singleLow = single ? single.claimants.find((c) => c.modId.toLowerCase() === WS1.toLowerCase()) : null;
  check('single-max: one mod claiming twice folds to its max (100, not 50)',
    !!singleLow && singleLow.value === 100, JSON.stringify(singleLow && singleLow.value));

  const partial = byPath.get('UI/Partial.lua');
  check('single declarer is trivially the strictly greatest and wins',
    !!partial && partial.status === 'decided' && partial.winner
      && partial.winner.modId.toLowerCase() === WP1.toLowerCase() && partial.winner.value === 150,
    JSON.stringify(partial && partial.winner));

  const und = byPath.get('UI/Undeclared.lua');
  check('no declared order is undefined with reason no-declared-order and no winner',
    !!und && und.status === 'undefined' && und.reason === 'no-declared-order' && und.winner === null,
    JSON.stringify(und && { status: und.status, reason: und.reason, winner: und.winner }));
  check('undeclared path still names all claimants with null values',
    !!und && und.claimants.length === 2 && und.claimants.every((c) => c.value === null),
    JSON.stringify(und && und.claimants.map((c) => [c.modId.slice(0, 8), c.value])));

  const tie = byPath.get('UI/Tie.lua');
  const tiedIds = tie && tie.tied ? tie.tied.map((t) => t.modId.toLowerCase()).sort() : [];
  check('genuine tie is undefined with reason tie, shared value, and no winner',
    !!tie && tie.status === 'undefined' && tie.reason === 'tie' && tie.value === 300 && tie.winner === null
      && tiedIds.length === 2 && tiedIds.includes(WT1.toLowerCase()) && tiedIds.includes(WT2.toLowerCase()),
    JSON.stringify(tie && { status: tie.status, reason: tie.reason, value: tie.value, tied: tie.tied }));
  const tieSources = tie ? tie.claimants.map((c) => c.sources.join('+')).sort() : [];
  check('tie spans file vs LuaReplace sources (rule is source-agnostic)',
    JSON.stringify(tieSources) === JSON.stringify(['LuaReplace', 'file']), JSON.stringify(tieSources));
  check('tied claimants are listed unranked (modId order, winner stays null)',
    !!tie && tie.winner === null && tie.tied
      && JSON.stringify(tie.tied.map((t) => t.modId)) === JSON.stringify([...tie.tied.map((t) => t.modId)].sort((a, b) => (a < b ? -1 : 1))),
    JSON.stringify(tie && tie.tied));
  const identBytes = Buffer.from('-- TieIdentical fixture payload v1\n', 'utf8');
  const identA = path.join(TMP, 'TieIdentical-A.lua');
  const identB = path.join(TMP, 'TieIdentical-B.lua');
  fs.writeFileSync(identA, identBytes);
  fs.writeFileSync(identB, identBytes);
  const hashOf = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const hashA = hashOf(identA);
  const hashB = hashOf(identB);
  check('identical-content tie payloads are byte-identical (scratch fixtures)',
    hashA === hashB, `${hashA.slice(0, 12)} vs ${hashB.slice(0, 12)}`);
  const tieIdent = byPath.get('UI/TieIdentical.lua');
  const tieIdentIds = tieIdent && tieIdent.tied ? tieIdent.tied.map((t) => t.modId.toLowerCase()).sort() : [];
  check('identical content still undefined with reason tie and no winner',
    !!tieIdent && tieIdent.status === 'undefined' && tieIdent.reason === 'tie' && tieIdent.value === 310 && tieIdent.winner === null
      && tieIdentIds.length === 2 && tieIdentIds.includes(WI1.toLowerCase()) && tieIdentIds.includes(WI2.toLowerCase()),
    JSON.stringify(tieIdent && { status: tieIdent.status, reason: tieIdent.reason, value: tieIdent.value, tied: tieIdent.tied }));
}

// Task 3.3 fixture: a deterministic reference-scale corpus with the measured
// spike's shape - 424 mods / 3,171 components yielding 354 contested paths of
// which 35 are decidable by strictly-greatest LoadOrder, 318 have no claimant
// declaring order, and 1 is a genuine tie. All claims are file-sourced (the
// union path is covered by tasks 3.1/3.2); the envelope counts and timing are
// what this proves.
const ENVELOPE_REF = {
  mods: 424, components: 3171, contested: 354,
  decidable: 35, noDeclaredOrder: 318, ties: 1, wallMs: 50,
};

function seedEnvelope(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const modRowIds = [];
  const addMod = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)');
  const addModRow = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)');
  for (let i = 0; i < ENVELOPE_REF.mods; i += 1) {
    const modId = `envelope-mod-${String(i).padStart(4, '0')}`;
    const sf = addMod.run(`C:/mods/${modId}.modinfo`).lastInsertRowid;
    modRowIds.push(addModRow.run(sf, modId).lastInsertRowid);
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const addItem = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of modRowIds) addItem.run(mid);

  const addComp = w.prepare("INSERT INTO Components (ModRowId, ComponentId, ComponentType) VALUES (?, ?, 'AddUIScript')");
  const addProp = w.prepare('INSERT INTO ComponentProperties (ComponentRowId, Name, Value) VALUES (?, ?, ?)');
  const addFile = w.prepare('INSERT INTO ModFiles (ModRowId, Path) VALUES (?, ?)');
  const addLink = w.prepare('INSERT INTO ComponentFiles (ComponentRowId, FileRowId, Priority) VALUES (?, ?, 0)');
  let seq = 0;
  const claim = (modIdx, uiPath, loadOrder) => {
    const cr = addComp.run(modRowIds[modIdx], `Env${seq}`).lastInsertRowid;
    seq += 1;
    if (loadOrder != null) addProp.run(cr, 'LoadOrder', String(loadOrder));
    const fr = addFile.run(modRowIds[modIdx], uiPath).lastInsertRowid;
    addLink.run(cr, fr);
  };

  w.exec('BEGIN');
  try {
    for (let i = 0; i < ENVELOPE_REF.contested; i += 1) {
      const uiPath = `UI/Contested${String(i).padStart(4, '0')}.lua`;
      const a = i % ENVELOPE_REF.mods;
      const b = (i + 211) % ENVELOPE_REF.mods; // 211 is coprime to 424: always a distinct mod
      if (i < ENVELOPE_REF.decidable) {
        claim(a, uiPath, 100); // strictly-greatest loser side
        claim(b, uiPath, 200 + i); // strictly-greatest winner side
      } else if (i === ENVELOPE_REF.contested - 1) {
        claim(a, uiPath, 500); // genuine tie: shared max
        claim(b, uiPath, 500);
      } else {
        claim(a, uiPath, null); // no claimant declares order
        claim(b, uiPath, null);
      }
    }
    const filler = ENVELOPE_REF.components - ENVELOPE_REF.contested * 2;
    for (let k = 0; k < filler; k += 1) {
      claim(k % ENVELOPE_REF.mods, `UI/Solo${String(k).padStart(4, '0')}.lua`, null);
    }
    w.exec('COMMIT');
  } catch (e) {
    try { w.exec('ROLLBACK'); } catch (_) { /* already failed */ }
    throw e;
  }
  w.close();
}

if (WANT_ENVELOPE) {
  console.log('Test 3: enumeration envelope over the reference-scale corpus (--envelope)');
  console.log(`  reference: ${ENVELOPE_REF.mods} mods / ${ENVELOPE_REF.components} components / ` +
    `${ENVELOPE_REF.contested} contested (${ENVELOPE_REF.decidable} decidable / ` +
    `${ENVELOPE_REF.noDeclaredOrder} no-declared-order / ${ENVELOPE_REF.ties} tie) in ~${ENVELOPE_REF.wallMs}ms`);
  seedEnvelope(ENVELOPE_DB);
  const db = new DatabaseSync(ENVELOPE_DB, { readOnly: true });
  let env;
  try {
    env = shadowing.buildEnvelope(db);
  } finally {
    db.close();
  }
  console.log(`  ${shadowing.formatEnvelope(env)}`);

  check('envelope scans the reference-scale corpus (mods)', env.mods === ENVELOPE_REF.mods, `${env.mods} mods`);
  check('envelope scans the reference-scale corpus (components)', env.components === ENVELOPE_REF.components, `${env.components} components`);
  check('envelope reports the contested count', env.contested === ENVELOPE_REF.contested, `${env.contested} contested`);
  check('envelope reports the decidable count', env.decidable === ENVELOPE_REF.decidable, `${env.decidable} decidable`);
  check('envelope reports undefined-by-reason (no-declared-order)',
    env.noDeclaredOrder === ENVELOPE_REF.noDeclaredOrder, `${env.noDeclaredOrder} no-declared-order`);
  check('envelope reports undefined-by-reason (tie)', env.ties === ENVELOPE_REF.ties, `${env.ties} tie(s)`);
  check('contested splits exactly into decided + undefined-by-reason',
    env.contested === env.decidable + env.noDeclaredOrder + env.ties &&
    env.undefined === env.noDeclaredOrder + env.ties,
    `${env.contested} vs ${env.decidable}+${env.noDeclaredOrder}+${env.ties}`);
  check('enumeration stays interactive (same order as the ~50ms reference)',
    env.wallClockMs < 1000, `${env.wallClockMs}ms`);

  console.log('\nLimitation flags: undefined reasons plus the LuaReplace-only claim path');
  const LIM_DB = path.join(TMP, 'Limits.sqlite');
  {
    const w = new DatabaseSync(LIM_DB);
    w.exec('CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ModId TEXT NOT NULL);'
      + 'CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);'
      + 'CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));'
      + 'CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);'
      + 'CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));');
    const mF = w.prepare('INSERT INTO Mods (ModId) VALUES (?)').run('lim-filer-0001').lastInsertRowid;
    const mR = w.prepare('INSERT INTO Mods (ModId) VALUES (?)').run('lim-replacer-0002').lastInsertRowid;
    addFileAction(w, mF, 'AddUIScript', 'LimShip', ['UI/Lim.lua']);
    addFileAction(w, mR, 'ReplaceUIScript', 'LimReplace', [], { LuaContext: 'Screen', LuaReplace: 'UI/Lim.lua' });
    w.close();
  }
  const ldb = new DatabaseSync(LIM_DB, { readOnly: true });
  let lim;
  try { lim = shadowing.resolveWinners(ldb); } finally { ldb.close(); }
  const limEntry = lim.find((d) => d.path === 'UI/Lim.lua');
  const limSources = limEntry ? limEntry.claimants.map((c) => c.sources.join('+')).sort() : [];
  console.log(`  contested: UI/Lim.lua via ${limSources.join(' + ')}`);
  console.log(`  limitations: ${env.noDeclaredOrder} no-declared-order / ${env.ties} tie undefined;`
    + ' LuaReplace-sourced claims enumerated from ComponentProperties.LuaReplace');
  check('the gate contests exactly the LuaReplace path', lim.length === 1 && !!limEntry, `${lim.length} path(s)`);
  check('claimants span file and LuaReplace sources',
    JSON.stringify(limSources) === JSON.stringify(['LuaReplace', 'file']), JSON.stringify(limSources));
  check('an undeclared LuaReplace contest is undefined with reason no-declared-order',
    !!limEntry && limEntry.status === 'undefined' && limEntry.reason === 'no-declared-order' && limEntry.winner === null);
}

// Pairing + wrong-context warning fixtures. A dedicated database: the mods
// below must not leak contested paths into the Test 1 seed (which asserts an
// exact path list), and Test 1's mods must not leak warnings here.
const MP_A = 'a1a1a1a1-1111-4111-8111-1111111111a1'; // Pair Alpha: wins the .lua half
const MP_B = 'b2b2b2b2-2222-4222-8222-2222222222b2'; // Pair Beta: wins the .xml half
const MC_F = 'c3c3c3c3-3333-4333-8333-3333333333c3'; // gameplay script in a front-end action
const MC_D = 'd4d4d4d4-4444-4444-8444-4444444444d4'; // script file in a data action, data file in a script action
const MC_OK = 'e5e5e5e5-5555-4555-8555-5555555555e5'; // clean in every direction (the negative case)

function seedWarnings(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE Settings(SettingRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, SettingId TEXT, SettingType TEXT NOT NULL);
    CREATE TABLE SettingFiles(SettingRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(SettingRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL, PRIMARY KEY(ModRowId, Tag, Locale));`);

  const ids = {};
  for (const [modId, name] of [[MP_A, 'Pair Alpha'], [MP_B, 'Pair Beta'], [MC_F, 'Ctx Front'],
      [MC_D, 'Ctx Data'], [MC_OK, 'Ctx Clean']]) {
    const tag = `LOC_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NAME`;
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)')
      .run(`C:/mods/${name.replace(/[^A-Za-z]+/g, '_')}.modinfo`).lastInsertRowid;
    const mid = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
      .run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(mid, 'Name', tag);
    w.prepare('INSERT INTO LocalizedText (ModRowId, Tag, Locale, Text) VALUES (?, ?, ?, ?)').run(mid, tag, 'en_US', name);
    ids[modId] = mid;
  }
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  for (const mid of Object.values(ids)) item.run(mid);

  // Split pair: the .lua decides for Alpha (200 > 100), the .xml for Beta
  // (300 > 50). Same-winner pair: Alpha takes both halves (200 > 100 twice).
  // Tie pair: the .lua ties at 300 (undefined) beside a decided .xml.
  // Quiet pair: neither half declares anything (both undefined).
  addFileAction(w, ids[MP_A], 'AddUIScript', 'PairLuaA', ['UI/Pair.lua'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'PairLuaB', ['UI/Pair.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'PairXmlA', ['UI/Pair.xml'], { LoadOrder: '50' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'PairXmlB', ['UI/Pair.xml'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'SameLuaA', ['UI/Same.lua'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'SameLuaB', ['UI/Same.lua'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'SameXmlA', ['UI/Same.xml'], { LoadOrder: '200' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'SameXmlB', ['UI/Same.xml'], { LoadOrder: '100' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'TieLuaA', ['UI/TiePair.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'TieLuaB', ['UI/TiePair.lua'], { LoadOrder: '300' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'TieXmlA', ['UI/TiePair.xml'], { LoadOrder: '50' });
  addFileAction(w, ids[MP_B], 'AddUIScript', 'TieXmlB', ['UI/TiePair.xml'], { LoadOrder: '400' });
  addFileAction(w, ids[MP_A], 'AddUIScript', 'QuietLuaA', ['UI/Quiet.lua']);
  addFileAction(w, ids[MP_B], 'AddUIScript', 'QuietLuaB', ['UI/Quiet.lua']);
  addFileAction(w, ids[MP_A], 'AddUIScript', 'QuietXmlA', ['UI/Quiet.xml']);
  addFileAction(w, ids[MP_B], 'AddUIScript', 'QuietXmlB', ['UI/Quiet.xml']);

  // Wrong context, positive: a gameplay script behind a front-end action (no
  // in-game counterpart, so no contested path carries it - the warning is the
  // only place it surfaces), a .lua inside UpdateDatabase next to a legit
  // .sql (only the .lua warns), and a .sql inside a script action.
  addSettingAction(w, ids[MC_F], 'AddGameplayScripts', 'FrontGame', ['Game/Front.lua']);
  addFileAction(w, ids[MC_D], 'UpdateDatabase', 'MixedData', ['data/ok.sql', 'UI/Stray.lua']);
  addFileAction(w, ids[MC_D], 'AddUIScript', 'ScriptWithSql', ['UI/ScriptWithSql.lua', 'data/stray.sql']);
  // Wrong context, negative: every kind where it belongs. The .xml beside
  // the .lua under a script action is the screen/layout pair mechanism, not a
  // misplaced file, and stays silent.
  addFileAction(w, ids[MC_OK], 'UpdateDatabase', 'GoodData', ['data/good.sql']);
  addFileAction(w, ids[MC_OK], 'AddGameplayScripts', 'GoodGame', ['Game/good.lua']);
  addSettingAction(w, ids[MC_OK], 'UpdateText', 'GoodText', ['Text/good.xml']);
  addFileAction(w, ids[MC_OK], 'AddUIScript', 'GoodUI', ['UI/good.lua', 'UI/good.xml']);

  w.close();
}

if (RUN_WARNINGS) {
  console.log('\nTest 4: Lua/XML split-brain pairing warnings (--warnings)');
  seedWarnings(WARNINGS_DB);
  const db = new DatabaseSync(WARNINGS_DB, { readOnly: true });
  let decided;
  let warnCtx;
  let warnAll;
  try {
    decided = shadowing.resolveWinners(db);
    warnCtx = shadowing.detectWrongContext(db);
    warnAll = shadowing.collectWarnings(db, decided);
  } finally {
    db.close();
  }
  const sb = shadowing.detectSplitBrain(decided);
  for (const warn of sb) {
    console.log(`  split-brain: ${warn.luaPath} <- ${warn.luaWinner.name} vs ${warn.xmlPath} <- ${warn.xmlWinner.name}`);
  }

  check('exactly the one split pair warns',
    sb.length === 1 && sb[0].luaPath === 'UI/Pair.lua' && sb[0].xmlPath === 'UI/Pair.xml',
    JSON.stringify(sb.map((x) => [x.luaPath, x.xmlPath])));
  check('the warning names the split winners with their display names',
    sb.length === 1 && sb[0].luaWinner.modId.toLowerCase() === MP_A.toLowerCase() && sb[0].luaWinner.name === 'Pair Alpha'
    && sb[0].xmlWinner.modId.toLowerCase() === MP_B.toLowerCase() && sb[0].xmlWinner.name === 'Pair Beta',
    JSON.stringify(sb[0] && { lua: sb[0].luaWinner, xml: sb[0].xmlWinner }));
  const sbText = JSON.stringify(sb);
  check('the same-winner pair stays silent', !sbText.includes('Same'), sbText);
  check('the tie-decided pair stays silent (undefined side names no winner)', !sbText.includes('TiePair'), sbText);
  check('the undeclared pair stays silent', !sbText.includes('Quiet'), sbText);

  console.log('\nTest 5: wrong-context placement warnings (--warnings)');
  for (const warn of warnCtx) {
    console.log(`  wrong-context: ${warn.dir} ${warn.actionType} ${warn.actionId || ''} (${warn.scope}) <- ${warn.name}: ${(warn.files || []).join(', ')}`);
  }
  check('exactly the three misplaced files/actions warn', warnCtx.length === 3,
    JSON.stringify(warnCtx.map((x) => [x.dir, x.actionType, x.files])));

  const front = warnCtx.find((x) => x.dir === 'gameplay-in-frontend');
  check('a gameplay script in a front-end action warns with scope and action',
    !!front && front.scope === 'frontend' && front.actionType === 'AddGameplayScripts'
    && front.modId.toLowerCase() === MC_F.toLowerCase() && front.name === 'Ctx Front',
    JSON.stringify(front));
  const inData = warnCtx.find((x) => x.dir === 'script-in-data-action');
  check('a .lua inside a database action warns naming only the script file',
    !!inData && inData.scope === 'ingame' && inData.actionType === 'UpdateDatabase'
    && JSON.stringify(inData.files) === JSON.stringify(['UI/Stray.lua']),
    JSON.stringify(inData && inData.files));
  const inScript = warnCtx.find((x) => x.dir === 'data-in-script-action');
  check('a .sql inside a script action warns naming the database file',
    !!inScript && inScript.actionType === 'AddUIScript'
    && JSON.stringify(inScript.files) === JSON.stringify(['data/stray.sql']),
    JSON.stringify(inScript && inScript.files));
  check('the clean mod warns nowhere',
    !warnCtx.some((x) => x.modId.toLowerCase() === MC_OK.toLowerCase()),
    JSON.stringify(warnCtx.map((x) => x.name)));

  check('collectWarnings joins both layers, split-brain first',
    warnAll.length === sb.length + warnCtx.length
    && warnAll[0].kind === 'split-brain' && warnAll.slice(1).every((x) => x.kind === 'wrong-context'),
    JSON.stringify(warnAll.map((x) => x.kind)));
  const dbw = new DatabaseSync(WARNINGS_DB, { readOnly: true });
  let envW;
  try {
    envW = shadowing.buildEnvelope(dbw);
  } finally {
    dbw.close();
  }
  check('the envelope carries the warnings', envW.warnings.length === warnAll.length,
    `${envW.warnings.length} warning(s)`);
  check('a nonzero warning count appends to the envelope line',
    /pairing\/placement warning/.test(shadowing.formatEnvelope(envW)), shadowing.formatEnvelope(envW));

  console.log('\nZero-warning pin: the Test 1 corpus warns nowhere and keeps its envelope line');
  // The Test 1 corpus only exists when the contested block seeded it; a
  // --warnings-only run skips this pin rather than reading a missing file.
  if (WANT_CONTESTED) {
    const dbz = new DatabaseSync(DB_PATH, { readOnly: true });
    let envZ;
    try {
      envZ = shadowing.buildEnvelope(dbz);
    } finally {
      dbz.close();
    }
    check('no warnings on the contested-only corpus', envZ.warnings.length === 0,
      JSON.stringify(envZ.warnings));
    check('a zero warning count leaves the envelope line byte-identical',
      !/warning/.test(shadowing.formatEnvelope(envZ)), shadowing.formatEnvelope(envZ));
  }
}

// Base/DLC warning silence (doctrine: a warning fires only when a real mod
// is involved). A dedicated database so the exact-count pins above never
// move: the DLC-vs-DLC split pair stays silent, the mod-vs-DLC split pair
// fires, and a misplaced file on a DLC mod stays silent beside a firing
// real-mod control. Winner math is unchanged throughout: DLC claimants are
// still listed and still win.
const WARNINGS_DLC_DB = path.join(TMP, 'WarningsDlc.sqlite');
const MD_A = 'd1d1d1d1-aaaa-4aaa-8aaa-aaaaaaaaaa01'; // DLC claimant (relative ../../../DLC path)
const MD_B = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbb02'; // base-game claimant (relative ../../../Base path)
const MR_R = 'c3c3c3c3-cccc-4ccc-8ccc-cccccccccc03'; // real mod (absolute .modinfo path)

function seedWarningsDlc(file) {
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY, Path TEXT UNIQUE, LastWriteTime INTEGER NOT NULL);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY, ScannedFileRowId INTEGER NOT NULL, ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY, Name TEXT NOT NULL, CanDelete BOOLEAN, Selected BOOLEAN, SortIndex INTEGER);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL, Disabled BOOLEAN NOT NULL, PRIMARY KEY(ModGroupRowId, ModRowId));`);

  const addMod = (modId, scannedPath) => w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)')
    .run(w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, 1)').run(scannedPath).lastInsertRowid, modId).lastInsertRowid;
  const dlcA = addMod(MD_A, '../../../DLC/Expansion1/Expansion1.modinfo');
  const baseB = addMod(MD_B, '../../../Base/Game/BaseGame.modinfo');
  const realR = addMod(MR_R, 'C:/mods/RealMod.modinfo');
  w.prepare('INSERT INTO ModGroups (ModGroupRowId, Name, CanDelete, Selected, SortIndex) VALUES (1, ?, 0, 1, 0)').run('Main');
  const item = w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, ?, 0)');
  item.run(dlcA); item.run(baseB); item.run(realR);

  // DLC-vs-DLC split: .lua decides for DLC Alpha (200 > 100), .xml for Base
  // Beta (300 > 50). Mod-vs-DLC split: .lua for the real mod (200 > 100),
  // .xml for DLC Alpha (300 > 50).
  addFileAction(w, dlcA, 'AddUIScript', 'DlcLuaA', ['UI/DlcPair.lua'], { LoadOrder: '200' });
  addFileAction(w, baseB, 'AddUIScript', 'DlcLuaB', ['UI/DlcPair.lua'], { LoadOrder: '100' });
  addFileAction(w, dlcA, 'AddUIScript', 'DlcXmlA', ['UI/DlcPair.xml'], { LoadOrder: '50' });
  addFileAction(w, baseB, 'AddUIScript', 'DlcXmlB', ['UI/DlcPair.xml'], { LoadOrder: '300' });
  addFileAction(w, realR, 'AddUIScript', 'MixLuaR', ['UI/MixedPair.lua'], { LoadOrder: '200' });
  addFileAction(w, dlcA, 'AddUIScript', 'MixLuaA', ['UI/MixedPair.lua'], { LoadOrder: '100' });
  addFileAction(w, realR, 'AddUIScript', 'MixXmlR', ['UI/MixedPair.xml'], { LoadOrder: '50' });
  addFileAction(w, dlcA, 'AddUIScript', 'MixXmlA', ['UI/MixedPair.xml'], { LoadOrder: '300' });
  // Wrong context: a .lua in a database action on the base-game mod (silent)
  // beside the same misplacement on the real mod (fires).
  addFileAction(w, baseB, 'UpdateDatabase', 'DlcData', ['data/dlc.sql', 'UI/DlcStray.lua']);
  addFileAction(w, realR, 'UpdateDatabase', 'RealData', ['data/real.sql', 'UI/RealStray.lua']);

  w.close();
}

if (RUN_WARNINGS) {
  console.log('\nTest 6: base/DLC warning silence (DLC-vs-DLC quiet, mod-vs-DLC fires) (--warnings)');
  seedWarningsDlc(WARNINGS_DLC_DB);
  const dd = new DatabaseSync(WARNINGS_DLC_DB, { readOnly: true });
  let decided;
  let sbBare;
  let sb;
  let warnCtx;
  let warnAll;
  try {
    decided = shadowing.resolveWinners(dd);
    sbBare = shadowing.detectSplitBrain(decided);
    sb = shadowing.detectSplitBrain(decided, dd);
    warnCtx = shadowing.detectWrongContext(dd);
    warnAll = shadowing.collectWarnings(dd, decided);
  } finally {
    dd.close();
  }
  for (const d of decided) {
    console.log(`  decided: ${d.path} <- ${d.status === 'decided' ? `winner ${d.winner.modId.slice(0, 8)} @${d.winner.value}` : d.reason}`);
  }
  for (const warn of sb) {
    console.log(`  split-brain: ${warn.luaPath} <- ${warn.luaWinner.modId.slice(0, 8)} vs ${warn.xmlPath} <- ${warn.xmlWinner.modId.slice(0, 8)}`);
  }
  for (const warn of warnCtx) {
    console.log(`  wrong-context: ${warn.dir} ${warn.actionType} <- ${warn.modId.slice(0, 8)}: ${(warn.files || []).join(', ')}`);
  }

  const byPath = new Map(decided.map((d) => [d.path, d]));
  check('all four DLC-corpus paths stay contested and decided (winner math unchanged)',
    decided.length === 4 && decided.every((d) => d.status === 'decided'),
    JSON.stringify(decided.map((d) => [d.path, d.status])));
  const dlcLua = byPath.get('UI/DlcPair.lua');
  const dlcXml = byPath.get('UI/DlcPair.xml');
  check('the DLC-vs-DLC halves still decide for their DLC/base winners',
    !!dlcLua && dlcLua.winner.modId.toLowerCase() === MD_A.toLowerCase() && dlcLua.winner.value === 200
    && !!dlcXml && dlcXml.winner.modId.toLowerCase() === MD_B.toLowerCase() && dlcXml.winner.value === 300,
    JSON.stringify({ lua: dlcLua && dlcLua.winner, xml: dlcXml && dlcXml.winner }));
  const mixLua = byPath.get('UI/MixedPair.lua');
  const mixXml = byPath.get('UI/MixedPair.xml');
  check('the mod-vs-DLC halves still decide across the real/DLC line',
    !!mixLua && mixLua.winner.modId.toLowerCase() === MR_R.toLowerCase() && mixLua.winner.value === 200
    && !!mixXml && mixXml.winner.modId.toLowerCase() === MD_A.toLowerCase() && mixXml.winner.value === 300,
    JSON.stringify({ lua: mixLua && mixLua.winner, xml: mixXml && mixXml.winner }));
  check('without the database the filter is off and both split pairs warn',
    sbBare.length === 2, JSON.stringify(sbBare.map((x) => [x.luaPath, x.xmlPath])));
  check('with the database only the mod-vs-DLC pair warns',
    sb.length === 1 && sb[0].luaPath === 'UI/MixedPair.lua' && sb[0].xmlPath === 'UI/MixedPair.xml',
    JSON.stringify(sb.map((x) => [x.luaPath, x.xmlPath])));
  check('the firing pair names the real .lua winner beside the DLC .xml winner',
    sb.length === 1 && sb[0].luaWinner.modId.toLowerCase() === MR_R.toLowerCase()
    && sb[0].xmlWinner.modId.toLowerCase() === MD_A.toLowerCase(),
    JSON.stringify(sb[0] && { lua: sb[0].luaWinner, xml: sb[0].xmlWinner }));
  check('exactly the real-mod misplacement warns (the DLC stray stays silent)',
    warnCtx.length === 1 && warnCtx[0].dir === 'script-in-data-action'
    && warnCtx[0].modId.toLowerCase() === MR_R.toLowerCase()
    && JSON.stringify(warnCtx[0].files) === JSON.stringify(['UI/RealStray.lua']),
    JSON.stringify(warnCtx.map((x) => [x.dir, x.modId, x.files])));
  check('collectWarnings joins the firing layers, split-brain first',
    warnAll.length === 2 && warnAll[0].kind === 'split-brain' && warnAll[1].kind === 'wrong-context',
    JSON.stringify(warnAll.map((x) => x.kind)));
  const dde = new DatabaseSync(WARNINGS_DLC_DB, { readOnly: true });
  let envD;
  try {
    envD = shadowing.buildEnvelope(dde);
  } finally {
    dde.close();
  }
  check('the envelope carries the two firing warnings', envD.warnings.length === 2,
    `${envD.warnings.length} warning(s)`);
}

// A real database, if one is offered: read-only enumeration, never written.
const real = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && a !== process.argv[1]);
if (real && fs.existsSync(real)) {
  console.log(`\nReal database (read-only): ${real}`);
  const rd = new DatabaseSync(real, { readOnly: true });
  try {
    const t0 = Date.now();
    const contested = shadowing.enumerateContested(rd);
    console.log(`  contested paths: ${contested.length} in ${Date.now() - t0}ms`);
    printReport(contested.slice(0, 20));
    if (contested.length > 20) console.log(`  ... and ${contested.length - 20} more`);
  } finally {
    rd.close();
  }
} else if (real) {
  console.log(`\nReal database path not found, skipped: ${real}`);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {
  // Best effort: a locked handle on Windows reports here rather than silently.
  console.log(`  note: scratch dir not removed: ${TMP}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(pass ? 'SHADOWING: ALL CHECKS PASSED' : 'SHADOWING: FAILURES PRESENT');
console.log('='.repeat(60));
process.exit(pass ? 0 : 1);
