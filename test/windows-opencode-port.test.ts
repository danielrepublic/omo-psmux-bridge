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

/** Records that it ran, then fails on purpose. The counter path and the exit
 *  code come from the environment so ONE compiled binary serves every case. */
const FIXTURE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'const counter = process.env["OMO_QA_COUNTER"];',
  "if (counter) appendFileSync(counter, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
  'process.exit(Number.parseInt(process.env["OMO_QA_EXIT"] ?? "7", 10));',
  "",
].join("\n");

interface Route {
  readonly name: string;
  /** Wrapper argv. Must avoid $PassthroughFlags on every route EXCEPT route 2,
   *  and $Argv[0] must be a passthrough subcommand only on route 3. */
  readonly argv: readonly string[];
  readonly tmux: string | undefined;
  readonly opencodePort: string | undefined;
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
  writeFileSync(source, FIXTURE_SOURCE, "ascii");

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