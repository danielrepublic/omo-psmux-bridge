// byte-level invariants of the shipped Windows scripts.
//
// Nothing in the bridge's own test suite reads `scripts/`. The `.cmd` and `.ps1`
// files that go into the release package are therefore completely uncovered, even
// though they are the only files a user's fingers ever touch: `install.cmd` is the
// thing they double-click, and `psmux.cmd` is the thing that starts the
// multiplexer.
//
// What is pinned here, and why each one is a real failure mode rather than a
// style preference:
//
//   1. Every shipped `.cmd` is CRLF, with no bare LF anywhere. This is the one
//      that actually shipped broken. `install.cmd` was authored with LF endings
//      while `psmux.cmd` and `opencode.cmd` -- the two files already known to run
//      on a Windows host -- were CRLF. `.gitattributes` marks `scripts/windows/**`
//      as `-text`, so git never normalises the difference: the LF file reached the
//      published release byte for byte. `cmd.exe` parses a batch file line by
//      line, and `install.cmd` is the shipped file with THREE multi-line
//      parenthesised blocks -- the construct most sensitive to a line ending the
//      parser does not expect. It had never run on any Windows host when it
//      shipped, so nothing but a test would have caught it.
//
//   2. No doubled CR. A CRLF conversion run twice produces blank lines, and a
//      blank line inside a parenthesised block ends the block. This is the check
//      that catches a careless "fix" for (1).
//
//   3. Every shipped script is ASCII. They all say so in their own headers -- the
//      maintainer's console codepage is big5, and the installers write through
//      `[Console]::Out.WriteLine` precisely because of it. A non-ASCII byte renders
//      as mojibake or drops silently on that host, and only there.
//
//   4. Every file the release promises exists, except `tmux.exe`, which CI builds
//      and `.gitignore` excludes -- asserting it here would fail for anyone who
//      has not run a build. Its presence in the release is proven by the CI
//      manifest gate.
//
// None of this needs Windows. Every assertion reads bytes, and reading bytes is
// the whole point: the defect that shipped was invisible to every test that ran,
// because every test that ran was exercising the TypeScript, not the batch.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = `${ROOT}scripts/windows/bin`;
const RUNTIME = `${ROOT}scripts/windows/runtime`;
const RELEASE = `${ROOT}scripts/windows/release`;

/** The four `.cmd` files that ship. Discovered rather than listed, because a new
 *  launcher nobody adds to a test is exactly the case (1) exists to catch. */
const cmdFiles = readdirSync(BIN)
  .filter((name) => name.toLowerCase().endsWith(".cmd"))
  .sort();

/** Every script that ships, paired with the directory it lives in. */
const shippedScripts: ReadonlyArray<readonly [string, string]> = [
  ...readdirSync(BIN)
    .filter((name) => /\.(cmd|ps1)$/i.test(name))
    .sort()
    .map((name): readonly [string, string] => [name, BIN]),
  ...readdirSync(RUNTIME)
    .filter((name) => /\.(cmd|ps1)$/i.test(name))
    .sort()
    .map((name): readonly [string, string] => [name, RUNTIME]),
];

function occurrences(haystack: Uint8Array, needle: readonly number[]): number {
  let count = 0;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((byte, offset) => haystack[index + offset] === byte)) {
      count += 1;
      index += needle.length - 1;
    }
  }
  return count;
}

describe("the shipped .cmd files are CRLF", () => {
  test("the file set is discovered, not hardcoded, so it cannot pass vacuously", () => {
    // If the discovery ever returned nothing, every assertion below would be
    // trivially true. That is the failure mode this file most needs to avoid: it
    // exists because a real defect got through a suite that looked green.
    expect(cmdFiles.length).toBeGreaterThanOrEqual(3);
    expect(cmdFiles).toContain("install.cmd");
    expect(cmdFiles).toContain("psmux.cmd");
  });

  for (const name of cmdFiles) {
    test(`${name} has no bare LF`, () => {
      const bytes = readFileSync(`${BIN}/${name}`);
      const crlf = occurrences(bytes, [0x0d, 0x0a]);
      const total = occurrences(bytes, [0x0a]);
      const bare = total - crlf;
      // Compared as an object so a failure prints the file and both counts.
      expect({ file: name, bare, lines: total, crlf }).toEqual({
        file: name,
        bare: 0,
        lines: total,
        crlf,
      });
      expect(total).toBeGreaterThan(0);
    });

    test(`${name} has no doubled CR`, () => {
      const bytes = readFileSync(`${BIN}/${name}`);
      expect({ file: name, doubledCR: occurrences(bytes, [0x0d, 0x0d]) }).toEqual({
        file: name,
        doubledCR: 0,
      });
    });
  }
});

describe("every shipped script is ASCII", () => {
  for (const [name, dir] of shippedScripts) {
    test(`${name} has no byte above 127`, () => {
      const bytes = readFileSync(`${dir}/${name}`);
      const offenders: string[] = [];
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index] ?? 0;
        if (byte > 127) {
          offenders.push(`0x${byte.toString(16).padStart(2, "0")}@${index}`);
          if (offenders.length >= 5) break;
        }
      }
      // The offending bytes are IN the expected value, so a failure names them.
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] });
    });
  }
});

describe("the release manifest exists in this tree", () => {
  const required = [
    "INSTALL.md",
    "scripts/windows/bin/install.cmd",
    "scripts/windows/bin/install.ps1",
    "scripts/windows/bin/uninstall.ps1",
    "scripts/windows/bin/bridge-doctor.ps1",
    "scripts/windows/bin/bridge-doctor.cmd",
    "scripts/windows/bin/psmux.cmd",
    "scripts/windows/bin/opencode.cmd",
    "scripts/windows/bin/omo-opencode-port.ps1",
    "scripts/windows/runtime/Start-PaneFromDescriptor.ps1",
  ];

  for (const relative of required) {
    test(`${relative} exists`, () => {
      expect(existsSync(`${ROOT}${relative}`)).toBe(true);
    });
  }

  test("install-bootstrap.ps1 exists, because the one-line install line fetches it", () => {
    expect(existsSync(`${RELEASE}/install-bootstrap.ps1`)).toBe(true);
  });
});