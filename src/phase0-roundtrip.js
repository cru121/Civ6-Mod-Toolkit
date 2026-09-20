'use strict';

// Phase 0: prove the format engine is trustworthy before we ever write a real file.
//
//  [1] Block scan       : locate MOD_BLOCK_* arrays and read their element counts.
//  [2] Mod extraction   : list every enabled mod (GUID + human title).
//  [3] Round-trip        : addMod then removeMod must return a byte-identical buffer,
//                          and addMod must re-parse with count+1 in every block.
//                          (All in-memory; nothing is written to disk.)

const fs = require('fs');
const path = require('path');
const cfg = require('./civ6cfg');

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const files = fs.readdirSync(FIX_DIR).filter((f) => /\.Civ6Cfg$/i.test(f));

const TEST_GUID = 'DEADBEEF-0000-0000-0000-000000000001';
const TEST_TITLE = '{"LOC_PHASE0_TEST":[]}';

function humanTitle(title) {
  if (!title) return '(no title)';
  try {
    const j = JSON.parse(title);
    const key = Object.keys(j)[0];
    const loc = j[key];
    if (Array.isArray(loc) && loc.length) {
      const en = loc.find((x) => x.locale === 'en_US') || loc[0];
      return en.text || key;
    }
    return key;
  } catch (_) {
    return title;
  }
}

let allPass = true;
const fail = (msg) => { allPass = false; console.log(`      !! ${msg}`); };

for (const file of files) {
  const full = path.join(FIX_DIR, file);
  const buf = fs.readFileSync(full);
  console.log('\n============================================================');
  console.log(`${file}  (${buf.length} bytes)`);
  console.log('============================================================');

  let blocks;
  try {
    blocks = cfg.parseConfig(buf).blocks;
  } catch (e) {
    fail(`parse failed: ${e.message}`);
    continue;
  }

  // [1] Block scan
  console.log('  [1] mod blocks:');
  for (const b of blocks) {
    const ok = b.count === b.mods.length;
    console.log(`        ${b.key} @${b.markerOffset}: count=${b.count}, elements=${b.mods.length} ${ok ? '' : '<-- MISMATCH'}`);
    if (!ok) fail(`${b.key} count/element mismatch`);
  }

  // [2] Mod extraction (distinct)
  const { mods } = cfg.listMods(buf);
  console.log(`  [2] distinct mods enabled: ${mods.length}`);
  for (const m of mods) {
    console.log(`        - ${m.id}  ${humanTitle(m.title)}`);
  }

  // [3] Round-trip: add then remove
  if (mods.length > 0 && blocks.length > 0) {
    try {
      const added = cfg.addMod(buf, TEST_GUID, TEST_TITLE);
      const addedBlocks = cfg.parseConfig(added).blocks;

      let addOk = true;
      for (let i = 0; i < blocks.length; i++) {
        const before = blocks[i];
        const after = addedBlocks[i];
        const hasTest = after.mods.some((m) => m.id === TEST_GUID);
        if (after.count !== before.count + 1 || !hasTest) addOk = false;
      }
      console.log(`  [3] addMod re-parses with +1 in every block : ${addOk ? 'PASS' : 'FAIL'}`);
      if (!addOk) fail('addMod did not add cleanly to every block');

      const removed = cfg.removeMod(added, TEST_GUID);
      const identical = removed.length === buf.length && removed.equals(buf);
      console.log(`  [3] add -> remove returns byte-identical file : ${identical ? 'PASS' : 'FAIL'}`);
      if (!identical) {
        const n = Math.min(removed.length, buf.length);
        let d = -1;
        for (let i = 0; i < n; i++) if (removed[i] !== buf[i]) { d = i; break; }
        fail(`byte diff at offset ${d} (0x${(d >>> 0).toString(16)}); len ${removed.length} vs ${buf.length}`);
      }
    } catch (e) {
      fail(`round-trip failed: ${e.message}`);
    }
  }
}

console.log('\n============================================================');
console.log(allPass ? 'PHASE 0: ALL CHECKS PASSED' : 'PHASE 0: FAILURES PRESENT');
console.log('============================================================');
process.exit(allPass ? 0 : 1);
