// argv grammar — classification and payload extraction (v2.0.0).
//
// psmux 3.4.0 only; current OmO grammar only (5.1.35+ singlequote/Q banner,
// 5.1.51+ auth-file prefix). The pre-5.1.35 escaped-doublequote placeholder
// template is retired: such an argv classifies as pass-through.
//
// Fixture source:
//
//   oh-my-openagent@5.1.35+/dist/index.js (pane-command.ts)
//     shellQuoteForNestedCommand          (Q)
//     buildTmuxAttachCommand              (Template A)
//     buildTmuxPlaceholderCommand         (Template B)
//     buildPaneAuthEnvironmentArgs        (-e NAME=VALUE)
//
// STRUCTURAL FACT these fixtures encode: the payload is ONE argv element whose
// text *contains* `/bin/sh -c "…"`. It is not three argv elements. The payload
// body is the substring between the outer double quotes of that last element.

import { describe, expect, test } from "bun:test";
import { classifyArgv, splitLeadingGlobals, type RecognisedKind,
} from "../src/grammar";
import { translateArgv } from "../src/translate";

// ---------------------------------------------------------------------------
// Fixtures (byte-exact, captured from the bundle's own template functions)
// ---------------------------------------------------------------------------

// Template B (5.1.35+), plain description "explore the tmux grammar module".
const PH_PLAIN =
  "/bin/sh -c \"printf '%s\\n%s\\n' 'OMO subagent pane ready: explore the tmux grammar module' 'Focus this pane to attach.'; while :; do sleep 86400; done\"";

// Template B (5.1.35+), hostile raw description:
//   it's a $HOME `cmd` with "quotes" and \backslash\
// Q-encoded by upstream, byte-exact.
const PH_HOSTILE =
  "/bin/sh -c \"printf '%s\\n%s\\n' 'OMO subagent pane ready: it'\\\\''s a \\$HOME \\`cmd\\` with \\\"quotes\\\" and \\\\backslash\\\\' 'Focus this pane to attach.'; while :; do sleep 86400; done\"";

// The Q-encoded banner inner text carried inside PH_HOSTILE, as a literal:
// the bytes between `'OMO subagent pane ready: ` and the token's closing `'`.
const HOSTILE_Q_INNER =
  "it'\\\\''s a \\$HOME \\`cmd\\` with \\\"quotes\\\" and \\\\backslash\\\\";

// Template B (5.1.35+), upstream-truncated description: 2005 chars in,
// 2000 chars plus U+2026 out (PLACEHOLDER_DESCRIPTION_LIMIT).
const TRUNCATED_Q_INNER = `${"A".repeat(2000)}…`;
const PH_TRUNCATED =
  `/bin/sh -c "printf '%s\\n%s\\n' 'OMO subagent pane ready: ${"A".repeat(2000)}…' 'Focus this pane to attach.'; while :; do sleep 86400; done"`;

// Template B (5.1.35+), NUL-cleaned description: raw was `ab\0cd\0ef`,
// upstream withoutNul strips the NULs before Q-encoding.
const PH_NUL_CLEANED =
  "/bin/sh -c \"printf '%s\\n%s\\n' 'OMO subagent pane ready: abcdef' 'Focus this pane to attach.'; while :; do sleep 86400; done\"";

// Retired pre-5.1.35 escaped-doublequote placeholder body. Not recognised in
// v2.0.0: classifies as pass-through.
const LEGACY_PH_PLAIN =
  "/bin/sh -c \"printf '%s\\n%s\\n' \\\"OMO subagent pane ready: explore the tmux grammar module\\\" \\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done\"";

// Template A, plain values.
const AT_PLAIN =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'\"";

// Template A, session id containing two apostrophes and a literal `--dir`,
// raw input: ses_'x'--dir'y
const AT_HOSTILE =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_'\\\\''x'\\\\''--dir'\\\\''y' --dir '/home/dev/proj'\"";

// buildPaneAuthEnvironmentArgs() with both vars set.
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
    // Given: the same three words as three argv elements, as a naive
    // space-split forwarder would produce
    // When: classified
    // Then: no placeholder is recognised — the one-element shape is
    // load-bearing, and splitting it silently loses the pane
    expect(
      classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "/bin/sh", "-c", "printf"])
        .kind,
    ).toBe("pass-through");
    // And the intact single-element form classifies through production code.
    const whole = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(whole);
    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.payload.startsWith("printf '%s\\n%s\\n'")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. placeholder-split
// ---------------------------------------------------------------------------

describe("placeholder-split", () => {
  test("split-window carrying Template B, with -e pairs", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", ...AUTH_ARGS, PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.payload).toBe(
      "printf '%s\\n%s\\n' 'OMO subagent pane ready: explore the tmux grammar module' 'Focus this pane to attach.'; while :; do sleep 86400; done",
    );
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.envArgs).toEqual([
      { name: "OPENCODE_SERVER_PASSWORD", value: "pw123" },
      { name: "OPENCODE_SERVER_USERNAME", value: "daniel" },
    ]);
    // -e pairs and the payload are stripped; every other flag survives in order.
    expect(result.flags).toEqual(["-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3"]);
  });

  test("split-window with the EMPTY authEnvArgs case", () => {
    const argv = ["split-window", "-v", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.envArgs).toEqual([]);
    expect(result.envArgs).toHaveLength(0);
    expect(result.description).toBe("explore the tmux grammar module");
  });

  test("split-window with no -t target (targetPaneId unset)", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.flags).toEqual(["-h", "-d", "-P", "-F", "#{pane_id}"]);
  });
});

// ---------------------------------------------------------------------------
// 2. placeholder-respawn
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
// 3. attach-respawn
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
// 4. placeholder-newwindow
// ---------------------------------------------------------------------------

describe("placeholder-newwindow", () => {
  test("new-window with the literal window name omo-agents", () => {
    const argv = ["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.flags).toEqual(["-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}"]);
    expect(result.envArgs).toEqual([]);
  });

  test("new-window targeting an existing session (no -d, no -n)", () => {
    const argv = ["new-window", "-t", "omo-iso-4711", "-P", "-F", "#{pane_id}", ...AUTH_ARGS, PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.flags).toEqual(["-t", "omo-iso-4711", "-P", "-F", "#{pane_id}"]);
    expect(result.envArgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. placeholder-newsession
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

  test("new-session with NO sizeArgs (dimensions unreadable)", () => {
    const argv = ["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-newsession");
    if (result.kind !== "placeholder-newsession") throw new Error("unreachable");
    expect(result.flags).toEqual(["-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}"]);
  });
});

// ---------------------------------------------------------------------------
// 6. pass-through
// ---------------------------------------------------------------------------

describe("pass-through — unrecognised verbs", () => {
  test("send-keys (teardown) is pass-through", () => {
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

  test("the trailing select-pane title call is pass-through", () => {
    const argv = ["select-pane", "-t", "%7", "-T", "omo-subagent-explore the tm"];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    expect(result.kind === "pass-through" ? result.argv : null).toEqual(argv);
  });

  test("split-window carrying the ATTACH payload is not one of the five forms", () => {
    // The attach template on split-window has no classification name covering
    // it, so pass-through.
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", AT_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
  });
});

describe("pass-through — retired legacy template", () => {
  test("a pre-5.1.35 escaped-doublequote placeholder argv is pass-through", () => {
    // Given: the retired E(doublequote) placeholder body on split-window
    // When: classified
    // Then: pass-through — v2.0.0 recognises the current Q banner only
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", LEGACY_PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("pass-through");
    if (result.kind !== "pass-through") throw new Error("unreachable");
    expect(result.argv).toEqual(argv);
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
    // Byte-identical to the Q-encoded banner inner text the generator emitted.
    expect(result.description).toBe(HOSTILE_Q_INNER);
    expect(result.description.length).toBe(HOSTILE_Q_INNER.length);
    expect(result.description).toContain("it'\\\\''s a");
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
    expect(result.description).toBe(HOSTILE_Q_INNER);
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
// ---------------------------------------------------------------------------
// Leading psmux globals
//
// psmux 3.4.0: `-L <ns>`, `-S <socket>` and `-f <config>` are accepted BEFORE
// the verb. OmO never emits them, but every throwaway-namespace invocation
// does. Without splitLeadingGlobals, `classifyArgv(["-L","ns","split-window",
// ...,payload])` returned pass-through, because argv[0] was "-L".
// ---------------------------------------------------------------------------

describe("splitLeadingGlobals", () => {
  test("a bare -L namespace pair is split off and reported verbatim", () => {
    const argv = ["-L", "omo_ns", "list-sessions"];

    expect(splitLeadingGlobals(argv)).toEqual({
      globals: ["-L", "omo_ns"],
      rest: ["list-sessions"],
    });
  });

  test("-S and -f are recognised on the same footing as -L", () => {
    expect(splitLeadingGlobals(["-S", "sock", "-V"]).globals).toEqual(["-S", "sock"]);
    expect(splitLeadingGlobals(["-f", "cfg.toml", "-V"]).globals).toEqual(["-f", "cfg.toml"]);
  });

  test("several globals combine, in the order given", () => {
    const argv = ["-L", "ns", "-S", "sock", "-f", "cfg", "new-session", "-d", "-s", "x"];

    expect(splitLeadingGlobals(argv)).toEqual({
      globals: ["-L", "ns", "-S", "sock", "-f", "cfg"],
      rest: ["new-session", "-d", "-s", "x"],
    });
  });

  test("a dangling global with no value is left alone rather than guessed at", () => {
    // `-L` at the end, or `-L` with nothing after it, is not a namespace pair.
    // Forwarding it untouched is the only safe answer: a missing value would
    // otherwise swallow the verb.
    expect(splitLeadingGlobals(["list-sessions", "-L"])).toEqual({
      globals: [],
      rest: ["list-sessions", "-L"],
    });
    expect(splitLeadingGlobals(["-L"])).toEqual({ globals: [], rest: ["-L"] });
  });

  test("a value that looks like a verb is still consumed as the value", () => {
    // psmux takes the next element verbatim as the value, so `-L kill-server`
    // names a namespace called "kill-server" and must NOT be read as a verb.
    expect(splitLeadingGlobals(["-L", "kill-server", "list-sessions"])).toEqual({
      globals: ["-L", "kill-server"],
      rest: ["list-sessions"],
    });
  });

  test("no globals means an untouched argv", () => {
    const argv = ["split-window", "-d", "-t", "s", "-P", "-F", "#{pane_id}", PH_PLAIN];

    expect(splitLeadingGlobals(argv)).toEqual({ globals: [], rest: argv });
  });

  test("a global is only a global before the verb: -t later in the line is not one", () => {
    expect(splitLeadingGlobals(["list-panes", "-t", "-L", "x"]).globals).toEqual([]);
  });
});

describe("a leading -L namespace does not defeat classification", () => {
  const SHAPES: ReadonlyArray<
    readonly [string, readonly string[], RecognisedKind | "pass-through"]
  > = [
    ["placeholder-split", ["split-window", "-d", "-t", "s", "-P", "-F", "#{pane_id}", PH_PLAIN], "placeholder-split"],
    ["placeholder-newwindow", ["new-window", "-d", "-t", "s", "-P", "-F", "#{pane_id}", PH_PLAIN], "placeholder-newwindow"],
    ["placeholder-newsession", ["new-session", "-d", "-s", "s", "-P", "-F", "#{pane_id}", PH_PLAIN], "placeholder-newsession"],
    ["placeholder-respawn", ["respawn-pane", "-k", "-t", "%9", "-c", "#{pane_id}", PH_PLAIN], "placeholder-respawn"],
    ["attach-respawn", ["respawn-pane", "-k", "-t", "%9", "-c", "#{pane_id}", AT_PLAIN], "attach-respawn"],
  ];

  for (const [name, shape, expected] of SHAPES) {
    test(name + " survives a leading -L", () => {
      const { globals, rest } = splitLeadingGlobals(["-L", "omo_ns"].concat(shape));

      expect(globals).toEqual(["-L", "omo_ns"]);
      expect(classifyArgv(rest).kind).toBe(expected);
    });
  }

  test("the emitted argv keeps the namespace in front of the rewritten shape", () => {
    // The namespace is not consumed by the bridge: psmux still needs it, so it has
    // to come back out in front of everything the translator produced.
    const { globals, rest } = splitLeadingGlobals([
      "-L",
      "omo_ns",
      "split-window",
      "-d",
      "-t",
      "s",
      "-P",
      "-F",
      "#{pane_id}",
      PH_PLAIN,
    ]);
    const translation = translateArgv(classifyArgv(rest), {
      psmuxPath: "C:\\psmux.exe",
      helperPath: "C:\\helper.ps1",
      leadingGlobals: globals,
    });

    expect(translation.argv.slice(0, 2)).toEqual(["-L", "omo_ns"]);
    expect(translation.argv[2]).toBe("split-window");
    expect(translation.rewritten).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// placeholder edge cases: truncation, NUL-cleaning, wrong hint.
// ---------------------------------------------------------------------------

describe("placeholder edge cases", () => {
  test("upstream-truncated description (2000 chars plus ellipsis) classifies", () => {
    // Given: a description upstream cut at PLACEHOLDER_DESCRIPTION_LIMIT
    // When: classified
    // Then: the truncated inner text is carried, ellipsis included
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", PH_TRUNCATED]);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.description).toBe(TRUNCATED_Q_INNER);
    expect(result.description.length).toBe(2001);
    expect(result.description.endsWith("…")).toBe(true);
  });

  test("NUL-cleaned description classifies as upstream emits it", () => {
    // Given: upstream stripped the NULs before Q-encoding (`ab\0cd\0ef`)
    // When: classified
    // Then: the cleaned text is carried as-is
    const result = classifyArgv(["respawn-pane", "-k", "-t", "%7", PH_NUL_CLEANED]);

    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    expect(result.description).toBe("abcdef");
  });

  test("new-window and new-session carry the same banner description", () => {
    const window = classifyArgv(["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", PH_PLAIN]);
    expect(window.kind).toBe("placeholder-newwindow");
    if (window.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(window.description).toBe("explore the tmux grammar module");

    const session = classifyArgv(["new-session", "-d", "-s", "omo-iso-4711", "-P", "-F", "#{pane_id}", PH_PLAIN]);
    expect(session.kind).toBe("placeholder-newsession");
    if (session.kind !== "placeholder-newsession") throw new Error("unreachable");
    expect(session.description).toBe("explore the tmux grammar module");
  });

  test("a banner with the wrong hint text is pass-through, not misparsed", () => {
    // Given: the right banner but a foreign second token
    // When: classified
    // Then: no placeholder — the hint is part of the template, not decoration
    const argv = [
      "split-window",
      "-h",
      "/bin/sh -c \"printf '%s\\n%s\\n' 'OMO subagent pane ready: hi' 'Something else.'; while :; do sleep 86400; done\"",
    ];
    expect(classifyArgv(argv).kind).toBe("pass-through");
  });

  test("a truncated banner (missing closing quote) is pass-through", () => {
    // Given: a payload cut off mid-banner
    // When: classified
    // Then: pass-through, like the other truncation cases
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "/bin/sh -c \"printf '%s\\n%s\\n' 'OMO subagent pane ready: abc"];
    expect(classifyArgv(argv).kind).toBe("pass-through");
  });
});
