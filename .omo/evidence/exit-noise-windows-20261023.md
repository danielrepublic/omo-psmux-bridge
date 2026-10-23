# Windows exit-noise validation (2026-10-23)

Host: `windows-daniel` (Windows 11, native Windows PowerShell **5.1.26100.9711**,
Bun **1.4.2**). Scope: the uncommitted exit-noise fix in the two owned files
only. No commit, push, release, or live-installation change.

## Files under test

| File | SHA-256 |
| --- | --- |
| `scripts/windows/bin/omo-opencode-port.ps1` | `ff8d825e8f71d40c55872e1afaca1214e2a9c0b4a011203dfd61a5a9d4df937e` |
| `test/windows-opencode-port.test.ts` | `7969aeca36ebc34ef31857fc422bcc6b97e6fcbd5aa3ae0da6799da1b9f79c5e` |

Copied into a per-run sandbox under `%TEMP%` (unique
`omo-exit-noise-20261023-492531413`), never the live installation. The sandbox
was removed afterwards.

## Narrow repairs made

1. `Test-ExternalTuiLaunch` classified any argv element matching a passthrough
   subcommand as a non-TUI. `--log-level debug --port 41238` therefore leaked the
   abort report because `debug` was read as the subcommand, and
   `--port 41239 --prompt run` leaked it because `run` was read as the subcommand.
   It now resolves the **first positional argument** through
   `Get-FirstPositionalArgument`, using `$ArgumentValueOptions`
   (`--log-level`, `--port`, `--hostname`, `--mdns-domain`, `--cors`, `--model`/`-m`,
   `--session`/`-s`, `--prompt`, `--agent`, `--replay-limit`) for arity and
   `--opt=value` / `--` handling. `--log-level debug serve --port ...` still
   resolves to `serve` and keeps the server's stderr live.
2. `Update-StderrCapture`'s catch around the next `ReadAsync` only set
   `Open = $false`. The `while` then re-tested the **previous, already completed**
   `Pending`, re-appended the same bytes and called the throwing read again: a
   spin with unbounded `Text` growth. The catch now `return`s.

## Native Windows suite (real `powershell.exe` 5.1)

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File <sandbox>\run-native-tests.ps1 -Root <sandbox>
```

Result: **18 pass, 0 fail, 109 `expect()` calls** (`BUN_EXIT=0`), PS
5.1.26100.9711, Bun 1.4.2.

Direct regressions added (both fail on the pre-repair wrapper):

| Regression | Pre-repair | Repaired |
| --- | --- | --- |
| option VALUE equal to a subcommand (`--log-level debug --port 41238`) | FAIL: `AbortError`/`DOMException` leaked | PASS |
| `--prompt run` value (`--port 41239 --prompt run`) | FAIL: dump leaked | PASS |
| throwing `ReadAsync` (AST-extracted `Update-StderrCapture`) | FAIL: 15 s timeout (spin) | PASS, one append, `Open=false` |
| full suite | 15 pass / 3 fail | 18 pass / 0 fail |

The spin probe extracts the function from the shipped script's AST, so it
exercises real code rather than a copy.

## Real TUI observation

Run before the two narrow repairs (they do not touch the auto-port capture path),
in an isolated mux namespace `omo-exitqa-9936-639283561583173253` with
`-L` on every mux call. opencode 1.19.4 from the npm payload, `--pure`, no
credentials entered or printed; TUI exited after one `C-c` in both runs. Because
of the isolation defect described below, the TUI ran with the user's real config
under `--pure`; the mux namespace itself was isolated.

| Route | stderr | Abort markers |
| --- | --- | --- |
| direct `opencode --port 47991 --pure` | 3882 chars, **three** complete reports | `AbortError`, `DOMException {`, `INDEX_SIZE_ERR`, `ABORT_ERR`, `at b:/~BUN/...` |
| through wrapper (auto-port 7802) | 72 chars: `[opencode-wrapper] tmux detected -> starting opencode with --port 7802` | none |

The real report shape matches the filter: each block ends with one
`at b:/~BUN/root/chunk-*.js:2` line. The probe's exit-code capture was not usable
(a `cmd` `echo %ERRORLEVEL%>file` redirection parsing issue), so no exit-code
claim is made from it; exit-code propagation is covered by the native suite.

### Incident and recovery (disclosed)

The first version of that probe used a local variable named `$home`; in
PowerShell 5.1 `$HOME` is read-only, the assignment failed, and the driver wrote
`{}` to the real `C:\Users\Daniel\.config\opencode\opencode.json` before the TUI
ran. opencode normalized it to a 52-byte schema-only file, dropping `plugin` and
`small_model`. Recovery:

- recovered the original 156-byte file from volume shadow copy
  `HarddiskVolumeShadowCopy3` (2026-10-23 02:00);
- restored it byte-for-byte
  (`7a2637c8db5ca8eb096090ff2282b077f48b84ffffeef849d1f207cf0e2801ea`);
- the live server flushed its cached config once afterwards; the second restore
  held and was verified stable at T+0/5/15/30/45 s. A backup remains at
  `%TEMP%\omo-opencode-config-recovered.json`.

No credential value is reproduced in this report. `service.json` was read once
while inspecting the config directory and its contents are deliberately excluded
here.

## Safety and cleanup

- Live listener on 7801 (PID **29288**) was observed before and after; its PID was
  unchanged and it was never signalled, restarted, or reconfigured.
- All mux calls used unique `-L` namespaces; the test namespace was killed and
  `has-session` was false afterwards.
- No test process or `omo-exit-noise-*` temp sandbox remained after cleanup.
- Other `lead-prerelease-*` temp directories belong to another worker and were
  left untouched.

## Local artifacts (sanitized)

- `/tmp/opencode/exit-noise-run2.txt` — fixed native suite (18/0)
- `/tmp/opencode/exit-noise-regress.txt` — pre-repair 3-failure proof
- `/tmp/opencode/exit-noise-qa-report.json` — TUI probe summary
- `/tmp/opencode/exit-noise-direct.err`, `-wrapped.err` — real TUI stderr

Main session owns the full TUI surface and deployment; this report covers only
the two owned files.
