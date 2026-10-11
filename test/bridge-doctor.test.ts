// Regression coverage for the 5.1.30 bridge-doctor repair.
//
// WHAT THE PREVIOUS VERSION OF THIS FILE GOT WRONG, because it is the whole
// reason this file was rewritten:
//
//   It asserted each check-5 anchor as two INDEPENDENT substring searches:
//       expect(doctor).toContain(`[pscustomobject]@{ Line = ${line};`)
//       expect(doctor).toContain(`Text = '${text}'`)
//   Those two searches are satisfiable by a table where the Line column and the
//   Text column have been PERMUTED against each other. Swapping the rows for
//   lines 27005 and 156115 -- telling the doctor that line 27005 holds
//   `function resolveServerUrl(...)` and line 156115 holds
//   `enabled: z49.boolean().default(false),` -- passes every assertion in that
//   file, and makes the doctor's drift detector report 0/11 on a perfectly
//   healthy 5.1.30 host. That is not a hypothetical: it is the exact failure
//   recorded in the native baseline, where `frozen_line_anchors_resolved=0/11`
//   and check 5 exited 50 on a machine with the right package installed.
//
//   So the anchors below are read OUT of the script as (Line, Text) PAIRS by a
//   single parser, and compared as pairs. A swapped row fails. There is also a
//   test that runs the same comparator against a deliberately permuted table and
//   asserts that it REJECTS it, so this file cannot quietly go back to being
//   vacuous.
//
// The other three properties pinned here, each a real failure mode:
//
//   2. The doctor's frozen-version default must equal the machine value in
//      scripts/contract/pins.json (`omo.verifiedAgainst`). The literal is read
//      from pins.json rather than repeated here, so the pin moving cannot leave
//      a second copy of the truth behind in the test file.
//   3. The equivalent-version default must not list a version the contract says
//      was never installed (5.1.17). A name in that set satisfies half of check
//      5, so a phantom entry is a hole, not a comment.
//   4. Every `Write-*` call that concatenates must PARENTHESISE the expression.
//      Unparenthesised, PowerShell's command mode splits it into separate
//      arguments; `Write-Cause` is a simple function with one declared
//      parameter, so the surplus lands in $args and is discarded with no error.
//      Measured on Windows PowerShell 5.1: line 924 printed
//      "CAUSE the contract is frozen against " and dropped the frozen version,
//      which is the one value that sentence exists to name.
//
// NATIVE EXECUTION: reading bytes proves the SHAPE of the fix, not that PowerShell
// accepts it. Actual Windows PowerShell 5.1 runs (all harness cases, argv through
// .cmd, and the real 5.1.30 anchors read out of the INSTALLED bundle) are owned by
// the windows-runner lane and by scripts/windows/harness/doctor-harness.ps1.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCTOR = `${ROOT}scripts/windows/bin/bridge-doctor.ps1`;
const LAUNCHER = `${ROOT}scripts/windows/bin/bridge-doctor.cmd`;
const HARNESS = `${ROOT}scripts/windows/harness/doctor-harness.ps1`;
const PINS = `${ROOT}scripts/contract/pins.json`;

const doctorBytes = readFileSync(DOCTOR);
const doctor = doctorBytes.toString("latin1");
const launcher = readFileSync(LAUNCHER).toString("latin1");
const harness = readFileSync(HARNESS).toString("latin1");
const pins = JSON.parse(readFileSync(PINS, "utf8")) as {
  omo: { verifiedAgainst: string; bundleGlob: string };
};

/** The contracted version, read from the pin. One source of truth. */
const CONTRACTED_VERSION = pins.omo.verifiedAgainst;

// ---------------------------------------------------------------------------
// The pair parser. This is the load-bearing piece of the file.
//
// It reads the `$anchors = @(...)` table out of the shipped script and returns
// the (Line, Text) pairs AS THE POWERShell ENGINE WOULD SEE THEM, i.e. Line and
// Text bound together on the same `[pscustomobject]@{...}` row. Matching them
// separately is what let a permuted table pass before.
type Anchor = { readonly line: number; readonly text: string };

const ANCHOR_ROW =
  /\[pscustomobject\]@\{\s*Line\s*=\s*(\d+);\s*Text\s*=\s*'((?:[^']|'')*)'\s*\}/g;

function parseAnchors(source: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of source.matchAll(ANCHOR_ROW)) {
    // PowerShell single-quoted strings escape a quote by doubling it.
    out.push({ line: Number(m[1]), text: (m[2] ?? "").replace(/''/g, "'") });
  }
  return out;
}

const shippedAnchors = parseAnchors(doctor);

/** The 11 check-5 anchors, verified against the real 5.1.30 dist/index.js. */
const EXPECTED_ANCHORS: ReadonlyArray<Anchor> = [
  { line: 8234, text: "function isInsideTmuxEnvironment(environment) {" },
  { line: 8274, text: "async function isServerRunning(serverUrl, options = {}) {" },
  { line: 8286, text: 'const healthUrl = new URL("/global/health", serverUrl).toString();' },
  { line: 8392, text: "const serverRunning = await deps.isServerRunning(serverUrl);" },
  { line: 8397, text: "const tmux = await deps.getTmuxPath();" },
  { line: 9078, text: "async function findVerifiedTmuxPath() {" },
  { line: 9084, text: 'const verifyProc = spawn([path, "-V"], {' },
  { line: 9090, text: "if (verifyExitCode !== 0) {" },
  { line: 27005, text: "enabled: z49.boolean().default(false)," },
  { line: 156115, text: "function resolveServerUrl(rawServerUrl, env, log) {" },
  {
    line: 156125,
    text: 'log("[tmux-session-manager] ctx.serverUrl has port 0; falling back. "',
  },
];

/** Compares two anchor tables by (line, text) PAIR, not by membership. */
function diffAnchors(
  actual: ReadonlyArray<Anchor>,
  expected: ReadonlyArray<Anchor>,
): string[] {
  const problems: string[] = [];
  if (actual.length !== expected.length) {
    problems.push(`row count ${actual.length}, expected ${expected.length}`);
  }
  const byLine = new Map(expected.map((a) => [a.line, a.text]));
  for (const a of actual) {
    const want = byLine.get(a.line);
    if (want === undefined) {
      problems.push(`L${a.line} is not a contracted anchor (text \`${a.text}\`)`);
    } else if (want !== a.text) {
      problems.push(
        `L${a.line} text \`${a.text}\` but the contract pairs it with \`${want}\``,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

describe("the anchor parser is not vacuous", () => {
  test("it finds exactly the 11 contracted rows in the shipped script", () => {
    expect(shippedAnchors.length).toBe(EXPECTED_ANCHORS.length);
  });

  test("it rejects a PERMUTED table, which is the defect the old file missed", () => {
    // Swap the text of the last two rows against each other. Both line numbers
    // are still present, and every individual line number and every individual
    // text string still appears somewhere in the table -- so the old
    // substring-membership assertions all pass. The pair comparison must not.
    const permuted = [...EXPECTED_ANCHORS];
    const a = permuted[8] as Anchor;
    const b = permuted[9] as Anchor;
    permuted[8] = { line: a.line, text: b.text };
    permuted[9] = { line: b.line, text: a.text };

    // Precondition: the old, weak assertions genuinely cannot see this.
    expect(permuted.some((x) => x.line === a.line)).toBe(true);
    expect(permuted.some((x) => x.text === b.text)).toBe(true);

    expect(diffAnchors(permuted, EXPECTED_ANCHORS).length).toBeGreaterThan(0);
  });

  test("it accepts the unmodified table", () => {
    expect(diffAnchors(EXPECTED_ANCHORS, EXPECTED_ANCHORS)).toEqual([]);
  });
});

describe("bridge-doctor check-5 anchors match the contract as PAIRS", () => {
  test("every Line keeps the Text the contract pairs it with", () => {
    // The offending values are IN the expected value, so a failure names them.
    expect(diffAnchors(shippedAnchors, EXPECTED_ANCHORS)).toEqual([]);
  });

  test("the anchor line numbers are all distinct", () => {
    const lines = shippedAnchors.map((a) => a.line);
    expect({ lines, unique: new Set(lines).size }).toEqual({
      lines,
      unique: lines.length,
    });
  });

  test("no stale 5.1.18-era anchor survives", () => {
    // The 5.1.18 citations were: 8227 / 8267 / 8279 / 8385 / 8390 / 9071 /
    // 9077 / 9083 / 26719 / 150702 / 150712, and `z48.boolean()`. Any of these
    // reappearing as an ANCHOR LINE is a regression, whatever the text says.
    const staleLines = [
      8227, 8267, 8279, 8385, 8390, 9071, 9077, 9083, 26719, 150702, 150712,
    ];
    const found = shippedAnchors
      .map((a) => a.line)
      .filter((n) => staleLines.includes(n));
    expect({ staleAnchorLinesStillPresent: found }).toEqual({
      staleAnchorLinesStillPresent: [],
    });

    for (const stale of [
      "z48.boolean().default(false)",
      "index.js:150704",
      "index.js:150712",
      "index.js:26719",
      "index.js:8267-8294",
      "index.js:8391",
      "index.js:8387",
    ]) {
      expect({ stale, found: doctor.includes(stale) }).toEqual({
        stale,
        found: false,
      });
    }
  });

  test("each GATE range starts on a line the anchors actually check", () => {
    // Only the three silent-failure gate ranges are covered by the check-5
    // anchor table. The config-resolution ranges (21410-21426, 26288-26302) are
    // deliberately NOT anchors -- they describe which file is read, not what is
    // at a line -- and they are verified by the isolated-home cases in
    // scripts/windows/harness/install-config-probe.ps1 instead.
    const GATE_RANGES: ReadonlyArray<readonly [string, number]> = [
      ["9078-9099", 9078],
      ["8274-8315", 8274],
      ["156115-156138", 156115],
    ];
    for (const [span, start] of GATE_RANGES) {
      expect({
        span,
        cited: doctor.includes(`index.js:${span}`),
        startIsAnAnchorLine: shippedAnchors.some((a) => a.line === start),
      }).toEqual({ span, cited: true, startIsAnAnchorLine: true });
    }

    // And the config ranges are cited without being passed off as anchors.
    for (const span of ["21410-21426", "26288-26302"]) {
      expect({
        span,
        cited: doctor.includes(`index.js:${span}`),
        wronglyClaimedAsAnchor: shippedAnchors.some((a) =>
          doctor.includes(`index.js:${span}`) && a.line === Number(span.split("-")[0]),
        ),
      }).toEqual({ span, cited: true, wronglyClaimedAsAnchor: false });
    }
  });
});

describe("bridge-doctor frozen version", () => {
  test("defaults to the contracted version, read from pins.json", () => {
    expect(CONTRACTED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doctor).toContain(`$FrozenOmoVersion = '${CONTRACTED_VERSION}'`);
  });

  test("the pin this file reads is the one the contract checker reads", () => {
    // If pins.json ever stops carrying omo.verifiedAgainst, this file would
    // silently start comparing against `undefined`.
    expect(pins.omo.verifiedAgainst).toBe("5.1.30");
    expect(pins.omo.bundleGlob).toContain("oh-my-openagent");
  });

  test("equivalent set no longer cites never-installed 5.1.17", () => {
    expect(doctor).toContain("$KnownEquivalentOmoVersions = @()");
    expect(doctor).not.toContain("@('5.1.17'");
    expect(doctor).not.toContain("known_equivalent_versions=5.1.17");
  });
});

describe("Write-* calls parenthesise every concatenation", () => {
  // PowerShell's COMMAND mode does not treat `+` as an operator between two
  // bare arguments: `Write-Cause -Text 'a' + $b` passes FOUR arguments
  // ('a', '+', $b, ...). Write-Cause declares one parameter, so the surplus
  // lands in $args and vanishes with no error. Confirmed on Windows PowerShell
  // 5.1, where the shipped line printed "CAUSE the contract is frozen against "
  // and dropped 5.1.30 -- the single value the sentence exists to name.
  const UNPARENTHESISED = /-(?:Text|Prefix|Name|Detail|Reason)\s+(?:'[^']*'|"[^"]*")\s*\+/;

  test("the doctor has no unparenthesized concatenation call site", () => {
    const offenders: string[] = [];
    doctor.split(/\r?\n/).forEach((line, index) => {
      // A full-line comment documents the bug; it does not execute.
      if (/^\s*#/.test(line)) return;
      if (UNPARENTHESISED.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
    });
    expect({ offenders }).toEqual({ offenders: [] });
  });

  test("the frozen version is named by the message that must name it", () => {
    // The specific sentence the baseline lost. Asserted by content, so a
    // reworded-but-still-correct message does not fail; a dropped value does.
    expect(doctor).toContain(
      "Write-Cause -Text ('the contract is frozen against ' + $FrozenOmoVersion + ', whose line numbers this check')",
    );
  });

  test("the detector is not vacuous: it fires on the original defect", () => {
    expect(
      UNPARENTHESISED.test(
        "Write-Cause -Text 'the contract is frozen against ' + $FrozenOmoVersion + ', x'",
      ),
    ).toBe(true);
    expect(
      UNPARENTHESISED.test(
        "Write-Cause -Text ('the contract is frozen against ' + $FrozenOmoVersion + ', x')",
      ),
    ).toBe(false);
  });

  test("the harness parenthesises too", () => {
    const offenders: string[] = [];
    harness.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (UNPARENTHESISED.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
    });
    expect({ offenders }).toEqual({ offenders: [] });
  });
});

describe("bridge-doctor PATH shadow detection excludes its own bin dir", () => {
  // Measured in the native baseline on a correctly installed host:
  //   bin_dir=C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin
  //   WARN  another opencode-psmux-bridge\bin is on the PATH:
  //         C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin
  // The warning named the doctor's own directory. A false WARN on a healthy
  // machine teaches the reader to ignore WARNs.
  test("the loop skips an entry that IS $BinDir", () => {
    expect(doctor).toContain("$isOwnBinDir = Get-SamePath $e $BinDir");
    expect(doctor).toContain(
      "if ((-not $isOwnBinDir) -and (Test-BridgeBinEntry $e)",
    );
  });

  test("a repeated shadow directory is still reported only once", () => {
    expect(doctor).toContain("$shadowsSeen = @()");
    expect(doctor).toContain("$shadowsSeen -notcontains (Get-NormalizedPath $e)");
  });
});

describe("bridge-doctor check 5 can be pointed at a scratch package tree", () => {
  // Check 5 is the only check that reads someone else's installed state. Without
  // a seam it can only be exercised against the live package cache, which means
  // "test the drift detector" and "do not disturb the live install" cannot both
  // hold. Same rationale -ConfigPath already documents for check 4.
  test("-PackageRoot exists and defaults to the live cache", () => {
    expect(doctor).toContain("[string] $PackageRoot,");
    expect(doctor).toContain(
      "$pkgRoot = Join-Path $env:USERPROFILE '.cache\\opencode\\packages'",
    );
  });

  test("the override is a read, and cannot make a drifted bundle pass", () => {
    // The comparison is against the bytes actually found at the cited line, so
    // pointing at a different tree changes WHICH bundle is checked, never
    // WHETHER it passes.
    expect(doctor).toContain(
      ".StartsWith($a.Text, [System.StringComparison]::Ordinal)",
    );
    expect(doctor).not.toContain("if ($PackageRoot -ne '') { $anchorHits = $anchors.Count }");
  });
});

describe("bridge-doctor launcher", () => {
  test("still propagates the doctor exit code unchanged", () => {
    expect(launcher).toContain("BRIDGE_DOCTOR_EXIT=%ERRORLEVEL%");
    expect(launcher).toContain("exit /b %BRIDGE_DOCTOR_EXIT%");
  });
});

describe("doctor harness portability", () => {
  test("takes its paths as parameters with environment-derived defaults", () => {
    expect(harness.startsWith("param(")).toBe(true);
    for (const name of [
      "$BridgeBin",
      "$HarnessDir",
      "$WorkDir",
      "$NodeExe",
      "$LiveConfigPath",
      "$LiveDataDir",
    ]) {
      expect(harness).toContain(name);
    }
  });

  test("no machine-specific path or pinned shim identity survives", () => {
    for (const stale of [
      "C:\\opencode-t13",
      "C:\\Users\\Daniel",
      "9EA5E733FD78F4EA966A85A5CF062D1113C644FEFF80AD3B3084574c2BA2A858",
      "bytes=86110208",
      "omo_t13",
      "t13s",
    ]) {
      expect({ stale, found: harness.includes(stale) }).toEqual({
        stale,
        found: false,
      });
    }
  });

  test("the core cases own their fixtures instead of waiting on live state", () => {
    // The old harness SKIPPED the happy case whenever no opencode loopback
    // port happened to be listening, which is the normal state of a machine
    // that is not currently running a server -- so the most important case was
    // usually the one that never ran. The harness now starts its own HTTP
    // fixture, builds its own bin dir, and owns its own package tree.
    expect(harness).toContain("health-fixture-port.txt");
    expect(harness).toContain("stale-fixture-data");
    expect(harness).toContain("fxprobe__stale.port");
  });
});

// ---------------------------------------------------------------------------
// Byte invariants. The maintainer's console codepage is BIG5 and every one of
// these scripts writes through [Console]::Out.WriteLine, so a non-ASCII byte is
// mangled or dropped on exactly the host that runs them.

describe("doctor file byte invariants", () => {
  test("the .ps1 is pure ASCII", () => {
    const offenders: string[] = [];
    doctorBytes.forEach((byte, index) => {
      if (byte > 127) offenders.push(`0x${byte.toString(16)}@${index}`);
    });
    expect({ offenders: offenders.slice(0, 5) }).toEqual({ offenders: [] });
  });

  test("the .ps1 uses LF only, so no CR is smuggled into a here-line", () => {
    expect(doctorBytes.includes(0x0d)).toBe(false);
  });

  test("the .cmd launcher stays CRLF, with no bare LF", () => {
    const bytes = readFileSync(LAUNCHER);
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0a) {
        lf += 1;
        if (i > 0 && bytes[i - 1] === 0x0d) crlf += 1;
      }
    }
    expect({ bareLF: lf - crlf, lines: lf }).toEqual({ bareLF: 0, lines: lf });
    expect(lf).toBeGreaterThan(0);
  });
});