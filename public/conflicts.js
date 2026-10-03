'use strict';

// The conflicts view: diagnostics for the active profile.
//
// This page READS. Both routes are GETs; there is no POST anywhere under
// /api/conflicts, and no control on this page writes anything. The replay
// runs thousands of statements into a disposable copy, so it waits for its
// button.

const cfState = {
  shadow: null,   // last /api/conflicts/shadowing answer
  replay: null,   // last /api/conflicts/replay answer
  packaging: null, // last /api/conflicts/packaging answer
  running: false,
  diffFilter: '',        // exact-match mod search over differential groups
  hideUnattributed: false,
};

function cfSetRunning(running, label) {
  cfState.running = running;
  $('cfRunShadow').disabled = running;
  $('cfRunReplay').disabled = running;
  $('cfRunPackaging').disabled = running;
  $('cfFkMode').disabled = running;
  if (label) $('cfReplayEnv').textContent = label;
}

function cfClaimantHtml(c) {
  const val = c.value === null || c.value === undefined ? 'no declared order' : `LoadOrder ${esc(n(c.value))}`;
  return `<div class="lo-row"><span class="lo-mod">${renderCivText(c.name)}</span>`
    + `<span class="lo-type">${esc((c.sources || []).join('+'))}</span>`
    + `<span class="lo-detail">${esc(val)}</span></div>`;
}

function cfShadowPathHtml(d) {
  if (d.status === 'decided' && d.winner) {
    return `<div class="lo-band"><div class="lo-bandhead"><span class="lo-value">${esc(d.path)}</span>`
      + `<span class="lo-bandnote">winner: ${renderCivText(d.winner.name)} at ${esc(n(d.winner.value))}</span></div>`
      + `${d.claimants.map(cfClaimantHtml).join('')}</div>`;
  }
  const reason = d.reason === 'tie'
    ? `tie at ${esc(n(d.value))} — the game picks arbitrarily, so no winner is named`
    : 'no claimant declares an order — nothing decides this path';
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(d.path)}</span>`
    + `<span class="lo-bandnote">undefined: ${reason}</span></div>`
    + `${d.claimants.map(cfClaimantHtml).join('')}</div>`;
}

function cfWarningHtml(w) {
  if (w.kind === 'split-brain') {
    return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(w.luaPath)} + ${esc(w.xmlPath)}</span>`
      + `<span class="lo-bandnote">split pair — the screen and its layout come from different winners</span></div>`
      + `<div class="lo-row"><span class="lo-mod">${esc(w.luaPath)} loads from ${renderCivText(w.luaWinner.name)}</span></div>`
      + `<div class="lo-row"><span class="lo-mod">${esc(w.xmlPath)} loads from ${renderCivText(w.xmlWinner.name)}</span></div>`
      + `<div class="lo-row"><span class="lo-detail">The game loads each file from its named winner, so the two halves can disagree. Keep the pair in one mod, or open both files and check they still fit together.</span></div></div>`;
  }
  const where = w.scope === 'frontend' ? 'a front-end action' : 'an in-game action';
  const what = w.dir === 'gameplay-in-frontend'
    ? 'a gameplay script, which only runs inside a loaded game — in the menu shell it never runs. Move it to an in-game action.'
    : w.dir === 'script-in-data-action'
      ? 'a script file where the game reads database content, so it fails to load as data. Move it to a script action, or drop it from the action.'
      : 'a database file where the game loads a script, so it fails to load as code. Move it to a database action.';
  const action = w.actionId == null ? esc(w.actionType) : `${esc(w.actionType)} “${esc(w.actionId)}”`;
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${renderCivText(w.name)} — ${action} in ${where}</span>`
    + `<span class="lo-bandnote">wrong context — ${esc(w.dir)}</span></div>`
    + `${(w.files || []).map((f) => `<div class="lo-row"><span class="lo-mod">${esc(f)}</span></div>`).join('')}`
    + `<div class="lo-row"><span class="lo-detail">This is ${what}</span></div></div>`;
}

function cfRenderShadow() {
  const d = cfState.shadow;
  if (!d || !d.ok) return;
  $('cfShadowCount').textContent = n(d.envelope.contested);
  $('cfShadowEnv').innerHTML = `<p>${esc(d.envelopeLine)} — profile “${esc(d.profile.name)}”. `
    + 'Start here: rows with a winner are settled — ignore them unless the screen looks wrong. '
    + 'Rows with no winner are choices to pin down or accept — nothing here crashes.</p>';
  const warns = (d.envelope && d.envelope.warnings) || [];
  const warnHtml = warns.length
    ? `<p class="note">${esc(n(warns.length))} pairing/placement warning${warns.length === 1 ? '' : 's'} — every row names a real problem, but a clean report does not mean the profile is clean.</p>`
      + warns.map(cfWarningHtml).join('')
    : '';
  $('cfShadowList').innerHTML = warnHtml + (d.contested.length
    ? d.contested.map(cfShadowPathHtml).join('')
    : '<p class="note">No contested paths: every UI file is claimed by exactly one enabled mod.</p>');
}

async function cfRunShadowing() {
  if (cfState.running) return;
  cfSetRunning(true);
  $('cfShadowList').innerHTML = '<p class="note">Enumerating…</p>';
  try {
    cfState.shadow = await api('/api/conflicts/shadowing');
    if (!cfState.shadow.ok) throw new Error(cfState.shadow.error || 'enumeration failed');
    cfRenderShadow();
  } catch (err) {
    $('cfShadowList').innerHTML = `<div class="alert warn"><b>Can’t enumerate shadowing.</b> ${esc(err.message)}</div>`;
  } finally {
    cfSetRunning(false);
  }
}

// Packaging findings: five small groups over the active profile's enabled
// mods, in load order (disabled mods are out of scope). Every row names the mod by display
// name (renderCivText, never a raw id), the file or action, the
// plain-words reason the backend already supplies, and what to do next.
function cfPackagingUnregHtml(w) {
  const hint = String(w.reason || '').indexOf('does not list') >= 0
    ? 'List it in the mod, or remove the file - as it stands the game never loads it.'
    : 'Add it to an action in the mod, or remove the file - as it stands the game never loads it.';
  return `<div class="lo-row" title="${esc(hint)}"><span class="lo-mod">${renderCivText(w.name)} / ${esc(w.file)}</span>`
    + `<span class="lo-detail">${esc(w.reason)}.</span></div>`;
}

function cfPackagingSchemaHtml(w) {
  const where = w.expectedDb === 'gameplay' ? 'gameplay' : 'front-end';
  const hint = `Move the file into a ${where} action in the mod - as it stands the game reads it where its tables are not.`;
  return `<div class="lo-row" title="${esc(hint)}"><span class="lo-mod">${renderCivText(w.name || w.modId)} / ${esc(w.file)} · table ${esc(w.table)} (${esc(where)} database)</span>`
    + `<span class="lo-detail">${esc(w.reason)}.</span></div>`;
}

function cfPackagingDbHtml(w) {
  const side = (list) => (list || []).map((s) => `${renderCivText(s.name)} (${esc(s.actionType)})`).join(', ');
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(w.file)}</span>`
    + `<span class="lo-bandnote">wrong database</span></div>`
    + `<div class="lo-row"><span class="lo-mod">gameplay: ${side(w.ingame)}</span></div>`
    + `<div class="lo-row"><span class="lo-mod">front-end: ${side(w.frontend)}</span></div>`
    + `<div class="lo-row" title="Keep this file on one side only - move it into a gameplay action or a front-end action, not both."><span class="lo-detail">${esc(w.reason)}.</span></div></div>`;
}

function cfPackagingDupHtml(w) {
  const who = (w.claimants || []).map((c) => `${renderCivText(c.name)} (${esc(c.folder || 'folder unknown')})`).join(', ');
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">One id claimed by ${esc(n((w.claimants || []).length))} mods</span>`
    + `<span class="lo-bandnote">shared id</span></div>`
    + `<div class="lo-row"><span class="lo-mod">${who}</span></div>`
    + `<div class="lo-row" title="Give one of them a different ModId, or remove the copy you do not play with - the game cannot tell them apart as they are."><span class="lo-detail">${esc(w.reason)}.</span></div></div>`;
}

function cfPackagingXmlHtml(w) {
  const tag = `<${w.tag == null ? '' : w.tag}>`;
  const where = w.line === null || w.line === undefined || w.line === '' ? tag : `${tag} (line ${w.line})`;
  return `<div class="lo-row" title="Open the file at the named line and fix the tag the reason names - as it stands the game skips it."><span class="lo-mod">${renderCivText(w.name)} / ${esc(w.file)} · ${esc(where)}</span>`
    + `<span class="lo-detail">${esc(w.reason)}.</span></div>`;
}

// One packaging group renders at most this many rows; the rest sit behind an
// "and M more" button that expands in place. Header counts always show the
// full total. Big libraries report tens of thousands of findings, and
// rendering them all blocks the browser for minutes.
const cfPackagingWindow = 100;

function cfPackagingGroupState(kind) {
  if (!cfState.packagingExpanded) cfState.packagingExpanded = {};
  return !!cfState.packagingExpanded[kind];
}

function cfTogglePackagingGroup(kind) {
  if (!cfState.packagingExpanded) cfState.packagingExpanded = {};
  cfState.packagingExpanded[kind] = !cfState.packagingExpanded[kind];
  cfRenderPackaging();
}

function cfPackagingRowsHtml(kind, rows, rowFn) {
  const expanded = cfPackagingGroupState(kind);
  const shown = expanded ? rows : rows.slice(0, cfPackagingWindow);
  let html = shown.map(rowFn).join('');
  const rest = rows.length - shown.length;
  if (rest > 0) {
    html += `<div class="lo-row"><button type="button" class="secondary small" onclick="cfTogglePackagingGroup('${kind}')" title="Show every row in this group — the list may be long.">and ${esc(n(rest))} more — show all</button></div>`;
  } else if (expanded && rows.length > cfPackagingWindow) {
    html += `<div class="lo-row"><button type="button" class="secondary small" onclick="cfTogglePackagingGroup('${kind}')" title="Back to the first rows only.">show less</button></div>`;
  }
  return html;
}

function cfPackagingGroupHtml(title, count, rowsHtml, emptyNote, tip) {
  const head = `<div class="lo-bandhead"><span class="lo-value">${esc(title)}</span><span class="lo-bandnote">${esc(n(count))}</span></div>`;
  const body = rowsHtml || `<div class="lo-row"><span class="lo-detail">${esc(emptyNote)}</span></div>`;
  return `<div class="lo-band" title="${esc(tip)}">${head}${body}</div>`;
}

function cfRenderPackaging() {
  const d = cfState.packaging;
  if (!d || !d.ok) return;
  const warns = d.warnings || [];
  $('cfPackagingCount').textContent = n(warns.length);
  const who = d.profile && d.profile.name ? `profile “${esc(d.profile.name)}”` : 'the active profile';
  const scope = typeof d.enabledMods === 'number'
    ? `${esc(n(d.enabledMods))} mods switched on in ${who}` : `the enabled mods in ${who}`;
  $('cfPackagingEnv').innerHTML = `<p>Static checks over ${scope}, in load order — order and winner predictions use the `
    + 'effective LoadOrder values, overrides included. '
    + 'Start here: files the game never loads and mods sharing one id first — those stop content loading; wrong-database tables next.</p>';
  if (!warns.length) {
    $('cfPackagingList').innerHTML = '<p class="note">Packaging looks clean: every file is loaded by an action, '
      + 'every table lives where its file loads, every database file sits on one side, no two mods share an id, and every database file reads as database content.</p>';
    return;
  }
  const unreg = warns.filter((w) => w.kind === 'unregistered-file');
  const schema = warns.filter((w) => w.kind === 'schema-mismatch');
  const wrong = warns.filter((w) => w.kind === 'wrong-database');
  const dup = warns.filter((w) => w.kind === 'duplicate-mod-id');
  const xml = warns.filter((w) => w.kind === 'xml-issue');
  $('cfPackagingList').innerHTML = cfPackagingGroupHtml('Files no action loads', unreg.length,
      cfPackagingRowsHtml('unreg', unreg, cfPackagingUnregHtml),
      'Every listed file is loaded by an action, and every folder file is listed.',
      'Files the game never loads - add each to an action in its mod, or remove it.')
    + cfPackagingGroupHtml('Tables in the wrong database', schema.length,
      cfPackagingRowsHtml('schema', schema, cfPackagingSchemaHtml),
      'Every table lives where its file loads.',
      'Tables the game reads from the other database - move each file into the named database action.')
    + cfPackagingGroupHtml('Database files on the wrong side', wrong.length,
      cfPackagingRowsHtml('wrong', wrong, cfPackagingDbHtml),
      'Every database file loads on one side only.',
      'One file loading into both databases - keep it on one side.')
    + cfPackagingGroupHtml('Mods sharing one id', dup.length,
      cfPackagingRowsHtml('dup', dup, cfPackagingDupHtml),
      'Every mod id belongs to exactly one mod folder.',
      'Two folders claiming one id - give one a different id, or remove the spare.')
    + cfPackagingGroupHtml('Database files the game skips', xml.length,
      cfPackagingRowsHtml('xml', xml, cfPackagingXmlHtml),
      'Every database file reads as database content.',
      'Tags the game skips - open the file at the named line and fix the tag the reason names.');
}

async function cfRunPackaging() {
  if (cfState.running) return;
  cfSetRunning(true);
  $('cfPackagingList').innerHTML = '<p class="note">Checking packaging…</p>';
  try {
    cfState.packaging = await api('/api/conflicts/packaging');
    if (!cfState.packaging.ok) throw new Error(cfState.packaging.error || 'packaging check failed');
    cfState.packagingExpanded = {};
    cfRenderPackaging();
  } catch (err) {
    $('cfPackagingList').innerHTML = `<div class="alert warn"><b>Can’t check packaging.</b> ${esc(err.message)}</div>`;
  } finally {
    cfSetRunning(false);
  }
}

// Zero-rows-affected: an UPDATE/DELETE that ran clean but matched nothing -
// flagged, never an error. Replay-relative by construction (this replay’s
// order, gates and earlier aborts may differ from the game’s), so the row
// says so in plain words instead of printing the backend flag.
function cfZeroRowsHtml(z) {
  return `<div class="lo-row" title="The statement ran but matched nothing in this replay - open the file at that statement and check what it targets."><span class="lo-mod">${renderCivText(z.modName || z.modId)} / ${esc(z.fileLabel)} #${esc(n(z.stmtIndex))}</span>`
    + `<span class="lo-detail">${esc(z.verb)} matched no rows in this replay.</span></div>`;
}

function cfWhoHtml(w) {
  return `${renderCivText((w && (w.modName || w.modId)) || '?')} / ${esc(w.fileLabel)} #${esc(n(w.stmtIndex))}`;
}

function cfCollisionHtml(c) {
  const flag = c.fidelityLimited && c.fidelityLimited.length
    ? ` <span class="lo-tag lo-unknown">fidelity-limited: ${esc(c.fidelityLimited.join(', '))}</span>` : '';
  const same = c.sameMod
    ? ' <span class="lo-tag" title="Winner and loser are the same mod — the order is decided inside one mod, so open its files in replay order and check them.">same mod</span>' : '';
  return `<div class="lo-band lo-tie"><div class="lo-bandhead"><span class="lo-value">${esc(c.table)} · ${esc(String(c.pk))} · ${esc(c.column)}</span>`
    + `<span class="lo-bandnote">${esc(n(c.writes))} writes${flag}${same}</span></div>`
    + `<div class="lo-row"><span class="lo-mod">winner: ${cfWhoHtml(c.winner)}</span></div>`
    + `${c.losers.map((w) => `<div class="lo-row"><span class="lo-mod">loser: ${cfWhoHtml(w)}</span></div>`).join('')}</div>`;
}

function cfResponsibleHtml(row) {
  const name = (row && (row.responsibleModName || row.responsibleModId)) || null;
  return name ? renderCivText(name) : esc('Mod unknown');
}

// Plain words, never backend jargon: the raw strengths (context-proven,
// hint-matched, bracket-approximate) mean nothing to a player, so each maps
// to a short tag whose tooltip says what to do next. An unattributed row
// never carries an attributing label, whatever the backend sent.
function cfStrengthTag(row) {
  if (!row) return '';
  const attributed = !!(row.responsibleModId || row.responsibleModName);
  if (!attributed) {
    const attr = row.attribution || {};
    if (attr.kind === 'bracket-ambiguous' && Array.isArray(attr.candidates) && attr.candidates.length) {
      return ' <span class="lo-tag lo-unknown" title="Two or more mods were loading at the same moment, so no single mod can be named — open each candidate file and check.">several possible</span>';
    }
    return ' <span class="lo-tag lo-unknown" title="Neither the game log nor the replay could name the mod behind this — read the statement text for clues, then check your mod files.">no mod named</span>';
  }
  if (row.strength === 'replay') return ' <span class="lo-tag" title="The replay raised this and the game log stayed silent — open the file at the named statement.">found by replay</span>';
  if (row.strength === 'context-proven') return ' <span class="lo-tag" title="The game log names this mod’s file at the same moment — open that file and check the statement.">traced to this mod</span>';
  if (row.strength === 'hint-matched') return ' <span class="lo-tag" title="Only the file name points here — open the file and check it belongs to this mod.">matched by file name</span>';
  if (row.strength === 'bracket-approximate') {
    return ' <span class="lo-tag" title="No file was named, so this is the mod loading nearest in time — treat it as a lead, not proof.">best guess</span>'
      + (row.approximate ? ' <span class="lo-tag lo-unknown" title="This is a rough guess, not proof — open the named file before changing anything.">approximate</span>' : '');
  }
  if (!row.strength || row.strength === 'unattributed') return '';
  return ` <span class="lo-tag">${esc(row.strength)}</span>`;
}

// Backend reason codes in average-player words. Unknown codes pass through
// escaped rather than dropped, so a new reason reads raw instead of silent.
function cfPlainReason(reason) {
  const r = String(reason == null ? '' : reason);
  if (!r) return '';
  if (r === 'no-loading-precedes') return 'nothing was loading just before, so there is nothing to guess from';
  if (r === 'no-log-entry') return 'the game log has no matching line';
  if (r === 'no-source-path') return 'the log names no file';
  if (r === 'path-not-mapped') return 'the file path matches no installed mod';
  if (r === 'file-hint-only') return 'the log names a file but no mod';
  if (r === 'same-ms-ambiguity') return 'two or more mods were loading at the same moment';
  if (r === 'no-error-timestamp') return 'the log line carries no timestamp to match on';
  const w = /^workshop-id-not-installed:(.+)$/.exec(r);
  if (w) return `that workshop item (${w[1]}) is not installed`;
  return r;
}

function cfAttributionNote(row) {
  const attr = (row && row.attribution) || {};
  if (attr.kind === 'bracket-ambiguous' && Array.isArray(attr.candidates) && attr.candidates.length) {
    const names = attr.candidates.map((c) => renderCivText(
      (c && c.attribution && (c.attribution.modName || c.attribution.modId)) || (c && c.path) || '?')).join(', ');
    return ` — could be ${names}: they were loading at the same moment, so open each file and check`;
  }
  if (attr.loadingPath) {
    return ` — seen while the game was loading ${esc(attr.loadingPath)}: a lead, not proof`;
  }
  if ((attr.kind === 'hint' || attr.fileHint) && !row.responsibleModId) {
    return ' — file name only, no mod proven: open the file and check which mod owns it';
  }
  if (!row.responsibleModId && attr.reason) return ` — ${esc(cfPlainReason(attr.reason))}`;
  return '';
}

function cfCalibrationHtml(cal) {
  if (!cal) return '';
  if (!cal.available) {
    return `<p class="note">No load-order calibration: ${esc((cal && cal.reason) || 'the game’s loading log is unavailable')}.</p>`;
  }
  const divs = cal.divergences || [];
  if (!divs.length) {
    return '<p class="note">Load-order calibration: the replay order matches the game-observed order — no divergences.</p>';
  }
  return `<p class="note" title="The game loaded these files in a different order than the replay assumed — open the named files and check which order your setup needs.">${esc(n(divs.length))} load-order divergence${divs.length === 1 ? '' : 's'}: `
    + 'the game loaded these files in the opposite order to the replay assumption. Open the named files and check the order.</p>'
    + divs.map((dv) => `<div class="lo-band"><div class="lo-bandhead"><span class="lo-value">order differs: ${esc(dv.assumedFirst)} / ${esc(dv.assumedSecond)}</span></div>`
      + `<div class="lo-row"><span class="lo-detail">${esc(dv.assumedOrder)} — but ${esc(dv.observedOrder)}</span></div>`
      + cfCalibrationFileHtml(dv.assumedFirst, dv.assumedFirstMods)
      + cfCalibrationFileHtml(dv.assumedSecond, dv.assumedSecondMods) + `</div>`).join('');
}

// One divergence file with its owning mod(s) underneath: display names
// render (never raw markup), several claimants all list, and a file no
// enabled mod claims says so in plain words instead of dropping the row.
function cfCalibrationFileHtml(label, mods) {
  const names = (mods || []).map((m) => renderCivText((m && (m.modName || m.modId)) || '?')).join(', ');
  if (!names) {
    return `<div class="lo-row" title="No enabled mod claims this file — check it still belongs to the profile, then replay.">`
      + `<span class="lo-mod">${esc(label)} — owning mod unknown</span></div>`;
  }
  return `<div class="lo-row" title="The replay read this file from the named mod — open it there to check the order.">`
    + `<span class="lo-mod">${esc(label)} — from ${names}</span></div>`;
}

// The differential as one list: agreements, replay-only, and log-only rows
// together, so grouping below sees every row.
function cfDiffRows() {
  const d = cfState.replay && cfState.replay.differential;
  if (!d || !d.available) return null;
  const rows = [];
  for (const a of d.agreements || []) rows.push({ ...a, side: 'agree' });
  for (const r of d.replayOnly || []) rows.push({ ...r, side: 'replay-only' });
  for (const l of d.logOnly || []) rows.push({ ...l, side: 'log-only' });
  return rows;
}

// Same side plus same failure text: one mod failing the same way in several
// files (three language files, one missing table) reads as one finding.
function cfDiffFailureKey(row) {
  const msg = row.side === 'replay-only' ? (row.replayError || '')
    : (row.logText || row.replayError || row.message || '');
  return `${row.side}|${String(msg).trim().toLowerCase()}`;
}

function cfCollapseDiffRows(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const k = cfDiffFailureKey(row);
    if (!seen.has(k)) seen.set(k, { first: row, rows: [] });
    seen.get(k).rows.push(row);
  }
  return [...seen.values()];
}

// Markup-free display name for searching and sorting. Local regex rather
// than stripCivText so grouping never depends on another script loading.
function cfPlainModName(name) {
  return String(name == null ? '' : name).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Groups keyed by responsible mod, attributed first, then A–Z; the unattributed
// group always sorts last.
function cfDiffGroups() {
  const rows = cfDiffRows();
  if (!rows) return null;
  const byMod = new Map();
  for (const row of rows) {
    const key = row.responsibleModId || ' unattributed';
    if (!byMod.has(key)) byMod.set(key, { modId: row.responsibleModId || null, name: row.responsibleModName || null, rows: [] });
    byMod.get(key).rows.push(row);
  }
  const groups = [...byMod.values()].map((g) => ({ ...g, findings: cfCollapseDiffRows(g.rows) }));
  groups.sort((a, b) => {
    const au = a.modId ? 0 : 1;
    const bu = b.modId ? 0 : 1;
    if (au !== bu) return au - bu;
    return cfPlainModName(a.name).toLowerCase().localeCompare(cfPlainModName(b.name).toLowerCase());
  });
  return groups;
}

// Exact-match mod search, reusing the load-order pattern: the full display
// name or nothing. The unattributed group never matches a typed name.
function cfDiffGroupVisible(g, q) {
  if (!q) return true;
  if (!g.modId) return false;
  return cfPlainModName(g.name || g.modId).toLowerCase() === q;
}

function cfDiffSideLabel(side) {
  if (side === 'agree') return 'Replay and log agree';
  if (side === 'replay-only') return 'Replay only';
  return 'Game log only';
}

function cfDiffRowHtml(f) {
  const r = f.first;
  const files = [...new Set(f.rows.map((x) => x.fileLabel || '(no file hint)'))];
  const stmt = r.stmtIndex == null ? '' : `, statement ${esc(n(r.stmtIndex))}`;
  const what = files.length > 1
    ? `${esc(n(files.length))} files, same error — ${files.map((x) => esc(x)).join(', ')}${stmt}`
    : `${esc(files[0])}${stmt}`;
  let detail = '';
  if (r.side === 'agree') {
    const logNote = (r.logModId && r.responsibleModId && r.logModId !== r.responsibleModId)
      ? ` — log points to ${renderCivText(r.logModName || r.logModId)}` : '';
    detail = `matches game-log line ${esc(n(r.logLine))}${logNote}`;
  } else if (r.side === 'replay-only') {
    detail = esc(r.replayError);
  } else {
    detail = `game-log line ${esc(n(r.logLine))}: ${esc(r.logText)}${cfAttributionNote(r)}`;
  }
  const tip = r.side === 'agree'
    ? 'Both sides report this — start here; open the file at the named statement.'
    : r.side === 'replay-only'
      ? 'Only the replay raised this — a lead to check; open the file at the named statement.'
      : 'Only the game log reports this — it actually broke something; read the line, then open the named file if there is one.';
  return `<div class="lo-row" title="${tip}"><span class="lo-mod">${esc(cfDiffSideLabel(r.side))}: ${what}</span>${cfStrengthTag(r)}`
    + `<span class="lo-detail">${detail}</span></div>`;
}

function cfDiffGroupHtml(g) {
  const count = `${esc(n(g.findings.length))} finding${g.findings.length === 1 ? '' : 's'}`;
  const head = g.modId
    ? `<span class="lo-value">${renderCivText(g.name || g.modId)}</span><span class="lo-bandnote">${count}</span>`
    : `<span class="lo-value" title="These errors name no mod — read the statement text for clues, then check your mod files.">Mod unknown</span>`
      + `<span class="lo-bandnote">${count} no mod could be named for</span>`;
  return `<div class="lo-band"><div class="lo-bandhead">${head}</div>`
    + `${g.findings.map(cfDiffRowHtml).join('')}</div>`;
}

// Differential section only, so the search box and the toggle re-render it
// without touching the collisions or the gated-out lists.
function cfRenderDiff() {
  const d = cfState.replay;
  if (!d || !d.ok) return;
  const diff = d.differential;
  let html;
  let note = '';
  if (!diff || !diff.available) {
    html = `<p class="note">No comparison: ${esc((diff && diff.reason) || 'the game log is unavailable')}.</p>`;
  } else {
    const q = (cfState.diffFilter || '').trim().toLowerCase();
    const all = cfDiffGroups() || [];
    const total = all.reduce((s, g) => s + g.findings.length, 0);
    const hidden = cfState.hideUnattributed
      ? all.filter((g) => !g.modId).reduce((s, g) => s + g.findings.length, 0) : 0;
    const groups = all
      .filter((g) => !(cfState.hideUnattributed && !g.modId))
      .filter((g) => cfDiffGroupVisible(g, q));
    const shown = groups.reduce((s, g) => s + g.findings.length, 0);
    if (!all.length) {
      html = '<p class="note">Replay and the game log agree: no errors on either side.</p>';
    } else if (!groups.length) {
      html = q
        ? '<p class="note">No mod is named exactly that — the mod filter matches whole names only.</p>'
        : '<p class="note">Everything here names no mod — untick “Hide unnamed findings” to see it.</p>';
    } else {
      html = '<p class="note" title="Fix game-log rows at their named files first, then check replay-only rows at their statements — leave rows with no mod named until last.">'
        + 'Start with game-logged errors — those actually broke something; replay-only rows are leads; rows with no mod named come last. Where both sides agree, fix first.</p>'
        + groups.map(cfDiffGroupHtml).join('');
    }
    const bits = [];
    if (q) bits.push(`${n(shown)} of ${n(total)} findings — matching the filter`);
    if (hidden) bits.push(`${n(hidden)} unnamed finding${hidden === 1 ? '' : 's'} hidden`);
    note = bits.join(' · ');
  }
  html += cfCalibrationHtml(d.calibration);
  $('cfReplayDiff').innerHTML = html;
  const noteEl = $('cfDiffNote');
  if (noteEl) noteEl.textContent = note;
}

// Rows the replay decided only because of asserted game setup read
// differently from measured rows by construction: measured rows never carry
// the flag. Same short tag language as the load-order view ("assumed
// setup"); the title says what to do next.
function cfAssumedTag(g) {
  if (!g || !g.assumed) return '';
  return ' <span class="lo-tag lo-assumed" title="Decided by your asserted game setup, never measured — change it in the game-setup panel">assumed setup</span>';
}

function cfRenderReplay() {
  const d = cfState.replay;
  if (!d || !d.ok) return;
  $('cfReplayCount').textContent = n(d.collisions.length);
  const bits = [`${esc(d.envelopeLine)}`, 'replayed in a disposable copy',
    `foreign-key checks ${esc(d.fkMode)}${String(d.fkMode).toLowerCase() === 'on' ? ' — strict, stops each file at the first missing reference' : ' — game-like, keeps going when references are missing'}`, `profile “${esc(d.profile.name)}”`];
  if (d.limitationFlags.length) bits.push(`limited by: ${esc(d.limitationFlags.join(', '))}`);
  if (d.unreadable.length) bits.push(`${esc(n(d.unreadable.length))} unreadable file(s) skipped`);
  if (d.skippedGated) bits.push(`${esc(n(d.skippedGated))} statement(s) gated out`);
  $('cfReplayEnv').innerHTML = `<p>${bits.join(' · ')}</p>`
    + '<p>Start here: cross-mod pairs first — same-mod pairs are one author\u2019s layering. '
    + 'The gated and skipped lists below explain what the replay did not cover.</p>';
  $('cfReplayCollisions').innerHTML = d.collisions.length
    ? d.collisions.map(cfCollisionHtml).join('')
    : '<p class="note">No collisions: no cell was written by two statements in this replay.</p>';
  const gated = [];
  for (const g of d.gatedOut) {
    gated.push(`<div class="lo-row" title="Its conditions were not met, so the replay skipped it — change the profile and replay to include it."><span class="lo-mod">${renderCivText(g.modName || g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">not run — ${esc(g.reason)}</span>${cfAssumedTag(g)}</div>`);
  }
  for (const g of d.gatedUnknown) {
    gated.push(`<div class="lo-row" title="The replay ran this file, but its conditions need the running game — check them in-game if it matters."><span class="lo-mod">${renderCivText(g.modName || g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">ran anyway — its conditions cannot be decided here</span></div>`);
  }
  // Files the replay ran only because of asserted game setup: membership in
  // gatedAssumed is itself the marker, so the tag renders unconditionally.
  for (const g of d.gatedAssumed || []) {
    gated.push(`<div class="lo-row" title="The replay ran this file only because of your asserted game setup — switch it off in the game-setup panel and replay to compare."><span class="lo-mod">${renderCivText(g.modName || g.modId)} / ${esc(g.fileLabel)}</span>`
      + `<span class="lo-detail">ran as assumed</span>${cfAssumedTag({ assumed: true })}</div>`);
  }
  for (const u of d.unreadable) {
    gated.push(`<div class="lo-row" title="The file is missing or outside the mod folder — put it back (or remove the action) and replay."><span class="lo-mod">${renderCivText(u.modName || u.modId)} / ${esc(u.file)}</span>`
      + `<span class="lo-detail">could not be read — ${esc(u.reason)}</span></div>`);
  }
  const aborted = d.perFile.filter((f) => f.status === 'aborted');
  for (const f of aborted) {
    gated.push(`<div class="lo-row" title="Nothing after that statement ran — open the file at that statement and fix it."><span class="lo-mod">${renderCivText(f.modName || f.modId)} / ${esc(f.fileLabel)}</span>`
      + `<span class="lo-detail">stopped at statement ${esc(n(f.failedAt))} — ${esc(f.error)}</span></div>`);
  }
  $('cfReplayGated').innerHTML = gated.length
    ? gated.join('')
    : '<p class="note">Nothing gated out, assumed, unreadable, or aborted.</p>';
  const zeroes = d.zeroRows || [];
  $('cfReplayZeroRows').innerHTML = zeroes.length
    ? zeroes.map(cfZeroRowsHtml).join('')
    : '<p class="note">Every UPDATE and DELETE matched at least one row in this replay.</p>';
  cfRenderDiff();
}

async function cfRunReplay() {
  if (cfState.running) return;
  cfSetRunning(true, 'Replaying…');
  $('cfReplayCollisions').innerHTML = '<p class="note">Replaying the profile in a disposable copy…</p>';
  $('cfReplayGated').innerHTML = '';
  $('cfReplayDiff').innerHTML = '';
  try {
    const fk = $('cfFkMode').value === 'on' ? 'on' : 'off';
    cfState.replay = await api(`/api/conflicts/replay?fk=${fk}`);
    if (!cfState.replay.ok) throw new Error(cfState.replay.error || 'replay failed');
    cfRenderReplay();
  } catch (err) {
    $('cfReplayEnv').innerHTML = `<div class="alert warn"><b>Can’t replay.</b> ${esc(err.message)}</div>`;
  } finally {
    cfSetRunning(false);
  }
}

// Page entry: reset the outputs and leave the buttons armed. Nothing fetches
// here - each report waits for its button.
function cfShowConflicts() {
  cfState.shadow = null;
  cfState.replay = null;
  cfState.packaging = null;
  cfState.packagingExpanded = {};
  cfState.diffFilter = '';
  cfState.hideUnattributed = false;
  $('cfShadowCount').textContent = '';
  $('cfShadowEnv').innerHTML = '<p>Shows every UI file claimed by more than one enabled mod. '
    + 'Start here: rows with a winner are settled — ignore them unless the screen looks wrong; rows with no winner are choices to pin down or accept.</p>';
  $('cfShadowList').innerHTML = '';
  $('cfPackagingCount').textContent = '';
  $('cfPackagingEnv').innerHTML = '<p>Lists files the game never loads, tables in the wrong database, and ids two mods share, for the active profile. '
    + 'Start here: never-loaded files and shared ids first — those stop content loading.</p>';
  $('cfPackagingList').innerHTML = '';
  $('cfReplayCount').textContent = '';
  $('cfReplayEnv').innerHTML = '<p>Replays the profile’s database files in load order inside a throwaway copy — never the live game database — '
    + 'and names the winner of every contested cell. Start here: cross-mod pairs first; same-mod pairs are one author\u2019s layering. '
    + 'Runs when you ask — large profiles take a moment.</p>';
  $('cfReplayCollisions').innerHTML = '';
  $('cfReplayGated').innerHTML = '';
  $('cfReplayZeroRows').innerHTML = '';
  $('cfReplayDiff').innerHTML = '';
  const df = $('cfDiffFilter');
  if (df) df.value = '';
  const hu = $('cfHideUnattributed');
  if (hu) hu.checked = false;
  const dn = $('cfDiffNote');
  if (dn) dn.textContent = '';
}

$('cfRunShadow').addEventListener('click', () => { cfRunShadowing().catch((err) => toast(err.message, 'err')); });
$('cfRunReplay').addEventListener('click', () => { cfRunReplay().catch((err) => toast(err.message, 'err')); });
$('cfRunPackaging').addEventListener('click', () => { cfRunPackaging().catch((err) => toast(err.message, 'err')); });
$('cfDiffFilter').addEventListener('input', (e) => { cfState.diffFilter = e.target.value; cfRenderDiff(); });
$('cfHideUnattributed').addEventListener('change', (e) => { cfState.hideUnattributed = !!e.target.checked; cfRenderDiff(); });

pages['conflicts'] = { show: cfShowConflicts };
