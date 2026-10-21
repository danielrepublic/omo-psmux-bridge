# Windows OmO 5.1.40 upgrade + bridge deploy — READ-ONLY preflight

Date: 2026-10-21. Host: `WINDOWS-DANIEL` (Windows 11, build 26300), user `daniel`.
Owner: `windows-deployer`, team `windows-omo-5140-upgrade-deploy`, task 4 (preflight).

**Nothing was mutated.** Every command in this document is a read: file reads,
hashes, an exclusive-share *read* open used as a lock probe, read-only HTTP GETs,
read-only `psmux list-*` commands, and the installed doctor (documented read-only).
No file was created, written, moved or deleted on Windows. No process was stopped.
No argv, environment, config body, auth body or credential was captured.

Raw probe output (Linux copies of the Windows transcripts):

- `/tmp/opencode/windows-omo5140/inventory-raw.txt` — 237 lines
- `/tmp/opencode/windows-omo5140/probe-raw.txt` — 70 lines
- `/tmp/opencode/windows-omo5140/probe2-raw.txt` — 62 lines

Probe scripts (task-owned, this task only):
`/tmp/opencode/windows-omo5140/inventory-readonly.ps1`,
`probe-live-usage.ps1`, `probe-plugin-cache.ps1`, `probe-omo-leases.ps1`,
`probe-cache-tree.ps1`, `probe-standalone.ps1`.

---

## 1. Verified baseline

| Item | Observed | Source |
| --- | --- | --- |
| OpenCode | **1.19.3** | `opencode --version`; `GET /global/health` → `{"healthy":true,"version":"1.19.3"}` |
| OpenCode install route | `C:\Users\Daniel\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe` (npm) | process path |
| psmux | **3.4.0** (`20aa1d7 2026-10-13`) | `psmux -V` |
| psmux binary | `C:\Users\Daniel\AppData\Local\psmux\psmux.exe`, sha256 `bbe825a30f7cddc91b043084049143a381aba5f7e9e36e4d0bb587e296d262ca` | hash |
| psmux registry | `HKCU\Software\psmux\InstallDir` = `C:\Users\Daniel\AppData\Local\psmux` | `reg query` |
| OmO installed (cache) | **5.1.35**, `dist/index.js` sha256 `886b7a3cb275609649ab5083670d87fe66c4c1248dfa801d83963f187f824930`, 6 077 854 bytes | package.json + hash |
| npm registry | `oh-my-openagent@latest` = **5.1.40 exactly**; dist-tags `latest=5.1.40, beta=5.1.0, next=4.5.12`; `5.1.40` exists; published list jumps `5.1.35 → 5.1.38 → 5.1.40` | `npm view` (registry, read-only) |
| npm | 11.17.0, `C:\Program Files\nodejs\npm.ps1` | `npm --version` |
| OpenCode plugin pin | `C:\Users\Daniel\.config\opencode\opencode.json` → `"oh-my-openagent@latest"` (single spec, sha256 `7a2637c8…`) | regex extraction of the spec only |
| OmO user config | `C:\Users\Daniel\.omo\omo.jsonc` sha256 `f4ff26ac…`; `"tmux": { "enabled": true, … }`; `"team_mode": { "enabled": true, "tmux_visualization": true }` | block extraction only |
| User PATH | 14 entries; entry **0** = `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge\bin`; sha256 `fa64dd34bbfa4a327c3f796fea7806cba1aa59201ccbacfbe1b28fa39ea527ec` | registry read + hash |
| Machine PATH | 16 entries; sha256 `1d11fe7f05771a3f9122c2cd079aa58944cced2cd3cee40afaec5e553864fd63` | registry read + hash |
| Standalone `omo` | **not installed** on this host — no `omo`/`omo.exe` on PATH, and `.config\opencode\node_modules` holds only the `@opencode-ai/plugin` SDK (`package.json` → `{"dependencies":{"@opencode-ai/plugin":"1.19.0"}}`). There is nothing to migrate. | PATH probe + package.json |

---

## 2. LIVE USAGE — this is the blocker

### 2.1 Two live OpenCode servers, both healthy

| PID | Started (UTC) | Loopback port | Health |
| --- | --- | --- | --- |
| 3924 | 2026-10-20T21:33:18Z | 7802 (+56430, +56449) | `HTTP 200 {"healthy":true,"version":"1.19.3"}` |
| 28380 | **2026-10-21T03:43:57Z** (≈4 min before the probe) | 7801 (+62877, +62887) | `HTTP 200 {"healthy":true,"version":"1.19.3"}` |

PID 28380 started *during* this preflight, i.e. the user is actively using
OpenCode right now. The two ports are the range the bridge's own
`opencode.cmd` picks from (bind 7801..7901), which is why two servers coexist.

### 2.2 psmux default namespace is live and ATTACHED

```
list-sessions -F '#{session_name}'  ->  0 | default
list-sessions (verbose)             ->  0: 1 windows (created Wed Oct 21 05:33:09 2026)
                                       default: 1 windows (created Wed Oct 21 11:43:49 2026) (attached)
list-clients                         ->  /dev/pts/43640: default [133x71 xterm-256color] (attached,UTF-8)
last_session                        ->  default
```

Four `psmux.exe` processes are alive: 11624 & 43640 (started 03:43:49Z, the
current default-namespace server + attached client), 18816 (21:31:40Z) and
22332 (21:33:09Z).

### 2.3 OmO's OWN plugin lease/refresh machinery is active inside the cache

This is the decisive finding. The plugin cache subtree is not inert — OmO
manages it with a lease directory and a pending-refresh marker:

```
C:\Users\Daniel\.cache\opencode\packages\oh-my-openagent@latest\
  .omo-refresh-pending      6 bytes   mtime 2026-10-21T03:45:09Z   content: "28380 "
  .omo-leases\              56 PID lease files (incl. "3924", "28380", "33228", …)
  node_modules\oh-my-openagent\dist\index.js
  bun.lock (29 369 B), package-lock.json (60 378 B), package.json (60 B)
```

- `.omo-refresh-pending` contains **`28380 `** — the PID of the live OpenCode
  that started four minutes earlier. OmO has a **plugin refresh pending for a
  live PID**, and the marker file's mtime advances (03:33:25Z → 03:45:09Z).
- `.omo-leases\` holds one lease per PID that has loaded the plugin; 56 of
  them, including both live servers.

And the loader's own metadata cache, `C:\Users\Daniel\.local\state\opencode\plugin-meta.json`,
pins the plugin and was rewritten by the live server one minute before the probe:

```json
{"oh-my-openagent:tui": {
  "source": "npm", "spec": "oh-my-openagent@latest",
  "target": "C:\\Users\\Daniel\\.cache\\opencode\\packages\\oh-my-openagent@latest\\node_modules\\oh-my-openagent",
  "requested": "latest", "version": "5.1.35",
  "load_count": 106, "last_time": 1792554245374,   // 2026-10-21T03:44:05Z
  "fingerprint": "…\\oh-my-openagent|latest|5.1.35" }}
```

### 2.4 Lock probe — mechanically deletable, but not idle

`File.Open(path, Open, Read, FileShare.None)` succeeds on
`package.json`, `dist/index.js`, `bin\tmux.exe` and `bin\state\shim-calls.jsonl`:
**no OS-level file handle is held** on the plugin files. Bun closes them after
import, so the delete would not fail with a sharing violation.

Mechanically possible ≠ safe to do. The cache is *semantically* in use: OmO is
mid-refresh on a live PID and the live servers reload the plugin from this exact
path (`load_count` incremented at 03:44:05Z, i.e. after my first probe).

### 2.5 What the user authorized vs. what a delete would touch

The user authorized plugin update + cache deletion, and excluded **user-session
disruption**. Deleting the cache subtree does not kill anything, but it removes
the plugin from under two live servers that are actively re-loading it. If
OmO's pending refresh or a subsequent subagent spawn resolves the plugin while
the directory is absent, the failure surfaces **in the user's live session** —
which is precisely the disruption the user excluded. And the live servers keep
`5.1.35` in memory regardless: only a restart (not authorized) makes the user's
own session *run* 5.1.40.

**Reported, not acted on.** Nothing was deleted.

---

## 3. The authorized cache root — exact and safe

```
C:\Users\Daniel\.cache\opencode\            <- the OpenCode cache root
├─ bin\rg.exe                                4 266 496 B   (OpenCode's ripgrep)
├─ models.json                               5 893 971 B   (model catalog; LIVE-WRITTEN, mtime 03:44:00Z)
├─ packages\
│   └─ oh-my-openagent@latest\               8 868 files / 116.63 MiB   <- the plugin subtree
└─ skills\
    ├─ security-research\SKILL.md                7 784 B  sha256 d14aebffc36be7139174bfda330b9342a81773a2d51703f98863d5d9261d6864
    └─ security-review\SKILL.md                  7 832 B  sha256 1c5b5bb806a2c58886d7936b733b2c15a4b8744ae8368c421376abf579fe440a
```

Cache totals: **8 872 files / 126.34 MiB**.

Safety facts, all verified:

- `cache.home` and `cache.packages` are plain `Directory` attributes,
  `LinkType` empty, `Target` empty.
- **`cache.reparse.count = 0`** — `Get-ChildItem -Recurse -Attributes ReparsePoint`
  over the whole cache root returns **zero** junctions/symlinks. A recursive
  delete therefore cannot escape the authorized root through a link.
- `cache.pkg.dir` lists exactly one package directory: `oh-my-openagent@latest`.
- The plugin subtree's `package.json` is 60 bytes:
  `{"dependencies":{"oh-my-openagent":"5.1.35"}}` — a pure npm install layout
  (`node_modules/`, `bun.lock`, `package-lock.json`), no user content.

### 3.1 Preservation inventory (must survive untouched)

| Path | State | Verdict |
| --- | --- | --- |
| `.local\share\opencode\auth.json` | 2 432 B present | **preserve** |
| `.local\share\opencode\opencode.db` (+ `-wal`, `-shm`) | 147 308 544 B + 11 564 872 B + 32 768 B | **preserve** |
| `.local\share\opencode\{storage,snapshot,tool-output,log,repos}` | 140 files / 168.6 MiB total | **preserve** |
| `.local\state\opencode\{kv,model,plugin-meta,prompt-history,session}.json*` | 6 files | **preserve** (not in the cache root) |
| `.config\opencode\*` (opencode.json, tui.json, package.json, node_modules, `oh-my-openagent\native-nudge.json`) | 2 463 files / 24.96 MiB | **preserve** |
| `.omo\{teams,run-continuation,worktrees,runtime}` + `omo.jsonc` (+ 3 dated `.bak-*`) | present | **preserve** |
| `.cache\opencode\skills\*.md` | 2 files / 15 616 B | in the cache root → **back up verbatim, restore after** |
| `.cache\opencode\{bin,models.json}` | rebuildable | in the cache root → deletable, auto-rebuilt |

---

## 4. Deployed bridge vs. repository

Deployed root: `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge`
(plain directory, `bridge.reparse.count = 0`).

| File | Deployed sha256 | Repo sha256 | Match |
| --- | --- | --- | --- |
| `bin\tmux.exe` | `994875a97663ac4fe8a26a0bae11fa904b3ed16bed580929aebcbd92fcd8b513` (86 135 808 B) | `4e94e1df2735dc70a559f807ce0bc2eb37b7414acca0470aaece5505e9d28e39` (96 429 056 B) | **NO** |
| `bin\install.cmd` | `5146a4cc6bba61c420e402a185edc4318833330678529c1a787f2830264c8613` | same | yes (MOTW hotfix) |
| `bin\install.ps1` | `120a80580051352ec38a2d660d0d8d51d86f8023fb7d9549eee856ea473d32ff` | same | yes |
| `bin\bridge-doctor.ps1` | `16114bbf9c3cc013718670671d79c0b920c884c9f945a91269189f17c8e60bc3` | same | yes |
| `bin\bridge-doctor.cmd` | `c11edef92e207a15e4a95993864cc57db2513dd4a3dbf752846e49ead6e9cd4b` | same | yes |
| `bin\opencode.cmd` | `fbb1e84509ebf2a9d26193cba8f8f03e75ccae41244af0c3540221fb2c2ca958` | same | yes |
| `bin\psmux.cmd` | `ad9d8e5b3c714474436d2ea71636be6eae7c2b02053f910324febfd39bcedd36` | same | yes |
| `bin\uninstall.ps1` | `5a6201fadd01af0e23fced595a5c0a3f19d951e9861c11cf5f0494f3c8b07c86` | same | yes |
| `bin\omo-opencode-port.ps1` | `8ac696c87ad2f5a3ffd08a136adb9e8dd8763864da33783445ea70e99c6ae01a` | same | yes |
| `runtime\Start-PaneFromDescriptor.ps1` | `564e218b73350270c5dbe0fdb099913ce960ec48b4198c538e3fa74275b6e034` | same | yes |
| `INSTALL.md` | `06bb131101499e573eb6b522fed25ac075080b99aba13e39d94ce7e9077f88c0` | same | yes |

So **every deployed helper already matches the repository byte-for-byte**; the
only delta in the whole payload is `bin\tmux.exe`. The installed shim is the
*older* build (86.1 MB, deployed 2026-10-18T11:10:14Z); the repo `dist/tmux.exe`
is the newer cross-build (96.4 MB, 2026-10-19T10:51Z). The installed
`bin\state\shim-calls.jsonl` is live (mtime 03:37:30Z) — the bridge is in use.

Note for the record: `.omo/evidence/windows-update-20261019.md` claims the
installed shim equalled `4e94e1df…` on 2026-10-19; the tree observed now holds
`994875a9…`. The tree was evidently restored from the published v0.3.0 zip
afterwards (whose `install.cmd` is the pre-hotfix `1bd67f75…`, while the
deployed one is the hotfixed `5146a4cc…`). That history is the lead's to
reconcile; it changes nothing about the delta table above.

---

## 5. OmO 5.1.40 facts and the frozen-anchor table for the peer

The npm tarball is platform-independent and byte-identical across installs:
the **local** extracted `oh-my-openagent-5.1.35.tgz` `dist/index.js` has
sha256 `886b7a3cb275609649ab5083670d87fe66c4c1248dfa801d83963f187f824930` —
**exactly the sha256 of the copy installed on Windows**. The same must hold for
5.1.40:

| Artifact | sha256 | bytes |
| --- | --- | --- |
| 5.1.35 `dist/index.js` (Windows-installed **and** npm tarball) | `886b7a3cb275609649ab5083670d87fe66c4c1248dfa801d83963f187f824930` | 6 077 854 |
| **5.1.40 `dist/index.js`** (npm tarball, cross-platform expectation) | **`d3d603598b6f0a9ce5da8681d6f0aa680220fd8216b314cfcf20a7bb127b36fd`** | **6 080 006** |

5.1.40 `dist/index.js` = 188 457 lines. The doctor's check 5 resolves the
contract's frozen line numbers against the **installed** bundle, so the
contract-maintainer needs the 5.1.40 line numbers. I resolved them read-only
from the npm tarball; the doctor's `Get-SelectedLines` trims each line, so the
comparison is `trimmedLine.StartsWith(anchorText)`.

| # | Anchor text | 5.1.35 line | **5.1.40 line** |
| --- | --- | --- | --- |
| 1 | `function isInsideTmuxEnvironment(environment) {` | 8231 | **8235** |
| 2 | `async function isServerRunning(serverUrl, options = {}) {` | 8271 | **8275** |
| 3 | `const healthUrl = new URL("/global/health", serverUrl).toString();` | 8283 | **8287** |
| 4 | `const serverRunning = await deps.isServerRunning(serverUrl);` | 8399 | **8403** |
| 5 | `const tmux = await deps.getTmuxPath();` | 8404 | **8408** |
| 6 | `async function findVerifiedTmuxPath() {` | 9079 | **9079** |
| 7 | `const verifyProc = spawn([path, "-V"], {` | 9085 | **9085** |
| 8 | `if (verifyExitCode !== 0) {` | 9091 | **9091** |
| 9 | `enabled: z49.boolean().default(false),` | 27072 | **89030** |
| 10 | `function resolveServerUrl(rawServerUrl, env, log) {` | 156456 | **156488** |
| 11 | `log("[tmux-session-manager] ctx.serverUrl has port 0; falling back. "` | 156466 | **156498** |

All 11 verified against the 5.1.40 bundle with the doctor's own trim+StartsWith
rule: **11/11 resolve**. Anchor 9 moved 27 072 → 89 030 (the bundle was
re-ordered), and the doctor's in-file citation `omo dist/index.js:156458`
(the `4096` fallback port) must become `156488`.

Two anchors are no longer unique in 5.1.40 — they must be pinned by line, not
by search: `const serverRunning = await deps.isServerRunning(serverUrl);`
occurs at 8403 / 8615 / 8715, and `const tmux = await deps.getTmuxPath();` at
8408 / 8511 / 8558 / 8625 / 8725 / 8804 / 8851 / 8945 / 9406 / 155570.
The doctor already pins by line, so this is a note for the peer, not a defect.

---

## 6. Doctor state right now (read-only run)

```
exit=30
namespace=default  session=default
OPENCODE_PORT=<unset>
FIX     set OPENCODE_PORT=<n>   then   opencode --port <n>
contract_frozen_version=5.1.35  (CONTRACT.md section 0.1)
known_equivalent_versions=  (same line numbers verified)
frozen_line_anchors_resolved=11/11
installed_version=5.1.35
verdict_basis=version-equality (equals the frozen version exactly)
```

Exit 30 is check 3 (no OpenCode port resolution): `OPENCODE_PORT` is unset in
an SSH session, and the OmO fallback port 4096 has no listener. Checks 1, 2, 4
and 5 are unaffected by that. QA must therefore run the doctor with
`OPENCODE_PORT` pointing at a server it owns — exactly what the 2026-10-19
smoke driver did.

---

## 7. Exact remaining blockers and the authorization I need

**B1 — the cache is live, not idle.** `.omo-refresh-pending` names live PID
28380; 56 OmO leases are held; `plugin-meta.json` was rewritten at 03:44:05Z.
Options, my recommendation first:

- **(a) Wait for the user to close the live OpenCode/psmux sessions, then
  delete.** Zero live lease, zero race, zero user-visible effect. Matches the
  lead's own plan wording ("delete full authorized `.cache\opencode` once
  idle"). **Recommended.**
- (b) Delete now under the live lease. The delete itself would succeed, but
  OmO's pending refresh or a subsequent subagent spawn could hit the plugin
  missing and surface an error **in the user's live session** — the exact
  disruption the user excluded. Not recommended without the user's explicit
  acceptance of that risk.

**B2 — "actual loaded plugin 5.1.40" for the user's own session is
unreachable without a restart.** The live servers hold 5.1.35 in memory. The
verifiable form of the goal is: the cache on disk is rebuilt and the **plugin
that a freshly started OpenCode loads** is 5.1.40. I can prove that with an
*owned* `opencode serve` child on an ephemeral port (the 2026-10-19 smoke
pattern): on-disk `package.json` = 5.1.40, `dist/index.js` =
`d3d60359…`, `plugin-meta.json` rewritten by OpenCode's own loader to
`"version": "5.1.40"`, and `GET /agent` proving the plugin's agents loaded.
The user's own sessions keep 5.1.35 until the user restarts them — that is
reported, not forced.

**B3 — the doctor's 5.1.40 alignment must land BEFORE the deploy, and the
deploy must come AFTER the cache rebuild.** The updated doctor's check 5
compares the *installed* bundle against the frozen 5.1.40 anchors, so with
5.1.35 still installed it would fail. Order: peer lands doctor/contract →
cache rebuilt to 5.1.40 → bridge deployed → QA.

**B4 — the shim to deploy.** The only payload delta is `bin\tmux.exe`. The
lead owns the build; I will not rebuild `dist` and will not edit repo scripts.
I need from the lead: the authoritative sha256 of the build to install, and
confirmation that the repository `dist/tmux.exe`
(`4e94e1df…`) is that build. Deployment = back up the deployed tree first,
then copy `tmux.exe` + the peer's updated `bridge-doctor.ps1` and any other
changed helper, then verify installed hashes == build hashes.

**B5 — the published v0.3.0 zip must not be used.** Its `install.cmd` is the
pre-hotfix `1bd67f75…`; installing it would undo the `5146a4cc…` MOTW hotfix.
All deployment is by explicit per-file copy from the repo build.

---

## 8. Proposed mutation sequence (nothing started; awaiting authorization)

1. Back up `C:\Users\Daniel\AppData\Local\opencode-psmux-bridge` to a
   task-owned scratch dir with per-file sha256; back up the cache root's
   `skills\*.md` (exact bytes) and the plugin subtree's bookkeeping files
   (`package.json`, `bun.lock`, `package-lock.json`) + `plugin-meta.json`.
2. Delete **exactly** `C:\Users\Daniel\.cache\opencode` (0 reparse points
   verified; nothing else on the host is touched). Do not touch
   `.local\share`, `.local\state`, `.config`, `.omo`.
3. Restore `skills\security-research\SKILL.md` and
   `skills\security-review\SKILL.md` byte-for-byte from the backup.
4. Start an **owned** `opencode serve` child on an ephemeral loopback port;
   OpenCode's own loader re-resolves `oh-my-openagent@latest` → **5.1.40** and
   rebuilds the cache; verify on-disk version + bundle sha256 + `plugin-meta`
   version + `GET /agent`.
5. Deploy the bridge: copy the lead's verified `tmux.exe` and the peer's
   updated helpers; verify installed sha256 == build sha256 for every payload
   file; prove user PATH and machine PATH hashes are unchanged.
6. QA in **one** ssh lifetime:
   - protocol smoke in a private `-L omo5140-<rand>` namespace (owned child
     server, owned namespace, `kill-server` only ever scoped with `-L`),
   - installed doctor with `OPENCODE_PORT` → exit 0 and 11/11,
   - team-layout probe: private `-L` namespace for the main arm, plus a
     default-namespace arm guarded by a **before/after baseline** of
     `list-sessions` / `list-windows` / `list-panes` and torn down with
     `kill-session -t <our-session>` only — never a bare `kill-server`, never
     touching the user's `default` session,
   - cleanup: owned session deleted by actual id, owned child killed, owned
     namespace gone, and a final baseline comparison proving the user's
     sessions, processes, PATH, config and `.omo` memory are byte-identical.
7. Write the evidence under `.omo/evidence/windows-omo5140-*` and report.
