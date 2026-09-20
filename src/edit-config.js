'use strict';

// CLI for editing a .Civ6Cfg. The Phase 3 web UI will shell out to this.
//
//   node src/edit-config.js --config "<path.Civ6Cfg>" \
//        --add "<id or name>" --add "<id or name>" \
//        --remove "<id or name>" \
//        [--out "<path>"] [--dry-run] [--no-backup]
//
// Add tokens are resolved against the installed-mod inventory (by GUID, exact
// name, or unique name substring). Remove tokens may be a GUID or a name of a
// currently-enabled mod.

const fs = require('fs');
const paths = require('./paths');
const cfg = require('./civ6cfg');
const { scanMods, normId } = require('./modinfo');
const { humanTitle } = require('./inventory');
const { saveConfig } = require('./editor');

function parseArgs(argv) {
  const out = { adds: [], removes: [], backup: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--add') out.adds.push(argv[++i]);
    else if (a === '--remove') out.removes.push(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-backup') out.backup = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.config) throw new Error('--config is required');
  return out;
}

function resolveInstalled(token, installed) {
  const t = token.trim();
  const byId = installed.find((m) => m.idNorm === normId(t));
  if (byId) return byId;
  const byName = installed.filter((m) => m.name.toLowerCase() === t.toLowerCase());
  if (byName.length === 1) return byName[0];
  const bySub = installed.filter((m) => m.name.toLowerCase().includes(t.toLowerCase()));
  if (bySub.length === 1) return bySub[0];
  if (bySub.length > 1) {
    throw new Error(`"${token}" matches ${bySub.length} mods: ${bySub.map((m) => m.name).join(', ')}`);
  }
  return null;
}

function resolveEnabled(token, enabled) {
  const t = token.trim();
  const byId = enabled.find((m) => normId(m.id) === normId(t));
  if (byId) return { id: byId.id, name: humanTitle(byId.title) };
  const byName = enabled.filter((m) => (humanTitle(m.title) || '').toLowerCase() === t.toLowerCase());
  if (byName.length === 1) return { id: byName[0].id, name: humanTitle(byName[0].title) };
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const installed = scanMods(paths.getSources());
  const enabled = cfg.listMods(fs.readFileSync(args.config)).mods;

  const adds = [];
  for (const tok of args.adds) {
    const m = resolveInstalled(tok, installed);
    if (!m) throw new Error(`could not resolve --add "${tok}" to an installed mod`);
    if (enabled.some((e) => normId(e.id) === m.idNorm)) {
      console.log(`  (skip) "${m.name}" is already enabled`);
      continue;
    }
    adds.push({ id: m.id, name: m.name });
  }

  const removes = [];
  for (const tok of args.removes) {
    const m = resolveEnabled(tok, enabled);
    if (!m) throw new Error(`could not resolve --remove "${tok}" to an enabled mod`);
    removes.push(m.id);
  }

  if (adds.length === 0 && removes.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log(`Config : ${args.config}`);
  if (adds.length) console.log('Add    :\n' + adds.map((a) => `  + ${a.name} (${a.id})`).join('\n'));
  if (removes.length) console.log('Remove :\n' + removes.map((r) => `  - ${r}`).join('\n'));

  const summary = saveConfig(args.config, {
    adds, removes,
    outPath: args.out || args.config,
    backup: args.backup,
    dryRun: args.dryRun,
  });

  console.log('\nResult:');
  console.log(`  mods: ${summary.modsBefore} -> ${summary.modsAfter}`);
  console.log(`  bytes: ${summary.bytesBefore} -> ${summary.bytesAfter}`);
  if (summary.dryRun) console.log('  (dry run - nothing written)');
  else {
    console.log(`  written: ${summary.outPath}`);
    if (summary.backupPath) console.log(`  backup : ${summary.backupPath}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
