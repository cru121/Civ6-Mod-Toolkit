'use strict';

// The mod list shared by the web server and the command line (mods-cli.js).

const paths = require('./paths');
const { scanMods } = require('./modinfo');
const { readModState, listGroups, findUnregistered } = require('./modsdb');
const labelStore = require('./labels');

// Civ text markup - [COLOR_GREEN]…[ENDCOLOR], [ICON_*], [NEWLINE] - has no place
// in a sort key, and sorting on the raw name puts every tagged name together
// ahead of any name starting with a letter. The list is ordered by the
// markup-free form, and that same form is sent as `sortName` so the browser
// sorts on exactly what the server sorted on. Deriving it there instead would be
// a second Civ-markup parser in another language, and the two would drift.
const plainName = (n) => String(n == null ? '' : n).replace(/\[[^\]]*\]/g, '').trim();

// Everything the mod manager shows: the game's database joined with the mod
// folders on disk. Mods found on disk but not yet in the database (the game
// hasn't rescanned) are listed with scanned=false and can't be toggled.
//
// opts.prune says whether the list below may be treated as a complete statement
// about which mods exist. It may not be: when the database would not read, `out`
// comes back empty, and pruning labels against an empty list would delete every
// one the user has. Callers that know the game is closed pass true; everyone else
// gets the labels as they are on disk.
function modList(opts = {}) {
  const installed = scanMods(paths.getSources());
  const modsDb = paths.getModsDb();
  const st = modsDb.exists ? readModState(modsDb.path) : { ok: false, error: 'Mod database not found.', mods: [] };
  const disk = new Map(installed.map((m) => [m.idNorm, m]));
  // What a sync would add, from the one place that decides. Passing the state
  // we already read avoids opening the database a second time per request.
  const todo = st.ok ? findUnregistered(modsDb.path, paths.getSources(), st) : { pending: [] };
  const needsSync = new Set(todo.pending.map((p) => p.idNorm));
  const out = [];
  const isLoc = (n) => !n || /^LOC_[A-Z0-9_]+$/i.test(n);
  for (const d of st.mods) {
    // Base-game scenarios/maps and entries the game hides aren't user-facing.
    if (d.source === 'base' || d.hidden || !/\.modinfo$/i.test(d.path)) continue;
    const f = disk.get(d.idNorm);
    const name = isLoc(d.name) && f ? f.name : d.name;
    out.push({
      id: d.modId,
      idNorm: d.idNorm,
      name,
      sortName: plainName(name),
      source: f ? f.type : d.source,
      enabled: d.disabled == null ? null : !d.disabled,
      scanned: true,
      // A sync would give this mod the row it is missing, so the mod manager
      // can point at Rescan rather than offering its own button.
      needsSync: needsSync.has(d.idNorm),
      teaser: d.teaser,
      // Unix milliseconds, or null when the game never stamped the file. The
      // browser's "Last changed" ordering sorts the nulls last.
      lastChanged: d.lastChanged == null ? null : d.lastChanged,
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
        id: f.id, idNorm: f.idNorm, name: f.name, sortName: plainName(f.name),
        source: f.type, enabled: null, scanned: false, teaser: null,
        needsSync: true,
        workshopId: f.workshopId || null, folder: f.folder, requires: [], blocks: [],
      });
    }
  }
  // Ordered by the same field the browser is sent, so the array's arrival order
  // is already the name order - which is what every other sort key falls back to
  // for its ties, and what makes the client's sort stable.
  out.sort((a, b) => a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' }));

  // The user's own labels, read once per request so the page never fetches them
  // separately. A label a mod does not carry is an empty list, not a missing
  // field, so the client never has to ask whether a mod has labels or not.
  const labelView = labelStore.readLabels(labelStore.labelsFile(),
    opts.prune ? new Set(out.map((m) => m.idNorm)) : null);
  for (const m of out) m.labels = labelView.labels[m.idNorm] || [];

  // A sync writes a row in every profile, so the UI needs to know how many
  // there are to describe what will happen.
  const groups = st.ok ? listGroups(modsDb.path).groups.length : 0;
  return {
    modsDb, ok: st.ok, error: st.error || null, activeGroup: st.activeGroup || null,
    labelCounts: labelView.counts, labelNames: labelView.names, labelsError: labelView.error,
    pathsError: paths.overridesStatus().error,
    profiles: groups, needsSync: todo.pending.length, mods: out,
  };
}


module.exports = { modList };
