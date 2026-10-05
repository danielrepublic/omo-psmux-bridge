// argv grammar — classification and payload extraction.
//
// A pure function over an argv array. It executes nothing, spawns nothing,
// touches no file, and reads no environment variable.
//
// The six classifications, and nothing else:
//
//   placeholder-split        split-window   + placeholder payload   (:8402-8411)
//   placeholder-newwindow    new-window     + placeholder payload   (:8617-8626, :8727-8735)
//   placeholder-newsession   new-session    + placeholder payload   (:8736-8747)
//   placeholder-respawn      respawn-pane   + placeholder payload   (:8501)
//   attach-respawn           respawn-pane   + attach payload        (:8548-8555)
//   pass-through             everything else, INCLUDING all unrecognised input
//
// `pass-through` is TOTAL. This function never throws and never returns an
// error: OmO drives tmux from LLM-authored argv via the `interactive_bash`
// tool, so arbitrary input arrives here and must be forwarded untouched.
//
// Structural fact this module is built around: the payload is ONE argv element
// whose text CONTAINS `/bin/sh -c "…"` as text. It is not three argv elements.
// The payload body is the substring between the outer double quotes of that
// last element.
//
// Source of every template constant below is the OmO bundle
// oh-my-openagent@5.1.18 dist/index.js; see test/grammar.test.ts for the
// per-line citations and the byte-exact fixtures.

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RecognisedKind =
  | "placeholder-split"
  | "placeholder-newwindow"
  | "placeholder-newsession"
  | "placeholder-respawn"
  | "attach-respawn";

/** One `-e NAME=VALUE` pair, as built by buildPaneAuthEnvironmentArgs
 *  (index.js:8331-8341). The value is kept byte-exact and is NEVER logged by
 *  this module: CONTRACT.md 2.2 requires it to be redacted. */
export interface AuthEnvArg {
  readonly name: string;
  readonly value: string;
}

interface RecognisedBase {
  /** The argv as given, copied. */
  readonly argv: readonly string[];
  /** Every element before the payload, with the `-e NAME=VALUE` pairs removed.
   *  Order is preserved exactly, so a translator can re-emit them verbatim. */
  readonly flags: readonly string[];
  /** The exact text between the outer double quotes of the payload element.
   *  Byte-identical to what OmO built; not unescaped, not rewritten. */
  readonly payload: string;
  /** Zero or more `-e` pairs. Empty is the NORMAL case (index.js:8334). */
  readonly envArgs: readonly AuthEnvArg[];
}

export interface PlaceholderSplit extends RecognisedBase {
  readonly kind: "placeholder-split";
  /** The E(description) text (index.js:4715-4716), byte-exact. */
  readonly description: string;
}

export interface PlaceholderNewWindow extends RecognisedBase {
  readonly kind: "placeholder-newwindow";
  readonly description: string;
}

export interface PlaceholderNewSession extends RecognisedBase {
  readonly kind: "placeholder-newsession";
  readonly description: string;
}

export interface PlaceholderRespawn extends RecognisedBase {
  readonly kind: "placeholder-respawn";
  readonly description: string;
}

export interface AttachRespawn extends RecognisedBase {
  readonly kind: "attach-respawn";
  /** The Q(...) tokens from index.js:8318-8319, byte-exact and STILL SHELL
   *  QUOTED — surrounding apostrophes included. Reversing Q's escaping is the
   *  translator's business (todo 9), not the grammar's. */
  readonly serverUrlQuoted: string;
  readonly sessionIdQuoted: string;
  readonly directoryQuoted: string;
}

export type Classification =
  | PlaceholderSplit
  | PlaceholderNewWindow
  | PlaceholderNewSession
  | PlaceholderRespawn
  | AttachRespawn;

export interface PassThrough {
  readonly kind: "pass-through";
  /** The argv as given, copied. A copy, not the caller's own array. */
  readonly argv: readonly string[];
}

export type Classified = Classification | PassThrough;

// ---------------------------------------------------------------------------
// Template constants, from the bundle
// ---------------------------------------------------------------------------

/** `${TMUX_COMMAND_SHELL} -c "` — index.js:8343 + the leading half of the
 *  template in :8325 / :8329. */
const SHELL_PREFIX = '/bin/sh -c "';

/** index.js:8329, up to the interpolated description. */
const PLACEHOLDER_HEAD = `printf '%s\\n%s\\n' \\"OMO subagent pane ready: `;

/** index.js:8329, after the interpolated description. */
const PLACEHOLDER_TAIL = `\\" \\"Focus this pane to attach.\\"; while :; do sleep 86400; done`;

/** index.js:8325. */
const ATTACH_HEAD = "opencode attach ";
const ATTACH_SESSION_SEP = " --session ";
const ATTACH_DIR_SEP = " --dir ";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Leading psmux globals
// ---------------------------------------------------------------------------

/** The value-taking globals psmux 3.3.8 accepts BEFORE the verb.
 *
 *  Measured on the host, not read from a manual: `psmux -L ns -V`,
 *  `psmux -S sock -V` and `psmux -f cfg -V` all exit 0 and print the version,
 *  so all three are parsed as leading options. tmux spells them the same way.
 *  `psmux list-sessions -L ns` fails with "unknown option '-L'", so they are
 *  only globals while they precede the verb.
 *
 *  OmO never emits any of them -- it resolves the bare name `tmux` and calls a
 *  verb. They matter because a throwaway-namespace invocation does, and this
 *  plan mandates that shape for todos 14, 15, 16, 18, 19 and 20. Without this
 *  the leading pair made `argv[0]` a flag, every one of the five real payload
 *  shapes degraded to `pass-through`, and the bridge silently stopped
 *  translating while still returning the backend's exit code. */
const LEADING_VALUE_GLOBALS: ReadonlySet<string> = new Set(["-L", "-S", "-f"]);

export interface SplitGlobals {
  /** The leading `-L <ns>` / `-S <socket>` / `-f <config>` pairs, verbatim and
   *  in order. Never rewritten: psmux still needs them. */
  readonly globals: readonly string[];
  /** Everything after them, which is what the grammar is defined over. */
  readonly rest: readonly string[];
}

/** Split the leading psmux globals off the front of an argv.
 *
 *  Total, like `classifyArgv`: an argv it does not recognise comes back with
 *  `globals: []` and `rest` equal to the input. A global with no value after it
 *  is NOT consumed, because taking the verb as its value would swallow the
 *  command; forwarding it untouched lets psmux produce its own error. */
export function splitLeadingGlobals(argv: readonly string[]): SplitGlobals {
  const globals: string[] = [];
  let i = 0;
  while (i + 1 < argv.length) {
    const flag = argv[i];
    if (flag === undefined || !LEADING_VALUE_GLOBALS.has(flag)) break;
    const value = argv[i + 1];
    if (value === undefined) break;
    globals.push(flag, value);
    i += 2;
  }
  return { globals, rest: argv.slice(i) };
}

/**
 * Classify one argv array. Total: never throws, never rejects, never returns an
 * error object. Anything unrecognised is `pass-through`.
 */
export function classifyArgv(argv: readonly string[]): Classified {
  const passthrough: PassThrough = { kind: "pass-through", argv: [...argv] };

  // Fewer than two elements means there is no final positional to carry a
  // payload: empty argv, or a bare verb with no operands.
  if (argv.length < 2) return passthrough;

  const verb = argv[0];
  const payloadElement = argv[argv.length - 1];
  if (verb === undefined || payloadElement === undefined) return passthrough;

  const head = argv.slice(1, -1);
  const scanned = scanAuthEnvArgs(head);
  // An unterminated or otherwise malformed `-e` means this is not one of the
  // five real shapes, so forward it untouched rather than guessing.
  if (scanned === undefined) return passthrough;

  const payload = parsePayloadElement(payloadElement);
  if (payload === undefined) return passthrough;

  const { flags, envArgs } = scanned;

  if (payload.kind === "placeholder") {
    const base = { argv: [...argv], flags, payload: payload.body, envArgs };
    switch (verb) {
      case "split-window":
        return { ...base, kind: "placeholder-split", description: payload.description };
      case "new-window":
        return { ...base, kind: "placeholder-newwindow", description: payload.description };
      case "new-session":
        return { ...base, kind: "placeholder-newsession", description: payload.description };
      case "respawn-pane":
        return { ...base, kind: "placeholder-respawn", description: payload.description };
      default:
        // e.g. split-window carrying the attach template (index.js:8401 under
        // cmux-compat). No classification name covers that, and cmux-compat is
        // false under psmux, so it is pass-through by contract.
        return passthrough;
    }
  }

  if (verb === "respawn-pane") {
    return {
      argv: [...argv],
      kind: "attach-respawn",
      flags,
      payload: payload.body,
      envArgs,
      serverUrlQuoted: payload.serverUrlQuoted,
      sessionIdQuoted: payload.sessionIdQuoted,
      directoryQuoted: payload.directoryQuoted,
    };
  }

  return passthrough;
}

// ---------------------------------------------------------------------------
// `-e NAME=VALUE`
// ---------------------------------------------------------------------------

interface ScannedHead {
  readonly flags: string[];
  readonly envArgs: AuthEnvArg[];
}

/**
 * Walk the elements before the payload, pulling out `-e NAME=VALUE` pairs
 * wherever they sit. Returns undefined for a malformed pair, which sends the
 * whole argv to pass-through.
 *
 * A `-e` as the final head element has no value within the head — the only
 * element after it is the payload, and the payload is not an env value. That is
 * the unterminated case.
 */
function scanAuthEnvArgs(head: readonly string[]): ScannedHead | undefined {
  const flags: string[] = [];
  const envArgs: AuthEnvArg[] = [];

  let index = 0;
  while (index < head.length) {
    const element = head[index];
    if (element === undefined) return undefined;
    if (element !== "-e") {
      flags.push(element);
      index += 1;
      continue;
    }
    const raw = head[index + 1];
    if (raw === undefined) return undefined;
    const separator = raw.indexOf("=");
    // Rejects a bare name with no `=`, and `=value` with no name. The value
    // itself is kept whole: only the FIRST `=` splits, so a password
    // containing `=` survives.
    if (separator <= 0) return undefined;
    envArgs.push({ name: raw.slice(0, separator), value: raw.slice(separator + 1) });
    index += 2;
  }

  return { flags, envArgs };
}

// ---------------------------------------------------------------------------
// Payload element
// ---------------------------------------------------------------------------

type ParsedPayload =
  | { readonly kind: "placeholder"; readonly body: string; readonly description: string }
  | {
      readonly kind: "attach";
      readonly body: string;
      readonly serverUrlQuoted: string;
      readonly sessionIdQuoted: string;
      readonly directoryQuoted: string;
    };

/**
 * Pull the payload body out of the final positional argument, and say which of
 * the two templates it is.
 *
 * Rejects, by returning undefined, all of: a non-payload element, a missing
 * opening or closing outer quote (the truncated case), an empty body, and a
 * body that is neither template.
 */
function parsePayloadElement(element: string): ParsedPayload | undefined {
  if (!element.startsWith(SHELL_PREFIX)) return undefined;
  if (!element.endsWith('"')) return undefined;

  const body = element.slice(SHELL_PREFIX.length, element.length - 1);
  if (body.length === 0) return undefined;

  if (body.startsWith(PLACEHOLDER_HEAD) && body.endsWith(PLACEHOLDER_TAIL)) {
    const description = body.slice(
      PLACEHOLDER_HEAD.length,
      body.length - PLACEHOLDER_TAIL.length,
    );
    return { kind: "placeholder", body, description };
  }

  if (body.startsWith(ATTACH_HEAD)) return parseAttachBody(body);

  return undefined;
}

/**
 * `opencode attach <Q(url)> --session <Q(sid)> --dir <Q(dir)>` (index.js:8325).
 *
 * The three values are read as shell single-quoted tokens rather than by
 * splitting on `--session` / `--dir`, because Q's output for a value that
 * contains those words contains them verbatim: a session id of
 * `ses_'x'--dir'y` yields the token `'ses_'\''x'\''--dir'\''y'`, whose interior
 * does contain ` --dir `. Splitting would mis-cut it.
 */
function parseAttachBody(
  body: string,
): Extract<ParsedPayload, { readonly kind: "attach" }> | undefined {
  let cursor = ATTACH_HEAD.length;

  const url = readSingleQuotedToken(body, cursor);
  if (url === undefined) return undefined;
  cursor = url.next;

  if (!body.startsWith(ATTACH_SESSION_SEP, cursor)) return undefined;
  cursor += ATTACH_SESSION_SEP.length;

  const sessionId = readSingleQuotedToken(body, cursor);
  if (sessionId === undefined) return undefined;
  cursor = sessionId.next;

  if (!body.startsWith(ATTACH_DIR_SEP, cursor)) return undefined;
  cursor += ATTACH_DIR_SEP.length;

  const directory = readSingleQuotedToken(body, cursor);
  if (directory === undefined) return undefined;
  cursor = directory.next;

  // Trailing rubbish means this is not Template A after all.
  if (cursor !== body.length) return undefined;

  return {
    kind: "attach",
    body,
    serverUrlQuoted: url.token,
    sessionIdQuoted: sessionId.token,
    directoryQuoted: directory.token,
  };
}

/**
 * Read one single-quoted shell token starting at `start`, returning the token
 * with its surrounding apostrophes included, plus the index just past it.
 *
 * shellQuoteForNestedCommand (index.js:8318-8319) wraps the value in
 * apostrophes and first rewrites every apostrophe in the value to the four
 * characters `'\''`; its subsequent backslash pass then doubles that inserted
 * backslash. So an embedded apostrophe reaches us as the five characters
 * `'` `\` `\` `'` `'` — and that is what this scanner treats as "still inside
 * the token".
 */
function readSingleQuotedToken(
  text: string,
  start: number,
): { readonly token: string; readonly next: number } | undefined {
  if (text[start] !== "'") return undefined;

  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "'") {
      const isEmbeddedApostrophe =
        text[index + 1] === "\\" &&
        text[index + 2] === "\\" &&
        text[index + 3] === "'" &&
        text[index + 4] === "'";
      if (isEmbeddedApostrophe) {
        index += 5;
        continue;
      }
      return { token: text.slice(start, index + 1), next: index + 1 };
    }
    index += 1;
  }

  // Ran off the end with the token still open.
  return undefined;
}