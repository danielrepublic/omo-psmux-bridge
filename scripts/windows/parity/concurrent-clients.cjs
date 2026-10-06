'use strict';
// The last unmeasured claim in CONTRACT.md sections 9.3 and 9.4.
//
// 9.3 said, and marked INFERRED: "each client probably carries its own
// current-window pointer, in which case two agents laying out concurrently would
// each hit their own window". It could not assert that, because psmux's
// `active_idx` is server state (`src/layout.rs:1070`) and psmux runs ONE server
// per session. If it is genuinely global, two concurrent clients do not each get
// their own window — they race, and at most one of them gets the window it asked
// for.
//
// That is not a theoretical concern here. The bridge injects an untargeted
// `select-layout` for rules 1b and 1e, and team mode creates several agents laying
// out at the same time. If the pointer is global, concurrent injections collide,
// and the loser's layout lands on the winner's window while both report success.
//
// Everything so far ran one process at a time. This runs two CONCURRENTLY, using
// spawn rather than spawnSync, so the two `select-window` calls genuinely overlap.
//
//   A  select-window -> w0, pause, untargeted `main-horizontal`
//   B  select-window -> w1, pause, untargeted `even-vertical`
//
// `tiled` was B's layout here and it is gone for a measured reason. w1 resets to
// `even-horizontal`, and `tiled` on a two-pane window serialises to the identical
// layout tree — `collision-tolerance.cjs` recorded byte-identical `#{window_layout}`
// strings before and after a `tiled` apply, `aliased_with_reset: true`. So B's apply
// was unobservable no matter whether it succeeded: the window ended where it started.
// A probe that cannot see half its clients' work cannot support a risk claim, which
// is what section 9.5 was making. `even-vertical` stacks the panes and produces a
// tree `even-horizontal` cannot, so the apply is visible either way.
//
// Each applies a layout the OTHER window is not already in, so whichever window
// each one lands on is visible.
//
//   both land on their own window  -> the pointer is per-client
//   both land on the same window   -> the pointer is global and they raced
//   one lands, one does nothing    -> partial, and the loser is the finding

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const LA = process.env.LOCALAPPDATA;
const REAL = path.join(LA, 'psmux', 'tmux.exe');
const NS = 'omo_t22';
const S = 'race';
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
p(['select-layout', '-t', S + ':0', 'main-vertical']);
p(['select-layout', '-t', S + ':1', 'even-horizontal']);
sleep(1500);

const out = { namespace: NS, session: S, baseline: layouts(), trials: [] };

// Both phases run as pairs of genuinely overlapping psmux processes.
//
// An earlier version drove each client through `cmd.exe /c "…"` to get a pause
// between its two commands. It never ran: quoting a Windows path through Node's
// spawn into cmd.exe produced `\"C:\\…\\tmux.exe\"` as a literal, and every
// invocation exited 1. Both trials then reported "nothing changed", which read as
// a finding and was not one. So: no shell, direct spawn, and the overlap comes
// from starting a pair at the same time rather than from pausing inside one.
const spawnP = (args) => new Promise((resolve) => {
  const ps = spawn(REAL, ['-L', NS].concat(args), { windowsHide: true });
  let stderr = '';
  ps.stderr.on('data', (d) => { stderr += String(d); });
  ps.on('close', (code) => resolve({ args, exit: code, stderr: stderr.trim() }));
});

// Each trial resets both windows, then runs both clients with their two phases
// overlapped.
function concurrentTrial(tag, clientA, clientB, pauseMs) {
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(1200);
  const before = layouts();

  return Promise.all([
    // Phase 1: both clients name a different window, at the same time.
    spawnP(['select-window', '-t', clientA.target]),
    spawnP(['select-window', '-t', clientB.target]),
  ]).then((selects) => new Promise((resolve) => {
    sleep(pauseMs);
    // Phase 2: both apply an untargeted layout, at the same time.
    Promise.all([
      spawnP(['select-layout', clientA.layout]),
      spawnP(['select-layout', clientB.layout]),
    ]).then((applies) => resolve({ selects, applies }));
  })).then((r) => {
    sleep(1500);
    const after = layouts();
    const b = before.split('\n');
    const a = after.split('\n');
    const changed = [];
    for (let i = 0; i < Math.max(b.length, a.length); i += 1) {
      if (b[i] !== a[i]) changed.push({ window: i, before: b[i], after: a[i] });
    }
    const rec = {
      tag,
      pause_ms: pauseMs,
      client_a: { target: clientA.target, layout: clientA.layout },
      client_b: { target: clientB.target, layout: clientB.layout },
      invocations: [...r.selects, ...r.applies],
      before,
      after,
      changed_windows: changed,
    };
    out.trials.push(rec);
    return rec;
  });
}

// Trial 4 — is a dropped layout computed and then discarded, or never computed?
//
// Trials 1-3 start both applies with Promise.all, so there is no instant between them
// at which anything can be observed. Both are reported as `changed: [1]`, which is
// equally consistent with client A's layout having been computed against w1 and then
// overwritten by B's, and with A's layout never having been computed at all. This
// trial staggers phase 2 so there IS a moment between the two applies, and samples it.
//
// This is a DIFFERENT condition from trials 1-3 — phase 2 is serial here, parallel
// there — and it is labelled separately for that reason. It answers the mechanism
// question, not the collision-rate question, and its result must not be pooled with
// theirs.
//
// §9.5 already established that staggering phase 2 by 2.5 s does not prevent the
// collision, so a staggered trial that shows A's layout landing on w1 is the expected
// result if the mechanism is last-writer-wins on a global pointer. If A's layout does
// not appear mid-flight, the mechanism is something else and 9.5's explanation is wrong.
async function staggeredTrial(tag, clientA, clientB) {
  // w0 resets to `main-vertical`, which NEITHER client applies — client A applies
  // main-horizontal, client B even-vertical. The first version reset w0 to
  // main-horizontal, i.e. to client A's own layout, which made w0's line identical
  // before and after no matter what A's apply did. That is precisely the baseline
  // fault this file has already been corrected for twice: a reset the operation can
  // reproduce hides the operation. w0 is now the window whose movement is evidence.
  // `main-vertical` on a two-pane window yields `{71x30 / 48x30}`, a different tree
  // from both clients' layouts.
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(1200);
  const before = layouts();

  // Phase 1 as in every other trial: both clients name their window, concurrently.
  const selects = await Promise.all([
    spawnP(['select-window', '-t', clientA.target]),
    spawnP(['select-window', '-t', clientB.target]),
  ]);
  sleep(1500);
  const after_selects = layouts();

  // Phase 2, staggered. A first, sampled, then B.
  const applyA = await spawnP(['select-layout', clientA.layout]);
  sleep(1500);
  const mid = layouts();
  const applyB = await spawnP(['select-layout', clientB.layout]);
  sleep(1500);
  const after = layouts();

  const diff = (x, y) => {
    const bx = x.split('\n');
    const ay = y.split('\n');
    const out = [];
    for (let i = 0; i < Math.max(bx.length, ay.length); i += 1) {
      if (bx[i] !== ay[i]) out.push({ window: i, before: bx[i], after: ay[i] });
    }
    return out;
  };

  const rec = {
    tag,
    condition: 'phase 2 staggered (serial), NOT pooled with trials 1-3',
    client_a: { target: clientA.target, layout: clientA.layout },
    client_b: { target: clientB.target, layout: clientB.layout },
    invocations: [...selects, applyA, applyB],
    before,
    after_selects,
    mid,
    after,
    // Which windows moved between the reset and the mid-flight sample. If w0 is here,
    // A's layout reached the window A named. If w1 is here, A's untargeted layout was
    // computed against the pointer B had already moved — computed, then overwritten.
    changed_by_a_alone: diff(before, mid),
    changed_by_b_alone: diff(mid, after),
  };
  // Deliberately NOT pushed into out.trials: the verdict there iterates records
  // expecting `changed_windows`, and this record reports two separate diffs instead.
  // Pooling a different condition into the same series is how the previous two
  // corrections in this file went wrong.
  out.staggered = rec;
  return rec;
}

(async () => {
  // Trial 1: both select a different window, then apply a layout the other
  // window does not already have.
  const t1 = await concurrentTrial(
    'two clients, distinct targets, concurrent',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'even-vertical' },
    700,
  );

  // Trial 2: same but serialised by a long pause, as a control for "did the
  // concurrency matter or would this happen anyway".
  const t2 = await concurrentTrial(
    'two clients, distinct targets, long pause',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'even-vertical' },
    2500,
  );

  // Trial 4: the mechanism question. Runs last so it cannot perturb trials 1-3.
  await staggeredTrial(
    'staggered phase 2, sampled between the two applies',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'even-vertical' },
  );

  // Trial 3 — does a collision heal?
  //
  // Trials 1 and 2 show that two clients can land on the same window. That is only
  // a defect if it PERSISTS: if a later, correctly-targeted call restores each
  // window, then a collision is a transient wrong frame in a sequence that ends up
  // right, which is a materially smaller problem than a session left mislaid out
  // with no way back.
  //
  // No bridge-side fix exists for the collision (CONTRACT.md 9.5), so whether the
  // system recovers on its own is the only thing left that bounds it. Both windows
  // are reset, deliberately collided, then each is given a correct targeted layout
  // and the result compared with a known-good arrangement.
  // The known-good arrangement is read BEFORE the collision, not after the repair.
  //
  // It used to be read after, from the same live server the repair had just
  // modified — so `wantedLayouts` was a re-read of `recovered` and the comparison
  // could not fail. `repair_succeeded` was vacuously true, and it is the only thing
  // bounding 9.5's risk claim. Capturing it first makes the reference independent of
  // the state it is judging, which is the whole difference between a check and a
  // tautology.
  p(['select-layout', '-t', S + ':0', 'main-horizontal']);
  p(['select-layout', '-t', S + ':1', 'even-vertical']);
  sleep(1500);
  const wantedLayouts = p(['list-windows', '-a', '-F', '#{window_index}|#{window_layout}']).stdout
    .split('\n').map((l) => l.split('|')[1]);

  const collided = await concurrentTrial(
    'collision, before recovery',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'even-vertical' },
    2500,
  );
  p(['select-layout', '-t', S + ':0', 'main-horizontal']);
  p(['select-layout', '-t', S + ':1', 'even-vertical']);
  sleep(1500);
  const recovered = layouts();
  const recoveredLayouts = recovered.split('\n').map((l) => l.split('|')[1]);
  out.recovery = {
    after_collision: collided.after,
    after_targeted_repair: recovered,
    wanted_layouts: wantedLayouts,
    recovered_layouts: recoveredLayouts,
    repair_succeeded: wantedLayouts.length === recoveredLayouts.length
      && wantedLayouts.every((w, i) => w === recoveredLayouts[i]),
  };

  const landing = (rec) => rec.changed_windows.map((w) => w.window).sort();

  // A trial whose invocations did not all succeed has measured NOTHING, and
  // "nothing changed" is exactly what a broken trial looks like. The first run of
  // this probe reported an empty result for both trials for precisely that
  // reason — every cmd.exe invocation exited 1 — and it read as a finding.
  // So the verdict refuses to speak unless the mechanism demonstrably ran.
  const failed = out.trials.flatMap((t) => t.invocations.filter((i) => i.exit !== 0));
  const measured = failed.length === 0;

  out.verdict = {
    invocations_all_succeeded: measured,
    failed_invocations: failed.map((f) => ({ args: f.args, exit: f.exit, stderr: f.stderr.slice(0, 200) })),
    concurrent_landed: landing(t1),
    serialised_landed: landing(t2),
    // The decision-relevant question: did both clients get their own window, or
    // did they collide on one because `active_idx` is global server state?
    both_got_their_own_window: measured && JSON.stringify(landing(t1)) === JSON.stringify([0, 1]),
    collided_on_one_window: measured && landing(t1).length === 1,
    // If concurrency and serialisation give the same answer, the trial is not
    // measuring concurrency at all and the verdict should not be read as one.
    concurrency_changed_the_outcome:
      measured && JSON.stringify(landing(t1)) !== JSON.stringify(landing(t2)),
  };

  p(['kill-session', '-t', S]);
  p(['kill-server']);
  out.after_teardown = p(['list-sessions']).stdout;

  const dir = path.join(process.env.TEMP, 'omo-t22');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'concurrent-clients.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  console.log('written ' + dest);
})();