'use strict';

// Saved-game helpers shared by the web UI (server.js) and the CLI (saves-cli.js).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const civ6save = require('./civ6save');
const inventory = require('./inventory');
const editor = require('./editor');
const { scanMods, normId } = require('./modinfo');
const { readModState } = require('./modsdb');

// Saves live in the Saves/Single folder and one level of subfolders (auto/, ...).
function listSaves() {
  const saves = paths.getSavesDir();
  const out = [];
  if (saves.exists) {
    const scan = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !rel) scan(full, e.name);
        else if (e.isFile() && /\.Civ6Save$/i.test(e.name)) {
          const st = fs.statSync(full);
          out.push({ name: e.name, folder: rel, path: full, size: st.size, modified: st.mtimeMs });
        }
      }
    };
    try { scan(saves.root, ''); } catch (_) { /* unreadable folder: show what we have */ }
  }
  out.sort((a, b) => b.modified - a.modified);
  return { savesRoot: saves.root, savesExists: saves.exists, saves: out };
}

// Only .Civ6Save files inside the saves folder may be read or changed.
function isSavePath(p) {
  if (typeof p !== 'string' || !/\.Civ6Save$/i.test(p)) return false;
  const root = path.resolve(paths.getSavesDir().root) + path.sep;
  return path.resolve(p).toLowerCase().startsWith(root.toLowerCase());
}

// A save's mods, each classified:
//   official - DLC / expansion content (removing it would break the save)
//   ui       - AffectsSavedGames=0: not part of the saved game state
//   gameplay - changes game rules/content: may be baked into the save
//   unknown  - not installed, so we can't tell
// `available` lists installed mods that are not in the save (candidates to add).
function saveMods(buffer) {
  const { mods, blockKeys } = civ6save.listMods(buffer);
  const installed = new Map(scanMods(paths.getSources()).map((m) => [m.idNorm, m]));
  const modsDb = paths.getModsDb();
  const dlc = new Map(); // official content: idNorm -> display name
  const enabled = new Map(); // idNorm -> in the game's active mod group?
  if (modsDb.exists) {
    const st = readModState(modsDb.path);
    for (const d of st.mods) {
      if (d.source === 'dlc' || d.source === 'base') dlc.set(d.idNorm, d.name);
      if (d.disabled != null) enabled.set(d.idNorm, !d.disabled);
    }
  }
  const inSave = new Set(mods.map((m) => m.idNorm));
  const out = mods.map((m) => {
    const f = installed.get(m.idNorm);
    const title = inventory.humanTitle(m.title);
    let kind = 'unknown';
    if (dlc.has(m.idNorm) || (!f && /^LOC_[A-Z0-9_]+$/.test(title))) kind = 'official';
    else if (f) kind = f.affectsSavedGames === false ? 'ui' : 'gameplay';
    const name = f ? f.name : (dlc.get(m.idNorm) || title);
    return {
      id: m.id, idNorm: m.idNorm, name, kind, installed: !!f, source: f ? f.type : null,
      enabled: enabled.has(m.idNorm) ? enabled.get(m.idNorm) : null, blocks: m.blocks,
    };
  });
  const available = [...installed.values()].filter((f) => !inSave.has(f.idNorm)).map((f) => ({
    id: f.id, idNorm: f.idNorm, name: f.name, kind: f.affectsSavedGames === false ? 'ui' : 'gameplay',
    source: f.type, enabled: enabled.has(f.idNorm) ? enabled.get(f.idNorm) : null,
  }));
  available.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { blockKeys, mods: out, available };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra);
}

// Remove and/or add mods. opts: { add:[id], remove:[id], mode:'new'|'overwrite', newName, dryRun }
// 'new' (default) writes a copy and leaves the original alone; 'overwrite' backs it up first.
function editSave(savePath, opts = {}) {
  const { add = [], remove = [], mode = 'new', newName, dryRun = false } = opts;
  if (!isSavePath(savePath) || !fs.existsSync(savePath)) throw httpError(400, 'invalid save path');
  if (!add.length && !remove.length) throw httpError(400, 'no mods selected');
  const original = fs.readFileSync(savePath);
  const info = saveMods(original);
  const inSave = new Map(info.mods.map((m) => [m.idNorm, m]));
  const avail = new Map(info.available.map((m) => [m.idNorm, m]));

  const removed = [];
  for (const id of remove) {
    const m = inSave.get(normId(id));
    if (!m) throw httpError(400, `mod not in this save: ${id}`);
    if (m.kind === 'official') throw httpError(400, `"${m.name}" is official game content and can't be removed from a save.`);
    removed.push(m);
  }
  const added = [];
  for (const id of add) {
    const m = avail.get(normId(id));
    if (!m) throw httpError(400, inSave.has(normId(id)) ? `already in this save: ${id}` : `mod not installed: ${id}`);
    if (removed.some((r) => r.idNorm === m.idNorm)) throw httpError(400, `can't add and remove the same mod: ${m.name}`);
    added.push(m);
  }

  const edited = civ6save.applyEdit(original, {
    remove: removed.map((m) => m.id),
    add: added.map((m) => ({ id: m.id, title: editor.buildTitle(m.name), gameplay: m.kind !== 'ui' })),
  });

  let outPath = savePath;
  if (mode === 'new') {
    let base = path.basename(String(newName || '').trim());
    if (!base) base = path.basename(savePath).replace(/\.Civ6Save$/i, '') + ' (edited)';
    if (!/\.Civ6Save$/i.test(base)) base += '.Civ6Save';
    outPath = path.join(path.dirname(savePath), base);
    if (fs.existsSync(outPath)) throw httpError(409, `file already exists: ${base}`);
  }
  const summary = {
    outPath, backupPath: null, written: false, dryRun,
    removed: removed.map((m) => m.name), added: added.map((m) => m.name),
    modsBefore: info.mods.length, modsAfter: civ6save.listMods(edited).mods.length,
    bytesBefore: original.length, bytesAfter: edited.length,
  };
  if (dryRun) return summary;
  if (mode === 'overwrite') summary.backupPath = editor.backupFile(savePath);
  editor.atomicWrite(outPath, edited);
  summary.written = true;
  return summary;
}

module.exports = { listSaves, isSavePath, saveMods, editSave };
