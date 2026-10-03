'use strict';

// Assumed game setup ("I always play with X on"): the options the installed
// library actually gates on, as round toggles grouped by kind, each with its
// gated-action count. One click asserts an option for verdict purposes, the
// next withdraws it - the label-toggle interaction from the mod manager's
// label editor, so asserting feels like labelling.
//
// Nothing here writes the game database: toggling only rewrites
// game-setup.json, a file the game has never heard of, so - like labels - this
// works while Civ6 runs. The load-order view reads the store on every load,
// so after a toggle it is reloaded in place; the replay reads it on every
// run, so it needs no refresh.

const gsState = { data: null, busy: false };

// Panel group order: rulesets, modes, settings, cores, leaders. The catalog
// arrives in this order already; the rank only places a kind the store may one
// day add without breaking the panel.
const GS_KIND_ORDER = ['RULESET', 'GAMEMODE', 'CONFIG', 'CORE', 'LEADER'];
const GS_KIND_TITLES = {
  RULESET: 'Rulesets',
  GAMEMODE: 'Game modes',
  CONFIG: 'Game settings',
  CORE: 'Game cores',
  LEADER: 'Leaders',
};

function gsKindRank(kind) {
  const i = GS_KIND_ORDER.indexOf(kind);
  return i === -1 ? GS_KIND_ORDER.length : i;
}

function gsKindTitle(kind) {
  return GS_KIND_TITLES[kind] || String(kind);
}

// One option as a round toggle. The title says what the click does next:
// asserting stops matching actions saying they require it, withdrawing puts
// the wording back. The count is the point - an option gating nothing would
// not be listed, and one gating a dozen is worth asserting.
function gsToggleHtml(opt, asserted) {
  const label = opt.name;
  const units = `${n(opt.count)} action${opt.count === 1 ? '' : 's'}`;
  const title = asserted
    ? `Withdraw ${label} — matching actions go back to saying they require it`
    : `Assert ${label} — matching actions stop saying they require it`;
  return `<button type="button" class="chip label-toggle${asserted ? ' on' : ''}" data-gs="${esc(opt.key)}"`
    + ` aria-pressed="${asserted ? 'true' : 'false'}" title="${esc(title)}">`
    + `${esc(label)}<span class="n">${esc(units)}</span></button>`;
}

function gsGroupsHtml(options, asserted) {
  const isOn = (opt) => !!(asserted && asserted[opt.key] === true);
  const groups = new Map();
  for (const opt of options || []) {
    if (!groups.has(opt.kind)) groups.set(opt.kind, []);
    groups.get(opt.kind).push(opt);
  }
  const kinds = [...groups.keys()].sort((a, b) => gsKindRank(a) - gsKindRank(b));
  return kinds.map((kind) => {
    const toggles = groups.get(kind).map((opt) => gsToggleHtml(opt, isOn(opt))).join('');
    return `<h3>${esc(gsKindTitle(kind))}</h3><div class="label-toggles">${toggles}</div>`;
  }).join('');
}

function gsApplyData(d) {
  gsState.data = d;
  gsState.busy = false;
  const asserted = (d && d.asserted) || {};
  const options = (d && d.options) || [];
  const keys = (d && d.keys) || Object.keys(asserted);

  // The global banner: visible while anything is asserted, everywhere. It
  // names the count and leads to the panel that explains it - a row marked
  // assumed anywhere is a guess from these options, never a measurement.
  const banner = $('gsBanner');
  if (banner) {
    banner.hidden = keys.length === 0;
    if (keys.length) banner.textContent = `Assuming game setup — ${n(keys.length)} asserted`;
  }

  const total = options.length;
  const onCount = options.filter((opt) => asserted[opt.key] === true).length;
  const count = $('gsCount');
  if (count) count.textContent = total ? `${n(onCount)} of ${n(total)} asserted` : '';
  const clear = $('gsClear');
  if (clear) clear.disabled = keys.length === 0 || !!(d && d.unusable);

  const slot = $('gsError');
  if (slot) {
    const alerts = [];
    if (d && d.error) {
      alerts.push(`<div class="alert warn"><b>Problem with your game setup.</b> ${esc(d.error)}`
        + (d.unusable ? ' Fix or delete game-setup.json, then toggle again.' : '') + '</div>');
    }
    if (d && d.catalogError) {
      alerts.push(`<div class="alert warn"><b>Can't list game-setup options.</b> ${esc(d.catalogError)}</div>`);
    }
    slot.innerHTML = alerts.join('');
  }

  const box = $('gsGroups');
  if (box) {
    if (!total && !(d && d.catalogError)) {
      box.innerHTML = '<p class="hint">Nothing in your library gates on game setup — there is nothing to assert.</p>';
    } else {
      const pruned = d && d.pruned ? `<p class="hint">${n(d.pruned)} asserted option${d.pruned === 1 ? '' : 's'}`
        + ` the library no longer gates on ${d.pruned === 1 ? 'was' : 'were'} set aside`
        + ' — the next toggle writes the cleaned list.</p>' : '';
      box.innerHTML = gsGroupsHtml(options, asserted) + pruned;
    }
    // A store file the toolkit can no longer read refuses every write rather
    // than overwrite whatever it holds. Its toggles disable so the refusal is
    // visible before the click, not after it.
    if (box.querySelectorAll && d && d.unusable) {
      for (const btn of box.querySelectorAll('button[data-gs]')) btn.disabled = true;
    }
  }
}

async function gsLoad() {
  try {
    gsApplyData(await api('/api/game-setup'));
  } catch (err) {
    gsState.busy = false;
    const box = $('gsGroups');
    if (box) box.innerHTML = '';
    const slot = $('gsError');
    if (slot) slot.innerHTML = `<div class="alert warn"><b>Can't load game setup.</b> ${esc(err.message)}</div>`;
  }
}

// The load-order view reads the store on every load, so a toggle reloads it
// in place - when it is the page being read. loadLoOrder is the view's own
// loader; calling it reaches across files through the shared global scope,
// the way these classic scripts share everything.
function gsRefreshVerdicts() {
  try {
    if (document.body.dataset.page === 'load-order' && typeof loadLoOrder === 'function') loadLoOrder();
  } catch (_) { /* the view keeps its rows until its next load */ }
}

async function gsToggle(key, turnOn) {
  if (gsState.busy) return;
  gsState.busy = true;
  try {
    gsApplyData(await postJson('/api/game-setup', { key, on: turnOn }));
    gsRefreshVerdicts();
  } catch (err) {
    toast(esc(err.message), 'err');
    gsState.busy = false;
    gsLoad();
  }
}

async function gsClearSetup() {
  if (gsState.busy) return;
  const d = gsState.data;
  if (!d || !d.keys || !d.keys.length) return;
  gsState.busy = true;
  try {
    gsApplyData(await postJson('/api/game-setup/clear', {}));
    gsRefreshVerdicts();
  } catch (err) {
    toast(esc(err.message), 'err');
    gsState.busy = false;
  }
}

$('gsGroups').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-gs]');
  if (!btn || btn.disabled) return;
  gsToggle(btn.dataset.gs, btn.getAttribute('aria-pressed') !== 'true');
});
$('gsClear').addEventListener('click', gsClearSetup);
$('gsBanner').addEventListener('click', () => {
  const panel = $('gsPanel');
  const go = () => { if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'start' }); };
  if (document.body.dataset.page === 'load-order') go();
  else {
    location.hash = '#/load-order';
    window.setTimeout(go, 150);
  }
});
// The banner is global, so its state is refreshed on every navigation - one
// small GET per page show, the same price every other page already pays.
window.addEventListener('hashchange', () => { gsLoad(); });
window.addEventListener('DOMContentLoaded', () => { gsLoad(); });
