'use strict';

// Wrapped in a function so that nothing leaks into the page's global scope as a
// bare name - `byName` and `labelKey` are not names worth offering the rest of the
// app - and so the file can be both served to the browser and required by phase6.
// It publishes one object either way: window.modsort in the page, module.exports
// in node. Everything below is inside that function.

const API = (() => {
  // Every comparator is pure and takes what it needs as arguments, which is what
  // lets phase6 check the orderings without a browser. Nothing here touches the
  // DOM, `pages`, `localStorage` or `modsPage` - if a function below grew a
  // dependency on page state it could no longer be required from node, and the
  // orderings that matter most (stability, unlabelled-last, pending-as-current)
  // are exactly the ones that are hard to eyeball.
  //
  // mods.js passes in `isOn` and `problemCount` because both reach into
  // modsPage.pending, which lives on the page and not here.

// The keys, in the order the select lists them. `changed` is appended only when
// the server actually sent a timestamp - see `availableSorts`.
//
// `hint` is the tooltip, shown when the pointer rests on the control. It lives
// here, beside the comparator it describes, so the two cannot drift apart the
// way a tooltip written in the HTML would.
//
// A native <select> draws its own popup, so a tooltip cannot be attached to an
// individual unselected option - no browser shows one. The control's title is
// therefore the *active* key's hint: the one on screen, and the one worth
// explaining. Per-option tooltips would mean replacing the select with a
// hand-built dropdown, which is a far larger change than the tooltip is worth.
const SORTS = [
  { key: 'name', label: 'Name', hint: 'Alphabetical, ignoring case and Civ colour markup.' },
  { key: 'state', label: 'State', hint: 'Enabled first, then disabled. A mod you have switched on but not yet applied counts as on.' },
  { key: 'source', label: 'Source', hint: 'Workshop, then local, then official DLC.' },
  { key: 'label', label: 'Label', hint: 'By your first label - the order you applied them. Mods with no label go last.' },
  { key: 'attention', label: 'Needs attention', hint: 'Mods with a missing dependency or an active conflict first. How many problems it has makes no difference.' },
  { key: 'changed', label: 'Last changed', hint: 'Newest .modinfo file first. This means the file changed, not that the author released something - a Steam file repair also bumps it. Not the same number as the details panel\'s "Last changed", which reports the newest file anywhere in the folder.' },
];

  const DEFAULT_SORT = 'name';

  // Workshop, then local, then DLC. Deliberately not SRC_MATCH's key order:
  // that is an alphabetical list of the filter buttons and includes the "mods"
  // catch-all, which is a subset of workshop, not a source.
  const SOURCE_RANK = { workshop: 0, local: 1, dlc: 2, base: 3 };

  // Case-insensitive, the same rule the label store compares by.
  const labelKey = (n) => String(n == null ? '' : n).trim().toLowerCase();

  // An unknown key, a key this browser has no comparator for, and the default all
  // fall back to name rather than throwing: a stored value that stops making sense
  // should cost the user their sort order for this session, not the whole page.
  function comparatorFor(key) {
    switch (key) {
      case 'state': return byState;
      case 'source': return bySource;
      case 'label': return byLabel;
      case 'attention': return byAttention;
      case 'changed': return byChanged;
      default: return byName;
    }
  }

  function byName(a, b) {
    return String(a.sortName == null ? a.name : a.sortName)
      .localeCompare(String(b.sortName == null ? b.name : b.sortName), undefined, { sensitivity: 'base' });
  }

  // Enabled first, then disabled. `isOn` rather than `enabled`, so a mod you have
  // switched on but not applied sorts as on - the same rule the rows themselves
  // use, and the reason the warning count and the list agree.
  function byState(a, b, ctx) {
    const on = (m) => (ctx.isOn ? !!ctx.isOn(m) : m.enabled === true);
    return (on(b) ? 1 : 0) - (on(a) ? 1 : 0);
  }

  function bySource(a, b) {
    const rank = (m) => (SOURCE_RANK[m.source] == null ? 99 : SOURCE_RANK[m.source]);
    return rank(a) - rank(b);
  }

  // Unlabelled last, then alphabetical by the first label. "First" is array
  // order, which is the order the user applied them in, so a mod labelled
  // favourite then mp-safe sorts under f.
  function byLabel(a, b) {
    const first = (m) => {
      const names = m.labels || [];
      return names.length ? labelKey(names[0]) : null;
    };
    const fa = first(a);
    const fb = first(b);
    if (fa === null && fb === null) return 0;
    if (fa === null) return 1;
    if (fb === null) return -1;
    return fa.localeCompare(fb);
  }

  // Mods with unmet dependencies or active conflicts first. The count comes from
  // problemsOf, the same function the warning total uses, so the order and the
  // number in the bottom bar cannot disagree.
  //
  // A boolean, not a magnitude: the spec asks for mods with problems first, and a
  // mod with one missing dependency is not meaningfully "less broken" than one with
  // two. Two problems and one sort together, then by name.
  function byAttention(a, b, ctx) {
    const n = (m) => (ctx.problemCount ? ctx.problemCount(m) > 0 : false);
    return (n(b) ? 1 : 0) - (n(a) ? 1 : 0);
  }

  // Newest first, and a mod with no timestamp LAST rather than first - it has no
  // date, not the oldest one, and 1970 would put every DLC entry above every mod
  // you actually touched.
  function byChanged(a, b) {
    const t = (m) => (typeof m.lastChanged === 'number' && isFinite(m.lastChanged) ? m.lastChanged : null);
    const ta = t(a);
    const tb = t(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }

  // The keys this session can actually sort by. `changed` is offered only when at
  // least one mod has a timestamp: against an older server the field is absent,
  // and an option that silently moved every mod to the end would look like a
  // working sort that does nothing.
  function availableSorts(mods) {
    const list = mods || [];
    const anyDate = list.some((m) => typeof m.lastChanged === 'number' && isFinite(m.lastChanged));
    return SORTS.filter((s) => s.key !== 'changed' || anyDate);
  }

  // Sort a copy - data.mods is shared by the details dialog, the bar's problem
  // count and the filters, and reordering it under them would be a bug waiting to
  // be reported as something else.
  //
  // Every key falls back to name for its ties, so two enabled mods are still in a
  // predictable order instead of whichever order the array happened to arrive in.
  // Array.prototype.sort has been stable since ES2019, so equal keys keep the
  // arrival order - which is the server's name order - and stay there across
  // repeated sorts.
  function sortMods(list, key, ctx) {
    const cmp = comparatorFor(key);
    return list.slice().sort((a, b) => cmp(a, b, ctx || {}) || byName(a, b));
  }

  // A stored key is only honoured if it is one this build can actually sort by.
  // A value saved before a key was added, or saved against a server that did not
  // send the field it needs, falls back to the default instead of sorting every
  // mod to the end of the list.
  //
  // `available` is a list of SORTS entries - the same thing availableSorts
  // returns - rather than a list of key names. Accepting both was the obvious
  // convenience and it hid a bug: mapping `.key` over an array of strings yields
  // [undefined, ...], so a caller passing the names got a silent fallback to name
  // for every key, every time. One shape, and the caller passes what it already has.
  function resolveSortKey(stored, available) {
    const list = available || SORTS;
    const keys = list.map((s) => (typeof s === 'string' ? s : s.key));
    return keys.indexOf(stored) === -1 ? DEFAULT_SORT : stored;
  }

  return {
    SORTS, DEFAULT_SORT, SOURCE_RANK, labelKey,
    byName, byState, bySource, byLabel, byAttention, byChanged,
    comparatorFor, availableSorts, sortMods, resolveSortKey,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.modsort = API;
