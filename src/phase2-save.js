'use strict';

// Phase 2 automated proof. Operates only on copies in a scratch dir; never
// touches the originals in fixtures/ or the user's game folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./civ6cfg');
const { normId } = require('./modinfo');
const editor = require('./editor');

const SRC = path.join(__dirname, '..', 'fixtures', 'kupe arborea.Civ6Cfg');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'civ6cfg-phase2-'));

const ADD = [
  { id: '8f4fb7ec-4a96-4d5e-b965-7d7f4eac12de', name: 'Terra Mirabilis (2026 update)' },
  { id: 'a2c4e6f8-1b3d-4c5e-8a9b-0c1d2e3f4a5b', name: 'Winterize Snow Production (PoC)' },
];
const REMOVE = ['382a187f-c8ba-4094-a6a7-0d5315661f33']; // Extended Policy Cards (enabled)

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};

console.log(`scratch dir: ${TMP}\n`);

// --- Test 1: dry run writes nothing ----------------------------------------
console.log('Test 1: dry run');
const work1 = path.join(TMP, 'kupe.Civ6Cfg');
fs.copyFileSync(SRC, work1);
const before = fs.readFileSync(work1);
const s1 = editor.saveConfig(work1, { adds: ADD, removes: REMOVE, dryRun: true });
check('dry run reports mod delta', s1.modsAfter === s1.modsBefore + ADD.length - REMOVE.length,
  `${s1.modsBefore} -> ${s1.modsAfter}`);
check('dry run left file byte-identical', fs.readFileSync(work1).equals(before));
check('dry run created no backup', fs.readdirSync(TMP).filter((f) => f.includes('.bak-')).length === 0);

// --- Test 2: real save with backup + validation -----------------------------
console.log('\nTest 2: real in-place save');
const s2 = editor.saveConfig(work1, { adds: ADD, removes: REMOVE });
check('write happened', s2.written);
check('backup created', !!s2.backupPath && fs.existsSync(s2.backupPath));
check('backup equals pre-edit bytes', fs.readFileSync(s2.backupPath).equals(before));

const edited = fs.readFileSync(work1);
const blocks = cfg.parseConfig(edited).blocks;
const norms = blocks.map((b) => new Set(b.mods.map((m) => normId(m.id))));
check('added mods present in every block', norms.every((set) => ADD.every((a) => set.has(normId(a.id)))));
check('removed mod absent in every block', norms.every((set) => REMOVE.every((r) => !set.has(normId(r)))));
check('block count == element count', blocks.every((b) => b.count === b.mods.length));

// --- Test 3: titles mirror the {"name":[]} style ----------------------------
console.log('\nTest 3: title style');
const enabled = cfg.listMods(edited).mods;
const tm = enabled.find((m) => normId(m.id) === normId(ADD[0].id));
check('added title uses {"name":[]}', tm && tm.title === JSON.stringify({ [ADD[0].name]: [] }),
  tm ? tm.title : '(missing)');

// --- Test 4: add-only edit is byte-reversible -------------------------------
console.log('\nTest 4: add-only reversibility');
const work2 = path.join(TMP, 'kupe2.Civ6Cfg');
fs.copyFileSync(SRC, work2);
const orig2 = fs.readFileSync(work2);
editor.saveConfig(work2, { adds: ADD, backup: false });
let back = fs.readFileSync(work2);
for (const a of ADD) back = cfg.removeMod(back, a.id);
check('add then programmatic remove returns to original bytes', back.equals(orig2));

// --- Test 5: out-path (non-destructive copy) --------------------------------
console.log('\nTest 5: save to a separate out path');
const work3 = path.join(TMP, 'kupe3.Civ6Cfg');
fs.copyFileSync(SRC, work3);
const outp = path.join(TMP, 'kupe3 + mods.Civ6Cfg');
const s5 = editor.saveConfig(work3, { adds: ADD, outPath: outp });
check('source untouched when writing to out path', fs.readFileSync(work3).equals(fs.readFileSync(SRC)));
check('out file created with added mods', fs.existsSync(outp) &&
  cfg.listMods(fs.readFileSync(outp)).mods.some((m) => normId(m.id) === normId(ADD[0].id)));
check('no backup when not overwriting', !s5.backupPath);

// cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n============================================================');
console.log(pass ? 'PHASE 2: ALL CHECKS PASSED' : 'PHASE 2: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
