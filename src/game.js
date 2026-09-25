'use strict';

// Detects whether Civilization VI is running. Changing the mod database while
// the game is open is unsafe, so the mod manager blocks writes in that case.

const { execFile } = require('child_process');

// CivilizationVI.exe, CivilizationVI_DX12.exe, ...
const GAME_EXE = /^civilizationvi(_dx12)?\.exe$/i;

function gameStatus() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ running: false, known: false, processes: [] });
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ running: false, known: false, processes: [] });
      const processes = [];
      for (const line of out.split(/\r?\n/)) {
        const name = (line.match(/^"([^"]+)"/) || [])[1];
        if (name && GAME_EXE.test(name) && !processes.includes(name)) processes.push(name);
      }
      resolve({ running: processes.length > 0, known: true, processes });
    });
  });
}

module.exports = { gameStatus };
