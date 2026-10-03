'use strict';

// Phase 8 automated proof: the browser page's scripts, checked the way a browser
// loads them.
//
// The bug this exists for: clicking the fourth tab returned to the first. The
// router was fine. The cause was in the console -
//
//   Uncaught SyntaxError: Identifier 'esc' has already been declared
//     loadorder.js:1
//   Uncaught SyntaxError: Identifier 'esc' has already been declared
//     looverrides.js:1
//
// Classic <script> tags share ONE global scope, so `const esc` at the top level of
// two files is a SyntaxError, and the browser discards BOTH files rather than the
// second one. Neither `pages['load-order']` nor `pages['load-overrides']` was ever
// registered, so parseRoute's fallback sent the user to the dashboard - and the
// whole override-management surface was unreachable, not merely misrouted.
//
// The existing per-file `node --check` in the release workflow cannot see this by
// construction: each file is valid on its own, and the error only exists in the
// combination. So this checks the combination, which is what a browser does.
//
// It also checks the other half, which is what turned a syntax error into a dead
// feature: every route the navigation offers must be registered by some script.
// A nav link to a page nothing registers fails silently and looks like a router
// bug.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// CIV6_PUBLIC_DIR points the suite at a scratch copy of public/, so the mod-name
// gate below can be shown failing on a planted leak without touching the tree.
const PUB = process.env.CIV6_PUBLIC_DIR || path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};

const scriptSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

console.log('Test 1: every script index.html loads exists, and every one it ships is loaded');
{
  const onDisk = fs.readdirSync(PUB).filter((f) => f.endsWith('.js')).sort();
  check('index.html loads at least the shared app and one page',
    scriptSrcs.includes('app.js') && scriptSrcs.length >= 4, scriptSrcs.join(', '));
  for (const s of scriptSrcs) {
    check(`  ${s} exists`, fs.existsSync(path.join(PUB, s)));
  }
  // A file on disk that nothing loads is dead weight, and the usual way a helper
  // ends up duplicated into a file that IS loaded.
  const orphans = onDisk.filter((f) => !scriptSrcs.includes(f));
  check('  and no script on disk is left unloaded', orphans.length === 0, orphans.join(', '));
}

console.log('\nTest 2: every script parses on its own');
{
  for (const s of scriptSrcs) {
    let ok = true;
    let err = '';
    try { new vm.Script(fs.readFileSync(path.join(PUB, s), 'utf8'), { filename: s }); }
    catch (e) { ok = false; err = e.message; }
    check(`  ${s}`, ok, err);
  }
}

console.log('\nTest 3: they parse together, as one program - which is how a browser reads them');
{
  const all = scriptSrcs
    .map((s) => `// ==== ${s} ====\n${fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n')}`)
    .join('\n');
  let ok = true;
  let err = '';
  let where = '';
  try {
    new vm.Script(all, { filename: 'public-concatenated.js' });
  } catch (e) {
    ok = false;
    err = e.message;
    // Say which file, so a failure names a file rather than an offset.
    const m = (e.stack || '').match(/public-concatenated\.js:(\d+)/);
    if (m) {
      const upto = all.split('\n').slice(0, Number(m[1])).join('\n');
      const at = upto.lastIndexOf('// ==== ');
      where = upto.slice(at + 8, upto.indexOf('\n', at));
    }
  }
  check('the scripts index.html loads, concatenated, parse as one program', ok, ok ? `${scriptSrcs.length} files` : `${err}${where ? ` (in ${where})` : ''}`);
}

console.log('\nTest 4: no top-level name is declared twice across those scripts');
{
  // Column 0 is a sound test for "top level" in this codebase's style: a
  // declaration inside a function or block is always indented.
  const DECL = [
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;\[]/,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^class\s+([A-Za-z_$][\w$]*)\s*[({]/,
  ];
  const owners = new Map();
  for (const s of scriptSrcs) {
    fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      for (const re of DECL) {
        const m = re.exec(line);
        if (!m) continue;
        if (!owners.has(m[1])) owners.set(m[1], []);
        owners.get(m[1]).push(`${s}:${i + 1}`);
      }
    });
  }
  const dupes = [...owners].filter(([, v]) => v.length > 1);
  check('no top-level name is declared in two of them', dupes.length === 0,
    dupes.map(([n, v]) => `${n} in ${v.join(' and ')}`).join('; '));
  // Worth saying how many were found, so a pass is not mistaken for "found none
  // because the scan matched nothing".
  check('  and the scan found the declarations to compare', owners.size >= 20, `${owners.size} top-level names`);
}

console.log('\nTest 5: every route the navigation offers is registered by some script');
{
  // This is the half that turned a syntax error into a dead feature. The router
  // falls back to the dashboard for an unknown name, so a nav link to a page
  // nothing registers looks exactly like a router bug - which is how this was
  // misdiagnosed before the console was read.
  const navs = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
  check('the navigation offers at least the four pages', navs.length >= 4, navs.join(', '));
  const all = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8')).join('\n');
  for (const n of navs) {
    const re = new RegExp(`pages\\s*(?:\\[['"]${n}['"]\\]|\\.${n}\\s*=|\\[['"]${n}['"]\\]\\s*=)`);
    check(`  #/${n} is registered`, re.test(all));
  }
  // And the reverse: a page registered but not reachable from the navigation is
  // not a bug - the override management screen is deliberately not a nav item, and
  // the plan says so. Recorded as an observation, not a requirement.
  const registered = [...all.matchAll(/pages\s*(?:\[['"]([a-z-]+)['"]\]|\.([A-Za-z_$][\w$]*))\s*=/g)]
    .map((m) => m[1] || m[2]);
  const unreachable = [...new Set(registered)].filter((n) => !navs.includes(n));
  console.log(`  note: ${[...new Set(registered)].length} pages registered, ${navs.length} in the navigation`);
  console.log(`        reachable only by link: ${unreachable.join(', ') || 'none'}`);
}

console.log('\nTest 6: mod names render in page HTML and strip in dialogs/options');
{
  // Convention (mod-name-display): a mod name can carry Civ markup
  // ([COLOR_...]...[ENDCOLOR]) that only renders through renderCivText. Page
  // HTML must render it; <option> text and native confirm()/prompt() dialogs
  // must strip it with stripCivText. A bare esc() leaks literal bracket tags.
  // A mod-name-shaped expression is the modName property or .name on a
  // mod-ish receiver (m/o/a). Group, config, label and file names (g.name,
  // c.name, file.name) are not mod names and keep using esc(). A line that
  // already renders or strips is fine (config.js renders the name and escapes
  // the id on one line).
  const MODNAME = /\bmodName\b|(?:^|[^\w$])[moa]\.name\b/;
  const bad = [];
  for (const s of scriptSrcs) {
    fs.readFileSync(path.join(PUB, s), 'utf8').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) return;
      if (/esc\s*\(/.test(line) && MODNAME.test(line) && !/renderCivText|stripCivText/.test(line)) {
        bad.push(`${s}:${i + 1} esc() around a mod name: ${t}`);
      }
      if (/confirm\s*\(|prompt\s*\(|<option/.test(line) && /\$\{/.test(line)
        && MODNAME.test(line) && !/stripCivText/.test(line)) {
        bad.push(`${s}:${i + 1} raw mod name in a dialog/option string: ${t}`);
      }
    });
  }
  check('no template escapes a mod name instead of rendering it', bad.length === 0, bad.join('; '));
  // The fixed dialog sites build their strings away from the confirm()/prompt()
  // call, so the line scan above cannot see them: assert they still strip.
  const lov = fs.readFileSync(path.join(PUB, 'looverrides.js'), 'utf8');
  const pro = fs.readFileSync(path.join(PUB, 'profiles.js'), 'utf8');
  const cfg = fs.readFileSync(path.join(PUB, 'config.js'), 'utf8');
  const mod = fs.readFileSync(path.join(PUB, 'mods.js'), 'utf8');
  const lord = fs.readFileSync(path.join(PUB, 'loadorder.js'), 'utf8');
  check('  the override prompt still strips the mod name', /stripCivText\(o\.modName\)/.test(lov));
  check('  the profile switch preview still strips mod names',
    /stripCivText\(\(all\.get\(id\)/.test(pro) && /stripCivText\(m\.name\)/.test(pro));
  check('  the config delete confirm still strips the name', /stripCivText\(name\)/.test(cfg));
  // Both build their strings away from the toast()/confirm() call, so the
  // line scan above cannot see them either: the import-skipped names travel
  // as the `names`/`shown` aliases into the toast detail (innerHTML), and
  // the remove-mod `what` travels into confirm(). A generic alias pattern
  // is disproportionate - `names` also holds label names that keep esc()
  // (mods.js label chips, label-edit dialog) - so pin the fixed sites.
  check('  the import-skipped toast detail still renders mod names',
    /names\.slice\(0,\s*5\)\.map\(renderCivText\)/.test(pro));
  check('  the remove-mod confirm still strips the mod name', /stripCivText\(m\.name\)/.test(mod));
  check('  condition reason/why text renders civ markup',
    /renderCivText\(a\.reason\)/.test(lord) && /renderCivText\(a\.unknown\[0\]\.why\)/.test(lord));
  // And the scan is not vacuous: the convention helpers are actually in use.
  const uses = scriptSrcs.map((s) => fs.readFileSync(path.join(PUB, s), 'utf8'))
    .join('\n').match(/(?:render|strip)CivText\(/g) || [];
  check('  and the scan saw the helpers in use', uses.length >= 10, `${uses.length} render/strip call sites`);
}

console.log('\nTest 7: differential attribution renders (log-pairing 3.1)');
{
  // Whole-file load like phase7 Tests 16b/18: the real conflicts.js render
  // path under stubs. Stubs mirror the app.js contract (esc escapes HTML,
  // renderCivText drops [...] markup), so a bare esc() around a mod name
  // would leak literal bracket tags and fail the naming check below.
  const cfSrc = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub = (s) => escStub(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els = {};
  const dollarStub = (id) => {
    if (!els[id]) els[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', addEventListener() {} };
    return els[id];
  };
  let cx = null;
  let cxErr = '';
  try {
    cx = vm.createContext({ $: dollarStub, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub, renderCivText: renderStub,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc, cx, { filename: 'conflicts.js' });
  } catch (e) { cxErr = e.message; }
  check('the conflicts script loads headless under stubs', cx !== null, cxErr);
  if (cx) {
    const run = (expr) => vm.runInContext(expr, cx);
    const named = run('cfResponsibleHtml({ responsibleModId: "m1", responsibleModName: "[COLOR_GREEN]Green Mod[ENDCOLOR]" })');
    check('an attributed row names the mod', /Green Mod/.test(named), named);
    check('  with no literal bracket tags', !/\[COLOR/i.test(named) && !/ENDCOLOR/i.test(named), named);
    const tCtx = run('cfStrengthTag({ responsibleModId: "m1", strength: "context-proven", approximate: false })');
    const tHint = run('cfStrengthTag({ responsibleModId: "m1", strength: "hint-matched", approximate: false })');
    const tBra = run('cfStrengthTag({ responsibleModId: "m3", strength: "bracket-approximate", approximate: true })');
    check('attributed strength renders in plain words', /traced to this mod/.test(tCtx), tCtx);
    check('hint strength renders in plain words', /matched by file name/.test(tHint), tHint);
    check('best-guess renders with the approximate marker',
      /best guess/.test(tBra) && /approximate/.test(tBra), tBra);
    check('replay strength renders in plain words',
      /found by replay/.test(run('cfStrengthTag({ responsibleModId: "m2", strength: "replay" })')));
    check('unattributed rows never carry an attributing label',
      /no mod named/.test(run('cfStrengthTag({ strength: "context-proven" })'))
      && !/traced to this mod/.test(run('cfStrengthTag({ strength: "context-proven" })'))
      && !/matched by file name/.test(run('cfStrengthTag({ strength: "hint-matched" })')));
    const amb = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "bracket-ambiguous", candidates: [{ path: "a", attribution: { modName: "Cand A" } }, { path: "b", attribution: { modName: "Cand B" } }] } })');
    check('same-ms ambiguity lists candidates instead of picking',
      /Cand A/.test(amb) && /Cand B/.test(amb) && /could be/.test(amb), amb);
    const unResp = run('cfResponsibleHtml({})');
    const unTag = run('cfStrengthTag({ strength: "unattributed" })');
    const unNote = run('cfAttributionNote({ responsibleModId: null, attribution: { kind: "unattributed", reason: "no-loading-precedes" } })');
    check('an unattributed row states so in plain words', /Mod unknown/.test(unResp) && /no mod named/.test(unTag), `${unResp} / ${unTag}`);
    check('  with the reason stated in plain words, never dropped', /nothing was loading/.test(unNote), unNote);
    run('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"m1","responsibleModName":"[COLOR_GREEN]Green Mod[ENDCOLOR]","fileLabel":"Data.xml","stmtIndex":0,"logLine":10,"logText":"boom","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"m2","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"fail","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":20,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{}},{"responsibleModId":"m3","responsibleModName":"Bracket Mod","fileLabel":"D.xml","stmtIndex":null,"logLine":21,"logText":"b","strength":"bracket-approximate","approximate":true,"attribution":{}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":22,"logText":"u","strength":"bracket-approximate","approximate":true,"attribution":{"kind":"bracket-ambiguous","candidates":[{"path":"a","attribution":{"modName":"Cand A"}},{"path":"b","attribution":{"modName":"Cand B"}}]}},{"responsibleModId":null,"fileLabel":"(no file hint)","stmtIndex":null,"logLine":23,"logText":"v","strength":"unattributed","approximate":true,"attribution":{"kind":"unattributed","reason":"no-loading-precedes"}}]}}');
    run('cfRenderReplay()');
    const diffHtml = els.cfReplayDiff.innerHTML;
    check('the differential names the mod with no literal bracket tags',
      /Green Mod/.test(diffHtml) && !/\[COLOR/i.test(diffHtml), diffHtml.slice(0, 200));
    check('  plain-language strengths render in place, never raw backend labels',
      /traced to this mod/.test(diffHtml) && /no mod named/.test(diffHtml) && /best guess/.test(diffHtml)
      && /found by replay/.test(diffHtml) && /several possible/.test(diffHtml)
      && !/context-proven|hint-matched|bracket-approximate|named by replay/.test(diffHtml));
    check('  the approximate marker and candidate list render',
      /approximate/.test(diffHtml) && /Cand A/.test(diffHtml) && /Cand B/.test(diffHtml));
    check('  the unattributed row states so with its reason in plain words',
      /Mod unknown/.test(diffHtml) && /nothing was loading/.test(diffHtml));
  }
}

console.log('\nTest 8: differential grouped by mod, searchable, hideable (log-pairing follow-up)');
{
  // Same stubbed-DOM harness as Test 7: the grouping, search, and toggle
  // helpers run headless against the real conflicts.js render path.
  const cfSrc8 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub8 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub8 = (s) => escStub8(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els8 = {};
  const dollarStub8 = (id) => {
    if (!els8[id]) els8[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els8[id];
  };
  let cx8 = null;
  let cxErr8 = '';
  try {
    cx8 = vm.createContext({ $: dollarStub8, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub8, renderCivText: renderStub8,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc8, cx8, { filename: 'conflicts.js' });
  } catch (e) { cxErr8 = e.message; }
  check('the conflicts script loads headless under stubs', cx8 !== null, cxErr8);
  if (cx8) {
    const run8 = (expr) => vm.runInContext(expr, cx8);
    run8('cfState.diffFilter = ""; cfState.hideUnattributed = false');
    run8('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":1,"collisions":[],"gatedOut":[{"modId":"guid-gated-999","modName":"Gated Mod","fileLabel":"g.sql","statements":1,"reason":"needs some-mod to be on in this profile"}],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"A.xml","stmtIndex":0,"logLine":10,"logText":"UNIQUE constraint failed: T.Id","replayError":"UNIQUE constraint failed: T.Id","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"guid-bbb-222","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"no such table: Nope","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L1.xml","stmtIndex":null,"logLine":20,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L2.xml","stmtIndex":null,"logLine":21,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":"guid-aaa-111","responsibleModName":"Green Mod","fileLabel":"L3.xml","stmtIndex":null,"logLine":22,"logText":"no such table: Lang","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint"}},{"responsibleModId":null,"responsibleModName":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":23,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{"kind":"hint","fileHint":"C.xml","reason":"file-hint-only"}}]}}');
    run8('cfRenderReplay()');
    const diffHtml8 = els8.cfReplayDiff.innerHTML;
    check('one group per responsible mod with per-mod counts',
      /Green Mod/.test(diffHtml8) && /2 findings/.test(diffHtml8) && /Plain Mod/.test(diffHtml8)
      && /Mod unknown/.test(diffHtml8), diffHtml8.slice(0, 300));
    check('same failure across three files reads as one finding',
      (diffHtml8.match(/no such table: Lang/g) || []).length === 1
      && /3 files, same error/.test(diffHtml8) && /L1\.xml/.test(diffHtml8) && /L3\.xml/.test(diffHtml8));
    check('attributed groups order before unattributed',
      diffHtml8.indexOf('Green Mod') < diffHtml8.indexOf('Plain Mod')
      && diffHtml8.indexOf('Plain Mod') < diffHtml8.indexOf('Mod unknown'));
    run8('cfState.hideUnattributed = true');
    run8('cfRenderDiff()');
    check('hide-unattributed drops the unnamed group with a hidden-count note',
      !/Mod unknown/.test(els8.cfReplayDiff.innerHTML) && /Green Mod/.test(els8.cfReplayDiff.innerHTML)
      && /1 unnamed finding hidden/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    run8('cfState.hideUnattributed = false; cfState.diffFilter = "green mod"');
    run8('cfRenderDiff()');
    check('exact-match search shows only the named mod group',
      /Green Mod/.test(els8.cfReplayDiff.innerHTML) && !/Plain Mod/.test(els8.cfReplayDiff.innerHTML)
      && !/Mod unknown/.test(els8.cfReplayDiff.innerHTML)
      && /matching the filter/.test(els8.cfDiffNote.textContent), els8.cfDiffNote.textContent);
    run8('cfState.diffFilter = "no such mod"');
    run8('cfRenderDiff()');
    check('search with no exact match is an explicit empty state',
      /No mod is named exactly that/.test(els8.cfReplayDiff.innerHTML));
    run8('cfState.diffFilter = ""');
    run8('cfRenderDiff()');
    const fullHtml8 = els8.cfReplayDiff.innerHTML;
    const gatedHtml8 = els8.cfReplayGated.innerHTML;
    check('differential rows never show raw mod ids',
      !/guid-aaa-111|guid-bbb-222/.test(fullHtml8), fullHtml8.slice(0, 200));
    check('gated-out rows name the mod display name, not the id',
      /Gated Mod/.test(gatedHtml8) && !/guid-gated-999/.test(gatedHtml8)
      && /not run/.test(gatedHtml8), gatedHtml8.slice(0, 200));
    const unSection8 = fullHtml8.slice(fullHtml8.indexOf('Mod unknown'));
    check('no contradictory labels on unattributed rows',
      !/traced to this mod|best guess|found by replay/.test(unSection8)
      && /no mod named/.test(unSection8));
    check('tooltips answer what-to-do-next',
      /title="/.test(fullHtml8) && /open the file/.test(fullHtml8));
    check('attributed file-name matches render in plain words',
      /matched by file name/.test(fullHtml8));
  }
}

console.log('\nTest 9: conflicts readability (toggle layout, heading, stacked divergences, collision names)');
{
  // Same stubbed-DOM harness as Tests 7/8: the real conflicts.js render path
  // headless, plus index.html source checks for the layout-only fixes.
  const cfSrc9 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub9 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub9 = (s) => escStub9(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els9 = {};
  const dollarStub9 = (id) => {
    if (!els9[id]) els9[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els9[id];
  };
  let cx9 = null;
  let cxErr9 = '';
  try {
    cx9 = vm.createContext({ $: dollarStub9, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub9, renderCivText: renderStub9,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc9, cx9, { filename: 'conflicts.js' });
  } catch (e) { cxErr9 = e.message; }
  check('the conflicts script loads headless under stubs', cx9 !== null, cxErr9);
  if (cx9) {
    const run9 = (expr) => vm.runInContext(expr, cx9);
    const whoNamed = run9('cfWhoHtml({ modId: "guid-winner-1", modName: "[COLOR_GREEN]Winner Mod[ENDCOLOR]", fileLabel: "w.sql", stmtIndex: 2 })');
    check('collision rows render the display name, never the mod id',
      /Winner Mod/.test(whoNamed) && !/guid-winner-1/.test(whoNamed) && !/\[COLOR/i.test(whoNamed), whoNamed);
    const whoFallback = run9('cfWhoHtml({ modId: "guid-unknown-9", fileLabel: "g.sql", stmtIndex: 0 })');
    check('  with mod-id fallback only when unresolvable', /guid-unknown-9/.test(whoFallback), whoFallback);
    const sameTag = run9('cfCollisionHtml({ table: "T", pk: "k", column: "V", writes: 2, sameMod: true, fidelityLimited: [], winner: { modId: "m", modName: "Same Mod", fileLabel: "a.sql", stmtIndex: 0 }, losers: [] })');
    check('same-mod pairs carry the same-mod tag', /same mod/.test(sameTag), sameTag.slice(0, 200));
    const crossTag = run9('cfCollisionHtml({ table: "T", pk: "k", column: "V", writes: 2, sameMod: false, fidelityLimited: [], winner: { modId: "m", modName: "M", fileLabel: "a.sql", stmtIndex: 0 }, losers: [] })');
    check('  and cross-mod pairs carry none', !/same mod/.test(crossTag));
    run9('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[{"table":"CrossT","pk":"k","column":"V","writes":2,"sameMod":false,"fidelityLimited":[],"winner":{"modId":"guid-cross-w","modName":"Cross Winner","fileLabel":"w.sql","stmtIndex":0},"losers":[{"modId":"guid-cross-l","modName":"Cross Loser","fileLabel":"l.sql","stmtIndex":0}]},{"table":"SameT","pk":"k","column":"V","writes":2,"sameMod":true,"fidelityLimited":[],"winner":{"modId":"guid-same-w","modName":"Same Winner","fileLabel":"w2.sql","stmtIndex":1},"losers":[{"modId":"guid-same-w","modName":"Same Winner","fileLabel":"w1.sql","stmtIndex":0}]}],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":false,"reason":"no log"}}');
    run9('cfRenderReplay()');
    const colHtml9 = els9.cfReplayCollisions.innerHTML;
    check('replay rows name mods, never raw ids',
      /Cross Winner/.test(colHtml9) && /Same Winner/.test(colHtml9) && /Cross Loser/.test(colHtml9)
      && !/guid-cross-w|guid-cross-l|guid-same-w/.test(colHtml9), colHtml9.slice(0, 200));
    check('the client keeps server order: same-mod rows render after cross-mod rows',
      colHtml9.indexOf('CrossT') >= 0 && colHtml9.indexOf('CrossT') < colHtml9.indexOf('SameT')
      && /same mod/.test(colHtml9.slice(colHtml9.indexOf('SameT'))));
    const divHtml9 = run9('cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "m/a.sql", assumedSecond: "m/b.sql", assumedOrder: "m/a.sql before m/b.sql (assumed replay order)", observedOrder: "m/b.sql before m/a.sql (game-observed order)" }] })');
    check('divergence keeps the same content', /m\/a\.sql/.test(divHtml9) && /m\/b\.sql/.test(divHtml9)
      && /assumed replay order/.test(divHtml9) && /game-observed order/.test(divHtml9), divHtml9.slice(0, 200));
    check('divergence rows stack: pair on its own line, no side-by-side columns',
      /lo-bandhead/.test(divHtml9) && !/<span class="lo-mod">order differs/.test(divHtml9));
  }
  {
    // Layout-only fixes live in index.html: assert structure, not pixels.
    const html9 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    check('the differential section is headed Log pairing report',
      /<h3>Log pairing report<\/h3>/.test(html9) && !/Game log vs replay/.test(html9));
    const hideAt9 = html9.indexOf('id="cfHideUnattributed"');
    const noteAt9 = html9.indexOf('id="cfDiffNote"');
    check('the hidden-count note sits under the toggle row, not beside it',
      hideAt9 >= 0 && noteAt9 > hideAt9 && /<\/div>/.test(html9.slice(hideAt9, noteAt9)));
    check('toggle and note keep their styling classes',
      /<label class="toggle"[^>]*><input[^>]*id="cfHideUnattributed"/.test(html9)
      && /<div class="meta" id="cfDiffNote"><\/div>/.test(html9));
  }
}

console.log('\nTest 10: conflicts polish batch (FK placement, divergence mods, heading sizes)');
{
  // Fix 1: the missing-references control lives in the replay panel-head row
  // beside Run replay (not above the panel), labelled as what-to-do-next.
  const html10 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const css10 = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  check('the FK control is labelled how-to-handle in plain words',
    /<label class="meta" for="cfFkMode">How to handle missing references<\/label>/.test(html10));
  const headAt10 = html10.indexOf('DB collision replay');
  const fkAt10 = html10.indexOf('id="cfFkMode"');
  const runAt10 = html10.indexOf('id="cfRunReplay"');
  check('the FK select sits in the panel-head row beside Run replay',
    headAt10 >= 0 && fkAt10 > headAt10 && runAt10 > fkAt10
    && /<\/div>\s*<\/div>\s*<div class="panel-body">/.test(html10.slice(runAt10, runAt10 + 400)));
  const fkSel10 = html10.slice(fkAt10, html10.indexOf('</select>', fkAt10));
  check('Off stays the game-like default, On the strict comparison',
    /<option value="off">Off — game-like: skip past missing references<\/option>/.test(fkSel10)
    && /<option value="on">On — strict: stop each file at the first missing reference<\/option>/.test(fkSel10));
  check('the FK tooltip answers what-to-do-next',
    /Leave Off to replay like the game/.test(fkSel10) && /Switch On for a strict comparison/.test(fkSel10));
  check('the replay head row centres and wraps instead of floating detached',
    /#page-conflicts \.panel-actions \{[^}]*align-items:\s*center[^}]*flex-wrap:\s*wrap/.test(css10));
}
{
  // Fix 2: divergence rows name owning mods, resolved server-side.
  const cfSrc10 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub10 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub10 = (s) => escStub10(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els10 = {};
  const dollarStub10 = (id) => {
    if (!els10[id]) els10[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els10[id];
  };
  let cx10 = null;
  let cxErr10 = '';
  try {
    cx10 = vm.createContext({ $: dollarStub10, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub10, renderCivText: renderStub10,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc10, cx10, { filename: 'conflicts.js' });
  } catch (e) { cxErr10 = e.message; }
  check('the conflicts script loads headless under stubs', cx10 !== null, cxErr10);
  if (cx10) {
    const run10 = (expr) => vm.runInContext(expr, cx10);
    const divHtml10 = run10('cfCalibrationHtml({ available: true, divergences: [{ assumedFirst: "data/a.sql", assumedSecond: "data/b.sql", assumedOrder: "data/a.sql before data/b.sql (assumed replay order)", observedOrder: "data/b.sql before data/a.sql (game-observed order)", assumedFirstMods: [{ modId: "guid-a", modName: "[COLOR_GREEN]Alpha Mod[ENDCOLOR]" }], assumedSecondMods: [{ modId: "guid-b", modName: "Beta Mod" }, { modId: "guid-c", modName: "Gamma Mod" }] }] })');
    check('each divergence file names its owning mod(s) with no bracket tags',
      /Alpha Mod/.test(divHtml10) && /Beta Mod/.test(divHtml10) && /Gamma Mod/.test(divHtml10)
      && !/\[COLOR/i.test(divHtml10) && !/ENDCOLOR/i.test(divHtml10), divHtml10.slice(0, 300));
    check('multi-claimant files list every claimant, never a raw mod id',
      /Beta Mod, Gamma Mod/.test(divHtml10) && !/guid-a|guid-b|guid-c/.test(divHtml10));
    check('unowned files state so in plain words',
      /owning mod unknown/.test(run10('cfCalibrationFileHtml("x.sql", [])')));
    check('ownership tooltips answer what-to-do-next',
      /open it there/.test(divHtml10));
  }
  // Server side stays additive: existing divergence labels untouched, the mod
  // lists ride alongside via a ComponentFiles-claimant lookup.
  const srv10 = fs.readFileSync(path.join(PUB, '..', 'src', 'server.js'), 'utf8');
  check('divergence mods resolve server-side and additively',
    /assumedFirstMods/.test(srv10) && /assumedSecondMods/.test(srv10)
    && /ComponentFiles/.test(srv10) && /fileClaimants/.test(srv10));
}
{
  // Fix 3: panel sub-heads sit one step below the 16px h2.
  const css10b = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const html10b = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const h3rule = /\.panel h3 \{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/.exec(css10b);
  check('a .panel h3 rule exists, smaller than the 16px h2',
    !!h3rule && Number(h3rule[1]) < 16, h3rule ? `${h3rule[1]}px` : 'no rule');
  check('the replay sub-heads stay h3 under the panel h2',
    /<h2>DB collision replay/.test(html10b)
    && /<h3>Files the replay skipped or stopped on<\/h3>/.test(html10b)
    && /<h3>Log pairing report<\/h3>/.test(html10b));
  check('the audited override sub-head stays h3 under the same rule',
    /<h3>Where to put it<\/h3>/.test(html10b));
}

console.log('\nTest 11: assumed-setup verdicts read distinctly in the load-order list (game-setup 3.1)');
{
  // Same stubbed-DOM harness as Tests 7-10: the real loadorder.js render path
  // headless. Rows decided by assertion carry `assumed` from the verdict API
  // (src/loadorder.js task 2.1); measured rows never do.
  const loSrc11 = fs.readFileSync(path.join(PUB, 'loadorder.js'), 'utf8');
  const escStub11 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub11 = (s) => escStub11(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const dollarStub11 = () => ({ addEventListener() {} });
  let cx11 = null;
  let cxErr11 = '';
  try {
    cx11 = vm.createContext({ $: dollarStub11, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub11, renderCivText: renderStub11,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(loSrc11, cx11, { filename: 'loadorder.js' });
  } catch (e) { cxErr11 = e.message; }
  check('the load-order script loads headless under stubs', cx11 !== null, cxErr11);
  if (cx11) {
    const run11 = (expr) => vm.runInContext(expr, cx11);
    const measured11 = (over) => Object.assign({
      modId: null, modName: 'M', componentRowId: null, type: 'UpdateDatabase',
      override: null, state: 'author default', misspelled: false, protected: true,
      willRun: true, reason: null, unknown: [], assumed: false, inCompare: null,
    }, over);
    const runHtml11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: true, assumed: true }))})`);
    check('an assumed will-run row carries the marker',
      /assumed setup/.test(runHtml11) && /lo-assumed/.test(runHtml11), runHtml11.slice(0, 200));
    check('  with what-to-do-next wording, never a bare label',
      /title="/.test(runHtml11) && /game-setup/.test(runHtml11), runHtml11.slice(0, 300));
    const offHtml11 = run11(`conditionLine(${JSON.stringify({ willRun: false, reason: 'needs X', assumed: true, unknown: [] })})`);
    check('an assumed not-run row carries the marker on its verdict line',
      /not run/.test(offHtml11) && /assumed setup/.test(offHtml11), offHtml11.slice(0, 200));
    const offRow11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: false, reason: 'needs X', assumed: true }))})`);
    check('  exactly once per row', (offRow11.match(/assumed setup/g) || []).length === 1, offRow11.slice(0, 300));
    const measRun11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: true }))})`);
    const measOff11 = run11(`actionRow(${JSON.stringify(measured11({ willRun: false, reason: 'needs X' }))})`);
    const measUnknown11 = run11(`conditionLine(${JSON.stringify({ willRun: null, reason: null, assumed: false, unknown: [{ why: 'needs X - undecidable here' }] })})`);
    check('measured rows carry no marker',
      !/assum/i.test(measRun11) && !/assum/i.test(measOff11) && !/assum/i.test(measUnknown11),
      `${measRun11.slice(0, 120)} / ${measOff11.slice(0, 120)}`);
    check('  and the measured not-run wording is unchanged',
      /not run &mdash; needs X/.test(measOff11), measOff11.slice(0, 200));
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log('\nTest 12: packaging findings and zero-rows display wiring');
{
  // Same stubbed-DOM harness as Tests 7-10: the real conflicts.js render
  // path headless. The live packaging groups plus zero-rows rows, each naming
  // the mod by display name with a plain-words reason and a what-to-do-next
  // hint; clean states state so, never a blank hole. Backend coverage for the
  // schema-mismatch check lives in phase 10; here the panel group for it
  // plus the remaining groups and their empty states are pinned.
  const cfSrc12 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub12 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub12 = (s) => escStub12(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els12 = {};
  const dollarStub12 = (id) => {
    if (!els12[id]) els12[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els12[id];
  };
  let cx12 = null;
  let cxErr12 = '';
  try {
    cx12 = vm.createContext({ $: dollarStub12, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub12, renderCivText: renderStub12,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc12, cx12, { filename: 'conflicts.js' });
  } catch (e) { cxErr12 = e.message; }
  check('the conflicts script loads headless under stubs', cx12 !== null, cxErr12);
  if (cx12) {
    const run12 = (expr) => vm.runInContext(expr, cx12);
    const unreg = run12('cfPackagingUnregHtml({ kind: "unregistered-file", modId: "guid-unreg-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it, so it never reaches the game" })');
    check('files no action loads name the mod display name, never the id',
      /Green Mod/.test(unreg) && !/guid-unreg-1/.test(unreg) && !/\[COLOR/i.test(unreg), unreg.slice(0, 200));
    check('  with the plain-words reason and a what-to-do-next hint',
      /never reaches the game/.test(unreg) && /title="/.test(unreg) && /Add it to an action/.test(unreg));
    const unlisted = run12('cfPackagingUnregHtml({ kind: "unregistered-file", modId: "guid-unreg-2", name: "Disk Mod", file: "Data/Orphan.sql", reason: "sits in the mod folder but the mod does not list it, so no action can load it" })');
    check('  the unlisted variant points at the mod listing, not an action',
      /List it in the mod/.test(unlisted) && !/Add it to an action/.test(unlisted));
    const dup = run12('cfPackagingDupHtml({ kind: "duplicate-mod-id", modId: "guid-dup-1", key: "guid-dup-1", claimants: [{ modId: "guid-dup-1", name: "[COLOR_BLUE]Dupe One[ENDCOLOR]", folder: "/mods/Alpha" }, { modId: "guid-dup-1", name: "Dupe Two", folder: "/mods/Beta" }], reason: "is claimed by more than one mod folder, so the game cannot tell them apart" })');
    check('shared-id rows name every claimant folder with no raw ids or markup',
      /Dupe One/.test(dup) && /Dupe Two/.test(dup) && /\/mods\/Alpha/.test(dup) && /\/mods\/Beta/.test(dup)
      && !/guid-dup-1/.test(dup) && !/\[COLOR/i.test(dup));
    check('  with a give-one-a-different-id hint',
      /different ModId/.test(dup));
    const schema = run12('cfPackagingSchemaHtml({ kind: "schema-mismatch", modId: "guid-schema-1", name: "[COLOR_GREEN]Green Mod[ENDCOLOR]", file: "Data/Units.sql", table: "Units", side: "gameplay", expectedDb: "front-end", reason: "touches table Units, which lives in the front-end database, but the file loads in a gameplay action" })');
    check('tables in the wrong database name the mod, file, table and expected database',
      /Green Mod/.test(schema) && /Data\/Units\.sql/.test(schema) && /table Units/.test(schema) && /front-end database/.test(schema)
      && !/guid-schema-1/.test(schema) && !/\[COLOR/i.test(schema), schema.slice(0, 220));
    check('  with the plain-words reason and a what-to-do-next hint',
      /lives in the front-end database/.test(schema) && /title="/.test(schema) && /Move the file into a front-end action/.test(schema));
    const zero = run12('cfZeroRowsHtml({ modId: "guid-zero-1", modName: "[COLOR_GREEN]Zero Mod[ENDCOLOR]", fileLabel: "Data/T.sql", stmtIndex: 3, verb: "UPDATE" })');
    check('zero-rows rows name the mod and file with the statement number',
      /Zero Mod/.test(zero) && /Data\/T\.sql/.test(zero) && /#3/.test(zero)
      && !/guid-zero-1/.test(zero) && !/\[COLOR/i.test(zero), zero.slice(0, 200));
    check('  in plain words with a what-to-do-next hint, never backend jargon',
      /matched no rows/.test(zero) && /open the file/.test(zero) && /title="/.test(zero)
      && !/replay-relative/.test(zero));
    run12('cfState.packaging = { ok: true, warnings: ['
      + '{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" },'
      + '{ kind: "duplicate-mod-id", modId: "guid-d", key: "k", claimants: [{ modId: "guid-d", name: "Dupe One", folder: "A" }, { modId: "guid-d", name: "Dupe Two", folder: "B" }], reason: "claimed by more than one" }'
      + '] }');
    run12('cfRenderPackaging()');
    const packHtml = els12.cfPackagingList.innerHTML;
    check('both groups render with their rows',
      /Files no action loads/.test(packHtml)
      && /Mods sharing one id/.test(packHtml) && /Green Mod/.test(packHtml) && /Dupe Two/.test(packHtml),
      packHtml.slice(0, 200));
    check('  and no raw mod ids leak anywhere in the panel',
      !/guid-u|guid-d/.test(packHtml));
    run12('cfState.packaging = { ok: true, warnings: ['
      + '{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" },'
      + '{ kind: "schema-mismatch", modId: "guid-s", name: "Schema Mod", file: "Data/X.sql", table: "T", side: "gameplay", expectedDb: "front-end", reason: "touches table T, which lives in the front-end database" },'
      + '{ kind: "duplicate-mod-id", modId: "guid-d", key: "k", claimants: [{ modId: "guid-d", name: "Dupe One", folder: "A" }, { modId: "guid-d", name: "Dupe Two", folder: "B" }], reason: "claimed by more than one" }'
      + '] }');
    run12('cfRenderPackaging()');
    const packSchemaHtml = els12.cfPackagingList.innerHTML;
    check('the schema-mismatch group renders with its rows and no raw ids',
      /Tables in the wrong database/.test(packSchemaHtml)
      && /Schema Mod/.test(packSchemaHtml) && /Data\/X\.sql/.test(packSchemaHtml)
      && /front-end database/.test(packSchemaHtml) && !/guid-s/.test(packSchemaHtml),
      packSchemaHtml.slice(0, 220));
    check('  and the header count includes the schema rows',
      els12.cfPackagingCount.textContent === '3', els12.cfPackagingCount.textContent);
    run12('cfState.packaging = { ok: true, warnings: [{ kind: "unregistered-file", modId: "guid-u", name: "Green Mod", file: "UI/Extra.lua", reason: "listed by the mod but no action loads it" }] }');
    run12('cfRenderPackaging()');
    check('quiet groups keep their empty state beside a firing one',
      /Green Mod/.test(els12.cfPackagingList.innerHTML)
      && /Every database file loads on one side only/.test(els12.cfPackagingList.innerHTML)
      && /Every mod id belongs to exactly one mod folder/.test(els12.cfPackagingList.innerHTML)
      && /Every table lives where its file loads/.test(els12.cfPackagingList.innerHTML));
    run12('cfState.packaging = { ok: true, warnings: [] }');
    run12('cfRenderPackaging()');
    check('a clean library states so, never a blank hole',
      /Packaging looks clean/.test(els12.cfPackagingList.innerHTML), els12.cfPackagingList.innerHTML.slice(0, 160));
    run12('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"zeroRows":[{"modId":"guid-zero-9","modName":"[COLOR_GREEN]Zero Nine[ENDCOLOR]","fileLabel":"Data/Z.sql","stmtIndex":7,"verb":"DELETE"}],"differential":{"available":false,"reason":"no log"}}');
    run12('cfRenderReplay()');
    check('replay rows carry the zero-rows section with display names',
      /Zero Nine/.test(els12.cfReplayZeroRows.innerHTML) && /Data\/Z\.sql/.test(els12.cfReplayZeroRows.innerHTML)
      && !/guid-zero-9/.test(els12.cfReplayZeroRows.innerHTML) && !/\[COLOR/i.test(els12.cfReplayZeroRows.innerHTML),
      els12.cfReplayZeroRows.innerHTML.slice(0, 200));
    run12('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":false,"reason":"no log"}}');
    run12('cfRenderReplay()');
    check('a replay with no zero-rows states so, never a blank hole',
      /matched at least one row/.test(els12.cfReplayZeroRows.innerHTML));
  }
  {
    // Server side stays additive: the packaging route is a GET beside the
    // other two, and zeroRows rides alongside the replay fields, renaming
    // nothing.
    const srv12 = fs.readFileSync(path.join(PUB, '..', 'src', 'server.js'), 'utf8');
    check('the packaging route is a read-only GET reusing the backend',
      /req\.method === 'GET' && url\.pathname === '\/api\/conflicts\/packaging'/.test(srv12)
      && /packaging\.collectPackagingWarnings/.test(srv12)
      && /loOrder\.openDb/.test(srv12));
    check('zeroRows rides the replay response additively with display names',
      /zeroRows: withModDisplayNames\(report\.zeroRows/.test(srv12));
    const html12 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    check('the conflicts page gains a packaging panel with its controls',
      /id="cfRunPackaging"/.test(html12) && /id="cfPackagingList"/.test(html12) && /id="cfPackagingCount"/.test(html12));
    check('zero-rows rows live inside the replay panel, never a new tab',
      /id="cfReplayZeroRows"/.test(html12) && /Statements that changed nothing/.test(html12)
      && !/data-nav="packaging"/.test(html12));
  }
}

console.log('\nTest 13: packaging groups window large result sets');
{
  // Same stubbed-DOM harness as Test 12: 250 unregistered rows render capped
  // with the full count in the header, then expand in place and collapse.
  const cfSrc13 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub13 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub13 = (s) => escStub13(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els13 = {};
  const dollarStub13 = (id) => {
    if (!els13[id]) els13[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els13[id];
  };
  let cx13 = null;
  let cxErr13 = '';
  try {
    cx13 = vm.createContext({ $: dollarStub13, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub13, renderCivText: renderStub13,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc13, cx13, { filename: 'conflicts.js' });
  } catch (e) { cxErr13 = e.message; }
  check('the conflicts script loads headless under stubs', cx13 !== null, cxErr13);
  if (cx13) {
    const run13 = (expr) => vm.runInContext(expr, cx13);
    check('one group renders at most a hundred rows', run13('cfPackagingWindow') === 100, String(run13('cfPackagingWindow')));
    run13('cfState.packagingExpanded = {}');
    run13('cfState.packaging = { ok: true, warnings: Array.from({ length: 250 }, function (_, i) { return { kind: "unregistered-file", modId: "guid-u" + i, name: "Mod " + i, file: "Data/Extra" + i + ".sql", reason: "listed by the mod but no action loads it" }; }) }');
    run13('cfRenderPackaging()');
    const capped13 = els13.cfPackagingList.innerHTML;
    const rows13 = (capped13.match(/Data\/Extra\d+\.sql/g) || []).length;
    check('a 250-row group renders capped with the full count in its header',
      rows13 === 100 && />250</.test(capped13) && /Files no action loads/.test(capped13),
      rows13 + ' rows, header ' + (/>250</.test(capped13) ? 'exact' : 'wrong'));
    check('  with an expand control naming the hidden remainder',
      /and 150 more/.test(capped13) && /show all/.test(capped13));
    run13('cfTogglePackagingGroup("unreg")');
    const open13 = els13.cfPackagingList.innerHTML;
    check('expanding shows every row with a way back',
      (open13.match(/Data\/Extra\d+\.sql/g) || []).length === 250 && /show less/.test(open13));
    run13('cfTogglePackagingGroup("unreg")');
    const shut13 = els13.cfPackagingList.innerHTML;
    check('collapsing caps the rows again with the count intact',
      (shut13.match(/Data\/Extra\d+\.sql/g) || []).length === 100 && />250</.test(shut13));
  }
}

console.log('\nTest 14: conflicts copy triage (words only, no behavior change)');
{
  // Banned mechanism-trivia is gone from the strings the page shows; each
  // panel now opens with a start-here triage sentence.
  const cfSrc14 = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const html14 = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  check('no never-on-page-load reassurance remains in conflicts strings',
    !/never on page load/.test(cfSrc14) && !/never on page load/.test(html14));
  check('no switched-off-cannot restatement remains in conflicts strings',
    !/switched off, they cannot/.test(cfSrc14) && !/switched off, they cannot/.test(html14));
  check('page hint triages cross-mod collisions and game-logged errors first',
    /Start with cross-mod collisions and game-logged errors/.test(html14));
  check('  and names shadowing no-winner rows as choices, not crashes',
    /shadowing rows with no winner are choices to pin down, not crashes/.test(html14));
  check('shadowing env names settled winners and choices that do not crash',
    /rows with a winner are settled/.test(cfSrc14) && /choices to pin down or accept/.test(cfSrc14)
    && /nothing here crashes/.test(cfSrc14));
  check('replay env triages cross-mod first with a coverage note',
    /cross-mod pairs first/.test(cfSrc14) && /same-mod pairs are one author/.test(cfSrc14)
    && /did not cover/.test(cfSrc14));
  check('packaging env and button triage never-loaded files and shared ids',
    /never loads and mods sharing one id first/.test(cfSrc14)
    && /Find files the game never loads, tables in the wrong database, and ids two mods share/.test(html14)
    && /run this after adding or updating mods/.test(html14));
}
{
  // Same stubbed-DOM harness as Tests 7/8/12/13: the pairing section renders
  // headless, and its new guidance markup answers what-to-do-next.
  const cfSrc14b = fs.readFileSync(path.join(PUB, 'conflicts.js'), 'utf8');
  const escStub14 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderStub14 = (s) => escStub14(String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ''));
  const els14 = {};
  const dollarStub14 = (id) => {
    if (!els14[id]) els14[id] = { textContent: '', innerHTML: '', disabled: false, value: 'off', checked: false, addEventListener() {} };
    return els14[id];
  };
  let cx14 = null;
  let cxErr14 = '';
  try {
    cx14 = vm.createContext({ $: dollarStub14, pages: {}, n: (v) => (v == null ? '' : Number(v).toLocaleString()),
      esc: escStub14, renderCivText: renderStub14,
      stripCivText: (s) => String(s == null ? '' : s).replace(/\[([^\]]+)\]/g, ' ').replace(/\s+/g, ' ').trim(),
      api: async () => ({ ok: true }), toast() {}, window: {} });
    vm.runInContext(cfSrc14b, cx14, { filename: 'conflicts.js' });
  } catch (e) { cxErr14 = e.message; }
  check('the conflicts script loads headless under stubs', cx14 !== null, cxErr14);
  if (cx14) {
    const run14 = (expr) => vm.runInContext(expr, cx14);
    run14('cfState.diffFilter = ""; cfState.hideUnattributed = false');
    run14('cfState.replay = {"ok":true,"envelopeLine":"env","fkMode":"off","profile":{"name":"P"},"limitationFlags":[],"unreadable":[],"skippedGated":0,"collisions":[],"gatedOut":[],"gatedUnknown":[],"perFile":[],"differential":{"available":true,"agreements":[{"responsibleModId":"m1","responsibleModName":"Green Mod","fileLabel":"A.xml","stmtIndex":0,"logLine":10,"logText":"boom","replayError":"boom","strength":"context-proven","approximate":false,"attribution":{}}],"replayOnly":[{"responsibleModId":"m2","responsibleModName":"Plain Mod","fileLabel":"B.sql","stmtIndex":1,"replayError":"no such table: Nope","strength":"replay","approximate":false}],"logOnly":[{"responsibleModId":null,"responsibleModName":null,"fileLabel":"C.xml","stmtIndex":null,"logLine":20,"logText":"lost","strength":"hint-matched","approximate":false,"attribution":{}}]},"calibration":{"available":true,"divergences":[{"assumedFirst":"m/a.sql","assumedSecond":"m/b.sql","assumedOrder":"m/a.sql before m/b.sql (assumed replay order)","observedOrder":"m/b.sql before m/a.sql (game-observed order)","assumedFirstMods":[],"assumedSecondMods":[]}]}}');
    run14('cfRenderReplay()');
    const diffHtml14 = els14.cfReplayDiff.innerHTML;
    const envHtml14 = els14.cfReplayEnv.innerHTML;
    check('pairing section opens with game-log-first guidance and a next-step title',
      /Start with game-logged errors/.test(diffHtml14) && /actually broke something/.test(diffHtml14)
      && /title="[^"]*Fix game-log rows/.test(diffHtml14), diffHtml14.slice(0, 200));
    check('  where both sides agree reads as fix-first',
      /Where both sides agree, fix first/.test(diffHtml14));
    check('agree rows say start here, single-side rows read as leads vs breakage',
      /Both sides report this — start here/.test(diffHtml14) && /a lead to check/.test(diffHtml14)
      && /it actually broke something/.test(diffHtml14));
    check('calibration divergences carry what-to-do-next guidance',
      /title="[^"]*open the named files/.test(diffHtml14) && /Open the named files and check the order/.test(diffHtml14));
    check('replay env triages cross-mod first with the coverage note',
      /cross-mod pairs first/.test(envHtml14) && /did not cover/.test(envHtml14), envHtml14.slice(0, 200));
  }
}

console.log(pass ? 'SCRIPTS: ALL CHECKS PASSED' : 'SCRIPTS: FAILURES PRESENT');
console.log('='.repeat(60));
process.exit(pass ? 0 : 1);
