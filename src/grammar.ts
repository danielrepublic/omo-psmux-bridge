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
// Template sources: the E(doublequote) constants below match the OmO bundle
// from 5.1.18 through 5.1.33 (dist/index.js); the Q(singlequote) banner
// constants match 5.1.35's pane-command.ts buildTmuxPlaceholderCommand.
// test/grammar.test.ts keeps byte-exact fixtures for both eras; only the
// 5.1.35 shape is current upstream.

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RecognisedKind =
  | "placeholder-split"
  | "placeholder-newwindow"
  | "placeholder-newsession"
  | "placeholder-respawn"
  | "attach-respawn";

/** How the placeholder description is encoded inside the payload body.
 *
 *  The shipped E(doublequote) template (5.1.33 and earlier) escapes the
 *  description with shellEscapeForDoubleQuotedCommand; the 5.1.35 template
 *  carries it inside a Q(singlequote) banner token instead. The translator
 *  reverses the matching pass, so the grammar names the variant explicitly
 *  rather than leaving the translator to guess. */
export type PlaceholderEncoding = "escaped-doublequote" | "singlequote";

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
  /** True iff OmO 5.1.51 prepended its file-backed auth fragment. The fragment
   *  is stripped only for template parsing; `payload` keeps the original bytes
   *  as provenance. A pane marked true needs `OPENCODE_SERVER_PASSWORD_FILE`
   *  delivered or it must fail closed rather than run unauthenticated. */
  readonly authFileBacked: boolean;
}

export interface PlaceholderSplit extends RecognisedBase {
  readonly kind: "placeholder-split";
  /** The description bytes, encoding named by `descriptionEncoding`. E text
   *  for the shipped template, Q-banner inner text for the 5.1.35 template.
   *  Byte-exact in both cases; decoding is the translator's business. */
  readonly description: string;
  readonly descriptionEncoding: PlaceholderEncoding;
}

export interface PlaceholderNewWindow extends RecognisedBase {
  readonly kind: "placeholder-newwindow";
  readonly description: string;
  readonly descriptionEncoding: PlaceholderEncoding;
}

export interface PlaceholderNewSession extends RecognisedBase {
  readonly kind: "placeholder-newsession";
  readonly description: string;
  readonly descriptionEncoding: PlaceholderEncoding;
}

export interface PlaceholderRespawn extends RecognisedBase {
  readonly kind: "placeholder-respawn";
  readonly description: string;
  readonly descriptionEncoding: PlaceholderEncoding;
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
 *  template in :8325 / :8329. Unchanged in 5.1.35. */
const SHELL_PREFIX = '/bin/sh -c "';

/** index.js:8329, up to the interpolated description. The shipped E template,
 *  preserved verbatim (5.1.33 and earlier). */
const PLACEHOLDER_HEAD = `printf '%s\\n%s\\n' \\"OMO subagent pane ready: `;

/** index.js:8329, after the interpolated description. The shipped E template. */
const PLACEHOLDER_TAIL = `\\" \\"Focus this pane to attach.\\"; while :; do sleep 86400; done`;

/** 5.1.35 pane-command.ts buildTmuxPlaceholderCommand: the fixed prefix before
 *  the Q(banner) token. */
const PLACEHOLDER_PREFIX_535 = `printf '%s\\n%s\\n' `;

/** 5.1.35: the banner token's fixed opening, including its leading quote. */
const PLACEHOLDER_BANNER_OPEN_535 = `'OMO subagent pane ready: `;

/** 5.1.35: the exact remainder after the banner token's closing quote — one
 *  space, the Q(hint) token, then the sleep loop. The hint carries no escapes
 *  (plain sentence), so it is matched literally. */
const PLACEHOLDER_HINT_535 = `'Focus this pane to attach.'; while :; do sleep 86400; done`;

/** index.js:8325. */
const ATTACH_HEAD = "opencode attach ";
const ATTACH_SESSION_SEP = " --session ";
const ATTACH_DIR_SEP = " --dir ";

/**
 * The constant body prefix OmO 5.1.51 prepends when
 * `OPENCODE_SERVER_PASSWORD` is set (index.js:8285-8289, escaped by
 * buildTmuxAttachCommand/buildTmuxPlaceholderCommand at :8391/:8409).
 *
 * It contains no interpolated value, so it is matched byte-exactly. The
 * fragment sources a one-use credential file and deletes it. It is stripped
 * before template parsing; `payload` keeps the original bytes.
 */
const AUTH_FILE_PREFIX_551 =
  '. \\"\\$OPENCODE_SERVER_PASSWORD_FILE\\" && rm -f -- \\"\\$OPENCODE_SERVER_PASSWORD_FILE\\" && ';

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
    const base = {
      argv: [...argv],
      flags,
      payload: payload.payload,
      envArgs,
      description: payload.description,
      descriptionEncoding: payload.descriptionEncoding,
      authFileBacked: payload.authFileBacked,
    };
    switch (verb) {
      case "split-window":
        return { ...base, kind: "placeholder-split" };
      case "new-window":
        return { ...base, kind: "placeholder-newwindow" };
      case "new-session":
        return { ...base, kind: "placeholder-newsession" };
      case "respawn-pane":
        return { ...base, kind: "placeholder-respawn" };
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
      payload: payload.payload,
      envArgs,
      authFileBacked: payload.authFileBacked,
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
 * Split one `NAME=VALUE` assignment on its FIRST `=`.
 *
 * Returns undefined for a bare name with no `=`, and for `=value` with no name.
 * The value is kept whole, so a password containing `=` survives intact.
 *
 * Exported rather than restated per call site: src/descriptor.ts must split
 * env-slot assignments by this same rule, and until it imported this function
 * the only thing tying the two together was a comment claiming they matched.
 */
export function splitAssignment(assignment: string): AuthEnvArg | undefined {
  const separator = assignment.indexOf("=");
  if (separator <= 0) return undefined;
  return { name: assignment.slice(0, separator), value: assignment.slice(separator + 1) };
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
    const pair = splitAssignment(raw);
    if (pair === undefined) return undefined;
    envArgs.push(pair);
    index += 2;
  }

  return { flags, envArgs };
}

// ---------------------------------------------------------------------------
// Payload element
// ---------------------------------------------------------------------------

type ParsedPayload =
  | {
      readonly kind: "placeholder";
      readonly payload: string;
      readonly description: string;
      readonly descriptionEncoding: PlaceholderEncoding;
      readonly authFileBacked: boolean;
    }
  | {
      readonly kind: "attach";
      readonly payload: string;
      readonly serverUrlQuoted: string;
      readonly sessionIdQuoted: string;
      readonly directoryQuoted: string;
      readonly authFileBacked: boolean;
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

  const payload = element.slice(SHELL_PREFIX.length, element.length - 1);
  if (payload.length === 0) return undefined;

  const authFileBacked = payload.startsWith(AUTH_FILE_PREFIX_551);
  const body = authFileBacked ? payload.slice(AUTH_FILE_PREFIX_551.length) : payload;
  if (body.length === 0) return undefined;

  if (body.startsWith(PLACEHOLDER_HEAD) && body.endsWith(PLACEHOLDER_TAIL)) {
    const description = body.slice(
      PLACEHOLDER_HEAD.length,
      body.length - PLACEHOLDER_TAIL.length,
    );
    return {
      kind: "placeholder",
      payload,
      description,
      descriptionEncoding: "escaped-doublequote",
      authFileBacked,
    };
  }

  if (body.startsWith(PLACEHOLDER_PREFIX_535)) {
    const parsed = parsePlaceholder535Body(body);
    return parsed === undefined ? undefined : { ...parsed, payload, authFileBacked };
  }

  if (body.startsWith(ATTACH_HEAD)) {
    const parsed = parseAttachBody(body);
    return parsed === undefined ? undefined : { ...parsed, payload, authFileBacked };
  }

  return undefined;
}

/**
 * 5.1.35 placeholder body: `printf '…' <Q(banner)> <Q(hint)>; while …`.
 *
 * The banner is read as one single-quoted token — the same scanner the attach
 * template uses, so an embedded apostrophe (`'\\''`) does not end it early —
 * and must open with the fixed banner prefix. The remainder after its closing
 * quote must be exactly one space plus the hint tail. Anything else is not
 * this template. The description is the banner's inner text after the prefix,
 * still Q-escaped; decoding is the translator's business.
 */
function parsePlaceholder535Body(
  body: string,
): { readonly kind: "placeholder"; readonly description: string; readonly descriptionEncoding: PlaceholderEncoding } | undefined {
  const banner = readSingleQuotedToken(body, PLACEHOLDER_PREFIX_535.length);
  if (banner === undefined) return undefined;
  if (!banner.token.startsWith(PLACEHOLDER_BANNER_OPEN_535)) return undefined;

  const rest = body.slice(banner.next);
  if (rest !== ` ${PLACEHOLDER_HINT_535}`) return undefined;

  const inner = banner.token.slice(1, -1);
  const description = inner.slice(PLACEHOLDER_BANNER_OPEN_535.length - 1);
  return { kind: "placeholder", description, descriptionEncoding: "singlequote" };
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
): { readonly kind: "attach"; readonly serverUrlQuoted: string; readonly sessionIdQuoted: string; readonly directoryQuoted: string } | undefined {
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