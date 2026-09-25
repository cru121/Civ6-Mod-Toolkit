'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  configPath: null,
  view: null,          // { enabled:[], availableToAdd:[] }
  addSet: new Set(),   // idNorm to add
  removeSet: new Set(),// idNorm to remove
  showDlc: false,      // whether to list official DLC / not-installed entries
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

// Civ text markup uses tags like [COLOR_GREEN]…[ENDCOLOR], [COLOR:r,g,b,a]…,
// [ICON_*], [NEWLINE]. Render colors as spans, drop other tags. Theme-friendly
// named colors (readable on both light and dark backgrounds).
const CIV_COLORS = {
  GREEN: '#2ea043', RED: '#e5534b', YELLOW: '#c9a227', GOLD: '#c9a227',
  ORANGE: '#d2691e', BLUE: '#4c8dff', CYAN: '#1c9c9c', MAGENTA: '#c145b8',
  PURPLE: '#a371f7', WHITE: '#8b98a5', GREY: '#8b98a5', GRAY: '#8b98a5',
  BLACK: '#8b98a5', BROWN: '#a0522d',
};
function parseCivColor(tag) {
  const t = tag.replace(/^COLOR[:_]?/i, '');
  const nums = t.match(/^\s*(\d{1,3})[,_\s]+(\d{1,3})[,_\s]+(\d{1,3})/);
  if (nums) return `rgb(${nums[1]},${nums[2]},${nums[3]})`;
  const key = t.replace(/[^A-Za-z]/g, '').toUpperCase();
  return CIV_COLORS[key] || null;
}
function renderCivText(s) {
  s = String(s == null ? '' : s);
  const re = /\[([^\]]+)\]/g;
  let out = '', last = 0, depth = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    last = re.lastIndex;
    const up = m[1].toUpperCase();
    if (up === 'ENDCOLOR') { if (depth) { out += '</span>'; depth--; } }
    else if (up.startsWith('COLOR')) {
      const col = parseCivColor(m[1]);
      out += col ? `<span style="color:${col}">` : '<span>';
      depth++;
    } else if (up === 'NEWLINE') { out += ' '; }
    // any other tag ([ICON_*], etc.) is dropped
  }
  out += esc(s.slice(last));
  while (depth-- > 0) out += '</span>';
  return out;
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

$('deleteConfig').addEventListener('click', async () => {
  if (!state.configPath) return;
  const name = state.view ? state.view.name : state.configPath;
  if (!confirm(`Delete "${name}"?\n\nA timestamped backup is kept so it can be restored.`)) return;
  try {
    const r = await api('/api/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.configPath }),
    });
    toast('Configuration deleted.', 'ok', r.backupPath ? `backup: ${r.backupPath}` : '');
    state.configPath = null;
    await loadState();
    $('configSelect').value = '';
    await loadConfig('');
  } catch (err) { toast(err.message, 'err'); }
});

// ---- init ------------------------------------------------------------------
loadState().catch((err) => toast(err.message, 'err'));
