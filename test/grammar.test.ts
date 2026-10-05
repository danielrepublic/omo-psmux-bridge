// argv grammar — classification and payload extraction.
//
// Every argv fixture below is a LITERAL capture of the argv OmO 5.1.18
// actually emits, taken from:
//
//   oh-my-openagent@5.1.18/dist/index.js
//     :4715-4716  shellEscapeForDoubleQuotedCommand   (E)
//     :8318-8319  shellQuoteForNestedCommand         (Q)
//     :8321-8325  buildTmuxAttachCommand             (Template A)
//     :8327-8329  buildTmuxPlaceholderCommand        (Template B)
//     :8331-8341  buildPaneAuthEnvironmentArgs       (-e NAME=VALUE)
//     :8402-8411  split-window     call site
//     :8501       respawn-pane     + placeholder
//     :8548-8555  respawn-pane     + attach
//     :8617-8626  new-window
//     :8727-8747  new-session / new-window-on-existing-session
//
// STRUCTURAL FACT these fixtures encode: the payload is ONE argv element whose
// text *contains* `/bin/sh -c "…"`. It is not three argv elements. The payload
// body is the substring between the outer double quotes of that last element.

import { describe, expect, test } from "bun:test";
import { classifyArgv } from "../src/grammar";

// ---------------------------------------------------------------------------
// Fixtures (byte-exact, captured from the bundle's own template functions)
// ---------------------------------------------------------------------------

// Template B, plain description "explore the tmux grammar module".
const PH_PLAIN =
  "/bin/sh -c \"printf '%s\\n%s\\n' \\\"OMO subagent pane ready: explore the tmux grammar module\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done\"";

// Template B, description carrying a single quote, a backslash, a `$`, a
// backtick and a double quote. Raw input was:
//   it's a $HOME `cmd` with "quotes" and \backslash\
const PH_HOSTILE =
  "/bin/sh -c \"printf '%s\\n%s\\n' \\\"OMO subagent pane ready: it's a \\$HOME \\`cmd\\` with \\\"quotes\\\" and \\\\backslash\\\\\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done\"";

// The E(description) text carried inside PH_HOSTILE, as a literal.
const HOSTILE_DESCRIPTION =
  "it's a \\$HOME \\`cmd\\` with \\\"quotes\\\" and \\\\backslash\\\\";

// Template A, plain values.
const AT_PLAIN =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'\"";

// Template A, session id containing two apostrophes and a literal `--dir`,
// raw input: ses_'x'--dir'y
const AT_HOSTILE =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_'\\\\''x'\\\\''--dir'\\\\''y' --dir '/home/dev/proj'\"";

// buildPaneAuthEnvironmentArgs() with both vars set (:8336, :8339).
const AUTH_ARGS = [
  "-e",
  "OPENCODE_SERVER_PASSWORD=pw123",
  "-e",
  "OPENCODE_SERVER_USERNAME=daniel",
];

// ---------------------------------------------------------------------------
// The structural fact itself
// ---------------------------------------------------------------------------

describe("payload shape", () => {
  test("the payload is ONE argv element containing the shell text, not three", () => {
    expect(PH_PLAIN.startsWith('/bin/sh -c "')).toBe(true);
    expect(PH_PLAIN.endsWith('"')).toBe(true);
    expect(PH_PLAIN.includes("/bin/sh -c \"")).toBe(true);
    expect(["/bin/sh", "-c", "printf"]).toHaveLength(3);
    expect(["/bin/sh", "-c", "printf"]).not.toEqual(PH_PLAIN.split(" "));
  });
});

// ---------------------------------------------------------------------------
// 1. placeholder-split  (index.js:8402-8411)
// ---------------------------------------------------------------------------

describe("placeholder-split", () => {
  test("split-window carrying Template B, with -e pairs", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", ...AUTH_ARGS, PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.payload).toBe(
      "printf '%s\\n%s\\n' \\\"OMO subagent pane ready: explore the tmux grammar module\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done",
    );
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.envArgs).toEqual([
      { name: "OPENCODE_SERVER_PASSWORD", value: "pw123" },
      { name: "OPENCODE_SERVER_USERNAME", value: "daniel" },
    ]);
    // -e pairs and the payload are stripped; every other flag survives in order.
    expect(result.flags).toEqual(["-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3"]);
  });

  test("split-window with the EMPTY authEnvArgs case (:8334 returns [])", () => {
    const argv = ["split-window", "-v", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.envArgs).toEqual([]);
    expect(result.envArgs).toHaveLength(0);
    expect(result.description).toBe("explore the tmux grammar module");
  });

  test("split-window with no -t target (targetPaneId unset, :8409)", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.flags).toEqual(["-h", "-d", "-P", "-F", "#{pane_id}"]);
  });
});

// ---------------------------------------------------------------------------
// 2. placeholder-respawn  (index.js:8501)
// ---------------------------------------------------------------------------

describe("placeholder-respawn", () => {
  test("respawn-pane carrying Template B, with -e pairs before -t", () => {
    const argv = ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.envArgs).toHaveLength(2);
    // The -e pairs sit BEFORE -t in the real argv, so flags keep that order.
    expect(result.flags).toEqual(["-k", "-t", "%7"]);
    expect(result.payload.endsWith("while :; do sleep 86400; done")).toBe(true);
  });

  test("respawn-pane carrying Template B with no -e pairs at all", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    expect(result.envArgs).toEqual([]);
    expect(result.flags).toEqual(["-k", "-t", "%7"]);
  });
});

// ---------------------------------------------------------------------------
// 3. attach-respawn  (index.js:8548-8555)
// ---------------------------------------------------------------------------

describe("attach-respawn", () => {
  test("respawn-pane carrying Template A, no -e pairs", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", AT_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("attach-respawn");
    if (result.kind !== "attach-respawn") throw new Error("unreachable");
    expect(result.payload).toBe(
      "opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'",
    );
    expect(result.serverUrlQuoted).toBe("'http://127.0.0.1:4096'");
    expect(result.sessionIdQuoted).toBe("'ses_abc123'");
    expect(result.directoryQuoted).toBe("'/home/dev/proj'");
    expect(result.envArgs).toEqual([]);
  });

  test("respawn-pane carrying Template A with -e pairs", () => {
    const argv = ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", AT_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("attach-respawn");
    if (result.kind !== "attach-respawn") throw new Error("unreachable");
    expect(result.envArgs).toHaveLength(2);
    expect(result.flags).toEqual(["-k", "-t", "%7"]);
  });
});

// ---------------------------------------------------------------------------
// 4. placeholder-newwindow  (index.js:8617-8626 and :8727-8735)
// ---------------------------------------------------------------------------

describe("placeholder-newwindow", () => {
  test("new-window with the literal window name omo-agents (:8647)", () => {
    const argv = ["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.flags).toEqual(["-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}"]);
    expect(result.envArgs).toEqual([]);
  });

  test("new-window targeting an existing session (:8727-8735, no -d, no -n)", () => {
    const argv = ["new-window", "-t", "omo-iso-4711", "-P", "-F", "#{pane_id}", ...AUTH_ARGS, PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.flags).toEqual(["-t", "omo-iso-4711", "-P", "-F", "#{pane_id}"]);
    expect(result.envArgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. placeholder-newsession  (index.js:8736-8747)
// ---------------------------------------------------------------------------

describe("placeholder-newsession", () => {
  test("new-session with sizeArgs and -e pairs", () => {
    const argv = [
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
    ];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newsession");
    if (result.kind !== "placeholder-newsession") throw new Error("unreachable");
    expect(result.flags).toEqual(["-d", "-s", "omo-iso-4711", "-x", "120", "-y", "40", "-P", "-F", "#{pane_id}"]);
    expect(result.envArgs).toHaveLength(2);
    expect(result.description).toBe("explore the tmux grammar module");
  });

  test("new-session with NO sizeArgs (dimensions unreadable, :8721)", () => {
    const argv = ["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newsession");
    if (result.kind !== "placeholder-newsession") throw new Error("unreachable");
    expect(result.flags).toEqual(["-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}"]);
  });
});

// ---------------------------------------------------------------------------
// 6. pass-through  (CONTRACT.md 3.9)
// ---------------------------------------------------------------------------

describe("pass-through — unrecognised verbs", () => {
  test("send-keys (teardown, :8448) is pass-through", () => {
    const argv = ["send-keys", "-t", "%3", "C-c"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    if (result.kind !== "pass-through") throw new Error("unreachable");
    expect(result.argv).toEqual(["send-keys", "-t", "%3", "C-c"]);
  });

  test("display-message with a format string is pass-through", () => {
    const argv = ["display", "-p", "-t", "%1", "#{window_width}"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    if (result.kind !== "pass-through") throw new Error("unreachable");
    expect(result.argv).toEqual(["display", "-p", "-t", "%1", "#{window_width}"]);
  });

  test("the trailing select-pane title call (:8419) is pass-through", () => {
    const argv = ["select-pane", "-t", "%7", "-T", "omo-subagent-explore the tm"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    expect(result.kind === "pass-through" ? result.argv : null).toEqual(argv);
  });

  test("split-window carrying the ATTACH payload is not one of the five forms", () => {
    // index.js:8401 chooses the attach template under cmux-compat, which is
    // false under psmux. No classification name covers it, so pass-through.
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", AT_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
  });
});

// ---------------------------------------------------------------------------
// pass-through — malformed_input. None of these may throw.
// ---------------------------------------------------------------------------

describe("pass-through — malformed input", () => {
  test("truncated payload: missing the closing double quote", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "/bin/sh -c \"printf 'x"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    if (result.kind !== "pass-through") throw new Error("unreachable");
    expect(result.argv).toEqual(argv);
    expect(result.argv).toHaveLength(7);
  });

  test("truncated payload on respawn-pane does not yield a partial command", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", "/bin/sh -c \"printf '%s\\n%s\\n' \"OMO subagent"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    expect("payload" in result).toBe(false);
  });

  test("unterminated -e: -e is the last element, so no value exists", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-e"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    expect(result.kind === "pass-through" ? result.argv : null).toEqual(argv);
  });

  test("unterminated -e: -e sits where the payload's value would have to be", () => {
    const argv = ["split-window", "-h", "-d", "-e", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
  });

  test("-e value without an = is malformed", () => {
    const argv = ["split-window", "-h", "-d", "-e", "OPENCODE_SERVER_PASSWORD", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
  });

  test("empty argv", () => {
    const result = classifyArgv([]);

    expect(result.kind).toBe("pass-through");
    expect(result.kind === "pass-through" ? result.argv : null).toEqual([]);
  });

  test("argv with only a verb", () => {
    const result = classifyArgv(["new-window"]);

    expect(result.kind).toBe("pass-through");
    expect(result.kind === "pass-through" ? result.argv : null).toEqual(["new-window"]);
  });

  test("a right verb whose last element is not the shell payload is pass-through", () => {
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "/bin/sh -c"]);

    expect(result.kind).toBe("pass-through");
  });

  test("a foreign shell's payload is pass-through, not misparsed", () => {
    const result = classifyArgv(["split-window", "-h", "bash", "-lc", "printf hello"]);

    expect(result.kind).toBe("pass-through");
  });

  test("an empty payload body is pass-through", () => {
    const result = classifyArgv(["split-window", "-h", '/bin/sh -c ""']);

    expect(result.kind).toBe("pass-through");
  });
});

// ---------------------------------------------------------------------------
// Hostile quoting: byte-identity
// ---------------------------------------------------------------------------

describe("hostile quoting", () => {
  test("placeholder description with ' \\ $ ` \" is extracted byte-identically", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", PH_HOSTILE];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    // Byte-identical to the E(description) text the real generator emitted.
    expect(result.description).toBe(HOSTILE_DESCRIPTION);
    expect(result.description.length).toBe(HOSTILE_DESCRIPTION.length);
    expect(result.description).toContain("it's a");
    expect(result.description).toContain("\\$HOME");
    expect(result.description).toContain("\\`cmd\\`");
    expect(result.description).toContain('\\"quotes\\"');
    expect(result.description).toContain("\\\\backslash\\\\");
    // The whole payload survives unchanged too.
    expect(PH_HOSTILE.slice(PH_HOSTILE.indexOf('"') + 1, PH_HOSTILE.length - 1)).toBe(result.payload);
  });

  test("hostile placeholder still classifies as placeholder-split", () => {
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%9", PH_HOSTILE]);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.description).toBe(HOSTILE_DESCRIPTION);
  });

  test("attach session id containing ' and --dir is read as one token", () => {
    const argv = ["respawn-pane", "-k", "-t", "%7", AT_HOSTILE];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("attach-respawn");
    if (result.kind !== "attach-respawn") throw new Error("unreachable");
    // Q(sessionId) verbatim, apostrophes included: naive --dir splitting fails here.
    expect(result.sessionIdQuoted).toBe("'ses_'\\\\''x'\\\\''--dir'\\\\''y'");
    expect(result.directoryQuoted).toBe("'/home/dev/proj'");
    expect(result.serverUrlQuoted).toBe("'http://127.0.0.1:4096'");
  });

  test("an -e value containing = and spaces is preserved whole", () => {
    const argv = [
      "respawn-pane",
      "-k",
      "-e",
      "OPENCODE_SERVER_PASSWORD=a b=c d",
      "-t",
      "%7",
      PH_PLAIN,
    ];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    expect(result.envArgs).toEqual([{ name: "OPENCODE_SERVER_PASSWORD", value: "a b=c d" }]);
  });

  test("an empty -e value is preserved as an empty string", () => {
    const result = classifyArgv(["new-window", "-e", "OPENCODE_SERVER_PASSWORD=", PH_PLAIN]);

    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.envArgs).toEqual([{ name: "OPENCODE_SERVER_PASSWORD", value: "" }]);
  });
});

// ---------------------------------------------------------------------------
// Purity and determinism: flaky_tests defence
// ---------------------------------------------------------------------------

describe("purity", () => {
  test("classifying does not mutate the input array", () => {
    const argv = ["respawn-pane", "-k", ...AUTH_ARGS, "-t", "%7", PH_PLAIN];
    const snapshot = [...argv];

    classifyArgv(argv);

    expect(argv).toEqual(snapshot);
  });

  test("classifying a frozen argv array does not throw", () => {
    const argv = Object.freeze(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN]);

    expect(() => classifyArgv(argv)).not.toThrow();
    expect(classifyArgv(argv).kind).toBe("placeholder-split");
  });

  test("classification is deterministic across repeated calls", () => {
    const argv = ["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_HOSTILE];

    expect(classifyArgv(argv)).toEqual(classifyArgv(argv));
  });

  test("pass-through carries a copy, so the caller's argv is not aliased", () => {
    const argv = ["send-keys", "-t", "%3", "C-c"];
    const result = classifyArgv(argv);

    if (result.kind !== "pass-through") throw new Error("unreachable");
    expect(result.argv).not.toBe(argv);
    expect(result.argv).toEqual(argv);
  });
});