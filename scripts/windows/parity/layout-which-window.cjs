'use strict';
// todo 19, part 2: WHICH window does an untargeted `select-layout` act on?
//
// Part 1 settled the primary question -- `select-layout <name>` with no `-t`
// exits 0, writes nothing to stderr, and visibly re-lays-out window 0. It could not
// settle *which* window, because in both of its probes the change would have been
// invisible: the layout it applied was already in place, and the other window held
// a single pane, whose layout string is the same either way.
//
// This probe removes both blind spots. BOTH windows get two panes and DIFFERENT
// layouts, so applying one named layout to either one is visible, and the untargeted
// call is made once per candidate "current" window.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const NS = 'omo_t19b';
const S = 'lay2';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function p(argv, t) {
  const r = spawnSync(REAL, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: t || 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const layouts = () => p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}|#{window_panes}p']).stdout;

// Build: two windows, two panes each, deliberately different layouts.
p(['kill-session', '-t', S]);
p(['new-session', '-d', '-s', S, '-n', 'w0']);
p(['split-window', '-d', '-t', S + ':0']);
p(['new-window', '-d', '-t', S, '-n', 'w1']);
p(['split-window', '-d', '-t', S + ':1']);
sleep(1200);
// w0 = main-vertical (asymmetric), w1 = even-horizontal (symmetric). Distinct strings.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
p(['select-layout', '-t', S + ':1', 'even-horizontal']);
sleep(1200);

const out = { namespace: NS, session: S, baseline: layouts(), trials: [] };
const MAIN_V = out.baseline.split('\n')[0];
const EVEN_H = out.baseline.split('\n')[1];

// For each candidate current window: pin it, then apply the OTHER window's layout
// untargeted. Whichever window's string changes is the one the call acted on.
for (const [current, applyName, expectedFlips] of [
  [S + ':0', 'even-horizontal', 'window 1 (the one that already had it) or window 0'],
  [S + ':1', 'main-vertical', 'window 0'],
]) {
  p(['select-window', '-t', current]);
  sleep(700);
  const before = layouts();
  const r = p(['select-layout', applyName]);
  sleep(1000);
  const after = layouts();
  const b = before.split('\n');
  const a = after.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) changed.push({ window: i, before: b[i], after: a[i] });
  }
  out.trials.push({
    made_current: current,
    applied_untargeted: applyName,
    exit: r.status,
    stderr: r.stderr,
    before,
    after,
    changed_windows: changed,
  });
  // restore the distinct baseline for the next trial
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(900);
}

// A layout name psmux does not know: exit code and stderr, with a DIFFERENT layout
// in place so a silent success would be visible as a no-op rather than a pass.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
sleep(800);
const beforeBogus = layouts();
const bogus = p(['select-layout', 'no-such-layout-anywhere']);
sleep(900);
out.invalid_layout_name = {
  invocation: ['select-layout', 'no-such-layout-anywhere'],
  exit: bogus.status,
  stderr: bogus.stderr,
  before: beforeBogus,
  after: layouts(),
  note: 'a name psmux does not know, applied untargeted',
};

p(['kill-session', '-t', S]);
p(['kill-server']);
out.after_teardown = p(['list-sessions']).stdout;

const dest = path.join(process.env.TEMP, 'omo-t14', 'layout-which-window.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
console.log('written ' + dest);