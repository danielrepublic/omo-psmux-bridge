'use strict';
// VOID — this probe does not measure what it claims. Kept because the reason it
// fails is itself the useful finding, and because deleting a negative result is how
// the next person repeats it.
//
// WHAT IT WAS FOR
// Section 9.5 knows a collision is real, non-reproducible, and self-healing. What
// it lacks is the tolerance: how close together two clients' `select-layout` calls
// must be before they interfere. If microseconds, real agent traffic will not
// trigger it; if hundreds of milliseconds, it is a live risk. This swept that
// delay.
//
// WHAT IT PRODUCED
// `NONE` at every gap — 0, 50, 150, 400, 1000 and 2500 ms. Nothing changed at any
// separation, up to two and a half seconds.
//
// WHY THAT IS NOT A TOLERANCE NUMBER
// Both layouts here differ from the reset layouts, so at least one of them should
// have landed. None did. The sweep is not measuring interference between two
// layouts — it is reproducing the 9.4 R1/R2 phenomenon, where an untargeted layout
// is inert once a process has issued `select-window` and exited. The gap, the
// variable this probe exists to sweep, is irrelevant when neither layout applies.
//
// The guard that should have caught it does not, and that is the sharper lesson.
// `invocations_all_succeeded` checks exit codes, and psmux cannot fail an untargeted
// `select-layout` — it exits 0 whether it applied the layout or did nothing at all.
// That is section 9.3's first finding. So an exit-code guard is blind to precisely
// the failure this probe needed to detect, and three earlier guards did not prevent
// this because they all watched the same wrong signal.
//
// WHAT A WORKING VERSION NEEDS
// A per-trial control: before sweeping, prove that an untargeted layout CAN apply
// in that exact session state, and void the trial if it cannot. Every probe here
// after this one should carry one. "Nothing changed" must never be reportable
// without a same-trial demonstration that something could have changed.
//
// Retiring the sweep rather than fixing it in place: a correct version needs a
// session state where a layout reliably applies first, and establishing that is
// the open question in 9.4, not a prerequisite this probe can assume away.

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