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
      "followUps",
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

// ---------------------------------------------------------------------------
// 10. THE LAYOUT RULES — the three carve-outs from pass-through
// ---------------------------------------------------------------------------
//
// `set-window-option main-pane-width 50%` and `resize-pane -t %1 -x 99` USED to
// sit in the ADVERSARIAL array above, asserting byte-identical pass-through. Both
// assertions are withdrawn, deliberately, because forwarding them is what produces
// the reported geometry: a 197-column main pane and 2-column subagent panes.
//
// The fixtures here are the argv OmO 5.1.18 actually emits for the layout, in
// order, after every subagent spawn and after every subagent close:
//
//   1. index.js:8914  ["select-layout", "main-vertical"]
//   2. index.js:8921  ["set-window-option", dimension, `${mainPaneSize}%`]
//   3. index.js:8937  ["resize-pane", "-t", mainPaneId, "-x", String(mainWidth)]
//
// and every test here is pinned to a psmux defect: `options.rs:527` parses the
// value as `u16` so `"50%"` never lands, `layout.rs:1094-1096` reads the option
// only from inside `apply_layout`, and `window_ops.rs:1771-1796` writes a cell
// count into a PERCENTAGE array (`layout.rs:1136`). CONTRACT.md 3.9 records the
// rules; section 9 there records why the re-applied layout carries no `-t`.

/** The layout trio as OmO emits it, with `-L <ns>` so the leading globals and
 *  their propagation onto BOTH commands are visible in every assertion below. */
const LAYOUT_OPTS = { ...OPTS, leadingGlobals: ["-L", "ns"] } as const;

describe("layout rule 1a: one trailing `%` is stripped from a main-pane sizing option", () => {
  test("`set-window-option main-pane-width 50%` becomes `50`, with `select-layout main-vertical` as the follow-up", () => {
    const translation = translate(["set-window-option", "main-pane-width", "50%"], LAYOUT_OPTS);

    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "main-pane-width", "50"]);
    expect(translation.kind).toBe("passthrough");
    expect(translation.rewritten).toBe(true);
    // Not a payload form, so nothing else about the translation changes.
    expect(translation.dashDashInserted).toBe(false);
    expect(translation.helperCommandLine).toBeUndefined();
    expect(translation.envSlotCount).toBe(0);

    // The follow-up is what makes the stripped value MEAN anything: psmux reads
    // `main_pane_width` only from inside `apply_layout`.
    expect(translation.followUps).toHaveLength(1);
    expect(translation.followUps[0]?.argv).toEqual(["-L", "ns", "select-layout", "main-vertical"]);
    expect(translation.followUps[0]?.reason).toBe(
      "psmux-reads-main-pane-size-only-inside-apply-layout",
    );
  });

  test("`main-pane-height` maps to `main-horizontal`, because that is the layout that reads it", () => {
    const translation = translate(["set-window-option", "main-pane-height", "50%"], LAYOUT_OPTS);

    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "main-pane-height", "50"]);
    expect(translation.followUps[0]?.argv).toEqual(["-L", "ns", "select-layout", "main-horizontal"]);
  });

  test("a value with no `%` is forwarded byte-identically and asks for no follow-up", () => {
    // psmux parses a bare number fine, so there is no defect to work around and
    // therefore nothing to rewrite. Emitting a follow-up here would be a second
    // unrequested layout application on a command the contract says is untouched.
    const translation = translate(["set-window-option", "main-pane-width", "50"], LAYOUT_OPTS);

    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "main-pane-width", "50"]);
    expect(translation.kind).toBe("passthrough");
    expect(translation.rewritten).toBe(false);
    expect(translation.followUps).toEqual([]);
  });

  test("exactly ONE trailing `%` comes off, so `50%%` becomes `50%`", () => {
    const translation = translate(["set-window-option", "main-pane-width", "50%%"], LAYOUT_OPTS);

    expect(translation.argv.at(-1)).toBe("50%");
    expect(translation.followUps).toHaveLength(1);
  });

  test("a non-sizing option is forwarded byte-identically, `%` and all", () => {
    // `status` is a STRING option (`src/server/options.rs:71-74`, arms that yield
    // `"off"` / `"on"` / a line count), so a `%` in some other option's value is
    // not this defect. Rewriting it would be rewriting a command nobody measured.
    for (const option of ["status", "window-size", "mode-keys"]) {
      const translation = translate(["set-window-option", "-g", option, "50%"], LAYOUT_OPTS);

      expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "-g", option, "50%"]);
      expect(translation.rewritten).toBe(false);
      expect(translation.followUps).toEqual([]);
    }
  });

  test("all four set-option spellings are handled, because psmux accepts all four", () => {
    for (const verb of ["set-window-option", "setw", "set-option", "set"]) {
      const translation = translate([verb, "main-pane-width", "50%"], LAYOUT_OPTS);

      expect(translation.argv).toEqual(["-L", "ns", verb, "main-pane-width", "50"]);
      expect(translation.followUps[0]?.argv).toEqual(["-L", "ns", "select-layout", "main-vertical"]);
    }
  });

  test("`-g` and `-t <target>` keep their positions, and NO follow-up is invented", () => {
    const translation = translate(
      ["set-window-option", "-t", "%4", "-g", "main-pane-width", "50%"],
      LAYOUT_OPTS,
    );

    // Only the VALUE moved. The verb, the flag order, and the target are byte-identical.
    expect(translation.argv).toEqual([
      "-L",
      "ns",
      "set-window-option",
      "-t",
      "%4",
      "-g",
      "main-pane-width",
      "50",
    ]);
    expect(translation.argv.indexOf("-t")).toBe(3);
    expect(translation.argv.indexOf("-g")).toBe(5);
    // BEHAVIOUR CHANGE. This test used to assert that the follow-up existed and
    // merely did not leak `-t`/`%4` into it. It no longer exists at all. The
    // follow-up is now gated on `flagless`, i.e. on OmO's own three-element shape
    // (`index.js:8921`), and this argv has two flags. Asserting the leak-absence
    // on a command that gets no follow-up was asserting a weaker property than
    // the one that actually matters: that the bridge invents nothing here.
    expect(translation.followUps).toEqual([]);
    // Rule 1a is NOT gated the same way — the `%` still comes off. Stripping is
    // always the safe direction; only the layout change is restricted.
    expect(translation.rewritten).toBe(true);
  });

  test("leading globals land on BOTH commands, so the re-layout reaches the same server", () => {
    const translation = translate(["set-window-option", "main-pane-width", "50%"], {
      ...OPTS,
      leadingGlobals: ["-L", "ns", "-f", "C:\\conf\\psmux.cfg"],
    });

    expect(translation.argv).toEqual([
      "-L",
      "ns",
      "-f",
      "C:\\conf\\psmux.cfg",
      "set-window-option",
      "main-pane-width",
      "50",
    ]);
    expect(translation.followUps[0]?.argv).toEqual([
      "-L",
      "ns",
      "-f",
      "C:\\conf\\psmux.cfg",
      "select-layout",
      "main-vertical",
    ]);
  });

  test("a `-t` with no value, and a sizing option with no value, are both left alone", () => {
    // The walk cannot find a value, so it forwards rather than guessing. psmux
    // produces its own diagnostic; a rewrite of a half-understood command would
    // be silent.
    const danglingTarget = translate(["set-window-option", "-t"], LAYOUT_OPTS);
    expect(danglingTarget.argv).toEqual(["-L", "ns", "set-window-option", "-t"]);
    expect(danglingTarget.followUps).toEqual([]);

    const noValue = translate(["set-window-option", "main-pane-width"], LAYOUT_OPTS);
    expect(noValue.argv).toEqual(["-L", "ns", "set-window-option", "main-pane-width"]);
    expect(noValue.followUps).toEqual([]);
  });

  test("OmO's own un-targeted `select-layout` is still pass-through, with no follow-up of its own", () => {
    const translation = translate(["select-layout", "main-vertical"], LAYOUT_OPTS);

    expect(translation.kind).toBe("passthrough");
    expect(translation.argv).toEqual(["-L", "ns", "select-layout", "main-vertical"]);
    expect(translation.rewritten).toBe(false);
    expect(translation.followUps).toEqual([]);
  });
});

describe("layout rule 1b: the follow-up fires ONLY for the exact shape OmO emits", () => {
  // The gate is `flagless` — verb, option name, value, nothing else — because
  // that is byte-for-byte what `index.js:8921` spawns, and because a per-argv
  // pure translator CANNOT know what layout the previous separate invocation left
  // behind. `select-layout main-vertical` (index.js:8914) and this command are two
  // different processes, so nothing in this argv names the current layout.
  //
  // The point of every test below is therefore not "did the `%` get stripped" but
  // "did the bridge invent a `select-layout` nobody asked for". Stripping is gated
  // wide and deliberately stays that way; only the layout change is restricted.

  test("the POSITIVE case: the bare three-element shape still gets exactly one follow-up", () => {
    const translation = translate(["set-window-option", "main-pane-width", "50%"], OPTS);

    expect(translation.argv).toEqual(["set-window-option", "main-pane-width", "50"]);
    expect(translation.followUps).toHaveLength(1);
    expect(translation.followUps[0]?.argv).toEqual(["select-layout", "main-vertical"]);
    expect(translation.followUps[0]?.reason).toBe(
      "psmux-reads-main-pane-size-only-inside-apply-layout",
    );
  });

  test("`set-window-option -u main-pane-width 50%`: the `%` IS stripped, and no follow-up is invented", () => {
    // psmux routes `-u` to `CtrlReq::SetOptionUnset` (`src/server/mod.rs:459-463`),
    // whose handler only removes `@`-prefixed user options. The unset is itself a
    // no-op and `main-pane-width` is never read by anything — so a follow-up here
    // would re-lay-out the window on the strength of a command that did nothing.
    const translation = translate(["set-window-option", "-u", "main-pane-width", "50%"], LAYOUT_OPTS);

    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "-u", "main-pane-width", "50"]);
    expect(translation.rewritten).toBe(true);
    expect(translation.followUps).toEqual([]);
  });

  test("`set-window-option -ga main-pane-width 50%`: same, via `SetOptionAppend`", () => {
    // `src/server/mod.rs:446-458`: `SetOptionAppend` touches only `@` options and
    // the three `status-*` strings. `-g` is a bare boolean flag, `-a` another, so
    // the walk skips two elements and `flagless` is false.
    const translation = translate(["set-window-option", "-ga", "main-pane-width", "50%"], LAYOUT_OPTS);

    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "-ga", "main-pane-width", "50"]);
    expect(translation.rewritten).toBe(true);
    expect(translation.followUps).toEqual([]);
  });

  test("a bare untargeted `main-pane-height 50%` is the gated-IN shape, and is NOT residual exposure", () => {
    // NAMED DELIBERATELY, because this is the shape the residual case rides on.
    // It is indistinguishable from a layout re-application the user did not want:
    // see the residual-exposure paragraph on `stripPercentAndReapplyLayout`. The
    // honest statement of what this fix achieves is that the three FLAGGED shapes
    // are closed and the bare one is still open — so this test pins the OPEN half
    // rather than implying the defect is gone.
    const translation = translate(["set-window-option", "main-pane-height", "50%"], LAYOUT_OPTS);

    // The `%` still comes off, which is the half that is unconditionally safe.
    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "main-pane-height", "50"]);
    expect(translation.argv.at(-1)).toBe("50");
  });

  test("every flagged shape loses the follow-up while keeping the `%` strip", () => {
    // One table, because the property is uniform: a flag anywhere before the
    // option name closes rule 1b and leaves rule 1a alone.
    const FLAGGED = [
      ["set-window-option", "-u", "main-pane-width", "50%"],
      ["set-window-option", "-U", "main-pane-width", "50%"],
      ["set-window-option", "-g", "main-pane-width", "50%"],
      ["set-window-option", "-ga", "main-pane-width", "50%"],
      ["set-window-option", "-ag", "main-pane-width", "50%"],
      ["set-window-option", "-t", "%4", "main-pane-width", "50%"],
      ["set-window-option", "-t", "%4", "-g", "main-pane-width", "50%"],
      ["set-window-option", "-q", "main-pane-height", "50%"],
      ["setw", "-u", "main-pane-height", "50%"],
    ] as const;

    for (const argv of FLAGGED) {
      const translation = translate([...argv], LAYOUT_OPTS);

      expect(translation.followUps).toEqual([]);
      expect(translation.rewritten).toBe(true);
      // Exactly the value changed, one trailing `%`, nothing else moved.
      expect(translation.argv).toEqual(["-L", "ns", ...argv.slice(0, -1), "50"]);
    }
  });

  test("a `-g` on its own is enough to close the gate: one flag, no value, still not flagless", () => {
    // Pins that `flagless` is `index === 1` and nothing looser, rather than a
    // test for "two or more flags" that would also pass.
    const translation = translate(["set-window-option", "-g", "main-pane-width", "50%"], LAYOUT_OPTS);

    expect(translation.followUps).toEqual([]);
    expect(translation.argv).toEqual(["-L", "ns", "set-window-option", "-g", "main-pane-width", "50"]);
  });
});

describe("layout rule 1c: `resize-pane -x` / `-y` is suppressed, not forwarded", () => {
  test("`resize-pane -t %1 -x 99` is marked suppressed, runs nothing, and records what it dropped", () => {
    const translation = translate(["resize-pane", "-t", "%1", "-x", "99"], LAYOUT_OPTS);

    expect(translation.kind).toBe("suppressed");
    // The argv is the INPUT, verbatim: the log's job is to say what was asked
    // for, so the dropped command is recorded rather than erased.
    expect(translation.argv).toEqual(["-L", "ns", "resize-pane", "-t", "%1", "-x", "99"]);
    expect(translation.rewritten).toBe(false);
    expect(translation.dashDashInserted).toBe(false);
    expect(translation.followUps).toEqual([]);
    expect(translation.helperCommandLine).toBeUndefined();
    expect(translation.envSlotCount).toBe(0);
    expect(translation.psmuxPath).toBe(PSMUX_PATH);
  });

  test("EVERY value form is suppressed, because psmux mishandles all of them", () => {
    // `99` and `100` are destructive (written as percentages, absorbing the
    // difference from a sibling floored at 1); `99%` is a percentage of a
    // percentage; `+5` and `-20` are relative syntax psmux does not parse at all.
    // Every measurement of every form is in the header of `src/translate.ts`.
    const VALUES = ["99", "99%", "100", "+5", "-20", "0", "197"];
    for (const value of VALUES) {
      for (const axis of ["-x", "-y"]) {
        const translation = translate(["resize-pane", "-t", "%1", axis, value], LAYOUT_OPTS);

        expect(translation.kind).toBe("suppressed");
        expect(translation.followUps).toEqual([]);
      }
    }
  });

  test("both verb spellings and a bare `-x` with no target are suppressed", () => {
    for (const argv of [
      ["resize-pane", "-x", "99"],
      ["resizep", "-t", "%1", "-y", "24"],
      ["resize-pane", "-t", "%1", "-x", "99", "-y", "12"],
    ] as const) {
      expect(translate([...argv], LAYOUT_OPTS).kind).toBe("suppressed");
    }
  });

  test("`resize-pane -Z` is forwarded byte-identically: zoom is a different, working path", () => {
    const translation = translate(["resize-pane", "-Z"], LAYOUT_OPTS);

    expect(translation.kind).toBe("passthrough");
    expect(translation.argv).toEqual(["-L", "ns", "resize-pane", "-Z"]);
    expect(translation.rewritten).toBe(false);
    expect(translation.followUps).toEqual([]);
  });

  test("`-Z` WINS over `-x`/`-y` in the same argv: `resize-pane -Z -x 99` is a zoom, not a resize", () => {
    // The case that decided the precedence. psmux dispatches zoom at
    // `src/server/connection.rs:1236` — an arm of the same `match cmd` that opens
    // at 1061, carrying the guard `args.iter().any(|a| *a == "-Z")` — before the
    // `-x`/`-y` arms at `src/server/connection.rs:1767-1778` are reached at all.
    // So psmux never reads the `-x 99` beside it, and suppressing this argv would
    // suppress a zoom the user asked for on the strength of a flag psmux ignores.
    for (const axis of ["-x", "-y"]) {
      const translation = translate(["resize-pane", "-Z", "-t", "%1", axis, "99"], LAYOUT_OPTS);

      expect(translation.kind).toBe("passthrough");
      expect(translation.argv).toEqual(["-L", "ns", "resize-pane", "-Z", "-t", "%1", axis, "99"]);
      expect(translation.rewritten).toBe(false);
    }

    // `-Z` anywhere in the argv wins, not just in second position: the guard is
    // `args.iter().any(..)` over the whole argument list.
    const trailing = translate(["resize-pane", "-t", "%1", "-x", "99", "-Z"], LAYOUT_OPTS);
    expect(trailing.kind).toBe("passthrough");
    expect(trailing.argv).toContain("-Z");
    expect(trailing.argv).toContain("99");
  });

  test("a `resize-pane` with neither `-x`, `-y` nor anything broken is forwarded byte-identically", () => {
    // The relative resize arms, and `-Z` beside a target. None of these is the
    // defect, so none of them is the bridge's business.
    for (const argv of [
      ["resize-pane", "-t", "%1", "-U"],
      ["resize-pane", "-t", "%1", "-D", "2"],
      ["resize-pane", "-t", "%1", "-Z"],
    ] as const) {
      const translation = translate([...argv], LAYOUT_OPTS);

      expect(translation.kind).toBe("passthrough");
      expect(translation.argv).toEqual(["-L", "ns", ...argv]);
      expect(translation.followUps).toEqual([]);
    }
  });

  test("only the two resize verbs are suppressed: a `-x` elsewhere is none of this module's business", () => {
    // `new-session -x 120 -y 40` (CONTRACT.md 3.5) carries `-x`, and it must not
    // be caught by a rule that only looked for the flag.
    const translation = translate(["new-session", "-d", "-s", "omo-iso-4711", "-x", "120", "-y", "40"], LAYOUT_OPTS);

    expect(translation.kind).toBe("passthrough");
    expect(translation.argv).toContain("120");
    expect(translation.argv).toContain("40");
    expect(translation.followUps).toEqual([]);
  });

  test("the suppression survives a payload-shaped tail element, which is still pass-through", () => {
    // The grammar calls this pass-through (a right verb with the wrong payload),
    // and the layout rules run on the pass-through branch — so the rule sees it.
    const translation = translate(["resize-pane", "-t", "%1", "-x", "99", PH_PLAIN], LAYOUT_OPTS);

    expect(classify(["resize-pane", "-t", "%1", "-x", "99", PH_PLAIN]).kind).toBe("pass-through");
    expect(translation.kind).toBe("suppressed");
  });
});

describe("the layout rules leave every other path untouched", () => {
  test("`followUps` is empty on a plain pass-through, with and without leading globals", () => {
    for (const options of [OPTS, LAYOUT_OPTS]) {
      const translation = translate(["send-keys", "-t", "%1", "C-c"], options);

      expect(translation.followUps).toEqual([]);
      expect(translation.kind).toBe("passthrough");
    }
  });

  test("`followUps` is empty on the helper path", () => {
    const translation = translate(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN], OPTS);

    expect(translation.kind).toBe("helper");
    expect(translation.followUps).toEqual([]);
    // A helper translation's argv is untouched by all of this.
    expect(translation.argv.slice(0, 6)).toEqual([
      "split-window",
      "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  test("translating the whole layout trio yields one corrected command, one follow-up and one suppression", () => {
    // The end-to-end shape of the fix, as three separate shim invocations, which
    // is exactly how OmO emits them. `test/cli.test.ts` drives the same three
    // through `main` and asserts what actually reached the backend.
    const layout = translate(["select-layout", "main-vertical"], LAYOUT_OPTS);
    const sizing = translate(["set-window-option", "main-pane-width", "50%"], LAYOUT_OPTS);
    const resize = translate(["resize-pane", "-t", "%1", "-x", "99"], LAYOUT_OPTS);

    expect(layout.kind).toBe("passthrough");
    expect(sizing.kind).toBe("passthrough");
    expect(resize.kind).toBe("suppressed");
    // Four psmux invocations replace OmO's three: layout, sizing, the re-applied
    // layout, and nothing for the resize.
    expect([layout, sizing, resize].flatMap((t) => [t, ...t.followUps])).toHaveLength(4);
    expect(sizing.followUps[0]?.argv).toEqual(["-L", "ns", "select-layout", "main-vertical"]);
  });
});
