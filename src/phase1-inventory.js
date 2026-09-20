'use strict';

// Phase 1: scan mod sources, build the installed inventory, and diff a config
// against it. Read-only.
//
// Usage:
//   node src/phase1-inventory.js                     # diff the bundled fixture
//   node src/phase1-inventory.js "path/to/x.Civ6Cfg" # diff a specific config

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { scanMods } = require('./modinfo');
const { diff } = require('./inventory');

const argConfig = process.argv[2];
const defaultConfig = path.join(__dirname, '..', 'fixtures', 'kupe arborea.Civ6Cfg');
const configPath = argConfig || defaultConfig;

console.log('=== Mod sources ===');
const sources = paths.getSources();
for (const s of sources) {
  console.log(`  [${s.exists ? 'ok ' : 'MISSING'}] ${s.type.padEnd(8)} ${s.root || '(not found)'}`);
}
const saves = paths.getSavesDir();
console.log(`  [${saves.exists ? 'ok ' : 'MISSING'}] saves    ${saves.root}`);

console.log('\n=== Installed mods (scanned) ===');
const installed = scanMods(sources);
const byType = installed.reduce((a, m) => ((a[m.type] = (a[m.type] || 0) + 1), a), {});
console.log(`  total ${installed.length}  (${Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
for (const m of installed) {
  console.log(`    - ${m.idNorm}  [${m.type}]  ${m.name}`);
}

console.log(`\n=== Diff against: ${path.basename(configPath)} ===`);
const buf = fs.readFileSync(configPath);
const d = diff(buf, installed);

console.log(`\n  Enabled in config: ${d.enabled.length}`);
console.log(`  ├─ installed (removable): ${d.enabledInstalled.length}`);
console.log(`  └─ not found in folders (likely official DLC or uninstalled): ${d.enabledMissing.length}`);

console.log(`\n  >>> INSTALLED BUT NOT ENABLED  (candidates to add): ${d.availableToAdd.length}`);
for (const m of d.availableToAdd) {
  console.log(`        + ${m.idNorm}  [${m.type}]  ${m.name}`);
}

console.log(`\n  Enabled AND installed (could be removed): ${d.enabledInstalled.length}`);
for (const m of d.enabledInstalled) {
  console.log(`        - ${m.idNorm}  ${m.installed.name}`);
}

console.log(`\n  Enabled but NOT installed here: ${d.enabledMissing.length}`);
for (const m of d.enabledMissing.slice(0, 8)) {
  console.log(`        ? ${m.idNorm}  ${m.title || ''}`);
}
if (d.enabledMissing.length > 8) console.log(`        ... and ${d.enabledMissing.length - 8} more`);
