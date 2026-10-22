# Windows OmO 5.1.42 upgrade + bridge retarget — execution evidence

Date: 2026-10-23. Host: `WINDOWS-DANIEL` (Windows 11, build 26300), user `daniel`,
Windows PowerShell 5.1.26100.9711, node v24.19.0, Bun 1.4.2.
Machine-readable report: `.omo/evidence/omo5142-windows-smoke-report-20261023.json`
(sha256 `94a9a2fd63fc7c72044fc8954d65c295e67b94a40dee43a49a78d91fbf6579b6`).

---

## 1. Verdict

| Gate | Result |
| --- | --- |
| opencode updated 1.19.3 → **1.19.4** | **yes** — npm global `opencode-ai@1.19.4`; `opencode.exe --version` = `1.19.4`; `/global/health` reports `version:"1.19.4"` |
| OmO plugin updated 5.1.40 → **5.1.42** | **yes** — installed `package.json` version `5.1.42`; bundle 6 083 565 B; `GET /agent` returns 24 agents with a `/^Sisyphus/` match |
| Bridge retargeted at 5.1.42 | **yes** — doctor `contract_frozen_version=5.1.42`, `installed_version=5.1.42`, `verdict_basis=version-equality`, `frozen_line_anchors_resolved=11/11` |
| Deployed files match the published artifact | **yes** — `bridge-doctor.ps1` and `install.ps1` equal their repo/HEAD bytes; `tmux.exe` equals the `v5.1.42` release asset (CI-built with bun 1.4.2) |
| Protocol smoke | **yes** — 35/35 assertions pass, 0 fail (split, placeholder, hostile chars, respawn, real attach, close, doctor, scoped cleanup) |
| Source gates (Linux) | **yes** — `bun test` 432 pass / 34 skip / **0 fail**; `bunx tsc --noEmit` exit 0; `contract:verify` **180 citations / 0 problems** |
| User data preserved | **yes** — psmux 3.4.0 and its sessions untouched; `.omo/omo.jsonc`, `opencode.json`, `auth.json`, `opencode.db` untouched; no PATH change |

The installed bridge-doctor exits **30** when run with no OpenCode server, which is
check 3 (PORT) and is correct: nothing is listening on the OmO fallback port. Checks
1, 2, 4 and 5 pass. The smoke run starts its own server and supplies
`OPENCODE_PORT`, and under that condition the doctor exits **0**.

---

## 2. What actually changed upstream (5.1.40 → 5.1.42)

The tmux grammar region the bridge implements is **byte-identical** between the two
bundles: every template, verb, `-e` auth argument, layout command and gate resolves
verbatim. No `src/*.ts` behaviour change was needed or made.

Six `CONTRACT.md` citations and three of the doctor's eleven check-5 anchors moved by
a uniform **+78** lines, plus two zod-alias renames:

| Old (5.1.40) | New (5.1.42) |
| --- | --- |
| `index.js:88956` `var TeamModeConfigSchema = z45.object({` | `index.js:89034` `... z46 ...` |
| `index.js:88958` `tmux_visualization: z45.boolean().default(false),` | `index.js:89036` `... z46 ...` |
| `index.js:89029` `var TmuxConfigSchema = z49.object({` | `index.js:89107` `... z50 ...` |
| `index.js:89030` `enabled: z49.boolean().default(false),` | `index.js:89108` `... z50 ...` |
| `index.js:156488` `function resolveServerUrl(rawServerUrl, env, log) {` | `index.js:156566` |
| `index.js:156498` `ctx.serverUrl has port 0; falling back.` | `index.js:156576` |

Comment-only citations in `bridge-doctor.ps1`, `install.ps1`, `doctor-harness.ps1`
and `test/install-config.test.ts` were moved by the same map:

| Old | New |
| --- | --- |
| `86041-86057` / `86042` / `86051` / `86053` / `86054` / `86056` / `86057` | `86113-86129` / `86114` / `86123` / `86125` / `86126` / `86128` / `86129` |
| `86112` (resolveOmoConfigPaths) | `86184` |
| `88313-88327` (loadOmoOpenCodeConfigChain) | `88391-88405` |
| `88324-88327` (appendViews) | `88402-88405` |
| `141307-141308` (isTmuxIntegrationEnabled) | `141385-141386` |

`scripts/contract/pins.json` `omo.verifiedAgainst` is now `5.1.42`, and
`package.json` `version` follows it: `5.1.42` (was `0.3.1`).

---

## 3. Deployment

Built on Linux with `bun build --compile src/cli.ts --target=bun-windows-x64`
(output begins with the `MZ` signature) and deployed into
`%LOCALAPPDATA%\opencode-psmux-bridge\bin`.

| File | sha256 | Bytes |
| --- | --- | --- |
| `bin\tmux.exe` | `994875A97663AC4FE8A26A0BAE11FA904B3ED16BED580929AEBCBD92FCD8B513` | 86 135 808 |
| `bin\bridge-doctor.ps1` | `F788923E98EC5388E9F3476F29FD346E37B4A388CC289F2786590A7FF7EDF9C8` | 56 980 |
| `bin\install.ps1` | `79D4F36CDABFA85B9494D260F5D780895C63B81D027C30F3C3DDA7BC9F89CA13` | 35 926 |

`bin\tmux.exe` is the binary shipped inside
`opencode-psmux-bridge-v5.1.42-win-x64.zip`, cross-compiled by `release.yml` with
the pinned **bun 1.4.2**. A local build with bun 1.4.3 (96 429 056 B,
`4E94E1DF…`) was installed first and passed the smoke; it was then replaced by the
published 1.4.2 artifact and the smoke was re-run against that binary (35/35 again),
so the host now runs exactly what a user downloads. `bin\install.cmd` (the
Mark-of-the-Web hotfix, `5146A4CC…`) was not touched. The other installed payload
files already matched the repo and were not touched.

---

## 4. Verification runs

### 4.1 Protocol smoke — 35/35

`omo5142-windows-smoke-20261023.cjs`, one ssh lifetime, private `-L omo-v5142-<rand>`
namespace, its own `opencode serve` child. The committed report is the run against
the **published v5.1.42 `tmux.exe`** (`994875A9…`); the same 35 assertions also
passed against the earlier local bun-1.4.3 build.

| Group | Checks |
| --- | --- |
| Version identity | `omo-package-5.1.42`, `opencode-version-1.19.4`, `mux-version-3.4.0` |
| Server / plugin | `serve-health-ok`, `serve-version-1.19.4`, `config-200`, `agent-plugin-loaded` (24 agents) |
| Session | `session-post-2xx`, `session-id-captured`, `session-seeded-without-model-call` |
| Multiplexer | `mux-new-session`, `mux-list-live-session`, `launcher-list-live-session` |
| Placeholder | `mux-split-placeholder-5142`, `pane-banner-marker`, `pane-hint`, `pane-no-interpolation`, `pane-no-side-effect` |
| Hostile text | `pane-hostile-apos`, `pane-hostile-hash-dollar`, `pane-hostile-backtick`, `pane-hostile-backslash` |
| Respawn | `mux-respawn-placeholder-5142`, `pane-respawn-banner`, `pane-respawn-meta` |
| Real attach | `mux-respawn-attach`, `pane-real-opencode-session` |
| Close / doctor | `mux-kill-pane`, `doctor-exit-0`, `doctor-anchors-11/11` |
| Cleanup | `cleanup-session-deleted` (HTTP 200), `cleanup-serve-child`, `cleanup-namespace-only` |

Non-gating observation, unchanged: GitHub issue #2 — the PS 5.1 helper drops embedded
double quotes from the placeholder description. The smoke records it and does not gate
on it.

### 4.2 Installed doctor

```
contract_frozen_version=5.1.42
installed_version=5.1.42
verdict_basis=version-equality (equals the frozen version exactly)
anchors_requested=11  anchors_returned=11
frozen_line_anchors_resolved=11/11
RESULT: 4/5 checks PASS   failures=1
first_failing_check_code=30
exit=30
```

Check 3 (PORT) is the only failure, because this invocation had no OpenCode server
running. In the smoke run, where `OPENCODE_PORT` was supplied, `doctor-exit-0` passed.

### 4.3 Source gates (Linux)

| Run | Result |
| --- | --- |
| `bun test` | 432 pass / 34 skip / **0 fail**, 2 273 `expect()` calls, 12 files |
| `bunx tsc --noEmit` | exit 0 |
| `HOME=/tmp/opencode/verifyhome bun run contract:verify` | **checked 180 citations, found 0 problems** |

`verifyhome` holds the npm 5.1.42 tarball at the pinned `@latest` path, so the
citation check ran against the exact bundle the release is retargeted at.

---

## 5. Backup and rollback

| | |
| --- | --- |
| Backup root | `C:\Users\Daniel\AppData\Local\Temp\omo5142-backup` |
| Files | 158 |
| Old doctor | `426C8D3183AD5D0806F6ED0DCE221ABA0516538562C4559890CA2F3116FF3269` |
| Old install.ps1 | `109D0AC465047009437BC64B625769da492f433316c21a1a2a6d060a36d80fd3` |

Rollback:

```powershell
Copy-Item "$env:TEMP\omo5142-backup\*" "$env:LOCALAPPDATA\opencode-psmux-bridge" -Recurse -Force
```

The previous protocol smoke, `.omo/evidence/windows-omo5140-lead-smoke-20261021T044345Z.json`,
remains in the repository as the 5.1.40 baseline.

---

## 6. Scope notes

- No PATH change, no machine-wide cleanup, no mass kill. `psmux` 3.4.0 and its
  sessions were not touched; no bare `kill-server` was ever issued.
- The smoke owns its session and namespace, deletes the session by its actual id, and
  removes only `-L omo-v5142-…`.
- No model call was made: the attach check seeds a context-only message with
  `noReply: true`.
- The version scheme changed deliberately: the bridge version now follows the OmO
  version it is retargeted at (`5.1.42`), so the release tag is `v5.1.42`.
