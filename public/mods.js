'use strict';

// Mod manager page: turn mods on/off in the game's mod database. Two views:
// a checkbox list, and two panes (available / enabled) where clicking a mod
// moves it across. Both share the same pending-changes state.

const modsPage = {
  data: null,          // /api/mods response
  pending: new Map(),  // idNorm -> desired enabled (only real changes)
  src: 'mods',         // mods | workshop | local | dlc
  stateFilter: 'all',  // all | on | off (list view only)
  view: 'list',        // list | panes
  labels: new Set(),   // selected filter labels, lowercased
  sort: 'name',        // which ordering, by key name
};
try { if (localStorage.getItem('modsView') === 'panes') modsPage.view = 'panes'; } catch (_) { /* storage blocked */ }
const SORT_KEY = 'modsSort';
try { modsPage.sort = localStorage.getItem(SORT_KEY) || 'name'; } catch (_) { /* storage blocked */ }

// A label name is free text the user typed, and the store compares it without
// regard to case. Comparing without regard to case here too is what makes a
// filter chip and a row's label chip the same thing.
const labelKey = modsort.labelKey;

// OR, not AND. Several labels selected show the mods carrying ANY of them.
// AND would show only mods carrying every one, which is rarely what someone
// wants and quietly returns nothing at all - the worst possible answer to a
// filter, because it looks like the labels are broken.
function matchesLabels(m) {
  if (!modsPage.labels.size) return true;
  return (m.labels || []).some((n) => modsPage.labels.has(labelKey(n)));
}

function toggleLabelFilter(name) {
  const k = labelKey(name);
  if (modsPage.labels.has(k)) modsPage.labels.delete(k);
  else modsPage.labels.add(k);
  renderMods();
}

const SRC_MATCH = {
  mods: (m) => m.source === 'workshop' || m.source === 'local',
  workshop: (m) => m.source === 'workshop',
  local: (m) => m.source === 'local',
  dlc: (m) => m.source === 'dlc',
};

function byNorm() {
  if (!modsPage.data) return new Map();
  return new Map(modsPage.data.mods.map((m) => [m.idNorm, m]));
}

function isOn(m) {
  return modsPage.pending.has(m.idNorm) ? modsPage.pending.get(m.idNorm) : m.enabled === true;
}

function canToggle(m) {
  return m.scanned && m.enabled != null;
}

function setWanted(m, on) {
  if (!canToggle(m)) return;
  if (on === (m.enabled === true)) modsPage.pending.delete(m.idNorm);
  else modsPage.pending.set(m.idNorm, on);
}

// Problems for an enabled mod, given the pending state: missing / disabled
// dependencies and enabled mods it's marked as incompatible with.
//
// `on` decides whether a mod counts as loaded. It defaults to the live state, but
// the profile switch passes one built from the profile being switched to, so the
// same rules can be applied to a set that is not in use yet - otherwise this
// would need writing twice and the two copies would drift.
function problemsOf(m, all, on = isOn) {
  if (!on(m)) return [];
  const out = [];
  for (const r of m.requires) {
    const dep = all.get(r.id);
    if (!dep) out.push({ text: `Needs ${r.title}, which isn't installed` });
    else if (!on(dep)) out.push({ text: `Needs ${dep.name}, which is turned off`, fix: canToggle(dep) ? dep.idNorm : null });
  }
  for (const b of m.blocks) {
    const other = all.get(b.id);
    if (other && on(other)) out.push({ text: `Conflicts with ${other.name}` });
  }
  return out;
}

function visibleMods() {
  // Empty rather than throwing when the list has not loaded. This is called from
  // the bulk buttons, and modsPage.data is null until the first /api/mods
  // resolves - so clicking one in that window raised a TypeError, changed nothing,
  // said nothing, and left the reason in the console where nobody looks.
  if (!modsPage.data) return [];
  const q = $('modsFilter').value.trim().toLowerCase();
  const shown = modsPage.data.mods.filter((m) => SRC_MATCH[modsPage.src](m)
    && matchesLabels(m)
    && (modsPage.view === 'panes' || modsPage.stateFilter === 'all' || (modsPage.stateFilter === 'on') === isOn(m))
    && (!q || m.name.toLowerCase().includes(q) || m.idNorm.includes(q)
      || (m.teaser && m.teaser.toLowerCase().includes(q))));
  // Sorting happens here, once, as the last step - not at each render site.
  // This is the one place that answers "what is shown, and in what order", so
  // the list view, both panes and the label dropdown's count all agree without
  // any of them knowing about sorting. It cannot change which mods are shown,
  // only their order, so the "N of M shown" count is unaffected by design.
  return modsort.sortMods(shown, modsPage.sort, sortContext());
}

// What the orderings need to know about page state, injected rather than
// imported: both of these reach into modsPage.pending, which lives on the page.
// Mods with problems is the same problemsOf the warning count uses, so the order
// and the number in the bottom bar cannot disagree.
function sortContext() {
  const all = modsPage.data ? byNorm() : new Map();
  return { isOn, problemCount: (m) => problemsOf(m, all).length };
}

// ---- rows ------------------------------------------------------------------

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

// The source label is also the link to the mod's Workshop page, for Workshop
// mods. That is not cosmetic: the whole row is the on/off switch, and
// paneClick() only spares the things that are a <button> or an <a>. As a plain
// <span> this label was neither, so clicking it toggled the mod instead of
// opening anything. Making it a real link fixes that structurally rather than
// adding another case to remember.
function sourceTag(m) {
  if (!m.scanned) return '<span class="tag unscanned">not scanned yet</span>';
  if (m.enabled == null) return '<span class="tag" title="The game doesn&#39;t list this in the active mod group (for example DLC you don&#39;t own)">not available</span>';
  const label = m.source === 'dlc' ? 'DLC' : esc(m.source);
  if (!m.workshopId) return `<span class="tag ${esc(m.source)}">${label}</span>`;
  return `<a class="tag ${esc(m.source)}" href="${workshopUrl(m.workshopId)}" target="_blank" rel="noopener"`
    + ` title="Open this mod&#39;s Steam Workshop page">${label}</a>`;
}

function rowClass(m, extra) {
  const on = isOn(m);
  const changed = modsPage.pending.has(m.idNorm);
  return ['row', changed ? (on ? 'pending-add' : 'pending-remove') : '', canToggle(m) ? extra || '' : 'readonly']
    .filter(Boolean).join(' ');
}

// The mod's own folder. Only Workshop and local mods have one - DLC and
// base-game content lives in the game's install folder, not a mod folder.
// m.folder comes from the on-disk scan, so it is null exactly when the mod is
// not there, and a disabled button dispatches no click at all: the broken state
// is unreachable rather than guarded against.
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

function folderButton(m) {
  if (m.source !== 'workshop' && m.source !== 'local') return '';
  if (m.folder) {
    return `<button type="button" class="folder-btn" data-open-folder="${esc(m.idNorm)}"`
      + ` title="Open this mod&#39;s folder">${FOLDER_ICON}</button>`;
  }
  return `<button type="button" class="folder-btn" disabled title="Folder not found — it has been unsubscribed or deleted">${FOLDER_ICON}</button>`;
}

// The user's own labels on this mod. A .chip, not a .tag: these are a control,
// not a badge, and they are the same shape as the filter chips in the row under
// the profile bar so the two read as one idea. Every name is user-typed free
// text, so it is escaped like any other.
//
// An unlabelled mod gets a bare "+" rather than the words "add a label": there
// are 384 of these rows and almost none of them will carry a label, so the
// empty state has to be quiet enough to be ignorable. The title says what it
// does, and the button is always there for the row that needs it.
function labelsChip(m) {
  const names = m.labels || [];
  const title = names.length
    ? `Labels: ${names.join(', ')} — click to change`
    : 'No labels — click to add one';
  return `<button type="button" class="chip mod-labels${names.length ? '' : ' is-empty'}" data-labels="${esc(m.idNorm)}" title="${esc(title)}">${
    names.length ? names.map((n) => esc(n)).join('<span class="sep">·</span>') : '+'}</button>`;
}

// Name, teaser, warnings, source tag, folder button and the details button. The
// source tag is the Workshop link for Workshop mods, so there is no separate one.
function rowBody(m, all) {
  const probs = problemsOf(m, all).map((p) => `<span class="warn-line">⚠ ${renderCivText(p.text)}${
    p.fix ? `<button type="button" data-fix="${esc(p.fix)}">Turn it on</button>` : ''}</span>`).join('');
  const sub = m.teaser ? `<span class="teaser">${renderCivText(m.teaser)}</span>` : `<small>${esc(m.id)}</small>`;
  // The mod manager does not write to the database itself - Apply changes and
  // the profile buttons are the only things that do. A mod that needs adding
  // gets a tag saying so, and the dashboard's "Rescan & add new mods" does it.
  const tag = m.needsSync
    ? `<span class="tag unscanned" title="Not switched on yet. Use “Rescan &amp; add new mods” on the dashboard.">not added</span>`
    : sourceTag(m);
  return `<span class="name"><b>${renderCivText(m.name)}</b>${sub}${probs}</span>
    ${tag}${labelsChip(m)}${folderButton(m)}
    <!-- Not on every row. A DLC the game does not list in the profile has no
         actions in the load order view, so the button navigated to a page with
         nothing marked on it - and it sits close enough to the toggle to be hit
         by accident, which is how turning a DLC on appeared to open this tab. -->
    ${canToggle(m) ? `<button type="button" class="info lo-info" data-loadorder="${esc(m.idNorm)}" title="See this mod in the load order">&#8646;</button>` : ''}
    <button type="button" class="info" data-info="${esc(m.idNorm)}" title="Details">i</button>`;
}

function listRow(m, all) {
  return `<label class="${rowClass(m)}">
    <input type="checkbox" data-mod="${esc(m.idNorm)}" ${isOn(m) ? 'checked' : ''} ${canToggle(m) ? '' : 'disabled'} />
    ${rowBody(m, all)}
  </label>`;
}

function paneRow(m, all, arrow) {
  const movable = canToggle(m);
  const attrs = movable
    ? `data-move="${esc(m.idNorm)}" role="button" tabindex="0" title="${arrow === '→' ? 'Enable' : 'Disable'}"`
    : '';
  return `<div class="${rowClass(m, 'movable')}" ${attrs}>
    ${rowBody(m, all)}
    <span class="move">${movable ? arrow : ''}</span>
  </div>`;
}

// ---- render ----------------------------------------------------------------

// ---- label filter dropdown -------------------------------------------------

// A dropdown rather than a row of chips. Chips were tried first and were fine
// with three labels and unusable with twelve: they took six lines on a phone and
// pushed the mod list off the bottom of the screen. A cap and a "+N more" button
// papered over that; a menu that scrolls removes the question.

// The trigger says what the filter is doing without opening it. One name is
// worth showing; several are not, and a list of twelve in a 200px-wide button
// would be truncated into noise, so it counts them.
function renderLabelTrigger() {
  const n = modsPage.labels.size;
  const names = (modsPage.data.labelCounts || [])
    .filter((c) => modsPage.labels.has(labelKey(c.name)))
    .map((c) => c.name);
  $('labelFilterText').textContent = !n ? 'All labels'
    : n === 1 ? names[0]
    : `${n} labels selected`;
  $('labelFilterClear').disabled = n === 0;
}

// The menu: every label in use, with how many mods carry it. The count is the
// point - a filter that would leave you nothing is visible before it is used,
// which is the one thing a control this far from the list cannot otherwise tell
// you. The server has already ordered them most-used first.
function renderLabelMenu() {
  const d = modsPage.data;
  const counts = (d && d.labelCounts) || [];
  $('labelFilterList').innerHTML = counts.length
    ? counts.map((c) => {
      const on = modsPage.labels.has(labelKey(c.name));
      return `<label class="drop-item${on ? ' on' : ''}">
        <input type="checkbox" data-label-filter="${esc(c.name)}" ${on ? 'checked' : ''} />
        <span class="name">${esc(c.name)}</span><span class="n">${c.count}</span></label>`;
    }).join('')
    : '<p class="hint drop-empty">No labels yet. Click <b>+</b> on a mod to add one.</p>';

  // How many mods the current selection matches, so the menu says the same thing
  // the list is doing.
  const shown = visibleMods().length;
  const total = d.mods.filter(SRC_MATCH[modsPage.src]).length;
  $('labelFilterMeta').textContent = modsPage.labels.size
    ? `${shown} of ${total} mods shown`
    : `${total} mod${total === 1 ? '' : 's'}`;
}

function labelMenuIsOpen() {
  return !$('labelFilterMenu').hidden;
}

function setLabelMenu(open) {
  $('labelFilterMenu').hidden = !open;
  $('labelFilterBtn').setAttribute('aria-expanded', String(open));
  if (open) renderLabelMenu();
}

// ---- sorting ---------------------------------------------------------------

// Which keys are on offer right now, so the options are rebuilt only when that
// actually changes. renderMods runs on every keystroke in the name filter, and
// reassigning a <select>'s options while someone is reaching for it would close
// it under their cursor.
let sortSelectKeys = null;

function renderSortSelect() {
  const available = modsort.availableSorts(modsPage.data ? modsPage.data.mods : []);
  modsPage.sort = modsort.resolveSortKey(modsPage.sort, available);
  const sel = $('sortSelect');
  const keys = available.map((s) => s.key).join();
  if (keys !== sortSelectKeys) {
    sortSelectKeys = keys;
    sel.innerHTML = available
      .map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`)
      .join('');
  }
  if (sel.value !== modsPage.sort) sel.value = modsPage.sort;
  // The tooltip follows the active key, set on the control rather than on the
  // options: a native select draws its own popup, and no browser will show a
  // title on an option inside it. Set unconditionally rather than only when the
  // value changes, so a stored key that resolveSortKey quietly replaced still
  // gets the right description.
  const active = available.find((s) => s.key === modsPage.sort);
  sel.title = active ? `${active.label} — ${active.hint}` : 'How to order the mod list';
}

$('sortSelect').addEventListener('change', (e) => {
  modsPage.sort = e.target.value;
  // Persisted for next time, and failing to persist is no reason to refuse to sort
  // now - localStorage throws when storage is blocked, and the view preference
  // already lives with that.
  try { localStorage.setItem(SORT_KEY, modsPage.sort); } catch (_) { /* storage blocked */ }
  renderMods();
});

function renderMods() {
  const d = modsPage.data;
  // Nothing has loaded yet. The next line reads d.ok and the one after calls
  // byNorm(), so this is the only place that can be safe about it - and the bulk
  // buttons, which are enabled below, would otherwise be live against no list.
  if (!modsPage.data) {
    $('modsList').innerHTML = '';
    for (const b of ['enableShown', 'disableShown', 'applyMods', 'discardMods']) $(b).disabled = true;
    return;
  }
  const all = byNorm();

  const alerts = [];
  if (!d.ok) alerts.push(`<div class="alert warn"><b>Can't read which mods are enabled.</b> ${esc(d.error || '')}</div>`);
  if (game.running) alerts.push('<div class="alert warn"><b>Civ6 is running.</b> You can prepare changes, but close the game before applying them.</div>');
  // Labels are the user's own notes, not the game's state, so this never stops
  // the list working - it says what went wrong and carries on with no labels.
  if (d.labelsError) {
    alerts.push(`<div class="alert warn"><b>Problem with your labels.</b> ${esc(d.labelsError)} Showing no labels until it is fixed.</div>`);
  }
  // A broken overrides file means we are reading the default folders instead of
  // yours, so most of the library can look like it has simply vanished. Saying so
  // is the difference between "my mods are gone" and "your path overrides did
  // not load" - and the list keeps working either way.
  if (d.pathsError) {
    alerts.push(`<div class="alert warn"><b>Mod locations are not being read.</b> ${esc(d.pathsError)} Falling back to the usual folders, so mods kept elsewhere will not be listed.</div>`);
  }
  if (serverIsStale) {
    alerts.push('<div class="alert warn"><b>The toolkit needs restarting.</b> This page is newer than the program serving it, so the parts of it that need the server will fail — saving labels, for one. Close the toolkit and start it again.</div>');
  }
  // No button here on purpose: adding mods writes to the game's database, and
  // the mod manager's only write is Apply changes. Point at the dashboard
  // instead so there is one place that adds mods, not two.
  const addable = d.mods.filter((m) => m.needsSync);
  if (addable.length) {
    const one = addable.length === 1;
    const names = addable.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (addable.length > 4 ? ` and ${addable.length - 4} more` : '');
    alerts.push(`<div class="alert info"><b>${addable.length} mod${one ? '' : 's'} not added yet:</b> ${names}.
      Use <b>Rescan &amp; add new mods</b> on the dashboard to add ${one ? 'it' : 'them'}.
      ${game.running ? 'Close Civ6 first — it has to be shut down to change its database.' : ''}</div>`);
  }
  $('modsAlerts').innerHTML = alerts.join('');

  for (const b of document.querySelectorAll('#srcFilter button')) {
    b.classList.toggle('active', b.dataset.src === modsPage.src);
    b.querySelector('span').textContent = `(${d.mods.filter(SRC_MATCH[b.dataset.src]).length})`;
  }
  for (const b of document.querySelectorAll('#stateFilter button')) b.classList.toggle('active', b.dataset.state === modsPage.stateFilter);
  for (const b of document.querySelectorAll('#viewSwitch button')) b.classList.toggle('active', b.dataset.view === modsPage.view);

  const group = d.activeGroup ? groupLabel(d.activeGroup) : '';
  $('modsHint').textContent = (group ? `Editing mod group "${group}". ` : '') +
    'Changes are saved to the game when you click Apply, and take effect the next time you start Civ6.';

  renderSortSelect();
  renderLabelTrigger();
  if (labelMenuIsOpen()) renderLabelMenu();

  const panes = modsPage.view === 'panes';
  $('stateFilter').hidden = panes;
  $('enableShown').hidden = panes;
  $('disableShown').hidden = panes;
  // Disabled, not merely inert, while the list is empty because it has not loaded.
  // A button that can be pressed and does nothing is worse than one that cannot.
  const nothingYet = !d || !d.mods;
  $('enableShown').disabled = nothingYet;
  $('disableShown').disabled = nothingYet;
  $('modsList').hidden = panes;
  $('modsPanes').hidden = !panes;

  const shown = visibleMods();
  const inSrc = d.mods.filter(SRC_MATCH[modsPage.src]);
  $('modsCount').textContent = `(${inSrc.filter(isOn).length} of ${inSrc.length} enabled${shown.length !== inSrc.length ? `, ${shown.length} shown` : ''})`;

  if (panes) {
    const off = shown.filter((m) => !isOn(m));
    const on = shown.filter(isOn);
    $('paneOffCount').textContent = `(${off.length})`;
    $('paneOnCount').textContent = `(${on.length})`;
    $('paneOff').innerHTML = off.map((m) => paneRow(m, all, '→')).join('') || '<p class="hint">Nothing here.</p>';
    $('paneOn').innerHTML = on.map((m) => paneRow(m, all, '←')).join('') || '<p class="hint">Nothing here.</p>';
  } else {
    $('modsList').innerHTML = shown.map((m) => listRow(m, all)).join('') || '<p class="hint">No mods match.</p>';
  }

  updateModsBar();
}

function updateModsBar() {
  const all = byNorm();
  let on = 0, off = 0;
  for (const v of modsPage.pending.values()) (v ? on++ : off++);
  const problems = modsPage.data.mods.reduce((n, m) => n + problemsOf(m, all).length, 0);
  const parts = [];
  if (on || off) parts.push(`Pending: <b class="add">${on} to enable</b>, <b class="remove">${off} to disable</b>`);
  else parts.push('No changes');
  if (problems) parts.push(`<span class="warn">⚠ ${problems} warning${problems > 1 ? 's' : ''}</span>`);
  if ((on || off) && game.running) parts.push('<span class="warn">Close Civ6 to apply.</span>');
  $('modsPending').innerHTML = parts.join(' &nbsp;·&nbsp; ');
  $('applyMods').disabled = !(on || off) || game.running;
  $('discardMods').disabled = !(on || off);
}

// The page's files are read from disk on every request, so a browser reload
// picks up new code while the server process may still be running whatever it
// was started with. Nothing says so, and the first thing you meet is a bare
// "not found" from a route that exists - which reads as a broken feature rather
// than a server that wants restarting. A server that has never heard of /api/ping
// is by definition an old one, so the 404 is the answer.
let serverIsStale = false;
async function checkServerIsCurrent() {
  try {
    await postJson('/api/ping', {});
    serverIsStale = false;
  } catch (_) {
    serverIsStale = true;
  }
}

async function loadMods() {
  await checkServerIsCurrent();
  modsPage.data = await api('/api/mods');
  // Drop pending changes that the current state already satisfies.
  const all = byNorm();
  for (const [k, v] of modsPage.pending) {
    const m = all.get(k);
    if (!m || !canToggle(m) || (m.enabled === true) === v) modsPage.pending.delete(k);
  }
  setGameStatus(modsPage.data.game);
  renderMods();
}

// Adding mods is not done from here. The dashboard's "Rescan & add new mods"
// does it, and the server also does it at startup, so a newly subscribed mod
// shows up tickable without anyone clicking anything.

pages.mods = {
  show(params) {
    const src = params.get('source');
    if (src && SRC_MATCH[src]) modsPage.src = src;
    return loadMods();
  },
};

// ---- events ----------------------------------------------------------------

$('srcFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  modsPage.src = b.dataset.src;
  history.replaceState(null, '', `#/mods?source=${modsPage.src}`);
  renderMods();
});
$('stateFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  modsPage.stateFilter = b.dataset.state;
  renderMods();
});
$('viewSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  modsPage.view = b.dataset.view;
  try { localStorage.setItem('modsView', modsPage.view); } catch (_) { /* storage blocked */ }
  renderMods();
});
$('modsFilter').addEventListener('input', () => modsPage.data && renderMods());

// The dropdown's own listeners, kept away from rowButtonClick: it sits outside
// every row, so there is no row for a miss to fall through to.
$('labelFilterBtn').addEventListener('click', () => setLabelMenu(!labelMenuIsOpen()));
$('labelFilterClear').addEventListener('click', () => {
  modsPage.labels.clear();
  renderMods();
});
$('labelFilterList').addEventListener('change', (e) => {
  const box = e.target.closest('[data-label-filter]');
  if (box) toggleLabelFilter(box.dataset.labelFilter);
});
// A click anywhere else closes it, and so does Escape. Both are what a dropdown
// is expected to do, and without them the menu covers the mod list with no way
// out but the trigger again.
document.addEventListener('click', (e) => {
  if (!labelMenuIsOpen()) return;
  if (e.target.closest('#labelFilter')) return;
  setLabelMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && labelMenuIsOpen()) {
    setLabelMenu(false);
    $('labelFilterBtn').focus();
  }
});

// Buttons inside rows (both views): "Turn it on" fixes and details.
function rowButtonClick(e) {
  const b = e.target.closest('button');
  if (!b) return false;
  if (b.dataset.fix) {
    e.preventDefault(); // don't toggle the row's own checkbox
    setWanted(byNorm().get(b.dataset.fix), true);
    renderMods();
    return true;
  }
  // MUST return true. A button with a data-* attribute nobody claims returns
  // false, and paneClick() then treats the click as one on the row - which
  // toggles the mod. That is the exact bug the source-label link was fixed for,
  // reappearing in a new place.
  if (b.dataset.openFolder !== undefined) {
    e.preventDefault();
    e.stopPropagation();
    openModFolder(b.dataset.openFolder, b);
    return true;
  }
  if (b.dataset.info) {
    e.preventDefault();
    showDetails(b.dataset.info);
    return true;
  }
  // Same reason as the two above, and the same trap: in the list view the row is
  // a <label>, so a click the handler does not claim toggles this mod's
  // enable flag. That is exactly the bug the source-label link was fixed for.
  if (b.dataset.labels !== undefined) {
    e.preventDefault();
    e.stopPropagation();
    showLabelEditor(b.dataset.labels);
    return true;
  }
  // The load order view marks this mod's rows in context rather than filtering
  // to them: a list showing only this mod answers none of the question the
  // button was clicked to ask. Same reason for claiming the click - the row is a
  // <label>, so an unclaimed one toggles the mod.
  if (b.dataset.loadorder !== undefined) {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `#/load-order?mark=${encodeURIComponent(b.dataset.loadorder)}`;
    return true;
  }
  return false;
}

// Opening the folder is the server's job - a page cannot start Explorer itself.
// The id goes out; the folder comes back resolved from the database, never from
// anything the page chose.
async function openModFolder(idNorm, btn) {
  try {
    await postJson('/api/mods/open-folder', { ids: [idNorm] });
  } catch (err) {
    toast(esc(err.message), 'err');
    if (btn) btn.disabled = true;
  }
}

$('modsList').addEventListener('click', rowButtonClick);
$('modsList').addEventListener('change', (e) => {
  const k = e.target.dataset.mod;
  if (k === undefined) return;
  setWanted(byNorm().get(k), e.target.checked);
  renderMods();
});

function paneClick(e) {
  if (rowButtonClick(e) || e.target.closest('a')) return;
  const row = e.target.closest('[data-move]');
  if (!row) return;
  const m = byNorm().get(row.dataset.move);
  setWanted(m, !isOn(m));
  renderMods();
}
for (const id of ['paneOff', 'paneOn']) {
  $(id).addEventListener('click', paneClick);
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // The row itself is the switch, so Enter on a focused control inside it must
    // do that control's job, not the row's. This was already true by accident -
    // a button has no dataset.move - and is now true on purpose.
    if (e.target.closest('button, a')) return;
    if (!e.target.dataset.move) return;
    e.preventDefault();
    paneClick(e);
  });
}

function setShown(on) {
  // Reports what it did, in one shape, always. "Enable all shown" on a list of
  // rows that cannot be toggled changed nothing and said nothing, which reads as
  // a broken button; the first attempt at fixing that counted rows that merely
  // COULD change and reported "6 of 37 changed" when nothing changed. So: count
  // rows whose state actually flips, and show both numbers.
  const shown = visibleMods();
  const changeable = shown.filter(canToggle);
  for (const m of changeable) setWanted(m, on);
  const byId = new Map(shown.map((m) => [m.idNorm, m]));
  const flipped = [...modsPage.pending].filter(([id, want]) => (byId.get(id) || {}).enabled !== want).length;
  const skipped = shown.length - changeable.length;
  renderMods();

  if (!shown.length) return;

  const parts = [flipped
    ? `${n(flipped)} of ${n(changeable.length)} changed`
    : `${n(changeable.length)} already in that state`];
  if (skipped) parts.push(`${n(skipped)} not listed by the game in this profile`);
  toast(parts.join('; '), flipped ? undefined : 'err');
}

$('enableShown').addEventListener('click', () => setShown(true));
$('disableShown').addEventListener('click', () => setShown(false));
$('enableAllPane').addEventListener('click', () => setShown(true));
$('disableAllPane').addEventListener('click', () => setShown(false));

$('discardMods').addEventListener('click', () => { modsPage.pending.clear(); renderMods(); });

$('applyMods').addEventListener('click', async () => {
  const changes = [...modsPage.pending].map(([id, enabled]) => ({ id, enabled }));
  if (!changes.length) return;
  $('applyMods').disabled = true;
  $('discardMods').disabled = true;
  $('modsPending').textContent = 'Saving…';
  try {
    const r = await postJson('/api/mods/apply', { changes });
    modsPage.pending.clear();
    toast(`Saved: ${r.changed} mod${r.changed > 1 ? 's' : ''} changed.`, 'ok', `backup: ${esc(r.backupPath)}`);
  } catch (err) {
    toast(esc(err.message), 'err');
  }
  await loadMods().catch((err) => toast(esc(err.message), 'err'));
});

// Re-render only when the running state flips, so polling doesn't redraw the
// list under the user's cursor every few seconds.
let lastRunning = null;
document.addEventListener('gamestatus', () => {
  if (game.running === lastRunning) return;
  lastRunning = game.running;
  if (modsPage.data && document.body.dataset.page === 'mods') renderMods();
});

// ---- label editor ----------------------------------------------------------

// The mod being edited, and the labels it would end up with if saved. A working
// copy, so cancelling really cancels: the dialog never writes as you click.
const labelEdit = { idNorm: null, names: [] };

// One click toggles a label on or off. Comparison is without regard to case,
// the same rule the store applies, so a label the user typed as "Favourites"
// toggles the "favourite" the store resolved it to.
const hasLabel = (name) => labelEdit.names.some((n) => n.toLowerCase() === String(name).toLowerCase());

function toggleLabel(name) {
  if (hasLabel(name)) labelEdit.names = labelEdit.names.filter((n) => n.toLowerCase() !== String(name).toLowerCase());
  else labelEdit.names = [...labelEdit.names, name];
  renderLabelEditor();
}

function labelEditorHtml() {
  const m = byNorm().get(labelEdit.idNorm);
  const d = modsPage.data;
  const counts = new Map((d.labelCounts || []).map((c) => [c.name, c.count]));
  // A label this mod carries always appears in the global list, so the toggles
  // are simply every label in use - there is no second list to merge.
  const names = d.labelNames || [];
  const toggles = names.length
    ? names.map((n) => `<button type="button" class="chip label-toggle${hasLabel(n) ? ' on' : ''}" data-toggle="${esc(n)}">${
        esc(n)}${counts.has(n) ? `<span class="n">${counts.get(n)}</span>` : ''}</button>`).join('')
    : '<p class="hint">No labels yet. Type one below.</p>';

  return `<h2>Labels</h2>
    <p class="hint">${renderCivText(m ? m.name : '')} — a mod can carry as many labels as are useful, and each one is
      counted separately. Labels are the same whichever profile is in use.</p>
    <div class="label-toggles">${toggles}</div>
    <p class="label-picked">This mod would be
      <b>${labelEdit.names.length ? labelEdit.names.map(esc).join(', ') : 'unlabelled'}</b>.</p>
    <form class="label-new" id="labelNewForm">
      <input id="labelNew" type="text" maxlength="100" placeholder="New label…" autocomplete="off" spellcheck="false" />
      <button type="submit" class="secondary">Add</button>
    </form>
    <div class="label-actions">
      <button type="button" class="secondary" id="labelCancel">Cancel</button>
      <button type="button" id="labelSave">Save</button>
    </div>`;
}

function renderLabelEditor() {
  $('labelDialogBody').innerHTML = labelEditorHtml();
}

// A typed name joins the working copy without being saved, so adding three
// labels is still one write. The server is what resolves the spelling, so
// nothing canonicalises here and the store stays the only place that decides.
function addTypedLabel(value) {
  const name = String(value == null ? '' : value).trim();
  if (!name) return false;
  if (hasLabel(name)) return true; // already on it; nothing to add
  labelEdit.names = [...labelEdit.names, name];
  renderLabelEditor();
  return true;
}

function showLabelEditor(idNorm) {
  const m = byNorm().get(idNorm);
  if (!m) return;
  labelEdit.idNorm = idNorm;
  labelEdit.names = (m.labels || []).slice();
  renderLabelEditor();
  const dlg = $('labelDialog');
  if (!dlg.open) dlg.showModal();
}

async function saveLabels() {
  const idNorm = labelEdit.idNorm;
  $('labelSave').disabled = true;
  try {
    const r = await postJson('/api/mods/labels', { id: idNorm, labels: labelEdit.names });
    // The server sends the refreshed label state, so the rows, the counts and
    // the editor's own list all come from what is really on disk rather than
    // from what was asked for - one write, one truth, no refetch.
    Object.assign(modsPage.data, {
      labels: r.labels, labelCounts: r.labelCounts, labelNames: r.labelNames, labelsError: r.labelsError,
    });
    // The map the server sends is the same key the rows carry, so the rows are
    // re-pointed at it. Assigning only data.labels leaves every mod holding the
    // array it was built with, and the edit appears to have done nothing.
    for (const m of modsPage.data.mods) m.labels = r.labels[m.idNorm] || [];
    setGameStatus(r.game);
    $('labelDialog').close();
    renderMods();
    if ($('labelDialog').open) renderLabelEditor();
  } catch (err) {
    // A bare "not found" here is the server's catch-all, not this route's
    // "mod not found", so it means the route does not exist on the process
    // answering - a toolkit that is older than this page.
    toast(serverIsStale || err.message === 'not found'
      ? 'The toolkit server is out of date. Close the toolkit and start it again.'
      : esc(err.message), 'err');
    $('labelSave').disabled = false;
  }
}

$('labelDialogBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) { toggleLabel(t.dataset.toggle); return; }
  if (e.target.closest('#labelCancel')) { $('labelDialog').close(); return; }
  if (e.target.closest('#labelSave')) saveLabels();
});
$('labelDialogBody').addEventListener('submit', (e) => {
  if (e.target.id !== 'labelNewForm') return;
  e.preventDefault();
  const input = $('labelNew');
  if (addTypedLabel(input.value)) { input.value = ''; input.focus(); }
});
$('labelDialogClose').addEventListener('click', () => $('labelDialog').close());
$('labelDialog').addEventListener('click', (e) => { if (e.target === $('labelDialog')) $('labelDialog').close(); });

// ---- manage labels ---------------------------------------------------------

// Rename and delete reach every mod carrying the label, so both report how many
// mods changed - "deleted" on its own says nothing about what moved. Delete asks
// first and names the count. Rename does not ask, because a rename is reversible
// by renaming back and a delete is not.
function renderLabelManage() {
  const counts = (modsPage.data && modsPage.data.labelCounts) || [];
  $('labelManageBody').innerHTML = `<h2>Labels</h2>
    <p class="hint">Your own labels, the same in every profile. Renaming or deleting one changes it
      on every mod that has it — the mods themselves are never touched.</p>
    ${counts.length
      ? `<div class="list">${counts.map((c) => `<div class="row">
          <span class="name"><b>${esc(c.name)}</b><small>${c.count} mod${c.count === 1 ? '' : 's'}</small></span>
          <button type="button" class="secondary small" data-rename-label="${esc(c.name)}">Rename</button>
          <button type="button" class="danger small" data-delete-label="${esc(c.name)}">Delete</button>
        </div>`).join('')}</div>`
      : '<p class="hint">No labels yet. Click <b>+</b> on a mod to add one.</p>'}`;
}

function openLabelManage() {
  renderLabelManage();
  if (!$('labelManageDialog').open) $('labelManageDialog').showModal();
}

// A write that changes the label set as a whole rather than one mod's share of
// it. The response carries the refreshed state, so the rows, the filter menu and
// the manage dialog all come from what is really on disk rather than from what
// was asked for.
async function labelAction(path, body, busyBtn) {
  if (busyBtn) busyBtn.disabled = true;
  try {
    const r = await postJson(path, body);
    Object.assign(modsPage.data, {
      labels: r.labels, labelCounts: r.labelCounts, labelNames: r.labelNames, labelsError: r.labelsError,
    });
    for (const m of modsPage.data.mods) m.labels = r.labels[m.idNorm] || [];
    setGameStatus(r.game);
    // A label that has just been renamed or deleted must leave the filter
    // selection too, or the list would narrow to nothing with no visible reason.
    const live = new Set((r.labelNames || []).map(labelKey));
    for (const k of [...modsPage.labels]) if (!live.has(k)) modsPage.labels.delete(k);
    return r;
  } catch (err) {
    toast(esc(err.message), 'err');
    return null;
  } finally {
    if (busyBtn) busyBtn.disabled = false;
  }
}

$('labelManage').addEventListener('click', openLabelManage);
$('labelManageClose').addEventListener('click', () => $('labelManageDialog').close());
$('labelManageDialog').addEventListener('click', (e) => { if (e.target === $('labelManageDialog')) $('labelManageDialog').close(); });

$('labelManageBody').addEventListener('click', async (e) => {
  const rename = e.target.closest('[data-rename-label]');
  if (rename) {
    const from = rename.dataset.renameLabel;
    const to = prompt(`New name for "${from}". It will change on every mod that has it.`, from);
    if (to == null) return; // cancelled
    if (!to.trim()) { toast('A label needs a name.', 'err'); return; }
    const r = await labelAction('/api/mods/labels/rename', { from, to: to.trim() }, rename);
    if (!r) return;
    // A merge is reported rather than left to be noticed: two labels the user
    // believed were separate are now one.
    toast(r.merged
      ? `Merged into "${esc(to.trim())}" — ${r.moved} mod${r.moved === 1 ? '' : 's'} changed.`
      : `Renamed to "${esc(to.trim())}" — ${r.moved} mod${r.moved === 1 ? '' : 's'} changed.`, 'ok');
    renderLabelManage();
    renderMods();
    return;
  }

  const del = e.target.closest('[data-delete-label]');
  if (del) {
    const name = del.dataset.deleteLabel;
    const n = ((modsPage.data.labelCounts || []).find((c) => c.name === name) || {}).count || 0;
    if (!confirm(`Delete the label "${name}"?\n\nIt will be taken off ${n} mod${n === 1 ? '' : 's'}. The mods themselves are not touched.`)) return;
    const r = await labelAction('/api/mods/labels/delete', { name }, del);
    if (!r) return;
    toast(`Deleted "${esc(name)}" from ${r.removed} mod${r.removed === 1 ? '' : 's'}.`, 'ok');
    renderLabelManage();
    renderMods();
  }
});

// ---- details dialog --------------------------------------------------------

// What a mod changes, from its component / setting types.
const CHANGE_KINDS = [
  ['Gameplay', ['UpdateDatabase', 'AddGameplayScripts', 'GameplayScripts']],
  ['User interface', ['ReplaceUIScript', 'AddUserInterfaces']],
  ['Art & icons', ['UpdateArt', 'ModArt', 'UpdateIcons', 'UpdateColors', 'Icons']],
  ['Text', ['UpdateText', 'LocalizedText']],
  ['Audio', ['UpdateAudio']],
];
const SETTING_KINDS = [
  ['Game setup options', ['UpdateDatabase', 'Custom']],
  ['Maps', ['AddMap', 'Map', 'WorldBuilder']],
];

function kindsOf(counts, table) {
  return table.filter(([, types]) => types.some((t) => counts && counts[t])).map(([label]) => label);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Accepts unix seconds (modinfo "Created"), milliseconds, or a date string.
function fmtDate(v) {
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e11 ? n * 1000 : n) : new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Descriptions keep their line breaks ([NEWLINE] or real newlines).
function renderDescription(s) {
  return String(s).split(/\[NEWLINE\]|\r?\n/i).map(renderCivText).join('<br>');
}

function relList(items) {
  return `<ul class="rel">${items.map((r) => {
    const state = r.missing ? '<span class="state-off">not installed</span>'
      : r.enabled === true ? '<span class="state-on">on</span>'
      : r.enabled === false ? '<span class="state-off">off</span>' : '';
    return `<li>${renderCivText(r.name)}${state ? ` — ${state}` : ''}</li>`;
  }).join('')}</ul>`;
}

function detailsHtml(x) {
  const m = x.mod;
  const p = (x.db && x.db.properties) || {};
  const all = byNorm();
  const facts = [];
  const fact = (k, v) => { if (v != null && v !== '') facts.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`); };

  fact('Authors', p.Authors ? renderCivText(p.Authors) : (m.source === 'dlc' ? 'Firaxis Games' : null));
  fact('Special thanks', p.SpecialThanks && renderCivText(p.SpecialThanks));
  fact('Version', x.db && x.db.version != null ? esc(x.db.version) : null);
  fact('Created', p.Created && esc(fmtDate(p.Created)));
  if (p.AffectsSavedGames != null) {
    fact('Affects saved games', p.AffectsSavedGames === '0' ? 'No — can be turned on or off for an existing game' : 'Yes');
  }
  const modes = [['SupportsSinglePlayer', 'single player'], ['SupportsMultiplayer', 'multiplayer'], ['SupportsHotSeat', 'hot seat']]
    .filter(([k]) => p[k] != null).map(([k, label]) => `${label}: ${p[k] === '0' ? 'no' : 'yes'}`);
  fact('Modes', modes.length ? esc(modes.join(', ')) : null);
  fact('Stability', p.Stability && esc(p.Stability));
  fact('Game versions', p.CompatibleVersions && esc(p.CompatibleVersions.split(',').map((v) => v.trim()).join(', ')));

  const changes = [...kindsOf(x.db && x.db.components, CHANGE_KINDS), ...kindsOf(x.db && x.db.settings, SETTING_KINDS)];

  // Relationship states reflect pending changes, like the rows do.
  const needs = m.requires.map((r) => {
    const dep = all.get(r.id);
    return dep ? { name: dep.name, enabled: isOn(dep) } : { name: r.title, missing: true };
  });
  // Incompatible either way round; ones you don't have are listed as not installed.
  const titles = new Map([...m.blocks.map((b) => [b.id, b.title]), ...x.blockedBy.map((b) => [b.id, b.name])]);
  const conflicts = [...titles].map(([id, title]) => {
    const o = all.get(id);
    return o ? { name: o.name, enabled: isOn(o) } : { name: title, missing: true };
  }).sort((a, b) => (a.missing === b.missing ? 0 : a.missing ? 1 : -1));
  const requiredBy = x.requiredBy.map((r) => { const o = all.get(r.id); return { name: r.name, enabled: o ? isOn(o) : r.enabled }; })
    .sort((a, b) => (b.enabled === true) - (a.enabled === true)); // enabled ones first

  const files = [];
  if (x.disk) {
    files.push(`<dt>Folder</dt><dd><code>${esc(x.disk.folder)}</code></dd>`);
    files.push(`<dt>Size</dt><dd>${esc(fmtBytes(x.disk.bytes))} in ${x.disk.files} file${x.disk.files === 1 ? '' : 's'}</dd>`);
    if (x.disk.modified) files.push(`<dt>Last changed</dt><dd>${esc(fmtDate(x.disk.modified))}</dd>`);
  } else if (x.db) {
    files.push(`<dt>Files</dt><dd>${x.db.fileCount} (official content, in the game's install folder)</dd>`);
  }
  if (m.workshopId) {
    files.push(`<dt>Steam Workshop</dt><dd><a href="${workshopUrl(m.workshopId)}" target="_blank" rel="noopener">Open Workshop page ↗</a> <small>(${esc(m.workshopId)})</small></dd>`);
  }
  files.push(`<dt>Mod ID</dt><dd><code>${esc(m.id)}</code></dd>`);

  // A .tag like the source label beside it, not a .chip. This row is a tag row,
  // and the two had different font sizes - 11px against 12px - so their text sat
  // on different baselines. .tag keeps its own quiet metrics; .tag.good and
  // .tag.bad carry the state colour, so "disabled" still reads as a state.
  const stateTag = m.needsSync
    ? '<span class="tag unscanned" title="Use “Rescan &amp; add new mods” on the dashboard">not added yet</span>'
    : m.enabled == null ? '<span class="tag" title="The game doesn&#39;t list this in the active mod group (for example DLC you don&#39;t own)">not available</span>'
    : isOn(m) ? '<span class="tag good">enabled</span>' : '<span class="tag bad">disabled</span>';

  // Remove lives here rather than on the row: it deletes files, so it should be
  // one deliberate control per mod, not 380 identical ones down a list.
  const remove = (m.source === 'workshop' || m.source === 'local')
    ? `<h3>Remove</h3>
       <p class="hint">Takes this mod out of the game and out of every profile${x.disk ? ', and deletes its folder from disk' : ''}.
       ${m.workshopId ? 'Steam is not unsubscribed for you — use the Workshop page above to take it out of your library too.' : ''}</p>
       <p><button type="button" class="danger" data-remove="${esc(m.idNorm)}" ${game.running ? 'disabled' : ''}
         title="${game.running ? 'Close Civ6 to remove mods' : 'Remove this mod, and delete its folder'}">Remove mod</button>
         ${game.running ? '<small>Close Civ6 to remove mods.</small>' : ''}</p>`
    : '';

  return `
    <h2>${renderCivText(m.name)}</h2>
    <div class="tags"><span class="tag ${esc(m.source)}">${m.source === 'dlc' ? 'Official DLC' : esc(m.source)}</span>${stateTag}
      ${modsPage.pending.has(m.idNorm) ? '<span class="tag">pending change</span>' : ''}</div>
    ${m.teaser ? `<p><b>${renderCivText(m.teaser)}</b></p>` : ''}
    ${p.Description ? `<p class="desc">${renderDescription(p.Description)}</p>` : (m.teaser ? '' : '<p class="hint">No description.</p>')}
    ${facts.length ? `<h3>About</h3><dl class="facts">${facts.join('')}</dl>` : ''}
    ${changes.length ? `<h3>What it changes</h3><div class="chips">${changes.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${needs.length ? `<h3>Needs</h3>${relList(needs)}` : ''}
    ${requiredBy.length ? `<h3>Needed by</h3>${relList(requiredBy)}` : ''}
    ${conflicts.length ? `<h3>Incompatible with</h3>${relList(conflicts)}` : ''}
    <h3>In your configurations</h3>
    ${x.inConfigs.length ? `<ul class="rel">${x.inConfigs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="hint">Not used in any .Civ6Cfg file.</p>'}
    <h3>Files</h3><dl class="facts">${files.join('')}</dl>
    ${remove}`;
}

async function showDetails(idNorm) {
  const dlg = $('modDialog');
  const m = byNorm().get(idNorm);
  $('modDialogBody').innerHTML = `<h2>${renderCivText(m ? m.name : '')}</h2><p class="hint">Loading…</p>`;
  if (!dlg.open) dlg.showModal();
  try {
    const x = await api('/api/mods/details?id=' + encodeURIComponent(idNorm));
    $('modDialogBody').innerHTML = detailsHtml(x);
  } catch (err) {
    $('modDialogBody').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

$('modDialogClose').addEventListener('click', () => $('modDialog').close());
// A click on the backdrop (outside the dialog box) closes it.
$('modDialog').addEventListener('click', (e) => { if (e.target === $('modDialog')) $('modDialog').close(); });

// Deleting a mod's folder cannot be undone from here, so it asks first and says
// exactly which folder. The database is backed up, but the files are not.
$('modDialogBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const idNorm = btn.dataset.remove;
  const m = byNorm().get(idNorm);
  if (!m) return;
  const folder = (await api('/api/mods/details?id=' + encodeURIComponent(idNorm)).catch(() => null))?.disk?.folder;

  const what = [
    `Remove **${stripCivText(m.name)}** from the game and from every profile?`,
    folder ? `Its folder will be deleted:\n\n<code>${esc(folder)}</code>` : 'Its folder is already gone.',
    'This cannot be undone.',
  ].join('\n\n');
  if (!confirm(what)) return;

  btn.disabled = true;
  try {
    const r = await postJson('/api/mods/remove', { ids: [idNorm] });
    const n = r.removed.length;
    const bits = [`Removed ${n} mod${n === 1 ? '' : 's'}.`];
    if (r.backupPath) bits.push(`backup: ${r.backupPath}`);
    toast(bits.join('  ·  '), 'ok');
    // A folder that would not go is worth saying out loud: the game will find
    // it again on its next scan and put the mod back.
    for (const k of r.kept || []) toast(`Could not delete ${renderCivText(k.name || k.modId)}: ${k.error}`, 'err');
    for (const x of r.refused || []) toast(`Not removed: ${renderCivText(x.name || x.modId)} — ${x.reason}`, 'err');
    $('modDialog').close();
    await loadMods();
  } catch (err) {
    toast(esc(err.message), 'err');
    btn.disabled = false;
  }
});
