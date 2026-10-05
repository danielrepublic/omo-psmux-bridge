# Installing opencode-psmux-bridge on Windows

A `tmux` shim, so that opencode's `oh-my-openagent` (OmO) plugin can open subagent
panes under [psmux](https://github.com/psmux/psmux) instead of real tmux. No WSL,
no Git Bash, no Cygwin.

Verified against **psmux 3.3.8**.

---

## What you need already installed

The bridge is a translator. It installs no multiplexer, no agent runtime, and no
plugin.

| | Check it with | If it is missing |
| --- | --- | --- |
| **psmux** 3.3.8+ | `psmux -V` | Install psmux first. The bridge cannot work without it. |
| **opencode** | `opencode -v` | Install opencode first. |
| **the OmO plugin** | your opencode config lists `oh-my-openagent` under `"plugin"` | See [Step 0](#step-0--the-one-setting-people-miss). |

---

## Step 0 — the one setting people miss

> **Without this you get zero subagent panes and no error message at all.**

`[opencode].tmux.enabled` defaults to **`false`** in the OmO plugin. With it off,
the plugin never attempts to spawn a pane — so there is nothing to report.

Open your opencode config (`opencode.json` or `opencode.jsonc`) and make sure it
contains:

```json
{
  "plugin": ["oh-my-openagent@5.1.18"],

  "tmux": { "enabled": true }
}
```

Merge it into the config you already have; do not replace the whole file.

The installer **reports** this setting and warns you if it is off. It does not
edit the file for you, because that file is yours and a setting applied silently
is a setting you never learn exists.

---

## Step 1 — install

### Option A: one line, nothing downloaded by hand

Open a terminal (PowerShell or cmd) and paste this single line:

```
iwr -useb https://github.com/danielrepublic/omo-psmux-bridge/releases/latest/download/install-bootstrap.ps1 -OutFile "$env:TEMP\omo-bridge-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\omo-bridge-install.ps1"
```

That fetches a small bootstrap script, which downloads the newest release, prints
its size and sha256, unpacks it somewhere disposable, runs the installer, and
cleans up after itself. No git, no bun, no admin rights.

### Option B: download the zip

1. Download `opencode-psmux-bridge-<version>-win-x64.zip` from the
   [releases page](https://github.com/danielrepublic/omo-psmux-bridge/releases).
2. Extract it.
3. Double-click `opencode-psmux-bridge\bin\install.cmd` — or run it from a
   terminal:

   ```
   & .\opencode-psmux-bridge\bin\install.cmd
   ```

> `install.cmd` exists because a `.ps1` unpacked from a downloaded zip carries a
> Mark-of-the-Web mark, and PowerShell's default policy refuses to run those. The
> `.cmd` wrapper is not subject to that policy and passes `-ExecutionPolicy Bypass`
> to the PowerShell it starts. Double-clicking `install.ps1` directly will fail
> on a fresh download, and the error text will not explain why.

---

## Step 2 — open a NEW terminal

A running shell keeps the environment it started with. The installer changed your
**user** PATH, so only a newly started process sees it.

Then:

```
psmux
```

`psmux.cmd` is a thin wrapper that makes bare `psmux` behave like `tmux`: it
attaches to the `default` session instead of creating a new numbered one, and it
puts the bridge's `bin` directory on the PATH **of the psmux server it starts** —
which is the only way an opencode running inside psmux can find the shim.

Inside psmux:

```
opencode
```

Now subagent panes should open.

---

## What the installer changed on your machine

Exactly one persistent thing:

| | |
| --- | --- |
| **What** | one entry prepended to your **user** `PATH`: `%LOCALAPPDATA%\opencode-psmux-bridge\bin` |
| **What was NOT touched** | the machine (`HKLM`) `PATH`, any other `PATH` entry or its order, the registry value kind, `setx`, any psmux or opencode file |

Plus the files themselves, under `%LOCALAPPDATA%\opencode-psmux-bridge`:

```
bin\tmux.exe                       the shim
bin\install.cmd  bin\install.ps1
bin\uninstall.ps1
bin\bridge-doctor.ps1  bin\bridge-doctor.cmd
bin\psmux.cmd  bin\opencode.cmd  bin\omo-opencode-port.ps1
runtime\Start-PaneFromDescriptor.ps1
state\                           call log, created on first use
```

That `bin` directory is first on `PATH` and therefore **shadows** three command
names: `tmux`, `psmux`, and `opencode`. That is intentional — it is the only way
the shim gets invoked — but it means `where opencode` and `where psmux` will name
files in the bridge directory rather than the originals. Both wrappers delegate to
the real program when they are not bridging.

---

## When it does not work

Run the doctor. It is **read-only** — it starts nothing, kills nothing, writes
nothing — and it names which of its four gates is responsible in one screen:

```
& "$env:LOCALAPPDATA\opencode-psmux-bridge\bin\bridge-doctor.cmd"
```

The four gates it checks:

| Gate | Meaning |
| --- | --- |
| **CONFIG** | `tmux.enabled` is not `true`. See [Step 0](#step-0--the-one-setting-people-miss). |
| **PATH** | the first `tmux` on `PATH` is not this bridge, or the bridge `bin` directory is absent |
| **PORT** | the opencode server is not answering a health check |
| **STALE** | a psmux server started **before** the bridge was on `PATH`. Panes inherit the *server's* environment and no client attach can change it. **Restart psmux.** |

`STALE` is the one that catches everyone. If you installed the bridge into a
psmux that was already running, every pane that server opens will keep resolving
the old `tmux`. Quit psmux entirely and start it again.

Every invocation is also logged to
`%LOCALAPPDATA%\opencode-psmux-bridge\state\shim-calls.jsonl`, one line per
call, with credential values redacted.

---

## Uninstall

```
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\opencode-psmux-bridge\bin\uninstall.ps1"
```

It removes only that one `PATH` entry, leaves every other entry in its original
order, never touches the machine `PATH`, and reports whether the directory itself
could be deleted right now. Deleting
`%LOCALAPPDATA%\opencode-psmux-bridge` afterwards leaves nothing behind.

Remember to also set `"tmux": { "enabled": false }` or remove the key in Step 0,
otherwise opencode still believes it should be managing panes.

---

## When you can delete this entirely

Each workaround the bridge performs exists because of a specific psmux defect,
and each can be dropped when the fix ships **in a release**. The tracked table,
with the upstream commit for every row, is
[`CONTRACT.md` §8](CONTRACT.md). It is deliberately not computed by comparing
version strings: `3.3.9` might contain a given fix or might not, and nothing in
the string says which.
