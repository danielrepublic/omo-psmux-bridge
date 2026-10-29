#!/usr/bin/env node
'use strict';
/*
 * Windows auth-pane smoke for the OmO 5.1.51 bridge change (2026-10-29).
 *
 * Runs against a CANDIDATE bridge tree, not the installed bridge:
 *   node omo5151-windows-auth-smoke-20261029.cjs <candidateRoot> <reportPath>
 *
 * <candidateRoot> holds bin/tmux.exe and runtime/Start-PaneFromDescriptor.ps1.
 * The script owns one opencode serve child, one throwaway psmux namespace, and
 * every credential file it creates. It never touches the user's default psmux
 * session and never sends a model request.
 *
 * What it proves:
 *  1. an authenticated subagent placeholder is classified as placeholder-split,
 *     its one-use file is consumed at pane start, and the banner renders;
 *  2. an authenticated attach is classified as attach-respawn, the second
 *     one-use file is consumed, and a real OpenCode session attaches;
 *  3. an authenticated team send-keys is rewritten to the helper, consumes the
 *     split's one-use file, and attaches;
 *  4. the sentinel password appears in none of the bridge logs, pane traces, or
 *     fallback descriptors.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const candidateRoot = process.argv[2];
const reportPath = process.argv[3] || path.join(os.tmpdir(), 'omo5151-auth-smoke.json');
if (!candidateRoot) {
  console.error('usage: node omo5151-windows-auth-smoke-20261029.cjs <candidateRoot> [reportPath]');
  process.exit(64);
}
const MUX = path.join(candidateRoot, 'bin', 'tmux.exe');
const OPENCODE = 'C:\\Users\\Daniel\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
const NS = `omo-auth-${RUN}`;
const SENTINEL = `SENTINEL_AUTH_${RUN}`;
const MARKER = `BRIDGE_AUTH_${RUN}`;
const AUTH_DIR = path.join(os.tmpdir(), `omo-auth-smoke-${RUN}`);
const DESCRIPTOR_DIR = path.join(os.homedir(), '.omo-pane-env', 'state');
const MUX_ENV = { ...process.env, PSMUX_NO_WARM: '1' };

const assertions = [];
function check(name, pass, detail) {
  assertions.push({ name, pass: !!pass, detail: String(detail).slice(0, 400) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${String(detail).slice(0, 180)}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function mux(args) {
  const result = spawnSync(MUX, ['-L', NS, ...args], {
    encoding: 'utf8',
    timeout: 25_000,
    windowsHide: true,
    shell: false,
    env: MUX_ENV,
  });
  return {
    code: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`.slice(0, 1200),
    raw: String(result.stdout || '').trim(),
  };
}
function authFile() {
  const file = path.join(AUTH_DIR, `${RUN}-${Math.random().toString(16).slice(2)}.sh`);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(file, `export OPENCODE_SERVER_PASSWORD='${SENTINEL}'\n`, 'utf8');
  return file;
}
function posixQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function nestedQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
    .replaceAll('\\', '\\\\')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')
    .replaceAll('"', '\\"');
}
const AUTH_PREFIX_NESTED = '. \\"\\$OPENCODE_SERVER_PASSWORD_FILE\\" && rm -f -- \\"\\$OPENCODE_SERVER_PASSWORD_FILE\\" && ';
const AUTH_PREFIX_RAW = '. "$OPENCODE_SERVER_PASSWORD_FILE" && rm -f -- "$OPENCODE_SERVER_PASSWORD_FILE" && ';
function placeholderPayload(description) {
  return `/bin/sh -c "${AUTH_PREFIX_NESTED}printf '%s\\n%s\\n' ${nestedQuote(`OMO subagent pane ready: ${description}`)} ${nestedQuote('Focus this pane to attach.')}; while :; do sleep 86400; done"`;
}
function attachPayload(url, sessionId, directory) {
  return `/bin/sh -c "${AUTH_PREFIX_NESTED}opencode attach ${nestedQuote(url)} --session ${nestedQuote(sessionId)} --dir ${nestedQuote(directory)}"`;
}
function teamText(url, sessionId, directory) {
  return `${AUTH_PREFIX_RAW}opencode attach ${posixQuote(url)} --session ${posixQuote(sessionId)} --dir ${posixQuote(directory)}`;
}
async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, text: await response.text() };
}
function sentinelIn(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const hits = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!pattern.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      if (fs.readFileSync(full, 'utf8').includes(SENTINEL)) hits.push(full);
    } catch {
      // ignore unreadable files
    }
  }
  return hits;
}

(async () => {
  const report = {
    tool: 'omo5151-windows-auth-smoke-20261029.cjs',
    ok: false,
    namespace: NS,
    candidateRoot,
    versions: {},
    assertions,
    paneSamples: {},
    cleanup: {},
  };
  let server = null;
  let pane = '';
  let teamPane = '';
  let sessionId = '';

  try {
    check('candidate-tmux-exe-present', fs.existsSync(MUX), MUX);
    if (!fs.existsSync(MUX)) throw new Error('candidate tmux.exe missing');

    const version = spawnSync(OPENCODE, ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    report.versions.opencode = String(version.stdout || version.stderr || '').trim();
    check('opencode-1.19.5', report.versions.opencode === '1.19.5', report.versions.opencode);

    const port = await freePort();
    const outLog = path.join(os.tmpdir(), `omo-auth-smoke-${RUN}.serve.out.log`);
    const errLog = path.join(os.tmpdir(), `omo-auth-smoke-${RUN}.serve.err.log`);
    const outFd = fs.openSync(outLog, 'w');
    const errFd = fs.openSync(errLog, 'w');
    server = spawn(OPENCODE, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      shell: false,
      env: { ...process.env, OPENCODE_PORT: String(port) },
    });
    let healthy = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) break;
      try {
        const health = await fetchText(`http://127.0.0.1:${port}/global/health`);
        if (health.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // booting
      }
      await sleep(750);
    }
    check('serve-health-ok', healthy, healthy ? `port=${port}` : `server exited=${server.exitCode}`);
    if (!healthy) throw new Error('opencode serve never became healthy');

    const created = await fetchText(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `omo-auth-smoke-${RUN}` }),
    });
    check('session-created', created.status >= 200 && created.status < 300, `HTTP ${created.status}`);
    const createdJson = JSON.parse(created.text);
    sessionId = createdJson.id || (createdJson.session && createdJson.session.id) || '';
    check('session-id-captured', typeof sessionId === 'string' && sessionId.length > 0, 'id withheld');

    const seeded = await fetchText(`http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noReply: true, parts: [{ type: 'text', text: MARKER }] }),
    });
    check('session-seeded', seeded.status === 200, `HTTP ${seeded.status}`);

    const started = mux(['new-session', '-d', '-s', NS, '-x', '200', '-y', '50']);
    check('mux-new-session', started.code === 0, started.out.slice(0, 160));
    if (started.code !== 0) throw new Error('new-session failed');

    const url = `http://127.0.0.1:${port}`;
    const directory = 'C:\\Users\\Daniel';

    const authA = authFile();
    const split = mux([
      'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', NS,
      '-e', `OPENCODE_SERVER_PASSWORD_FILE=${authA}`,
      placeholderPayload(`auth placeholder ${RUN}`),
    ]);
    pane = (split.raw.match(/%\d+/) || [''])[0];
    check('auth-placeholder-split', split.code === 0 && !!pane, `pane=${pane || '?'} ${split.out.slice(0, 120)}`);
    if (!pane) throw new Error('no pane id from auth split');
    await sleep(2500);
    const capA = mux(['capture-pane', '-p', '-t', pane]);
    report.paneSamples.placeholder = capA.raw.slice(0, 2000);
    check('auth-placeholder-banner', capA.raw.includes(`OMO subagent pane ready: auth placeholder ${RUN}`), 'banner rendered');
    check('auth-placeholder-file-consumed', !fs.existsSync(authA), authA);

    const authB = authFile();
    const attach = mux([
      'respawn-pane', '-k',
      '-e', `OPENCODE_SERVER_PASSWORD_FILE=${authB}`,
      '-t', pane,
      attachPayload(url, sessionId, directory),
    ]);
    check('auth-attach-respawn', attach.code === 0, attach.out.slice(0, 120));
    let attachSample = '';
    const attachDeadline = Date.now() + 30_000;
    while (Date.now() < attachDeadline) {
      const captured = mux(['capture-pane', '-p', '-t', pane]);
      attachSample = captured.raw;
      if (attachSample.includes(MARKER)) break;
      await sleep(500);
    }
    report.paneSamples.attach = attachSample.slice(0, 3000);
    check('auth-attach-session', attachSample.includes(MARKER), 'session marker rendered');
    check('auth-attach-file-consumed', !fs.existsSync(authB), authB);

    const authC = authFile();
    const teamSplit = mux([
      'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', NS,
      '-e', `OPENCODE_SERVER_PASSWORD_FILE=${authC}`,
    ]);
    teamPane = (teamSplit.raw.match(/%\d+/) || [''])[0];
    check('team-split', teamSplit.code === 0 && !!teamPane, `pane=${teamPane || '?'} ${teamSplit.out.slice(0, 120)}`);
    if (!teamPane) throw new Error('no pane id from team split');
    await sleep(1200);
    const sent = mux(['send-keys', '-t', teamPane, teamText(url, sessionId, directory), 'Enter']);
    check('team-send-keys', sent.code === 0, sent.out.slice(0, 120));
    let teamSample = '';
    const teamDeadline = Date.now() + 30_000;
    while (Date.now() < teamDeadline) {
      const captured = mux(['capture-pane', '-p', '-t', teamPane]);
      teamSample = captured.raw;
      if (teamSample.includes(MARKER)) break;
      await sleep(500);
    }
    report.paneSamples.team = teamSample.slice(0, 3000);
    check('team-attach-session', teamSample.includes(MARKER), 'session marker rendered in team pane');
    check('team-auth-file-consumed', !fs.existsSync(authC), authC);

    const logPath = path.join(candidateRoot, 'bin', 'state', 'shim-calls.jsonl');
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const records = logText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    check(
      'log-auth-split-classified',
      records.some((r) => r.verb === 'split-window' && r.classification === 'placeholder-split' && r.envSlotCount >= 1),
      'placeholder-split with env slots',
    );
    check(
      'log-auth-attach-classified',
      records.some((r) => r.verb === 'respawn-pane' && r.classification === 'attach-respawn' && r.envSlotCount >= 1),
      'attach-respawn with env slots',
    );
    check(
      'log-team-rewrite-recorded',
      records.some((r) => r.verb === 'send-keys' && r.rewriteReason === 'omo-551-team-auth-send-keys'),
      'send-keys rewrite reason',
    );
    check('sentinel-absent-from-call-log', !logText.includes(SENTINEL), 'call log');

    const traceHits = sentinelIn(path.join(candidateRoot, 'state'), /^pane-.*\.jsonl$/);
    check('sentinel-absent-from-pane-traces', traceHits.length === 0, traceHits.join('; ') || 'none');
    const descriptorHits = sentinelIn(DESCRIPTOR_DIR, /^desc-.*\.env$/);
    check('sentinel-absent-from-descriptors', descriptorHits.length === 0, descriptorHits.join('; ') || 'none');

    report.ok = assertions.every((a) => a.pass);
  } catch (error) {
    check('no-unhandled-error', false, error && error.message ? error.message : String(error));
    report.ok = false;
  } finally {
    try {
      if (pane) mux(['kill-pane', '-t', pane]);
    } catch {
      // cleanup best effort
    }
    try {
      if (teamPane) mux(['kill-pane', '-t', teamPane]);
    } catch {
      // cleanup best effort
    }
    const killed = mux(['kill-server']);
    report.cleanup.namespaceKill = killed.code === 0 ? 'exit=0' : `exit=${killed.code}`;
    if (server) {
      server.kill();
      await sleep(1500);
      if (server.exitCode === null) server.kill('SIGKILL');
      report.cleanup.serve = `exit=${server.exitCode} signal=${server.signalCode}`;
    }
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`report ${report.ok ? 'OK' : 'FAIL'} -> ${reportPath}`);
    process.exit(report.ok ? 0 : 1);
  }
})();
