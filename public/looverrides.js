'use strict';

// The load order overrides screen: problem 2.
//
// A separate page from the load order view, on purpose. The view answers "where
// is there room" and must stay read-only; this answers "move this one" and is
// where a value is allowed to change. The handoff for this feature was explicit
// that the two had been conflated before and must not be again.
//
// It is a page rather than a dialog because the person who has twenty overrides
// is the person writing a sub-mod - which is the same person the view is built
// for - and because an orphaned override has no mod row to live in: the action
// it named is gone.

const lov = { data: null };

const STATE_TEXT = {
  applied: 'in place — your value is used',
  drifted: 'drifted — the database has a different value',
  orphaned: 'orphaned — nothing in that mod matches this key any more',
  ambiguous: 'ambiguous — more than one action matches this key',
};

function keyLabel(o) {
  // The key is a readable string on purpose. A mod author looking at "why did
  // my override stop matching" should be able to see what it names.
  const parts = String(o.key).split('\n');
  const files = parts.slice(2);
  return `${parts[0]}${parts[1] ? ` · ${parts[1]}` : ''}${files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`;
}

// Ledger file names: a resolved row names its action's file basenames like
// picker rows do, from the same lov.fileCache behind the same batch GET
// /api/action-files?modId=. Unresolvable keys (no componentRowId) keep the
// key summary only. Basenames carry no Civ markup, so esc() is the right
// helper — never renderCivText, and never a raw path.
function lovLedgerFilesSlot(o) {
  if (o.componentRowId == null) return '';
  const hit = (lov.fileCache || {})[o.componentRowId];
  if (!hit) return '<span class="lo-fileslot">…</span>';
  return `<span class="lo-fileslot">${lovEditFilesHtml(hit, !!lov.filesOpen[o.componentRowId], o.componentRowId)}</span>`;
}

function rowHtml(o) {
  const editable = o.state === 'applied' || o.state === 'drifted';
  const warn = o.state === 'drifted' ? 'lo-drift' : o.state === 'applied' ? 'lo-override' : 'lo-lost';
  return `<div class="lo-row lov-row" data-mod="${esc(o.modId)}" data-key="${esc(o.key)}">
    <span class="lo-mod">${renderCivText(o.modName)}</span>
    <span class="lo-type">${esc(o.type || o.state)}</span>
    <span class="lo-detail">
      <span class="lo-tag ${warn}">${esc(STATE_TEXT[o.state] || o.state)}</span>
      <span class="lo-ov">at ${esc(n(o.value))}${o.declared !== null ? ` · author declares ${esc(n(o.declared))}` : ''}</span>
      <span class="lo-key">${esc(keyLabel(o))}</span>
      ${lovLedgerFilesSlot(o)}
      ${o.reason ? `<span class="lo-cond">${esc(o.reason)}</span>` : ''}
      ${o.protected ? '' : '<span class="lo-tag lo-unprot">can’t be kept safe — its .modinfo is not on disk</span>'}
    </span>
    <span class="lov-actions">
      ${editable ? `<button type="button" class="secondary small" data-act="edit">Change…</button>
                    <button type="button" class="secondary small" data-act="reset">Reset</button>` : ''}
      <button type="button" class="secondary small" data-act="discard">Discard</button>
    </span>
  </div>`;
}

// Per-mod ledger groups: one header per mod with Reset-all (back to recorded
// author values, refused when any entry lacks one) and Discard-all (forget
// without touching the database). Sorted by rendered name, like the picker.
function lovLedgerGroups() {
  const d = lov.data;
  if (!d || !d.ok || !Array.isArray(d.overrides) || !d.overrides.length) return [];
  const byMod = new Map();
  for (const o of d.overrides) {
    if (!byMod.has(o.modId)) byMod.set(o.modId, { modId: o.modId, modName: o.modName, rows: [] });
    byMod.get(o.modId).rows.push(o);
  }
  return [...byMod.values()].sort((a, b) => String(a.modName).localeCompare(String(b.modName)));
}

function lovLedgerModHeader(m) {
  const c = m.rows.length;
  return `<div class="lo-row lov-modhead" data-lov-modhead="${esc(m.modId)}">`
    + `<span class="lo-mod">${renderCivText(m.modName)}</span>`
    + `<span class="lo-type">${esc(`${c} override${c === 1 ? '' : 's'}`)}</span>`
    + `<span class="lov-actions">`
    + `<button type="button" class="secondary small" data-lov-resetmod="${esc(m.modId)}" title="Put every override of this mod back to the recorded author values — refused if any entry lacks one, nothing half-done">Reset all</button>`
    + ` <button type="button" class="secondary small" data-lov-discardmod="${esc(m.modId)}" title="Forget every override of this mod without touching the database — values stay where last written">Discard all</button>`
    + `</span></div>`;
}

// Fire-and-forget batch loads for every mod named in the ledger, reusing the
// picker's lov.fileCache / lov.filesMod behind the same GET. Each load
// re-renders once it lands; the filesMod flag keeps a second render from
// refetching, so this never loops.
function lovLedgerEnsureFiles() {
  const d = lov.data;
  if (!d || !d.ok || !Array.isArray(d.overrides)) return;
  const mods = [...new Set(d.overrides.filter((o) => o.componentRowId != null).map((o) => o.modId))];
  for (const mid of mods) {
    if ((lov.filesMod || {})[mid]) continue;
    lovEditLoadFiles(mid).catch((err) => toast(err.message, 'err'));
  }
}

function renderOverrides() {
  const d = lov.data;
  const alerts = [];
  if (d && !d.ok) alerts.push(`<div class="alert warn"><b>Can't read your overrides.</b> ${esc(d.error || '')}</div>`);
  if (d && d.unusable) alerts.push(`<div class="alert warn"><b>Your overrides file cannot be read.</b> ${esc(d.error || '')} Nothing will be written until it is fixed or deleted.</div>`);
  if (d && d.stale && d.stale.stale && d.stale.stale.length) {
    alerts.push(`<div class="alert warn"><b>${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} updated since your last sync.</b> Re-apply before playing.</div>`);
  }
  $('lovAlerts').innerHTML = alerts.join('');

  $('lovCount').textContent = d && d.ok ? n(d.count) : '';
  $('lovMeta').textContent = d && d.ok
    ? (d.stale && d.stale.stale && d.stale.stale.length
        ? `${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} waiting to be re-applied`
        : 'Everything is in place')
    : '';
  $('lovList').innerHTML = d && d.ok && d.overrides.length
    ? lovLedgerGroups().map((g) => lovLedgerModHeader(g) + g.rows.map(rowHtml).join('')).join('')
    : '<p class="note">No overrides. The load order view is read-only on purpose — an override is set from here.</p>';
  lovLedgerEnsureFiles();
}

async function load() {
  try {
    lov.data = await api('/api/load-overrides');
  } catch (err) {
    lov.data = { ok: false, error: err.message, overrides: [], count: 0 };
  }
  renderOverrides();
}

async function post(path, body) {
  const d = await postJson(path, body);
  lov.data = d;
  renderOverrides();
  return d;
}

// Change… asks for the value in a dialog rather than a prompt(), so the author
// can see the declared value and the current one while deciding.
function askValue(o) {
  const current = String(o.value);
  const declared = o.declared === null ? '' : String(o.declared);
  const msg = `${stripCivText(o.modName)}\n\ncurrently ${o.value}${declared !== '' ? `, author declares ${declared}` : ''}\n\nNew LoadOrder (whole number):`;
  // eslint-disable-next-line no-alert
  const answer = window.prompt(msg, current);
  if (answer === null) return null;
  const trimmed = answer.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    toast('a load order has to be a whole number', 'err');
    return null;
  }
  return Number(trimmed);
}

$('lovList').addEventListener('click', async (e) => {
  const fbtn = e.target.closest('button[data-lov-files]');
  if (fbtn) {
    const id = fbtn.dataset.lovFiles;
    lov.filesOpen[id] = !lov.filesOpen[id];
    renderOverrides();
    return;
  }
  const rmod = e.target.closest('button[data-lov-resetmod]');
  if (rmod) {
    const modId = rmod.dataset.lovResetmod;
    const group = (lovLedgerGroups() || []).find((g) => String(g.modId) === String(modId));
    const c = group ? group.rows.length : 0;
    const name = group ? stripCivText(group.modName) : modId;
    try {
      if (!confirm(`Put all ${c} override${c === 1 ? '' : 's'} for ${name} back to the recorded author values?`)) return;
      await post('/api/load-overrides/reset-mod', { modId });
      toast(`all ${c} back to the authors' values`);
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }
  const dmod = e.target.closest('button[data-lov-discardmod]');
  if (dmod) {
    const modId = dmod.dataset.lovDiscardmod;
    const group = (lovLedgerGroups() || []).find((g) => String(g.modId) === String(modId));
    const c = group ? group.rows.length : 0;
    const name = group ? stripCivText(group.modName) : modId;
    try {
      // Same "values stay" wording as the single discard: forgetting is not resetting.
      if (!confirm(`Forget all ${c} override${c === 1 ? '' : 's'} for ${name}?\n\nThe values stay where they were last written. Use Reset all if you want the authors' values back.`)) return;
      await post('/api/load-overrides/discard-mod', { modId });
      toast('overrides discarded');
    } catch (err) {
      toast(err.message, 'err');
    }
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.lov-row');
  const modId = row.dataset.mod;
  const key = row.dataset.key;
  const entry = (lov.data.overrides || []).find((o) => o.modId === modId && o.key === key);
  if (!entry) return;

  try {
    if (btn.dataset.act === 'edit') {
      const v = askValue(entry);
      if (v === null) return;
      if (v >= 10000000 && !confirm(`Load order ${v} means "load last, override everything" in Civ6. The author may have meant that. Carry on?`)) return;
      const d = await post('/api/load-overrides', { modId, key, value: v });
      if (d.sentinels && d.sentinels.length) toast('applied — and that value means "load last"');
      else toast('applied');
    } else if (btn.dataset.act === 'reset') {
      if (!confirm(`Put this action back to the author's value (${entry.declared})?`)) return;
      await post('/api/load-overrides/reset', { modId, key });
      toast('back to the author\'s value');
    } else if (btn.dataset.act === 'discard') {
      // Discarding forgets the intent but leaves the value where the last apply
      // put it. Saying so is the whole point - it is not a reset.
      if (!confirm('Forget this override?\n\nThe value stays where it was last written. Use Reset if you want the author\'s value back.')) return;
      await post('/api/load-overrides/discard', { modId, key });
      toast('override discarded');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('lovSync').addEventListener('click', async () => {
  try {
    const d = await post('/api/load-overrides/sync', {});
    const s = d.sync || {};
    if (!s.changed) toast('nothing needed re-applying');
    else toast(`re-applied ${s.applied} override${s.applied === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

pages['load-overrides'] = { show: lovEditShow };

// ---------------------------------------------------------------------------
// Block-move editor (change load-order-edit, tasks 3.1/3.2/3.3, editor side).
//
// Every new top-level name here carries the lovEdit prefix: classic <script>
// tags share one global scope, so a bare `post`/`load`-style name risks the
// concatenated-parse failure src/phase8-scripts.js exists to catch.
//
// Split of duties: the preview is computed client-side from GET
// /api/load-order bands with the fit/offset algorithm from design.md, and
// apply is POST /api/load-overrides/bulk (src/server.js), which resolves
// each componentRowId server-side and commits one transaction + one backup.

lov.bands = null;
lov.bandsError = '';
lov.profileId = null;
lov.modFilter = '';
lov.expandedMod = null;
lov.moveMod = null;
lov.targetMode = 'after-value';
lov.anchorValue = '';
lov.anchorMod = '';
lov.freeIdx = '';
lov.nofitMode = 'even';
lov.proposal = null;
lov.manual = {};
lov.handoffAction = null;
lov.windowRows = 200;
lov.fileCache = {}; // componentRowId -> [basename]; one batch GET per expanded mod
lov.filesMod = {};  // modId -> true once its batch has landed
lov.filesOpen = {}; // componentRowId -> true when its +N more is expanded

// 3.3: entry from #/load-order carries ?modId &componentRowId. The mod opens
// expanded and selected for the move, the action row is marked. The banner in
// index.html says the rest: edits are global, the profile picker is a filter.
function lovEditShow(params) {
  lov.handoffAction = null;
  const modId = params ? params.get('modId') : null;
  const action = params ? params.get('componentRowId') : null;
  if (modId) {
    lov.expandedMod = modId;
    lov.moveMod = modId;
    if (action != null && /^-?\d+$/.test(action)) lov.handoffAction = Number(action);
  }
  return Promise.resolve()
    .then(() => load())
    .then(() => lovEditLoadBands())
    .catch((err) => toast(err.message, 'err'));
}

// 3.1: the picker reuses GET /api/load-order bands — the same payload the
// read-only view renders — so the editor and the view can never disagree
// about where a value sits. A profile switch re-reads only; it writes nothing.
async function lovEditLoadBands() {
  const q = lov.profileId != null && lov.profileId !== '' ? `?profile=${encodeURIComponent(lov.profileId)}` : '';
  try {
    lov.bands = await api(`/api/load-order${q}`);
    lov.bandsError = '';
  } catch (err) {
    lov.bands = null;
    lov.bandsError = err.message;
  }
  // The profile the server actually answered with wins: a stale id falls back
  // to the active profile rather than rendering another profile's bands.
  if (lov.bands && lov.bands.ok && lov.bands.profile) lov.profileId = String(lov.bands.profile.id);
  lovEditRenderProfile();
  lovEditRenderPicker();
  lovEditRenderTarget();
  lovEditPropose();
}

function lovEditRenderProfile() {
  const d = lov.bands;
  const sel = $('lovProfile');
  if (d && d.ok) {
    sel.innerHTML = (d.groups || []).map((g) => `<option value="${esc(g.id)}"${d.profile && String(g.id) === String(d.profile.id) ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
    const s = d.summary || {};
    $('lovProfileMeta').textContent = d.profile
      ? `${d.profile.name} · ${n(s.modsOn)} mods on · ${n(s.positioned)} positioned`
      : '';
  } else {
    sel.innerHTML = '';
    $('lovProfileMeta').textContent = lov.bandsError ? `Can't read the load order: ${lov.bandsError}` : '';
  }
}

// Per-mod roll-up: positioned count, min, max, width, tie flag, undeclared
// count, protection. Undeclared arrive grouped by mod (counts only) — there
// are no rows to move, which is exactly why they stay out of every mapping.
function lovEditModStats() {
  const d = lov.bands;
  if (!d || !d.ok) return [];
  const mods = new Map();
  const occ = new Map();
  for (const b of d.bands || []) {
    if (b.kind !== 'value') continue;
    occ.set(b.value, (b.actions || []).length);
    for (const a of b.actions || []) {
      if (!mods.has(a.modId)) {
        mods.set(a.modId, {
          modId: a.modId, name: a.modName, rows: [],
          undeclared: 0, unprot: 0, drifted: 0, misspell: 0,
        });
      }
      const m = mods.get(a.modId);
      m.rows.push(a);
      if (!a.protected) m.unprot += 1;
      if (a.state === 'drifted') m.drifted += 1;
      if (a.misspelled) m.misspell += 1;
    }
  }
  for (const u of d.undeclared || []) {
    if (!mods.has(u.modId)) {
      mods.set(u.modId, { modId: u.modId, name: u.name, rows: [], undeclared: 0, unprot: 0, drifted: 0, misspell: 0 });
    }
    mods.get(u.modId).undeclared += u.count;
  }
  const out = [];
  for (const m of mods.values()) {
    m.rows.sort((x, y) => Number(x.effective) - Number(y.effective) || x.componentRowId - y.componentRowId);
    m.count = m.rows.length;
    if (m.count) {
      m.min = Number(m.rows[0].effective);
      m.max = Number(m.rows[m.count - 1].effective);
      m.width = m.max - m.min;
    } else {
      m.min = null; m.max = null; m.width = null;
    }
    // A tie is a shared value, never an ordering: the flag names the condition
    // without sequencing the actions inside it.
    m.tie = m.rows.some((a) => (occ.get(Number(a.effective)) || 0) > 1);
    out.push(m);
  }
  const q = lov.modFilter.trim().toLowerCase();
  return out
    .filter((m) => !q || `${m.name} ${m.modId}`.toLowerCase().includes(q))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function lovEditStatsById(modId) {
  return lovEditModStats().find((m) => String(m.modId) === String(modId)) || null;
}

function lovEditActionLabel(a) {
  return `${a.type || 'action'}${a.id ? ` · ${a.id}` : ''} · row ${a.componentRowId}`;
}

function lovEditActionTags(a) {
  const t = [];
  if (a.state === 'drifted') t.push('<span class="lo-tag lo-drift">changed elsewhere</span>');
  else if (a.state === 'overridden') t.push('<span class="lo-tag lo-override">changed by you</span>');
  if (a.misspelled) t.push('<span class="lo-tag lo-typo">spells LoadOrder wrong</span>');
  if (!a.protected) t.push('<span class="lo-tag lo-unprot">can’t be kept safe</span>');
  return t.join(' ');
}

// Action file lists in the picker: one batch GET per expanded mod, cached per
// action. Up to two basenames inline, the rest behind +N more; no files says so.
function lovEditFilesHtml(files, expanded, rowId) {
  if (!files || !files.length) return '<span class="lo-files">no files</span>';
  if (files.length <= 2 || expanded) {
    return `<span class="lo-files">${files.map((f) => esc(f)).join(', ')}</span>`
      + (files.length > 2 ? ` <button type="button" class="secondary small" data-lov-files="${esc(rowId == null ? '' : rowId)}">show less</button>` : '');
  }
  return `<span class="lo-files">${files.slice(0, 2).map((f) => esc(f)).join(', ')}`
    + ` <button type="button" class="secondary small" data-lov-files="${esc(rowId == null ? '' : rowId)}">+${n(files.length - 2)} more</button></span>`;
}

function lovEditFilesSlot(a) {
  const hit = lov.fileCache[a.componentRowId];
  if (!hit) return '<span class="lo-fileslot">…</span>';
  return `<span class="lo-fileslot">${lovEditFilesHtml(hit, !!lov.filesOpen[a.componentRowId], a.componentRowId)}</span>`;
}

async function lovEditLoadFiles(modId) {
  if ((lov.filesMod || {})[modId]) return;
  const d = await api(`/api/action-files?modId=${encodeURIComponent(modId)}`);
  for (const r of (d && d.actions) || []) lov.fileCache[r.componentRowId] = r.files || [];
  lov.filesMod[modId] = true;
  if (typeof lovEditRenderPicker === 'function') {
    try { lovEditRenderPicker(); } catch (_) { /* picker not on screen */ }
  }
  // The ledger reuses the same cache: a batch that landed for the picker
  // completes the ledger rows of the same mod, and vice versa.
  if (typeof renderOverrides === 'function' && lov.data && lov.data.ok) {
    try { renderOverrides(); } catch (_) { /* ledger not on screen */ }
  }
}

function lovEditPickerRow(m) {
  const open = String(lov.expandedMod) === String(m.modId);
  const range = m.count ? `${n(m.min)} to ${n(m.max)} · width ${n(m.width)}` : 'no positioned actions';
  const flags = [
    m.tie ? '<span class="lo-tag lo-tie">tie — the game picks at random</span>' : '',
    m.undeclared ? `<span class="lo-cond">${n(m.undeclared)} with no position — never moved</span>` : '',
    m.unprot ? `<span class="lo-tag lo-unprot">${n(m.unprot)} can’t be kept safe</span>` : '',
    m.drifted ? `<span class="lo-tag lo-drift">${n(m.drifted)} changed elsewhere</span>` : '',
    m.misspell ? '<span class="lo-tag lo-typo">spells LoadOrder wrong</span>' : '',
    String(lov.moveMod) === String(m.modId) ? '<span class="lo-tag lo-override">chosen to move</span>' : '',
  ].filter(Boolean).join(' ');
  let inner = '';
  if (open) {
    const cap = lov.windowRows;
    const rows = m.rows.slice(0, cap).map((a) => {
      const mark = lov.handoffAction === a.componentRowId ? ' lo-mark' : '';
      return `<div class="lo-row${mark}"${mark ? ' id="lovEditHandoff"' : ''}>`
        + `<span class="lo-mod">${esc(lovEditActionLabel(a))}</span>`
        + `<span class="lo-type">${esc(n(a.effective))}</span>`
        + `<span class="lo-detail">${lovEditActionTags(a)} ${lovEditFilesSlot(a)}</span></div>`;
    }).join('');
    const rest = m.rows.length > cap
      ? `<p class="note">Showing the first ${n(cap)} of ${n(m.rows.length)} actions — the move still covers all ${n(m.rows.length)}.</p>` : '';
    const tieNote = m.tie
      ? '<p class="note">Values shared with other actions are ties: unordered, and the editor never sequences inside one.</p>' : '';
    const und = m.undeclared
      ? `<p class="note">${n(m.undeclared)} undeclared action${m.undeclared === 1 ? '' : 's'} declare${m.undeclared === 1 ? 's' : ''} no position and ${m.undeclared === 1 ? 'is' : 'are'} excluded from the move.</p>` : '';
    inner = `<div class="lov-expand">${tieNote}${und}${rows || '<p class="note">No positioned actions — nothing to move.</p>'}${rest}</div>`;
  }
  return `<div class="lo-row lov-pick${open ? ' lov-open' : ''}" data-lov-mod="${esc(m.modId)}">`
    + `<span class="lo-mod">${renderCivText(m.name)}</span>`
    + `<span class="lo-type">${esc(m.count ? `${m.count} positioned · ${range}` : range)}</span>`
    + `<span class="lo-detail">${flags}</span>`
    + `<span class="lov-actions"><button type="button" class="secondary small" data-lov-expand="${esc(m.modId)}">${open ? 'Collapse' : 'Expand'}</button></span>`
    + `</div>${open ? inner : ''}`;
}

// 183-mod profiles render one row per mod, not one per action: the picker is
// the window. Only the expanded mod renders action rows, capped above.
function lovEditRenderPicker() {
  const box = $('lovPicker');
  if (!lov.bands || !lov.bands.ok) {
    box.innerHTML = `<p class="note">Can't build the picker: ${esc(lov.bandsError || 'no load order data')}.</p>`;
    return;
  }
  const stats = lovEditModStats();
  box.innerHTML = stats.length
    ? stats.map(lovEditPickerRow).join('')
    : '<p class="note">No mods match that filter.</p>';
  const hand = $('lovEditHandoff');
  if (hand) hand.scrollIntoView({ block: 'center' });
}

// ---- target + proposal preview (3.2) ----

function lovEditGapList() {
  const d = lov.bands;
  const gaps = [];
  if (!d || !d.ok) return gaps;
  (d.bands || []).forEach((b, i) => {
    if (b.kind === 'free') gaps.push({ idx: i, from: b.from, to: b.to, count: b.count, label: `${n(b.from)} to ${n(b.to)} — room for ${n(b.count)}` });
    else if (b.kind === 'headroom') gaps.push({ idx: i, from: b.from, to: null, count: null, label: `everything above ${n(b.from - 1)} (open-ended, no top)` });
  });
  return gaps;
}

function lovEditGlobals() {
  const d = lov.bands;
  const g = { min: null, max: null, occupied: new Map() };
  for (const b of (d && d.ok && d.bands) || []) {
    if (b.kind !== 'value') continue;
    if (g.min === null || b.value < g.min) g.min = b.value;
    if (g.max === null || b.value > g.max) g.max = b.value;
    g.occupied.set(b.value, (b.actions || []).slice());
  }
  return g;
}

function lovEditRenderTarget() {
  const stats = lovEditModStats();
  const movable = stats.filter((m) => m.count);
  const am = $('lovAnchorMod');
  am.innerHTML = movable.map((m) => `<option value="${esc(m.modId)}">${esc(`${stripCivText(m.name)} (${m.min} to ${m.max})`)}</option>`).join('');
  if (lov.anchorMod && movable.some((m) => String(m.modId) === String(lov.anchorMod))) am.value = lov.anchorMod;
  else if (lov.moveMod && movable.some((m) => String(m.modId) === String(lov.moveMod))) am.value = lov.moveMod;
  const gaps = lovEditGapList();
  const fb = $('lovFreeBand');
  fb.innerHTML = gaps.length
    ? gaps.map((x) => `<option value="${x.idx}">${esc(x.label)}</option>`).join('')
    : '<option value="">no free bands</option>';
  if (lov.freeIdx !== '' && gaps.some((x) => String(x.idx) === String(lov.freeIdx))) fb.value = lov.freeIdx;
  $('lovTargetMode').value = lov.targetMode;
  const isMod = lov.targetMode === 'after-mod' || lov.targetMode === 'before-mod';
  const isFree = lov.targetMode === 'free';
  $('lovAnchorValue').hidden = isMod || isFree;
  am.hidden = !isMod;
  fb.hidden = !isFree;
  const m = movable.find((x) => String(x.modId) === String(lov.moveMod)) || null;
  $('lovEditCount').textContent = m ? `${n(m.count)} positioned · width ${n(m.width)}` : '';
}

function lovEditReadTarget() {
  lov.targetMode = $('lovTargetMode').value;
  lov.anchorValue = $('lovAnchorValue').value;
  lov.anchorMod = $('lovAnchorMod').value;
  lov.freeIdx = $('lovFreeBand').value;
}

// Anchor (before/after a value or a mod's band) or a free band straight from
// this profile's own bands. Returns {gap, base} or {error}; a null gap means
// unbounded below (before everything), which always fits.
function lovEditResolveTarget(m) {
  const gaps = lovEditGapList();
  if (!gaps.length) return { error: 'this profile has no empty gaps' };
  const mode = lov.targetMode;
  if (mode === 'free') {
    const gap = gaps.find((x) => String(x.idx) === String(lov.freeIdx)) || gaps[0];
    return { gap, base: gap.from };
  }
  let v;
  if (mode === 'after-mod' || mode === 'before-mod') {
    const am = lovEditStatsById(lov.anchorMod) || m;
    if (!am || !am.count) return { error: 'the other mod has nothing positioned to sit next to' };
    v = mode === 'after-mod' ? am.max : am.min;
  } else {
    const t = String(lov.anchorValue).trim();
    if (!/^-?\d+$/.test(t)) return { error: 'type a whole number to sit next to' };
    v = Number(t);
  }
  if (mode === 'after-value' || mode === 'after-mod') {
    // The proposal uses the first free run at or after the anchor.
    const start = v + 1;
    const gap = gaps.find((x) => x.from <= start && (x.to === null || start <= x.to))
      || gaps.find((x) => x.from > start);
    if (!gap) return { error: 'no empty gap at or after that spot' };
    return { gap, base: Math.max(gap.from, start) };
  }
  // Snug below the anchor, mirroring the server {before}: the block ends at
  // V-1, so base = (V-1) - width. Another mod's value inside the block is a
  // clash: no-fit (even/spill-below/manual), never a jump to a far run. The
  // block's own values free up once it moves, so only others count.
  const end = v - 1;
  const base = end - m.width;
  const moved = new Set(((m && m.rows) || []).map((a) => a.componentRowId));
  let prev = null;
  for (const [val, holders] of lovEditGlobals().occupied) {
    if (val < v && (holders || []).some((a) => !moved.has(a.componentRowId))
      && (prev === null || val > prev)) prev = val;
  }
  if (prev === null) return { gap: null, base };
  const from = prev + 1;
  const count = Math.max(0, end - from + 1);
  return { gap: { idx: 'before', from, to: end, count,
    label: `${n(from)} to ${n(end)} — room for ${n(count)}` }, base, clash: prev >= base };
}

// The proposeBlock contract (design.md), client-side: on fit, new = base +
// offset, preserving spread and order. On no-fit the block is never squeezed
// silently — even re-space, spill-below, or manual, always with need-vs-gap.
// Spill is below-only; the open-ended free band covers the other end.
function lovEditBuildMapping(rows, m, mode, base, gap) {
  const offs = rows.map((a) => Number(a.effective) - m.min);
  if (mode === 'fit') {
    return rows.map((a, i) => ({ action: a, old: Number(a.effective), proposed: base + offs[i] }));
  }
  if (mode === 'even') {
    if (gap && gap.to !== null) {
      const c = gap.count, k = rows.length;
      if (k === 1) return [{ action: rows[0], old: Number(rows[0].effective), proposed: gap.from }];
      return rows.map((a, i) => ({ action: a, old: Number(a.effective), proposed: gap.from + Math.round((i * (c - 1)) / (k - 1)) }));
    }
    return rows.map((a, i) => ({ action: a, old: Number(a.effective), proposed: base + i }));
  }
  if (mode === 'overflow-below') {
    const g = lovEditGlobals();
    const b = (g.min === null ? 0 : g.min) - m.width - 1;
    return rows.map((a, i) => ({ action: a, old: Number(a.effective), proposed: b + offs[i] }));
  }
  return null; // manual is read from its inputs, not built
}

function lovEditReadManual(rows) {
  const box = $('lovManual');
  const inputs = box ? box.querySelectorAll('input[data-lov-row]') : [];
  const byId = new Map(rows.map((a) => [String(a.componentRowId), a]));
  const mapping = [];
  const bad = [];
  inputs.forEach((el) => {
    const t = el.value.trim();
    if (t === '') return;
    const a = byId.get(el.dataset.lovRow);
    if (!a) return;
    if (!/^-?\d+$/.test(t)) { bad.push(el.dataset.lovRow); return; }
    mapping.push({ action: a, old: Number(a.effective), proposed: Number(t) });
  });
  // Explicit pick (spec: manual may name an undeclared action): the extra row
  // names a componentRowId directly. A positioned id resolves to its row;
  // anything else becomes an explicitly-picked undeclared entry — old null,
  // applied only because the user named it here. Listed last so it wins when
  // both rows name the same action (the server applies last-wins per key).
  const xRow = box ? box.querySelector('input[data-lov-extra-row]') : null;
  const xVal = box ? box.querySelector('input[data-lov-extra-val]') : null;
  const xr = xRow ? xRow.value.trim() : '';
  const xv = xVal ? xVal.value.trim() : '';
  if (xr !== '' || xv !== '') {
    if (!/^-?\d+$/.test(xr) || !/^-?\d+$/.test(xv)) { bad.push(xr || 'explicit'); }
    else {
      const a = byId.get(xr);
      if (a) mapping.push({ action: a, old: Number(a.effective), proposed: Number(xv) });
      else {
        const modId = rows.length ? rows[0].modId : lov.moveMod;
        mapping.push({ action: { componentRowId: Number(xr), modId, type: 'undeclared action', id: '', effective: null, undeclaredPick: true }, old: null, proposed: Number(xv) });
      }
    }
  }
  return { mapping, bad };
}

function lovEditRenderManual(rows, prefill) {
  const gaps = lovEditGapList();
  const hint = gaps.length ? `Empty gaps here: ${esc(gaps.map((x) => x.label).join(' · '))}` : 'No empty gaps in this profile.';
  const pre = new Map((prefill || []).map((r) => [String(r.action.componentRowId), r.proposed]));
  const cap = lov.windowRows;
  const box = $('lovManual');
  // Tags the box with the mod it was rendered for: propose() treats a box
  // from another mod as stale input, never as values for this mod.
  box.dataset.lovMod = String(rows.length ? rows[0].modId : (lov.moveMod || ''));
  box.innerHTML = `<p class="note">${hint} Whole numbers only; leave blank to leave a thing out.</p>`
    + rows.slice(0, cap).map((a) => `<div class="lo-row"><span class="lo-mod">${esc(lovEditActionLabel(a))}</span>`
      + `<span class="lo-type">now ${esc(n(a.effective))}</span>`
      + `<span class="lov-actions"><input data-lov-row="${a.componentRowId}" type="text" inputmode="numeric" placeholder="new number…" value="${pre.has(String(a.componentRowId)) ? pre.get(String(a.componentRowId)) : ''}" /></span></div>`).join('')
    + (rows.length > cap ? `<p class="note">Showing the first ${n(cap)} of ${n(rows.length)} — the move still covers all.</p>` : '')
    + '<div class="lo-row"><span class="lo-mod">Name a thing with no position, explicitly</span>'
    + '<span class="lo-type">row number → new number</span>'
    + '<span class="lov-actions"><input data-lov-extra-row="" type="text" inputmode="numeric" placeholder="row number…" />'
    + ' <input data-lov-extra-val="" type="text" inputmode="numeric" placeholder="new number…" /></span></div>'
    + '<p class="note">Things with no position are never moved automatically — only one you name above gets a number. The server resolves the number on apply: an unknown one is reported as orphaned and not written.</p>';
}

// Honest warnings, never gates (no-fit blocks auto-placement instead):
// tie creation, drifted state, sentinel load-last, misspelling,
// unprotectable. Shared filenames are NEVER treated as conflicts — dozens of
// mods can share one filename and the editor stays silent about it.
function lovEditWarningsFor(mapping) {
  const g = lovEditGlobals();
  const moved = new Set(mapping.map((r) => r.action.componentRowId));
  const seen = new Set();
  const out = [];
  const push = (w) => { if (!seen.has(w)) { seen.add(w); out.push(w); } };
  for (const r of mapping) {
    const others = (g.occupied.get(r.proposed) || []).filter((a) => !moved.has(a.componentRowId));
    if (others.length) push(`tie at ${n(r.proposed)}: ${n(others.length)} action${others.length === 1 ? '' : 's'} outside this block already sit${others.length === 1 ? 's' : ''} there — the game picks arbitrarily`);
    if (r.proposed >= 10000000) push(`sentinel load-last: ${n(r.proposed)} means "override everything" in Civ6`);
    const a = r.action;
    if (a.state === 'drifted') push(`drifted row ${a.componentRowId}: the database has ${a.effective}, the stored override says ${a.override ? a.override.value : '?'} — this proposal applies over drift`);
    if (a.misspelled) push(`misspelled property on row ${a.componentRowId}: the mod spells LoadOrder wrong — check which property the game actually reads`);
    // An explicitly-picked undeclared row carries no protection flag: the
    // bands payload groups undeclared as counts, so the preview cannot know
    // and the server reports unprotectable on apply instead of a guess here.
    if (!a.protected && !a.undeclaredPick) push(`unprotectable row ${a.componentRowId}: its .modinfo is not on disk, so no stamp can keep the value`);
  }
  return out;
}

function lovEditMarkNofitSeg() {
  $('lovNofitSeg').querySelectorAll('button[data-nofit]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.nofit === lov.nofitMode ? 'true' : 'false');
  });
}

// Spill is below-only: the segmented option for the other end is removed from
function lovEditPropose() {
  lov.proposal = null;
  // No lovManual clear here: in manual mode Preview is the submit action for
  // hand-typed values, so the manual branch below must read them first.
  $('lovWarnings').innerHTML = '';
  $('lovPreview').innerHTML = '';
  $('lovNeedGap').textContent = '';
  $('lovApply').disabled = true;
  $('lovApplyMeta').textContent = '';
  const m = lov.moveMod ? lovEditStatsById(lov.moveMod) : null;
  if (!m || !m.count) {
    $('lovManual').innerHTML = '';
    $('lovNeedGap').textContent = 'Open a mod that has something positioned to start a move.';
    $('lovNofit').hidden = true;
    return;
  }
  const rows = m.rows;
  const need = m.width; // spec + server convention: need is the width itself (proposeBlock reports need = width)
  const t = lovEditResolveTarget(m);
  if (t.error) {
    $('lovManual').innerHTML = '';
    $('lovNeedGap').textContent = t.error;
    $('lovNofit').hidden = true;
    return;
  }
  const gapSize = !t.gap || t.gap.to === null ? Infinity : t.gap.count;
  // A before-anchor clash is no-fit even when the raw count covers the
  // width: the end value itself (or the base) is held by another mod.
  const fit = need <= gapSize && !t.clash;
  // Spill is below-only now; a stale spill-above choice falls back to even
  // rather than previewing nothing.
  if (!fit && lov.nofitMode !== 'even' && lov.nofitMode !== 'overflow-below' && lov.nofitMode !== 'manual') {
    lov.nofitMode = 'even';
  }
  const mode = fit ? 'fit' : lov.nofitMode;
  $('lovNofit').hidden = fit;
  // Need-vs-gap up front, in values, before any table.
  const gapText = gapSize === Infinity ? 'open-ended' : n(gapSize);
  $('lovNeedGap').textContent = fit
    ? `Fits: this block spans ${n(need)} value${need === 1 ? '' : 's'} and the gap holds ${gapText}. Each thing keeps its spacing: new number = ${n(t.base)} + its old offset.`
    : `No fit: this block spans ${n(need)} value${need === 1 ? '' : 's'} but the gap holds ${gapText}. Nothing written — spread it evenly, spill below, or type each number.`;
  lovEditMarkNofitSeg();
  let mapping;
  if (!fit && mode === 'manual') {
    // The box still holds what the user typed — Preview submits it. A box
    // rendered for another mod is stale and counts as no input, so a typed
    // action id can never leak into the wrong mod's proposal.
    const box = $('lovManual');
    const fresh = String((box.dataset && box.dataset.lovMod) || '') === String(m.modId);
    const read = fresh ? lovEditReadManual(rows) : { mapping: [], bad: [] };
    const hasInputs = fresh && box.querySelectorAll('input[data-lov-row]').length > 0;
    box.innerHTML = '';
    if (read.bad.length) {
      $('lovNeedGap').textContent += ` ${n(read.bad.length)} box${read.bad.length === 1 ? ' is' : 'es are'} not a whole number — nothing previewed.`;
      return;
    }
    if (hasInputs && read.mapping.length) {
      mapping = read.mapping;
    } else {
      // First pass renders inputs prefilled with the fit-shaped suggestion;
      // the user edits, then Previews again.
      lovEditRenderManual(rows, lovEditBuildMapping(rows, m, 'fit', t.base, t.gap));
      $('lovNeedGap').textContent += ' Type numbers below, then preview again.';
      return;
    }
  } else {
    $('lovManual').innerHTML = '';
    mapping = lovEditBuildMapping(rows, m, mode, t.base, t.gap);
  }
  const warns = lovEditWarningsFor(mapping);
  lov.proposal = { modId: m.modId, mode, base: t.base, need, gapSize: gapSize === Infinity ? null : gapSize, mapping, warnings: warns };
  $('lovWarnings').innerHTML = warns.map((w) => `<div class="alert warn">${renderCivText(w)}</div>`).join('');
  const cap = lov.windowRows;
  $('lovPreview').innerHTML = mapping.slice(0, cap).map((r) =>
    `<div class="lo-row"><span class="lo-mod">${esc(lovEditActionLabel(r.action))}</span>`
    + `<span class="lo-type">${esc(r.old === null || r.old === undefined ? 'undeclared' : n(r.old))} → ${esc(n(r.proposed))}</span></div>`).join('')
    + (mapping.length > cap ? `<p class="note">Showing the first ${n(cap)} of ${n(mapping.length)}.</p>` : '');
  $('lovApply').disabled = !mapping.length;
  $('lovApplyMeta').textContent = mapping.length ? `${n(mapping.length)} things to move · written in one step, never while the game is running` : '';
}

// Client preview, server apply — both live, no fallback involved.
// The preview above is computed client-side from GET /api/load-order bands
// with the fit/offset algorithm from design.md, so it always agrees with
// the read-only view. Apply is POST /api/load-overrides/bulk (src/server.js):
// lovEditApplyPacket() is the request body, one entry per action identified
// by componentRowId. The server resolves each id (stale rows report orphaned,
// twins ambiguous — never written) and commits in one mutateDb transaction
// with one backup, refused while Civ6 runs. Never by filename: shared
// filenames are not conflicts.
function lovEditApplyPacket() {
  const p = lov.proposal;
  if (!p) return { entries: [] };
  return {
    entries: p.mapping.map((r) => ({
      modId: r.action.modId,
      componentRowId: r.action.componentRowId,
      value: r.proposed,
    })),
  };
}

async function lovEditApply() {
  const p = lov.proposal;
  if (!p || !p.mapping.length) return;
  // eslint-disable-next-line no-alert
  if (p.mapping.some((r) => r.proposed >= 10000000) && !confirm('One or more values mean "load last, override everything" in Civ6. Carry on?')) return;
  $('lovApply').disabled = true;
  try {
    const d = await postJson('/api/load-overrides/bulk', lovEditApplyPacket());
    if (d && d.overrides) {
      lov.data = d;
      renderOverrides();
    }
    await lovEditLoadBands();
    toast('block move applied');
  } catch (err) {
    if (/404|not found/i.test(err.message || '')) {
      $('lovApplyMeta').textContent = 'The server has no bulk route at this address — nothing was written. The preview above is unchanged.';
      toast('bulk apply is not available on this server — nothing was written', 'err');
    } else {
      $('lovApplyMeta').textContent = err.message;
      toast(err.message, 'err');
    }
  } finally {
    $('lovApply').disabled = !(lov.proposal && lov.proposal.mapping.length);
  }
}

$('lovModFilter').addEventListener('input', (e) => { lov.modFilter = e.target.value; lovEditRenderPicker(); });
$('lovProfile').addEventListener('change', (e) => {
  // A subset filter: re-read bands, write nothing.
  lov.profileId = e.target.value;
  lovEditLoadBands().catch((err) => toast(err.message, 'err'));
});
$('lovPicker').addEventListener('click', (e) => {
  const fbtn = e.target.closest('button[data-lov-files]');
  if (fbtn) {
    const id = fbtn.dataset.lovFiles;
    lov.filesOpen[id] = !lov.filesOpen[id];
    const slot = fbtn.closest('.lo-fileslot');
    if (slot) slot.innerHTML = lovEditFilesHtml(lov.fileCache[id] || [], !!lov.filesOpen[id], id);
    return;
  }
  const btn = e.target.closest('button[data-lov-expand]');
  if (!btn) return;
  const id = btn.dataset.lovExpand;
  lov.expandedMod = String(lov.expandedMod) === String(id) ? null : id;
  if (lov.expandedMod) lov.moveMod = lov.expandedMod;
  lovEditRenderPicker();
  lovEditRenderTarget();
  lovEditPropose();
  if (lov.expandedMod) lovEditLoadFiles(lov.expandedMod).catch((err) => toast(err.message, 'err'));
});
$('lovTargetMode').addEventListener('change', () => { lovEditReadTarget(); lovEditRenderTarget(); lovEditPropose(); });
$('lovPropose').addEventListener('click', () => { lovEditReadTarget(); lovEditRenderTarget(); lovEditPropose(); });
$('lovAnchorValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') { lovEditReadTarget(); lovEditRenderTarget(); lovEditPropose(); } });
$('lovNofitSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-nofit]');
  if (!b) return;
  if (b.dataset.nofit !== 'even' && b.dataset.nofit !== 'overflow-below' && b.dataset.nofit !== 'manual') return;
  lov.nofitMode = b.dataset.nofit;
  lovEditReadTarget();
  lovEditPropose();
});
$('lovApply').addEventListener('click', lovEditApply);
