// Citation checker for CONTRACT.md.
//
// CONTRACT.md pins the behaviour of two external programs (the OmO bundle and
// the psmux checkout) with backtick citations of the form
// `PATH:LINE[-LINE]` → `<exact text>`. The document's own preamble admits those
// citations were re-resolved by hand, one `sed -n` at a time, with no script to
// catch drift. This file is that script: it parses every citation, routes it to
// the pinned tree, and fails loudly (exit 1) on the first sign of drift.
//
// The module is split into a pure, importable core (parse, unescape, route,
// verify, pin checks) plus a thin CLI entry at the bottom. The unit tests in
// test/contract.test.ts drive the core against temp-dir fixtures and never
// touch the real `.contract/psmux` checkout or the real OmO bundle cache.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
// A single parsed citation: `FILE:A[-B]` → expected text, found on contractLine
// (1-based) of CONTRACT.md. `expected` is still markdown-escaped here; it is
// unescaped with unescapeMarkdown just before comparison.
export interface Citation {
  file: string;
  start: number;
  end: number;
  expected: string;
  contractLine: number;
}

// One problem, printed as a single `CODE detail` line on stdout. The CODE is
// the frozen interface CONTRACT.md prose cites; the detail names the file,
// the contract line, and what was found, so a failure is actionable.
export interface Problem {
  code: string;
  detail: string;
}

export function formatProblem(problem: Problem): string {
  return `${problem.code} ${problem.detail}`;
}

// The final stdout line. CONTRACT.md prose cites this prefix, so the shape is
// frozen: counts change, the wording does not.
export function formatSummary(checked: number, problems: number): string {
  return `contract:verify: checked ${checked} citations, found ${problems} problems`;
}

// The two pinned trees, as absolute paths. Either may point at nothing on
// disk; that is itself a reportable pin problem, not a crash.
export interface VerifyTrees {
  omoBundleFile: string;
  psmuxRoot: string;
}

export interface Pins {
  omo: { verifiedAgainst: string; bundleGlob: string };
  psmux: { tag: string; commit: string; repo: string; srcRoot: string };
}

// Quoted text in CONTRACT.md is markdown-escaped one level: an outer span that
// contains backticks is itself wrapped in \`…\`, and \, ", ` inside are
// backslash-escaped. Unescape exactly one level, in this order, before
// comparing against the source line.
export function unescapeMarkdown(text: string): string {
  return text.split("\\`").join("`").split("\\\\").join("\\").split('\\"').join('"');
}

// Basename `index.js` is the OmO bundle; every other path lives in psmux.
export function routeTree(file: string): "omo" | "psmux" {
  return basename(file) === "index.js" ? "omo" : "psmux";
}

// Expand the two placeholders pins.json allows in the OmO bundle path.
export function expandBundleGlob(glob: string, version: string, home: string): string {
  return glob.split("$HOME").join(home).split("{version}").join(version);
}

// Walk up from startDir to the repository root (the dir holding package.json).
// Never relies on process.cwd(), so the checker works from any directory.
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no package.json found above ${startDir}`);
    }
    dir = parent;
  }
}

function needString(where: string, obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`pins.json: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Validate pins.json at runtime so a typo there becomes PIN_FILE_MISSING
// instead of a crash deep in the checker. No type assertions on the way in:
// every field is narrowed out of unknown.
export function parsePins(raw: unknown): Pins {
  if (!isRecord(raw)) {
    throw new Error("pins.json: top level must be an object");
  }
  const omo = raw["omo"];
  const psmux = raw["psmux"];
  if (!isRecord(omo)) {
    throw new Error("pins.json: omo must be an object");
  }
  if (!isRecord(psmux)) {
    throw new Error("pins.json: psmux must be an object");
  }
  return {
    omo: {
      verifiedAgainst: needString("omo", omo, "verifiedAgainst"),
      bundleGlob: needString("omo", omo, "bundleGlob"),
    },
    psmux: {
      tag: needString("psmux", psmux, "tag"),
      commit: needString("psmux", psmux, "commit"),
      repo: needString("psmux", psmux, "repo"),
      srcRoot: needString("psmux", psmux, "srcRoot"),
    },
  };
}

export function loadPins(pinsPath: string): Pins {
  return parsePins(JSON.parse(readFileSync(pinsPath, "utf8")));
}

// The head of a citation: a backtick span holding PATH:LINE[-LINE] followed by
// the arrow. The span content must contain a colon line number, which keeps
// prose like `"50%"` → `… "50"` and bare mentions like `index.js:19665-19666`
// (no arrow) from parsing as citations.
const CITATION_HEAD_SOURCE = "`([^`\n]*:\\d+(?:-\\d+)?)`\\s*→";

// Pull the expected text out of what follows the arrow. Two spellings occur in
// the live file: plain `…` spans, and \`…\` spans whose outer delimiters are
// backslash-escaped because the inside holds backticks or backslashes. A bare
// backtick closes a plain span; an escaped \` never does, so the escaped form
// runs to the LAST \` on the line. Trailing prose after the close (as in the
// two "opening at … →" continuations) is ignored.
function extractExpected(source: string): string | null {
  if (source.startsWith("\\`")) {
    const close = source.lastIndexOf("\\`");
    if (close <= 1) {
      return null;
    }
    return source.slice(2, close);
  }
  if (source.startsWith("`")) {
    let index = 1;
    while (index < source.length) {
      if (source[index] === "\\" && source[index + 1] === "`") {
        index += 2;
        continue;
      }
      if (source[index] === "`") {
        return source.slice(1, index);
      }
      index += 1;
    }
    return null;
  }
  return null;
}

function parseHead(content: string): { file: string; start: number; end: number } | null {
  const colon = content.lastIndexOf(":");
  if (colon <= 0) {
    return null;
  }
  const file = content.slice(0, colon);
  // Paths never contain whitespace; this rejects prose spans that happen to
  // hold a colon and digits.
  if (file === "" || /\s/.test(file)) {
    return null;
  }
  const spec = content.slice(colon + 1);
  const dash = spec.indexOf("-");
  const start = Number(dash < 0 ? spec : spec.slice(0, dash));
  const end = dash < 0 ? start : Number(spec.slice(dash + 1));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return null;
  }
  return { file, start, end };
}

// Parse every citation in the contract text. A citation whose arrow ends its
// line takes its expected text from the next line (the two "opening at … →"
// continuations); everything else is same-line.
export function parseCitations(markdown: string): Citation[] {
  const lines = markdown.split(/\r?\n/);
  const citations: Citation[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const heads = [...line.matchAll(new RegExp(CITATION_HEAD_SOURCE, "gu"))];
    for (let headIndex = 0; headIndex < heads.length; headIndex += 1) {
      const head = heads[headIndex];
      if (head === undefined || head.index === undefined || head[1] === undefined) {
        continue;
      }
      const parsed = parseHead(head[1]);
      if (parsed === null) {
        continue;
      }
      let rest = line.slice(head.index + head[0].length).trimStart();
      if (rest === "" && headIndex === heads.length - 1 && lineIndex + 1 < lines.length) {
        rest = (lines[lineIndex + 1] ?? "").trimStart();
      }
      const expected = extractExpected(rest) ?? rest;
      citations.push({ ...parsed, expected, contractLine: lineIndex + 1 });
    }
  }
  return citations;
}

// Read a source file as lines, tolerating CRLF. A trailing newline does not
// create a phantom extra line: without the drop, every newline-terminated file
// would verify a citation to a line past its end. Null means unreadable.
export function readSourceLines(absPath: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function rangeLabel(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

// Verify one citation against the pinned trees. The expected text passes when
// it is a literal substring of ANY single line in the cited range, OR of those
// lines joined with \n: some ranges cite text that lives on the first line.
export function verifyCitation(citation: Citation, trees: VerifyTrees): Problem | null {
  const absPath =
    routeTree(citation.file) === "omo" ? trees.omoBundleFile : join(trees.psmuxRoot, citation.file);
  const at = `${citation.file}:${rangeLabel(citation.start, citation.end)} (contract line ${citation.contractLine})`;
  const lines = readSourceLines(absPath);
  if (lines === null) {
    return {
      code: "CITATION_UNRESOLVED_FILE",
      detail: `${at}: ${oneLine(absPath)} is not under a pinned tree`,
    };
  }
  if (citation.start > lines.length || citation.end > lines.length) {
    return {
      code: "CITATION_LINE_OUT_OF_RANGE",
      detail: `${at}: file has ${lines.length} lines`,
    };
  }
  const expected = unescapeMarkdown(citation.expected);
  if (expected === "") {
    return { code: "CITATION_MISMATCH", detail: `${at}: quoted text is empty` };
  }
  const window = lines.slice(citation.start - 1, citation.end);
  const hit =
    window.some((line) => line.includes(expected)) || window.join("\n").includes(expected);
  if (!hit) {
    return {
      code: "CITATION_MISMATCH",
      detail: `${at}: quoted text is not a substring of the cited line(s)`,
    };
  }
  return null;
}

export function verifyAll(
  markdown: string,
  trees: VerifyTrees,
): { citations: Citation[]; problems: Problem[] } {
  const citations = parseCitations(markdown);
  const problems: Problem[] = [];
  for (const citation of citations) {
    const problem = verifyCitation(citation, trees);
    if (problem !== null) {
      problems.push(problem);
    }
  }
  return { citations, problems };
}

// The OmO pin separates which tree to read from which version the document
// was verified against. The bundle always lives at @latest; verifiedAgainst
// lags it by design. Absent bundle means the tree is not on disk; a present
// bundle whose neighbouring package.json disagrees with verifiedAgainst is
// PIN_DRIFT, and the line tells the reader what to do about it.
export function checkOmoPin(bundleFile: string, verifiedAgainst: string): Problem[] {
  if (!existsSync(bundleFile)) {
    // Name what IS installed so the drift is visible at a glance: walk up
    // from the missing versioned dir to the packages dir that holds its
    // oh-my-openagent@* siblings.
    let hint = "nothing else installed alongside it";
    try {
      const parts = bundleFile.split("/");
      const at = parts.findIndex((part) => part.startsWith("oh-my-openagent@"));
      const packagesDir = at > 0 ? parts.slice(0, at).join("/") : dirname(bundleFile);
      const others = readdirSync(packagesDir)
        .filter((name) => name.startsWith("oh-my-openagent@"))
        .sort();
      hint =
        others.length > 0
          ? `on disk instead: ${others.join(", ")}`
          : `nothing matching oh-my-openagent@* under ${packagesDir}`;
    } catch {
      // The packages dir itself is unreadable; the missing bundle is the fact.
    }
    return [
      {
        code: "PIN_TREE_MISSING",
        detail: `omo bundle not on disk: ${bundleFile} (pins.json verifiedAgainst ${verifiedAgainst}; ${hint})`,
      },
    ];
  }
  let actual: unknown = null;
  try {
    const pkgPath = join(dirname(dirname(bundleFile)), "package.json");
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    actual = isRecord(pkg) ? pkg["version"] : null;
  } catch {
    return [];
  }
  if (typeof actual === "string" && actual !== verifiedAgainst) {
    return [
      {
        code: "PIN_DRIFT",
        detail: `omo tree is ${actual} but CONTRACT.md was verified against ${verifiedAgainst} — re-verify the bundle citations and bump scripts/contract/pins.json`,
      },
    ];
  }
  return [];
}

// The psmux pin is a git checkout at an exact commit. A missing root is
// PIN_TREE_MISSING; a root that exists but is not a git checkout names a tree
// root that does not exist (PIN_FILE_MISSING); a checkout at another commit is
// PIN_DRIFT with both SHAs in the line. Never re-clones or resets here.
export function checkPsmuxPin(srcRootAbs: string, pinnedCommit: string, tag: string): Problem[] {
  if (!existsSync(srcRootAbs)) {
    return [
      {
        code: "PIN_TREE_MISSING",
        detail: `psmux tree not on disk: ${srcRootAbs} (pins.json wants ${tag} / ${pinnedCommit}; run \`bun run contract:fetch\`)`,
      },
    ];
  }
  try {
    if (!statSync(srcRootAbs).isDirectory()) {
      return [
        { code: "PIN_FILE_MISSING", detail: `psmux srcRoot is not a directory: ${srcRootAbs}` },
      ];
    }
  } catch {
    return [{ code: "PIN_TREE_MISSING", detail: `psmux tree not on disk: ${srcRootAbs}` }];
  }
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: srcRootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [
      {
        code: "PIN_FILE_MISSING",
        detail: `${srcRootAbs} exists but is not a git checkout, so the pinned ${tag} tree root does not exist there`,
      },
    ];
  }
  if (head !== pinnedCommit) {
    return [
      {
        code: "PIN_DRIFT",
        detail: `psmux tree is at ${head}, pins.json wants ${pinnedCommit} (${tag})`,
      },
    ];
  }
  return [];
}

function main(): number {
  // import.meta.dir is already an absolute path in Bun; resolving the root
  // from it (rather than process.cwd()) keeps the CLI working from any cwd.
  const root = findRepoRoot(import.meta.dir);
  const pinsPath = join(root, "scripts", "contract", "pins.json");
  let pins: Pins;
  try {
    pins = loadPins(pinsPath);
  } catch (error) {
    console.log(
      formatProblem({
        code: "PIN_FILE_MISSING",
        detail: `cannot read pins file ${pinsPath}: ${oneLine(error instanceof Error ? error.message : String(error))}`,
      }),
    );
    console.log(formatSummary(0, 1));
    return 1;
  }
  const trees: VerifyTrees = {
    omoBundleFile: expandBundleGlob(pins.omo.bundleGlob, pins.omo.verifiedAgainst, homedir()),
    psmuxRoot: join(root, pins.psmux.srcRoot),
  };
  const problems: Problem[] = [
    ...checkOmoPin(trees.omoBundleFile, pins.omo.verifiedAgainst),
    ...checkPsmuxPin(trees.psmuxRoot, pins.psmux.commit, pins.psmux.tag),
  ];
  let markdown: string;
  try {
    markdown = readFileSync(join(root, "CONTRACT.md"), "utf8");
  } catch (error) {
    problems.push({
      code: "PIN_FILE_MISSING",
      detail: `cannot read contract ${join(root, "CONTRACT.md")}: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    });
    for (const problem of problems) {
      console.log(formatProblem(problem));
    }
    console.log(formatSummary(0, problems.length));
    return 1;
  }
  const { citations, problems: citationProblems } = verifyAll(markdown, trees);
  problems.push(...citationProblems);
  for (const problem of problems) {
    console.log(formatProblem(problem));
  }
  console.log(formatSummary(citations.length, problems.length));
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
