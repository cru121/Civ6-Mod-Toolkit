'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  configPath: null,
  view: null,          // { enabled:[], availableToAdd:[] }
  addSet: new Set(),   // idNorm to add
  removeSet: new Set(),// idNorm to remove
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind, detail) {
  const t = $('toast');
  t.className = 'toast ' + (kind || '');
  t.innerHTML = msg + (detail ? `<small>${detail}</small>` : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), kind === 'err' ? 8000 : 5000);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- load overall state ----------------------------------------------------

async function loadState() {
  const s = await api('/api/state');
  $('pathLocal').value = (s.sources.find((x) => x.type === 'local') || {}).root || '';
  $('pathWorkshop').value = s.sources.filter((x) => x.type === 'workshop').map((x) => x.root).join(';') || '';
  $('pathSaves').value = s.saves.root || '';
  const nLocal = s.installed.filter((m) => m.type === 'local').length;
  const nWs = s.installed.filter((m) => m.type === 'workshop').length;
  $('pathsBadge').textContent = `(${s.installed.length} mods found — ${nLocal} local, ${nWs} workshop)`;

  const sel = $('configSelect');
  if (!s.configs.length) {
    sel.innerHTML = '<option value="">No .Civ6Cfg files found in saves folder</option>';
    $('configMeta').textContent = s.savesExists ? '' : 'Saves folder not found — set it above.';
  } else {
    sel.innerHTML = '<option value="">Choose a config…</option>' +
      s.configs.map((c) => `<option value="${esc(c.path)}">${esc(c.name)}${c.mods != null ? ` — ${c.mods} mods` : ''}</option>`).join('');
  }
  // keep current selection if still present
  if (state.configPath && [...sel.options].some((o) => o.value === state.configPath)) {
    sel.value = state.configPath;
  }
}

// ---- load one config -------------------------------------------------------

async function loadConfig(p) {
  state.configPath = p;
  state.addSet.clear();
  state.removeSet.clear();
  if (!p) {
    $('editor').hidden = true; $('bar').hidden = true;
    return;
  }
  const v = await api('/api/config?path=' + encodeURIComponent(p));
  state.view = v;
  render();
  $('editor').hidden = false; $('bar').hidden = false;
}

function render() {
  const v = state.view;
  const enabled = v.enabled;
  const avail = v.availableToAdd;

  // Enabled column
  $('enabledCount').textContent = `(${enabled.length})`;
  $('enabledList').innerHTML = enabled.map((m) => {
    const removable = m.installed;
    const pendingRemove = state.removeSet.has(m.idNorm);
    const cls = pendingRemove ? 'row pending-remove' : (removable ? 'row' : 'row readonly');
    const tag = m.installed ? m.type : 'dlc';
    const tagLabel = m.installed ? m.type : 'DLC / not installed';
    return `<label class="${cls}">
      <input type="checkbox" data-remove="${esc(m.idNorm)}" ${removable ? '' : 'disabled'} ${pendingRemove ? '' : 'checked'} />
      <span class="name"><b>${esc(m.name || m.title || m.id)}</b><small>${esc(m.id)}</small></span>
      <span class="tag ${tag}">${esc(tagLabel)}</span>
    </label>`;
  }).join('') || '<p class="hint">No mods enabled.</p>';

  // Available column
  const filter = $('availFilter').value.toLowerCase();
  const shown = avail.filter((m) => !filter || m.name.toLowerCase().includes(filter) || m.idNorm.includes(filter));
  $('availCount').textContent = `(${avail.length})`;
  $('availList').innerHTML = shown.map((m) => {
    const pendingAdd = state.addSet.has(m.idNorm);
    return `<label class="row ${pendingAdd ? 'pending-add' : ''}">
      <input type="checkbox" data-add="${esc(m.idNorm)}" ${pendingAdd ? 'checked' : ''} />
      <span class="name"><b>${esc(m.name)}</b><small>${esc(m.id)}</small></span>
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

document.addEventListener('change', (e) => {
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

$('savePaths').addEventListener('click', async () => {
  try {
    const workshop = $('pathWorkshop').value.split(';').map((s) => s.trim()).filter(Boolean);
    await api('/api/paths', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localMods: $('pathLocal').value.trim() || undefined,
        workshop: workshop.length ? workshop : undefined,
        saves: $('pathSaves').value.trim() || undefined,
      }),
    });
    $('pathsMsg').textContent = 'Saved. Rescanning…';
    await loadState();
    if (state.configPath) await loadConfig(state.configPath);
    $('pathsMsg').textContent = 'Saved.';
  } catch (err) { toast(err.message, 'err'); }
});

$('rescan').addEventListener('click', async () => {
  try { await loadState(); if (state.configPath) await loadConfig(state.configPath); toast('Rescanned.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
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
    const { summary } = await api('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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
    toast(err.message + (err.problems ? '' : ''), 'err');
  }
}

$('saveOverwrite').addEventListener('click', () => doSave('overwrite'));
$('saveNew').addEventListener('click', () => doSave('new'));

// ---- init ------------------------------------------------------------------
loadState().catch((err) => toast(err.message, 'err'));
