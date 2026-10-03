'use strict';

// Command-line .Civ6Cfg (game configuration) mod tool for Civ6 (for scripts and AI agents; see CLAUDE.md).
// Output is always JSON on stdout; exit code is non-zero on any error.
// Same verbs as saves-cli.js:
//
//   node src/config-cli.js list [--search text]
//   node src/config-cli.js check  <config>                       # mods in the config + what can be added
//   node src/config-cli.js add    <config> <id|name> [...] [--dry-run] [--overwrite] [--as <new name>]
//   node src/config-cli.js remove <config> <id|name> [...] [--dry-run] [--overwrite] [--as <new name>]
//
// <config> is a full path, a file name (with or without .Civ6Cfg) or a unique part of one.
// add matches installed mods that are not in the config; remove matches mods that are.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const cfg = require('./civ6cfg');
const { scanMods } = require('./modinfo');
const inventory = require('./inventory');
const editor = require('./editor');
const { readModState } = require('./modsdb');
const { plain, print, fail, parse, resolveMod } = require('./cli-common');

const isConfigPath = (p) => /\.Civ6Cfg$/i.test(p);
const stem = (n) => n.replace(/\.civ6cfg$/i, '');

function listConfigs() {
  const dir = paths.getSavesDir();
  const out = [];
  if (dir.exists) {
    for (const f of fs.readdirSync(dir.root)) {
      if (!isConfigPath(f)) continue;
      const full = path.join(dir.root, f);
      let mods = null;
      try { mods = cfg.listMods(fs.readFileSync(full)).mods.length; } catch (_) { /* unreadable: leave null */ }
      out.push({ name: f, path: full, mods });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { root: dir.root, configs: out };
}

function resolveConfig(token) {
  if (path.isAbsolute(token) && isConfigPath(token) && fs.existsSync(token)) return path.resolve(token);
  const { configs } = listConfigs();
  const t = stem(token.trim().toLowerCase());
  const exact = configs.filter((c) => stem(c.name.toLowerCase()) === t);
  const hits = exact.length ? exact : configs.filter((c) => c.name.toLowerCase().includes(t));
  if (hits.length === 1) return hits[0].path;
  if (hits.length > 1) fail(`"${token}" is ambiguous; use the full path`, { candidates: hits });
  return fail(`no configuration matches "${token}"`);
}

const slimMod = (m) => ({ id: m.id, name: plain(m.name), type: m.type, installed: m.installed });

function main() {
  const { cmd, tokens, flags } = parse(process.argv.slice(2), ['search', 'as']);
  if (!['list', 'check', 'add', 'remove'].includes(cmd)) {
    fail('usage: config-cli.js list [--search t] | check <config> | add|remove <config> <id|name>... [--dry-run] [--overwrite] [--as <new name>]');
  }

  if (cmd === 'list') {
    const l = listConfigs();
    let configs = l.configs;
    if (flags.search) configs = configs.filter((c) => c.name.toLowerCase().includes(String(flags.search).toLowerCase()));
    return print({ ok: true, savesRoot: l.root, count: configs.length, configs });
  }

  if (!tokens.length) fail(`${cmd} needs a configuration (file name or path)`);
  const cfgPath = resolveConfig(tokens[0]);
  const buf = fs.readFileSync(cfgPath);
  const installed = scanMods(paths.getSources());
  const modsDb = paths.getModsDb();
  const dbState = modsDb.exists ? readModState(modsDb.path) : { ok: false, mods: [] };
  const scanned = dbState.ok ? new Set(dbState.mods.map((m) => m.idNorm)) : null;
  let view;
  try { view = inventory.configView(buf, installed, scanned); } catch (e) { fail(`could not read the configuration: ${e.message}`); }

  if (cmd === 'check') {
    const missing = view.enabled.filter((m) => !m.installed);
    const unscanned = view.availableToAdd.filter((m) => m.scanned === false);
    const warnings = [];
    if (missing.length) warnings.push(`${missing.length} mod(s) in this configuration are not installed (${missing.map((m) => plain(m.name)).join(', ')})`);
    if (unscanned.length) warnings.push(`${unscanned.length} installed mod(s) are unknown to the game (not scanned yet): adding one can make the game reject the configuration`);
    return print({
      ok: true, config: { name: path.basename(cfgPath), path: cfgPath },
      mods: view.enabled.map(slimMod),
      addable: view.availableToAdd.map((m) => ({ id: m.id, name: plain(m.name), type: m.type, scanned: m.scanned })),
      warnings,
    });
  }

  // add / remove
  const rest = tokens.slice(1);
  if (!rest.length) fail(`${cmd} needs at least one mod id or name`);
  const adding = cmd === 'add';
  const pool = adding ? view.availableToAdd : view.enabled;
  const where = adding ? 'among installed mods that are not in this configuration' : 'in this configuration';
  const picked = rest.map((t) => resolveMod(t, pool, { where, describe: slimMod }));

  const warnings = [];
  if (adding) {
    for (const m of picked) {
      if (m.scanned === false) warnings.push(`"${plain(m.name)}" is not in the game's mod database yet (not scanned): a configuration listing a mod the game does not know can be rejected, resetting settings. With Civ6 closed, click "Rescan & add new mods" on the dashboard (web UI) to register it first.`);
    }
  }

  const mode = flags.overwrite ? 'overwrite' : 'new';
  let outPath = cfgPath;
  if (mode === 'new') {
    let base = path.basename(String(flags.as || '').trim());
    if (!base) base = stem(path.basename(cfgPath)) + ' (edited)';
    if (!isConfigPath(base)) base += '.Civ6Cfg';
    outPath = path.join(path.dirname(cfgPath), base);
    if (fs.existsSync(outPath)) fail(`file already exists: ${base}`);
  }

  let r;
  try {
    r = editor.saveConfig(cfgPath, {
      adds: adding ? picked.map((m) => ({ id: m.id, name: m.name })) : [],
      removes: adding ? [] : picked.map((m) => m.id),
      outPath, backup: mode === 'overwrite', dryRun: !!flags['dry-run'],
    });
  } catch (e) {
    fail(e.message, e.problems ? { problems: e.problems } : {});
  }
  print({
    ok: true, action: cmd, dryRun: r.dryRun, mode,
    changed: picked.map(slimMod), output: r.outPath, backup: r.backupPath,
    modsBefore: r.modsBefore, modsAfter: r.modsAfter, warnings,
    note: r.dryRun ? undefined : (mode === 'new' ? 'Original untouched; the edited copy was written next to it.' : 'Original overwritten; backup kept.'),
  });
}

try { main(); } catch (e) { fail(e.message); }
