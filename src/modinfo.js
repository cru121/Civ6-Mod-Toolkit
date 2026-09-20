'use strict';

// Scans mod source folders for .modinfo files and extracts each mod's GUID and
// display name. .modinfo files are small, consistent XML, so we read the two
// fields we need with focused regexes rather than pulling in an XML dependency.

const fs = require('fs');
const path = require('path');

// Normalize a GUID for comparison: lowercase, strip surrounding braces/space.
// Config files store GUIDs uppercase, lowercase, or brace-wrapped {..}; .modinfo
// files store them lowercase without braces. Normalizing both lets them match.
function normId(id) {
  return String(id || '').trim().replace(/^\{|\}$/g, '').toLowerCase();
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseModinfo(file) {
  let text;
  try {
    text = stripBom(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  // id from the <Mod ...> root element specifically (not nested id="" attrs).
  const modTag = text.match(/<Mod\b[^>]*>/i);
  const idMatch = modTag && modTag[0].match(/\bid\s*=\s*"([^"]+)"/i);
  if (!idMatch) return null;
  const nameMatch = text.match(/<Name>\s*([^<]*?)\s*<\/Name>/i);
  const rawName = nameMatch ? nameMatch[1].trim() : '';
  // .modinfo Name is sometimes a raw localization key (LOC_..._NAME/_TITLE) that
  // only resolves inside the mod's text files. Fall back to the (usually
  // human-readable) .modinfo filename in that case.
  const fileName = path.basename(file, path.extname(file));
  const name = (!rawName || /^LOC_[A-Z0-9_]+$/i.test(rawName)) ? fileName : rawName;
  return { id: idMatch[1], name, rawName: rawName || null };
}

// Recursively find .modinfo files, but only a couple levels deep (local mods:
// Mods/<name>/<name>.modinfo; workshop: content/289070/<id>/<name>.modinfo).
function findModinfos(root, maxDepth = 3) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.modinfo$/i.test(e.name)) results.push(full);
    }
  }
  walk(root, 0);
  return results;
}

// Scan all sources -> array of installed mods.
// Each: { id, idNorm, name, type, folder, path, workshopId? }
function scanMods(sources) {
  const mods = [];
  const seen = new Set();
  for (const src of sources) {
    if (!src.root || !src.exists) continue;
    for (const file of findModinfos(src.root)) {
      const info = parseModinfo(file);
      if (!info) continue;
      const idNorm = normId(info.id);
      const folder = path.dirname(file);
      const rel = path.relative(src.root, folder).split(path.sep)[0] || path.basename(folder);
      const entry = {
        id: info.id,
        idNorm,
        name: info.name,
        type: src.type,
        folder,
        path: file,
      };
      if (src.type === 'workshop') entry.workshopId = rel;
      // De-dupe by normalized id (a mod installed twice keeps the first found).
      if (seen.has(idNorm)) {
        const prior = mods.find((m) => m.idNorm === idNorm);
        if (prior) prior.duplicateOf = (prior.duplicateOf || 0) + 1;
        continue;
      }
      seen.add(idNorm);
      mods.push(entry);
    }
  }
  return mods;
}

module.exports = { scanMods, parseModinfo, findModinfos, normId };
