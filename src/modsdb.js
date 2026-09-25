'use strict';

// Read-only access to the game's Mods.sqlite, which records which mods are
// enabled. Schema (user_version 24) as observed:
//   ModGroups(ModGroupRowId, Name, CanDelete, Selected, SortIndex)
//       one row per mod group; Selected=1 marks the active group
//   ModGroupItems(ModGroupRowId, ModRowId, Disabled)
//       Disabled=1 -> mod is off in that group
//   Mods(ModRowId, ScannedFileRowId, ModId, Version) + ScannedFiles(Path)
// ModRowId can change when the game rescans, so callers must key by ModId.
//
// Uses Node's built-in node:sqlite (Node 22.5+). On older Node the reader
// reports an error instead of crashing, and the rest of the app keeps working.

const { normId } = require('./modinfo');

let DatabaseSync = null;
let loadError = null;
try {
  // Silence the one-time "SQLite is an experimental feature" warning.
  const origEmit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = origEmit;
} catch (e) {
  loadError = `Reading the mod database needs Node.js 22.5 or newer (you have ${process.version}).`;
}

// Classify a ScannedFiles.Path. DLC / base game paths are stored relative to
// the game's install folder; user mods are absolute.
function classifyPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/\/steamapps\/workshop\/content\//i.test(s)) return 'workshop';
  if (/^(\.\.\/)+DLC\//i.test(s)) return 'dlc';
  if (/^(\.\.\/)+Base\//i.test(s)) return 'base';
  return 'local';
}

// -> { ok, error?, activeGroup, groups:[], mods:[{ modId, idNorm, name, path, source, disabled }] }
// disabled is null when the mod has no row in the active group.
function readModState(dbPath) {
  if (!DatabaseSync) return { ok: false, error: loadError, groups: [], mods: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const groups = db.prepare('SELECT ModGroupRowId AS id, Name AS name, Selected AS selected FROM ModGroups ORDER BY SortIndex, ModGroupRowId').all()
      .map((g) => ({ id: g.id, name: g.name, selected: !!g.selected }));
    const active = groups.find((g) => g.selected) || groups[0] || null;
    const rows = db.prepare(`
      SELECT m.ModId AS modId, s.Path AS path, gi.Disabled AS disabled,
             COALESCE(lt.Text, p.Value) AS name
      FROM Mods m
      JOIN ScannedFiles s ON s.ScannedFileRowId = m.ScannedFileRowId
      LEFT JOIN ModProperties p ON p.ModRowId = m.ModRowId AND p.Name = 'Name'
      LEFT JOIN LocalizedText lt ON lt.ModRowId = m.ModRowId AND lt.Tag = p.Value AND lt.Locale = 'en_US'
      LEFT JOIN ModGroupItems gi ON gi.ModRowId = m.ModRowId AND gi.ModGroupRowId = ?
    `).all(active ? active.id : -1);
    const mods = rows.map((r) => ({
      modId: r.modId,
      idNorm: normId(r.modId),
      name: r.name || r.modId,
      path: r.path,
      source: classifyPath(r.path),
      disabled: r.disabled == null ? null : !!r.disabled,
    }));
    return { ok: true, activeGroup: active, groups, mods };
  } catch (e) {
    return { ok: false, error: `Could not read the mod database: ${e.message}`, groups: [], mods: [] };
  } finally {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { readModState, classifyPath };
