// panel descriptor and credential handling.
//
// The module that owns the ONE thing the argv translator deliberately refuses to
// own: how an `-e NAME=VALUE` pair reaches the pane's process environment
// without becoming a second exposure of the credential.
//
// ---------------------------------------------------------------------------
// THE CONTRACT THIS EXTENDS
// ---------------------------------------------------------------------------
//
// src/translate.ts owns HELPER_CONTRACT and emits ONE argv element holding one
// self-quoted helper command line:
//
//   <shell> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<helper>"
//       --payload <b64url> --command <b64url-json> [--cwd <b64url>]
//       --env-slots <n> [--correlation <b64url>]
//
// `--env-slots N` says: read `OMO_PANE_ENV_0` .. `OMO_PANE_ENV_<N-1>` from the
// HELPER'S OWN PROCESS ENVIRONMENT. That is the contract's existing mechanism
// and this module does not replace it or add a second convention beside it.
//
// What this module adds, coherently, is everything that has to exist for that
// one mechanism to actually work:
//
//   * a DELIVERY ORDER. The environment is tried first. The restricted-ACL file
//     under the user's profile is the documented fallback, used only when the
//     numbered slots are not in the helper's environment - which is the NORMAL
//     case on the respawn path, because psmux's server is long-lived and the
//     pane inherits the SERVER's environment, not the shim's (CONTRACT.md 11,
////     translate.ts's "delivery is todo 11's problem" note).
//   * a CORRELATION ID as the single key. `--correlation` already exists in
//     HELPER_CONTRACT; this module requires one, because the trace file, the
//     consume-once marker and the fallback file are all named by it, and
//     because "a trace line can name which pane command it handled" is
//     impossible without it. A descriptor with no id is refused rather than
//     invented, because a made-up id would silently collide with another pane's.
//   * a CONSUME-ONCE RULE. The exclusive creation of the trace file IS the
//     marker: one file per pane, created once, no credential in it. A second
//     helper run for the same id finds it and exits non-zero without executing
//     anything.
//   * AN ATTACH-READINESS POLICY. `opencode attach` waits for the session to
//     become attachable, and retries ONCE on a non-zero exit, so a pane that
//     starts before its session is ready does not silently vanish (upstream
//     OpenCode issue #3505). Bounded, capped at one, and never applied to any
//     other command.
//   * A TRACE LINE naming the pane command, the delivery mechanism, the wait and
//     the retry count - and no value, no URL, no session id and no directory.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT DONE HERE
// ---------------------------------------------------------------------------
//
// No new flag is added to the emitted command line. The attach-retry parameters
// are CONSTANTS, so they need no field: `DESCRIPTOR_CONTRACT` carries them and
// the helper reads the same numbers. Adding a flag would have changed the exact
// flag sequence test/translate.test.ts pins, and the correlation id already
// arrives by `--correlation`.
//
// No file is written by this module. `serializeSlotPayload` produces the BYTES a
// caller would write and `parseSlotPayload` reads them back; the write, the ACL,
// the read-once and the verified delete are the PowerShell helper's job, and
// `DescriptorStore` is the seam that makes its behaviour testable here.
//
// The digest is NOT a security control. A same-user process could read the
// password out of the pane's environment anyway. It is a COMPLETENESS check:
// it proves the bytes decoded are the bytes that were written, so a truncated
// or partially-written fallback file is rejected instead of half-applied.

import { createHash } from "node:crypto";

import type { AuthEnvArg } from "./grammar";
import { splitAssignment } from "./grammar";
import { HELPER_CONTRACT, parseHelperCommandLine } from "./translate";
import type { EnvSlot, Translation } from "./translate";

// ---------------------------------------------------------------------------
// The contract, as data
// ---------------------------------------------------------------------------

export const DESCRIPTOR_CONTRACT = {
  /** Re-exported from HELPER_CONTRACT, not restated: the helper path is one
   *  fact with one owner. */
  helperFileRelative: HELPER_CONTRACT.helperFileRelative,

  /** Re-exported from HELPER_CONTRACT for the same reason. */
  envSlotPrefix: HELPER_CONTRACT.envSlotPrefix,

  /** Re-exported: `opencode attach` is the only retryable command, and the two
   *  strings that name it already have one owner. */
  attachProgram: HELPER_CONTRACT.attachProgram,
  attachVerb: HELPER_CONTRACT.attachVerb,

  /** Names matching this are treated as credential-bearing for every redaction
   *  and every audit. Source: the shape of `buildPaneAuthEnvironmentArgs`
   *  (index.js:8336/8339) plus the general convention that a variable named
   *  `*_TOKEN` is a secret. */
  sensitiveNamePattern: /PASSWORD|SECRET|TOKEN/i,

  /** What a redacted value is replaced with. Never the empty string: an empty
   *  replacement would be indistinguishable from a genuinely empty value. */
  redactedValue: "<redacted>",

  /** The fallback file's directory, created under the USER'S PROFILE. Never
   *  `%TEMP%` (world-readable on a default Windows install) and never inside
   *  the bridge tree (which the shim, psmux and every pane can see). */
  restrictedProfileSubdir: ".omo-pane-env",
  restrictedProfileStateSubdir: "state",
  descriptorFilePrefix: "desc-",
  descriptorFileSuffix: ".env",

  /** The ACL the helper must apply to the fallback file: the current user only,
   *  with inheritance disabled so it cannot pick up a permissive parent. */
  acl: "current-user-only",

  /** Where the per-pane trace line lives, and what it is called. It is resolved
   *  from the HELPER'S OWN LOCATION (`<bridgeRoot>\runtime\<file>`), so no
   *  path ever has to travel in argv. */
  traceDirectoryRelative: "state",
  traceFilePrefix: "pane-",
  traceFileSuffix: ".jsonl",

  /** The attach-readiness wait, in milliseconds, and its poll interval. 5 s at
   *  250 ms is 20 polls: bounded, and short enough that a dead session does
   *  not hold the pane hostage. */
  attachReadyWaitMs: 5000,
  attachPollIntervalMs: 250,

  /** The wait before the single retry. */
  attachRetryWaitMs: 2000,

  /** The cap. One. It is a constant, not an option, so no caller - including
   *  todo 12 - can raise it. */
  maxAttachRetries: 1,

  /** The readiness probe, appended to the attach URL's origin. Specified by the
   *  plan for todo 13; not a bundle citation. */
  healthPath: "/global/health",

  /** Bridge-internal exit codes, disjoint from the chain guard's 78 and from
   *  EX_OK. `sysexits.h` numbering so an operator can look them up:
   *  64 EX_USAGE, 65 EX_DATAERR, 66 EX_NOINPUT, 67 EX_NOUSER, 71 EX_OSERR. */
  exitCodes: {
    usage: 64,
    malformed: 65,
    absent: 66,
    consumed: 67,
    deleteUnverified: 71,
  },
} as const;

// ---------------------------------------------------------------------------
// Correlation ids
// ---------------------------------------------------------------------------

/** `[a-z0-9-]` only, so an id is safe as a Windows file name component. */
const CORRELATION_ID_PATTERN = /^[a-z0-9-]+$/;

/** Upper bound on an id's length, so a hostile id cannot become a long path. */
const CORRELATION_ID_MAX_LENGTH = 64;

/**
 * Build a correlation id from an explicit clock and an explicit nonce.
 *
 * Both are parameters rather than reads of `Date.now()` and `Math.random()`
 * because this module is otherwise pure, and a pure module is one whose output
 * can be asserted instead of merely observed. The result is lower-case hex and
 * base-36 only, so it matches CORRELATION_ID_PATTERN.
 */
export function newCorrelationId(nowMs: number, nonce: string): string {
  const stamp = Math.max(0, Math.trunc(nowMs)).toString(36);
  const entropy = createHash("sha256").update(nonce).digest("hex").slice(0, 8);
  return `pane-${stamp}-${entropy}`;
}

/** True iff an id is safe to interpolate into a path. */
export function isSafeCorrelationId(correlationId: string): boolean {
  return (
    correlationId.length > 0 &&
    correlationId.length <= CORRELATION_ID_MAX_LENGTH &&
    CORRELATION_ID_PATTERN.test(correlationId)
  );
}

// ---------------------------------------------------------------------------
// Attach readiness, and the single retry
// ---------------------------------------------------------------------------

export interface AttachRetryPolicy {
  /** True only for `opencode attach`. Everything else is run once. */
  readonly applies: boolean;
  /** Bounded wait for the session to become attachable, before the FIRST run. */
  readonly readyWaitMs: number;
  /** Poll interval for that wait. */
  readonly pollIntervalMs: number;
  /** `readyWaitMs / pollIntervalMs`. Zero when no wait applies. */
  readonly maxPolls: number;
  /** Bounded wait before the one retry. */
  readonly retryWaitMs: number;
  /** Always 1. A constant, so it cannot be raised. */
  readonly maxRetries: 1;
}

export interface AttachWaitOverrides {
  readonly readyWaitMs?: number | undefined;
  readonly retryWaitMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

/**
 * True for exactly one command shape: the program `opencode` followed by the
 * verb `attach`.
 *
 * Deliberately byte-exact, not a basename match. `opencode.exe attach` is NOT
 * matched, because the translator never emits it and a wrong match would apply
 * a retry to something nobody asked to be retried; the rule "never retry
 * anything that is not `opencode attach`" is worth more than the convenience.
 * Nor is a PowerShell script whose TEXT mentions `opencode attach`.
 */
export function isAttachCommand(command: readonly string[]): boolean {
  return (
    command[0] === DESCRIPTOR_CONTRACT.attachProgram &&
    command[1] === DESCRIPTOR_CONTRACT.attachVerb
  );
}

/**
 * The wait/retry policy for one command. Total, and a constant unless the
 * caller shortens the waits - `maxRetries` is not overridable at all.
 */
export function attachRetryPolicy(
  command: readonly string[],
  overrides: AttachWaitOverrides = {},
): AttachRetryPolicy {
  const applies = isAttachCommand(command);
  const pollIntervalMs = positiveOr(overrides.pollIntervalMs, DESCRIPTOR_CONTRACT.attachPollIntervalMs);
  const readyWaitMs = applies
    ? roundsDownTo(positiveOr(overrides.readyWaitMs, DESCRIPTOR_CONTRACT.attachReadyWaitMs), pollIntervalMs)
    : 0;
  const retryWaitMs = positiveOr(overrides.retryWaitMs, DESCRIPTOR_CONTRACT.attachRetryWaitMs);

  return Object.freeze({
    applies,
    readyWaitMs,
    pollIntervalMs,
    maxPolls: Math.trunc(readyWaitMs / pollIntervalMs),
    retryWaitMs,
    maxRetries: DESCRIPTOR_CONTRACT.maxAttachRetries,
  });
}

export type AttachActionKind = "run" | "retry-once" | "stop";

export interface AttachAction {
  readonly kind: AttachActionKind;
  /** How long to wait BEFORE doing what `kind` says. */
  readonly waitMs: number;
  /** Only meaningful for `kind === "run"` when a wait applies. */
  readonly pollIntervalMs: number;
  /** The attempt number this action leads into: 1 for `run`, 2 for `retry-once`. */
  readonly attempt: number;
}

export interface AttachState {
  /** How many times the command has been run so far. */
  readonly attemptsRun: number;
  /** Its last exit code, or undefined if it has not run. */
  readonly lastExitCode: number | undefined;
}

/**
 * The whole attach state machine, as one total function.
 *
 * `run` for the first attempt, `retry-once` for the second, and `stop` after
 * that - unconditionally. There is no branch that can produce a third `run`,
 * which is the property IS-3's second clause needs and the property the
 * simulation below exists to prove.
 */
export function nextAttachAction(policy: AttachRetryPolicy, state: AttachState): AttachAction {
  if (state.attemptsRun <= 0) {
    return {
      kind: "run",
      waitMs: policy.readyWaitMs,
      pollIntervalMs: policy.pollIntervalMs,
      attempt: 1,
    };
  }

  const exhausted = state.attemptsRun >= 1 + policy.maxRetries;
  if (!policy.applies || state.lastExitCode === 0 || exhausted) {
    return { kind: "stop", waitMs: 0, pollIntervalMs: policy.pollIntervalMs, attempt: state.attemptsRun };
  }

  return {
    kind: "retry-once",
    waitMs: policy.retryWaitMs,
    pollIntervalMs: policy.pollIntervalMs,
    attempt: state.attemptsRun + 1,
  };
}

export interface AttachSimulation {
  readonly attemptsRun: number;
  readonly retries: number;
  readonly outcome: "succeeded" | "exhausted";
  readonly finalExitCode: number | undefined;
  readonly totalWaitMs: number;
  readonly actions: readonly AttachAction[];
}

/**
 * Drive the state machine over a list of modelled exit codes.
 *
 * This is the "two failures must exit rather than spin" assertion as a value
 * rather than as a promise: the helper runs the same machine against real
 * processes, and this runs it against the outcomes a test can name.
 */
export function simulateAttach(
  policy: AttachRetryPolicy,
  exitCodes: readonly number[],
): AttachSimulation {
  const actions: AttachAction[] = [];
  let attemptsRun = 0;
  let retries = 0;
  let totalWaitMs = 0;
  let lastExitCode: number | undefined = undefined;

  for (;;) {
    const action = nextAttachAction(policy, { attemptsRun, lastExitCode });
    if (action.kind === "stop") {
      actions.push(action);
      break;
    }

    actions.push(action);
    if (action.kind === "retry-once") retries += 1;
    totalWaitMs += action.waitMs;

    const code = exitCodes[attemptsRun];
    if (code === undefined) break; // nothing left to model
    lastExitCode = code;
    attemptsRun += 1;
  }

  return {
    attemptsRun,
    retries,
    outcome: lastExitCode === 0 ? "succeeded" : "exhausted",
    finalExitCode: lastExitCode,
    totalWaitMs,
    actions,
  };
}

// ---------------------------------------------------------------------------
// The credential, and the two places it may live
// ---------------------------------------------------------------------------

export type EnvDeliveryMechanism = "environment" | "file";

/** `NAME` and `VALUE`, split. SENSITIVE: `value` is a credential. */
export type EnvAssignment = AuthEnvArg;

/**
 * Split one `NAME=VALUE` assignment on its FIRST `=` only.
 *
 * First, not last: a password containing `=` must survive whole. Returns
 * undefined for an assignment with no `=` or with an empty name, so a malformed
 * slot is refused instead of applying an empty variable.
 *
 * The rule itself is `splitAssignment` in src/grammar.ts, imported rather than
 * restated. The two must agree — a credential split one way on the way in and
 * another on the way out silently changes shape — and the only thing that
 * guaranteed agreement before was a comment in this file claiming agreement.
 */
export function applySlotAssignment(assignment: string): EnvAssignment | undefined {
  return splitAssignment(assignment);
}

/** True iff a variable NAME looks credential-bearing. */
export function isSensitiveName(name: string): boolean {
  return DESCRIPTOR_CONTRACT.sensitiveNamePattern.test(name);
}

/**
 * Mask every sensitive assignment in an argv, for logging.
 *
 * CONTRACT.md 2.2: the bridge's own logging must redact `-e` values. Applied to
 * every element independently, because the pair can arrive as one element
 * (`NAME=VALUE`) or as two (`-e`, then `NAME=VALUE`), and both must be safe.
 */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((element) => {
    const separator = element.indexOf("=");
    if (separator <= 0) return element;
    const name = element.slice(0, separator);
    if (!isSensitiveName(name)) return element;
    return `${name}=${DESCRIPTOR_CONTRACT.redactedValue}`;
  });
}

// ---------------------------------------------------------------------------
// The fallback payload: bytes in, assignments out
// ---------------------------------------------------------------------------

export interface SerializedSlotPayload {
  /** UTF-8 JSON: version, digest, count, then one `NAME=VALUE` per slot. */
  readonly body: string;
  /** Lower-case hex sha256 over the JSON array of assignments. */
  readonly digest: string;
}

/**
 * Serialise the assignments for the restricted-ACL file.
 *
 * JSON, not a line-oriented format, because a credential may contain a newline
 * and a line-oriented format would silently split one value into two. The digest
 * is a completeness check over the serialised array, so it is unambiguous about
 * where a value begins and ends.
 */
export function serializeSlotPayload(slots: readonly EnvSlot[]): SerializedSlotPayload {
  const assignments = slots.map((slot) => slot.assignment);
  return { body: JSON.stringify({ v: 1, digest: digestOf(assignments), count: assignments.length, assignments }), digest: digestOf(assignments) };
}

export type SlotParseFailureReason = "unreadable" | "digest-mismatch" | "slot-count-mismatch";

export type SlotParseResult =
  | { readonly ok: true; readonly assignments: readonly EnvAssignment[] }
  | {
      readonly ok: false;
      readonly reason: SlotParseFailureReason;
      readonly message: string;
      readonly exitCode: number;
    };

/**
 * Read the fallback payload back.
 *
 * `expectedCount` is the `--env-slots` value from argv, which the helper has and
 * the file cannot be trusted to agree with: a file claiming three slots when the
 * invocation promised two is a mismatch, not a surplus to accept.
 */
export function parseSlotPayload(body: string, expectedCount: number): SlotParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return malformed("unreadable", "fallback payload is not JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("unreadable", "fallback payload is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const rawAssignments = record["assignments"];
  const rawDigest = record["digest"];
  const rawCount = record["count"];
  const rawVersion = record["v"];

  if (rawVersion !== 1) return malformed("unreadable", "fallback payload has an unknown version");
  if (!Array.isArray(rawAssignments)) {
    return malformed("unreadable", "fallback payload carries no assignment array");
  }
  for (const entry of rawAssignments) {
    if (typeof entry !== "string") {
      return malformed("unreadable", "fallback payload holds a non-string assignment");
    }
  }
  const assignments = rawAssignments as string[];

  if (rawCount !== assignments.length) {
    return malformed("slot-count-mismatch", "fallback payload disagrees with itself on the slot count");
  }
  if (assignments.length !== expectedCount) {
    return malformed(
      "slot-count-mismatch",
      `fallback payload holds ${assignments.length} assignments but the invocation promised ${expectedCount}`,
    );
  }

  const digest = digestOf(assignments);
  if (typeof rawDigest !== "string" || rawDigest !== digest) {
    return malformed("digest-mismatch", "fallback payload digest does not match its own contents");
  }

  const decoded: EnvAssignment[] = [];
  for (const assignment of assignments) {
    const pair = applySlotAssignment(assignment);
    if (pair === undefined) {
      return malformed("unreadable", "fallback payload holds an assignment with no name");
    }
    decoded.push(pair);
  }

  return { ok: true, assignments: decoded };
}

function malformed(reason: SlotParseFailureReason, message: string): SlotParseResult {
  return { ok: false, reason, message, exitCode: DESCRIPTOR_CONTRACT.exitCodes.malformed };
}

function digestOf(assignments: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(assignments)).digest("hex");
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export interface PlanDescriptorOptions {
  /** `<bridgeRoot>`; the trace file is resolved from it. */
  readonly bridgeRoot: string;
  /** `%USERPROFILE%`; the fallback file is resolved from it. */
  readonly profileDir: string;
  /** Required. Falls back to the invocation's `--correlation`. */
  readonly correlationId?: string | undefined;
  /** Shorten the waits. For tests, and for a deliberately impatient caller. */
  readonly readyWaitMs?: number | undefined;
  readonly retryWaitMs?: number | undefined;
}

export interface PanelDescriptor {
  /** The single key: trace file, consume-once marker and fallback file are all
   *  named by it. */
  readonly correlationId: string;
  /** Provenance only. The helper never hands this to a shell. */
  readonly payload: string;
  /** The Windows-native token vector to exec. */
  readonly command: readonly string[];
  /** Present only when the invocation carried `--cwd`. */
  readonly cwd: string | undefined;
  /** The helper's own path, as the invocation named it. */
  readonly helperPath: string;
  /** `--env-slots`. */
  readonly envSlotCount: number;
  /** SENSITIVE: `assignment` is the credential. Never log this array. */
  readonly slots: readonly EnvSlot[];
  /** The same slots by NAME only. Safe to log. */
  readonly slotNames: readonly string[];
  /** The attach-readiness policy for `command`. */
  readonly attachRetry: AttachRetryPolicy;
  /** Where the fallback payload lives if the environment cannot carry it. */
  readonly descriptorFilePath: string;
  /** The ACL the helper must apply to that file. */
  readonly acl: typeof DESCRIPTOR_CONTRACT.acl;
  /** Where the one trace line for this pane lives. Doubles as its claim. */
  readonly traceFilePath: string;
}

/**
 * Derive the descriptor for one translation.
 *
 * Returns undefined - never throws, never guesses - when there is nothing to
 * describe or nothing to key it on:
 *
 *   * a pass-through translation. It runs no helper, so it has no credential
 *     and no trace line.
 *   * a helper invocation with no correlation id. The trace file and the
 *     consume-once marker are both named by the id, so without one a descriptor
 *     could not be made single-use, and inventing an id would collide with
 *     another pane's. The caller (todo 12) generates one per invocation, which
 *     is what src/translate.ts already documents.
 *   * a correlation id that is not safe to put in a path.
 */
export function planDescriptor(
  translation: Translation,
  options: PlanDescriptorOptions,
): PanelDescriptor | undefined {
  if (translation.kind !== "helper") return undefined;
  const line = translation.helperCommandLine;
  if (line === undefined) return undefined;

  let invocation;
  try {
    invocation = parseHelperCommandLine(line);
  } catch {
    return undefined;
  }

  const correlationId = options.correlationId ?? invocation.correlationId;
  if (correlationId === undefined || !isSafeCorrelationId(correlationId)) return undefined;

  const slots = Object.freeze([...translation.envSlots]);
  const slotNames = Object.freeze(slots.map((slot) => applySlotAssignment(slot.assignment)?.name ?? slot.variable));

  return Object.freeze({
    correlationId,
    payload: invocation.payload,
    command: Object.freeze([...invocation.command]),
    cwd: invocation.cwd,
    helperPath: invocation.helperPath,
    envSlotCount: invocation.envSlotCount,
    slots,
    slotNames,
    attachRetry: attachRetryPolicy(invocation.command, {
      readyWaitMs: options.readyWaitMs,
      retryWaitMs: options.retryWaitMs,
    }),
    descriptorFilePath: descriptorFilePathFor(options.profileDir, correlationId),
    acl: DESCRIPTOR_CONTRACT.acl,
    traceFilePath: traceFilePathFor(options.bridgeRoot, correlationId),
  });
}

function joinWindows(dir: string, leaf: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}\\${leaf}`;
}

function descriptorFilePathFor(profileDir: string, correlationId: string): string {
  return joinWindows(
    joinWindows(
      joinWindows(profileDir, DESCRIPTOR_CONTRACT.restrictedProfileSubdir),
      DESCRIPTOR_CONTRACT.restrictedProfileStateSubdir,
    ),
    `${DESCRIPTOR_CONTRACT.descriptorFilePrefix}${correlationId}${DESCRIPTOR_CONTRACT.descriptorFileSuffix}`,
  );
}

function traceFilePathFor(bridgeRoot: string, correlationId: string): string {
  return joinWindows(
    joinWindows(bridgeRoot, DESCRIPTOR_CONTRACT.traceDirectoryRelative),
    `${DESCRIPTOR_CONTRACT.traceFilePrefix}${correlationId}${DESCRIPTOR_CONTRACT.traceFileSuffix}`,
  );
}

// ---------------------------------------------------------------------------
// The store: the I/O seam
// ---------------------------------------------------------------------------

/**
 * The filesystem operations the delivery needs, and nothing else.
 *
 * The PowerShell helper implements these against the real filesystem with a
 * restricted ACL; `createMemoryDescriptorStore` implements them in memory so the
 * DECISIONS can be tested on any host. `write(..., exclusive)` returning false
 * is what "this path already exists" means, and it is what makes consume-once a
 * single atomic operation rather than a check-then-act race.
 */
export interface DescriptorStore {
  read(path: string): string | undefined;
  write(path: string, text: string, exclusive?: boolean): boolean;
  /** True iff the path is gone when this returns. */
  remove(path: string): boolean;
}

export interface MemoryDescriptorStore extends DescriptorStore {
  readonly files: Map<string, string>;
  /** When true, `remove` reports failure and leaves the file in place, so the
   *  "deletion must be verified" branch can be exercised. */
  failRemoval: boolean;
}

export function createMemoryDescriptorStore(): MemoryDescriptorStore {
  const files = new Map<string, string>();
  return {
    files,
    failRemoval: false,
    read(path) {
      return files.get(path);
    },
    write(path, text, exclusive = false) {
      if (exclusive && files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    remove(path) {
      if (this.failRemoval) return false;
      files.delete(path);
      return !files.has(path);
    },
  };
}

// ---------------------------------------------------------------------------
// Consume-once
// ---------------------------------------------------------------------------

export type ConsumeOutcome = "claimed" | "already-consumed";

export type ClaimResult =
  | { readonly claimed: true }
  | {
      readonly claimed: false;
      readonly outcome: ConsumeOutcome;
      readonly exitCode: number;
      readonly message: string;
    };

/**
 * Take the descriptor's single-use claim.
 *
 * The claim IS the trace file, created exclusively. That is deliberate: one file
 * per pane, created once, holding no credential, and already the thing an
 * operator reads to find out what the pane did. A second claim for the same
 * correlation id loses the exclusive create and is refused - so the helper exits
 * non-zero instead of launching a second pane for one descriptor.
 *
 * `exclusive` is a filesystem primitive (O_EXCL / FileMode.CreateNew), not a
 * `Test-Path` followed by a write, so two helpers racing on one descriptor cannot
 * both win.
 */
export function claimDescriptor(
  descriptor: PanelDescriptor,
  store: DescriptorStore,
  at: string = "",
): ClaimResult {
  const opening = `${JSON.stringify(
    traceLine(descriptor, {
      at,
      outcome: "opened",
      mechanism: "pending",
      descriptorFileUsed: false,
      deleteVerified: false,
      attachWaitMs: 0,
      attachRetries: 0,
      exitCode: 0,
    }),
  )}\n`;

  const opened = store.write(descriptor.traceFilePath, opening, true);
  if (!opened) {
    return {
      claimed: false,
      outcome: "already-consumed",
      exitCode: DESCRIPTOR_CONTRACT.exitCodes.consumed,
      message: `descriptor ${descriptor.correlationId} was already consumed; refusing to launch a second pane for it`,
    };
  }
  return { claimed: true };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type LoadOutcome = "delivered" | "absent" | "malformed" | "delete-unverified";

export interface LoadResult {
  readonly ok: boolean;
  readonly outcome: LoadOutcome;
  readonly exitCode: number;
  /** Names a slot or a path. Never contains a value. */
  readonly message: string;
  readonly mechanism: EnvDeliveryMechanism;
  /** SENSITIVE. Empty unless `ok`. */
  readonly assignments: readonly EnvAssignment[];
  /** The slots that were not in the helper's environment. */
  readonly missing: readonly string[];
  readonly descriptorFileUsed: boolean;
  readonly deleteVerified: boolean;
}

/**
 * Resolve the `-e` assignments, in the documented order.
 *
 *   1. The helper's own process environment. `OMO_PANE_ENV_0` .. `<N-1>`, split
 *      on the first `=`. All N or none: a partial set is refused, because a pane
 *      with the password but not the username is a different failure from a pane
 *      with neither, and only the second is the one the bridge can fix.
 *   2. The restricted-ACL fallback file, ONLY when step 1 found a gap. Read once,
 *      deleted immediately, and the deletion VERIFIED. An unverified deletion is
 *      a failure with a non-zero exit, and NO assignment is handed on: nothing
 *      may be applied while the credential cannot be proven destroyed.
 *   3. Neither: exit non-zero with a message naming the missing slot and the
 *      path. Never launch a pane without the credential.
 *
 * `env` is a snapshot of the helper's environment, passed in, because this
 * module reads no environment variable of its own.
 */
export function loadAssignments(
  descriptor: PanelDescriptor,
  env: Readonly<Record<string, string | undefined>>,
  store: DescriptorStore,
): LoadResult {
  if (descriptor.envSlotCount <= 0) {
    return delivered([], "environment", [], false, true, "no env slots; nothing to deliver");
  }

  const missing: string[] = [];
  const fromEnvironment: EnvAssignment[] = [];
  for (let index = 0; index < descriptor.envSlotCount; index += 1) {
    const variable = `${DESCRIPTOR_CONTRACT.envSlotPrefix}${index}`;
    const assignment = env[variable];
    if (assignment === undefined) {
      missing.push(variable);
      continue;
    }
    const pair = applySlotAssignment(assignment);
    if (pair === undefined) {
      return failure(
        "malformed",
        DESCRIPTOR_CONTRACT.exitCodes.malformed,
        `${variable} does not hold a NAME=VALUE assignment`,
        "environment",
        missing,
        false,
        true,
      );
    }
    fromEnvironment.push(pair);
  }

  if (missing.length === 0) return delivered(fromEnvironment, "environment", [], false, true, "delivered from the helper environment");

  const body = store.read(descriptor.descriptorFilePath);
  if (body === undefined) {
    return failure(
      "absent",
      DESCRIPTOR_CONTRACT.exitCodes.absent,
      `neither the helper environment (missing ${missing.join(", ")}) nor ${descriptor.descriptorFilePath} carries the pane environment; refusing to launch a pane without it`,
      "file",
      missing,
      true,
      true,
    );
  }

  const parsed = parseSlotPayload(body, descriptor.envSlotCount);
  if (!parsed.ok) {
    return failure("malformed", parsed.exitCode, `${descriptor.descriptorFilePath}: ${parsed.message}`, "file", missing, true, true);
  }

  // Read once. Deleted immediately. And the deletion is checked, not assumed.
  if (!store.remove(descriptor.descriptorFilePath)) {
    return failure(
      "delete-unverified",
      DESCRIPTOR_CONTRACT.exitCodes.deleteUnverified,
      `${descriptor.descriptorFilePath} could not be removed; refusing to run with a credential that may outlive the read`,
      "file",
      missing,
      true,
      false,
    );
  }

  return delivered(parsed.assignments, "file", missing, true, true, "delivered from the restricted fallback file");
}

function delivered(
  assignments: readonly EnvAssignment[],
  mechanism: EnvDeliveryMechanism,
  missing: readonly string[],
  descriptorFileUsed: boolean,
  deleteVerified: boolean,
  message: string,
): LoadResult {
  return {
    ok: true,
    outcome: "delivered",
    exitCode: 0,
    message,
    mechanism,
    assignments,
    missing,
    descriptorFileUsed,
    deleteVerified,
  };
}

function failure(
  outcome: LoadOutcome,
  exitCode: number,
  message: string,
  mechanism: EnvDeliveryMechanism,
  missing: readonly string[],
  descriptorFileUsed: boolean,
  deleteVerified: boolean,
): LoadResult {
  return {
    ok: false,
    outcome,
    exitCode,
    message,
    mechanism,
    assignments: [],
    missing,
    descriptorFileUsed,
    deleteVerified,
  };
}

// ---------------------------------------------------------------------------
// The trace line
// ---------------------------------------------------------------------------

export type TraceOutcome =
  | LoadOutcome
  | ConsumeOutcome
  | "exhausted"
  | "succeeded"
  /** Written by the claim, before anything has been delivered. */
  | "opened";

/** The opening trace line is written before the delivery mechanism is known, so
 *  it says so rather than guessing. */
export type TraceMechanism = EnvDeliveryMechanism | "pending";

export interface DescriptorTraceEvent {
  /** ISO-8601. Supplied, not read from a clock. */
  readonly at: string;
  readonly outcome: TraceOutcome;
  readonly mechanism: TraceMechanism;
  readonly descriptorFileUsed: boolean;
  readonly deleteVerified: boolean;
  /** How long the helper actually waited for readiness. */
  readonly attachWaitMs: number;
  /** How many retries it actually performed: 0 or 1. */
  readonly attachRetries: number;
  readonly exitCode: number;
}

export interface DescriptorTrace {
  readonly v: 1;
  readonly correlationId: string;
  readonly at: string;
  /** "attach" | "placeholder" | "other". */
  readonly kind: string;
  /** argv[0] of the command. Never the whole vector. */
  readonly program: string;
  /** argv[1] of the command, or "" when there is none. */
  readonly verb: string;
  readonly envMechanism: TraceMechanism;
  readonly slotCount: number;
  /** NAMES only. The values are never here. */
  readonly slotNames: readonly string[];
  readonly descriptorFileUsed: boolean;
  readonly deleteVerified: boolean;
  readonly attachRetryApplies: boolean;
  readonly attachWaitMs: number;
  readonly attachRetries: number;
  readonly exitCode: number;
  readonly outcome: TraceOutcome;
}

/**
 * The one line the helper appends for this pane.
 *
 * What is deliberately absent, and why each absence is a decision rather than an
 * oversight:
 *
 *   * every `-e` VALUE. CONTRACT.md 2.2. The slot NAMES are there, because
 *     "which variables did this pane get" is the useful half and the harmless
 *     half.
 *   * the attach URL. It is a bearer URL in OpenCode's own scheme, and a trace
 *     file is exactly the sort of artefact that gets attached to a bug report.
 *   * the session id and the directory. Same reasoning, and they add nothing an
 *     operator cannot read off the pane.
 *   * the payload body. It is provenance for the shim's own trace, not for this.
 */
export function traceLine(
  descriptor: PanelDescriptor,
  event: DescriptorTraceEvent,
): DescriptorTrace {
  const isAttach = isAttachCommand(descriptor.command);
  // The translator emits the placeholder as
  // `<shell> -NoProfile -NonInteractive -Command <script>`, so the verb is not
  // at index 1; the discriminator is the shell plus the presence of -Command.
  const isPlaceholder =
    !isAttach &&
    (descriptor.command[0] === "powershell" || descriptor.command[0] === "pwsh") &&
    descriptor.command.includes("-Command");

  return {
    v: 1,
    correlationId: descriptor.correlationId,
    at: event.at,
    kind: isAttach ? "attach" : isPlaceholder ? "placeholder" : "other",
    program: descriptor.command[0] ?? "",
    verb: isAttach ? DESCRIPTOR_CONTRACT.attachVerb : isPlaceholder ? "-Command" : "",
    envMechanism: event.mechanism,
    slotCount: descriptor.envSlotCount,
    slotNames: [...descriptor.slotNames],
    descriptorFileUsed: event.descriptorFileUsed,
    deleteVerified: event.deleteVerified,
    attachRetryApplies: descriptor.attachRetry.applies,
    attachWaitMs: event.attachWaitMs,
    attachRetries: event.attachRetries,
    exitCode: event.exitCode,
    outcome: event.outcome,
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function positiveOr(candidate: number | undefined, fallback: number): number {
  if (candidate === undefined) return fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) return fallback;
  return Math.trunc(candidate);
}

/** Round DOWN, so `maxPolls` never promises more polls than the wait affords. */
function roundsDownTo(value: number, multiple: number): number {
  return Math.trunc(value / multiple) * multiple;
}