'use strict';

// The load order view: one profile's load order, as one flat list.
//
// This page READS. There is no control on it that changes a value, and the
// button that says "Manage overrides" navigates to a different screen. That is
// not a style choice - the handoff for this feature was explicit that the two
// problems it covers were conflated for a long time and must not be again:
//
//   problem 1, authoring:  which values are taken, which are free, where does
//                          mine go?                     <- this page
//   problem 2, reordering: this mod is in the wrong band, move it
//                                                          <- load-overrides
//
// The list is the answer rather than a dashboard about it. "Where does mine
// sit" is answered by its neighbours, so the useful thing is the ordered list
// itself, with the gaps in it.

const lo = {
  data: null,
  filter: '',
  mode: 'mod',      // 'mod': exact-name text field; 'action': component-type dropdown
  typeFilter: '',   // component type in action mode; '' means all types
  compareWith: null,
  marked: null,   // a mod id, when arriving from the mod list
  onlyOff: false, // rows that will not run are noise unless asked for
  fileCache: {},  // componentRowId -> [basename]; fetched on demand, never in the list payload
  filesOpen: {},  // componentRowId -> true when its +N more is expanded
};

function loMatches(a, q, t) {
  if (t) return a.type === t;
  if (!q) return true;
  return String(a.modName || '').toLowerCase() === q;
}

// The note explaining the shape of the list. It is here rather than in a dialog
// because what needs explaining is why there are gaps in the thing you are
// looking at.
function noteHtml(s) {
  return `<p>Load order is declared per <b>action</b>, not per mod. Most actions
    declare nothing, and where two share a value the game picks arbitrarily and
    neither is first. <b>${esc(n(s.modsOn))}</b> mods are on here, carrying
    <b>${esc(n(s.actions))}</b> actions &mdash; <b>${esc(n(s.positioned))}</b>
    of them positioned across <b>${esc(n(s.distinctValues))}</b> values,
    ${esc(n(s.min))} to ${esc(n(s.max))}.</p>`;
}

function stateBadge(a) {
  if (a.state === 'overridden') return '<span class="lo-tag lo-override">changed by you</span>';
  if (a.state === 'drifted') return '<span class="lo-tag lo-drift">changed elsewhere</span>';
  return '';
}

// Rows decided by assertion carry the verdict's assumed flag, and read
// differently from measured rows by construction: measured rows never carry
// it, so loAssumedTag is empty for them and their HTML is byte-identical
// with nothing asserted. The tag says what it is in the same short language
// as the other tags ("changed by you", "can't be kept safe"); the title
// says what to do next.
function loAssumedTag(a) {
  if (!a || !a.assumed) return '';
  return '<span class="lo-tag lo-assumed" title="Decided by your asserted game setup, never measured — change it in the game-setup panel">assumed setup</span>';
}

function conditionLine(a) {
  if (a.willRun === false) return `<span class="lo-cond lo-off">not run &mdash; ${renderCivText(a.reason)}</span>${loAssumedTag(a)}`;
  if (a.willRun === null && a.unknown && a.unknown.length) {
    // Name the first thing it could not decide, and say how many others there
    // are. Showing only the first reads as "this is the one thing", which is a
    // claim the row has not earned when a set gates on four unreadable conditions.
    const more = a.unknown.length - 1;
    return `<span class="lo-cond lo-unknown">? ${renderCivText(a.unknown[0].why)}`
      + (more > 0 ? ` <span class="lo-cond-more">and ${n(more)} more it cannot see</span>` : '')
      + '</span>';
  }
  return '';
}

// The one control on this page that reaches toward editing, and it does not
// edit: it navigates to #/load-overrides carrying the action's identity
// (modId + componentRowId), which the editor resolves server-side via
// actionKey/resolveAction. View rows deliberately carry no action key -
// building one per action would cost a key build per row per request - so the
// row id is what crosses the handoff. No POST, no value mutation.
function loOverrideControl(a) {
  if (a.modId == null || a.componentRowId == null) return '';
  return `<span class="lov-actions"><button type="button" class="secondary small" data-lo-override="${esc(a.modId)}" data-lo-action="${esc(a.componentRowId)}">Override&hellip;</button></span>`;
}

// Action file lists, fetched on demand per row and cached above: the list
// payload carries no per-action file joins. Up to two basenames inline, the
// rest behind +N more; an action with no files says so.
function loFilesHtml(files, expanded, rowId) {
  if (!files || !files.length) return '<span class="lo-files">no files</span>';
  if (files.length <= 2 || expanded) {
    return `<span class="lo-files">${files.map((f) => esc(f)).join(', ')}</span>`
      + (files.length > 2 ? ` <button type="button" class="secondary small" data-lo-files-toggle="${esc(rowId == null ? '' : rowId)}">show less</button>` : '');
  }
  return `<span class="lo-files">${files.slice(0, 2).map((f) => esc(f)).join(', ')}`
    + ` <button type="button" class="secondary small" data-lo-files-toggle="${esc(rowId == null ? '' : rowId)}">+${n(files.length - 2)} more</button></span>`;
}

function loFilesSlot(a) {
  if (a.componentRowId == null) return '';
  const hit = lo.fileCache[a.componentRowId];
  if (!hit) return `<span class="lo-fileslot"><button type="button" class="secondary small" data-lo-files="${esc(a.componentRowId)}">files</button></span>`;
  return `<span class="lo-fileslot">${loFilesHtml(hit, !!lo.filesOpen[a.componentRowId], a.componentRowId)}</span>`;
}

async function loFilesLoad(rowId, slot) {
  try {
    const d = await api(`/api/action-files?componentRowId=${encodeURIComponent(rowId)}`);
    lo.fileCache[rowId] = d.files || [];
  } catch (err) {
    slot.innerHTML = `<span class="lo-cond">${esc(err.message)}</span>`;
    return;
  }
  slot.innerHTML = loFilesHtml(lo.fileCache[rowId], !!lo.filesOpen[rowId], rowId);
}

function loOverrideHash(modId, componentRowId) {
  const q = new URLSearchParams({ modId: String(modId), componentRowId: String(componentRowId) });
  return `#/load-overrides?${q}`;
}

function actionRow(a) {
  const bits = [];
  if (a.inCompare === false) bits.push('<span class="lo-diff lo-diff-rm">not in the compared profile</span>');
  if (a.inCompare === true) bits.push('<span class="lo-diff lo-diff-same">in both profiles</span>');
  if (a.willRun !== true) bits.push(conditionLine(a));
  // Will-run rows have no condition line, so an assumed run would read as a
  // measured run without its own marker. (Assumed not-run rows carry it in
  // conditionLine above; undecided rows are never assumed.)
  if (a.willRun === true && a.assumed) bits.push(loAssumedTag(a));
  if (a.override) {
    bits.push(stateBadge(a));
    if (a.state === 'drifted') {
      // Drifted means the author changed it, or the game re-derived it. Either
      // way the two numbers are worth seeing side by side.
      bits.push(`<span class="lo-ov">author declares ${esc(n(a.declared))}, the database has ${esc(n(a.effective))}</span>`);
    } else {
      bits.push(`<span class="lo-ov">author declares ${esc(n(a.declared))}, yours is ${esc(n(a.override.value))}</span>`);
    }
  }
  if (a.misspelled) bits.push('<span class="lo-tag lo-typo">spells LoadOrder wrong</span>');
  if (!a.protected) bits.push('<span class="lo-tag lo-unprot">can’t be kept safe</span>');

  return `<div class="lo-row${lo.marked === a.modId ? ' lo-mark' : ''}">
    <span class="lo-mod">${renderCivText(a.modName)}</span>
    <span class="lo-type">${esc(a.type)}</span>
    ${loFilesSlot(a)}
    <span class="lo-detail">${bits.filter(Boolean).join(' ')}</span>
    ${loOverrideControl(a)}
  </div>`;
}

function bandHtml(b) {
  if (b.kind === 'free') {
    return `<div class="lo-band lo-free" data-free="1">
      <span class="lo-value">&mdash;</span>
      <span class="lo-bandnote">${esc(n(b.from))} to ${esc(n(b.to))} &mdash; ${esc(n(b.count))} values nothing claims</span>
    </div>`;
  }
  if (b.kind === 'headroom') {
    return `<div class="lo-band lo-free" data-free="1">
      <span class="lo-value">&mdash;</span>
      <span class="lo-bandnote">everything above ${esc(n(b.from - 1))} is free</span>
    </div>`;
  }
  return `<div class="lo-band${b.tie ? ' lo-tie' : ''}">
    <div class="lo-bandhead">
      <span class="lo-value">${esc(n(b.value))}</span>
      <span class="lo-bandnote">${b.actions.length} action${b.actions.length === 1 ? '' : 's'}${b.tie ? ' &mdash; a tie, the game picks arbitrarily' : ''}</span>
    </div>
    ${b.actions.map(actionRow).join('')}
  </div>`;
}

function renderList() {
  const d = lo.data;
  const list = $('loList');
  if (!d || !d.ok) { list.innerHTML = ''; return; }
  const loModMode = lo.mode !== 'action';
  const q = loModMode ? lo.filter.trim().toLowerCase() : '';
  const loType = loModMode ? '' : lo.typeFilter;

  let html = '';
  let shown = 0;
  for (const b of d.bands) {
    if (b.kind === 'free' || b.kind === 'headroom') { html += bandHtml(b); continue; }
    // A filter keeps the band and its value, so the list stays a list of
    // positions rather than collapsing to a list of matching actions.
    //
    // `narrowing`, not `q`: "only what will not run" narrows the list just as much
    // as the text box does, and testing only `q` meant the button discarded its own
    // filter and showed every row while claiming to show fewer.
    const narrowing = q || loType || lo.onlyOff;
    const keep = b.actions.filter((a) => loMatches(a, q, loType) && (!lo.onlyOff || a.willRun === false));
    if (narrowing && !keep.length) continue;
    const visible = narrowing ? keep : b.actions;
    shown += visible.length;
    html += bandHtml({ ...b, actions: visible, tie: visible.length > 1 });
  }
  // A text or type filter that matches no action is an empty state, not a list
  // of gaps: the free rows always render, so `html` is never empty for that.
  const loEmpty = (q || loType) && !shown;
  list.innerHTML = loEmpty
    ? (q
      ? '<p class="note">No mod is named exactly that — the mod filter matches whole names only.</p>'
      : '<p class="note">Nothing matches that filter.</p>')
    : (html || '<p class="note">Nothing matches that filter.</p>');
  // Both narrowings are named, not just the text one: a list that silently shows
  // 331 rows instead of 1,762 reads as a different profile rather than a filter.
  const bits = [];
  if (lo.onlyOff) bits.push('only what will not run');
  if (q) bits.push('matching the filter');
  else if (loType) bits.push(`of kind ${loType}`);
  $('loShown').textContent = bits.length
    ? `${shown} of ${d.summary.actions} actions - ${bits.join(', ')}`
    : '';
}

function renderUndeclared() {
  const d = lo.data;
  const ok = d && d.ok;
  $('loUndeclaredCount').textContent = ok ? n(d.undeclaredTotal) : '';
  $('loUndeclaredNote').innerHTML = ok
    ? `<p><b>${esc(n(d.undeclaredTotal))}</b> of the <b>${esc(n(d.summary.actions))}</b> actions
       in this profile declare no LoadOrder at all. Their order is whatever the game
       decides &mdash; not yours, and not ours. A mod with a long list here is relying on
       ordering nobody controls.</p>`
    : '';
  const uq = ok && lo.mode !== 'action' ? lo.filter.trim().toLowerCase() : '';
  const urows = !ok ? [] : (uq ? d.undeclared.filter((m) => String(m.name || '').toLowerCase() === uq) : d.undeclared);
  $('loUndeclared').innerHTML = !ok || !d.undeclared.length
    ? '<p class="note">Every action in this profile declares a position.</p>'
    : urows.length
      ? urows.map((m) => `<div class="lo-row"><span class="lo-mod">${renderCivText(m.name)}</span><span class="lo-detail">${esc(n(m.count))} actions</span></div>`).join('')
      : '<p class="note">No mod is named exactly that — the mod filter matches whole names only.</p>';
}

function renderUnmatched() {
  const d = lo.data;
  const panel = $('loUnmatchedPanel');
  if (!d || !d.ok || !d.unmatched.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('loUnmatchedCount').textContent = d.unmatched.length;
  $('loUnmatched').innerHTML = d.unmatched.map((u) => `<div class="lo-row">
      <span class="lo-mod">${esc(u.modId)}</span>
      <span class="lo-type">${esc(u.state)}</span>
      <span class="lo-detail">${u.state === 'ambiguous'
        ? `${u.candidates} actions in that mod match this key, so the toolkit will not choose between them`
        : 'no action in that mod matches this key any more'}</span>
    </div>`).join('');
}

function renderAlerts() {
  const d = lo.data;
  const alerts = [];
  if (d && !d.ok) alerts.push(`<div class="alert warn"><b>Can't read the load order.</b> ${esc(d.error || '')}</div>`);
  if (d && d.stale && d.stale.stale && d.stale.stale.length) {
    alerts.push(`<div class="alert warn"><b>${d.stale.stale.length} mod${d.stale.stale.length === 1 ? '' : 's'} updated since your last sync.</b>
      Open the toolkit before playing, so your overrides are re-applied first.</div>`);
  }
  if (d && d.labelsError) {
    alerts.push(`<div class="alert warn"><b>Problem with your load order overrides.</b> ${esc(d.labelsError)} Showing none until it is fixed.</div>`);
  }
  $('loAlerts').innerHTML = alerts.join('');
}

function renderHeader() {
  const d = lo.data;
  const s = d && d.ok ? d.summary : null;
  $('loSummary').textContent = s
    ? [`${n(s.modsOn)} mods on`, `${n(s.actions)} actions`,
       s.willNotRun ? `${n(s.willNotRun)} will not run` : null,
       s.unknown ? `${n(s.unknown)} cannot be decided` : null,
       s.unmatched ? `${n(s.unmatched)} override${s.unmatched === 1 ? '' : 's'} no longer match` : null]
      .filter(Boolean).join(' · ')
    : '';
  $('loNote').innerHTML = s ? noteHtml(s) : '';

  const sel = $('loProfile');
  if (d) sel.innerHTML = d.groups.map((g) => `<option value="${g.id}"${d.profile && g.id === d.profile.id ? ' selected' : ''}>${esc(groupLabel(g))}</option>`).join('');

  const cmp = d && d.compare;
  $('loCompare').hidden = !cmp;
  $('loCompare').textContent = cmp ? `Comparing with "${groupLabel(cmp)}" — clear` : 'Clear comparison';
}

// Component types for the action-mode dropdown, derived from the loaded
// profile's own band data rather than a server route: the bands already
// carry every positioned action's type.
function loSyncTypeOptions() {
  const sel = $('loTypeFilter');
  if (!sel) return;
  const seen = new Set();
  const d = lo.data;
  if (d && d.ok) {
    for (const b of d.bands) {
      if (!b || b.kind !== 'value' || !b.actions) continue;
      for (const a of b.actions) if (a && a.type) seen.add(a.type);
    }
  }
  const prev = lo.typeFilter || '';
  sel.innerHTML = ['<option value="">All kinds</option>',
    ...[...seen].sort().map((t) => `<option value="${esc(t)}"${t === prev ? ' selected' : ''}>${esc(t)}</option>`)].join('');
  if (prev && !seen.has(prev)) lo.typeFilter = '';
  sel.value = lo.typeFilter || '';
}

function renderLoOrder() {
  renderAlerts();
  renderHeader();
  loSyncTypeOptions();
  renderList();
  renderUndeclared();
  renderUnmatched();
  markScroll();
}

// Arriving from a mod row marks that mod's rows rather than filtering to them.
// A filtered list would show only that mod, which answers none of the question
// the user clicked it to ask.
function markScroll() {
  if (!lo.marked) return;
  const el = document.querySelector('#loList .lo-mark');
  if (el) el.scrollIntoView({ block: 'center' });
}

async function loadLoOrder() {
  const params = new URLSearchParams();
  if (lo.compareWith != null) params.set('compare', lo.compareWith);
  try {
    lo.data = await api(`/api/load-order${params.toString() ? `?${params}` : ''}`);
  } catch (err) {
    lo.data = { ok: false, error: err.message, groups: [], bands: [], summary: {}, undeclared: [] };
  }
  renderLoOrder();
}

$('loFilter').addEventListener('input', (e) => { lo.filter = e.target.value; renderList(); renderUndeclared(); });
$('loTypeFilter').addEventListener('change', (e) => { lo.typeFilter = e.target.value; renderList(); });
// Navigation only. This handler carries identity into the hash and writes
// nothing: the view stays read-only by construction, asserted in phase7.
$('loList').addEventListener('click', (e) => {
  const fbtn = e.target.closest('button[data-lo-files]');
  if (fbtn) {
    const slot = fbtn.closest('.lo-fileslot');
    if (slot) loFilesLoad(fbtn.dataset.loFiles, slot).catch((err) => toast(err.message, 'err'));
    return;
  }
  const tbtn = e.target.closest('button[data-lo-files-toggle]');
  if (tbtn) {
    const id = tbtn.dataset.loFilesToggle;
    lo.filesOpen[id] = !lo.filesOpen[id];
    const slot = tbtn.closest('.lo-fileslot');
    if (slot) slot.innerHTML = loFilesHtml(lo.fileCache[id] || [], !!lo.filesOpen[id], id);
    return;
  }
  const btn = e.target.closest('button[data-lo-override]');
  if (!btn) return;
  location.hash = loOverrideHash(btn.dataset.loOverride, btn.dataset.loAction);
});
$('loProfile').addEventListener('change', (e) => {
  const q = new URLSearchParams({ profile: e.target.value });
  if (lo.compareWith != null) q.set('compare', lo.compareWith);
  if (lo.marked) q.set('mark', lo.marked);
  location.hash = `#/load-order?${q}`;
});
$('loManage').addEventListener('click', () => { location.hash = '#/load-overrides'; });
$('loUnmatchedManage').addEventListener('click', () => { location.hash = '#/load-overrides'; });
$('loCompare').addEventListener('click', () => {
  lo.compareWith = null;
  const q = new URLSearchParams();
  if (lo.data && lo.data.profile) q.set('profile', lo.data.profile.id);
  location.hash = `#/load-order${q.toString() ? `?${q}` : ''}`;
});
$('loJump').addEventListener('click', (e) => {
  const modeBtn = e.target.closest('button[data-lomode]');
  if (modeBtn) {
    lo.mode = modeBtn.dataset.lomode === 'action' ? 'action' : 'mod';
    $('loModeMod').setAttribute('aria-pressed', lo.mode === 'mod' ? 'true' : 'false');
    $('loModeAction').setAttribute('aria-pressed', lo.mode === 'action' ? 'true' : 'false');
    $('loFilter').hidden = lo.mode !== 'mod';
    $('loTypeFilter').hidden = lo.mode !== 'action';
    renderList();
    renderUndeclared();
    return;
  }
  const kind = e.target.dataset && e.target.dataset.jump;
  if (!kind) return;
  if (kind === 'nextoff') {
    // A toggle, because it was not one: the flag was only ever set to true, so a
    // single click left the list filtered with no way back and nothing on screen
    // saying so. Pressed state carries the answer now.
    lo.onlyOff = !lo.onlyOff;
    $('loOnlyOff').setAttribute('aria-pressed', lo.onlyOff ? 'true' : 'false');
    renderList();
    return;
  }
});

pages['load-order'] = {
  show(params) {
    lo.marked = params.get('mark');
    const cmp = params.get('compare');
    lo.compareWith = cmp != null && /^\d+$/.test(cmp) ? Number(cmp) : null;
    lo.filter = '';
    lo.mode = 'mod';
    lo.typeFilter = '';
    $('loFilter').value = '';
    $('loFilter').hidden = false;
    $('loTypeFilter').value = '';
    $('loTypeFilter').hidden = true;
    $('loModeMod').setAttribute('aria-pressed', 'true');
    $('loModeAction').setAttribute('aria-pressed', 'false');
    return loadLoOrder();
  },
};

window.civ6LoadOrder = lo;
