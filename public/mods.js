'use strict';

// Mod manager page: turn mods on/off in the game's mod database.

const modsPage = {
  data: null,          // /api/mods response
  pending: new Map(),  // idNorm -> desired enabled (only real changes)
  src: 'mods',         // mods | workshop | local | dlc
  stateFilter: 'all',  // all | on | off
};

const SRC_MATCH = {
  mods: (m) => m.source === 'workshop' || m.source === 'local',
  workshop: (m) => m.source === 'workshop',
  local: (m) => m.source === 'local',
  dlc: (m) => m.source === 'dlc',
};

function byNorm() {
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
function problemsOf(m, all) {
  if (!isOn(m)) return [];
  const out = [];
  for (const r of m.requires) {
    const dep = all.get(r.id);
    if (!dep) out.push({ text: `Needs ${r.title}, which isn't installed` });
    else if (!isOn(dep)) out.push({ text: `Needs ${dep.name}, which is turned off`, fix: canToggle(dep) ? dep.idNorm : null });
  }
  for (const b of m.blocks) {
    const other = all.get(b.id);
    if (other && isOn(other)) out.push({ text: `Conflicts with ${other.name}` });
  }
  return out;
}

function visibleMods() {
  const q = $('modsFilter').value.trim().toLowerCase();
  return modsPage.data.mods.filter((m) => SRC_MATCH[modsPage.src](m)
    && (modsPage.stateFilter === 'all' || (modsPage.stateFilter === 'on') === isOn(m))
    && (!q || m.name.toLowerCase().includes(q) || m.idNorm.includes(q)));
}

function renderMods() {
  const d = modsPage.data;
  const all = byNorm();

  const alerts = [];
  if (!d.ok) alerts.push(`<div class="alert warn"><b>Can't read which mods are enabled.</b> ${esc(d.error || '')}</div>`);
  if (game.running) alerts.push('<div class="alert warn"><b>Civ6 is running.</b> You can prepare changes, but close the game before applying them.</div>');
  const unscanned = d.mods.filter((m) => !m.scanned);
  if (unscanned.length) {
    alerts.push(`<div class="alert info"><b>${unscanned.length} new mod${unscanned.length > 1 ? 's' : ''} not yet seen by the game.</b>
      Start Civ6 once so it picks ${unscanned.length > 1 ? 'them' : 'it'} up, then ${unscanned.length > 1 ? 'they' : 'it'} can be turned on or off here.</div>`);
  }
  $('modsAlerts').innerHTML = alerts.join('');

  for (const b of document.querySelectorAll('#srcFilter button')) {
    b.classList.toggle('active', b.dataset.src === modsPage.src);
    b.querySelector('span').textContent = `(${d.mods.filter(SRC_MATCH[b.dataset.src]).length})`;
  }
  for (const b of document.querySelectorAll('#stateFilter button')) b.classList.toggle('active', b.dataset.state === modsPage.stateFilter);

  const group = d.activeGroup ? groupLabel(d.activeGroup) : '';
  $('modsHint').textContent = (group ? `Editing mod group "${group}". ` : '') +
    'Changes are saved to the game when you click Apply, and take effect the next time you start Civ6.';

  const shown = visibleMods();
  const inSrc = d.mods.filter(SRC_MATCH[modsPage.src]);
  $('modsCount').textContent = `(${inSrc.filter(isOn).length} of ${inSrc.length} enabled${shown.length !== inSrc.length ? `, ${shown.length} shown` : ''})`;

  $('modsList').innerHTML = shown.map((m) => {
    const on = isOn(m);
    const changed = modsPage.pending.has(m.idNorm);
    const cls = ['row', changed ? (on ? 'pending-add' : 'pending-remove') : '', canToggle(m) ? '' : 'readonly'].join(' ');
    const probs = problemsOf(m, all).map((p) => `<span class="warn-line">⚠ ${renderCivText(p.text)}${p.fix ? `<button type="button" data-fix="${esc(p.fix)}">Turn it on</button>` : ''}</span>`).join('');
    const tag = !m.scanned ? '<span class="tag unscanned">not scanned yet</span>'
      : m.enabled == null ? '<span class="tag" title="The game doesn&#39;t list this in the active mod group (for example DLC you don&#39;t own)">not available</span>'
      : `<span class="tag ${esc(m.source)}">${m.source === 'dlc' ? 'DLC' : esc(m.source)}</span>`;
    const link = m.workshopId ? `<a class="ext" href="https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(m.workshopId)}" target="_blank" rel="noopener" title="Open the Steam Workshop page"><span class="ext-text">Workshop page </span>↗</a>` : '';
    return `<label class="${cls.trim()}">
      <input type="checkbox" data-mod="${esc(m.idNorm)}" ${on ? 'checked' : ''} ${canToggle(m) ? '' : 'disabled'} />
      <span class="name"><b>${renderCivText(m.name)}</b><small>${esc(m.id)}</small>${probs}</span>
      ${link}${tag}
    </label>`;
  }).join('') || '<p class="hint">No mods match.</p>';

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

async function loadMods() {
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
$('modsFilter').addEventListener('input', () => modsPage.data && renderMods());

$('modsList').addEventListener('change', (e) => {
  const k = e.target.dataset.mod;
  if (k === undefined) return;
  setWanted(byNorm().get(k), e.target.checked);
  renderMods();
});
$('modsList').addEventListener('click', (e) => {
  const k = e.target.dataset && e.target.dataset.fix;
  if (!k) return;
  e.preventDefault(); // don't toggle the row's own checkbox
  setWanted(byNorm().get(k), true);
  renderMods();
});

function setShown(on) {
  for (const m of visibleMods()) setWanted(m, on);
  renderMods();
}
$('enableShown').addEventListener('click', () => setShown(true));
$('disableShown').addEventListener('click', () => setShown(false));

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
