'use strict';

// Dashboard: mod / config counts and the folder setup.

const dash = { data: null };

function groupLabel(g) {
  if (!g) return '';
  return g.name === 'LOC_MODS_GROUP_DEFAULT_NAME' ? 'Default' : g.name;
}

function ratio(c, dbOk) {
  return dbOk ? `${c.enabled} / ${c.total}` : `? / ${c.total}`;
}

function folderRow(label, value, ok, note) {
  return `<div class="folder">
    <span class="folder-label">${esc(label)}</span>
    <code class="folder-path">${esc(value || '(not set)')}</code>
    <span class="chip ${ok ? 'good' : 'bad'}">${ok ? 'found' : 'not found'}</span>
    ${note ? `<span class="folder-note">${note}</span>` : ''}
  </div>`;
}

function renderDashboard() {
  const d = dash.data;
  const dbOk = d.modsDb.ok;
  $('appVersion').textContent = d.version ? ` v${d.version}` : '';
  $('cWorkshop').textContent = ratio(d.counts.workshop, dbOk);
  $('cLocal').textContent = ratio(d.counts.local, dbOk);
  $('cConfigs').textContent = d.counts.configs;
  $('cDlc').textContent = dbOk ? `${d.counts.dlc.enabled} / ${d.counts.dlc.total}` : '?';

  const alerts = [];
  if (!dbOk) {
    alerts.push(`<div class="alert warn"><b>Can't read which mods are enabled.</b> ${esc(d.modsDb.error || '')}</div>`);
  }
  if (d.unscanned.length) {
    const names = d.unscanned.map((m) => renderCivText(m.name)).join(', ');
    alerts.push(`<div class="alert info"><b>${d.unscanned.length} new mod${d.unscanned.length > 1 ? 's' : ''} not yet seen by the game:</b> ${names}.
      Start Civ6 once so it picks ${d.unscanned.length > 1 ? 'them' : 'it'} up.</div>`);
  }
  $('dashAlerts').innerHTML = alerts.join('');

  const local = d.sources.filter((s) => s.type === 'local');
  const ws = d.sources.filter((s) => s.type === 'workshop');
  $('folderList').innerHTML = [
    ...local.map((s) => folderRow('Local mods', s.root, s.exists)),
    ...ws.map((s) => folderRow('Steam Workshop', s.root, s.exists)),
    folderRow('Configurations', d.saves.root, d.saves.exists),
    folderRow('Mod database', d.modsDb.path, d.modsDb.exists,
      d.modsDb.activeGroup ? `active mod group: ${esc(groupLabel(d.modsDb.activeGroup))}` : ''),
  ].join('');

  $('pathLocal').value = (local[0] || {}).root || '';
  $('pathWorkshop').value = ws.map((s) => s.root).filter(Boolean).join(';');
  $('pathSaves').value = d.saves.root || '';
  $('pathModsDb').value = d.modsDb.path || '';
}

async function loadDashboard() {
  dash.data = await api('/api/dashboard');
  setGameStatus(dash.data.game);
  renderDashboard();
}

pages.dashboard = { show: loadDashboard };

$('editPaths').addEventListener('click', () => { $('pathsForm').hidden = !$('pathsForm').hidden; });
$('cancelPaths').addEventListener('click', () => { $('pathsForm').hidden = true; if (dash.data) renderDashboard(); });

$('pathsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const workshop = $('pathWorkshop').value.split(';').map((s) => s.trim()).filter(Boolean);
    await postJson('/api/paths', {
      localMods: $('pathLocal').value.trim() || undefined,
      workshop: workshop.length ? workshop : undefined,
      saves: $('pathSaves').value.trim() || undefined,
      modsDb: $('pathModsDb').value.trim() || undefined,
    });
    $('pathsMsg').textContent = 'Saved.';
    $('pathsForm').hidden = true;
    configPage.stale = true;
    await loadDashboard();
  } catch (err) { toast(err.message, 'err'); }
});

$('rescan').addEventListener('click', async () => {
  try { configPage.stale = true; await loadDashboard(); toast('Rescanned.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});
