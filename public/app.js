'use strict';

// App shell: shared helpers, hash router (#/dashboard, #/config, #/mods) and
// the game-status pill. Each page script registers itself in `pages`.

const $ = (id) => document.getElementById(id);
const pages = {}; // name -> { show(params) }

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

// A number for display, or nothing. Lives here rather than in a page because
// three scripts wanted it and two of them declared it, which is a SyntaxError
// in a browser: classic scripts share one global scope, and a duplicate
// top-level const makes the browser discard BOTH files.
const n = (v) => (v == null ? '' : Number(v).toLocaleString());

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
// Mod text is XML, so a name can arrive with entities in it: one mod is called
// "[COLOR_FLOAT_SCIENCE]Leugi &amp; Lime[ENDCOLOR] ..." and the game stores
// exactly that, so decoding at the point of display is the only place it can
// happen - changing what we write to the database would stop matching the game.
// Decoding before escaping means "&amp;" becomes "&" and esc() puts it back as
// a single entity, so it renders as "&" rather than "&amp;amp;".
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Only ever a real character. Numeric references to < or > are left
      // alone so a numeric entity can never smuggle markup into the page.
      return Number.isFinite(n) && n > 0 && n < 0x110000 && n !== 0x3c && n !== 0x3e ? String.fromCodePoint(n) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, key) ? XML_ENTITIES[key] : whole;
  });
}

// Escapes, but treats the text as XML first. Everything that reaches the page
// as mod text goes through here, so an entity in a name, teaser or description
// renders as the character it stands for.
function escText(s) {
  return esc(decodeXml(String(s == null ? '' : s)));
}

function renderCivText(s) {
  s = String(s == null ? '' : s);
  const re = /\[([^\]]+)\]/g;
  let out = '', last = 0, depth = 0, m;
  while ((m = re.exec(s))) {
    out += escText(s.slice(last, m.index));
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
  out += escText(s.slice(last));
  while (depth-- > 0) out += '</span>';
  return out;
}

// Plain-text form of renderCivText for contexts where HTML cannot render
// (<option> text, native confirm()/prompt() dialogs). Drops the same [...]
// markup runs renderCivText handles, decodes entities, collapses whitespace.
function stripCivText(s) {
  return decodeXml(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ')).replace(/\s+/g, ' ').trim();
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
  if (!g.known) {
    pill.className = 'pill';
    pill.textContent = 'Game status unknown';
  } else {
    pill.className = 'pill ' + (g.running ? 'bad' : 'good');
    pill.textContent = g.running ? 'Civ6 is running' : 'Civ6 is closed';
  }
  document.dispatchEvent(new CustomEvent('gamestatus')); // pages that write react to this
}

async function pollGame() {
  try {
    setGameStatus(await api('/api/game'));
  } catch (_) {
    // The toolkit itself isn't answering (stopped or restarting).
    $('gamePill').className = 'pill bad';
    $('gamePill').textContent = 'Toolkit not running';
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  route();
  pollGame();
  setInterval(pollGame, 10000);
});
