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
//   B  select-window -> w1, pause, untargeted `tiled`
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

(async () => {
  // Trial 1: both select a different window, then apply a layout the other
  // window does not already have.
  const t1 = await concurrentTrial(
    'two clients, distinct targets, concurrent',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'tiled' },
    700,
  );

  // Trial 2: same but serialised by a long pause, as a control for "did the
  // concurrency matter or would this happen anyway".
  const t2 = await concurrentTrial(
    'two clients, distinct targets, long pause',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'tiled' },
    2500,
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
  const collided = await concurrentTrial(
    'collision, before recovery',
    { target: S + ':0', layout: 'main-horizontal' },
    { target: S + ':1', layout: 'tiled' },
    2500,
  );
  p(['select-layout', '-t', S + ':0', 'main-horizontal']);
  p(['select-layout', '-t', S + ':1', 'tiled']);
  sleep(1500);
  const recovered = layouts();
  const wanted = [
    p(['list-windows', '-t', S + ':0', '-F', '#{window_layout}']).stdout,
    p(['list-windows', '-t', S + ':1', '-F', '#{window_layout}']).stdout,
  ];
  out.recovery = {
    after_collision: collided.after,
    after_targeted_repair: recovered,
    wanted_layouts: wanted,
    repair_succeeded: recovered.split('\n').map((l) => l.split('|')[1]).join('|')
      === wanted.join('|'),
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