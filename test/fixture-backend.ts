// Shared fixtures for the tests that spawn a real stand-in for the backend.
//
// WHY THIS EXISTS
// ---------------
// These suites assert that argv reaches the backend by DIRECT spawn, with no
// shell anywhere in the path (src/backend.ts). To prove that they have to spawn
// something real, and for years that something was a shebang script:
//
//     #!<absolute bun path>
//     process.stdout.write(JSON.stringify(process.argv.slice(2)));
//
// A shebang is a POSIX kernel feature. `CreateProcess` has no equivalent: it
// resolves `psmux.exe` as a PE image, finds a text file, and fails with exit 1
// before a single byte of the fixture runs. Every one of the 25 Windows
// failures in the 336-test baseline was that, or one of its two consequences.
// A `.cmd`/`.bat` shim is NOT an acceptable substitute: Node refuses to spawn
// one without `shell: true` since the CVE-2024-27980 fix, so "fixing" the
// fixtures that way would smuggle a `cmd` into precisely the tests that exist
// to prove no `cmd` is ever started.
//
// WHAT THIS DOES INSTEAD
// ----------------------
// The fixture file is UNCHANGED on every platform: same path, same bytes,
// same `#!<process.execPath>` first line. What changes is the single act of
// starting it. On POSIX the file is exec'd and the kernel reads the shebang. On
// Windows `fixtureSpawn` runs the very same file with the very same
// interpreter the shebang named, as `bun <path> <argv...>`:
//
//   - the interpreter is the absolute `process.execPath`, never `/usr/bin/env`,
//     so a replaced environment with no PATH cannot find the wrong bun;
//   - argv is passed as an ARRAY with `shell: false`, byte-for-byte, which is
//     verified on the Windows host rather than assumed;
//   - `process.argv.slice(2)` inside the fixture therefore sees EXACTLY what
//     it sees under the shebang, because in both cases slot 0 is the
//     interpreter and slot 1 is the script.
//
// So the adapter substitutes the *program*, never the *arguments*, and never
// the options. `shell` stays false and `windowsHide` stays true, because those
// objects are the assertion surface of
// "argv reaches the backend directly: no shell, no `cmd`, no `/c`". A spy that
// wraps `fixtureSpawn` records the executable and argv BEFORE the substitution
// happens, so what that test inspects is still the values src/backend.ts passed
// down. Nothing about the property under test is relaxed; only the way the
// test harness launches its own stand-in is host-appropriate.
//
// The adapter is also NARROW: it only substitutes executables that
// `writeBackendFixture` created in this process. A real `psmux.exe`, and the
// compiled shim in the chain-guard test, go to `spawn` untouched.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendSpawnOptions, SpawnBackend } from "../src/backend";

/** Windows has no shebang support, so the fixtures there need the interpreter. */
const NEEDS_INTERPRETER = process.platform === "win32";

/** Exactly the fixtures this process created, by the path they were created at.
 *  Membership is what makes the substitution narrow: anything not in here is
 *  spawned as-is. */
const FIXTURES = new Set<string>();

/** A scratch directory holding runnable stand-ins for `psmux.exe`, plus the
 *  `spawn` that can start them on this host. */
export interface FixtureSandbox {
  /** The scratch directory. Also used as the fake `installDir`. */
  readonly dir: string;
  /** Writes a runnable stand-in at a fresh path and returns that path. */
  readonly pscript: (body: string) => string;
  /** The `SpawnBackend` to hand `runBackend`, or to wrap in a spy. */
  readonly spawn: SpawnBackend;
  readonly cleanup: () => void;
}

/** A temp directory of executable stand-ins for `psmux.exe`.
 *
 *  The bodies are JavaScript, not shell one-liners, so nothing under test can
 *  smuggle a shell in through the backend itself. */
export function fixtureSandbox(): FixtureSandbox {
  const dir = mkdtempSync(join(tmpdir(), "omo-backend-"));
  return {
    dir,
    pscript: (body: string): string => {
      const path = join(dir, `fake-${Math.random().toString(36).slice(2)}.bin`);
      writeBackendFixture(path, body);
      return path;
    },
    spawn: fixtureSpawn,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Writes `body` as a directly runnable file at `path` and returns that path.
 *
 *  Absolute `process.execPath`, not `#!/usr/bin/env bun`: these stand-ins are
 *  spawned with a replaced environment and so have no PATH, and `/usr/bin/env`
 *  then falls back to `/bin:/usr/bin` — which finds a system bun and misses one
 *  installed under a user's home. That is how this passed on the machine that
 *  wrote it and failed on a runner with bun under ~/.bun/bin with exit 127.
 *
 *  `mode: 0o755` is a no-op on Windows, which has no execute bit; it is kept so
 *  the file is identical on both platforms and only the launch differs. */
export function writeBackendFixture(path: string, body: string): string {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  FIXTURES.add(path);
  return path;
}

/**
 * The `spawn` seam for fixture-backed tests.
 *
 * On POSIX this is the identity. On Windows it substitutes the interpreter for
 * the fixtures this process wrote and does nothing else: it never touches
 * `argv`, never touches `options`, and never enables a shell.
 */
export const fixtureSpawn: SpawnBackend = (
  executable: string,
  argv: readonly string[],
  options: BackendSpawnOptions,
) => {
  const launch = fixtureLaunch(executable, argv);
  return nodeSpawn(launch.program, [...launch.argv], { ...options });
};

/**
 * Which program actually runs a fixture, and with what argv.
 *
 * POSIX is the identity. On Windows a fixture is run as
 * `bun <fixture> <argv...>`, so slot 0 is the interpreter and slot 1 is the
 * script and the caller's argv follows unchanged — which is exactly the layout
 * a shebang produces, so `process.argv.slice(2)` reads the same in the fixture
 * on both platforms. The executable is the absolute `process.execPath`, never a
 * bare `bun`, because the fixtures are spawned with a replaced environment that
 * has no PATH to resolve one against.
 *
 * Split out from `fixtureSpawn` so a test that needs its own `stdio` can apply
 * the same substitution without giving up the `SpawnBackend` option shape.
 */
export function fixtureLaunch(
  executable: string,
  argv: readonly string[],
): { readonly program: string; readonly argv: readonly string[] } {
  if (!NEEDS_INTERPRETER || !FIXTURES.has(executable)) return { program: executable, argv };
  return { program: process.execPath, argv: [executable, ...argv] };
}