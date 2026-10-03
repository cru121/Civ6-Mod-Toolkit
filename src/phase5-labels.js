'use strict';

// Phase 5 automated proof: user-defined mod labels.
//
// Operates only on a synthetic labels file in a scratch dir. A real
// mod-labels.json is never read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const labels = require('./labels');
const { scanMods } = require('./modinfo');
// Deliberately not labels.js's own key: the point is to check that the store
// keys by the same normalisation the mod list does, and using its own function
// here would hide it if it ever stopped.
const { normId } = require('./modinfo');

// Resolved, for the same reason as phase4's: on Windows a GitHub runner's TEMP
// is under an 8.3 short name, and anything that later compares one of these
// paths against a path the product canonicalised would be comparing two
// spellings of one folder. Cheap to do once here rather than to discover per
// check.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-labels-')));
const FILE = path.join(TMP, 'mod-labels.json');
console.log(`scratch dir: ${TMP}\n`);

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const put = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const ID_A = '521b8777-0977-4859-a5ee-3e411a732e5c';
const ID_B = 'fdf9c98a-1111-4222-8333-444455556666';
const SAMPLE = { version: 1, labels: { [ID_A]: ['favourite'], [ID_B]: ['favourite', 'needs-testing'] } };

// --- Test 1: a file that is not there is not a failure -----------------------
console.log('Test 1: no file, no labels');
{
  const v = labels.readLabels(FILE);
  check('a missing file reads as no labels', Object.keys(v.labels).length === 0);
  check('  and says nothing is wrong', v.error === null, String(v.error));
  check('  and nothing was pruned', v.pruned === 0);
  check('  and the label list is empty', v.names.length === 0 && v.counts.length === 0);
}

// --- Test 2: empty and malformed --------------------------------------------
console.log('\nTest 2: empty and malformed files still load the mod list');
{
  put('');
  check('an empty file reads as no labels', Object.keys(labels.readLabels(FILE).labels).length === 0);
  put('   \n\t  ');
  check('a whitespace-only file reads as no labels', Object.keys(labels.readLabels(FILE).labels).length === 0);
  check('  and is not reported as an error', labels.readLabels(FILE).error === null);

  put('{ this is not json');
  const broken = labels.readLabels(FILE);
  check('a syntax error yields no labels', Object.keys(broken.labels).length === 0);
  check('  and a message saying why', /not valid JSON/.test(broken.error || ''), String(broken.error));

  put('[1, 2, 3]');
  check('a JSON array is refused', /does not contain an object/.test(labels.readLabels(FILE).error || ''));
  put({ version: 1, labels: 'nope' });
  check('a labels value that is not an object is refused', /no "labels" object/.test(labels.readLabels(FILE).error || ''));
  put({ version: 99, labels: { [ID_A]: ['favourite'] } });
  const future = labels.readLabels(FILE);
  check('a version we did not write is refused whole', future.labels[normId(ID_A)] === undefined
    && /version 99/.test(future.error || ''), String(future.error));

  // One bad entry must not cost the good ones: the file is valid JSON, and only
  // the entry that is not an array of names is unreadable.
  put({ version: 1, labels: { [ID_A]: ['favourite'], 'not-an-array': 'oops', '': ['x'], [ID_B]: 'no' } });
  const mixed = labels.readLabels(FILE);
  check('a good entry survives a bad one', !!mixed.labels[normId(ID_A)], JSON.stringify(mixed.labels));
  check('  and the bad ones are reported', /could not be read/.test(mixed.error || ''), String(mixed.error));
  check('  and none of the bad ones became keys',
    !Object.keys(mixed.labels).some((k) => k === 'not-an-array' || k === ''));

  // A directory in the file's place is an unreadable file, not a missing one:
  // it should say so rather than claim there is nothing there.
  fs.rmSync(FILE, { force: true });
  fs.mkdirSync(FILE);
  check('an unreadable path is reported, not silently empty', !!labels.readLabels(FILE).error);
  fs.rmdirSync(FILE);
}

// --- Test 3: reading a good file --------------------------------------------
console.log('\nTest 3: counts, names and key normalisation');
{
  put(SAMPLE);
  const v = labels.readLabels(FILE);
  const a = normId(ID_A);
  const b = normId(ID_B);
  check('both mods have their labels', (v.labels[a] || []).join() === 'favourite' && (v.labels[b] || []).join() === 'favourite,needs-testing');
  check('a label on two mods counts two', v.counts.find((c) => c.name === 'favourite').count === 2);
  check('a label on one mod counts one', v.counts.find((c) => c.name === 'needs-testing').count === 1);
  check('counts come back most-used first', v.counts[0].name === 'favourite');
  check('the editor list is alphabetical', v.names.join() === 'favourite,needs-testing', v.names.join());
  check('a well-formed file reports no error', v.error === null, String(v.error));

  // The game, .Civ6Cfg files and hand edits all spell a GUID differently.
  put({ version: 1, labels: { [`{${ID_A.toUpperCase()}}`]: ['favourite'], [ID_B.toUpperCase()]: ['favourite'] } });
  const cased = labels.readLabels(FILE);
  check('braces and case in a key make no difference', !!(cased.labels[a] && cased.labels[b]),
    JSON.stringify(Object.keys(cased.labels)));
  check('  and it is still two mods on the label', cased.counts.find((c) => c.name === 'favourite').count === 2);

  put({ labels: { [ID_A]: ['favourite'] } });
  check('a file with no version field still loads', !!labels.readLabels(FILE).labels[a]);
}

// --- Test 4: pruning --------------------------------------------------------
console.log('\nTest 4: pruning orphans');
{
  put(SAMPLE);
  const a = normId(ID_A);
  const b = normId(ID_B);
  const known = new Set([a]); // mod B is gone from the list
  const v = labels.readLabels(FILE, known);
  check('a label for a mod that is not there is dropped', v.labels[a] && v.labels[b] === undefined,
    JSON.stringify(Object.keys(v.labels)));
  check('  and is counted', v.pruned === 1, `pruned=${v.pruned}`);
  check('  and its label stops being offered', !v.names.includes('needs-testing'), v.names.join());

  // The read must not have touched the file: pruning only becomes permanent
  // when something is written.
  check('a read never writes', Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).labels).length === 2);

  // An incomplete list is not a statement about which mods exist. Pruning
  // against one is how criterion 4 would be met by breaking criterion 2.
  const unsure = labels.readLabels(FILE, null);
  check('an unvouched set prunes nothing', Object.keys(unsure.labels).length === 2 && unsure.pruned === 0);
}

// --- Test 5: label names ----------------------------------------------------
console.log('\nTest 5: what a label may be called');
{
  check('surrounding space is trimmed', labels.cleanLabel('  favourite  ') === 'favourite');
  check('a name at the cap is kept', labels.cleanLabel('x'.repeat(100)).length === 100);
  check('an over-long name is refused', /longer than 100/.test(cap(labels.cleanLabel, 'x'.repeat(101))));
  check('an empty name is refused', /cannot be empty/.test(cap(labels.cleanLabel, '')));
  check('a whitespace-only name is refused', /cannot be empty/.test(cap(labels.cleanLabel, '   ')));
  check('so is no name at all', /cannot be empty/.test(cap(labels.cleanLabel, null)));
}

// --- Test 6: writing --------------------------------------------------------
console.log('\nTest 6: writing a label');
{
  fs.rmSync(FILE, { force: true });
  const a = normId(ID_A);
  const known = new Set([a, normId(ID_B)]);

  const v = labels.setLabels(FILE, ID_A, ['favourite'], known);
  check('a label is written and read back', v.labels[a] && v.labels[a][0] === 'favourite', JSON.stringify(v.labels));
  check('the file appears on disk', fs.existsSync(FILE));
  check('  with the version it was written as', JSON.parse(fs.readFileSync(FILE, 'utf8')).version === 1);
  check('  and no temp file left beside it', !fs.readdirSync(TMP).some((f) => /\.tmp-/.test(f)), fs.readdirSync(TMP).join());

  // Typing the same label on a second mod must not make a second label.
  const two = labels.setLabels(FILE, ID_B, ['Favourite', '  needs-testing  '], known);
  check('the same label on another mod counts twice',
    two.counts.find((c) => c.name === 'favourite').count === 2, JSON.stringify(two.counts));
  check('case-insensitive: it did not become a second label',
    two.names.length === 2, two.names.join());
  check('  and it took the spelling created first', !!two.labels[normId(ID_B)].includes('favourite'),
    JSON.stringify(two.labels[normId(ID_B)]));
  check('names are trimmed on the way in', two.labels[normId(ID_B)].includes('needs-testing'));
  check('a mod can carry several labels', two.labels[normId(ID_B)].length === 2);

  const dup = labels.setLabels(FILE, ID_B, ['favourite', 'FAVOURITE', 'favourite'], known);
  check('the same name three times in one request is stored once',
    dup.labels[normId(ID_B)].length === 1, JSON.stringify(dup.labels[normId(ID_B)]));

  // An empty request is a removal, not a refusal: the editor sends the whole
  // set back every time, including when the last one is unticked. At this point
  // both A and B carry "favourite" and nothing else.
  const afterB = labels.setLabels(FILE, ID_B, [], known);
  check('removing a mod\'s last label leaves no empty entry', afterB.labels[normId(ID_B)] === undefined,
    JSON.stringify(afterB.labels));
  check('  but the label stays while another mod still carries it', afterB.names.includes('favourite'), afterB.names.join());
  const afterA = labels.setLabels(FILE, ID_A, [], known);
  check('once no mod carries it the label stops existing', !afterA.names.includes('favourite'), afterA.names.join());
  check('  and nothing is left in the file', Object.keys(afterA.labels).length === 0 && afterA.counts.length === 0);

  // A second tab labelling a different mod must not lose the first tab's work.
  labels.setLabels(FILE, ID_A, ['favourite'], known);
  labels.setLabels(FILE, ID_B, ['mp-safe'], known);
  const both = labels.readLabels(FILE, known);
  check('two saves to different mods both survive',
    !!both.labels[a] && !!both.labels[normId(ID_B)] && both.labels[normId(ID_B)][0] === 'mp-safe',
    JSON.stringify(both.labels));

  check('a bad name in the request is refused whole',
    /cannot be empty/.test(cap(labels.setLabels, FILE, ID_A, ['ok', '  '], known)));
  check('  and nothing was written', JSON.stringify(labels.readLabels(FILE, known).labels) === JSON.stringify(both.labels));
  check('an over-long name is refused too',
    /longer than 100/.test(cap(labels.setLabels, FILE, ID_A, ['x'.repeat(101)], known)));
  check('a mod id of nothing is refused', /which mod/.test(cap(labels.setLabels, FILE, '', ['a'], known)));
}

// --- Test 7: the write leaves nothing half-done ------------------------------
console.log('\nTest 7: two saves in quick succession');
{
  const known = new Set([normId(ID_A), normId(ID_B)]);
  fs.rmSync(FILE, { force: true });
  // Back to back, so the two temp files exist at the same moment: a shared
  // temp name would let the second write clobber the first before the rename.
  labels.setLabels(FILE, ID_A, ['one'], known);
  labels.setLabels(FILE, ID_B, ['two'], known);
  labels.setLabels(FILE, ID_A, ['three'], known);
  const v = labels.readLabels(FILE, known);
  check('every save landed', v.labels[normId(ID_A)][0] === 'three' && v.labels[normId(ID_B)][0] === 'two',
    JSON.stringify(v.labels));
  check('the file is still valid JSON', (() => {
    try { JSON.parse(fs.readFileSync(FILE, 'utf8')); return true; } catch (_) { return false; }
  })());
  check('and no temp file was left behind', fs.readdirSync(TMP).join() === 'mod-labels.json', fs.readdirSync(TMP).join());
}

// --- Test 8: a file that cannot be built on ---------------------------------
console.log('\nTest 8: writing over a broken file');
{
  const known = new Set([normId(ID_A)]);
  put('{ broken');
  const msg = cap(labels.setLabels, FILE, ID_A, ['favourite'], known);
  check('a save over a corrupt file is refused', /not valid JSON/.test(msg), msg);
  check('  and the message says nothing was written', /nothing was written/.test(msg), msg);
  check('  and the file is left exactly as it was', fs.readFileSync(FILE, 'utf8') === '{ broken');
  check('  and the mod list still reads, as no labels', Object.keys(labels.readLabels(FILE).labels).length === 0);
  check('a file of the wrong version is refused the same way', (() => {
    put({ version: 42, labels: {} });
    return /nothing was written/.test(cap(labels.setLabels, FILE, ID_A, ['x'], known));
  })());
  // The recoverable case still writes: one bad entry among good ones costs only
  // that entry, so there is a real map to build on.
  put({ version: 1, labels: { [ID_A]: ['keep'], bad: 'oops' } });
  const ok = labels.setLabels(FILE, ID_A, ['keep', 'added'], known);
  check('a file with one bad entry is still writable', ok.labels[normId(ID_A)].join() === 'keep,added',
    JSON.stringify(ok.labels));
  check('  and the bad entry is gone from the file', !JSON.stringify(JSON.parse(fs.readFileSync(FILE, 'utf8'))).includes('oops'));
}

// --- Test 9: the mod's own GUID, not the row the game gave it ---------------
// The constraint the spec says was learned the hard way. During a load-order
// investigation a rescan moved two mods from ModRowId 1921/1758 to 2218/2219,
// and anything keyed by ModRowId loses every label the next time Civ6 starts.
//
// This is the one test that would notice a regression to ModRowId keys, and
// it is worth the synthetic database it needs: a test that cannot fail here
// proves nothing about the thing that actually broke.
console.log('\nTest 9: labels survive a rescan');
{
  const modsDir = path.join(TMP, 'mods');
  const local = path.join(modsDir, 'Local');
  const workshop = path.join(modsDir, 'Workshop');
  for (const d of [local, workshop]) fs.mkdirSync(d, { recursive: true });

  // Real .modinfo files, walked by the real scanner, so the id under test is
  // the one the toolkit would actually key on.
  const plant = (root, folder, id, name) => {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, `${folder}.modinfo`),
      `<?xml version="1.0" encoding="utf-8"?>\n<Mod id="${id}">\n\t<Properties>\n\t\t<Name>${name}</Name>\n\t</Properties>\n</Mod>\n`);
    return id;
  };
  const GUID_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const GUID_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const Mover = plant(local, 'Mover', GUID_1, 'Mover');
  const Stayer = plant(local, 'Stayer', GUID_2, 'Stayer');
  const sources = [{ type: 'local', label: 'local', root: local, exists: true }];

  const found = scanMods(sources);
  check('the scanner finds both mods', found.length === 2, `${found.length} found`);
  const ids = new Set(found.map((m) => m.idNorm));
  check('  by the GUID from their .modinfo', ids.has(normId(GUID_1)) && ids.has(normId(GUID_2)));

  labels.setLabels(FILE, GUID_1, ['favourite'], ids);
  labels.setLabels(FILE, GUID_2, ['favourite', 'needs-testing'], ids);

  // The game's database, and what a rescan does to it.
  const dbPath = path.join(TMP, 'Mods.sqlite');
  const seed = () => {
    fs.rmSync(dbPath, { force: true });
    const d = new DatabaseSync(dbPath);
    d.exec(`CREATE TABLE Mods(ModRowId INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ModId TEXT NOT NULL);`);
    for (const id of [GUID_1, GUID_2]) d.prepare('INSERT INTO Mods (ModId) VALUES (?)').run(id);
    d.close();
  };
  const rowIds = () => {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try { return Object.fromEntries(d.prepare('SELECT ModRowId, ModId FROM Mods').all().map((r) => [normId(r.ModId), r.ModRowId])); }
    finally { d.close(); }
  };
  seed();
  const before = rowIds();
  // A rescan: the game drops and rebuilds its rows, and the ids move. This is
  // what happened to the two mods in the spec, and it is not hypothetical.
  const d = new DatabaseSync(dbPath);
  d.exec('UPDATE Mods SET ModRowId = ModRowId + 1000');
  d.close();
  const after = rowIds();

  check('the rescan really did renumber the rows',
    before[normId(GUID_1)] !== after[normId(GUID_1)] && before[normId(GUID_2)] !== after[normId(GUID_2)],
    `${before[normId(GUID_1)]}->${after[normId(GUID_1)]}, ${before[normId(GUID_2)]}->${after[normId(GUID_2)]}`);

  const v = labels.readLabels(FILE, ids);
  check('every label is still attached to the same mod',
    v.labels[normId(GUID_1)].join() === 'favourite' && v.labels[normId(GUID_2)].join() === 'favourite,needs-testing',
    JSON.stringify(v.labels));
  check('  and nothing was pruned as an orphan', v.pruned === 0, `pruned=${v.pruned}`);

  // The negative control. If this passed for a ModRowId-keyed file, the test
  // above would be proving nothing.
  put({ version: 1, labels: { [String(before[normId(GUID_1)])]: ['favourite'] } });
  const byRow = labels.readLabels(FILE, ids);
  check('a file keyed by ModRowId loses the label on rescan, as it must',
    byRow.labels[normId(GUID_1)] === undefined && byRow.pruned === 1,
    JSON.stringify(byRow.labels));

  // Moving a mod between the workshop and local folders changes its path, not
  // its GUID. Criterion 3 of the spec.
  labels.setLabels(FILE, GUID_1, ['favourite', 'mp-safe'], ids);
  // Not created first: Windows refuses to rename a directory onto one that
  // already exists, which is the sort of thing a test that only ever ran on
  // Linux would not find.
  const wsFolder = path.join(workshop, '12345');
  fs.renameSync(path.join(local, 'Mover'), wsFolder);
  const both = [...sources, { type: 'workshop', label: 'workshop', root: workshop, exists: true }];
  const moved = scanMods(both);
  const movedMod = moved.find((m) => m.idNorm === normId(GUID_1));
  check('the mod is found in its new home', !!movedMod, moved.map((m) => `${m.name}:${m.type}`).join());
  check('  and it is now a workshop mod', movedMod && movedMod.type === 'workshop');
  const after2 = labels.readLabels(FILE, new Set(moved.map((m) => m.idNorm)));
  check('  and both of its labels came with it',
    after2.labels[normId(GUID_1)].join() === 'favourite,mp-safe', JSON.stringify(after2.labels[normId(GUID_1)]));
}

// --- Test 10: the two decisions in server.js that nothing can assert on -----
// Both are deliberate and both look like the kind of thing a later reader
// "fixes" by adding a game-running check or a prune that is always on. Neither
// has a runtime symptom to catch it, so the only place is here - the same
// argument phase4 makes about the explorer call.
console.log('\nTest 10: the decisions the server makes about labels');
{
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  // modList lives in modlist.js, shared with the CLI.
  const modlistSrc = fs.readFileSync(path.join(__dirname, 'modlist.js'), 'utf8');
  const block = (name) => {
    const at = srv.indexOf(`'${name}'`);
    return at === -1 ? '' : srv.slice(at, srv.indexOf('\n  }', at));
  };
  const labelsRoute = block('/api/mods/labels');
  const modsRoute = block('/api/mods');

  check('there is a labels route', !!labelsRoute);
  // The one write in the toolkit that is not refused while Civ6 runs, because
  // it writes a file the game has never heard of. Blocking it would be copying
  // a rule whose reason does not apply.
  check('the labels write is NOT refused while Civ6 runs',
    labelsRoute && !/game\.running\s*\)\s*return send\(res, 409/.test(labelsRoute), labelsRoute.slice(0, 200));
  check('  and it does read the game status, for pruning rather than refusal',
    /await gameStatus\(\)/.test(labelsRoute));
  check('pruning is opt-in, so a caller that cannot vouch for its list gets no prune',
    /modList\(opts = \{\}\)/.test(modlistSrc) && /opts\.prune \? new Set/.test(modlistSrc));
  check('  and /api/mods only opts in when the game is closed',
    /modList\(\{ prune: !game\.running \}\)/.test(modsRoute), modsRoute.slice(0, 200));
  // A typed label is the user's mistake; a corrupt file is ours. The two must
  // not both answer 500, or the UI cannot tell which one to apologise for.
  check('a label the server will not accept is a 400', /400, \{ error: e\.message \}/.test(labelsRoute));
  check('a file we cannot read is a 500, and says nothing was written',
    /500, \{ error: e\.message \}/.test(labelsRoute));
  check('the whole file is never sent by the page, only one mod id',
    /postJson\('\/api\/mods\/labels', \{ id: idNorm, labels: labelEdit\.names \}\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'public', 'mods.js'), 'utf8')));

  // The filter combines as OR, not AND. Nothing at runtime can tell the
  // difference when there is one chip, and with two it is the difference
  // between a list of five and a list of one - so a refactor from some() to
  // every() would pass every manual check anyone would think to do.
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'mods.js'), 'utf8');
  const matches = /function matchesLabels\(m\) \{([\s\S]*?)\n\}/.exec(page);
  check('a multi-label filter is a union, not an intersection',
    matches && /\.some\(/.test(matches[1]) && !/\.every\(/.test(matches[1]),
    matches ? matches[1].trim() : 'matchesLabels not found');
  check('  and the filter narrows the visible list rather than replacing it',
    /SRC_MATCH\[modsPage\.src\]\(m\)\s*\n\s*&& matchesLabels\(m\)/.test(page));
  // The filter is a set, so anything holding more than one label has to compare
  // it as a set. A plain array would still pass the union check above.
  check('  and it is a Set, so several labels can be selected at once',
    /labels: new Set\(\)/.test(page) && /modsPage\.labels\.(add|delete|has)\(/.test(page));
  check('  and a label that no longer exists leaves the selection',
    /if \(!live\.has\(k\)\) modsPage\.labels\.delete\(k\)/.test(page));

  // Rename and delete change every mod at once, so they need names of their own -
  // one mod's id is not enough to ask for either.
  check('a label can be renamed across every mod that has it',
    /url\.pathname === '\/api\/mods\/labels\/rename'/.test(srv) && /labelStore\.renameLabel/.test(srv));
  check('and deleted across every mod that has it',
    /url\.pathname === '\/api\/mods\/labels\/delete'/.test(srv) && /labelStore\.deleteLabel/.test(srv));
  check('  and the rename reports how many mods moved, and whether it merged',
    /moved: v\.moved, merged: v\.merged/.test(srv));
  check('  and neither is refused while Civ6 runs, like the other label writes',
    !/409/.test(block('/api/mods/labels/rename')) && !/409/.test(block('/api/mods/labels/delete')));
  // A rename is read-modify-write too, so a tab labelling a mod at the same
  // moment does not lose its change to someone renaming a label.
  check('  and it re-reads the file rather than trusting the page',
    /labelStore\.renameLabel\(labelStore\.labelsFile\(\), body\.from, to,/.test(srv));
}

// --- Test 11: renaming and deleting a label everywhere ---------------------
console.log('\nTest 11: rename and delete');
{
  const A = normId(ID_A);
  const B = normId(ID_B);
  const known = new Set([A, B]);

  const seed = () => labels.writeLabels(FILE, {
    [A]: ['favourite', 'mp-safe'],
    [B]: ['favourite', 'needs-testing'],
  });
  seed();

  // --- rename -------------------------------------------------------------
  let v = labels.renameLabel(FILE, 'favourite', 'starred', known);
  check('a rename reaches every mod that carried the label', v.moved === 2, `moved=${v.moved}`);
  check('  the new name is on both of them', v.labels[A].includes('starred') && v.labels[B].includes('starred'),
    JSON.stringify(v.labels));
  check('  the old name is on neither', !v.names.includes('favourite'), v.names.join());
  check('  and the other labels are untouched', v.labels[A].join() === 'starred,mp-safe', JSON.stringify(v.labels[A]));
  check('  and the count followed the rename', (v.counts.find((c) => c.name === 'starred') || {}).count === 2);
  check('a rename is not reported as a merge', v.merged === false);

  // Renaming to a spelling that already exists adopts that spelling, rather than
  // creating a second label nobody can tell apart.
  v = labels.renameLabel(FILE, 'starred', 'MP-Safe', known);
  check('renaming onto an existing label merges the two', v.moved === 2 && v.merged === true,
    `moved=${v.moved} merged=${v.merged}`);
  check('  every mod ends up with one label, not two', v.names.length === 2, v.names.join());
  check('  and it took the spelling already in use', v.names.includes('mp-safe') && !v.names.includes('MP-Safe'),
    v.names.join());
  check('  the mod that had both keeps just the target',
    (v.labels[A] || []).join() === 'mp-safe', JSON.stringify(v.labels[A]));
  check('  and the one that had only the old name gains the target',
    (v.labels[B] || []).join() === 'mp-safe,needs-testing', JSON.stringify(v.labels[B]));

  // Renaming to a name only differing in case is a spelling change, not a merge.
  seed();
  v = labels.renameLabel(FILE, 'favourite', 'FAVOURITE', known);
  check('a rename that only changes case keeps one label', v.names.length === 3, v.names.join());
  check('  and does not report a merge', v.merged === false);
  check('  the spelling on file is the one that was there', v.names.includes('favourite'));

  check('renaming a label nothing carries is refused', /no mod is labelled/.test(cap(labels.renameLabel, FILE, 'nope', 'x', known)));
  check('  and nothing was written', !labels.readLabels(FILE, known).names.includes('x'));
  check('renaming to an empty name is refused', /cannot be empty/.test(cap(labels.renameLabel, FILE, 'favourite', '  ', known)));
  check('renaming to an over-long name is refused', /longer than 100/.test(cap(labels.renameLabel, FILE, 'favourite', 'y'.repeat(101), known)));
  check('renaming nothing at all is refused', /which label/.test(cap(labels.renameLabel, FILE, '', 'x', known)));
  check('a rename over a corrupt file is refused', (() => {
    put('{ broken');
    const m = cap(labels.renameLabel, FILE, 'a', 'b', known);
    put(JSON.stringify({ version: 1, labels: { [A]: ['favourite'], [B]: ['mp-safe'] } }));
    return /nothing was written/.test(m);
  })());

  // --- delete -------------------------------------------------------------
  seed();
  v = labels.deleteLabel(FILE, 'favourite', known);
  check('a delete reports how many mods it came off', v.removed === 2, `removed=${v.removed}`);
  check('  and none of them has it any more', !v.names.includes('favourite'), v.names.join());
  check('  and the other labels survived', v.names.includes('mp-safe') && v.names.includes('needs-testing'), v.names.join());
  // The mod that had favourite + mp-safe keeps mp-safe; the one that had
  // favourite + needs-testing keeps needs-testing. Neither entry disappears.
  check('  a mod with another label keeps it', v.labels[A].join() === 'mp-safe', JSON.stringify(v.labels[A]));

  labels.writeLabels(FILE, { [A]: ['lonely'], [B]: ['favourite', 'needs-testing'] });
  v = labels.deleteLabel(FILE, 'lonely', known);
  check('a mod left with no labels loses its entry entirely', v.labels[A] === undefined, JSON.stringify(v.labels[A]));
  check('  so it cannot come back if the label is reused', !v.names.includes('lonely'), v.names.join());
  check('deleting a label nothing carries is refused', /no mod is labelled/.test(cap(labels.deleteLabel, FILE, 'nothing', known)));
  check('deleting nothing at all is refused', /which label/.test(cap(labels.deleteLabel, FILE, '', known)));
  check('a delete over a corrupt file is refused', (() => {
    put('{ broken');
    const m = cap(labels.deleteLabel, FILE, 'a', known);
    put(JSON.stringify({ version: 1, labels: { [A]: ['favourite'] } }));
    return /nothing was written/.test(m);
  })());

  // A name differing only in case is the same label to delete.
  labels.writeLabels(FILE, { [A]: ['Favourite'] });
  check('a delete matches without regard to case',
    labels.deleteLabel(FILE, 'favourite', known).removed === 1);
  check('  and leaves nothing behind', Object.keys(labels.readLabels(FILE, known).labels).length === 0);

  // Both honour a caller that cannot vouch for its id set.
  labels.writeLabels(FILE, { [A]: ['favourite'], 'someone-elses': ['other'] });
  const deferred = labels.readLabels(FILE, null);
  check('an unvouched set keeps the entry during a read', Object.keys(deferred.labels).length === 2);
  check('  and a delete only touches what it can see',
    labels.deleteLabel(FILE, 'other', null).removed === 1 && !labels.readLabels(FILE, null).labels['someone-elses']);
}

function cap(fn, ...args) {
  try { fn(...args); return ''; } catch (e) { return e.message; }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n============================================================');
console.log(pass ? 'LABELS: ALL CHECKS PASSED' : 'LABELS: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
