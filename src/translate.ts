// argv translator — the heart of the bridge.
//
// A pure function over one `Classified` (src/grammar.ts) plus the resolved psmux
// path. It executes nothing, spawns nothing, touches no file, and reads no
// environment variable. Every environment value it needs is handed in.
//
// The whole design is three rules, in priority order (rule 1 has three
// sub-rules, 1a to 1c, which is where every layout rule lives):
//
//   1. `pass-through` is returned byte-identically. OmO drives tmux from
//      LLM-authored argv via the `interactive_bash` tool, so unrecognised input
//      is routine, not exceptional, and rewriting it would be worse than not
//      translating at all. The three LAYOUT RULES below (rules 1a, 1b, 1c) are
//      the only exceptions, and each one is pinned to a psmux defect.
//   2. The five payload-carrying forms get their POSIX `/bin/sh -c "…"` operand
//      replaced by ONE PowerShell helper invocation. The helper applies the `-e`
//      pairs to the child's environment and then execs the command.
//   3. `respawn-pane` needs `--` before the command operand (CONTRACT.md 7.1) and
//      needs `-e` applied by the bridge rather than by psmux (CONTRACT.md 7.2).
//
// Nothing else moves. No flag is stripped, reordered or rewritten.
//
// ---------------------------------------------------------------------------
// THE HELPER INVOCATION CONTRACT — this is todo 11's interface
// ---------------------------------------------------------------------------
//
// The command operand the translator emits is a SINGLE argv element holding one
// self-quoted command line:
//
//   <shell> -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<helperPath>"
//       --payload <b64url> --command <b64url-json> [--cwd <b64url>]
//       --env-slots <n> [--correlation <b64url>]
//
// Why `powershell` and why quoted: `CreateProcess` cannot execute a `.ps1`
// directly (learnings V-6 / T-2), so the script is reached through the shell,
// and the path is quoted because `%LOCALAPPDATA%` may contain a space.
// `-ExecutionPolicy Bypass` because the pane is non-interactive and must never
// stop on a policy prompt. `shellPath` is an option so todo 12 can prefer `pwsh`.
//
// Why ONE argv element rather than several: psmux 3.3.8 reads the respawn command
// as `args.iter().position(|a| *a == "--").map(|i| args[i+1..].join(" "))`
// (CONTRACT.md 7.1). Everything after `--` is collapsed into one string joined by
// single spaces, which would destroy any multi-element quoting. A single element
// makes that join the identity, so the shape is safe on every verb.
//
// Why every value-bearing field is base64url (`A-Za-z0-9_-`, unpadded): the fields
// therefore contain no space, no quote, no backslash and no `=`, so they cannot
// collide with the flag syntax or with the shell's own parsing, and hostile
// descriptions round-trip byte-for-byte with no escaping layer to get wrong.
// `--cwd` and `--correlation` are OPTIONAL and are omitted entirely when absent;
// there is no sentinel value for "unknown".
//
// Field meanings, which todo 11 must match exactly:
//
//   --payload      base64url of the UTF-8 payload BODY, i.e. the byte-exact text
//                  between the outer double quotes of OmO's `/bin/sh -c "…"`
//                  element. PROVENANCE ONLY. The helper MUST NOT hand this to a
//                  shell: no POSIX shell is guaranteed to exist, and doing so is
//                  how the original defect is reproduced. It exists so a trace
//                  line can name the original shape without the shim re-parsing.
//   --command      base64url of a JSON array of tokens: the Windows-native
//                  command to exec. token[0] is the program. The helper execs
//                  these tokens directly with no shell wrapper (psmux's own
//                  `try_direct_spawn` behaves the same way, upstream #582).
//                  For an attach payload this is `opencode attach <url> --session
//                  <sid> --dir <dir>` with Q() already reversed. For a
//                  placeholder payload it is `<shell> -NoProfile -NonInteractive
//                  -Command <script>`, the script printing the same two lines
//                  OmO's `printf` produced and then sleeping forever.
//   --cwd          base64url of a UTF-8 working directory. OMITTED unless the
//                  caller supplied one; when absent the helper must not change
//                  directory. The translator never invents a working directory:
//                  the pane's cwd comes from psmux (CONTRACT.md 5) and the
//                  attach payload carries its own `--dir`.
//   --env-slots    decimal count N, always present, 0 in the normal case
//                  (index.js:8334 returns [] when no password is set).
//   --correlation  base64url correlation id. OMITTED by default. todo 11 owns
//                  the id; todo 12 generates one per invocation.
//
// THE CREDENTIAL RULE. `--env-slots N` says: read `OMO_PANE_ENV_0` through
// `OMO_PANE_ENV_<N-1>` from your OWN process environment, and apply each as
// `NAME=VALUE` — split on the FIRST `=` only, so a password containing `=` and
// spaces survives whole. The values are NEVER placed in argv, in any encoding:
// a command line is visible in a process listing, and base64 is not encryption.
// Consequently the translator strips the `-e` pairs from the argv it hands to
// psmux on ALL FIVE payload forms, not only on the two respawn forms where
// psmux 3.3.8 demonstrably drops them. That is a deliberate hardening of
// CONTRACT.md 7.2, which only mandates self-application on the respawn path:
// `split-window`/`new-window`/`new-session` DO honour `-e` at 3.3.8, so removing
// it there trades one unverified assumption (that env-slot delivery reaches the
// helper) for another (that psmux forwards `-e` into the pane). Removing it means
// exactly ONE delivery mechanism has to work, and it is the one whose fallback
// todo 11 is already required to build.
//
// DELIVERY IS TODO 11's PROBLEM, NOT THIS MODULE'S. psmux's server is long-lived
// and panes inherit the SERVER's environment, so setting `OMO_PANE_ENV_*` on the
// psmux client is not by itself sufficient. This module only defines the slot
// names and hands the assignments back in `envSlots`; delivering them is
// `src/descriptor.ts`'s job, including its documented restricted-ACL file
// fallback.
//
// ---------------------------------------------------------------------------
// THE LAYOUT RULES — three exceptions to rule 1, each pinned to a psmux defect
// ---------------------------------------------------------------------------
//
// Every subagent spawn and every subagent close makes OmO emit exactly three tmux
// commands, in this order, as three separate process invocations (`index.js:8914`,
// `index.js:8921`, `index.js:8937`). None of them carries a payload, so all three
// classify as `pass-through` and all three used to be forwarded byte-identically.
// Forwarding them is what produces the reported geometry: a main pane about 197
// columns wide and every subagent pane crushed to 2. Three independent psmux
// 3.3.8 defects conspire to do that, and each one is neutralised here by exactly
// as much rewriting as it takes — no more.
//
// THE GOAL is the geometry, and it is a layout question, not a translation one:
// the main pane must occupy the LEFT half of the window and the subagent panes
// must stack in the RIGHT half. `main-vertical` is that layout in psmux
// (`src/layout.rs:1129-1136`, an `Horizontal` split of `vec![main_v_pct, 100 -
// main_v_pct]` with the main pane first), so `main-horizontal` — which would put
// the main pane on TOP — is NOT substituted anywhere. OmO already asks for
// `main-vertical` (`index.js:8914`) and that choice is correct as it stands.
//
// RULE 1a — strip the `%` from a main-pane sizing option.
//
//   OmO writes the size as a percentage (`index.js:8921` builds
//   `` `${mainPaneSize}%` ``) and tmux accepts that spelling. psmux does not: it
//   parses the value with `value.parse::<u16>()` in BOTH
//   `src/server/options.rs:527` and `src/config.rs:1207`, `"50%".parse::<u16>()`
//   fails, the `if let Ok(n)` arm simply never fires, and there is no error — the
//   option is never set at all. Measured on the host: `set-window-option
//   main-pane-width "50%"` leaves the main pane at 119/199 (its 60% default),
//   while `set-window-option main-pane-width "50"` yields 99/199.
//
//   So when the verb is one of the four set-option spellings and the option being
//   set is `main-pane-width` or `main-pane-height`, ONE trailing `%` comes off the
//   value. Nothing else moves: same verb, same flags, same order, same target. A
//   value without a `%`, or any other option name, is forwarded byte-identically,
//   because the defect is specifically about a unit the backend cannot parse.
//
// RULE 1b — re-apply the layout, because setting the option is not applying it.
//
//   psmux reads `main_pane_width` and `main_pane_height` from INSIDE
//   `apply_layout` (`src/layout.rs:1094-1096`), so setting the option changes
//   nothing until a layout is applied. Measured: set the option, list panes, still
//   119; set the option, then `select-layout main-vertical`, 99. And OmO emits
//   `select-layout` BEFORE `set-window-option` (`index.js:8914` precedes
//   `index.js:8921`), so even a corrected value would arrive too late to matter.
//   The fix is to run the matching layout again, after the option is set, which is
//   what `followUps` on the Translation is for.
//
//   The mapping is not a guess. psmux reads `main_pane_width` for its
//   `main-vertical` layout (`src/layout.rs:1096` feeds `main_v_pct`, consumed at
//   `src/layout.rs:1129-1136`) and `main_pane_height` for `main-horizontal`
//   (`src/layout.rs:1095` feeds `main_h_pct`, consumed at `src/layout.rs:1109`),
//   and OmO emits these two options for its two `main-*` layouts and nothing else
//   (`index.js:8920` picks the dimension from the layout name). One option, one
//   consumer.
//
//   BUT ONLY FOR THE EXACT SHAPE OmO EMITS: verb, option name, value, no flags and
//   no `-t` (`index.js:8921`). That is a real restriction and not a stylistic one,
//   because `select-layout` and `set-window-option` are SEPARATE process
//   invocations — a pure per-argv translator can never know what layout the
//   previous one left behind, so a follow-up injected for a shape OmO never emits
//   is a layout change nobody asked for. `-u` and `-ga` are the sharp cases: psmux
//   routes them to handlers that only touch `@` options (`src/server/mod.rs:446-463`),
//   so those commands change nothing and a follow-up would still re-lay-out. Rule
//   1a is NOT so restricted, because stripping a `%` is always the safe direction.
//   The residual case this leaves, and why it is accepted rather than hidden, is
//   argued at `stripPercentAndReapplyLayout`.
//
//   The re-applied command carries NO `-t`, matching OmO's own un-targeted call
//   (`index.js:8914`) and CONTRACT.md 9 Option A. It carries the same
//   `leadingGlobals` the primary got, because `-L <ns>` is what selects the server
//   (`src/types.rs:1345-1347`) and a follow-up aimed at the wrong one would
//   re-lay-out a namespace nobody is looking at.
//
//   Its stdout, stderr and exit code are all discarded by the caller. OmO spawns
//   the two layout commands it does spawn itself with `stdout: "ignore",
//   stderr: "ignore"` (`index.js:8915-8916` and `index.js:8921`), awaits both
//   without reading a code (`index.js:8918`, `index.js:8922`), and the bridge has
//   to be at least as quiet as that: the primary command's exit code is the only
//   one OmO branches on.
//
// RULE 1c — suppress `resize-pane -x` / `-y` entirely.
//
//   OmO's third command (`index.js:8937`) hardens the width with an explicit cell
//   count. psmux's `resize-pane -x/-y` is destructive: `resize_pane_absolute`
//   (`src/window_ops.rs:1771-1796`) assigns the caller-supplied value straight
//   into the layout tree's `sizes` array, but those entries are PERCENTAGES
//   (`src/layout.rs:1136` builds `vec![main_v_pct, 100 - main_v_pct]`), whereas
//   tmux's `-x`/`-y` is a CELL COUNT. So `-x 99` writes `99` as a percentage: with
//   `sizes = [60, 20, 20]` the sibling takes `20 - (99 - 60)` and is floored at 1,
//   i.e. `[99, 1, 1]` — a 197-column main pane and 2-column siblings. Measured
//   exactly: `resize-pane -t %1 -x 99` turned `[119, 80, 80]` into `[197, 2, 2]`.
//
//   No argument form rescues it: `-x 99`, `-x 99%`, `-x 100` and `-x +0` are all
//   wrong or destructive, `-x -20` and `-l 25` are silent no-ops, and
//   `src/server/connection.rs:1767-1778` shows why — psmux parses a bare `-x`
//   token as an ABSOLUTE value and only treats a `%` suffix as a percentage, so
//   there is no spelling of the cell count that means "cell count" to it.
//
//   So the command is not forwarded at all. With rules 1a and 1b the geometry is
//   already correct, so this command is a no-op in INTENT, and forwarding a
//   no-op that is actively destructive is strictly worse than dropping it. The
//   suppression is a deliberate, user-approved tradeoff, which is why it is a
//   first-class `Translation.kind` rather than a silent drop: the call log names
//   `kind: "suppressed"` and still records the argv that was dropped, so the
//   decision is auditable rather than invisible.
//
//   `-Z` BEATS `-x`/`-y`, so `-Z` is checked first and suppresses nothing.
//   psmux dispatches zoom at `src/server/connection.rs:1236`, an arm of the same
//   `match cmd` that opens at 1061 and carries the guard `args.iter().any(|a| *a
//   == "-Z")`, before the `-x`/`-y` arms at `src/server/connection.rs:1767-1778`
//   are ever reached. So in `resize-pane -Z -x 99` the `-x 99` is never read by
//   psmux at all, and dropping that argv would drop the ZOOM.
//
// WHY ALL THREE LIVE HERE AND NOT IN src/grammar.ts. These verbs carry no payload,
// so `classifyArgv` is right to call them `pass-through` and its verb switch and
// `RecognisedKind` union are unchanged: what the bridge does to them is a
// TRANSLATE-stage concern, and keeping the classification honest is what lets
// CONTRACT.md 3.9 still say "no payload, therefore no new classification".
//
// WHAT IS NOT HANDLED, DELIBERATELY. The unset alias `-U`
// (`src/server/connection.rs:2368` treats `-U`/`-u` as "unset this option") is
// off-path: OmO's only `set-window-option` call is `index.js:8921`, which carries
// no flag at all, and an unset has no `%` for rule 1a to find. An agent that
// unsets `main-pane-width` through the `interactive_bash` tool is forwarded
// untouched, which is the pass-through guarantee doing its job.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT DONE HERE
// ---------------------------------------------------------------------------
//
// `respawn-window` is NOT special-cased. CONTRACT.md 7.3 records that OmO emits
// zero occurrences of it and that its argv shape is therefore off-path; it
// classifies as `pass-through` and is forwarded untouched, so that a future
// bundle which does emit it shows up as a visible contract change instead of a
// silent breakage. The plan's todo 9 wording says "respawn-pane/respawn-window",
// but src/grammar.ts has no `RecognisedKind` for it and CONTRACT.md 7.3 forbids
// handling it. This module follows the types and the contract.
//
// `select-layout` with no `-t` is forwarded unchanged when OmO sends one
// (CONTRACT.md 9, Option A). The only `select-layout` the bridge INVENTS is the
// follow-up in rule 1b, and it is un-targeted for the same reason.

import { classifyArgv } from "./grammar";
import type { AuthEnvArg, Classification, Classified } from "./grammar";

// ---------------------------------------------------------------------------
// The contract, as data
// ---------------------------------------------------------------------------

export const HELPER_CONTRACT = {
  /** Default argv[0] of the command operand. `pwsh` is preferred when present,
   *  but `powershell` is guaranteed on every Windows host, so it is the default
   *  for a translator that cannot probe the filesystem. */
  shell: "powershell",

  /** The flags between the shell and the helper path, verbatim and in order. */
  shellArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"],

  /** Where todo 11 puts the helper, relative to the bridge root. The installed
   *  tree already has this file (learnings T-7); the name is recorded here so
   *  todos 11 and 12 cannot drift apart. */
  helperFileRelative: "runtime\\Start-PaneFromDescriptor.ps1",

  /** Prefix of the numbered environment slots carrying `NAME=VALUE`. */
  envSlotPrefix: "OMO_PANE_ENV_",

  /** Every flag name the helper must understand. */
  payloadFlag: "--payload",
  commandFlag: "--command",
  cwdFlag: "--cwd",
  envSlotsFlag: "--env-slots",
  correlationFlag: "--correlation",

  /** Template B's `sleep 86400`, preserved exactly (index.js:8329). */
  placeholderSleepSeconds: 86400,

  /** The fixed text of Template B (index.js:8329). */
  placeholderHead: "OMO subagent pane ready: ",
  placeholderTail: "Focus this pane to attach.",

  /** Template A's program and flags (index.js:8321-8325). */
  attachProgram: "opencode",
  attachVerb: "attach",

  /** Unambiguous, total base64url. Documented here because todo 11 reimplements
   *  the decode in PowerShell and must not drift. */
  encode: encodeField,
} as const;

// ---------------------------------------------------------------------------
// Result and input types
// ---------------------------------------------------------------------------

export interface TranslateOptions {
  /** The real psmux binary the caller will exec. Echoed back so todo 12 can
   *  treat a Translation as a complete exec spec; it is deliberately the ONLY
   *  path in the result, because the rest of the result is designed to be
   *  trace-loggable. */
  readonly psmuxPath: string;
  /** Absolute path of the PowerShell helper todo 11 implements. Required: the
   *  translator is pure and cannot resolve `%LOCALAPPDATA%` itself. */
  readonly helperPath: string;
  /** Defaults to `HELPER_CONTRACT.shell`. */
  readonly shellPath?: string;
  /** Emitted as `--cwd` when present; otherwise omitted. */
  readonly cwd?: string;
  /** Emitted as `--correlation` when present; otherwise omitted. */
  readonly correlationId?: string;
  /** Leading psmux globals (`-L <ns>`, `-S <socket>`, `-f <config>`) that the
   *  caller split off with `splitLeadingGlobals`. Re-emitted in front of
   *  everything this translator produced, unchanged and in order: they select
   *  which psmux server to talk to, so dropping them would silently retarget
   *  the call, and moving them behind the verb would make psmux reject them. */
  readonly leadingGlobals?: readonly string[];
}

/** ONE `-e NAME=VALUE` pair, addressed to the helper by position.
 *
 *  `assignment` is SENSITIVE. It is the only place in a Translation where a
 *  credential lives, and it is here because the caller must put it somewhere.
 *  Never log it. */
export interface EnvSlot {
  /** 0-based position; the helper's variable name is the prefix plus this. */
  readonly index: number;
  /** `OMO_PANE_ENV_<index>` — the name to set in the child's environment. */
  readonly variable: string;
  /** `NAME=VALUE`, byte-exact, to be split by the helper on the first `=`. */
  readonly assignment: string;
}

/**
 * Why the bridge added a psmux command of its own.
 *
 * A stable slug rather than prose, because it is written verbatim into the call
 * log, where a reader has to match it against this file and against CONTRACT.md
 * 3.9. One member today because one rule needs it; a second rule that invents a
 * command adds a member here rather than a free-text string, so the log stays a
 * closed vocabulary.
 */
export type FollowUpReason = "psmux-reads-main-pane-size-only-inside-apply-layout";

/**
 * One extra psmux invocation, to be run AFTER the primary `argv`.
 *
 * A separate argv rather than a verb and a flag list because the follow-up is a
 * complete command in its own right: it needs its own leading globals to reach
 * the same server, and it must be independently projectable into the log.
 */
export interface FollowUpCommand {
  /** The psmux defect this command works around. Recorded verbatim. */
  readonly reason: FollowUpReason;
  /** The argv for THIS invocation, after the psmux path. Never contains the
   *  primary's helper operand, because no follow-up is a helper invocation. */
  readonly argv: readonly string[];
}

export interface Translation {
  /** Exactly what to hand to psmux, after the psmux path itself. ALWAYS THE
   *  PRIMARY command, even when `followUps` is non-empty — so every existing
   *  caller, and every existing assertion, keeps meaning what it meant. */
  readonly argv: readonly string[];
  /** `"passthrough"`, `"helper"`, or `"suppressed"` for the one command this
   *  bridge refuses to forward at all (rule 1c). A `suppressed` translation's
   *  `argv` is still the input, verbatim: it is the record of what was dropped. */
  readonly kind: "passthrough" | "helper" | "suppressed";
  /** Extra psmux invocations to run after `argv`, in order (rule 1b). Empty on
   *  every ordinary path, `passthrough` and `helper` included. */
  readonly followUps: readonly FollowUpCommand[];
  /** True iff any element differs from the input. Never true when the argv came
   *  back verbatim, so never for `passthrough` or `suppressed`; true for every
   *  `helper`, and true for the `%`-stripped sizing option of rule 1a. */
  readonly rewritten: boolean;
  /** True iff `--` was inserted. True for exactly two classifications. */
  readonly dashDashInserted: boolean;
  /** The psmux binary to exec `argv` with. */
  readonly psmuxPath: string;
  /** The `-e` pairs, addressed to the helper by position. Empty is normal. */
  readonly envSlots: readonly EnvSlot[];
  /** `envSlots.length`. Duplicated so a caller can size an array without a walk. */
  readonly envSlotCount: number;
  /** The emitted command line, or undefined for pass-through. */
  readonly helperCommandLine: string | undefined;
  /** Echoed from the options, for the trace line. */
  readonly correlationId: string | undefined;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Translate one already-classified argv into the argv psmux should receive.
 *
 * Total: never throws. A classification the grammar produced is always
 * translatable; a malformed helper path yields a quoted-but-odd command line
 * rather than an exception, because an exception here would strand a pane.
 */
export function translateArgv(classified: Classified, options: TranslateOptions): Translation {
  if (classified.kind === "pass-through") {
    // The layout rules live on this branch and nowhere else, because all three
    // act on payload-free commands, which is exactly what `pass-through` is.
    return translatePassThrough(classified.argv, options);
  }

  const verb = classified.argv[0];
  // Unreachable for a real Classification: the grammar only builds one from an
  // argv of length >= 2. Handled anyway so this function stays total.
  if (verb === undefined) return passthrough(classified.argv, options);

  // CONTRACT.md 7.1 and 7.3: `--` belongs to respawn-pane only. `respawn-window`
  // is off-path and never reaches this branch.
  const dashDash =
    classified.kind === "placeholder-respawn" || classified.kind === "attach-respawn";

  const shellPath = options.shellPath ?? HELPER_CONTRACT.shell;
  const commandLine = buildHelperCommandLine({
    shellPath,
    helperPath: options.helperPath,
    payload: classified.payload,
    command: buildCommandVector(classified, shellPath),
    cwd: options.cwd,
    envSlotCount: classified.envArgs.length,
    correlationId: options.correlationId,
  });

  const envSlots = buildEnvSlots(classified.envArgs);

  return {
    argv: [
      ...(options.leadingGlobals ?? []),
      verb,
      ...classified.flags,
      ...(dashDash ? ["--"] : []),
      commandLine,
    ],
    kind: "helper",
    followUps: [],
    rewritten: true,
    dashDashInserted: dashDash,
    psmuxPath: options.psmuxPath,
    envSlots,
    envSlotCount: envSlots.length,
    helperCommandLine: commandLine,
    correlationId: options.correlationId,
  };
}

/** Classify then translate. The form todo 12's CLI will call. */
export function translate(argv: readonly string[], options: TranslateOptions): Translation {
  return translateArgv(classifyArgv(argv), options);
}

function passthrough(argv: readonly string[], options: TranslateOptions): Translation {
  return {
    argv: [...(options.leadingGlobals ?? []), ...argv],
    kind: "passthrough",
    followUps: [],
    rewritten: false,
    dashDashInserted: false,
    psmuxPath: options.psmuxPath,
    envSlots: [],
    envSlotCount: 0,
    helperCommandLine: undefined,
    correlationId: undefined,
  };
}

// ---------------------------------------------------------------------------
// The layout rules, on the pass-through branch
// ---------------------------------------------------------------------------

/** The four spellings psmux itself accepts for the same verb
 *  (`src/server/connection.rs:2355`), and tmux accepts for the same one. All
 *  four are handled because OmO emits only `set-window-option`
 *  (`index.js:8921`) and an agent using `interactive_bash` may emit any of the
 *  others. */
const OPTION_SET_VERBS: ReadonlySet<string> = new Set([
  "set-window-option",
  "setw",
  "set-option",
  "set",
]);

/** Sizing option → the layout whose `apply_layout` arm CONSUMES it. The keys are
 *  the two options `src/server/options.rs:527-532` parses as `u16`, and the
 *  values are the two layouts OmO pairs them with at `index.js:8920`. One map,
 *  because "which option" and "which layout" are the same question: psmux reads
 *  `main_pane_width` in the `main-vertical` arm (`src/layout.rs:1096,1129`) and
 *  `main_pane_height` in the `main-horizontal` arm (`src/layout.rs:1095,1109`). */
const SIZING_OPTION_LAYOUT: ReadonlyMap<string, string> = new Map([
  ["main-pane-width", "main-vertical"],
  ["main-pane-height", "main-horizontal"],
]);

/** Of `set-window-option`'s flags, the one that takes a value: `-t <target>`.
 *  psmux says so in as many words (`src/server/connection.rs:2376`: "Only -t takes
 *  a value here."); the rest are bare or combined booleans it reads by letter
 *  (`src/server/connection.rs:2356-2377`: `-g`, `-a`, `-q`, `-o`, `-u`/`-U`,
 *  `-p`). A value flag is skipped together with its value so the walk lands on
 *  the option NAME and not on a target. */
const OPTION_SET_VALUE_FLAGS: ReadonlySet<string> = new Set(["-t"]);

/** Both spellings of the resize verb (`src/server/connection.rs:1760`). */
const RESIZE_VERBS: ReadonlySet<string> = new Set(["resize-pane", "resizep"]);

/**
 * The layout rules, applied to one pass-through argv.
 *
 * Three mutually exclusive shapes, decided by the verb alone, so the order here
 * is a readability choice and not a priority one. Anything not named by a rule
 * comes out of `passthrough()` untouched.
 */
function translatePassThrough(argv: readonly string[], options: TranslateOptions): Translation {
  if (carriesDestructiveResize(argv)) return suppressed(argv, options);
  return stripPercentAndReapplyLayout(argv, options);
}

/**
 * Does this argv carry a `resize-pane -x` / `-y`?
 *
 * Element equality, not a prefix test, and that is not a shortcut:
 * `src/server/connection.rs:1767-1778` looks for a bare `-x` / `-y` token with
 * `args.windows(2).find(|w| w[0] == "-x")`, so a combined `-x99` element is not
 * even read as a resize request and is harmless. Only the bare form can do
 * damage, so only the bare form is suppressed.
 *
 * `-Z` is checked FIRST and returns false, which is the precedence psmux itself
 * applies. `-Z` is dispatched at `src/server/connection.rs:1236`, an arm of the
 * same `match cmd` that opens at 1061 and closes after 3632, and it carries the
 * guard `args.iter().any(|a| *a == "-Z")`. So `resize-pane -Z -x 99` is a ZOOM to
 * psmux and the `-x 99` beside it is never read. Suppressing that argv would
 * suppress a zoom the user asked for, on the strength of a flag psmux ignores --
 * so the check has to be an early return, not a note in a comment.
 */
function carriesDestructiveResize(argv: readonly string[]): boolean {
  const verb = argv[0];
  if (verb === undefined || !RESIZE_VERBS.has(verb)) return false;
  if (argv.includes("-Z")) return false;
  return argv.includes("-x") || argv.includes("-y");
}

/** A command the bridge refuses to forward (rule 1c).
 *
 * `argv` is the INPUT, verbatim, not an empty array: the call log's whole job is
 * to say what the shim was asked to do, so the dropped command is recorded rather
 * than erased, and `kind: "suppressed"` is what distinguishes "deliberately not
 * run" from "nothing to run". */
function suppressed(argv: readonly string[], options: TranslateOptions): Translation {
  return {
    argv: [...(options.leadingGlobals ?? []), ...argv],
    kind: "suppressed",
    followUps: [],
    rewritten: false,
    dashDashInserted: false,
    psmuxPath: options.psmuxPath,
    envSlots: [],
    envSlotCount: 0,
    helperCommandLine: undefined,
    correlationId: undefined,
  };
}

/** Where the option name and its value sit, once both have been found. */
interface SizingOption {
  /** Index in argv of the VALUE element. */
  readonly valueIndex: number;
  /** The value, byte-exact. Guaranteed present and guaranteed not to be a flag. */
  readonly value: string;
  /** The layout that consumes this option — see `SIZING_OPTION_LAYOUT`. */
  readonly layout: string;
  /**
   * True iff the argv carried NO flag at all and NO `-t`.
   *
   * True is exactly `index === 1` at the end of the walk below, because the walk
   * starts at 1 and only ever advances past a flag — so it did not advance iff it
   * never saw one. This is the shape OmO emits and the ONLY shape rule 1b fires
   * on; see `stripPercentAndReapplyLayout` for why that distinction is load
   * bearing rather than cosmetic.
   */
  readonly flagless: boolean;
}

/**
 * Find `main-pane-width` / `main-pane-height` and the value OmO gave it.
 *
 * The walk skips flags to reach the option NAME, then takes the element after it
 * as the value. Anything that does not fit that shape — a different option, no
 * value at all, a dangling `-t` — returns undefined and the caller forwards the
 * command untouched, which is the safe direction for every one of those cases:
 * psmux produces its own diagnostic for a command the bridge did not understand,
 * whereas a rewrite of a command the bridge half-understood would be silent.
 *
 * It also RECORDS whether it had to skip anything, as `flagless`. That is not the
 * same question as "did it find a sizing option", and the difference is rule 1b's
 * whole gate — see `stripPercentAndReapplyLayout`.
 */
function findSizingOption(argv: readonly string[]): SizingOption | undefined {
  const verb = argv[0];
  if (verb === undefined || !OPTION_SET_VERBS.has(verb)) return undefined;

  let index = 1;
  while (index < argv.length) {
    const element = argv[index];
    if (element === undefined) return undefined;
    // The first element that is not a flag is the option NAME. A bare `-` is a
    // filename in tmux's grammar, not a flag, and a post-`--` element is an
    // operand; both end the flag run.
    if (!element.startsWith("-") || element === "-") break;
    index += OPTION_SET_VALUE_FLAGS.has(element) ? 2 : 1;
  }

  const name = argv[index];
  if (name === undefined) return undefined;
  const layout = SIZING_OPTION_LAYOUT.get(name);
  if (layout === undefined) return undefined;

  const valueIndex = index + 1;
  const value = argv[valueIndex];
  if (value === undefined || value.startsWith("-")) return undefined;

  return { valueIndex, value, layout, flagless: index === 1 };
}

/**
 * Rules 1a and 1b together: one trailing `%` off the value, and — ONLY for the
 * exact argv shape OmO emits — the consuming layout re-applied afterwards.
 *
 * Rule 1a is gated on "a main-pane sizing option whose value ends in `%`",
 * because `%` is the whole of defect A and a value without it already parses in
 * psmux. That gate is deliberately WIDE: it fires on every spelling an agent can
 * produce, including the flagged ones below, because in that direction stripping
 * is always the safe correction — psmux ignores an unparseable value silently, so
 * the worst outcome of stripping is that a value the user meant literally lost its
 * unit, versus the worst outcome of not stripping, which is a size that never
 * applies.
 *
 * Rule 1b is gated on `sizing.flagless` instead, and the two gates are not
 * interchangeable, because rule 1b is the only rule here that CHANGES THE LAYOUT
 * rather than repairing a value. OmO emits exactly one spelling of this command
 * — `index.js:8921`, `spawnCommand([tmux, "set-window-option", dimension,
 * `${mainPaneSize}%`], {...})` — which is three elements: verb, option name,
 * value. No flags, no `-t`. `flagless` is precisely that shape, because the walk
 * starts at 1 and only advances past a flag.
 *
 * WHY THE OTHER THREE SHAPES MUST NOT GET A FOLLOW-UP. A per-argv translator
 * cannot see what the previous process invocation did, and that is not a
 * limitation to work around here, it is the reason this gate exists. `select-
 * layout main-vertical` (`index.js:8914`) and `set-window-option main-pane-width
 * 50%` (`index.js:8921`) are SEPARATE invocations, so nothing in this argv says
 * which layout the window is currently in. Injecting `select-layout` on a shape
 * OmO never emits therefore applies a layout nobody asked for:
 *
 *   * `set-window-option -u main-pane-width 50%` — psmux routes `-u` to
 *     `SetOptionUnset` (`src/server/mod.rs:459-463`), whose handler only removes
 *     `@`-prefixed user options. The unset is itself a no-op and the value is
 *     never read by anything, so a follow-up here would re-lay-out the window on
 *     the strength of a command that did nothing at all.
 *   * `set-window-option -ga main-pane-width 50%` — same story via
 *     `SetOptionAppend` (`src/server/mod.rs:446-458`), which only touches `@`
 *     options and the three `status-*` strings.
 *   * `set-window-option -t <target> main-pane-width 50%` — the option did set,
 *     but a `-t` may name a pane or window other than the one holding the main
 *     pane, and the follow-up carries no `-t` by design (CONTRACT.md 9, Option A),
 *     so it would re-lay-out the CURRENT window in answer to a command aimed at
 *     some other one.
 *
 * RESIDUAL EXPOSURE, STATED PLAINLY RATHER THAN HIDDEN. The bare, un-targeted,
 * un-flagged shape is what the gate keys on, and rule 1b cannot tell whether the
 * window it is about is already in the matching layout. So an agent that authors
 * `set-window-option main-pane-height 50%` by hand through `interactive_bash`,
 * intending to resize the main pane of a window that is CURRENTLY
 * `main-vertical`, still gets switched to `main-horizontal` — the exact defect
 * this fix addresses, narrowed but not closed.
 *
 * It is narrowed rather than closed because closing it needs information this
 * module does not have and cannot get: the window's current layout, which lives
 * in the psmux server, behind a socket, in a state this pure, runtime-free
 * translator never observes. The reviewer's suggested alternative — gate on
 * "whether this argv already names that layout" — cannot work at all, because the
 * argv names an OPTION (`main-pane-width`), never a layout: the `select-layout`
 * that set the current layout was a different process invocation, already gone.
 * Choosing the option→layout map as the gate is what keeps this one line of
 * inference where the defect is actually decidable. The residual case is
 * accepted deliberately rather than papered over, and it is reachable only by an
 * agent writing a raw sizing command, which is off every path OmO takes.
 */
function stripPercentAndReapplyLayout(
  argv: readonly string[],
  options: TranslateOptions,
): Translation {
  const sizing = findSizingOption(argv);
  if (sizing === undefined || !sizing.value.endsWith("%")) {
    return passthrough(argv, options);
  }

  const leadingGlobals = options.leadingGlobals ?? [];
  const rewrittenArgv = [...argv];
  // Exactly one trailing character, which `endsWith` has established is `%`. So
  // `50%` becomes `50` and `50%%` becomes `50%`, which is what "remove a single
  // trailing `%`" means and not "strip every `%`".
  rewrittenArgv[sizing.valueIndex] = sizing.value.slice(0, -1);

  return {
    argv: [...leadingGlobals, ...rewrittenArgv],
    kind: "passthrough",
    // One follow-up, and only when no flag was skipped — the gate and its
    // residual exposure are argued above, not repeated here.
    followUps: sizing.flagless
      ? [
          {
            reason: "psmux-reads-main-pane-size-only-inside-apply-layout",
            // No `-t`, matching OmO's own un-targeted call (`index.js:8914`); the
            // same leading globals as the primary, so both invocations reach the
            // one server this translation is about.
            argv: [...leadingGlobals, "select-layout", sizing.layout],
          },
        ]
      : [],
    rewritten: true,
    dashDashInserted: false,
    psmuxPath: options.psmuxPath,
    envSlots: [],
    envSlotCount: 0,
    helperCommandLine: undefined,
    correlationId: undefined,
  };
}

// ---------------------------------------------------------------------------
// The emitted command line
// ---------------------------------------------------------------------------

interface HelperCommandLineInput {
  readonly shellPath: string;
  readonly helperPath: string;
  readonly payload: string;
  readonly command: readonly string[];
  readonly cwd: string | undefined;
  readonly envSlotCount: number;
  readonly correlationId: string | undefined;
}

function buildHelperCommandLine(input: HelperCommandLineInput): string {
  const parts: string[] = [
    input.shellPath,
    ...HELPER_CONTRACT.shellArgs,
    // Windows forbids `"` in a path, so unconditional quoting is total.
    `"${input.helperPath}"`,
    HELPER_CONTRACT.payloadFlag,
    encodeField(input.payload),
    HELPER_CONTRACT.commandFlag,
    encodeField(JSON.stringify(input.command)),
  ];

  if (input.cwd !== undefined) parts.push(HELPER_CONTRACT.cwdFlag, encodeField(input.cwd));
  parts.push(HELPER_CONTRACT.envSlotsFlag, String(input.envSlotCount));
  if (input.correlationId !== undefined) {
    parts.push(HELPER_CONTRACT.correlationFlag, encodeField(input.correlationId));
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Reading a helper command line back
// ---------------------------------------------------------------------------

export interface HelperInvocation {
  readonly shell: string;
  readonly helperPath: string;
  /** The byte-exact payload body OmO built. */
  readonly payload: string;
  /** The Windows-native token vector to exec. */
  readonly command: readonly string[];
  readonly cwd: string | undefined;
  readonly envSlotCount: number;
  readonly correlationId: string | undefined;
}

/**
 * Re-read a command line produced by `buildHelperCommandLine`.
 *
 * This is the round-trip half of the contract: it is what makes "the emitted
 * invocation reproduces the original command byte-for-byte" a checkable
 * statement rather than a claim. Throws on anything that is not a well-formed
 * helper invocation; it is not on the translation path, so totality is not
 * required of it.
 */
export function parseHelperCommandLine(line: string): HelperInvocation {
  const tokens = tokeniseCommandLine(line);

  // shell + the five shellArgs + the helper path.
  const prefixLength = 1 + HELPER_CONTRACT.shellArgs.length + 1;
  if (tokens.length < prefixLength) throw new Error(`not a helper command line: ${line}`);

  const shell = tokens[0];
  const helperPath = tokens[prefixLength - 1];
  if (shell === undefined || helperPath === undefined) {
    throw new Error(`not a helper command line: ${line}`);
  }
  const expectedShellArgs = HELPER_CONTRACT.shellArgs.join(" ");
  if (tokens.slice(1, prefixLength - 1).join(" ") !== expectedShellArgs) {
    throw new Error(`unexpected shell arguments in: ${line}`);
  }

  let payload: string | undefined;
  let command: readonly string[] | undefined;
  let cwd: string | undefined;
  let envSlotCount: number | undefined;
  let correlationId: string | undefined;

  const rest = tokens.slice(prefixLength);
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || value === undefined) throw new Error(`dangling flag in: ${line}`);
    index += 2;

    switch (flag) {
      case HELPER_CONTRACT.payloadFlag:
        payload = decodeField(value);
        break;
      case HELPER_CONTRACT.commandFlag:
        command = decodeCommandVector(value);
        break;
      case HELPER_CONTRACT.cwdFlag:
        cwd = decodeField(value);
        break;
      case HELPER_CONTRACT.envSlotsFlag: {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`bad env slot count ${value} in: ${line}`);
        }
        envSlotCount = parsed;
        break;
      }
      case HELPER_CONTRACT.correlationFlag:
        correlationId = decodeField(value);
        break;
      default:
        throw new Error(`unknown flag ${flag} in: ${line}`);
    }
  }

  if (payload === undefined) throw new Error(`missing ${HELPER_CONTRACT.payloadFlag} in: ${line}`);
  if (command === undefined) throw new Error(`missing ${HELPER_CONTRACT.commandFlag} in: ${line}`);
  if (envSlotCount === undefined) {
    throw new Error(`missing ${HELPER_CONTRACT.envSlotsFlag} in: ${line}`);
  }

  return { shell, helperPath, payload, command, cwd, envSlotCount, correlationId };
}

function decodeCommandVector(encoded: string): readonly string[] {
  const parsed: unknown = JSON.parse(decodeField(encoded));
  if (!Array.isArray(parsed)) throw new Error("command field is not a JSON array");
  const tokens: string[] = [];
  for (const token of parsed) {
    if (typeof token !== "string") throw new Error("command array holds a non-string token");
    tokens.push(token);
  }
  return tokens;
}

/** Split a command line on spaces, honouring double-quoted runs. */
function tokeniseCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (character === " " && !quoted) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// The command the helper will exec
// ---------------------------------------------------------------------------

/**
 * Turn a payload into a Windows-native token vector.
 *
 * The attach form is a real command line and becomes a token vector with Q()
 * already reversed. The placeholder form is a POSIX script fragment
 * (`printf …; while :; do sleep 86400; done`) with no Windows equivalent, so it
 * becomes a PowerShell script that prints the same two lines and then sleeps the
 * same 86400 seconds — which is the part that keeps the pane alive.
 */
function buildCommandVector(classified: Classification, shellPath: string): string[] {
  if (classified.kind === "attach-respawn") {
    return [
      HELPER_CONTRACT.attachProgram,
      HELPER_CONTRACT.attachVerb,
      unescapeSingleQuotedToken(classified.serverUrlQuoted),
      "--session",
      unescapeSingleQuotedToken(classified.sessionIdQuoted),
      "--dir",
      unescapeSingleQuotedToken(classified.directoryQuoted),
    ];
  }

  return [shellPath, "-NoProfile", "-NonInteractive", "-Command", placeholderScript(
    unescapeDoubleQuoted(classified.description),
  )];
}

function placeholderScript(description: string): string {
  const first = powerShellSingleQuoted(
    `${HELPER_CONTRACT.placeholderHead}${description}`,
  );
  const second = powerShellSingleQuoted(HELPER_CONTRACT.placeholderTail);
  return (
    `Write-Output ${first}; ` +
    `Write-Output ${second}; ` +
    `while ($true) { Start-Sleep -Seconds ${HELPER_CONTRACT.placeholderSleepSeconds} }`
  );
}

/**
 * PowerShell single-quoted string. Inside single quotes PowerShell treats
 * everything literally except `''`, so a doubled apostrophe is a total escape
 * for arbitrary text — `$`, backtick, `"` and `\` need no handling at all.
 */
function powerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// Reversing OmO's two escaping passes
// ---------------------------------------------------------------------------

/**
 * Reverse `shellEscapeForDoubleQuotedCommand` (E), used inside Template B.
 *
 * E's order (index.js:8319's neighbourhood, and the byte-exact fixture in
 * test/grammar.test.ts) is: double every backslash, then `$`, then a backtick,
 * then `"`. Reversed left to right: a backslash followed by one of those four
 * characters yields that character; a backslash followed by anything else is
 * literal, because E would have doubled it.
 */
export function unescapeDoubleQuoted(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      const next = text[index + 1];
      if (next === "\\" || next === "$" || next === "`" || next === '"') {
        out += next;
        index += 2;
        continue;
      }
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * Reverse `shellQuoteForNestedCommand` (Q), used inside Template A.
 *
 * Q wraps the value in apostrophes, replaces every apostrophe with the four
 * characters `'\''`, and then doubles every backslash — so the inserted backslash
 * arrives doubled and an embedded apostrophe arrives as the five characters
 * `'` `\` `\` `'` `'`. Reversed: that five-character run yields one apostrophe,
 * and a `\\` pair yields one backslash.
 *
 * The token is passed WITH its surrounding apostrophes, exactly as grammar.ts
 * hands it over; this module owns the reversal, as grammar.ts documents.
 */
export function unescapeSingleQuotedToken(token: string): string {
  if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) return token;
  const inner = token.slice(1, -1);

  let out = "";
  let index = 0;

  while (index < inner.length) {
    if (inner.startsWith("'\\\\''", index)) {
      out += "'";
      index += 5;
      continue;
    }
    if (inner.startsWith("\\\\", index)) {
      out += "\\";
      index += 2;
      continue;
    }
    out += inner[index];
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Environment slots
// ---------------------------------------------------------------------------

/**
 * Address each `-e NAME=VALUE` pair to a numbered environment variable.
 *
 * The pairing is byte-exact and positional: slot 0 is the first `-e` pair in
 * argv, which is `OPENCODE_SERVER_PASSWORD` when a password is set
 * (index.js:8336). The helper splits each assignment on its FIRST `=`.
 */
function buildEnvSlots(envArgs: readonly AuthEnvArg[]): EnvSlot[] {
  const slots: EnvSlot[] = [];
  for (const [index, pair] of envArgs.entries()) {
    slots.push({
      index,
      variable: `${HELPER_CONTRACT.envSlotPrefix}${index}`,
      assignment: `${pair.name}=${pair.value}`,
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/** Unambiguous, total base64url: `[A-Za-z0-9_-]`, no padding. */
export function encodeField(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The exact inverse of `encodeField`. Invalid input yields `""`, never throws. */
export function decodeField(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}
