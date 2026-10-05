// argv translator — the heart of the bridge.
//
// Written FIRST, against CONTRACT.md (the specification) and src/grammar.ts (the
// only module allowed to parse argv). This file never re-parses argv itself: it
// feeds literal fixtures to classifyArgv (todo 3) and to translateArgv (todo 9),
// and asserts on exactly what comes out.
//
// What is being pinned here, in order of importance:
//
//   1. `pass-through` is returned byte-identically. `interactive_bash` produces
//      arbitrary LLM-authored argv, and a translator that "helpfully" rewrites
//      an unrecognised verb is worse than no translator at all.
//   2. `--` appears IMMEDIATELY BEFORE the command operand for exactly two
//      classifications (placeholder-respawn, attach-respawn) and nowhere else.
//   3. A credential never appears in the emitted argv, in any element, in any
//      encoding. It travels in numbered process-environment slots only.
//   4. The emitted helper invocation RE-PARSES to the original payload body
//      byte-for-byte, hostile quoting included.
//
// Fixtures are byte-identical to test/grammar.test.ts on purpose: these are
// literal captures of the argv OmO 5.1.18 actually emits.

import { describe, expect, test } from "bun:test";
import { classifyArgv } from "../src/grammar";
import type { Classified, RecognisedKind } from "../src/grammar";
import {
  HELPER_CONTRACT,
  decodeField,
  parseHelperCommandLine,
  translate,
  translateArgv,
  unescapeDoubleQuoted,
  unescapeSingleQuotedToken,
} from "../src/translate";

// ---------------------------------------------------------------------------
// Fixtures — byte-exact, copied from test/grammar.test.ts
// ---------------------------------------------------------------------------

// Template B head/tail as they appear INSIDE the payload body, i.e. between the
// outer double quotes of the payload argv element. Composed here from the
// documented template (index.js:8329) rather than pasted as one opaque literal,
// so that the expectation stays independent of the implementation.
const BODY_HEAD = "printf '%s\\n%s\\n' \\\"OMO subagent pane ready: ";
const BODY_TAIL = "\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done";

const PLAIN_DESCRIPTION = "explore the tmux grammar module";

// The E(description) text OmO's shellEscapeForDoubleQuotedCommand produced.
const HOSTILE_DESCRIPTION = "it's a \\$HOME \\`cmd\\` with \\\"quotes\\\" and \\\\backslash\\\\";
// The raw description, i.e. what a human typed. Unescaping E must recover it.
const HOSTILE_DESCRIPTION_RAW = "it's a $HOME `cmd` with \"quotes\" and \\backslash\\";

const PH_PLAIN_BODY = `${BODY_HEAD}${PLAIN_DESCRIPTION}${BODY_TAIL}`;
const PH_HOSTILE_BODY = `${BODY_HEAD}${HOSTILE_DESCRIPTION}${BODY_TAIL}`;

// Template A bodies (index.js:8325). Q() leaves the apostrophes in place and
// encodes an embedded apostrophe as the five characters ' \ \ ' '.
const AT_PLAIN_BODY =
  "opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'";
const AT_HOSTILE_BODY =
  "opencode attach 'http://127.0.0.1:4096' --session 'ses_'\\\\''x'\\\\''--dir'\\\\''y' --dir '/home/dev/proj'";

const PH_PLAIN = `/bin/sh -c "${PH_PLAIN_BODY}"`;
const PH_HOSTILE = `/bin/sh -c "${PH_HOSTILE_BODY}"`;
const AT_PLAIN = `/bin/sh -c "${AT_PLAIN_BODY}"`;
const AT_HOSTILE = `/bin/sh -c "${AT_HOSTILE_BODY}"`;

// A password-bearing authEnvArgs (:8336, :8339). The sentinel is what must be
// absent from every emitted argv element.
const SENTINEL = "SENTINEL_SECRET_a1b2c3";
const AUTH_ARGS = ["-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`, "-e", "OPENCODE_SERVER_USERNAME=daniel"];

// A space in the user name, so the helper path genuinely needs quoting.
const PSMUX_PATH = "C:\\Users\\Test User\\AppData\\Local\\psmux\\tmux.exe";
const HELPER_PATH =
  "C:\\Users\\Test User\\AppData\\Local\\opencode-psmux-bridge\\runtime\\Start-PaneFromDescriptor.ps1";

const OPTS = { psmuxPath: PSMUX_PATH, helperPath: HELPER_PATH } as const;

// The Windows-native command token vectors the translator must emit. Hand-written
// expectations, never recomputed with the same formula the implementation uses.
const PLAIN_SCRIPT =
  "Write-Output 'OMO subagent pane ready: explore the tmux grammar module'; " +
  "Write-Output 'Focus this pane to attach.'; " +
  "while ($true) { Start-Sleep -Seconds 86400 }";

// Note the doubled apostrophe (PowerShell single-quote escaping) and the
// otherwise-untouched backtick, backslash and double quote.
const HOSTILE_SCRIPT =
  "Write-Output 'OMO subagent pane ready: it''s a $HOME `cmd` with \"quotes\" and \\backslash\\'; " +
  "Write-Output 'Focus this pane to attach.'; " +
  "while ($true) { Start-Sleep -Seconds 86400 }";

const PLACEHOLDER_COMMAND = ["powershell", "-NoProfile", "-NonInteractive", "-Command", PLAIN_SCRIPT];
const PLACEHOLDER_HOSTILE_COMMAND = [
  "powershell",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  HOSTILE_SCRIPT,
];
const ATTACH_COMMAND = [
  "opencode",
  "attach",
  "http://127.0.0.1:4096",
  "--session",
  "ses_abc123",
  "--dir",
  "/home/dev/proj",
];
// Q() reversal: 'ses_'\\''x'\\''--dir'\\''y'  ->  ses_'x'--dir'y
const ATTACH_HOSTILE_COMMAND = [
  "opencode",
  "attach",
  "http://127.0.0.1:4096",
  "--session",
  "ses_'x'--dir'y",
  "--dir",
  "/home/dev/proj",
];

// ---------------------------------------------------------------------------
// The full payload matrix: every classification, every payload shape, both the
// with-`-e` and the (normal) empty-`-e` case.
// ---------------------------------------------------------------------------

interface PayloadCase {
  readonly name: string;
  readonly argv: readonly string[];
  readonly kind: RecognisedKind;
  readonly dashDash: boolean;
  readonly payloadBody: string;
  readonly command: readonly string[];
  readonly envCount: number;
}

const PAYLOAD_CASES: readonly PayloadCase[] = [
  {
    name: "placeholder-split (index.js:8402-8411) with authEnvArgs",
    argv: ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", ...AUTH_ARGS, PH_PLAIN],
    kind: "placeholder-split",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 2,
  },
  {
    name: "placeholder-split with the EMPTY authEnvArgs case (:8334 returns [])",
    argv: ["split-window", "-v", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", PH_PLAIN],
    kind: "placeholder-split",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 0,
  },
  {
    name: "placeholder-split with a hostile description",
    argv: ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%9", PH_HOSTILE],
    kind: "placeholder-split",
    dashDash: false,
    payloadBody: PH_HOSTILE_BODY,
    command: PLACEHOLDER_HOSTILE_COMMAND,
    envCount: 0,
  },
  {
    name: "placeholder-newwindow (index.js:8617-8626)",
    argv: ["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", ...AUTH_ARGS, PH_PLAIN],
    kind: "placeholder-newwindow",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 2,
  },
  {
    name: "placeholder-newwindow targeting an existing session (:8727-8735)",
    argv: ["new-window", "-t", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_PLAIN],
    kind: "placeholder-newwindow",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 0,
  },
  {
    name: "placeholder-newsession with sizeArgs (:8736-8747)",
    argv: [
      "new-session",
      "-d",
      "-s",
      "omo-iso-4711",
      "-x",
      "120",
      "-y",
      "40",
      "-P",
      "-F",
      "#{pane_id}",
      ...AUTH_ARGS,
      PH_PLAIN,
    ],
    kind: "placeholder-newsession",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 2,
  },
  {
    name: "placeholder-newsession with NO sizeArgs (:8721)",
    argv: ["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_PLAIN],
    kind: "placeholder-newsession",
    dashDash: false,
    payloadBody: PH_PLAIN_BODY,
    command: PLACEHOLDER_COMMAND,
    envCount: 0,
  },
  {
    name: "placeholder-respawn (index.js:8501)",
    argv: ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", PH_HOSTILE],
    kind: "placeholder-respawn",
    dashDash: true,
    payloadBody: PH_HOSTILE_BODY,
    command: PLACEHOLDER_HOSTILE_COMMAND,
    envCount: 2,
  },
  {
    name: "attach-respawn (index.js:8548-8555)",
    argv: ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", AT_PLAIN],
    kind: "attach-respawn",
    dashDash: true,
    payloadBody: AT_PLAIN_BODY,
    command: ATTACH_COMMAND,
    envCount: 2,
  },
  {
    name: "attach-respawn with a hostile session id and NO authEnvArgs",
    argv: ["respawn-pane", "-k", "-t", "%7", AT_HOSTILE],
    kind: "attach-respawn",
    dashDash: true,
    payloadBody: AT_HOSTILE_BODY,
    command: ATTACH_HOSTILE_COMMAND,
    envCount: 0,
  },
];

/** The flags a case must survive with, in order, with `-e` pairs removed. */
function expectedFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  const head = argv.slice(1, -1);
  let index = 0;
  while (index < head.length) {
    const element = head[index];
    if (element === undefined) throw new Error("unreachable");
    if (element === "-e") {
      index += 2;
      continue;
    }
    out.push(element);
    index += 1;
  }
  return out;
}

function classify(argv: readonly string[]): Classified {
  return classifyArgv(argv);
}

// ---------------------------------------------------------------------------
// 0. The fixtures themselves must be what the grammar recognises
// ---------------------------------------------------------------------------

describe("fixture corpus integrity", () => {
  test("every payload fixture classifies as its declared kind", () => {
    for (const testCase of PAYLOAD_CASES) {
      expect(classify(testCase.argv).kind).toBe(testCase.kind);
    }
  });

  test("every payload fixture's body is exactly what sits between the outer quotes", () => {
    const payload = testCase_last(PH_PLAIN);
    expect(payload).toBe(PH_PLAIN_BODY);
    expect(testCase_last(PH_HOSTILE)).toBe(PH_HOSTILE_BODY);
    expect(testCase_last(AT_PLAIN)).toBe(AT_PLAIN_BODY);
    expect(testCase_last(AT_HOSTILE)).toBe(AT_HOSTILE_BODY);
    // And the fixtures really do carry the hostile characters.
    expect(HOSTILE_DESCRIPTION).toContain("it's");
    expect(HOSTILE_DESCRIPTION).toContain("\\$");
    expect(HOSTILE_DESCRIPTION).toContain("\\`");
    expect(HOSTILE_DESCRIPTION).toContain('\\"');
    expect(HOSTILE_DESCRIPTION).toContain("\\\\");
  });
});

function testCase_last(element: string): string {
  return element.slice('/bin/sh -c "'.length, element.length - 1);
}

// ---------------------------------------------------------------------------
// 1. pass-through — the guarantee that must never regress
// ---------------------------------------------------------------------------

describe("pass-through — argv comes back untouched", () => {
  // The adversarial case: argv that LOOKS like a payload on a verb that does not
  // carry one. This is the `interactive_bash` surface, where an LLM authors argv.
  const ADVERSARIAL: ReadonlyArray<readonly string[]> = [
    ["send-keys", "-t", "%1", '/bin/sh -c "echo hi"'],
    ["display", "-p", "-e", "A=B"],
    ["select-pane", "-t", "%7", "-T", "omo-subagent-explore the tm"],
    ["send-keys", "-t", "%3", "C-c"],
    ["display", "-p", "-t", "%1", "#{window_width}"],
    ["set-window-option", "-g", "main-pane-height", "50%"],
    ["resize-pane", "-t", "%1", "-x", "109"],
    ["has-session", "-t", "omo-iso-4711"],
    ["list-sessions", "-F", "#{session_name}"],
    // respawn-window is OFF-PATH (CONTRACT.md 7.3) and carries no payload, but an
    // agent could still send it. It must not be "helpfully" given a `--`.
    ["respawn-window", "-k", "-t", "%1", '/bin/sh -c "echo hi"'],
    // A right verb whose last element merely contains the payload text.
    ["split-window", "-h", "bash", "-lc", "printf hello"],
    ["split-window", "-h", '-d', "-P", "-F", "#{pane_id}", "/bin/sh -c"],
    // Truncated / malformed payloads.
    ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", '/bin/sh -c "printf \'x'],
    ["respawn-pane", "-k", "-t", "%7", "/bin/sh -c \"printf '%s\\n%s\\n' \"OMO subagent"],
    ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-e"],
    ["split-window", "-h", "-d", "-e", PH_PLAIN],
    ["split-window", "-h", "-d", "-e", "OPENCODE_SERVER_PASSWORD", PH_PLAIN],
    // Degenerate arity.
    [],
    ["new-window"],
    // An option-looking value and an empty string.
    ["send-keys", "-t", "%1", ""],
    ["send-keys", "-t", "--", "/bin/sh -c \"echo hi\""],
  ];

  test("every adversarial argv comes back deep-equal, in original order", () => {
    for (const input of ADVERSARIAL) {
      const before = [...input];
      const translation = translateArgv(classify(input), OPTS);

      expect(translation.kind).toBe("passthrough");
      expect(translation.rewritten).toBe(false);
      expect(translation.dashDashInserted).toBe(false);
      expect(translation.envSlots).toEqual([]);
      expect(translation.envSlotCount).toBe(0);
      expect(translation.helperCommandLine).toBeUndefined();
      expect(translation.correlationId).toBeUndefined();

      expect(translation.argv).toEqual(before);
      expect(translation.argv).toHaveLength(before.length);
      expect(input).toEqual(before);

      // No `--` was invented. One input already contained one (an agent sending
      // keys to a literal `--`), so the count must MATCH the input's, not be zero.
      expect(translation.argv.filter((element) => element === "--")).toEqual(
        before.filter((element) => element === "--"),
      );
      // No helper was substituted anywhere.
      expect(translation.argv.filter((element) => element.includes(HELPER_PATH))).toEqual([]);
    }
  });

  test("the two named false-positive cases are reported with their real arrays", () => {
    const sendKeys = ["send-keys", "-t", "%1", '/bin/sh -c "echo hi"'];
    const display = ["display", "-p", "-e", "A=B"];

    const sentKeysOut = translateArgv(classify(sendKeys), OPTS);
    const displayOut = translateArgv(classify(display), OPTS);

    console.log("[false-positive-translation] BEFORE send-keys:", JSON.stringify(sendKeys));
    console.log("[false-positive-translation] AFTER  send-keys:", JSON.stringify(sentKeysOut.argv));
    console.log("[false-positive-translation] BEFORE display   :", JSON.stringify(display));
    console.log("[false-positive-translation] AFTER  display   :", JSON.stringify(displayOut.argv));

    expect(sentKeysOut.argv).toEqual(sendKeys);
    expect(displayOut.argv).toEqual(display);
    // The literal payload-looking string is still sitting there, untouched.
    expect(sentKeysOut.argv[3]).toBe('/bin/sh -c "echo hi"');
    expect(displayOut.argv[3]).toBe("A=B");
    expect(sentKeysOut.argv).not.toContain("--");
    expect(displayOut.argv).not.toContain("--");
  });

  test("pass-through does not alias the caller's array", () => {
    const input = ["send-keys", "-t", "%1", "C-c"];
    const translation = translateArgv(classify(input), OPTS);

    expect(translation.argv).not.toBe(input);
    expect(translation.argv).toEqual(input);
  });

  test("a credential-bearing pass-through is NOT scrubbed — verbatim is the contract", () => {
    // The bridge is not a redactor. If OmO put a secret in argv on a pass-through
    // path, rewriting it would be a behaviour change psmux never agreed to.
    const input = ["display", "-p", "-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`];
    const translation = translateArgv(classify(input), OPTS);

    expect(translation.argv).toEqual(input);
    expect(translation.argv.join("\n")).toContain(SENTINEL);
    expect(translation.envSlots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. `--` placement: exactly two classifications, immediately before the operand
// ---------------------------------------------------------------------------

describe("-- insertion", () => {
  test("`--` precedes the command operand for exactly the two respawn forms", () => {
    for (const testCase of PAYLOAD_CASES) {
      const translation = translateArgv(classify(testCase.argv), OPTS);

      const separators = translation.argv.filter((element) => element === "--");
      if (testCase.dashDash) {
        expect(separators).toHaveLength(1);
        // IMMEDIATELY before the command operand, i.e. the final element.
        expect(translation.argv[translation.argv.length - 2]).toBe("--");
        expect(translation.dashDashInserted).toBe(true);
      } else {
        expect(separators).toEqual([]);
        expect(translation.argv).not.toContain("--");
        expect(translation.dashDashInserted).toBe(false);
      }
    }
  });

  test("exactly two of the six classifications insert `--`", () => {
    const kinds = new Set(PAYLOAD_CASES.map((testCase) => testCase.kind));
    const inserting = new Set(
      PAYLOAD_CASES.filter((testCase) => testCase.dashDash).map((testCase) => testCase.kind),
    );

    expect([...kinds].sort()).toEqual([
      "attach-respawn",
      "placeholder-newsession",
      "placeholder-newwindow",
      "placeholder-respawn",
      "placeholder-split",
    ]);
    expect([...inserting].sort()).toEqual(["attach-respawn", "placeholder-respawn"]);
  });

  test("the emitted respawn argv is verb, flags, `--`, command line — nothing after", () => {
    const translation = translateArgv(classify(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]), OPTS);

    if (translation.kind !== "helper") throw new Error("a payload argv must translate to the helper form");
    const commandLine = translation.helperCommandLine;
    if (commandLine === undefined) throw new Error("a helper translation must carry a command line");

    // Six, not five: the payload is REPLACED one-for-one by the command operand
    // and `--` is INSERTED before it (CONTRACT.md 7.1), so the head grows by one.
    expect(translation.argv).toEqual(["respawn-pane", "-k", "-t", "%7", "--", commandLine]);
    expect(translation.argv).toHaveLength(6);
    // Nothing follows the command line, and `--` sits immediately before it.
    expect(translation.argv.at(-1)).toBe(commandLine);
    expect(translation.argv.indexOf("--")).toBe(4);
    expect(translation.argv.slice(-2, -1)).toEqual(["--"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Flag preservation: nothing stripped, nothing reordered, nothing altered
// ---------------------------------------------------------------------------

describe("flag preservation", () => {
  test("every non-`-e` element survives, in order, ahead of the command operand", () => {
    for (const testCase of PAYLOAD_CASES) {
      const translation = translateArgv(classify(testCase.argv), OPTS);

      const verb = testCase.argv[0];
      if (verb === undefined) throw new Error(`fixture "${testCase.name}" has no verb element`);

      const head = translation.argv.slice(0, translation.argv.length - 1 - (testCase.dashDash ? 1 : 0));
      expect(head).toEqual([verb, ...expectedFlags(testCase.argv)]);
    }
  });

  test("the protected flags keep their exact text and their operands", () => {
    const translation = translateArgv(classify(PAYLOAD_CASES[5]?.argv ?? []), OPTS);

    // new-session -d -s omo-iso-4711 -x 120 -y 40 -P -F #{pane_id}
    expect(translation.argv).toContain("-d");
    expect(translation.argv).toContain("-s");
    expect(translation.argv).toContain("omo-iso-4711");
    expect(translation.argv).toContain("-x");
    expect(translation.argv).toContain("120");
    expect(translation.argv).toContain("-y");
    expect(translation.argv).toContain("40");
    expect(translation.argv).toContain("-P");
    expect(translation.argv).toContain("-F");
    expect(translation.argv).toContain("#{pane_id}");
    // No -e pair is left anywhere in the argv.
    expect(translation.argv).not.toContain("-e");
  });

  test("`-c <dir>` on a payload form is forwarded untouched", () => {
    const argv = ["split-window", "-h", "-c", "C:\\work\\proj", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.argv).toContain("-c");
    expect(translation.argv).toContain("C:\\work\\proj");
    expect(translation.argv.indexOf("-c")).toBe(translation.argv.indexOf("C:\\work\\proj") - 1);
  });

  test("the window name literal `omo-agents` is not renamed", () => {
    const argv = ["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.argv[translation.argv.indexOf("-n") + 1]).toBe("omo-agents");
  });
});

// ---------------------------------------------------------------------------
// 4. Round-trip: re-parsing the emitted invocation yields the payload byte-for-byte
// ---------------------------------------------------------------------------

describe("round-trip byte identity", () => {
  test("`--payload` decodes to the original payload body for every case", () => {
    for (const testCase of PAYLOAD_CASES) {
      const translation = translateArgv(classify(testCase.argv), OPTS);
      const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");

      expect(invocation.payload).toBe(testCase.payloadBody);
      expect(invocation.payload.length).toBe(testCase.payloadBody.length);
      // Encoding must be lossless at the byte level, not merely the string level.
      expect(decodeField(encodeFieldOf(testCase.payloadBody))).toBe(testCase.payloadBody);
    }
  });

  test("`--command` decodes to the expected Windows-native token vector", () => {
    for (const testCase of PAYLOAD_CASES) {
      const translation = translateArgv(classify(testCase.argv), OPTS);
      const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");

      expect(invocation.command).toEqual(testCase.command);
    }
  });

  test("the hostile placeholder survives the whole round trip byte-for-byte", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%9", PH_HOSTILE];
    const translation = translateArgv(classify(argv), OPTS);
    const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");

    expect(invocation.payload).toBe(PH_HOSTILE_BODY);
    expect(invocation.payload).toContain("it's a");
    expect(invocation.payload).toContain("\\$HOME");
    expect(invocation.payload).toContain("\\`cmd\\`");
    expect(invocation.payload).toContain('\\"quotes\\"');
    expect(invocation.payload).toContain("\\\\backslash\\\\");

    // And the human-authored description is recoverable from the command vector.
    expect(invocation.command[4]).toBe(HOSTILE_SCRIPT);
    expect(invocation.command[4]).toContain("it''s a");
  });

  test("the hostile attach session id is recovered exactly", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", AT_HOSTILE];
    const translation = translateArgv(classify(argv), OPTS);
    const invocation = parseHelperCommandLine(translation.helperCommandLine ?? "");

    expect(invocation.payload).toBe(AT_HOSTILE_BODY);
    expect(invocation.command).toEqual(ATTACH_HOSTILE_COMMAND);
    // A naive split on ` --dir ` would have produced `ses_'x'` here.
    expect(invocation.command[4]).toBe("ses_'x'--dir'y");
  });
});

// ---------------------------------------------------------------------------
// 5. Q / E reversal, tested directly
// ---------------------------------------------------------------------------

describe("escaping reversal", () => {
  test("unescapeDoubleQuoted recovers the raw description from E(description)", () => {
    expect(unescapeDoubleQuoted(HOSTILE_DESCRIPTION)).toBe(HOSTILE_DESCRIPTION_RAW);
    expect(unescapeDoubleQuoted(PLAIN_DESCRIPTION)).toBe(PLAIN_DESCRIPTION);
    expect(unescapeDoubleQuoted("")).toBe("");
    // A lone trailing backslash is not an escape and survives as itself.
    expect(unescapeDoubleQuoted("a\\")).toBe("a\\");
  });

  test("unescapeSingleQuotedToken recovers the raw value from Q(value)", () => {
    expect(unescapeSingleQuotedToken("'ses_abc123'")).toBe("ses_abc123");
    expect(unescapeSingleQuotedToken("'http://127.0.0.1:4096'")).toBe("http://127.0.0.1:4096");
    expect(unescapeSingleQuotedToken("'/home/dev/proj'")).toBe("/home/dev/proj");
    expect(unescapeSingleQuotedToken("'ses_'\\\\''x'\\\\''--dir'\\\\''y'")).toBe("ses_'x'--dir'y");
    // Backslashes survive the blanket doubling pass.
    expect(unescapeSingleQuotedToken("'C:\\\\Users\\\\dev'")).toBe("C:\\Users\\dev");
    expect(unescapeSingleQuotedToken("''")).toBe("");
  });
});

function encodeFieldOf(text: string): string {
  return HELPER_CONTRACT.encode(text);
}

// ---------------------------------------------------------------------------
// 6. The helper invocation contract (this is todo 11's interface)
// ---------------------------------------------------------------------------

describe("helper invocation contract", () => {
  test("the command line starts with the shell and the five documented flags", () => {
    const translation = translateArgv(classify(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]), OPTS);
    const line = translation.helperCommandLine ?? "";

    expect(line.startsWith("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ")).toBe(
      true,
    );
    // The helper path is quoted, because %LOCALAPPDATA% may contain a space.
    expect(line.includes(`"${HELPER_PATH}"`)).toBe(true);
  });

  test("the exact flag sequence is payload, command, [cwd], env-slots, [correlation]", () => {
    const translation = translateArgv(classify(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]), OPTS);
    const flags = commandLineFlags(translation.helperCommandLine ?? "");

    expect(flags).toEqual(["--payload", "--command", "--env-slots"]);
  });

  test("a caller-supplied shell path is used verbatim", () => {
    const translation = translateArgv(classify(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]), {
      ...OPTS,
      shellPath: "pwsh",
    });

    expect((translation.helperCommandLine ?? "").startsWith("pwsh -NoProfile ")).toBe(true);
    expect(parseHelperCommandLine(translation.helperCommandLine ?? "").shell).toBe("pwsh");
  });

  test("`--cwd` is absent unless the caller supplies one, and then it round-trips", () => {
    const without = translateArgv(classify(["split-window", "-h", PH_PLAIN]), OPTS);
    expect(commandLineFlags(without.helperCommandLine ?? "")).toEqual(["--payload", "--command", "--env-slots"]);
    expect(parseHelperCommandLine(without.helperCommandLine ?? "").cwd).toBeUndefined();

    const withCwd = translateArgv(classify(["split-window", "-h", PH_PLAIN]), {
      ...OPTS,
      cwd: "C:\\Users\\Test User\\work dir",
    });
    expect(commandLineFlags(withCwd.helperCommandLine ?? "")).toEqual([
      "--payload",
      "--command",
      "--cwd",
      "--env-slots",
    ]);
    expect(parseHelperCommandLine(withCwd.helperCommandLine ?? "").cwd).toBe("C:\\Users\\Test User\\work dir");
  });

  test("`--correlation` is absent by default and present when supplied", () => {
    const bare = translateArgv(classify(["split-window", "-h", PH_PLAIN]), OPTS);
    expect(commandLineFlags(bare.helperCommandLine ?? "")).not.toContain("--correlation");
    expect(bare.correlationId).toBeUndefined();

    const correlated = translateArgv(classify(["split-window", "-h", PH_PLAIN]), {
      ...OPTS,
      correlationId: "corr-0001",
    });
    expect(commandLineFlags(correlated.helperCommandLine ?? "")).toContain("--correlation");
    expect(parseHelperCommandLine(correlated.helperCommandLine ?? "").correlationId).toBe("corr-0001");
    expect(correlated.correlationId).toBe("corr-0001");
  });

  test("the emitted fields are base64url and therefore need no quoting", () => {
    const translation = translateArgv(classify(["split-window", "-h", PH_PLAIN]), OPTS);
    const line = translation.helperCommandLine ?? "";

    for (const field of ["--payload", "--command"]) {
      const index = line.indexOf(`${field} `);
      expect(index).toBeGreaterThan(-1);
      const value = line.slice(index + field.length + 1).split(" ")[0] ?? "";
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("parseHelperCommandLine rejects a line that is not a helper invocation", () => {
    expect(() => parseHelperCommandLine("powershell -NoProfile")).toThrow();
    expect(() => parseHelperCommandLine("")).toThrow();
    expect(() => parseHelperCommandLine("powershell -File x --payload")).toThrow();
  });
});

/** The flag names, in order, from a helper command line. */
function commandLineFlags(line: string): string[] {
  return tokeniseCommandLine(line).filter((token) => token.startsWith("--"));
}

/** Split on spaces, honouring double-quoted runs. */
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
// 7. FAILURE CASE 1 — the credential leak
// ---------------------------------------------------------------------------

describe("credentials never reach argv", () => {
  test("the sentinel is absent from every emitted element, for every payload shape", () => {
    for (const testCase of PAYLOAD_CASES) {
      const withSecret = [...testCase.argv];
      // Re-stamp the sentinel into every authEnvArgs slot the case carries.
      for (let index = 0; index < withSecret.length - 1; index += 1) {
        const element = withSecret[index];
        if (element === "-e" && (withSecret[index + 1] ?? "").startsWith("OPENCODE_SERVER_PASSWORD=")) {
          withSecret[index + 1] = `OPENCODE_SERVER_PASSWORD=${SENTINEL}`;
        }
      }

      const translation = translateArgv(classify(withSecret), OPTS);

      for (const element of translation.argv) {
        expect(element).not.toContain(SENTINEL);
        expect(element).not.toContain("OPENCODE_SERVER_PASSWORD");
        expect(element).not.toMatch(/[A-Za-z0-9_-]*PASSWORD[A-Za-z0-9_-]*\s*=/i);
      }
      expect(translation.argv.join("\n")).not.toContain(SENTINEL);
      // The original payload text is gone too: it is replaced, not appended to.
      expect(translation.argv.join("\n")).not.toContain('/bin/sh -c "');
      // And the `-e` flag itself is not forwarded to psmux on ANY payload form.
      expect(translation.argv).not.toContain("-e");
    }
  });

  test("the emitted argv is printed so the sentinel's absence is visible", () => {
    const argv = [
      "respawn-pane",
      "-k",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
      "-e",
      "OPENCODE_SERVER_USERNAME=daniel",
      "-t",
      "%7",
      AT_PLAIN,
    ];
    const translation = translateArgv(classify(argv), OPTS);

    console.log("[credential-leak] IN  argv     :", JSON.stringify(argv));
    console.log("[credential-leak] OUT argv     :", JSON.stringify(translation.argv));
    console.log("[credential-leak] OUT cmdline  :", translation.helperCommandLine);
    console.log(
      "[credential-leak] OUT env slots :",
      JSON.stringify(translation.envSlots.map((slot) => slot.variable)),
    );
    console.log("[credential-leak] OUT slot 0 is :", translation.envSlots[0]?.variable, "(value withheld)");

    const rendered = JSON.stringify(translation.argv) + (translation.helperCommandLine ?? "");
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain("daniel");
  });

  test("the credential travels in numbered env slots the helper reads", () => {
    const argv = [
      "respawn-pane",
      "-k",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
      "-t",
      "%7",
      AT_PLAIN,
    ];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.envSlotCount).toBe(1);
    expect(translation.envSlots).toHaveLength(1);
    expect(translation.envSlots[0]?.index).toBe(0);
    expect(translation.envSlots[0]?.variable).toBe("OMO_PANE_ENV_0");
    expect(translation.envSlots[0]?.assignment).toBe(`OPENCODE_SERVER_PASSWORD=${SENTINEL}`);
    expect(parseHelperCommandLine(translation.helperCommandLine ?? "").envSlotCount).toBe(1);
  });

  test("the EMPTY authEnvArgs case emits zero slots and says so in the argv", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.envSlots).toEqual([]);
    expect(translation.envSlotCount).toBe(0);
    expect(translation.helperCommandLine).toContain("--env-slots 0");
    expect(parseHelperCommandLine(translation.helperCommandLine ?? "").envSlotCount).toBe(0);
  });

  test("slot names are positional and predictable, so the helper needs no manifest", () => {
    const argv = [
      "new-session",
      "-d",
      "-s",
      "omo-iso-4711",
      "-P",
      "-F",
      "#{pane_id}",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
      "-e",
      "OPENCODE_SERVER_USERNAME=daniel",
      PH_PLAIN,
    ];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.envSlots.map((slot) => slot.variable)).toEqual([
      "OMO_PANE_ENV_0",
      "OMO_PANE_ENV_1",
    ]);
    expect(translation.envSlots.map((slot) => slot.index)).toEqual([0, 1]);
    expect(translation.envSlots[1]?.assignment).toBe("OPENCODE_SERVER_USERNAME=daniel");
    expect(translation.helperCommandLine).toContain("--env-slots 2");
  });

  test("an -e value containing `=` and spaces is preserved whole in the slot", () => {
    const argv = [
      "respawn-pane",
      "-k",
      "-e",
      "OPENCODE_SERVER_PASSWORD=a b=c d",
      "-t",
      "%7",
      PH_PLAIN,
    ];
    const translation = translateArgv(classify(argv), OPTS);

    expect(translation.envSlots[0]?.assignment).toBe("OPENCODE_SERVER_PASSWORD=a b=c d");
    // Only the FIRST `=` separates, so the helper splits on indexOf, not on split.
    expect(translation.envSlots[0]?.assignment.indexOf("=")).toBe(
      "OPENCODE_SERVER_PASSWORD".length,
    );
  });

  test("an empty -e value is preserved as an empty string, not dropped", () => {
    const translation = translateArgv(classify(["new-window", "-e", "OPENCODE_SERVER_PASSWORD=", PH_PLAIN]), OPTS);

    expect(translation.envSlotCount).toBe(1);
    expect(translation.envSlots[0]?.assignment).toBe("OPENCODE_SERVER_PASSWORD=");
  });
});

// ---------------------------------------------------------------------------
// 8. Shape of the returned value
// ---------------------------------------------------------------------------

describe("translation result", () => {
  test("a payload translation reports kind, psmuxPath and the command line", () => {
    const translation = translate(["respawn-pane", "-k", "-t", "%7", AT_PLAIN], OPTS);

    expect(translation.kind).toBe("helper");
    expect(translation.rewritten).toBe(true);
    expect(translation.psmuxPath).toBe(PSMUX_PATH);
    expect(typeof translation.helperCommandLine).toBe("string");
  });

  test("the result never carries the original payload or any env value in a loggable field", () => {
    const argv = [
      "respawn-pane",
      "-k",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
      "-t",
      "%7",
      AT_PLAIN,
    ];
    const translation = translate(argv, OPTS);

    // Only `envSlots` holds the credential, and it is documented as sensitive.
    expect(Object.keys(translation).sort()).toEqual([
      "argv",
      "correlationId",
      "dashDashInserted",
      "envSlotCount",
      "envSlots",
      "helperCommandLine",
      "kind",
      "psmuxPath",
      "rewritten",
    ]);
  });

  test("translation is deterministic across repeated calls", () => {
    const argv = ["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_HOSTILE];

    expect(translate(argv, OPTS)).toEqual(translate(argv, OPTS));
  });

  test("translating does not mutate the caller's argv or the Classified value", () => {
    const argv = ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", PH_PLAIN];
    const snapshot = [...argv];
    const classified = classify(argv);
    const classifiedSnapshot = JSON.stringify(classified);

    translateArgv(classified, OPTS);

    expect(argv).toEqual(snapshot);
    expect(JSON.stringify(classified)).toBe(classifiedSnapshot);
  });

  test("translate() and translateArgv(classifyArgv(x)) agree", () => {
    for (const testCase of PAYLOAD_CASES) {
      expect(translate(testCase.argv, OPTS)).toEqual(translateArgv(classify(testCase.argv), OPTS));
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Boundaries the translated payload must never cross
// ---------------------------------------------------------------------------

describe("no shell wrapper, no cat special case", () => {
  test("the command line never begins with `cat`, which psmux special-cases", () => {
    for (const testCase of PAYLOAD_CASES) {
      const translation = translateArgv(classify(testCase.argv), OPTS);
      const line = translation.helperCommandLine ?? "";

      expect(line.startsWith("cat")).toBe(false);
      expect(line.startsWith("/bin/sh")).toBe(false);
      expect(line.startsWith("bash")).toBe(false);
      expect(line).toContain("powershell");
      // The POSIX shell text survives only as an opaque, encoded provenance field.
      expect(line).not.toContain("/bin/sh");
    }
  });

  test("the emitted command operand is ONE argv element, because psmux joins the `--` tail", () => {
    // CONTRACT.md 7.1: connection.rs:2103 reads
    //   args.iter().position(|a| *a == "--").map(|i| args[i+1..].join(" "))
    // so anything after `--` is collapsed into one string. A multi-element tail
    // would be re-joined with single spaces and the quoting destroyed.
    const translation = translateArgv(classify(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]), OPTS);
    const tail = translation.argv.slice(translation.argv.indexOf("--") + 1);

    expect(tail).toHaveLength(1);
  });
});
