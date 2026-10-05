// argv translator — the heart of the bridge.
//
// A pure function over one `Classified` (src/grammar.ts) plus the resolved psmux
// path. It executes nothing, spawns nothing, touches no file, and reads no
// environment variable. Every environment value it needs is handed in.
//
// The whole design is three rules, in priority order:
//
//   1. `pass-through` is returned byte-identically. OmO drives tmux from
//      LLM-authored argv via the `interactive_bash` tool, so unrecognised input
//      is routine, not exceptional, and rewriting it would be worse than not
//      translating at all.
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
// `select-layout` with no `-t` is forwarded unchanged (CONTRACT.md 9, Option A:
// the lower-risk default). Nothing is injected.

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

export interface Translation {
  /** Exactly what to hand to psmux, after the psmux path itself. */
  readonly argv: readonly string[];
  /** `"passthrough"` or `"helper"`. */
  readonly kind: "passthrough" | "helper";
  /** True iff any element differs from the input. Never true for pass-through. */
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
    return passthrough(classified.argv, options);
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
