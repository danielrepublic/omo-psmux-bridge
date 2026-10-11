// Native execution tests for scripts/windows/runtime/Start-PaneFromDescriptor.ps1.
//
// Every contract this helper advertises is a claim about BYTES and EXIT CODES,
// and no amount of reading the script proves any of them: whether
// `--command` really arrives as a token vector, whether a credential file is
// really deleted, whether the trace really omits the secret, whether the pane's
// own exit code really propagates. All of it is only observable by RUNNING the
// helper on a Windows host under Windows PowerShell, which is why this file is
// the one suite in the repository that executes the shipped script rather than
// describing it.
//
// Windows PowerShell 5.1 is MANDATORY here, not a preference. pwsh 7 is a
// different argument binder with different quoting rules, so a suite that only
// ran on pwsh would prove the helper works on a host where it is not the host
// that will run it. The two suites are registered separately and each reports
// which interpreter it used.
//
// ISOLATION. Each run gets its own correlation id and its own USERPROFILE, both
// unique per process. The helper resolves its credential fallback file from
// %USERPROFILE%, so redirecting it per run means these tests never read, write or
// delete anything in the real profile -- including another QA run's fixtures
// executing concurrently on the same host. `OMO_PANE_ENV_*` is stripped from the
// inherited environment for the same reason: a real pane's credential must never
// be visible to a test, and a test must never consume one.
//
// The helper writes its trace to <bridge-root>/state/pane-<id>.jsonl, where the
// bridge root is derived from the helper's own location, so those files are
// removed again in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeSlotPayload } from "../src/descriptor";

// ---------------------------------------------------------------------------
// Fixtures and identity
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPER = `${ROOT}scripts/windows/runtime/Start-PaneFromDescriptor.ps1`;
/** The helper derives its trace directory from `Split-Path -Parent $PSScriptRoot`. */
const BRIDGE_ROOT = `${ROOT}scripts/windows`;

const ON_WINDOWS = process.platform === "win32";
const describeWin = ON_WINDOWS ? describe : describe.skip;

/** Matches the helper's `^[a-z0-9-]+$`, 64 chars max, so it is a SAFE correlation
 *  id and still unique per process: no run can collide with another run's trace
 *  file, which is what would otherwise turn a second run into a false 67. */
const RUN = `helperqa-${process.pid}-${Date.now().toString(36)}`;
const SANDBOX = join(tmpdir(), `omo-helper-qa-${RUN}`);

/** The observer script's own path. It IS the pane program every delivery test
 *  runs, so it must be the file the harness writes. */
const OBSERVER = join(SANDBOX, "observer.ps1");
/** Fixed slot names so the observer's report shape is identical everywhere and an
 *  assertion never has to guess which variable a test used. */
const SLOT_USER = "OMO_QA_USER";
const SLOT_TOKEN = "OMO_QA_TOKEN";
/** Values chosen to be unguessable, so "the trace does not contain the secret"
 *  is a real search and not a search for a word that appears in a path. */
const SECRET_USER = "who-9f3a21c7";
const SECRET_TOKEN = "tok=9f3a21c7=x";

const POWERSHELL_51 = join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

let sequence = 0;
function correlationId(tag: string): string {
  sequence += 1;
  return `${RUN}-${tag}-${sequence}`;
}

/** Everything a test may leave on disk, removed in afterAll. */
const created: string[] = [];
function track(path: string): string {
  created.push(path);
  return path;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** The helper's `ConvertFrom-Base64Url` inverse: unpadded, URL-safe base64 of the
 *  UTF-8 text. Node's `base64url` encoding is already unpadded and uses - and _,
 *  which is exactly what the helper accepts. */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The real producer of the credential fallback file. Imported rather than
 *  reimplemented so a drift between the shim's writer and the helper's digest
 *  check fails HERE, where the two are executed together. */
function fallbackBody(assignments: readonly string[]): string {
  const slots = assignments.map((assignment, index) => ({
    index,
    variable: `OMO_PANE_ENV_${index}`,
    assignment,
  }));
  return serializeSlotPayload(slots).body;
}

function fallbackPath(id: string): string {
  return join(SANDBOX, ".omo-pane-env", "state", `desc-${id}.env`);
}

function tracePath(id: string): string {
  return join(BRIDGE_ROOT, "state", `pane-${id}.jsonl`);
}

function writeFallback(id: string, body: string): string {
  const path = track(fallbackPath(id));
  mkdirSync(join(SANDBOX, ".omo-pane-env", "state"), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

/** The helper's trace record. Typed rather than `Record<string, unknown>` on
 *  purpose: tsconfig enables noPropertyAccessFromIndexSignature, so an index
 *  signature would force every field read in this file to be written
 *  `record["outcome"]`. Naming the fields also means a helper that drops one is a
 *  compile error here rather than an `undefined` at runtime. */
interface TraceRecord {
  readonly correlationId: string;
  readonly kind: string;
  readonly program: string;
  readonly verb: string;
  readonly envMechanism: string;
  readonly slotCount: number;
  readonly slotNames: readonly string[];
  readonly descriptorFileUsed: boolean;
  readonly deleteVerified: boolean;
  readonly attachRetryApplies: boolean;
  readonly attachWaitMs: number;
  readonly attachRetries: number;
  readonly exitCode: number;
  readonly outcome: string;
}

function readTrace(id: string): TraceRecord[] {
  const path = tracePath(id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceRecord);
}

function readTraceText(id: string): string {
  const path = tracePath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// ---------------------------------------------------------------------------
// Running the helper
// ---------------------------------------------------------------------------

interface HelperSpec {
  readonly commandJson?: string;
  readonly rawCommand?: string;
  readonly rawCorrelation?: string;
  readonly omit?: readonly string[];
  readonly extraArgs?: readonly string[];
  readonly cwd?: string;
  readonly envSlots?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly correlation: string;
}

interface HelperRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(exe: string, spec: HelperSpec): HelperRun {
  const argv = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    HELPER,
  ];
  const omit = new Set(spec.omit ?? []);
  const add = (flag: string, value: string) => {
    if (omit.has(flag)) return;
    argv.push(flag, value);
  };
  add("--payload", b64url(JSON.stringify({ v: 1, probe: true })));
  if (spec.rawCommand !== undefined) add("--command", spec.rawCommand);
  else add("--command", b64url(spec.commandJson ?? JSON.stringify([OBSERVER, join(SANDBOX, "unreached.json")])));
  if (spec.cwd !== undefined) add("--cwd", b64url(spec.cwd));
  add("--env-slots", String(spec.envSlots ?? 0));
  if (spec.rawCorrelation !== undefined) add("--correlation", spec.rawCorrelation);
  else add("--correlation", b64url(spec.correlation));
  for (const extra of spec.extraArgs ?? []) argv.push(extra);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Never inherit a live pane's credential into a test, and never let a test
    // consume one: the helper deletes the fallback file it reads.
    if (key.startsWith("OMO_PANE_ENV_")) continue;
    env[key] = value;
  }
  env["USERPROFILE"] = SANDBOX;
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const result = spawnSync(exe, argv, {
    encoding: "utf8",
    env,
    timeout: 60_000,
    windowsHide: true,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The command that makes the helper's delivery observable: it reports the
 *  working directory it inherited, every argv element it received, and the two
 *  slot variables, then exits with the requested code.
 *
 *  The pane program is Windows PowerShell itself -- a NATIVE EXE -- with the
 *  observer behind `-File`. That detail is load-bearing and was measured: the
 *  helper execs its pane command with `& $program @commandArgs`, and when
 *  `$program` is a native exe PowerShell uses the native command-line binder,
 *  which does not escape embedded double quotes and drops an empty argument.
 *  When `$program` is a `.ps1` instead, the SCRIPT binder is used and both
 *  round-trip perfectly. Measuring through the script binder would report the
 *  native binder as sound when it is not, so the fidelity assertions below would
 *  have been proving the opposite of what they claim. */
function observerCommand(reportPath: string, exitCode: number, extra?: readonly string[]): string[] {
  return [POWERSHELL_51, "-NoProfile", "-NonInteractive", "-File", OBSERVER, reportPath, String(exitCode), ...(extra ?? [])];
}

/** Where the payload starts in the observer's `$args`. `powershell.exe -File
 *  script.ps1 a b c` binds `$args` to (a, b, c): the executable, its switches
 *  and the script path are all consumed by the host and never reach `$args`. So
 *  the two leading elements are the report path and the exit code, and the tokens
 *  under test begin at 2. */
const OBSERVER_ARGV_PREFIX = 2;

function readReport(path: string): {
  cwd: string;
  args: string[];
  env: Record<string, string>;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

function reportFor(tag: string): string {
  return track(join(SANDBOX, `${tag}.json`));
}

function cwdFor(tag: string): string {
  const dir = track(join(SANDBOX, `cwd-${tag}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A stub directory prepended to the PATH of one child process only. Nothing is
 *  installed and nothing outside SANDBOX is touched: the child resolves `opencode`
 *  here for the length of one run and the sandbox is removed in afterAll.
 *  Deliberately NOT tracked: `track` removes single files, and this is a
 *  directory. The recursive removal of SANDBOX covers it. */
const STUB_DIR = join(SANDBOX, "stub-bin");
const STUB_COUNTER = track(join(SANDBOX, "stub-invocations.txt"));

/** An `opencode` that always fails and records every invocation. The counter is
 *  what makes "exactly one retry" observable: the helper's own `attachRetries`
 *  field is written by the same code that performs the retry, so on its own it
 *  would agree with any number of attempts. */
function writeFailingOpenCodeStub(): void {
  mkdirSync(STUB_DIR, { recursive: true });
  writeFileSync(
    join(STUB_DIR, "opencode.cmd"),
    ["@echo off", `>>"${STUB_COUNTER}" echo invoked`, "exit /b 3", ""].join("\r\n"),
    "ascii",
  );
}

function stubInvocationCount(): number {
  if (!existsSync(STUB_COUNTER)) return 0;
  const text = readFileSync(STUB_COUNTER, "utf8").trim();
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const OBSERVER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$reportPath = [string]$args[0]",
  "$exitCode = 0",
  "if ($args.Count -gt 1) { $exitCode = [int]$args[1] }",
  "$o = [ordered]@{",
  "    cwd = (Get-Location).Path",
  "    args = @($args)",
  "    env = [ordered]@{}",
  "}",
  `foreach ($n in @(${psQuote(SLOT_USER)}, ${psQuote(SLOT_TOKEN)})) {`,
  "    $o.env[$n] = [System.Environment]::GetEnvironmentVariable($n)",
  "}",
  "$json = $o | ConvertTo-Json -Compress -Depth 5",
  "[System.IO.File]::WriteAllText($reportPath, $json, (New-Object System.Text.UTF8Encoding($false)))",
  "exit $exitCode",
].join("\r\n");

beforeAll(() => {
  if (!ON_WINDOWS) return;
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(OBSERVER, OBSERVER_SCRIPT, "utf8");
  expect(existsSync(HELPER)).toBe(true);
});

afterAll(() => {
  // `recursive` covers the tracked directories (cwd fixtures) as well as the
  // tracked files, so adding a directory fixture can never fail the suite's own
  // teardown. The recursive removal of SANDBOX below is the backstop.
  for (const path of created) rmSync(path, { force: true, recursive: true });
  rmSync(SANDBOX, { force: true, recursive: true });
});

// ---------------------------------------------------------------------------
// The suite, registered per interpreter
// ---------------------------------------------------------------------------

interface SuiteOptions {
  readonly label: string;
  readonly exe: string;
  readonly slow: boolean;
  /** True on Windows PowerShell 5.1, whose native command-line binder does not
   *  escape an embedded double quote and drops an empty argument. False on pwsh 7,
   *  which binds both correctly. Measured, not assumed: the fidelity assertions
   *  below differ per interpreter because the measured behaviour does, and
   *  asserting one interpreter's behaviour on the other would make one lane a
   *  silent, permanent failure. */
  readonly lossyNativeBinding: boolean;
}

/** Bun's default per-test budget is 5 s. One Windows PowerShell start on this host
 *  costs 0.5-1.5 s, and a command-discovery miss can spike past 5 s on its own, so
 *  the default would report a product failure as a timeout. */
const TEST_TIMEOUT_MS = 30_000;

const qa = (name: string, fn: () => void | Promise<void>, timeout: number = TEST_TIMEOUT_MS): void => {
  test(name, fn, timeout);
};

function helperSuite({ label, exe, slow, lossyNativeBinding }: SuiteOptions): void {
  describeWin(`Start-PaneFromDescriptor.ps1 under ${label}`, () => {
    // -- exit 64, usage ------------------------------------------------------

    describe("exit 64: a malformed invocation is refused before anything runs", () => {
      qa("a missing --payload is refused", () => {
        // Given: an invocation with no --payload
        const id = correlationId("nopayload");
        track(tracePath(id));
        const run = runHelper(exe, { omit: ["--payload"], correlation: id });
        // Then: usage, and nothing was claimed or run
        expect(run.status).toBe(64);
        expect(readTrace(id)).toEqual([]);
      });

      qa("a missing --command is refused", () => {
        const id = correlationId("nocommand");
        track(tracePath(id));
        const run = runHelper(exe, { omit: ["--command"], correlation: id });
        expect(run.status).toBe(64);
        expect(readTrace(id)).toEqual([]);
      });

      qa("a dangling flag is refused, not read as a value", () => {
        // Given: --payload with nothing after it
        const id = correlationId("dangling");
        track(tracePath(id));
        // When: the flag is passed on its own
        const run = runHelper(exe, {
          omit: ["--payload"],
          extraArgs: ["--payload"],
          correlation: id,
        });
        // Then: usage rather than a payload of "--correlation"
        expect(run.status).toBe(64);
      });

      qa("an unknown flag is refused", () => {
        const id = correlationId("unknownflag");
        track(tracePath(id));
        const run = runHelper(exe, { extraArgs: ["--nope", "1"], correlation: id });
        expect(run.status).toBe(64);
        expect(readTrace(id)).toEqual([]);
      });

      qa("a --command that is not base64url is refused", () => {
        const id = correlationId("badb64");
        track(tracePath(id));
        const run = runHelper(exe, { rawCommand: "not valid base64url!!", correlation: id });
        expect(run.status).toBe(64);
      });

      qa("an unsafe --correlation is refused before a trace is named", () => {
        // Given: a correlation id carrying a path separator, which would let the
        // trace and the credential fallback file escape their directories
        const id = correlationId("badsig");
        track(tracePath(id));
        // When: the flag value decodes to something that is not ^[a-z0-9-]+$
        const run = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(reportFor("badsig"), 0)),
          rawCorrelation: b64url("../../escape"),
          correlation: id,
        });
        // Then: usage, and the trace for that id is never created
        expect(run.status).toBe(64);
        expect(readTrace(id)).toEqual([]);
        expect(existsSync(join(SANDBOX, "escape"))).toBe(false);
      });

      // The regression: `--command` is documented as a JSON ARRAY of tokens.
      // ConvertFrom-Json unwraps a 1-element array into a scalar, and the helper
      // normalises that back on purpose. The same branch also accepted a
      // top-level JSON STRING, which is not an array at all: a single string
      // became a one-token command and the helper exec'd it as a program name.
      qa("a top-level JSON string in --command is refused", () => {
        // Given: valid base64url of `"not-an-array"` -- valid JSON, wrong shape
        const id = correlationId("scalar");
        track(tracePath(id));
        const run = runHelper(exe, {
          commandJson: JSON.stringify("not-an-array"),
          correlation: id,
        });
        // Then: usage. The contract says array; a scalar is a translator bug and
        // must surface here, not be executed.
        expect(run.status).toBe(64);
        expect(readTrace(id)).toEqual([]);
      });

      qa("a one-element --command array still runs", () => {
        // Given: the case the unwrap branch exists to support
        const report = reportFor("one-element");
        const id = correlationId("onearray");
        track(tracePath(id));
        // When: --command is `["<observer>", "<report>", "0"]`
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, report, "0"]),
          correlation: id,
        });
        // Then: it ran. A fix that rejects scalars must not reject this.
        expect(run.status).toBe(0);
        expect(existsSync(report)).toBe(true);
      });

      qa("an empty --command array is refused", () => {
        const id = correlationId("emptycmd");
        track(tracePath(id));
        const run = runHelper(exe, { commandJson: "[]", correlation: id });
        expect(run.status).toBe(64);
      });
    });

    // -- exit 65, malformed ---------------------------------------------------

    describe("exit 65: a slot that is not an assignment is refused", () => {
      qa("an environment slot with no '=' is malformed", () => {
        const id = correlationId("noeq");
        track(tracePath(id));
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, reportFor("noeq"), "0"]),
          envSlots: 1,
          env: { OMO_PANE_ENV_0: "NOT_AN_ASSIGNMENT" },
          correlation: id,
        });
        expect(run.status).toBe(65);
        const trace = readTrace(id);
        expect(trace.at(-1)?.outcome).toBe("malformed");
      });

      qa("an environment slot with an empty name is malformed", () => {
        // Given: `=value`, which would otherwise apply an empty variable name
        const id = correlationId("emptyname");
        track(tracePath(id));
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, reportFor("emptyname"), "0"]),
          envSlots: 1,
          env: { OMO_PANE_ENV_0: "=value" },
          correlation: id,
        });
        // Then: refused rather than setting a nameless variable
        expect(run.status).toBe(65);
      });

      qa("a fallback file whose digest does not match is malformed", () => {
        // Given: a structurally valid file carrying the wrong digest
        const id = correlationId("baddigest");
        track(tracePath(id));
        writeFallback(id, JSON.stringify({ v: 1, digest: "0".repeat(64), count: 1, assignments: ["A=b"] }));
        // When: the helper reads it
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, reportFor("baddigest"), "0"]),
          envSlots: 1,
          correlation: id,
        });
        // Then: refused, and the record says so
        expect(run.status).toBe(65);
        expect(readTrace(id).at(-1)?.outcome).toBe("malformed");
      });
    });

    // -- exit 66, absent ------------------------------------------------------

    describe("exit 66: a promised credential that is nowhere is refused", () => {
      qa("no environment slot and no fallback file is absent", () => {
        // Given: --env-slots 1 with nothing in the environment and no file
        const id = correlationId("absent");
        track(tracePath(id));
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, reportFor("absent"), "0"]),
          envSlots: 1,
          correlation: id,
        });
        // Then: refused, and the pane never started
        expect(run.status).toBe(66);
        const trace = readTrace(id);
        expect(trace.at(-1)?.outcome).toBe("absent");
        expect(trace.at(-1)?.envMechanism).toBe("file");
      });
    });

    // -- exit 67, consume once ------------------------------------------------

    describe("exit 67: a descriptor is claimed by exclusive creation", () => {
      qa("a second run for the same correlation id refuses to launch", () => {
        // Given: one successful run, which has created the trace file
        const id = correlationId("consumeonce");
        track(tracePath(id));
        const first = reportFor("consume-first");
        const one = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(first, 0)),
          correlation: id,
        });
        expect(one.status).toBe(0);
        expect(existsSync(first)).toBe(true);

        // When: the same descriptor is presented a second time
        const second = reportFor("consume-second");
        const two = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(second, 0)),
          correlation: id,
        });
        // Then: refused with EX_NOUSER, and the second pane never started
        expect(two.status).toBe(67);
        expect(existsSync(second)).toBe(false);
        // Then: and the first run's trace was not extended, so nothing executed
        expect(readTrace(id)).toHaveLength(2);
      });
    });

    // -- environment delivery -------------------------------------------------

    describe("credential delivery: environment first, then the restricted file", () => {
      qa("a complete environment is used and no file is touched", () => {
        const id = correlationId("envmech");
        track(tracePath(id));
        const report = reportFor("envmech");
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, report, "0"]),
          envSlots: 2,
          env: {
            OMO_PANE_ENV_0: `${SLOT_USER}=${SECRET_USER}`,
            OMO_PANE_ENV_1: `${SLOT_TOKEN}=${SECRET_TOKEN}`,
          },
          correlation: id,
        });
        expect(run.status).toBe(0);
        const trace = readTrace(id);
        expect(trace.at(-1)?.envMechanism).toBe("environment");
        expect(trace.at(-1)?.descriptorFileUsed).toBe(false);
      });

      qa("a value containing '=' survives whole", () => {
        // Given: a password-shaped value holding two '=' characters
        const id = correlationId("literaleq");
        track(tracePath(id));
        const report = reportFor("literaleq");
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, report, "0"]),
          envSlots: 2,
          env: {
            OMO_PANE_ENV_0: `${SLOT_USER}=${SECRET_USER}`,
            OMO_PANE_ENV_1: `${SLOT_TOKEN}=${SECRET_TOKEN}`,
          },
          correlation: id,
        });
        expect(run.status).toBe(0);
        // Then: split on the FIRST '=' only, so the rest of the value is intact
        const observed = readReport(report).env;
        expect(observed[SLOT_USER]).toBe(SECRET_USER);
        expect(observed[SLOT_TOKEN]).toBe(SECRET_TOKEN);
      });

      qa("the trace records slot NAMES and never the values", () => {
        const id = correlationId("traceseal");
        track(tracePath(id));
        const report = reportFor("traceseal");
        runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, report, "0"]),
          envSlots: 2,
          env: {
            OMO_PANE_ENV_0: `${SLOT_USER}=${SECRET_USER}`,
            OMO_PANE_ENV_1: `${SLOT_TOKEN}=${SECRET_TOKEN}`,
          },
          correlation: id,
        });
        const text = readTraceText(id);
        // Then: the names are there, because they are the diagnostic
        expect(text).toContain(SLOT_USER);
        expect(text).toContain(SLOT_TOKEN);
        // Then: the values are not, because the trace outlives the pane
        expect(text).not.toContain(SECRET_USER);
        expect(text).not.toContain(SECRET_TOKEN);
      });

      qa("an incomplete environment falls back to the restricted file, and the file is gone afterwards", () => {
        // Given: slot 1 missing from the environment and a valid fallback file
        const id = correlationId("filemech");
        track(tracePath(id));
        const file = writeFallback(
          id,
          fallbackBody([`${SLOT_USER}=${SECRET_USER}`, `${SLOT_TOKEN}=${SECRET_TOKEN}`]),
        );
        expect(existsSync(file)).toBe(true);
        const report = reportFor("filemech");

        // When: the helper runs
        const run = runHelper(exe, {
          commandJson: JSON.stringify([OBSERVER, report, "0"]),
          envSlots: 2,
          env: { OMO_PANE_ENV_0: `${SLOT_USER}=${SECRET_USER}` },
          correlation: id,
        });
        // Then: it delivered from the file and reported the deletion as verified
        expect(run.status).toBe(0);
        const trace = readTrace(id);
        expect(trace.at(-1)?.envMechanism).toBe("file");
        expect(trace.at(-1)?.descriptorFileUsed).toBe(true);
        expect(trace.at(-1)?.deleteVerified).toBe(true);
        // Then: the credential itself is destroyed on disk, checked not assumed
        expect(existsSync(file)).toBe(false);
        // Then: and both assignments still reached the pane
        const observed = readReport(report).env;
        expect(observed[SLOT_USER]).toBe(SECRET_USER);
        expect(observed[SLOT_TOKEN]).toBe(SECRET_TOKEN);
      });
    });

    // -- argv, cwd, exit propagation -----------------------------------------

    describe("the pane command is execed as a token vector", () => {
      qa("every token arrives, in order, with the requested cwd", () => {
        const id = correlationId("argv");
        track(tracePath(id));
        const report = reportFor("argv");
        const dir = cwdFor("argv");
        const tokens = ["first token", "second", "--flag=value"];
        const run = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(report, 0, tokens)),
          cwd: dir,
          correlation: id,
        });
        expect(run.status).toBe(0);
        const observed = readReport(report);
        // Then: no shell is interposed and nothing is re-split
        expect(observed.args).toEqual([
          report,
          "0",
          ...tokens,
        ]);
        // Then: --cwd was honoured, so the pane started where it was told to
        expect(observed.cwd.toLowerCase()).toBe(dir.toLowerCase());
      });

      qa("the pane command's own exit code is propagated", () => {
        // Given: a pane command that exits 42
        const id = correlationId("exitcode");
        track(tracePath(id));
        const report = reportFor("exitcode");
        const run = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(report, 42)),
          correlation: id,
        });
        // Then: 42, not a helper code and not 0
        expect(run.status).toBe(42);
        expect(readTrace(id).at(-1)?.exitCode).toBe(42);
        expect(readTrace(id).at(-1)?.outcome).toBe("delivered");
      });

      qa("a program that cannot be started exits 127", () => {
        // Given: a program name nothing on this host resolves
        const id = correlationId("spawnfail");
        track(tracePath(id));
        const run = runHelper(exe, {
          commandJson: JSON.stringify(["omo-helper-qa-no-such-program-9f3a21c7"]),
          correlation: id,
        });
        // Then: 127, the shell convention, because the delivery worked and the
        // command is what failed
        expect(run.status).toBe(127);
      });
    });

    // -- measured argv fidelity ----------------------------------------------
    //
    // MEASURED on Windows PowerShell 5.1.26100.9444 and on pwsh 7, driving
    // `& $program @commandArgs` exactly as Invoke-PaneCommand does, with a child
    // that reports the argv the OS handed it.
    //
    // Both interpreters: spaces and shell metacharacters round-trip byte-exactly.
    //
    // Windows PowerShell 5.1 ONLY: an embedded double quote is dropped rather than
    // escaped, and an argument that is entirely empty disappears. pwsh 7 binds
    // both correctly. So the defect is a property of the 5.1 binder, not of the
    // helper's own argument handling, and these assertions state each
    // interpreter's own measurement. They pin the behaviour so a change to the
    // executor is noticed here rather than in a pane.
    //
    // Blast radius, measured against the token vectors src/translate.ts emits:
    // the attach vector (a URL, `--session`, and a `--dir` that routinely contains
    // spaces) round-trips exactly on BOTH interpreters, and a Windows path cannot
    // contain a double quote at all, so attach is not exposed. The placeholder
    // `-Command` token is single-quoted PowerShell, so it is exposed only when a
    // pane DESCRIPTION contains a double quote. The executor is deliberately left
    // as it is: correcting it means replacing the native binder, which changes
    // how every pane is launched and needs its own evidence, not a fix riding
    // along with a QA pass.

    describe("measured native argv fidelity", () => {
      qa("spaces and shell metacharacters round-trip exactly", () => {
        const id = correlationId("fidelity-ok");
        track(tracePath(id));
        const report = reportFor("fidelity-ok");
        const tokens = ["one two", "a&b", "c|d", "e^f", "100%x", "g>h", "i<j", "dir\\"];
        const run = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(report, 0, tokens)),
          correlation: id,
        });
        expect(run.status).toBe(0);
        expect(readReport(report).args.slice(OBSERVER_ARGV_PREFIX)).toEqual(tokens);
      });

      qa("an attach-shaped vector with spaces and non-ASCII round-trips exactly", () => {
        const id = correlationId("fidelity-attach");
        track(tracePath(id));
        const report = reportFor("fidelity-attach");
        const dir = "C:\\Users\\Daniel\\proj\\my project æøå";
        const tokens = ["--dir", dir, "--session", "ses_7f3a"];
        const run = runHelper(exe, {
          commandJson: JSON.stringify(observerCommand(report, 0, tokens)),
          correlation: id,
        });
        expect(run.status).toBe(0);
        expect(readReport(report).args.slice(OBSERVER_ARGV_PREFIX)).toEqual(tokens);
      });

      qa(
        lossyNativeBinding
          ? "an embedded double quote is DROPPED by this native binder"
          : "an embedded double quote is bound exactly by this native binder",
        () => {
          const id = correlationId("fidelity-quote");
          track(tracePath(id));
          const report = reportFor("fidelity-quote");
          const run = runHelper(exe, {
            commandJson: JSON.stringify(observerCommand(report, 0, ['say "hi"'])),
            correlation: id,
          });
          expect(run.status).toBe(0);
          // Then: each interpreter's own measurement. The 5.1 result is the
          // recorded defect, not the wanted behaviour.
          expect(readReport(report).args.slice(OBSERVER_ARGV_PREFIX)).toEqual(
            lossyNativeBinding ? ["say hi"] : ['say "hi"'],
          );
        },
      );

      qa(
        lossyNativeBinding
          ? "an empty token DISAPPEARS under this native binder"
          : "an empty token is bound exactly by this native binder",
        () => {
          const id = correlationId("fidelity-empty");
          track(tracePath(id));
          const report = reportFor("fidelity-empty");
          const run = runHelper(exe, {
            commandJson: JSON.stringify(observerCommand(report, 0, ["first", "", "last"])),
            correlation: id,
          });
          expect(run.status).toBe(0);
          // Then: the child saw two tokens where three were sent
          expect(readReport(report).args.slice(OBSERVER_ARGV_PREFIX)).toEqual(
            lossyNativeBinding ? ["first", "last"] : ["first", "", "last"],
          );
        },
      );
    });

    // -- attach retry cap -----------------------------------------------------

    if (slow) {
      qa("an attach command is retried exactly once, never twice", () => {
        // Given: the one command the retry policy applies to, pointed at a port
        // nothing is listening on. The real `opencode` on this host is the
        // bridge's own opencode.cmd, which prints its error and STILL exits 0, so
        // pointing at it would observe zero retries and look like a pass. A stub
        // that always fails, and counts its own invocations, is what makes the cap
        // observable at all: the count IS the assertion.
        const id = correlationId("retry");
        track(tracePath(id));
        writeFailingOpenCodeStub();

        runHelper(exe, {
          commandJson: JSON.stringify(["opencode", "attach", "http://127.0.0.1:9/", "--session", "qa"]),
          correlation: id,
          env: { PATH: `${STUB_DIR};${process.env["PATH"] ?? ""}` },
        });

        // Then: the helper's own record says the policy applied and fired once
        const trace = readTrace(id);
        expect(trace.at(-1)?.attachRetryApplies).toBe(true);
        expect(trace.at(-1)?.attachRetries).toBe(1);
        // Then: the pane program was launched exactly twice -- the first attempt
        // and the single retry. A cap of two or an unbounded loop would make this
        // three or more, and the helper's field would not catch it.
        expect(stubInvocationCount()).toBe(2);
        // Then: the readiness wait before the first attempt was bounded
        expect(Number(trace.at(-1)?.attachWaitMs)).toBeLessThanOrEqual(5000);
      }, 120_000);
    }
  });
}

// Windows PowerShell 5.1 is the mandatory lane: it is the interpreter the
// translator emits and the one whose binder the measurement above is about.
describeWin("interpreter discovery", () => {
  qa("Windows PowerShell 5.1 is present and is version 5.1", () => {
    const probe = spawnSync(
      POWERSHELL_51,
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major.ToString()"],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe("5");
  });
});

helperSuite({
  label: "Windows PowerShell 5.1",
  exe: POWERSHELL_51,
  slow: true,
  lossyNativeBinding: true,
});

// pwsh 7 is the extra lane. It binds native arguments differently, so this lane
// is evidence that the helper's own logic is binder-independent, not a
// substitute for the 5.1 lane above.
const PWSH = spawnSync("where", ["pwsh"], { encoding: "utf8", windowsHide: true });
const PWSH_PATH = PWSH.status === 0 ? PWSH.stdout.split(/\r?\n/)[0]?.trim() : undefined;
if (ON_WINDOWS && PWSH_PATH) {
  helperSuite({ label: "PowerShell 7", exe: PWSH_PATH, slow: false, lossyNativeBinding: false });
}