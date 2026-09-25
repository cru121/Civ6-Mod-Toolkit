'use strict';

// Access to the game's Mods.sqlite, which records which mods are enabled.
// Schema (user_version 24) as observed:
//   ModGroups(ModGroupRowId, Name, CanDelete, Selected, SortIndex)
//       one row per mod group; Selected=1 marks the active group
//   ModGroupItems(ModGroupRowId, ModRowId, Disabled)
//       Disabled=1 -> mod is off in that group
//   Mods(ModRowId, ScannedFileRowId, ModId, Version) + ScannedFiles(Path)
//   ModRelationships(ModRowId, OtherModId, Relationship, OtherModTitle)
//       Relationship: Dependency | Block | Reference | ReverseReference
// ModRowId can change when the game rescans, so everything here keys by ModId.
//
// Uses Node's built-in node:sqlite (Node 22.5+). On older Node the reader
// reports an error instead of crashing, and the rest of the app keeps working.

const fs = require('fs');
const path = require('path');
const { normId } = require('./modinfo');
const { backupFile } = require('./editor');

let DatabaseSync = null;
let loadError = null;
try {
  // Silence the one-time "SQLite is an experimental feature" warning (Node 22).
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = origEmit;
} catch (e) {
  loadError = `Reading the mod database needs Node.js 22.5 or newer (you have ${process.version}).`;
}

const KEEP_BACKUPS = 10;

// Classify a ScannedFiles.Path. DLC / base game paths are stored relative to
// the game's install folder; user mods are absolute.
function classifyPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/\/steamapps\/workshop\/content\//i.test(s)) return 'workshop';
  if (/^(\.\.\/)+DLC\//i.test(s)) return 'dlc';
  if (/^(\.\.\/)+Base\//i.test(s)) return 'base';
  return 'local';
}

function activeGroupOf(db) {
  const groups = db.prepare('SELECT ModGroupRowId AS id, Name AS name, Selected AS selected FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all()
    .map((g) => ({ id: g.id, name: g.name, selected: !!g.selected }));
  return { groups, active: groups.find((g) => g.selected) || groups[0] || null };
}

// Last-resort readable name for an unresolved key, possibly JSON-wrapped:
// '{"LOC_RULERS_OF_CHINA_MOD_TITLE":[]}' -> 'Rulers of China'.
const KNOWN_NAMES = { EXPANSION1: 'Expansion: Rise and Fall', EXPANSION2: 'Expansion: Gathering Storm' };
function prettyName(s) {
  const m = String(s || '').match(/LOC_[A-Z0-9_]+/i);
  if (!m) return s;
  const key = m[0].replace(/^LOC_/i, '').replace(/_MOD_TITLE$/i, '').toUpperCase();
  if (KNOWN_NAMES[key]) return KNOWN_NAMES[key];
  const words = m[0].replace(/^LOC_/i, '').replace(/_(MOD_)?(TITLE|NAME)$/i, '').replace(/(^|_)MOD(_|$)/gi, '$1$2')
    .split('_').filter(Boolean).map((w) => w.toLowerCase());
  const small = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on']);
  return words.map((w, i) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ') || s;
}

// SQL for a ModProperties row's text: the mod's own English text for the tag,
// else the tag's English text from any mod, else the raw value.
function resolved(alias) {
  return `COALESCE(
      (SELECT Text FROM LocalizedText WHERE ModRowId = ${alias}.ModRowId AND Tag = ${alias}.Value AND Locale = 'en_US'),
      (SELECT Text FROM LocalizedText WHERE Tag = ${alias}.Value AND Locale = 'en_US' LIMIT 1),
      ${alias}.Value)`;
}

// A resolved text that is still a bare LOC_ key (or JSON-wrapped one) is useless to show.
function usable(text) {
  return text && !/LOC_[A-Z0-9_]+/i.test(text) ? text : null;
}

// Display name: the mod's own English text, else the same LOC tag's English
// text from any mod (DLC titles are often stored under another row), else the
// title other mods use when they reference it, else the raw value.
const MODS_SQL = `
  SELECT m.ModId AS modId, s.Path AS path, gi.Disabled AS disabled,
    COALESCE(
      (SELECT Text FROM LocalizedText WHERE ModRowId = m.ModRowId AND Tag = p.Value AND Locale = 'en_US'),
      (SELECT Text FROM LocalizedText WHERE Tag = p.Value AND Locale = 'en_US' LIMIT 1),
      (SELECT OtherModTitle FROM ModRelationships WHERE lower(OtherModId) = lower(m.ModId)
         AND OtherModTitle IS NOT NULL AND instr(OtherModTitle, 'LOC_') = 0 LIMIT 1),
      p.Value) AS name,
    (SELECT ${resolved('t')} FROM ModProperties t WHERE t.ModRowId = m.ModRowId AND t.Name = 'Teaser') AS teaser,
    (SELECT Value FROM ModProperties WHERE ModRowId = m.ModRowId AND Name = 'ShowInBrowser') AS showInBrowser
  FROM Mods m
  JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
  LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'
  LEFT JOIN ModGroupItems gi ON gi.ModRowId = m.ModRowId AND gi.ModGroupRowId = ?`;

const REL_SQL = `
  SELECT m.ModId AS modId, r.OtherModId AS otherId, r.Relationship AS rel, r.OtherModTitle AS otherTitle
  FROM ModRelationships r JOIN Mods m ON m.ModRowId = r.ModRowId
  WHERE r.Relationship IN ('Dependency', 'Block')`;

// -> { ok, error?, activeGroup, groups:[], mods:[{ modId, idNorm, name, path,
//      source, disabled, teaser, hidden, requires:[{id,title}], blocks:[{id,title}] }] }
// disabled is null when the mod has no row in the active group.
function readModState(dbPath) {
  if (!DatabaseSync) return { ok: false, error: loadError, groups: [], mods: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const { groups, active } = activeGroupOf(db);
    const rels = new Map();
    for (const r of db.prepare(REL_SQL).all()) {
      const k = normId(r.modId);
      if (!rels.has(k)) rels.set(k, { requires: [], blocks: [] });
      const entry = { id: normId(r.otherId), title: prettyName(r.otherTitle || r.otherId) };
      rels.get(k)[r.rel === 'Dependency' ? 'requires' : 'blocks'].push(entry);
    }
    const mods = db.prepare(MODS_SQL).all(active ? active.id : -1).map((r) => {
      const idNorm = normId(r.modId);
      const rel = rels.get(idNorm) || { requires: [], blocks: [] };
      return {
        modId: r.modId,
        idNorm,
        name: prettyName(r.name) || r.modId,
        path: r.path,
        source: classifyPath(r.path),
        disabled: r.disabled == null ? null : !!r.disabled,
        teaser: usable(r.teaser),
        hidden: r.showInBrowser === 'AlwaysHidden',
        requires: rel.requires,
        blocks: rel.blocks,
      };
    });
    return { ok: true, activeGroup: active, groups, mods };
  } catch (e) {
    return { ok: false, error: `Could not read the mod database: ${e.message}`, groups: [], mods: [] };
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// Everything the details panel shows for one mod, or null if it isn't in the
// database: { version, properties:{Name: text}, components:{Type: n},
// settings:{Type: n}, fileCount }.
function readModDetails(dbPath, modId) {
  if (!DatabaseSync) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const mod = db.prepare('SELECT ModRowId AS rowId, Version AS version FROM Mods WHERE lower(ModId) = lower(?)').get(String(modId));
    if (!mod) return null;
    const properties = {};
    for (const r of db.prepare(`SELECT p.Name AS name, ${resolved('p')} AS text FROM ModProperties p WHERE p.ModRowId = ?`).all(mod.rowId)) {
      const t = usable(r.text);
      if (t != null) properties[r.name] = t;
    }
    const counts = (sql) => Object.fromEntries(db.prepare(sql).all(mod.rowId).map((r) => [r.type, r.n]));
    return {
      version: mod.version,
      properties,
      components: counts('SELECT ComponentType AS type, count(*) AS n FROM Components WHERE ModRowId = ? GROUP BY 1'),
      settings: counts('SELECT SettingType AS type, count(*) AS n FROM Settings WHERE ModRowId = ? GROUP BY 1'),
      fileCount: db.prepare('SELECT count(*) AS n FROM ModFiles WHERE ModRowId = ?').get(mod.rowId).n,
    };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

// Keep only the newest KEEP_BACKUPS "Mods.sqlite.bak-YYYYMMDD-HHMMSS" copies.
// Other backups (e.g. hand-made ones) are never touched.
function pruneBackups(dbPath) {
  const dir = path.dirname(dbPath);
  const re = new RegExp(`^${path.basename(dbPath).replace(/\./g, '\\.')}\\.bak-\\d{8}-\\d{6}$`);
  const baks = fs.readdirSync(dir).filter((f) => re.test(f)).sort();
  for (const f of baks.slice(0, Math.max(0, baks.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
  }
}

// changes: [{ modId, enabled }]. Caller must make sure the game is closed.
// Backs up the database, applies all changes in one transaction to the active
// mod group, then verifies; on any failure the backup is put back.
function applyChanges(dbPath, changes) {
  if (!DatabaseSync) throw new Error(loadError);
  if (!Array.isArray(changes) || !changes.length) throw new Error('no changes');

  const backupPath = backupFile(dbPath);
  let db;
  let committed = false;
  try {
    db = new DatabaseSync(dbPath);
    const { active } = activeGroupOf(db);
    if (!active) throw new Error('the mod database has no mod group');

    const rowIds = new Map(db.prepare('SELECT ModId, ModRowId FROM Mods').all().map((r) => [normId(r.ModId), r.ModRowId]));
    const update = db.prepare('UPDATE ModGroupItems SET Disabled = ? WHERE ModGroupRowId = ? AND ModRowId = ?');

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of changes) {
        const rowId = rowIds.get(normId(c.modId));
        if (rowId == null) throw new Error(`mod ${c.modId} is not in the game's database yet (start the game once)`);
        const n = update.run(c.enabled ? 0 : 1, active.id, rowId).changes;
        if (n !== 1) throw new Error(`mod ${c.modId} is not part of the active mod group`);
      }
      db.exec('COMMIT');
      committed = true;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('database check failed after saving');

    // Read back what we wrote.
    const read = db.prepare('SELECT Disabled FROM ModGroupItems WHERE ModGroupRowId = ? AND ModRowId = ?');
    for (const c of changes) {
      const row = read.get(active.id, rowIds.get(normId(c.modId)));
      if (!row || !!row.Disabled === !!c.enabled) throw new Error(`verification failed for mod ${c.modId}`);
    }
    db.close();
    db = null;
    pruneBackups(dbPath);
    return { backupPath, changed: changes.length, group: active };
  } catch (e) {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    if (committed) {
      // Something went wrong after writing: put the untouched copy back.
      try { fs.copyFileSync(backupPath, dbPath); e.message += ' (the database was restored from the backup)'; }
      catch (_) { e.message += ` (restore failed; your backup is ${backupPath})`; }
    } else {
      // Nothing was written, so the backup is just a duplicate.
      try { fs.unlinkSync(backupPath); } catch (_) { /* ignore */ }
    }
    throw e;
  }
}

module.exports = { readModState, readModDetails, applyChanges, classifyPath };
