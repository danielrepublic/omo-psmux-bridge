'use strict';
// todo 19 - settle CONTRACT.md section 9: does `select-layout <name>` with no `-t`
// work on psmux 3.3.8, and which window does it act on?
//
// The question matters because OmO applies the layout with NO target
// (dist/index.js:8914) while enforcing the width WITH one (:8937). If the untargeted
// call is a silent no-op, panes never get the layout OmO asked for and nothing
// reports it. If it acts on an implicit window that is not the one OmO meant, an
// injected `-t` would be wrong.
//
// Everything runs in one throwaway `-L` namespace, from a detached client, through
// argv-faithful spawnSync. Two windows exist so "which window" is answerable rather
// than assumed.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const SHIM = path.join(process.env.TEMP, 'omo-t14', 'bin', 'tmux.exe');
const NS = 'omo_t19';
const S = 'lay';

const out = { namespace: NS, session: S, probes: [] };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function p(argv, t) {
  const r = spawnSync(REAL, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: t || 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error ? String(r.error.message) : null };
}
function shim(argv, t) {
  const r = spawnSync(SHIM, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: t || 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function state(tag) {
  const s = {
    tag,
    sessions: p(['list-sessions']).stdout,
    windows: p(['list-windows', '-a', '-F', '#{window_index}|#{window_width}x#{window_height}|#{window_layout}|#{window_panes}p']).stdout,
    panes: p(['list-panes', '-a', '-F', '#{window_index}.#{pane_index}|#{pane_id}|#{pane_width}x#{pane_height}|#{pane_left},#{pane_top}']).stdout,
  };
  return s;
}

// ---- setup: two windows, so "which window" is answerable --------------------
p(['kill-session', '-t', S]);
p(['new-session', '-d', '-s', S, '-n', 'w0']);
p(['new-window', '-d', '-t', S, '-n', 'w1']);
// give window 0 two panes so a layout change inside it is visible
p(['split-window', '-d', '-t', S + ':0']);
sleep(1200);
p(['select-layout', '-t', S + ':0', 'even-horizontal']);
p(['select-layout', '-t', S + ':1', 'tiled']);
sleep(1200);

out.before = state('before');

// ---- the probe: `select-layout <name>` with NO -t, exactly as OmO emits it ----
for (const layout of ['main-vertical', 'tiled', 'even-horizontal', 'this-layout-does-not-exist']) {
  const r = p(['select-layout', layout]);
  sleep(900);
  const after = state('after ' + layout);
  out.probes.push({
    invocation: ['select-layout', layout],
    targeted: false,
    exit: r.status,
    stderr: r.stderr,
    windows_before: out.before.windows,
    windows_after: after.windows,
    panes_after: after.panes,
  });
  out.before = after;
}

// ---- control 1: the SAME call WITH an explicit -t, for comparison ----------
const withTarget = p(['select-layout', '-t', S + ':1', 'main-horizontal']);
sleep(900);
out.targeted_control = {
  invocation: ['select-layout', '-t', S + ':1', 'main-horizontal'],
  exit: withTarget.status,
  stderr: withTarget.stderr,
  windows_after: p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}']).stdout,
};

// ---- control 2: which window is "current" for a detached client? ------------
// Move each window's activity in turn and see whether the untargeted call follows.
out.which_window = [];
for (const w of ['0', '1']) {
  p(['select-window', '-t', S + ':' + w]);
  sleep(600);
  const beforeL = p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}']).stdout;
  const r = p(['select-layout', 'even-horizontal']);
  sleep(900);
  out.which_window.push({
    made_current: S + ':' + w,
    before: beforeL,
    untargeted_exit: r.status,
    after: p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}']).stdout,
  });
}

// ---- control 3 (negative reference): no session at all ----------------------
const ghost = p(['select-layout', 'main-vertical', '-t', 'omo_no_such_session_zzz']);
out.negative_reference_no_such_session = { invocation: ['select-layout', '-t', 'omo_no_such_session_zzz', 'main-vertical'], exit: ghost.status, stderr: ghost.stderr };

// ---- control 4: the same call through the SHIM, which must pass it through --
const viaShim = shim(['select-layout', 'main-vertical']);
out.through_shim = { invocation: ['select-layout', 'main-vertical'], exit: viaShim.status, stderr: viaShim.stderr };

// ---- teardown ---------------------------------------------------------------
p(['kill-session', '-t', S]);
p(['kill-server']);
out.after_teardown = { sessions: p(['list-sessions']).stdout };

const dest = path.join(process.env.TEMP, 'omo-t14', 'layout-probe.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
console.log('written ' + dest);