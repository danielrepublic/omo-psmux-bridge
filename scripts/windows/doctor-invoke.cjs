// doctor-invoke.cjs -- argv-fidelity-preserving doctor runner.
//
// WHY THIS EXISTS (recorded failures I-15 / T-12c / V-18 / V-22):
//   * PowerShell's `Start-Process -ArgumentList @(...)` joins the array into ONE
//     command-line string that the child re-parses, so an argument containing a
//     space arrives split. This driver always passes a real argv array.
//   * PowerShell's `ProcessStartInfo` + `ReadToEndAsync` returns EMPTY stdout on
//     this host, which silently turns every comparison into a vacuous pass. So
//     the doctor's own stdout is written straight to a FILE by the child: no pipe
//     layer sits between the doctor's WriteLine calls and the bytes we assert on.
//
// Usage: node doctor-invoke.cjs <ps1> <outFile> <errFile> <jsonEnvOverrides> [args...]
//   <jsonEnvOverrides> is a JSON object of env vars to set/remove (null = unset).
// Prints one JSON line to its own stdout. Never uses a shell.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [ps1, outFile, errFile, envJson, ...args] = process.argv.slice(2);
if (!ps1 || !outFile || !errFile || !envJson) {
  process.stderr.write('usage: doctor-invoke.cjs <ps1> <out> <err> <envJson> [args...]\n');
  process.exit(64);
}

const env = Object.assign({}, process.env);
const overrides = JSON.parse(envJson);
for (const [k, v] of Object.entries(overrides)) {
  if (v === null) delete env[k];
  else env[k] = String(v);
}

const outFd = fs.openSync(outFile, 'w');
const errFd = fs.openSync(errFile, 'w');
const t0 = Date.now();
const r = spawnSync(
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args],
  { env, stdio: ['ignore', outFd, errFd], windowsHide: true },
);
const wallMs = Date.now() - t0;
fs.closeSync(outFd);
fs.closeSync(errFd);

const stat = (f) => {
  try {
    const s = fs.statSync(f);
    return { exists: true, bytes: s.size };
  } catch {
    // A MISSING FILE IS ZERO LINES, never -1 (recorded failure mode I-16).
    return { exists: false, bytes: 0, lines: 0 };
  }
};
const countLines = (f) => {
  if (!fs.existsSync(f)) return 0; // missing file == zero lines, never -1
  return fs.readFileSync(f, 'latin1').split('\n').filter((l) => l.trim() !== '').length;
};

process.stdout.write(
  JSON.stringify({
    argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args],
    envOverrides: overrides,
    status: r.status === null ? null : r.status, // null == killed by signal
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message) : null,
    wallMs,
    outFile,
    outBytes: stat(outFile).bytes,
    outLines: countLines(outFile),
    errFile,
    errBytes: stat(errFile).bytes,
    errLines: countLines(errFile),
  }) + '\n',
);
process.exit(0);