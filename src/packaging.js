'use strict';

// Static packaging checks over Mods.sqlite.
//
// Four checks, each naming the mod (display name), the file or action, and a
// plain-words reason:
//
//   (a) detectUnregisteredFiles — files no action references: ModFiles rows
//       with no ComponentFiles/SettingFiles link (the .modinfo lists them but
//       no action loads them), plus files sitting in the mod folder that the
//       .modinfo does not list at all (so no action can load them).
//   (b) detectSchemaMismatch — a database file loaded by an action whose
//       database lacks its tables. The file's tables are parsed out (SQL
//       INTO/FROM/JOIN/UPDATE plus XML table wrappers and <Sql> blocks) and
//       compared against the gameplay vs front-end table sets mined read-only
//       from the debug sqlite masters. A file only warns when one of its
//       tables provably lives in the OTHER database and not in its own:
//       tables in both stay silent (shared text tables are legit on either
//       side), tables in neither stay silent (a mod-made table proves
//       nothing), and when a debug master is absent its whole side stays
//       silent — never guessed.
//   (c) detectDuplicateModIds — one ModId claimed by more than one mod folder.
//   (d) detectXmlIssues — GameData XML no action can load as written:
//       malformed XML plus structural faults, each naming the offending tag.
//
// Read-only: every Mods.sqlite query below is a SELECT, and the debug masters
// are opened with node:sqlite { readOnly: true } and only listed for their
// table names. Callers pass the Mods.sqlite handle in; the disk layer only
// lists files under caller-/database-resolved mod folders and reads linked
// database files, never writes.
//
// Conventions mirror the mod manager and the shadowing layer:
//   - mod folder = dirname of the recorded ScannedFiles path, resolved
//     read-only exactly the way findRemoved/removeMods in modsdb.js do it;
//   - mod identity = modinfo.normId (lowercase, brace-stripped, trimmed), the
//     manager's own key for matching disk mods against database rows;
//   - display names = shadowing.modIndex (the same reader every screen shows);
//   - base-game/DLC rows never warn alone: a warning fires only when a real
//     (local/workshop) mod is involved, the same silence rule as
//     detectWrongContext in shadowing.js.
// Profile scoping: every check covers the ACTIVE profile's enabled mods
// (enabledModRowIds/activeGroupId, the same scoping as the shadowing
// enumeration). A mod switched off cannot affect the game, so its findings
// are skipped by design; without an active profile nothing is filtered.
// Findings present in load order: each mod ranks by its smallest LoadOrder,
// ties break by mod id, undeclared mods sort last. The LoadOrder values are
// read from the database rows the game will use — overrides are written
// into those rows by the load-order screen, so they are effective
// post-override values with no store read here.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const iconv = require('iconv-lite');
const { modIndex, activeGroupId, enabledModRowIds, parseLoadOrderValue } = require('./shadowing');
const { classifyPath } = require('./modsdb');
const { normId } = require('./modinfo');
const paths = require('./paths');

// Slash-unify and trim so `UI\Panel.lua` and `UI/Panel.lua` join on one key.
// Case is preserved, same as shadowing.normalizePath.
function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').trim();
}

function fileExt(p) {
  const base = String(p == null ? '' : p).split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

// Extensions an action can actually load. Only these ride actions anywhere
// in the codebase: .sql/.xml into UpdateDatabase/UpdateText (the replay runs
// only those two, see collectConflictModSet), .lua into the script actions
// (AddGameplayScripts/GameplayScripts/AddUIScript/AddUserInterfaces) and the
// LuaReplace targets, with .xml alongside .lua as the screen/layout pair
// (see shadowing.js). Art, audio, model and platform files (.artdef, .blp,
// .dds, .wem, ...) load through the engine, never through an action, so
// flagging them floods real libraries while proving nothing. When in doubt
// this set misses a weird-but-real case rather than re-flooding; a linked
// file of any extension still counts as used and stays silent.
const LOADABLE_EXTS = new Set(['sql', 'xml', 'lua']);

// Platform asset roots, never actionable content: mods ship per-OS asset
// trees (e.g. MacOS/BLPs) that the engine resolves itself. Matched per path
// segment, case-insensitive, so a file merely named like one still counts.
const SILENT_DIR_SEGMENTS = new Set(['macos', '__macosx', 'windows', 'linux', 'platforms', 'platform']);

function isSilentDirPath(p) {
  const segs = String(p == null ? '' : p).replace(/\\/g, '/').split('/');
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (SILENT_DIR_SEGMENTS.has(segs[i].toLowerCase())) return true;
  }
  return false;
}

function isLoadableFile(p) {
  if (isSilentDirPath(p)) return false;
  return LOADABLE_EXTS.has(fileExt(p));
}

// Actions whose files the game reads as database content. Same pair as the
// DATA_ACTION_TYPES doctrine in shadowing.js: only these types provably load
// a .sql file as data on their side of the in-game/front-end mirror.
const DATABASE_ACTION_TYPES = new Set(['UpdateDatabase', 'UpdateText']);

// A mod the warnings hold accountable: user content with a folder on disk.
// Base-game/DLC rows (relative ../../../ paths) are the game's own content,
// not packaging the user can fix.
function isRealMod(dir) {
  return !!dir && (dir.kind === 'local' || dir.kind === 'workshop');
}

// ModRowId -> { folder, recordedPath, kind }. The folder is the dirname of
// the recorded .modinfo path, read-only, exactly like findRemoved/removeMods
// resolve it. A database without the ScannedFiles linkage resolves nothing.
function modFolders(db) {
  const out = new Map();
  try {
    for (const r of db.prepare(
      `SELECT m.ModRowId AS rowId, s.Path AS path
         FROM Mods m JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId`
    ).all()) {
      const recorded = String(r.path == null ? '' : r.path).replace(/\\/g, '/');
      const slash = recorded.lastIndexOf('/');
      out.set(r.rowId, {
        folder: slash < 0 ? '' : recorded.slice(0, slash),
        recordedPath: recorded,
        kind: classifyPath(recorded),
      });
    }
  } catch (_) {
    // No linkage, no folders; checks that need one stay silent (see below).
  }
  return out;
}

// Files under a mod folder, as mod-relative slash paths. Directories are
// skipped; everything else is listed. The .modinfo descriptor itself is left
// to the caller: it lives in every folder but is never action content.
function listModFolderFiles(folder) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Platform asset roots stay silent and un-walked: nothing under them
        // can be action content, and large trees live there.
        if (SILENT_DIR_SEGMENTS.has(e.name.toLowerCase())) continue;
        walk(full, relPath);
      } else if (e.isFile()) out.push(relPath.split(path.sep).join('/'));
    }
  };
  walk(folder, '');
  return out;
}

function addToSet(map, key, value) {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  s.add(value);
}

// Load-order rank per mod, for presenting findings in load order. byRow maps
// ModRowId -> smallest LoadOrder across its components; byMod maps the exact
// ModId string -> smallest LoadOrder across every row carrying it. Only the
// correctly spelled, integer-parsable LoadOrder counts (the winner rule's own
// parse); a mod declaring nothing ranks last via rankOf. Reads the database
// rows the game will use, so overrides already applied are reflected.
// Tolerant: without the action tables every finding ranks last.
function loadPositions(db) {
  const byRow = new Map();
  const byMod = new Map();
  try {
    const rows = db.prepare(
      `SELECT c.ModRowId AS modRowId, m.ModId AS modId, p.Value AS value
         FROM ComponentProperties p
         JOIN Components c ON c.ComponentRowId = p.ComponentRowId
         JOIN Mods m ON m.ModRowId = c.ModRowId
        WHERE p.Name = 'LoadOrder'`
    ).all();
    for (const r of rows) {
      const n = parseLoadOrderValue(r.value);
      if (n === null) continue;
      const cur = byRow.get(r.modRowId);
      if (cur === undefined || n < cur) byRow.set(r.modRowId, n);
      const mid = String(r.modId);
      const curm = byMod.get(mid);
      if (curm === undefined || n < curm) byMod.set(mid, n);
    }
  } catch (_) {
    // No ordering without the action tables.
  }
  return { byRow, byMod };
}

// A mod's load-order rank, or Infinity when it declares none (sorts last).
function rankOf(map, key) {
  const v = map.get(key);
  return v === undefined ? Infinity : v;
}

// (a) Files no action references. Two sources, one finding shape:
// listed-but-unused (a ModFiles row with no action link) and on-disk-but-
// unlisted (a folder file the .modinfo never lists, so no link can exist).
//
// A same-mod LuaReplace target counts as referenced: a ReplaceUIScript
// action carries no ComponentFiles links (see phase4 Test 14), so without
// this the mod's own copy beside a LuaReplace-only override would warn
// wrongly. Settings (front-end) links count as use, like Components ones.
//
// Only local/workshop mods are read: without the ScannedFiles linkage, or
// for base/DLC rows with no folder on disk, there is nothing accountable to
// report. An unlistable folder skips the disk layer silently for that mod:
// a folder that cannot be read proves nothing. Only the active profile's
// enabled mods are read: a switched-off mod cannot affect the game, so its
// orphans stay silent by design. Findings present in load order.
function detectUnregisteredFiles(db, { folders, listFiles } = {}) {
  const tDb0 = Date.now();
  const dirs = folders || modFolders(db);
  const mods = modIndex(db);
  const walk = listFiles || listModFolderFiles;
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const pos = loadPositions(db);

  const used = new Map();
  try {
    for (const r of db.prepare(
      `SELECT c.ModRowId AS modRowId, cf.FileRowId AS fileRowId
         FROM ComponentFiles cf
         JOIN Components c ON c.ComponentRowId = cf.ComponentRowId`
    ).all()) {
      addToSet(used, r.modRowId, r.fileRowId);
    }
  } catch (_) {
    // No in-game action links without the action tables.
  }
  try {
    for (const r of db.prepare(
      `SELECT s.ModRowId AS modRowId, sf.FileRowId AS fileRowId
         FROM SettingFiles sf
         JOIN Settings s ON s.SettingRowId = sf.SettingRowId`
    ).all()) {
      addToSet(used, r.modRowId, r.fileRowId);
    }
  } catch (_) {
    // No front-end action links without the front-end tables.
  }
  const replaced = new Map();
  try {
    for (const r of db.prepare(
      `SELECT c.ModRowId AS modRowId, p.Value AS target
         FROM ComponentProperties p
         JOIN Components c ON c.ComponentRowId = p.ComponentRowId
        WHERE p.Name = 'LuaReplace'`
    ).all()) {
      addToSet(replaced, r.modRowId, normalizePath(r.target).toLowerCase());
    }
  } catch (_) {
    // No LuaReplace claims without the properties table.
  }

  let files = [];
  try {
    files = db.prepare('SELECT FileRowId AS id, ModRowId AS modRowId, Path AS path FROM ModFiles').all();
  } catch (_) {
    files = [];
  }
  const tDb1 = Date.now();
  const listedLower = new Map();
  const out = [];
  for (const f of files) {
    const dir = dirs.get(f.modRowId);
    if (!isRealMod(dir)) continue;
    if (enabled && !enabled.has(f.modRowId)) continue;
    const file = normalizePath(f.path);
    addToSet(listedLower, f.modRowId, file.toLowerCase());
    const links = used.get(f.modRowId);
    if (links && links.has(f.id)) continue;
    const targets = replaced.get(f.modRowId);
    if (targets && targets.has(file.toLowerCase())) continue;
    // Engine-loaded assets (.artdef, .blp, audio, models) and platform-dir
    // files never warn: no action could load them, so they prove nothing.
    if (!isLoadableFile(file)) continue;
    const m = mods.get(f.modRowId) || { modId: String(f.modRowId), name: String(f.modRowId) };
    out.push({
      kind: 'unregistered-file',
      modId: m.modId,
      name: m.name,
      file,
      folder: dir.folder,
      reason: 'listed by the mod but no action loads it, so it never reaches the game',
    });
  }

  const seenMods = new Set(files.map((f) => f.modRowId));
  const tWalk0 = Date.now();
  for (const modRowId of seenMods) {
    const dir = dirs.get(modRowId);
    if (!isRealMod(dir) || !dir.folder) continue;
    if (enabled && !enabled.has(modRowId)) continue;
    let onDisk;
    try {
      onDisk = walk(dir.folder);
    } catch (_) {
      continue;
    }
    if (!Array.isArray(onDisk)) continue;
    const known = listedLower.get(modRowId) || new Set();
    const m = mods.get(modRowId) || { modId: String(modRowId), name: String(modRowId) };
    for (const rel of onDisk) {
      const file = normalizePath(rel);
      if (!file || file.toLowerCase().endsWith('.modinfo')) continue;
      if (known.has(file.toLowerCase())) continue;
      if (!isLoadableFile(file)) continue;
      out.push({
        kind: 'unregistered-file',
        modId: m.modId,
        name: m.name,
        file,
        folder: dir.folder,
        reason: 'sits in the mod folder but the mod does not list it, so no action can load it',
      });
    }
  }

  const tWalk1 = Date.now();
  console.log(`[packaging] unregistered-files: db=${tDb1 - tDb0}ms walk=${tWalk1 - tWalk0}ms findings=${out.length}`);
  out.sort((a, b) => {
    const pa = rankOf(pos.byMod, a.modId);
    const pb = rankOf(pos.byMod, b.modId);
    if (pa !== pb) return pa - pb;
    const am = a.modId.toLowerCase();
    const bm = b.modId.toLowerCase();
    if (am !== bm) return am < bm ? -1 : 1;
    const af = a.file.toLowerCase();
    const bf = b.file.toLowerCase();
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
  return out;
}

// (c) One ModId claimed by more than one mod folder. Grouped by the mod
// manager's own identity key (modinfo.normId), so a bare case or brace
// difference does not hide a clash the manager itself would trip over. Every
// group is reported with each claimant's folder: the folders are what the
// reader must reconcile. Only groups touching the active profile's enabled
// mods fire: a pair with neither side enabled stays silent, while an
// enabled-vs-disabled pair still names both claimants so the shadow is
// visible. Groups present in load order by their earliest claimant.
function detectDuplicateModIds(db) {
  const dirs = modFolders(db);
  const mods = modIndex(db);
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const pos = loadPositions(db);
  let rows = [];
  try {
    rows = db.prepare('SELECT ModRowId AS rowId, ModId AS modId FROM Mods').all();
  } catch (_) {
    return [];
  }
  const groups = new Map();
  for (const r of rows) {
    const key = normId(r.modId);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const firing = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    if (enabled && !list.some((r) => enabled.has(r.rowId))) continue;
    list.sort((a, b) => a.rowId - b.rowId);
    firing.push({ key, list, rank: Math.min(...list.map((r) => rankOf(pos.byRow, r.rowId))) });
  }
  firing.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (a.key < b.key ? -1 : 1)));
  return firing.map(({ key, list }) => {
    const claimants = list.map((r) => {
      const m = mods.get(r.rowId) || { modId: String(r.modId), name: String(r.modId) };
      const d = dirs.get(r.rowId);
      return { modId: String(r.modId), name: m.name, folder: d ? d.folder : null };
    });
    return {
      kind: 'duplicate-mod-id',
      modId: claimants[0].modId,
      key,
      claimants,
      reason: 'is claimed by more than one mod folder, so the game cannot tell them apart',
    };
  });
}

// (d) GameData XML the game cannot load as written. Only .xml files loaded by
// database-typed actions (UpdateDatabase/UpdateText, the DATA_ACTION_TYPES
// doctrine) are read: a .xml under a script action is the screen/layout pair
// mechanism, not database content, so reading it as GameData would warn
// wrongly. Each finding names the mod (display name), the file, the offending
// tag, the line, and a plain-words reason saying what to do next.
//
// Conservative cuts, mirroring the module's doctrine: an unreadable or empty
// file proves nothing and stays silent; malformed XML stops the file at the
// first fault (structure past that point cannot be trusted); table names are
// never judged (without the game schema no table name is provably wrong).
// DLC/base rows stay silent under the module's silence rule. No XML
// dependency: mod files are decoded with the BOM-aware reader below (UTF-16
// via iconv-lite, same heuristic as the conflict-replay layer) and scanned
// with focused regexes, the repo's existing convention for small consistent
// XML (see modinfo.js).

// BOM-aware decode for mod database files: Civ6 mod files are commonly
// UTF-16. Same shapes as the conflict-replay decodeModSql: BOM detection plus
// a null-byte heuristic for BOM-less UTF-16LE, plain UTF-8 otherwise. Reading
// raw bytes (not utf8 text) is the whole point: a UTF-16 file read as UTF-8
// is mojibake that the lint would misreport as malformed XML.
function decodeModBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf));
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return iconv.decode(b.slice(2), 'utf16-le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return iconv.decode(b.slice(2), 'utf16-be');
  const probe = b.slice(0, Math.min(b.length, 4096));
  let zeros = 0;
  for (const x of probe) if (x === 0x00) zeros += 1;
  if (zeros > 0 && zeros >= probe.length * 0.1) return iconv.decode(b, 'utf16-le');
  return b.toString('utf8');
}

// One file off disk, or null when it cannot be read (missing, locked): an
// unreadable file proves nothing, so callers skip it silently.
function defaultReadFile(full) {
  try {
    return decodeModBytes(fs.readFileSync(full));
  } catch (_) {
    return null;
  }
}

// Mask a span keeping newlines, so indices and line numbers still match the
// original text after noise is blanked out.
function maskSpan(s) {
  return String(s).replace(/[^\n]/g, ' ');
}

// Blank the parts of the file that are opaque character data, not structure:
// comments, CDATA sections, raw-SQL blocks (raw SQL may hold a stray `<`, as
// in `WHERE a < b`), and processing instructions. The <Sql> open and close
// tags themselves stay: an unclosed <Sql> must still fault.
function maskXmlNoise(src) {
  let out = String(src);
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => maskSpan(m));
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => maskSpan(m));
  out = out.replace(/(<Sql\b(?:(?:"[^"]*"|'[^']*'|[^>"'])*)>)([\s\S]*?)(<\/\s*Sql\s*>)/gi,
    (m, open, inner, close) => open + maskSpan(inner) + close);
  out = out.replace(/<\?[\s\S]*?\?>/g, (m) => maskSpan(m));
  return maskDoctype(out);
}

// The DOCTYPE terminator is a bare `>`, which also appears inside internal
// subsets (`[...]`), so a regex would stop early and could expose a `<` from
// inside the subset. Scan quote- and bracket-aware instead; an unclosed
// DOCTYPE is left in place so the stray-`<` check faults it.
function maskDoctype(s) {
  let out = '';
  let pos = 0;
  for (;;) {
    const rel = s.slice(pos).search(/<!DOCTYPE/i);
    if (rel < 0) return out + s.slice(pos);
    const start = pos + rel;
    let j = start + 9;
    let quote = null;
    let depth = 0;
    let end = -1;
    for (; j < s.length; j += 1) {
      const c = s[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[') depth += 1;
      else if (c === ']') {
        if (depth > 0) depth -= 1;
      } else if (c === '>' && depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) return out + s.slice(pos);
    out += s.slice(pos, start) + maskSpan(s.slice(start, end + 1));
    pos = end + 1;
  }
}

// One element tag: quote-aware so a `>` inside an attribute value (as in
// Text="a>b") does not split the tag. The attribute group deliberately also
// matches unquoted values; quoting is not this lint's business.
const XML_TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

function lineOf(text, index) {
  let n = 1;
  const stop = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < stop; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

// Flat token list over the masked text: { close, name, attrs, self, index,
// len }. Gaps between tokens are plain character data (all noise is masked),
// examined by the well-formedness pass.
function tokenizeXml(clean) {
  XML_TAG_RE.lastIndex = 0;
  const tokens = [];
  let m;
  while ((m = XML_TAG_RE.exec(clean)) !== null) {
    tokens.push({
      close: m[1] === '/',
      name: m[2],
      attrs: m[3],
      self: m[4] === '/',
      index: m.index,
      len: m[0].length,
    });
  }
  return tokens;
}

// Attribute count. Unquoted values count: a value is a value even without
// quotes, and demanding quotes here would fault files the game may still read.
function countXmlAttrs(attrStr) {
  const m = String(attrStr || '').match(/[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g);
  return m ? m.length : 0;
}

// The local part of a tag name: a namespaced <x:Row> classifies as a Row (the
// game has no namespaces, but the prefix changes nothing about the shape), and
// is still reported under its full as-written name.
function localTag(name) {
  const s = String(name);
  const c = s.lastIndexOf(':');
  return (c < 0 ? s : s.slice(c + 1)).toLowerCase();
}

// First well-formedness fault over the masked text, or null when the file is
// well-formed. Single ordered pass: gaps are checked inline so a stray `<`
// names the element enclosing it. Tag matching is case-sensitive (XML is);
// anything looser would misreport genuinely broken files.
function firstXmlWellFormedFault(clean, tokens) {
  const stack = [];
  let rootClosed = false;
  let pos = 0;
  const gapFault = (gap, gapStart) => {
    const lt = gap.indexOf('<');
    if (lt >= 0) {
      return {
        tag: stack.length ? stack[stack.length - 1].name : 'GameData',
        line: lineOf(clean, gapStart + lt),
        reason: `has a < on line ${lineOf(clean, gapStart + lt)} that starts no tag, so the game cannot read the file at all — remove it or write it as &lt;`,
      };
    }
    if (!stack.length && /\S/.test(gap)) {
      const badLine = lineOf(clean, gapStart + gap.search(/\S/));
      return {
        tag: 'GameData',
        line: badLine,
        reason: rootClosed
          ? `has words outside its <GameData> block (line ${badLine}), so the game cannot read the file at all — move the words inside the block or remove them`
          : `has words before its <GameData> block (line ${badLine}), so the game cannot read the file at all — move the words inside the block or remove them`,
      };
    }
    return null;
  };
  for (const tok of tokens) {
    const bad = gapFault(clean.slice(pos, tok.index), pos);
    if (bad) return bad;
    pos = tok.index + tok.len;
    if (tok.close) {
      if (!stack.length) {
        return {
          tag: tok.name,
          line: lineOf(clean, tok.index),
          reason: `closes </${tok.name}> on line ${lineOf(clean, tok.index)} with no matching opening tag, so the game cannot read the file at all — remove the stray closing tag or add its missing opening tag`,
        };
      }
      const top = stack[stack.length - 1];
      if (top.name !== tok.name) {
        return {
          tag: top.name,
          line: lineOf(clean, tok.index),
          reason: `is not well-formed XML (line ${lineOf(clean, tok.index)} closes </${tok.name}> while <${top.name}> is still open), so the game cannot read the file at all — fix the tags so every opening tag has its matching closing tag`,
        };
      }
      stack.pop();
      if (!stack.length) rootClosed = true;
    } else if (tok.self) {
      if (!stack.length) {
        if (rootClosed) return secondXmlRoot(clean, tok);
        rootClosed = true;
      }
    } else {
      if (!stack.length && rootClosed) return secondXmlRoot(clean, tok);
      stack.push({ name: tok.name, index: tok.index });
    }
  }
  const tail = gapFault(clean.slice(pos), pos);
  if (tail) return tail;
  if (stack.length) {
    const top = stack[stack.length - 1];
    return {
      tag: top.name,
      line: lineOf(clean, top.index),
      reason: `never closes its <${top.name}> block, so the game cannot read the file at all — add the missing </${top.name}>`,
    };
  }
  return null;
}

// A second top-level block: a file holds a single <GameData> root.
function secondXmlRoot(clean, tok) {
  return {
    tag: tok.name,
    line: lineOf(clean, tok.index),
    reason: `opens a second top-level <${tok.name}> block, but a file holds a single <GameData> root, so the game cannot read the file at all — merge everything under one <GameData>`,
  };
}

// Operation tags the game understands inside a table: the converter's own
// XML_OP_CANON set (see phase9-conflict-replay.js). Anything else nested in a
// table is skipped by the game, so it is provably dead content worth naming.
const XML_TABLE_OPS = new Set(['row', 'replace', 'update', 'delete', 'insertorignore']);

// A <Where>/<Set> block outside any <Update>.
function whereOutsideUpdate(tokName, at) {
  return {
    tag: tokName,
    line: at,
    reason: `<${tokName}> sits outside any <Update> block, so the game ignores it — move it inside the <Update> it belongs to`,
  };
}

// Structure faults over a well-formed token list, in file order. Tainted
// subtrees (content nested under an already-faulted element) fault once at
// their root: the game skips the whole block, so every tag inside would be
// the same finding repeated. Findings are { tag, line, reason }.
function lintXmlStructure(clean, tokens) {
  const out = [];
  // Contexts: root | table | update | leaf (a Row-family op) | where | set,
  // plus tainted (faulted or opaque: swallow the whole subtree). Only
  // non-tainted update contexts track completeness.
  const stack = [];
  const atLine = (i) => lineOf(clean, i);
  const taintedCtx = (tok) => ({ kind: 'tainted', name: tok.name, tainted: true });
  for (const tok of tokens) {
    if (tok.close) {
      const ctx = stack.pop();
      if (ctx && ctx.kind === 'update' && !ctx.tainted) {
        if (!ctx.hasWhere && !ctx.hasSet) {
          out.push({ tag: ctx.name, line: ctx.line, reason: `<${ctx.name}> has no <Where> and no <Set> block, so it changes nothing — add a <Where .../> that picks out the rows and a <Set .../> with the new values` });
        } else if (!ctx.hasWhere) {
          out.push({ tag: ctx.name, line: ctx.line, reason: `<${ctx.name}> has no <Where> block, so it would rewrite every row in <${ctx.table}> — add a <Where .../> that picks out only the rows to change` });
        } else if (!ctx.hasSet) {
          out.push({ tag: ctx.name, line: ctx.line, reason: `<${ctx.name}> has no <Set> block, so it changes nothing — add a <Set .../> with the new values` });
        }
      }
      continue;
    }
    const l = localTag(tok.name);
    const at = atLine(tok.index);
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (tok.self) {
      if (selfXmlElement(out, parent, tok, l, at)) return out;
      continue;
    }
    if (!parent) {
      if (l !== 'gamedata') {
        out.push(notGameDataRoot(tok.name, at));
        return out;
      }
      stack.push({ kind: 'root', name: tok.name, line: at, tainted: false });
      continue;
    }
    if (parent.tainted) {
      stack.push(taintedCtx(tok));
      continue;
    }
    if (parent.kind === 'root') {
      if (XML_TABLE_OPS.has(l)) {
        out.push({ tag: tok.name, line: at, reason: `<${tok.name}> sits directly under <GameData> instead of inside a table, so the game cannot tell which table it belongs to — move it inside its <TableName> wrapper` });
        stack.push(taintedCtx(tok));
      } else if (l === 'where' || l === 'set') {
        out.push(whereOutsideUpdate(tok.name, at));
        stack.push(taintedCtx(tok));
      } else if (l === 'sql') {
        stack.push(taintedCtx(tok));
      } else {
        stack.push({ kind: 'table', name: tok.name, table: tok.name, tainted: false });
      }
      continue;
    }
    if (parent.kind === 'table') {
      openInTable(out, stack, parent, tok, l, at);
      continue;
    }
    if (parent.kind === 'update') {
      openInUpdate(out, stack, parent, tok, l, at);
      continue;
    }
    // A <Text> block inside a Row-family op is the localized-text shape the
    // game reads (descriptions living solely in it raise zero game-log
    // complaints), so it stays silent and its subtree is swallowed.
    if (parent.kind === 'leaf' && l === 'text') {
      stack.push(taintedCtx(tok));
      continue;
    }
    out.push({
      tag: tok.name,
      line: at,
      reason: `<${tok.name}> sits inside <${parent.name}>, which only carries values rather than blocks, so the game skips it — move the values into the <${parent.name} ...> attributes`,
    });
    stack.push(taintedCtx(tok));
  }
  return out;
}

// The file's root is not <GameData>: nothing in it loads as database content.
// Reported once, not once per tag: the UI-layout content inside would
// otherwise fault on every block, burying the one real problem.
function notGameDataRoot(name, at) {
  return {
    tag: name,
    line: at,
    reason: `<${name}> wraps the file instead of <GameData>, so the game does not read it as database content — wrap the database tables in <GameData>, or load the file with the action that matches its shape`,
  };
}

// A self-closing element. Self-closers take no children, so nothing is pushed;
// returns true when the caller must stop (a wrong root poisons the file).
function selfXmlElement(out, parent, tok, l, at) {
  if (!parent) {
    if (l !== 'gamedata') out.push(notGameDataRoot(tok.name, at));
    return true;
  }
  if (parent.tainted) return false;
  if (parent.kind === 'root') {
    if (XML_TABLE_OPS.has(l)) {
      out.push({ tag: tok.name, line: at, reason: `<${tok.name}> sits directly under <GameData> instead of inside a table, so the game cannot tell which table it belongs to — move it inside its <TableName> wrapper` });
    } else if (l === 'where' || l === 'set') {
      out.push(whereOutsideUpdate(tok.name, at));
    }
    return false;
  }
  if (parent.kind === 'table') {
    if (l === 'update') {
      out.push({ tag: tok.name, line: at, reason: `<${tok.name}> has no <Where> and no <Set> block, so it changes nothing — add a <Where .../> that picks out the rows and a <Set .../> with the new values` });
    } else if (l === 'row' || l === 'replace' || l === 'delete' || l === 'insertorignore') {
      emptyRowOp(out, parent, tok, l, at);
    } else if (l === 'where' || l === 'set') {
      out.push(whereOutsideUpdate(tok.name, at));
    } else if (l !== 'sql') {
      out.push(unknownTableCommand(tok.name, parent.table, at));
    }
    return false;
  }
  if (parent.kind === 'update') {
    if (l === 'where' || l === 'set') {
      emptyWhereOrSet(out, parent, tok, l, at);
      if (l === 'where') parent.hasWhere = true;
      else parent.hasSet = true;
    } else {
      out.push(unknownUpdateChild(tok.name, at));
    }
    return false;
  }
  // Self-closing <Text/> inside a Row-family op: same localized-text shape as
  // the paired block, silent for the same reason.
  if (parent.kind === 'leaf' && l === 'text') return false;
  out.push({
    tag: tok.name,
    line: at,
    reason: `<${tok.name}> sits inside <${parent.name}>, which only carries values rather than blocks, so the game skips it — move the values into the <${parent.name} ...> attributes`,
  });
  return false;
}

// A paired opener directly inside a table.
function openInTable(out, stack, parent, tok, l, at) {
  const tainted = () => ({ kind: 'tainted', name: tok.name, tainted: true });
  if (l === 'update') {
    stack.push({ kind: 'update', name: tok.name, line: at, table: parent.table, hasWhere: false, hasSet: false, tainted: false });
  } else if (l === 'row' || l === 'replace' || l === 'delete' || l === 'insertorignore') {
    emptyRowOp(out, parent, tok, l, at);
    stack.push({ kind: 'leaf', name: tok.name, line: at, table: parent.table, tainted: false });
  } else if (l === 'where' || l === 'set') {
    out.push(whereOutsideUpdate(tok.name, at));
    stack.push(tainted());
  } else if (l === 'sql') {
    stack.push(tainted());
  } else {
    out.push(unknownTableCommand(tok.name, parent.table, at));
    stack.push(tainted());
  }
}

// A paired opener inside an <Update>: only <Where> and <Set> belong here.
function openInUpdate(out, stack, parent, tok, l, at) {
  if (l === 'where' || l === 'set') {
    emptyWhereOrSet(out, parent, tok, l, at);
    if (l === 'where') parent.hasWhere = true;
    else parent.hasSet = true;
    stack.push({ kind: l, name: tok.name, line: at, table: parent.table, tainted: false });
  } else {
    out.push(unknownUpdateChild(tok.name, at));
    stack.push({ kind: 'tainted', name: tok.name, tainted: true });
  }
}

// A tag inside a table that is none of the commands the game understands.
function unknownTableCommand(name, table, at) {
  return {
    tag: name,
    line: at,
    reason: `<${name}> is not a command the game understands inside <${table}>, so the game skips the whole block — use Row, Replace, Update, Delete or InsertOrIgnore, and check the spelling`,
  };
}

// A tag inside an <Update> that is neither <Where> nor <Set>.
function unknownUpdateChild(name, at) {
  return {
    tag: name,
    line: at,
    reason: `<${name}> does not belong inside an <Update> block (only <Where> and <Set> do), so the game skips it — move it out of the <Update>, or replace it with a <Where> and <Set> pair`,
  };
}

// A Row-family op with no values. A bare <Delete> is the dangerous one: with
// no values it matches every row in the table (the converter refuses it for
// the same reason); a bare Row adds nothing the game can use.
function emptyRowOp(out, parent, tok, l, at) {
  if (countXmlAttrs(tok.attrs) > 0) return;
  out.push({
    tag: tok.name,
    line: at,
    reason: l === 'delete'
      ? `<${tok.name}> carries no values, so it matches every row in <${parent.table}> — add the values that pick out only the rows to remove`
      : `<${tok.name}> carries no values, so the game cannot add the row — add the column values the row needs`,
  });
}

// An empty <Where> (matches every row) or <Set> (changes nothing) opener.
function emptyWhereOrSet(out, parent, tok, l, at) {
  if (countXmlAttrs(tok.attrs) > 0) return;
  out.push({
    tag: tok.name,
    line: at,
    reason: l === 'where'
      ? `<${tok.name}> carries no values, so the <Update> would rewrite every row in <${parent.table}> — add the values that pick out only the rows to change`
      : `<${tok.name}> carries no values, so the <Update> changes nothing — add the new values as attributes`,
  });
}

// Pure structural lint over one XML text: [] when the file is fine or
// effectively empty (empty files are skipped, never findings), else one entry
// per fault in file order. Malformed XML stops at the first fault: structure
// past that point cannot be trusted.
function lintGameDataXml(text) {
  const src = String(text == null ? '' : text);
  const bomless = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  if (!bomless.trim()) return [];
  const clean = maskXmlNoise(bomless);
  const tokens = tokenizeXml(clean);
  if (!tokens.length) {
    if (clean.indexOf('<') >= 0) {
      const lt = clean.indexOf('<');
      return [{
        tag: 'GameData',
        line: lineOf(clean, lt),
        reason: `has a < on line ${lineOf(clean, lt)} that starts no tag, so the game cannot read the file at all — remove it or write it as &lt;`,
      }];
    }
    if (clean.trim()) {
      return [{
        tag: 'GameData',
        line: 1,
        reason: 'has no XML tags at all, so the game cannot read it as database content — write the content as <GameData> tables, or stop loading the file with a database action',
      }];
    }
    return [];
  }
  const malformed = firstXmlWellFormedFault(clean, tokens);
  if (malformed) return [malformed];
  return lintXmlStructure(clean, tokens);
}

// (d) driver: every .xml file database-typed actions load, linted off disk.
// Findings read { kind: 'xml-issue', modId, name, file, tag, line, reason }.
// The action-type filter is the point: only UpdateDatabase/UpdateText rows
// read a file as database content, and only GameData XML is database content,
// so a UI-layout .xml under a script action never reaches the lint. Only the
// active profile's enabled mods are linted: a switched-off mod's broken file
// cannot reach the game, so it stays silent by design. Targets present in
// load order. readFile overrides the disk read in tests (full path in, text
// or null out).
function detectXmlIssues(db, { folders, readFile } = {}) {
  const dirs = folders || modFolders(db);
  const mods = modIndex(db);
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const pos = loadPositions(db);
  const dbTypes = [...DATABASE_ACTION_TYPES];
  const holes = dbTypes.map(() => '?').join(',');
  const targets = new Map();
  const collect = (rows) => {
    for (const r of rows || []) {
      const file = normalizePath(r.filePath);
      if (!file || fileExt(file) !== 'xml') continue;
      const key = `${r.modRowId}\n${file.toLowerCase()}`;
      if (!targets.has(key)) targets.set(key, { modRowId: r.modRowId, file });
    }
  };
  try {
    collect(db.prepare(
      `SELECT c.ModRowId AS modRowId, f.Path AS filePath
         FROM Components c
         JOIN ComponentFiles cf ON cf.ComponentRowId = c.ComponentRowId
         JOIN ModFiles f ON f.FileRowId = cf.FileRowId
        WHERE c.ComponentType IN (${holes})`
    ).all(...dbTypes));
  } catch (_) {
    // No in-game database claims without the action tables.
  }
  try {
    collect(db.prepare(
      `SELECT s.ModRowId AS modRowId, f.Path AS filePath
         FROM Settings s
         JOIN SettingFiles sf ON sf.SettingRowId = s.SettingRowId
         JOIN ModFiles f ON f.FileRowId = sf.FileRowId
        WHERE s.SettingType IN (${holes})`
    ).all(...dbTypes));
  } catch (_) {
    // No front-end database claims without the front-end tables.
  }
  const read = readFile || defaultReadFile;
  const ordered = [...targets.values()].sort((a, b) => {
    const pa = rankOf(pos.byRow, a.modRowId);
    const pb = rankOf(pos.byRow, b.modRowId);
    if (pa !== pb) return pa - pb;
    const ma = (mods.get(a.modRowId) || { modId: String(a.modRowId) }).modId.toLowerCase();
    const mb = (mods.get(b.modRowId) || { modId: String(b.modRowId) }).modId.toLowerCase();
    if (ma !== mb) return ma < mb ? -1 : 1;
    const fa = a.file.toLowerCase();
    const fb = b.file.toLowerCase();
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  const out = [];
  const tLint0 = Date.now();
  for (const t of ordered) {
    const dir = dirs.get(t.modRowId);
    if (!dir || !dir.folder) continue;
    if (dirs.size > 0 && !isRealMod(dir)) continue;
    if (enabled && !enabled.has(t.modRowId)) continue;
    let text;
    try {
      text = read(path.join(dir.folder, ...t.file.split('/')));
    } catch (_) {
      continue;
    }
    if (text == null) continue;
    const m = mods.get(t.modRowId) || { modId: String(t.modRowId), name: String(t.modRowId) };
    for (const issue of lintGameDataXml(text)) {
      out.push({
        kind: 'xml-issue',
        modId: m.modId,
        name: m.name,
        file: t.file,
        tag: issue.tag,
        line: issue.line,
        reason: issue.reason,
      });
    }
  }
  console.log(`[packaging] xml-issues: files=${ordered.length} lint=${Date.now() - tLint0}ms findings=${out.length}`);
  return out;
}

// (b) A database file loaded by an action whose database lacks its tables.
//
// Components (in-game) actions run against the gameplay database, Settings
// (front-end) actions against the front-end one. Each .sql/.xml file those
// actions load is parsed for the tables it touches — SQL INTO/FROM/JOIN/
// UPDATE plus the XML table wrappers and <Sql> blocks — and each table is
// compared against the gameplay vs front-end table sets mined read-only from
// the debug sqlite masters. A file warns only when one of its tables
// provably lives in the OTHER database and not in its own: tables present in
// both stay silent (shared text tables are legitimately loaded on either
// side), tables in neither stay silent (a mod-made table proves nothing), and
// when a debug master is absent its whole side stays silent — never guessed.
// DLC/base rows stay silent under the module's silence rule, and only the
// active profile's enabled mods are read. Findings name the mod (display
// name), the file, the table, and the database the table lives in, in load
// order.

// Where the game keeps one debug master, the same lookup family the conflict
// replay uses for DebugGameplay.sqlite: the env override first, then the
// Documents-side root (Cache dir before the bare root), then the Local-side
// root the same way.
function debugMasterCandidates(masterFile, envVar) {
  const out = [];
  if (process.env[envVar]) out.push(process.env[envVar]);
  const root = paths.myGamesRoot ? paths.myGamesRoot() : null;
  if (root) {
    out.push(path.join(root, 'Cache', masterFile));
    out.push(path.join(root, masterFile));
  }
  const localRoot = paths.localGamesRoot ? paths.localGamesRoot() : null;
  if (localRoot) {
    out.push(path.join(localRoot, 'Cache', masterFile));
    out.push(path.join(localRoot, masterFile));
  }
  return out;
}

function findDebugMaster(masterFile, envVar) {
  for (const p of debugMasterCandidates(masterFile, envVar)) {
    try {
      if (p && fs.statSync(p).isFile()) return p;
    } catch (_) {
      // Next candidate.
    }
  }
  return null;
}

// Lowercased table names from one sqlite master, or null when it cannot be
// read (missing, locked, not a database): an absent master stays silent,
// never guessed.
function readMasterTables(file) {
  let master = null;
  try {
    master = new DatabaseSync(file, { readOnly: true });
    const rows = master.prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table'").all();
    const out = new Set();
    for (const r of rows || []) {
      const n = String(r.name == null ? '' : r.name).trim().toLowerCase();
      if (n && !n.startsWith('sqlite_')) out.add(n);
    }
    return out;
  } catch (_) {
    return null;
  } finally {
    try {
      if (master) master.close();
    } catch (_) {
      // Already gone.
    }
  }
}

// Both schema sets at once: { gameplay, config }, each a Set or null.
// Explicit files (tests) win; otherwise the game Cache folder is searched the
// way the conflict replay finds DebugGameplay.sqlite.
function mineDebugTableSets({ gameplayFile, configFile } = {}) {
  const g = gameplayFile || findDebugMaster('DebugGameplay.sqlite', 'CIV6_DEBUG_GAMEPLAY');
  const c = configFile || findDebugMaster('DebugConfiguration.sqlite', 'CIV6_DEBUG_CONFIGURATION');
  return { gameplay: g ? readMasterTables(g) : null, config: c ? readMasterTables(c) : null };
}

// Blank the parts of a SQL text that are not table references: block and line
// comments plus single-quoted string literals (a value like 'chosen from the
// best' holds a FROM that names no table). Double-quoted, backtick, and
// bracket wrappers are kept: in SQLite those quote identifiers, so
// INSERT INTO "Units" still matches below.
function stripSqlNoise(src) {
  let out = String(src == null ? '' : src);
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, ' '));
  return out;
}

// The table a reference chunk names: the last identifier past any schema
// qualifier ("main"."Units" is the Units table), unwrapped from SQLite
// quoting, or null when the chunk is no plain name.
function sqlRefName(chunk) {
  const s = String(chunk == null ? '' : chunk).trim();
  if (!s) return null;
  const parts = s.split('.');
  const last = parts[parts.length - 1].trim();
  const q = /^"([^"]+)"$/.exec(last) || /^`([^`]+)`$/.exec(last) || /^\[([^\]]+)\]$/.exec(last);
  const bare = (q ? q[1] : last).trim();
  return /^[A-Za-z_][\w$]*$/.test(bare) ? bare : null;
}

// Table names one SQL text touches, as written, deduplicated
// case-insensitively keeping the first spelling.
function mineSqlTables(text) {
  const clean = stripSqlNoise(text);
  const seen = new Set();
  const out = [];
  const take = (name) => {
    if (!name) return;
    const k = String(name).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(name);
  };
  const patterns = [
    /\bINSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+([^\s(,;]+)/gi,
    /\bUPDATE\s+(?:OR\s+[A-Z]+\s+)?([^\s(,;]+)/gi,
    /\bFROM\s+([^\s(,;]+)/gi,
    /\bJOIN\s+([^\s(,;]+)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) take(sqlRefName(m[1]));
  }
  return out;
}

// A tag that names a table: anything directly under <GameData> that is not a
// row command, a <Where>/<Set> block, or raw <Sql>.
function isXmlTableTag(tok) {
  const l = localTag(tok.name);
  return l !== 'gamedata' && !XML_TABLE_OPS.has(l) && l !== 'where' && l !== 'set' && l !== 'sql';
}

// Table names one XML text touches, as written: the table wrapper tags plus
// the tables any <Sql> blocks touch (parsed as SQL). Best effort over the
// masked token list, so a malformed file still yields its readable wrappers
// while the lint names the malformation separately.
function mineXmlTables(text) {
  const src = String(text == null ? '' : text);
  const bomless = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const seen = new Set();
  const out = [];
  const take = (name) => {
    if (!name) return;
    const k = String(name).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(name);
  };
  const tokens = tokenizeXml(maskXmlNoise(bomless));
  const stack = [];
  for (const tok of tokens) {
    if (tok.close) {
      if (stack.length && stack[stack.length - 1] === tok.name) stack.pop();
      continue;
    }
    if (tok.self) {
      if (stack.length === 1 && isXmlTableTag(tok)) take(tok.name);
      continue;
    }
    if (stack.length === 1 && isXmlTableTag(tok)) take(tok.name);
    if (stack.length === 0) {
      if (localTag(tok.name) === 'gamedata') stack.push(tok.name);
    } else {
      stack.push(tok.name);
    }
  }
  const sqlBlockRe = /<Sql\b[^>]*>([\s\S]*?)<\/\s*Sql\s*>/gi;
  let m;
  while ((m = sqlBlockRe.exec(bomless)) !== null) {
    for (const t of mineSqlTables(m[1])) take(t);
  }
  return out;
}

// (b) driver: every .sql/.xml file database-typed actions load, read off
// disk and compared against the two schema sets. Findings read
// { kind: 'schema-mismatch', modId, name, file, table, side, expectedDb,
// reason }. gameplayTables/configTables ride in for tests as Sets (or arrays,
// normalized here) or null for a missing master; when either is undefined the
// debug masters are mined, and when either side is still unknown the check
// stays silent. readFile overrides the disk read in tests (full path in,
// text or null out); debugGameplayFile/debugConfigFile override the master
// lookup in tests (explicit path in, real lookup skipped).
function detectSchemaMismatch(db, { folders, readFile, gameplayTables, configTables, debugGameplayFile, debugConfigFile } = {}) {
  const dirs = folders || modFolders(db);
  const mods = modIndex(db);
  const enabled = enabledModRowIds(db, activeGroupId(db));
  const pos = loadPositions(db);
  const normTables = (v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const raw = v instanceof Set ? v : new Set(v);
    const out = new Set();
    for (const t of raw) {
      const n = String(t == null ? '' : t).trim().toLowerCase();
      if (n) out.add(n);
    }
    return out;
  };
  let gameplay = normTables(gameplayTables);
  let config = normTables(configTables);
  if (gameplay === undefined || config === undefined) {
    const mined = mineDebugTableSets({ gameplayFile: debugGameplayFile, configFile: debugConfigFile });
    if (gameplay === undefined) gameplay = mined.gameplay;
    if (config === undefined) config = mined.config;
  }
  if (!gameplay || !config) return [];

  const dbTypes = [...DATABASE_ACTION_TYPES];
  const holes = dbTypes.map(() => '?').join(',');
  const targets = new Map();
  const collect = (rows, side) => {
    for (const r of rows || []) {
      const file = normalizePath(r.filePath);
      if (!file) continue;
      const ext = fileExt(file);
      if (ext !== 'sql' && ext !== 'xml') continue;
      const key = `${r.modRowId}\n${file.toLowerCase()}\n${side}`;
      if (!targets.has(key)) targets.set(key, { modRowId: r.modRowId, file, side });
    }
  };
  try {
    collect(db.prepare(
      `SELECT c.ModRowId AS modRowId, f.Path AS filePath
         FROM Components c
         JOIN ComponentFiles cf ON cf.ComponentRowId = c.ComponentRowId
         JOIN ModFiles f ON f.FileRowId = cf.FileRowId
        WHERE c.ComponentType IN (${holes})`
    ).all(...dbTypes), 'gameplay');
  } catch (_) {
    // No in-game database claims without the action tables.
  }
  try {
    collect(db.prepare(
      `SELECT s.ModRowId AS modRowId, f.Path AS filePath
         FROM Settings s
         JOIN SettingFiles sf ON sf.SettingRowId = s.SettingRowId
         JOIN ModFiles f ON f.FileRowId = sf.FileRowId
        WHERE s.SettingType IN (${holes})`
    ).all(...dbTypes), 'front-end');
  } catch (_) {
    // No front-end database claims without the front-end tables.
  }

  const read = readFile || defaultReadFile;
  const ordered = [...targets.values()].sort((a, b) => {
    const pa = rankOf(pos.byRow, a.modRowId);
    const pb = rankOf(pos.byRow, b.modRowId);
    if (pa !== pb) return pa - pb;
    const ma = (mods.get(a.modRowId) || { modId: String(a.modRowId) }).modId.toLowerCase();
    const mb = (mods.get(b.modRowId) || { modId: String(b.modRowId) }).modId.toLowerCase();
    if (ma !== mb) return ma < mb ? -1 : 1;
    const fa = a.file.toLowerCase();
    const fb = b.file.toLowerCase();
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a.side < b.side ? -1 : a.side > b.side ? 1 : 0;
  });
  const out = [];
  for (const t of ordered) {
    const dir = dirs.get(t.modRowId);
    if (!dir || !dir.folder) continue;
    if (dirs.size > 0 && !isRealMod(dir)) continue;
    if (enabled && !enabled.has(t.modRowId)) continue;
    let text;
    try {
      text = read(path.join(dir.folder, ...t.file.split('/')));
    } catch (_) {
      continue;
    }
    if (text == null) continue;
    const tables = fileExt(t.file) === 'sql' ? mineSqlTables(text) : mineXmlTables(text);
    if (!tables.length) continue;
    const own = t.side === 'gameplay' ? gameplay : config;
    const other = t.side === 'gameplay' ? config : gameplay;
    const expected = t.side === 'gameplay' ? 'front-end' : 'gameplay';
    const m = mods.get(t.modRowId) || { modId: String(t.modRowId), name: String(t.modRowId) };
    for (const table of tables) {
      const k = String(table).toLowerCase();
      if (!other.has(k) || own.has(k)) continue;
      out.push({
        kind: 'schema-mismatch',
        modId: m.modId,
        name: m.name,
        file: t.file,
        table,
        side: t.side,
        expectedDb: expected,
        reason: `touches table ${table}, which lives in the ${expected} database, but the file loads in a ${t.side} action — move it into a ${expected} action so the game reads it where its tables live`,
      });
    }
  }
  out.sort((a, b) => {
    const pa = rankOf(pos.byMod, a.modId);
    const pb = rankOf(pos.byMod, b.modId);
    if (pa !== pb) return pa - pb;
    const am = a.modId.toLowerCase();
    const bm = b.modId.toLowerCase();
    if (am !== bm) return am < bm ? -1 : 1;
    const af = a.file.toLowerCase();
    const bf = b.file.toLowerCase();
    if (af !== bf) return af < bf ? -1 : 1;
    const at = String(a.table).toLowerCase();
    const bt = String(b.table).toLowerCase();
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  console.log(`[packaging] schema-mismatch: files=${ordered.length} findings=${out.length}`);
  return out;
}

// All four layers over one database. Unregistered files first, then
// schema-mismatch rows, then duplicate ids, then XML findings; each layer is
// already internally sorted in load order, so the concatenation is
// deterministic. opts rides
// through to the file checks (folders/listFiles/readFile overrides for tests,
// plus the schema table sets and debug-master overrides).
// Logs per-stage ms plus the render payload size to the server console, so the
// next slowness report names its stage instead of saying "packaging is slow".
function collectPackagingWarnings(db, opts) {
  const t0 = Date.now();
  const unreg = detectUnregisteredFiles(db, opts);
  const t1 = Date.now();
  const schema = detectSchemaMismatch(db, opts);
  const t2 = Date.now();
  const dup = detectDuplicateModIds(db);
  const t3 = Date.now();
  const xml = detectXmlIssues(db, opts);
  const t4 = Date.now();
  const all = [...unreg, ...schema, ...dup, ...xml];
  let bytes = -1;
  try {
    bytes = Buffer.byteLength(JSON.stringify(all), 'utf8');
  } catch (_) {
    bytes = -1;
  }
  console.log(`[packaging] stages: unregistered=${t1 - t0}ms schema=${t2 - t1}ms dup-ids=${t3 - t2}ms xml=${t4 - t3}ms total=${t4 - t0}ms warnings=${all.length} payload=${bytes}B`);
  return all;
}

// One plain-words line per finding. Names are display names (never bare
// LOC_ tags — modIndex resolves those); ids print shortened, the way the
// shadowing fixtures print them.
function formatWarning(w) {
  const short = (id) => String(id == null ? '' : id).slice(0, 8);
  if (w.kind === 'duplicate-mod-id') {
    const who = (w.claimants || []).map((c) => `${c.name} (${c.folder || 'folder unknown'})`).join(', ');
    return `duplicate-mod-id: ${short(w.modId)} ${w.reason}: ${who}`;
  }
  if (w.kind === 'schema-mismatch') {
    return `schema-mismatch: ${w.name}: ${w.file} table ${w.table} ${w.reason}`;
  }
  if (w.kind === 'xml-issue') {
    return `xml-issue: ${w.name}: ${w.file} <${w.tag}> (line ${w.line}) ${w.reason}`;
  }
  return `unregistered-file: ${w.name}: ${w.file} ${w.reason}`;
}

module.exports = {
  normalizePath,
  fileExt,
  LOADABLE_EXTS,
  SILENT_DIR_SEGMENTS,
  isLoadableFile,
  DATABASE_ACTION_TYPES,
  modFolders,
  listModFolderFiles,
  detectUnregisteredFiles,
  detectSchemaMismatch,
  detectDuplicateModIds,
  detectXmlIssues,
  lintGameDataXml,
  mineDebugTableSets,
  mineSqlTables,
  mineXmlTables,
  collectPackagingWarnings,
  formatWarning,
};
