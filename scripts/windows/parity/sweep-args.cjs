'use strict';
// Argument parsing for sweep.cjs, extracted so it can be unit-tested on any
// host. sweep.cjs itself cannot load off Windows: it resolves %LOCALAPPDATA%
// and drives psmux at the top level, so no Linux test can require it.
//
// Calling convention (flags may appear anywhere; positionals keep their order):
//   bun sweep.cjs [corpusPath] [outPath] [progressPath] [flags]
// Flags (never positional):
//   --negative-control     deliberately break one expectation (control run)
//   --allow-shim-mismatch  sweep the current build even when the corpus pin
//                          mismatches; the override is recorded in the artifact
//   --run-id <id>          namespace prefix for this run (default: unique per
//                          process, so two QA runs cannot share an -L namespace)
//   --help, -h             usage, exit 0
//
// Regression this fixes: flags used to be read by bare index, so the 3rd slot
// (argv[4]) became the progress path and `sweep.cjs corpus out
// --negative-control` wrote its progress log into a file literally named
// `--negative-control` while also failing to enable the control.

const USAGE = [
  'usage: sweep.cjs [corpusPath] [outPath] [progressPath] [flags]',
  '',
  '  corpusPath, outPath, progressPath are positional and optional.',
  '  flags (anywhere, never positional):',
  '    --negative-control     break one expectation on purpose (control run)',
  '    --allow-shim-mismatch  run despite a corpus pin mismatch; recorded',
  '    --run-id <id>          per-run -L namespace prefix (default: unique)',
  '    --help, -h             print this and exit 0',
].join('\n');

function parseSweepArgs(argv, here) {
  const positionals = [];
  let negativeControl = false;
  let allowShimMismatch = false;
  let help = false;
  let runIdRaw = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run-id') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        return { ok: false, error: '--run-id needs a value' };
      }
      runIdRaw = v;
      i += 1;
      continue;
    }
    if (a.startsWith('--run-id=')) {
      const v = a.slice('--run-id='.length);
      if (!v) {
        return { ok: false, error: '--run-id= needs a non-empty value' };
      }
      runIdRaw = v;
      continue;
    }
    if (a === '--negative-control') { negativeControl = true; continue; }
    if (a === '--allow-shim-mismatch') { allowShimMismatch = true; continue; }
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a.startsWith('-') && a.length > 1) {
      return { ok: false, error: 'unknown flag: ' + a };
    }
    positionals.push(a);
  }
  if (positionals.length > 3) {
    return { ok: false, error: 'too many positional arguments (max 3): ' + positionals.slice(3).join(' ') };
  }
  const outPath = positionals[1] || (here + '/sweep-result.json');
  return {
    ok: true,
    corpusPath: positionals[0] || (here + '/corpus.json'),
    outPath,
    progressPath: positionals[2] || (outPath + '.progress'),
    negativeControl,
    allowShimMismatch,
    help,
    runIdRaw,
  };
}

// Socket-safe and short: psmux -L names become socket paths, so only
// [a-z0-9_-] survive and the whole id is capped.
function sanitizeRunId(value) {
  const clean = String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return clean || 'run';
}

function resolveRunId(runIdRaw, env, pid, now) {
  const fromEnv = env && typeof env.OMO_SWEEP_RUN_ID === 'string' ? env.OMO_SWEEP_RUN_ID : '';
  const raw = runIdRaw || fromEnv || (Number(pid).toString(36) + '-' + Number(now).toString(36));
  return sanitizeRunId(raw);
}

// Per-run unique -L namespace. The old name was 'omo_t14_' + tag: fixed per
// case, so two QA runs on one host shared every namespace and each case's
// preemptive kill-server could reap the other run's seed mid-trial.
function nsNameFor(runId, tag) {
  return 'omo_t14_' + runId + '_' + tag;
}

// ---------------------------------------------------------------------------
// Verdict logic, extracted for the same reason the parser was: the whole of it is
// a claim about whether a sweep proved anything, and a claim that cannot be
// tested off Windows is a claim nobody can trust. Each function here is total
// and side-effect free except `finalizeSweep`, whose ONE effect is writing the
// artifact, and whose ORDERING is the contract.
// ---------------------------------------------------------------------------

/** The case a negative control breaks. Named here so the flag and the corpus
 *  cannot drift apart: the control increments this case's expected stdout byte
 *  count by one, which the byte comparison then fails. */
const NEGATIVE_CONTROL_TARGET = 'a-version';

/** A corpus with no cases sweeps nothing. Running it would print
 *  `pass=0 fail=0` and exit 0, which reads as a clean bill of health for a sweep
 *  that observed nothing at all. Refused before the first spawn instead. */
function preflightCases(cases) {
  if (!Array.isArray(cases)) return { ok: false, problems: ['corpus.cases is not an array'] };
  if (cases.length === 0) return { ok: false, problems: ['corpus.cases is empty: nothing would be swept'] };
  return { ok: true, problems: [] };
}

/**
 * Break one expectation on purpose, for a control run.
 *
 * Non-mutating: the corpus is read straight from disk and a control run must not
 * be able to leave the corpus, or a later real run, holding a broken
 * expectation. `targeted` names the case that actually moved, so a caller can
 * assert the control did something instead of trusting that it did.
 */
function applyNegativeControl(cases, enabled) {
  if (!enabled) return { ok: true, cases, targeted: null };
  if (!Array.isArray(cases) || !cases.some((c) => c && c.id === NEGATIVE_CONTROL_TARGET)) {
    return { ok: false, error: 'negative control needs a case with id ' + NEGATIVE_CONTROL_TARGET };
  }
  let targeted = null;
  const next = cases.map((c) => {
    if (!c || c.id !== NEGATIVE_CONTROL_TARGET) return c;
    targeted = c.id;
    const base = typeof c.expect_stdout_bytes === 'number' ? c.expect_stdout_bytes : 44;
    return Object.assign({}, c, { expect_stdout_bytes: base + 1 });
  });
  return { ok: true, cases: next, targeted };
}

/**
 * Write the artifact, THEN decide the exit code.
 *
 * The ordering is the whole point and is why this is one function rather than two
 * lines in `main`: a sweep that disagrees with its control has to leave its
 * evidence on disk AND fail the process, and doing it in the wrong order loses one
 * of the two. A test asserts both by giving this a writer that records when it
 * ran.
 *
 * Zero observations is a failure, not a pass: `pass=0 fail=0` from an empty run
 * list is the same string a genuinely clean sweep would print for a corpus of
 * nothing.
 */
function finalizeSweep(options) {
  const meta = (options && options.meta) || {};
  const list = options && Array.isArray(options.results) ? options.results : [];
  const failed = list.filter((r) => r && r.ok === false);
  const vacuous = list.length === 0;
  const summary = Object.assign({
    total_cases: list.length,
    passed_cases: list.length - failed.length,
    failed_cases: failed.length,
    failed_ids: failed.map((f) => f.id),
    vacuous,
    results: list,
  }, meta);
  const translated =
    typeof meta.expected_translated_cases === 'number' ? ' expected-translated=' + meta.expected_translated_cases : '';
  summary.summary_line =
    'pass=' + summary.passed_cases + ' fail=' + summary.failed_cases + translated + (vacuous ? ' VACUOUS' : '');

  let artifactWritten = false;
  if (typeof options.writeArtifact === 'function') {
    options.writeArtifact(summary);
    artifactWritten = true;
  }
  const exitCode = (vacuous || failed.length > 0) ? 1 : 0;
  return { exitCode, summary, failed, vacuous, artifactWritten };
}

module.exports = {
  USAGE,
  parseSweepArgs,
  sanitizeRunId,
  resolveRunId,
  nsNameFor,
  NEGATIVE_CONTROL_TARGET,
  preflightCases,
  applyNegativeControl,
  finalizeSweep,
};
