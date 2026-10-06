'use strict';
// Settle CONTRACT.md section 3.9 rules 1a and 1b, which are the two rules the
// document marks "unrecorded, not measured".
//
// Rule 1a says psmux parses `main-pane-width` as a bare u16, so tmux's `50%`
// fails silently and the option is never set. Rule 1b says the consequence:
// because `main_pane_width` is read only inside `apply_layout`, setting the
// option applies nothing until a layout runs, so the bridge must inject a
// follow-up `select-layout`.
//
// Both claims are currently source-reading. This probe exercises them in one
// sequence, on a known window width, with the pane geometry on both sides:
//
//   A  `set-window-option main-pane-width "50%"`  -> expect NO change (60% default)
//   B  `set-window-option main-pane-width "50"`   -> expect NO change on its own,
//                                                    which is rule 1b's premise
//   C  ...then an untargeted `select-layout main-vertical` -> expect ~50%
//   D  the reverse order, layout then option      -> expect the option to be inert
//
// A and C together separate the two rules: if C moves the pane to ~50% while A
// does not, rule 1a's premise holds (the `%` form really is dropped) and rule
// 1b's remedy is confirmed necessary (B alone changed nothing). D is what makes
// rule 1b's *ordering* claim falsifiable rather than merely plausible.
//
// The window width is recorded because "did it become 50%" is not answerable
// without it, and a percentage-looking number with no denominator is how a
// geometry claim goes wrong.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const NS = 'omo_t20';
const S = 'mpw';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function p(argv, t) {
  const r = spawnSync(REAL, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: t || 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Window width is captured alongside the panes on every reading. `#{pane_width}`
// alone cannot distinguish "50% of 200" from "50% of 120".
const geometry = () => ({
  windows: p(['list-windows', '-a', '-F', '#{window_index}|#{window_width}x#{window_height}|#{window_layout}|#{window_panes}p']).stdout,
  panes: p(['list-panes', '-a', '-F', '#{window_index}.#{pane_index}|#{pane_id}|#{pane_width}x#{pane_height}|#{pane_left},#{pane_top}']).stdout,
});

// Main pane width as a number, or null if it cannot be read. The main pane of a
// `main-vertical` window is the left one, so index 0 is the one rules 1a/1b size.
function mainWidth(g) {
  const first = g.panes.split('\n').find((l) => l.startsWith('0.0|'));
  if (!first) return null;
  const m = first.match(/\|(\d+)x\d+\|\d+,\d+$/);
  return m ? Number(m[1]) : null;
}

function windowWidth(g) {
  const first = g.windows.split('\n')[0];
  if (!first) return null;
  const m = first.match(/\|(\d+)x\d+\|/);
  return m ? Number(m[1]) : null;
}

p(['kill-session', '-t', S]);
p(['new-session', '-d', '-s', S, '-n', 'w']);
p(['split-window', '-d', '-t', S + ':0']);
sleep(1200);
p(['select-layout', '-t', S + ':0', 'main-vertical']);
sleep(1200);

const out = { namespace: NS, session: S, steps: [] };

function record(tag, result) {
  sleep(1200);
  const g = geometry();
  const step = {
    tag,
    invocation: result.invocation,
    exit: result.status,
    stderr: result.stderr,
    geometry: g,
    main_width: mainWidth(g),
    window_width: windowWidth(g),
  };
  // The share is the only comparable number across windows of different sizes,
  // and it is what "50%" and "60%" actually mean.
  step.main_share = step.main_width !== null && step.window_width
    ? Number((step.main_width / step.window_width).toFixed(4))
    : null;
  out.steps.push(step);
  return step;
}

const base = record('baseline: main-vertical, option never set', { invocation: ['select-layout', '-t', S + ':0', 'main-vertical'], status: 0, stderr: '' });

// A — rule 1a's premise: the `%` form is dropped.
const a = record('A: set main-pane-width "50%", then select-layout', p(['set-window-option', 'main-pane-width', '50%']));
record('A2: then an untargeted select-layout main-vertical', p(['select-layout', 'main-vertical']));

// B — rule 1b's premise: the bare form stores, but storing alone applies nothing.
const b = record('B: set main-pane-width "50", no layout yet', p(['set-window-option', 'main-pane-width', '50']));
// C — rule 1b's remedy: the follow-up is what makes it take effect.
const c = record('C: then untargeted select-layout main-vertical', p(['select-layout', 'main-vertical']));

// D — rule 1b's ordering claim: layout BEFORE the option must be inert.
const d = record('D: select-layout first, for contrast', p(['select-layout', 'main-vertical']));
record('D2: then set main-pane-width "40"', p(['set-window-option', 'main-pane-width', '40']));
const d2 = record('D3: geometry after setting the option with no layout after it', { invocation: ['(none)'], status: 0, stderr: '' });

// E — the risk section 9.4 raises, applied to rule 1b rather than to select-layout
// on its own. Its survival probe found that a `select-window` issued by a process
// which then EXITS leaves an untargeted layout doing nothing at all. Every step
// above is a bare option-set followed by a bare layout, with no `select-window`
// anywhere. A real OmO session is not guaranteed to be that tidy, so: put a
// `select-window` from a process that exits BETWEEN rule 1b's option and its
// follow-up, and see whether the follow-up still applies the stored size.
//
// This is the sequence rule 1b actually emits, plus one command it does not emit.
// If the share still reaches ~0.5, the intervening selection is harmless. If it
// stays at 0.6, then rule 1b's remedy is conditional on nothing else having
// touched the window in between, which is a property worth knowing.
p(['set-window-option', 'main-pane-width', '60']);
p(['select-layout', 'main-vertical']);
sleep(1200);
record('E0: reset to 60 for contrast', { invocation: ['(reset)'], status: 0, stderr: '' });
p(['set-window-option', 'main-pane-width', '50']);
p(['select-window', '-t', S + ':0']);
const e = record('E: follow-up AFTER a select-window from an exited process', p(['select-layout', 'main-vertical']));

// Verdict computed here rather than left to the reader, because the whole point
// is that a bare percentage with no denominator is not evidence.
out.verdict = {
  rule_1a_percent_form_ignored: a.main_share === base.main_share,
  rule_1b_option_alone_inert: b.main_share === base.main_share,
  rule_1b_followup_applies: c.main_share !== null && Math.abs(c.main_share - 0.5) < 0.03,
  rule_1b_order_matters: d2.main_share === c.main_share,
  // E: does an intervening `select-window` from a process that exits disarm the
  // follow-up? Null when the share is unreadable, which is not the same as false.
  rule_1b_survives_intervening_select_window: e.main_share === null
    ? null
    : Math.abs(e.main_share - 0.5) < 0.03,
  e_share: e.main_share,
  baseline_share: base.main_share,
  shares: Object.fromEntries(out.steps.map((s) => [s.tag, s.main_share])),
};

p(['kill-session', '-t', S]);
p(['kill-server']);
out.after_teardown = p(['list-sessions']).stdout;

const dir = path.join(process.env.TEMP, 'omo-t20');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'main-pane-width-probe.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log('written ' + dest);