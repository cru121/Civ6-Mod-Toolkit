'use strict';

// Config editor page: add/remove mods in an existing .Civ6Cfg.

const configPage = {
  stale: true,         // reload the config list next time the page is shown
  configPath: null,
  view: null,          // { enabled:[], availableToAdd:[] }
  addSet: new Set(),   // idNorm to add
  removeSet: new Set(),// idNorm to remove
  showDlc: false,      // whether to list official DLC / not-installed entries
};
const state = configPage;

// ---- load overall state ----------------------------------------------------

async function loadState() {
  const s = await api('/api/state');
  state.stale = false;

  const sel = $('configSelect');
  if (!s.configs.length) {
    sel.innerHTML = '<option value="">No .Civ6Cfg files found in configurations folder</option>';
    $('configMeta').textContent = s.savesExists ? '' : 'Configurations folder not found — set it on the Dashboard.';
  } else {
    sel.innerHTML = '<option value="">Choose a config…</option>' +
      s.configs.map((c) => `<option value="${esc(c.path)}">${esc(c.name)}${c.mods != null ? ` — ${c.mods} mods` : ''}</option>`).join('');
    $('configMeta').textContent = '';
  }
  // keep current selection if still present
  if (state.configPath && [...sel.options].some((o) => o.value === state.configPath)) {
    sel.value = state.configPath;
  } else if (state.configPath) {
    await loadConfig('');
  }
}

pages.config = {
  async show() {
    if (!state.stale) return;
    const hasPending = state.addSet.size || state.removeSet.size;
    await loadState();
    // Folders may have changed: refresh the open config unless edits are pending.
    if (state.configPath && !hasPending) await loadConfig(state.configPath);
  },
};

// ---- load one config -------------------------------------------------------

async function loadConfig(p) {
  state.configPath = p || null;
  state.addSet.clear();
  state.removeSet.clear();
  if (!p) {
    $('editor').hidden = true; $('bar').hidden = true;
    $('deleteConfig').disabled = true;
    return;
  }
  const v = await api('/api/config?path=' + encodeURIComponent(p));
  state.view = v;
  render();
  $('editor').hidden = false; $('bar').hidden = false;
  $('deleteConfig').disabled = false;
}

function render() {
  const v = state.view;
  const enabled = v.enabled;
  const avail = v.availableToAdd;

  // Enabled column (optionally hide official DLC / not-installed entries)
  const enabledShown = state.showDlc ? enabled : enabled.filter((m) => m.installed);
  const hidden = enabled.length - enabledShown.length;
  $('enabledCount').textContent = hidden ? `(${enabledShown.length} of ${enabled.length}, ${hidden} DLC hidden)` : `(${enabled.length})`;
  $('enabledList').innerHTML = enabledShown.map((m) => {
    const removable = m.installed;
    const pendingRemove = state.removeSet.has(m.idNorm);
    const cls = pendingRemove ? 'row pending-remove' : (removable ? 'row' : 'row readonly');
    const tag = m.installed ? m.type : 'dlc';
    const tagLabel = m.installed ? m.type : 'DLC / not installed';
    return `<label class="${cls}">
      <input type="checkbox" data-remove="${esc(m.idNorm)}" ${removable ? '' : 'disabled'} ${pendingRemove ? '' : 'checked'} />
      <span class="name"><b>${renderCivText(m.name || m.title || m.id)}</b><small>${esc(m.id)}</small></span>
      <span class="tag ${tag}">${esc(tagLabel)}</span>
    </label>`;
  }).join('') || '<p class="hint">No mods to show.</p>';

  // Available column
  const filter = $('availFilter').value.toLowerCase();
  const shown = avail.filter((m) => !filter || m.name.toLowerCase().includes(filter) || m.idNorm.includes(filter));
  $('availCount').textContent = `(${avail.length})`;
  $('availList').innerHTML = shown.map((m) => {
    const pendingAdd = state.addSet.has(m.idNorm);
    return `<label class="row ${pendingAdd ? 'pending-add' : ''}">
      <input type="checkbox" data-add="${esc(m.idNorm)}" ${pendingAdd ? 'checked' : ''} />
      <span class="name"><b>${renderCivText(m.name)}</b><small>${esc(m.id)}</small></span>
      <span class="tag ${esc(m.type)}">${esc(m.type)}</span>
    </label>`;
  }).join('') || '<p class="hint">Nothing to add — every installed mod is already enabled.</p>';

  updateBar();
}

function updateBar() {
  const a = state.addSet.size, r = state.removeSet.size;
  $('pending').innerHTML = (a || r)
    ? `Pending: <b class="add">+${a}</b> to add, <b class="remove">−${r}</b> to remove`
    : 'No changes';
  $('saveOverwrite').disabled = !(a || r);
  $('saveNew').disabled = !(a || r);
}

// ---- events ----------------------------------------------------------------

$('configSelect').addEventListener('change', (e) => loadConfig(e.target.value).catch((err) => toast(err.message, 'err')));
$('availFilter').addEventListener('input', render);
$('showDlc').addEventListener('change', (e) => { state.showDlc = e.target.checked; if (state.view) render(); });

$('page-config').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.add !== undefined) {
    const k = el.dataset.add;
    if (el.checked) state.addSet.add(k); else state.addSet.delete(k);
    // toggle row style without full re-render (keeps filter/scroll)
    el.closest('.row').classList.toggle('pending-add', el.checked);
    updateBar();
  } else if (el.dataset && el.dataset.remove !== undefined) {
    const k = el.dataset.remove;
    if (!el.checked) state.removeSet.add(k); else state.removeSet.delete(k);
    el.closest('.row').classList.toggle('pending-remove', !el.checked);
    updateBar();
  }
});

async function doSave(mode) {
  const payload = {
    path: state.configPath,
    add: [...state.addSet],
    remove: [...state.removeSet],
    mode,
  };
  if (mode === 'new') {
    const cur = state.view.name.replace(/\.Civ6Cfg$/i, '');
    const name = prompt('Save as new file name:', `${cur} (edited)`);
    if (!name) return;
    payload.newName = name;
  }
  try {
    const { summary } = await postJson('/api/save', payload);
    const detail = [
      `mods ${summary.modsBefore} → ${summary.modsAfter}`,
      summary.backupPath ? `backup: ${summary.backupPath}` : null,
      `saved: ${summary.outPath}`,
    ].filter(Boolean).join('  ·  ');
    toast(mode === 'new' ? 'Saved new config.' : 'Saved (backup created).', 'ok', detail);
    await loadState();
    // reload the file we actually wrote so the view reflects reality
    await loadConfig(mode === 'new' ? summary.outPath : state.configPath);
    $('configSelect').value = state.configPath;
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('saveOverwrite').addEventListener('click', () => doSave('overwrite'));
$('saveNew').addEventListener('click', () => doSave('new'));

$('deleteConfig').addEventListener('click', async () => {
  if (!state.configPath) return;
  const name = state.view ? state.view.name : state.configPath;
  if (!confirm(`Delete "${name}"?\n\nA timestamped backup is kept so it can be restored.`)) return;
  try {
    const r = await postJson('/api/delete', { path: state.configPath });
    toast('Configuration deleted.', 'ok', r.backupPath ? `backup: ${r.backupPath}` : '');
    state.configPath = null;
    await loadState();
    $('configSelect').value = '';
    await loadConfig('');
  } catch (err) { toast(err.message, 'err'); }
});
