# Windows OmO 5.1.40 upgrade + bridge deploy — execution evidence

Date: 2026-10-21. Host: `WINDOWS-DANIEL` (Windows 11, build 26300), user `daniel`.
Owner: `windows-deployer`, team `windows-omo-5140-upgrade-deploy`, task 3.
Machine-readable preflight/outcome: `/tmp/opencode/windows-omo5140-preflight.json`.

Source gate at execution time (lead-reported, Windows host): `bun test` 432 pass /
34 skip / 0 fail, `tsc` 0, contract 180 citations / 0 problems. The fresh Windows
cross-build `4e94e1df…` was staged from the **current working tree**, not
`git show HEAD`.

---

## 1. Verdict

| Gate | Result |
| --- | --- |
| Cache root actually removed and rebuilt | **yes** — `C:\Users\Daniel\.cache\opencode` deleted, then rebuilt by OpenCode's own plugin loader |
| Installed plugin is 5.1.40 | **yes** — `package.json` version `5.1.40`; `dist/index.js` sha256 `d3d603598b6f0a9ce5da8681d6f0aa680220fd8216b314cfcf20a7bb127b36fd`, 6 080 006 B (byte-identical to the npm tarball) |
| Plugin actually **loaded** at 5.1.40 | **yes** — a real `opencode serve` answered `GET /agent` with 24 agents including `/^Sisyphus/`, and the installed doctor reports `installed_version=5.1.40` with `frozen_line_anchors_resolved=11/11` |
| Installed files match build/source | **yes** — 3 files deployed, each installed sha256 == staged sha256 == repo working-tree sha256 |
| Backup + preservation evidence | **yes** — full old cache + deployed tree backed up and per-file double-hashed (see §2.2 for the two distinct file counts) with 0 mismatches, 0 errors; DB/auth/config/`.omo` memory unchanged |
| Runtime / doctor / team-layout validation | **yes** — protocol smoke 39/39, doctor harness 205/205/0 skip, team-layout 25/25, Windows `bun test` 491/0 |

Driver reports (all `ok=true`, 0 failing checks):
`cache-rebuild` 28/28 · `deploy` 23/23 · `smoke` 39/39 · `team-layout` 25/25.

---

## 2. What was executed, in order

### 2.1 Scoped closure of one stale OpenCode runtime process

The user's TUI was closed but the **OpenCode app server survived**: PID **3924**,
started `2026-10-20T21:33:18Z`, path
`C:\Users\Daniel\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`.
It held OmO 5.1.35 in memory, so the cache was live state.

Closed **by exact executable-path match** (`…\opencode-ai\bin\opencode.exe`),
never by name, so no unrelated `node`/`bun`/`codex` process could be caught:

```
STOPPED opencode pid=3924 start=2026-10-20T21:33:18Z path=…\opencode-ai\bin\opencode.exe
STOPPED_COUNT=1  SKIPPED_COUNT=0  OPENCODE_REMAINING=0  PSMUX_STILL_RUNNING=4
```

psmux was **not** touched: its 4 pids (11624, 18816, 22332, 43640) are identical
before and after, and the user's `default` session is still attached.

### 2.2 Backup (full old cache, verified)

`win-backup.ps1` → `C:\Users\Daniel\AppData\Local\Temp\omo5140-backup`

| | |
| --- | --- |
| Files **copied and hash-verified** | **8 970** = cache 8 875/8 875 + deployed bridge 95/95 |
| Files **on disk** in the backup root afterwards | **8 972** = the 8 970 above, **plus** `backup-manifest.json` and `state\plugin-meta.json` |
| Hash mismatches | **0** |
| Errors | **0** |
| Cache size | 126.34 MiB (8 875 files) |
| Deployed bridge size | 90 061 912 B (95 files) |
| Old plugin bundle | `886b7a3cb275609649ab5083670d87fe66c4c1248dfa801d83963f187f824930` — **backup copy matches** |
| Old shim | `994875a97663ac4fe8a26a0bae11fa904b3ed16bed580929aebcbd92fcd8b513` — preserved in `bridge\bin\tmux.exe` |
| Cached skills | 2 files, both hashed and matched (`d14aebff…`, `1c5b5bb8…`) |
| `plugin-meta.json` | copied separately to `state\plugin-meta.json`, sha `46db3926c712211797f12cbaf8d664eb6e1a1447cbd8d4d7665d4578511b2f6d` — **matches** |

**The two counts are not interchangeable.** `8 970` is the number of files the
backup script copied and hashed on both sides (`manifest.file_count`); `8 972` is
what a recursive directory listing of the backup root returns afterwards,
because the manifest itself and the separately-copied `plugin-meta.json` also
sit in that root. The `manifest.json` field to read is `file_count`.

This is a **full cache backup** (every one of the 8 875 cache files was copied
and hashed on both sides), not a bookkeeping-only one.

### 2.3 Cache rebuild — by OpenCode's own loader

`omo5140-cache-rebuild.cjs`, one ssh lifetime, 28/28 checks.

Gates, all of which had to pass **before** anything was deleted:

| Gate | Observed |
| --- | --- |
| G1 cache root exists | `C:\Users\Daniel\.cache\opencode` |
| G2 root is not a reparse point | `root_reparse=False` |
| G2 recursive reparse enumeration completes **without errors** | `reparse_count=0` |
| G3 **no live opencode process** | `opencode pids=[]` (no override exists in the driver) |
| G4 backup manifest ok / copied every cache file | `ok=true`, `copied=8875/8875` |
| G4 old plugin bundle backup matches | `886b7a3c…` == `886b7a3c…` |
| G5 both cached skill .md files backed up and matching | `d14aebff…`, `1c5b5bb8…` |

Then: the cache root was deleted (8 922 files gone), the two `SKILL.md` files
were restored **byte-for-byte** from the backup (sha256 re-verified after the
restore — see §2.3.1 for where those bytes landed, and why the top-level copies
in the cache are OpenCode's own), and an **owned** `opencode serve` child was
started on an ephemeral loopback port.
`GET /agent` is what forces OpenCode to resolve `oh-my-openagent@latest`; the
first five attempts timed out while the loader installed the package, the sixth
returned HTTP 200, and the loader then wrote 5.1.40 into the cache.

```
PASS  plugin-installed-by-opencode-loader  version=5.1.40
PASS  plugin-version-is-5.1.40  version=5.1.40
PASS  plugin-bundle-sha256  sha256=d3d603598b6f0a9ce5da8681d6f0aa680220fd8216b314cfcf20a7bb127b36fd
PASS  plugin-bundle-bytes  bytes=6080006
PASS  agent-plugin-loaded  24 agent(s), /^Sisyphus/ required
PASS  skill-restored:skills/security-research/SKILL.md  sha256=d14aebff…
PASS  skill-restored:skills/security-review/SKILL.md  sha256=1c5b5bb8…
PASS  only-the-owned-child-opencode-is-running
PASS  owned-child-stopped
```

Cache after: 8 927 files / 126.26 MiB, children `bin`, `packages`, `skills`,
`models.json`, **0 reparse points**.

#### 2.3.1 The nested `skills\skills\` duplicate — named, not hidden

A read-only audit of the cache's skills tree after the rebuild shows **four**
skill files where there should be two:

| Path | bytes | mtime (UTC) | sha256 | origin |
| --- | --- | --- | --- | --- |
| `skills\security-research\SKILL.md` | 7 784 | 2026-10-21T04:21:13Z | `d14aebff…d6864` | written by **OpenCode's own loader** (its bundled copy) |
| `skills\security-review\SKILL.md` | 7 832 | 2026-10-21T04:21:13Z | `1c5b5bb8…440a` | written by **OpenCode's own loader** (its bundled copy) |
| `skills\skills\security-research\SKILL.md` | 7 784 | 2026-10-16T07:57:11Z | `d14aebff…d6864` | written by **my restore**, one level too deep |
| `skills\skills\security-review\SKILL.md` | 7 832 | 2026-10-16T07:57:11Z | `1c5b5bb8…440a` | written by **my restore**, one level too deep |

**Cause.** I fixed the G5 skill comparison to use one path base for both the
backup manifest and the backup walk; the same walk also feeds the *restore*
destination, so the restore began writing to `skills\<rel>` where `<rel>` was
now already `skills/…`. The first rebuild run (before that fix) wrote the files
to the correct top level; the final run wrote them one level deeper. The nested
files carry the original mtime because Windows `CopyFile` preserves it.

**Why it is harmless, stated precisely.**

- The two top-level files are the ones OpenCode reads, and they are
  **byte-identical to the originals** (`d14aebff…`, `1c5b5bb8…` — the same
  digests as the pre-rebuild files and as the backup).
- The nested copies are **byte-identical to the canonical backup copies** at
  `%TEMP%\omo5140-backup\cache-opencode\skills\`, which live **outside** the
  cache. Nothing is at risk from a future cache clear: the canonical copy is
  not inside the cache root.
- The nested level is inert. Nothing in OpenCode or OmO reads `skills\skills\`.

**Not removed, deliberately.** The lead's standing instruction is "no further
remote mutation" (the shutdown was approved), so this was resolved by naming it
rather than by deleting it. One command removes it when the lead wants:

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.cache\opencode\skills\skills" -Recurse -Force
```

Re-running the cache rebuild driver with the current source would also remove
it, because the driver deletes the whole cache root before restoring.

**CORRECTION — `plugin-meta.json` now names 5.1.40.** An earlier version of
this document claimed the loader does **not** rewrite that record. That claim
was wrong, and it is corrected here rather than left standing.

| When | Observed `plugin-meta.json` |
| --- | --- |
| preflight, 03:45:44Z | `version=5.1.35`, `load_count=108` (the user's last TUI load) |
| probe at **04:19:31Z**, right after the rebuild | `version=5.1.35`, mtime still 03:45:44Z |
| **04:21:45Z** | `version=5.1.40`, `load_count=109` |

The write landed at **04:21:45Z** — after my 04:19:31Z probe, and while the
**smoke run's** owned `opencode serve` child was running (its `GET /agent` is
what forces a plugin load). So the record **is** rewritten by the loader when a
server loads the plugin; my earlier probe simply ran about two minutes before
the write arrived, and I generalised from that single observation into "the
loader never rewrites it". The record now names the installed version
correctly, and the stale-5.1.35 worry is resolved.

What survives of the original point: `plugin-meta.json` is a *bookkeeping*
record, not the installed state, and the authority for the installed version
remains the installed `package.json` and the installed bundle hash — which the
installed doctor reads, and which reports 5.1.40 with 11/11 anchors. The
rebuild driver asserts the installed `package.json` version and the bundle
hash, and reports the metadata record as an observation, because the record's
write is not ordered against the driver's own probes.

**The doctor's exit code in this final state is 30, and that is correct.**
Exit 30 is check 3, "no OpenCode port resolution": nothing was running on the
OmO fallback port 4096 because no OpenCode server was up. The preflight
baseline on the same host exited 30 for the same reason. Checks 1, 2, 4 and 5
are unaffected, and check 5 reports `frozen_line_anchors_resolved=11/11` and
`installed_version=5.1.40`.

### 2.4 Deploy — 3 files, hard-gated

`win-deploy.ps1`, 23/23 checks. The published v0.3.0 zip was **not** used.

| File | Before | After |
| --- | --- | --- |
| `bin\tmux.exe` | `994875a9…` (86 135 808 B) | **`4e94e1df2735dc70a559f807ce0bc2eb37b7414acca0470aaece5505e9d28e39`** (96 429 056 B) |
| `bin\bridge-doctor.ps1` | `16114bbf…` | **`426c8d3183ad5d0806f6ed0dce221aba0516538562c4559890ca2f3116ff3269`** (frozen at 5.1.40) |
| `bin\install.ps1` | `120a8058…` | **`109d0ac465047009437bc64b625769da492f433316c21a1a2a6d060a36d80fd3`** |

The MOTW hotfix is intact: `bin\install.cmd` = `5146a4cc6bba61c420e402a185edc4318833330678529c1a787f2830264c8613`
(unchanged, and the published zip's pre-hotfix `1bd67f75…` was never installed).
The other eight payload files already matched the repo byte-for-byte and were
not touched. Deployed tree reparse count: **0**.

The deploy refuses to copy anything while a preflight check is failing
(`PREFLIGHT all gates passed; copying now` is printed only after the backup
manifest, the staged hashes and the reparse checks all pass).

### 2.5 Preservation

| Item | Before | After |
| --- | --- | --- |
| User PATH sha256 | `fa64dd34bbfa4a327c3f796fea7806cba1aa59201ccbacfbe1b28fa39ea527ec` | **identical** |
| Machine PATH sha256 | `1d11fe7f05771a3f9122c2cd079aa58944cced2cd3cee40afaec5e553864fd63` | **identical** |
| User PATH entry 0 | `…\opencode-psmux-bridge\bin` | **identical** (14 entries) |
| `.local\share\opencode\auth.json` | 2 432 B | present, 2 432 B |
| `opencode.db` / `-wal` / `-shm` | 147 308 544 / 11 564 872 / 32 768 B | present, same sizes |
| `.local\share\opencode` | 140 files / 168.6 MiB | 141 files / 168.63 MiB (+1 = the QA session row, created and deleted) |
| `.omo\omo.jsonc` | `f4ff26ac…` | **identical** |
| `.config\opencode\opencode.json` | `7a2637c8…` | **identical** |
| `.omo\{teams,run-continuation,worktrees,runtime}` | present | present |
| psmux pids / sessions / attached client | 11624,18816,22332,43640 / `0`,`default` / attached | **identical** |
| OpenCode install route | npm `…\opencode-ai\bin\opencode.exe` 1.19.3 | unchanged |
| Standalone `omo` | not installed | not installed (nothing migrated) |

---

## 3. Verification runs

### 3.1 Protocol smoke — real installed shim, real OpenCode, 39/39

`omo5140-smoke.cjs`, one ssh lifetime, private `-L omo5140-<rand>` namespace.

| Check | Result |
| --- | --- |
| `omo-package-5.1.40` | PASS |
| `omo-bundle-sha256` | PASS (`d3d60359…`) |
| `omo-placeholder-source-present` | PASS (banner + hint constants found in the installed bundle) |
| `serve-health-ok` / `serve-version-1.19.3` | PASS |
| `agent-plugin-loaded` | PASS — 24 agents, `/^Sisyphus/` present |
| `session-post-2xx` / `session-id-captured` | PASS (id withheld) |
| `pane-banner-marker`, `pane-hostile-apos`, `pane-hostile-hash-dollar`, `pane-hostile-backtick`, `pane-hostile-backslash`, `pane-hint` | PASS — placeholder rendered as literal text |
| `pane-no-interpolation`, `pane-no-side-effect` | PASS — `$()` not expanded, canary file absent |
| `mux-respawn-placeholder`, `pane-respawn-banner`, `pane-respawn-meta` | PASS |
| `pane-real-opencode-session` | PASS — a unique context-only message rendered by the **real attached OpenCode session** (no model call) |
| `doctor-exit-0` | PASS (exit 0) |
| `doctor-anchors-11/11` | PASS |
| `doctor-sees-5.1.40` | PASS (`installed_version=5.1.40`) |
| `cleanup-session-deleted` | PASS (HTTP 200, id withheld) |
| `cleanup-namespace-only` | PASS — `kill-server -L omo5140-…`, namespace gone, **never a bare kill-server** |
| `preexisting-opencode-pids-not-signalled` | PASS — none existed at the start; nothing of the user's could be signalled |
| `preexisting-psmux-pids-not-signalled` | PASS — all four pids identical before/after |

Known limitation carried forward unchanged (GitHub issue #2): the PS 5.1 helper
drops embedded doublequotes from the placeholder description — recorded as an
observation, not a gating assertion.

### 3.2 Team layout in the DEFAULT namespace — 25/25

`omo5140-team-default.cjs`. The default namespace is live (the user's `default`
session is attached), so this run is baseline-guarded:

| Check | Result |
| --- | --- |
| `new-session-in-default-namespace` | PASS (uniquely named `omo5140-team-<pid><rand>`) |
| `display-caller-session` / `display-caller-window-target` | PASS — `$61` / `omo5140-team-…:0` (the bridge's `-F` drop working) |
| `set-option-p-absorbed-a` / `-b` | PASS — the pane-scoped `@omo_attach_*` options are absorbed, exit 0, empty stderr |
| `pane-a-marker` / `pane-b-marker` | PASS |
| `select-layout-main-vertical` | PASS |
| `resize-pane-30pct` | PASS |
| `resize-changed-geometry-after-layout` | PASS — `after_layout [%1 0 119 \| %2 120 80 \| %3 120 80]` → `after_resize [%1 0 59 \| %2 60 140 \| %3 60 140]` |
| `caller-pane-at-~30pct-after-resize` | PASS — 59 of 200 = **29.5 %** |
| `targeted-kill-session` | PASS — `kill-session -t omo5140-team-…` |
| `no-kill-server-ever-issued` | PASS — none, in any namespace |
| `only-our-session-was-killed` | PASS |
| `our-session-gone` | PASS — after = `0,default` |
| `user-sessions-survived` | PASS — `before=0,default after=0,default lost=none` |
| `no-session-count-growth` | PASS — 2 before, 2 after |
| attached client | unchanged — `/dev/pts/43640: default [133x71 xterm-256color] (attached,UTF-8)` |

The geometry matches the recorded reference run
(`.omo/evidence/issue-1-team-layout-probe-after.json`, shim arm) exactly.

> Note on a corrected measurement: the first run of this driver used
> `list-panes -a` for the geometry, which in the **default** namespace crosses
> the user's own sessions (their panes are also called `%1`), so it measured the
> wrong pane and reported 74 %. The geometry is now scoped to our own window
> target, which is why the 29.5 % figure is the correct one.

### 3.3 Windows test suite and installed doctor harness

| Run | Command | Result |
| --- | --- | --- |
| Full suite | `bun test` in `%TEMP%\omo5140-worktree` (the current working tree, `bun install` into that dir only) | **491 pass, 0 fail**, 2 428 `expect()` calls, 12 files, 56.15 s |
| Doctor harness | `doctor-harness.ps1 -BridgeBin %LOCALAPPDATA%\opencode-psmux-bridge\bin` (the **installed** doctor) | **205 pass, 0 fail, 0 skip**, 34.5 s |

`bun 1.4.2`, `node v24.19.0` on the host. The harness reads its expected anchor
table back out of the doctor under test, so a fixture cannot encode an older
table than the one the doctor enforces.

---

## 4. The defects the lead's review found, and how each was closed

| Defect | Fix |
| --- | --- |
| `'ExecutionPolicy'` missing its leading dash | all three occurrences corrected in `omo5140-smoke.cjs`; the cache-rebuild driver was written with `'-ExecutionPolicy'` from the start |
| `report.backup` was a string, so `report.backup.skillFiles` threw a TypeError | `backup` is now an object (`{ workRoot, manifest, checks, ok }`) |
| the live-process gate had a bypass | the bypass is **removed**; the gate requires **zero** opencode processes and there is no override flag |
| the reparse check could swallow enumeration errors | enumeration errors now **fail** the gate; the root itself is checked as well as the recursion |
| the driver did not require a verified backup before deleting | G4/G5 read the backup manifest and assert `ok`, `copied == source`, the old bundle match and both skill files; the delete is refused otherwise |
| the driver waited 12 min for a manifest instead of triggering the load | `GET /agent` is now the trigger, retried, and the install wait follows it |
| empty catch blocks / a `sha256File` that returned an empty digest | every catch records a safe reason; `sha256File` records the failure and returns `null`, and the smoke now fails the run if any hash read failed |
| the deploy did not abort on failing preflight checks | all preflight checks are collected and the script **throws before any copy** when one fails; the backup manifest is validated before the copy, not the backup's existence after it |
| the smoke's process assertions were stale | the assertion now states the real claim — every pre-existing pid observed at the start is still alive at the end — and it is honest when the set is empty |
| the report write could fail while the exit code stayed 0 | a failed report write sets `ok=false` and exits non-zero |
| the staged copies could be stale | the payload is staged from the **current working tree**; the deploy re-generates and re-checks the manifest, so a stale stage is rejected rather than installed |

Two defects found during my own runs, and fixed:
the G5 skill comparison used two different path bases (so a good backup looked
absent), and `plugin-meta.json` was asserted to be rewritten by `opencode serve`
— it is not; that assertion is now an observation with the measured explanation.

---

## 5. Artifacts, paths and how to re-run

### On Windows (`windows-daniel`)

| Path | What |
| --- | --- |
| `%TEMP%\omo5140-backup\` | the full backup — **8 970 files copied and hash-verified**, 8 972 files on disk, 220.02 MiB; **keep it** until the lead accepts, it is the rollback |
| `%TEMP%\omo5140-backup\backup-manifest.json` | per-file sha256 manifest of the backup (8.2 MB — deliberately **not** committed to git; see below) |
| `%TEMP%\omo5140-stage\` | the staged deploy payload + `manifest.json` |
| `%TEMP%\omo5140-artifacts\` | `cache-rebuild-report.json`, `deploy-report.json`, `smoke-report.json`, `team-layout-report.json`, `doctor-harness-report.txt`, `windows-bun-test.txt` (this last one in **UTF-16LE with BOM**, as `Tee-Object` wrote it) |
| `%TEMP%\omo5140-worktree\` | the repo working tree staged for the Windows test run (deps installed there only) |
| `%TEMP%\omo5140-*.ps1`, `%TEMP%\omo5140-*.cjs` | the drivers, left in place for a personal re-run |

### On Linux (this repo)

| Path | What |
| --- | --- |
| `/tmp/opencode/windows-omo5140-preflight.json` | machine-readable preflight + outcome |
| `/tmp/opencode/windows-omo5140/artifacts/` | pulled copies of all six reports |
| `/tmp/opencode/windows-omo5140/artifacts-raw/` | the untouched Windows originals (the bun-test log in its original UTF-16LE) |
| `/tmp/opencode/windows-omo5140/*.ps1`, `*.cjs` | the drivers (source of truth for a re-run) |
| `.omo/evidence/windows-omo5140-preflight-20261021.md` | the read-only preflight report |
| `.omo/evidence/windows-omo5140-execution-20261021.md` | this document |
| `.omo/evidence/windows-omo5140-cache-rebuild-report-20261021.json` | 9 194 B, 28/28 |
| `.omo/evidence/windows-omo5140-deploy-report-20261021.json` | 9 562 B, 23/23 |
| `.omo/evidence/windows-omo5140-smoke-report-20261021.json` | 8 645 B, 39/39 |
| `.omo/evidence/windows-omo5140-team-layout-report-20261021.json` | 16 810 B, 25/25 |
| `.omo/evidence/windows-omo5140-doctor-harness-report-20261021.txt` | 33 593 B, 205 pass / 0 fail / 0 skip |
| `.omo/evidence/windows-omo5140-windows-bun-test-20261021.txt` | 66 496 B, 491 pass / 0 fail |

### 5.1 Evidence durability — what is in git, what is not, and the exact commit

The six small reports and the two evidence documents are now **in the repo**
under `.omo/evidence/`, all with the `windows-omo5140-` prefix, and are
**untracked** — I made no git mutation. Their digests:

```
9d7ad661ada859f973ae4f2af6e82bfc2db159f616b1a58679904358e1de2148  windows-omo5140-cache-rebuild-report-20261021.json
489a243e3fbbd3a0c3f33e8f121b930555bb98984205f6926d9e81b94324c8c3  windows-omo5140-deploy-report-20261021.json
2869ca02f9323bb8d832fc39860f075743701d4be08a55f6771684566b0a28d0  windows-omo5140-smoke-report-20261021.json
aa4cbad075b0d50429b7260e32753fbbf3bec66e594b6fd5f2388446374559c9  windows-omo5140-team-layout-report-20261021.json
0717b07d5413a8fb39e238b6378779cc30d3b1490f8635bf38c43a45067ee4dc  windows-omo5140-doctor-harness-report-20261021.txt
f8c2432df685e46af3fffb50b317282ff2ae512c1bbbd71bcaf05030dc5ff9fa  windows-omo5140-windows-bun-test-20261021.txt
```

**The 8.2 MB backup manifest is deliberately NOT in git.** It is a per-file
digest of 8 970 files and is large enough to bloat the repository for no
review value. It stays on the Windows host and on the Linux scratch, and its
identity is recorded here so either copy can be verified:

| | |
| --- | --- |
| Linux copy | `/tmp/opencode/windows-omo5140/artifacts/backup-manifest.json` |
| sha256 | `a9f096b3fe3f1e2d108c2f93b076195a51deaded9ba9914aa57deff5b7b30fae` |
| bytes | 8 167 993 |
| Windows copy | `C:\Users\Daniel\AppData\Local\Temp\omo5140-backup\backup-manifest.json` |

**The bun-test log has two encodings; the repo copy is canonical.** The Windows
original is UTF-16LE with a BOM (132 964 bytes, sha256
`7f60bd2a3a49675a3d637098ee3b83b4b0f4b7e51daab77732b2b334c1a31274`, preserved
untouched at `%TEMP%\omo5140-artifacts\windows-bun-test.txt` and at
`/tmp/opencode/windows-omo5140/artifacts-raw/windows-bun-test.win-utf16.txt`).
The repo copy `.omo/evidence/windows-omo5140-windows-bun-test-20261021.txt` is
that file decoded and re-encoded as UTF-8 (66 496 bytes, sha256
`f8c2432df685e46af3fffb50b317282ff2ae512c1bbbd71bcaf05030dc5ff9fa`). The two
decode to **797 lines each and differ on exactly one line — line 1, by the BOM
character only**; the test output itself is identical. The UTF-8 form is the
one to commit, because it diffs cleanly in git.

**The exact commit for the lead** (I did not run it — no git mutation was
mine to make):

```bash
git add .omo/evidence/windows-omo5140-*.json \
        .omo/evidence/windows-omo5140-*.txt \
        .omo/evidence/windows-omo5140-*.md
git commit -m "test(evidence): record the Windows OmO 5.1.40 cache rebuild and bridge deploy"
```

### Exact re-run commands

```bash
# 1. verify the current installed state
ssh windows-daniel "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:/Users/Daniel/AppData/Local/Temp/omo5140-finalverify.ps1"

# 2. the protocol smoke (one ssh lifetime; owns its own opencode child)
ssh windows-daniel "node C:/Users/Daniel/AppData/Local/Temp/omo5140-smoke.cjs C:/Users/Daniel/AppData/Local/Temp/omo5140-artifacts/smoke-report.json"

# 3. the team-layout replay in the default namespace (baseline-guarded)
ssh windows-daniel "node C:/Users/Daniel/AppData/Local/Temp/omo5140-team-default.cjs C:/Users/Daniel/AppData/Local/Temp/omo5140-artifacts/team-layout-report.json"

# 4. the installed doctor harness
ssh windows-daniel "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:/Users/Daniel/AppData/Local/Temp/omo5140-worktree/scripts/windows/harness/doctor-harness.ps1 -HarnessDir C:/Users/Daniel/AppData/Local/Temp/omo5140-worktree/scripts/windows/harness -BridgeBin C:/Users/Daniel/AppData/Local/opencode-psmux-bridge/bin -WorkDir C:/Users/Daniel/AppData/Local/Temp/omo5140-artifacts/doctor-cases -ReportPath C:/Users/Daniel/AppData/Local/Temp/omo5140-artifacts/doctor-harness-report.txt"

# 5. the full Windows suite
ssh windows-daniel "powershell.exe -NoProfile -NonInteractive -Command \"Set-Location C:/Users/Daniel/AppData/Local/Temp/omo5140-worktree; bun test\""
```

Steps 2–5 are read-only against the user's data and leave no process behind.
Step 2 and 3 create and delete their own resources (a private `-L` namespace and
a uniquely named default-namespace session).

### Rollback

```powershell
# restore the previous bridge payload from the backup
Copy-Item "$env:TEMP\omo5140-backup\bridge\*" "$env:LOCALAPPDATA\opencode-psmux-bridge" -Recurse -Force
# restore the previous plugin cache
Copy-Item "$env:TEMP\omo5140-backup\cache-opencode\*" "$env:USERPROFILE\.cache\opencode" -Recurse -Force
```

The backup holds the previous shim `994875a9…`, the previous doctor `16114bbf…`,
the previous `install.ps1` `120a8058…`, the previous plugin bundle `886b7a3c…`
and every other cache file.

---

## 6. Scope notes and what was deliberately not done

- **No git mutation.** Nothing was committed, staged or pushed. The peer owns
  `CONTRACT.md`, `pins.json`, `bridge-doctor.ps1`, `install.ps1`,
  `doctor-harness.ps1` and the two test files; their working-tree edits were
  used as-is and not modified.
- **No repo script was edited by me.** `dist` was not rebuilt; the binary came
  from the lead's verified cross-build.
- **The published v0.3.0 zip was never installed**, so the `install.cmd` MOTW
  hotfix `5146a4cc…` survived.
- **No machine-wide cleanup, no mass kill.** Exactly one process was closed
  (the identified OpenCode app server, by path match). psmux, the user's
  attached `default` session, the DB, the auth file, all config and the `.omo`
  memory are intact.
- **No model-driven team E2E** was run: it is optional, needs a provider key,
  and the deterministic team-layout replay already covers the command family.
- **The user's own OpenCode sessions are not running right now.** PID 3924 was
  closed for the rebuild and has not been reopened. The next OpenCode the user
  starts will load the rebuilt 5.1.40 from the cache. The psmux `default`
  session and its attached client are still up.
