// Unit tests for the CONTRACT.md citation checker.
//
// The checker parses citations out of CONTRACT.md and verifies them against
// two pinned source trees. These tests drive its pure core (parse, unescape,
// route, verify, pin checks) against fixtures under a temp dir, never against
// the real `.contract/psmux` checkout or the real OmO bundle cache: the point
// is to prove each failure code fires for the reason it names, with no
// network, no cache, and no dependence on what happens to be installed.
//
// Fixture layout per test: `<tmp>/omo/index.js` stands in for the OmO bundle
// and `<tmp>/psmux/<path>` for the psmux tree, wired together as VerifyTrees.

import { describe, expect, test, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkOmoPin,
  checkPsmuxPin,
  formatSummary,
  parseCitations,
  routeTree,
  unescapeMarkdown,
  verifyAll,
  verifyCitation,
  type Citation,
  type VerifyTrees,
} from "../scripts/contract/verify-citations";

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

// Fresh pair of stand-in trees. `omoLines` become the whole index.js bundle;
// `psmuxFiles` maps a tree-relative path to its lines.
function makeTrees(omoLines: string[], psmuxFiles: Record<string, string[]>): VerifyTrees {
  const dir = mkdtempSync(join(tmpdir(), "contract-test-"));
  scratchDirs.push(dir);
  const omoBundleFile = join(dir, "omo", "index.js");
  mkdirSync(join(dir, "omo"), { recursive: true });
  writeFileSync(omoBundleFile, `${omoLines.join("\n")}\n`);
  const psmuxRoot = join(dir, "psmux");
  mkdirSync(psmuxRoot, { recursive: true });
  for (const [rel, lines] of Object.entries(psmuxFiles)) {
    const abs = join(psmuxRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `${lines.join("\n")}\n`);
  }
  return { omoBundleFile, psmuxRoot };
}

function codesOf(markdown: string, trees: VerifyTrees): string[] {
  return verifyAll(markdown, trees).problems.map((problem) => problem.code);
}

describe("the citation core", () => {
  test("a matching citation verifies", () => {
    // The psmux fixture is rewritten CRLF on purpose: the checker must split
    // \r\n into lines, and a missed \r would fail this match.
    const trees = makeTrees(["bundle line"], { "src/a.rs": ["placeholder"] });
    writeFileSync(
      join(trees.psmuxRoot, "src", "a.rs"),
      `${["fn one() {", "    hello();", "}"].join("\r\n")}\r\n`,
    );
    const { citations, problems } = verifyAll("- `src/a.rs:2` → `hello();`", trees);
    expect(citations.length).toBe(1);
    expect(problems).toEqual([]);
  });

  test("a text-mismatch yields CITATION_MISMATCH", () => {
    const trees = makeTrees([], { "src/a.rs": ["fn one() {", "    hello();", "}"] });
    expect(codesOf("- `src/a.rs:2` → `goodbye();`", trees)).toEqual(["CITATION_MISMATCH"]);
  });

  test("a missing file yields CITATION_UNRESOLVED_FILE", () => {
    const trees = makeTrees([], { "src/a.rs": ["fn one() {}"] });
    expect(codesOf("- `src/nope.rs:1` → `fn one() {}`", trees)).toEqual([
      "CITATION_UNRESOLVED_FILE",
    ]);
  });

  test("an out-of-range line yields CITATION_LINE_OUT_OF_RANGE", () => {
    const trees = makeTrees([], { "src/a.rs": ["fn one() {}", "fn two() {}"] });
    expect(codesOf("- `src/a.rs:99` → `fn nine() {}`", trees)).toEqual([
      "CITATION_LINE_OUT_OF_RANGE",
    ]);
  });

  test("a range where the text is on the first line of the range passes", () => {
    const trees = makeTrees([], {
      "src/window_ops.rs": ["if idx + 1 < sizes.len() {", "    sizes[idx] = 1;", "}"],
    });
    const { problems } = verifyAll(
      "- `src/window_ops.rs:1-3` → `if idx + 1 < sizes.len() {`",
      trees,
    );
    expect(problems).toEqual([]);
  });

  test("a range where the text spans the joined lines passes", () => {
    // The markdown parser never yields an expected text with an embedded
    // newline (it comes from one contract line), so this reaches past the
    // parser and constructs the citation directly: it proves the comparator
    // tries the lines-joined-with-\n form, not just each line alone.
    const trees = makeTrees([], { "src/a.rs": ["fn one() {", "    hello();"] });
    const spanning: Citation = {
      file: "src/a.rs",
      start: 1,
      end: 2,
      expected: "fn one() {\n    hello();",
      contractLine: 1,
    };
    expect(verifyCitation(spanning, trees)).toBeNull();
  });

  test("`index.js:...` routes to the OmO tree and `src/....rs:...` routes to the psmux tree", () => {
    // Each marker lives ONLY in its own tree: a pass proves the citation was
    // read from the right one, since the other tree cannot resolve it.
    const trees = makeTrees(["const OMO_MARKER = 1;"], {
      "src/x.rs": ["const PSMUX_MARKER: u8 = 2;"],
    });
    expect(routeTree("index.js")).toBe("omo");
    expect(routeTree("src/x.rs")).toBe("psmux");
    const { citations, problems } = verifyAll(
      ["- `index.js:1` → `const OMO_MARKER = 1;`", "- `src/x.rs:1` → `PSMUX_MARKER`"].join("\n"),
      trees,
    );
    expect(citations.length).toBe(2);
    expect(problems).toEqual([]);
  });

  test("markdown unescaping of `\\``, `\\\\`, `\\\"`", () => {
    expect(unescapeMarkdown("\\`")).toBe("`");
    expect(unescapeMarkdown("\\\\")).toBe("\\");
    expect(unescapeMarkdown('\\"')).toBe('"');
    // End to end in both directions of the real spot cases: a Rust line with
    // a doubled backslash, and an NSI line with a single one, both cited
    // through markdown-escaped spans.
    const rustLine = 'let obj = format!("Local\\\\psmux-session-{x}");';
    const nsiLine = 'InstallDir "$LOCALAPPDATA\\psmux"';
    const trees = makeTrees([], { "src/platform.rs": [rustLine], "installer/psmux.nsi": [nsiLine] });
    const mdEscape = (raw: string): string =>
      raw.split("\\").join("\\\\").split('"').join('\\"').split("`").join("\\`");
    const { problems } = verifyAll(
      [
        "- `src/platform.rs:1` → \\`" + mdEscape(rustLine) + "\\`",
        "- `installer/psmux.nsi:1` → \\`" + mdEscape(nsiLine) + "\\`",
      ].join("\n"),
      trees,
    );
    expect(problems).toEqual([]);
  });

  test("PIN_DRIFT when a git tree is at the wrong commit, and PIN_TREE_MISSING when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-pin-"));
    scratchDirs.push(dir);
    const root = join(dir, "psmux");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.rs"), "fn a() {}\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"], {
      cwd: root,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(checkPsmuxPin(root, head, "v3.3.8")).toEqual([]);
    const drift = checkPsmuxPin(root, "0".repeat(40), "v3.3.8");
    expect(drift.map((problem) => problem.code)).toEqual(["PIN_DRIFT"]);
    expect(drift[0]?.detail).toContain(head);
    expect(drift[0]?.detail).toContain("0".repeat(40));
    const missing = checkPsmuxPin(join(dir, "never-cloned"), head, "v3.3.8");
    expect(missing.map((problem) => problem.code)).toEqual(["PIN_TREE_MISSING"]);
    const plainDir = join(dir, "plain");
    mkdirSync(plainDir, { recursive: true });
    expect(checkPsmuxPin(plainDir, head, "v3.3.8").map((problem) => problem.code)).toEqual([
      "PIN_FILE_MISSING",
    ]);
  });

  test("the OmO pin reports a missing bundle and a drifted version", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-omo-"));
    scratchDirs.push(dir);
    const bundleFile = join(dir, "dist", "index.js");
    expect(checkOmoPin(bundleFile, "5.1.21").map((problem) => problem.code)).toEqual([
      "PIN_TREE_MISSING",
    ]);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(bundleFile, "var x = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "5.1.21" }));
    expect(checkOmoPin(bundleFile, "5.1.21")).toEqual([]);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "5.1.20" }));
    const drift = checkOmoPin(bundleFile, "5.1.21");
    expect(drift.map((problem) => problem.code)).toEqual(["PIN_DRIFT"]);
    expect(drift[0]?.detail).toContain("5.1.20");
    expect(drift[0]?.detail).toContain("5.1.21");
    expect(drift[0]?.detail).toContain("re-verify the bundle citations");
  });

  test("an @latest tree holding a newer bundle than verifiedAgainst still drifts", () => {
    // The owner's actual scenario: the cache dir is literally
    // oh-my-openagent@latest, verifiedAgainst lags it by design, and the run
    // must say so naming both versions. Pinned explicitly because this is the
    // case that will fire most often.
    const dir = mkdtempSync(join(tmpdir(), "contract-omo-latest-"));
    scratchDirs.push(dir);
    const cacheDir = join(dir, "oh-my-openagent@latest", "node_modules", "oh-my-openagent");
    const bundleFile = join(cacheDir, "dist", "index.js");
    mkdirSync(join(cacheDir, "dist"), { recursive: true });
    writeFileSync(bundleFile, "var x = 1;\n");
    writeFileSync(join(cacheDir, "package.json"), JSON.stringify({ version: "5.1.22" }));
    const drift = checkOmoPin(bundleFile, "5.1.21");
    expect(drift.map((problem) => problem.code)).toEqual(["PIN_DRIFT"]);
    expect(drift[0]?.detail).toContain("5.1.22");
    expect(drift[0]?.detail).toContain("5.1.21");
    writeFileSync(join(cacheDir, "package.json"), JSON.stringify({ version: "5.1.21" }));
    expect(checkOmoPin(bundleFile, "5.1.21")).toEqual([]);
  });

  test("prose lines without a line number or arrow do not parse as citations", () => {
    const citations = parseCitations(
      [
        "Written as `` `index.js:NNNN` → `<exact text>` `` for the OmO bundle,",
        "bare mentions like `index.js:19665-19666` carry no quoted text,",
        "nor does prose such as `\"50%\"` → `… \"50\"`).",
      ].join("\n"),
    );
    expect(citations).toEqual([]);
  });

  test("the summary line states citations checked and problems found", () => {
    expect(formatSummary(174, 0)).toBe("contract:verify: checked 174 citations, found 0 problems");
    expect(formatSummary(174, 91)).toBe("contract:verify: checked 174 citations, found 91 problems");
  });
});
