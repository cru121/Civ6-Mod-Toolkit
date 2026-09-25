'use strict';

// App shell: shared helpers, hash router (#/dashboard, #/config, #/mods) and
// the game-status pill. Each page script registers itself in `pages`.

const $ = (id) => document.getElementById(id);
const pages = {}; // name -> { show(params) }
pages.mods = {};  // placeholder page until the mod manager lands

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function postJson(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

// ---- router ----------------------------------------------------------------

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, query] = h.split('?');
  return { name: pages[name] ? name : 'dashboard', params: new URLSearchParams(query || '') };
}

function route() {
  const { name, params } = parseRoute();
  document.body.dataset.page = name;
  for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== `page-${name}`;
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
  Promise.resolve(pages[name].show && pages[name].show(params)).catch((err) => toast(err.message, 'err'));
}

// ---- game status -----------------------------------------------------------

const game = { running: false, known: false };

function setGameStatus(g) {
  Object.assign(game, g);
  const pill = $('gamePill');
  if (!g.known) { pill.className = 'pill'; pill.textContent = 'Game status unknown'; return; }
  pill.className = 'pill ' + (g.running ? 'bad' : 'good');
  pill.textContent = g.running ? 'Civ6 is running' : 'Civ6 is closed';
}

async function pollGame() {
  try { setGameStatus(await api('/api/game')); } catch (_) { /* server gone; keep last */ }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  route();
  pollGame();
  setInterval(pollGame, 10000);
});
