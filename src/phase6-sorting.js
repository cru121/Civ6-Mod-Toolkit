'use strict';

// Phase 6 automated proof: the mod list's orderings.
//
// Pure functions over plain objects, so no browser and no DOM. What is being
// checked is the part that is hard to eyeball: that pending changes read as the
// current state, that unlabelled mods go last, that equal keys do not shuffle,
// and that the caller's array is not reordered underneath it.
//
// Every expectation below is worked out by hand from the fixture in library(),
// and the fixture's shape is commented so it can be re-derived rather than
// guessed at. Several first-draft expectations here were wrong - the code was
// right - so the comments say which group each mod is in.

const sort = require('../public/modsort');
const fs = require('fs');
const path = require('path');
const readPage = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');

let pass = true;
const check = (label, cond, extra = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${extra ? ' :: ' + extra : ''}`);
  if (!cond) pass = false;
};
const names = (list) => list.map((m) => m.name);
// One way of writing a list of names, used by every assertion below, so an
// expected string reads the way the failure message does.
const str = (list) => names(list).join(', ');

// source   : workshop/local/dlc
// enabled  : what the game has saved (null = not in the active group)
// isOn()   : false for Bravo only, because it has a pending change
// problems : Foxtrot 2, Echo 1, everyone else 0
//
// Resulting groups:
//   enabled (isOn true)   : alpha, Golf
//   disabled (isOn false) : Zeta, Bravo, Delta, Echo, Foxtrot
//   first label           : alpha/Delta/Golf = favourite, Bravo = mp-safe,
//                           Echo = needs-testing, Zeta/Foxtrot = none
//   timestamps            : Foxtrot 1800000000000, Echo 1700000000000,
//                           Golf explicitly null, the rest absent
function library() {
  return [
    { name: 'Zeta', sortName: 'Zeta', source: 'local', enabled: false, labels: [] },
    { name: 'alpha', sortName: 'alpha', source: 'workshop', enabled: true, labels: ['favourite'] },
    { name: 'Bravo', sortName: 'Bravo', source: 'workshop', enabled: true, labels: ['mp-safe', 'favourite'] },
    { name: 'Delta', sortName: 'Delta', source: 'dlc', enabled: null, labels: ['favourite'] },
    { name: 'Echo', sortName: 'Echo', source: 'local', enabled: false, labels: ['needs-testing'], lastChanged: 1700000000000 },
    { name: 'Foxtrot', sortName: 'Foxtrot', source: 'workshop', enabled: false, labels: [], lastChanged: 1800000000000 },
    { name: 'Golf', sortName: 'Golf', source: 'workshop', enabled: true, labels: ['favourite'], lastChanged: null },
  ];
}
const ctx = {
  isOn: (m) => (m.name === 'Bravo' ? false : m.enabled === true),
  problemCount: (m) => (m.name === 'Foxtrot' ? 2 : m.name === 'Echo' ? 1 : 0),
};
const order = (key, list, context) => str(sort.sortMods(list || library(), key, context || ctx));
// Where a mod ends up, by position rather than by character offset in the
// joined string - the two are easy to confuse and the character one silently
// passes for a small list.
const at = (key, name, list, context) => str(sort.sortMods(list || library(), key, context || ctx)).split(', ').indexOf(name);

// --- Test 1: name ----------------------------------------------------------
console.log('Test 1: name, the default');
{
  check('alphabetical, without regard to case', order('name') === 'alpha, Bravo, Delta, Echo, Foxtrot, Golf, Zeta',
    order('name'));
  check('an unknown key falls back to name rather than throwing', order('nonsense') === order('name'));
  check('a mod with no sortName falls back to its name',
    str(sort.sortMods([{ name: 'Solo', enabled: true }], 'name', ctx)) === 'Solo');
  check('a null sortName falls back to the name too, rather than throwing',
    str(sort.sortMods([{ name: 'A', sortName: null }, { name: 'C', sortName: 'B' }], 'name', ctx)) === 'A, C');
}

// --- Test 2: state ---------------------------------------------------------
console.log('\nTest 2: state');
{
  check('enabled first, then disabled, by name within each group',
    order('state') === 'alpha, Golf, Bravo, Delta, Echo, Foxtrot, Zeta', order('state'));
  check('a pending change reads as the current state, not the saved one: Bravo is saved on and sorts as off',
    at('state', 'Bravo') === 2, order('state'));
  check('enabled as null counts as not enabled, so DLC Delta sits with the disabled',
    at('state', 'Delta') === 3, order('state'));
  check('with no isOn supplied it uses the mod\'s own enabled',
    str(sort.sortMods([{ name: 'A', enabled: false }, { name: 'B', enabled: true }], 'state', {})) === 'B, A');
  check('  and two mods equal on the key fall back to name',
    str(sort.sortMods([{ name: 'B', enabled: true }, { name: 'A', enabled: true }], 'state', {})) === 'A, B');
}

// --- Test 3: source --------------------------------------------------------
console.log('\nTest 3: source');
{
  check('workshop, then local, then DLC, by name within each',
    order('source') === 'alpha, Bravo, Foxtrot, Golf, Echo, Zeta, Delta', order('source'));
  check('an unrecognised source sorts last rather than throwing',
    sort.bySource({ source: 'weird' }, { source: 'workshop' }) > 0);
  check('and base content would be after DLC, not before workshop',
    sort.bySource({ source: 'base' }, { source: 'dlc' }) > 0 && sort.bySource({ source: 'base' }, { source: 'workshop' }) > 0);
}

// --- Test 4: label ---------------------------------------------------------
console.log('\nTest 4: label');
{
  check('by the first label, then the mods with none last',
    order('label') === 'alpha, Delta, Golf, Bravo, Echo, Foxtrot, Zeta', order('label'));
  check('comparison is without regard to case',
    sort.byLabel({ labels: ['Favourite'] }, { labels: ['favourite'] }) === 0);
  check('"first" is the array order, not the alphabetically first: mp-safe then favourite sorts under m',
    sort.byLabel({ labels: ['zzz', 'aaa'] }, { labels: ['mmm'] }) > 0);
  check('a label list of one behaves the same way',
    sort.byLabel({ labels: ['favourite'] }, { labels: [] }) < 0);
  check('two unlabelled mods tie and fall back to name',
    sort.byLabel({ labels: [] }, { labels: [] }) === 0);
}

// --- Test 5: needs attention ------------------------------------------------
console.log('\nTest 5: needs attention');
{
  check('mods with problems first, then by name; two problems and one are the same group',
    order('attention') === 'Echo, Foxtrot, alpha, Bravo, Delta, Golf, Zeta', order('attention'));
  check('any number of problems outranks none',
    sort.byAttention({ name: 'a' }, { name: 'b' }, { problemCount: (m) => (m.name === 'a' ? 1 : 0) }) < 0);
  check('  including two against one, which are peers rather than ranked',
    sort.byAttention({ name: 'a' }, { name: 'b' }, { problemCount: (m) => (m.name === 'a' ? 2 : 1) }) === 0);
  check('with no problemCount supplied nothing is a problem, so it is pure name order',
    order('attention', null, {}) === order('name', null, {}), order('attention', null, {}));
}

// --- Test 6: last changed --------------------------------------------------
console.log('\nTest 6: last changed');
{
  check('newest first, then the ones with no timestamp by name',
    order('changed') === 'Foxtrot, Echo, alpha, Bravo, Delta, Golf, Zeta', order('changed'));
  check('Golf has an explicit null and so sorts with the absent ones, not as epoch',
    at('changed', 'Golf') === 5, order('changed'));  check('a non-numeric timestamp is treated as absent too',
    sort.byChanged({ lastChanged: 'yesterday' }, { lastChanged: 1 }) > 0);
  check('Infinity is absent, not the newest thing in the list',
    sort.byChanged({ lastChanged: Infinity }, { lastChanged: 1 }) > 0);
  check('a string that looks like a number is still not a timestamp',
    sort.byChanged({ lastChanged: '1800000000000' }, { lastChanged: 1 }) > 0);
  check('the key is offered when at least one mod has a timestamp',
    sort.availableSorts(library()).map((s) => s.key).includes('changed'));
  check('  and withheld when the server sent no timestamps at all - an older server',
    !sort.availableSorts([{ name: 'A' }]).map((s) => s.key).includes('changed'));
  check('  and withheld for an empty list',
    !sort.availableSorts([]).map((s) => s.key).includes('changed'));
  check('the other five keys are always offered',
    sort.availableSorts([]).map((s) => s.key).join() === 'name,state,source,label,attention');
}

// --- Test 7: the caller's array is not touched -----------------------------
console.log('\nTest 7: sorting does not reorder the caller\'s data');
{
  const list = library();
  const before = list.map((m) => m.name).join();
  for (const key of sort.SORTS.map((s) => s.key)) sort.sortMods(list, key, ctx);
  check('modsPage.data.mods is unchanged after sorting by all six keys',
    list.map((m) => m.name).join() === before, list.map((m) => m.name).join(' '));
}

// --- Test 8: stability -----------------------------------------------------
console.log('\nTest 8: re-sorting never shuffles equal rows');
{
  // Every key, applied repeatedly, must reach a fixed point. A comparator that is
  // not a consistent order gets stuck in a cycle and the list visibly twitches
  // each time the user touches a filter.
  const keys = sort.SORTS.map((s) => s.key);
  const stuck = {};
  for (const key of keys) {
    let list = library();
    for (let pass = 0; pass < 6; pass++) {
      const next = sort.sortMods(list, key, ctx).map((m) => m.name).join();
      if (next === list.map((m) => m.name).join()) break;
      if (pass === 5) stuck[key] = next;
      list = sort.sortMods(list, key, ctx);
    }
  }
  check('every key reaches a fixed point within a few passes', Object.keys(stuck).length === 0, JSON.stringify(stuck));

  // The spec's guarantee, isolated: three mods identical on every key, so the
  // only thing that can order them is the order they arrived in.
  const tied = [
    { name: 'second', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
    { name: 'first', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
    { name: 'third', sortName: 'same', source: 'workshop', enabled: true, labels: ['x'] },
  ];
  let held = true;
  const broke = [];
  for (const key of keys) {
    if (str(sort.sortMods(tied, key, ctx)) !== 'second, first, third') { held = false; broke.push(key); }
  }
  check('every key keeps arrival order for mods equal on it', held, broke.join(', '));
}

// --- Test 9: the stored key ------------------------------------------------
console.log('\nTest 9: a stored key is only honoured if it can be sorted by');
{
  const withDates = sort.availableSorts(library());       // the shape a caller has
  const without = sort.availableSorts([{ name: 'A' }]);
  check('a key this build knows is kept', sort.resolveSortKey('label', withDates) === 'label');
  check('the default is name', sort.resolveSortKey('name', withDates) === 'name');
  check('an absent or empty stored value falls back to name', sort.resolveSortKey('', withDates) === 'name');
  check('an unknown stored value falls back to name', sort.resolveSortKey('by-vibes', withDates) === 'name');
  check('a key the server cannot support falls back to name rather than sorting everything to last',
    sort.resolveSortKey('changed', without) === 'name');
  check('with no availability list at all, every key resolves',
    keysAreAllKnown(), '');
  function keysAreAllKnown() {
    return sort.SORTS.every((s) => sort.resolveSortKey(s.key) === s.key);
  }
  // The shape the caller actually has. Passing key names instead used to map
  // .key over strings and silently yield the default for everything - see
  // resolveSortKey's comment.
  check('the availability list is the same shape the resolve call takes',
    sort.SORTS.every((s, i) => withDates[i].key === sort.resolveSortKey(s.key, withDates)));
}

// --- Test 10: the wiring ----------------------------------------------------
// The comparators above are checked by behaviour, but the page's use of them is
// not: nothing here can click a native <select>, because Chrome draws its popup in
// a layer the automation cannot reach. So the path from the control to the list is
// asserted against the source instead - the same approach phase4 takes for the
// explorer.exe call, for the same reason: there is no runtime symptom to catch it.
console.log('\nTest 10: the wiring from the control to the list');
{
  const page = readPage('mods.js');
  const html = readPage('index.html');

  // modsort.js must be parsed before mods.js runs: mods.js reads it at load, and
  // `modsort.labelKey` against an undefined global throws before anything renders.
  const at = (re) => { const m = re.exec(html); return m ? m.index : -1; };
  check('modsort.js is loaded before mods.js, which reads it at load time',
    at(/modsort\.js/) > -1 && at(/modsort\.js/) < at(/mods\.js/),
    `modsort at ${at(/modsort\.js/)}, mods at ${at(/mods\.js/)}`);

  check('the page reaches the orderings through the global the file publishes',
    /modsort\.(sortMods|availableSorts|resolveSortKey|labelKey)/.test(page));
  check('sorting happens in exactly one place - the end of visibleMods()',
    /return modsort\.sortMods\(shown, modsPage\.sort, sortContext\(\)\)/.test(page)
    && (page.match(/modsort\.sortMods\(/g) || []).length === 1,
    `${(page.match(/modsort\.sortMods\(/g) || []).length} call sites`);

  // Filters first, sort last: sorting before filtering would reorder mods the
  // filters were about to exclude, which is harmless but means the order is not
  // the one the user asked for among what is shown.
  const visible = /function visibleMods\(\)[\s\S]*?\n\}/.exec(page);
  check('the label and source filters are applied before the sort',
    !!visible && visible[0].indexOf('matchesLabels(m)') < visible[0].indexOf('modsort.sortMods(')
    && visible[0].indexOf('SRC_MATCH[modsPage.src](m)') < visible[0].indexOf('modsort.sortMods('));

  check('the state ordering is given isOn, so a pending change counts as current',
    /return \{ isOn, problemCount:/.test(page));
  check('  and problemCount is problemsOf, the same function the warning bar uses',
    /problemCount: \(m\) => problemsOf\(m, all\)\.length/.test(page));

  check('the stored key is read at load, inside a try, defaulting to name',
    /modsPage\.sort = localStorage\.getItem\(SORT_KEY\) \|\| 'name'/.test(page));
  check('  and the change handler stores it back and re-renders',
    /localStorage\.setItem\(SORT_KEY, modsPage\.sort\)/.test(page)
    && /addEventListener\('change'[\s\S]{0,400}renderMods\(\)/.test(page));
  check('  and a failed write does not stop the sort - the view preference does the same',
    /localStorage\.setItem\(SORT_KEY, modsPage\.sort\); \} catch \(_\)/.test(page));

  check('the select is built from the keys that can be sorted by, and the stored one validated',
    /availableSorts\([\s\S]{0,160}resolveSortKey\(/.test(page));
  check('the sort control is in the left half of the filter row',
    /id="sortSelect"/.test(html)
    && at(/id="sortSelect"/) > at(/class="filter-half"/)
    && at(/id="sortSelect"/) < html.indexOf('class="filter-half"', at(/class="filter-half"/) + 1),
    `first half at ${at(/class="filter-half"/)}, select at ${at(/id="sortSelect"/)}`);
  // The reserved slot is gone. A comment still pointing at the spec would now be
  // a lie about where the control is.
  check('  and the placeholder it replaced is gone, not left as dead markup',
    !/id="sortSlot"/.test(html) && !/SPEC-mod-sorting\.md puts the sort control/.test(html));
}

// --- Test 11: the tooltip -------------------------------------------------
// Hovering the control shows the active key's description. That only works if
// every key on offer has one, including the key a stored value gets resolved to.
console.log('\nTest 11: every key has something to say about itself');
{
  const all = sort.availableSorts(library());
  check('every key on offer carries a hint', all.every((s) => typeof s.hint === 'string' && s.hint.length > 0),
    all.filter((s) => !s.hint).map((s) => s.key).join(', ') || `${all.length} keys, all with a hint`);
  check('no hint is a placeholder - each is longer than "TODO"',
    all.every((s) => s.hint.length > 20),
    all.filter((s) => s.hint.length <= 20).map((s) => s.key).join(', '));
  // The label is repeated in the tooltip, so a key that reads as its own label is
  // not explaining anything.
  check('no hint is just the label again',
    all.every((s) => s.hint.toLowerCase() !== s.label.toLowerCase()));
  check('with no data at all, the keys still carry hints - a tooltip must not need a page',
    sort.availableSorts([]).every((s) => s.hint && s.hint.length > 0));

  // The one that actually matters at runtime: whatever resolveSortKey hands back
  // is a key that can be described, or the tooltip goes blank.
  const stale = ['', 'by-vibes', 'changed', 'NAME', null, undefined];
  const withDates = all;
  const without = sort.availableSorts([{ name: 'A' }]);
  let described = true;
  const bare = [];
  for (const stored of stale) {
    for (const list of [withDates, without]) {
      const key = sort.resolveSortKey(stored, list);
      const entry = list.find((s) => s.key === key);
      if (!entry || !entry.hint) { described = false; bare.push(`${JSON.stringify(stored)} -> ${key}`); }
    }
  }
  check('every key a stored value can resolve to is one that has a hint', described, bare.join(' | '));

  // The 18-digit hazard, in the one place a user's own input could reach it: a
  // hint is plain text set through innerHTML, so it has to be escaped like any
  // other text reaching the DOM.
  check('a hint is plain text, and the page escapes it like any other',
    /\$\{esc\(s\.label\)\}/.test(readPage('mods.js'))
    && /sel\.title = active \? `\$\{active\.label\}/.test(readPage('mods.js')),
    'title is assigned as a property, not as markup');
  check('  and a key with no matching entry still leaves a tooltip rather than "undefined"',
    /sel\.title = active \? .* : 'How to order the mod list'/.test(readPage('mods.js')));
}

console.log('\n============================================================');
console.log(pass ? 'SORTING: ALL CHECKS PASSED' : 'SORTING: FAILURES PRESENT');
console.log('============================================================');
process.exit(pass ? 0 : 1);
