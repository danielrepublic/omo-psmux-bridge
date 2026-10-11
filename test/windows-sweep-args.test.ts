// Unit tests for scripts/windows/parity/sweep-args.cjs.
//
// sweep.cjs itself cannot load off Windows (it resolves %LOCALAPPDATA% and
// drives psmux at require time), so its argument parsing lives in the
// extracted module under test here. Every test runs on any host.

import { describe, expect, test } from "bun:test";

const sweepArgs = require("../scripts/windows/parity/sweep-args.cjs");

const HERE = "/tmp/here";

describe("parseSweepArgs defaults", () => {
  test("no args resolves all three positional defaults", () => {
    // Given: an empty argv
    // When: parsed
    // Then: corpus/out/progress defaults chain (progress derives from out)
    const parsed = sweepArgs.parseSweepArgs([], HERE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.corpusPath).toBe("/tmp/here/corpus.json");
    expect(parsed.outPath).toBe("/tmp/here/sweep-result.json");
    expect(parsed.progressPath).toBe("/tmp/here/sweep-result.json.progress");
    expect(parsed.negativeControl).toBe(false);
    expect(parsed.allowShimMismatch).toBe(false);
    expect(parsed.help).toBe(false);
  });
});

describe("parseSweepArgs regression: flags are never positional paths", () => {
  test("a flag in the third slot does not become the progress path", () => {
    // Given: the historical invocation `sweep.cjs corpus out --negative-control`
    // When: parsed
    // Then: the flag enables the control AND progress stays derived from out
    const parsed = sweepArgs.parseSweepArgs(
      ["corpus.json", "out.json", "--negative-control"],
      HERE,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.negativeControl).toBe(true);
    expect(parsed.corpusPath).toBe("corpus.json");
    expect(parsed.outPath).toBe("out.json");
    expect(parsed.progressPath).toBe("out.json.progress");
  });

  test("flags are accepted in any position", () => {
    // Given: flags before positionals
    // When: parsed
    // Then: same resolution as flags-last
    const parsed = sweepArgs.parseSweepArgs(
      ["--allow-shim-mismatch", "--run-id", "qa7", "corpus.json"],
      HERE,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.allowShimMismatch).toBe(true);
    expect(parsed.runIdRaw).toBe("qa7");
    expect(parsed.corpusPath).toBe("corpus.json");
  });

  test("an unknown flag is refused, not treated as a path", () => {
    // Given: a misspelled flag
    // When: parsed
    // Then: parse fails naming the flag (caller exits 2)
    const parsed = sweepArgs.parseSweepArgs(["--negativ-control"], HERE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--negativ-control");
  });

  test("--run-id without a value is refused", () => {
    // Given: a dangling --run-id
    // When: parsed
    // Then: parse fails instead of consuming the next flag as the id
    const parsed = sweepArgs.parseSweepArgs(
      ["--run-id", "--negative-control"],
      HERE,
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("run-id and namespace isolation", () => {
  test("explicit run ids survive sanitising", () => {
    // Given: an operator-supplied run id
    // When: resolved with an empty env
    // Then: it is used verbatim (it is already socket-safe)
    expect(sweepArgs.resolveRunId("qa7", {}, 123, 456)).toBe("qa7");
  });

  test("unsafe characters are replaced so the id is socket-safe", () => {
    // Given: a run id with path-hostile characters
    // When: sanitised
    // Then: only [a-z0-9_-] remain
    expect(sweepArgs.sanitizeRunId("a/b\\c:d e")).toBe("a_b_c_d_e");
  });

  test("the default run id embeds pid and time, so two processes differ", () => {
    // Given: no flag and no env
    // When: resolved for two different pids
    // Then: the ids differ (no shared -L namespace across concurrent runs)
    const a = sweepArgs.resolveRunId(null, {}, 111, 222);
    const b = sweepArgs.resolveRunId(null, {}, 333, 222);
    expect(a).not.toBe(b);
  });

  test("the namespace carries the run id before the case tag", () => {
    // Given: a run id and a case tag
    // When: namespaced
    // Then: fixed prefix, run id, then tag (concurrent runs cannot collide)
    expect(sweepArgs.nsNameFor("qa7", "a-version")).toBe("omo_t14_qa7_a-version");
  });

  test("two case tags in one run never collide", () => {
    // Given: one run id, two distinct case tags
    // When: namespaced
    // Then: the names differ, so a case cannot reap another case's seed
    expect(sweepArgs.nsNameFor("qa7", "a-version")).not.toBe(
      sweepArgs.nsNameFor("qa7", "a-help"),
    );
  });
});

// ---------------------------------------------------------------------------
// Verdict logic.
//
// A sweep's exit code is the only thing a CI job or a human looks at, and every
// way it can go quietly green is a way this suite stops proving anything. The
// cases below are the four measured escapes: a corpus that sweeps nothing, a
// negative control that silently does nothing, an artifact written after the
// process already reported success, and a run that observed zero results.
// ---------------------------------------------------------------------------

describe("preflightCases: a sweep of nothing is refused, not reported as a pass", () => {
  test("the real corpus passes preflight", () => {
    // Given: the shipped corpus
    // When: checked
    // Then: ok, so the refusal below is about the empty case and not the corpus
    const corpus = require("../scripts/windows/parity/corpus.json");
    expect(sweepArgs.preflightCases(corpus.cases)).toEqual({ ok: true, problems: [] });
  });

  test("an empty case list is refused", () => {
    // Given: a corpus that declares zero cases
    // When: checked
    // Then: refused, because `pass=0 fail=0` from an empty run reads as success
    const verdict = sweepArgs.preflightCases([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toContain("empty");
  });

  test("a non-array case list is refused rather than iterated", () => {
    // Given: a corpus whose cases field is not a list
    // When: checked
    // Then: refused, not crashed on, and not treated as zero cases
    expect(sweepArgs.preflightCases(undefined).ok).toBe(false);
    expect(sweepArgs.preflightCases({ length: 3 }).ok).toBe(false);
  });
});

describe("applyNegativeControl: the control must actually break something", () => {
  const corpus = require("../scripts/windows/parity/corpus.json");

  test("it increments a-version and names it as the target", () => {
    // Given: the shipped corpus
    // When: the control is applied
    // Then: a-version's expected byte count moves by exactly 1, and `targeted`
    // names it, so a caller can assert the control fired
    const applied = sweepArgs.applyNegativeControl(corpus.cases, true);
    expect(applied.ok).toBe(true);
    expect(applied.targeted).toBe("a-version");
    const before = corpus.cases.find((c: { id: string }) => c.id === "a-version");
    const after = applied.cases.find((c: { id: string }) => c.id === "a-version");
    expect(after.expect_stdout_bytes).toBe(before.expect_stdout_bytes + 1);
  });

  test("it does not mutate the corpus it was given", () => {
    // Given: the corpus object read straight off disk
    // When: the control is applied to it
    // Then: the original is unchanged, or a later real run inherits a broken
    // expectation from a control run
    const before = corpus.cases.find((c: { id: string }) => c.id === "a-version").expect_stdout_bytes;
    sweepArgs.applyNegativeControl(corpus.cases, true);
    expect(corpus.cases.find((c: { id: string }) => c.id === "a-version").expect_stdout_bytes).toBe(before);
  });

  test("every other case is passed through by reference, untouched", () => {
    // Given: the shipped corpus
    // When: the control is applied
    // Then: only a-version is a new object; the rest are the same references
    const applied = sweepArgs.applyNegativeControl(corpus.cases, true);
    for (const original of corpus.cases) {
      if (original.id === "a-version") continue;
      expect(applied.cases.find((c: { id: string }) => c.id === original.id)).toBe(original);
    }
  });

  test("a corpus with no a-version case is refused, not silently un-broken", () => {
    // Given: a corpus renamed away from a-version
    // When: the control is requested
    // Then: refused, because a control that changes nothing would report a
    // healthy run and prove the comparisons work
    const verdict = sweepArgs.applyNegativeControl([{ id: "b-help", kind: "pass-through" }], true);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("a-version");
  });

  test("the control off is an identity, and says it touched nothing", () => {
    // Given: a normal run
    // When: the control is not requested
    // Then: the same cases, and `targeted` null so nothing is claimed
    const applied = sweepArgs.applyNegativeControl(corpus.cases, false);
    expect(applied.ok).toBe(true);
    expect(applied.targeted).toBeNull();
    expect(applied.cases).toBe(corpus.cases);
  });
});

describe("finalizeSweep: the artifact is written, then the exit code is decided", () => {
  test("the artifact is written before the exit code is returned", () => {
    // Given: a run with one failing case and a writer that records when it ran
    // When: finalized
    // Then: exit 1 AND the writer ran, and it saw the failed case
    const events: string[] = [];
    const verdict = sweepArgs.finalizeSweep({
      results: [
        { id: "a-help", ok: true },
        { id: "a-version", ok: false },
      ],
      meta: { expected_translated_cases: 3 },
      writeArtifact: (summary: { failed_ids: string[] }) => {
        events.push(`written:${summary.failed_ids.join(",")}`);
      },
    });
    expect(events).toEqual(["written:a-version"]);
    expect(verdict.artifactWritten).toBe(true);
    expect(verdict.exitCode).toBe(1);
  });

  test("failed cases make the exit code 1", () => {
    // Given: any failing case
    // When: finalized
    // Then: exit 1 (this script used to exit 0 with failures only in the JSON)
    const verdict = sweepArgs.finalizeSweep({
      results: [{ id: "c-list-sessions", ok: false }],
      writeArtifact: () => {},
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.summary.failed_cases).toBe(1);
    expect(verdict.summary.failed_ids).toEqual(["c-list-sessions"]);
  });

  test("a clean run exits 0", () => {
    // Given: every case passed
    // When: finalized
    // Then: exit 0, so the non-vacuity rules below cannot make a real pass fail
    const verdict = sweepArgs.finalizeSweep({
      results: [{ id: "a-help", ok: true }],
      meta: { expected_translated_cases: 0 },
      writeArtifact: () => {},
    });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.summary.summary_line).toBe("pass=1 fail=0 expected-translated=0");
  });

  test("zero results is NOT green, even though failed_cases is 0", () => {
    // Given: a run that produced no result records at all
    // When: finalized
    // Then: exit 1. `pass=0 fail=0` is what a clean sweep prints, so without this
    // the summary line and the exit code would both claim health for a sweep
    // that observed nothing.
    const verdict = sweepArgs.finalizeSweep({ results: [], writeArtifact: () => {} });
    expect(verdict.summary.failed_cases).toBe(0);
    expect(verdict.vacuous).toBe(true);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.summary.summary_line).toContain("VACUOUS");
  });

  test("a missing results array is treated as vacuous, not as a pass", () => {
    // Given: the caller forgot to pass results
    // When: finalized
    // Then: still not green (defence in depth behind preflightCases)
    expect(sweepArgs.finalizeSweep({ writeArtifact: () => {} }).exitCode).toBe(1);
  });

  test("meta reaches the artifact alongside the counts", () => {
    // Given: run metadata the artifact has always carried
    // When: finalized
    // Then: it is merged in, so extracting the verdict did not drop the
    // provenance fields (pin, override, run id) the artifact is the record of
    const verdict = sweepArgs.finalizeSweep({
      results: [{ id: "a-help", ok: true }],
      meta: {
        run_id: "qa7",
        shim: { matches_pin: false, allow_shim_mismatch: true, pin_override: true },
        expected_translated_cases: 4,
      },
      writeArtifact: () => {},
    });
    expect(verdict.summary.run_id).toBe("qa7");
    expect(verdict.summary.shim.pin_override).toBe(true);
    expect(verdict.summary.expected_translated_cases).toBe(4);
    expect(verdict.summary.summary_line).toBe("pass=1 fail=0 expected-translated=4");
  });
});
