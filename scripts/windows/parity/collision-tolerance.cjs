'use strict';
// How close together must two clients' layout calls be before anything goes wrong?
//
// Section 9.5 measured that a collision is real but not reproducible: one run in
// three showed it, and it always healed. That is enough to know the defect exists
// and not enough to judge whether it matters, because the missing number is the
// tolerance — how far apart two agents' `select-layout` calls can be before the
// interference stops.
//
// This sweep measures that directly. One parameter varies: the delay between the
// two clients' untargeted layouts. Everything else is fixed, both windows start
// from the same reset layouts, and both clients target different windows so a
// correct outcome is unambiguous.
//
// The outcomes that mean "something went wrong" are:
//
//   NONE        neither window changed — the concurrent-trial signature
//   BOTH_ON_ONE both layouts landed on the same window — the collision signature
//   CORRECT     each window holds the layout its own client asked for
//
// At some delay the distribution must move to CORRECT, because two processes
// cannot interleave forever. Where that transition sits is the number that says
// whether real agent traffic is anywhere near it.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const NS = 'omo_t24';
const S = 'gap';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function p(argv) {
  const r = spawnSync(REAL, ['-L', NS].concat(argv), { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const spawnP = (args) => new Promise((resolve) => {
  const ps = spawn(REAL, ['-L', NS].concat(args), { windowsHide: true });
  ps.on('close', (code) => resolve({ args, exit: code }));
});

const layouts = () => p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}']).stdout;
const A = 'main-horizontal'; // A's layout, a top/bottom split neither window starts in
const B = 'tiled';           // B's layout, an even split

function classify(before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(b.length, a.length); i += 1) {
    if (b[i] !== a[i]) changed.push(i);
  }
  if (changed.length === 0) return { outcome: 'NONE', changed };
  if (changed.length === 2) return { outcome: 'BOTH_ON_ONE', changed };
  return { outcome: 'CHANGED_ONE', changed };
}

async function trial(gapMs) {
  // Both windows start identical on every trial so a change is attributable.
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(1200);
  const before = layouts();

  // Pointer selection is sequential and identical every time: the last one wins,
  // so both clients' untargeted layouts will contend for the same window by
  // construction. The only variable left is how close the two layouts are issued.
  await spawnP(['select-window', '-t', S + ':0']);
  await spawnP(['select-window', '-t', S + ':1']);

  const first = spawnP(['select-layout', A]);
  await sleep(gapMs);
  const second = spawnP(['select-layout', B]);
  const results = await Promise.all([first, second]);

  sleep(1200);
  const after = layouts();
  const { outcome, changed } = classify(before, after);
  return {
    gap_ms: gapMs,
    outcome,
    changed_windows: changed,
    invocations_ok: results.every((r) => r.exit === 0),
    before,
    after,
  };
}

(async () => {
  p(['kill-session', '-t', S]);
  p(['new-session', '-d', '-s', S, '-n', 'w0']);
  p(['split-window', '-d', '-t', S + ':0']);
  p(['new-window', '-d', '-t', S, '-n', 'w1']);
  p(['split-window', '-d', '-t', S + ':1']);
  sleep(1500);

  // A logarithmic-ish sweep: the interesting region is where interference stops,
  // and that is not known in advance, so the steps are wide at first and narrow
  // toward the bottom where two process launches actually overlap.
  const GAPS = [0, 50, 150, 400, 1000, 2500];
  const out = { namespace: NS, session: S, layouts: { A, B }, trials: [] };

  for (const gap of GAPS) {
    out.trials.push(await trial(gap));
  }

  const ok = out.trials.filter((t) => t.invocations_ok);
  out.verdict = {
    invocations_all_succeeded: ok.length === out.trials.length,
    outcomes_by_gap: Object.fromEntries(out.trials.map((t) => [t.gap_ms, t.outcome])),
    // The tolerance, stated as the smallest gap at which no trial was disturbed.
    // null when every gap disturbed something, which is itself the finding.
    smallest_undisturbed_gap_ms: (() => {
      const clean = ok.filter((t) => t.outcome === 'CHANGED_ONE' || t.outcome === 'CORRECT');
      return clean.length ? Math.min(...clean.map((t) => t.gap_ms)) : null;
    })(),
    clean_outcomes: ok.filter((t) => t.outcome !== 'NONE' && t.outcome !== 'BOTH_ON_ONE').length,
    disturbed_outcomes: ok.filter((t) => t.outcome === 'NONE' || t.outcome === 'BOTH_ON_ONE').length,
  };

  p(['kill-session', '-t', S]);
  p(['kill-server']);
  out.after_teardown = p(['list-sessions']).stdout;

  const dir = path.join(process.env.TEMP, 'omo-t24');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'collision-tolerance.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  console.log('written ' + dest);
})();