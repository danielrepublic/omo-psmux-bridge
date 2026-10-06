'use strict';
// The residual question from CONTRACT.md section 9.3.
//
// 9.3 measured that an untargeted `select-layout` follows the client's current
// window: two trials, each moving only the window it had made current. But every
// one of those steps ran inside the SAME short-lived process, and that is not how
// the bridge runs. OmO spawns a separate `tmux` process per command, and rules 1b
// and 1e each INJECT an untargeted `select-layout` into a command that arrived on
// its own connection.
//
// So the question that actually matters for this bridge is narrower and sharper
// than "which window is current":
//
//     Does the current-window pointer SURVIVE the connection that set it?
//
// If it does not, then every injected untargeted `select-layout` lands on
// whatever the server considers current at that moment, which is not necessarily
// the window the caller meant — and rules 1b/1e would be applying layouts to an
// arbitrary window while reporting success.
//
// Three readings, each in its own process so the connections cannot overlap:
//
//   R1  set current to window 0, exit.   Then in a NEW process: apply untargeted.
//   R2  set current to window 1, exit.   Then in a NEW process: apply untargeted.
//   R3  set current to window 1, and in the SAME process apply untargeted.
//
// R3 is the control: 9.3 already showed it lands on window 1. If R1 and R2 both
// land on the same window as each other, the pointer did not survive and the
// untargeted call is not following anybody's intent. If R1 lands on window 0 and
// R2 on window 1, the pointer is server state and survives the connection.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const NS = 'omo_t21';
const S = 'cur';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function p(argv, t) {
  const r = spawnSync(REAL, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: t || 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const layouts = () => p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}|#{window_panes}p']).stdout;

p(['kill-session', '-t', S]);
p(['new-session', '-d', '-s', S, '-n', 'w0']);
p(['split-window', '-d', '-t', S + ':0']);
p(['new-window', '-d', '-t', S, '-n', 'w1']);
p(['split-window', '-d', '-t', S + ':1']);
sleep(1200);
// Distinct starting layouts, so a change is attributable to one window.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
p(['select-layout', '-t', S + ':1', 'even-horizontal']);
sleep(1200);

const out = { namespace: NS, session: S, baseline: layouts(), readings: [] };

function reading(tag, setCurrent, applyInSameProcess, applyName) {
  // Reset both windows so each reading starts from the same state.
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(900);

  const setResult = p(['select-window', '-t', S + ':' + setCurrent]);
  sleep(600);

  let applyResult = null;
  if (applyInSameProcess) {
    applyResult = p(['select-layout', applyName]);
    sleep(900);
  }
  const after = layouts();

  const rec = {
    tag,
    set_current_to: S + ':' + setCurrent,
    select_window_exit: setResult.status,
    select_window_stderr: setResult.stderr,
    applied_in_same_process: applyInSameProcess,
    layout_applied: applyInSameProcess ? applyName : null,
    apply_exit: applyResult ? applyResult.status : null,
    apply_stderr: applyResult ? applyResult.stderr : null,
    before: out.baseline,
    after,
    changed_windows: [],
  };
  const b = out.baseline.split('\n');
  const a = after.split('\n');
  for (let i = 0; i < Math.max(b.length, a.length); i += 1) {
    if (b[i] !== a[i]) rec.changed_windows.push({ window: i, before: b[i], after: a[i] });
  }
  out.readings.push(rec);
  return rec;
}

// R3 first: the control, and it must reproduce 9.3 or the harness is wrong.
const r3 = reading('R3 control: set current and apply in ONE process', '1', true, 'main-vertical');

// R1 and R2: the pointer is set in one process, the layout applied in another.
const r1 = reading('R1: set current to 0 in one process, apply in ANOTHER', '0', false, 'main-vertical');
const r2 = reading('R2: set current to 1 in one process, apply in ANOTHER', '1', false, 'main-vertical');

function changedIndex(rec) {
  return rec.changed_windows.length === 1 ? rec.changed_windows[0].window : null;
}

out.verdict = {
  control_lands_on_made_current: changedIndex(r3) === 1,
  r1_changed: changedIndex(r1),
  r2_changed: changedIndex(r2),
  // The decision-relevant fact: does setting the pointer in a process that then
  // EXITS still steer a later, unrelated process?
  pointer_survives_connection: changedIndex(r1) === 0 && changedIndex(r2) === 1,
  note: 'pointer_survives_connection=false means an injected untargeted select-layout from a separate process does NOT follow the window the caller selected',
};

p(['kill-session', '-t', S]);
p(['kill-server']);
out.after_teardown = p(['list-sessions']).stdout;

const dir = path.join(process.env.TEMP, 'omo-t21');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'current-window-survival.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log('written ' + dest);