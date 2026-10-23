# Windows OpenCode integrity inspection: read-only evidence

Date: 2026-10-23, approximately 11:14-11:26 Asia/Taipei (+08:00). Host:
`WINDOWS-DANIEL`, user `daniel`, PowerShell 7.6.7 reached over SSH. Repo corroboration:
`/home/daniel/omo-psmux-bridge` at commit `0b535dc`, working tree clean.

This was an **inspection only**: no repair, no update, no restart, no config edit, no model call, and no
Bridge wrapper or Bridge doctor execution. Every remote command was a read cmdlet, and the single network
request was one `GET /global/health` against an already-running listener.

---

## 1. Verdict

| Area | Result |
| --- | --- |
| Core binary provenance | **PASS**: Authenticode valid, signer `Anomaly Innovations, Inc`, SHA-256 recorded, package and binary versions agree |
| CLI health | **PASS**: `--version` exit 0 in 1,964 ms printing `1.19.4`; `--help` exit 0 in 1,372 ms |
| Live server health | **PASS**: HTTP 200, `healthy=true`, `version:"1.19.4"` on the Bridge-reserved backend port |
| Global config parse | **PASS**: `opencode.json`, `tui.json`, `service.json`, `lsp-install-decisions.json` all parse |
| Config dependency install | **PASS**: 27 of 27 real package entries present, no missing dependency |
| OmO plugin assets | **PASS**: `oh-my-openagent` 5.1.43, `dist/index.js` 6,083,565 bytes, all four exports resolve |
| Skills assets | **PASS**: every counted skill directory carries a `SKILL.md`; no declared path left dangling |
| Database integrity | **PASS**: `integrity_check` returns `["ok"]`, `foreign_key_check` returns no rows, on-disk file unchanged |
| Bridge shim vs published artifact | **PASS**: deployed `bin\tmux.exe` hash equals the published `v5.1.42` asset hash |
| Bridge doctor baseline vs installed versions | **UNVERIFIED at inspection**: doctor not executed. Source-determined outcome at 5.1.43/5.1.42 is exit 50 (see §3 item 4); resolved in §7 |

---

## 2. Fact sheet

### 2.1 Core runtime

| Item | Value |
| --- | --- |
| Resolved real binary | `C:\Users\Daniel\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe` |
| Size / mtime | 211,699,592 bytes, 2026-10-23T04:53:47+08:00 |
| SHA-256 | `41C848C0986720C02D39B015BD2672E454A221052F6947854BC508D8765D9711` |
| Authenticode | Valid; signer `CN="Anomaly Innovations, Inc https://anoma.ly/"`; issuer `CN=Microsoft ID Verified CS AOC CA 04`; countersigned by Microsoft Public RSA Time Stamping Authority |

Packages are `opencode-ai` 1.19.4, `opencode-windows-x64` 1.19.4 and `opencode-windows-x64-baseline` 1.19.4.
The `bin` copy hash equals the non-baseline package binary, so the baseline variant is present but unused. PE
`FileVersion` reads `1.4.4` on the binary and `1.4.2` on the Bridge Shim; both are Bun compile-time metadata
(`CompanyName` Oven, `ProductName` Bun), not application versions, so they are not a mismatch. CLI probes ran
directly against the exe, bypassing the Shim.

### 2.2 Live server

- Process `opencode.exe` PID 5984 listening on `127.0.0.1:7801`, `62223`, `62235`.
- `GET http://127.0.0.1:7801/global/health` returned HTTP 200 with `healthy=true`,
  `version:"1.19.4"`. Port 7801 is the port the Bridge reserves for the Backend; port
  4096 (the OmO fallback) was not listening, and `OPENCODE_PORT` was unset.
- Ancestry observed as `opencode.exe` <- `powershell.exe` (5.1) <- `cmd.exe` <- `pwsh`
  <- `psmux.exe` <- `psmux server`: the documented wrapper design working as intended.
  OmO asks for a pane, the Shim answers, the Pane Descriptor carries the pane start
  command, and the Backend hosts it.

### 2.3 Global configuration and plugin

Scope: `C:\Users\Daniel\.config\opencode`. `opencode.json` is 149 bytes, valid JSON, with top-level keys exactly
`$schema`, `plugin`, `small_model`. `plugin` is `["oh-my-openagent@latest"]`; `small_model` is
`opencode-go/muse-spark-1.3-contributor`; there is no `model` key and no `mcp` key. `package.json` declares
`@opencode-ai/plugin` 1.19.0, installed at the same version. `package-lock.json` lists 28 package entries
including the root, and all 27 real package directories exist on disk, so no dependency is missing. `tui.json`
is valid with the same plugin spec; `lsp-install-decisions.json` is valid and `bash` is declined. `service.json`
parses but holds credential-bearing keys: contents were not read, not quoted, and are out of scope.

Cache plugin install root: `C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest`, installed version
5.1.43. `dist/index.js` is 6,083,565 bytes; `dist/tui.js`, `dist/oh-my-opencode.schema.json`,
`dist/cli/index.js` and `dist/cli-node/index.js` are all present; exports `.`, `./server`, `./tui`,
`./schema.json` resolve; runtime deps are `@opentui/solid` 0.5.17, `detect-libc` 2.1.2 and `zod` 4.6.7. The
platform package ships a JS launcher (`bin/oh-my-opencode.js`) that runs `dist/cli/index.js` under bun and falls
back to `dist/cli-node/index.js` under node; it is not supposed to contain a native `.exe`, so the absence of
one is not a defect.

Skills inventory: 2 in the cache (`security-research`, `security-review`), 4 under the plugin's
`.opencode/skills`, 18 under plugin `dist/skills`, 13 under `.agents/skills`. Every one carries a `SKILL.md`,
and the config declares no skills paths, so no reference is left dangling. With no `mcp` key there is no
user-declared local MCP command to verify; plugin-internal entry points exist at `lsp-tools-mcp/dist/cli.js`,
`lsp-daemon/dist/cli.js` and `git-bash-mcp/dist/cli.js`, and none were launched. Cache utilities: `bin/rg.exe`
4,266,496 bytes; `models.json` parses, mtime 2026-10-23T11:12.

### 2.4 Storage

Scope: `C:\Users\Daniel\.local\share\opencode`.

- `auth.json` parses, 4 provider entries, contents not read.
- `opencode.db` 249,856 bytes, no `-wal` file present. Integrity was checked by reading the file into memory,
  forcing a rollback-journal header in the in-memory copy, deserializing with `sqlite3`, then `PRAGMA
  integrity_check` -> `["ok"]` and `PRAGMA foreign_key_check` -> no rows. The on-disk file was byte-identical
  before and after (mtime and size unchanged); no journal or WAL file was created.
- `log/opencode.log` 6,993 bytes, 53 lines, 5 runs: INFO 48, ERROR 2, WARN 3. The two errors are `models.dev`
  fetch failures; the three warnings are remote MCP servers unavailable (`websearch`, `grep_app`, `context7`).
  There are no config-parse, plugin-load or skill-path errors, and also no plugin-load success lines, which is
  why dynamic OmO activation stays UNVERIFIED rather than PASS.

### 2.5 Bridge deployment

Scope: `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge`, which contains `bin`, `runtime`, `state` and
`INSTALL.md` only. HKCU user PATH entry #1 is the Bridge `bin` directory, so it shadows `tmux`, `psmux` and
`opencode`. Repo live state showed 2,185 Shim calls, last write 11:21:31, with 2,148 pass-through, 18
attach-respawn, 18 placeholder-split and 45 deliberate suppressions (35 `resize-pane`, 10 `set-option`). Only
12 non-zero exits, all benign pass-through cases (10 `kill-pane`, 2 `list-panes`). No credential-shaped
fields, `envSlotCount` 0.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `bin\tmux.exe` | 86,135,808 | `994875A97663AC4FE8A26A0BAE11FA904B3ED16BED580929AEBCBD92FCD8B513` |
| `bin\bridge-doctor.ps1` | 56,980 | `f788923e98ec5388e9f3476f29fd346e37b4a388cc289f2786590a7ff7edf9c8` |
| `bin\install.ps1` | 35,926 | `79d4f36cdabfa85b9494d260f5d780895c63b81d027c30f3c3dda7bc9f89ca13` |

The `tmux.exe` hash equals the hash recorded for the published `v5.1.42` release asset in
`.omo/evidence/windows-omo5142-execution-20261023.md` section 3, so the deployed Shim matches the published
artifact. Both PowerShell scripts are identical to the repo files at `scripts/windows/bin/`. Backend:
`C:\Users\Daniel\AppData\Local\psmux\psmux.exe`, 9,907,824 bytes, reports 3.4.0.

---

## 3. Observed drift

Seven differences between the installed surface and the repo were recorded. All are
pre-existing, and none is classified as damage.

1. **Deployed `INSTALL.md` predates the 5.1.42 retarget.** It is 9,327 bytes dated 2026-10-19 and cites
   OpenCode 1.19.3 and OmO 5.1.35, linking `.omo/evidence/windows-update-runtime-20261019.json`. The repo
   `INSTALL.md` is 9,333 bytes and states 1.19.4, 5.1.42 and psmux 3.4.0. Reference lives at repo
   `INSTALL.md`. Only the deployed copy is stale, and a stale document is not file damage.
2. **Deployed relative links cannot resolve on the host.** `CONTRACT.md` and
   `.omo/evidence/...` point outside the installed set, which holds only `bin`,
   `runtime`, `state` and `INSTALL.md`. Both `CONTRACT.md` and every referenced evidence
   file exist in the repo, so this is a packaging and scope boundary, not missing
   evidence.
3. **The doctor's default `ExpectedShimSha256` predates the shipped Shim.** The value is
   `9EA5E733FD78F4EA966A85A5CF062D1113C644FEFF80AD3B3084574c2BA2A858` (`scripts/windows/bin/bridge-doctor.ps1`
   line 126), belonging to an older 86,110,208-byte Shim. The old identity survives in
   `test/bridge-doctor.test.ts:528` only as a **negative** assertion (the test requires
   that hash to be absent from the doctor harness) and in
   `scripts/windows/pty/conpty-driver.ps1:908` as the task-16-era fixture hash; neither
   is a live expectation. The shipped 5.1.42 asset is `994875A9…` at 86,135,808 bytes,
   so the hash NOTE fires on a correct 5.1.42 install. The doctor's own documentation
   (lines 77-79) states this NOTE is never a failure because the Shim is rebuilt during
   development. **This item supersedes any earlier reading of that hash mismatch as
   corruption.**
4. **Frozen OmO version is one patch behind the runtime plugin.** `FrozenOmoVersion` is
   5.1.42 (`bridge-doctor.ps1` line 127, `scripts/contract/pins.json`
   `omo.verifiedAgainst`, `package.json` version 5.1.42) while the installed plugin is
   5.1.43. This is not a NOTE: with `KnownEquivalentOmoVersions` empty, `versionKnown`
   stays false and check 5 deterministically reaches the FAIL branch and appends exit
   code 50 (`bridge-doctor.ps1:1021-1045`), regardless of anchor results. `CONTRACT.md`
   section 0.1 classifies this version drift as routine `PIN_DRIFT`, so it is not
   damage; the open question was whether the line anchors still resolve (§7 settles it).
5. **The plugin spec is unpinned.** `oh-my-openagent@latest` is a mutable specifier. It
   currently resolves to 5.1.43 and the cache lock agrees, so the recorded state is
   reproducible only until the next publish. This is a property of the specifier, not a
   present defect.
6. **The runtime log records network and topology failures.** Two `models.dev` fetch
   failures and three unavailable remote MCP servers (`websearch`, `grep_app`,
   `context7`). These are runtime network and topology events and say nothing about file
   integrity.
7. **The psmux pin is behind the installed backend.** `scripts/contract/pins.json` pins
   psmux `v3.3.8` (commit `66cf613`) and `CONTRACT.md` cites only that tag, while the host
   runs psmux 3.4.0. `INSTALL.md:12` already discloses this ("pins psmux 3.3.8; the newer
   runtime smoke does not retire its workarounds"), so it is a known, deliberate gap
   rather than a defect.

---

## 4. What this does not establish

Dynamic OmO plugin activation in a live TUI (the log shows neither success nor failure lines for plugin load);
pane split, attach or respawn (none occurred here); MCP server spawn (no entry point was launched, so neither
startup nor handshake is observed); any model or provider call (none was made); full interactive parity
(file-level and process-level agreement is not a behavioural claim); and the doctor's exit status, since it was
never executed, leaving the baseline-versus-installed comparison UNVERIFIED.

---

## 5. Method

SSH to the host alias. Every remote command ran in PowerShell 7 with `-NoProfile` and `-NonInteractive`, and
only read cmdlets were used: `Get-ChildItem`, `Get-Content`, `ConvertFrom-Json`, `Test-Path`, `Get-FileHash`,
`Get-AuthenticodeSignature`, `Get-Process`, `Get-CimInstance`, `Get-NetTCPConnection`. One `GET
/global/health` went to the already-running listener. The SQLite check deserialized an in-memory copy into
`:memory:`, taking no file lock and creating no WAL file. Nothing was written to the host.

---

## 6. Files and artifacts referenced

| Inspected host path | Corroborating repo path |
| --- | --- |
| `...\npm\node_modules\opencode-ai\bin\opencode.exe` | `INSTALL.md`; `.omo/evidence/windows-omo5142-execution-20261023.md` |
| `C:\Users\Daniel\.config\opencode\opencode.json` | `INSTALL.md`; `scripts/contract/pins.json` |
| `C:\Users\Daniel\.config\opencode\package-lock.json` | none (runtime-only artifact) |
| `...\.cache\opencode\packages\oh-my-openagent@latest\dist\index.js` | `scripts/contract/pins.json` (`omo.verifiedAgainst`) |
| `C:\Users\Daniel\.local\share\opencode\opencode.db` | none (user data) |
| `C:\Users\Daniel\.local\share\opencode\log\opencode.log` | none (runtime log) |
| `...\opencode-psmux-bridge\bin\tmux.exe` | `.omo/evidence/windows-omo5142-execution-20261023.md` section 3 |
| `...\opencode-psmux-bridge\bin\bridge-doctor.ps1`, `bin\install.ps1` | `scripts/windows/bin/bridge-doctor.ps1`, `scripts/windows/bin/install.ps1` |
| `...\opencode-psmux-bridge\INSTALL.md` | `INSTALL.md` |
| `C:\Users\Daniel\AppData\Local\psmux\psmux.exe` | `INSTALL.md` (psmux 3.4.0) |

---

## 7. Post-inspection resolution

Recorded after the inspection; the inspection itself wrote nothing to the host.

- All 11 doctor check-5 anchors resolve at the same line numbers and text in the installed
  5.1.43 bundle (188,535 lines; the `z50` alias is unchanged; the `L156576` prefix still
  matches).
- `bun run contract:verify` with `omo.verifiedAgainst` retargeted at 5.1.43 reports
  **180 citations, 0 problems**.
- The pin was therefore bumped to 5.1.43 and the bridge released as `v5.1.43-1`; the
  execution record is `.omo/evidence/windows-omo5143-1-execution-20261023.md`.
- `ExpectedShimSha256` was left unchanged: the shim is rebuilt for every release, and the
  doctor defines a mismatch there as a NOTE, never a failure. It is not a correctness gate.
