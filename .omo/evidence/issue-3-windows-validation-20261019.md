# Issue #3: Windows installer MOTW repair

Date: 2026-10-19. Host: WINDOWS-DANIEL. Base: `a69e21c`.

## Scope and Byte Identity

Only `scripts/windows/bin/install.cmd` changed in the shipped payload. Recursion
now belongs to `Get-ChildItem -LiteralPath ... -Recurse -File`, whose output is
piped to `Unblock-File`. Both commands keep `-ErrorAction SilentlyContinue`.
The enumeration root remains `BRIDGE_BIN`; this change does not broaden the
operation to sibling directories. The wrapper remains ASCII with CRLF endings.

| Artifact | SHA-256 |
| --- | --- |
| Original wrapper, repository and installed baseline | `1bd67f755c52c90912a3b396bc8faa16495eb0c0a2e93c4c5c8139f16b865f2d` |
| Fixed wrapper, source, staged copy and installed copy | `5146a4cc6bba61c420e402a185edc4318833330678529c1a787f2830264c8613` |
| Unchanged installed `bin/tmux.exe` | `994875a97663ac4fe8a26a0bae11fa904b3ed16bed580929aebcbd92fcd8b513` |
| Unchanged installed `runtime/Start-PaneFromDescriptor.ps1` | `564e218b73350270c5dbe0fdb099913ce960ec48b4198c538e3fa74275b6e034` |

## Local Gates

| Command | Result |
| --- | --- |
| `bun test test/windows-scripts.test.ts` before the production fix, with the new regression tests | 30 pass, 2 fail; missing `Get-ChildItem` and invalid `Unblock-File -Recurse` detected |
| Same command after the fix | 32 pass, 0 fail |
| `bun test test/windows-scripts.test.ts test/install-config.test.ts` | 52 pass, 0 fail |
| `bun test` | 431 pass, 34 Windows-only skips, 0 fail; 2253 assertions |
| `bun x tsc --noEmit` | Exit 0 |
| `bun run build:win` | Exit 0; compiled binary was NOT deployed |

TypeScript diagnostics had no errors or warnings; the existing import-order
information at line 42 was unchanged. No `.cmd` or `.ps1` LSP was configured;
the actual Windows executions below provide the behavioral verification.

## Real Windows Fixture QA

The lead executed a fixture-only driver through `ssh windows-daniel`. It copied
the actual old/new wrapper into temporary directories containing spaces and
brackets, beside an inert `install.ps1` that recorded argv/cwd and returned a
configured exit code. Fixture files received real NTFS `Zone.Identifier` streams.
No production installer, registry write or psmux command ran in these fixtures.

Driver: `/tmp/opencode/issue3-qa.ps1`, SHA-256
`c9dc10c0844121a790b96117e216eeaa9d622a9c16c9f17e069748c255837f16`.
Invocation on Windows, with absolute paths to the two staged wrappers:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File issue3-qa.ps1 -WorkRoot C:\Users\Daniel\AppData\Local\Temp\omo-issue3-qa-20261019-r2 -BrokenCmd C:\Users\Daniel\issue3-broken.cmd -FixedCmd C:\Users\Daniel\issue3-fixed.cmd
pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File issue3-qa.ps1 -WorkRoot C:\Users\Daniel\AppData\Local\Temp\omo-issue3-qa7-20261019-r2 -BrokenCmd C:\Users\Daniel\issue3-broken.cmd -FixedCmd C:\Users\Daniel\issue3-fixed.cmd
```

Both reports had `pass=true`, `failedCount=0`, **27/27 checks PASS**.
Parent hosts: Windows PowerShell **5.1.26100.9711** and PowerShell **7.6.7**.
The wrapper itself deliberately resolves Windows PowerShell 5.1 in both runs;
the second invocation additionally exercises the pwsh-to-5.1 module-path repair.

| Scenario | Observed in both runs |
| --- | --- |
| Old wrapper control | Exit 0, `NamedParameterNotFound` for `Recurse`; both root and nested MOTW streams remain |
| New wrapper with marked files | Both streams proven present first, then absent; exit 0 and empty stderr |
| Content preservation | Root/nested files, companion script and wrapper SHA-256 unchanged by unblocking |
| Adjacent launcher behavior | `alpha beta` arrives as `alpha|beta`; cwd remains `C:\Users\Daniel` |
| Repeat with no marks | Exit 0, empty stderr |
| Companion returns 2 or 69 | Exact exit code propagated |
| Missing companion script | Exit 127 |

Initial fixture-driver runs failed before executing the wrapper because
`Start-Process` redirect paths treated brackets as wildcards. Redirect logs were
moved outside bracketed directories and the full matrix rerun successfully.
Those initial failures are not counted as successful QA. SSH exit status alone
was not used as evidence: the JSON check results were retrieved and inspected.
Final raw reports were retrieved to `/tmp/opencode/issue3-qa-report-r2.json` and
`/tmp/opencode/issue3-qa7-report-r2.json` during this session.

## Deployment and Real Installer Run

After the fixture gates passed, copied only the verified wrapper into
`%LOCALAPPDATA%\opencode-psmux-bridge\bin\install.cmd`, retaining its original
copy in the task's scratch directory until verification completed. Baseline and
staged SHA-256 guards ran before the copy. No release asset or tag was changed.

Ran the installed `install.cmd` with its real companion installer, from its
already-installed directory. The deployment driver reported **11/11 PASS**:

```text
installed-wrapper-hash: True
only-wrapper-content-changed: True
installer-exit-zero: True
installer-self-copy-skipped: True
installer-already-correct: True
shim-version-smoke-pass: True
no-recurse-binding-error: True
stderr-empty: True
user-path-unchanged: True
machine-path-unchanged: True
psmux-process-ids-unchanged: True
FAILED_COUNT=0
```

The installer printed `stage_skipped=already_installed_at_target`,
`RESULT=ALREADY_CORRECT`, `changed=no`, `smoke_result=PASS`, and
`tmux 3.4.0 / psmux 3.4.0 (20aa1d7 2026-10-13)`. Stderr was empty.
All 10 top-level payload files in `bin` and `runtime` were hashed before/after;
the only content difference was `bin\install.cmd`. User and machine PATH hashes
were unchanged, as were the sole psmux process and its PID (**6916**).
No session was created, killed or restarted.

Deployment driver: `/tmp/opencode/issue3-deploy.ps1`, SHA-256
`3409c4b9e86e6802aa7fe99c82b4d214e6ddaf4d65865ed89040752e8151b97d`.
Raw deployment report was retrieved to
`/tmp/opencode/issue3-deployment-report.json` during this session.

Final gate review: APPROVE after correcting the single-file test counts above
and rerunning that file (32 pass, 0 fail). Task-owned Windows scratch directories,
drivers and staged wrappers were removed; cleanup reported
`TASK_FILES_REMAINING=0` and reconfirmed the fixed installed wrapper hash.

This is a source fix plus a single-host hotfix, not a new published release.
The existing v0.3.0 download still contains its original wrapper until a future
release ships this change.
