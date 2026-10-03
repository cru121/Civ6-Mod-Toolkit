'use strict';

// Command-line mod manager for Civ6 (for scripts and AI agents; see CLAUDE.md).
// Output is always JSON on stdout; exit code is non-zero on any error.
//
//   node src/mods-cli.js status
//   node src/mods-cli.js list [--enabled|--disabled] [--search text] [--source workshop|local|dlc]
//   node src/mods-cli.js enable  <id|name> [<id|name> ...] [--dry-run]
//   node src/mods-cli.js disable <id|name> [<id|name> ...] [--dry-run]

const fs = require('fs');
const paths = require('./paths');
const { normId } = require('./modinfo');
const { applyChanges } = require('./modsdb');
const { gameStatus } = require('./game');
const { modList } = require('./modlist');

const plain = (n) => String(n || '').replace(/\[[^\]]*\]/g, '').trim(); // drop Civ [COLOR_*] markup
const slim = (m) => ({ id: m.id, name: plain(m.name), source: m.source, enabled: m.enabled, scanned: m.scanned });

// A mod that ships a native .dll (usually a replacement GameCore) can conflict with
// other such mods and with game updates, so it is called out explicitly.
function shipsDll(m) {
  if (!m.folder) return false;
  try { return fs.readdirSync(m.folder, { recursive: true }).some((f) => /\.dll$/i.test(f)); } catch (_) { return false; }
}

// slim() plus requires / blocks (with their current state) and the DLL flag.
function detailed(m, byNorm) {
  const rel = (r) => {
    const o = byNorm.get(normId(r.id));
    return { id: r.id, name: o ? plain(o.name) : plain(r.title), enabled: o ? o.enabled : null, installed: !!o };
  };
  const out = slim(m);
  if (m.requires.length) out.requires = m.requires.map(rel);
  if (m.blocks.length) out.blocks = m.blocks.map(rel);
  if (shipsDll(m)) out.shipsGameCoreDll = true;
  return out;
}

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

function parse(argv) {
  const out = { cmd: argv[0], tokens: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--search' || a === '--source') out.flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) out.flags[a.slice(2)] = true;
    else out.tokens.push(a);
  }
  return out;
}

// GUID, exact name, or unique name substring (case-insensitive, markup ignored).
function resolve(token, mods) {
  const t = token.trim().toLowerCase();
  const byId = mods.find((m) => m.idNorm === normId(token));
  if (byId) return byId;
  const exact = mods.filter((m) => plain(m.name).toLowerCase() === t);
  if (exact.length === 1) return exact[0];
  const sub = exact.length ? exact : mods.filter((m) => plain(m.name).toLowerCase().includes(t));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) fail(`"${token}" is ambiguous; use the id`, { candidates: sub.map(slim) });
  fail(`no mod matches "${token}"`);
}

async function main() {
  const { cmd, tokens, flags } = parse(process.argv.slice(2));
  if (!['status', 'list', 'enable', 'disable'].includes(cmd)) {
    fail('usage: mods-cli.js status | list [--enabled|--disabled] [--search t] [--source s] | enable|disable <id|name>... [--dry-run]');
  }

  const game = await gameStatus();
  const list = modList();

  if (cmd === 'status') {
    const modsDb = paths.getModsDb();
    const counts = { total: 0, enabled: 0, disabled: 0, notScanned: 0 };
    for (const m of list.mods) {
      counts.total++;
      if (!m.scanned) counts.notScanned++;
      else if (m.enabled === true) counts.enabled++;
      else if (m.enabled === false) counts.disabled++;
    }
    const dll = list.mods.filter((m) => m.enabled === true && shipsDll(m)).map((m) => plain(m.name));
    const warnings = [];
    if (dll.length) warnings.push(`${dll.length} enabled mod(s) ship a native DLL / replace GameCore: ${dll.join(', ')}`);
    return console.log(JSON.stringify({
      ok: list.ok, error: list.error, gameRunning: game.running, modsDb: modsDb.path,
      activeGroup: list.activeGroup, counts, warnings,
    }, null, 2));
  }

  if (!list.ok) fail(list.error || 'could not read the mod database');
  const byNorm = new Map(list.mods.map((m) => [m.idNorm, m]));

  if (cmd === 'list') {
    let mods = list.mods;
    if (flags.enabled) mods = mods.filter((m) => m.enabled === true);
    if (flags.disabled) mods = mods.filter((m) => m.enabled === false);
    if (flags.source) mods = mods.filter((m) => m.source === flags.source);
    if (flags.search) mods = mods.filter((m) => plain(m.name).toLowerCase().includes(String(flags.search).toLowerCase()));
    return console.log(JSON.stringify({ ok: true, gameRunning: game.running, count: mods.length, mods: mods.map((m) => detailed(m, byNorm)) }, null, 2));
  }

  // enable / disable
  if (!tokens.length) fail(`${cmd} needs at least one mod id or name`);
  const want = cmd === 'enable';
  const picked = tokens.map((t) => resolve(t, list.mods));
  for (const m of picked) {
    if (!m.scanned) fail(`"${plain(m.name)}" is installed but the game hasn't scanned it yet (start Civ6 once)`);
    if (m.enabled == null) fail(`"${plain(m.name)}" is not in the active mod group, so it can't be toggled`);
  }
  const todo = picked.filter((m) => m.enabled !== want);
  // State after the change, to spot broken dependencies and GameCore conflicts.
  const after = new Map(list.mods.map((m) => [m.idNorm, m.enabled]));
  for (const m of todo) after.set(m.idNorm, want);
  const on = (idNorm) => after.get(idNorm) === true;
  const warnings = [];
  for (const m of todo) {
    if (want) {
      for (const r of m.requires) if (!on(normId(r.id))) warnings.push(`"${plain(m.name)}" requires "${plain(r.title)}", which is not enabled`);
      for (const b of m.blocks) if (on(normId(b.id))) warnings.push(`"${plain(m.name)}" blocks "${plain(b.title)}", which is enabled`);
    } else {
      for (const o of list.mods) {
        if (on(o.idNorm) && o.requires.some((r) => normId(r.id) === m.idNorm)) warnings.push(`enabled mod "${plain(o.name)}" requires "${plain(m.name)}"`);
      }
    }
  }
  const dllOn = list.mods.filter((m) => on(m.idNorm) && shipsDll(m));
  if (dllOn.length > 1) warnings.push(`${dllOn.length} enabled mods ship a native DLL / replace GameCore (${dllOn.map((m) => plain(m.name)).join(', ')}); they may conflict`);
  const result = {
    ok: true, action: cmd, dryRun: !!flags['dry-run'],
    changed: todo.map((m) => detailed(m, byNorm)), alreadyInState: picked.filter((m) => m.enabled === want).map(slim),
    warnings,
  };
  if (!todo.length || flags['dry-run']) return console.log(JSON.stringify(result, null, 2));
  if (game.running) fail('Civilization VI is running. Ask the user to close it, then retry.');

  const r = applyChanges(list.modsDb.path, todo.map((m) => ({ modId: m.id, enabled: want })));
  console.log(JSON.stringify({ ...result, backup: r.backupPath, group: r.group }, null, 2));
}

main().catch((e) => fail(e.message));
