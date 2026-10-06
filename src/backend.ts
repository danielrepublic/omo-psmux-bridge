// backend resolver and chain guard.
//
// Where the real psmux lives, and the one thing that must never be true of it.
//
// Two responsibilities, and they are the same responsibility seen from both
// sides:
//
//   1. RESOLVE. Find the installed psmux, by absolute path, in one exact order.
//   2. REFUSE. If the answer is the shim itself, stop with exit 78 rather than
//      exec'ing it. A shim that execs itself does not fail; it recurses until
//      something — a process limit, a stack, a user's patience — kills it, and
//      the symptom is a hang with no output. That is the entire failure mode
//      this module exists to remove, so every guard path here is bounded and
//      cheap: the resolver spawns nothing and writes nothing.
//
// ---------------------------------------------------------------------------
// THE RESOLUTION CONTRACT — this is todo 12's interface
// ---------------------------------------------------------------------------
//
// One ordered chain, first match wins:
//
//   1. `OMO_PSMUX_INSTALL_DIR`, when set to a non-blank value.
//      TEST SEAM ONLY. It exists so the precedence chain and the guard are
//      verifiable without a Windows host; nothing in production sets it, and
//      nothing in this module treats it as more authoritative than the
//      registry — it is simply first, so a test can pin every case below.
//   2. `HKCU\Software\psmux`, value `InstallDir`. The authoritative source:
//      `installer/psmux.nsi:35` is `InstallDirRegKey HKCU "Software\psmux"
//      "InstallDir"`, and CONTRACT.md 11.5 requires resolution by absolute
//      path from exactly this key rather than by name, so that the shim can
//      never shadow the launcher.
//   3. `%LOCALAPPDATA%\psmux`. The installer's default:
//      `installer/psmux.nsi:34` is `InstallDir "$LOCALAPPDATA\psmux"`.
//
// There is NO fourth source. In particular there is no home directory, no
// `C:\Users\<someone>`, no `%USERPROFILE%`, no current-working-directory guess
// and no bare-name PATH search as a last resort: a shim that guesses is a shim
// that can guess itself. Every failure below reports what it looked for and
// stops, which is what makes the failure legible instead of mysterious.
//
// Inside the chosen directory, exactly two candidate names are considered, in
// this order: `psmux.exe` then `tmux.exe`. `psmux.exe` is first because the
// shim itself is built as `tmux.exe` (todo 12), so a collision with `tmux.exe`
// is the EXPECTED accident — a user who drops the shim straight into the
// install directory must still get a working backend, which is exactly what
// trying `psmux.exe` first guarantees. `tmux.exe` is the fallback for a
// directory that holds only the alias. Both binaries emit the same two-line
// `-V` at 3.3.8, so the order costs nothing when both are present.
//
// ---------------------------------------------------------------------------
// THE CHAIN GUARD, AND WHY IT IS CORRECT FOR BARE-NAME INVOCATION
// ---------------------------------------------------------------------------
//
// Two OmO call sites bypass any resolver and spawn the literal string `tmux`
// (index.js:9072 `findCommandPath("tmux")`, and the pane-command construction
// paths), so the shim is routinely entered by BARE NAME rather than by absolute
// path. That does not weaken the guard: the operating system resolves the bare
// name to a full path before argv[0] exists, so `process.execPath` is an
// absolute path to the running image either way. "Bare name" and "absolute
// path" are indistinguishable from inside the process, and the guard needs no
// special case for either. What does need care is SPELLING: the same file can
// arrive as `C:\Users\x\AppData\Local\psmux\tmux.exe`,
// `c:/users/x/appdata/local/PSMUX/tmux.exe` or
// `C:\Users\x\AppData\Local\psmux\bin\..\tmux.exe`. Windows filesystems are
// case-insensitive, so identity is decided on a normalised, case-folded form
// AND, when both paths exist on this host, on the real filesystem identity of
// the two files. String equality alone would miss the second and third
// spellings; the real filesystem catches a symlink or junction that points the
// install directory back at the bridge directory.
//
// The rule is "skip the shim, keep looking", not "give up at the first self
// match": a candidate that IS the shim is never executed, but resolution
// continues to the next candidate, and exit 78 is returned only when there is
// nothing left to run. That distinction matters in the one realistic bad
// install — somebody dropped the shim into the psmux directory next to an
// intact `psmux.exe` — where refusing outright would break a setup that has a
// perfectly good backend sitting right there. When every candidate is the shim,
// the result is a refusal with a loud message, never a fallback and never a
// spawn.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT DONE HERE
// ---------------------------------------------------------------------------
//
// `bridge.json` is NOT read. It exists in the installed tree and historically
// named the backend, but the registry is now authoritative (CONTRACT.md 11.5),
// and a JSON file in a directory the shim itself may have written is one more
// way for the shim to end up pointing at itself.
//
// No trace, no correlation id, no logging. `OMO_PSMUX_BRIDGE_TRACE` is todo 12's
// and must never become a correctness dependency: this module is required to
// behave identically whether or not anybody is watching.
//
// argv translation is NOT here. `src/translate.ts` takes a `Classified` and this
// module's resolved path and produces the argv; this module never inspects,
// rewrites or reorders an argument, it only decides WHICH PROGRAM receives them.
//
// One failure code is invented, and only one: exit 78 for the guard, which the
// plan fixes. Everything else that goes wrong is `INSTALL_FAILURE_EXIT_CODE`,
// 69 — `EX_UNAVAILABLE` in `sysexits.h`, next to 78's `EX_CONFIG`. The guard is
// a configuration error (the shim's own configuration points it at itself);
// everything else is an unavailable service. The distinction is worth keeping
// because 78 is the one code an operator or a harness can key on.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { win32 as win32Path } from "node:path";

// ---------------------------------------------------------------------------
// The contract, as data
// ---------------------------------------------------------------------------

export const RESOLUTION_CONTRACT = {
  /** Test-only override, first in the chain. See the header. */
  installDirEnv: "OMO_PSMUX_INSTALL_DIR",

  /** `installer/psmux.nsi:35`. */
  registryKeyPath: "HKCU\\Software\\psmux",
  registryValueName: "InstallDir",

  /** `installer/psmux.nsi:34`: `InstallDir "$LOCALAPPDATA\psmux"`. */
  localAppDataEnv: "LOCALAPPDATA",
  defaultInstallDirLeaf: "psmux",

  /** Candidate binary names inside the install directory, in preference order. */
  backendCandidateNames: ["psmux.exe", "tmux.exe"],

  /** The plan's fixed code for "the backend resolved to me". */
  chainGuardExitCode: 78,

  /** `EX_UNAVAILABLE`, for every other resolution failure. */
  installFailureExitCode: 69,
} as const;

/** Candidate binary names, re-exported at the top level for callers. */
export const BACKEND_CANDIDATE_NAMES = RESOLUTION_CONTRACT.backendCandidateNames;

/** The exit code the chain guard must return. Re-exported for the same reason. */
export const CHAIN_GUARD_EXIT_CODE = RESOLUTION_CONTRACT.chainGuardExitCode;

/** Exit code for every resolution failure that is not the chain guard. */
export const INSTALL_FAILURE_EXIT_CODE = RESOLUTION_CONTRACT.installFailureExitCode;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Which of the three sources produced the install directory. */
export type InstallDirSource = "env" | "registry" | "local-app-data";

/** What the filesystem says about a candidate path. */
export type PathKind = "file" | "directory" | "absent";

/** The backend was found and is not the shim. The only executable outcome. */
export interface ResolvedBackend {
  readonly kind: "resolved";
  /** Absolute, normalised, no trailing separator. */
  readonly installDir: string;
  readonly source: InstallDirSource;
  /** Absolute path to exec. Never equals the running image — that is the guard. */
  readonly backendPath: string;
  /** Which candidate name matched. */
  readonly backendName: string;
}

/** The backend resolved, but every candidate was the shim. Exec is refused. */
export interface ChainGuardResolution {
  readonly kind: "chain-guard";
  readonly installDir: string;
  readonly source: InstallDirSource;
  /** The candidate that is the shim. */
  readonly backendPath: string;
  readonly backendName: string;
  /** Every candidate in the directory that is the shim. */
  readonly selfCandidates: readonly string[];
  /** The running image, normalised. */
  readonly shimPath: string;
  /** Why the match happened: `"path"`, `"realpath"`, or both. For diagnostics. */
  readonly matchedBy: readonly ("path" | "realpath")[];
  readonly message: string;
  readonly exitCode: typeof RESOLUTION_CONTRACT.chainGuardExitCode;
}

/** No source named a directory at all: env blank, registry absent, no %LOCALAPPDATA%. */
export interface InstallDirUnresolved {
  readonly kind: "install-dir-unresolved";
  /** The three things that were consulted, in order, so the message is actionable. */
  readonly consulted: readonly InstallDirSource[];
  readonly message: string;
  readonly exitCode: number;
}

/** A directory was named but holds no usable backend, or does not exist. */
export interface BackendMissing {
  readonly kind: "backend-missing";
  readonly installDir: string;
  readonly source: InstallDirSource;
  /** What the directory actually holds, per `probePath`. */
  readonly installDirKind: PathKind;
  /** The candidate names that were tried, in order. */
  readonly lookedFor: readonly string[];
  readonly message: string;
  readonly exitCode: number;
}

export type Resolution =
  | ResolvedBackend
  | ChainGuardResolution
  | InstallDirUnresolved
  | BackendMissing;

/** The one accessor todo 12 needs: a resolution turned into a process exit code. */
export function exitCodeFor(resolution: Resolution): number {
  return resolution.kind === "resolved" ? 0 : resolution.exitCode;
}

/** A single operator-facing line for a resolution. Trace- and log-safe: it names
 *  paths and codes only, never arguments and never environment values. */
export function describeResolution(resolution: Resolution): string {
  return resolution.kind === "resolved"
    ? `backend ${resolution.backendPath} (${resolution.source})`
    : resolution.message;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Reads one environment variable. `undefined` for absent or blank. */
export type ReadEnv = (name: string) => string | undefined;

/** Reads `HKCU\Software\psmux:InstallDir`. `undefined` for absent or blank. */
export type ReadRegistryInstallDir = () => string | undefined;

/** Reads `%LOCALAPPDATA%`. `undefined` for absent or blank. */
export type ReadLocalAppData = () => string | undefined;

/** What the filesystem says about a path. Injectable so the chain is testable
 *  on a host that does not have psmux installed. */
export type ProbePath = (candidate: string) => PathKind;

/** The running image. `process.execPath` by default, which is absolute whether
 *  the shim was entered by bare name or by full path. */
export type CurrentExecutable = () => string;

/** Two paths, one file? Injectable so Windows identity is testable on Linux. */
export type SameFile = (left: string, right: string) => boolean;

/** Every seam is optional; each has a production default. */
export interface ResolveOptions {
  readonly readEnv?: ReadEnv;
  readonly readRegistryInstallDir?: ReadRegistryInstallDir;
  readonly readLocalAppData?: ReadLocalAppData;
  readonly probePath?: ProbePath;
  readonly currentExecutable?: CurrentExecutable;
  readonly sameFile?: SameFile;
  /** Further paths that must be treated as the shim. Optional; the caller has
   *  none today, and the seam exists so a future caller does not have to reach
   *  into this module's internals to add one. */
  readonly extraShimPaths?: readonly string[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the backend to exec.
 *
 * Total: never throws, whatever the environment holds. An unusable environment
 * produces a `Resolution` that says what was looked for, because an exception
 * here would surface as a stack trace in a pane and explain nothing.
 */
export function resolveBackend(options: ResolveOptions = {}): Resolution {
  const readEnv = options.readEnv ?? defaultReadEnv;
  const probePath = options.probePath ?? defaultProbePath;
  const sameFile = options.sameFile ?? defaultSameFile;
  const currentExecutable = options.currentExecutable ?? (() => process.execPath);

  const shimPaths = [currentExecutable(), ...(options.extraShimPaths ?? [])];

  const installDir = pickInstallDir({
    env: firstNonBlank(readEnv(RESOLUTION_CONTRACT.installDirEnv)),
    registry: firstNonBlank((options.readRegistryInstallDir ?? readRegistryInstallDirViaReg)()),
    localAppData: firstNonBlank((options.readLocalAppData ?? readLocalAppDataFromEnv)(readEnv)),
  });

  if (installDir === undefined) {
    return {
      kind: "install-dir-unresolved",
      consulted: ["env", "registry", "local-app-data"],
      message:
        `omo-psmux-bridge: cannot locate the psmux installation. ` +
        `${RESOLUTION_CONTRACT.installDirEnv} is not set, ` +
        `${RESOLUTION_CONTRACT.registryKeyPath}\\${RESOLUTION_CONTRACT.registryValueName} is absent, ` +
        `and %${RESOLUTION_CONTRACT.localAppDataEnv}% is not set. ` +
        `Reinstall psmux, or set ${RESOLUTION_CONTRACT.installDirEnv} to the directory ` +
        `holding ${BACKEND_CANDIDATE_NAMES.join(" or ")}.`,
      exitCode: INSTALL_FAILURE_EXIT_CODE,
    };
  }

  const { dir, source } = installDir;
  const installDirKind = probePath(dir);

  // The name travels with its path: an index into a FILTERED candidate list
  // mislabels the backend whenever only the second candidate is present.
  const candidates = BACKEND_CANDIDATE_NAMES.map((name) => ({
    name,
    path: joinWindows(dir, name),
  }));
  const present = candidates.filter((candidate) => probePath(candidate.path) === "file");
  const safe = present.filter((candidate) => !isShim(candidate.path, shimPaths, sameFile));
  const selfPaths = present.filter((candidate) => isShim(candidate.path, shimPaths, sameFile)).map((c) => c.path);

  const chosen = safe[0];
  if (chosen !== undefined) {
    return {
      kind: "resolved",
      installDir: dir,
      source,
      backendPath: chosen.path,
      backendName: chosen.name,
    };
  }

  if (selfPaths.length > 0) {
    return chainGuard(dir, source, selfPaths, candidates.map((c) => c.path), shimPaths, sameFile);
  }

  return {
    kind: "backend-missing",
    installDir: dir,
    source,
    installDirKind,
    lookedFor: BACKEND_CANDIDATE_NAMES,
    message:
      installDirKind === "directory"
        ? `omo-psmux-bridge: ${dir} (from ${source}) contains neither ` +
          `${BACKEND_CANDIDATE_NAMES.join(" nor ")}. ` +
          `That directory is not a psmux installation.`
        : `omo-psmux-bridge: ${dir} (from ${source}) is not a directory. ` +
          `The psmux installation is missing.`,
    exitCode: INSTALL_FAILURE_EXIT_CODE,
  };
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

interface PickedInstallDir {
  readonly dir: string;
  readonly source: InstallDirSource;
}

/** First non-blank wins, in the order the contract fixes. */
function pickInstallDir(input: {
  readonly env: string | undefined;
  readonly registry: string | undefined;
  readonly localAppData: string | undefined;
}): PickedInstallDir | undefined {
  if (input.env !== undefined) return { dir: normalizeWindowsPath(input.env), source: "env" };
  if (input.registry !== undefined) return { dir: normalizeWindowsPath(input.registry), source: "registry" };
  if (input.localAppData !== undefined) {
    return {
      dir: joinWindows(normalizeWindowsPath(input.localAppData), RESOLUTION_CONTRACT.defaultInstallDirLeaf),
      source: "local-app-data",
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The chain guard
// ---------------------------------------------------------------------------

function isShim(candidate: string, shimPaths: readonly string[], sameFile: SameFile): boolean {
  return shimPaths.some((shim) => sameFile(candidate, shim));
}

function chainGuard(
  dir: string,
  source: InstallDirSource,
  selfCandidates: readonly string[],
  allCandidates: readonly string[],
  shimPaths: readonly string[],
  sameFile: SameFile,
): ChainGuardResolution {
  const primary = selfCandidates[0] ?? allCandidates[0] ?? dir;
  const shimPath = normalizeWindowsPath(shimPaths[0] ?? primary);
  const primaryName = BACKEND_CANDIDATE_NAMES[allCandidates.indexOf(primary)] ?? primary;
  const matchedBy = matchEvidence(primary, shimPath, sameFile);

  return {
    kind: "chain-guard",
    installDir: dir,
    source,
    backendPath: primary,
    backendName: primaryName,
    selfCandidates,
    shimPath,
    matchedBy,
    message:
      `omo-psmux-bridge: refusing to exec myself — the resolved backend ` +
      `${primary} IS this executable (${shimPath}, matched by ${matchedBy.join(" and ")}). ` +
      `The psmux installation at ${dir} (from ${source}) contains no backend other than the shim. ` +
      `Move the bridge out of the psmux directory, or reinstall psmux, ` +
      `or set ${RESOLUTION_CONTRACT.installDirEnv} to the real installation.`,
    exitCode: CHAIN_GUARD_EXIT_CODE,
  };
}

/** Which comparison(s) fired, so the guard's message can say why. */
function matchEvidence(candidate: string, shim: string, sameFile: SameFile): readonly ("path" | "realpath")[] {
  const evidence: ("path" | "realpath")[] = [];
  if (pathFormsEqual(candidate, shim)) evidence.push("path");
  if (!evidence.includes("path") && sameFile(candidate, shim)) evidence.push("realpath");
  return evidence.length > 0 ? evidence : ["path"];
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/** A Windows-flavoured path: a drive letter, a UNC prefix, or any backslash. */
function looksLikeWindows(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\") || candidate.includes("\\");
}

/**
 * Normalise a path for comparison and for display: collapse separators, resolve
 * `.` and `..` textually, drop a trailing separator, drop a trailing `.`.
 *
 * Windows-flavoured paths are folded to lower case by `pathFormsEqual` rather
 * than here, so that a normalised value stays readable in a message. POSIX paths
 * keep their case, because a POSIX filesystem does not.
 */
export function normalizeWindowsPath(candidate: string): string {
  if (candidate.length === 0) return candidate;
  const windows = looksLikeWindows(candidate);
  // Backslashes become slashes first so that ONE normalizer handles both
  // flavours; `win32Path.posix` also keeps a `\\?\` or `\\server\` prefix intact.
  let normalized = win32Path.posix.normalize(windows ? candidate.replaceAll("\\", "/") : candidate);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized.length > 1 && normalized.endsWith("/.")) normalized = normalized.slice(0, -2);
  return windows ? normalized.replaceAll("/", "\\") : normalized;
}

/**
 * Join a normalised directory with a leaf name, in the directory's own flavour.
 *
 * Deliberately NOT interchangeable with the same-named function in
 * src/descriptor.ts, which is Windows-only and always uses a backslash. Merging
 * them breaks `test/descriptor.test.ts`'s `startsWith(PROFILE_DIR + "\\")`.
 */
function joinWindows(dir: string, leaf: string): string {
  if (looksLikeWindows(dir)) return `${dir.replace(/[\\/]+$/, "")}\\${leaf}`;
  return `${dir.replace(/\/+$/, "")}/${leaf}`;
}

/** Case-folded equality of two normalised paths. */
function pathFormsEqual(left: string, right: string): boolean {
  const a = normalizeWindowsPath(left);
  const b = normalizeWindowsPath(right);
  return looksLikeWindows(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Do two paths name the same file?
 *
 * Normalised, case-folded string equality first, because that is cheap and
 * correct for the overwhelming majority of cases. Then, only if both paths
 * exist, the real filesystem identity — which is what catches a symlink or a
 * Windows junction pointing the install directory back at the bridge directory,
 * where the strings differ and the files do not.
 */
export function sameFile(left: string, right: string): boolean {
  return defaultSameFile(left, right);
}

function defaultSameFile(left: string, right: string): boolean {
  if (pathFormsEqual(left, right)) return true;
  const a = realIdentity(left);
  const b = realIdentity(right);
  return a !== undefined && a === b;
}

/** The canonical path of an existing file, or `undefined`. */
function realIdentity(candidate: string): string | undefined {
  try {
    if (!existsSync(candidate)) return undefined;
    return realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function firstNonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Production defaults for the seams
// ---------------------------------------------------------------------------

function defaultReadEnv(name: string): string | undefined {
  return firstNonBlank(process.env[name]);
}

function readLocalAppDataFromEnv(readEnv: ReadEnv): string | undefined {
  return readEnv(RESOLUTION_CONTRACT.localAppDataEnv);
}

function defaultProbePath(candidate: string): PathKind {
  try {
    const stats = statSync(candidate);
    return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "absent";
  } catch {
    return "absent";
  }
}

// ---------------------------------------------------------------------------
// The registry seam
// ---------------------------------------------------------------------------

/**
 * Read `HKCU\Software\psmux:InstallDir` by running `reg.exe` directly.
 *
 * `reg.exe` is a real executable, so this is `spawn(exe, argv)` with no shell
 * anywhere: no `cmd /c`, no PowerShell wrapper, nothing that could re-interpret
 * the value. It is the only way to read a user-scope registry value from a
 * compiled binary with no runtime dependency, and `reg query /v` is the
 * documented interface for it.
 *
 * Cannot be exercised on a non-Windows host, which is why the OUTPUT PARSER
 * below is a separate exported pure function with its own tests: that is the
 * half of this seam with any logic in it.
 */
function readRegistryInstallDirViaReg(): string | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: [
        "reg",
        "query",
        RESOLUTION_CONTRACT.registryKeyPath,
        "/v",
        RESOLUTION_CONTRACT.registryValueName,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return undefined;
    return parseRegQueryInstallDir(result.stdout.toString());
  } catch {
    return undefined;
  }
}

/**
 * Pull `InstallDir` out of `reg query` output.
 *
 * `reg query /v` prints one indented line per value, four space-separated
 * columns: name, type, then the data. Only a row whose value name is EXACTLY
 * `InstallDir` counts — `InstallDirX` is a different value and must not be
 * mistaken for it — and `REG_SZ`/`REG_EXPAND_SZ` are the only types a directory
 * can arrive as. An error message from `reg` has no value row and yields
 * `undefined`, never an empty string, because an empty string is not a
 * directory and pretending otherwise would send the caller looking in `C:\`.
 */
export function parseRegQueryInstallDir(stdout: string, readEnv: ReadEnv = defaultReadEnv): string | undefined {
  const name = RESOLUTION_CONTRACT.registryValueName;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/);
    if (columns.length < 3) continue;
    const [valueName, valueType, ...rest] = columns;
    if (valueName !== name) continue;
    if (valueType !== "REG_SZ" && valueType !== "REG_EXPAND_SZ") continue;
    const data = rest.join(" ").trim();
    if (data.length === 0) continue;
    return normalizeWindowsPath(expandWindowsEnvironmentReferences(data, readEnv));
  }
  return undefined;
}

/**
 * Expand `%NAME%` references in a registry value.
 *
 * `reg query` does not expand `REG_EXPAND_SZ` data, and psmux's installer writes
 * a literal path, so this is normally a no-op. It exists because an unexpanded
 * `%LOCALAPPDATA%\psmux` would otherwise be treated as a relative directory
 * name and fail with a confusing message. A reference that cannot be expanded
 * is LEFT ALONE: an unresolvable variable is information, and blanking it would
 * turn a legible registry value into a silently wrong path.
 */
export function expandWindowsEnvironmentReferences(value: string, readEnv: ReadEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\([A-Za-z_][A-Za-z0-9_]*\))?$/.test(name)) return match;
    const expanded = readEnv(name);
    return expanded === undefined ? match : expanded;
  });
}

// ---------------------------------------------------------------------------
// Forwarding to the backend
// ---------------------------------------------------------------------------

/** Exactly the options this module passes to `spawn`. Deliberately narrow: it
 *  carries no field that could introduce a shell. */
export interface BackendSpawnOptions {
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
  /** `"inherit"` for an interactive session, a capture tuple for `-V`. */
  readonly stdio: "inherit" | ["inherit", "pipe", "pipe"];
  /** Always false. There is no code path that sets it true. */
  readonly shell: false;
  /** Always true: a tmux shim must never flash a console window. */
  readonly windowsHide: true;
}

/** The `spawn` seam. Injectable so the no-shell property can be asserted on the
 *  real options object, not merely on the source. */
export type SpawnBackend = (
  executable: string,
  argv: readonly string[],
  options: BackendSpawnOptions,
) => ChildProcess;

export interface RunBackendOptions {
  /** Capture stdout/stderr instead of inheriting them. Defaults to `false`. */
  readonly captureOutput?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: SpawnBackend;
}

export interface BackendOutcome {
  /** The backend's own exit code, or a non-zero code if it could not be run. */
  readonly exitCode: number;
  /** `""` when not capturing. Otherwise the backend's bytes, unmodified. */
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the backend died from a signal rather than exiting. */
  readonly signal: NodeJS.Signals | null;
}

/**
 * Forward argv to the backend and propagate what it did.
 *
 * argv goes to `spawn` as an array, with `shell: false`. There is no `cmd /c`
 * wrapper, no PowerShell wrapper and no quoting layer of this module's own: an
 * argument containing a space, a quote, a `$` or a backslash reaches the backend
 * byte-for-byte, because the only thing that can mangle it is a shell and this
 * module never starts one.
 *
 * Output is returned VERBATIM. `-V` in particular must come back byte-identical,
 * trailing newline included: at 3.3.8 `tmux -V` prints two lines, and trimming or
 * re-wrapping them would be a silent difference from the real backend on a
 * load-bearing probe (CONTRACT.md 4.4 — a non-zero exit here silently disables
 * every tmux feature in OmO).
 *
 * Never throws. An unrunnable backend is a non-zero outcome carrying a message,
 * because the caller needs an exit code either way.
 */
export async function runBackend(
  backend: ResolvedBackend,
  argv: readonly string[],
  options: RunBackendOptions = {},
): Promise<BackendOutcome> {
  const capture = options.captureOutput ?? false;
  const spawnImpl = options.spawn ?? nodeSpawn;

  const spawnOptions: BackendSpawnOptions = {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    shell: false,
    windowsHide: true,
  };

  return new Promise<BackendOutcome>((complete) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (outcome: BackendOutcome): void => {
      if (settled) return;
      settled = true;
      complete(outcome);
    };

    let child: ChildProcess;
    try {
      child = spawnImpl(backend.backendPath, argv, spawnOptions);
    } catch (error) {
      finish({
        exitCode: describeSpawnFailure(error),
        stdout: "",
        stderr: `omo-psmux-bridge: cannot start ${backend.backendPath}: ${errorMessage(error)}\n`,
        signal: null,
      });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (error: Error) => {
      finish({
        exitCode: describeSpawnFailure(error),
        stdout,
        stderr: `${stderr}omo-psmux-bridge: cannot start ${backend.backendPath}: ${errorMessage(error)}\n`,
        signal: null,
      });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      // A signalled child has no exit code of its own. 128 + signum is the
      // shell convention and is the only defensible number to hand back.
      const exitCode = code ?? (signal === null ? 1 : 128 + (signalNumber(signal) ?? 0));
      finish({ exitCode, stdout, stderr, signal });
    });
  });
}

function buildEnv(env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const built: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) built[key] = value;
  }
  return built;
}

/** ENOENT on a backend must not be confused with a backend that exits 127. */
function describeSpawnFailure(error: unknown): number {
  return error instanceof Error && "code" in error && error.code === "ENOENT" ? 127 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return SIGNAL_NUMBERS[signal];
}
