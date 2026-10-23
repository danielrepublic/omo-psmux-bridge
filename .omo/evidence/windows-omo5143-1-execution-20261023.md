# Windows OmO 5.1.43 + bridge v5.1.43-1 — execution evidence

Date: 2026-10-23. Host: `WINDOWS-DANIEL` (Windows 11, build 26300), user `daniel`,
Windows PowerShell 5.1.26100.9711, node v24.19.0. Linux build host: bun 1.4.4.
Machine-readable report: `.omo/evidence/omo5143-1-windows-smoke-report-20261023.json`
(sha256 `e4a490e443b5176248a50002e2ec57b6c329c1503d29574b6a7ccf80de392009`).

This record covers the bridge-side release. The OmO plugin was already at 5.1.43
before this run; the bridge pin was the drifted half.

---

## 1. Verdict

| Gate | Result |
| --- | --- |
| OmO contract retargeted 5.1.42 → **5.1.43** | **yes** — `contract:verify` 180 citations / 0 problems; 11/11 doctor anchors at identical lines; no `src/*.ts` change |
| Bridge version | **5.1.43-1** (`package.json`), release tag `v5.1.43-1` |
| Source gates (Linux) | **yes** — `bun test` 432 pass / 34 skip / 0 fail (2,273 expects); `bunx tsc --noEmit` exit 0; `contract:fetch` psmux at `66cf613` |
| Deployed to Windows | **yes** — local bun-1.4.4 build installed; all payload hashes recorded below |
| Installed doctor | **4/5, exit 30** with no OpenCode server (check 3 PORT only); check 5 PASS, `version-equality`, anchors 11/11 |
| Protocol smoke | **yes** — 35/35 assertions, 0 fail; `doctor-exit-0`, `doctor-anchors-11/11`, scoped cleanup |
| Published artifact equals deployed shim | **pending** — CI builds with bun 1.4.2; this section is updated after the release |

---

## 2. What changed upstream (5.1.42 → 5.1.43)

**No citation moved.** The 180 `CONTRACT.md` citations and all 11 doctor check-5
anchors resolve at the same line numbers and with the same text in the installed
5.1.43 bundle (188,535 lines). The `z50` alias and the `L156576` prefix are
unchanged. The bridge grammar region is byte-identical across the two releases,
so no `src/*.ts` behaviour change was needed or made.

Changes are pin and documentation only:

- `scripts/contract/pins.json` `omo.verifiedAgainst`: 5.1.42 → 5.1.43.
- `scripts/windows/bin/bridge-doctor.ps1` `$FrozenOmoVersion`: 5.1.42 → 5.1.43
  (plus the matching parameter comment).
- `CONTRACT.md` §0.1 and §14: version and the example PIN_DRIFT table.
- `INSTALL.md`: OmO 5.1.43 and the new runtime evidence link.
- `test/bridge-doctor.test.ts`, `test/install-config.test.ts`,
  `scripts/windows/harness/doctor-harness.ps1`: version comments and the pin
  expectation.
- `package.json`: bridge version 5.1.43-1 (first revision suffix on an OmO pin;
  the OmO version itself stays 5.1.43).

---

## 3. Deployment (local build, pre-release)

Built on Linux with bun 1.4.4
(`bun build --compile src/cli.ts --target=bun-windows-x64`), staged with the
release manifest, zipped, copied to the host, and installed from the extracted
payload with `bin\install.cmd`. The installer staged all ten payload files and
returned `RESULT=ALREADY_CORRECT` for PATH (the entry was already present);
`changed=no` refers to PATH, not to the files, which were replaced.

| File | Bytes | sha256 |
| --- | --- | --- |
| `bin\tmux.exe` (local build) | 115,320,320 | `A6634CD877138D3649908874B2522E4AE102DB712992759B13EBF9D034448F56` |
| `bin\bridge-doctor.ps1` | 56,980 | `5C38CE16F3A9FD8CCDA83972F96307C695C3A2B1FF0C6680F8D5DBAC70BE7AD3` |
| `bin\install.ps1` | 35,926 | `79D4F36CDABFA85B9494D260F5D780895C63B81D027C30F3C3DDA7BC9F89CA13` |
| `bin\install.cmd` | 6,422 | `5146A4CC6BBA61C420E402A185EDC4318833330678529C1A787F2830264C8613` |
| zip | 54,604,863 | `7546E66B2AFE119E7BA9773556F4734BCD00D81B7478963EE8DF5AE83F653E2A` |

Backup root: `C:\Users\Daniel\AppData\Local\Temp\omo5143-1-backup` (whole
installed tree, taken before staging). No PATH, machine-environment, psmux or
user-data change was made; the installer reported the machine PATH fingerprint
unchanged.

---

## 4. Verification runs

### 4.1 Installed doctor (no server)

```
contract_frozen_version=5.1.43
installed_version=5.1.43
verdict_basis=version-equality (equals the frozen version exactly)
anchors_requested=11  anchors_returned=11
frozen_line_anchors_resolved=11/11
RESULT: 4/5 checks PASS   failures=1
first_failing_check_code=30
exit=30
```

Check 3 fails only because this invocation had no `OPENCODE_PORT` and nothing
answered on the OmO fallback port 4096; checks 1, 2, 4 and 5 pass. The shim-hash
NOTE fired as designed (local build vs the historical default), and is never a
failure.

### 4.2 Protocol smoke — 35/35

`omo5143-1-windows-smoke-20261023.cjs`, one ssh lifetime, private
`-L omo-v5143-1-<rand>` namespace, its own `opencode serve` child. The committed
report is this run, against the **local bun-1.4.4 build**.

| Group | Checks |
| --- | --- |
| Version identity | `omo-package-5.1.43`, `opencode-version-1.19.4`, `mux-version-3.4.0` |
| Server / plugin | `serve-health-ok`, `serve-version-1.19.4`, `config-200`, `agent-plugin-loaded` (24 agents) |
| Session | `session-post-2xx`, `session-id-captured`, `session-seeded-without-model-call` |
| Multiplexer | `mux-new-session`, `mux-list-live-session`, `launcher-list-live-session` |
| Placeholder | `mux-split-placeholder-5143-1`, `pane-banner-marker`, `pane-hint`, `pane-no-interpolation`, `pane-no-side-effect` |
| Hostile text | `pane-hostile-apos`, `pane-hostile-hash-dollar`, `pane-hostile-backtick`, `pane-hostile-backslash` |
| Respawn | `mux-respawn-placeholder-5143-1`, `pane-respawn-banner`, `pane-respawn-meta` |
| Real attach | `mux-respawn-attach`, `pane-real-opencode-session` |
| Close / doctor | `mux-kill-pane`, `doctor-exit-0`, `doctor-anchors-11/11` |
| Cleanup | `cleanup-session-deleted` (HTTP 200), `cleanup-serve-child`, `cleanup-namespace-only` |

Non-gating observation, unchanged: GitHub issue #2 (PS 5.1 helper drops embedded
double quotes from the placeholder description).

### 4.3 Source gates (Linux)

| Run | Result |
| --- | --- |
| `bun run contract:fetch` | psmux tree already at `66cf61354c473b35d4f0c06c57384fc46d61ffdb` |
| `bun run contract:verify` | **checked 180 citations, found 0 problems** |
| `bunx tsc --noEmit` | exit 0 |
| `bun test` | 432 pass / 34 skip / **0 fail**, 2,273 `expect()` calls, 12 files |

---

## 5. Published-artifact replacement (pending)

CI builds the release with the pinned bun 1.4.2, so its `tmux.exe` will not be
byte-identical to the local 1.4.4 build above. After `v5.1.43-1` is published,
the host is switched to the binary inside
`opencode-psmux-bridge-v5.1.43-1-win-x64.zip`, the doctor and smoke are re-run,
and this section is replaced with the published hash and result.

---

## 6. Backup and rollback

| | |
| --- | --- |
| Backup root | `C:\Users\Daniel\AppData\Local\Temp\omo5143-1-backup` |
| Contents | the full pre-upgrade `%LOCALAPPDATA%\opencode-psmux-bridge` tree |

Rollback:

```powershell
Copy-Item "$env:TEMP\omo5143-1-backup\opencode-psmux-bridge\*" "$env:LOCALAPPDATA\opencode-psmux-bridge" -Recurse -Force
```

The previous 5.1.42 execution record remains at
`.omo/evidence/windows-omo5142-execution-20261023.md`.

---

## 7. Scope notes

- No PATH change, no machine-wide cleanup, no mass kill. psmux 3.4.0 and its
  sessions were not touched; no bare `kill-server` was issued.
- The smoke owns its session and namespace, deletes the session by its actual id,
  and removes only `-L omo-v5143-1-…`.
- No model call was made: the attach check seeds a context-only message with
  `noReply: true`.
- The version suffix is deliberate: `v5.1.43-1` is the first bridge revision
  pinned to OmO 5.1.43, not a new OmO version.
