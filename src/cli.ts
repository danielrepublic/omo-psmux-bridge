// CLI entry point — the bridge, wired end to end.
//
// ===========================================================================
// THE ORDER OF OPERATIONS
// ===========================================================================
//
//   argv ──classifyArgv──▶ Classified ──translateArgv──▶ Translation
//        ──resolveBackend─▶ ResolvedBackend ──runBackend──▶ exit code
//
// The backend is resolved BEFORE the translation, not after, because
// `TranslateOptions.psmuxPath` is required and the `Translation` carries it back
// as part of a complete exec spec: `translation.psmuxPath` plus
// `translation.argv` is everything the caller needs to run, with nothing left to
// look up. Resolving first also means a resolution failure is still a fully
// logged invocation rather than a silent one.
//
// Nothing in this file re-implements grammar, translation, backend resolution or
// descriptor planning. Those four modules own those decisions and their tests
// own them. This file is the order, the seams, and the two logs.
//
// ===========================================================================
// WHY THERE ARE TWO LOGS, AND WHY THE SECOND ONE IS THE PROOF
// ===========================================================================
//
// 1. `OMO_PSMUX_BRIDGE_TRACE` — OPT-IN, off unless the variable names a file.
//    The prior session's E2E enabled it and it never fired, so it is treated as a
//    bonus signal: nothing in the bridge reads it back, and every failure path
//    here swallows its errors. Its absence must never change behaviour.
//
// 2. `state\shim-calls.jsonl`, resolved from the SHIM EXECUTABLE'S OWN DIRECTORY
//    — ALWAYS ON, no environment variable involved. This is the attribution
//    record: it is what lets a reader prove that a given pane was created by the
//    bridge rather than by the backend, because it names the translated shape,
//    the backend path it was handed to, and the correlation id that the helper's
//    own per-pane trace line also carries. The path is derived from
//    `dirname(process.execPath)` and nothing else: no `%LOCALAPPDATA%`, no
//    registry, no current working directory. A shim staged at
//    `<root>\staging\bin\tmux.exe` therefore writes to
//    `<root>\staging\bin\state\shim-calls.jsonl`, and that is deliberate — the
//    derivation has to be derivable from the binary alone, or it is not evidence
//    of anything.
//
// The directory is created by this module on first write, so no install step is
// load-bearing for the log existing. (`state\` does not exist in the installed
// tree; see learnings V-4 / issues I-6.)
//
// ===========================================================================
// WHAT IS DELIBERATELY ABSENT FROM BOTH LOGS
// ===========================================================================
//
//   * every `-e NAME=VALUE` VALUE, on every path, whether or not the name looks
//     sensitive. A position-based rule, not a name-based one, because a
//     credential called `FOO` is still a credential. CONTRACT.md 2.2.
//   * the payload body, in any encoding. `--payload <base64url>` is not logged,
//     and neither is the base64url itself: base64 is not encryption, and
//     `src/translate.ts` says so in as many words.
//   * the helper command line verbatim. It is replaced by a structural summary
//     (`helper` below) which carries the shape without carrying the bytes.
//   * the attach URL, the session id and the working directory. Same reasoning as
//     `src/descriptor.ts`'s own trace line, for the same reason: a log file is
//     the sort of artefact that gets attached to a bug report.
//
// The translation itself forwards everything faithfully — see
// `sanitisedArgv` for what is logged and note that it is a LOG projection only.
// The argv handed to `runBackend` is `translation.argv`, unmodified.

import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";

import { classifyArgv, splitLeadingGlobals } from "./grammar";
import type { Classified } from "./grammar";
import { HELPER_CONTRACT, parseHelperCommandLine, translateArgv } from "./translate";
import type { FollowUpCommand, Translation } from "./translate";
import { BACKEND_CANDIDATE_NAMES, describeResolution, exitCodeFor, resolveBackend, runBackend } from "./backend";
import type {
  BackendOutcome,
  ResolveOptions,
  Resolution,
  ResolvedBackend,
  RunBackendOptions,
} from "./backend";
import { newCorrelationId, planDescriptor, redactArgv, serializeSlotPayload } from "./descriptor";
import type { PanelDescriptor } from "./descriptor";

// ---------------------------------------------------------------------------
// The contract, as data
// ---------------------------------------------------------------------------

export const CLI_CONTRACT = {
  /** The opt-in trace. Its VALUE is the destination file path; blank means off. */
  traceEnv: "OMO_PSMUX_BRIDGE_TRACE",

  /** The always-on call log, relative to the shim executable's own directory.
   *  The directory name is `DESCRIPTOR_CONTRACT.traceDirectoryRelative` — one
   *  owner for the string `state`, re-exported so this module does not restate
   *  it. See the file header for why the call log and the helper's per-pane
   *  trace file are anchored differently. */
  callLogDirectory: "state",
  callLogFileName: "shim-calls.jsonl",

  /** Schema version on both records, so a reader can tell a line it understands
   *  from one it must not trust.
   *
   *  BUMPED 1 -> 2 for the layout rules, and the bump is not bookkeeping: the
   *  version is only worth carrying if a change that a v1 reader CANNOT detect
   *  moves it. Both of these are undetectable from the line itself — a v1 reader
   *  sees `v: 1` and has no way to know the schema moved underneath it:
   *
   *   * `ShimCallRecord` gained the required key `followUps`, so a strict v1
   *     validator rejects every record this shim now writes.
   *   * `ShimOutcome` gained the member `"suppressed"`, so `outcome` can now
   *     carry a value no v1 switch has a case for — and a v1 reader sees it as an
   *     unknown string on a record it believes it understands.
   *
   *  Leaving it at 1 would mean the version field asserts a compatibility that
   *  does not exist, which is strictly worse than having no version at all. */
  recordVersion: 2,

  /** Upper bound on one logged argv element, in characters. A 30 KB argument is
   *  a legal thing to forward and a terrible thing to write to a log; the tail
   *  carries the real length so the truncation is never silent. */
  maxLoggedArgLength: 200,

  /** What a redacted `-e` value becomes. Matches
   *  `DESCRIPTOR_CONTRACT.redactedValue`'s intent; a distinct constant so this
   *  module does not silently inherit a change to the other one. */
  redacted: "<redacted>",

  /** What the helper invocation element becomes in a logged argv. The real
   *  element carries `--payload <b64>` and `--command <b64>`; its structure is
   *  recorded separately in the `helper` object instead. */
  helperInvocationPlaceholder: "<helper-invocation>",

  /** `EX_SOFTWARE`, for an error inside the shim itself. Disjoint from the
   *  chain guard's 78, `EX_UNAVAILABLE`'s 69 and
   *  `DESCRIPTOR_CONTRACT.exitCodes`. */
  internalErrorExitCode: 70,
} as const;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What happened to one invocation. One of these appears in every record. */
export type ShimOutcome =
  | "forwarded"
  /** The command was deliberately NOT forwarded: `resize-pane -x` / `-y`, which
   *  psmux 3.3.8 applies as a PERCENTAGE and which would destroy the layout the
   *  other two rules just built (`src/window_ops.rs:1771-1796` against
   *  `src/layout.rs:1136`). See `src/translate.ts` rule 1c and CONTRACT.md 3.9.
   *  A distinct member rather than `"forwarded"`, because "I ran it" and "I
   *  deliberately did not run it" are different facts about the same argv, and
   *  the call log is the record that has to be able to tell them apart. */
  | "suppressed"
  | "chain-guard"
  | "backend-missing"
  | "install-dir-unresolved"
  | "shim-error";

export function outcomeForResolution(resolution: Resolution): ShimOutcome {
  return resolution.kind === "resolved" ? "forwarded" : resolution.kind;
}

function defaultNonce(): string {
  return randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Every seam has a production default. `bun test` drives the wiring through a
 *  real temp `psmux.exe`, so these exist for the cases a real backend cannot
 *  produce (a resolution failure, a log that cannot be written) rather than to
 *  make the normal path easier to fake. */
export interface MainDeps {
  readonly env?: (name: string) => string | undefined;
  readonly cwd?: string;
  /** The shim executable's own path. `process.execPath` by default, which is
   *  absolute whether OmO spawned the literal string `tmux` or a full path. */
  readonly shimPath?: string;
  /** Overrides the derived helper path. The derivation is
   *  `<shimDir>\..\<HELPER_CONTRACT.helperFileRelative>`, because the installed
   *  layout puts the shim in `<root>\bin\` and the helper in `<root>\runtime\`. */
  readonly helperPath?: string;
  /** Where the restricted-ACL fallback file is rooted. `%USERPROFILE%` in
   *  production; the descriptor module owns the subdirectory layout. */
  readonly profileDir?: string;
  readonly registryInstallDir?: string;
  readonly localAppData?: string;
  /** Passed to the backend resolver's own seam of the same name. */
  readonly resolve?: (options: ResolveOptions) => Resolution;
  readonly run?: (
    backend: ResolvedBackend,
    argv: readonly string[],
    options: RunBackendOptions,
  ) => Promise<BackendOutcome>;
  /** Receives the COMPLETE line, newline included. Default appends and fsyncs. */
  readonly writeLine?: (target: string, line: string) => void;
  /** Writes the credential fallback file. Default: mode 0600, exclusive. */
  readonly writeDescriptorFile?: (path: string, body: string) => void;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly writeStderr?: (text: string) => void;
  /** Environment for the backend child. UNDEFINED by default, so the child
   *  inherits the shim's own in full. `OMO_PANE_ENV_<n>` is deliberately NOT set
   *  here: panes inherit the long-lived SERVER's environment (CONTRACT.md 5), so
   *  a variable set on this client dies with the client. See `deliverEnvSlots`. */
  readonly backendEnv?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// The plan: everything except the exec and the writes
// ---------------------------------------------------------------------------

/** The structural summary of the helper invocation, for the call log. Carries
 *  the SHAPE — which program, how many tokens, how many env slots — and none of
 *  the bytes. `commandProgram` alone distinguishes the two shapes:
 *  `opencode` for an attach, `powershell` for a placeholder pane. */
export interface HelperView {
  readonly shell: string;
  readonly helperPath: string;
  readonly commandProgram: string;
  readonly commandVerb: string;
  readonly commandArgc: number;
  readonly cwdSet: boolean;
  readonly envSlots: number;
  readonly correlationId: string | undefined;
}

export interface Invocation {
  /** argv[0], or `""` for an empty argv. Never a payload. */
  readonly verb: string;
  readonly classification: Classified["kind"];
  readonly translation: Translation;
  readonly resolution: Resolution;
  /** Generated for EVERY invocation, pass-through included, so a log line for an
   *  unrecognised verb can still be joined to the helper's per-pane trace. */
  readonly correlationId: string;
  readonly descriptor: PanelDescriptor | undefined;
  readonly backend: ResolvedBackend | undefined;
  readonly helper: HelperView | undefined;
  /** The fixed-path call log's destination. Present even when resolution fails. */
  readonly callLogPath: string;
  /** The opt-in trace's destination, or undefined when the variable is unset or
   *  blank. */
  readonly tracePath: string | undefined;
}

/**
 * `<shimDir>\state\shim-calls.jsonl`, and nothing else.
 *
 * Anchored on the executable's own directory, deliberately, with no `bin`
 * special case and no layout assumption. A rule that guessed the bridge root
 * would be one more thing that can be wrong in a way nobody notices, and this
 * path is the attribution proof: it has to be computable from the binary alone.
 * `resolveDescriptorRoot` below is the OTHER anchor, and it does make a layout
 * assumption, because the helper's own trace file is named by the helper from
 * the helper's own location and the two must agree.
 *
 * The separator follows the shim path's own flavour rather than the host's, so
 * this returns a Windows path when given a Windows path even when it is asked on
 * Linux. `node:path`'s `dirname` would not: it reads `\` as an ordinary
 * character off-Windows and answers `.`.
 */
export function resolveCallLogPath(shimPath: string): string {
  return `${parentDir(shimPath)}${separatorOf(shimPath)}${CLI_CONTRACT.callLogDirectory}${separatorOf(shimPath)}${CLI_CONTRACT.callLogFileName}`;
}

/** `<root>` for `src/descriptor.ts`, whose trace file the helper resolves from
 *  its own `<root>\runtime\` location. The shim sits in `<root>\bin\`, so the
 *  root is one directory up when — and only when — the shim's directory is named
 *  `bin`; anywhere else the shim's own directory IS the root. */
export function resolveDescriptorRoot(shimPath: string): string {
  const parent = parentDir(shimPath);
  const leaf = parent.split(/[\\/]/).pop() ?? "";
  return leaf.toLowerCase() === "bin" ? parentDir(parent) : parent;
}

/** `<shimDir>\..\runtime\Start-PaneFromDescriptor.ps1`, from the installed
 *  layout. Derived, never configured from the environment: a wrong helper path
 *  would only be observed as a pane that silently fails to start, which is the
 *  exact failure this bridge exists to remove. */
export function resolveHelperPath(shimPath: string): string {
  const separator = separatorOf(shimPath);
  const parent = parentDir(shimPath);
  return `${parent}${separator}..${separator}${HELPER_CONTRACT.helperFileRelative}`;
}

function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Everything before the last separator, in the path's own flavour. `dirname`
 *  would answer `.` for a Windows path when asked on POSIX, and this module's
 *  output is a Windows path by construction. */
function parentDir(path: string): string {
  const separator = separatorOf(path);
  const index = path.lastIndexOf(separator);
  if (index <= 0) return separator;
  return path.slice(0, index);
}

/** `resolve(traceSetting, cwd)` — the opt-in trace's destination, or undefined.
 *  Absolute settings are used as given; a relative one is resolved against the
 *  current working directory. Unset or blank means OFF. */
export function resolveTracePath(
  traceSetting: string | undefined,
  cwd: string,
): string | undefined {
  if (traceSetting === undefined) return undefined;
  const trimmed = traceSetting.trim();
  if (trimmed.length === 0) return undefined;
  return isAbsolute(trimmed) ? trimmed : resolvePath(cwd, trimmed);
}

// ---------------------------------------------------------------------------
// Log-safe projections
// ---------------------------------------------------------------------------

/**
 * An argv made safe to write to a log.
 *
 * Three rules, in this order:
 *
 *   1. A bare `-e` (or `--environment`) and the element after it are collapsed to
 *      `<redacted>`. POSITIONAL, not name-based: `redactArgv` below also masks
 *      anything shaped `NAME=VALUE` whose NAME matches
 *      `DESCRIPTOR_CONTRACT.sensitiveNamePattern`, but that is a second line of
 *      defence for elements that are not a `-e` pair at all. A pair is a pair.
 *   2. Everything else goes through `redactArgv`, so a credential that arrives
 *      outside a `-e` pair is still masked by name.
 *   3. Each surviving element is capped, with the real length appended, so a
 *      30 KB argument cannot turn a log into a data store and the truncation is
 *      visible to whoever reads it.
 *
 * The helper invocation element is replaced wholesale by
 * `CLI_CONTRACT.helperInvocationPlaceholder` because it carries `--payload
 * <base64url>` and `--command <base64url>`; the structure is recorded in the
 * `helper` object instead.
 */
export function sanitisedArgv(argv: readonly string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const element = argv[index];
    if (element === undefined) continue;

    if (element === "-e" || element === "--environment") {
      safe.push(element);
      const value = argv[index + 1];
      if (value !== undefined) {
        safe.push(redactAssignment(value));
        index += 1;
      }
      continue;
    }

    const [redacted] = redactArgv([element]);
    safe.push(capElement(redacted ?? element));
  }
  return safe;
}

/** `NAME=<redacted>` for a pair, `<redacted>` for anything else. */
function redactAssignment(value: string): string {
  const separator = value.indexOf("=");
  if (separator <= 0) return CLI_CONTRACT.redacted;
  return `${value.slice(0, separator)}=${CLI_CONTRACT.redacted}`;
}

function capElement(element: string): string {
  if (element.length <= CLI_CONTRACT.maxLoggedArgLength) return element;
  return `${element.slice(0, CLI_CONTRACT.maxLoggedArgLength)}…(${element.length}B)`;
}

/**
 * The argv projection for the call log: `sanitisedArgv`, with the helper
 * invocation element — the LAST one, and only when the translation actually
 * produced one — swapped for a placeholder.
 */
function loggedArgv(translation: Translation): string[] {
  const safe = sanitisedArgv(translation.argv);
  if (translation.kind === "helper") {
    if (safe.length > 0) safe[safe.length - 1] = CLI_CONTRACT.helperInvocationPlaceholder;
  }
  return safe;
}

/** `parseHelperCommandLine`, reduced to shape. Undefined if it is not one. */
export function helperViewFor(translation: Translation): HelperView | undefined {
  const line = translation.helperCommandLine;
  if (line === undefined) return undefined;
  let invocation;
  try {
    invocation = parseHelperCommandLine(line);
  } catch {
    return undefined;
  }
  const [program, verb] = invocation.command;
  return {
    shell: invocation.shell,
    helperPath: invocation.helperPath,
    commandProgram: program ?? "",
    commandVerb: verb ?? "",
    commandArgc: invocation.command.length,
    cwdSet: invocation.cwd !== undefined,
    envSlots: invocation.envSlotCount,
    correlationId: invocation.correlationId,
  };
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** The opt-in trace line. Four required facts and their context: the verb, the
 *  classification, the outcome, and the correlation id. No argv, no payload, no
 *  env values — this is the smaller, stricter of the two records. */
export interface ShimTraceRecord {
  readonly v: number;
  readonly at: string;
  readonly pid: number;
  readonly correlationId: string;
  readonly verb: string;
  readonly classification: string;
  readonly kind: string;
  readonly rewritten: boolean;
  readonly argc: number;
  readonly dashDashInserted: boolean;
  readonly envSlotCount: number;
  readonly envSlotNames: readonly string[];
  readonly descriptorFileUsed: boolean;
  readonly backend: string | null;
  readonly backendSource: string | null;
  readonly resolution: string;
  readonly outcome: ShimOutcome;
  readonly exitCode: number;
  readonly durationMs: number;
}

/** The fixed-path call-log line. Superset of the trace line plus the SHAPE that
 *  was executed: the projected argv, the helper summary, and the backend path. */
export interface ShimCallRecord extends ShimTraceRecord {
  readonly argv: readonly string[];
  /** The extra invocations the shim ran after `argv`, in order, each with the
   *  reason it exists. Non-empty only for the layout rules in `src/translate.ts`
   *  (rule 1b), and recorded because a command the SHIM invented has to be
   *  distinguishable from one OmO asked for; an attribution record that silently
   *  omitted it would understate what the bridge did. Empty on every other path,
   *  `suppressed` included: nothing ran, so nothing is listed. */
  readonly followUps: readonly LoggedFollowUp[];
  readonly helper: HelperView | null;
  readonly backendName: string | null;
  readonly installDir: string | null;
}

/** One injected follow-up as the log records it: the reason slug plus the argv
 *  projection, never the raw argv — the same rule every other logged field obeys. */
export interface LoggedFollowUp {
  readonly reason: string;
  readonly argv: readonly string[];
}

export interface RecordContext {
  readonly invocation: Invocation;
  readonly at: string;
  readonly pid: number;
  readonly outcome: ShimOutcome;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly descriptorFileUsed: boolean;
}

export function buildTraceRecord(context: RecordContext): ShimTraceRecord {
  const { invocation } = context;
  const backend = invocation.backend;
  return {
    v: CLI_CONTRACT.recordVersion,
    at: context.at,
    pid: context.pid,
    correlationId: invocation.correlationId,
    verb: invocation.verb,
    classification: invocation.classification,
    kind: invocation.translation.kind,
    rewritten: invocation.translation.rewritten,
    argc: invocation.translation.argv.length,
    dashDashInserted: invocation.translation.dashDashInserted,
    envSlotCount: invocation.translation.envSlotCount,
    // NAMES only. `PanelDescriptor.slotNames` is documented as the log-safe half
    // of the slots, and it is the only part of a credential worth having.
    envSlotNames: [...(invocation.descriptor?.slotNames ?? [])],
    descriptorFileUsed: context.descriptorFileUsed,
    backend: backend?.backendPath ?? null,
    backendSource: backend?.source ?? null,
    resolution: invocation.resolution.kind,
    outcome: context.outcome,
    exitCode: context.exitCode,
    durationMs: context.durationMs,
  };
}

export function buildCallRecord(context: RecordContext): ShimCallRecord {
  const { invocation } = context;
  const trace = buildTraceRecord(context);
  const resolved = invocation.resolution.kind === "resolved" ? invocation.resolution : undefined;
  return {
    ...trace,
    argv: loggedArgv(invocation.translation),
    followUps: invocation.translation.followUps.map((followUp) => ({
      reason: followUp.reason,
      argv: sanitisedArgv(followUp.argv),
    })),
    helper: invocation.helper ?? null,
    backendName: resolved?.backendName ?? null,
    installDir: resolved?.installDir ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writing a line, durably
// ---------------------------------------------------------------------------

/**
 * Append one already-serialised, newline-terminated line and fsync it before
 * returning.
 *
 * `O_APPEND` plus a single `writeSync` is what makes concurrent invocations
 * interleave whole lines rather than shredding one. The fsync is what makes the
 * record survive the thing it is usually recording: a shim running inside a pane
 * that is about to be closed. The directory is created here, so the log's
 * existence never depends on an install step having run.
 *
 * Takes a LINE, not a record: the `writeLine` seam receives the same thing, so
 * there is exactly one place in this module that decides how a record becomes
 * bytes. (Stringifying on both sides is how the first draft wrote a JSON string
 * containing JSON — a file that parsed, and was wrong.)
 */
export function appendLine(target: string, line: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const descriptor = openSync(target, "a");
  try {
    writeSync(descriptor, line);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** The credential fallback file. Mode 0600 and exclusive, and its body is never
 *  logged. `src/descriptor.ts` owns the layout, the digest and the consume-once
 *  claim; the ACL is applied by the helper, which is the process that can. */
function writeFallbackFileDefault(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Classify, resolve, translate, describe. Executes nothing and writes nothing.
 *
 * Resolution failures are a RETURN VALUE, not a throw: an exception here would
 * surface as a stack trace inside a pane and explain nothing, whereas
 * `Resolution.message` says what was looked for and where.
 */
export function planInvocation(argv: readonly string[], deps: MainDeps = {}): Invocation {
  const env = deps.env ?? ((name: string) => process.env[name]);
  const shimPath = deps.shimPath ?? process.execPath;
  const now = deps.now ?? Date.now;
  const nonce = deps.nonce ?? defaultNonce;

  // Generated unconditionally. A pass-through gets no `--correlation` in its
  // argv (there is no argv to put it in), but it still gets an id, so its log
  // line is joinable with everything else from the same invocation.
  const correlationId = newCorrelationId(now(), nonce());

  // A leading `-L <ns>` / `-S <socket>` / `-f <config>` belongs to psmux, not to
  // the grammar. It is split off first so `argv[0]` is the verb the grammar is
  // defined over, and handed to the translator so it comes back out in front of
  // the rewritten shape. Verified on the host: without this, `tmux -L ns
  // split-window ... <payload>` classified as pass-through and the payload was
  // forwarded untranslated with the backend's own exit code, so the failure was
  // silent. See splitLeadingGlobals in ./grammar.
  const { globals: leadingGlobals, rest: argvAfterGlobals } = splitLeadingGlobals(argv);
  const classification: Classified = classifyArgv(argvAfterGlobals);

  const resolveOptions: ResolveOptions = {
    readEnv: env,
    // The SAME fact that names the call log also tells the resolver which file
    // the shim is, so the chain guard and the log cannot disagree about it.
    currentExecutable: () => shimPath,
    ...(deps.registryInstallDir === undefined
      ? {}
      : { readRegistryInstallDir: () => deps.registryInstallDir }),
    ...(deps.localAppData === undefined ? {} : { readLocalAppData: () => deps.localAppData }),
  };
  const resolution = (deps.resolve ?? resolveBackend)(resolveOptions);

  // `translateArgv` is total and its result is pure bookkeeping, so a failed
  // resolution still gets a real Translation: the argv is forwarded to nobody,
  // but the log line must describe what WOULD have run, and the pass-through case
  // is what `-V` and every unknown verb land in.
  const translation = translateArgv(classification, {
    psmuxPath: resolution.kind === "resolved" ? resolution.backendPath : "",
    helperPath: deps.helperPath ?? resolveHelperPath(shimPath),
    correlationId,
    leadingGlobals,
  });

  return {
    // The verb is what follows any leading globals, so the log line names
    // `split-window` rather than `-L`.
    verb: argvAfterGlobals[0] ?? "",
    classification: classification.kind,
    translation,
    resolution,
    correlationId,
    descriptor: planDescriptor(translation, {
      bridgeRoot: resolveDescriptorRoot(shimPath),
      profileDir: resolveProfileDir(deps, env),
    }),
    backend: resolution.kind === "resolved" ? resolution : undefined,
    helper: helperViewFor(translation),
    callLogPath: resolveCallLogPath(shimPath),
    tracePath: resolveTracePath(env(CLI_CONTRACT.traceEnv), deps.cwd ?? process.cwd()),
  };
}

function resolveProfileDir(deps: MainDeps, env: (name: string) => string | undefined): string {
  if (deps.profileDir !== undefined) return deps.profileDir;
  return env("USERPROFILE") ?? env("HOME") ?? "";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * One shim invocation: argv in, exit code out.
 *
 * `-V` needs no special case and gets none. It is a one-element argv, so
 * `classifyArgv` returns `pass-through` by the length rule alone, and the
 * pass-through guarantee then forwards it byte-identically with
 * `rewritten === false`. A dedicated fast path would be a SECOND place where
 * `-V` could be handled, and the two could disagree; the parity sweep (todo 14)
 * is what should decide whether that is ever wrong, not a branch.
 *
 * Never throws. Anything unexpected becomes `shim-error` on stderr and
 * `EX_SOFTWARE`, because a shim that dies with a stack trace inside a pane is
 * indistinguishable, to whoever is reading the pane, from the bug it was built
 * to fix.
 */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  const env = deps.env ?? ((name: string) => process.env[name]);
  const writeLine = deps.writeLine ?? appendLine;
  const writeStderr = deps.writeStderr ?? writeStderrSync;

  let invocation: Invocation | undefined;
  let descriptorFileUsed = false;
  let exitCode: number = CLI_CONTRACT.internalErrorExitCode;
  let outcome: ShimOutcome = "shim-error";

  try {
    invocation = planInvocation(argv, deps);
    const resolution = invocation.resolution;

    if (resolution.kind !== "resolved") {
      exitCode = exitCodeFor(resolution);
      outcome = outcomeForResolution(resolution);
      writeStderr(`${describeResolution(resolution)}\n`);
    } else if (invocation.translation.kind === "suppressed") {
      // Deliberate non-execution (`src/translate.ts` rule 1c). NO backend run at
      // all — not a run of an empty argv, not a run of the original argv — and
      // exit 0, because OmO emits `resize-pane` on a fire-and-forget path
      // (`index.js:8937`, awaited for completion and never inspected for an exit
      // code) and a non-zero code here would read as a failed teardown. The
      // record still carries the dropped argv, so the decision is auditable.
      exitCode = 0;
      outcome = "suppressed";
    } else {
      descriptorFileUsed = deliverEnvSlots(invocation, deps);
      const fromRun = await (deps.run ?? runBackend)(
        resolution,
        invocation.translation.argv,
        backendRunOptions(deps),
      );
      // A follow-up is gated on the primary SUCCEEDING, and it never touches
      // `exitCode` or `outcome`. All three facts are load-bearing:
      //
      //   * the ordering is the fix. `src/layout.rs:1094-1096` reads the sizing
      //     option from inside `apply_layout`, so the re-layout has to come after
      //     the `set-window-option` that set it or it reads the old value.
      //   * SUCCESS is the gate, not merely "it ran". `runBackend` never throws
      //     (`src/backend.ts:663`), so a bad `-t`, a dead server or a psmux
      //     rejection all arrive here as a non-zero `exitCode` from a call that
      //     returned normally — and then the option the follow-up exists to
      //     consume was never set. A follow-up is a CORRECTION to an effect the
      //     primary was supposed to have had; with no effect there is nothing to
      //     correct, and injecting `select-layout` anyway would silently re-lay-out
      //     a window the user never asked to change, applying whatever
      //     `main_pane_width` happened to hold before the failed call.
      //   * the primary's exit code is OmO's only signal for this command
      //     (`index.js:8415`), and OmO itself discards the exit code of the
      //     layout calls (`index.js:8918`, `index.js:8922`), so inheriting a
      //     follow-up's code would manufacture a failure that did not happen.
      if (fromRun.exitCode === 0) {
        await runFollowUps(resolution, invocation.translation.followUps, deps);
      }
      exitCode = fromRun.exitCode;
      outcome = "forwarded";
    }
  } catch (error) {
    exitCode = CLI_CONTRACT.internalErrorExitCode;
    outcome = "shim-error";
    writeStderr(`omo-psmux-bridge: internal error: ${errorMessage(error)}\n`);
  }

  // Both writes are best-effort and both failures are silent by design: a log
  // that cannot be written must not change the exit code, because the exit code
  // is what OmO branches on (index.js:8415) and the log is only evidence.
  // An invocation that failed before `planInvocation` returned still gets both
  // lines, so "exactly one line per invocation" does not depend on the path.
  const endedAt = clock();
  const context: RecordContext = {
    invocation: invocation ?? degradedInvocation(argv, deps, env),
    at: new Date(endedAt).toISOString(),
    pid: process.pid,
    outcome,
    exitCode,
    durationMs: Math.max(0, endedAt - startedAt),
    descriptorFileUsed,
  };
  writeQuietly(writeLine, context.invocation.tracePath, buildTraceRecord(context));
  writeQuietly(writeLine, context.invocation.callLogPath, buildCallRecord(context));

  return exitCode;
}

/**
 * Run the extra psmux invocations a translation asked for, in order.
 *
 * Sequentially, each awaited, because they are order-dependent by construction:
 * the `select-layout` re-application exists to consume the option the primary
 * just set, so overlapping the two would race the very read it is there to serve.
 *
 * `captureOutput: true` is how the output is DISCARDED. `runBackend` then pipes
 * both streams instead of inheriting them (`src/backend.ts`, `BackendSpawnOptions`),
 * so the bytes are collected into a `BackendOutcome` nobody reads and never reach
 * the shim's own stdout — which matters because a stray line there would land in
 * the pane text OmO captures when it reads a pane id (CONTRACT.md 3.7).
 *
 * The outcome is discarded too, deliberately; see the comment in `main`.
 */
async function runFollowUps(
  backend: ResolvedBackend,
  followUps: readonly FollowUpCommand[],
  deps: MainDeps,
): Promise<void> {
  if (followUps.length === 0) return;
  const run = deps.run ?? runBackend;
  const options = backendRunOptions(deps);
  for (const followUp of followUps) {
    await run(backend, followUp.argv, { ...options, captureOutput: true });
  }
}

/** The environment handed to a backend child, or nothing at all so the child
 *  inherits the shim's own environment in full. One function so the primary and
 *  its follow-ups are spawned identically except for `captureOutput`. */
function backendRunOptions(deps: MainDeps): RunBackendOptions {
  return { ...(deps.backendEnv ? { env: deps.backendEnv } : {}) };
}

/** The record context for an invocation that never got as far as a plan. Its
 *  resolution is `backend-missing`, which is already a real resolution kind and
 *  makes the record self-consistent: no backend was found, so nothing ran. */
function degradedInvocation(
  argv: readonly string[],
  deps: MainDeps,
  env: (name: string) => string | undefined,
): Invocation {
  const shimPath = deps.shimPath ?? process.execPath;
  return {
    verb: argv[0] ?? "",
    classification: "pass-through",
    translation: {
      argv: [...argv],
      kind: "passthrough",
      followUps: [],
      rewritten: false,
      dashDashInserted: false,
      psmuxPath: "",
      envSlots: [],
      envSlotCount: 0,
      helperCommandLine: undefined,
      correlationId: undefined,
    },
    resolution: {
      kind: "backend-missing",
      installDir: "",
      source: "env",
      installDirKind: "absent",
      lookedFor: BACKEND_CANDIDATE_NAMES,
      message: "omo-psmux-bridge: the invocation was not planned",
      exitCode: CLI_CONTRACT.internalErrorExitCode,
    },
    correlationId: newCorrelationId((deps.now ?? Date.now)(), (deps.nonce ?? defaultNonce)()),
    descriptor: undefined,
    backend: undefined,
    helper: undefined,
    callLogPath: resolveCallLogPath(shimPath),
    tracePath: resolveTracePath(env(CLI_CONTRACT.traceEnv), deps.cwd ?? process.cwd()),
  };
}

/**
 * Put the `-e` pairs where the helper can reach them.
 *
 * The obvious mechanism — `OMO_PANE_ENV_<n>` on the psmux CLIENT's environment —
 * is not sufficient and is deliberately not used: psmux's server is long-lived
 * and panes inherit the SERVER's environment (CONTRACT.md 5), so a variable set
 * on the client dies with the client. What reaches the helper is the restricted
 * fallback file named by the correlation id, which the helper claims once and
 * deletes. This function's whole job is to write it, and to say in the record
 * whether it managed to.
 */
function deliverEnvSlots(invocation: Invocation, deps: MainDeps): boolean {
  const descriptor = invocation.descriptor;
  if (descriptor === undefined || descriptor.envSlotCount === 0) return false;

  const write = deps.writeDescriptorFile ?? writeFallbackFileDefault;
  try {
    write(descriptor.descriptorFilePath, serializeSlotPayload(descriptor.slots).body);
    return true;
  } catch {
    // The body is a credential and is deliberately not in this message. The
    // helper's own missing-slot path (exit 66) reports the failure to the pane.
    return false;
  }
}

function writeQuietly(
  writeLine: (target: string, line: string) => void,
  target: string | undefined,
  record: unknown,
): void {
  if (target === undefined) return;
  try {
    writeLine(target, `${JSON.stringify(record)}\n`);
  } catch {
    // Intentionally ignored. See the note in `main`.
  }
}

/** `process.stderr.write` is asynchronous on a pipe, so a message written there
 *  can be lost when the process exits immediately after. The shim exits right
 *  after writing, so the synchronous form is the correct one. `EAGAIN` on a
 *  non-blocking pipe is swallowed rather than thrown, because there is nothing
 *  useful to do about it. */
function writeStderrSync(text: string): void {
  try {
    writeSync(2, text);
  } catch {
    // Intentionally ignored.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
