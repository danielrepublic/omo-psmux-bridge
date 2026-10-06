'use strict';
// Rule 1c, measured.
//
// Rule 1c is the one layout rule CONTRACT.md section 14 step 5 deliberately left
// unprobed, on the reasoning that a probe would "measure the layout rather than
// the parser". That reasoning was wrong, and this probe is the correction: rules
// 1a and 1b are measured behaviourally — apply, then read the geometry — and
// rule 1c's claim is the same shape. The claim is that a tmux CELL COUNT passed to
// `resize-pane -x` arrives as a PERCENTAGE:
//
//   `resize_pane_absolute` writes the caller's number into `sizes[idx]`, and
//   `sizes` holds proportions — `src/tree.rs:21` sums it into a variable named
//   `total_pct` and `src/tree.rs:31` divides by that sum.
//
// So the two readings are trivially distinguishable if the number is chosen so
// they cannot coincide. On a W-column window:
//
//   `-x 99` read as a CELL COUNT  -> main pane is exactly  99 columns
//   `-x 99` read as a PERCENTAGE  -> main pane is about 99% of W
//
// With W near 200 those are 99 versus about 197. Nothing subtle is required to
// tell them apart, which is exactly why the rule can be watched rather than
// argued.
//
// It also tests the bridge's half, because a rule that suppresses a command is
// only doing its job if forwarding that command would actually have broken
// something. The shim arm runs the same argv THROUGH the bridge, where rule 1c
// suppresses it, and the geometry must not move.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const SHIM = path.join(process.env.TEMP, 'omo-t14', 'bin', 'tmux.exe');
const NS = 'omo_t23';
const S = 'rc';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const TIMEOUT = 30000;

function run(bin, argv) {
  const r = spawnSync(bin, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: TIMEOUT, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const p = (argv) => run(REAL, argv);
const viaShim = (argv) => run(SHIM, argv);

const geometry = () => ({
  windows: p(['list-windows', '-a', '-F', '#{window_index}|#{window_width}x#{window_height}|#{window_layout}|#{window_panes}p']).stdout,
  panes: p(['list-panes', '-a', '-F', '#{window_index}.#{pane_index}|#{pane_width}x#{pane_height}|#{pane_left},#{pane_top}']).stdout,
});

function mainWidth(g) {
  const first = g.panes.split('\n').find((l) => l.startsWith('0.0|'));
  if (!first) return null;
  const m = first.match(/\|(\d+)x(\d+)\|(\d+),(\d+)$/);
  return m ? Number(m[1]) : null;
}
function windowWidth(g) {
  const m = g.windows.split('\n')[0] && g.windows.split('\n')[0].match(/\|(\d+)x\d+\|/);
  return m ? Number(m[1]) : null;
}

p(['kill-session', '-t', S]);
p(['new-session', '-d', '-s', S, '-n', 'w']);
p(['split-window', '-d', '-t', S + ':0']);
sleep(1200);
// main-vertical so the tree is the nested two-child shape rule 1c's arithmetic
// depends on, and so pane 0 is the main pane.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
sleep(1500);

const out = { namespace: NS, session: S, steps: [] };

function record(tag, res, bin) {
  sleep(1200);
  const g = geometry();
  const mw = mainWidth(g);
  const ww = windowWidth(g);
  const step = {
    tag,
    via: bin,
    argv: res.argv || null,
    exit: res.status,
    stderr: res.stderr,
    window_width: ww,
    main_width: mw,
    // The discriminator. A cell reading lands on the number the caller sent; a
    // percentage reading lands on that number as a share of the window.
    main_share: mw !== null && ww ? Number((mw / ww).toFixed(4)) : null,
  };
  out.steps.push(step);
  return step;
}

const CELLS = 99;
const base = record('baseline: main-vertical, nothing resized', { status: 0, stderr: '' }, 'direct');

// The two readings, for the record, so the verdict keys below are readable.
out.expected = {
  cells_sent: CELLS,
  if_read_as_cells: CELLS,
  if_read_as_percentage: null,
};

// Direct arm: the bare cell count, which is what OmO emits and what rule 1c
// suppresses in the bridge.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
sleep(1000);
const direct = record(
  'DIRECT: resize-pane -x 99 (bare cell count)',
  Object.assign(p(['resize-pane', '-t', S + ':0', '-x', String(CELLS)]), { argv: ['resize-pane', '-t', S + ':0', '-x', String(CELLS)] }),
  'direct',
);
out.expected.if_read_as_percentage = direct.main_share !== null ? Math.round(direct.window_width * direct.main_share) : null;

// Shim arm: the same argv through the bridge, where rule 1c must suppress it.
p(['select-layout', '-t', S + ':0', 'main-vertical']);
sleep(1000);
const shimmed = record(
  'THROUGH SHIM: the same argv, which rule 1c suppresses',
  Object.assign(viaShim(['resize-pane', '-t', S + ':0', '-x', String(CELLS)]), { argv: ['resize-pane', '-t', S + ':0', '-x', String(CELLS)] }),
  'shim',
);

function isPctReading(step) {
  if (step.main_width === null) return null;
  // "Percentage" means the pane took ~99% of the window, which is nowhere near the
  // 99 columns a cell reading would give on a ~200-column window.
  return step.main_share !== null && step.main_share > 0.8;
}

out.verdict = {
  // The defect rule 1c exists to suppress: present, or psmux fixed it.
  rule_1c_defect_present: isPctReading(direct),
  // If the defect is present, the numbers should confirm which reading happened.
  direct_landed_where: isPctReading(direct) === true
    ? `~${direct.main_width} columns, about ${Math.round(direct.main_share * 100)}% of ${direct.window_width}`
    : isPctReading(direct) === false ? `${direct.main_width} columns` : null,
  // The bridge's half: rule 1c suppresses, so the geometry must NOT move.
  shim_left_geometry_unchanged: shimmed.main_width === base.main_width,
  baseline_main: base.main_width,
  window_width: base.window_width,
};

p(['kill-session', '-t', S]);
p(['kill-server']);
out.after_teardown = p(['list-sessions']).stdout;

const dir = path.join(process.env.TEMP, 'omo-t23');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'resize-pane-cells-probe.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
console.log('written ' + dest);