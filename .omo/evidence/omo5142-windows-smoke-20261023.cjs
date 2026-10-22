#!/usr/bin/env node
/*
 * omo5142 smoke driver for the OmO 5.1.42 / opencode 1.19.4 release (2026-10-23).
 * Adapted from v0.3.0-windows-smoke-20261019.cjs with assertions unchanged:
 * namespace prefix is omo-v5142-<random> per the release E2E safety rule;
 * OmO is 5.1.42, opencode 1.19.4, psmux 3.4.0, so the version pins are updated.
 * The tmux grammar region is byte-identical between OmO 5.1.40 and 5.1.42, so
 * the placeholder template exercised here is the same current 5.1.35+ shape.
 *
 * Run on Windows in a SINGLE ssh invocation; the SSH server kills descendants on
 * command end, so this file owns the whole lifetime: child opencode.exe serve,
 * all mux calls, doctor, session cleanup, and the JSON report.
 *
 *   node omo5142-windows-smoke-20261023.cjs [reportJsonPath]
 *
 * Contracts mirrored (read-only) from repo:
 *   src/grammar.ts  — payload is ONE argv element `/bin/sh -c "..."`; -L/-S/-f are
 *                     leading globals; 5.1.35+ singlequote banner constants.
 *   src/translate.ts HELPER_CONTRACT — translator strips -e, bridge owns delivery;
 *                     placeholder becomes a PowerShell Write-Output + sleep loop.
 *                     NOTE: src/cli.ts never passes shellPath, so the helper shell
 *                     defaults to powershell (5.1), NOT pwsh auto-preference.
 *   OMO 5.1.42 pane-command.ts buildTmuxPlaceholderCommand (via repo fixtures,
 *     byte-exact outputs of the installed oh-my-openagent@5.1.42 bundle):
 *       body = printf '%s\n%s\n' Q(banner) Q(hint); while :; do sleep 86400; done
 *       Q = shellQuoteForNestedCommand: `'` -> `'\''` first (doubled to `'\\''`
 *           by the backslash pass), then `\`->`\\`, `$`->`\$`, backtick->`` \` ``,
 *           `"`->`\"`. banner = `OMO subagent pane ready: ${shown}`, shown =
 *           withoutNul, truncated to 2000 chars + U+2026. hint is literal.
 *       CONTRACT.md Template B + test/grammar.test.ts PH535_* fixtures.
 *
 * SCOPE (per parent): verify the NEW grammar plus $/apostrophe/# safety, NOT a
 * redesign of the shell transport. GitHub issue #2 documents that PS 5.1 drops
 * embedded doublequotes from the placeholder description, so the hostile
 * description used for EXACT-byte assertions contains NO doublequote; quote
 * survival is recorded as a separate non-gating observation tied to issue #2.
 *
 * What this proves (protocol smoke only — NO LLM subagent is exercised):
 *   1. installed bridge tmux.exe renders the NEW single-quoted placeholder with a
 *      hostile description (apostrophe, #, $, $() interpolation, backticks,
 *      backslashes) as literal text: banner present, metachars unexpanded,
 *      no side-effect file.
 *   2. split-window + respawn-pane + kill-pane paths work under an isolated -L ns.
 *   3. real opencode.exe serve answers /global/health as {healthy:true,
 *      version:"1.19.4"}; GET /agent proves plugin load (a name matching
 *      /^Sisyphus/); POST /session + DELETE /session/:id both succeed.
 *      Only safe projections are printed/reported — never raw bodies or IDs.
 *   4. actual installed oh-my-openagent package.json is 5.1.42 (asserted).
 *   5. installed bridge-doctor.ps1 exits 0 with 11/11 frozen anchors.
 *   6. cleanup deletes the QA session by actual ID and touches ONLY the private
 *      namespace (never a bare kill-server).
 */
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

/* ---------------- bounded helpers (credential-free) ---------------- */
const FETCH_MS = 3000;      // per HTTP probe
const MUX_MS = 20000;       // per mux call
const SERVE_WAIT_MS = 45000;// serve readiness budget
const DOCTOR_MS = 90000;

const assertions = [];
function check(name, pass, detail) {
  assertions.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${String(detail).slice(0, 160)}\n`);
  return !!pass;
}
const observations = [];
function observe(name, detail) {
  observations.push({ name, detail: String(detail).slice(0, 300) });
  process.stdout.write(`NOTE  ${name}  ${String(detail).slice(0, 160)}\n`);
}
function redact(s) { // never print raw config/credentials
  return String(s).replace(/(OPENCODE_SERVER_(PASSWORD|USERNAME)\s*=\s*)(\S+)/g, '$1<redacted>')
    .replace(/("?(password|token|secret|apiKey)"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1<redacted>');
}
function errReason(e) { // no silent failures: every catch records a safe reason
  if (!e) return 'unknown';
  if (e.cause) return `${e.name || 'Error'}: ${e.message || e} (cause: ${errReason(e.cause)})`.slice(0, 200);
  return `${e.name || 'Error'}: ${e.message || String(e)}`.slice(0, 200);
}
async function fetchFull(url, opts = {}, timeoutMs = FETCH_MS) {
  const ctl = new AbortController(); // full body kept in memory for JSON.parse; only projections leave this function
  const t = setTimeout(() => ctl.abort(new Error(`timeout-after-${timeoutMs}ms`)), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => reject(new Error(`freePort listen failed: ${errReason(e)}`)));
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* ---------------- upstream Q-encoding (buildTmuxPlaceholderCommand) ---------------- */
function truncateShown(s) {
  const t = s.replace(/\0/g, '');
  return t.length > 2000 ? t.slice(0, 2000) + '…' : t;
}
function shellQuoteForNestedCommand(s) { // order matters: quote, then backslash, then $, `, "
  return "'" + s.replace(/'/g, "'\\''").replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/"/g, '\\"') + "'";
}
function buildTmuxPlaceholderPayload(rawDescription) {
  const shown = truncateShown(rawDescription);
  const banner = shellQuoteForNestedCommand(`OMO subagent pane ready: ${shown}`);
  const hint = shellQuoteForNestedCommand('Focus this pane to attach.');
  const body = `printf '%s\\n%s\\n' ${banner} ${hint}; while :; do sleep 86400; done`;
  return `/bin/sh -c "${body}"`;
}

/* ---------------- main ---------------- */
(async () => {
  const reportPath = process.argv[2] || path.join(os.tmpdir(), 'omo5142-smoke.json');
  const LOCALAPPDATA = process.env.LOCALAPPDATA || '';
  const APPDATA = process.env.APPDATA || '';
  const bridgeBin = path.join(LOCALAPPDATA, 'opencode-psmux-bridge', 'bin');
  const opencodeExe = path.join(APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const omoPkgJson = path.join(os.homedir(), '.cache', 'opencode', 'packages', 'oh-my-openagent@latest', 'node_modules', 'oh-my-openagent', 'package.json');
  const doctorPs1 = path.join(bridgeBin, 'bridge-doctor.ps1');
  const MUX = path.join(bridgeBin, 'tmux.exe'); // REQUIRED: installed bridge; no backend/psmux fallback (would false-pass)
  const R = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
  const NS = `omo-v5142-${R}`;
  const muxEnv = { ...process.env, PSMUX_NO_WARM: '1' }; // scoped: mux calls only
  const versions = { node: process.version };
  let port = 0, child = null, paneId = '', paneSample = '';
  let sessionIdActual = null; // real ID, memory-only: used for DELETE, NEVER printed or reported
  let lastHealthReason = '(not attempted)';

  const report = { tool: 'omo5142-windows-smoke-20261023.cjs', ok: false, versions, namespace: NS, port: 0,
    assertions, observations, health: null, agents: [], config: null, session: null,
    paneSample: '', cleanup: {}, notes: '' };

  function mux(args) { // EVERY mux call carries -L NS; never a bare call
    const r = spawnSync(MUX, ['-L', NS, ...args], {
      encoding: 'utf8', timeout: MUX_MS, shell: false, env: muxEnv,
    });
    if (r.error) return { code: -1, out: `spawn error: ${errReason(r.error)}`, raw: '' };
    const out = redact(`${r.stdout || ''}${r.stderr || ''}`).slice(0, 1200);
    return { code: r.status ?? -1, out, raw: String(r.stdout || '').trim() };
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  async function cleanupChild() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return 'already-exited';
    child.kill();
    const t0 = Date.now();
    while (child.exitCode === null && child.signalCode === null && Date.now() - t0 < 8000) await sleep(250);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch (e) { return `SIGKILL failed: ${errReason(e)}`; }
    }
    return `exit=${child.exitCode} signal=${child.signalCode}`;
  }

  try {
    /* REQUIRED installed bridge binary — no fallbacks (a raw backend would false-pass) */
    check('bridge-tmux-exe-present', fs.existsSync(MUX), MUX);
    if (!fs.existsSync(MUX)) throw new Error(`installed bridge missing: ${MUX}`);
    check('opencode-exe-present', fs.existsSync(opencodeExe), opencodeExe);
    if (!fs.existsSync(opencodeExe)) throw new Error(`opencode.exe missing: ${opencodeExe}`);

    /* actual installed OMO package version from ITS package.json — not hardcoded */
    let omoPkg = null;
    try {
      omoPkg = JSON.parse(fs.readFileSync(omoPkgJson, 'utf8'));
    } catch (e) { check('omo-package-readable', false, `${omoPkgJson}: ${errReason(e)}`); throw new Error('omo package.json unreadable'); }
    versions.omo = typeof omoPkg.version === 'string' ? omoPkg.version : '(no version field)';
    versions.omoPackagePath = omoPkgJson;
    check('omo-package-5.1.42', versions.omo === '5.1.42', `${omoPkgJson} version=${versions.omo}`);

    /* versions: opencode + bridge mux (-L form proves the namespace flag path) */
    const ov = spawnSync(opencodeExe, ['--version'], { encoding: 'utf8', timeout: MUX_MS, shell: false });
    if (ov.error) { check('opencode-version-1.19.4', false, `spawn error: ${errReason(ov.error)}`); throw new Error('opencode --version failed'); }
    versions.opencode = redact(String(ov.stdout || ov.stderr || '').trim()).slice(0, 80) || '(unknown)';
    check('opencode-version-1.19.4', versions.opencode.includes('1.19.4'), versions.opencode);
    const mv = mux(['-V']);
    versions.mux = (mv.raw || mv.out).slice(0, 80);
    check('mux-version-3.4.0', versions.mux.includes('3.4.0'), versions.mux);

    /* own child serve on loopback ephemeral; driver owns timeout/kill; no shell */
    port = await freePort();
    report.port = port;
    const logOut = fs.openSync(path.join(os.tmpdir(), `omo-smoke-${R}.serve.out.log`), 'w');
    const logErr = fs.openSync(path.join(os.tmpdir(), `omo-smoke-${R}.serve.err.log`), 'w');
    child = spawn(opencodeExe, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      stdio: ['ignore', logOut, logErr], shell: false, windowsHide: true,
      env: { ...process.env, OPENCODE_PORT: String(port) },
    });
    await new Promise((resolve) => { // surface fast spawn failure instead of hanging the poll loop
      if (child.exitCode !== null) return resolve();
      child.once('error', () => resolve());
      setTimeout(resolve, 1000);
    });
    let healthText = '';
    const t0 = Date.now();
    while (Date.now() - t0 < SERVE_WAIT_MS) {
      if (child.exitCode !== null) { lastHealthReason = `serve exited code=${child.exitCode} (see serve.*.log)`; break; }
      try {
        const h = await fetchFull(`http://127.0.0.1:${port}/global/health`);
        if (h.status === 200) { healthText = h.text; break; }
        lastHealthReason = `GET /global/health -> HTTP ${h.status}`;
      } catch (e) { lastHealthReason = errReason(e); } // expected while booting: ECONNREFUSED etc.
      await sleep(750);
    }
    if (!healthText) { check('serve-health-ok', false, lastHealthReason); throw new Error(`serve never healthy: ${lastHealthReason}`); }
    let healthJson = null;
    try { healthJson = JSON.parse(healthText); }
    catch (e) { check('serve-health-ok', false, `health body unparseable: ${errReason(e)}`); throw new Error('health JSON parse failed'); }
    const healthOk = healthJson && healthJson.healthy === true; // measured shape: {healthy:true, version:"1.19.4"}
    check('serve-health-ok', healthOk, `{healthy:${healthJson && healthJson.healthy}, version:${typeof (healthJson && healthJson.version) === 'string' ? healthJson.version : '(n/a)'}}`);
    if (!healthOk) throw new Error('health shape mismatch');
    report.health = { healthy: true, version: String(healthJson.version).slice(0, 40) };
    check('serve-version-1.19.4', String(healthJson.version).includes('1.19.4'), String(healthJson.version).slice(0, 40));
    process.stdout.write(`health healthy=true version=${report.health.version}\n`);

    /* /config: reachable (200), no schema assumptions; informational mention flag only */
    let configOk = false, configMentionsOmo = false;
    try {
      const cfg = await fetchFull(`http://127.0.0.1:${port}/config`);
      configOk = cfg.status === 200;
      if (configOk) configMentionsOmo = cfg.text.includes('oh-my-openagent');
      else lastHealthReason = `GET /config -> HTTP ${cfg.status}`;
    } catch (e) { lastHealthReason = errReason(e); }
    check('config-200', configOk, configOk ? 'GET /config -> 200' : lastHealthReason);
    report.config = { status200: configOk, mentionsOmoPlugin: configMentionsOmo };

    /* plugin-load proof: GET /agent, assert a name matching /^Sisyphus/; record safe names only */
    let agentNames = [];
    try {
      const ag = await fetchFull(`http://127.0.0.1:${port}/agent`);
      if (ag.status !== 200) { check('agent-plugin-loaded', false, `GET /agent -> HTTP ${ag.status}`); throw new Error('agent list unavailable'); }
      let agentJson = null;
      try { agentJson = JSON.parse(ag.text); }
      catch (e) { check('agent-plugin-loaded', false, `agent body unparseable: ${errReason(e)}`); throw new Error('agent JSON parse failed'); }
      const list = Array.isArray(agentJson) ? agentJson : Array.isArray(agentJson.agents) ? agentJson.agents : null;
      if (!list) { check('agent-plugin-loaded', false, 'agent body has no list shape'); throw new Error('agent shape mismatch'); }
      agentNames = list.filter((a) => a && typeof a.name === 'string').map((a) => a.name.slice(0, 80));
      report.agents = agentNames;
      process.stdout.write(`agents${agentNames.map((n) => ` [${n}]`).join('').slice(0, 400)}\n`);
      check('agent-plugin-loaded', agentNames.some((n) => /^Sisyphus/.test(n)), `${agentNames.length} agent(s), /^Sisyphus/ match required`);
    } catch (e) {
      if (!assertions.some((a) => a.name === 'agent-plugin-loaded')) check('agent-plugin-loaded', false, errReason(e));
      throw e;
    }

    /* POST /session (forces plugin load path); keep ACTUAL id memory-only for DELETE */
    let sessionPosted = false;
    try {
      const ses = await fetchFull(`http://127.0.0.1:${port}/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'omo-smoke-protocol-only' }),
      });
      sessionPosted = ses.status >= 200 && ses.status < 300;
      check('session-post-2xx', sessionPosted, `POST /session -> ${ses.status}`);
      if (sessionPosted) {
        let sj = null;
        try { sj = JSON.parse(ses.text); }
        catch (e) { check('session-post-2xx', false, `session body unparseable: ${errReason(e)}`); throw new Error('session JSON parse failed'); }
        if (sj && typeof sj.id === 'string' && sj.id) sessionIdActual = sj.id;
        else if (sj && sj.session && typeof sj.session.id === 'string' && sj.session.id) sessionIdActual = sj.session.id;
        check('session-id-captured', !!sessionIdActual, sessionIdActual ? `id captured (${sessionIdActual.length} chars, withheld)` : 'no id in response');
      }
    } catch (e) {
      if (!assertions.some((a) => a.name === 'session-post-2xx')) check('session-post-2xx', false, errReason(e));
      throw e;
    }
    report.session = { created: sessionPosted, deleted: false };

    /* isolated namespace seed with shell default */
    const sess = mux(['new-session', '-d', '-s', NS, '-x', '200', '-y', '50']);
    check('mux-new-session', sess.code === 0, sess.out.slice(0, 160));
    if (sess.code !== 0) throw new Error('new-session failed');

    const liveList = mux(['list-sessions', '-F', '#{session_name}']);
    check('mux-list-live-session', liveList.code === 0 && liveList.raw.includes(NS), 'live private session is discoverable');
    const launcher = path.join(bridgeBin, 'psmux.cmd');
    const launcherList = spawnSync(process.env.ComSpec, ['/d', '/c', launcher, '-L', NS, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', timeout: MUX_MS, env: muxEnv, shell: false });
    check('launcher-list-live-session', launcherList.status === 0 && String(launcherList.stdout).includes(NS), 'installed .cmd launcher discovers the same live private session');
    report.startProcessReadProbe = [];
    for (const [route, exe] of [['direct-exe', MUX], ['cmd-launcher', launcher]]) {
      const stdoutPath = path.join(os.tmpdir(), `omo-read-${R}-${route}.out`);
      const stderrPath = path.join(os.tmpdir(), `omo-read-${R}-${route}.err`);
      const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
      const ps = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${psQuote(exe)} -ArgumentList @('-L','${NS}','list-sessions','-F','"#{session_name}"') -NoNewWindow -Wait -PassThru -RedirectStandardOutput ${psQuote(stdoutPath)} -RedirectStandardError ${psQuote(stderrPath)}; exit $p.ExitCode`;
      const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: MUX_MS, env: muxEnv, shell: false });
      const out = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const err = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      report.startProcessReadProbe.push({ route, exit: probe.status, stdout: redact(out), stderr: redact(err), wrapperStderr: redact(probe.stderr || '') });
      observe(`start-process-read-${route}`, `exit=${probe.status} stdoutBytes=${Buffer.byteLength(out)} stderrBytes=${Buffer.byteLength(err)}`);
    }

    /* Hostile description WITHOUT doublequote (issue #2: PS5.1 drops embedded ")
       covers apostrophe + # + $ + $() + backticks + backslashes for exact-byte asserts.
       The canary filename is NAMED in prose; if any layer executed the text as
       shell, the file would exist. Safe rendering keeps it literal. */
    const canary = path.join(os.tmpdir(), `omo-smoke-sidefx-${R}.marker`);
    const hostileRaw = `it's #7 $HOME $(echo hi > ${canary}) \`bt\` \\done\\ CANARY-${R}`;
    const payload1 = buildTmuxPlaceholderPayload(hostileRaw);
    const sp = mux(['split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', NS, payload1]);
    paneId = (sp.raw.match(/%\d+/) || [''])[0];
    check('mux-split-placeholder-5142', sp.code === 0 && !!paneId, `pane=${paneId || '?'} ${sp.out.slice(0, 120)}`);
    if (!paneId) throw new Error('no pane id from split-window');
    await sleep(2500);
    const cap1 = mux(['capture-pane', '-p', '-t', paneId]);
    paneSample = cap1.raw.slice(0, 2000);
    check('pane-banner-marker', /OMO subagent pane ready: it/.test(cap1.raw), 'banner line rendered');
    check('pane-hostile-apos', cap1.raw.includes("it's #7"), 'apostrophe literal');
    check('pane-hostile-hash-dollar', cap1.raw.includes('#7') && cap1.raw.includes('$HOME'), '# and $ literal');
    check('pane-hostile-backtick', cap1.raw.includes('`bt`'), 'backticks literal');
    check('pane-hostile-backslash', cap1.raw.includes('\\done\\'), 'backslashes literal');
    check('pane-hint', cap1.raw.includes('Focus this pane to attach.'), 'hint line rendered');
    check('pane-no-interpolation', cap1.raw.includes('$(echo hi'), '$() kept literal, not expanded');
    check('pane-no-side-effect', !fs.existsSync(canary), `canary absent: ${canary}`);

    /* Respawn path with a second 5.1.42 placeholder (OMO shape: no `--`; bridge inserts).
       The "q" doublequote here is QUOTE-TOLERANT: survival is an observation tied to
       issue #2, never a gating assertion (PS5.1 is the default helper shell). */
    const payload2 = buildTmuxPlaceholderPayload(`respawn-ok # $ "q" it's CANARY-${R}`);
    const rs = mux(['respawn-pane', '-k', '-t', paneId, payload2]);
    check('mux-respawn-placeholder-5142', rs.code === 0, rs.out.slice(0, 120));
    if (rs.code !== 0) throw new Error('respawn-pane failed');
    await sleep(2500);
    const cap2 = mux(['capture-pane', '-p', '-t', paneId]);
    check('pane-respawn-banner', cap2.raw.includes('respawn-ok') && cap2.raw.includes("it's"), 'respawned banner core rendered');
    check('pane-respawn-meta', cap2.raw.includes('#') && cap2.raw.includes('$'), 'respawned # and $ literal');
    observe('known-limitation-issue2-doublequote',
      cap2.raw.includes('"q"') ? 'respawn "q" survived this run' : 'respawn "q" quotes dropped (matches GitHub issue #2: PS5.1 helper strips embedded doublequotes; scope is grammar+$/apos/# safety, not transport redesign)');
    if (cap2.raw.includes('respawn-ok')) paneSample = cap2.raw.slice(0, 2000);

    const attachMarker = `BRIDGE_ATTACH_${R}`;
    const seeded = await fetchFull(`http://127.0.0.1:${port}/session/${encodeURIComponent(sessionIdActual)}/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noReply: true, parts: [{ type: 'text', text: attachMarker }] }),
    });
    check('session-seeded-without-model-call', seeded.status === 200, `POST context-only message -> HTTP ${seeded.status}`);
    const attachPayload = `/bin/sh -c "opencode attach ${shellQuoteForNestedCommand(`http://127.0.0.1:${port}`)} --session ${shellQuoteForNestedCommand(sessionIdActual)} --dir ${shellQuoteForNestedCommand(process.cwd())}"`;
    const attached = mux(['respawn-pane', '-k', '-t', paneId, attachPayload]);
    check('mux-respawn-attach', attached.code === 0, attached.out.slice(0, 120));
    const attachDeadline = Date.now() + 20000;
    let attachSample = '';
    while (Date.now() < attachDeadline) {
      const captured = mux(['capture-pane', '-p', '-t', paneId]);
      attachSample = captured.raw;
      if (attachSample.includes(attachMarker)) break;
      await sleep(500);
    }
    report.attachPaneSample = redact(attachSample).slice(0, 4000);
    check('pane-real-opencode-session', attachSample.includes(attachMarker), 'unique context-only message rendered by the real attached OpenCode session');
    if (attachSample.includes(attachMarker)) paneSample = attachSample.slice(0, 4000);

    /* close tested pane */
    const kp = mux(['kill-pane', '-t', paneId]);
    check('mux-kill-pane', kp.code === 0, kp.out.slice(0, 120));

    /* doctor with actual OPENCODE_PORT; expect exit 0 + 11/11 anchors */
    const doc = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', doctorPs1],
      { encoding: 'utf8', timeout: DOCTOR_MS, shell: false, env: { ...process.env, OPENCODE_PORT: String(port) } });
    if (doc.error) { check('doctor-exit-0', false, `spawn error: ${errReason(doc.error)}`); throw new Error('doctor spawn failed'); }
    const docOut = redact(`${doc.stdout || ''}${doc.stderr || ''}`);
    check('doctor-exit-0', doc.status === 0, `exit=${doc.status}`);
    check('doctor-anchors-11/11', /frozen_line_anchors_resolved=11\/11/.test(docOut), '11/11 frozen anchors');
    versions.doctor = (docOut.match(/bridge-doctor[^\r\n]{0,60}/) || ['(see report)'])[0].slice(0, 80);

    report.paneSample = paneSample;
    report.ok = assertions.every((a) => a.pass);
  } catch (e) {
    if (!assertions.some((a) => a.name === 'no-unhandled-abort')) check('no-unhandled-abort', false, redact(errReason(e)));
    report.paneSample = paneSample;
    report.ok = false;
  } finally {
    /* cleanup: delete QA session by ACTUAL id, then ONLY the private namespace; never a bare kill-server */
    let sessionDelete = 'skipped-no-session';
    if (sessionIdActual && child && child.exitCode === null) {
      try {
        const del = await fetchFull(`http://127.0.0.1:${port}/session/${encodeURIComponent(sessionIdActual)}`, { method: 'DELETE' });
        const okDel = del.status >= 200 && del.status < 300;
        sessionDelete = `HTTP ${del.status}`;
        check('cleanup-session-deleted', okDel, `DELETE /session/:id -> ${sessionDelete} (id withheld)`);
        report.session = { created: true, deleted: okDel };
      } catch (e) {
        sessionDelete = errReason(e);
        check('cleanup-session-deleted', false, `${sessionDelete} (id withheld)`);
        report.session = { created: true, deleted: false };
      }
    } else if (sessionIdActual) {
      sessionDelete = 'skipped-serve-down';
      check('cleanup-session-deleted', false, 'serve down before DELETE (id withheld)');
      report.session = { created: true, deleted: false };
    }
    sessionIdActual = null; // drop the secret from memory the moment cleanup is done
    let killed = 'skipped', gone = false, childState = 'n/a';
    try {
      const k = mux(['kill-server']); // scoped: -L NS is prepended inside mux(); never bare
      killed = `exit=${k.code}${k.code !== 0 ? ` (${k.out.slice(0, 120)})` : ''}`;
      const ls = mux(['list-sessions']);
      gone = ls.code !== 0;
    } catch (e) { killed = `error: ${redact(errReason(e))}`; }
    childState = await cleanupChild();
    check('cleanup-serve-child', !child || child.exitCode !== null || child.signalCode !== null, childState);
    report.cleanup = { sessionDelete, killServerScopedOnly: killed, namespaceGone: gone, serveChild: childState, noBareKillServer: true };
    check('cleanup-namespace-only', gone, `kill-server -L ${NS} ${killed}; ns gone=${gone}`);
    report.ok = assertions.every((a) => a.pass);
    report.notes = 'Protocol smoke: placeholder/split/respawn/real OpenCode attach/close + serve health/agent/session + doctor. No LLM subagent exercised; no model call made. Embedded-doublequote survival is a non-gating observation per GitHub issue #2 (PS5.1 default helper shell).';
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(`report ${report.ok ? 'OK' : 'FAIL'} -> ${reportPath}\n`);
    process.exit(report.ok ? 0 : 1);
  }
})();
