'use strict';

// Combines a config's enabled-mod list with the installed-mod inventory and
// produces the three views the UI needs.

const cfg = require('./civ6cfg');
const { normId } = require('./modinfo');

function humanTitle(title) {
  if (!title) return null;
  try {
    const j = JSON.parse(title);
    const key = Object.keys(j)[0];
    const loc = j[key];
    if (Array.isArray(loc) && loc.length) {
      const en = loc.find((x) => x.locale === 'en_US') || loc[0];
      return en.text || key;
    }
    return key;
  } catch (_) {
    return title;
  }
}

// installed: array from modinfo.scanMods()
function diff(configBuffer, installed) {
  const enabled = cfg.listMods(configBuffer).mods.map((m) => ({
    id: m.id,
    idNorm: normId(m.id),
    title: humanTitle(m.title),
  }));
  const installedByNorm = new Map(installed.map((m) => [m.idNorm, m]));
  const enabledNorms = new Set(enabled.map((m) => m.idNorm));

  const enabledInstalled = []; // in config AND installed -> can remove
  const enabledMissing = [];   // in config but NOT installed -> DLC / uninstalled
  for (const e of enabled) {
    const inst = installedByNorm.get(e.idNorm);
    if (inst) enabledInstalled.push({ ...e, installed: inst });
    else enabledMissing.push(e);
  }

  // installed but NOT in config -> the "add these" list
  const availableToAdd = installed
    .filter((m) => !enabledNorms.has(m.idNorm))
    .map((m) => ({ id: m.id, idNorm: m.idNorm, name: m.name, type: m.type, folder: m.folder }));

  return { enabled, enabledInstalled, enabledMissing, availableToAdd };
}

// A UI-friendly view of one config against the installed inventory.
function configView(configBuffer, installed) {
  const d = diff(configBuffer, installed);
  const installedByNorm = new Map(installed.map((m) => [m.idNorm, m]));
  const enabled = d.enabled.map((e) => {
    const inst = installedByNorm.get(e.idNorm);
    return {
      id: e.id,
      idNorm: e.idNorm,
      title: e.title,
      installed: !!inst,
      name: inst ? inst.name : e.title,
      type: inst ? inst.type : 'dlc',
    };
  });
  return { enabled, availableToAdd: d.availableToAdd };
}

module.exports = { diff, humanTitle, configView };
