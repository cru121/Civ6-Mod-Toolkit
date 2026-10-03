'use strict';

const paths = require('./paths');
const { scanMods } = require('./modinfo');
const { readModState } = require('./modsdb');

// Everything the mod manager shows: the game's database joined with the mod
// folders on disk. Mods found on disk but not yet in the database (the game
// hasn't rescanned) are listed with scanned=false and can't be toggled.
function modList() {
  const installed = scanMods(paths.getSources());
  const modsDb = paths.getModsDb();
  const st = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
  const disk = new Map(installed.map((m) => [m.idNorm, m]));
  const out = [];
  const isLoc = (n) => !n || /^LOC_[A-Z0-9_]+$/i.test(n);
  for (const d of st.mods) {
    // Base-game scenarios/maps and entries the game hides aren't user-facing.
    if (d.source === 'base' || d.hidden || !/\.modinfo$/i.test(d.path)) continue;
    const f = disk.get(d.idNorm);
    out.push({
      id: d.modId,
      idNorm: d.idNorm,
      name: isLoc(d.name) && f ? f.name : d.name,
      source: f ? f.type : d.source,
      enabled: d.disabled == null ? null : !d.disabled,
      scanned: true,
      teaser: d.teaser,
      workshopId: f ? f.workshopId || null : null,
      folder: f ? f.folder : null,
      requires: d.requires,
      blocks: d.blocks,
    });
  }
  if (st.ok) {
    const inDb = new Set(st.mods.map((m) => m.idNorm));
    for (const f of installed) {
      if (inDb.has(f.idNorm)) continue;
      out.push({
        id: f.id, idNorm: f.idNorm, name: f.name, source: f.type, enabled: null, scanned: false, teaser: null,
        workshopId: f.workshopId || null, folder: f.folder, requires: [], blocks: [],
      });
    }
  }
  const plain = (n) => n.replace(/\[[^\]]*\]/g, '').trim(); // sort without Civ [COLOR_*] markup
  out.sort((a, b) => plain(a.name).localeCompare(plain(b.name), undefined, { sensitivity: 'base' }));
  return { modsDb, ok: st.ok, error: st.error || null, activeGroup: st.activeGroup || null, mods: out };
}

module.exports = { modList };
