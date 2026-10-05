// backend resolver and chain guard.
//
// Written FIRST, before src/backend.ts has any implementation. The production
// target is Windows-only, so this suite is built to prove the whole ordered
// precedence chain and the whole guard **on Linux**: every environment touch
// point is an injectable seam, and only two seams — the registry read and the
// `reg query` output parser — are untestable by construction, because they name
// a Windows-only facility. Everything else is asserted in-process.
//
// What is being pinned here, in order of importance:
//
//   1. The resolved backend path can NEVER be the shim itself. That is the bug
//      this module exists to prevent; its failure mode is a hang or unbounded
//      recursion, so every guard assertion is also a PROMPTNESS assertion.
//   2. The install directory is resolved in one exact order:
//        OMO_PSMUX_INSTALL_DIR  >  HKCU\Software\psmux:InstallDir  >  %LOCALAPPDATA%\psmux
//      with no hardcoded machine path anywhere as a fallback.
//   3. `-V` propagates the backend's EXACT stdout bytes and EXACT exit code.
//      This is load-bearing, not cosmetic: OmO's `findVerifiedTmuxPath`
//      (index.js:9071-9091) returns null on a non-zero exit and the gate at
//      :8390-8394 then disables every tmux feature with no error at all.
//   4. argv reaches the backend by DIRECT spawn. No `cmd /c`, no `shell: true`,
//      no shell wrapper of any kind.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawn } from "node:child_process";
import {
  BACKEND_CANDIDATE_NAMES,
  CHAIN_GUARD_EXIT_CODE,
  RESOLUTION_CONTRACT,
  describeResolution,
  exitCodeFor,
  expandWindowsEnvironmentReferences,
  normalizeWindowsPath,
  parseRegQueryInstallDir,
  resolveBackend,
  runBackend,
  sameFile,
} from "../src/backend";
import type {
  BackendSpawnOptions,
  ChainGuardResolution,
  InstallDirSource,
  PathKind,
  ResolveOptions,
  Resolution,
} from "../src/backend";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Windows-shaped paths, so the normalisation and case-folding under test is the
// real Windows behaviour and not a POSIX accident of the test host.
const WIN_ENV_DIR = "C:\\Users\\Someone\\AppData\\Local\\psmux";
const WIN_REGISTRY_DIR = "D:\\tools\\psmux-3.3.8";
const WIN_LOCALAPPDATA = "C:\\Users\\Someone\\AppData\\Local";

/** The two-line form psmux 3.3.8 actually prints (learnings T-4 / V-2). A
 *  one-line expectation here would be a FALSE PASS, so it is spelled out in
 *  full, trailing newline included. */
const REAL_VERSION_STDOUT = "tmux 3.3.8\npsmux 3.3.8 (66cf613 2026-08-18)\n";

function fakeFs(overrides: {
  directories?: readonly string[];
  files?: readonly string[];
}): Map<string, PathKind> {
  const entries = new Map<string, PathKind>();
  for (const directory of overrides.directories ?? []) entries.set(directory, "directory");
  for (const file of overrides.files ?? []) entries.set(file, "file");
  return entries;
}

/** Base options for a resolved-on-Windows filesystem that is not this host's. */
function windowsFs(options: {
  directories?: readonly string[];
  files?: readonly string[];
  envInstallDir?: string | undefined;
  registryInstallDir?: string | undefined;
  localAppData?: string | undefined;
  shimPath?: string;
}): ResolveOptions {
  const entries = fakeFs(options);
  return {
    readEnv: (name) =>
      name === RESOLUTION_CONTRACT.installDirEnv ? options.envInstallDir : undefined,
    readRegistryInstallDir: () => options.registryInstallDir,
    readLocalAppData: () => options.localAppData,
    probePath: (candidate) => entries.get(normalizeWindowsPath(candidate)) ?? "absent",
    currentExecutable: () => options.shimPath ?? "C:\\bridge\\bin\\tmux.exe",
  };
}

function expectResolved(resolution: Resolution): Extract<Resolution, { kind: "resolved" }> {
  if (resolution.kind !== "resolved") throw new Error(`expected resolved, got ${resolution.kind}`);
  return resolution;
}

function expectChainGuard(resolution: Resolution): ChainGuardResolution {
  if (resolution.kind !== "chain-guard") throw new Error(`expected chain-guard, got ${resolution.kind}`);
  return resolution;
}

// ---------------------------------------------------------------------------
// Temporary backend scripts, for the real-spawn tests
// ---------------------------------------------------------------------------

interface Sandbox {
  readonly dir: string;
  readonly pscript: (body: string) => string;
  readonly cleanup: () => void;
}

/** A scratch directory holding executable stand-ins for `psmux.exe`. Shebang
 *  scripts, not shell one-liners, so nothing under test can smuggle a shell in
 *  through the backend itself. */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "omo-backend-"));
  return {
    dir,
    pscript: (body: string): string => {
      const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.bin`);
      // Absolute `process.execPath`, not `#!/usr/bin/env bun`: these stand-ins are
      // spawned with a replaced environment and so have no PATH, and `/usr/bin/env`
      // then falls back to `/bin:/usr/bin` — which finds a system bun and misses one
      // installed under a user's home. See the same note in test/cli.test.ts.
      writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 1. The ordered precedence chain
// ---------------------------------------------------------------------------

describe("install directory precedence", () => {
  test("case 1 — OMO_PSMUX_INSTALL_DIR wins over a present registry value", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR, WIN_REGISTRY_DIR],
        files: [`${WIN_ENV_DIR}\\psmux.exe`, `${WIN_REGISTRY_DIR}\\psmux.exe`],
        envInstallDir: WIN_ENV_DIR,
        registryInstallDir: WIN_REGISTRY_DIR,
        localAppData: WIN_LOCALAPPDATA,
      }),
    );

    const resolved = expectResolved(resolution);
    expect(resolved.installDir).toBe(WIN_ENV_DIR);
    expect(resolved.source).toBe<InstallDirSource>("env");
    expect(resolved.backendPath).toBe(`${WIN_ENV_DIR}\\psmux.exe`);
    expect(resolved.backendName).toBe("psmux.exe");
    // The registry directory is a decoy: nothing may come from it.
    expect(resolved.backendPath).not.toContain("psmux-3.3.8");
  });

  test("case 2 — the registry value wins when the env override is unset", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_REGISTRY_DIR, `${WIN_LOCALAPPDATA}\\psmux`],
        files: [`${WIN_REGISTRY_DIR}\\psmux.exe`],
        envInstallDir: undefined,
        registryInstallDir: WIN_REGISTRY_DIR,
        localAppData: WIN_LOCALAPPDATA,
      }),
    );

    const resolved = expectResolved(resolution);
    expect(resolved.source).toBe<InstallDirSource>("registry");
    expect(resolved.installDir).toBe(WIN_REGISTRY_DIR);
    expect(resolved.backendPath).toBe(`${WIN_REGISTRY_DIR}\\psmux.exe`);
  });

  test("case 3 — an absent registry value falls through to %LOCALAPPDATA%\\psmux", () => {
    const defaultDir = `${WIN_LOCALAPPDATA}\\psmux`;
    const resolution = resolveBackend(
      windowsFs({
        directories: [defaultDir],
        files: [`${defaultDir}\\psmux.exe`],
        envInstallDir: undefined,
        registryInstallDir: undefined,
        localAppData: WIN_LOCALAPPDATA,
      }),
    );

    const resolved = expectResolved(resolution);
    expect(resolved.source).toBe<InstallDirSource>("local-app-data");
    expect(resolved.installDir).toBe(defaultDir);
    expect(resolved.backendPath).toBe(`${defaultDir}\\psmux.exe`);
  });

  test("case 4 — an install directory with no backend in it is a failure, not a fallback", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_REGISTRY_DIR],
        files: [],
        envInstallDir: undefined,
        registryInstallDir: WIN_REGISTRY_DIR,
        localAppData: WIN_LOCALAPPDATA,
      }),
    );

    expect(resolution.kind).toBe("backend-missing");
    if (resolution.kind !== "backend-missing") return;
    expect(resolution.installDir).toBe(WIN_REGISTRY_DIR);
    expect(resolution.source).toBe<InstallDirSource>("registry");
    expect([...resolution.lookedFor]).toEqual([...BACKEND_CANDIDATE_NAMES]);
    expect(resolution.message).toContain(WIN_REGISTRY_DIR);
    expect(resolution.exitCode).not.toBe(0);
    // There is no fourth source to fall back to, and no home directory either.
    expect(resolution.message).not.toContain("\\Users\\");
  });

  test("no source at all is its own failure mode, and never invents a path", () => {
    const resolution = resolveBackend(
      windowsFs({ envInstallDir: undefined, registryInstallDir: undefined, localAppData: undefined }),
    );

    expect(resolution.kind).toBe("install-dir-unresolved");
    if (resolution.kind !== "install-dir-unresolved") return;
    expect(resolution.message).toContain(RESOLUTION_CONTRACT.installDirEnv);
    expect(resolution.message).toContain(RESOLUTION_CONTRACT.registryKeyPath);
    expect(resolution.message).toContain(RESOLUTION_CONTRACT.localAppDataEnv);
    expect(resolution.exitCode).not.toBe(0);
    expect(exitCodeFor(resolution)).toBe(resolution.exitCode);
  });

  test("every non-resolved kind carries the one exit-code accessor todo 12 will call", () => {
    const cases: readonly Resolution[] = [
      resolveBackend(windowsFs({ envInstallDir: "", registryInstallDir: WIN_REGISTRY_DIR, files: [] })),
      resolveBackend(windowsFs({ envInstallDir: WIN_ENV_DIR, registryInstallDir: WIN_ENV_DIR, files: [WIN_ENV_DIR] })),
      resolveBackend(windowsFs({ envInstallDir: undefined, registryInstallDir: undefined, localAppData: undefined })),
      resolveBackend(windowsFs({ envInstallDir: WIN_ENV_DIR, shimPath: `${WIN_ENV_DIR}\\psmux.exe`, files: [`${WIN_ENV_DIR}\\psmux.exe`] })),
    ];
    expect(cases.map((c) => c.kind)).toEqual([
      "backend-missing",
      "backend-missing",
      "install-dir-unresolved",
      "chain-guard",
    ]);
    for (const resolution of cases) {
      if (resolution.kind === "resolved") throw new Error("fixture resolved unexpectedly");
      expect(typeof resolution.exitCode).toBe("number");
      expect(resolution.exitCode).toBeGreaterThan(0);
      expect(resolution.message.length).toBeGreaterThan(0);
      expect(exitCodeFor(resolution)).toBe(resolution.exitCode);
      expect(describeResolution(resolution)).toBe(resolution.message);
    }
    expect(expectChainGuard(cases[3] as Resolution).exitCode).toBe(CHAIN_GUARD_EXIT_CODE);
  });
});

// ---------------------------------------------------------------------------
// 2. Locating the binary inside the install directory
// ---------------------------------------------------------------------------

describe("locating tmux.exe / psmux.exe", () => {
  test("both candidate names are accepted, in the documented order", () => {
    expect([...BACKEND_CANDIDATE_NAMES]).toEqual(["psmux.exe", "tmux.exe"]);

    const only = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\tmux.exe`],
        envInstallDir: WIN_ENV_DIR,
      }),
    );
    const resolved = expectResolved(only);
    expect(resolved.backendName).toBe("tmux.exe");
    expect(resolved.backendPath).toBe(`${WIN_ENV_DIR}\\tmux.exe`);
  });

  test("a bare `psmux.exe` (no extension) is not accepted — the shim needs a real image", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\psmux`],
        envInstallDir: WIN_ENV_DIR,
      }),
    );
    expect(resolution.kind).toBe("backend-missing");
  });

  test("a directory named like the backend does not count as the backend", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR, `${WIN_ENV_DIR}\\psmux.exe`],
        files: [],
        envInstallDir: WIN_ENV_DIR,
      }),
    );
    expect(resolution.kind).toBe("backend-missing");
  });
});

// ---------------------------------------------------------------------------
// 3. The chain guard — the whole point of the module
// ---------------------------------------------------------------------------

describe("chain guard: the backend is never the shim", () => {
  test("an exact self-match exits 78 with a message naming both paths", () => {
    // The running image IS `<install dir>\psmux.exe`, and the install
    // directory holds nothing else. Every candidate present is the shim.
    const shim = `${WIN_ENV_DIR}\\psmux.exe`;
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [shim],
        envInstallDir: WIN_ENV_DIR,
        shimPath: shim,
      }),
    );

    const guard = expectChainGuard(resolution);
    expect(guard.exitCode).toBe(78);
    expect(guard.backendPath).toBe(shim);
    expect(guard.shimPath).toBe(shim);
    expect([...guard.matchedBy]).toContain("path");
    expect(guard.message).toContain("psmux.exe");
    expect(guard.message).toContain("refusing to exec myself");
    expect(exitCodeFor(guard)).toBe(78);
  });

  test("the guard is case-insensitive and separator-insensitive, as Windows is", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\psmux.exe`],
        envInstallDir: `${WIN_ENV_DIR}\\`,
        shimPath: "c:\\users\\SOMEONE\\appdata\\local\\PSMUX\\psmux.exe",
      }),
    );
    expect(expectChainGuard(resolution).exitCode).toBe(78);
  });

  test("a `..`-bearing spelling of the shim path is still the shim", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\psmux.exe`],
        envInstallDir: WIN_ENV_DIR,
        shimPath: `${WIN_ENV_DIR}\\bin\\..\\psmux.exe`,
      }),
    );
    expect(expectChainGuard(resolution).exitCode).toBe(78);
  });

  test("a second candidate that is the SAME FILE as the shim is also refused", () => {
    // Path identity alone cannot see this: `<dir>\tmux.exe` is a different
    // directory entry. A symlink or Windows junction aliasing the second
    // candidate onto the running image can, and that is what the realpath half
    // of `sameFile` exists for. Modelled through the seam because a junction is
    // not creatable on this host.
    const shim = `${WIN_ENV_DIR}\\psmux.exe`;
    const base = windowsFs({
      directories: [WIN_ENV_DIR],
      files: [shim, `${WIN_ENV_DIR}\\tmux.exe`],
      envInstallDir: WIN_ENV_DIR,
      shimPath: shim,
    });
    const resolution = resolveBackend({
      ...base,
      sameFile: (left, right) =>
        left.toLowerCase() === right.toLowerCase() ||
        (left.toLowerCase() === `${WIN_ENV_DIR}\\tmux.exe`.toLowerCase() &&
          right.toLowerCase() === shim.toLowerCase()),
    });

    const guard = expectChainGuard(resolution);
    expect(guard.exitCode).toBe(78);
    expect([...guard.selfCandidates]).toEqual([shim, `${WIN_ENV_DIR}\\tmux.exe`]);
  });

  test("a self candidate is SKIPPED and resolution continues to a real backend", () => {
    // The shim is `tmux.exe`; an install directory where somebody dropped it
    // next to an intact `psmux.exe` must keep working, not refuse.
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\tmux.exe`, `${WIN_ENV_DIR}\\psmux.exe`],
        envInstallDir: WIN_ENV_DIR,
        shimPath: `${WIN_ENV_DIR}\\tmux.exe`,
      }),
    );
    const resolved = expectResolved(resolution);
    expect(resolved.backendName).toBe("psmux.exe");
    expect(resolved.backendPath).toBe(`${WIN_ENV_DIR}\\psmux.exe`);
  });

  test("the guard is PROMPT — a hang is the bug it prevents", () => {
    const started = Date.now();
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\psmux.exe`],
        envInstallDir: WIN_ENV_DIR,
        shimPath: `${WIN_ENV_DIR}\\psmux.exe`,
      }),
    );
    const elapsed = Date.now() - started;

    expect(expectChainGuard(resolution).exitCode).toBe(78);
    expect(elapsed).toBeLessThan(1000);
  });

  test("the resolver is a bounded synchronous read: no promise, no walk, no exec", () => {
    // The guard's failure mode is unbounded work, so the resolver must be
    // incapable of it: it may look at the directory and at the two candidate
    // names and at nothing else, and it may not return something awaitable.
    let probes = 0;
    const resolution = resolveBackend({
      readEnv: () => WIN_ENV_DIR,
      readRegistryInstallDir: () => WIN_ENV_DIR,
      readLocalAppData: () => WIN_LOCALAPPDATA,
      probePath: (candidate) => {
        probes += 1;
        return normalizeWindowsPath(candidate) === `${WIN_ENV_DIR}\\psmux.exe` ? "file" : "directory";
      },
      currentExecutable: () => `${WIN_ENV_DIR}\\psmux.exe`,
    });

    expect(expectChainGuard(resolution).backendPath).toBe(`${WIN_ENV_DIR}\\psmux.exe`);
    expect(resolution).not.toBeInstanceOf(Promise);
    expect(probes).toBeLessThanOrEqual(3);
  });

  test("an extra shim path supplied by the caller is guarded too", () => {
    const resolution = resolveBackend({
      ...windowsFs({
        directories: [WIN_ENV_DIR],
        files: [`${WIN_ENV_DIR}\\psmux.exe`],
        envInstallDir: WIN_ENV_DIR,
      }),
      extraShimPaths: [`${WIN_ENV_DIR}\\psmux.exe`],
    });
    expect(expectChainGuard(resolution).exitCode).toBe(78);
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed environment
// ---------------------------------------------------------------------------

describe("malformed OMO_PSMUX_INSTALL_DIR", () => {
  test("an empty override is ignored, not obeyed — precedence continues", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_REGISTRY_DIR],
        files: [`${WIN_REGISTRY_DIR}\\psmux.exe`],
        envInstallDir: "",
        registryInstallDir: WIN_REGISTRY_DIR,
      }),
    );
    const resolved = expectResolved(resolution);
    expect(resolved.source).toBe<InstallDirSource>("registry");
    expect(resolved.installDir).toBe(WIN_REGISTRY_DIR);
  });

  test("a whitespace-only override is ignored the same way", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [WIN_REGISTRY_DIR],
        files: [`${WIN_REGISTRY_DIR}\\psmux.exe`],
        envInstallDir: "   \t ",
        registryInstallDir: WIN_REGISTRY_DIR,
      }),
    );
    expect(expectResolved(resolution).source).toBe<InstallDirSource>("registry");
  });

  test("an empty registry value counts as absent", () => {
    const resolution = resolveBackend(
      windowsFs({
        directories: [`${WIN_LOCALAPPDATA}\\psmux`],
        files: [`${WIN_LOCALAPPDATA}\\psmux\\psmux.exe`],
        registryInstallDir: "",
        localAppData: WIN_LOCALAPPDATA,
      }),
    );
    expect(expectResolved(resolution).source).toBe<InstallDirSource>("local-app-data");
  });

  test("an override naming a directory that does not exist fails with its name", () => {
    const ghost = "E:\\nowhere\\psmux";
    const resolution = resolveBackend(
      windowsFs({ directories: [], files: [], envInstallDir: ghost, registryInstallDir: WIN_REGISTRY_DIR }),
    );

    expect(resolution.kind).toBe("backend-missing");
    if (resolution.kind !== "backend-missing") return;
    expect(resolution.message).toContain(ghost);
    expect(resolution.source).toBe<InstallDirSource>("env");
  });

  test("an override with a trailing separator resolves identically", () => {
    const withSlash = resolveBackend(
      windowsFs({ directories: [WIN_ENV_DIR], files: [`${WIN_ENV_DIR}\\psmux.exe`], envInstallDir: `${WIN_ENV_DIR}\\` }),
    );
    const withoutSlash = resolveBackend(
      windowsFs({ directories: [WIN_ENV_DIR], files: [`${WIN_ENV_DIR}\\psmux.exe`], envInstallDir: WIN_ENV_DIR }),
    );
    expect(expectResolved(withSlash).installDir).toBe(WIN_ENV_DIR);
    expect(expectResolved(withSlash).backendPath).toBe(expectResolved(withoutSlash).backendPath);
  });

  test("the resolver is total: it never throws on hostile input", () => {
    const hostile: readonly (string | undefined)[] = [
      undefined,
      "",
      " ",
      "\\",
      "..",
      "\\..\\..",
      "C:",
      "C:\\",
      "\\\\?\\C:\\weird",
      "%LOCALAPPDATA%",
      "Z:\\nul",
      "psmux.exe",
    ];
    for (const value of hostile) {
      for (const registry of [undefined, "", hostile[0]]) {
        expect(() => resolveBackend(windowsFs({ envInstallDir: value, registryInstallDir: registry }))).not.toThrow();
      }
    }
  });

  test("an unresolvable override never falls back to a home directory", () => {
    for (const value of ["", "   ", "E:\\nowhere", "%USERPROFILE%"]) {
      const resolution = resolveBackend(windowsFs({ envInstallDir: value, registryInstallDir: undefined, localAppData: undefined }));
      expect(resolution.kind).not.toBe("resolved");
      if (resolution.kind === "resolved") return;
      expect(resolution.message).not.toMatch(/\/home\/|[A-Za-z]:\\Users\\/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Path identity — the guard's primitive
// ---------------------------------------------------------------------------

describe("path identity", () => {
  test("Windows comparison folds case, separators and `..`", () => {
    expect(sameFile("C:\\a\\b.exe", "c:/A/B.EXE")).toBe(true);
    expect(sameFile("C:\\a\\b.exe", "C:\\a\\.\\b.exe")).toBe(true);
    expect(sameFile("C:\\a\\x\\..\\b.exe", "C:\\a\\b.exe")).toBe(true);
    expect(sameFile("C:\\a\\b.exe", "C:\\a\\c.exe")).toBe(false);
    expect(sameFile("C:\\a\\b.exe", "D:\\a\\b.exe")).toBe(false);
  });

  test("a trailing separator never changes a directory's identity", () => {
    expect(normalizeWindowsPath("C:\\a\\psmux\\")).toBe("C:\\a\\psmux");
    expect(normalizeWindowsPath("C:/a/psmux/")).toBe("C:\\a\\psmux");
    expect(normalizeWindowsPath("C:\\a\\\\psmux")).toBe("C:\\a\\psmux");
  });

  test("a POSIX path is compared POSIX-style, so this suite can run on Linux", () => {
    expect(sameFile("/opt/psmux/tmux.exe", "/opt/./psmux/tmux.exe")).toBe(true);
    expect(sameFile("/opt/psmux/tmux.exe", "/opt/psmux/psmux.exe")).toBe(false);
  });

  test("the real filesystem is consulted when both paths exist", () => {
    const box = sandbox();
    try {
      const other = join(box.dir, "other.exe");
      writeFileSync(other, `#!${process.execPath}\n`, { mode: 0o755 });
      // Two different spellings of ONE file on this host must compare equal
      // through the realpath seam rather than by string shape alone.
      expect(sameFile(other, join(box.dir, ".", "other.exe"))).toBe(true);
      expect(sameFile(other, join(box.dir, "nope.exe"))).toBe(false);
    } finally {
      box.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. `reg query` output — the one seam that is Windows-only by construction
// ---------------------------------------------------------------------------

describe("reg query output parsing", () => {
  test("a REG_SZ value is extracted verbatim", () => {
    const stdout = [
      "",
      "HKEY_CURRENT_USER\\Software\\psmux",
      "    InstallDir    REG_SZ    C:\\Users\\Someone\\AppData\\Local\\psmux",
      "",
    ].join("\r\n");
    expect(parseRegQueryInstallDir(stdout)).toBe("C:\\Users\\Someone\\AppData\\Local\\psmux");
  });

  test("a REG_EXPAND_SZ value has its %VAR% references expanded", () => {
    const stdout = [
      "HKEY_CURRENT_USER\\Software\\psmux",
      "    InstallDir    REG_EXPAND_SZ    %LOCALAPPDATA%\\psmux",
      "",
    ].join("\n");
    expect(parseRegQueryInstallDir(stdout, (name) => (name === "LOCALAPPDATA" ? WIN_LOCALAPPDATA : undefined))).toBe(
      `${WIN_LOCALAPPDATA}\\psmux`,
    );
  });

  test("an unexpandable reference is left alone rather than blanked", () => {
    const stdout = "HKEY_CURRENT_USER\\Software\\psmux\n    InstallDir    REG_SZ    %NOPE%\\psmux\n";
    expect(parseRegQueryInstallDir(stdout, () => undefined)).toBe("%NOPE%\\psmux");
  });

  test("a missing value yields undefined, not an empty string", () => {
    expect(parseRegQueryInstallDir("HKEY_CURRENT_USER\\Software\\psmux\n")).toBeUndefined();
    expect(parseRegQueryInstallDir("")).toBeUndefined();
    expect(parseRegQueryInstallDir("ERROR: The system was unable to find the specified registry key or value.\r\n")).toBeUndefined();
  });

  test("only the InstallDir value is read, never a neighbouring one", () => {
    const stdout = [
      "HKEY_CURRENT_USER\\Software\\psmux",
      "    (Default)    REG_SZ    psmux",
      "    InstallDirX    REG_SZ    C:\\wrong",
      "    InstallDir    REG_SZ    C:\\right",
      "",
    ].join("\r\n");
    expect(parseRegQueryInstallDir(stdout)).toBe("C:\\right");
  });

  test("the expander only touches whole-name references", () => {
    const lookup = (name: string): string | undefined => (name === "LOCALAPPDATA" ? "C:\\L" : undefined);
    expect(expandWindowsEnvironmentReferences("%LOCALAPPDATA%\\p", lookup)).toBe("C:\\L\\p");
    expect(expandWindowsEnvironmentReferences("%LOCALAPPDATA", lookup)).toBe("%LOCALAPPDATA");
    expect(expandWindowsEnvironmentReferences("%LOCALAPPDATA%", lookup)).toBe("C:\\L");
    expect(expandWindowsEnvironmentReferences("%LOCAL APPDATA%\\p", lookup)).toBe("%LOCAL APPDATA%\\p");
    expect(expandWindowsEnvironmentReferences("%1BAD%", lookup)).toBe("%1BAD%");
    expect(expandWindowsEnvironmentReferences("100%done", lookup)).toBe("100%done");
    expect(expandWindowsEnvironmentReferences("%NOPE%", lookup)).toBe("%NOPE%");
  });
});

// ---------------------------------------------------------------------------
// 7. `-V` propagation — exact bytes, exact exit code, direct argv
// ---------------------------------------------------------------------------

describe("forwarding to the backend", () => {
  test("`-V` propagates the backend's EXACT two-line stdout and exit code 0", async () => {
    const box = sandbox();
    try {
      const backend = box.pscript(
        `process.stdout.write(${JSON.stringify(REAL_VERSION_STDOUT)}); process.exit(0);`,
      );
      const resolution = {
        kind: "resolved",
        installDir: box.dir,
        source: "env",
        backendPath: backend,
        backendName: "psmux.exe",
      } as const satisfies Resolution;

      const outcome = await runBackend(resolution, ["-V"], { captureOutput: true });
      expect(outcome.exitCode).toBe(0);
      // Byte identity, trailing newline included. Not `.trim()`, not line one.
      expect(outcome.stdout).toBe(REAL_VERSION_STDOUT);
      expect(outcome.stdout.split("\n")).toHaveLength(3);
      expect(outcome.stderr).toBe("");
    } finally {
      box.cleanup();
    }
  });

  test("a non-zero backend exit code is propagated unchanged, with both streams", async () => {
    const box = sandbox();
    try {
      const backend = box.pscript(
        `process.stdout.write("out"); process.stderr.write("err"); process.exit(3);`,
      );
      const resolution = {
        kind: "resolved",
        installDir: box.dir,
        source: "env",
        backendPath: backend,
        backendName: "psmux.exe",
      } as const satisfies Resolution;

      const outcome = await runBackend(resolution, ["list-sessions"], { captureOutput: true });
      expect(outcome.exitCode).toBe(3);
      expect(outcome.stdout).toBe("out");
      expect(outcome.stderr).toBe("err");
    } finally {
      box.cleanup();
    }
  });

  test("argv reaches the backend directly: no shell, no `cmd`, no `/c`", async () => {
    const box = sandbox();
    try {
      const backend = box.pscript("process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const resolution = {
        kind: "resolved",
        installDir: box.dir,
        source: "env",
        backendPath: backend,
        backendName: "psmux.exe",
      } as const satisfies Resolution;

      const seen: { executable: string; argv: readonly string[]; options: BackendSpawnOptions }[] = [];
      const argv = ["new-session", "-d", "s", "a b", 'q"uote', "$HOME", "back\\slash"];
      const outcome = await runBackend(resolution, argv, {
        captureOutput: true,
        spawn: (executable, args, options) => {
          seen.push({ executable, argv: args, options });
          return spawn(executable, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
        },
      });

      expect(outcome.exitCode).toBe(0);
      expect(JSON.parse(outcome.stdout) as unknown).toEqual(argv);
      expect(seen).toHaveLength(1);
      const call = seen[0];
      if (call === undefined) return;
      expect(call.executable).toBe(backend);
      expect([...call.argv]).toEqual(argv);
      expect(call.options.shell).toBe(false);
      expect(call.options.windowsHide).toBe(true);
      expect(JSON.stringify(call.options)).not.toContain("/c");
      expect(JSON.stringify(call.options)).not.toContain("cmd");
    } finally {
      box.cleanup();
    }
  });

  test("an empty argv is forwarded as an empty argv, not as a shell string", async () => {
    const box = sandbox();
    try {
      const backend = box.pscript("process.stdout.write(String(process.argv.length - 2));");
      const resolution = {
        kind: "resolved",
        installDir: box.dir,
        source: "env",
        backendPath: backend,
        backendName: "psmux.exe",
      } as const satisfies Resolution;

      const outcome = await runBackend(resolution, [], { captureOutput: true });
      expect(outcome.stdout).toBe("0");
    } finally {
      box.cleanup();
    }
  });

  test("an unrunnable backend is a non-zero outcome with a message, never a throw", async () => {
    const resolution = {
      kind: "resolved",
      installDir: "/nowhere",
      source: "env",
      backendPath: "/nowhere/does-not-exist",
      backendName: "psmux.exe",
    } as const satisfies Resolution;

    const outcome = await runBackend(resolution, ["-V"], { captureOutput: true });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr.length).toBeGreaterThan(0);
    expect(outcome.stdout).toBe("");
  });

  test("forwarding is prompt: a `-V` round trip does not hang", async () => {
    const box = sandbox();
    try {
      const backend = box.pscript(`process.stdout.write(${JSON.stringify(REAL_VERSION_STDOUT)});`);
      const resolution = {
        kind: "resolved",
        installDir: box.dir,
        source: "env",
        backendPath: backend,
        backendName: "psmux.exe",
      } as const satisfies Resolution;

      const started = Date.now();
      const outcome = await runBackend(resolution, ["-V"], { captureOutput: true });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(outcome.exitCode).toBe(0);
    } finally {
      box.cleanup();
    }
  }, 20_000);

  test("a real chain attempt through a compiled binary exits 78 and terminates", async () => {
    // The genuine article: `process.execPath` is the shim, the install dir
    // holds nothing but a copy of that shim, and the chain guard has to break
    // the recursion on its own. Bounded by the test timeout on purpose.
    const box = sandbox();
    const entry = join(box.dir, "chain-entry.ts");
    const shim = join(box.dir, "install", "psmux.exe");
    mkdirSync(join(box.dir, "install"), { recursive: true });
    writeFileSync(
      entry,
      [
        'import { resolveBackend, exitCodeFor, describeResolution } from "' +
        join(import.meta.dir, "..", "src", "backend.ts") +
        '";',
        "const resolution = resolveBackend();",
        "if (resolution.kind !== 'resolved') process.stderr.write(describeResolution(resolution) + '\\n');",
        'process.stderr.write(JSON.stringify({ kind: resolution.kind, exitCode: exitCodeFor(resolution) }) + "\\n");',
        "process.exit(exitCodeFor(resolution));",
      ].join("\n"),
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bun",
          ["build", "--compile", entry, "--outfile", shim],
          { cwd: import.meta.dir, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`compile failed: ${stderr}`))));
      });

      const outcome = await runBackend(
        {
          kind: "resolved",
          installDir: join(box.dir, "install"),
          source: "env",
          backendPath: shim,
          backendName: "psmux.exe",
        } as const satisfies Resolution,
        ["-V"],
        { captureOutput: true, env: { ...process.env, OMO_PSMUX_INSTALL_DIR: join(box.dir, "install") } },
      );

      expect(outcome.exitCode).toBe(78);
      const lines = outcome.stderr.trim().split("\n");
      const report = JSON.parse(lines[lines.length - 1] ?? "") as { kind: string; exitCode: number };
      expect(report.kind).toBe("chain-guard");
      expect(report.exitCode).toBe(78);
      // The guard message reaches the operator, not just the exit code.
      expect(outcome.stderr.toLowerCase()).toContain("psmux.exe");
      expect(outcome.stderr).toContain("refusing to exec myself");
    } finally {
      box.cleanup();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 8. The module never hardcodes a machine
// ---------------------------------------------------------------------------

describe("no hardcoded machine path", () => {
  test("src/backend.ts contains no home directory and no drive-letter literal", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "backend.ts"), "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(withoutComments).not.toMatch(/\/home\/[a-z]/i);
    expect(withoutComments).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(withoutComments).not.toMatch(/\\\\Users\\\\/);
  });

  test("the default install directory is derived from %LOCALAPPDATA%, never assumed", () => {
    expect(RESOLUTION_CONTRACT.defaultInstallDirLeaf).toBe("psmux");
    expect(RESOLUTION_CONTRACT.localAppDataEnv).toBe("LOCALAPPDATA");
    expect(RESOLUTION_CONTRACT.registryKeyPath).toBe("HKCU\\Software\\psmux");
    expect(RESOLUTION_CONTRACT.registryValueName).toBe("InstallDir");
    expect(RESOLUTION_CONTRACT.installDirEnv).toBe("OMO_PSMUX_INSTALL_DIR");
  });

  test("resolution with no options reads the real environment and finds nothing on Linux", () => {
    // Not a Windows assertion: the point is that the defaults are safe to call
    // on any host and cannot invent a path out of thin air.
    const previous = process.env["OMO_PSMUX_INSTALL_DIR"];
    delete process.env["OMO_PSMUX_INSTALL_DIR"];
    try {
      const resolution = resolveBackend();
      expect(resolution.kind).not.toBe("resolved");
      if (resolution.kind === "resolved") return;
      expect(resolution.message).not.toMatch(/\/home\/[a-z]/i);
    } finally {
      if (previous === undefined) delete process.env["OMO_PSMUX_INSTALL_DIR"];
      else process.env["OMO_PSMUX_INSTALL_DIR"] = previous;
    }
  });

  test("the real environment override is honoured when it is set", () => {
    const box = sandbox();
    writeFileSync(join(box.dir, "tmux.exe"), `#!${process.execPath}\n`, { mode: 0o755 });
    const previous = process.env["OMO_PSMUX_INSTALL_DIR"];
    process.env["OMO_PSMUX_INSTALL_DIR"] = `${box.dir}${sep}`;
    try {
      // `resolveBackend()` with no options at all: the production defaults must
      // find this, on this host, through a real stat of a real file.
      const resolution = expectResolved(resolveBackend());
      expect(resolution.source).toBe<InstallDirSource>("env");
      expect(resolution.installDir).toBe(normalizeWindowsPath(box.dir));
      expect(resolution.backendPath).toBe(join(box.dir, "tmux.exe"));
    } finally {
      if (previous === undefined) delete process.env["OMO_PSMUX_INSTALL_DIR"];
      else process.env["OMO_PSMUX_INSTALL_DIR"] = previous;
      box.cleanup();
    }
  });
});
