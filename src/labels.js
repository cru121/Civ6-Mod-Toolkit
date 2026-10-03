'use strict';

// User-defined labels for mods ("favourites", "needs-testing"), in one JSON
// file beside civ6-paths.json. Labels are global, not per profile: the same
// set applies whichever mod group is active.
//
// Keys are modinfo.normId() output - the mod's own GUID from its .modinfo,
// lowercased and unbraced - and NOT ModRowId, which the game renumbers on every
// rescan. Anything keyed by ModRowId loses every label the next time Civ6
// launches.
//
// Reading never throws and never writes. A file we wrote ourselves that we can
// no longer parse must degrade to "no labels with a message", never take the
// mod list down with it.

const fs = require('fs');
const path = require('path');
const { normId } = require('./modinfo');
const { atomicWrite } = require('./editor');

const VERSION = 1;
// The same cap cleanName() applies to profile names in modsdb.
const MAX_NAME = 100;

// Where the file lives. Overridable, for tests and for a relocated install.
function labelsFile() {
  return process.env.CIV6_LABELS_FILE || path.join(__dirname, '..', 'mod-labels.json');
}

// Trimmed, non-empty, and no longer than MAX_NAME. A label is typed by hand
// into a text field, so it is user input like any other.
function cleanLabel(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('a label cannot be empty');
  if (n.length > MAX_NAME) throw new Error(`a label cannot be longer than ${MAX_NAME} characters`);
  return n;
}

// The file's own text -> { labels, error }. Two levels of failure, and the
// difference matters: a file that is not the shape we write is unusable as a
// whole, while one bad entry among good ones costs only that entry. Neither is
// allowed to take the rest of the file down.
function parse(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { labels: {}, error: `mod-labels.json is not valid JSON (${e.message})`, unusable: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { labels: {}, error: 'mod-labels.json does not contain an object', unusable: true };
  }
  // A missing version is treated as the current one, so a file written before
  // the field existed still loads. A different one we did not write, and whose
  // shape we cannot vouch for, is refused rather than half-understood.
  if (raw.version !== undefined && raw.version !== VERSION) {
    return { labels: {}, error: `mod-labels.json is version ${JSON.stringify(raw.version)}; this toolkit reads version ${VERSION}`, unusable: true };
  }
  if (raw.labels === undefined || raw.labels === null) return { labels: {}, error: null };
  if (typeof raw.labels !== 'object' || Array.isArray(raw.labels)) {
    return { labels: {}, error: 'mod-labels.json has no "labels" object', unusable: true };
  }

  const labels = {};
  let dropped = 0;
  for (const [id, value] of Object.entries(raw.labels)) {
    const key = normId(id);
    if (!key || !Array.isArray(value)) { dropped++; continue; }
    const names = value.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
    if (names.length) labels[key] = names;
  }
  return {
    labels,
    error: dropped ? `${dropped} entr${dropped === 1 ? 'y' : 'ies'} in mod-labels.json could not be read and ${dropped === 1 ? 'was' : 'were'} ignored` : null,
  };
}

// Everything the mod manager needs, derived from the map: the per-mod map, the
// counts the filter chips show, and the alphabetical list the editor offers.
//
// `unusable` is the one distinction a read and a write both need: a file with a
// bad entry is readable and its good entries are real, while a file that is not
// the shape we write is not something to build on.
function view(labels, error, pruned, unusable = false) {
  const counts = new Map();
  for (const names of Object.values(labels)) {
    // A mod that somehow lists the same name twice counts once, or the chip
    // would promise more mods than carry it.
    for (const name of new Set(names)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return {
    labels,
    counts: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)),
    names: [...counts.keys()].sort((a, b) => a.localeCompare(b)),
    error: error || null,
    unusable,
    pruned,
  };
}

// Read the file, pruning ids that `known` does not contain.
//
// `known` is the set of mod ids the caller can actually see, or null when it
// cannot vouch for the set - the mod database would not read, or the game is
// part-way through a rescan. Pruning against an incomplete set would delete
// real labels, so those reads prune nothing. Pruned entries are dropped in
// memory and counted in `pruned`; the next write persists the pruned form.
// Nothing is written here, ever.
function readLabels(file = labelsFile(), known = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // No file is the normal state. Having no labels is not a failure.
    if (e.code === 'ENOENT') return view({}, null, 0);
    return view({}, `mod-labels.json could not be read (${e.message})`, 0, true);
  }
  if (!text.trim()) return view({}, null, 0); // an empty file is no labels

  const { labels, error, unusable } = parse(text);
  let pruned = 0;
  if (known) {
    for (const key of Object.keys(labels)) {
      if (!known.has(key)) { delete labels[key]; pruned++; }
    }
  }
  return view(labels, error, pruned, unusable);
}

// Write the map out. One plain file and no backups: it is a few kilobytes,
// written by one synchronous handler, and a lost label is a nuisance rather
// than a hazard. Mods.sqlite earns its ten backups because the game writes it
// too and can be interrupted mid-write; nobody else has ever heard of this one.
//
// Keys are written in sorted order so the file is stable and diffable by hand.
function writeLabels(file, labels) {
  const body = { version: VERSION, labels: {} };
  for (const key of Object.keys(labels).sort()) {
    const names = labels[key];
    if (Array.isArray(names) && names.length) body.labels[key] = names.slice();
  }
  atomicWrite(file, JSON.stringify(body, null, 2));
}

// Which spelling of each name is already in use, matched without regard to
// case. Built over keys in sorted order and only recording a name the first
// time it is seen, so the answer is stable rather than dependent on the order
// the object happened to be built in.
function spellingIndex(labels) {
  const index = new Map();
  for (const key of Object.keys(labels).sort()) {
    for (const name of labels[key]) {
      const k = name.toLowerCase();
      if (!index.has(k)) index.set(k, name);
    }
  }
  return index;
}

// The names to store for one mod. Each is trimmed, rejected if empty or over
// the cap, de-duplicated, and resolved to the spelling already on file - so
// typing "Favourites" against an existing "favourite" adds to that label rather
// than creating a second one nobody can tell apart.
function canonicalLabels(existing, names) {
  const index = spellingIndex(existing);
  const out = [];
  for (const raw of names) {
    const name = cleanLabel(raw);
    const k = name.toLowerCase();
    if (!index.has(k)) index.set(k, name); // new on this save: it is the spelling
    if (!out.some((n) => n.toLowerCase() === k)) out.push(index.get(k));
  }
  return out;
}

// Comparing names without regard to case. The browser has its own copy of this
// rule in public/mods.js, because the two cannot import each other; if one
// changes, the other has to.
const labelKey = (n) => String(n == null ? '' : n).trim().toLowerCase();

// The read a write is built on.
//
// Refuses outright if the file exists but is not the shape we write. Building on
// an unreadable file would replace whatever it holds, so a corrupt file is fixed
// or deleted by hand rather than overwritten by a click the user did not think of
// as destructive.
function readForWrite(file, known) {
  const v = readLabels(file, known);
  if (v.unusable) {
    throw new Error(`${v.error} - nothing was written. Fix or delete it, then try again.`);
  }
  return v;
}

// Set one mod's labels, and return the refreshed view.
//
// The file is re-read inside the call rather than sent by the caller. Two tabs
// open, each labelling a different mod: a client that PUT the whole file would
// silently discard the other tab's change. Node serves one request at a time on
// one thread, so read-modify-write needs no lock here.
//
// The whole set is replaced, not patched. The editor is a set of toggles, so
// the answer is a set, and one write either lands or does not.
function setLabels(file, idNorm, names, known = null) {
  const key = normId(idNorm);
  if (!key) throw new Error('which mod?');
  if (!Array.isArray(names)) throw new Error('labels must be a list');

  const current = readForWrite(file, known);
  const wanted = canonicalLabels(current.labels, names);
  if (wanted.length) current.labels[key] = wanted;
  else delete current.labels[key]; // no labels left: the entry goes, so it cannot come back
  writeLabels(file, current.labels);

  return readLabels(file, known);
}

// Take a label off every mod that carries it, and drop any mod left with none.
// Returns how many mods it was on, which is the number the user wants to hear:
// "deleted" on its own says nothing about what changed.
function deleteLabel(file, name, known = null) {
  const key = labelKey(name);
  if (!key) throw new Error('which label?');
  const current = readForWrite(file, known);

  let removed = 0;
  for (const [id, names] of Object.entries(current.labels)) {
    const rest = names.filter((n) => labelKey(n) !== key);
    if (rest.length === names.length) continue;
    removed++;
    if (rest.length) current.labels[id] = rest;
    else delete current.labels[id];
  }
  if (!removed) throw new Error(`no mod is labelled "${name}"`);

  writeLabels(file, current.labels);
  return { ...readLabels(file, known), removed };
}

// Rename a label everywhere it is used.
//
// Renaming onto a name that is already in use MERGES the two labels rather than
// being refused. Refusing would leave the user unable to reach a name they want
// without first deleting a label they meant to keep, and a merge is not silent:
// `merged` says it happened and `moved` says how many mods moved, so the dialog
// can report it.
function renameLabel(file, from, to, known = null) {
  const oldKey = labelKey(from);
  if (!oldKey) throw new Error('which label?');
  const newName = cleanLabel(to);
  const current = readForWrite(file, known);

  // The spelling already in use for the target, if there is one, so a rename
  // cannot introduce a second spelling of a label that already exists.
  const existing = spellingIndex(current.labels).get(labelKey(newName));
  const target = existing || newName;
  const targetKey = labelKey(target);
  // Merged means the two labels were actually combined, which needs a target
  // that already existed. A rename to a fresh name is not a merge, however
  // different the two names are.
  const merged = !!existing && targetKey !== oldKey;

  let moved = 0;
  for (const [id, names] of Object.entries(current.labels)) {
    const at = names.findIndex((n) => labelKey(n) === oldKey);
    if (at === -1) continue;
    moved++;
    const rest = names.filter((_, i) => i !== at);
    // Put the target back where the old name was, rather than at the end, so a
    // rename does not silently reorder a mod's labels. And add it whenever it
    // is not already there - including when the target is the old name in a
    // different spelling, which is a rename that must not delete anything.
    if (!rest.some((n) => labelKey(n) === targetKey)) rest.splice(Math.min(at, rest.length), 0, target);
    if (rest.length) current.labels[id] = rest;
    else delete current.labels[id];
  }
  if (!moved) throw new Error(`no mod is labelled "${from}"`);

  writeLabels(file, current.labels);
  return { ...readLabels(file, known), moved, merged };
}

module.exports = {
  VERSION, MAX_NAME, labelsFile, cleanLabel, readLabels, writeLabels,
  setLabels, deleteLabel, renameLabel,
};
