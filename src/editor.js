'use strict';

// Phase 2: apply add/remove edits to a .Civ6Cfg and save safely.
//
// Safety model:
//   - the buffer edit itself only splices mod-block bytes (see civ6cfg.js);
//   - before writing we re-parse the edited buffer and assert the intended
//     changes are present in every mod block and the file is still well-formed;
//   - the original file is copied to a timestamped .bak-* before being replaced;
//   - the write is atomic (temp file + rename).

const fs = require('fs');
const path = require('path');
const cfg = require('./civ6cfg');
const { normId } = require('./modinfo');

// Civ writes a user mod's title as {"<display name>":[]} (literal name as the
// JSON key, empty locale array). DLC uses a LOC_* key instead. We mirror the
// user-mod form for anything we add.
function buildTitle(name) {
  return JSON.stringify({ [name || 'Unknown Mod']: [] });
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupFile(filePath) {
  const bak = `${filePath}.bak-${timestamp()}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

function atomicWrite(filePath, buffer) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, filePath); // replaces existing on Windows and POSIX
  } catch (e) {
    // Fallback: direct overwrite if rename across the same dir somehow fails.
    fs.writeFileSync(filePath, buffer);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

// Apply edits to a buffer (pure, no disk I/O). Returns the new buffer.
//   adds:    [{ id, title }]  (title optional; built from name if omitted)
//   removes: [ id, ... ]
function applyEdits(buffer, { adds = [], removes = [] } = {}) {
  let out = buffer;
  for (const id of removes) out = cfg.removeMod(out, id);
  for (const a of adds) out = cfg.addMod(out, a.id, a.title || buildTitle(a.name));
  return out;
}

// Validate that `edited` reflects the requested changes and is still coherent.
function validate(original, edited, { adds = [], removes = [] } = {}) {
  const problems = [];
  if (edited.slice(0, 4).toString() !== 'CIV6') problems.push('output lost CIV6 magic header');

  let blocks;
  try {
    blocks = cfg.parseConfig(edited).blocks;
  } catch (e) {
    problems.push(`edited file no longer parses: ${e.message}`);
    return { ok: false, problems };
  }
  if (blocks.length === 0) problems.push('no mod blocks found after edit');

  for (const b of blocks) {
    if (b.count !== b.mods.length) {
      problems.push(`${b.key}: count field (${b.count}) != element count (${b.mods.length})`);
    }
    const norms = new Set(b.mods.map((m) => normId(m.id)));
    for (const a of adds) {
      if (!norms.has(normId(a.id))) problems.push(`${b.key}: added mod ${a.id} missing`);
    }
    for (const id of removes) {
      if (norms.has(normId(id))) problems.push(`${b.key}: removed mod ${id} still present`);
    }
  }

  // Every byte outside mod blocks must be unchanged. We prove this by checking
  // that removing our adds and re-adding our removes reconstructs the original.
  try {
    let back = edited;
    for (const a of adds) back = cfg.removeMod(back, a.id);
    // (re-adding removed mods is not reversible to exact bytes, so only assert
    //  the invariant when the edit was adds-only)
    if (removes.length === 0 && !back.equals(original)) {
      problems.push('non-mod-block bytes changed (add is not cleanly reversible)');
    }
  } catch (e) {
    problems.push(`reversibility check failed: ${e.message}`);
  }

  return { ok: problems.length === 0, problems };
}

// Full save operation.
//   opts: { adds, removes, outPath, backup=true, dryRun=false }
// Returns a summary object.
function saveConfig(configPath, opts = {}) {
  const { adds = [], removes = [], outPath = configPath, backup = true, dryRun = false } = opts;
  const original = fs.readFileSync(configPath);
  const before = cfg.listMods(original).mods.length;

  const edited = applyEdits(original, { adds, removes });
  const v = validate(original, edited, { adds, removes });
  if (!v.ok) {
    const err = new Error('validation failed:\n  - ' + v.problems.join('\n  - '));
    err.problems = v.problems;
    throw err;
  }

  const after = cfg.listMods(edited).mods.length;
  const summary = {
    configPath,
    outPath,
    added: adds.map((a) => a.id),
    removed: removes.slice(),
    modsBefore: before,
    modsAfter: after,
    bytesBefore: original.length,
    bytesAfter: edited.length,
    backupPath: null,
    written: false,
    dryRun,
  };

  if (dryRun) return summary;

  const overwriting = path.resolve(outPath) === path.resolve(configPath);
  if (backup && overwriting && fs.existsSync(outPath)) {
    summary.backupPath = backupFile(outPath);
  }
  atomicWrite(outPath, edited);
  summary.written = true;
  return summary;
}

module.exports = { buildTitle, backupFile, applyEdits, validate, saveConfig };
