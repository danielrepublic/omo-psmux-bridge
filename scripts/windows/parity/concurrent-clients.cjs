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

// Each trial resets both windows, then starts two processes at once. The pause
// between select-window and select-layout is what creates the overlap: without it
// the first process finishes before the second starts and the trial measures
// nothing about concurrency.
function concurrentTrial(tag, targetA, layoutA, targetB, layoutB, pauseMs) {
  p(['select-layout', '-t', S + ':0', 'main-vertical']);
  p(['select-layout', '-t', S + ':1', 'even-horizontal']);
  sleep(1200);
  const before = layouts();

  // Both psmux calls live inside ONE spawned shell, so the pause between them
  // belongs to a single process and the overlap is real rather than a gap between
  // two spawnSync round-trips.
  const run = (target, layout) => new Promise((resolve) => {
    const ps = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', [
        `"${REAL}" -L ${NS} select-window -t ${target}`,
        pauseMs ? `&& timeout /t ${Math.ceil(pauseMs / 1000)} /nobreak >nul` : '',
        `&& "${REAL}" -L ${NS} select-layout ${layout}`,
      ].filter(Boolean).join(' ')],
      { windowsHide: true },
    );
    let stderr = '';
    ps.stderr.on('data', (d) => { stderr += String(d); });
    ps.on('close', (code) => resolve({ target, layout, exit: code, stderr: stderr.trim() }));
  });

  return Promise.all([run(targetA, layoutA), run(targetB, layoutB)]).then((results) => {
    sleep(1500);
    const after = layouts();
    const b = before.split('\n');
    const a = after.split('\n');
    const changed = [];
    for (let i = 0; i < Math.max(b.length, a.length); i += 1) {
      if (b[i] !== a[i]) changed.push({ window: i, before: b[i], after: a[i] });
    }
    const rec = { tag, pause_ms: pauseMs, before, after, results, changed_windows: changed };
    out.trials.push(rec);
    return rec;
  });
}

(async () => {
  // Trial 1: both select a different window, then apply a layout the other
  // window does not already have.
  const t1 = await concurrentTrial(
    'two clients, distinct targets, concurrent',
    S + ':0', 'main-horizontal',
    S + ':1', 'tiled',
    700,
  );

  // Trial 2: same but serialised by a long pause, as a control for "did the
  // concurrency matter or would this happen anyway".
  const t2 = await concurrentTrial(
    'two clients, distinct targets, long pause',
    S + ':0', 'main-horizontal',
    S + ':1', 'tiled',
    2500,
  );

  const landing = (rec) => rec.changed_windows.map((w) => w.window).sort();
  out.verdict = {
    concurrent_landed: landing(t1),
    serialised_landed: landing(t2),
    // The decision-relevant question: did both clients get their own window, or
    // did they collide on one because `active_idx` is global server state?
    both_got_their_own_window: JSON.stringify(landing(t1)) === JSON.stringify([0, 1]),
    collided_on_one_window: landing(t1).length === 1,
    // If concurrency and serialisation give the same answer, the trial is not
    // measuring concurrency at all and the verdict should not be read as one.
    concurrency_changed_the_outcome: JSON.stringify(landing(t1)) !== JSON.stringify(landing(t2)),
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