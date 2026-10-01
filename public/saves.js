'use strict';

// Save editor page: remove mods from a .Civ6Save.

const savePage = {
  stale: true,
  savePath: null,
  view: null,
  removeSet: new Set(), // idNorm
  showOfficial: false,
};
const sv = savePage;

const KIND = {
  ui: { label: 'UI / no gameplay', hint: 'Not part of the saved game state: safe to remove.' },
  gameplay: { label: 'changes gameplay', hint: 'Adds or changes game content. Its data may be baked into the save, so the game might not load it without the mod.' },
  unknown: { label: 'not installed', hint: "Not installed here, so we can't tell what it does. Treat it like a gameplay mod." },
  official: { label: 'official', hint: 'Official game content. Can\'t be removed.' },
};

async function loadSaveList() {
  const s = await api('/api/saves');
  sv.stale = false;
  const sel = $('saveSelect');
  if (!s.saves.length) {
    sel.innerHTML = '<option value="">No .Civ6Save files found</option>';
    $('saveMeta').textContent = s.savesExists ? '' : 'Saves folder not found — set it on the Dashboard.';
    return;
  }
  sel.innerHTML = '<option value="">Choose a save…</option>' + s.saves.map((x) => {
    const when = new Date(x.modified).toLocaleDateString();
    return `<option value="${esc(x.path)}">${esc((x.folder ? x.folder + ' / ' : '') + x.name)} — ${when}</option>`;
  }).join('');
  if (sv.savePath && [...sel.options].some((o) => o.value === sv.savePath)) sel.value = sv.savePath;
  else if (sv.savePath) await loadSave('');
}

pages.saves = {
  async show() {
    if (!sv.stale) return;
    await loadSaveList();
  },
};

async function loadSave(p) {
  sv.savePath = p || null;
  sv.removeSet.clear();
  if (!p) { $('saveEditor').hidden = true; $('saveBar').hidden = true; return; }
  sv.view = await api('/api/save-mods?path=' + encodeURIComponent(p));
  renderSave();
  $('saveEditor').hidden = false; $('saveBar').hidden = false;
}

function renderSave() {
  const v = sv.view;
  const shown = v.mods.filter((m) => sv.showOfficial || m.kind !== 'official');
  const hiddenN = v.mods.length - shown.length;
  $('saveCount').textContent = hiddenN ? `(${shown.length} of ${v.mods.length}, ${hiddenN} official hidden)` : `(${v.mods.length})`;
  $('saveMeta').textContent = v.editable ? '' : "This save can't be edited safely.";
  $('saveLegend').innerHTML = Object.entries(KIND).filter(([k]) => k !== 'official')
    .map(([k, d]) => `<span class="tag ${k}">${esc(d.label)}</span> ${esc(d.hint)}`).join('<br>');
  $('saveList').innerHTML = shown.map((m) => {
    const removable = m.kind !== 'official' && v.editable;
    const rm = sv.removeSet.has(m.idNorm);
    const cls = rm ? 'row pending-remove' : (removable ? 'row' : 'row readonly');
    const d = KIND[m.kind];
    return `<label class="${cls}" title="${esc(d.hint)}">
      <input type="checkbox" data-sv="${esc(m.idNorm)}" ${removable ? '' : 'disabled'} ${rm ? '' : 'checked'} />
      <span class="name"><b>${renderCivText(m.name)}</b><small>${esc(m.id)}</small></span>
      <span class="tag ${m.kind}">${esc(d.label)}</span>
    </label>`;
  }).join('') || '<p class="hint">No mods to show.</p>';
  updateSaveBar();
}

function updateSaveBar() {
  const n = sv.removeSet.size;
  const risky = sv.view && sv.view.mods.filter((m) => sv.removeSet.has(m.idNorm) && m.kind !== 'ui').length;
  $('savePending').innerHTML = n
    ? `Pending: <b class="remove">−${n}</b> to remove` + (risky ? ` <span class="tag gameplay">${risky} may affect the saved game</span>` : '')
    : 'Uncheck a mod to remove it from the save';
  $('saveAsNew').disabled = !n;
  $('saveOver').disabled = !n;
}

$('saveSelect').addEventListener('change', (e) => loadSave(e.target.value).catch((err) => toast(err.message, 'err')));
$('showOfficial').addEventListener('change', (e) => { sv.showOfficial = e.target.checked; if (sv.view) renderSave(); });
$('page-saves').addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset || el.dataset.sv === undefined) return;
  if (!el.checked) sv.removeSet.add(el.dataset.sv); else sv.removeSet.delete(el.dataset.sv);
  el.closest('.row').classList.toggle('pending-remove', !el.checked);
  updateSaveBar();
});

async function doSaveEdit(mode) {
  const risky = sv.view.mods.filter((m) => sv.removeSet.has(m.idNorm) && m.kind !== 'ui');
  if (risky.length && !confirm(
    `These mods may be part of the saved game itself:\n\n  ${risky.map((m) => m.name.replace(/\[[^\]]*\]/g, '')).join('\n  ')}\n\n` +
    'The game may fail to load the result, or load it with missing content. Continue?')) return;
  const payload = { path: sv.savePath, remove: sv.view.mods.filter((m) => sv.removeSet.has(m.idNorm)).map((m) => m.id), mode };
  if (mode === 'new') {
    const cur = sv.view.name.replace(/\.Civ6Save$/i, '');
    const name = prompt('Save as new file name:', `${cur} (edited)`);
    if (!name) return;
    payload.newName = name;
  } else if (!confirm('Overwrite this save? A timestamped backup is kept next to it.')) return;
  try {
    const r = await postJson('/api/save-edit', payload);
    toast(mode === 'new' ? 'Saved new copy.' : 'Saved (backup created).', 'ok',
      [`mods ${r.modsBefore} → ${r.modsAfter}`, r.backupPath ? `backup: ${r.backupPath}` : null, `saved: ${r.outPath}`].filter(Boolean).join('  ·  '));
    await loadSaveList();
    await loadSave(mode === 'new' ? r.outPath : sv.savePath);
    $('saveSelect').value = sv.savePath;
  } catch (err) { toast(err.message, 'err'); }
}

$('saveAsNew').addEventListener('click', () => doSaveEdit('new'));
$('saveOver').addEventListener('click', () => doSaveEdit('overwrite'));
