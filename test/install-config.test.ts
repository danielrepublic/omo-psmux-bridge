// install.ps1 configuration-path regression coverage.
//
// THE DEFECT. install.ps1 probed tmux.enabled with a raw regex over the raw text
// of the OPENCODE config:
//
//     $block = [regex]::Match($text, '"tmux"\s*:\s*\{(?<body>[^}]{0,400})\}')
//
// and then told the user to edit that file. Both halves are wrong, and the
// bundle says so:
//
//   * Wrong FILE. `tmux.enabled` is read by
//       isTmuxIntegrationEnabled(pluginConfig) -> pluginConfig.tmux?.enabled ?? false
//     (index.js:141083-141084), and pluginConfig is the `[opencode]` block of the
//     OMO config chain (index.js:26288-26302). It is never a top-level `tmux` key
//     in opencode.jsonc.
//   * Wrong METHOD. A raw regex answers TRUE for a config whose only match is a
//     comment:
//         // "[opencode]" "tmux" "enabled": true
//     and commented-out config is how users normally disable a setting. The probe
//     below asserts that exact file MATCHES the old pattern, so the regression
//     this file guards is demonstrably real rather than hypothetical.
//
// The resolution rules the installer must mirror, verified against the real
// 5.1.30 bundle before the code was written:
//   21410  resolveHomeDir: env.HOME ?? env.USERPROFILE ?? process.cwd()
//   21420  detectUserOmoJsonPath: <home>/.omo/omo.jsonc if it exists,
//          else <home>/.omo/omo.json if it exists, else <home>/.omo/omo.jsonc
//   21481  resolveOmoConfigPaths is the LOADER and calls detectUserOmoJsonPath.
//          resolveUserOmoConfigPath (21414) is only the WRITE path (22138), so it
//          must not be used to model loading.
//
// These are static assertions and they need no Windows. The BEHAVIOURAL half --
// HOME precedence, the omo.json fallback, and the comment decoy actually being
// rejected -- runs natively in scripts/windows/harness/install-config-probe.ps1,
// which extracts only these functions through the PowerShell AST and never
// compiles the installer's main body.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const install = readFileSync(`${ROOT}scripts/windows/bin/install.ps1`, "latin1");
const probe = readFileSync(
  `${ROOT}scripts/windows/harness/install-config-probe.ps1`,
  "latin1",
);

describe("the old raw-regex tmux probe is gone", () => {
  test("install.ps1 no longer probes tmux with a raw regex over raw text", () => {
    // Each of these is the old defect in a form it cannot drift back into.
    expect(install).not.toContain('[regex]::Match($text, \'"tmux"');
    expect(install).not.toContain("(?<body>[^}]{0,400})");
    expect(install).not.toContain("function Read-TmuxEnabled");
  });

  test("the raw regex WOULD have matched the comment decoy, so the defect is real", () => {
    // The decoy has to be the shape the old pattern actually needed -- it
    // required a `{` after the colon -- so this proves a live hazard rather than
    // a merely plausible one. A user who commented the whole block out gets
    // exactly this file.
    const decoy = '{\n  // "[opencode]": { "tmux": { "enabled": true } }\n}\n';
    const block = /"tmux"\s*:\s*\{(?<body>[^}]{0,400})\}/.exec(decoy);
    const enabled = block
      ? /"enabled"\s*:\s*(true|false)/i.exec(block.groups?.["body"] ?? "")
      : null;
    // The old probe reported TRUE for a file that sets nothing at all.
    expect({
      decoySetsAnything: /^\s*\{[^/]*"tmux"/.test(decoy.replace(/\/\/[^\n]*/g, "")),
      oldProbeSaid: enabled?.[1] ?? null,
    }).toEqual({ decoySetsAnything: false, oldProbeSaid: "true" });
  });
});

describe("install.ps1 resolves the OMO config the way the bundle does", () => {
  test("Get-OmoConfigPath exists and prefers HOME over USERPROFILE", () => {
    expect(install).toContain("function Get-OmoConfigPath");
    expect(install).toContain("if ($null -ne $env:HOME) { $homeDir = $env:HOME }");
    expect(install).toContain(
      "elseif ($null -ne $env:USERPROFILE) { $homeDir = $env:USERPROFILE }",
    );
  });

  test("it is a NULL test, because `??` is null-coalescing and not truthiness", () => {
    // An empty-string test would pick USERPROFILE where the bundle picks HOME.
    // That divergence is asserted natively too, and it is silent either way.
    const resolver = /function Get-OmoConfigPath \{[\s\S]*?\n\}/.exec(install)?.[0] ?? "";
    expect(resolver).toContain("$null -ne $env:HOME");
    expect(resolver).not.toContain("IsNullOrEmpty($env:HOME)");
    expect(resolver).not.toContain("IsNullOrEmpty($env:USERPROFILE)");
  });

  test("it tries omo.jsonc, then omo.json, then reports the expected jsonc path", () => {
    const resolver = /function Get-OmoConfigPath \{[\s\S]*?\n\}/.exec(install)?.[0] ?? "";
    const jsoncAt = resolver.indexOf("if (Test-Path -LiteralPath $jsoncPath) { return $jsoncPath }");
    const jsonAt = resolver.indexOf("if (Test-Path -LiteralPath $jsonPath) { return $jsonPath }");
    const finalAt = resolver.lastIndexOf("return $jsoncPath");
    // Order is the whole contract: jsonc first, json only as a fallback, and the
    // jsonc path returned when neither exists so the advice names a real location.
    expect({ jsoncAt: jsoncAt > 0, jsonAt: jsonAt > jsoncAt, finalAt: finalAt > jsonAt }).toEqual(
      { jsoncAt: true, jsonAt: true, finalAt: true },
    );
  });

  test("Get-OpencodeConfigPath is kept, for the plugin declaration only", () => {
    expect(install).toContain("function Get-OpencodeConfigPath");
    // It must no longer claim to be where tmux.enabled lives.
    expect(install).not.toContain(
      "where the OmO plugin is declared and where\n# tmux.enabled lives",
    );
  });
});

describe("install.ps1 reads the setting truthfully", () => {
  test("it parses the document rather than regexing it", () => {
    expect(install).toContain("function Read-OmoTmuxEnabled");
    expect(install).toContain("function ConvertTo-PlainJsonText");
    expect(install).toContain("ConvertFrom-Json -ErrorAction Stop");
  });

  test("it reads the nested [opencode] -> tmux -> enabled path", () => {
    expect(install).toContain("$json.PSObject.Properties['[opencode]']");
    expect(install).toContain("$opencodeNode.Value.PSObject.Properties['tmux']");
    expect(install).toContain("$tmuxNode.Value.PSObject.Properties['enabled']");
  });

  test("only a JSON boolean true counts", () => {
    // `"enabled": "true"` is a string. The loader's `?? false` reads it as falsy,
    // so accepting it would tell a user their panes work when they do not.
    expect(install).toContain("if ($enabledNode.Value -is [bool])");
  });

  test("the comment stripper is string-aware, or a $schema https:// eats the file", () => {
    const lexer = /function ConvertTo-PlainJsonText \{[\s\S]*?return \$plain\.ToString\(\)\s*\n\}/.exec(
      install,
    )?.[0] ?? "";
    for (const guard of [
      "$inString",
      "$inLine",
      "$inBlock",
      "$escaped",
      "if ($c -eq '\"')",
      "elseif ($c -eq '\"') { $inString = $false }",
    ]) {
      expect({ guard, present: lexer.includes(guard) }).toEqual({
        guard,
        present: true,
      });
    }
  });

  test("trailing commas are removed, or a valid JSONC reports UNPARSEABLE on PS 5.1", () => {
    // ConvertFrom-Json in Windows PowerShell 5.1 rejects a trailing comma, and
    // trailing commas are the norm in a hand-edited JSONC file.
    expect(install).toContain("$next -eq '}' -or $next -eq ']'");
    expect(install).toContain("'UNPARSEABLE'");
  });

  test("a malformed document is UNPARSEABLE rather than silently FALSE", () => {
    expect(install).toContain("return 'UNPARSEABLE'");
  });
});

describe("install.ps1 advice names the file OmO actually reads", () => {
  test("the advice block points at the omo config, not the opencode config", () => {
    expect(install).toContain(
      'Write-Line \'[install]     "[opencode]": { "tmux": { "enabled": true } }\'',
    );
    expect(install).not.toContain('Write-Line \'[install]     "tmux": { "enabled": true }\'');
    expect(install).toContain("This key belongs to OmO, not to opencode");
  });

  test("it states the real resolution rules instead of asserting omo.jsonc", () => {
    expect(install).toContain("omo.jsonc when it exists, else omo.json");
    expect(install).toContain("index.js:21410-21426");
    // The merged-layer caveat: a project config can enable tmux while the user
    // file says false, so a FAIL here is not proof about the effective config.
    expect(install).toContain("merges");
    expect(install).toContain("project layers and a profile block");
  });

  test("it still reports rather than writes", () => {
    expect(install).toContain("# Reported, never written, and the refusal to write it is deliberate.");
  });
});

describe("the native probe extracts functions instead of running the installer", () => {
  test("it pulls named functions out of the AST", () => {
    expect(probe).toContain(
      "[System.Management.Automation.Language.FunctionDefinitionAst]",
    );
    expect(probe).toContain("Parser]::ParseFile");
    expect(probe).toContain("Get-TrustedFunctions");
  });

  test("it asserts each function was found, so an empty extraction cannot pass", () => {
    expect(probe).toContain(
      "throw ('expected exactly one function named ' + $want + ', found ' + $hit.Count)",
    );
    expect(probe).toContain(
      "Assert -Ok ($installFns.Count -eq 3) -Name 'install.ps1: the three config functions were found by AST extraction'",
    );
    // The extraction must be proven live, not just counted: a dot-source done
    // inside the helper function would be lost with that function's scope.
    expect(probe).toContain(
      "the extracted functions are callable in this scope",
    );
  });

  test("it compiles ONLY those definitions, so no PATH write exists as code", () => {
    expect(probe).toContain("Only these definitions become code");
    expect(probe).toContain(". ([scriptblock]::Create($installFns.Source))");
    // And it proves the run left the machine alone.
    expect(probe).toContain("the user PATH was never written by this probe");
    expect(probe).toContain("the live omo config was not written");
  });

  test("it covers HOME precedence, the json fallback and the comment decoy", () => {
    for (const label of [
      "HOME wins over USERPROFILE",
      "omo.json is read when omo.jsonc is absent",
      "omo.jsonc wins when both exist",
      "neither file exists -> expected omo.jsonc path is reported",
      "HOME unset -> USERPROFILE is used",
      "this host collapses an empty process env var to UNSET, so `??` on an empty HOME is unreachable here",
      "an unset HOME falls through to USERPROFILE",
      "a COMMENTED-OUT setting is not a true setting",
      "a block comment decoy is not a true setting either",
      "the string \"true\" is not the boolean the loader reads",
      "trailing commas and comments still parse",
      "a top-level tmux block that is NOT under [opencode] is not read",
    ]) {
      expect({ label, covered: probe.includes(label) }).toEqual({
        label,
        covered: true,
      });
    }
  });
});

describe("install.ps1 byte invariants", () => {
  test("pure ASCII, LF only", () => {
    const bytes = readFileSync(`${ROOT}scripts/windows/bin/install.ps1`);
    const offenders: string[] = [];
    bytes.forEach((b, i) => {
      if (b > 127) offenders.push(`0x${b.toString(16)}@${i}`);
    });
    expect({ offenders: offenders.slice(0, 5) }).toEqual({ offenders: [] });
    expect(bytes.includes(0x0d)).toBe(false);
  });
});