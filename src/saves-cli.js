'use strict';

// Command-line saved-game mod tool for Civ6 (for scripts and AI agents; see CLAUDE.md).
// Output is always JSON on stdout; exit code is non-zero on any error.
//
//   node src/saves-cli.js list [--search text]
//   node src/saves-cli.js check  <save>                       # mods in the save + what's wrong
//   node src/saves-cli.js add    <save> <id|name> [...] [--dry-run] [--overwrite] [--as <new name>]
//   node src/saves-cli.js remove <save> <id|name> [...] [--dry-run] [--overwrite] [--as <new name>]

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { normId } = require('./modinfo');
const civ6save = require('./civ6save');
const { listSaves, isSavePath, saveMods, editSave } = require('./savelist');

const plain = (n) => String(n || '').replace(/\[[^\]]*\]/g, '').trim(); // drop Civ [COLOR_*] markup

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

function parse(argv) {
  const out = { cmd: argv[0], tokens: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--search' || a === '--as') out.flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) out.flags[a.slice(2)] = true;
    else out.tokens.push(a);
  }
  return out;
}

const slimSave = (s) => ({ name: s.name, folder: s.folder || null, path: s.path, sizeKB: Math.round(s.size / 1024), modified: new Date(s.modified).toISOString() });

// Full path, file name (with or without .Civ6Save, optionally "auto/<name>"), or unique name substring.
function resolveSave(token) {
  if (path.isAbsolute(token) && isSavePath(token) && fs.existsSync(token)) return path.resolve(token);
  const { saves } = listSaves();
  const t = token.trim().toLowerCase().split(path.sep).join('/').replace(/\.civ6save$/, '');
  const full = (s) => ((s.folder ? s.folder + '/' : '') + s.name).toLowerCase().replace(/\.civ6save$/, '');
  const exact = saves.filter((s) => full(s) === t || s.name.toLowerCase().replace(/\.civ6save$/, '') === t);
  const hits = exact.length ? exact : saves.filter((s) => full(s).includes(t));
  if (hits.length === 1) return hits[0].path;
  if (hits.length > 1) fail(`"${token}" is ambiguous; use the full path`, { candidates: hits.map(slimSave) });
  fail(`no saved game matches "${token}"`);
}

// GUID, exact name, or unique name substring (case-insensitive, markup ignored).
function resolveMod(token, mods, where) {
  const t = token.trim().toLowerCase();
  const byId = mods.find((m) => m.idNorm === normId(token));
  if (byId) return byId;
  const exact = mods.filter((m) => plain(m.name).toLowerCase() === t);
  if (exact.length === 1) return exact[0];
  const sub = exact.length ? exact : mods.filter((m) => plain(m.name).toLowerCase().includes(t));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) fail(`"${token}" is ambiguous; use the id`, { candidates: sub.map(slimMod) });
  fail(`no mod matches "${token}" ${where}`);
}

const slimMod = (m) => ({ id: m.id, name: plain(m.name), kind: m.kind, source: m.source, enabled: m.enabled });

function main() {
  const { cmd, tokens, flags } = parse(process.argv.slice(2));
  if (!['list', 'check', 'add', 'remove'].includes(cmd)) {
    fail('usage: saves-cli.js list [--search t] | check <save> | add|remove <save> <id|name>... [--dry-run] [--overwrite] [--as <new name>]');
  }

  if (cmd === 'list') {
    const l = listSaves();
    let saves = l.saves;
    if (flags.search) saves = saves.filter((s) => s.name.toLowerCase().includes(String(flags.search).toLowerCase()));
    return console.log(JSON.stringify({ ok: true, savesRoot: l.savesRoot, count: saves.length, saves: saves.map(slimSave) }, null, 2));
  }

  if (!tokens.length) fail(`${cmd} needs a saved game (file name or path)`);
  const savePath = resolveSave(tokens[0]);
  const buf = fs.readFileSync(savePath);
  let info;
  try { info = saveMods(buf); } catch (e) { fail(`could not read the save: ${e.message}`); }
  const editable = civ6save.roundTrips(buf);

  if (cmd === 'check') {
    // A mod the save asks for that isn't installed is what usually stops a save from loading.
    const notInstalled = info.mods.filter((m) => m.kind === 'unknown');
    const warnings = [];
    if (notInstalled.length) warnings.push(`${notInstalled.length} mod(s) in this save are not installed (${notInstalled.map((m) => plain(m.name)).join(', ')}); the save may refuse to load until they are installed or removed from it`);
    if (!editable) warnings.push("this save's header can't be re-written byte-for-byte, so add/remove will refuse to edit it");
    return console.log(JSON.stringify({
      ok: true, save: slimSave({ ...listSaves().saves.find((s) => s.path === savePath), }), editable,
      kinds: 'official = DLC/expansion (locked); ui = AffectsSavedGames=0 (safe); gameplay = changes game content (may break loading); unknown = not installed',
      mods: info.mods.map(slimMod),
      addable: info.available.map((m) => ({ id: m.id, name: plain(m.name), kind: m.kind, source: m.source })),
      warnings,
    }, null, 2));
  }

  // add / remove
  const rest = tokens.slice(1);
  if (!rest.length) fail(`${cmd} needs at least one mod id or name`);
  const adding = cmd === 'add';
  const picked = rest.map((t) => (adding ? resolveMod(t, info.available, 'among installed mods that are not in this save')
    : resolveMod(t, info.mods, 'in this save')));
  if (!adding) {
    const off = picked.find((m) => m.kind === 'official');
    if (off) fail(`"${plain(off.name)}" is official game content and can't be removed from a save`);
  }
  const mode = flags.overwrite ? 'overwrite' : 'new';
  let r;
  try {
    r = editSave(savePath, {
      [adding ? 'add' : 'remove']: picked.map((m) => m.id),
      mode, newName: flags.as, dryRun: !!flags['dry-run'],
    });
  } catch (e) {
    fail(e.message, e.problems ? { problems: e.problems } : {});
  }
  const warnings = picked.filter((m) => m.kind !== 'ui').map((m) =>
    `"${plain(m.name)}" is ${m.kind === 'unknown' ? 'not installed (unknown effect)' : 'a gameplay mod'}: the edited save may fail to load`);
  console.log(JSON.stringify({
    ok: true, action: cmd, dryRun: r.dryRun, mode,
    changed: picked.map(slimMod), output: r.outPath, backup: r.backupPath,
    modsBefore: r.modsBefore, modsAfter: r.modsAfter, warnings,
    note: r.dryRun ? undefined : (mode === 'new' ? 'Original untouched; the edited copy was written next to it.' : 'Original overwritten; backup kept.'),
  }, null, 2));
}

try { main(); } catch (e) { fail(e.message); }
