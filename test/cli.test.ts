// Smoke test: src/cli.ts must export main(argv: string[]): Promise<number>.
// Intentionally RED until todo 12 implements the CLI entry point.
import { test, expect } from "bun:test";
import * as cli from "../src/cli";

test("src/cli.ts exports main(argv: string[]): Promise<number>", () => {
  expect(cli).toHaveProperty("main");
});

// ===========================================================================
// todo 12 — the entry point, the two logs, and the pass-through guarantee
// ===========================================================================
//
// Everything below drives the REAL `resolveBackend` and the REAL `runBackend`
// against a temp stand-in named `psmux.exe`, so what is under test is the
// wiring, not a stub of it: grammar → translate → backend → exec, with
// `OMO_PSMUX_INSTALL_DIR` pointing at the stand-in. The seams are used only for
// the things a real backend cannot produce — a resolution failure, a log that
// cannot be written, the shim's own path.
//
// Three properties are load-bearing and each is asserted directly:
//
//   1. PASSTHROUGH IS TOTAL. `-V`, an unknown verb, an empty argv, a lone
//      surrogate, a 30 KB argument: each reaches the backend byte-identically.
//      Nothing is dropped, truncated, reordered or re-quoted.
//   2. `-V` NEEDS NO SPECIAL CASE. It is one element, so the grammar's own length
//      rule makes it pass-through. `rewritten === false` is asserted, so a future
//      change that grows a `-V` branch would fail here rather than silently
//      diverge from real psmux.
//   3. NO CREDENTIAL REACHES EITHER LOG. Asserted by grepping the exact bytes of
//      both files for a sentinel that was passed as an `-e` value, not by
//      inspecting the record shape.

import { afterEach, beforeEach, describe } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBackend } from "../src/backend";
import type { BackendOutcome, Resolution, ResolvedBackend } from "../src/backend";
import {
  CLI_CONTRACT,
  buildCallRecord,
  main,
  planInvocation,
  resolveCallLogPath,
  resolveTracePath,
  sanitisedArgv,
} from "../src/cli";
import type { MainDeps, ShimCallRecord } from "../src/cli";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** psmux 3.3.8 prints TWO lines (learnings V-2 / T-4 / I-5). A one-line
 *  expectation would make every byte-identity assertion in this file a false
 *  PASS or a false FAIL. */
const REAL_VERSION_STDOUT = "tmux 3.3.8\npsmux 3.3.8 (66cf613 2026-08-18)\n";

const PH_PLACEHOLDER =
  "/bin/sh -c \"printf '%s\\n%s\\n' \\\"OMO subagent pane ready: explore the tmux grammar module\\\" " +
  "\\\"Focus this pane to attach.\\\"; while :; do sleep 86400; done\"";

const PH_ATTACH =
  "/bin/sh -c \"opencode attach 'http://127.0.0.1:4096' --session 'ses_abc123' --dir '/home/dev/proj'\"";

const SENTINEL = "TRACE_SENTINEL_9f3c7a_d0_not_in_any_log";

interface BackendCall {
  readonly argv: readonly string[];
  readonly stdout: string;
  readonly exitCode: number;
}

/** A temp install dir holding an executable stand-in named `psmux.exe`, plus a
 *  staging dir that pretends to be the shim's own directory. Shebang scripts, so
 *  nothing under test can smuggle a shell in through the backend. */
interface Box {
  readonly dir: string;
  readonly installDir: string;
  readonly shimPath: string;
  readonly callLogPath: string;
  readonly tracePath: string;
  readonly callsPath: string;
  readonly profileDir: string;
  readonly calls: () => BackendCall[];
  readonly read: (path: string) => string;
  readonly lines: (path: string) => string[];
  readonly cleanup: () => void;
}

let box: Box;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "omo-cli-"));
  const installDir = join(dir, "psmux-install");
  const staging = join(dir, "staging", "bin");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(dir, "profile"), { recursive: true });

  const callsPath = join(dir, "backend-calls.jsonl");
  const shimPath = join(staging, "tmux.exe");
  writeFileSync(
    join(installDir, "psmux.exe"),
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync } from "node:fs";',
      `const callsPath = ${JSON.stringify(callsPath)};`,
      "const argv = process.argv.slice(2);",
      'const stdout = argv[0] === "-V" ? process.env["OMO_TEST_VERSION"] ?? "" : "";',
      'const exitCode = Number.parseInt(process.env["OMO_TEST_EXIT"] ?? "0", 10);',
      'appendFileSync(callsPath, JSON.stringify({ argv, stdout }) + "\\n");',
      'if (stdout.length > 0) process.stdout.write(stdout);',
      "process.exit(exitCode);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The shim image need not exist: the call log's directory is derived from the
  // shim's PATH, and nothing in this suite requires the file behind it.
  writeFileSync(shimPath, "not really an executable");

  box = {
    dir,
    installDir,
    shimPath,
    callLogPath: resolveCallLogPath(shimPath),
    tracePath: join(dir, "trace", "shim-trace.jsonl"),
    callsPath,
    profileDir: join(dir, "profile"),
    calls: (): BackendCall[] =>
      readIfPresent(callsPath)
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as BackendCall),
    read: readIfPresent,
    lines: (path: string): string[] =>
      readIfPresent(path)
        .split("\n")
        .filter((l) => l.length > 0),
    cleanup: (): void => rmSync(dir, { recursive: true, force: true }),
  };
});

afterEach(() => {
  box.cleanup();
});

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The dependency set that makes `main` behave like a staged production shim:
 *  the trace variable is UNSET, the shim lives in its own staging directory, and
 *  the backend is the temp stand-in. */
function deps(extra: MainDeps = {}): MainDeps {
  return {
    env: (name) => {
      const table: Record<string, string> = { OMO_PSMUX_INSTALL_DIR: box.installDir };
      if (name === "USERPROFILE") table["USERPROFILE"] = box.profileDir;
      if (name === "OMO_TEST_VERSION") table["OMO_TEST_VERSION"] = REAL_VERSION_STDOUT;
      return table[name];
    },
    cwd: box.dir,
    shimPath: box.shimPath,
    profileDir: box.profileDir,
    registryInstallDir: "",
    localAppData: "",
    writeStderr: () => undefined,
    ...extra,
  };
}

function callRecords(): ShimCallRecord[] {
  return box.lines(box.callLogPath).map((line) => JSON.parse(line) as ShimCallRecord);
}

// ---------------------------------------------------------------------------
// 1. The wiring, end to end, through the real resolver and the real exec
// ---------------------------------------------------------------------------

describe("wiring: grammar -> translate -> backend -> exec", () => {
  test("-V exits 0 and the backend's stdout arrives byte-identically, two lines and all", async () => {
    // Captured through `runBackend`, because the shim's own stdio is inherited —
    // which is the point: a shim that re-wrapped the bytes would be visible here.
    let captured: BackendOutcome = { exitCode: -1, stdout: "", stderr: "", signal: null };
    const run: NonNullable<MainDeps["run"]> = (backend, argv, options) =>
      runBackend(backend, argv, { ...options, captureOutput: true }).then((outcome) => {
        captured = outcome;
        return outcome;
      });
    const exitCode = await main(["-V"], deps({ backendEnv: { OMO_TEST_VERSION: REAL_VERSION_STDOUT }, run }));

    const direct = await runBackend(resolvedFor(box.installDir), ["-V"], {
      captureOutput: true,
      env: { OMO_TEST_VERSION: REAL_VERSION_STDOUT },
    });

    expect(exitCode).toBe(0);
    expect(captured.exitCode).toBe(0);
    expect(captured.stdout).toBe(REAL_VERSION_STDOUT);
    expect(captured.stdout).toBe(direct.stdout);
    expect(captured.stdout.length).toBe(44);
    expect(captured.stdout.endsWith("\n")).toBe(true);
    expect(captured.stderr).toBe("");
    // Two calls, both `["-V"]`: one through the shim, one the direct baseline.
    expect(box.calls().map((c) => c.argv)).toEqual([["-V"], ["-V"]]);
  });

  test("-V needs no special case: it is pass-through by the grammar's own length rule", () => {
    const plan = planInvocation(["-V"], deps());
    expect(plan.classification).toBe("pass-through");
    expect(plan.translation.kind).toBe("passthrough");
    expect(plan.translation.rewritten).toBe(false);
    expect(plan.translation.dashDashInserted).toBe(false);
    expect(plan.translation.argv).toEqual(["-V"]);
    expect(plan.helper).toBeUndefined();
    expect(plan.descriptor).toBeUndefined();
  });

  test("an unknown verb is forwarded verbatim, with the backend's exit code and streams", async () => {
    const argv = ["--totally-unknown-verb", "x", "y", "z"];

    const forwarded = await main(argv, deps({ backendEnv: { OMO_TEST_EXIT: "42" } }));
    const direct = await runBackend(resolvedFor(box.installDir), argv, {
      captureOutput: true,
      env: { OMO_TEST_EXIT: "42" },
    });

    expect(forwarded).toBe(42);
    expect(forwarded).toBe(direct.exitCode);
    expect(box.calls()[0]?.argv).toEqual(argv);
    expect(box.calls()[0]?.argv).toEqual(box.calls()[1]?.argv);
  });

  test("empty argv, a verb with no operands, and unpaired surrogates all forward without a crash", async () => {
    for (const argv of [[], ["split-window"]] as const) {
      expect(await main(argv, deps())).toBe(0);
      expect(box.calls().at(-1)?.argv).toEqual(argv);
    }

    // A lone surrogate is not representable in UTF-8, so the OS boundary is
    // entitled to substitute U+FFFD. What must not happen is a crash, a dropped
    // argument, or a changed arity — so that is what is asserted, not equality.
    for (const argv of [["\udcff"], ["--totally-unknown-verb", "\ud800", "\udfff"]] as const) {
      expect(await main(argv, deps())).toBe(0);
      const received = box.calls().at(-1)?.argv ?? [];
      expect(received).toHaveLength(argv.length);
    }
  });

  test("a 30 KB single argument is forwarded whole, not truncated", async () => {
    const big = "A".repeat(30 * 1024);
    const exitCode = await main(["--totally-unknown-verb", big], deps());

    expect(exitCode).toBe(0);
    const received = box.calls()[0]?.argv[1] ?? "";
    expect(received.length).toBe(30 * 1024);
    expect(createHash("sha256").update(received).digest("hex")).toBe(
      createHash("sha256").update(big).digest("hex"),
    );
  });

  test("a recognised placeholder shape is translated, and the record says how", () => {
    const plan = planInvocation(["split-window", "-h", "-P", "-F", PH_PLACEHOLDER], deps());

    expect(plan.classification).toBe("placeholder-split");
    expect(plan.translation.kind).toBe("helper");
    expect(plan.translation.rewritten).toBe(true);
    expect(plan.translation.dashDashInserted).toBe(false);
    expect(plan.translation.argv[0]).toBe("split-window");
    expect(plan.translation.argv.slice(1, 4)).toEqual(["-h", "-P", "-F"]);
    expect(plan.helper?.commandProgram).toBe("powershell");
    expect(plan.helper?.envSlots).toBe(0);

    // The `--payload` base64url must be in the ARGV and must not be in the LOG.
    const record = buildCallRecord({
      invocation: plan,
      at: "1970-01-01T00:00:00.000Z",
      pid: 1,
      outcome: "forwarded",
      exitCode: 0,
      durationMs: 0,
      descriptorFileUsed: false,
    });
    const encodedPayload = plan.translation.helperCommandLine ?? "";
    expect(encodedPayload).toContain("--payload ");
    expect(JSON.stringify(record)).not.toContain(encodedPayload);
    expect(JSON.stringify(record)).not.toContain("OMO subagent pane ready");
    expect(record.argv.at(-1)).toBe(CLI_CONTRACT.helperInvocationPlaceholder);
  });

  test("the attach shape inserts `--` and reaches the helper as an `opencode attach` vector", () => {
    const plan = planInvocation(
      ["respawn-pane", "-k", "-t", "%7", PH_ATTACH],
      deps(),
    );

    expect(plan.classification).toBe("attach-respawn");
    expect(plan.translation.dashDashInserted).toBe(true);
    const commandLine = plan.translation.helperCommandLine ?? "";
    expect(plan.translation.argv).toEqual([
      "respawn-pane",
      "-k",
      "-t",
      "%7",
      "--",
      commandLine,
    ]);
    expect(plan.helper?.commandProgram).toBe("opencode");
    expect(plan.helper?.commandVerb).toBe("attach");
    expect(plan.helper?.commandArgc).toBe(7);
    expect(plan.helper?.correlationId).toBe(plan.correlationId);
  });
});

// ---------------------------------------------------------------------------
// 2. The opt-in trace
// ---------------------------------------------------------------------------

describe("the trace hook", () => {
  test("unset: no trace destination is resolved and nothing is written there", async () => {
    const targets: string[] = [];
    await main(["-V"], deps({ writeLine: (target) => void targets.push(target) }));

    expect(resolveTracePath(undefined, box.dir)).toBeUndefined();
    expect(resolveTracePath("", box.dir)).toBeUndefined();
    expect(resolveTracePath("   ", box.dir)).toBeUndefined();
    expect(targets).toEqual([box.callLogPath]);
  });

  test("blank counts as unset, and the call log still receives its one line", async () => {
    await main(["-V"], deps({ env: (name) => (name === CLI_CONTRACT.traceEnv ? "  " : undefined) }));

    expect(existsSync(box.tracePath)).toBe(false);
    expect(box.lines(box.callLogPath)).toHaveLength(1);
  });

  test("set: exactly one JSON line per invocation, and it names verb/classification/outcome/id", async () => {
    const env = (name: string): string | undefined =>
      name === CLI_CONTRACT.traceEnv
        ? box.tracePath
        : deps().env?.(name);

    await main(["-V"], deps({ env }));
    expect(box.lines(box.tracePath)).toHaveLength(1);

    await main(["--totally-unknown-verb", "x"], deps({ env }));
    expect(box.lines(box.tracePath)).toHaveLength(2);

    const first = JSON.parse(box.lines(box.tracePath)[0] ?? "{}") as Record<string, unknown>;
    expect(first["v"]).toBe(1);
    expect(first["verb"]).toBe("-V");
    expect(first["classification"]).toBe("pass-through");
    expect(first["outcome"]).toBe("forwarded");
    expect(first["exitCode"]).toBe(0);
    expect(String(first["correlationId"])).toMatch(/^pane-[0-9a-z]+-[0-9a-f]{8}$/);

    // Every line is one complete JSON object, so the file is a valid JSONL.
    for (const line of box.lines(box.tracePath)) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("a relative trace setting is resolved against the working directory", () => {
    expect(resolveTracePath("nested/out.jsonl", box.dir)).toBe(join(box.dir, "nested/out.jsonl"));
    expect(resolveTracePath("/abs/out.jsonl", box.dir)).toBe("/abs/out.jsonl");
  });

  test("the trace is a bonus signal: a log that cannot be written does not change the exit code", async () => {
    const exitCode = await main(["-V"], deps({
      writeLine: () => {
        throw new Error("disk on fire");
      },
    }));
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The fixed-path call log — the attribution proof
// ---------------------------------------------------------------------------

describe("the fixed-path call log", () => {
  test("the path is derived from the executable's own directory and no environment variable", () => {
    expect(resolveCallLogPath("C:\\Users\\D\\bridge\\bin\\tmux.exe")).toBe(
      "C:\\Users\\D\\bridge\\bin\\state\\shim-calls.jsonl",
    );
    expect(resolveCallLogPath("/opt/bridge/bin/tmux.exe")).toBe("/opt/bridge/bin/state/shim-calls.jsonl");
    expect(resolveCallLogPath("C:\\tmux.exe")).toBe("C:\\state\\shim-calls.jsonl");
  });

  test("it is written with the trace variable UNSET, and the log exists in a directory that did not", async () => {
    expect(existsSync(dirname(box.callLogPath))).toBe(false);

    const exitCode = await main(["-V"], deps());

    expect(exitCode).toBe(0);
    expect(box.lines(box.callLogPath)).toHaveLength(1);
  });

  test("append-only across three invocations: one line each, nothing rewritten", async () => {
    for (const argv of [["-V"], ["--totally-unknown-verb", "x"], []]) {
      await main(argv, deps());
    }

    const lines = box.lines(box.callLogPath);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { verb: string }).verb)).toEqual([
      "-V",
      "--totally-unknown-verb",
      "",
    ]);
    // Distinct correlation ids: three invocations, three records.
    const ids = lines.map((l) => (JSON.parse(l) as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(3);

    const before = box.read(box.callLogPath);
    await main(["-V"], deps());
    expect(box.read(box.callLogPath).startsWith(before)).toBe(true);
  });

  test("every line is exactly one JSON object, newline-terminated, and the file ends with one newline", () => {
    // The shape a reader must be able to rely on: a partial final line would
    // mean a record was lost, and a missing final newline would mean the next
    // append concatenates onto it.
    const append = async (): Promise<void> => {
      await main(["-V"], deps());
    };
    return append().then(async () => {
      const raw = box.read(box.callLogPath);
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    });
  });

  test("the record names the backend and the translated shape, which is what attributes a pane", async () => {
    await main(["split-window", "-h", "-P", "-F", PH_PLACEHOLDER], deps());

    const record = callRecords()[0];
    expect(record?.backend).toBe(join(box.installDir, "psmux.exe"));
    expect(record?.backendName).toBe("psmux.exe");
    expect(record?.installDir).toBe(box.installDir);
    expect(record?.backendSource).toBe("env");
    expect(record?.resolution).toBe("resolved");
    expect(record?.verb).toBe("split-window");
    expect(record?.classification).toBe("placeholder-split");
    expect(record?.kind).toBe("helper");
    expect(record?.rewritten).toBe(true);
    expect(record?.argc).toBe(5);
    expect(record?.argv.slice(0, 4)).toEqual(["split-window", "-h", "-P", "-F"]);
    expect(record?.helper?.shell).toBe("powershell");
    expect(record?.helper?.commandProgram).toBe("powershell");
    expect(record?.helper?.envSlots).toBe(0);
  });

  test("a resolution failure is logged too, with the exit code an operator keys on", async () => {
    // `deps()` already blanks the registry and %LOCALAPPDATA%; blanking the
    // environment reader too leaves all three sources naming nothing.
    const exitCode = await main(["-V"], deps({ env: () => undefined }));

    expect(exitCode).toBe(69);
    const record = callRecords();
    expect(record).toHaveLength(1);
    expect(record[0]?.resolution).toBe("install-dir-unresolved");
    expect(record[0]?.outcome).toBe("install-dir-unresolved");
    expect(record[0]?.exitCode).toBe(69);
    expect(record[0]?.backend).toBeNull();
    expect(box.calls()).toHaveLength(0);
  });

  test("the chain guard's 78 propagates and is recorded, and nothing is executed", async () => {
    // The install directory holds nothing but the shim itself, under the name the
    // resolver tries. Same file, same realpath: the guard must break the
    // recursion rather than spawn a child that would spawn a child.
    const trapDir = join(box.dir, "trap");
    mkdirSync(trapDir, { recursive: true });
    const shimInTrap = join(trapDir, "tmux.exe");
    writeFileSync(shimInTrap, readFileSync(join(box.installDir, "psmux.exe")));

    const exitCode = await main(["-V"], deps({
      shimPath: shimInTrap,
      env: (name) => (name === "OMO_PSMUX_INSTALL_DIR" ? trapDir : undefined),
    }));

    expect(exitCode).toBe(78);
    // The call log follows the shim, so it followed it into the trap.
    const record = box
      .lines(resolveCallLogPath(shimInTrap))
      .map((line) => JSON.parse(line) as ShimCallRecord);
    expect(record).toHaveLength(1);
    expect(record[0]?.resolution).toBe("chain-guard");
    expect(record[0]?.outcome).toBe("chain-guard");
    expect(record[0]?.exitCode).toBe(78);
    expect(box.calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. No credential reaches either log
// ---------------------------------------------------------------------------

describe("no credential in either log", () => {
  test("a password-bearing `-e` pair reaches neither file, and the value is delivered by file", async () => {
    const written: { path: string; body: string }[] = [];

    await main(
      ["split-window", "-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`, "-h", "-P", PH_PLACEHOLDER],
      deps({
        env: (name) => (name === CLI_CONTRACT.traceEnv ? box.tracePath : deps().env?.(name)),
        writeDescriptorFile: (path, body) => void written.push({ path, body }),
      }),
    );

    // Both logs exist, and neither contains the sentinel — checked on the exact
    // bytes, not on a parsed shape.
    expect(box.lines(box.tracePath)).toHaveLength(1);
    expect(box.lines(box.callLogPath)).toHaveLength(1);
    expect(box.read(box.tracePath)).not.toContain(SENTINEL);
    expect(box.read(box.callLogPath)).not.toContain(SENTINEL);
    expect(JSON.stringify(callRecords()[0])).not.toContain(SENTINEL);

    // The NAME survives, because "which variables did this pane get" is the
    // useful half and the harmless half.
    const record = callRecords()[0];
    expect(record?.envSlotCount).toBe(1);
    expect(record?.envSlotNames).toEqual(["OPENCODE_SERVER_PASSWORD"]);
    expect(record?.descriptorFileUsed).toBe(true);

    // The argv handed to psmux carries no `-e` at all: the translator strips it on
    // every payload form, so the value cannot even reach a process listing.
    expect(record?.argv.some((a) => a.includes("OPENCODE_SERVER_PASSWORD"))).toBe(false);

    // The credential reached the helper the only way it is allowed to: a
    // restricted file named by the correlation id, never argv.
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toContain(record?.correlationId ?? "@@no-id@@");
    expect(written[0]?.body).toContain(SENTINEL);
    expect(record?.argv.join(" ")).not.toContain(SENTINEL);
  });

  test("the same holds on the PASS-THROUGH path, where psmux itself receives the `-e`", async () => {
    await main(
      ["--totally-unknown-verb", "-e", `OPENCODE_SERVER_PASSWORD=${SENTINEL}`, "x"],
      deps({
        env: (name) => (name === CLI_CONTRACT.traceEnv ? box.tracePath : deps().env?.(name)),
      }),
    );

    expect(box.read(box.tracePath)).not.toContain(SENTINEL);
    expect(box.read(box.callLogPath)).not.toContain(SENTINEL);

    const record = callRecords()[0];
    expect(record?.classification).toBe("pass-through");
    expect(record?.argv).toEqual([
      "--totally-unknown-verb",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${CLI_CONTRACT.redacted}`,
      "x",
    ]);
    // ...and psmux really did receive the real value, which is the point of
    // pass-through: the LOG is redacted, the EXECUTION is not.
    expect(box.calls()[0]?.argv).toEqual([
      "--totally-unknown-verb",
      "-e",
      `OPENCODE_SERVER_PASSWORD=${SENTINEL}`,
      "x",
    ]);
  });

  test("an unsensitively-named `-e` value is redacted anyway", () => {
    expect(sanitisedArgv(["split-window", "-e", "FOO=bar", "x"])).toEqual([
      "split-window",
      "-e",
      `FOO=${CLI_CONTRACT.redacted}`,
      "x",
    ]);
    expect(sanitisedArgv(["-e", "no-equals-sign"])).toEqual(["-e", CLI_CONTRACT.redacted]);
    expect(sanitisedArgv(["-e"])).toEqual(["-e"]);
  });

  test("a sensitive NAME=VALUE element outside a `-e` pair is redacted by name", () => {
    expect(sanitisedArgv(["MY_API_TOKEN=abc123"])).toEqual([`MY_API_TOKEN=${CLI_CONTRACT.redacted}`]);
    expect(sanitisedArgv(["PATH=/usr/bin"])).toEqual(["PATH=/usr/bin"]);
    expect(sanitisedArgv(["=novalue"])).toEqual(["=novalue"]);
  });

  test("a huge argv element is capped, with its real length stated", () => {
    const [only] = sanitisedArgv(["x".repeat(1000)]);
    expect(only?.startsWith("x".repeat(CLI_CONTRACT.maxLoggedArgLength))).toBe(true);
    expect(only).toContain("(1000B)");
    expect(only?.length).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvedFor(installDir: string): ResolvedBackend {
  const resolution: Resolution = {
    kind: "resolved",
    installDir,
    source: "env",
    backendPath: join(installDir, "psmux.exe"),
    backendName: "psmux.exe",
  };
  return resolution as ResolvedBackend;
}

