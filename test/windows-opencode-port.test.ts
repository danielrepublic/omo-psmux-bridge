// Native Windows coverage for omo-opencode-port.ps1 passthrough exit codes.
//
// THE DEFECT THIS EXISTS FOR
// --------------------------
// Every passthrough route in scripts/windows/bin/omo-opencode-port.ps1 ended in
// Start-RealOpencode, which read the child's exit code off the WRONG OBJECT:
//
//     $launch = New-OpencodeProcess ...
//     return $launch.ExitCode          # $launch is @{ Ok = $true; Proc = ... }
//
// New-OpencodeProcess's success shape carries no ExitCode key, and this script
// does not run under Set-StrictMode, so reading the absent key yielded $null.
// `exit $null` is `exit 0`. The wrapper therefore reported SUCCESS for an
// opencode that had crashed, been refused, or rejected its arguments -- on all
// four routes, for every possible child result. A shim that cannot fail is worse
// than no shim: the operator's tooling sees a clean exit and believes the pane
// came up. The fix reads $launch.Proc.ExitCode.
//
// WHY THIS NEEDS A REAL WINDOWS HOST
// ----------------------------------
// The read is only wrong at runtime, against a real Process object. A test that
// greps the source for `.Proc.ExitCode` proves the text is present, not that the
// value is the child's. So each route below drives the REAL shipped script under
// Windows PowerShell 5.1 and asserts the number that came out the other end.
//
// THE COUNTER, AND WHY IT IS NOT OPTIONAL
// ---------------------------------------
// The fixture is not just "something that exits non-zero". It is a compiled exe
// that appends a line to a counter file on every invocation and then exits 7.
// Without the counter, an exit code of 7 could not be told apart from a wrapper
// that had a DIFFERENT non-zero path -- and, more importantly, a route that
// short-circuited before spawning anything could never be distinguished from one
// that ran the child and propagated its code. The counter is what makes each
// assertion mean "the wrapper ran the child AND returned the child's code".
//
// Nothing here touches the real opencode, the user's config, the registry, or any
// live process. The child is a compiled Bun fixture placed in a per-run sandbox
// directory that is prepended to PATH in the CHILD environment only; APPDATA is
// redirected too, so the resolver's first choice -- the npm payload at
// %APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe -- cannot be found and
// the fixture is unambiguously what got launched. If that redirect ever stopped
// working, the real opencode would run instead and the counter would stay at
// zero, which fails the test rather than passing it silently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRAPPER = `${ROOT}scripts/windows/bin/omo-opencode-port.ps1`;

const ON_WINDOWS = process.platform === "win32";
const describeWin = ON_WINDOWS ? describe : describe.skip;

/** Hardcoded, not resolved through PATH: pwsh 7 is installed on this host and a
 *  bare `powershell` could pick it up, which would quietly change what is under
 *  test. The shipped script's own ps1 branch uses this exact host too. */
const POWERSHELL_51 = join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/** A code no other path in the wrapper can produce. Its own exits are 1 (port
 *  exhausted / stale), 126 (cannot start), 127 (cannot resolve). A route that
 *  exits 7 therefore really did run the child, and a route that exits 0 really
 *  did swallow it. */
const FIXTURE_EXIT = 7;

/** Unique per run, and never named like runtime-finish's `omo-helper-qa-*`
 *  sandboxes, so a concurrent native suite cannot be deleted by afterAll. */
const RUN = `portqa-${process.pid}-${Date.now().toString(36)}`;
const SANDBOX = join(tmpdir(), `omo-port-qa-${RUN}`);
const FIXTURE_DIR = join(SANDBOX, "bin");
const FIXTURE_EXE = join(FIXTURE_DIR, "opencode.exe");
const COUNTERS = join(SANDBOX, "counters");

/** The report shape opencode 1.19.4 / Bun 1.4.4 prints to stderr when the TUI
 *  aborts its external HTTP transport on a clean exit, captured on Linux
 *  against opencode 1.19.4 with `--port`. The 25-entry legacy constant table is
 *  abbreviated to its first and last entries because the filter matches the
 *  object boundary, never its contents; the full table was used to verify the
 *  regex separately. The fixture emits this so the native Windows suite can
 *  prove the wrapper removes it and nothing else. */
const BUN_ABORT_REPORT = [
  "AbortError: The operation was aborted.",
  "DOMException {",
  "  line: 2,",
  "  column: 10262,",
  '  sourceURL: "B:/~BUN/root/chunk-2nvkam47.js",',
  '  stack: "abort@[native code]\\n@B:/~BUN/root/chunk-2nvkam47.js:2:10262",',
  "  code: 20,",
  '  name: "AbortError",',
  '  message: "The operation was aborted.",',
  "  INDEX_SIZE_ERR: 1,",
  "  ABORT_ERR: 20,",
  "  toString: [Function: toString],",
  "}",
  "      at B:/~BUN/root/chunk-2nvkam47.js:2",
  "",
].join("\n");

/** Stderr the filter must NOT touch. The two sentinels bracket the report so a
 *  filter that drops the whole stream (instead of just the block) fails here,
 *  and the UTF-8 line proves replay is not re-encoded through the console code
 *  page. */
const SENTINEL_BEFORE = "SENTINEL-BEFORE-DUMP";
const SENTINEL_UTF8 = "SENTINEL-UTF8-中文-🚀";
const SENTINEL_AFTER = "SENTINEL-AFTER-DUMP";

/** Every marker is a line the report cannot survive. `at B:/~BUN` is the one
 *  trailing line Bun appends, which a filter that only drops the object would
 *  leave behind. */
const DUMP_MARKERS = [
  "AbortError: The operation was aborted.",
  "DOMException {",
  "INDEX_SIZE_ERR: 1",
  "ABORT_ERR: 20",
  "at B:/~BUN/root/chunk-2nvkam47.js:2",
] as const;

/** Records that it ran, then fails on purpose. The counter path and the exit
 *  code come from the environment so ONE compiled binary serves every case.
 *  `OMO_QA_STDERR_NOISE=dump|line` additionally emits the abort report (or
 *  only its first line) surrounded by sentinels; writeSync(2, ...) is used
 *  rather than process.stderr.write because the fixture exits immediately
 *  afterwards and a synchronous fd write cannot be dropped by that exit. */
const FIXTURE_SOURCE = [
  'import { appendFileSync, writeSync } from "node:fs";',
  'const counter = process.env["OMO_QA_COUNTER"];',
  "if (counter) appendFileSync(counter, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
  'const noise = process.env["OMO_QA_STDERR_NOISE"];',
  'if (noise === "dump") {',
  `  writeSync(2, ${JSON.stringify(`${SENTINEL_BEFORE}\n`)});`,
  `  writeSync(2, ${JSON.stringify(`${SENTINEL_UTF8}\n`)});`,
  `  writeSync(2, ${JSON.stringify(BUN_ABORT_REPORT)});`,
  `  writeSync(2, ${JSON.stringify(`${SENTINEL_AFTER}\n`)});`,
  "}",
  'if (noise === "line") {',
  `  writeSync(2, ${JSON.stringify(`${DUMP_MARKERS[0]}\n`)});`,
  `  writeSync(2, ${JSON.stringify("SENTINEL-LINE-ONLY\n")});`,
  "}",
  'process.exit(Number.parseInt(process.env["OMO_QA_EXIT"] ?? "7", 10));',
  "",
].join("\n");

/** Runs Update-StderrCapture against a reader whose SECOND ReadAsync throws, with
 *  a Pending task that is already completed and returns 4. Before the fix the
 *  catch only set Open=$false and the while re-tested the OLD completed Pending,
 *  re-appended the same 4 chars and called the throwing ReadAsync again: an
 *  unbounded spin. The process is killed by the spawn timeout in that case, so
 *  the test fails by status instead of hanging the suite. The function is
 *  extracted from the SHIPPED script's AST, so this is the real code, not a copy.
 *  Output is one marker plus the final Text length, and exit codes name the
 *  violated assertion. */
const CAPTURE_SPIN_PROBE = [
  "param([string]$Wrapper)",
  "$ErrorActionPreference = 'Stop'",
  "$tokens = $null; $errors = $null",
  "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Wrapper, [ref]$tokens, [ref]$errors)",
  "if ($errors.Count -gt 0) { exit 90 }",
  "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Update-StderrCapture' }, $true)",
  "if (-not $fn) { exit 91 }",
  "Invoke-Expression $fn.Extent.Text",
  "$pending = [System.Threading.Tasks.Task[int]]::FromResult(4)",
  "$buffer = [char[]]@('x', 'x', 'x', 'x')",
  "$text = New-Object System.Text.StringBuilder",
  "$reader = [pscustomobject]@{}",
  "$reader | Add-Member -MemberType ScriptMethod -Name ReadAsync -Value { throw 'pipe closed' }",
  "$capture = @{ Reader = $reader; Buffer = $buffer; Pending = $pending; Text = $text; Open = $true; Written = $false }",
  "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
  "Update-StderrCapture $capture",
  "$sw.Stop()",
  "if ($capture.Open) { exit 92 }",
  "if ($text.ToString() -ne 'xxxx') { exit 93 }",
  "if ($sw.ElapsedMilliseconds -gt 5000) { exit 94 }",
  "Write-Output 'SPIN_PROBE_OK'",
  "",
].join("\n");

interface Route {
  readonly name: string;
  /** Wrapper argv. Must avoid $PassthroughFlags on every route EXCEPT route 2,
   *  and $Argv[0] must be a passthrough subcommand only on route 3. */
  readonly argv: readonly string[];
  readonly tmux: string | undefined;
  readonly opencodePort: string | undefined;
  /** `dump` emits the whole report surrounded by sentinels; `line` emits only
   *  its first line, which the filter must leave alone. */
  readonly stderrNoise?: "dump" | "line";
}

const TMUX_VALUE = "/tmp/tmux-0/default,1234,0";
/** All digits, so the wrapper uses it verbatim and sets $Reserved = $false: no
 *  bind probe, no liveness wait, the plain Start-RealOpencode path. */
const EXPLICIT_PORT = "41234";

const ROUTES: readonly Route[] = [
  { name: "TMUX unset", argv: ["--totally-unknown-verb", "x"], tmux: undefined, opencodePort: undefined },
  { name: "--version", argv: ["--version"], tmux: TMUX_VALUE, opencodePort: undefined },
  { name: "passthrough subcommand", argv: ["run", "probe"], tmux: TMUX_VALUE, opencodePort: undefined },
  { name: "explicit OPENCODE_PORT", argv: ["tui", "probe"], tmux: TMUX_VALUE, opencodePort: EXPLICIT_PORT },
];

let sequence = 0;
function counterPath(tag: string): string {
  sequence += 1;
  return join(COUNTERS, `${RUN}-${tag}-${sequence}.log`);
}

function counterLines(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
}

beforeAll(() => {
  if (!ON_WINDOWS) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(COUNTERS, { recursive: true });
  const source = join(SANDBOX, "fixture.ts");
  writeFileSync(source, FIXTURE_SOURCE, "utf8");

  // A REAL .exe, because Resolve-RealOpencode prefers opencode.exe over
  // opencode.cmd, and because New-OpencodeProcess then launches it directly with
  // ProcessStartInfo -- no cmd.exe, no shell.
  const built = spawnSync(
    process.execPath,
    ["build", "--compile", source, "--outfile", FIXTURE_EXE],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (built.status !== 0 || !existsSync(FIXTURE_EXE)) {
    throw new Error(`could not build the fixture exe: ${built.stderr || built.stdout}`);
  }
});

afterAll(() => {
  if (!ON_WINDOWS) return;
  rmSync(SANDBOX, { recursive: true, force: true });
});

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runWrapper(route: Route, counter: string): RunResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Prepended, so the sandbox's opencode.exe is the first exe the PATH scan sees.
  env["PATH"] = `${FIXTURE_DIR};${env["PATH"] ?? ""}`;
  // Redirected, so %APPDATA%\npm does not exist and the resolver's first choice
  // (the real npm payload) cannot pre-empt the fixture.
  env["APPDATA"] = join(SANDBOX, "appdata");
  env["OMO_QA_COUNTER"] = counter;
  env["OMO_QA_EXIT"] = String(FIXTURE_EXIT);
  if (route.tmux === undefined) delete env["TMUX"];
  else env["TMUX"] = route.tmux;
  if (route.opencodePort === undefined) delete env["OPENCODE_PORT"];
  else env["OPENCODE_PORT"] = route.opencodePort;
  if (route.stderrNoise) env["OMO_QA_STDERR_NOISE"] = route.stderrNoise;
  else delete env["OMO_QA_STDERR_NOISE"];

  const result = spawnSync(
    POWERSHELL_51,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WRAPPER, ...route.argv],
    { encoding: "utf8", env, timeout: 120_000, windowsHide: true },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describeWin("omo-opencode-port.ps1 propagates the real opencode's exit code", () => {
  test("the fixture is a real exe and is what the resolver would pick", () => {
    // Guards the whole file: if this fails, every assertion below is measuring
    // something other than the shipped resolver.
    expect(existsSync(FIXTURE_EXE)).toBe(true);
    expect(existsSync(POWERSHELL_51)).toBe(true);
    expect(existsSync(WRAPPER)).toBe(true);
  });

  for (const route of ROUTES) {
    test(`the ${route.name} route returns the child's non-zero code, not 0`, () => {
      const counter = counterPath(route.name.replace(/\W+/g, "-"));
      const result = runWrapper(route, counter);
      const invocations = counterLines(counter);

      // The explicit-port route is the one that rewrites argv: it prepends
      // --port. Every other route must forward byte-for-byte.
      const expectedArgv =
        route.opencodePort === undefined ? [...route.argv] : ["--port", route.opencodePort, ...route.argv];

      // The child really ran, exactly once, with exactly the argv the wrapper
      // decided on. Asserting the CONTENT and not just the count is what makes
      // this a passthrough test: without it, a wrapper that ran the child three
      // times, or with the wrong argv, would satisfy a bare count.
      // And without the counter entirely, a wrapper that exited before spawning
      // anything could satisfy the exit-code assertion by accident.
      expect({ route: route.name, invocations }).toEqual({
        route: route.name,
        invocations: [JSON.stringify(expectedArgv)],
      });

      // Equality AND inequality. The defect's signature is "0 whatever the
      // child did", so pinning only one of these two leaves a route free to
      // regress to either failure.
      expect(result.status).not.toBe(0);
      expect(result.status).toBe(FIXTURE_EXIT);

      // The fixture must never have been reached through a shell, and the
      // wrapper must not have failed to resolve anything.
      expect(result.stderr).not.toContain("could not resolve the real opencode");
      expect(result.stderr).not.toContain("unsupported real-opencode kind");
    });
  }

  test("a child that succeeds still returns 0, so the fix did not invert the contract", () => {
    const counter = counterPath("success");
    const envExit = 0;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env["PATH"] = `${FIXTURE_DIR};${env["PATH"] ?? ""}`;
    env["APPDATA"] = join(SANDBOX, "appdata");
    env["OMO_QA_COUNTER"] = counter;
    env["OMO_QA_EXIT"] = String(envExit);
    delete env["TMUX"];

    const result = spawnSync(
      POWERSHELL_51,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WRAPPER, "--probe", "ok"],
      { encoding: "utf8", env, timeout: 120_000, windowsHide: true },
    );

    expect(counterLines(counter)).toHaveLength(1);
    expect(result.status).toBe(0);
  });

  test("a second distinct non-zero code propagates unchanged, so it is not hardcoded to one value", () => {
    const counter = counterPath("other-code");
    const other = 33;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env["PATH"] = `${FIXTURE_DIR};${env["PATH"] ?? ""}`;
    env["APPDATA"] = join(SANDBOX, "appdata");
    env["OMO_QA_COUNTER"] = counter;
    env["OMO_QA_EXIT"] = String(other);
    delete env["TMUX"];

    const result = spawnSync(
      POWERSHELL_51,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WRAPPER, "--probe", "other"],
      { encoding: "utf8", env, timeout: 120_000, windowsHide: true },
    );

    expect(counterLines(counter)).toHaveLength(1);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(other);
  });
});

function invocationArgv(counter: string): readonly string[][] {
  return counterLines(counter).map((line) => JSON.parse(line) as string[]);
}

/** The whole point of the capture is "remove the report, keep everything else".
 *  All three sentinels must survive, including the UTF-8 one, and no marker of
 *  the report may remain. Asserting only the absence would also pass for a
 *  wrapper that dropped stderr entirely. */
function expectAbortReportSuppressed(result: RunResult): void {
  expect(result.stderr).toContain(SENTINEL_BEFORE);
  expect(result.stderr).toContain(SENTINEL_UTF8);
  expect(result.stderr).toContain(SENTINEL_AFTER);
  for (const marker of DUMP_MARKERS) {
    expect(result.stderr).not.toContain(marker);
  }
}

describeWin("omo-opencode-port.ps1 removes the Bun abort report its port launches provoke", () => {
  test("the auto-port TUI launch filters the report and preserves the rest of stderr", () => {
    const counter = counterPath("noise-auto-port");
    const result = runWrapper(
      {
        name: "auto-port TUI",
        argv: ["tui", "probe"],
        tmux: TMUX_VALUE,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    const invocations = invocationArgv(counter);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]![0]).toBe("--port");
    const port = Number.parseInt(invocations[0]![1]!, 10);
    expect(port).toBeGreaterThanOrEqual(7801);
    expect(port).toBeLessThanOrEqual(7901);
    expect(invocations[0]!.slice(2)).toEqual(["tui", "probe"]);

    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
    // The wrapper's own diagnostic shares stderr with the capture; filtering
    // the child must not touch it.
    expect(result.stderr).toContain("[opencode-wrapper] tmux detected");
  });

  test("the explicit OPENCODE_PORT launch also filters the report", () => {
    const counter = counterPath("noise-explicit-port");
    const result = runWrapper(
      {
        name: "explicit-port TUI",
        argv: ["tui", "probe"],
        tmux: TMUX_VALUE,
        opencodePort: EXPLICIT_PORT,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--port", EXPLICIT_PORT, "tui", "probe"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
  });

  test("a caller-supplied --port TUI launch also filters the report", () => {
    const counter = counterPath("noise-caller-port");
    const port = "41235";
    const result = runWrapper(
      {
        name: "caller-port TUI",
        argv: ["--port", port, "tui"],
        tmux: TMUX_VALUE,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--port", port, "tui"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
  });

  test("a passthrough subcommand keeps its stderr live", () => {
    const counter = counterPath("noise-serve");
    const result = runWrapper(
      {
        name: "serve passthrough",
        argv: ["serve", "--port", "41236"],
        tmux: TMUX_VALUE,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["serve", "--port", "41236"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    // serve is an operator surface: buffering it would hide live logs, so the
    // report is deliberately not filtered here.
    expect(result.stderr).toContain(SENTINEL_BEFORE);
    expect(result.stderr).toContain("AbortError: The operation was aborted.");
    expect(result.stderr).toContain("DOMException {");
  });

  test("outside tmux without a port, stderr stays untouched", () => {
    const counter = counterPath("noise-no-tmux");
    const result = runWrapper(
      {
        name: "no tmux",
        argv: ["tui"],
        tmux: undefined,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(result.status).toBe(FIXTURE_EXIT);
    expect(result.stderr).toContain(SENTINEL_BEFORE);
    expect(result.stderr).toContain("AbortError: The operation was aborted.");
  });

  test("a bare AbortError line without the DOMException object survives", () => {
    const counter = counterPath("noise-line-only");
    const result = runWrapper(
      {
        name: "line-only",
        argv: ["tui"],
        tmux: TMUX_VALUE,
        opencodePort: undefined,
        stderrNoise: "line",
      },
      counter,
    );

    expect(result.status).toBe(FIXTURE_EXIT);
    // The filter is anchored to the two-line report; a diagnostic that only
    // shares the first line is not the report and must reach the operator.
    expect(result.stderr).toContain("AbortError: The operation was aborted.");
    expect(result.stderr).toContain("SENTINEL-LINE-ONLY");
  });

  test("outside tmux, a --hostname TUI launch is captured too", () => {
    const counter = counterPath("noise-hostname");
    const result = runWrapper(
      {
        name: "hostname TUI",
        argv: ["--hostname", "0.0.0.0", "tui"],
        tmux: undefined,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--hostname", "0.0.0.0", "tui"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
  });

  test("a global option before a subcommand does not turn a server into a captured TUI", () => {
    const counter = counterPath("noise-global-before-serve");
    const result = runWrapper(
      {
        name: "global-before-serve",
        argv: ["--log-level", "debug", "serve", "--port", "41237"],
        tmux: TMUX_VALUE,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--log-level", "debug", "serve", "--port", "41237"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    // opencode's global options may precede the subcommand. The server's stderr
    // must stay live, so the report is not filtered on this route.
    expect(result.stderr).toContain("AbortError: The operation was aborted.");
  });

  test("an option VALUE equal to a subcommand name does not disable capture", () => {
    const counter = counterPath("noise-log-level-value");
    const result = runWrapper(
      {
        name: "log-level value",
        // `debug` is a PASSTHROUGH SUBCOMMAND NAME but here it is the value of
        // --log-level. The old any-element scan returned false and leaked the
        // report. This is still the default TUI command, so it must be filtered.
        argv: ["--log-level", "debug", "--port", "41238"],
        tmux: undefined,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--log-level", "debug", "--port", "41238"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
  });

  test("a --prompt value equal to a subcommand name does not disable capture", () => {
    const counter = counterPath("noise-prompt-value");
    const result = runWrapper(
      {
        name: "prompt value",
        // `run` is the PROMPT, not the subcommand; --prompt consumes it.
        argv: ["--port", "41239", "--prompt", "run"],
        tmux: undefined,
        opencodePort: undefined,
        stderrNoise: "dump",
      },
      counter,
    );

    expect(invocationArgv(counter)).toEqual([["--port", "41239", "--prompt", "run"]]);
    expect(result.status).toBe(FIXTURE_EXIT);
    expectAbortReportSuppressed(result);
  });
});

describeWin("Update-StderrCapture does not spin when the stderr pipe breaks", () => {
  test("a throwing ReadAsync stops the drain after one append", () => {
    const script = join(SANDBOX, "spin-probe.ps1");
    writeFileSync(script, CAPTURE_SPIN_PROBE, "ascii");

    const result = spawnSync(
      POWERSHELL_51,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Wrapper",
        WRAPPER,
      ],
      // Before the fix this spins forever; the timeout turns that into a
      // failing status instead of a hung suite.
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SPIN_PROBE_OK");
  });
});
