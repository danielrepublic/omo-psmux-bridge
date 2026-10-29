// OmO 5.1.51 authenticated pane payloads.
//
// Source: oh-my-openagent@5.1.51 dist/index.js
//   :8285-8289  withPaneAuth
//   :8384-8393  shellQuoteForNestedCommand + buildTmuxAttachCommand
//   :8404-8412  buildTmuxPlaceholderCommand
//
// When OPENCODE_SERVER_PASSWORD is set, every payload body is prefixed with a
// CONSTANT, escaped POSIX fragment that sources a one-use credential file and
// removes it. The fragment contains no interpolated value, so it is matched
// byte-exactly. Without a password the payload is byte-identical to 5.1.48.
//
// The bridge must still recognise the five payload shapes and must carry the
// fact that the pane needs file-backed auth, because a pane whose credential
// file is missing must not silently behave as an unauthenticated pane.

import { describe, expect, test } from "bun:test";
import { classifyArgv } from "../src/grammar";
import { parseHelperCommandLine, translateArgv } from "../src/translate";

// Exact payload bodies between the outer quotes, generated from the published
// 5.1.51 bundle functions. String.raw keeps the backslashes literal.
const AUTH_PREFIX = String.raw`. \"\$OPENCODE_SERVER_PASSWORD_FILE\" && rm -f -- \"\$OPENCODE_SERVER_PASSWORD_FILE\" && `;

const AUTH_PH_PLAIN = String.raw`/bin/sh -c ". \"\$OPENCODE_SERVER_PASSWORD_FILE\" && rm -f -- \"\$OPENCODE_SERVER_PASSWORD_FILE\" && printf '%s\n%s\n' 'OMO subagent pane ready: explore the tmux grammar module' 'Focus this pane to attach.'; while :; do sleep 86400; done"`;

const AUTH_AT_PLAIN = String.raw`/bin/sh -c ". \"\$OPENCODE_SERVER_PASSWORD_FILE\" && rm -f -- \"\$OPENCODE_SERVER_PASSWORD_FILE\" && opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'"`;

const PH_PLAIN = String.raw`/bin/sh -c "printf '%s\n%s\n' 'OMO subagent pane ready: explore the tmux grammar module' 'Focus this pane to attach.'; while :; do sleep 86400; done"`;

const AT_PLAIN = String.raw`/bin/sh -c "opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'"`;

const AUTH_ENV = [
  "-e",
  "OPENCODE_SERVER_PASSWORD_FILE=C:\\Users\\Daniel\\AppData\\Local\\Temp\\omo-run-auth-ab12cd\\0f8fad5b.sh",
  "-e",
  "OPENCODE_SERVER_USERNAME=daniel",
];

function bodyOf(element: string): string {
  return element.slice('/bin/sh -c "'.length, -1);
}

describe("5.1.51 authenticated payload recognition", () => {
  test("split-window placeholder keeps its shape and records file-backed auth", () => {
    const argv = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", ...AUTH_ENV, AUTH_PH_PLAIN];
    const result = classifyArgv(argv);

    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
    expect(result.payload).toBe(bodyOf(AUTH_PH_PLAIN));
    expect(result.payload.startsWith(AUTH_PREFIX)).toBe(true);
    expect(result.description).toBe("explore the tmux grammar module");
    expect(result.descriptionEncoding).toBe("singlequote");
    expect(result.envArgs).toEqual([
      {
        name: "OPENCODE_SERVER_PASSWORD_FILE",
        value: "C:\\Users\\Daniel\\AppData\\Local\\Temp\\omo-run-auth-ab12cd\\0f8fad5b.sh",
      },
      { name: "OPENCODE_SERVER_USERNAME", value: "daniel" },
    ]);
  });

  test("new-window placeholder is recognised", () => {
    const result = classifyArgv(["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}", ...AUTH_ENV, AUTH_PH_PLAIN]);
    expect(result.kind).toBe("placeholder-newwindow");
    if (result.kind !== "placeholder-newwindow") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
  });

  test("new-session placeholder is recognised", () => {
    const result = classifyArgv(["new-session", "-d", "-s", "omo", "-P", "-F", "#{pane_id}", ...AUTH_ENV, AUTH_PH_PLAIN]);
    expect(result.kind).toBe("placeholder-newsession");
    if (result.kind !== "placeholder-newsession") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
  });

  test("respawn-pane placeholder is recognised", () => {
    const result = classifyArgv(["respawn-pane", "-k", ...AUTH_ENV, "-t", "%7", AUTH_PH_PLAIN]);
    expect(result.kind).toBe("placeholder-respawn");
    if (result.kind !== "placeholder-respawn") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
  });

  test("respawn-pane attach is recognised and routed to the helper", () => {
    const result = classifyArgv(["respawn-pane", "-k", ...AUTH_ENV, "-t", "%7", AUTH_AT_PLAIN]);
    expect(result.kind).toBe("attach-respawn");
    if (result.kind !== "attach-respawn") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
    expect(result.serverUrlQuoted).toBe("'http://127.0.0.1:4096'");
    expect(result.sessionIdQuoted).toBe("'ses_abc123'");
    expect(result.directoryQuoted).toBe("'/home/dev/proj'");

    const translation = translateArgv(result, {
      psmuxPath: "psmux",
      helperPath: "C:\\bridge\\Start-PaneFromDescriptor.ps1",
      correlationId: "pane-test-auth",
    });
    expect(translation.kind).toBe("helper");
    expect(translation.argv).toContain("--");
  });

  test("the unauthenticated 5.1.51 shapes remain byte-identical to 5.1.48", () => {
    const split = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", "%3", PH_PLAIN]);
    expect(split.kind).toBe("placeholder-split");
    if (split.kind !== "placeholder-split") throw new Error("unreachable");
    expect(split.authFileBacked).toBe(false);

    const attach = classifyArgv(["respawn-pane", "-k", "-t", "%7", AT_PLAIN]);
    expect(attach.kind).toBe("attach-respawn");
    if (attach.kind !== "attach-respawn") throw new Error("unreachable");
    expect(attach.authFileBacked).toBe(false);
  });

  test("a prefix without the FILE env is still marked file-backed, not unauth", () => {
    const result = classifyArgv(["respawn-pane", "-k", "-t", "%7", AUTH_AT_PLAIN]);
    expect(result.kind).toBe("attach-respawn");
    if (result.kind !== "attach-respawn") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(true);
    expect(result.envArgs).toEqual([]);
  });

  test("a near-miss prefix is pass-through, not a guessed rewrite", () => {
    const nearMiss = AUTH_PH_PLAIN.replace('&& printf', '&&printf');
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", nearMiss]);
    expect(result.kind).toBe("pass-through");
  });

  test("an unescaped POSIX prefix is pass-through, not the 5.1.51 shape", () => {
    const unescaped = AUTH_PH_PLAIN.replaceAll('\\"', '"').replaceAll("\\$", "$");
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", unescaped]);
    expect(result.kind).toBe("pass-through");
  });

  test("the prefix text inside a description does not mis-cut the payload", () => {
    const description = `literal ${AUTH_PREFIX.trim()} text`;
    const payload = String.raw`/bin/sh -c "printf '%s\n%s\n' 'OMO subagent pane ready: literal . \"\$OPENCODE_SERVER_PASSWORD_FILE\" && rm -f -- \"\$OPENCODE_SERVER_PASSWORD_FILE\" && text' 'Focus this pane to attach.'; while :; do sleep 86400; done"`;
    const result = classifyArgv(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", payload]);
    expect(result.kind).toBe("placeholder-split");
    if (result.kind !== "placeholder-split") throw new Error("unreachable");
    expect(result.authFileBacked).toBe(false);
    expect(result.description).toBe(description);
  });

  test("a truncated outer quote after the prefix is pass-through", () => {
    const truncated = AUTH_AT_PLAIN.slice(0, -1);
    const result = classifyArgv(["respawn-pane", "-k", truncated]);
    expect(result.kind).toBe("pass-through");
  });
});

describe("5.1.51 authenticated team attach", () => {
  const TEAM_TEXT =
    `. "$OPENCODE_SERVER_PASSWORD_FILE" && rm -f -- "$OPENCODE_SERVER_PASSWORD_FILE" && ` +
    `opencode attach 'http://127.0.0.1:4096' --session 'ses_team1' --dir 'C:\\work\\my project'`;

  const options = {
    psmuxPath: "psmux",
    helperPath: "C:\\bridge\\Start-PaneFromDescriptor.ps1",
    correlationId: "pane-team-auth",
  };

  test("the typed POSIX attach is rewritten to a pane-start helper invocation", () => {
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", TEAM_TEXT, "Enter"]), options);

    expect(result.kind).toBe("helper");
    expect(result.argv.slice(0, 3)).toEqual(["send-keys", "-t", "%9"]);
    expect(result.argv[4]).toBe("Enter");
    expect(result.helperCommandLine).toBeDefined();
    if (result.helperCommandLine === undefined) throw new Error("unreachable");

    const helper = parseHelperCommandLine(result.helperCommandLine);
    expect(helper.command).toEqual([
      "opencode",
      "attach",
      "http://127.0.0.1:4096",
      "--session",
      "ses_team1",
      "--dir",
      "C:\\work\\my project",
    ]);
    expect(helper.envSlotCount).toBe(0);
    expect(helper.payload).toBe(TEAM_TEXT);
  });

  test("leading globals are preserved ahead of send-keys", () => {
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", TEAM_TEXT, "Enter"]), {
      ...options,
      leadingGlobals: ["-L", "team-ns"],
    });
    expect(result.argv.slice(0, 5)).toEqual(["-L", "team-ns", "send-keys", "-t", "%9"]);
  });

  test("the unauthenticated team attach stays byte-identical", () => {
    const plain =
      "opencode attach 'http://127.0.0.1:4096' --session 'ses_team1' --dir 'C:\\work\\my project'";
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", plain, "Enter"]), options);
    expect(result.kind).toBe("passthrough");
    expect(result.argv).toEqual(["send-keys", "-t", "%9", plain, "Enter"]);
  });

  test("a near-miss authenticated team text is pass-through", () => {
    const nearMiss = TEAM_TEXT.replace(" && opencode", " &&  opencode");
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", nearMiss, "Enter"]), options);
    expect(result.kind).toBe("passthrough");
  });

  test("other send-keys traffic is untouched", () => {
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", "C-c"]), options);
    expect(result.kind).toBe("passthrough");
    expect(result.argv).toEqual(["send-keys", "-t", "%9", "C-c"]);
  });

  test("an apostrophe in a team path survives the POSIX quoting", () => {
    const directory = "C:\\work\\it's here";
    const quotedDirectory = `'${directory.replaceAll("'", "'\\''")}'`;
    const text =
      `. "$OPENCODE_SERVER_PASSWORD_FILE" && rm -f -- "$OPENCODE_SERVER_PASSWORD_FILE" && ` +
      `opencode attach 'http://127.0.0.1:4096' --session 'ses_team1' --dir ${quotedDirectory}`;
    const result = translateArgv(classifyArgv(["send-keys", "-t", "%9", text, "Enter"]), options);
    expect(result.kind).toBe("helper");
    if (result.helperCommandLine === undefined) throw new Error("unreachable");
    const helper = parseHelperCommandLine(result.helperCommandLine);
    expect(helper.command[6]).toBe(directory);
  });
});
