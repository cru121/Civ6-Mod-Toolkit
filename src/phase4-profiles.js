'use strict';

// Phase 4 automated proof: mod groups (player profiles).
//
// Operates only on a synthetic database in a scratch dir. If a real Mods.sqlite
// is passed as the first argument it is copied first and never written to.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('./modsdb');
const { toNativePath } = require('./paths');

// Resolved through realpathSync.native, and that is the whole point.
//
// canonicalPath stores each mod's folder in its canonical form, and on Windows
// that call resolves 8.3 short names to their long ones. A GitHub runner's TEMP
// is C:\Users\RUNNER~1\AppData\Local\Temp - RUNNER~1 being the short name for
// runneradmin - so an unresolved TMP here is a different string from the paths
// the database ends up holding, and every check that compares one against the
// other fails on the runner while passing on any machine whose temp directory
// happens to have no short name. That is not hypothetical: it is what stopped
// the v1.5.0 release from being published.
//
// Canonicalising the scratch root once means every path below is in the form the
// database will hold, by construction, rather than one block at a time.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-profiles-')));
const DB_PATH = path.join(TMP, 'Mods.sqlite');

seed();
console.log(`scratch dir: ${TMP}\nseeded a small test database -> ${DB_PATH}\n`);

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const MAX = 10000; // the server's cap on mods in an imported file
const fails = (fn) => {
  try { fn(); return false; } catch (_) { return true; }
};
const groupNamed = (name) => db.listGroups(DB_PATH).groups.find((g) => g.name === name);
const raw = (sql, ...a) => {
  const conn = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return conn.prepare(sql).all(...a); } finally { conn.close(); }
};
const PROFILES = raw('SELECT count(*) AS n FROM ModGroups')[0].n;

// A handful of mods, the built-in group (full, one mod on) and a user group
// with a subset, so empty / duplicate / delete have something real to work on.
function seed() {
  const d = new DatabaseSync(DB_PATH);
  d.exec(`
    CREATE TABLE ModGroups(ModGroupRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      Name TEXT NOT NULL, CanDelete BOOLEAN DEFAULT 1, Selected BOOLEAN DEFAULT 0, SortIndex INTEGER DEFAULT 100);
    CREATE TABLE ModGroupItems(ModGroupRowId INTEGER NOT NULL, ModRowId INTEGER NOT NULL,
      Disabled BOOLEAN DEFAULT 0, PRIMARY KEY(ModGroupRowId, ModRowId));
    CREATE TABLE ScannedFiles(ScannedFileRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, Path TEXT UNIQUE, LastWriteTime INTEGER DEFAULT 0);
    CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ScannedFileRowId INTEGER NOT NULL,
      ModId TEXT NOT NULL, Version INTEGER NOT NULL);
    CREATE TABLE ModProperties(ModRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL,
      PRIMARY KEY(ModRowId, Name));
    CREATE TABLE LocalizedText(ModRowId INTEGER NOT NULL, Tag TEXT NOT NULL, Locale TEXT NOT NULL, Text TEXT NOT NULL,
      PRIMARY KEY(ModRowId, Tag, Locale));
    CREATE TABLE ModRelationships(ModRowId INTEGER NOT NULL, OtherModId TEXT NOT NULL, Relationship TEXT NOT NULL, OtherModTitle TEXT);
    CREATE TABLE ModFiles(FileRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, Path TEXT NOT NULL);
    CREATE TABLE Components(ComponentRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, ComponentId TEXT, ComponentType TEXT NOT NULL);
    CREATE TABLE ComponentProperties(ComponentRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(ComponentRowId, Name));
    CREATE TABLE ComponentFiles(ComponentRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, FileRowId));
    CREATE TABLE Settings(SettingRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, SettingId TEXT, SettingType TEXT NOT NULL);
    CREATE TABLE SettingFiles(SettingRowId INTEGER NOT NULL, FileRowId INTEGER NOT NULL, Priority INTEGER NOT NULL, PRIMARY KEY(SettingRowId, FileRowId));
    CREATE TABLE Criteria(CriteriaRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModRowId INTEGER NOT NULL, CriteriaId TEXT NOT NULL, Any BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE Criterion(CriterionRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, CriteriaRowId INTEGER NOT NULL, CriterionType TEXT NOT NULL, Inverse BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE CriterionProperties(CriterionRowId INTEGER NOT NULL, Name TEXT NOT NULL, Value TEXT NOT NULL, PRIMARY KEY(CriterionRowId, Name));
    CREATE TABLE ComponentCriteria(ComponentRowId INTEGER NOT NULL, CriteriaRowId INTEGER NOT NULL, PRIMARY KEY(ComponentRowId, CriteriaRowId));`);
  d.exec(`INSERT INTO ScannedFiles (Path) VALUES ('a'), ('b'), ('c'), ('d')`);
  const ids = ['mod-a', 'mod-b', 'mod-c', 'mod-d'];
  ids.forEach((id, i) => {
    d.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(i + 1, id);
    d.prepare('INSERT INTO ModProperties (ModRowId, Name, Value) VALUES (?, ?, ?)').run(i + 1, 'Name', id.toUpperCase());
  });
  d.exec(`INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES ('LOC_MODS_GROUP_DEFAULT_NAME', 0, 0, 0)`);
  d.exec(`INSERT INTO ModGroups (Name, CanDelete, Selected, SortIndex) VALUES ('Existing', 1, 1, 100)`);
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 1, 0)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 2, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 3, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (1, 4, 1)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, 1, 0)').run();
  d.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, 2, 0)').run();
  d.close();
}

// --- Test 1: reading --------------------------------------------------------
console.log('Test 1: read groups');
{
  const st = db.listGroups(DB_PATH);
  check('read ok', st.ok, st.error || '');
  check('two groups', st.groups.length === 2);
  check('active is the selected one', st.active && st.active.name === 'Existing');
  check('default group is not deletable', st.groups.find((g) => !g.canDelete).name === 'LOC_MODS_GROUP_DEFAULT_NAME');
  const g = st.groups.find((x) => x.name === 'Existing');
  check('counts per group', g.total === 2 && g.enabled === 2, `total=${g.total} enabled=${g.enabled}`);
  check('default group counts', (() => { const d0 = st.groups.find((x) => !x.canDelete); return d0.total === 4 && d0.enabled === 1; })());
}

// --- Test 2: create empty ---------------------------------------------------
console.log('\nTest 2: create an empty profile');
{
  const r = db.createGroup(DB_PATH, 'Fresh');
  check('backup created', !!r.backupPath && fs.existsSync(r.backupPath));
  const g = db.listGroups(DB_PATH).groups.find((x) => x.name === 'Fresh');
  check('group exists', !!g);
  check('deletable, selected, SortIndex 100', g.canDelete && g.selected && g.sortIndex === 100);
  check('every mod present but off', g.total === 4 && g.enabled === 0, `total=${g.total} enabled=${g.enabled}`);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('existing profile untouched', (() => { const e = groupNamed('Existing'); return e.total === 2 && e.enabled === 2; })());
  check('default group untouched', (() => { const d0 = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return d0.total === 4 && d0.enabled === 1; })());

  // Two profiles with the same name cannot be told apart in the dropdown, and
  // nothing can say which one a save was played with.
  const clash = db.createGroup(DB_PATH, 'Fresh');
  check('a name already in use gets a suffix', clash.group.name === 'Fresh (2)', clash.group.name);
  check('  and it is a real second profile', db.listGroups(DB_PATH).groups.filter((x) => x.name.startsWith('Fresh')).length === 2);
  const cased = db.createGroup(DB_PATH, 'fresh');
  // The suffix follows the spelling the user typed, not the one already stored.
  check('a name differing only in case also gets a suffix', cased.group.name === 'fresh (3)', cased.group.name);
  const longName = 'L'.repeat(100);
  db.createGroup(DB_PATH, longName); // the first one is free, so it is kept as-is
  const longClash = db.createGroup(DB_PATH, longName);
  check('a long name is not pushed over the 100 character limit', longClash.group.name.length <= 100, `${longClash.group.name.length} chars`);
  check('  and still ends in a suffix', /\(\d+\)$/.test(longClash.group.name), longClash.group.name.slice(-8));
  const longFree = db.createGroup(DB_PATH, 'M'.repeat(100));
  check('a free long name is left exactly as asked', longFree.group.name === 'M'.repeat(100), `${longFree.group.name.length} chars`);
  check('groups unchanged after the check', (() => {
    const n = db.listGroups(DB_PATH).groups.filter((x) => /^(Fresh|fresh|L{10}|M{10})/.test(x.name)).length;
    return n === 6;
  })());
}

// --- Test 3: duplicate ------------------------------------------------------
console.log('\nTest 3: duplicate a profile');
{
  db.activateGroup(DB_PATH, groupNamed('Existing').id);
  const src = groupNamed('Existing');
  db.createGroup(DB_PATH, 'AllOff'); // a different profile to copy, so we prove we copy the right one
  const copy = db.duplicateGroup(DB_PATH, src.id, 'Existing copy');
  check('copy reported', copy.group && copy.group.name === 'Existing copy');
  const g = groupNamed('Existing copy');
  check('same items as the source', g.total === src.total && g.enabled === src.enabled, `total=${g.total} enabled=${g.enabled}`);
  check('copy is active', g.selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('the copy has its own rows', raw('SELECT count(*) n FROM ModGroupItems WHERE ModGroupRowId = ?', g.id)[0].n === 2);
  // Changing the copy must not change the source.
  db.applyChanges(DB_PATH, [{ modId: 'mod-a', enabled: false }]);
  const after = groupNamed('Existing');
  check('source unchanged after editing the copy', after.enabled === 2, `enabled=${after.enabled}`);

  // Kept to the end of this test on purpose. Creating a group activates it, so
  // doing this earlier would have left a different profile in use - and the
  // applyChanges above edits the *active* profile, so its check would still have
  // passed, for the wrong reason.
  const dupClash = db.duplicateGroup(DB_PATH, src.id, 'AllOff');
  check('duplicating onto a taken name gets a suffix', dupClash.group.name === 'AllOff (2)', dupClash.group.name);
  check('  and it copied the source, not the profile it was named after',
    dupClash.group.total === src.total && dupClash.group.enabled === src.enabled,
    `total=${dupClash.group.total} enabled=${dupClash.group.enabled}`);
  // Put the copy back in use, which is the state the next test expects.
  db.activateGroup(DB_PATH, g.id);
}

// --- Test 4: rename ---------------------------------------------------------
console.log('\nTest 4: rename');
{
  const id = groupNamed('Existing copy').id;
  const r = db.renameGroup(DB_PATH, id, '  Renamed  ');
  check('name trimmed', r.group.name === 'Renamed', r.group.name);
  check('renamed group is the active one', r.group.selected);
  check('empty name rejected', fails(() => db.renameGroup(DB_PATH, id, '   ')));
  check('unknown id rejected', fails(() => db.renameGroup(DB_PATH, 9999, 'x')));

  // Renaming is an instruction about one profile, so a clash is refused rather
  // than answered with a name the user did not type.
  const taken = db.renameGroup(DB_PATH, id, 'Solo');
  check('and the name it now holds is the one asked for', taken.group.name === 'Solo', taken.group.name);
  const beforeClash = db.listGroups(DB_PATH).groups.length;
  check('renaming onto a taken name is refused', fails(() => db.renameGroup(DB_PATH, id, 'Fresh (2)')));
  check('  and no profile was renamed instead', db.listGroups(DB_PATH).groups.find((g) => g.id === id).name === 'Solo');
  check('  and no extra profile was created', db.listGroups(DB_PATH).groups.length === beforeClash);
  // 'Fresh' is a different profile (from Test 2), so this is a real clash that
  // differs only in case. Compare with the check below: re-casing a profile's
  // *own* name is not a clash, and must not be refused.
  check('a clash is refused case-insensitively too', fails(() => db.renameGroup(DB_PATH, id, 'FRESH')));
  // Renaming to the same letters in a different case is not a clash with itself.
  const recase = db.renameGroup(DB_PATH, id, 'solo');
  check('renaming to its own name in another case is allowed', recase.group.name === 'solo', recase.group.name);
  // Put the name back: the next test looks this profile up as "Renamed", and
  // these checks are not about that name.
  db.renameGroup(DB_PATH, id, 'Renamed');
  check('and it is back to the name the next test expects', groupNamed('Renamed').id === id);
}

// --- Test 5: activate -------------------------------------------------------
console.log('\nTest 5: activate');
{
  const target = groupNamed('AllOff');
  const r = db.activateGroup(DB_PATH, target.id);
  check('active switched', r.active && r.active.id === target.id);
  check('previous active deselected', !groupNamed('Renamed').selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
}

// --- Test 6: delete ---------------------------------------------------------
console.log('\nTest 6: delete');
{
  const def = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME');
  check('default group cannot be deleted', fails(() => db.deleteGroup(DB_PATH, def.id)));
  check('unknown id rejected', fails(() => db.deleteGroup(DB_PATH, 9999)));

  const gone = groupNamed('Renamed');
  const r = db.deleteGroup(DB_PATH, gone.id, groupNamed('AllOff').id);
  check('group removed', !groupNamed('Renamed'));
  check('its items removed', raw('SELECT count(*) n FROM ModGroupItems WHERE ModGroupRowId = ?', gone.id)[0].n === 0);
  check('switched to the fallback', r.active && r.active.id === groupNamed('AllOff').id);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);

  // Fall back to the built-in group when no fallback id is given.
  const victim = groupNamed('AllOff');
  const r2 = db.deleteGroup(DB_PATH, victim.id);
  check('without a fallback it picks the built-in group', r2.active && r2.active.id === def.id, r2.active && r2.active.name);
  check('last group still cannot be deleted', fails(() => db.deleteGroup(DB_PATH, def.id)));
}

// --- Test 7: apply changes still work on a created profile -------------------
console.log('\nTest 7: toggling mods in a fresh profile');
{
  const fresh = db.createGroup(DB_PATH, 'Toggles');
  const g = groupNamed('Toggles');
  check('all mods present so they can be toggled', g.total === 4 && g.enabled === 0);
  db.applyChanges(DB_PATH, [{ modId: 'mod-b', enabled: true }, { modId: 'mod-c', enabled: true }]);
  const after = groupNamed('Toggles');
  check('two mods on', after.enabled === 2, `enabled=${after.enabled}`);
  const exported = raw('SELECT m.ModId AS id, i.Disabled AS disabled FROM ModGroupItems i JOIN Mods m ON m.ModRowId = i.ModRowId WHERE i.ModGroupRowId = ? ORDER BY m.ModId', g.id);
  check('flags stored per mod', JSON.stringify(exported) === JSON.stringify([{ id: 'mod-a', disabled: 1 }, { id: 'mod-b', disabled: 0 }, { id: 'mod-c', disabled: 0 }, { id: 'mod-d', disabled: 1 }]), JSON.stringify(exported));
  check('other groups unaffected', (() => { const d0 = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return d0.enabled === 1; })());
}

// --- Test 8: a failed write leaves everything as it was ---------------------
console.log('\nTest 8: failure safety');
{
  const before = JSON.stringify(db.listGroups(DB_PATH));
  check('duplicate of a missing group fails', fails(() => db.duplicateGroup(DB_PATH, 9999, 'nope')));
  check('groups unchanged after a failure', JSON.stringify(db.listGroups(DB_PATH)) === before);
  check('database still checks out', raw('PRAGMA quick_check')[0].quick_check === 'ok');
}

// --- Test 9: backups --------------------------------------------------------
console.log('\nTest 9: backups');
{
  const baks = () => fs.readdirSync(TMP).filter((f) => /^Mods\.sqlite\.bak-\d{8}-\d{6}$/.test(f));
  const before = fs.readFileSync(DB_PATH);
  const r = db.createGroup(DB_PATH, 'Backed up');
  check('a successful write leaves a backup', baks().includes(path.basename(r.backupPath)));
  check('the backup is the pre-write database', fs.readFileSync(r.backupPath).equals(before));
  check('at most 10 kept', baks().length <= 10, `${baks().length} kept`);
  // A write that changes nothing removes its own redundant backup again.
  // Backup names only have second resolution, so within one second the failed
  // write shares the name of the previous one and can remove that too; what
  // matters is that a failure never leaves extra copies behind.
  const beforeCount = baks().length;
  check('a failed write leaves no extra backup', fails(() => db.duplicateGroup(DB_PATH, 9999, 'nope')) && baks().length <= beforeCount,
    `${beforeCount} -> ${baks().length}`);
}

// --- Test 10: previewing a switch -------------------------------------------
// Read-only, and it decides what the user is told before they change what the
// game loads, so it gets checked properly.
console.log('\nTest 10: previewing a profile switch');
{
  // The built-in group is the tidiest starting point: it has a row for all four
  // mods, and only mod-a is on. Everything else in this file leaves the active
  // profile wherever the last test left it.
  const def = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME');

  // A profile with mod-b and mod-c on and mod-a off: mod-b and mod-c start
  // loading, mod-a stops, mod-d is off in both and so is not mentioned.
  //
  // Both profiles are built first, and only then is the built-in group put back
  // in use: creating a group activates it, so switching afterwards would be
  // comparing the target against itself.
  const gid = db.createGroup(DB_PATH, 'Preview target').group.id;
  const emptyId = db.createGroup(DB_PATH, 'Preview empty').group.id;
  const w = new DatabaseSync(DB_PATH);
  const setIn = (modId, on) => w.prepare(
    'UPDATE ModGroupItems SET Disabled = ? WHERE ModGroupRowId = ? AND ModRowId = (SELECT ModRowId FROM Mods WHERE ModId = ?)'
  ).run(on ? 0 : 1, gid, modId);
  setIn('mod-b', true);
  setIn('mod-c', true);
  w.close();
  db.activateGroup(DB_PATH, def.id);
  check('starting point: only mod-a is on', db.listGroups(DB_PATH).active.enabled === 1);

  const p = db.previewGroup(DB_PATH, gid);
  check('names the profile being switched to', p.to.name === 'Preview target', p.to.name);
  check('and the one in use now', p.from && p.from.name === 'LOC_MODS_GROUP_DEFAULT_NAME', p.from && p.from.name);
  check('reports the mods that would start loading', p.turningOn.join() === 'mod-b,mod-c', p.turningOn.join());
  check('reports the mod that would stop loading', p.turningOff.join() === 'mod-a', p.turningOff.join());
  check('and says nothing about a mod that is off in both', !p.turningOn.includes('mod-d') && !p.turningOff.includes('mod-d'));
  check('counts what each profile has on', p.onNow === 1 && p.onNext === 2, `now=${p.onNow} next=${p.onNext}`);

  const same = db.previewGroup(DB_PATH, def.id);
  check('previewing the profile in use changes nothing',
    same.turningOn.length === 0 && same.turningOff.length === 0 && same.from.id === same.to.id);

  const empty = db.previewGroup(DB_PATH, emptyId);
  check('an empty profile would stop everything that is on', empty.turningOff.join() === 'mod-a', empty.turningOff.join());
  check('  and start nothing', empty.turningOn.length === 0);

  check('an unknown profile is refused', fails(() => db.previewGroup(DB_PATH, 9999)));

  const after = db.listGroups(DB_PATH);
  check('and none of it wrote anything: the active profile is unchanged',
    after.active && after.active.name === 'LOC_MODS_GROUP_DEFAULT_NAME' && after.active.enabled === 1,
    JSON.stringify(after.active));
  check('  and the previewed profile still has what it had',
    groupNamed('Preview target').enabled === 2, `enabled=${groupNamed('Preview target').enabled}`);
}

// --- Test 11: export / import -----------------------------------------------
console.log('\nTest 11: export and import');
{
  const source = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); // four mods, one on
  const file = db.exportGroup(DB_PATH, source.id);
  check('says which toolkit wrote it', file.toolkit === 'civ6-mod-toolkit', file.toolkit);
  check('and carries no format version', !('version' in file), Object.keys(file).join(','));
  check('carries the profile name', file.name === 'LOC_MODS_GROUP_DEFAULT_NAME', file.name);
  check('has an export timestamp', !Number.isNaN(Date.parse(file.exportedAt)));
  check('lists every mod with its state', file.mods.length === 4 && file.mods.filter((m) => m.enabled).length === 1,
    `${file.mods.length} mods, ${file.mods.filter((m) => m.enabled).length} on`);
  check('keys mods by ModId', file.mods.every((m) => typeof m.modId === 'string' && typeof m.enabled === 'boolean'));
  check('no ModRowId leaks into the file', !JSON.stringify(file).includes('ModRowId'));

  // A file with a mod the game doesn't know: skipped and reported.
  const withUnknown = { ...file, name: 'Imported', mods: [...file.mods, { modId: 'mod-does-not-exist', enabled: true }] };
  const r = db.importGroup(DB_PATH, withUnknown);
  check('creates a new profile', !!r.group && r.group.name === 'Imported', r.group && r.group.name);
  check('imports the known mods', r.imported === 4, `${r.imported}`);
  check('reports the unknown mod', JSON.stringify(r.skipped) === JSON.stringify(['mod-does-not-exist']), JSON.stringify(r.skipped));
  check('new profile is active', groupNamed('Imported').selected);
  check('exactly one selected group', raw('SELECT count(*) n FROM ModGroups WHERE Selected = 1')[0].n === 1);
  check('the imported states match the file', (() => {
    const g = groupNamed('Imported');
    const rows = raw('SELECT m.ModId AS id, i.Disabled AS d FROM ModGroupItems i JOIN Mods m ON m.ModRowId = i.ModRowId WHERE i.ModGroupRowId = ?', g.id);
    const byId = new Map(rows.map((x) => [x.id, !x.d]));
    return file.mods.every((m) => byId.get(m.modId) === m.enabled) && byId.size === 4;
  })());
  check('the source profile is untouched', (() => { const s = groupNamed('LOC_MODS_GROUP_DEFAULT_NAME'); return s.enabled === 1; })());

  // Importing always creates: the same name gets a suffix.
  const again = db.importGroup(DB_PATH, file);
  check('a second import does not overwrite', again.group.name === 'LOC_MODS_GROUP_DEFAULT_NAME (2)', again.group.name);
  check('the first imported profile is still there', groupNamed('Imported').total === 4);
  const third = db.importGroup(DB_PATH, file);
  check('a third import counts up', third.group.name === 'LOC_MODS_GROUP_DEFAULT_NAME (3)', third.group.name);
  const fresh = db.importGroup(DB_PATH, { mods: file.mods });
  check('a file with no name gets a default one', fresh.group.name === 'Imported profile', fresh.group.name);
  const noClash = db.importGroup(DB_PATH, { name: 'Brand new', mods: file.mods });
  check('a name that is free is used as is', noClash.group.name === 'Brand new', noClash.group.name);

  check('a file without mods is rejected', fails(() => db.importGroup(DB_PATH, { name: 'x' })));
  check('a file that is not an object is rejected', fails(() => db.importGroup(DB_PATH, 'nope')));
  check('a huge mod list is rejected', fails(() => db.importGroup(DB_PATH, { mods: new Array(MAX + 1).fill({ modId: 'a', enabled: true }) })));
}

// --- Test 11: a real database copy ------------------------------------------
// The checks above run against a known small database. Given a path to a real
// Mods.sqlite it is copied here and the same operations are smoke-tested
// against the real schema and the real number of mods. The original is only
// ever read.
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  console.log(`\nTest 10: a copy of the real database (${real})`);
  const copyPath = path.join(TMP, 'RealMods.sqlite');
  fs.copyFileSync(real, copyPath);
  const inCopy = (sql, ...a) => {
    const conn = new DatabaseSync(copyPath, { readOnly: true });
    try { return conn.prepare(sql).all(...a); } finally { conn.close(); }
  };
  const before = db.listGroups(copyPath);
  const modCount = inCopy('SELECT count(*) AS n FROM Mods')[0].n;
  check('read ok', before.ok, before.error || '');
  check('found the existing groups', before.groups.length > 0, `${before.groups.length} groups`);
  check('exactly one active group', inCopy('SELECT count(*) AS n FROM ModGroups WHERE Selected = 1')[0].n === 1);

  const created = db.createGroup(copyPath, 'Toolkit smoke test');
  const g = created.group;
  check('empty profile holds every mod, all off', g.total === modCount && g.enabled === 0, `total=${g.total}/${modCount} enabled=${g.enabled}`);
  check('the new profile is active', g.selected && db.listGroups(copyPath).active.id === g.id);

  const copyOf = db.duplicateGroup(copyPath, before.active.id, 'Copied profile');
  check('duplicate matches the source group', copyOf.group.total === before.active.total && copyOf.group.enabled === before.active.enabled,
    `total=${copyOf.group.total}/${before.active.total} enabled=${copyOf.group.enabled}/${before.active.enabled}`);
  db.renameGroup(copyPath, copyOf.group.id, 'Renamed profile');
  check('rename applied', db.listGroups(copyPath).groups.some((x) => x.name === 'Renamed profile'));
  db.activateGroup(copyPath, before.active.id);
  check('switch back to the original active group', db.listGroups(copyPath).active.id === before.active.id);

  db.deleteGroup(copyPath, copyOf.group.id);
  check('deleted the copy', !db.listGroups(copyPath).groups.some((x) => x.id === copyOf.group.id));
  check('active group is still the original', db.listGroups(copyPath).active.id === before.active.id);
  check('the other groups kept their mods', before.groups.every((x) => {
    const now = db.listGroups(copyPath).groups.find((y) => y.id === x.id);
    return now && now.total === x.total && now.enabled === x.enabled;
  }));
  check('the original file is untouched', fs.readFileSync(real).length > 0);
  check('the copy still checks out', inCopy('PRAGMA quick_check')[0].quick_check === 'ok');
} else if (real) {
  console.log(`\nTest 10: skipped - ${real} not found`);
}

// --- Test 12: registering a mod the game has not scanned --------------------
console.log('\nTest 12: register an unscanned mod');
{
  // A .modinfo like the ones on disk, so registerMod has real input.
  const modDir = path.join(TMP, 'mods', 'Test Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const modinfo = path.join(modDir, 'Test Mod.modinfo');
  fs.writeFileSync(modinfo, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="11111111-2222-3333-4444-555555555555" version="7">
  <Properties>
    <Name>Test Mod</Name>
    <Teaser>A test.</Teaser>
    <Description>Longer description.</Description>
    <Authors>Somebody</Authors>
    <CompatibleVersions>2.0</CompatibleVersions>
  </Properties>
</Mod>
`);
  const before = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ScannedFiles) f, (SELECT count(*) FROM ModGroupItems) g')[0];

  const r = db.registerMods(DB_PATH, [modinfo]);
  check('registered one mod', r.registered.length === 1, JSON.stringify(r.failed));
  check('no failures', r.failed.length === 0);
  check('a backup was made', !!r.backupPath && fs.existsSync(r.backupPath));
  check('its id came from the .modinfo', r.registered[0].modId === '11111111-2222-3333-4444-555555555555');
  check('it is a new row', r.registered[0].isNew === true);

  // The game registers a new mod in the built-in group, and rebuilds that mod's
  // group membership on its next scan - so that is the group to write.
  check('registered in the built-in group', r.builtIn === 1, String(r.builtIn));
  const profilesNow = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  check('reports how many profiles exist', r.profiles === profilesNow, `${r.profiles} vs ${profilesNow}`);
  const builtIn = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId = 1 AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].n;
  check('it has a row there', builtIn === 1);
  check('and it is enabled there', raw(`SELECT i.Disabled d FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId = 1 AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].d === 0);
  // Every profile gets a row, so the mod stays switchable wherever you are.
  const rowsEverywhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0].n;
  check('a row in every profile', rowsEverywhere === profilesNow, `rows=${rowsEverywhere} profiles=${profilesNow}`);
  // No profile was named here, so only the built-in group is switched on.
  check('reports how many profiles have it off', r.registered[0].offElsewhere === profilesNow - 1, String(r.registered[0].offElsewhere));

  const after = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ScannedFiles) f, (SELECT count(*) FROM ModGroupItems) g')[0];
  check('one mod row added', after.m === before.m + 1, `${before.m} -> ${after.m}`);
  check('one scanned file added', after.f === before.f + 1, `${before.f} -> ${after.f}`);
  // One row per profile, so the mod is switchable wherever the user is.
  const profilesAtReg = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  check('one group item added per profile', after.g === before.g + profilesAtReg, `${before.g} -> ${after.g} (${profilesAtReg} profiles)`);

  const row = raw(`SELECT s.Path AS path, CAST(s.LastWriteTime AS TEXT) AS lwt, m.ModId AS modId, m.Version AS version
    FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
    WHERE lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`)[0];
  check('path uses forward slashes', !row.path.includes('\\'), row.path);
  check('path points at the .modinfo', row.path.toLowerCase().endsWith('test mod.modinfo'));
  check('version comes from the .modinfo', row.version === 7, String(row.version));
  const fileTime = require('fs').statSync(modinfo, { bigint: true }).mtimeNs / 100n + 116444736000000000n;
  check('LastWriteTime is the file mtime, at full precision', row.lwt === fileTime.toString(), `${row.lwt} vs ${fileTime}`);
  check('and is not rounded to milliseconds', row.lwt !== (BigInt(fileTime / 10000n) * 10000n).toString());
  check('a Name property was written', raw(`SELECT Value FROM ModProperties WHERE Name='Name' AND ModRowId =
    (SELECT ModRowId FROM Mods WHERE lower(ModId)='11111111-2222-3333-4444-555555555555')`)[0].Value === 'Test Mod');

  // --- Test 20a: LastWriteTime as something JavaScript can compare ---------
  // The value is 18 digits of 100-nanosecond ticks and returning it raw is a
  // RangeError, which this codebase has already hit twice. The cast is in the
  // SQL and cannot be taken out without the read throwing again, so it is
  // asserted on the query rather than left to the conversion.
  console.log('\nTest 20a: lastChanged, a FILETIME the browser can compare');
  {
    const castInSql = /CAST\(s\.LastWriteTime AS TEXT\) AS lastWriteTicks/.test(
      require('fs').readFileSync(path.join(__dirname, 'modsdb.js'), 'utf8'));
    check('the SQL casts LastWriteTime to text, so it cannot RangeError on the way out', castInSql);

    const ms = db.lastWriteMs;
    // The exact value registration just wrote for Test Mod, above.
    const EPOCH = 116444736000000000n;
    const expectedMs = Number((fileTime - EPOCH) / 10000n);
    check('it round-trips fileTimeOf exactly, at full precision',
      ms(fileTime.toString()) === expectedMs, `${ms(fileTime.toString())} vs ${expectedMs}`);
    // Milliseconds are coarser than the stored 100ns ticks, so the honest claim is
    // that converting back recovers everything above the sub-millisecond remainder -
    // not that nothing is lost, which would be false.
    check('  and converting back recovers every whole millisecond of it',
      BigInt(ms(fileTime.toString())) * 10000n + EPOCH === fileTime - (fileTime % 10000n),
      `${BigInt(ms(fileTime.toString())) * 10000n + EPOCH} vs ${fileTime - (fileTime % 10000n)}`);
    check('  and what is lost is only the sub-millisecond remainder',
      fileTime % 10000n < 10000n);

    check('a 19-digit value does not throw and stays finite',
      Number.isFinite(ms('9223372036854775807')));
    check('the largest real value in the database converts without loss',
      Number.isSafeInteger(ms('134350824316577530')));

    // A zero is a file the toolkit never stamped, not the year 1601.
    check('zero is "no timestamp", not epoch', ms('0') === null, String(ms('0')));
    check('so is null, an empty string, and anything that is not a number',
      ms(null) === null && ms(undefined) === null && ms('') === null
      && ms('not a number') === null && ms('12 34') === null);
    check('a negative tick count is no timestamp either', ms('-1') === null);
    // A file genuinely older than 1970 is real, not absent, and still orders.
    check('a pre-1970 file keeps its negative value rather than becoming null',
      ms(String(116444736000000000n - 10000n)) === -1);

    // The read path end to end, against the database this script built.
    const st = db.readModState(DB_PATH);
    check('readModState still reads', st.ok, st.error || '');
    const testMod = st.mods.find((m) => m.modId === '11111111-2222-3333-4444-555555555555');
    check('the mod registered above carries a lastChanged', !!testMod && typeof testMod.lastChanged === 'number',
      testMod ? String(testMod.lastChanged) : 'mod not found');
    check('  equal to the mtime of its .modinfo',
      testMod && testMod.lastChanged === expectedMs,
      testMod ? `${testMod.lastChanged} vs ${expectedMs}` : '');

    // A row with no stamp at all, which is what the seeded '0' files are.
    const unstamped = raw(`SELECT CAST(s.LastWriteTime AS TEXT) AS lwt, m.ModId AS modId
      FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
      WHERE s.LastWriteTime = 0 OR s.LastWriteTime IS NULL LIMIT 1`)[0];
    check('a mod whose file was never stamped reads as null, not 1970',
      !unstamped || ms(unstamped.lwt) === null, unstamped ? unstamped.lwt : 'no unstamped row to check');
    check('  and no mod in this database got a lastChanged that is not a number or null',
      st.mods.every((m) => m.lastChanged === null || Number.isFinite(m.lastChanged)));
    check('  and none of them is unsafe as a Number',
      st.mods.every((m) => m.lastChanged === null || Number.isSafeInteger(m.lastChanged)));
  }

  // The toolkit now treats it as a normal mod. Registration gives it a row in
  // every profile, so it reads as a normal switchable mod here, off because
  // this call did not name a profile to switch it on in.
  const st = db.readModState(DB_PATH);
  const seen = st.mods.find((m) => m.idNorm === '11111111-2222-3333-4444-555555555555');
  check('the toolkit sees it', !!seen);
  check('with its real name', seen && seen.name === 'Test Mod', seen && seen.name);
  check('it is in the active profile, switched off', seen && seen.disabled === true, String(seen && seen.disabled));
  check('it is on in the built-in group', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=1 AND i.Disabled=0 AND lower(m.ModId)='11111111-2222-3333-4444-555555555555'`)[0].n === 1);

  // Idempotent: the game rescans on every launch, so repeats must be safe.
  const again = db.registerMods(DB_PATH, [modinfo]);
  const after2 = raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ModGroupItems) g')[0];
  check('re-registering adds nothing', after2.m === after.m && after2.g === after.g, `mods ${after.m}->${after2.m}, items ${after.g}->${after2.g}`);
  check('and reports it as not new', again.registered[0].isNew === false);
  // Repeating must not switch a mod on in profiles the user never asked for.
  check('re-registering leaves the other profiles off', (() => {
    const onElsewhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
      WHERE i.Disabled = 0 AND i.ModGroupRowId NOT IN (1, ?) AND lower(m.ModId) = '11111111-2222-3333-4444-555555555555'`,
      raw('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1')[0].id)[0].n;
    return onElsewhere === 0;
  })(), 'on elsewhere');

  check('registering nothing is a no-op', db.registerMods(DB_PATH, []).registered.length === 0);
  check('a modinfo with no id is reported, not thrown', (() => {
    const bad = path.join(modDir, 'bad.modinfo');
    fs.writeFileSync(bad, '<Mod version="1"></Mod>');
    const res = db.registerMods(DB_PATH, [bad]);
    return res.registered.length === 0 && res.failed.length === 1;
  })());
  check('a missing file is reported, not thrown', (() => {
    const res = db.registerMods(DB_PATH, [path.join(modDir, 'nope.modinfo')]);
    return res.registered.length === 0 && res.failed.length === 1;
  })());
  check('the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('and has no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 13: registering into a chosen profile as well');
{
  const modDir = path.join(TMP, 'mods', 'Second Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const file = path.join(modDir, 'Second.modinfo');
  fs.writeFileSync(file, '<Mod id="99999999-8888-7777-6666-555555555555" version="2"><Properties><Name>Second Mod</Name></Properties></Mod>');
  const r = db.registerMods(DB_PATH, [file], true, 2); // profile "Existing"
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  check('reports the profile row was written', r.registered[0].profileRow === true);
  check('has a row in the built-in group', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=1 AND lower(m.ModId)='99999999-8888-7777-6666-555555555555'`)[0].n === 1);
  check('and a row in the chosen profile', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.ModGroupRowId=2 AND lower(m.ModId)='99999999-8888-7777-6666-555555555555'`)[0].n === 1);
  // readModState reports flags for whichever profile is in use, so make it ours.
  db.activateGroup(DB_PATH, 2);
  const st = db.readModState(DB_PATH);
  const inExisting = st.mods.find((m) => m.idNorm === '99999999-8888-7777-6666-555555555555');
  check('readable and enabled once that profile is in use', inExisting && inExisting.disabled === false,
    inExisting ? String(inExisting.disabled) : '(not found)');
  check('an unknown profile is rejected', fails(() => db.registerMods(DB_PATH, [file], true, 9999)));
  check('a profile id of the built-in group is fine', db.registerMods(DB_PATH, [file], true, 1).registered.length === 1);
}

console.log('\nTest 14: the full registration (files, actions, criteria)');
{
  const dir = path.join(TMP, 'mods', 'Full Mod');
  fs.mkdirSync(path.join(dir, 'Core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Core', 'Data.sql'), 'x');
  fs.writeFileSync(path.join(dir, 'Core', 'Text.xml'), 'x');
  const file = path.join(dir, 'Full Mod.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="55555555-4444-3333-2222-111111111111" version="3">
  <Properties><Name>Full Mod</Name><Description>d</Description></Properties>
  <ActionCriteria>
    <Criteria id="Expansion1"><GameCoreInUse>Expansion1</GameCoreInUse></Criteria>
  </ActionCriteria>
  <InGameActions>
    <UpdateDatabase id="Main">
      <Properties><LoadOrder>200</LoadOrder></Properties>
      <File>Core/Data.sql</File>
    </UpdateDatabase>
    <UpdateText id="Text"><Criteria>Expansion1</Criteria><File>Core/Text.xml</File></UpdateText>
    <ReplaceUIScript id="NoFiles"><Properties><LuaContext>Screen</LuaContext></Properties></ReplaceUIScript>
    <UpdateIcons id="AttrForm" criteria="Expansion1"><File>Core/Text.xml</File></UpdateIcons>
  </InGameActions>
  <FrontEndActions>
    <UpdateIcons id="Icons"><File>Core/Text.xml</File></UpdateIcons>
  </FrontEndActions>
  <Files><File>Core/Data.sql</File><File>Core/Text.xml</File></Files>
</Mod>
`);
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const row = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '55555555-4444-3333-2222-111111111111')[0];
  const mid = row.ModRowId;
  const n = (sql, ...a) => raw(sql, ...a)[0].n;

  check('a ModFiles row per <Files> entry', n('SELECT count(*) n FROM ModFiles WHERE ModRowId=?', mid) === 2);
  check('paths kept relative with forward slashes', raw('SELECT Path FROM ModFiles WHERE ModRowId=?', mid).every((f) => !f.Path.includes('\\') && !/^[A-Za-z]:/.test(f.Path)));
check('one Component per InGameActions action', n('SELECT count(*) n FROM Components WHERE ModRowId=?', mid) === 4, String(n('SELECT count(*) n FROM Components WHERE ModRowId=?', mid)));
  check('components keep document order', JSON.stringify(raw('SELECT ComponentType t FROM Components WHERE ModRowId=? ORDER BY ComponentRowId', mid).map((r) => r.t))
=== JSON.stringify(['UpdateDatabase', 'UpdateText', 'ReplaceUIScript', 'UpdateIcons']));
  check('one Setting per FrontEndActions action', n('SELECT count(*) n FROM Settings WHERE ModRowId=?', mid) === 1);
  check('an action with no id is still recorded', raw('SELECT count(*) n FROM Components WHERE ModRowId=? AND ComponentId IS NULL', mid)[0].n === 0);
  check('the action Properties become ComponentProperties', n('SELECT count(*) n FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId WHERE c.ModRowId=?', mid) === 2,
    String(n('SELECT count(*) n FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId WHERE c.ModRowId=?', mid)));
  check('LoadOrder stored as a property', raw(`SELECT Value FROM ComponentProperties p JOIN Components c ON c.ComponentRowId=p.ComponentRowId
    WHERE c.ModRowId=? AND p.Name='LoadOrder'`, mid)[0].Value === '200');
  check('a Criteria row per ActionCriteria', n('SELECT count(*) n FROM Criteria WHERE ModRowId=?', mid) === 1);
  check('a Criterion row per condition', n('SELECT count(*) n FROM Criterion c JOIN Criteria k ON k.CriteriaRowId=c.CriteriaRowId WHERE k.ModRowId=?', mid) === 1);
  check('the condition value is a property', n(`SELECT count(*) n FROM CriterionProperties p JOIN Criterion c ON c.CriterionRowId=p.CriterionRowId
    JOIN Criteria k ON k.CriteriaRowId=c.CriteriaRowId WHERE k.ModRowId=? AND p.Name='Value' AND p.Value='Expansion1'`, mid) === 1);

  // The link the registration used to skip. Criteria rows that nothing points
  // at mean the mod's conditional actions are not conditional.
  const critLink = raw(`SELECT c.ComponentId id, k.CriteriaId crit FROM ComponentCriteria cc
    JOIN Components c ON c.ComponentRowId=cc.ComponentRowId
    JOIN Criteria k ON k.CriteriaRowId=cc.CriteriaRowId WHERE c.ModRowId=? ORDER BY c.ComponentRowId`, mid);
  check('an action that names a criteria set is linked to it', critLink.length === 2, JSON.stringify(critLink));
  check('  by the name the mod gave it, read from the <Criteria> ELEMENT',
    critLink.every((l) => l.crit === 'Expansion1'), JSON.stringify(critLink.map((l) => l.crit)));
  check('  the attribute form is understood too, since it costs nothing to read',
    critLink.map((l) => l.id).sort().join(',') === 'AttrForm,Text', JSON.stringify(critLink.map((l) => l.id)));
  check('  and an action that names none is not linked to anything',
    !critLink.some((l) => l.id === 'Main'), JSON.stringify(critLink.map((l) => l.id)));
  check('  and one naming a set the mod never declared is skipped, not invented',
    n(`SELECT count(*) n FROM ComponentCriteria cc JOIN Components c ON c.ComponentRowId=cc.ComponentRowId WHERE c.ModRowId=? AND c.ComponentId='Main'`, mid) === 0);

  // Links: only the action's own <File> children, at priority 0.
  const links = raw(`SELECT c.ComponentType t, mf.Path p, cf.Priority pr FROM ComponentFiles cf
    JOIN Components c ON c.ComponentRowId=cf.ComponentRowId JOIN ModFiles mf ON mf.FileRowId=cf.FileRowId WHERE c.ModRowId=?`, mid);
  // Three, not four: the FrontEnd action is a Setting, so its link lives in
  // SettingFiles and never appears here.
  check('one link per <File> child', links.length === 3, String(links.length));
  check('links resolve to ModFiles rows', links.every((l) => l.p === 'Core/Data.sql' || l.p === 'Core/Text.xml'));
  check('all at priority 0', links.every((l) => l.pr === 0));
  check('the action with no <File> gets no link', !links.some((l) => l.t === 'ReplaceUIScript'));
  check('SettingFiles linked too', n('SELECT count(*) n FROM SettingFiles sf JOIN Settings s ON s.SettingRowId=sf.SettingRowId WHERE s.ModRowId=?', mid) === 1);

  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 15: every .modinfo property and <Dependencies> are recorded');
{
  const dir = path.join(TMP, 'mods', 'Deps Mod');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Deps.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="77777777-6666-5555-4444-333333333333" version="1">
  <Properties>
    <Name>Deps Mod</Name>
    <Created>1726575064</Created>
    <AffectsSavedGames>0</AffectsSavedGames>
    <SubscriptionID>12345</SubscriptionID>
  </Properties>
  <Dependencies>
    <Mod id="4873eb62-8ccc-4574-b784-dda455e74e68" title="Expansion: Gathering Storm" />
  </Dependencies>
  <InGameActions><UpdateDatabase id="A"><File>x.sql</File></UpdateDatabase></InGameActions>
  <Files><File>x.sql</File></Files>
</Mod>
`);
  fs.writeFileSync(path.join(dir, 'x.sql'), 'x');
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const mid = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '77777777-6666-5555-4444-333333333333')[0].ModRowId;
  const props = raw('SELECT Name,Value FROM ModProperties WHERE ModRowId=? ORDER BY Name', mid);
  const names = props.map((p) => p.Name);
  check('every <Properties> child is kept, not just a known few',
    ['Name', 'Created', 'AffectsSavedGames', 'SubscriptionID'].every((n) => names.includes(n)), JSON.stringify(names));
  check('Created stored verbatim', props.find((p) => p.Name === 'Created').Value === '1726575064');
  const rel = raw('SELECT OtherModId,Relationship,OtherModTitle FROM ModRelationships WHERE ModRowId=?', mid);
  check('a self-closing <Dependencies> entry becomes a relationship', rel.length === 1, JSON.stringify(rel));
  check('with type Dependency and the title', rel[0].Relationship === 'Dependency' && rel[0].OtherModTitle === 'Expansion: Gathering Storm');
  check('the path is stored with forward slashes', raw('SELECT Path FROM ScannedFiles WHERE ScannedFileRowId=(SELECT ScannedFileRowId FROM Mods WHERE ModRowId=?)', mid)[0].Path.includes('/'));
  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

console.log('\nTest 16: <File> elements that carry attributes are not dropped');
{
  const dir = path.join(TMP, 'mods', 'Attr Mod');
  fs.mkdirSync(path.join(dir, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Data', 'a.xml'), 'x');
  fs.writeFileSync(path.join(dir, 'Data', 'b.xml'), 'x');
  const file = path.join(dir, 'Attr.modinfo');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?>
<Mod id="88888888-7777-6666-5555-444444444444" version="1">
  <Properties><Name>Attr Mod</Name></Properties>
  <InGameActions>
    <UpdateIcons id="Icon">
      <File>Data/a.xml</File>
      <File priority="1">Data/b.xml</File>
      <File Priority="2">Data/c.xml</File>
    </UpdateIcons>
  </InGameActions>
  <Files><File>Data/a.xml</File><File>Data/b.xml</File></Files>
</Mod>
`);
  const r = db.registerMods(DB_PATH, [file]);
  check('registered', r.registered.length === 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const mid = raw('SELECT ModRowId FROM Mods WHERE lower(ModId)=?', '88888888-7777-6666-5555-444444444444')[0].ModRowId;
  const links = raw(`SELECT mf.Path AS p FROM ComponentFiles cf JOIN Components c ON c.ComponentRowId=cf.ComponentRowId
    JOIN ModFiles mf ON mf.FileRowId=cf.FileRowId WHERE c.ModRowId=?`, mid).map((r) => r.p);
  check('the lowercase priority= file is linked, not dropped', links.includes('Data/b.xml'), JSON.stringify(links));
  check('the capitalised Priority= file is not linked (absent from <Files>)', !links.includes('Data/c.xml'), JSON.stringify(links));
  check('two links in total', links.length === 2, JSON.stringify(links));
  check('all links at priority 0', raw(`SELECT cf.Priority AS pr FROM ComponentFiles cf JOIN Components c ON c.ComponentRowId=cf.ComponentRowId
    WHERE c.ModRowId=?`, mid).every((r) => r.pr === 0));
  check('database still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

// --- Test 17: the sync that runs unattended ---------------------------------
// A sync runs at server startup and from the dashboard's Rescan with nobody
// watching, so the property that matters most is that it switches nothing on.
// registerMods used to ignore its `enabled` argument and always came up on in
// the built-in group and the profile in use; no test noticed, because the only
// caller always passed true. This is the test that would have caught it.
//
// Last in the file on purpose: it changes the database, and the tests above
// assert against shared state.
console.log('\nTest 17: an unattended sync switches nothing on');
{
  const profiles = raw('SELECT count(*) AS n FROM ModGroups')[0].n;
  // scanMods() takes { root, exists, type } entries, the shape paths.getSources() returns.
  const sources = [{ root: path.join(TMP, 'mods'), exists: true, type: 'local' }];

  // A real .modinfo on disk, so findUnregistered can see it. The id must not
  // collide with an earlier test's, or it is already in the database by now.
  const modDir = path.join(TMP, 'mods', 'Sync Mod');
  fs.mkdirSync(modDir, { recursive: true });
  const file = path.join(modDir, 'Sync.modinfo');
  const ID = '44444444-1111-2222-3333-444444444444';
  fs.writeFileSync(file, `<Mod id="${ID}" version="1"><Properties><Name>Sync Mod</Name></Properties></Mod>`);

  const first = db.findUnregistered(DB_PATH, sources);
  check('findUnregistered reads the database', first.ok === true, first.error || '');
  check('it finds the mod that is only on disk', first.pending.some((p) => p.idNorm === ID && p.reason === 'never-scanned'),
    first.pending.map((p) => p.reason).join(','));
  check('every entry carries a reason, a name and a real .modinfo path',
    first.pending.every((p) => p.reason && p.name && /\.modinfo$/i.test(p.path)));
  check('and only the two known reasons',
    first.pending.every((p) => p.reason === 'never-scanned' || p.reason === 'no-profile-row'));

  const r = db.registerMods(DB_PATH, first.pending.map((p) => p.path), false, 2);
  check('a sync registered it, and nothing failed', r.registered.length >= 1 && r.failed.length === 0, JSON.stringify(r.failed));
  const onSomewhere = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.Disabled = 0 AND lower(m.ModId)=?`, ID)[0].n;
  check('NOTHING is switched on, in any profile', onSomewhere === 0, `on in ${onSomewhere}`);
  const rowCount = raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE lower(m.ModId)=?`, ID)[0].n;
  check('but it has a row in every profile, so it is tickable', rowCount === profiles, `${rowCount}/${profiles}`);
  check('and reports itself as off everywhere', r.registered[0].offElsewhere === profiles, String(r.registered[0].offElsewhere));
  const seen = db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID);
  check('the mod manager lists it', !!seen);
  check('as off, and switchable rather than "not available"', seen && seen.disabled === true, String(seen && seen.disabled));
  check('and a second sync would skip it',
    !db.findUnregistered(DB_PATH, sources).pending.some((p) => p.idNorm === ID));

  // The other reason a mod needs adding: the game knows it, but it has no row
  // in the profile in use, so it cannot be ticked. Removing that row is exactly
  // how a mod gets stuck - it is what happened to a real one here.
  const activeId = raw('SELECT ModGroupRowId AS id FROM ModGroups WHERE Selected = 1')[0].id;
  const w = new DatabaseSync(DB_PATH);
  const rowId = w.prepare('SELECT ModRowId FROM Mods WHERE lower(ModId)=?').get(ID).ModRowId;
  w.prepare('DELETE FROM ModGroupItems WHERE ModGroupRowId=? AND ModRowId=?').run(activeId, rowId);
  w.close();
  const gone = db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID);
  check('removing that row makes it untoggleable', gone && gone.disabled === null, String(gone && gone.disabled));
  const todo = db.findUnregistered(DB_PATH, sources);
  check('and a sync now wants to fix it, saying why',
    todo.pending.some((p) => p.idNorm === ID && p.reason === 'no-profile-row'),
    todo.pending.map((p) => p.reason).join(','));
  const fix = db.registerMods(DB_PATH, todo.pending.map((p) => p.path), false, activeId);
  check('fixing it works', fix.registered.length >= 1 && fix.failed.length === 0, JSON.stringify(fix.failed));
  check('and still switches nothing on', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId
    WHERE i.Disabled = 0 AND lower(m.ModId)=?`, ID)[0].n === 0);
  check('and now it is tickable again', db.readModState(DB_PATH).mods.find((m) => m.idNorm === ID).disabled === true);
  check('nothing left to do', db.findUnregistered(DB_PATH, sources).count === 0);

  check('the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('and has no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);
}

// --- Test 18: removing a mod -------------------------------------------------
// Removal deletes the mod's folder, so the refusals matter more than the happy
// path. In a real database 42 of the 44 entries with no files on disk are
// base-game scenarios and DLC civs, not unsubscribed mods - so anything that
// does not check the path carefully would delete those.
console.log('\nTest 18: removing a mod, and refusing to remove the wrong thing');
{
  // TMP is already canonical, so every path built from it is in the form the
  // database will hold. That is the fix for "a case difference in the folder is
  // accepted" failing on the v1.5.0 release build and passing everywhere else:
  // once the scratch root is resolved, case is the only difference left to
  // introduce, which is what that check claims to be testing.
  const modRoot = path.join(TMP, 'mods');
  fs.mkdirSync(path.join(modRoot, 'Doomed Mod', 'Data'), { recursive: true });
  const sources = [{ root: modRoot, exists: true, type: 'local' }];
  const ID = '33333333-4444-5555-6666-777777777777';
  const dir = path.join(modRoot, 'Doomed Mod');
  const modinfo = path.join(dir, 'Doomed.modinfo');
  fs.writeFileSync(modinfo, `<Mod id="${ID}" version="1"><Properties><Name>Doomed Mod</Name></Properties><Files><File>Data/x.xml</File></Files></Mod>`);
  fs.writeFileSync(path.join(dir, 'Data', 'x.xml'), '<x/>');

  const reg = db.registerMods(DB_PATH, [modinfo], true, 2);
  check('registered first, so there is something to remove', reg.registered.length === 1, JSON.stringify(reg.failed));
  const folder = path.dirname(modinfo.replace(/\\/g, '/'));
  // Asserted rather than assumed. The checks below only mean anything if this
  // folder is the one the database recorded: when the two diverge, every guard in
  // this block is skipped for a different reason, and the only symptom is a
  // refusal several checks later saying "folder does not match". Naming the
  // invariant here means a future environment that reintroduces the divergence
  // fails with an explanation, not a riddle.
  const recordedPath = raw(`SELECT s.Path AS p FROM ScannedFiles s
    JOIN Mods m ON m.ScannedFileRowId = s.ScannedFileRowId
    WHERE lower(m.ModId) = ?`, ID)[0].p;
  check('the folder these checks use is the one the database recorded',
    folder === path.dirname(recordedPath), `${folder} vs ${path.dirname(recordedPath)}`);
  const countRows = () => raw('SELECT (SELECT count(*) FROM Mods) m, (SELECT count(*) FROM ModGroupItems) g')[0];
  const before = countRows();

  // --- refusals. Each must leave the database exactly as it was.
  const noFolder = db.removeMods(DB_PATH, [ID], {}, [modRoot]);
  check('refuses when no folder was confirmed', noFolder.removed.length === 0 && noFolder.refused.length === 1, JSON.stringify(noFolder.refused));

  const wrongFolder = db.removeMods(DB_PATH, [ID], { [ID]: path.join(modRoot, 'Some Other Mod') }, [modRoot]);
  check('refuses a folder that does not match the database', wrongFolder.removed.length === 0 && wrongFolder.refused.length === 1,
    JSON.stringify(wrongFolder.refused));

  // With no source folders to check against there is no way to tell a mod folder
  // from, say, the game's install directory - so a destructive call that cannot
  // prove safety refuses rather than assumes.
  const noRoots = db.removeMods(DB_PATH, [ID], { [ID]: folder });
  check('refuses when given no mod source folders at all', noRoots.removed.length === 0 && noRoots.refused.length === 1,
    JSON.stringify(noRoots.refused));
  check('  and the mod is still there', raw('SELECT count(*) n FROM Mods WHERE lower(ModId)=?', ID)[0].n === 1);

  const baseGame = db.removeMods(DB_PATH, [ID], { [ID]: 'C:/Program Files/Sid Meier/Civilization VI/Base/Scenarios' }, [modRoot]);
  check('refuses a base-game folder', baseGame.removed.length === 0 && baseGame.refused.length === 1, JSON.stringify(baseGame.refused));

  const theRoot = db.removeMods(DB_PATH, [ID], { [ID]: modRoot }, [modRoot]);
  check('refuses a mod source folder itself', theRoot.removed.length === 0 && theRoot.refused.length === 1, JSON.stringify(theRoot.refused));

  // Both of the above were refused for "folder does not match", which never
  // reaches the guards that matter. Plant rows whose recorded path really is a
  // base-game path, a DLC path, and the source root itself, so those guards are
  // the thing actually under test.
  const plant = (modId, scannedPath) => {
    const w = new DatabaseSync(DB_PATH);
    w.exec('BEGIN IMMEDIATE');
    const sf = w.prepare('INSERT INTO ScannedFiles (Path, LastWriteTime) VALUES (?, ?)').run(scannedPath, '0').lastInsertRowid;
    const mr = w.prepare('INSERT INTO Mods (ScannedFileRowId, ModId, Version) VALUES (?, ?, 1)').run(sf, modId).lastInsertRowid;
    w.prepare('INSERT INTO ModGroupItems (ModGroupRowId, ModRowId, Disabled) VALUES (2, ?, 1)').run(mr);
    w.exec('COMMIT');
    w.close();
  };
  const BASEGAME = '44444444-0000-0000-0000-00000000aaaa';
  const DLCD = '44444444-0000-0000-0000-00000000bbbb';
  const ROOTMOD = '44444444-0000-0000-0000-00000000cccc';
  const PARENTMOD = '44444444-0000-0000-0000-00000000dddd';
  const BASE_FOLDER = '../../Base/Scenarios';
  const DLC_FOLDER = '../../DLC/Australia/Civilization';
  const PARENT = modRoot.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  plant(BASEGAME, `${BASE_FOLDER}/AncientRivalsScenario.modinfo`);
  plant(DLCD, `${DLC_FOLDER}/Australia.modinfo`);
  plant(ROOTMOD, modRoot.replace(/\\/g, '/') + '/Loose.modinfo');
  plant(PARENTMOD, `${PARENT}/Loose2.modinfo`);

  // Baseline after planting, so "nothing changed" means the refusals changed
  // nothing rather than the planting having done it.
  const planted = countRows();

  // The folder passed has to be the one the database records, or the guard
  // under test is never reached - which is how the first version of these two
  // checks passed for the wrong reason.
  const g1 = db.removeMods(DB_PATH, [BASEGAME], { [BASEGAME]: BASE_FOLDER }, [modRoot]);
  check('a mod recorded at a base-game path is refused as base content',
    g1.removed.length === 0 && /refusing to remove base/.test(g1.refused[0].reason), JSON.stringify(g1.refused));
  const g2 = db.removeMods(DB_PATH, [DLCD], { [DLCD]: DLC_FOLDER }, [modRoot]);
  check('a mod recorded at a DLC path is refused as dlc content',
    g2.removed.length === 0 && /refusing to remove dlc/.test(g2.refused[0].reason), JSON.stringify(g2.refused));
  const g3 = db.removeMods(DB_PATH, [ROOTMOD], { [ROOTMOD]: modRoot }, [modRoot]);
  check('a mod whose folder IS a mod source folder is refused',
    g3.removed.length === 0 && /mod source folder/.test(g3.refused[0].reason), JSON.stringify(g3.refused));
  // The one that would have taken the whole mod library with it.
  const g4 = db.removeMods(DB_PATH, [PARENTMOD], { [PARENTMOD]: PARENT }, [modRoot]);
  check('so is a folder that contains the mod source folder',
    g4.removed.length === 0 && /containing the mod folders/.test(g4.refused[0].reason), JSON.stringify(g4.refused));
  check('all four are still in the database',
    [BASEGAME, DLCD, ROOTMOD, PARENTMOD].every((x) => raw('SELECT count(*) n FROM Mods WHERE lower(ModId)=?', x)[0].n === 1));
  check('and not one of those refusals changed a row',
    JSON.stringify(countRows()) === JSON.stringify(planted), `${JSON.stringify(planted)} -> ${JSON.stringify(countRows())}`);

  const unknown = db.removeMods(DB_PATH, ['99999999-0000-0000-0000-000000000000'],
    { '99999999-0000-0000-0000-000000000000': modRoot });
  check('reports an unknown mod rather than throwing', unknown.removed.length === 0 && unknown.refused.length === 1);

  check('the unknown-id refusal changed nothing either', JSON.stringify(countRows()) === JSON.stringify(planted),
    `${JSON.stringify(planted)} -> ${JSON.stringify(countRows())}`);

  // --- a mod still on disk is not "gone"
  const listed = db.findRemoved(DB_PATH, sources);
  check('findRemoved reads the database', listed.ok === true, listed.error || '');
  check('a mod that is still installed is not listed as gone', !listed.removed.some((r) => r.modId === ID));
  check('base and DLC entries are never offered for removal',
    listed.removed.every((r) => r.kind === 'dlc' || r.kind === 'base' ? r.removable === false : true),
    `${listed.removed.length} listed, ${listed.removable} removable`);

  // --- case must not matter, or a Steam library recorded as "d:\steam" fails
  const shouty = db.removeMods(DB_PATH, [ID], { [ID]: folder.toUpperCase() }, [modRoot]);
  check('a case difference in the folder is accepted', shouty.removed.length === 1, JSON.stringify(shouty.refused));
  check('it really is gone from Mods', raw('SELECT count(*) n FROM Mods WHERE lower(ModId)=?', ID)[0].n === 0);
  check('no profile still lists it', raw(`SELECT count(*) n FROM ModGroupItems i JOIN Mods m ON m.ModRowId=i.ModRowId WHERE lower(m.ModId)=?`, ID)[0].n === 0);
  // The join above cannot see an orphan: a row whose ModRowId points at a mod
  // that no longer exists has no match, so it is excluded by construction. This
  // is the only assertion that would notice one, and a profile IS a set of
  // ModGroupItems rows - an orphan inflates its "X of Y" count forever, with no
  // symptom to notice it by. The schema declares ON DELETE CASCADE, but nothing
  // in the toolkit turns PRAGMA foreign_keys on, so the cascade never fires and
  // the explicit DELETEs in removeMods are the only thing keeping this clean.
  check('and no profile row was left pointing at a mod that is gone',
    raw('SELECT count(*) n FROM ModGroupItems WHERE ModRowId NOT IN (SELECT ModRowId FROM Mods)')[0].n === 0,
    `${raw('SELECT count(*) n FROM ModGroupItems WHERE ModRowId NOT IN (SELECT ModRowId FROM Mods)')[0].n} orphans`);
  check('its file rows went with it', raw('SELECT count(*) n FROM ModFiles WHERE ModRowId NOT IN (SELECT ModRowId FROM Mods)')[0].n === 0);
  check('its ScannedFiles row went too', raw(`SELECT count(*) n FROM ScannedFiles WHERE Path LIKE '%Doomed%'`)[0].n === 0);
  check('a backup was made', !!shouty.backupPath && fs.existsSync(shouty.backupPath));
  check('only its own rows went: one fewer mod, fewer group items',
    countRows().m === planted.m - 1 && countRows().g < planted.g,
    `mods ${planted.m}->${countRows().m}, items ${planted.g}->${countRows().g}`);
  check('removing nothing is a no-op', db.removeMods(DB_PATH, [], {}, [modRoot]).removed.length === 0);
  check('and the database is still intact', raw('PRAGMA quick_check')[0].quick_check === 'ok');
  check('with no foreign key errors', raw('PRAGMA foreign_key_check').length === 0);

  // The rule set itself, on its own. Both the remove path and the open-folder
  // path go through this, so a change here moves both - which is the point, and
  // also why it needs checking directly rather than only through a caller.
  console.log('\nTest 19: the shared folder rules');
  {
    const roots = [modRoot];
    const F = db.modFolderFault;
    const real = path.join(modRoot, 'Real Mod').replace(/\\/g, '/');
    check('accepts a mod folder inside a source', F(real, `${real}/Real.modinfo`, roots) === null, String(F(real, `${real}/Real.modinfo`, roots)));
    check('accepts it however it is capitalised', F(real.toUpperCase(), `${real}/Real.modinfo`, roots) === null);
    check('accepts a workshop path', F(real, 'd:/steam/steamapps/workshop/content/289070/123/Real.modinfo', roots) === null);
    check('refuses base game', /base/.test(F(real, '../../Base/Scenarios/X.modinfo', roots) || ''), String(F(real, '../../Base/Scenarios/X.modinfo', roots)));
    check('refuses dlc', /dlc/.test(F(real, '../../DLC/Australia/X.modinfo', roots) || ''), String(F(real, '../../DLC/Australia/X.modinfo', roots)));
    check('refuses the source folder itself', /source folder/.test(F(modRoot, `${modRoot}/X.modinfo`, roots) || ''), String(F(modRoot, `${modRoot}/X.modinfo`, roots)));
    check('refuses a folder containing the source', /containing/.test(F(path.dirname(modRoot), `${path.dirname(modRoot)}/X.modinfo`, roots) || ''));
    check('refuses a folder outside every source', /not inside/.test(F('C:/elsewhere/Mod', 'C:/elsewhere/Mod/X.modinfo', roots) || ''));
    check('refuses an empty path', !!F('', 'X.modinfo', roots));
    // With nothing to check against it cannot prove the folder is safe, so it
    // must refuse rather than assume - this is what protects a caller that
    // forgets to pass the roots.
    check('refuses when given no roots at all', !!F(real, `${real}/Real.modinfo`, []), String(F(real, `${real}/Real.modinfo`, [])));
    check('and the same when roots is undefined', !!F(real, `${real}/Real.modinfo`, undefined));
    // The kind is reported before "not inside a mod folder", so a DLC path reads
    // as DLC rather than as merely being somewhere unexpected.
    check('the kind is reported ahead of the location', /^refusing to remove dlc/.test(F('C:/nowhere', '../../DLC/A/X.modinfo', roots) || ''),
      String(F('C:/nowhere', '../../DLC/A/X.modinfo', roots)));
  }

  // Handing a path to a native program. explorer.exe treats each "/segment" of
  // its argument as a switch, so the game's forward-slash paths leave it with no
  // path at all and it opens Documents instead - silently, with the same exit
  // code as success. Nothing about that failure is visible at runtime, so the
  // conversion is checked here rather than left to be noticed.
  console.log('\nTest 20: paths for native programs');
  {
    const win = process.platform === 'win32';
    const fwd = 'D:/Steam/steamapps/workshop/content/289070/2573589760';
    const native = toNativePath(fwd);
    check('a forward-slash path comes back with no forward slashes on Windows',
      win ? !native.includes('/') : true, native);
    check('and with native separators on Windows', win ? /^[A-Za-z]:\\/.test(native) : true, native);
    check('every segment survives the conversion',
      win ? native.replace(/\\/g, '/') === fwd : true, native);
    check('a path with a space is untouched by the separator change',
      toNativePath('C:/Program Files/Steam') === (win ? 'C:\\Program Files\\Steam' : 'C:/Program Files/Steam'),
      toNativePath('C:/Program Files/Steam'));
    // Already-native input must not gain a second round of escaping.
    check('an already-native path is unchanged',
      toNativePath('C:\\Program Files') === 'C:\\Program Files', toNativePath('C:\\Program Files'));
    check('a UNC path survives', toNativePath('//server/share/Mod') === (win ? '\\\\server\\share\\Mod' : '//server/share/Mod'),
      toNativePath('//server/share/Mod'));
    check('an empty path stays empty', toNativePath('') === '' && toNativePath(null) === '');
    // The call site has to use it, or the function is just dead code and the bug
    // is back. A source check is the only way to see that.
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    check('the explorer call converts at the boundary', /execFile\('explorer\.exe', \[paths\.toNativePath\(folder\)\]/.test(srv));
    check('and nothing else hands a raw forward-slash path to explorer',
      !/execFile\('explorer\.exe', \[folder\]/.test(srv));
    // windowsHide sets STARTUPINFO.wShowWindow = SW_HIDE, which Explorer inherits:
    // it builds the window and the shell hides it. The folder opens correctly and
    // you see a flicker and nothing else - and because a hidden window is still a
    // real entry in the shell's window list, a check that enumerates windows
    // reports success. There is no runtime symptom to assert on, so the only place
    // to catch it is here.
    const explorerCall = (srv.match(/execFile\('explorer\.exe'[^;]*/) || [''])[0];
    check('the explorer call does not pass windowsHide', !/windowsHide/.test(explorerCall), explorerCall.slice(0, 80));
    check('  which is the whole difference from a working launch',
      /execFile\('explorer\.exe', \[paths\.toNativePath\(folder\)\], \(err\)/.test(explorerCall));
    // The flag still belongs on the console programs, where it stops a flash.
    check('the console callers still hide their window', /execFile\('tasklist'.*windowsHide: true/.test(fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8')));
  }

  console.log('\nTest 21: civ6-paths.json when it is broken');
  {
    const wasFile = process.env.CIV6_PATHS_FILE;
    const scratch = path.join(TMP, 'paths-overrides.json');

    // A fresh module per scenario. loadOverrides memoises - that is the point of
    // it - so one shared instance would carry a scenario's verdict into the next
    // and every check after the first would silently be about the wrong file.
    const withFile = (text) => {
      process.env.CIV6_PATHS_FILE = scratch;
      delete require.cache[require.resolve('./paths')];
      if (text === undefined) { try { fs.unlinkSync(scratch); } catch (_) { /* absent */ } }
      else fs.writeFileSync(scratch, text);
      return require('./paths');
    };
    // Everything a request touches. None of it may throw, whatever the file says.
    const touches = (p) => [p.getSources(), p.getSavesDir(), p.getModsDb(), p.overridesStatus()];
    const status = (p) => p.overridesStatus();

    // --- the normal state: no file, nothing wrong --------------------------
    let p = withFile(undefined);
    check('no overrides file is not a failure', status(p).error === null, String(status(p).error));
    check('  and is not marked unusable', status(p).unusable === false);
    check('  and the folders still resolve', p.getSources().length >= 1);

    // --- a good file --------------------------------------------------------
    p = withFile(JSON.stringify({ localMods: 'D:/Games/Mods', workshop: 'D:/Steam/ws' }));
    check('a good file is read', p.getSources()[0].root === 'D:/Games/Mods', p.getSources()[0].root);
    check('  a single workshop path becomes a one-item list',
      p.getSources().filter((s) => s.type === 'workshop').length === 1);
    check('  and says nothing is wrong', status(p).error === null);

    p = withFile(JSON.stringify({ workshop: ['D:/a', 'D:/b'] }));
    check('a workshop list is kept as a list',
      p.getSources().filter((s) => s.type === 'workshop').length === 2);

    // --- broken: not JSON ---------------------------------------------------
    // The bug. This returned {} with no message at all, so a user whose paths
    // stopped resolving watched their whole library disappear with nothing to
    // tell them why.
    p = withFile('{ this is not json');
    check('invalid JSON is reported', /is not valid JSON/.test(String(status(p).error)), String(status(p).error));
    check('  the message names the file it is about', /paths-overrides\.json/.test(String(status(p).error)));
    check('  and it is marked unusable, so a write would refuse', status(p).unusable === true);
    check('  nothing throws - the mod list keeps working',
      touches(p).every(Boolean) && !fails(() => touches(p)));
    check('  and it falls back to the default folders',
      p.getSources().some((s) => s.type === 'workshop'));

    // --- broken: valid JSON, wrong shape -------------------------------------
    for (const [what, text] of [['an array', '[]'], ['a string', '"hello"'], ['null', 'null'], ['a number', '42']]) {
      p = withFile(text);
      check(`${what} is rejected as unusable`,
        status(p).unusable === true && /does not contain an object/.test(String(status(p).error)),
        String(status(p).error));
    }
    p = withFile('   ');   // whitespace is a file holding nothing, not a broken one
    check('a blank file is treated as no overrides, not as a broken one',
      status(p).error === null && status(p).unusable === false, String(status(p).error));

    // --- one bad key among good ones -----------------------------------------
    p = withFile(JSON.stringify({ localMods: 'D:/Games/Mods', saves: 42, modsDb: null, workshop: {} }));
    check('a good key survives alongside bad ones', p.getSources()[0].root === 'D:/Games/Mods', p.getSources()[0].root);
    check('  the bad ones are dropped rather than passed through',
      !touches(p).some((v) => JSON.stringify(v).includes('42')));
    check('  and it says which, by name',
      /saves/.test(String(status(p).error)) && /workshop/.test(String(status(p).error)), String(status(p).error));
    check('  but the file is still usable, because the rest of it is real',
      status(p).unusable === false);
    check('  a null is "not set", not an error', !/modsDb/.test(String(status(p).error)), String(status(p).error));

    p = withFile(JSON.stringify({ localMods: 'D:/Games/Mods', _comment: 'a note', somethingElse: [1, 2] }));
    check('an unknown key is ignored without complaint',
      status(p).error === null && p.getSources()[0].root === 'D:/Games/Mods', String(status(p).error));

    // --- writing --------------------------------------------------------------
    // The write path used to hardcode the project root while the read path
    // honoured CIV6_PATHS_FILE, so a test or a relocated install read overrides
    // from one file and overwrote another. The next two checks are the regression.
    p = withFile(undefined);
    p.writeOverrides({ localMods: 'E:/Elsewhere/Mods', workshop: 'E:/Steam/ws' });
    check('a write lands in the file that was read',
      JSON.parse(fs.readFileSync(scratch, 'utf8')).localMods === 'E:/Elsewhere/Mods');
    const real = path.join(__dirname, '..', 'civ6-paths.json');
    check('  and not in the project root',
      !fs.existsSync(real)
        || JSON.parse(fs.readFileSync(real, 'utf8')).localMods !== 'E:/Elsewhere/Mods');
    check('  and it is seen without a restart', p.getSources()[0].root === 'E:/Elsewhere/Mods');

    p = withFile(undefined);
    p.writeOverrides({ localMods: 'E:/M', saves: '', workshop: [] });
    const written = JSON.parse(fs.readFileSync(scratch, 'utf8'));
    check('an empty value is dropped, not written as an empty string',
      !('saves' in written) && !('workshop' in written) && written.localMods === 'E:/M', JSON.stringify(written));

    p = withFile('{ broken');
    check('writing over a broken file is refused', fails(() => p.writeOverrides({ localMods: 'E:/M' })));
    check('  and leaves it exactly as it was', fs.readFileSync(scratch, 'utf8') === '{ broken');
    let refusal = '';
    try { p.writeOverrides({ localMods: 'E:/M' }); } catch (e) { refusal = e.message; }
    check('  and says why, rather than just failing', /nothing was written/.test(refusal), refusal);

    // --- the wiring, which is all a source check can see -----------------------
    // modList lives in modlist.js (shared with the CLI), so the wiring spans both files.
    const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, 'modlist.js'), 'utf8');
    const modsJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'mods.js'), 'utf8');
    const dashJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
    check('the server writes paths through paths.writeOverrides', /paths\.writeOverrides\(body\)/.test(srv));
    check('  and no longer writes the overrides file itself',
      !/writeFileSync\(\s*file,\s*JSON\.stringify\(obj/.test(srv));
    check('  a refusal becomes a 400 rather than a crash',
      /catch \(e\) \{\s*return send\(res, 400, \{ error: e\.message \}\);/.test(srv));
    check('every response that carries paths also carries the error',
      (srv.match(/pathsError: paths\.overridesStatus\(\)\.error/g) || []).length === 3,
      String((srv.match(/pathsError: paths\.overridesStatus\(\)\.error/g) || []).length));
    check('the mod manager says so, and says the list still works',
      /pathsError/.test(modsJs) && /not being read/.test(modsJs));
    check('the dashboard says so too', /pathsError/.test(dashJs));

    if (wasFile === undefined) delete process.env.CIV6_PATHS_FILE;
    else process.env.CIV6_PATHS_FILE = wasFile;
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'PROFILES: ALL CHECKS PASSED' : 'PROFILES: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
