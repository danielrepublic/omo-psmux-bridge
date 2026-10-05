// panel descriptor and credential handling.
//
// Written FIRST, against src/translate.ts's HELPER_CONTRACT (which is where the
// helper-invocation contract was settled, and which this module EXTENDS rather
// than replaces) and against CONTRACT.md sections 2.2, 7.2 and 10.
//
// What is pinned here, in order of importance:
//
//   1. THE CREDENTIAL PROPERTY. OmO puts `OPENCODE_SERVER_PASSWORD=<value>` in
//      argv (index.js:8336) and that is out of scope to fix. The bridge must not
//      ADD a second exposure: no NAME=VALUE pair whose name looks sensitive may
//      appear in any generated argv element, in any encoding, and no trace line
//      or log projection may carry the value. The detector used for that is
//      written independently HERE, and it has a positive control, so the
//      assertion cannot pass vacuously.
//   2. Delivery order. The process environment is the mechanism. A restricted-
//      ACL file under the user's profile is the documented FALLBACK, used only
//      when the numbered slots are absent from the helper's own process
//      environment - which is the normal case on the respawn path, because
//      psmux's long-lived server owns the pane's environment.
//   3. A fallback file is read once, deleted immediately, and the deletion is
//      VERIFIED. A failed verification is a failure, not a warning.
//   4. Consume-once. A descriptor names exactly one pane. Consuming it twice
//      fails the second time and does not re-execute the command.
//   5. `opencode attach` retries ONCE and only once, after a bounded wait, and
//      never for any other command. Two failures stop.
//   6. Nothing anywhere logs a value.
//
// The PowerShell helper (runtime/Start-PaneFromDescriptor.ps1) performs the I/O.
// Every DECISION it makes is made here and is therefore testable on any host.

import { describe, expect, test } from "bun:test";
import type { AuthEnvArg } from "../src/grammar";
import {
  DESCRIPTOR_CONTRACT,
  applySlotAssignment,
  attachRetryPolicy,
  claimDescriptor,
  createMemoryDescriptorStore,
  isAttachCommand,
  loadAssignments,
  newCorrelationId,
  nextAttachAction,
  parseSlotPayload,
  planDescriptor,
  redactArgv,
  serializeSlotPayload,
  simulateAttach,
  traceLine,
} from "../src/descriptor";
import type { MemoryDescriptorStore, PanelDescriptor } from "../src/descriptor";
import { HELPER_CONTRACT, parseHelperCommandLine, translate } from "../src/translate";
import type { Translation } from "../src/translate";

// ---------------------------------------------------------------------------
// Fixtures - byte-identical in shape to test/translate.test.ts
// ---------------------------------------------------------------------------

const BODY_HEAD = "printf '%s\\n%s\\n' \\\"OMO subagent pane ready: ";
const BODY_TAIL = "\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done";
const PH_PLAIN = `/bin/sh -c "${BODY_HEAD}explore the tmux grammar module${BODY_TAIL}"`;
const AT_PLAIN =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'\"";

// The sentinel is a value that must never appear in argv, on disk or in a log.
// It contains the substring SECRET so it also trips the sensitive-name detector
// if a future change ever put a NAME in argv.
const SENTINEL = "SENTINEL_SECRET_a1b2c3";

const PSMUX_PATH = "C:\\Users\\Test User\\AppData\\Local\\psmux\\tmux.exe";
const HELPER_PATH =
  "C:\\Users\\Test User\\AppData\\Local\\opencode-psmux-bridge\\runtime\\Start-PaneFromDescriptor.ps1";
const BRIDGE_ROOT = "C:\\Users\\Test User\\AppData\\Local\\opencode-psmux-bridge";
const PROFILE_DIR = "C:\\Users\\Test User";

const OPTS = { psmuxPath: PSMUX_PATH, helperPath: HELPER_PATH } as const;

const AUTH_ARGS = [
  "-e",
  `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
  "-e",
  "OPENCODE_SERVER_USERNAME=daniel",
];

function attachTranslation(extraEnvArgs: readonly string[] = AUTH_ARGS): Translation {
  return translate(["respawn-pane", "-k", ...extraEnvArgs, "-t", "%7", AT_PLAIN], OPTS);
}

function placeholderTranslation(): Translation {
  return translate(["split-window", "-h", PH_PLAIN], OPTS);
}

const PLAN_OPTS = {
  bridgeRoot: BRIDGE_ROOT,
  profileDir: PROFILE_DIR,
  correlationId: "corr-0001",
};

function planFor(translation: Translation, overrides: Partial<typeof PLAN_OPTS> = {}): PanelDescriptor {
  const descriptor = planDescriptor(translation, { ...PLAN_OPTS, ...overrides });
  if (descriptor === undefined) throw new Error("expected a descriptor for a helper translation");
  return descriptor;
}

// A deliberately hostile value: an embedded `=`, quotes, a backslash, a newline
// and a trailing space. It must survive the first-`=` split and the file
// round-trip byte-for-byte.
const HOSTILE_VALUE = "a=b 'c\"d\\e\nf  ";

function envWith(descriptor: PanelDescriptor): Record<string, string> {
  const env: Record<string, string> = {};
  for (const slot of descriptor.slots) env[slot.variable] = slot.assignment;
  return env;
}

function storeWithPayload(descriptor: PanelDescriptor): MemoryDescriptorStore {
  const store = createMemoryDescriptorStore();
  store.write(descriptor.descriptorFilePath, serializeSlotPayload(descriptor.slots).body);
  return store;
}

function traceEventFor() {
  return {
    at: "2026-10-05T00:00:00.000Z",
    outcome: "delivered" as const,
    mechanism: "environment" as const,
    descriptorFileUsed: false,
    deleteVerified: true,
    attachWaitMs: 0,
    attachRetries: 0,
    exitCode: 0,
  };
}

function renderTraceLineFor(descriptor: PanelDescriptor): string {
  return JSON.stringify(traceLine(descriptor, traceEventFor()));
}

// ===========================================================================
// 1. THE CREDENTIAL PROPERTY
// ===========================================================================

describe("the credential never reaches argv", () => {
  test("no generated argv element carries a NAME=VALUE pair with a sensitive name", () => {
    for (const translation of [attachTranslation(), placeholderTranslation()]) {
      expect(sensitiveArgvPairsOf(translation.argv)).toEqual([]);
      for (const element of translation.argv) {
        expect(element).not.toMatch(/[A-Za-z0-9_.-]*(PASSWORD|SECRET|TOKEN)[A-Za-z0-9_.-]*\s*=/i);
      }
    }
  });

  test("the sentinel value itself is absent from every generated argv element", () => {
    const translation = attachTranslation();

    for (const element of translation.argv) expect(element).not.toContain(SENTINEL);
    expect(translation.helperCommandLine ?? "").not.toContain(SENTINEL);
    expect(translation.argv.join("\n")).not.toContain(SENTINEL);
  });

  test("the credential lives in exactly one place: the numbered env slots", () => {
    const translation = attachTranslation();

    expect(translation.envSlotCount).toBe(2);
    expect(translation.envSlots[0]?.variable).toBe("OMO_PANE_ENV_0");
    expect(translation.envSlots[0]?.assignment).toBe(`OPENCODE_SERVER_PASSWORD=${SENTINEL}`);
    expect(translation.envSlots[1]?.variable).toBe("OMO_PANE_ENV_1");
    // The `-e` flag itself is never forwarded to psmux.
    expect(translation.argv).not.toContain("-e");
  });

  test("nothing the descriptor exposes to a log carries the value", () => {
    const descriptor = planFor(attachTranslation());

    expect(descriptor.slotNames).toEqual(["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]);
    expect(JSON.stringify(descriptor.slotNames)).not.toContain(SENTINEL);
    expect(descriptor.traceFilePath).not.toContain(SENTINEL);
    expect(descriptor.descriptorFilePath).not.toContain(SENTINEL);
  });

  test("redactArgv masks a sensitive assignment for logging", () => {
    const leaked = ["respawn-pane", "-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`, "x"];
    const redacted = redactArgv(leaked);

    expect(redacted.join(" ")).not.toContain(SENTINEL);
    expect(redacted.join(" ")).toContain(`OPENCODE_SERVER_PASSWORD=${DESCRIPTOR_CONTRACT.redactedValue}`);
    // A non-sensitive element is passed through byte-identically.
    expect(redacted[0]).toBe("respawn-pane");
    expect(redacted[3]).toBe("x");
  });

  test("POSITIVE CONTROL: the test-side detector really does find a leaked pair", () => {
    const leaked = ["respawn-pane", "-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`];
    expect(sensitiveArgvPairsOf(leaked)).toEqual([
      { index: 2, name: "OPENCODE_SERVER_PASSWORD" },
    ]);
    expect(redactArgv(leaked).join(" ")).not.toContain(SENTINEL);

    // And the negative control, so a detector that matched everything would fail.
    expect(sensitiveArgvPairsOf(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}"])).toEqual([]);
  });
});

// ===========================================================================
// 2. Environment-slot delivery, and the empty case
// ===========================================================================

describe("environment slots are the delivery mechanism", () => {
  test("the NORMAL empty -e case needs no slots and no fallback file", () => {
    const descriptor = planFor(placeholderTranslation());

    expect(descriptor.envSlotCount).toBe(0);
    expect(descriptor.slots).toEqual([]);
    expect(descriptor.slotNames).toEqual([]);

    const result = loadAssignments(descriptor, {}, createMemoryDescriptorStore());

    expect(result.ok).toBe(true);
    expect(result.assignments).toEqual([]);
    expect(result.mechanism).toBe("environment");
    // Nothing was read, so nothing had to be deleted.
    expect(result.descriptorFileUsed).toBe(false);
    expect(result.deleteVerified).toBe(true);
  });

  test("every slot is read from the helper's own process environment", () => {
    const descriptor = planFor(attachTranslation());
    const result = loadAssignments(descriptor, envWith(descriptor), createMemoryDescriptorStore());

    expect(result.ok).toBe(true);
    expect(result.mechanism).toBe("environment");
    expect(result.assignments).toEqual([
      { name: "OPENCODE_SERVER_PASSWORD", value: SENTINEL },
      { name: "OPENCODE_SERVER_USERNAME", value: "daniel" },
    ]);
    expect(result.descriptorFileUsed).toBe(false);
  });

  test("an assignment splits on the FIRST `=` only, so a hostile value survives", () => {
    expect(applySlotAssignment(`P=${HOSTILE_VALUE}`)).toEqual({ name: "P", value: HOSTILE_VALUE });
  });

  test("an assignment with no `=`, or with no name, is rejected", () => {
    expect(applySlotAssignment("NOEQUALS")).toBeUndefined();
    expect(applySlotAssignment("=value")).toBeUndefined();
    expect(applySlotAssignment("")).toBeUndefined();
  });

  test("a hostile value round-trips byte-for-byte through BOTH mechanisms", () => {
    const translation = translate(
      ["respawn-pane", "-k", "-e", `OPENCODE_SERVER_PASSWORD=${HOSTILE_VALUE}`, "-t", "%7", AT_PLAIN],
      OPTS,
    );
    const descriptor = planFor(translation);

    const viaEnvironment = loadAssignments(descriptor, envWith(descriptor), createMemoryDescriptorStore());
    expect(viaEnvironment.assignments[0]?.value).toBe(HOSTILE_VALUE);

    // Withhold the slots so the fallback fires, with the payload where the
    // helper would find it.
    const viaFile = loadAssignments(descriptor, {}, storeWithPayload(descriptor));

    expect(viaFile.ok).toBe(true);
    expect(viaFile.mechanism).toBe("file");
    expect(viaFile.assignments[0]?.value).toBe(HOSTILE_VALUE);
  });

  test("a missing slot never yields a PARTIAL delivery", () => {
    const descriptor = planFor(attachTranslation());
    const env = envWith(descriptor);
    delete env["OMO_PANE_ENV_0"]; // slot 1 is still present

    const result = loadAssignments(descriptor, env, createMemoryDescriptorStore());

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("absent");
    expect(result.assignments).toEqual([]);
    expect(result.missing).toEqual(["OMO_PANE_ENV_0"]);
    expect(result.exitCode).toBe(DESCRIPTOR_CONTRACT.exitCodes.absent);
    // The message names the slot so an operator can tell which path was taken,
    // and never echoes the value.
    expect(result.message).toContain("OMO_PANE_ENV_0");
    expect(result.message).not.toContain(SENTINEL);
  });

  test("no descriptor file is needed, and none is read, when the environment has the slots", () => {
    const descriptor = planFor(attachTranslation());
    const store = createMemoryDescriptorStore();

    const result = loadAssignments(descriptor, envWith(descriptor), store);

    expect(result.ok).toBe(true);
    expect(result.descriptorFileUsed).toBe(false);
    expect(store.read(descriptor.descriptorFilePath)).toBeUndefined();
  });
});

// ===========================================================================
// 3. The restricted-ACL file fallback
// ===========================================================================

describe("the file fallback is restricted, single-read and verified-deleted", () => {
  test("the file lives under the user's profile: not TEMP, not the bridge tree", () => {
    const descriptor = planFor(attachTranslation());

    expect(descriptor.descriptorFilePath.startsWith(`${PROFILE_DIR}\\`)).toBe(true);
    expect(descriptor.descriptorFilePath).toContain(DESCRIPTOR_CONTRACT.restrictedProfileSubdir);
    expect(descriptor.acl).toBe("current-user-only");
    expect(descriptor.descriptorFilePath).not.toMatch(/temp/i);
    expect(descriptor.descriptorFilePath).not.toContain(BRIDGE_ROOT);
    expect(descriptor.descriptorFilePath).not.toContain("AppData");
  });

  test("the filename is derived from the correlation id, so it is predictable and bounded", () => {
    const descriptor = planFor(attachTranslation(), { correlationId: "corr-0001" });
    const leaf = descriptor.descriptorFilePath.slice(descriptor.descriptorFilePath.lastIndexOf("\\") + 1);

    expect(leaf).toBe("desc-corr-0001.env");
    expect(leaf).not.toContain(SENTINEL);
  });

  test("the on-disk format is documented and pinned: version, digest, count, assignments", () => {
    const descriptor = planFor(attachTranslation());
    const { body, digest } = serializeSlotPayload(descriptor.slots);
    const parsed: unknown = JSON.parse(body);

    expect(parsed).toEqual({
      v: 1,
      digest,
      count: 2,
      assignments: [`OPENCODE_SERVER_PASSWORD=${SENTINEL}`, "OPENCODE_SERVER_USERNAME=daniel"],
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("serialise then parse returns the assignments unchanged", () => {
    const descriptor = planFor(attachTranslation());
    const { body } = serializeSlotPayload(descriptor.slots);
    const parsed = parseSlotPayload(body, descriptor.envSlotCount);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.assignments).toEqual([
        { name: "OPENCODE_SERVER_PASSWORD", value: SENTINEL },
        { name: "OPENCODE_SERVER_USERNAME", value: "daniel" },
      ]);
    }
  });

  test("a corrupted payload is REJECTED by digest, before any value is used", () => {
    const descriptor = planFor(attachTranslation());
    const { body } = serializeSlotPayload(descriptor.slots);
    // Flip one character of the value: still valid JSON, wrong content.
    const corrupted = body.replace(SENTINEL, `${SENTINEL}X`);
    expect(corrupted).not.toBe(body);

    const parsed = parseSlotPayload(corrupted, descriptor.envSlotCount);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("digest-mismatch");
      expect(parsed.exitCode).toBe(DESCRIPTOR_CONTRACT.exitCodes.malformed);
    }
  });

  test("a payload whose slot COUNT disagrees with --env-slots is rejected", () => {
    const descriptor = planFor(attachTranslation());
    const { body } = serializeSlotPayload(descriptor.slots);

    const parsed = parseSlotPayload(body, 7);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("slot-count-mismatch");
  });

  test("an unparseable payload is rejected rather than half-applied", () => {
    const parsed = parseSlotPayload("this is not the payload", 2);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("unreadable");
      expect(parsed.exitCode).toBe(DESCRIPTOR_CONTRACT.exitCodes.malformed);
    }
  });

  test("an ABSENT descriptor file exits non-zero with a message, and launches nothing", () => {
    const descriptor = planFor(attachTranslation());
    const result = loadAssignments(descriptor, {}, createMemoryDescriptorStore());

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("absent");
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toContain(descriptor.descriptorFilePath);
    expect(result.assignments).toEqual([]);
  });

  test("after a successful fallback read the file is GONE and that is verified", () => {
    const descriptor = planFor(attachTranslation());
    const store = storeWithPayload(descriptor);

    const result = loadAssignments(descriptor, {}, store);

    expect(result.ok).toBe(true);
    expect(result.descriptorFileUsed).toBe(true);
    expect(result.deleteVerified).toBe(true);
    expect(store.read(descriptor.descriptorFilePath)).toBeUndefined();
  });

  test("a deletion that cannot be verified is a FAILURE, not a warning", () => {
    const descriptor = planFor(attachTranslation());
    const store = storeWithPayload(descriptor);
    store.failRemoval = true;

    const result = loadAssignments(descriptor, {}, store);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("delete-unverified");
    expect(result.exitCode).not.toBe(0);
    // No assignment is handed on: nothing at all may be applied when the
    // credential could not be proven destroyed.
    expect(result.assignments).toEqual([]);
    expect(store.read(descriptor.descriptorFilePath)).toBeDefined();
  });
});

// ===========================================================================
// 4. Consume-once
// ===========================================================================

describe("a descriptor is consumed exactly once", () => {
  test("the first consume claims it; the second is refused without re-executing", () => {
    const descriptor = planFor(attachTranslation());
    const store = createMemoryDescriptorStore();
    let executions = 0;
    const exec = () => {
      executions += 1;
    };

    const first = claimDescriptor(descriptor, store);
    expect(first.claimed).toBe(true);
    if (first.claimed) {
      expect(loadAssignments(descriptor, envWith(descriptor), store).ok).toBe(true);
      exec();
    }

    const second = claimDescriptor(descriptor, store);

    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.outcome).toBe("already-consumed");
      expect(second.exitCode).toBe(DESCRIPTOR_CONTRACT.exitCodes.consumed);
      expect(second.message).toContain(descriptor.correlationId);
    }
    expect(executions).toBe(1);
  });

  test("consume-once holds for the EMPTY -e case too", () => {
    const descriptor = planFor(placeholderTranslation());
    const store = createMemoryDescriptorStore();

    expect(claimDescriptor(descriptor, store).claimed).toBe(true);
    expect(claimDescriptor(descriptor, store).claimed).toBe(false);
  });

  test("two DIFFERENT descriptors do not interfere", () => {
    const store = createMemoryDescriptorStore();
    const a = planFor(attachTranslation(), { correlationId: "corr-a" });
    const b = planFor(attachTranslation(), { correlationId: "corr-b" });

    expect(claimDescriptor(a, store).claimed).toBe(true);
    expect(claimDescriptor(b, store).claimed).toBe(true);
    expect(claimDescriptor(a, store).claimed).toBe(false);
  });

  test("the claim marker IS the trace file, and it carries no credential", () => {
    const descriptor = planFor(attachTranslation());
    const store = createMemoryDescriptorStore();

    claimDescriptor(descriptor, store);

    // Exclusive creation of the trace file is the single-use token, so after the
    // claim the file exists and holds exactly one line with no value in it.
    const claimed = store.read(descriptor.traceFilePath);
    expect(claimed).toBeDefined();
    expect(claimed ?? "").not.toContain(SENTINEL);
    expect(claimed ?? "").not.toContain("OPENCODE_SERVER_PASSWORD=");
    expect(JSON.parse((claimed ?? "{}").split("\n")[0] ?? "{}").correlationId).toBe(
      descriptor.correlationId,
    );
  });
});

// ===========================================================================
// 5. Attach readiness, and the single retry
// ===========================================================================

describe("the attach retry fires once, and only for `opencode attach`", () => {
  test("isAttachCommand matches exactly `opencode attach` and nothing else", () => {
    expect(isAttachCommand(["opencode", "attach", "http://127.0.0.1:4096", "--session", "s"])).toBe(
      true,
    );
    expect(isAttachCommand(["opencode"])).toBe(false);
    expect(isAttachCommand(["opencode", "run"])).toBe(false);
    expect(isAttachCommand(["opencode.exe", "attach"])).toBe(false);
    expect(isAttachCommand(["powershell", "-Command", "opencode attach x"])).toBe(false);
    expect(isAttachCommand([])).toBe(false);
  });

  test("the policy is bounded and capped at ONE retry", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);

    expect(policy.applies).toBe(true);
    expect(policy.maxRetries).toBe(1);
    expect(policy.readyWaitMs).toBeGreaterThan(0);
    expect(policy.readyWaitMs).toBeLessThanOrEqual(30_000);
    expect(policy.retryWaitMs).toBeGreaterThan(0);
    expect(policy.readyWaitMs % policy.pollIntervalMs).toBe(0);
    expect(policy.maxPolls).toBe(policy.readyWaitMs / policy.pollIntervalMs);
  });

  test("a caller may shorten the waits but may NOT raise the retry cap", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"], {
      readyWaitMs: 1000,
      retryWaitMs: 500,
    });

    expect(policy.readyWaitMs).toBe(1000);
    expect(policy.retryWaitMs).toBe(500);
    expect(policy.maxRetries).toBe(1);
  });

  test("a non-attach command gets no retry at all", () => {
    const policy = attachRetryPolicy(["powershell", "-Command", "sleep"]);

    expect(policy.applies).toBe(false);
    expect(policy.maxRetries).toBe(1); // the cap is global; it is simply not reached
  });

  test("before the first run: run, having waited for readiness", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);
    const first = nextAttachAction(policy, { attemptsRun: 0, lastExitCode: undefined });

    expect(first.kind).toBe("run");
    expect(first.waitMs).toBe(policy.readyWaitMs);
    expect(first.pollIntervalMs).toBe(policy.pollIntervalMs);
  });

  test("a zero exit stops immediately", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);

    expect(nextAttachAction(policy, { attemptsRun: 1, lastExitCode: 0 }).kind).toBe("stop");
  });

  test("a non-zero exit schedules EXACTLY ONE retry", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);
    const next = nextAttachAction(policy, { attemptsRun: 1, lastExitCode: 1 });

    expect(next.kind).toBe("retry-once");
    expect(next.waitMs).toBe(policy.retryWaitMs);
  });

  test("two failures STOP: the simulation never runs a third time", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);
    const simulation = simulateAttach(policy, [1, 1]);

    expect(simulation.attemptsRun).toBe(2);
    expect(simulation.retries).toBe(1);
    expect(simulation.outcome).toBe("exhausted");
    expect(simulation.finalExitCode).toBe(1);
    expect(simulation.actions.map((action) => action.kind)).toEqual(["run", "retry-once", "stop"]);
    expect(simulation.totalWaitMs).toBe(policy.readyWaitMs + policy.retryWaitMs);
  });

  test("a first failure then a success is the recovery case IS-3 asks for", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);
    const simulation = simulateAttach(policy, [1, 0]);

    expect(simulation.attemptsRun).toBe(2);
    expect(simulation.retries).toBe(1);
    expect(simulation.outcome).toBe("succeeded");
    expect(simulation.finalExitCode).toBe(0);
    expect(simulation.actions.map((action) => action.kind)).toEqual(["run", "retry-once", "stop"]);
  });

  test("success on the first run never retries", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);
    const simulation = simulateAttach(policy, [0]);

    expect(simulation.attemptsRun).toBe(1);
    expect(simulation.retries).toBe(0);
    expect(simulation.outcome).toBe("succeeded");
    expect(simulation.actions.map((action) => action.kind)).toEqual(["run", "stop"]);
  });

  test("a NON-attach command is run once and never retried, however it fails", () => {
    const policy = attachRetryPolicy(["powershell", "-Command", "Write-Output x"]);
    const simulation = simulateAttach(policy, [1, 1, 1]);

    expect(policy.applies).toBe(false);
    expect(simulation.attemptsRun).toBe(1);
    expect(simulation.retries).toBe(0);
    expect(simulation.outcome).toBe("exhausted");
    expect(simulation.actions.map((action) => action.kind)).toEqual(["run", "stop"]);
  });

  test("the simulation is total: no exit codes, or far too many, still terminate", () => {
    const policy = attachRetryPolicy(["opencode", "attach", "u"]);

    expect(simulateAttach(policy, []).attemptsRun).toBe(0);
    expect(simulateAttach(policy, new Array(50).fill(1) as number[]).attemptsRun).toBe(2);
  });
});

// ===========================================================================
// 6. The trace line
// ===========================================================================

describe("the trace line names the pane command and the retry, and no value", () => {
  test("it carries the correlation id, the wait and the retry count", () => {
    const descriptor = planFor(attachTranslation(), { correlationId: "corr-0001" });
    const line = traceLine(descriptor, {
      at: "2026-10-05T00:00:00.000Z",
      outcome: "delivered",
      mechanism: "environment",
      descriptorFileUsed: false,
      deleteVerified: true,
      attachWaitMs: 5000,
      attachRetries: 1,
      exitCode: 0,
    });

    expect(line.correlationId).toBe("corr-0001");
    expect(line.attachWaitMs).toBe(5000);
    expect(line.attachRetries).toBe(1);
    expect(line.attachRetryApplies).toBe(true);
    expect(line.kind).toBe("attach");
    expect(line.program).toBe("opencode");
    expect(line.verb).toBe("attach");
    expect(line.slotNames).toEqual(["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]);
    expect(line.slotCount).toBe(2);
    expect(line.outcome).toBe("delivered");
    expect(line.exitCode).toBe(0);
  });

  test("it carries NO value, no URL, no session id and no directory", () => {
    const rendered = renderTraceLineFor(planFor(attachTranslation()));

    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain("OPENCODE_SERVER_PASSWORD=");
    expect(rendered).not.toContain("127.0.0.1:4096");
    expect(rendered).not.toContain("ses_abc123");
    expect(rendered).not.toContain("/home/dev/proj");
  });

  test("it is ONE JSON object and names a placeholder command correctly", () => {
    const descriptor = planFor(placeholderTranslation());
    const rendered = renderTraceLineFor(descriptor);
    const line = traceLine(descriptor, traceEventFor());

    expect(rendered.includes("\n")).toBe(false);
    expect(JSON.parse(rendered).kind).toBe(line.kind);
    expect(line.kind).toBe("placeholder");
    expect(line.program).toBe("powershell");
    expect(line.attachRetryApplies).toBe(false);
  });

  test("the trace path is under <bridgeRoot>\\state and is derived from the correlation id", () => {
    const descriptor = planFor(attachTranslation(), { correlationId: "corr-0001" });

    expect(descriptor.traceFilePath.startsWith(`${BRIDGE_ROOT}\\`)).toBe(true);
    expect(descriptor.traceFilePath).toContain(`\\${DESCRIPTOR_CONTRACT.traceDirectoryRelative}\\`);
    expect(descriptor.traceFilePath.endsWith("pane-corr-0001.jsonl")).toBe(true);
  });

  test("a generated correlation id cannot escape the state directory", () => {
    const correlationId = newCorrelationId(1_700_000_000_000, "abc");
    expect(/^[a-z0-9-]+$/.test(correlationId)).toBe(true);

    const descriptor = planFor(attachTranslation(), { correlationId });
    expect(descriptor.traceFilePath.startsWith(`${BRIDGE_ROOT}\\`)).toBe(true);
    expect(descriptor.traceFilePath).not.toContain("..");
    expect(descriptor.descriptorFilePath.startsWith(`${PROFILE_DIR}\\`)).toBe(true);
    expect(descriptor.descriptorFilePath).not.toContain("..");
  });

  test("a SUPPLIED correlation id that is not path-safe is REFUSED, not sanitised", () => {
    const translation = attachTranslation();
    for (const hostile of ["..\\..\\evil", "a/b", "A B", "", "x".repeat(65), "corr;rm"]) {
      expect(planDescriptor(translation, { ...PLAN_OPTS, correlationId: hostile })).toBeUndefined();
    }
  });
});

// ===========================================================================
// 7. Correlation ids
// ===========================================================================

describe("correlation ids", () => {
  test("are lowercase, filename-safe, bounded, and distinct per seed", () => {
    const a = newCorrelationId(1_700_000_000_000, "aaaa");
    const b = newCorrelationId(1_700_000_000_000, "bbbb");
    const c = newCorrelationId(1_700_000_000_001, "aaaa");

    expect(/^[a-z0-9-]+$/.test(a)).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("the id survives the round trip through the helper command line", () => {
    const correlationId = newCorrelationId(1_700_000_000_000, "aaaa");
    const translation = translate(["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", AT_PLAIN], {
      ...OPTS,
      correlationId,
    });
    const descriptor = planFor(translation, { correlationId });

    expect(parseHelperCommandLine(translation.helperCommandLine ?? "").correlationId).toBe(
      correlationId,
    );
    expect(descriptor.correlationId).toBe(correlationId);
  });
});

// ===========================================================================
// 8. Descriptor / translation coherence, and totality
// ===========================================================================

describe("the descriptor is coherent with the translation it came from", () => {
  test("command, cwd, slot count and correlation id all agree with the invocation", () => {
    const correlationId = "corr-0001";
    const translation = translate(["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", AT_PLAIN], {
      ...OPTS,
      correlationId,
      cwd: "C:\\work",
    });
    const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");
    const descriptor = planFor(translation, { correlationId });

    expect(descriptor.command).toEqual(invocation.command);
    expect(descriptor.payload).toBe(invocation.payload);
    expect(descriptor.cwd).toBe("C:\\work");
    expect(descriptor.envSlotCount).toBe(invocation.envSlotCount);
    expect(descriptor.envSlotCount).toBe(translation.envSlotCount);
    expect(descriptor.correlationId).toBe(correlationId);
    expect(descriptor.slots).toEqual(translation.envSlots);
    expect(descriptor.helperPath).toBe(HELPER_PATH);
  });

  test("with no --cwd the descriptor records no working directory at all", () => {
    const descriptor = planFor(attachTranslation());

    expect(descriptor.cwd).toBeUndefined();
    expect(descriptor.cwd).not.toBe("");
  });

  test("a pass-through translation has NO descriptor at all", () => {
    expect(planDescriptor(translate(["display", "-p", "#{pane_id}"], OPTS), PLAN_OPTS)).toBeUndefined();
    expect(planDescriptor(translate(["--totally-unknown-verb", "x"], OPTS), PLAN_OPTS)).toBeUndefined();
  });

  test("a helper translation with no correlation id has no descriptor either", () => {
    // The consume-once marker and the trace file are both keyed on the id, so a
    // descriptor without one could not be made single-use.
    const translation = translate(["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", AT_PLAIN], OPTS);
    const { correlationId: _fromArgv, ...optionsWithoutId } = PLAN_OPTS;

    expect(parseHelperCommandLine(translation.helperCommandLine ?? "").correlationId).toBeUndefined();
    expect(planDescriptor(translation, optionsWithoutId)).toBeUndefined();

    // Supplying one makes it describable.
    expect(planDescriptor(translation, PLAN_OPTS)).toBeDefined();
  });

  test("a descriptor for an attach carries the retry; one for a placeholder does not", () => {
    expect(planFor(attachTranslation()).attachRetry.applies).toBe(true);
    expect(planFor(placeholderTranslation()).attachRetry.applies).toBe(false);
  });

  test("the helper path and slot prefix are the ones HELPER_CONTRACT names", () => {
    expect(DESCRIPTOR_CONTRACT.helperFileRelative).toBe(HELPER_CONTRACT.helperFileRelative);
    expect(DESCRIPTOR_CONTRACT.envSlotPrefix).toBe(HELPER_CONTRACT.envSlotPrefix);
    expect(DESCRIPTOR_CONTRACT.attachProgram).toBe(HELPER_CONTRACT.attachProgram);
    expect(DESCRIPTOR_CONTRACT.attachVerb).toBe(HELPER_CONTRACT.attachVerb);
  });

  test("the exit-code family is disjoint, non-zero, and never the chain guard's 78", () => {
    const codes = Object.values(DESCRIPTOR_CONTRACT.exitCodes);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(78);
    for (const code of codes) expect(code).toBeGreaterThan(0);
  });

  test("the fields an operator keys on are frozen", () => {
    const descriptor = planFor(attachTranslation());

    expect(Object.isFrozen(descriptor.slots)).toBe(true);
    expect(Object.isFrozen(descriptor.attachRetry)).toBe(true);
    expect(Object.isFrozen(descriptor.slotNames)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test-side expectations, written by hand rather than imported from the module
// under test, so that a shared bug cannot make an assertion pass.
// ---------------------------------------------------------------------------

function sensitiveArgvPairsOf(argv: readonly string[]): { index: number; name: string }[] {
  const found: { index: number; name: string }[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const element = argv[index];
    if (element === undefined) continue;
    const separator = element.indexOf("=");
    if (separator <= 0) continue;
    const name = element.slice(0, separator);
    if (/^(?:[A-Za-z0-9_.-]*(?:PASSWORD|SECRET|TOKEN)[A-Za-z0-9_.-]*)$/i.test(name)) {
      found.push({ index, name });
    }
  }
  return found;
}

// A guard on the fixtures themselves: if the test-side argv shape ever stops
// producing the documented translation, the credential assertions could become
// vacuous, so this asserts the fixture still yields two slots and an attach
// command.
test("fixture integrity: the password-bearing argv still yields an attach translation", () => {
  const translation = attachTranslation();
  const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");

  expect(translation.envSlotCount).toBe(2);
  expect(invocation.command[0]).toBe("opencode");
  expect(invocation.command[1]).toBe("attach");
  expect(invocation.cwd).toBeUndefined();

  const authArgs: AuthEnvArg[] = [{ name: "N", value: "v" }];
  expect(authArgs[0]?.name).toBe("N");
});