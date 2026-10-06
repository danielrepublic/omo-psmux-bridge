'use strict';
// REPAIRED 2026-10-07, commits f79cc3a onward. This probe WAS void — it reported
// `NONE` at every gap and had no way to tell "no interference" from "nothing could
// have applied" — and it now carries the control that closes that gap. The failed
// version's reasoning is kept below because it is what motivated the control, and
// because deleting a negative result is how the next person repeats it.
//
// The first repair attempt was itself wrong twice over, and both errors are kept
// here too. It blamed the layout names, which test_layout.rs:159 shows are valid;
// and its control checked `tiled` against an `even-horizontal` baseline, which on a
// two-pane window is the same split, so it scored a successful apply as a failure.
// A control that cannot distinguish "applied" from "applied and identical to the
// baseline" is not a control.
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
// NO LONGER VOID. The control below was added and this sweep is now able to report
// a tolerance number, or to report that it cannot — and the second case is now
// visible rather than silent, which is the whole reason the control exists.
//
// REOPENED 2026-10-07, commit 83c3420. The paragraph above is now false. Section
// 9.4's open question was answered: the current-window pointer DOES survive the
// connection (R1 set w0 from an earlier process and the untargeted layout landed
// on w0; R2 set w1 and it landed on w1). So there is no missing session state and
// nothing to establish first.
//
// That leaves the likelier cause, which is embarrassingly local: the layout names.
// psmux v3.3.8 has a small layout set, and `select-layout` on a name it does not
// know exits 0 and does nothing. A and B are not psmux names — `tiled` is tmux's,
// not psmux's. If BOTH are invalid then every trial applies nothing at every gap
// and returns NONE, which is precisely what was observed, and no amount of session
// state would change it.
//
// HYPOTHESIS FALSIFIED 2026-10-07. Both names are valid psmux layouts:
// `tests-rs/test_layout.rs:159` lists them — "even-horizontal", "even-vertical",
// "main-horizontal", "main-vertical", "tiled" — and `test_commands_audit.rs:710`
// asserts `select-layout tiled` applies. So the silence is not a bad name, and the
// cause is still unknown. The control below is now the instrument for finding it:
// it separates "the name is refused" from "the name is accepted but this state
// refuses to apply it", which are indistinguishable from NONE alone.
//
// So the generalisable shape of the fix, which survives the falsification: for an
// untargeted command, prove the invocation is capable of doing something before
// concluding that it did nothing.
// Each name is checked against a baseline it cannot possibly equal, or the check
// measures the baseline instead of psmux.
const BASELINE_FOR = { 'main-vertical': 'even-horizontal', 'even-vertical': 'main-vertical' };

async function control() {
  const named = {};
  for (const name of [A, B]) {
    const baseline = BASELINE_FOR[name];
    p(['select-layout', '-t', S + ':1', baseline]);
    sleep(700);
    const before = layouts();
    p(['select-layout', '-t', S + ':1', name]);
    sleep(700);
    named[name] = { baseline, applied: before !== layouts() };
  }

  p(['select-layout', '-t', S + ':1', BASELINE_FOR[A]]);
  sleep(700);
  const before = layouts();
  await spawnP(['select-window', '-t', S + ':1']);
  await spawnP(['select-layout', A]);
  sleep(1000);
  return {
    layout_names_accepted: named,
    untargeted_applies_with_pointer_on_w1: before !== layouts(),
  };
}

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
// All three observable states must differ from each other.
//
// `tiled` was B's layout and the trial reset w1 to `even-horizontal`. On a two-pane
// window `tiled` is a balanced split, which is what `even-horizontal` already is, so
// psmux reports it back as `even-horizontal`. The trial therefore ran
//
//   even-horizontal --A--> main-vertical --B(tiled)--> even-horizontal
//
// and the final observable state equalled the baseline, so a sweep in which both
// layouts applied perfectly was scored NONE at every gap. Not inertness — a baseline
// collision with the operation's own result. The same mistake the control made, in
// the one place it had not been fixed.
//
// B is now even-vertical, which is a distinct orientation and cannot alias the
// reset. The general rule, now stated twice because it has been learned twice: pick
// a baseline the operation cannot reproduce, or a successful apply is invisible.
const A = 'main-vertical';    // A's layout, a left/right split
const B = 'even-vertical';    // B's layout, a top/bottom split — never aliases the reset
const RESET_W1 = 'even-horizontal'; // w1's reset; distinct from both A and B

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
  // w0 resets to an orientation neither A nor B uses, so that if a layout lands on
  // w0 by mistake the change is still visible. w1 resets to even-horizontal, which
  // is neither A nor B. Every window starts in a state neither layout can reproduce,
  // so any apply at all is observable on any window.
  p(['select-layout', '-t', S + ':0', 'main-horizontal']);
  p(['select-layout', '-t', S + ':1', RESET_W1]);
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

  // The control runs first, in the same session state the sweep will use. If an
  // untargeted layout cannot apply here, NONE is uninterpretable and the sweep is
  // void regardless of what the trials say.
  out.control = await control();
  out.verdict_void_reason = null;
  if (!Object.values(out.control.layout_names_accepted).every((r) => r.applied)) {
    out.verdict_void_reason = 'a layout name in the sweep is not accepted by psmux';
  } else if (!out.control.untargeted_applies_with_pointer_on_w1) {
    out.verdict_void_reason =
      'an untargeted layout did not apply even in the control trial, so NONE cannot be ' +
      'read as "no interference" — it is indistinguishable from "nothing applied"';
  }

  for (const gap of GAPS) {
    out.trials.push(await trial(gap));
  }

  const ok = out.trials.filter((t) => t.invocations_ok);
  out.verdict = {
    control_passed: out.verdict_void_reason === null,
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