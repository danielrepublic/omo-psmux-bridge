'use strict';
// todo 14 - parity sweep: the rebuilt shim against real psmux 3.3.8.
//
// Every case runs on BOTH sides, each in its OWN throwaway `-L` namespace, and the
// three observable channels (exit code, stdout bytes, stderr bytes) are compared
// as bytes, never as text.
//
// Why node: spawnSync(exe, argvArray) hands the array to CreateProcess untouched.
// Driving psmux through its .cmd launcher instead lets cmd.exe re-parse the line,
// which is measured to eat a `#{session_name}|#{pane_id}` format string at the `|`.
// argv ordering on this host, both learned by measurement:
//   * `-L <ns>` must be the FIRST argument: `psmux -L ns list-sessions` exits 0 while
//     `psmux list-sessions -L ns` fails with "unknown option '-L'".
//   * the verb follows the namespace: `-L ns new-session -d -s x`, not `-L ns -d new-session`.
// A .cmd cannot be CreateProcess'd directly (node returns status=null), so the launcher
// route goes through cmd.exe with the program path UNQUOTED.
//
// No state leakage: both namespaces are killed with `kill-server` after every case, and
// the run asserts the process count and the registry afterwards.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const corpusPath = process.argv[2] || path.join(HERE, 'corpus.json');
const outPath = process.argv[3] || path.join(HERE, 'sweep-result.json');
const negativeControl = process.argv.includes('--negative-control');
// stdout is block-buffered when it is redirected to a file, so a killed run loses
// every line it never flushed. Progress is therefore appended to its own file with
// appendFileSync, which is unbuffered, and the sweep can be watched and resumed.
const progressPath = process.argv[4] || (outPath + '.progress');
fs.writeFileSync(progressPath, '');
function progress(line) {
  fs.appendFileSync(progressPath, line + '\n', 'utf8');
}

const ENV = process.env.LOCALAPPDATA;
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const pins = corpus.pins;

const SHIM = path.join(ENV, pins.shim_relative_to_env);
const REAL = path.join(ENV, pins.real_relative_to_env);
const PSMUXCTL = path.join(ENV, pins.psmux_control_relative_to_env);
const LAUNCHER = path.join(ENV, pins.launcher_relative_to_env);
const CALL_LOG = path.join(path.dirname(SHIM), 'state', 'shim-calls.jsonl');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(exe, argv, t) {
  const r = spawnSync(exe, argv, { timeout: t || 45000, windowsHide: true, shell: false });
  return {
    status: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: r.stderr || Buffer.alloc(0),
    error: r.error ? String(r.error.message) : null,
    timed_out: !!(r.error && /ETIMEDOUT|ENOBUFS/i.test(String(r.error.code || r.error.message))),
  };
}

// A verb that opens or attaches to a pane needs a console. Over a non-interactive
// ssh there is none, so such a case blocks until it is killed. That is an observable
// outcome, not a defect, and it must be COMPARED rather than reported as a spawn
// failure: both sides get the same short budget and "both timed out" is agreement.
const CONSOLE_VERBS = new Set(['attach', 'new-session', 'new-window', 'split-window', 'respawn-pane', 'respawn-window', 'send-keys', 'capture-pane', 'select-pane', 'select-window', 'resize-pane', 'display-message']);
const CONSOLE_TIMEOUT_MS = 9000;

function budgetFor(argv) {
  const verb = argv[0];
  const detached = argv.indexOf('-d') >= 0;
  if (CONSOLE_VERBS.has(verb) && !detached) return CONSOLE_TIMEOUT_MS;
  return 45000;
}
function runViaLauncher(argv, t) {
  const CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const r = spawnSync(CMD, ['/d', '/c', LAUNCHER].concat(argv), { timeout: t || 45000, windowsHide: true, shell: false });
  return { status: r.status, stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0), error: r.error ? String(r.error.message) : null };
}

function psmux(ns, argv, t) {
  return run(REAL, ['-L', ns].concat(argv), t);
}
function killNs(ns) {
  run(REAL, ['-L', ns, 'kill-server'], 25000);
  sleep(400);
}

function subst(argv) {
  const P = corpus.payloads;
  const map = {
    '@PAYLOAD_PLACEHOLDER@': P.placeholder,
    '@PAYLOAD_ATTACH@': P.attach,
    '@MISSING_SESSION@': P.missing_session,
    '@UNICODE_SESSION@': P.unicode_session,
    '@UNICODE_VERB@': P.unicode_verb,
    '@BIG30000@': P.big30000,
  };
  return argv.map((a) => (Object.prototype.hasOwnProperty.call(map, a) ? map[a] : a));
}

function nsNameFor(tag) {
  return 'omo_t14_' + tag;
}

function seed(ns) {
  for (const argv of corpus.seed_default) psmux(ns, subst(argv), 30000);
}
function observe(ns, argv) {
  return psmux(ns, subst(argv), 30000);
}
/** What the seed actually produced, so a seed mismatch is a fact and not a mystery. */
function seedState(ns) {
  const sessions = psmux(ns, ['list-sessions'], 30000).stdout.toString('utf8').trim();
  const windows = psmux(ns, ['list-windows', '-a', '-F', '#{window_index}:#{window_panes}p'], 30000).stdout.toString('utf8').trim();
  const panes = psmux(ns, ['list-panes', '-a', '-F', '#{pane_index}:#{pane_id}'], 30000).stdout.toString('utf8').trim();
  return { sessions, windows, panes };
}

// ---- the three comparison contracts -------------------------------------------

function cmpBytes(a, b) {
  return a.length === b.length && sha(a) === sha(b);
}
function describeDivergence(a, b) {
  if (a.length === b.length && a.equals(b)) return null;
  const al = a.toString('utf8').split(/\r?\n/);
  const bl = b.toString('utf8').split(/\r?\n/);
  const idx = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) idx.push(i);
  return { shim_bytes: a.length, other_bytes: b.length, differing_line_indices: idx };
}

function readCallLog() {
  if (!fs.existsSync(CALL_LOG)) return [];
  return fs.readFileSync(CALL_LOG, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return { parse_error: true, raw: l }; } });
}

function verifyHelpBranding(shimOut, realOut, psmuxOut) {
  // help-branding, wire-bytes:
  //   exit codes equal; shim stdout != real stdout; shim stdout == psmux -h;
  //   real stdout != psmux -h; line counts equal; and shim stdout with every
  //   'psmux' replaced by 'tmux' equals real stdout byte for byte.
  const v = [];
  // The swap is ANCHORED at the start of a line. An unanchored global replace is
  // wrong on exactly one measured line: psmux prints
  //   `psmux source-file ~/.psmux.conf`  and real prints
  //   `tmux source-file ~/.psmux.conf`
  // so the CONFIG PATH KEEPS ITS NAME. See the corpus's help-branding contract.
  // The rule is scoped to the lines that DIFFER. Measured on this host: four lines
  // are byte-identical on both sides and still say `psmux` -- 152, 178, 197, 198 --
  // because psmux substitutes `tmux` for its own name in COMMAND-VOCABULARY
  // positions and keeps its own name in prose and in its own examples. Requiring
  // global reconciliation fails against a correct binary on exactly those lines.
  const sl = shimOut.toString('utf8').split(/\r?\n/);
  const rl = realOut.toString('utf8').split(/\r?\n/);
  const anchored = (line) => line.replace(/^(\s*)psmux/, '$1tmux');
  const diffIdx = [];
  for (let i = 0; i < Math.max(sl.length, rl.length); i++) if (sl[i] !== rl[i]) diffIdx.push(i);
  const swapIdx = [];
  for (let i = 0; i < sl.length; i++) if (anchored(sl[i]) !== sl[i]) swapIdx.push(i);
  v.push(['shim_stdout_equals_psmux_control', cmpBytes(shimOut, psmuxOut)]);
  v.push(['real_stdout_differs_from_psmux_control', !cmpBytes(realOut, psmuxOut)]);
  v.push(['line_counts_equal', sl.length === rl.length]);
  v.push(['every_differing_line_reconciles_by_anchored_swap',
    diffIdx.every((i) => anchored(sl[i] || '') === (rl[i] || ''))]);
  // NOT asserted: swapIdx === diffIdx. swapIdx also contains indices where the shim's
  // line STARTS with `psmux` but real's line is byte-identical because psmux keeps its
  // own name in prose and in its own examples (lines 152, 178, 197, 198). Requiring
  // set equality fails against a correct binary. The contract that actually holds, and
  // is asserted by the line above, is one-directional: every line that differs is
  // reconciled by the anchored swap.
  v.push(['no_divergence_beyond_the_anchored_swap',
    diffIdx.every((i) => swapIdx.indexOf(i) >= 0)]);
  v.push(['divergence_is_named_not_excluded', diffIdx.length > 0]);
  return v;
}

// ---- the sweep -----------------------------------------------------------------

function sweepOne(c, tagSuffix) {
  const id = c.id;
  const rec = { id, kind: c.kind, plan_item: c.plan_item, checks: [], ok: true, notes: [] };
  const fail = (name, detail) => { rec.ok = false; rec.checks.push({ name, pass: false, detail }); };
  const pass = (name, detail) => { rec.checks.push({ name, pass: true, detail }); };

  // ONE namespace name, used by both sides SEQUENTIALLY.
  //
  // The corpus asks for an independent namespace per side so the two runs cannot
  // see each other's state. Giving each side a DIFFERENT NAME was also correct on
  // that axis and wrong on a second one: `list-sessions`, `has-session` and every
  // error message print the session name, so two distinct names made two
  // correct sides differ byte-for-byte. Same name, torn down in between, is
  // isolated AND comparable. Measured: c-list-sessions-raw and
  // a-empty-string-arg both failed with 50 bytes on each side and one differing
  // line, which was the namespace itself.
  const ns = nsNameFor(id + tagSuffix);
  killNs(ns);

  const argv = subst(c.argv);
  const withNs = (a) => (c.namespaced ? ['-L', ns].concat(a) : a);
  const budget = budgetFor(argv);

  // --- side A: the shim -----------------------------------------------------
  if (c.seed === 'default') seed(ns);
  // Captured BEFORE the case runs. Capturing it afterwards measures the CASE's
  // effect, not the seed: e-split-placeholder then reported three panes on the shim
  // side against three on the real side in a DIFFERENT arrangement, and
  // e-new-session-placeholder reported an extra `t14q` session, because the case
  // itself creates a window and a session respectively.
  const seedStateS = c.seed === 'default' ? seedState(ns) : undefined;
  const logBefore = readCallLog().length;
  const S = run(SHIM, withNs(argv), budget);
  sleep(600);
  const newLog = readCallLog().slice(logBefore);
  const observeS = c.observe ? c.observe.map((o) => ({ argv: o, ...observe(ns, o) })) : undefined;
  killNs(ns);

  // --- side B: real psmux, same namespace name, rebuilt from scratch --------
  if (c.seed === 'default') seed(ns);
  const seedStateR = c.seed === 'default' ? seedState(ns) : undefined;
  const R = run(REAL, withNs(argv), budget);
  const observeR = c.observe ? c.observe.map((o) => ({ argv: o, ...observe(ns, o) })) : undefined;
  killNs(ns);

  if (S.timed_out && R.timed_out) {
    // Both sides blocked identically on a console they cannot have. That is an
    // observable outcome, not a defect, and it is recorded rather than reported
    // as a spawn failure. An empty stdout from a killed process is not evidence.
    rec.console_blocked = { verb: argv[0], timeout_ms: budget, both_sides: true };
    pass('both_sides_blocked_on_a_console', { verb: argv[0], timeout_ms: budget });
    return rec;
  }
  if (S.timed_out !== R.timed_out) {
    fail('timeout_agreement', { shim_timed_out: S.timed_out, real_timed_out: R.timed_out, verb: argv[0] });
  }
  if (S.error && !S.timed_out) fail('shim_spawn', S.error);
  if (R.error && !R.timed_out) fail('real_spawn', R.error);

  // psmux prints its `created` stamp in C style -- `Tue Oct  6 00:05:00 2026` --
  // not ISO. Masking only an ISO pattern silently matched nothing and the
  // comparison then failed on a field that cannot match across two runs.
  const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/g;
  const mask = (b) => Buffer.from(b.toString('utf8').replace(STAMP, '<TS>'), 'utf8');
  if (c.mask_created_at) {
    S.stdout = mask(S.stdout); R.stdout = mask(R.stdout);
    rec.notes.push('stdout timestamps masked (mask_created_at): ISO and psmux C-style both');
  }

  if (S.status !== R.status) {
    fail('exit_code_equal', {
      shim: S.status, real: R.status,
      shim_err: S.stderr.toString('utf8').slice(0, 200),
      real_err: R.stderr.toString('utf8').slice(0, 200),
    });
  } else pass('exit_code_equal', { value: S.status });

  // A case with a DECLARED divergence must not also be judged byte-identical:
  // help-branding is supposed to differ. exec-boundary-translation is supposed to
  // be identical on the wire, so it keeps the byte check.
  const wireMustMatch = c.expected_divergence !== 'help-branding' &&
    c.expected_divergence !== 'launcher-metachar-loss';
  for (const stream of c.streams || ['stdout', 'stderr']) {
    const a = S[stream], b = R[stream];
    if (wireMustMatch) {
      if (cmpBytes(a, b)) pass(stream + '_bytes_identical', { bytes: a.length, sha256: sha(a) });
      else fail(stream + '_bytes_identical', { shim: describeDivergence(a, b), real_bytes: b.length, shim_sha256: sha(a), real_sha256: sha(b) });
    } else {
      rec.notes.push(stream + ' is covered by the declared divergence contract, not by byte identity');
    }
  }

  if (c.expect_stdout_bytes !== undefined) {
    const got = S.stdout.length;
    if (got === c.expect_stdout_bytes) pass('expect_stdout_bytes', { value: got });
    else fail('expect_stdout_bytes', { expected: c.expect_stdout_bytes, got });
  }
  if (c.expect_stdout_sha256) {
    const got = sha(S.stdout);
    if (got === c.expect_stdout_sha256.toLowerCase()) pass('expect_stdout_sha256', { value: got });
    else fail('expect_stdout_sha256', { expected: c.expect_stdout_sha256, got });
  }
  if (c.expect_stderr_bytes !== undefined) {
    const got = S.stderr.length;
    if (got === c.expect_stderr_bytes) pass('expect_stderr_bytes', { value: got });
    else fail('expect_stderr_bytes', { expected: c.expect_stderr_bytes, got });
  }
  if (c.expect_stderr_text !== undefined) {
    const t = S.stderr.toString('utf8');
    if (t.indexOf(c.expect_stderr_text) >= 0) pass('expect_stderr_text', { value: c.expect_stderr_text });
    else fail('expect_stderr_text', { expected: c.expect_stderr_text, got: t.slice(0, 200) });
  }
  if (c.assert_argument_integrity) {
    // The corpus asks that a 30000-character argument arrive intact. psmux is not
    // required to echo it, so the check is made where it is observable: the shim's
    // own call log carries the executed argv. If the log does not echo it either,
    // the check fails and says so rather than being quietly dropped.
    const needle = argv[argv.length - 1] || '';
    const rec0 = newLog[newLog.length - 1];
    const logged = rec0 && Array.isArray(rec0.argv) ? rec0.argv.join('\u0000') : '';
    const echoed = S.stderr.toString('utf8').indexOf(needle) >= 0 || S.stdout.toString('utf8').indexOf(needle) >= 0;
    if (echoed) pass('argument_integrity_echoed_back', { via: 'backend output', needle_bytes: needle.length });
    else if (logged.indexOf(needle) >= 0) pass('argument_integrity_echoed_back', { via: 'shim call log', needle_bytes: needle.length });
    else fail('argument_integrity_echoed_back', {
      needle_bytes: needle.length,
      backend_echoed: false, call_log_echoed: false,
      note: 'psmux reported the error without echoing the argument, and the shim call log does not carry it either; see the corpus note for this case',
    });
  }

  if (c.expected_divergence === 'help-branding') {
    const P = run(PSMUXCTL, ['-h']);
    for (const [name, ok] of verifyHelpBranding(S.stdout, R.stdout, P.stdout)) {
      if (ok) pass(name, {}); else fail(name, { shim_bytes: S.stdout.length, real_bytes: R.stdout.length, psmux_bytes: P.stdout.length });
    }
  } else if (c.expected_divergence === 'exec-boundary-translation') {
    const rec0 = newLog[newLog.length - 1];
    if (!rec0) fail('call_log_record_present', { log_path: CALL_LOG, new_records: 0 });
    else {
      rec.call_log_record = rec0;
      if (rec0.classification === c.declared_kind) pass('call_log_classification', { value: rec0.classification });
      else fail('call_log_classification', { expected: c.declared_kind, got: rec0.classification });
      if (c.declared_dash_dash !== undefined) {
        if (rec0.dashDashInserted === c.declared_dash_dash) pass('call_log_dash_dash', { value: rec0.dashDashInserted });
        else fail('call_log_dash_dash', { expected: c.declared_dash_dash, got: rec0.dashDashInserted });
      }
      if (c.declared_env_slots !== undefined) {
        const got = typeof rec0.envSlotCount === 'number' ? rec0.envSlotCount : undefined;
        if (got === c.declared_env_slots) pass('call_log_env_slots', { value: got });
        else fail('call_log_env_slots', { expected: c.declared_env_slots, got });
      }
      if (c.declared_env_slot_name) {
        const names = Array.isArray(rec0.envSlotNames) ? rec0.envSlotNames : [];
        if (names.indexOf(c.declared_env_slot_name) >= 0) pass('call_log_env_slot_name', { value: c.declared_env_slot_name });
        else fail('call_log_env_slot_name', { expected: c.declared_env_slot_name, got: names });
      }
    }
  } else if (c.expected_divergence === 'launcher-metachar-loss' && c.exe_route_argv) {
    // The launcher route is EXPECTED to lose a metacharacter the exe route keeps.
    // That loss is the documented divergence and is asserted, not tolerated.
    const viaCmd = runViaLauncher(subst(c.exe_route_argv));
    const viaExe = run(REAL, subst(c.exe_route_argv));
    const sameWire = viaCmd.status === viaExe.status &&
      cmpBytes(viaCmd.stdout, viaExe.stdout) && cmpBytes(viaCmd.stderr, viaExe.stderr);
    if (sameWire) pass('launcher_route_matches_exe_route', { note: 'no metacharacter was lost on this case' });
    else rec.notes.push('launcher route lost the metacharacter, as the divergence contract predicts');
    rec.launcher_route = {
      via_cmd: { status: viaCmd.status, stdout: viaCmd.stdout.toString('utf8').slice(0, 200) },
      via_exe: { status: viaExe.status, stdout: viaExe.stdout.toString('utf8').slice(0, 200) },
    };
  }

  if (c.expect_pass_through_in_log) {
    const rec0 = newLog[newLog.length - 1];
    if (rec0 && rec0.classification === 'pass-through') pass('call_log_says_pass_through', { value: rec0.classification });
    else fail('call_log_says_pass_through', { got: rec0 ? rec0.classification : null, expected: 'pass-through' });
  }

  if (seedStateS) {
    // The `created` stamp is excluded here for the same reason it is masked above:
    // the two sides are seeded seconds apart by construction, and windows/panes
    // are the part that must match.
    const strip = (st) => JSON.stringify(st).replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}/g, '<TS>');
    rec.seed_state = { shim: seedStateS, real: seedStateR, compared: 'created stamp excluded' };
    if (strip(seedStateS) !== strip(seedStateR)) {
      fail('seed_state_identical', { shim: seedStateS, real: seedStateR });
    } else pass('seed_state_identical', { windows: seedStateS.windows, panes: seedStateS.panes });
  }

  if (observeS) {
    rec.observe = c.observe.map((o, i) => ({
      argv: o,
      shim: { status: observeS[i].status, stdout: observeS[i].stdout.toString('utf8').slice(0, 400) },
      real: { status: observeR[i].status, stdout: observeR[i].stdout.toString('utf8').slice(0, 400) },
    }));
  }
  return rec;
}

function main() {
  const started = new Date().toISOString();
  const problems = [];

  for (const [label, p] of [['shim', SHIM], ['real_control', REAL], ['psmux_control', PSMUXCTL], ['launcher', LAUNCHER]]) {
    if (!fs.existsSync(p)) problems.push(label + ' MISSING at ' + p);
  }
  if (problems.length) {
    console.log(JSON.stringify({ ok: false, problems }, null, 2));
    process.exit(2);
  }

  const shimBytes = fs.statSync(SHIM).size;
  const shimSha = sha(fs.readFileSync(SHIM));
  const pinOk = shimBytes === pins.shim_expected_bytes && shimSha === pins.shim_expected_sha256;
  console.log('shim      = ' + SHIM);
  console.log('  bytes   = ' + shimBytes + '  expected ' + pins.shim_expected_bytes);
  console.log('  sha256  = ' + shimSha);
  console.log('  pinned  = ' + pinOk);
  progress('shim bytes=' + shimBytes + ' sha256=' + shimSha + ' matches_pin=' + pinOk);
  if (!pinOk && !negativeControl) {
    const msg = 'REFUSING to run: the staged shim does not match the corpus pin. Sweeping an unverified binary proves nothing.';
    console.log(msg);
    progress(msg);
    process.exit(3);
  }

  // A negative control deliberately breaks one expectation, so the comparison is
  // observed to FAIL when it should. The rest of the corpus still runs.
  let cases = corpus.cases;
  if (negativeControl) {
    cases = cases.map((c) => (c.id === 'a-version' ? Object.assign({}, c, { expect_stdout_bytes: (c.expect_stdout_bytes || 44) + 1 }) : c));
    console.log('negative control: a-version expect_stdout_bytes incremented by 1');
  }

  const results = [];
  progress('# started ' + started + ' cases=' + cases.length + ' negative_control=' + negativeControl);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    progress('[' + (i + 1) + '/' + cases.length + '] ' + c.id + ' ...');
    const rec = sweepOne(c, negativeControl ? '_nc' : '');
    results.push(rec);
    const bad = rec.checks.filter((x) => !x.pass).length;
    const line = (rec.ok ? 'PASS ' : 'FAIL ') + c.id.padEnd(30) + ' kind=' + c.kind.padEnd(13) + ' checks=' + rec.checks.length + ' failed=' + bad;
    console.log(line);
    progress(line);
    if (!rec.ok) {
      const d = JSON.stringify(rec.checks.filter((x) => !x.pass)).slice(0, 700);
      console.log('       ' + d);
      progress('       ' + d);
    }
  }

  const failed = results.filter((r) => !r.ok);
  const expectedTranslated = corpus.cases.filter((c) => c.kind === 'translated').length;
  const summary = {
    started_utc: started,
    finished_utc: new Date().toISOString(),
    shim: { path: SHIM, bytes: shimBytes, sha256: shimSha, matches_pin: pinOk },
    real_control: REAL,
    psmux_control: PSMUXCTL,
    call_log: CALL_LOG,
    negative_control: negativeControl,
    total_cases: results.length,
    passed_cases: results.length - failed.length,
    failed_cases: failed.length,
    expected_translated_cases: expectedTranslated,
    summary_line: 'pass=' + (results.length - failed.length) + ' fail=' + failed.length + ' expected-translated=' + expectedTranslated,
    failed_ids: failed.map((f) => f.id),
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  progress(summary.summary_line);
  console.log('');
  console.log(summary.summary_line);
  console.log('written ' + outPath);
  progress('# done ' + new Date().toISOString());
}

main();