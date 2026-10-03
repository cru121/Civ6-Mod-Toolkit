'use strict';

// What the three command-line tools (mods-cli.js, saves-cli.js, config-cli.js)
// share, so they take the same arguments and answer in the same shape.
//
// Common grammar:
//   list   [--search t]                      what exists
//   check  [<target>]                        what is in it, and what is wrong
//   add    <target> <mod>... [--dry-run] [--overwrite] [--as <name>]   (saves, configs)
//   remove <target> <mod>... [--dry-run] [--overwrite] [--as <name>]   (saves, configs)
//   enable|disable <mod>... [--dry-run]                                (mods-cli only)
//
// Every answer is JSON on stdout with `ok`; the exit code is non-zero on error.

const { normId } = require('./modinfo');

// Civ text markup ([COLOR_GREEN], [ICON_*]...) has no place in a name shown or matched.
const plain = (n) => String(n || '').replace(/\[[^\]]*\]/g, '').trim();

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(message, extra = {}) {
  print({ ok: false, error: message, ...extra });
  process.exit(1);
}

// argv[0] is the command. Flags in `valueFlags` take the next argument; any other
// --flag is a boolean; everything else is a positional token.
function parse(argv, valueFlags = []) {
  const out = { cmd: argv[0], tokens: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a.slice(2))) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      out.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) out.flags[a.slice(2)] = true;
    else out.tokens.push(a);
  }
  return out;
}

// GUID, exact name, or unique part of a name (case-insensitive, markup ignored).
// `mods` are { id, idNorm, name, ... }. `describe` shapes the candidates of an
// ambiguous match; `where` finishes "no mod matches ...".
function resolveMod(token, mods, { where = '', describe = (m) => ({ id: m.id, name: plain(m.name) }) } = {}) {
  const t = token.trim().toLowerCase();
  const byId = mods.find((m) => m.idNorm === normId(token));
  if (byId) return byId;
  const exact = mods.filter((m) => plain(m.name).toLowerCase() === t);
  if (exact.length === 1) return exact[0];
  const sub = exact.length ? exact : mods.filter((m) => plain(m.name).toLowerCase().includes(t));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) fail(`"${token}" is ambiguous; use the id`, { candidates: sub.map(describe) });
  return fail(`no mod matches "${token}"${where ? ' ' + where : ''}`);
}

module.exports = { plain, print, fail, parse, resolveMod };
