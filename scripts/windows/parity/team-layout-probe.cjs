'use strict';
// D3 of issue #1 — replay the OmO team-layout tmux sequence against real psmux
// 3.3.8 on Windows, in throwaway `-L` namespaces, and write a JSON artifact.
//
// WHY THIS EXISTS
// ---------------
// OmO's team-mode visualization (`team_mode.tmux_visualization`) drives a command
// family CONTRACT.md does not cover. `createTeamLayoutInCallerWindow`
// (oh-my-openagent@5.1.19, dist/index.js:19653-19674) resolves the caller pane,
// splits one teammate pane per member, titles each pane, writes two pane-scoped
// options, types an attach command into each pane, applies `main-vertical`, and
// resizes the caller to 30%. The issue's Findings table (F1-F7) is source-read
// only; per the CONTRACT evidentiary standard no F-row is proven until a Windows
// run's output is committed. This probe is that run.
//
// WHAT IT REPLAYS (argv-faithful, in this order)
// ----------------------------------------------
//   1. new-session -d -s probe -x 200 -y 50 -P -F "#{pane_id}"        -> caller pane
//   2. display -p -F "#{session_id}" -t <caller>                      (resolveCallerTmuxSession)
//      display -p -F "#{session_name}:#{window_index}" -t <caller>
//   3. list-panes -t <windowTarget> -F "#{pane_id}"                   (listPanesInWindow)
//   4. split-window -t <caller> -h -d -l 70% -P -F "#{pane_id}" -c <cwd>   -> p1
//   5. select-pane -t <p1> -T omo-team-probe-a
//   6. set-option -p -t <p1> @omo_attach_server_url http://127.0.0.1:59999
//   7. set-option -p -t <p1> @omo_attach_session_id ses_probe_a
//   8. send-keys -t <p1> "echo TEAM_PROBE_MARKER_A" Enter ; capture-pane -p -t <p1>
//   9. member B: split-window -t <p1> -v -d -P -F "#{pane_id}" -c <cwd> -> p2
//      (selectExistingTeammatePane picks the middle pane, so B splits p1, not the
//       caller; buildSplitArgs omits `-l 70%` once teammatePanes is non-empty)
//      then 5-8 with title omo-team-probe-b, marker TEAM_PROBE_MARKER_B, ses_probe_b
//  10. list-panes -a -F "#{pane_id} #{pane_left} #{pane_width}"        (geometry before)
//  11. select-layout -t <windowTarget> main-vertical ; geometry after
//  12. resize-pane -t <caller> -x 30% ; geometry after
//  13. kill-pane -t <p1> ; kill-pane -t <p1> again (dead pane) — closes Q-CONTRACT-2
//
// The real attach command OmO types is `opencode attach '<url>' --session '<sid>'
// --dir '<dir>'` (index.js:19609-19610). The probe substitutes `echo <MARKER>` so
// the observable is a marker in the pane, not a live opencode process.
//
// TWO ARMS
// --------
//   direct — the real psmux binary (`--psmux`, default: `tmux` resolved on PATH)
//   shim   — the bridge shim (`--shim`, optional), in a FRESH namespace, replaying
//            the identical sequence so D1 (pane-option suppression) and D2
//            (resize translation) can be observed end to end. When the shim writes
//            its call log, the records appended during the arm are captured too.
//
// ISOLATION
// ---------
// EVERY invocation carries `-L <namespace>` as its first two argv elements; there
// is no code path that omits it. `-L` is the working isolation lever at 3.3.8
// (PSMUX_DATA_DIR is broken upstream, issue #599). Cleanup runs in a `finally`
// block: `kill-session -t probe`, then `list-sessions` to prove the namespace is
// empty, then a best-effort `kill-server` so no server process leaks. The run
// exits non-zero if any session survives.
//
// spawnSync(exe, argvArray) only — never a shell string. Driving psmux through a
// .cmd launcher lets cmd.exe re-parse the line and eat format strings at `|`
// (measured; see sweep.cjs).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
const CAPTURE_DEADLINE_MS = 8000;
const CAPTURE_POLL_MS = 800;
const SETTLE_MS = 1200;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const firstLine = (s) => (s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || null;

// ---- CLI --------------------------------------------------------------------

function usage() {
  return [
    'team-layout-probe.cjs — D3 of issue #1',
    '',
    'Replays the OmO team-layout tmux sequence against psmux in throwaway -L namespaces.',
    '',
    'Usage:',
    '  node team-layout-probe.cjs [options]',
    '',
    'Options:',
    '  --psmux <path>      real psmux binary (default: `tmux` resolved on PATH)',
    '  --shim <path>       bridge shim binary; adds a second arm in a fresh namespace',
    '  --namespace <ns>    base namespace (default: t<epoch>); shim arm uses <ns>_shim',
    '  --out <path>        artifact path (default: %TEMP%\\omo-team-probe\\team-layout-probe.json)',
    '  --keep              skip cleanup (debugging); default cleans',
    '  --help, -h          print this help and exit without touching tmux',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { psmux: null, shim: null, namespace: null, out: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--keep') { opts.keep = true; continue; }
    if (a === '--psmux' || a === '--shim' || a === '--namespace' || a === '--out') {
      const v = argv[++i];
      if (v === undefined) throw new Error('missing value for ' + a);
      if (a === '--psmux') opts.psmux = v;
      else if (a === '--shim') opts.shim = v;
      else if (a === '--namespace') opts.namespace = v;
      else opts.out = v;
      continue;
    }
    throw new Error('unknown argument: ' + a);
  }
  return opts;
}

// `--psmux` defaults to the `tmux` on PATH. On Windows the bridge installs a
// `tmux.exe`, so the .exe is preferred; a .cmd/.bat is recorded but cannot be
// CreateProcess'd directly (node returns status=null), which the arm will show.
function resolveTmuxOnPath() {
  const pathVar = process.env.PATH || process.env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32'
    ? ['tmux.exe', 'tmux.cmd', 'tmux.bat', 'tmux']
    : ['tmux'];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) return p; } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

// ---- process discipline -----------------------------------------------------

// `argv` here is the FULL argv, `-L <ns>` included. The arm recorder is the only
// caller and always builds it that way, so no invocation can escape the namespace.
function runRaw(bin, argv, timeout) {
  const t0 = Date.now();
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    timeout: timeout || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  return {
    argv,
    exit: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message) : null,
    timed_out: !!(r.error && /ETIMEDOUT|ENOBUFS/i.test(String(r.error.code || r.error.message))),
    duration_ms: Date.now() - t0,
  };
}

function makeArm(label, bin, ns) {
  const arm = {
    label,
    binary: bin,
    namespace: ns,
    started_utc: new Date().toISOString(),
    finished_utc: null,
    aborted: false,
    abort_reason: null,
    invocations: [],
    caller: null,
    panes: {},
    capture_panes: {},
    geometry: {},
    teardown: {},
  };
  arm.inv = (step, argv, timeout) => {
    const full = ['-L', ns].concat(argv);
    const rec = runRaw(bin, full, timeout);
    rec.step = step;
    arm.invocations.push(rec);
    return rec;
  };
  return arm;
}

// ---- observations -----------------------------------------------------------

function captureUntilMarker(arm, pane, marker) {
  const attempts = [];
  const deadline = Date.now() + CAPTURE_DEADLINE_MS;
  let last = null;
  for (;;) {
    last = arm.inv('capture-pane', ['capture-pane', '-p', '-t', pane]);
    attempts.push({ exit: last.exit, text: last.stdout });
    if (last.stdout.indexOf(marker) >= 0) break;
    if (Date.now() >= deadline) break;
    sleep(CAPTURE_POLL_MS);
  }
  return {
    pane,
    marker,
    marker_present: last.stdout.indexOf(marker) >= 0,
    exit: last.exit,
    stderr: last.stderr,
    text: last.stdout,
    attempts: attempts.length,
    attempt_texts: attempts,
  };
}

function geometrySnapshot(arm, step) {
  const r = arm.inv(step, ['list-panes', '-a', '-F', '#{pane_id} #{pane_left} #{pane_width}']);
  const panes = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    return { pane_id: parts[0] || null, pane_left: parts[1] || null, pane_width: parts[2] || null, raw: line };
  });
  return { argv: r.argv, exit: r.exit, stdout: r.stdout, stderr: r.stderr, panes };
}

// ---- the replay -------------------------------------------------------------

function replayArm(arm) {
  const cwd = process.cwd();
  arm.cwd = cwd;
  arm.note = 'send-keys types `echo <MARKER>` in place of OmO\'s `opencode attach ...` so the observable is a marker in the pane, not a live opencode process';

  // 1. caller session + pane
  const created = arm.inv('new-session', ['new-session', '-d', '-s', 'probe', '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}']);
  const caller = firstLine(created.stdout);
  arm.caller = { pane_id: caller, session_id: null, window_target: null };
  if (created.exit !== 0 || !caller) {
    arm.aborted = true;
    arm.abort_reason = 'new-session failed or returned no pane id (exit=' + created.exit + ')';
    return arm;
  }

  // 2. resolveCallerTmuxSession: session_id, then window target
  const sid = arm.inv('display-session-id', ['display', '-p', '-F', '#{session_id}', '-t', caller]);
  arm.caller.session_id = firstLine(sid.stdout);
  const wt = arm.inv('display-window-target', ['display', '-p', '-F', '#{session_name}:#{window_index}', '-t', caller]);
  arm.caller.window_target = firstLine(wt.stdout);
  const windowTarget = arm.caller.window_target || 'probe:0';

  // 3. listPanesInWindow
  const lp = arm.inv('list-panes', ['list-panes', '-t', windowTarget, '-F', '#{pane_id}']);
  arm.existing_panes = (lp.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  // 4-8. member A
  const splitA = arm.inv('split-window-a', ['split-window', '-t', caller, '-h', '-d', '-l', '70%', '-P', '-F', '#{pane_id}', '-c', cwd]);
  const p1 = firstLine(splitA.stdout);
  arm.panes.a = p1;
  if (!p1) {
    arm.aborted = true;
    arm.abort_reason = 'split-window A returned no pane id (exit=' + splitA.exit + ')';
    return arm;
  }
  arm.inv('select-pane-a', ['select-pane', '-t', p1, '-T', 'omo-team-probe-a']);
  arm.inv('set-option-url-a', ['set-option', '-p', '-t', p1, '@omo_attach_server_url', 'http://127.0.0.1:59999']);
  arm.inv('set-option-session-a', ['set-option', '-p', '-t', p1, '@omo_attach_session_id', 'ses_probe_a']);
  arm.inv('send-keys-a', ['send-keys', '-t', p1, 'echo TEAM_PROBE_MARKER_A', 'Enter']);
  sleep(SETTLE_MS);
  arm.capture_panes.a = captureUntilMarker(arm, p1, 'TEAM_PROBE_MARKER_A');

  // 9. member B — selectExistingTeammatePane([p1]) === p1, direction -v, no -l
  const splitB = arm.inv('split-window-b', ['split-window', '-t', p1, '-v', '-d', '-P', '-F', '#{pane_id}', '-c', cwd]);
  const p2 = firstLine(splitB.stdout);
  arm.panes.b = p2;
  if (!p2) {
    arm.aborted = true;
    arm.abort_reason = 'split-window B returned no pane id (exit=' + splitB.exit + ')';
    return arm;
  }
  arm.inv('select-pane-b', ['select-pane', '-t', p2, '-T', 'omo-team-probe-b']);
  arm.inv('set-option-url-b', ['set-option', '-p', '-t', p2, '@omo_attach_server_url', 'http://127.0.0.1:59999']);
  arm.inv('set-option-session-b', ['set-option', '-p', '-t', p2, '@omo_attach_session_id', 'ses_probe_b']);
  arm.inv('send-keys-b', ['send-keys', '-t', p2, 'echo TEAM_PROBE_MARKER_B', 'Enter']);
  sleep(SETTLE_MS);
  arm.capture_panes.b = captureUntilMarker(arm, p2, 'TEAM_PROBE_MARKER_B');

  // 10-12. geometry around the layout and the resize
  arm.geometry.before_layout = geometrySnapshot(arm, 'geometry-before-layout');
  arm.inv('select-layout', ['select-layout', '-t', windowTarget, 'main-vertical']);
  sleep(SETTLE_MS);
  arm.geometry.after_layout = geometrySnapshot(arm, 'geometry-after-layout');
  arm.inv('resize-pane', ['resize-pane', '-t', caller, '-x', '30%']);
  sleep(SETTLE_MS);
  arm.geometry.after_resize = geometrySnapshot(arm, 'geometry-after-resize');

  // 13. teardown — kill p1, then kill p1 again (dead pane); closes Q-CONTRACT-2
  arm.teardown.kill_pane_first = arm.inv('kill-pane-first', ['kill-pane', '-t', p1]);
  arm.teardown.kill_pane_dead = arm.inv('kill-pane-dead', ['kill-pane', '-t', p1]);

  return arm;
}

// ---- shim call log (optional, shim arm only) --------------------------------

function callLogPath(shimBin) {
  return path.join(path.dirname(shimBin), 'state', 'shim-calls.jsonl');
}

function callLogLineCount(shimBin) {
  const p = callLogPath(shimBin);
  try {
    if (!fs.existsSync(p)) return 0;
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function callLogNewRecords(shimBin, fromLine) {
  const p = callLogPath(shimBin);
  try {
    if (!fs.existsSync(p)) return { path: p, exists: false, new_records: [] };
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
    const new_records = lines.slice(fromLine).map((l) => {
      try { return JSON.parse(l); } catch { return { parse_error: true, raw: l }; }
    });
    return { path: p, exists: true, total_lines: lines.length, new_records };
  } catch (e) {
    return { path: p, exists: false, error: String((e && e.message) || e), new_records: [] };
  }
}

// ---- cleanup ----------------------------------------------------------------

function cleanupNamespace(bin, ns) {
  const killSession = runRaw(bin, ['-L', ns, 'kill-session', '-t', 'probe']);
  const listSessions = runRaw(bin, ['-L', ns, 'list-sessions', '-F', '#{session_name}']);
  const sessionsLeft = listSessions.exit === 0
    ? (listSessions.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    : [];
  // Best-effort: a namespace with no sessions can still hold a live server process.
  const killServer = runRaw(bin, ['-L', ns, 'kill-server']);
  return { namespace: ns, kill_session: killSession, list_sessions: listSessions, sessionsLeft, kill_server: killServer };
}

// ---- main -------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e && e.message) || e));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  // --help must not touch tmux: return before any spawn.
  if (opts.help) {
    console.log(usage());
    process.exitCode = 0;
    return;
  }

  const startedUtc = new Date().toISOString();
  const ns = opts.namespace || ('t' + Date.now());
  const shimNs = ns + '_shim';
  const outPath = opts.out || path.join(process.env.TEMP || os.tmpdir(), 'omo-team-probe', 'team-layout-probe.json');

  const psmuxBin = opts.psmux || resolveTmuxOnPath();
  const shimBin = opts.shim || null;

  const artifact = {
    probe: 'team-layout-probe',
    issue: '#1',
    deliverable: 'D3',
    started_utc: startedUtc,
    finished_utc: null,
    host: {
      platform: process.platform,
      node: process.version,
      temp: process.env.TEMP || null,
      cwd: process.cwd(),
    },
    options: {
      psmux: opts.psmux,
      shim: opts.shim,
      namespace: opts.namespace,
      out: opts.out,
      keep: opts.keep,
    },
    binaries: { psmux: psmuxBin, shim: shimBin },
    namespaces: { direct: ns, shim: shimBin ? shimNs : null },
    arms: { direct: null, shim: null },
    cleanup: null,
    fatal: null,
    ok: false,
  };

  let cleanupOk = true;
  try {
    // --- direct arm ---------------------------------------------------------
    if (psmuxBin && fs.existsSync(psmuxBin)) {
      artifact.arms.direct = replayArm(makeArm('direct', psmuxBin, ns));
    } else {
      artifact.arms.direct = {
        label: 'direct',
        binary: psmuxBin,
        namespace: ns,
        started_utc: new Date().toISOString(),
        finished_utc: new Date().toISOString(),
        aborted: true,
        abort_reason: psmuxBin
          ? 'binary not found at ' + psmuxBin
          : 'no --psmux given and `tmux` not found on PATH',
        invocations: [],
        caller: null,
        panes: {},
        capture_panes: {},
        geometry: {},
        teardown: {},
      };
    }
    if (artifact.arms.direct) artifact.arms.direct.finished_utc = new Date().toISOString();

    // --- shim arm (fresh namespace) ----------------------------------------
    if (shimBin) {
      if (fs.existsSync(shimBin)) {
        const logBefore = callLogLineCount(shimBin);
        artifact.arms.shim = replayArm(makeArm('shim', shimBin, shimNs));
        artifact.arms.shim.shim_call_log = callLogNewRecords(shimBin, logBefore);
      } else {
        artifact.arms.shim = {
          label: 'shim',
          binary: shimBin,
          namespace: shimNs,
          started_utc: new Date().toISOString(),
          finished_utc: new Date().toISOString(),
          aborted: true,
          abort_reason: 'binary not found at ' + shimBin,
          invocations: [],
          caller: null,
          panes: {},
          capture_panes: {},
          geometry: {},
          teardown: {},
        };
      }
      if (artifact.arms.shim) artifact.arms.shim.finished_utc = new Date().toISOString();
    }
  } catch (e) {
    artifact.fatal = String((e && e.stack) || e);
  } finally {
    const cleanupBin = (psmuxBin && fs.existsSync(psmuxBin))
      ? psmuxBin
      : (shimBin && fs.existsSync(shimBin) ? shimBin : psmuxBin);
    if (opts.keep) {
      artifact.cleanup = { kept: true, ok: true, binary: cleanupBin, namespaces: [], sessionsLeft: [] };
    } else {
      const namespaces = [];
      for (const arm of [artifact.arms.direct, artifact.arms.shim]) {
        if (arm && arm.namespace) namespaces.push(cleanupNamespace(cleanupBin, arm.namespace));
      }
      const sessionsLeft = namespaces.reduce((acc, n) => acc.concat(n.sessionsLeft), []);
      artifact.cleanup = { kept: false, binary: cleanupBin, namespaces, sessionsLeft, ok: sessionsLeft.length === 0 };
      cleanupOk = artifact.cleanup.ok;
    }
  }

  artifact.finished_utc = new Date().toISOString();
  artifact.ok = cleanupOk && !artifact.fatal;

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
  } catch (e) {
    console.error('failed to write artifact: ' + String((e && e.message) || e));
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify({
    ok: artifact.ok,
    direct: artifact.arms.direct
      ? { namespace: artifact.arms.direct.namespace, aborted: artifact.arms.direct.aborted, abort_reason: artifact.arms.direct.abort_reason }
      : null,
    shim: artifact.arms.shim
      ? { namespace: artifact.arms.shim.namespace, aborted: artifact.arms.shim.aborted, abort_reason: artifact.arms.shim.abort_reason }
      : null,
    cleanup: artifact.cleanup
      ? { kept: artifact.cleanup.kept, ok: artifact.cleanup.ok, sessionsLeft: artifact.cleanup.sessionsLeft }
      : null,
  }, null, 2));
  console.log('written ' + outPath);

  if (artifact.fatal) process.exitCode = 2;
  else process.exitCode = cleanupOk ? 0 : 1;
}

main();
