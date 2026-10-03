'use strict';

// Phase 9 automated proof (conflict-diagnosis change, tasks 1.1-1.3):
// temp-copy lifecycle + ordered statement collection + per-file SAVEPOINT
// abort emulation for conflict replay (1.1), plus preprocessing stages with
// declared transform/skip flags: trigger-aware splitter, double-quoted-string
// rewrite, Make_Hash JS stub, XML→SQL converter, FK on/off mode parameter
// (1.2), plus criteria gating evaluation with skipped-with-reason reporting
// (1.3).
//
// Task 2.1 adds history-trigger provenance (simonw-style): per-cell
// (table, pk, column) -> (file, statement index) recording via
// AFTER INSERT / AFTER UPDATE OF triggers, plus a contested-cell collision
// report naming winner plus loser(s) in replay order. Opt-in per replay via
// { provenance: true }; default off so --check/--fidelity/--gates are
// byte-identical paths.
//
// Temp copies only, never the live game DB. Fixtures and scratch live under
// os.tmpdir(); the repo gains this file.
//
//   node src/phase9-conflict-replay.js --check      (task 1.1)
//   node src/phase9-conflict-replay.js --fidelity  (task 1.2)
//   node src/phase9-conflict-replay.js --gates     (task 1.3)
//   node src/phase9-conflict-replay.js --provenance (task 2.1)
//   node src/phase9-conflict-replay.js --differential (task 2.2)
//   node src/phase9-conflict-replay.js --envelope (task 2.3)
//   node src/phase9-conflict-replay.js --assumed-gates (game-setup task 2.2)
//
// Task 2.2 adds Database.log differential validation: parse Database.log
// text into error entries and compare against replay abort findings,
// reporting agreement plus both divergence directions (log-only and
// replay-only), each naming file and statement.
//
// New file only: nothing under src/ or public/ is modified by this change.
//
// Game-setup task 2.2 adds assumed-setup replay gating: the gates context
// carries asserted option keys (same KIND:BODY store the view reads),
// asserted values satisfy matching undecidable gates, flagged assumed in gate
// reporting (rec.gate.assumed, gatedAssumed, gatedOut assumed flags). Nothing
// asserted behaves exactly as the 1.3 path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const iconv = require('iconv-lite');

// ---------------------------------------------------------------------------
// Temp-copy lifecycle: the live game DB is never opened for writing.
// ---------------------------------------------------------------------------

// Copy sourceDbPath into a fresh directory under the OS temp dir and return
// the scratch dir plus the temp copy path. The source is only read.
function createTempCopy(sourceDbPath, { prefix = 'civ6-conflict-replay-' } = {}) {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tempDbPath = path.join(tmpDir, path.basename(sourceDbPath));
  fs.copyFileSync(sourceDbPath, tempDbPath);
  return { tmpDir, tempDbPath, sourceDbPath };
}

function destroyTempCopy(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Mechanical guard: replay opens a database for writing only when it sits
// under the OS temp dir. A live game-DB path fails closed here, not in docs.
function assertTempPath(dbPath) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  let resolved = path.resolve(dbPath);
  try { resolved = fs.realpathSync.native(resolved); } catch (_) { /* missing file: use resolved */ }
  const rel = path.relative(tmp, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to open for writing outside the temp dir: ${dbPath}`);
  }
}

// ---------------------------------------------------------------------------
// SQL file decoding: Civ6 mod files are commonly UTF-16; decode via
// iconv-lite with BOM detection plus a null-byte heuristic for BOM-less
// UTF-16LE. Plain ASCII/UTF-8 passes through as UTF-8.
// ---------------------------------------------------------------------------

function decodeModSql(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.slice(2), 'utf16-le'), encoding: 'utf16-le-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.slice(2), 'utf16-be'), encoding: 'utf16-be-bom' };
  }
  const probe = buf.slice(0, Math.min(buf.length, 4096));
  let zeros = 0;
  for (const b of probe) if (b === 0x00) zeros += 1;
  if (zeros > 0 && zeros >= probe.length * 0.1) {
    return { text: iconv.decode(buf, 'utf16-le'), encoding: 'utf16-le' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

function readModFile(filePath) {
  const raw = fs.readFileSync(filePath);
  return { ...decodeModSql(raw), filePath };
}

// ---------------------------------------------------------------------------
// Statement splitting (task-1.1 naive edition): split on semicolons outside
// single/double-quoted strings and -- / * * / comments. Trigger bodies with
// embedded semicolons need the trigger-aware splitter below (task 1.2).
// Kept verbatim for the 1.1 --check path: collectStatements defaults to it
// unless preprocessing is requested.
// ---------------------------------------------------------------------------

function splitStatements(sqlText) {
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      cur += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      cur += c;
      if (c === '*' && next === '/') { cur += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") {
        if (next === "'") { cur += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') {
        if (next === '"') { cur += next; i += 1; } else inDouble = false;
      }
      continue;
    }
    if (c === '-' && next === '-') { cur += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { cur += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { cur += c; inSingle = true; continue; }
    if (c === '"') { cur += c; inDouble = true; continue; }
    if (c === ';') {
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = '';
      continue;
    }
    cur += c;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: trigger-aware splitter. Same scanning as the naive
// splitter, plus word tracking so semicolons inside a CREATE TRIGGER body
// (between its BEGIN and matching END) do not terminate the statement.
// Nested BEGIN levels count; CASE...END inside a trigger body is tracked
// separately so a CASE END does not close the trigger early. A trigger
// statement ends at its terminating semicolon, which resets the tracking.
// Heuristic limits (declared, not silent): [...] / `...` quoted identifiers
// get no special handling, same as the naive splitter.
// ---------------------------------------------------------------------------

function splitStatementsTriggerAware(sqlText) {
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  let word = '';
  let sawCreate = false;
  let pendingTrigger = false;
  let depth = 0;
  let caseDepth = 0;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const flushWord = () => {
    if (!word) return;
    const u = word.toUpperCase();
    word = '';
    if (!pendingTrigger) {
      if (u === 'CREATE') sawCreate = true;
      else if ((u === 'TEMP' || u === 'TEMPORARY') && sawCreate) { /* keep sawCreate */ }
      else if (u === 'TRIGGER' && sawCreate) { pendingTrigger = true; sawCreate = false; }
      else sawCreate = false;
    } else if (u === 'BEGIN') {
      depth += 1;
    } else if (u === 'CASE') {
      caseDepth += 1;
    } else if (u === 'END') {
      if (caseDepth > 0) caseDepth -= 1;
      else if (depth > 0) depth -= 1;
    }
  };
  const emit = () => {
    const stmt = cur.trim();
    if (stmt) out.push(stmt);
    cur = '';
    pendingTrigger = false;
    sawCreate = false;
    depth = 0;
    caseDepth = 0;
  };
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      cur += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      cur += c;
      if (c === '*' && next === '/') { cur += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") {
        if (next === "'") { cur += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"') {
        if (next === '"') { cur += next; i += 1; } else inDouble = false;
      }
      continue;
    }
    if (isWordChar(c)) { cur += c; word += c; continue; }
    flushWord();
    if (c === '-' && next === '-') { cur += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { cur += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { cur += c; inSingle = true; continue; }
    if (c === '"') { cur += c; inDouble = true; continue; }
    if (c === ';') {
      if (depth > 0) { cur += c; continue; } // inside a trigger body: not a terminator
      emit();
      continue;
    }
    cur += c;
  }
  flushWord();
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

// Mechanical splitter flag: naive vs trigger-aware statement counts.
function splitterFlags(sqlText) {
  const naive = splitStatements(sqlText);
  const aware = splitStatementsTriggerAware(sqlText);
  const transformed = naive.length !== aware.length;
  return {
    stage: 'splitter',
    mode: 'trigger-aware',
    outcome: transformed ? 'transformed' : 'skipped:identical',
    naive: naive.length,
    aware: aware.length,
    reason: transformed ? 'trigger-body-kept-whole' : 'no-trigger-bodies',
  };
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: double-quoted-string rewrite. Civ6 mod SQL often uses
// "..." for string literals where strict SQLite expects '...'. Rewrite a
// "..." segment to '...' only in value positions: after a value-clause
// keyword (VALUES/SET/WHERE/...), after = at any level, or after ( / ,
// inside a VALUE parenthesis (VALUES(...), IN(...), function calls).
// Parentheses following a table name (CREATE TABLE T(...), INSERT INTO
// T(...), CREATE INDEX ... ON T(...)) open OTHER parens whose ,-separated
// "..." entries are quoted identifiers and stay verbatim. "" escapes become
// " then re-escape to '' on rewrite. Reports rewritten vs kept-identifier
// counts. Heuristic, declared per file.
// ---------------------------------------------------------------------------

const DQ_CLAUSE_PRECEDERS = new Set([
  'VALUES', 'SET', 'WHERE', 'AND', 'OR', 'LIKE', 'GLOB',
  'BETWEEN', 'IN', 'IS', 'THEN', 'ELSE', 'WHEN', 'DEFAULT',
]);

// Words after which ( opens a non-value (DDL identifier-list) paren.
const DQ_DDL_GUARDS = new Set(['TABLE', 'VIEW', 'INDEX', 'INTO', 'ON']);

function dqParenKind(lastSig, prevSig) {
  if (lastSig === 'VALUES' || lastSig === 'IN') return 'VALUE';
  const wordLike = lastSig !== '' && !['=', '(', ')', ','].includes(lastSig);
  if (wordLike && !DQ_DDL_GUARDS.has(prevSig)) return 'VALUE';
  return 'OTHER';
}

function shouldRewriteDq(lastSig, parenStack) {
  if (lastSig === '=') return true;
  if (DQ_CLAUSE_PRECEDERS.has(lastSig)) return true;
  if (lastSig === ',' || lastSig === '(') {
    const top = parenStack.length ? parenStack[parenStack.length - 1] : null;
    return top === null || top === 'VALUE';
  }
  return false;
}

function rewriteDoubleQuotes(sqlText) {
  let out = '';
  let word = '';
  let lastSig = '';
  let prevSig = '';
  const parenStack = [];
  const setSig = (s) => { prevSig = lastSig; lastSig = s; };
  let inSingle = false;
  let inLine = false;
  let inBlock = false;
  let rewritten = 0;
  let kept = 0;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const flush = () => { if (word) { setSig(word.toUpperCase()); word = ''; } };
  for (let i = 0; i < sqlText.length; i += 1) {
    const c = sqlText[i];
    const next = sqlText[i + 1];
    if (inLine) {
      out += c;
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      out += c;
      if (c === '*' && next === '/') { out += next; i += 1; inBlock = false; }
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === "'") {
        if (next === "'") { out += next; i += 1; } else inSingle = false;
      }
      continue;
    }
    if (isWordChar(c)) { out += c; word += c; continue; }
    flush();
    if (c === '-' && next === '-') { out += c + next; i += 1; inLine = true; continue; }
    if (c === '/' && next === '*') { out += c + next; i += 1; inBlock = true; continue; }
    if (c === "'") { out += c; inSingle = true; continue; }
    if (c === '"') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < sqlText.length) {
        if (sqlText[j] === '"') {
          if (sqlText[j + 1] === '"') { inner += '"'; j += 2; }
          else { closed = true; j += 1; break; }
        } else { inner += sqlText[j]; j += 1; }
      }
      if (!closed) { out += c; setSig(''); continue; } // unbalanced: leave as-is
      if (shouldRewriteDq(lastSig, parenStack)) {
        out += `'${inner.replace(/'/g, "''")}'`;
        rewritten += 1;
        setSig('LITERAL');
      } else {
        out += `"${inner.replace(/"/g, '""')}"`;
        kept += 1;
        setSig('IDENT');
      }
      i = j - 1;
      continue;
    }
    if (c === '(') {
      parenStack.push(dqParenKind(lastSig, prevSig));
      setSig('(');
    } else if (c === ')') {
      if (parenStack.length) parenStack.pop();
      setSig(')');
    } else if (c === '=' || c === ',') {
      setSig(c);
    } else if (c === ';') {
      parenStack.length = 0;
      prevSig = '';
      lastSig = '';
    } else if (!/\s/.test(c)) {
      setSig('');
    }
    out += c;
  }
  flush();
  return { text: out, rewritten, kept, outcome: rewritten > 0 ? 'transformed' : 'skipped' };
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: Make_Hash JS stub. Some mods call the game-registered SQL
// function Make_Hash(...), which does not exist in a bare sqlite open, so
// those statements fail without a stub. The stub is a deterministic
// placeholder (FNV-1a over the string form) — the real game hash is
// unknown, so any collision touching a stubbed value is fidelity-limited by
// declaration (see the make-hash-stub flag note). needsMakeHash detects the
// call; installMakeHashStub registers it on a replay connection.
// ---------------------------------------------------------------------------

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function makeHashStubValue(value) {
  if (value === null || value === undefined) return null;
  return fnv1a32(String(value));
}

function needsMakeHash(statements) {
  return (statements || []).some((s) => /\bMake_Hash\s*\(/i.test(s));
}

function installMakeHashStub(db) {
  db.function('Make_Hash', { deterministic: true }, makeHashStubValue);
}

// ---------------------------------------------------------------------------
// Task 1.2, stage: XML→SQL converter. About 5% of Civ6 data files are
// GameData XML instead of SQL: <TableName> wrappers containing <Row>,
// <Replace>, <Update> (<Where>/<Set> children), <Delete>, <InsertOrIgnore>,
// plus embedded raw SQL in <Sql> blocks (CDATA unwrapped first). Generated
// SQL uses bare identifiers and single-quoted literals; numerics stay bare,
// NULL stays NULL. Ops outside any table wrapper are counted as unassigned,
// never assigned an invented table. Regex-based, matching the repo's existing
// convention for small consistent XML (see modinfo.js / modsdb.js).
// ---------------------------------------------------------------------------

function looksLikeXml(label, text) {
  return /\.xml$/i.test(label || '') || /^\s*</.test(text || '');
}

function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n]));
}

function parseXmlAttrs(attrStr) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function sqlVal(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^NULL$/i.test(v)) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

const XML_OP_CANON = {
  row: 'Row',
  replace: 'Replace',
  insertorignore: 'InsertOrIgnore',
  update: 'Update',
  delete: 'Delete',
};

function convertXmlToSql(xmlText) {
  const flags = {
    stage: 'xml-to-sql',
    outcome: 'skipped',
    reason: 'not-xml',
    tables: [],
    opCounts: {},
    statements: 0,
    rawChunks: 0,
    unconvertible: 0,
    unassigned: 0,
  };
  const empty = { statements: [], rawChunks: [], sqlText: xmlText, flags };
  if (!/^\s*</.test(xmlText || '')) return empty;
  let body = (xmlText || '').replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c);
  const raws = [];
  body = body.replace(/<Sql\b[^>]*>([\s\S]*?)<\/\s*Sql\s*>/gi, (_, inner) => {
    if (inner.trim()) raws.push(inner.trim());
    return '\n';
  });
  body = body.replace(/<\?xml[^?]*\?>/g, ' ').replace(/<\/?GameData\b[^>]*>/gi, ' ');
  const statements = [];
  const opCounts = {};
  const tables = [];
  const matchedRanges = [];
  const count = (op) => { opCounts[op] = (opCounts[op] || 0) + 1; };
  const whereEq = (o) => Object.keys(o).map((k) => `${k}=${sqlVal(o[k])}`).join(' AND ');
  const tableRe = /<([A-Za-z_]\w*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
  let tm;
  while ((tm = tableRe.exec(body)) !== null) {
    const table = tm[1];
    const inner = tm[2];
    if (/^(Row|Replace|Update|Delete|InsertOrIgnore|Where|Set|Sql)$/i.test(table)) continue;
    if (!/<(Row|Replace|Update|Delete|InsertOrIgnore)\b/i.test(inner)) continue;
    matchedRanges.push([tm.index, tableRe.lastIndex]);
    if (!tables.includes(table)) tables.push(table);
    const singleRe = new RegExp(
      '<(Row|Replace|InsertOrIgnore|Delete)\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1\\s*>)', 'gi',
    );
    let sm;
    while ((sm = singleRe.exec(inner)) !== null) {
      const op = XML_OP_CANON[sm[1].toLowerCase()];
      const attrs = parseXmlAttrs(sm[2]);
      const keys = Object.keys(attrs);
      // Zero-attribute Delete/Row forms convert to nothing safe: a bare
      // DELETE would wipe the table, so count unconvertible instead.
      if (keys.length === 0) { flags.unconvertible += 1; continue; }
      if (op === 'Delete') {
        statements.push(`DELETE FROM ${table} WHERE ${whereEq(attrs)};`);
      } else {
        const verb = op === 'Replace' ? 'INSERT OR REPLACE'
          : op === 'InsertOrIgnore' ? 'INSERT OR IGNORE' : 'INSERT';
        statements.push(`${verb} INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => sqlVal(attrs[k])).join(', ')});`);
      }
      count(op);
    }
    const updRe = /<Update\b[^>]*>([\s\S]*?)<\/Update\s*>/gi;
    let um;
    while ((um = updRe.exec(inner)) !== null) {
      const wm = /<Where\b([^>]*?)\/>/i.exec(um[1]);
      const st = /<Set\b([^>]*?)\/>/i.exec(um[1]);
      const w = wm ? parseXmlAttrs(wm[1]) : {};
      const s = st ? parseXmlAttrs(st[1]) : {};
      // A Where-less UPDATE would touch every row: refuse, count instead.
      if (Object.keys(w).length === 0 || Object.keys(s).length === 0) {
        flags.unconvertible += 1;
        continue;
      }
      statements.push(`UPDATE ${table} SET ${whereEq(s)} WHERE ${whereEq(w)};`);
      count('Update');
    }
  }
  // Ops outside any table wrapper cannot be assigned a table: count them.
  let rest = body;
  for (let k = matchedRanges.length - 1; k >= 0; k -= 1) {
    rest = `${rest.slice(0, matchedRanges[k][0])} ${rest.slice(matchedRanges[k][1])}`;
  }
  const stray = rest.match(/<(Row|Replace|Update|Delete|InsertOrIgnore)\b/gi);
  flags.unassigned = stray ? stray.length : 0;
  flags.tables = tables;
  flags.opCounts = opCounts;
  flags.rawChunks = raws.length;
  flags.statements = statements.length;
  if (statements.length > 0 || raws.length > 0) {
    flags.outcome = 'transformed';
    delete flags.reason;
  } else {
    flags.reason = 'no-convertible-ops';
  }
  return { statements, rawChunks: raws, sqlText: statements.concat(raws).join('\n'), flags };
}

// ---------------------------------------------------------------------------
// Task 1.2 preprocessing pipeline per file: XML→SQL, double-quote rewrite,
// trigger-aware split, Make_Hash detection. Returns the executable
// statements plus one flag object per stage (transform/skip with reason).
// ---------------------------------------------------------------------------

function preprocessFile(file, { splitter = 'trigger-aware' } = {}) {
  const label = file.label || 'file';
  let sqlText = file.text || '';
  const stages = [];
  // Stage 1: XML→SQL (only for XML-looking inputs; SQL passes through).
  if (looksLikeXml(label, sqlText)) {
    const conv = convertXmlToSql(sqlText);
    stages.push({ ...conv.flags });
    if (conv.flags.outcome === 'transformed') sqlText = conv.sqlText;
  } else {
    stages.push({ stage: 'xml-to-sql', outcome: 'skipped', reason: 'not-xml' });
  }
  // Stage 2: double-quoted-string rewrite.
  const rw = rewriteDoubleQuotes(sqlText);
  stages.push({
    stage: 'double-quote-rewrite',
    outcome: rw.outcome,
    rewritten: rw.rewritten,
    keptIdentifiers: rw.kept,
    ...(rw.rewritten > 0 ? {} : { reason: 'no-double-quoted-literals' }),
  });
  sqlText = rw.text;
  // Stage 3: statement splitting (trigger-aware keeps BEGIN...END whole).
  let statements;
  if (splitter === 'trigger-aware') {
    const sf = splitterFlags(sqlText);
    statements = splitStatementsTriggerAware(sqlText);
    stages.push({
      stage: 'splitter',
      mode: sf.mode,
      outcome: sf.outcome,
      naive: sf.naive,
      aware: sf.aware,
      reason: sf.reason,
    });
  } else {
    statements = splitStatements(sqlText);
    stages.push({
      stage: 'splitter', mode: 'naive', outcome: 'skipped',
      reason: 'naive-mode-selected', count: statements.length,
    });
  }
  // Stage 4: Make_Hash detection (the stub itself installs at replay time).
  const mh = needsMakeHash(statements);
  stages.push({
    stage: 'make-hash-stub',
    outcome: mh ? 'installed-at-replay' : 'skipped',
    needed: mh,
    ...(mh ? { note: 'deterministic-placeholder-fidelity-limited' } : { reason: 'no-Make_Hash-call' }),
  });
  return { label, sqlText, statements, stages };
}

// ---------------------------------------------------------------------------
// Ordered statement collection: mods in load order, files in listed order,
// statements in file order. Each file is { label, text } or
// { label, filePath } (filePath form exercises the UTF-16 decode path).
// With { preprocess: true } each file runs the task-1.2 pipeline and the
// entry carries per-stage flags; default false keeps the exact 1.1 path.
// A file's optional gate ({ label, text, gate }, with `criteria` accepted
// as an alias) mirrors one ActionCriteria set for task 1.3 and rides along
// on the file entry; files without one are ungated. Gates are evaluated at
// replay time, never here, so collection counts are gate-blind.
// ---------------------------------------------------------------------------

function collectStatements(modSet, { preprocess = false, splitter = 'trigger-aware' } = {}) {
  const ordered = [];
  const files = [];
  let globalIndex = 0;
  modSet.forEach((mod, modIndex) => {
    (mod.files || []).forEach((file, fileIndex) => {
      let text = file.text;
      let encoding = 'inline';
      if (file.filePath) {
        const decoded = readModFile(file.filePath);
        text = decoded.text;
        encoding = decoded.encoding;
      }
      const fileLabel = file.label || (file.filePath ? path.basename(file.filePath) : `file${fileIndex}`);
      let statements;
      let stages = null;
      if (preprocess) {
        const pre = preprocessFile({ label: fileLabel, text: text || '' }, { splitter });
        statements = pre.statements;
        stages = pre.stages;
      } else {
        statements = splitStatements(text || '');
      }
      const entry = {
        modIndex,
        modId: mod.modId,
        fileIndex,
        fileLabel,
        encoding,
        statements,
        stages,
        gate: file.gate !== undefined ? file.gate : (file.criteria !== undefined ? file.criteria : null),
        baseGlobalIndex: globalIndex,
      };
      files.push(entry);
      statements.forEach((sql, stmtIndex) => {
        ordered.push({ ...entry, statements: undefined, stages: undefined, sql, stmtIndex, globalIndex: globalIndex });
        globalIndex += 1;
      });
    });
  });
  return { ordered, files, total: ordered.length };
}

// ---------------------------------------------------------------------------
// Ordered replay with per-file SAVEPOINT abort emulation: the first failing
// statement rolls back only its own file (ROLLBACK TO + RELEASE) and replay
// continues with the next file, so earlier files persist.
//
// Task-1.2 additions: explicit FK mode recorded on the report (PRAGMA
// foreign_keys OFF default, ON comparison mode), and the Make_Hash JS stub
// installed when any collected statement needs it (disable via
// { installStubs: false } to show the without-stub abort).
//
// Task-1.3 addition: optional { gates } context ({ enabled, installed } mod
// id lists, as gateContextOf reads). A file whose gate evaluates to
// willRun=false is skipped-gated — never executed, counted in skippedGated
// and named in gatedOut with its reason. willRun=null (undecidable gate)
// replays normally but is flagged gateUnknown on the per-file record and in
// gatedUnknown. No gates context means no gating at all (the 1.1 path).
//
// Game-setup task 2.2 addition: the gates context may carry `asserted` (the
// assumed-setup store keys). An asserted value satisfying an otherwise
// undecidable gate decides it, flagged assumed: rec.gate carries assumed,
// assumed-satisfied files are named in gatedAssumed, and skipped-gated files
// carry assumed in gatedOut. Undecided files are never flagged.
//
// Task-2.1 addition: optional { provenance: true } installs simonw-style
// history triggers before replay and records (table, pk, column) ->
// (file, statement index) for every committed write. Report carries
// provenance: { writes, collisions } or null when disabled (default off).
// ---------------------------------------------------------------------------

function replayOrdered(tempDbPath, collected, { foreignKeys = false, installStubs = true, gates = null, provenance = false } = {}) {
  assertTempPath(tempDbPath);
  const db = new DatabaseSync(tempDbPath);
  const started = Date.now();
  const perFile = [];
  const fkMode = foreignKeys ? 'ON' : 'OFF';
  let makeHashStub = 'skipped';
  let makeHashStubReason = 'no-Make_Hash-call';
  let executed = 0;
  let rolledBack = 0;
  let skippedGated = 0;
  const gatedOut = [];
  const gatedUnknown = [];
  const gatedAssumed = [];
  const zeroRows = [];
  const gateCtx = gates ? gateContextOf(gates) : null;
  const provInstalled = new Set();
  let provWriters = null;
  let provCollisions = null;
  try {
    db.exec(`PRAGMA foreign_keys=${fkMode}`);
    if (provenance) {
      ensureProvenanceSchema(db);
      installProvenanceTriggers(db, provInstalled);
    }
    const allStmts = (collected.files || []).flatMap((f) => f.statements || []);
    if (needsMakeHash(allStmts)) {
      if (installStubs) {
        installMakeHashStub(db);
        makeHashStub = 'installed';
        makeHashStubReason = null;
      } else {
        makeHashStubReason = 'stub-disabled';
      }
    }
    collected.files.forEach((file, i) => {
      const sp = `cr_file_${i}`;
      const rec = {
        modId: file.modId,
        fileLabel: file.fileLabel,
        statements: file.statements.length,
        executed: 0,
        status: 'committed',
        error: null,
        failedAt: null,
        zeroRows: [],
      };
      // Task 2.1: pick up tables created by earlier files. Runs outside the
      // per-file SAVEPOINT so the triggers persist like the tables do.
      if (provenance) installProvenanceTriggers(db, provInstalled);
      // Task 1.3: gate check before any statement runs. Gated-out files are
      // skipped here — no SAVEPOINT, no execution — so their writes can never
      // land or collide. Undecidable gates replay but stay flagged.
      const verdict = gateCtx ? evaluateGate(file.gate || null, gateCtx) : null;
      if (verdict) {
        rec.gate = { willRun: verdict.willRun, reason: verdict.reason, assumed: !!verdict.assumed };
        if (verdict.willRun === false) {
          rec.status = 'skipped-gated';
          skippedGated += file.statements.length;
          gatedOut.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
            reason: verdict.reason,
            assumed: !!verdict.assumed,
          });
          perFile.push(rec);
          return;
        }
        if (verdict.willRun === null) {
          rec.gateUnknown = true;
          gatedUnknown.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
            reason: 'gate-undecidable-here',
            unknown: verdict.unknown,
          });
        }
        // An assumed-satisfied gate replays like a measured one but is named
        // in gatedAssumed, never as measured.
        if (verdict.willRun === true && verdict.assumed) {
          gatedAssumed.push({
            modId: file.modId,
            fileLabel: file.fileLabel,
            statements: file.statements.length,
          });
        }
      }
      db.exec(`SAVEPOINT "${sp}"`);
      const provSnapshot = new Set(provInstalled);
      let failed = false;
      for (let s = 0; s < file.statements.length; s += 1) {
        try {
          if (provenance) {
            setProvenanceWriter(db, {
              modId: file.modId,
              fileLabel: file.fileLabel,
              stmtIndex: s,
              globalIndex: file.baseGlobalIndex + s,
            });
          }
          db.exec(file.statements[s]);
          rec.executed += 1;
          executed += 1;
          // Zero-rows-affected: an UPDATE/DELETE that runs clean but matches
          // nothing is flagged, never an error — the statement stays executed
          // and the file stays committed. SELECT changes() reflects the
          // statement's own row count (trigger sub-statements excluded), so
          // this reads correctly with provenance triggers installed too.
          // Fidelity-limited by construction: zero rows matched in THIS
          // replay, whose order, gates, and earlier aborts may differ from
          // the game's, hence the replay-relative flag on every finding.
          const verb = leadingVerb(file.statements[s]);
          if (verb === 'UPDATE' || verb === 'DELETE') {
            let affected = null;
            try {
              affected = db.prepare('SELECT changes() AS n').get().n;
            } catch (_) {
              affected = null;
            }
            if (affected === 0) {
              rec.zeroRows.push(s);
              zeroRows.push({
                modId: file.modId,
                fileLabel: file.fileLabel,
                stmtIndex: s,
                globalIndex: file.baseGlobalIndex + s,
                verb,
                fidelityLimited: ['replay-relative', ...fileLimitationFlags(file.stages)],
              });
            }
          }
          // Task 2.1: tables born mid-file need triggers for later
          // statements in the same file. Installed inside the SAVEPOINT so
          // a later abort removes table and triggers together.
          if (provenance && /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\b/i.test(file.statements[s])) {
            installProvenanceTriggers(db, provInstalled);
          }
        } catch (e) {
          rec.status = 'aborted';
          rec.error = e.message;
          rec.failedAt = file.baseGlobalIndex + s;
          rolledBack += rec.executed;
          executed -= rec.executed;
          rec.executed = 0;
          failed = true;
          break;
        }
      }
      if (failed) db.exec(`ROLLBACK TO "${sp}"`);
      if (failed && provenance) {
        // Triggers born inside the rolled-back file are gone with its
        // tables; forget them so a later file recreates them.
        provInstalled.clear();
        provSnapshot.forEach((t) => provInstalled.add(t));
      }
      db.exec(`RELEASE "${sp}"`);
      perFile.push(rec);
    });
    if (provenance) {
      provWriters = readProvenanceWrites(db);
      provCollisions = buildCollisions(provWriters, collected);
    }
  } finally {
    db.close();
  }
  const wallMs = Date.now() - started;
  return {
    tempDbPath,
    total: collected.total,
    executed,
    rolledBack,
    skippedGated,
    gatedOut,
    gatedUnknown,
    gatedAssumed,
    zeroRows,
    perFile,
    wallMs,
    stmtsPerSec: wallMs > 0 ? Math.round((executed / wallMs) * 1000) : executed,
    fkMode,
    makeHashStub,
    makeHashStubReason,
    provenance: provenance ? { writes: provWriters, collisions: provCollisions } : null,
  };
}

// ---------------------------------------------------------------------------
// --check: fixture with one failing file proves counts + per-file rollback.
// (Task 1.1, unchanged.)
// ---------------------------------------------------------------------------

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runCheck() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-check-')));
  console.log(`conflict-replay --check (task 1.1)\nscratch dir: ${scratch}`);

  // Source DB stands in for DebugGameplay.sqlite: created in scratch, then
  // treated as the live DB (copied, never written).
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec(`CREATE TABLE ReplayCheck(Id TEXT PRIMARY KEY, Value INTEGER);
        INSERT INTO ReplayCheck VALUES('base', 0);`);
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const utf16 = (text, be = false) => {
    const body = be ? iconv.encode(text, 'utf16-be') : iconv.encode(text, 'utf16-le');
    return Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), body]);
  };
  const file1 = path.join(scratch, 'mod-a-part1.sql');
  const file2 = path.join(scratch, 'mod-a-part2.sql');
  const file3 = path.join(scratch, 'mod-b-part1.sql');
  fs.writeFileSync(file1, utf16(`UPDATE ReplayCheck SET Value = 1 WHERE Id = 'base';\nINSERT INTO ReplayCheck VALUES('a1', 11);\n`));
  fs.writeFileSync(file2, utf16(`INSERT INTO ReplayCheck VALUES('a2', 22);\nINSERT INTO NoSuchTable VALUES(1);\n`));
  fs.writeFileSync(file3, utf16(`INSERT INTO ReplayCheck VALUES('b1', 33);\n`, true));

  const { tmpDir, tempDbPath } = createTempCopy(sourceDbPath);
  console.log(`temp copy: ${tempDbPath}\n`);

  console.log('Test 1: ordered statement collection (mod -> file -> statement, UTF-16 via iconv-lite)');
  const collected = collectStatements([
    { modId: 'mod-a', files: [{ label: 'part1.sql', filePath: file1 }, { label: 'part2.sql', filePath: file2 }] },
    { modId: 'mod-b', files: [{ label: 'part1.sql', filePath: file3 }] },
  ]);
  check('5 statements collected across 3 files in order', collected.total === 5, `got ${collected.total}`);
  check('per-file counts are 2/2/1', collected.files.map((f) => f.statements.length).join('/') === '2/2/1',
    collected.files.map((f) => `${f.fileLabel}:${f.statements.length}`).join(', '));
  check('UTF-16LE files decoded as utf16', collected.files[0].encoding.startsWith('utf16') && collected.files[1].encoding.startsWith('utf16'),
    `${collected.files[0].encoding}, ${collected.files[1].encoding}`);
  check('UTF-16BE file decoded as utf16', collected.files[2].encoding.startsWith('utf16'),
    collected.files[2].encoding);
  check('global order follows mod -> file -> statement',
    collected.ordered.map((s) => `${s.modId}/${s.fileLabel}#${s.stmtIndex}`).join(' ') ===
    'mod-a/part1.sql#0 mod-a/part1.sql#1 mod-a/part2.sql#0 mod-a/part2.sql#1 mod-b/part1.sql#0');

  console.log('\nTest 2: per-file SAVEPOINT abort emulation');
  const report = replayOrdered(tempDbPath, collected);
  console.log(`  statement counts: total=${report.total} executed=${report.executed} rolledBack=${report.rolledBack}`);
  report.perFile.forEach((f) => {
    console.log(`  per-file: ${f.modId}/${f.fileLabel} ${f.status} (${f.executed}/${f.statements} persisted)` +
      (f.error ? ` :: ${f.error}` : ''));
  });
  check('failing file aborted', report.perFile[1].status === 'aborted');
  check('abort names the failing statement index', report.perFile[1].failedAt === 3, `got ${report.perFile[1].failedAt}`);
  check('healthy files committed', report.perFile[0].status === 'committed' && report.perFile[2].status === 'committed');

  const readTemp = (sql, ...args) => {
    const db = new DatabaseSync(tempDbPath, { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  const rows = Object.fromEntries(readTemp('SELECT Id, Value FROM ReplayCheck').map((r) => [r.Id, r.Value]));
  check('earlier file persists (base updated, a1 present)', rows.base === 1 && rows.a1 === 11, JSON.stringify(rows));
  check('failing file rolled back (a2 absent)', !('a2' in rows), JSON.stringify(rows));
  check('later file still applied (b1 present)', rows.b1 === 33, JSON.stringify(rows));

  console.log('\nTest 3: temp-copy lifecycle (live DB never written)');
  check('temp copy lives under the OS temp dir', tempDbPath.startsWith(fs.realpathSync.native(os.tmpdir())));
  check('temp copy is not the source path', tempDbPath !== sourceDbPath);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM ReplayCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Value === 0, JSON.stringify(liveRows));
  // A probe path inside the repo working tree (never the temp dir) must fail
  // closed before any file is created there.
  const probePath = path.join(__dirname, '..', 'conflict-replay-refuse-probe.sqlite');
  let refused = false;
  try {
    replayOrdered(probePath, { ordered: [], files: [], total: 0 });
  } catch (_) { refused = true; }
  check('replay refuses a database outside the temp dir', refused && !fs.existsSync(probePath));

  console.log('\nTest 4: replay while the live DB is locked (game-style exclusive lock)');
  const lockSource = path.join(scratch, 'DebugGameplayLock.sqlite');
  {
    const seed = new DatabaseSync(lockSource);
    try {
      seed.exec('CREATE TABLE LockCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO LockCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const lockSet = [
    { modId: 'mod-a', files: [{ label: 'ok.sql', text: "INSERT INTO LockCheck VALUES('ok', 1);" }] },
    { modId: 'mod-b', files: [{ label: 'bad.sql', text: 'INSERT INTO NoSuchLock VALUES(1);' }] },
  ];
  const trial = lockedCopyTrial(lockSource, lockSet);
  check('temp copy + replay succeed while the live DB is locked',
    !trial.copyError && !!trial.locked,
    trial.copyError ? String((trial.copyError && trial.copyError.message) || trial.copyError)
      : `executed=${trial.locked && trial.locked.executed}`);
  check('locked report matches the unlocked baseline',
    !!trial.locked && JSON.stringify(trial.locked) === JSON.stringify(trial.baseline),
    trial.locked ? `locked=${trial.locked.statuses.join(' ')} baseline=${trial.baseline.statuses.join(' ')}`
      : 'no locked report');
  check('live file byte-identical afterwards', trial.liveAfter === trial.liveBefore);
  const lockLiveRows = (() => {
    const db = new DatabaseSync(lockSource, { readOnly: true });
    try { return db.prepare('SELECT Id FROM LockCheck').all(); } finally { db.close(); }
  })();
  check('live DB holds only its seed row', lockLiveRows.length === 1 && lockLiveRows[0].Id === 'base',
    JSON.stringify(lockLiveRows));

  destroyTempCopy(tmpDir);
  check('temp copy cleaned up', !fs.existsSync(tempDbPath));
  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 1.1: ALL CHECKS PASSED' : 'CONFLICT-REPLAY 1.1: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// Reviewer WARNING 1: locked live DB. holdLiveExclusiveForCopy keeps a BEGIN
// EXCLUSIVE transaction open on the fixture live DB plus an open write
// handle (fs r+), emulating the game holding DebugGameplay.sqlite while the
// conflict replay runs. Scratch fixtures only, never a real game DB.
// ---------------------------------------------------------------------------

function holdLiveExclusiveForCopy(liveDbPath) {
  const holder = new DatabaseSync(liveDbPath);
  holder.exec('BEGIN EXCLUSIVE;');
  const fd = fs.openSync(liveDbPath, 'r+');
  return {
    release() {
      try { holder.exec('ROLLBACK'); } finally {
        try { holder.close(); } finally { fs.closeSync(fd); }
      }
    },
  };
}

// lockedCopyTrial replays the same mod set once unlocked (baseline) and
// once while the live DB is held exclusive, so callers can assert the
// locked copy+report still succeed, findings match, and the live file is
// byte-identical afterwards. The fixture must seed LockCheck(Id, Value).
function lockedCopyTrial(liveDbPath, modSet) {
  const collected = collectStatements(modSet);
  const readIds = (dbPath) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM LockCheck ORDER BY Id').all(); }
    finally { db.close(); }
  };
  const summarize = (report, tempDb) => ({
    total: report.total,
    executed: report.executed,
    rolledBack: report.rolledBack,
    statuses: report.perFile.map((f) => `${f.modId}/${f.fileLabel}:${f.status}`),
    failedAt: report.perFile.map((f) => f.failedAt),
    rows: readIds(tempDb),
  });
  const liveBefore = sha256(liveDbPath);
  const base = createTempCopy(liveDbPath);
  let baseline;
  try { baseline = summarize(replayOrdered(base.tempDbPath, collected), base.tempDbPath); }
  finally { destroyTempCopy(base.tmpDir); }
  const hold = holdLiveExclusiveForCopy(liveDbPath);
  let locked = null;
  let copyError = null;
  let live = null;
  try {
    live = createTempCopy(liveDbPath);
    locked = summarize(replayOrdered(live.tempDbPath, collected), live.tempDbPath);
  } catch (e) { copyError = e; }
  finally { if (live) destroyTempCopy(live.tmpDir); hold.release(); }
  return { collected, baseline, locked, copyError, liveBefore, liveAfter: sha256(liveDbPath) };
}

// ---------------------------------------------------------------------------
// --fidelity: one fixture per task-1.2 preprocessing stage, each printing
// its stage's transform/skip flags, plus a full preprocess→replay pipeline.
// ---------------------------------------------------------------------------

function runFidelity() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };
  const flagLine = (s) => `  [${s.stage}] outcome=${s.outcome}` + Object.entries(s)
    .filter(([k]) => k !== 'stage' && k !== 'outcome')
    .map(([k, v]) => ` ${k}=${Array.isArray(v) ? v.join(',') : (v && typeof v === 'object' ? JSON.stringify(v) : v)}`)
    .join('');

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-fidelity-')));
  console.log(`conflict-replay --fidelity (task 1.2)\nscratch dir: ${scratch}`);
  const makeSource = (name, seedSql) => {
    const p = path.join(scratch, name);
    const db = new DatabaseSync(p);
    try { db.exec(seedSql); } finally { db.close(); }
    return p;
  };
  const readOne = (dbPath, sql) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).get(); } finally { db.close(); }
  };
  const readAll = (dbPath, sql) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const asCollected = (statements, label = 'fixture.sql') => ({
    ordered: [],
    files: [{ modId: 'm', fileLabel: label, statements, baseGlobalIndex: 0 }],
    total: statements.length,
  });

  console.log('\nStage 1: trigger-aware splitter (BEGIN...END aware)');
  const trigSql = [
    'CREATE TABLE TrigT(Id INTEGER PRIMARY KEY, V INTEGER);',
    'CREATE TRIGGER trg_after AFTER INSERT ON TrigT BEGIN',
    '  UPDATE TrigT SET V = 1 WHERE Id = NEW.Id;',
    '  DELETE FROM TrigT WHERE V = 0;',
    'END;',
    "INSERT INTO TrigT VALUES(10, 0);",
  ].join('\n');
  const sf = splitterFlags(trigSql);
  console.log(flagLine(sf));
  check('naive splitter fractures the trigger body', sf.naive === 5, `got naive=${sf.naive}`);
  check('trigger-aware splitter keeps the trigger whole', sf.aware === 3, `got aware=${sf.aware}`);
  check('splitter flag reports transformed', sf.outcome === 'transformed');
  const plainSf = splitterFlags("INSERT INTO T VALUES(1);\nINSERT INTO T VALUES(2);");
  console.log(flagLine(plainSf));
  check('plain SQL reports skipped:identical', plainSf.outcome === 'skipped:identical');
  const src1 = makeSource('t1.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const aware = splitStatementsTriggerAware(trigSql);
  const c1 = createTempCopy(src1);
  const rep1 = replayOrdered(c1.tempDbPath, asCollected(aware, 'trig.sql'));
  check('kept-whole trigger file commits', rep1.perFile[0].status === 'committed', rep1.perFile[0].status);
  const fired = (() => {
    const db = new DatabaseSync(c1.tempDbPath);
    try {
      db.exec('INSERT INTO TrigT VALUES(20, 0);');
      return db.prepare('SELECT V FROM TrigT WHERE Id = 20').get().V;
    } finally { db.close(); }
  })();
  check('replayed trigger fires (V set to 1)', fired === 1, `got ${fired}`);
  destroyTempCopy(c1.tmpDir);

  console.log('\nStage 2: double-quoted-string rewrite');
  const dqVal = rewriteDoubleQuotes('INSERT INTO DQ2 VALUES("lit1", "lit2");');
  console.log(flagLine({ stage: 'double-quote-rewrite', outcome: dqVal.outcome, rewritten: dqVal.rewritten, keptIdentifiers: dqVal.kept }));
  check('value-position literals rewritten', dqVal.outcome === 'transformed' && dqVal.rewritten === 2,
    `rewritten=${dqVal.rewritten}`);
  check('rewrite emits single-quoted SQL', dqVal.text === "INSERT INTO DQ2 VALUES('lit1', 'lit2');", dqVal.text);
  const dqDdl = rewriteDoubleQuotes('CREATE TABLE "Hmm"("C" TEXT);');
  console.log(flagLine({
    stage: 'double-quote-rewrite',
    outcome: dqDdl.outcome,
    rewritten: dqDdl.rewritten,
    keptIdentifiers: dqDdl.kept,
    ...(dqDdl.rewritten > 0 ? {} : { reason: 'no-double-quoted-literals' }),
  }));
  check('quoted identifiers kept verbatim', dqDdl.outcome === 'skipped' && dqDdl.kept === 2,
    `rewritten=${dqDdl.rewritten} kept=${dqDdl.kept}`);
  check('DDL text untouched', dqDdl.text === 'CREATE TABLE "Hmm"("C" TEXT);', dqDdl.text);
  const src2 = makeSource('t2.sqlite', 'CREATE TABLE DQ2(A TEXT, B TEXT);');
  const c2 = createTempCopy(src2);
  const rep2 = replayOrdered(c2.tempDbPath, asCollected([dqVal.text], 'dq.sql'));
  check('rewritten statement executes', rep2.perFile[0].status === 'committed');
  check('rewritten row lands', readOne(c2.tempDbPath, "SELECT A FROM DQ2 WHERE B = 'lit2'").A === 'lit1');
  destroyTempCopy(c2.tmpDir);

  console.log('\nStage 3: Make_Hash JS stub');
  const mhStmts = [
    'CREATE TABLE MH(Id TEXT PRIMARY KEY, H INTEGER);',
    "INSERT INTO MH VALUES('a', Make_Hash('abc'));",
  ];
  check('Make_Hash call detected', needsMakeHash(mhStmts) === true);
  check('plain SQL needs no stub', needsMakeHash(['SELECT 1;']) === false);
  const src3 = makeSource('t3.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const c3a = createTempCopy(src3);
  const repNo = replayOrdered(c3a.tempDbPath, asCollected(mhStmts, 'mh.sql'), { installStubs: false });
  console.log(`  without stub: status=${repNo.perFile[0].status} makeHashStub=${repNo.makeHashStub} (${repNo.makeHashStubReason})`);
  check('without stub the file aborts', repNo.perFile[0].status === 'aborted' && repNo.makeHashStub === 'skipped');
  destroyTempCopy(c3a.tmpDir);
  const c3b = createTempCopy(src3);
  const repYes = replayOrdered(c3b.tempDbPath, asCollected(mhStmts, 'mh.sql'), { installStubs: true });
  console.log(`  with stub: status=${repYes.perFile[0].status} makeHashStub=${repYes.makeHashStub}`);
  check('with stub the file commits', repYes.perFile[0].status === 'committed' && repYes.makeHashStub === 'installed');
  const hVal = readOne(c3b.tempDbPath, "SELECT H FROM MH WHERE Id = 'a'").H;
  check('stub value is the declared deterministic placeholder', hVal === fnv1a32('abc'), `got ${hVal}`);
  destroyTempCopy(c3b.tmpDir);

  console.log('\nStage 4: XML→SQL converter (Row/Replace/Update/Delete/InsertOrIgnore + raw SQL)');
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<GameData>',
    '  <Traits>',
    '    <Row TraitType="TRAIT_A" Name="Alpha" Cost="100"/>',
    '    <Replace TraitType="TRAIT_B" Name="Beta"/>',
    '    <InsertOrIgnore TraitType="TRAIT_C" Name="Gamma"/>',
    '    <Update><Where TraitType="TRAIT_A"/><Set Name="Alpha2"/></Update>',
    '    <Delete TraitType="TRAIT_B"/>',
    '  </Traits>',
    "  <Sql>UPDATE Traits SET Cost = 0 WHERE TraitType = 'TRAIT_C';</Sql>",
    '</GameData>',
  ].join('\n');
  const conv = convertXmlToSql(xml);
  console.log(flagLine(conv.flags));
  check('five ops converted plus one raw chunk', conv.statements.length === 5 && conv.rawChunks.length === 1,
    `statements=${conv.statements.length} raw=${conv.rawChunks.length}`);
  check('op counts cover all five forms',
    conv.flags.opCounts.Row === 1 && conv.flags.opCounts.Replace === 1
    && conv.flags.opCounts.InsertOrIgnore === 1 && conv.flags.opCounts.Update === 1
    && conv.flags.opCounts.Delete === 1,
    JSON.stringify(conv.flags.opCounts));
  check('table named', conv.flags.tables.join(',') === 'Traits', conv.flags.tables.join(','));
  const notXml = convertXmlToSql('INSERT INTO T VALUES(1);');
  console.log(flagLine(notXml.flags));
  check('non-XML input skipped as not-xml', notXml.flags.outcome === 'skipped' && notXml.flags.reason === 'not-xml');
  const src4 = makeSource('t4.sqlite',
    'CREATE TABLE Traits(TraitType TEXT PRIMARY KEY, Name TEXT, Cost INTEGER);' +
    "INSERT INTO Traits VALUES('TRAIT_B', 'Old', 5);");
  const c4 = createTempCopy(src4);
  const rep4 = replayOrdered(c4.tempDbPath, asCollected(splitStatementsTriggerAware(conv.sqlText), 'data.xml'));
  check('converted statements all commit', rep4.perFile[0].status === 'committed', rep4.perFile[0].status);
  const traits = Object.fromEntries(readAll(c4.tempDbPath, 'SELECT TraitType, Name, Cost FROM Traits')
    .map((r) => [r.TraitType, [r.Name, r.Cost]]));
  check('Row + Update applied (TRAIT_A renamed)', traits.TRAIT_A && traits.TRAIT_A[0] === 'Alpha2', JSON.stringify(traits));
  check('Delete applied (TRAIT_B gone)', !('TRAIT_B' in traits), JSON.stringify(traits));
  check('raw SQL applied (TRAIT_C cost zeroed)', traits.TRAIT_C && traits.TRAIT_C[1] === 0, JSON.stringify(traits));
  destroyTempCopy(c4.tmpDir);

  console.log('\nStage 5: FK on/off mode parameter');
  const fkFile = ["INSERT INTO Child VALUES('c1', 'missing');"];
  const fkSeed = 'CREATE TABLE Parent(Id TEXT PRIMARY KEY);' +
    'CREATE TABLE Child(Id TEXT PRIMARY KEY, PId TEXT REFERENCES Parent(Id));' +
    "INSERT INTO Parent VALUES('p1');";
  const src5 = makeSource('t5.sqlite', fkSeed);
  const c5a = createTempCopy(src5);
  const repOff = replayOrdered(c5a.tempDbPath, asCollected(fkFile, 'fk.sql'), { foreignKeys: false });
  console.log(`  FK-OFF: status=${repOff.perFile[0].status} fkMode=${repOff.fkMode}`);
  check('FK-OFF commits the orphan row', repOff.perFile[0].status === 'committed' && repOff.fkMode === 'OFF');
  destroyTempCopy(c5a.tmpDir);
  const c5b = createTempCopy(src5);
  const repOn = replayOrdered(c5b.tempDbPath, asCollected(fkFile, 'fk.sql'), { foreignKeys: true });
  console.log(`  FK-ON: status=${repOn.perFile[0].status} fkMode=${repOn.fkMode}`);
  check('FK-ON aborts the orphan row', repOn.perFile[0].status === 'aborted' && repOn.fkMode === 'ON');
  destroyTempCopy(c5b.tmpDir);

  console.log('\nFull pipeline: preprocess → ordered replay with per-file stage flags');
  const pipeSet = [
    {
      modId: 'mod-pipe',
      files: [
        {
          label: 'schema.sql',
          text: 'CREATE TABLE XOps(K TEXT PRIMARY KEY, V TEXT);\n'
            + 'CREATE TABLE DQ(Id INTEGER PRIMARY KEY, V TEXT);\n'
            + 'CREATE TABLE MH(Id TEXT PRIMARY KEY, H INTEGER);\n'
            + 'CREATE TABLE TrigT(Id INTEGER PRIMARY KEY, V INTEGER);',
        },
        {
          label: 'trig.sql',
          text: 'CREATE TRIGGER trg_after AFTER INSERT ON TrigT BEGIN\n'
            + '  UPDATE TrigT SET V = 1 WHERE Id = NEW.Id;\n'
            + 'END;\n'
            + 'INSERT INTO TrigT VALUES(1, 0);',
        },
        { label: 'dq.sql', text: 'INSERT INTO DQ VALUES(1, "hello");' },
        {
          label: 'data.xml',
          text: '<GameData><XOps><Row K="k1" V="v1"/></XOps>'
            + "<Sql>INSERT INTO XOps VALUES('raw', 'R');</Sql></GameData>",
        },
        { label: 'mh.sql', text: "INSERT INTO MH VALUES('a', Make_Hash('abc'));" },
      ],
    },
  ];
  const piped = collectStatements(pipeSet, { preprocess: true });
  piped.files.forEach((f) => {
    console.log(`  file ${f.fileLabel}: ${f.statements.length} statements`);
    f.stages.forEach((s) => console.log(`   ${flagLine(s)}`));
  });
  check('pipeline collects 10 statements', piped.total === 10, `got ${piped.total}`);
  const byLabel = Object.fromEntries(piped.files.map((f) => [f.fileLabel, f]));
  const stageOf = (label, stage) => byLabel[label].stages.find((s) => s.stage === stage).outcome;
  check('trig.sql splitter transformed', stageOf('trig.sql', 'splitter') === 'transformed');
  check('dq.sql rewrite transformed', stageOf('dq.sql', 'double-quote-rewrite') === 'transformed');
  check('data.xml converted', stageOf('data.xml', 'xml-to-sql') === 'transformed');
  check('mh.sql stub installed-at-replay', stageOf('mh.sql', 'make-hash-stub') === 'installed-at-replay');
  check('schema.sql all stages skipped',
    byLabel['schema.sql'].stages.every((s) => s.outcome.startsWith('skipped')));
  const src6 = makeSource('t6.sqlite', 'CREATE TABLE _Seed(Id INTEGER);');
  const c6 = createTempCopy(src6);
  const rep6 = replayOrdered(c6.tempDbPath, piped);
  console.log(`  replay: total=${rep6.total} executed=${rep6.executed} fkMode=${rep6.fkMode} makeHashStub=${rep6.makeHashStub}`);
  check('pipeline replay commits every file',
    rep6.perFile.every((f) => f.status === 'committed'),
    rep6.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('pipeline replay executed all 10', rep6.executed === 10, `got ${rep6.executed}`);
  const fired6 = (() => {
    const db = new DatabaseSync(c6.tempDbPath);
    try {
      db.exec('INSERT INTO TrigT VALUES(99, 0);');
      return db.prepare('SELECT V FROM TrigT WHERE Id = 99').get().V;
    } finally { db.close(); }
  })();
  check('pipeline trigger fires', fired6 === 1, `got ${fired6}`);
  check('pipeline double-quoted row lands', readOne(c6.tempDbPath, 'SELECT V FROM DQ WHERE Id = 1').V === 'hello');
  check('pipeline XML rows land',
    readAll(c6.tempDbPath, 'SELECT K FROM XOps ORDER BY K').map((r) => r.K).join(',') === 'k1,raw');
  check('pipeline stub hash lands', readOne(c6.tempDbPath, "SELECT H FROM MH WHERE Id = 'a'").H === fnv1a32('abc'));
  destroyTempCopy(c6.tmpDir);

  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 1.2: ALL FIDELITY CHECKS PASSED' : 'CONFLICT-REPLAY 1.2: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// Task 1.3: criteria gating evaluation (ActionCriteria) with
// skipped-with-reason reporting. Gated-out actions are skipped (never
// replayed) and reported with their reason; gated-in actions replay
// normally; gates this harness cannot read replay normally but are flagged
// gate-unknown, never silently treated as decided.
//
// Gate model: one gate mirrors one ActionCriteria set:
//   { any: false, conditions: [{ type, value, inverse }] }
// attached per file as file.gate (file.criteria accepted as an alias) and
// carried through collectStatements onto the file entry. An absent gate, or
// a gate with no conditions, is ungated and replays. The evaluation context
// mirrors the profile read in loadorder.js:
//   { enabled: [modIds on in the profile], installed: [modIds present] }
// Only ModInUse / ModIsEnabled are decidable here (measured in
// loadorder.js: ModInUse is scoped to the active profile, like
// ModIsEnabled). Every other criterion type is unknown, with a per-type
// reason in the same shape as unreadableWhy. Any=true is OR, Any=false
// (default) is AND, combined three-valued exactly like verdictOf: one unmet
// defeats AND, one met carries OR, and anything left undecided stays null
// with its unknown list attached.
// ---------------------------------------------------------------------------

const GATE_DECIDABLE = new Set(['ModInUse', 'ModIsEnabled']);

// Comparison key for mod ids in gates: lowercase, brace-stripped, trimmed.
// Local (no modinfo import) so this phase script stays dependency-free.
function normGateId(id) {
  return String(id == null ? '' : id).replace(/[{}]/g, '').trim().toLowerCase();
}

function gateSetOf(list) {
  const arr = list instanceof Set ? [...list]
    : list instanceof Map ? [...list.keys()]
      : (list || []);
  const out = new Set();
  for (const v of arr) {
    const k = normGateId(v);
    if (k) out.add(k);
  }
  return out;
}

function gateContextOf(ctx) {
  const c = ctx || {};
  return {
    enabled: gateSetOf(c.enabled),
    installed: gateSetOf(c.installed),
    asserted: c.asserted !== undefined ? c.asserted : null,
  };
}

// Why a condition cannot be read here, in checkable words (same shape as
// unreadableWhy in loadorder.js; shortened, with no display-name lookup).
function gateUnreadableWhy(cond) {
  const v = cond.value;
  switch (cond.type) {
    case 'ConfigurationValueMatches':
      return `needs a game option to be ${v} - a game option picked in the main menu, so it is not known until the game starts`;
    case 'RuleSetInUse':
      return `needs the ${v} ruleset - you choose the ruleset when you start a game, so replay cannot see it`;
    case 'GameCoreInUse':
      return `needs the ${v} game core - that is a matter of which DLC is installed`;
    case 'LeaderPlayable':
      return `needs ${v} to be playable - which depends on who is in the game, not on the profile`;
    default:
      return `depends on ${cond.type}, which replay cannot see`;
  }
}

// Assumed-setup keys for one gate condition, mirroring setupKeysFor in
// loadorder.js (local: this phase script stays dependency-free, like the
// normGateId note above). RuleSetInUse / GameCoreInUse / LeaderPlayable read
// KIND:<Value>; ConfigurationValueMatches reads the Group/ConfigurationId/
// Value triple (props first, cond-level fields as fallback) plus the
// GAMEMODE:<id> shorthand for an enable triple. Anything else, or a row
// missing the property its key needs, yields no key: never guessed.
//
// Comma lists read as OR, mirroring the view and the catalog: one condition
// naming "Expansion1,Expansion2" yields one key per single (LeaderPlayable
// singles reduce to their leader tail), and gateAssumedMatch below satisfies
// the condition when ANY listed single is asserted.
function gateCommaSingles(value) {
  return String(value == null ? '' : value).split(',').map((s) => s.trim()).filter((s) => s);
}

function gateLeaderTail(single) {
  const s = String(single == null ? '' : single).trim();
  if (!s) return '';
  return s.includes('::') ? s.slice(s.lastIndexOf('::') + 2).trim() : s;
}

function gateSetupKeysFor(cond) {
  const c = cond || {};
  if (c.type === 'RuleSetInUse' || c.type === 'GameCoreInUse' || c.type === 'LeaderPlayable') {
    const kind = c.type === 'RuleSetInUse' ? 'RULESET' : c.type === 'GameCoreInUse' ? 'CORE' : 'LEADER';
    const out = [];
    for (const s of gateCommaSingles(c.value)) {
      const single = c.type === 'LeaderPlayable' ? gateLeaderTail(s) : s;
      if (!single) continue;
      out.push(`${kind}:${single}`);
    }
    return [...new Set(out)];
  }
  if (c.type === 'ConfigurationValueMatches') {
    const p = (c.props && typeof c.props === 'object') ? c.props : {};
    const pick = (k) => (p[k] != null ? p[k] : c[k]);
    const g = String(pick('Group') == null ? '' : pick('Group')).trim();
    const cid = String(pick('ConfigurationId') == null ? '' : pick('ConfigurationId')).trim();
    if (!g || !cid) return [];
    const out = [];
    for (const single of gateCommaSingles(pick('Value'))) {
      out.push(`CONFIG:${g}/${cid}=${single}`);
      if (single === '1' && (g === 'Game' || cid.startsWith('GAMEMODE_'))) out.push(`GAMEMODE:${cid}`);
    }
    return [...new Set(out)];
  }
  return [];
}

// Whether an asserted store holds a key satisfying this condition. Accepts a
// key array, a Set, a raw asserted map, or a readSetup view, mirroring
// isAsserted in gamesetup.js without importing it. Null or empty asserts
// nothing; junk answers false, never throws.
function gateIsAsserted(asserted, key) {
  if (!asserted) return false;
  if (asserted instanceof Set) return asserted.has(key);
  if (Array.isArray(asserted)) return asserted.includes(key);
  const map = asserted.asserted && typeof asserted.asserted === 'object' ? asserted.asserted : asserted;
  return !!map && typeof map === 'object' && map[key] === true;
}

function gateAssumedMatch(cond, asserted) {
  if (!asserted) return false;
  const keys = gateSetupKeysFor(cond);
  if (!keys.length) return false;
  return keys.some((k) => {
    try { return gateIsAsserted(asserted, k); } catch (_) { return false; }
  });
}

// One condition, three ways: satisfied, not satisfied, or not readable here.
// Mirrors evalCondition in loadorder.js, including the inverted-absence rule
// (NOT ModInUse(absent-mod) is satisfied) and never guessing.
function evalGateCondition(cond, ctx) {
  const c = cond || {};
  if (!GATE_DECIDABLE.has(c.type)) {
    // Assumed game setup (game-setup task 2.2), read-only: a matching
    // assertion satisfies the condition, flagged assumed so the verdict can
    // label it. Anything else stays undecidable with byte-identical wording,
    // so measured verdicts never move when nothing is asserted.
    if (ctx && ctx.asserted && gateAssumedMatch(c, ctx.asserted)) {
      return c.inverse
        ? { sat: false, needs: gateUnreadableWhy(c), assumed: true }
        : { sat: true, needs: null, assumed: true };
    }
    return { sat: null, needs: gateUnreadableWhy(c), assumed: false };
  }
  const target = normGateId(c.value);
  if (!ctx.installed.has(target)) {
    return c.inverse
      ? { sat: true, needs: null, assumed: false }
      : { sat: false, needs: `needs ${c.value}, which is not installed`, assumed: false };
  }
  const on = ctx.enabled.has(target);
  return {
    sat: c.inverse ? !on : on,
    needs: c.inverse
      ? `needs ${c.value} to be off in this profile`
      : `needs ${c.value} to be on in this profile`,
    assumed: false,
  };
}

// One gate set to a verdict: { willRun, reason, unknown, assumed }. Absent gate or
// no conditions means ungated (willRun true), matching verdictOf.
function evaluateGate(gate, ctx) {
  const items = (gate && gate.conditions) || [];
  if (items.length === 0) return { willRun: true, reason: null, unknown: [], assumed: false };
  const context = ctx && ctx.enabled instanceof Set ? ctx : gateContextOf(ctx);
  const unknown = [];
  const unmet = [];
  let read = 0;
  let met = 0;
  let metAssumed = 0;
  let metMeasured = 0;
  let unmetAssumed = 0;
  let unmetMeasured = 0;
  for (const cond of items) {
    const r = evalGateCondition(cond, context);
    if (r.sat === null) { unknown.push({ type: cond.type, why: r.needs }); continue; }
    read += 1;
    if (r.sat) {
      met += 1;
      if (r.assumed) metAssumed += 1;
      else metMeasured += 1;
    } else {
      unmet.push(r.needs);
      if (r.assumed) unmetAssumed += 1;
      else unmetMeasured += 1;
    }
  }
  const any = !!(gate && gate.any);
  let willRun = null;
  if (any) {
    if (met > 0) willRun = true;
    else if (read > 0 && unknown.length === 0) willRun = false;
  } else {
    if (unmet.length > 0) willRun = false;
    else if (read > 0 && unknown.length === 0) willRun = true;
  }
  // Assumed verdicts mirror verdictOf in loadorder.js: true only where removing
  // the assertions would leave a different willRun. Undecided rows are never
  // flagged: fewer unknowns is not running.
  let assumed = false;
  if (willRun === true) {
    assumed = any ? (metAssumed > 0 && metMeasured === 0) : metAssumed > 0;
  } else if (willRun === false) {
    assumed = any ? unmetAssumed > 0 : (unmetAssumed > 0 && unmetMeasured === 0);
  }
  if (willRun === true) return { willRun: true, reason: null, unknown, assumed };
  if (willRun === false) return { willRun: false, reason: unmet.join('; ') || 'a condition is not met', unknown, assumed };
  return { willRun: null, reason: null, unknown, assumed: false };
}

// ---------------------------------------------------------------------------
// Task 2.1: history-trigger provenance (simonw-style). One AFTER INSERT
// trigger per table logs every column; one AFTER UPDATE OF trigger per
// column logs exactly that column. UPDATE OF fires on assignment even when
// the value is unchanged, so two files writing identical values still
// produce two provenance rows (post-hoc diffing would miss that). The
// current writer lives in _cr_writer (one row, id=1); replay sets it before
// each statement and triggers copy it into _cr_provenance. Both tables are
// _cr_-prefixed so trigger installation skips them; provenance rows written
// inside a per-file SAVEPOINT roll back with the file, matching abort
// semantics. Temp copies only, like everything else here.
// ---------------------------------------------------------------------------

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function qLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function listUserTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return rows.map((r) => r.name).filter((n) => n !== undefined
    && !n.startsWith('sqlite_') && !n.startsWith('_cr_'));
}

function getTableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${qIdent(table)})`).all();
}

function tableIsWithoutRowid(db, table) {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table);
  return !!row && !!row.sql && /WITHOUT\s+ROWID/i.test(row.sql);
}

function pkExprNew(pkCols, fallbackCols) {
  const cast = (c) => `COALESCE(CAST(NEW.${qIdent(c)} AS TEXT), 'NULL')`;
  if (pkCols.length === 1) return cast(pkCols[0]);
  if (pkCols.length > 1) return pkCols.map(cast).join(" || '|' || ");
  if (fallbackCols && fallbackCols.length > 0) return fallbackCols.map(cast).join(" || '|' || ");
  return 'CAST(NEW.rowid AS TEXT)';
}

function ensureProvenanceSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS "_cr_provenance"('
    + 'seq INTEGER PRIMARY KEY AUTOINCREMENT, '
    + 'tbl TEXT NOT NULL, pk TEXT, col TEXT NOT NULL, '
    + 'modId TEXT, fileLabel TEXT, stmtIndex INTEGER, globalIndex INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS "_cr_writer"('
    + 'id INTEGER PRIMARY KEY CHECK(id = 1), '
    + 'modId TEXT, fileLabel TEXT, stmtIndex INTEGER, globalIndex INTEGER)');
  db.exec('INSERT OR IGNORE INTO "_cr_writer"(id) VALUES(1)');
}

function installProvenanceTriggers(db, installed) {
  const tables = listUserTables(db);
  for (const table of tables) {
    if (installed.has(table)) continue;
    const cols = getTableColumns(db, table);
    if (cols.length === 0) { installed.add(table); continue; }
    const pkCols = cols.filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const useRowid = pkCols.length === 0 && !tableIsWithoutRowid(db, table);
    const pkE = useRowid ? 'CAST(NEW.rowid AS TEXT)'
      : pkExprNew(pkCols, cols.map((c) => c.name));
    const provCols = '(tbl, pk, col, modId, fileLabel, stmtIndex, globalIndex)';
    const insBody = cols.map((c) => 'INSERT INTO "_cr_provenance"'
      + `${provCols} SELECT ${qLit(table)}, ${pkE}, ${qLit(c.name)}, `
      + 'w.modId, w.fileLabel, w.stmtIndex, w.globalIndex '
      + 'FROM "_cr_writer" w WHERE w.id = 1;').join(' ');
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${qIdent(`_cr_ins__${table}`)} `
      + `AFTER INSERT ON ${qIdent(table)} BEGIN ${insBody} END;`);
    for (const c of cols) {
      const one = 'INSERT INTO "_cr_provenance"'
        + `${provCols} SELECT ${qLit(table)}, ${pkE}, ${qLit(c.name)}, `
        + 'w.modId, w.fileLabel, w.stmtIndex, w.globalIndex '
        + 'FROM "_cr_writer" w WHERE w.id = 1;';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${qIdent(`_cr_upd__${table}__${c.name}`)} `
        + `AFTER UPDATE OF ${qIdent(c.name)} ON ${qIdent(table)} `
        + `BEGIN ${one} END;`);
    }
    installed.add(table);
  }
}

function setProvenanceWriter(db, writer) {
  db.prepare('UPDATE "_cr_writer" SET modId = ?, fileLabel = ?, stmtIndex = ?, globalIndex = ? WHERE id = 1')
    .run(writer.modId, writer.fileLabel, writer.stmtIndex, writer.globalIndex);
}

function readProvenanceWrites(db) {
  return db.prepare('SELECT seq, tbl AS "table", pk, col AS "column", '
    + 'modId, fileLabel, stmtIndex, globalIndex '
    + 'FROM "_cr_provenance" ORDER BY globalIndex, seq').all();
}

// Per-file fidelity limitations feeding collision flags: only stages that
// actually transformed (or installed the stub) limit fidelity. Splitter
// kept-whole is heuristic handling, so it flags too.
function fileLimitationFlags(stages) {
  const out = [];
  for (const s of stages || []) {
    if (s.stage === 'xml-to-sql' && s.outcome === 'transformed') out.push('xml-to-sql');
    else if (s.stage === 'double-quote-rewrite' && s.outcome === 'transformed') out.push('double-quoted-string-rewrite');
    else if (s.stage === 'make-hash-stub' && s.outcome === 'installed-at-replay') out.push('make-hash-stub');
    else if (s.stage === 'splitter' && s.outcome === 'transformed') out.push('trigger-aware-splitter');
  }
  return out;
}

// Group provenance rows by cell; cells with >=2 distinct writing statements
// are contested. Winner is the last writer in replay order; losers are the
// earlier writers in replay order. Single-writer cells carry no collision.
function buildCollisions(provWrites, collected) {
  const byCell = new Map();
  for (const w of provWrites || []) {
    const key = `${w.table}\x1f${w.pk}\x1f${w.column}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(w);
  }
  const fileByWriter = new Map();
  for (const f of (collected && collected.files) || []) {
    for (let s = 0; s < (f.statements || []).length; s += 1) {
      fileByWriter.set(`${f.modId}\x1f${f.fileLabel}\x1f${s}`, f);
    }
  }
  const collisions = [];
  for (const rows of byCell.values()) {
    const ordered = [...rows].sort((a, b) => (a.globalIndex - b.globalIndex) || (a.seq - b.seq));
    const seen = new Map();
    for (const w of ordered) {
      if (!seen.has(w.globalIndex)) seen.set(w.globalIndex, w);
    }
    if (seen.size < 2) continue;
    const writers = [...seen.values()];
    const winner = writers[writers.length - 1];
    const losers = writers.slice(0, -1);
    const flagSet = new Set();
    for (const w of writers) {
      const f = fileByWriter.get(`${w.modId}\x1f${w.fileLabel}\x1f${w.stmtIndex}`);
      for (const flag of fileLimitationFlags(f && f.stages)) flagSet.add(flag);
    }
    collisions.push({
      table: ordered[0].table,
      pk: ordered[0].pk,
      column: ordered[0].column,
      winner: {
        modId: winner.modId,
        fileLabel: winner.fileLabel,
        stmtIndex: winner.stmtIndex,
        globalIndex: winner.globalIndex,
      },
      losers: losers.map((w) => ({
        modId: w.modId,
        fileLabel: w.fileLabel,
        stmtIndex: w.stmtIndex,
        globalIndex: w.globalIndex,
      })),
      writes: writers.length,
      fidelityLimited: [...flagSet],
    });
  }
  collisions.sort((a, b) => (a.winner.globalIndex - b.winner.globalIndex)
    || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0)
    || (String(a.pk) < String(b.pk) ? -1 : String(a.pk) > String(b.pk) ? 1 : 0)
    || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  return collisions;
}

function formatCollision(c) {
  const who = (w) => `${w.modId}/${w.fileLabel}#${w.stmtIndex} (global ${w.globalIndex})`;
  const losers = c.losers.map(who).join(', ');
  const flag = c.fidelityLimited.length ? ` [fidelity-limited: ${c.fidelityLimited.join(',')}]` : '';
  return `${c.table} pk=${c.pk} col=${c.column} writes=${c.writes} `
    + `winner=${who(c.winner)} losers=[${losers}]${flag}`;
}

// The leading SQL verb of a statement (UPDATE, DELETE, INSERT, ...), skipping
// leading whitespace and -- / * * / comments the splitter keeps. Null when
// there is no leading word. Only UPDATE/DELETE feed the zero-rows flag.
function leadingVerb(sql) {
  let s = String(sql == null ? '' : sql);
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      if (nl < 0) return null;
      s = s.slice(nl + 1);
      continue;
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      if (end < 0) return null;
      s = s.slice(end + 2);
      continue;
    }
    break;
  }
  const m = /^[A-Za-z]+/.exec(s);
  return m ? m[0].toUpperCase() : null;
}

function formatZeroRows(z) {
  const flag = z.fidelityLimited.length ? ` [fidelity-limited: ${z.fidelityLimited.join(',')}]` : '';
  return `${z.verb} ${z.modId}/${z.fileLabel}#${z.stmtIndex} (global ${z.globalIndex}) matched no rows${flag}`;
}

// ---------------------------------------------------------------------------
// --gates: one gated-in and one gated-out action prove skipped-with-reason
// reporting. The gated-in file replays; the gated-out file is skipped (never
// executed) and named with its reason. Temp copies only, as ever.
// ---------------------------------------------------------------------------

function runGates() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-gates-')));
  console.log(`conflict-replay --gates (task 1.3)\nscratch dir: ${scratch}`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE GateCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO GateCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const ON_ID = 'mod-on-1111';
  const OFF_ID = 'mod-off-2222';
  const gatesCtx = { enabled: [ON_ID], installed: [ON_ID, OFF_ID] };
  const gateOn = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID, inverse: false }] };
  const gateOff = { any: false, conditions: [{ type: 'ModInUse', value: OFF_ID, inverse: false }] };
  const modSet = [
    { modId: 'mod-on', files: [{ label: 'on.sql', text: "INSERT INTO GateCheck VALUES('on', 1);", gate: gateOn }] },
    { modId: 'mod-off', files: [{ label: 'off.sql', text: "INSERT INTO GateCheck VALUES('off', 2);", gate: gateOff }] },
  ];

  console.log('\nTest 1: gate evaluation (ActionCriteria semantics)');
  const vOn = evaluateGate(gateOn, gatesCtx);
  const vOff = evaluateGate(gateOff, gatesCtx);
  check('gated-in action will run', vOn.willRun === true, JSON.stringify(vOn));
  check('gated-out action will not run', vOff.willRun === false, JSON.stringify(vOff));
  check('gated-out reason names the missing mod state', /mod-off-2222 to be on in this profile/.test(vOff.reason || ''), vOff.reason);
  check('absent gate is ungated', evaluateGate(null, gatesCtx).willRun === true);
  check('empty conditions are ungated', evaluateGate({ any: false, conditions: [] }, gatesCtx).willRun === true);
  const vUnknown = evaluateGate({ any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_1' }] }, gatesCtx);
  check('unreadable type stays undecided with its reason',
    vUnknown.willRun === null && vUnknown.unknown.length === 1, JSON.stringify(vUnknown.unknown));
  check('inverted absence is satisfied',
    evaluateGate({ conditions: [{ type: 'ModInUse', value: 'never-installed', inverse: true }] }, gatesCtx).willRun === true);
  check('ANY with one met condition runs',
    evaluateGate({ any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'ModInUse', value: ON_ID }] }, gatesCtx).willRun === true);
  check('AND with one unmet condition does not run',
    evaluateGate({ conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'ModInUse', value: OFF_ID }] }, gatesCtx).willRun === false);

  console.log('\nTest 2: collection carries gates onto file entries');
  const collected = collectStatements(modSet);
  check('both files collected with one statement each',
    collected.total === 2 && collected.files.map((f) => f.statements.length).join('/') === '1/1',
    `total=${collected.total}`);
  check('gates ride along on the file entries',
    JSON.stringify(collected.files[0].gate) === JSON.stringify(gateOn)
    && JSON.stringify(collected.files[1].gate) === JSON.stringify(gateOff));

  console.log('\nTest 3: replay skips gated-out files (never executed) with reason');
  const c1 = createTempCopy(sourceDbPath);
  const report = replayOrdered(c1.tempDbPath, collected, { gates: gatesCtx });
  console.log(`  replay: total=${report.total} executed=${report.executed} skippedGated=${report.skippedGated}`);
  report.perFile.forEach((f) => {
    console.log(`  per-file: ${f.modId}/${f.fileLabel} ${f.status}`
      + (f.gate && f.gate.reason ? ` :: ${f.gate.reason}` : ''));
  });
  check('gated-in file committed', report.perFile[0].status === 'committed');
  check('gated-out file skipped-gated, never replayed', report.perFile[1].status === 'skipped-gated');
  check('skipped file carries its reason',
    /mod-off-2222 to be on in this profile/.test((report.perFile[1].gate && report.perFile[1].gate.reason) || ''));
  check('report lists the gated-out write with reason',
    report.gatedOut.length === 1 && report.gatedOut[0].fileLabel === 'off.sql'
    && /mod-off-2222 to be on in this profile/.test(report.gatedOut[0].reason),
    JSON.stringify(report.gatedOut));
  check('executed counts only the gated-in statement', report.executed === 1 && report.skippedGated === 1,
    `executed=${report.executed} skippedGated=${report.skippedGated}`);
  const rows = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM GateCheck').all().map((r) => r.Id).sort(); } finally { db.close(); }
  })();
  check('gated-in row landed', rows.includes('on'), rows.join(','));
  check('gated-out row never landed', !rows.includes('off'), rows.join(','));
  destroyTempCopy(c1.tmpDir);

  console.log('\nTest 4: gating is opt-in (no context replays everything, as 1.1 did)');
  const c2 = createTempCopy(sourceDbPath);
  const plain = replayOrdered(c2.tempDbPath, collected);
  check('both files commit without a gates context',
    plain.perFile.every((f) => f.status === 'committed') && plain.executed === 2,
    plain.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  destroyTempCopy(c2.tmpDir);

  console.log('\nTest 5: temp-copy lifecycle (live DB never written)');
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM GateCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base', JSON.stringify(liveRows));

  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 1.3: ALL GATE CHECKS PASSED' : 'CONFLICT-REPLAY 1.3: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// --provenance (task 2.1): two-mod fixture writing the same cell proves
// history-trigger provenance plus the contested-cell collision report.
// mod-a writes hero.Value=1, mod-b writes hero.Value=2: winner is mod-b,
// loser is mod-a, in replay order. A twin pair writing the identical value
// still collides (trigger attribution, not diffing). A solo single-writer
// cell carries no collision. Temp copies only, as ever.
// ---------------------------------------------------------------------------

function runProvenance() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-prov-')));
  console.log(`conflict-replay --provenance (task 2.1)\nscratch dir: ${scratch}`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE ProvCheck(Id TEXT PRIMARY KEY, Value INTEGER, Note TEXT);'
        + "INSERT INTO ProvCheck VALUES('hero', 0, 'seed');"
        + "INSERT INTO ProvCheck VALUES('twin', 0, 'seed');"
        + "INSERT INTO ProvCheck VALUES('solo', 0, 'seed');");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);

  const modSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Value = 1 WHERE Id = 'hero';" }] },
    {
      modId: 'mod-b',
      files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 2 WHERE Id = 'hero';" }],
    },
  ];
  const twinSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Value = 5 WHERE Id = 'twin';" }] },
    {
      modId: 'mod-b',
      files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 5 WHERE Id = 'twin';" }],
    },
  ];
  const soloSet = [
    { modId: 'mod-a', files: [{ label: 'a.sql', text: "UPDATE ProvCheck SET Note = 'one' WHERE Id = 'solo';" }] },
    { modId: 'mod-b', files: [{ label: 'b.sql', text: "UPDATE ProvCheck SET Value = 9 WHERE Id = 'solo';" }] },
  ];

  console.log('\nTest 1: contested cell names winner plus loser in replay order');
  const c1 = createTempCopy(sourceDbPath);
  const collected = collectStatements(modSet);
  const report = replayOrdered(c1.tempDbPath, collected, { provenance: true });
  check('provenance recorded', !!report.provenance && report.provenance.writes.length >= 2,
    `writes=${report.provenance && report.provenance.writes.length}`);
  check('exactly one collision', report.provenance.collisions.length === 1,
    JSON.stringify(report.provenance.collisions.map(formatCollision)));
  const col = report.provenance.collisions[0];
  if (col) console.log(`  collision: ${formatCollision(col)}`);
  check('collision names table, key, column',
    !!col && col.table === 'ProvCheck' && col.pk === 'hero' && col.column === 'Value',
    col ? `${col.table} pk=${col.pk} col=${col.column}` : 'no collision');
  check('winner is the later file in replay order',
    !!col && col.winner.modId === 'mod-b' && col.winner.fileLabel === 'b.sql'
    && col.winner.stmtIndex === 0 && col.winner.globalIndex === 1,
    col ? JSON.stringify(col.winner) : 'no collision');
  check('loser is the earlier file in replay order',
    !!col && col.losers.length === 1 && col.losers[0].modId === 'mod-a'
    && col.losers[0].fileLabel === 'a.sql' && col.losers[0].stmtIndex === 0
    && col.losers[0].globalIndex === 0,
    col ? JSON.stringify(col.losers) : 'no collision');
  check('loser precedes winner', !!col && col.losers[0].globalIndex < col.winner.globalIndex);
  const heroVal = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare("SELECT Value FROM ProvCheck WHERE Id = 'hero'").get().Value; }
    finally { db.close(); }
  })();
  check('replayed value matches the winner (last-writer-wins)', heroVal === 2, `got ${heroVal}`);
  destroyTempCopy(c1.tmpDir);

  console.log('\nTest 2: identical values still collide (triggers, not diffing)');
  const c2 = createTempCopy(sourceDbPath);
  const twinRep = replayOrdered(c2.tempDbPath, collectStatements(twinSet), { provenance: true });
  check('identical-value cell still collides', twinRep.provenance.collisions.length === 1,
    JSON.stringify(twinRep.provenance.collisions.map(formatCollision)));
  const twin = twinRep.provenance.collisions[0];
  if (twin) console.log(`  collision: ${formatCollision(twin)}`);
  check('identical-value winner is still the later writer',
    !!twin && twin.winner.modId === 'mod-b' && twin.losers.length === 1
    && twin.losers[0].modId === 'mod-a');
  destroyTempCopy(c2.tmpDir);

  console.log('\nTest 3: uncontested writes carry no collision');
  const c3 = createTempCopy(sourceDbPath);
  const soloRep = replayOrdered(c3.tempDbPath, collectStatements(soloSet), { provenance: true });
  check('disjoint cells produce no collisions', soloRep.provenance.collisions.length === 0,
    JSON.stringify(soloRep.provenance.collisions.map(formatCollision)));
  destroyTempCopy(c3.tmpDir);

  console.log('\nTest 4: provenance is opt-in and live DB untouched');
  const c4 = createTempCopy(sourceDbPath);
  const plain = replayOrdered(c4.tempDbPath, collected);
  check('provenance off by default', plain.provenance === null);
  destroyTempCopy(c4.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);

  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 2.1: ALL PROVENANCE CHECKS PASSED' : 'CONFLICT-REPLAY 2.1: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}


// ---------------------------------------------------------------------------
// Task 2.2: Database.log differential validation. parseDatabaseLog reads
// Database.log-format text into error entries { line, text, message,
// fileHint, stmtHint }: only lines containing ERROR count, leading
// [timestamp] / [tag] prefixes strip to a message, a *.sql/*.xml token is
// the file hint, and a statement/stmt N token is the statement hint.
//
// Log-pairing 1.1 (additive): each ERROR also joins its same-timestamp
// non-ERROR context lines -- the executing statement ("While executing -
// '...'"), the row values ("... with values (...)"), and the source file
// ("from file <path>", usually a workshop path carrying its Steam ID) --
// into { statement, values, sourcePath, workshopId }. An ERROR with no
// same-timestamp context lines keeps today's single-line shape (all four
// null), so existing differential behavior is unchanged.
// ---------------------------------------------------------------------------

// Leading [timestamp] tag of a Database.log line; the join key for 1.1.
function dbTimestampOf(raw) {
  const m = /^\s*(\[[^\]]*\])/.exec(String(raw == null ? '' : raw));
  return m ? m[1] : null;
}

// Fold one same-timestamp context line into the attribution accumulator.
// First match per field wins across the timestamp group. Shapes measured
// on real logs (synthetic values in fixtures, never real paths).
function foldDbContextLine(text, acc) {
  let m = /while\s+executing\s*[-–:]\s*(.+?)\s*$/i.exec(text);
  if (m && acc.statement == null) {
    const stmt = m[1].replace(/^['"]/, '').replace(/['"]\s*[.,;]?\s*$/, '').trim();
    if (stmt) acc.statement = stmt;
  }
  m = /with\s+values\s*(.+?)\s*$/i.exec(text);
  if (m && acc.values == null) {
    let v = m[1].trim();
    if (!/\)$/.test(v)) v = v.replace(/[.,;]+$/, '').trim();
    if (v) acc.values = v;
  }
  m = /from\s+file\s+(.+?)\s*$/i.exec(text);
  if (m && acc.sourcePath == null) {
    const p = m[1].trim().replace(/^['"]/, '').replace(/['"\s.,;]+$/, '');
    if (p) {
      acc.sourcePath = p;
      const w = /workshop\/content\/\d+\/(\d+)/i.exec(p);
      if (w) acc.workshopId = w[1];
    }
  }
  return acc;
}

function parseDatabaseLog(logText) {
  const lines = String(logText == null ? '' : logText).split(/\r?\n/);
  // First pass: index non-ERROR context lines by leading timestamp tag.
  const contextByTs = new Map();
  lines.forEach((raw) => {
    if (/ERROR/i.test(raw)) return;
    const ts = dbTimestampOf(raw);
    if (!ts) return;
    const text = raw.trim();
    if (!text) return;
    if (!contextByTs.has(ts)) contextByTs.set(ts, []);
    contextByTs.get(ts).push(text);
  });
  const entries = [];
  lines.forEach((raw, i) => {
    if (!/ERROR/i.test(raw)) return;
    const text = raw.trim();
    if (!text) return;
    const message = text.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
    const fileM = /([\w][\w.\-]*\.(?:sql|xml))\b/i.exec(text);
    const stmtM = /(?:statement|stmt)\s*#?\s*(\d+)/i.exec(text);
    // Same-timestamp siblings only; none shared means today's shape.
    const acc = { statement: null, values: null, sourcePath: null, workshopId: null };
    const ts = dbTimestampOf(raw);
    const siblings = (ts && contextByTs.get(ts)) || [];
    siblings.forEach((sib) => foldDbContextLine(sib, acc));
    entries.push({
      line: i + 1,
      text,
      message,
      fileHint: fileM ? fileM[1] : null,
      stmtHint: stmtM ? Number(stmtM[1]) : null,
      statement: acc.statement,
      values: acc.values,
      sourcePath: acc.sourcePath,
      workshopId: acc.workshopId,
    });
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Log-pairing 1.2: workshop/local/base source mapping. Pure functions over
// the attributed entries from parseDatabaseLog: no filesystem access, the
// caller supplies the folder map (built server-side from scanMods plus
// resolved folders). Every entry yields an attribution stating its outcome;
// unmapped paths are reported, never silently dropped.
//
// Folder map shape:
//   { workshop: { [workshopId]: { modId, name? } | 'modId-string' },
//     local: [{ folder, modId, name? }] or
//            { [folderOrPrefix]: { modId, name? } | 'modId-string' } }
// A local folder is either a bare mod-folder name (matched as a /Mods/<name>/
// path segment) or an absolute mod-folder prefix (matched case-insensitively
// after slash normalization). Base-game/DLC paths need no map entry: a
// normalized path carrying a /base/ or /dlc/ segment attributes to the base
// game. Explicit maps win over the base-game heuristic, in that order.
// ---------------------------------------------------------------------------

function normalizeLogPath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase();
}

function isBaseGamePath(norm) {
  return /(^|\/)(base|dlc)(\/|$)/.test(norm || '');
}

function localEntriesOf(folderMap) {
  const local = (folderMap && folderMap.local) || [];
  if (Array.isArray(local)) return local;
  return Object.keys(local).map((k) => {
    const v = local[k];
    return typeof v === 'string' ? { folder: k, modId: v } : { folder: k, ...(v || {}) };
  });
}

function matchLocalFolder(normPath, entry) {
  const folder = normalizeLogPath((entry && entry.folder) || '').replace(/^\/+|\/+$/g, '');
  if (!folder) return false;
  // Absolute-prefix form (caller passed a full mod folder): prefix match.
  if (folder.includes('/')) return normPath.startsWith(folder);
  // Bare folder-name form: match one full path segment.
  return normPath.includes(`/${folder}/`);
}

// One source path to its owning mod. Never throws on a missing map and
// never returns a bare null: the reason field always says what happened.
function resolveLogSourceMod(sourcePath, workshopId, folderMap) {
  const map = folderMap || {};
  const wid = workshopId == null || workshopId === '' ? null : String(workshopId);
  if (!sourcePath) {
    return {
      kind: 'unmapped', modId: null, modName: null,
      workshopId: wid, reason: 'no-source-path',
    };
  }
  if (wid) {
    const hit = (map.workshop || {})[wid];
    if (hit) {
      return {
        kind: 'workshop',
        modId: typeof hit === 'string' ? hit : (hit.modId || null),
        modName: typeof hit === 'string' ? null : (hit.name || null),
        workshopId: wid, reason: null,
      };
    }
    return {
      kind: 'unmapped', modId: null, modName: null,
      workshopId: wid, reason: `workshop-id-not-installed:${wid}`,
    };
  }
  const norm = normalizeLogPath(sourcePath);
  for (const entry of localEntriesOf(map)) {
    if (matchLocalFolder(norm, entry)) {
      return {
        kind: 'local',
        modId: entry.modId || null,
        modName: entry.name || null,
        workshopId: null, reason: null,
      };
    }
  }
  if (isBaseGamePath(norm)) {
    return {
      kind: 'base-game', modId: 'base-game', modName: 'Base game',
      workshopId: null, reason: null,
    };
  }
  return {
    kind: 'unmapped', modId: null, modName: null,
    workshopId: null, reason: 'path-not-mapped',
  };
}

// Entries plus folder map to entries carrying .attribution. Non-mutating:
// the input array and its entries are returned untouched in fresh objects.
function attributeLogSources(entries, folderMap) {
  return (entries || []).map((e) => ({
    ...(e || {}),
    attribution: resolveLogSourceMod(e && e.sourcePath, e && e.workshopId, folderMap),
  }));
}

// Log-pairing 2.1: numeric ms clock shared by Database.log and Modding.log.
// Tags look like [100.001]; unparseable tags yield null (unbracketable).
function parseLogTimestampMs(tag) {
  const m = /^\s*\[\s*([0-9]+(?:\.[0-9]+)?)\s*\]/.exec(String(tag == null ? '' : tag));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Log-pairing 2.1: Modding.log Loading timeline. Real shape is
// `[t] <Action> - Loading <path>` on the same ms clock as Database.log;
// fixtures below use synthetic paths only, never real paths.
function parseModdingLog(logText) {
  const lines = String(logText == null ? '' : logText).split(/\r?\n/);
  const out = [];
  lines.forEach((raw, i) => {
    const m = /-\s*Loading\s+(.+?)\s*$/.exec(raw);
    if (!m) return;
    const cleaned = m[1].trim().replace(/^['"]/, '').replace(/['"\s.,;]+$/, '');
    if (!cleaned) return;
    const tag = dbTimestampOf(raw);
    const w = /workshop\/content\/\d+\/(\d+)/i.exec(cleaned);
    out.push({
      line: i + 1,
      text: raw.trim(),
      timestampTag: tag,
      timestampMs: tag ? parseLogTimestampMs(tag) : null,
      path: cleaned,
      workshopId: w ? w[1] : null,
    });
  });
  return out;
}

// Log-pairing 2.1: usable context means any same-timestamp joined field.
// Hint-only errors (fileHint without context) stay hint-matched, never
// bracketed; only errors with neither context nor hint are bracketable.
function hasUsableDbContext(entry) {
  const e = entry || {};
  return !!(e.sourcePath || e.statement || e.values);
}

// Log-pairing 2.1: nearest-preceding Loading bracketing, always labeled
// approximate. Single preceding Loading brackets to its file; two or more
// sharing the nearest ms yield a named-candidates list (never a pick);
// no preceding Loading states so explicitly via reason.
function bracketErrorWithLoading(dbError, loadings, folderMap) {
  const e = dbError || {};
  const errTag = e.timestampTag || dbTimestampOf(e.text || '');
  const errMs = errTag ? parseLogTimestampMs(errTag) : null;
  const base = { timestampTag: errTag || null, approximate: true };
  if (errMs == null) {
    return { ...base, outcome: 'unbracketed', strength: 'unattributed',
      loadingPath: null, loadingLine: null, attribution: null,
      candidates: [], reason: 'no-error-timestamp' };
  }
  const prior = (loadings || []).filter((l) => l && typeof l.timestampMs === 'number' && l.timestampMs <= errMs);
  if (prior.length === 0) {
    return { ...base, outcome: 'unbracketed', strength: 'unattributed',
      loadingPath: null, loadingLine: null, attribution: null,
      candidates: [], reason: 'no-loading-precedes' };
  }
  let maxMs = prior[0].timestampMs;
  for (const l of prior) if (l.timestampMs > maxMs) maxMs = l.timestampMs;
  const nearest = prior.filter((l) => l.timestampMs === maxMs);
  if (nearest.length === 1) {
    const n = nearest[0];
    return { ...base, outcome: 'bracketed', strength: 'bracket-approximate',
      loadingPath: n.path, loadingLine: n.line, timestampTag: n.timestampTag,
      attribution: resolveLogSourceMod(n.path, n.workshopId, folderMap),
      candidates: null, reason: null };
  }
  return { ...base, outcome: 'ambiguous', strength: 'bracket-approximate',
    loadingPath: null, loadingLine: null, timestampTag: nearest[0].timestampTag,
    attribution: null,
    candidates: nearest.map((n) => ({ path: n.path, line: n.line,
      attribution: resolveLogSourceMod(n.path, n.workshopId, folderMap) })),
    reason: 'same-ms-ambiguity' };
}

// Log-pairing 2.1: three-strength fallback in order. Context-proven first,
// then hint-matched (fileHint kept, never bracketed), then Modding.log
// bracketing labeled approximate; otherwise unattributed with a reason.
function attributeErrorWithFallback(entry, loadings, folderMap) {
  const e = entry || {};
  if (e.sourcePath || e.statement || e.values) {
    return { strength: 'context-proven', approximate: false,
      attribution: resolveLogSourceMod(e.sourcePath, e.workshopId, folderMap),
      bracket: null };
  }
  if (e.fileHint) {
    return { strength: 'hint-matched', approximate: false,
      attribution: { kind: 'hint', modId: null, modName: null,
        fileHint: e.fileHint, stmtHint: e.stmtHint == null ? null : e.stmtHint,
        workshopId: null, reason: 'file-hint-only' },
      bracket: null };
  }
  const bracket = bracketErrorWithLoading(e, loadings, folderMap);
  if (bracket.outcome === 'bracketed') {
    return { strength: 'bracket-approximate', approximate: true,
      attribution: { ...bracket.attribution, strength: 'bracket-approximate',
        approximate: true, loadingPath: bracket.loadingPath,
        loadingLine: bracket.loadingLine },
      bracket };
  }
  if (bracket.outcome === 'ambiguous') {
    return { strength: 'bracket-approximate', approximate: true,
      attribution: { kind: 'bracket-ambiguous', modId: null, modName: null,
        workshopId: null, reason: bracket.reason,
        candidates: bracket.candidates },
      bracket };
  }
  return { strength: 'unattributed', approximate: true,
    attribution: { kind: 'unattributed', modId: null, modName: null,
      workshopId: null, reason: bracket.reason },
    bracket };
}

// Log-pairing 2.2: load-sequence calibration (report-only). The game file
// load sequence is the Modding.log Loading order; calibration compares it
// against the assumed replay order and reports inverted pairs naming which
// side each order came from (game-observed vs assumed). Never reorders or
// corrects anything: replay assumptions stay as-is.
function basenameOfLoadPath(p) {
  const norm = String(p == null ? '' : p).replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  return base;
}

function loadOrderKey(s) {
  return basenameOfLoadPath(s).toLowerCase();
}

function assumedFileLabel(f) {
  if (typeof f === 'string') return f;
  if (f && typeof f.fileLabel === 'string') return f.fileLabel;
  if (f && typeof f.label === 'string') return f.label;
  if (f && typeof f.path === 'string') return basenameOfLoadPath(f.path);
  return String(f == null ? '' : f);
}

// Game-observed file load sequence: Loading paths in file (line) order.
// Returns fresh objects; never mutates the loadings input.
function gameLoadSequence(loadings) {
  const sorted = [...(loadings || [])]
    .filter((l) => l && typeof l.path === 'string' && l.path)
    .sort((a, b) => (a.line || 0) - (b.line || 0));
  return sorted.map((l) => ({
    path: l.path,
    key: loadOrderKey(l.path),
    label: basenameOfLoadPath(l.path),
    line: l.line,
    timestampMs: l.timestampMs,
  }));
}

// Report-only calibration of assumed replay order vs game-observed order.
// Files are matched by basename (case-insensitive); only files present on
// both sides participate in pair comparison, while side-only files are
// listed separately (never dropped silently). Returns a fresh report;
// inputs are never reordered or mutated.
function calibrateLoadOrder(assumedFiles, loadings) {
  const assumed = (assumedFiles || []).map((f, i) => ({
    index: i,
    label: assumedFileLabel(f),
    key: loadOrderKey(assumedFileLabel(f)),
    modId: (f && typeof f === 'object' && f.modId) || null,
  })).filter((a) => a.key);
  const observed = gameLoadSequence(loadings);
  const assumedPos = new Map();
  for (const a of assumed) if (!assumedPos.has(a.key)) assumedPos.set(a.key, a.index);
  const observedPos = new Map();
  observed.forEach((o, rank) => { if (!observedPos.has(o.key)) observedPos.set(o.key, rank); });
  const commonKeys = [...assumedPos.keys()].filter((k) => observedPos.has(k));
  const assumedOrder = [...commonKeys].sort((a, b) => assumedPos.get(a) - assumedPos.get(b));
  const observedOrder = [...commonKeys].sort((a, b) => observedPos.get(a) - observedPos.get(b));
  const labelOf = (key) => {
    const a = assumed.find((x) => x.key === key);
    return a ? a.label : key;
  };
  const divergences = [];
  for (let i = 0; i < assumedOrder.length; i += 1) {
    for (let j = i + 1; j < assumedOrder.length; j += 1) {
      const first = assumedOrder[i];
      const second = assumedOrder[j];
      if (observedPos.get(first) > observedPos.get(second)) {
        const aLabel = labelOf(first);
        const bLabel = labelOf(second);
        divergences.push({
          assumedFirst: aLabel,
          assumedSecond: bLabel,
          assumedOrder: `${aLabel} before ${bLabel} (assumed replay order)`,
          observedOrder: `${bLabel} before ${aLabel} (game-observed order)`,
        });
      }
    }
  }
  const assumedOnly = assumed.filter((a) => !observedPos.has(a.key)).map((a) => a.label);
  const observedOnly = observed.filter((o) => !assumedPos.has(o.key)).map((o) => o.label);
  return {
    assumedOrder: assumedOrder.map(labelOf),
    observedOrder: observedOrder.map(labelOf),
    divergences,
    assumedOnly,
    observedOnly,
  };
}

function formatCalibration(cal) {
  const lines = [];
  lines.push(`assumed=[${(cal.assumedOrder || []).join(', ')}]`
    + ` observed=[${(cal.observedOrder || []).join(', ')}]`
    + ` divergences=${(cal.divergences || []).length}`);
  (cal.divergences || []).forEach((d) => {
    lines.push(`  inverted: ${d.assumedOrder} vs ${d.observedOrder}`);
  });
  return lines.join('\n');
}

// Message comparison strips the -- file: annotation this harness appends
// to fixture log lines plus any ERROR: prefix, then lowercases and
// collapses whitespace. Equality wins; delimited inclusion tolerates
// game-side wrapping but never matches a table-name prefix (NoSuchAlpha
// must not match NoSuchAlpha2): the shorter side must end on non-word.

function normalizeDbMessage(msg) {
  const s = String(msg == null ? '' : msg).toLowerCase()
    .replace(/\s*--\s*file:.*$/, '')
    .replace(/\s*\(file:.*\)\s*$/, '')
    .replace(/^error\s*:\s*/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function dbMessagesMatch(a, b) {
  const x = normalizeDbMessage(a);
  const y = normalizeDbMessage(b);
  if (!x || !y || x.length < 8 || y.length < 8) return false;
  if (x === y) return true;
  const delimited = (hay, needle) => {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) return false;
      const word = (c) => /[a-z0-9_]/.test(c || '');
      if (!word(hay[at - 1]) && !word(hay[at + needle.length])) return true;
      from = at + 1;
    }
  };
  return delimited(x, y) || delimited(y, x);
}

// Replay-side findings: every aborted per-file record becomes one error
// keyed by (file, statement). stmtIndex derives from failedAt minus the
// file's baseGlobalIndex via the collected set; lookup by (mod, file)
// name is the fallback when positional correlation misses.

function collectReplayErrors(report, collected) {
  const files = (collected && collected.files) || [];
  const out = [];
  ((report && report.perFile) || []).forEach((rec, i) => {
    if (!rec || rec.status !== 'aborted' || !rec.error) return;
    const file = (files[i] && files[i].fileLabel === rec.fileLabel && files[i].modId === rec.modId)
      ? files[i]
      : files.find((f) => f.modId === rec.modId && f.fileLabel === rec.fileLabel);
    const stmtIndex = (file && typeof rec.failedAt === 'number'
      && typeof file.baseGlobalIndex === 'number')
      ? rec.failedAt - file.baseGlobalIndex
      : null;
    out.push({
      modId: rec.modId,
      fileLabel: rec.fileLabel,
      stmtIndex,
      globalIndex: typeof rec.failedAt === 'number' ? rec.failedAt : null,
      error: rec.error,
    });
  });
  return out;
}

// Greedy one-to-one match of replay errors to log errors by message.
// Agreements name file, statement, and the matched log line; leftovers
// are replay-only (replay raised, game silent) and log-only (game logged,
// replay missed), each still naming file and statement.

function differentialValidate(report, logInput, collected) {
  const logErrors = typeof logInput === 'string' ? parseDatabaseLog(logInput) : (logInput || []);
  const replayErrors = collectReplayErrors(report, collected);
  const used = new Array(logErrors.length).fill(false);
  const agreements = [];
  const replayOnly = [];
  replayErrors.forEach((re) => {
    let hit = -1;
    for (let i = 0; i < logErrors.length; i += 1) {
      if (!used[i] && dbMessagesMatch(re.error, logErrors[i].message)) { hit = i; break; }
    }
    if (hit >= 0) {
      used[hit] = true;
      agreements.push({
        modId: re.modId,
        fileLabel: re.fileLabel,
        stmtIndex: re.stmtIndex,
        globalIndex: re.globalIndex,
        replayError: re.error,
        logLine: logErrors[hit].line,
        logText: logErrors[hit].text,
      });
    } else {
      replayOnly.push({ ...re, replayError: re.error, side: 'replay-only' });
    }
  });
  const logOnly = [];
  logErrors.forEach((le, i) => {
    if (!used[i]) {
      logOnly.push({
        side: 'log-only',
        fileLabel: le.fileHint,
        stmtIndex: le.stmtHint,
        logLine: le.line,
        logText: le.text,
        message: le.message,
      });
    }
  });
  return {
    agreements,
    replayOnly,
    logOnly,
    replayErrors: replayErrors.length,
    logErrors: logErrors.length,
  };
}

function formatDifferential(diff) {
  const lines = [];
  lines.push(`agreements=${diff.agreements.length}`
    + ` replay-only=${diff.replayOnly.length} log-only=${diff.logOnly.length}`);
  diff.agreements.forEach((a) => {
    lines.push(`  agree: ${a.modId}/${a.fileLabel}#${a.stmtIndex} (global ${a.globalIndex})`
      + ` <-> Database.log:${a.logLine}: ${a.logText}`);
  });
  diff.replayOnly.forEach((r) => {
    lines.push(`  replay-only: ${r.modId}/${r.fileLabel}#${r.stmtIndex} (global ${r.globalIndex})`
      + ` :: ${r.replayError}`);
  });
  diff.logOnly.forEach((l) => {
    lines.push(`  log-only: ${l.fileLabel || '(unattributed)'}#${l.stmtIndex == null ? '?' : l.stmtIndex}`
      + ` Database.log:${l.logLine}: ${l.logText}`);
  });
  return lines.join('\n');
}

// --differential fixture: two replay failures plus a three-line
// Database.log-format text. The log carries bad-a's own replay error (one
// agreement), stays silent about bad-b (one replay-only divergence), and
// adds a ghost error no replay statement raised (one log-only divergence).

function differentialFixtureLog(badAError) {
  return [
    `[100.001] [Gameplay] ERROR: ${badAError} -- file: bad-a.sql statement 0`,
    '[100.002] [Gameplay] Validating Foreign Key Constraints...',
    '[100.003] [Gameplay] ERROR: UNIQUE constraint failed: DiffCheck.Id'
    + ' -- file: ghost.sql statement 3',
  ].join('\n');
}

// Checkable assertions for runDifferential: one agreement naming
// file/statement/log line, plus one divergence per direction each naming
// file, statement, and which side observed it.

function assertDifferential(diff, check) {
  check('one agreement', diff.agreements.length === 1, `got ${diff.agreements.length}`);
  const agree = diff.agreements[0];
  check('agreement names file and statement',
    !!agree && agree.fileLabel === 'bad-a.sql' && agree.stmtIndex === 0,
    agree ? `${agree.fileLabel}#${agree.stmtIndex}` : 'no agreement');
  check('agreement names the matched log line',
    !!agree && agree.logLine === 1, agree ? `logLine=${agree && agree.logLine}` : 'no agreement');
  check('one replay-only divergence', diff.replayOnly.length === 1, `got ${diff.replayOnly.length}`);
  const ro = diff.replayOnly[0];
  check('replay-only names file, statement, and side',
    !!ro && ro.fileLabel === 'bad-b.sql' && ro.stmtIndex === 0 && ro.side === 'replay-only',
    ro ? `${ro.fileLabel}#${ro.stmtIndex} ${ro.side}` : 'none');
  check('one log-only divergence', diff.logOnly.length === 1, `got ${diff.logOnly.length}`);
  const lo = diff.logOnly[0];
  check('log-only names file, statement, and side',
    !!lo && lo.fileLabel === 'ghost.sql' && lo.stmtIndex === 3 && lo.side === 'log-only',
    lo ? `${lo.fileLabel}#${lo.stmtIndex} ${lo.side}` : 'none');
}

// --differential (task 2.2): the fixture log holds one matching error and
// one divergent error per direction; the report must show the agreement
// with its log line plus both divergences with file and statement.

function runDifferential() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-diff-')));
  console.log(`conflict-replay --differential (task 2.2)\nscratch dir: ${scratch}`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec("CREATE TABLE DiffCheck(Id TEXT PRIMARY KEY, V INTEGER);"
        + "INSERT INTO DiffCheck VALUES('seed', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);

  const modSet = [
    {
      modId: 'mod-a',
      files: [
        { label: 'good.sql', text: "INSERT INTO DiffCheck VALUES('ok', 1);" },
        { label: 'bad-a.sql', text: 'INSERT INTO NoSuchAlpha VALUES(1);' },
      ],
    },
    { modId: 'mod-b', files: [{ label: 'bad-b.sql', text: 'INSERT INTO NoSuchBeta VALUES(1);' }] },
  ];
  const collected = collectStatements(modSet);
  const c1 = createTempCopy(sourceDbPath);
  const report = replayOrdered(c1.tempDbPath, collected);
  check('both bad files aborted', report.perFile[1].status === 'aborted'
    && report.perFile[2].status === 'aborted',
  report.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));

  console.log('\nFixture Database.log text:');
  const logText = differentialFixtureLog(report.perFile[1].error);
  logText.split('\n').forEach((l) => console.log(`  log: ${l}`));
  const entries = parseDatabaseLog(logText);
  check('parser keeps only ERROR lines', entries.length === 2, `got ${entries.length}`);

  console.log('\nDifferential report:');
  const diff = differentialValidate(report, entries, collected);
  console.log(formatDifferential(diff));
  assertDifferential(diff, check);

  // Log-pairing 1.1: same-timestamp context joining on a real-log-shaped
  // fixture (in-memory log text; the workshop path is synthetic, never a
  // real path). The 2.2 assertions above already passed unchanged.
  console.log('\nContext joining (log-pairing 1.1, real-log-shaped fixture):');
  const pairingLog = [
    "[200.001] [Gameplay] While executing - 'insert into Traits(TraitType, Name) values (?, ?)'",
    '[200.001] [Gameplay] In XMLSerializer while updating table Traits with values (TRAIT_PAIRED, Paired Trait)',
    '[200.001] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    '[200.001] [Gameplay] ERROR: UNIQUE constraint failed: Traits.TraitType',
    '[200.002] [Gameplay] ERROR: no such table: NoSuchLone -- file: lone.sql statement 1',
  ].join('\n');
  pairingLog.split('\n').forEach((l) => console.log(`  log: ${l}`));
  const paired = parseDatabaseLog(pairingLog);
  check('context fixture parses to both ERROR entries', paired.length === 2, `got ${paired.length}`);
  const ctx = paired[0];
  console.log(`  attributed: workshopId=${ctx.workshopId} sourcePath=${ctx.sourcePath}`);
  console.log(`  statement: ${ctx.statement}`);
  console.log(`  values: ${ctx.values}`);
  check('executing statement joined',
    ctx.statement === 'insert into Traits(TraitType, Name) values (?, ?)', String(ctx.statement));
  check('row values joined',
    ctx.values === '(TRAIT_PAIRED, Paired Trait)', String(ctx.values));
  check('workshop source path joined',
    ctx.sourcePath === 'D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    String(ctx.sourcePath));
  check('workshop ID attributed', ctx.workshopId === '1234567890', String(ctx.workshopId));
  const lone = paired[1];
  check('single-line fallback keeps null context fields',
    lone.statement === null && lone.values === null && lone.sourcePath === null && lone.workshopId === null,
    JSON.stringify({
      statement: lone.statement,
      values: lone.values,
      sourcePath: lone.sourcePath,
      workshopId: lone.workshopId,
    }));
  check('fallback keeps file-hint and statement-hint',
    lone.fileHint === 'lone.sql' && lone.stmtHint === 1, `${lone.fileHint}#${lone.stmtHint}`);

  // Log-pairing 1.2: workshop/local/base mapping over attributed entries.
  // Pure function on in-memory fixtures (synthetic paths, never real paths).
  console.log('\nSource mapping (log-pairing 1.2, workshop/local/base fixtures):');
  const folderMap = {
    workshop: { 1234567890: { modId: 'mod-paired', name: 'Paired Mod' } },
    local: [{ folder: 'MyLocalMod', modId: 'mod-local', name: 'Local Mod' }],
  };
  const mapLog = [
    '[300.001] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/1234567890/Data/PairedMod_Traits.xml',
    '[300.001] [Gameplay] ERROR: UNIQUE constraint failed: Traits.TraitType',
    "[300.002] [Gameplay] from file C:/Users/Test/Documents/My Games/Sid Meier's Civilization VI/Mods/MyLocalMod/Data/Local_Traits.xml",
    '[300.002] [Gameplay] ERROR: no such table: LocalTraits',
    "[300.003] [Gameplay] from file C:/Games/Sid Meier's Civilization VI/Base/Assets/Gameplay/Data/Base_Traits.xml",
    '[300.003] [Gameplay] ERROR: UNIQUE constraint failed: BaseTraits.Id',
    '[300.004] [Gameplay] from file D:/SteamLibrary/steamapps/workshop/content/289070/9999999999/Data/Stranger_Traits.xml',
    '[300.004] [Gameplay] ERROR: no such table: StrangerTraits',
  ].join('\n');
  mapLog.split('\n').forEach((l) => console.log(`  log: ${l}`));
  const mapEntries = parseDatabaseLog(mapLog);
  const mapped = attributeLogSources(mapEntries, folderMap);
  check('mapping fixture parses to four ERROR entries', mapped.length === 4, `got ${mapped.length}`);
  mapped.forEach((e) => console.log(`  mapped: kind=${e.attribution && e.attribution.kind}`
    + ` mod=${(e.attribution && e.attribution.modId) || '(none)'}`
    + ` workshopId=${e.workshopId || '-'} sourcePath=${e.sourcePath}`));
  check('mapper does not mutate its input',
    mapEntries.every((e) => e.attribution === undefined));
  check('every entry carries a stated attribution (none dropped)',
    mapped.every((e) => e.attribution && typeof e.attribution.kind === 'string'),
    JSON.stringify(mapped.map((e) => e.attribution && e.attribution.kind)));
  check('workshop path maps to its mod',
    mapped[0].attribution.kind === 'workshop' && mapped[0].attribution.modId === 'mod-paired',
    JSON.stringify(mapped[0].attribution));
  check('local path resolves by folder',
    mapped[1].attribution.kind === 'local' && mapped[1].attribution.modId === 'mod-local',
    JSON.stringify(mapped[1].attribution));
  check('base-game path attributes to the base game',
    mapped[2].attribution.kind === 'base-game' && mapped[2].attribution.modId === 'base-game',
    JSON.stringify(mapped[2].attribution));
  check('unknown workshop ID is stated, not dropped',
    mapped[3].attribution.kind === 'unmapped' && /9999999999/.test(mapped[3].attribution.reason || ''),
    JSON.stringify(mapped[3].attribution));
  const unmappedAll = attributeLogSources(mapEntries, null);
  check('empty map leaves nothing unstated (base needs no map entry)',
    unmappedAll.every((e) => e.attribution && typeof e.attribution.kind === 'string')
    && unmappedAll[0].attribution.kind === 'unmapped'
    && unmappedAll[1].attribution.kind === 'unmapped'
    && unmappedAll[2].attribution.kind === 'base-game',
    JSON.stringify(unmappedAll.map((e) => e.attribution.kind)));

  // Log-pairing 2.1: hint-only fallback kept (synthetic paths only).
  console.log('\nFallbacks (log-pairing 2.1, hint-only fixture):');
  const hintLog = '[400.001] [Gameplay] ERROR: no such table: NoSuchHinted -- file: hinted.sql statement 2';
  console.log(`  log: ${hintLog}`);
  const hintEntries = parseDatabaseLog(hintLog);
  check('hint-only fixture parses to one ERROR', hintEntries.length === 1, `got ${hintEntries.length}`);
  const hintE = hintEntries[0];
  check('hint-only keeps file-hint matching', hintE.fileHint === 'hinted.sql' && hintE.stmtHint === 2,
    `${hintE.fileHint}#${hintE.stmtHint}`);
  check('hint-only has no usable context', !hasUsableDbContext(hintE),
    JSON.stringify({ statement: hintE.statement, sourcePath: hintE.sourcePath }));
  const hintFb = attributeErrorWithFallback(hintE, [], folderMap);
  check('hint-only stays hint-matched, never bracketed',
    hintFb.strength === 'hint-matched' && hintFb.bracket === null && !hintFb.approximate,
    JSON.stringify(hintFb));

  // Log-pairing 2.1: Modding.log bracketing for no-context errors.
  console.log('\nBracketing (log-pairing 2.1, no-context fixture):');
  const bracketMap = {
    workshop: { 1111111111: { modId: 'mod-alpha', name: 'Alpha Mod' },
      2222222222: { modId: 'mod-beta', name: 'Beta Mod' } },
    local: [],
  };
  const moddingSingle = [
    '[500.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
    '[500.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
    '[500.004] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Late.xml',
  ].join('\n');
  moddingSingle.split('\n').forEach((l) => console.log(`  modding: ${l}`));
  const singleLoads = parseModdingLog(moddingSingle);
  check('Modding.log parses three Loading lines', singleLoads.length === 3, `got ${singleLoads.length}`);
  check('non-Loading lines are ignored', parseModdingLog('[500.000] [Modding] Idle').length === 0);
  const bareLog = '[500.003] [Gameplay] ERROR: no such table: NoSuchBare';
  console.log(`  log: ${bareLog}`);
  const bareE = parseDatabaseLog(bareLog)[0];
  check('no-context error has neither context nor hint',
    !hasUsableDbContext(bareE) && !bareE.fileHint, JSON.stringify(bareE));
  const bareB = bracketErrorWithLoading(bareE, singleLoads, bracketMap);
  console.log(`  bracket: outcome=${bareB.outcome} path=${bareB.loadingPath}`);
  check('nearest-preceding Loading brackets the error', bareB.outcome === 'bracketed'
    && /2222222222/.test(bareB.loadingPath || ''), JSON.stringify(bareB));
  check('bracketing is labeled approximate', bareB.approximate === true
    && bareB.strength === 'bracket-approximate', JSON.stringify(bareB));
  check('bracket resolves the loading mod', !!bareB.attribution
    && bareB.attribution.modId === 'mod-beta', JSON.stringify(bareB.attribution));
  const bareFb = attributeErrorWithFallback(bareE, singleLoads, bracketMap);
  check('fallback labels no-context as bracket-approximate',
    bareFb.strength === 'bracket-approximate' && bareFb.approximate === true,
    JSON.stringify(bareFb));

  // Same-ms ambiguity degrades to a named-candidates list, never a pick.
  const moddingAmbig = [
    '[600.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Ambig_A.xml',
    '[600.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Ambig_B.xml',
  ].join('\n');
  const ambigLoads = parseModdingLog(moddingAmbig);
  const ambigE = parseDatabaseLog('[600.002] [Gameplay] ERROR: no such table: NoSuchAmbig')[0];
  const ambigB = bracketErrorWithLoading(ambigE, ambigLoads, bracketMap);
  console.log(`  ambiguous: outcome=${ambigB.outcome} candidates=${(ambigB.candidates || []).length}`);
  check('same-ms yields candidates, not a single pick',
    ambigB.outcome === 'ambiguous' && (ambigB.candidates || []).length === 2
    && ambigB.loadingPath === null, JSON.stringify(ambigB));
  check('candidates are named with mods',
    ambigB.candidates.every((c) => !!c.path && !!c.attribution && !!c.attribution.modId),
    JSON.stringify((ambigB.candidates || []).map((c) => c.path)));
  check('ambiguity keeps the approximate label', ambigB.approximate === true
    && ambigB.strength === 'bracket-approximate' && ambigB.reason === 'same-ms-ambiguity');

  // No preceding Loading states so explicitly.
  const lateLoads = parseModdingLog('[700.005] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Late.xml');
  const earlyE = parseDatabaseLog('[700.001] [Gameplay] ERROR: no such table: NoSuchEarly')[0];
  const earlyB = bracketErrorWithLoading(earlyE, lateLoads, bracketMap);
  console.log(`  early: outcome=${earlyB.outcome} reason=${earlyB.reason}`);
  check('no preceding Loading is stated explicitly',
    earlyB.outcome === 'unbracketed' && earlyB.reason === 'no-loading-precedes',
    JSON.stringify(earlyB));
  const ctxFb = attributeErrorWithFallback(ctx, singleLoads, folderMap);
  check('context-proven errors never fall through to bracketing',
    ctxFb.strength === 'context-proven' && ctxFb.bracket === null,
    JSON.stringify(ctxFb));

  // Log-pairing 2.2: load-sequence calibration from Loading lines
  // (report-only: divergences are listed, replay assumptions untouched).
  console.log('\nCalibration (log-pairing 2.2, one inverted pair):');
  const assumedFiles = [
    { modId: 'mod-alpha', fileLabel: 'Alpha_Units.xml' },
    { modId: 'mod-beta', fileLabel: 'Beta_Units.xml' },
  ];
  const calLoadings = parseModdingLog([
    '[800.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
    '[800.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
  ].join('\n'));
  calLoadings.forEach((l) => console.log(`  loading: ${l.path}`));
  const seq = gameLoadSequence(calLoadings);
  check('game load sequence follows Loading order',
    seq.map((s) => s.label).join(',') === 'Beta_Units.xml,Alpha_Units.xml',
    seq.map((s) => s.label).join(','));
  const calBefore = JSON.stringify(assumedFiles);
  const cal = calibrateLoadOrder(assumedFiles, calLoadings);
  console.log(formatCalibration(cal));
  check('one inverted pair reported', cal.divergences.length === 1, `got ${cal.divergences.length}`);
  const inv = cal.divergences[0];
  check('inversion names which side each order came from',
    !!inv && /assumed replay order/.test(inv.assumedOrder || '')
    && /game-observed order/.test(inv.observedOrder || ''),
    inv ? `${inv.assumedOrder} vs ${inv.observedOrder}` : 'none');
  check('inversion names both files',
    !!inv && /Alpha_Units\.xml/.test(inv.assumedOrder || '')
    && /Beta_Units\.xml/.test(inv.observedOrder || ''),
    inv ? `${inv.assumedOrder} vs ${inv.observedOrder}` : 'none');
  check('calibration never reorders its inputs', JSON.stringify(assumedFiles) === calBefore);
  const calSame = calibrateLoadOrder(assumedFiles, parseModdingLog([
    '[801.001] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/1111111111/Data/Alpha_Units.xml',
    '[801.002] [Modding] UpdateDatabase - Loading D:/Synthetic/workshop/content/289070/2222222222/Data/Beta_Units.xml',
  ].join('\n')));
  check('matching order reports no divergences', calSame.divergences.length === 0,
    `got ${calSame.divergences.length}`);

  destroyTempCopy(c1.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 2.2: ALL DIFFERENTIAL CHECKS PASSED' : 'CONFLICT-REPLAY 2.2: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// Task 2.3: replay envelope reporting. Every replay already records counts,
// wall-clock, and rate (see replayOrdered); buildReplayEnvelope projects
// those onto the measured-spike reference shape (8,138 statements in ~2s,
// ~3,700 statements/s, 9 in 10 executing FK-off), and
// formatReplayEnvelope prints the one-line envelope every replay carries.
// ---------------------------------------------------------------------------

const REPLAY_ENVELOPE_REF = { statements: 8138, wallMs: 2000, stmtsPerSec: 3700, executedFraction: 0.9 };

function buildReplayEnvelope(report) {
  const statements = (report && report.total) || 0;
  const executed = (report && report.executed) || 0;
  return {
    statements,
    executed,
    skipped: statements - executed,
    wallMs: (report && report.wallMs) || 0,
    stmtsPerSec: (report && report.stmtsPerSec) || 0,
    executedFraction: statements > 0 ? executed / statements : 0,
  };
}

function formatReplayEnvelope(env) {
  const pct = (env.executedFraction * 100).toFixed(1);
  return `envelope: ${env.statements} statements in ${env.wallMs}ms`
    + ` (${env.stmtsPerSec} statements/s, executed ${env.executed}/${env.statements}`
    + ` skipped ${env.skipped}/${env.statements} = ${pct}%)`;
}

// Reference-scale fixture: exactly 8,138 valid INSERTs across 8 files in
// one mod, so ordered replay measures the envelope without abort noise.
function envelopeFixtureModSet() {
  const files = [];
  let n = 0;
  const per = Math.ceil(REPLAY_ENVELOPE_REF.statements / 8);
  for (let f = 0; f < 8 && n < REPLAY_ENVELOPE_REF.statements; f += 1) {
    const chunk = [];
    for (let k = 0; k < per && n < REPLAY_ENVELOPE_REF.statements; k += 1, n += 1) {
      chunk.push(`INSERT INTO EnvCheck VALUES(${n}, ${n});`);
    }
    files.push({ label: `part${f}.sql`, text: chunk.join('\n') });
  }
  return [{ modId: 'mod-env', files }];
}

// --envelope (task 2.3): replay the reference-scale fixture into a temp
// copy and prove the envelope shape: counts, wall-clock, rate, and the
// executed-vs-skipped fraction with 9 in 10 executing. Temp copies only.
function runEnvelope() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-env-')));
  console.log(`conflict-replay --envelope (task 2.3)\nscratch dir: ${scratch}`);
  console.log(`  reference: ${REPLAY_ENVELOPE_REF.statements} statements in ~${REPLAY_ENVELOPE_REF.wallMs}ms`
    + ` (~${REPLAY_ENVELOPE_REF.stmtsPerSec} statements/s, >=9 in 10 executing FK-off)`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  const seed = new DatabaseSync(sourceDbPath);
  try { seed.exec('CREATE TABLE EnvCheck(Id INTEGER PRIMARY KEY, V INTEGER);'); } finally { seed.close(); }
  const beforeHash = sha256(sourceDbPath);
  const collected = collectStatements(envelopeFixtureModSet());
  check('fixture holds the reference-scale statement count',
    collected.total === REPLAY_ENVELOPE_REF.statements, `got ${collected.total}`);
  const c1 = createTempCopy(sourceDbPath);
  const report = replayOrdered(c1.tempDbPath, collected);
  const env = buildReplayEnvelope(report);
  console.log(`  ${formatReplayEnvelope(env)}`);
  console.log(`  temp copy: ${c1.tempDbPath}`);
  check('envelope reports the statement count', env.statements === REPLAY_ENVELOPE_REF.statements);
  check('envelope reports wall-clock', typeof env.wallMs === 'number' && env.wallMs >= 0, `${env.wallMs}ms`);
  check('envelope reports execution rate', env.stmtsPerSec > 0, `${env.stmtsPerSec}/s`);
  check('at least 9 in 10 statements execute FK-off',
    env.executedFraction >= REPLAY_ENVELOPE_REF.executedFraction,
    `executed ${env.executed}/${env.statements} = ${(env.executedFraction * 100).toFixed(1)}%`);
  check('executed-vs-skipped covers every statement',
    env.executed + env.skipped === env.statements, `executed=${env.executed} skipped=${env.skipped}`);
  check('replay stays interactive (same order as the ~2s reference)', env.wallMs < 30000, `${env.wallMs}ms`);
  const landed = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS n FROM EnvCheck').get().n; } finally { db.close(); }
  })();
  check('replayed rows land in the temp copy', landed === REPLAY_ENVELOPE_REF.statements, `got ${landed}`);
  destroyTempCopy(c1.tmpDir);
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);

  console.log('\nZero-rows-affected: UPDATE/DELETE matching nothing flags, never errors');
  const zeroSource = path.join(scratch, 'DebugGameplayZero.sqlite');
  {
    const zeroSeed = new DatabaseSync(zeroSource);
    try {
      zeroSeed.exec(`CREATE TABLE ZeroCheck(Id TEXT PRIMARY KEY, V INTEGER);
        INSERT INTO ZeroCheck VALUES('real', 1);`);
    } finally {
      zeroSeed.close();
    }
  }
  const zeroBefore = sha256(zeroSource);
  const zeroSet = [
    {
      modId: 'mod-zero',
      files: [
        {
          label: 'fix.sql',
          text: `-- retune one row, then one that names nothing
            UPDATE ZeroCheck SET V = 2 WHERE Id = 'real';
            UPDATE ZeroCheck SET V = 9 WHERE Id = 'ghost';`,
        },
        {
          label: 'prune.sql',
          text: `DELETE FROM ZeroCheck WHERE Id = 'ghost';
            INSERT INTO ZeroCheck VALUES('new', 3);`,
        },
      ],
    },
  ];
  const zeroCopy = createTempCopy(zeroSource);
  const zeroRep = replayOrdered(zeroCopy.tempDbPath, collectStatements(zeroSet));
  zeroRep.zeroRows.forEach((z) => console.log(`  zero-rows: ${formatZeroRows(z)}`));
  check('both files stay committed (flagged, never an error)',
    zeroRep.perFile.every((f) => f.status === 'committed'),
    zeroRep.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('executed counts every statement', zeroRep.executed === 4, `got ${zeroRep.executed}`);
  check('exactly the two no-match statements flag',
    zeroRep.zeroRows.length === 2
    && zeroRep.zeroRows[0].verb === 'UPDATE' && zeroRep.zeroRows[0].fileLabel === 'fix.sql'
    && zeroRep.zeroRows[0].stmtIndex === 1 && zeroRep.zeroRows[0].globalIndex === 1
    && zeroRep.zeroRows[1].verb === 'DELETE' && zeroRep.zeroRows[1].fileLabel === 'prune.sql'
    && zeroRep.zeroRows[1].stmtIndex === 0 && zeroRep.zeroRows[1].globalIndex === 2,
    JSON.stringify(zeroRep.zeroRows.map((z) => `${z.verb} ${z.fileLabel}#${z.stmtIndex}`)));
  check('every finding carries the replay-relative fidelity flag',
    zeroRep.zeroRows.every((z) => z.fidelityLimited.includes('replay-relative')),
    JSON.stringify(zeroRep.zeroRows.map((z) => z.fidelityLimited)));
  check('per-file records carry their own statement indexes',
    JSON.stringify(zeroRep.perFile[0].zeroRows) === JSON.stringify([1])
    && JSON.stringify(zeroRep.perFile[1].zeroRows) === JSON.stringify([0]),
    JSON.stringify(zeroRep.perFile.map((f) => f.zeroRows)));
  check('the matching UPDATE and the INSERT stay unflagged',
    !zeroRep.zeroRows.some((z) => (z.fileLabel === 'fix.sql' && z.stmtIndex === 0)
      || (z.fileLabel === 'prune.sql' && z.stmtIndex === 1)));
  const zeroVal = (() => {
    const db = new DatabaseSync(zeroCopy.tempDbPath, { readOnly: true });
    try { return db.prepare("SELECT V FROM ZeroCheck WHERE Id = 'real'").get().V; } finally { db.close(); }
  })();
  check('the matching UPDATE still applied', zeroVal === 2, `got ${zeroVal}`);
  destroyTempCopy(zeroCopy.tmpDir);
  check('zero-rows source content unchanged', sha256(zeroSource) === zeroBefore);

  console.log('\nLimitation flags: mixed fixture with fidelity-limited provenance (gate section)');
  const limSource = path.join(scratch, 'DebugGameplayLim.sqlite');
  {
    const limSeed = new DatabaseSync(limSource);
    try {
      limSeed.exec('CREATE TABLE LimT(K TEXT PRIMARY KEY, V TEXT);'
        + 'CREATE TABLE LimTrig(Id INTEGER PRIMARY KEY, V INTEGER);'
        + 'CREATE TABLE LimH(Id TEXT PRIMARY KEY, H INTEGER);');
    } finally { limSeed.close(); }
  }
  const limBefore = sha256(limSource);
  const LIM_OFF = 'mod-lim-off-0000';
  const limCtx = { enabled: ['mod-lim-a', 'mod-lim-b'], installed: ['mod-lim-a', 'mod-lim-b', LIM_OFF] };
  const limSet = [
    {
      modId: 'mod-lim-a',
      files: [
        {
          label: 'trig.sql',
          text: 'CREATE TRIGGER lim_trg AFTER INSERT ON LimTrig BEGIN\n'
            + '  UPDATE LimTrig SET V = 1 WHERE Id = NEW.Id;\n'
            + 'END;\nINSERT INTO LimTrig VALUES(1, 0);',
        },
        { label: 'seed.xml', text: '<GameData><LimT><Row K="k1" V="v1"/></LimT></GameData>' },
      ],
    },
    {
      modId: 'mod-lim-b',
      files: [
        { label: 'contest.sql', text: "UPDATE LimT SET V = \"v2\" WHERE K = 'k1';" },
        { label: 'hash.sql', text: "INSERT INTO LimH VALUES('h', Make_Hash('abc'));" },
        {
          label: 'gated.sql',
          text: "INSERT INTO LimT VALUES('gated', 'G');",
          gate: { any: false, conditions: [{ type: 'ModInUse', value: LIM_OFF, inverse: false }] },
        },
      ],
    },
  ];
  const limCollected = collectStatements(limSet, { preprocess: true });
  limCollected.files.forEach((f) => {
    console.log(`  file ${f.fileLabel}: ${f.statements.length} statements`);
    f.stages.forEach((s) => console.log(`    [${s.stage}] outcome=${s.outcome}`
      + (s.reason ? ` reason=${s.reason}` : '') + (s.note ? ` note=${s.note}` : '')));
  });
  const limStageOf = (label, stage) => limCollected.files.find((f) => f.fileLabel === label)
    .stages.find((s) => s.stage === stage).outcome;
  check('trig.sql splitter transformed (heuristic, flagged)', limStageOf('trig.sql', 'splitter') === 'transformed');
  check('contest.sql double-quote rewrite transformed',
    limStageOf('contest.sql', 'double-quote-rewrite') === 'transformed');
  check('seed.xml converted', limStageOf('seed.xml', 'xml-to-sql') === 'transformed');
  check('hash.sql stub installed-at-replay', limStageOf('hash.sql', 'make-hash-stub') === 'installed-at-replay');
  const limCopy = createTempCopy(limSource);
  const limRep = replayOrdered(limCopy.tempDbPath, limCollected, { provenance: true, gates: limCtx });
  console.log(`  replay: total=${limRep.total} executed=${limRep.executed} skippedGated=${limRep.skippedGated}`
    + ` fkMode=${limRep.fkMode} makeHashStub=${limRep.makeHashStub}`);
  console.log(`  temp copy: ${limCopy.tempDbPath}`);
  limRep.provenance.collisions.forEach((c) => console.log(`  collision: ${formatCollision(c)}`));
  limRep.gatedOut.forEach((g) => console.log(`  gated-out: ${g.modId}/${g.fileLabel} :: ${g.reason}`));
  const limCol = limRep.provenance.collisions.find((c) => c.table === 'LimT' && c.pk === 'k1' && c.column === 'V');
  check('mixed fixture collides on the contested cell', !!limCol, limCol ? formatCollision(limCol) : 'none');
  check('winner is the later writer (last-writer-wins)',
    !!limCol && limCol.winner.modId === 'mod-lim-b' && limCol.winner.fileLabel === 'contest.sql',
    limCol ? JSON.stringify(limCol.winner) : 'no collision');
  check('collision carries fidelity-limited flags from both writers',
    !!limCol && limCol.fidelityLimited.includes('xml-to-sql')
    && limCol.fidelityLimited.includes('double-quoted-string-rewrite'),
    limCol ? limCol.fidelityLimited.join(',') : 'no collision');
  check('gated file skipped with reason', limRep.skippedGated === 1 && limRep.gatedOut.length === 1,
    JSON.stringify(limRep.gatedOut));
  check('FK mode recorded on the report', limRep.fkMode === 'OFF', limRep.fkMode);
  check('Make_Hash stub recorded on the report', limRep.makeHashStub === 'installed');
  destroyTempCopy(limCopy.tmpDir);
  check('limitation source content unchanged', sha256(limSource) === limBefore);
  if (pass) fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY 2.3: ALL ENVELOPE CHECKS PASSED' : 'CONFLICT-REPLAY 2.3: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// --live-lock (reviewer WARNING 1): the temp-copy design claims replay works
// while the game holds DebugGameplay.sqlite. This case holds a BEGIN
// EXCLUSIVE transaction plus an open write handle on a scratch fixture live
// DB during createTempCopy + replayOrdered and asserts the report still
// succeeds, findings match the unlocked baseline, and the live file is
// byte-identical afterwards. Scratch fixtures only, never a real game DB.
// ---------------------------------------------------------------------------

function runLiveLock() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-livelock-')));
  console.log(`conflict-replay --live-lock (reviewer WARNING 1)\nscratch dir: ${scratch}`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE LockCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO LockCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const modSet = [
    { modId: 'mod-a', files: [{ label: 'ok.sql', text: "INSERT INTO LockCheck VALUES('ok', 1);" }] },
    { modId: 'mod-b', files: [{ label: 'bad.sql', text: 'INSERT INTO NoSuchLock VALUES(1);' }] },
  ];

  console.log('\nTest 1: unlocked baseline replays (1 committed, 1 aborted)');
  const trial = lockedCopyTrial(sourceDbPath, modSet);
  check('unlocked baseline: good file committed, bad file aborted',
    trial.baseline.statuses.join(' ') === 'mod-a/ok.sql:committed mod-b/bad.sql:aborted',
    trial.baseline.statuses.join(' '));
  check('unlocked baseline executed exactly the good statement',
    trial.baseline.executed === 1 && trial.baseline.total === 2,
    `executed=${trial.baseline.executed} total=${trial.baseline.total}`);

  console.log('\nTest 2: locked live DB still copies and replays');
  check('copy + report succeed under lock (200-equivalent)',
    !trial.copyError && !!trial.locked,
    trial.copyError ? String((trial.copyError && trial.copyError.message) || trial.copyError)
      : `executed=${trial.locked && trial.locked.executed}`);
  check('locked findings match the unlocked run',
    !!trial.locked && JSON.stringify(trial.locked) === JSON.stringify(trial.baseline),
    trial.locked ? `statuses=${trial.locked.statuses.join(' ')} rows=${JSON.stringify(trial.locked.rows)}`
      : 'no locked report');

  console.log('\nTest 3: live fixture untouched');
  check('live file byte-identical afterwards', trial.liveAfter === trial.liveBefore,
    `before=${trial.liveBefore.slice(0, 12)} after=${trial.liveAfter.slice(0, 12)}`);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id, Value FROM LockCheck').all(); } finally { db.close(); }
  })();
  check('live DB holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base',
    JSON.stringify(liveRows));

  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY LIVE-LOCK: ALL CHECKS PASSED' : 'CONFLICT-REPLAY LIVE-LOCK: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

// ---------------------------------------------------------------------------
// --assumed-gates (game-setup task 2.2): the gates context carries asserted
// option keys (same KIND:BODY store the view reads); asserted values satisfy
// matching undecidable gates, flagged assumed in gate reporting. Measured
// gates and empty-asserted runs behave exactly as the --gates path.
// Temp copies only, as ever.
// ---------------------------------------------------------------------------

function runAssumedGates() {
  let pass = true;
  const check = (label, cond, extra = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ` :: ${extra}` : ''}`);
    if (!cond) pass = false;
  };

  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-conflict-replay-assumed-')));
  console.log(`conflict-replay --assumed-gates (game-setup task 2.2)\nscratch dir: ${scratch}`);
  const sourceDbPath = path.join(scratch, 'DebugGameplay.sqlite');
  {
    const seed = new DatabaseSync(sourceDbPath);
    try {
      seed.exec('CREATE TABLE SetupCheck(Id TEXT PRIMARY KEY, Value INTEGER);'
        + "INSERT INTO SetupCheck VALUES('base', 0);");
    } finally {
      seed.close();
    }
  }
  const beforeHash = sha256(sourceDbPath);
  const beforeMtime = fs.statSync(sourceDbPath).mtimeMs;

  const ON_ID = 'mod-setup-on-1111';
  const OFF_ID = 'mod-setup-off-2222';
  const RULESET = 'RULESET:RULESET_EXPANSION_2';
  const MODE = 'GAMEMODE:GAMEMODE_MONOPOLIES';
  const CONFIG = 'CONFIG:Map/MapSize=MAPSIZE_DUEL';
  const ctx = { enabled: [ON_ID], installed: [ON_ID, OFF_ID], asserted: [RULESET, MODE, CONFIG] };
  const bare = { enabled: [ON_ID], installed: [ON_ID, OFF_ID] };
  const gMeasuredIn = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID }] };
  const gRuleset = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  const gMode = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: '1', props: { Group: 'Game', ConfigurationId: 'GAMEMODE_MONOPOLIES', Value: '1' } }] };
  const gConfig = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: 'MAPSIZE_DUEL', props: { Group: 'Map', ConfigurationId: 'MapSize', Value: 'MAPSIZE_DUEL' } }] };
  const gConfigBare = { any: false, conditions: [{ type: 'ConfigurationValueMatches', value: 'MAPSIZE_DUEL' }] };
  const gOther = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_NEVER_ASSERTED' }] };
  const gMeasuredOut = { any: false, conditions: [{ type: 'ModInUse', value: OFF_ID }] };
  const gNotRuleset = { any: false, conditions: [{ type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2', inverse: true }] };

  console.log('\nTest 1: asserted values satisfy matching undecidable gates, distinctly');
  const vMeasured = evaluateGate(gMeasuredIn, ctx);
  check('measured will-run carries no assumed flag', vMeasured.willRun === true && vMeasured.assumed === false, JSON.stringify(vMeasured));
  const vRuleset = evaluateGate(gRuleset, ctx);
  check('asserted ruleset runs, flagged assumed', vRuleset.willRun === true && vRuleset.assumed === true, JSON.stringify(vRuleset));
  const vMode = evaluateGate(gMode, ctx);
  check('asserted game mode runs, flagged assumed', vMode.willRun === true && vMode.assumed === true, JSON.stringify(vMode));
  const vConfig = evaluateGate(gConfig, ctx);
  check('asserted config triple runs, flagged assumed', vConfig.willRun === true && vConfig.assumed === true, JSON.stringify(vConfig));
  check('a value-only config condition never guesses', evaluateGate(gConfigBare, ctx).willRun === null);
  check('an unasserted ruleset stays undecided', (() => {
    const v = evaluateGate(gOther, ctx);
    return v.willRun === null && v.assumed === false && v.unknown.length === 1;
  })(), JSON.stringify(evaluateGate(gOther, ctx).unknown));
  const vNot = evaluateGate(gNotRuleset, ctx);
  check('NOT an asserted value is assumed not to run', vNot.willRun === false && vNot.assumed === true, JSON.stringify(vNot));
  check('a measured miss stays measured (never assumed)', (() => {
    const v = evaluateGate(gMeasuredOut, ctx);
    return v.willRun === false && v.assumed === false;
  })());

  console.log('\nTest 1b: assumed depends on the outcome, like the view');
  const andBoth = { any: false, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('AND measured+assumed runs assumed (without it: undecided)', evaluateGate(andBoth, ctx).assumed === true);
  check('AND measured-only runs measured',
    evaluateGate({ any: false, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'ModInUse', value: ON_ID }] }, ctx).assumed === false);
  const orBoth = { any: true, conditions: [{ type: 'ModInUse', value: ON_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('OR carried by measured runs measured', evaluateGate(orBoth, ctx).assumed === false);
  const orAssumed = { any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'RuleSetInUse', value: 'RULESET_EXPANSION_2' }] };
  check('OR carried by assumed alone runs assumed', evaluateGate(orAssumed, ctx).assumed === true);
  check('undecided rows are never flagged',
    evaluateGate({ any: true, conditions: [{ type: 'ModInUse', value: OFF_ID }, { type: 'RuleSetInUse', value: 'RULESET_X' }] }, ctx).assumed === false);
  check('store-view, Set, and array shapes all match',
    evaluateGate(gRuleset, { enabled: [ON_ID], installed: [ON_ID], asserted: { asserted: { [RULESET]: true } } }).assumed === true
    && evaluateGate(gRuleset, { enabled: [ON_ID], installed: [ON_ID], asserted: new Set([RULESET]) }).assumed === true);
  check('junk asserted never throws, never matches',
    evaluateGate(gRuleset, { enabled: [], installed: [], asserted: 42 }).willRun === null
    && evaluateGate(gRuleset, { enabled: [], installed: [], asserted: ['junk-without-a-kind'] }).willRun === null);

  console.log('\nTest 2: replay runs assumed-satisfied files, reported distinctly');
  const modSet = [
    {
      modId: 'mod-setup',
      files: [
        { label: 'measured.sql', text: "INSERT INTO SetupCheck VALUES('measured', 1);", gate: gMeasuredIn },
        { label: 'ruleset.sql', text: "INSERT INTO SetupCheck VALUES('ruleset', 2);", gate: gRuleset },
        { label: 'mode.sql', text: "INSERT INTO SetupCheck VALUES('mode', 3);", gate: gMode },
        { label: 'unknown.sql', text: "INSERT INTO SetupCheck VALUES('unknown', 4);", gate: gOther },
        { label: 'off.sql', text: "INSERT INTO SetupCheck VALUES('off', 5);", gate: gMeasuredOut },
        { label: 'not-ruleset.sql', text: "INSERT INTO SetupCheck VALUES('not-ruleset', 6);", gate: gNotRuleset },
      ],
    },
  ];
  const collected = collectStatements(modSet);
  const c1 = createTempCopy(sourceDbPath);
  const report = replayOrdered(c1.tempDbPath, collected, { gates: ctx });
  console.log(`  replay: total=${report.total} executed=${report.executed} skippedGated=${report.skippedGated}`);
  report.perFile.forEach((f) => {
    console.log(`  per-file: ${f.modId}/${f.fileLabel} ${f.status}`
      + (f.gate ? ` willRun=${f.gate.willRun} assumed=${!!f.gate.assumed}` : '')
      + (f.gate && f.gate.reason ? ` :: ${f.gate.reason}` : ''));
  });
  console.log(`  gated-assumed: ${report.gatedAssumed.map((g) => g.fileLabel).join(', ') || '(none)'}`);
  check('measured and assumed files all commit', report.perFile.slice(0, 4).every((f) => f.status === 'committed'),
    report.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  check('both gated-out files skipped, never replayed',
    report.perFile[4].status === 'skipped-gated' && report.perFile[5].status === 'skipped-gated');
  check('assumed-satisfied files named distinctly from measured ones',
    report.gatedAssumed.map((g) => g.fileLabel).join(',') === 'ruleset.sql,mode.sql',
    JSON.stringify(report.gatedAssumed));
  check('measured commit carries no assumed flag', report.perFile[0].gate.assumed === false);
  check('assumed commits carry the flag', report.perFile[1].gate.assumed === true && report.perFile[2].gate.assumed === true);
  check('undecidable files stay flagged unknown, never assumed',
    report.gatedUnknown.length === 1 && report.gatedUnknown[0].fileLabel === 'unknown.sql' && report.perFile[3].gate.assumed === false,
    JSON.stringify(report.gatedUnknown));
  check('gated-out assumed flag tells the two misses apart',
    report.gatedOut.find((g) => g.fileLabel === 'off.sql').assumed === false
    && report.gatedOut.find((g) => g.fileLabel === 'not-ruleset.sql').assumed === true,
    JSON.stringify(report.gatedOut));
  check('executed counts the four replayed statements', report.executed === 4 && report.skippedGated === 2,
    `executed=${report.executed} skippedGated=${report.skippedGated}`);
  const rows = (() => {
    const db = new DatabaseSync(c1.tempDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM SetupCheck').all().map((r) => r.Id).sort(); } finally { db.close(); }
  })();
  check('assumed-satisfied rows landed', rows.includes('ruleset') && rows.includes('mode'), rows.join(','));
  check('gated-out rows never landed', !rows.includes('off') && !rows.includes('not-ruleset'), rows.join(','));
  destroyTempCopy(c1.tmpDir);

  console.log('\nTest 3: nothing asserted behaves exactly as the --gates path');
  const shapes = [gMeasuredIn, gRuleset, gMode, gConfig, gOther, gMeasuredOut, gNotRuleset];
  check('empty-asserted verdicts match bare-context verdicts', shapes.every((g) => {
    const a = evaluateGate(g, bare);
    const b = evaluateGate(g, { enabled: [ON_ID], installed: [ON_ID, OFF_ID], asserted: [] });
    return a.willRun === b.willRun && (a.reason || null) === (b.reason || null)
      && JSON.stringify(a.unknown) === JSON.stringify(b.unknown) && b.assumed === false;
  }));
  const c2 = createTempCopy(sourceDbPath);
  const plain = replayOrdered(c2.tempDbPath, collected, { gates: bare });
  check('no assumed flags anywhere without assertions',
    plain.gatedAssumed.length === 0 && plain.perFile.every((f) => !f.gate || f.gate.assumed === false)
    && plain.gatedOut.every((g) => g.assumed === false));
  check('unasserted setup files replay as unknown (1.3 behavior)',
    plain.gatedUnknown.map((g) => g.fileLabel).join(',') === 'ruleset.sql,mode.sql,unknown.sql,not-ruleset.sql',
    JSON.stringify(plain.gatedUnknown.map((g) => g.fileLabel)));
  check('measured outcomes unchanged without assertions',
    plain.perFile[0].status === 'committed' && plain.perFile[4].status === 'skipped-gated'
    && plain.perFile[5].status === 'committed' && plain.executed === 5 && plain.skippedGated === 1,
    plain.perFile.map((f) => `${f.fileLabel}:${f.status}`).join(', '));
  destroyTempCopy(c2.tmpDir);

  console.log('\nTest 4: temp-copy lifecycle (live DB never written)');
  check('source content unchanged', sha256(sourceDbPath) === beforeHash);
  check('source mtime unchanged', fs.statSync(sourceDbPath).mtimeMs === beforeMtime);
  const liveRows = (() => {
    const db = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { return db.prepare('SELECT Id FROM SetupCheck').all(); } finally { db.close(); }
  })();
  check('source holds only its seed row', liveRows.length === 1 && liveRows[0].Id === 'base', JSON.stringify(liveRows));

  if (pass) fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? 'CONFLICT-REPLAY ASSUMED-GATES: ALL CHECKS PASSED' : 'CONFLICT-REPLAY ASSUMED-GATES: FAILURES PRESENT');
  console.log('='.repeat(60));
  return pass;
}

module.exports = {
  createTempCopy,
  destroyTempCopy,
  decodeModSql,
  readModFile,
  splitStatements,
  splitStatementsTriggerAware,
  splitterFlags,
  rewriteDoubleQuotes,
  fnv1a32,
  makeHashStubValue,
  needsMakeHash,
  installMakeHashStub,
  looksLikeXml,
  convertXmlToSql,
  normGateId,
  gateContextOf,
  gateSetupKeysFor,
  gateIsAsserted,
  gateAssumedMatch,
  evalGateCondition,
  evaluateGate,
  qIdent,
  qLit,
  listUserTables,
  getTableColumns,
  ensureProvenanceSchema,
  installProvenanceTriggers,
  setProvenanceWriter,
  readProvenanceWrites,
  fileLimitationFlags,
  buildCollisions,
  formatCollision,
  leadingVerb,
  formatZeroRows,
  runProvenance,
  parseDatabaseLog,
  resolveLogSourceMod,
  attributeLogSources,
  parseLogTimestampMs,
  parseModdingLog,
  hasUsableDbContext,
  bracketErrorWithLoading,
  attributeErrorWithFallback,
  gameLoadSequence,
  calibrateLoadOrder,
  formatCalibration,
  normalizeDbMessage,
  dbMessagesMatch,
  collectReplayErrors,
  differentialValidate,
  formatDifferential,
  differentialFixtureLog,
  assertDifferential,
  runDifferential,
  REPLAY_ENVELOPE_REF,
  buildReplayEnvelope,
  formatReplayEnvelope,
  envelopeFixtureModSet,
  runEnvelope,
  preprocessFile,
  collectStatements,
  replayOrdered,
  holdLiveExclusiveForCopy,
  lockedCopyTrial,
  runLiveLock,
  runAssumedGates,
};

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg || arg === '--check') {
    const ok = runCheck();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--fidelity') {
    const ok = runFidelity();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--gates') {
    const ok = runGates();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--provenance') {
    const ok = runProvenance();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--differential') {
    const ok = runDifferential();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--envelope') {
    const ok = runEnvelope();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--live-lock') {
    const ok = runLiveLock();
    process.exit(ok ? 0 : 1);
  }
  if (arg === '--assumed-gates') {
    const ok = runAssumedGates();
    process.exit(ok ? 0 : 1);
  }
  console.error(`unknown flag ${arg}; usage: node src/phase9-conflict-replay.js [--check|--fidelity|--gates|--provenance|--differential|--envelope|--live-lock|--assumed-gates]`);
  process.exit(2);
}
