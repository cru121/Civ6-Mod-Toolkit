'use strict';

// A throwaway instance of the real server, for the suites that need one.
//
// The point is that it is the *real* server, not a reimplementation of it: the
// routes, the error handling, the shape of every response. A suite that tested a
// copy of the routing would prove the copy works.
//
// Isolation is by environment, and paths.js already honours it: CIV6_PATHS_FILE,
// CIV6_LOCAL_MODS, CIV6_WORKSHOP, CIV6_SAVES, CIV6_MODS_DB, CIV6_LABELS_FILE. So
// no product code changes to make a test safe.
//
// Two things make this harder than it looks, and both are handled here rather
// than left to each suite to remember:
//
//   1. `CIV6_PATHS_FILE` is consulted *before* the individual overrides, and a
//      real civ6-paths.json would win. So the harness points it at a file that
//      does not exist - loadOverrides() returns {} for one it cannot read, and
//      the environment variables then apply. That is the only way to be sure the
//      developer's real Steam paths are not consulted.
//
//   2. A port collision is silent and self-concealing. `PORT=0` does not give an
//      ephemeral port (the server does `parseInt(PORT) || 8673`, so 0 becomes
//      8673), and its EADDRINUSE handler prints "already running" and exits 0.
//      A harness that lost the race would therefore think it had a server, and
//      would then be asserting against somebody else's - quite possibly the
//      developer's real one. So the harness picks a free port itself, refuses the
//      one a developer is likely to be using, and checks /api/ping's `started`
//      timestamp against its own clock before handing anything back.

const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
// The port src/server.js defaults to, and so the one a developer is most likely
// to have running. Never take it, and never let the OS hand it to us.
const DEFAULT_PORT = 8673;
const READY_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A port nothing is listening on. Closing the probe and then binding it is a
// small race, which is why the caller verifies identity afterwards rather than
// trusting the port number.
function probePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = await probePort();
    if (port !== DEFAULT_PORT) return port;
  }
  throw new Error('could not find a free port that is not the server default');
}

// http.request with agent:false rather than fetch. fetch keeps sockets in a pool,
// and a pool with a live socket can hold the event loop open after the suite
// finishes - which shows up as a suite that passes and then hangs.
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    // apiAllowed() refuses any POST that does not carry a JSON content type,
    // whatever the body is. So every POST here sends one, defaulting to `{}` -
    // which readBody() parses to an empty object exactly as an empty body would,
    // so a route taking no arguments is unaffected.
    const isPost = method === 'POST';
    const payload = isPost ? JSON.stringify(body == null ? {} : body) : null;
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      agent: false,
      // The server also requires a Host it recognises, which this satisfies; and
      // no Origin is sent, which the guard allows ("local tools such as the
      // launcher, which send no Origin").
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeSandbox() {
  // Resolved, for the same reason phase4's scratch dir is: a short 8.3 name in
  // TEMP would make every path the server reports differ from the path the suite
  // asked for, and the isolation check below would fail for a reason that has
  // nothing to do with isolation.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'civ6-server-')));
  const mods = path.join(dir, 'Mods');
  const workshop = path.join(dir, 'workshop');
  const saves = path.join(dir, 'Saves');
  for (const d of [mods, workshop, saves]) fs.mkdirSync(d, { recursive: true });
  return {
    dir, mods, workshop, saves,
    // Left absent on purpose. syncMods() reports "Mod database not found" and
    // carries on, so the server starts either way; a suite that wants a database
    // seeds one through the `seed` option.
    modsDb: path.join(dir, 'Mods.sqlite'),
    labels: path.join(dir, 'mod-labels.json'),
    // A file that is not there. See the note at the top: this is what stops the
    // real civ6-paths.json being read, and therefore what stops its paths being
    // consulted in preference to the environment.
    pathsFile: path.join(dir, 'no-such-civ6-paths.json'),
  };
}

const inside = (parent, child) => {
  const a = path.resolve(parent).toLowerCase();
  const b = path.resolve(child).toLowerCase();
  return b === a || b.startsWith(a + path.sep);
};

/**
 * Start the real server against throwaway paths.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.seed]  async (box) => void - runs before the server
 *                                 starts, e.g. to build a database
 * @param {boolean}  [opts.keep]  leave the scratch directory in place
 * @returns {Promise<{port:number, url:string, box:object, get:Function,
 *                    post:Function, state:Function, stop:Function}>}
 */
async function startServer(opts = {}) {
  const box = makeSandbox();
  if (opts.seed) await opts.seed(box);

  const port = await freePort();
  const env = {
    ...process.env,
    CIV6_PATHS_FILE: box.pathsFile,
    CIV6_LOCAL_MODS: box.mods,
    CIV6_WORKSHOP: box.workshop,
    CIV6_SAVES: box.saves,
    CIV6_MODS_DB: box.modsDb,
    CIV6_LABELS_FILE: box.labels,
    PORT: String(port),
    NO_OPEN: '1',          // or every run opens a browser window
  };

  // The one file the toolkit writes outside the user's chosen directories, and
  // the one a broken override would put in the repository root. Watched so a
  // suite can tell "wrote nothing" from "wrote somewhere I did not look".
  const realLabels = path.join(__dirname, '..', 'mod-labels.json');
  const realLabelsBefore = fs.existsSync(realLabels) ? fs.statSync(realLabels).mtimeMs : null;

  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode == null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      const raced = await Promise.race([gone.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
      if (!raced) { child.kill('SIGKILL'); await Promise.race([gone, sleep(STOP_TIMEOUT_MS)]); }
    }
    if (!opts.keep) {
      try { fs.rmSync(box.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  };

  // Readiness by polling, not by a fixed sleep: a machine under load starts
  // slower, and a sleep long enough for the slowest machine is a slow suite on
  // every other one.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ping = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`the server exited with ${child.exitCode} before it was ready.\n${output}`);
    }
    try {
      const r = await request(port, 'POST', '/api/ping');
      if (r.status === 200 && r.body && r.body.ok) { ping = r.body; break; }
    } catch (_) { /* not listening yet */ }
    await sleep(50);
  }
  if (!ping) {
    await stop();
    throw new Error(`the server never became ready on port ${port}.\n${output}`);
  }

  // Identity. If the port was taken between the probe and the bind, the server
  // exited 0 saying "already running" and this is somebody else's - possibly the
  // developer's real instance. Its `started` predates us, which is the tell.
  const startedAt = Date.parse(ping.started);
  if (!(startedAt >= spawnedAt - 2000)) {
    await stop();
    throw new Error(
      `port ${port} was already in use: /api/ping reports started ${ping.started}, `
      + 'before this harness spawned anything. Refusing to test somebody else\'s server.');
  }

  // Isolation, proved rather than assumed. Every root the server reports must be
  // inside the scratch directory. A suite that found a developer's real Steam
  // library here would be asserting against their machine, and reading their
  // mod database - so this throws instead of returning a server to test.
  const state = await request(port, 'GET', '/api/state');
  const reported = []
    .concat((state.body && state.body.sources) || [])
    .map((s) => s.root)
    .concat([state.body && state.body.saves && state.body.saves.root])
    .filter(Boolean);
  const strays = reported.filter((r) => !inside(box.dir, r));
  if (strays.length) {
    await stop();
    throw new Error(`the server is not isolated; it reports paths outside ${box.dir}:\n  ${strays.join('\n  ')}`);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    box,
    output: () => output,
    // A real labels file must never appear in the repository root while a suite
    // runs. Returns null if it is untouched, or a description of what changed.
    realLabelsUntouched: () => {
      const now = fs.existsSync(realLabels) ? fs.statSync(realLabels).mtimeMs : null;
      return now === realLabelsBefore ? null : `${realLabels} was created or modified during the suite`;
    },
    get: (p) => request(port, 'GET', p).then((r) => r),
    post: (p, body) => request(port, 'POST', p, body).then((r) => r),
    state: () => request(port, 'GET', '/api/state').then((r) => r.body),
    stop,
  };
}

module.exports = { startServer, DEFAULT_PORT };
