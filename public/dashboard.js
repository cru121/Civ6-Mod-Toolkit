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
  // The counts below come from the folders we are actually reading, so if the
  // overrides file did not load these totals are of the wrong library entirely.
  // That is worth saying before the numbers, not after.
  if (d.pathsError) {
    alerts.push(`<div class="alert warn"><b>Mod locations are not being read.</b> ${esc(d.pathsError)} These counts are of the usual folders, not the ones you set.</div>`);
  }
  if (!dbOk) {
    alerts.push(`<div class="alert warn"><b>Can't read which mods are enabled.</b> ${esc(d.modsDb.error || '')}</div>`);
  }
  // Say what the last sync did, or what is still waiting. A sync never switches
  // anything on, so the wording never implies a mod is now active.
  const s = d.sync;
  if (s && s.error) {
    alerts.push(`<div class="alert warn"><b>Couldn't add new mods.</b> ${esc(s.error)}</div>`);
  } else if (s && s.skipped === 'civ6-running') {
    alerts.push(`<div class="alert warn"><b>Civ6 is running.</b> Close it, then rescan to add any new mods.</div>`);
  } else if (s && s.added.length) {
    const n = s.added.length;
    // renderCivText already returns HTML, so escaping it again is what turned a
    // mod's colour tags into visible "<span>" text.
    const names = s.added.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (n > 4 ? ` and ${n - 4} more` : '');
    alerts.push(`<div class="alert info"><b>Added ${n} new mod${n > 1 ? 's' : ''}:</b> ${names}.
      They're switched off — tick ${n > 1 ? 'them' : 'it'} in the mod manager when you want ${n > 1 ? 'them' : 'it'}.</div>`);
  }
  if (s && s.failed && s.failed.length) {
    alerts.push(`<div class="alert warn"><b>${s.failed.length} mod${s.failed.length > 1 ? 's' : ''} couldn't be read:</b> ${
      s.failed.map((f) => `${esc(f.file)} (${esc(f.error)})`).join(', ')}</div>`);
  }
  if (d.gone && d.gone.removable) {
    const gone = d.gone.removed.filter((r) => r.removable);
    const names = gone.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (gone.length > 4 ? ` and ${gone.length - 4} more` : '');
    alerts.push(`<div class="alert info"><b>${gone.length} mod${gone.length > 1 ? 's' : ''} no longer installed:</b> ${names}.
      The game still lists ${gone.length > 1 ? 'them' : 'it'}. Use <b>Remove mod</b> in the mod manager to clear
      ${gone.length > 1 ? 'them' : 'it'} out.</div>`);
  }
  if (d.needsSync.length) {
    const n = d.needsSync.length;
    const names = d.needsSync.slice(0, 4).map((m) => renderCivText(m.name)).join(', ')
      + (n > 4 ? ` and ${n - 4} more` : '');
    alerts.push(`<div class="alert info"><b>${n} mod${n > 1 ? 's' : ''} not added yet:</b> ${names}.
      Rescan to add ${n > 1 ? 'them' : 'it'} — they stay switched off until you tick ${n > 1 ? 'them' : 'it'}.</div>`);
  }
  $('dashAlerts').innerHTML = alerts.join('');

  const local = d.sources.filter((s) => s.type === 'local');
  const ws = d.sources.filter((s) => s.type === 'workshop');
  $('folderList').innerHTML = [
    ...local.map((s) => folderRow('Local mods', s.root, s.exists)),
    ...ws.map((s) => folderRow('Steam Workshop', s.root, s.exists)),
    folderRow('Configurations', d.saves.root, d.saves.exists),
    folderRow('Game logs', d.logs.root, d.logs.exists),
    folderRow('Game cache', d.cache.root, d.cache.exists),
    folderRow('Mod database', d.modsDb.path, d.modsDb.exists,
      d.modsDb.activeGroup ? `active mod group: ${esc(groupLabel(d.modsDb.activeGroup))}` : ''),
  ].join('');

  $('pathLocal').value = (local[0] || {}).root || '';
  $('pathWorkshop').value = ws.map((s) => s.root).filter(Boolean).join(';');
  $('pathSaves').value = d.saves.root || '';
  $('pathLogs').value = d.logs.root || '';
  $('pathCache').value = d.cache.root || '';
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
      logsDir: $('pathLogs').value.trim() || undefined,
      cacheDir: $('pathCache').value.trim() || undefined,
      modsDb: $('pathModsDb').value.trim() || undefined,
    });
    $('pathsMsg').textContent = 'Saved.';
    $('pathsForm').hidden = true;
    configPage.stale = true;
    await loadDashboard();
  } catch (err) { toast(err.message, 'err'); }
});

// Rescan is a write, not just a re-read: it adds any mod on disk that the game
// has not got yet. The button says so, and this says what happened.
$('rescan').addEventListener('click', async () => {
  const btn = $('rescan');
  btn.disabled = true;
  try {
    const r = await postJson('/api/sync', {});
    configPage.stale = true;
    await loadDashboard();
    if (r.error) toast(esc(r.error), 'err');
    else if (r.skipped === 'civ6-running') toast('Civ6 is running — close it and rescan to add new mods.', 'err');
    else if (r.added.length) {
      const n = r.added.length;
      toast(`Added ${n} new mod${n > 1 ? 's' : ''}, switched off.`, 'ok',
        r.backupPath ? `backup: ${esc(r.backupPath)}` : '');
    } else toast('Rescanned — nothing new to add.', 'ok');
  } catch (err) {
    toast(esc(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
});
