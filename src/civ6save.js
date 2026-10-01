'use strict';

// Read and edit the mod list of a .Civ6Save.
//
// A save keeps its mod list in the uncompressed header, in several parallel
// MOD_BLOCK arrays (the exact set differs between game versions and between
// blocks, e.g. UI-only mods appear in only some of them). The compressed
// game-state blob after the header is never touched: edits splice header bytes
// only, and we prove that by checking the file tail is byte-identical.

const parser = require('./civ6-save-parser');
const { normId } = require('./modinfo');

const TAIL = 32 * 1024;

function modBlocks(buffer) {
  const { parsed } = parser.parse(buffer, { simple: true });
  return Object.keys(parsed)
    .filter((k) => k.startsWith('MOD_BLOCK_') && Array.isArray(parsed[k]))
    .map((key) => ({ key, mods: parsed[key].map((m) => ({ id: m.MOD_ID, title: m.MOD_TITLE })) }));
}

// Unique mods across all blocks: { id, idNorm, title, blocks:[keys] }
function listMods(buffer) {
  if (buffer.slice(0, 4).toString() !== 'CIV6') throw new Error('Not a Civilization VI file.');
  const blocks = modBlocks(buffer);
  const byNorm = new Map();
  for (const b of blocks) {
    for (const m of b.mods) {
      const k = normId(m.id);
      if (!byNorm.has(k)) byNorm.set(k, { id: m.id, idNorm: k, title: m.title, blocks: [] });
      byNorm.get(k).blocks.push(b.key);
    }
  }
  return { blockKeys: blocks.map((b) => b.key), mods: [...byNorm.values()] };
}

// Remove mods (by id, any GUID casing/braces) from every block that lists them.
function removeMods(buffer, ids) {
  let out = buffer;
  for (const id of ids) {
    const want = normId(id);
    const raws = new Set();
    for (const b of modBlocks(out)) for (const m of b.mods) if (normId(m.id) === want) raws.add(m.id);
    // The same mod can be spelled differently per block; delete each spelling.
    for (const raw of raws) {
      let guard = 0;
      while (modBlocks(out).some((b) => b.mods.some((m) => m.id === raw)) && guard++ < 20) {
        out = Buffer.concat(parser.deleteMod(out, raw).chunks);
      }
    }
  }
  return out;
}

// Returns { ok, problems[] } for `edited` against `original`.
function validate(original, edited, removes) {
  const problems = [];
  if (edited.slice(0, 4).toString() !== 'CIV6') problems.push('output lost CIV6 magic header');
  const gone = new Set(removes.map(normId));
  let a, b;
  try {
    a = modBlocks(original);
    b = modBlocks(edited);
  } catch (e) {
    return { ok: false, problems: [`edited file no longer parses: ${e.message}`] };
  }
  if (a.map((x) => x.key).join() !== b.map((x) => x.key).join()) problems.push('mod blocks changed shape');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const want = a[i].mods.filter((m) => !gone.has(normId(m.id))).map((m) => m.id + '|' + m.title);
    const got = b[i].mods.map((m) => m.id + '|' + m.title);
    if (want.join('\n') !== got.join('\n')) problems.push(`${a[i].key}: mod list is not the original minus the removed mods`);
  }
  const n = Math.min(TAIL, original.length, edited.length);
  if (!original.slice(original.length - n).equals(edited.slice(edited.length - n))) {
    problems.push('end of file (game data) changed');
  }
  if (edited.length > original.length) problems.push('edited file grew');
  return { ok: problems.length === 0, problems };
}

// Whole-file sanity check on the untouched buffer: re-serialising the parsed
// chunks must reproduce the file exactly, otherwise we can't edit it safely.
function roundTrips(buffer) {
  try {
    return Buffer.concat(parser.parse(buffer).chunks).equals(buffer);
  } catch (_) {
    return false;
  }
}

function applyRemoval(buffer, ids) {
  if (!roundTrips(buffer)) throw new Error("This save's header can't be re-written byte-for-byte, so editing it isn't safe.");
  const edited = removeMods(buffer, ids);
  const v = validate(buffer, edited, ids);
  if (!v.ok) {
    const err = new Error('validation failed:\n  - ' + v.problems.join('\n  - '));
    err.problems = v.problems;
    throw err;
  }
  return edited;
}

module.exports = { listMods, removeMods, validate, roundTrips, applyRemoval };
