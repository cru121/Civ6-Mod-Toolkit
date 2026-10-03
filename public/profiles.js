'use strict';

// Player profiles: the game's mod groups (Additional Content > Mod Groups).
// The bar above the mod filters switches between them; the manage dialog
// creates, renames, duplicates and deletes them. Every change is refused by
// the server while Civ6 is running, so the controls are disabled then.

const profilePage = { data: null };

// Which profile the user had before, most recent first. The database has no
// "last used" column, so deleting the active profile falls back to this.
const LAST_USED_KEY = 'profileLastUsed';

function lastUsed() {
  try { return JSON.parse(localStorage.getItem(LAST_USED_KEY)) || []; } catch (_) { return []; }
}

function rememberUsed(id) {
  const list = [id, ...lastUsed().filter((x) => x !== id)].slice(0, 5);
  try { localStorage.setItem(LAST_USED_KEY, JSON.stringify(list)); } catch (_) { /* storage blocked */ }
}

function activeProfile() {
  return profilePage.data && profilePage.data.active;
}

function profileById(id) {
  return profilePage.data.groups.find((g) => g.id === Number(id));
}

// The profile to switch to when the active one is deleted: the one used before
// it, and null lets the server pick the built-in group.
function fallbackId() {
  const current = activeProfile();
  for (const id of lastUsed()) {
    if (current && id === current.id) continue;
    if (profileById(id)) return id;
  }
  return null;
}

// ---- bar --------------------------------------------------------------------

function renderBar() {
  const d = profilePage.data;
  $('profileBar').hidden = !d;
  if (!d) return;
  const sel = $('profileSelect');
  sel.innerHTML = d.groups
    .map((g) => `<option value="${g.id}">${esc(groupLabel(g))} — ${g.enabled} of ${g.total} on</option>`)
    .join('');
  if (d.active) sel.value = String(d.active.id);
  // Switching and editing both write to the game's database; exporting and the
  // manage dialog's read-only view still work while it runs.
  sel.disabled = game.running;
  $('profileManage').disabled = game.running;
  $('profileImport').disabled = game.running;
  $('profileExport').disabled = !d.active;
  $('profileMeta').textContent = game.running ? 'Close Civ6 to change profiles' : '';
}

async function loadProfiles() {
  profilePage.data = await api('/api/modgroups');
  setGameStatus(profilePage.data.game);
  if (profilePage.data.active) rememberUsed(profilePage.data.active.id);
  renderBar();
  if ($('profileDialog').open) renderDialog();
  return profilePage.data;
}

// Runs one profile operation, then re-renders from the refreshed list the
// server sends back and reloads the mod list (the mods shown belong to the
// active profile).
async function groupAction(action, body, message) {
  try {
    const r = await postJson('/api/modgroups/' + action, body);
    profilePage.data = { ...profilePage.data, ok: true, groups: r.groups, active: r.active };
    setGameStatus(r.game);
    renderBar();
    if ($('profileDialog').open) renderDialog();
    toast(message(r), 'ok', `backup: ${esc(r.backupPath)}`);
    await loadMods();
    return r;
  } catch (err) {
    toast(esc(err.message), 'err');
    return null;
  }
}

// ---- switching ------------------------------------------------------------

// The mods that would be loaded once `p` is in use: what is loaded now, plus
// this profile's additions, minus its removals. Built from the differences
// rather than fetched whole, because the server only sends those.
function setAfterSwitch(p) {
  const next = new Set((modsPage.data ? modsPage.data.mods : [])
    .filter((m) => m.enabled === true).map((m) => m.idNorm));
  for (const id of p.turningOn) next.add(id);
  for (const id of p.turningOff) next.delete(id);
  return next;
}

const modNames = (ids, all, limit) => {
  const names = ids.map((id) => stripCivText((all.get(id) || {}).name)).filter(Boolean);
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
};

// What the switch would do, in the order that matters: what starts loading, what
// stops, and whether the result is a set the game can actually load. Problems
// are worked out for the incoming set rather than the current one - warning about
// conflicts that the switch would resolve is as misleading as missing one it
// would cause.
function switchPreview(p) {
  const all = new Map((modsPage.data ? modsPage.data.mods : []).map((m) => [m.idNorm, m]));
  const on = (m) => setAfterSwitch(p).has(m.idNorm);
  const label = groupLabel({ name: p.to.name });
  const lines = [`Now using "${label}"?`];
  if (p.turningOn.length) lines.push(`\n${p.turningOn.length} mod${p.turningOn.length === 1 ? '' : 's'} will start loading:\n${modNames(p.turningOn, all, 5)}`);
  if (p.turningOff.length) lines.push(`\n${p.turningOff.length} mod${p.turningOff.length === 1 ? '' : 's'} will stop loading:\n${modNames(p.turningOff, all, 5)}`);
  if (!p.turningOn.length && !p.turningOff.length) lines.push('\nNothing will change.');

  const problems = [];
  for (const m of all.values()) {
    for (const pr of problemsOf(m, all, on)) problems.push(`${stripCivText(m.name)} — ${pr.text}`);
  }
  if (problems.length) {
    lines.push(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} with what would be loaded:`);
    for (const pr of problems.slice(0, 4)) lines.push(`• ${pr}`);
    if (problems.length > 4) lines.push(`• and ${problems.length - 4} more`);
  }
  return lines.join('\n');
}

async function switchTo(id) {
  const current = activeProfile();
  if (current && Number(id) === current.id) return;
  if (modsPage.pending.size &&
      !confirm('You have mod changes that haven\'t been applied. Switching profiles discards them. Continue?')) {
    renderBar(); // put the select back on the profile actually in use
    return;
  }
  // A preview is a courtesy, not a gate: if it cannot be had, still switch. What
  // it must never do is silently fail and leave the user unaware of the change.
  let p = null;
  try {
    p = await api(`/api/modgroups/preview?id=${encodeURIComponent(id)}`);
  } catch (_) { /* carry on without it */ }
  if (p && !confirm(switchPreview(p))) {
    renderBar();
    return;
  }
  modsPage.pending.clear();
  await groupAction('activate', { id: Number(id) }, (r) => `Now using "${esc(groupLabel(r.active))}".`);
  renderBar();
}

// ---- manage dialog ---------------------------------------------------------

function profileRow(g, d) {
  const blocked = game.running;
  const oneLeft = d.groups.length < 2;
  return `<div class="row">
    <span class="name"><b>${esc(groupLabel(g))}</b><small>${g.enabled} of ${g.total} mods on</small></span>
    ${g.selected ? '<span class="tag">in use</span>' : ''}
    ${g.canDelete ? '' : '<span class="tag">built-in</span>'}
    <button type="button" class="secondary small" data-use="${g.id}" ${g.selected || blocked ? 'disabled' : ''}>Use</button>
    <button type="button" class="secondary small" data-duplicate="${g.id}" ${blocked ? 'disabled' : ''}>Duplicate</button>
    <button type="button" class="secondary small" data-rename="${g.id}">Rename</button>
    <button type="button" class="danger small" data-delete="${g.id}" ${!g.canDelete || oneLeft || blocked ? 'disabled' : ''}>Delete</button>
  </div>`;
}

function renderDialog() {
  const d = profilePage.data;
  $('profileDialogBody').innerHTML = `
    <h2>Profiles</h2>
    <p class="hint">A profile is a set of mods turned on or off. Civ6 uses the one marked <b>in use</b>.
      Changes are written to the game now and take effect the next time you start Civ6.</p>
    <div class="panel-actions" style="margin-bottom:12px">
      <button type="button" id="profileNew" ${game.running ? 'disabled' : ''}>New empty profile</button>
    </div>
    <div class="list">${d.groups.map((g) => profileRow(g, d)).join('')}</div>`;
}

function openDialog() {
  renderDialog();
  $('profileDialog').showModal();
}

function namePrompt(message, initial) {
  const name = prompt(message, initial);
  return name == null ? null : name.trim() || null;
}

async function createProfile() {
  const name = namePrompt('Name for the new profile:', 'New profile');
  if (!name) return;
  await groupAction('create', { name }, (r) => `Created "${esc(groupLabel(r.group))}" with every mod off.`);
}

async function duplicateProfile(g) {
  const name = namePrompt(`Name for the copy of "${groupLabel(g)}":`, `${groupLabel(g)} copy`);
  if (!name) return;
  await groupAction('duplicate', { id: g.id, name }, (r) => `Copied to "${esc(groupLabel(r.group))}".`);
}

async function renameProfile(g) {
  const name = namePrompt('New name for this profile:', groupLabel(g));
  if (!name) return;
  await groupAction('rename', { id: g.id, name }, (r) => `Renamed to "${esc(groupLabel(r.group))}".`);
}

async function deleteProfile(g) {
  const label = groupLabel(g);
  const extra = g.selected ? '\n\nIt is the profile in use, so another one will be used instead.' : '';
  if (!confirm(`Delete the profile "${label}" (${g.enabled} of ${g.total} mods on)?${extra}`)) return;
  await groupAction('delete', { id: g.id, fallbackId: fallbackId() },
    (r) => (r.active ? `Deleted "${esc(label)}". Now using "${esc(groupLabel(r.active))}".` : `Deleted "${esc(label)}".`));
}

// ---- export / import -------------------------------------------------------

// A download is a plain navigation to the endpoint, which answers with the file.
function exportProfile() {
  const active = activeProfile();
  if (!active) return;
  $('profileMeta').textContent = 'Exporting…';
  const a = document.createElement('a');
  a.href = '/api/modgroups/export?id=' + encodeURIComponent(active.id);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  $('profileMeta').textContent = '';
}

// Import always creates a new profile; the file's own mods that this install
// doesn't have are reported instead of silently dropped.
async function importProfile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    toast(esc(`${file.name} is not valid JSON.`), 'err');
    return;
  }
  const r = await groupAction('import', { profile: data },
    (x) => `Imported "${esc(groupLabel(x.group))}" with ${x.imported} mod${x.imported === 1 ? '' : 's'}.`);
  if (!r) return;
  if (r.skipped && r.skipped.length) {
    // Prefer a name the player recognises over the bare id.
    const known = new Map((modsPage.data ? modsPage.data.mods : []).map((m) => [m.idNorm, m.name]));
    const names = r.skipped.map((id) => known.get(String(id).toLowerCase()) || id);
    const shown = names.slice(0, 5).map(renderCivText).join(', ');
    toast(`${r.skipped.length} mod${r.skipped.length === 1 ? '' : 's'} in the file ` +
      `${r.skipped.length === 1 ? 'is' : 'are'} not installed here and ${r.skipped.length === 1 ? 'was' : 'were'} left out.`,
      'err', shown + (names.length > 5 ? `, +${names.length - 5} more` : ''));
  }
}

// ---- events ----------------------------------------------------------------

$('profileSelect').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  switchTo(id).catch((err) => toast(esc(err.message), 'err'));
});

$('profileManage').addEventListener('click', openDialog);
$('profileExport').addEventListener('click', exportProfile);
$('profileImport').addEventListener('click', () => $('profileFile').click());
$('profileFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // so the same file can be picked twice
  if (file) importProfile(file).catch((err) => toast(esc(err.message), 'err'));
});
$('profileDialogClose').addEventListener('click', () => $('profileDialog').close());
$('profileDialog').addEventListener('click', (e) => { if (e.target === $('profileDialog')) $('profileDialog').close(); });

$('profileDialogBody').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = profilePage.data;
  if (b.id === 'profileNew') return void createProfile();
  const g = profileById((b.dataset.use || b.dataset.duplicate || b.dataset.rename || b.dataset.delete));
  if (!g) return;
  if (b.dataset.use) switchTo(g.id);
  else if (b.dataset.duplicate) duplicateProfile(g);
  else if (b.dataset.rename) renameProfile(g);
  else if (b.dataset.delete) deleteProfile(g);
});

// Profiles belong to the mod manager page, so they are loaded with it: wrap the
// page's router entry point instead of listening for load events, which makes
// the order of the script tags irrelevant. The bar is also re-rendered when the
// game is opened or closed, since that decides what can be changed.
const modsRoute = pages.mods.show;
pages.mods = {
  ...pages.mods,
  show(params) {
    return Promise.all([modsRoute(params), loadProfiles()]).then(([r]) => r);
  },
};

document.addEventListener('gamestatus', () => {
  if (document.body.dataset.page !== 'mods') return;
  renderBar();
  if ($('profileDialog').open) renderDialog();
});
