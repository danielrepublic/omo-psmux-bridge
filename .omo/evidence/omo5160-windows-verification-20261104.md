# OmO 5.1.60 Windows verification (2026-11-04)

Host: Windows desktop `windows-daniel`, psmux 3.4.0.

- opencode 1.19.5 (npm global `opencode-ai@1.19.5`).
- `oh-my-openagent@latest` installed at 5.1.60 via
  `opencode plugin oh-my-openagent@latest -g -f`.
- Bridge candidate built from this tree on the Windows host with Bun 1.4.2,
  target `bun-windows-x64`, into a throwaway candidate root.
- The published `v5.1.60-1` release was then installed with the release
  bootstrap (`install-bootstrap.ps1`) and the same smoke was run against the
  installed root.
- `.omo/evidence/omo5160-windows-auth-report-20261104.json`: 23/23 assertions
  pass against the installed release. It covers authenticated and
  unauthenticated split, placeholder, respawn, real OpenCode attach, team
  `send-keys`, one-use credential-file consumption, and sentinel absence from
  the call log, pane traces and descriptors.
- `.omo/evidence/omo5160-1-windows-doctor-20261104.txt`: the shipped doctor
  reports 5/5 PASS, `frozen_line_anchors_resolved=11/11`, with the installed
  OmO bundle at 5.1.60.
- `%USERPROFILE%\.omo\omo.jsonc`: JSONC parse 0 errors; valid against the
  schema it names; all seven referenced model ids resolve in `opencode models`.
- Cache and conversation history were cleared on Windows while preserving
  `auth.json`, the opencode/OmO configs, and `~/.omo/omo.jsonc`. The smoke's
  `opencode serve` child then reinstalled the 5.1.60 plugin into the cache and
  created a fresh test session; that test session was cleared again after the
  smoke.

The 5.1.60 bundle keeps the cited pane grammar byte-identical to 5.1.51 under
a constant line shift, so this pass changes citations, doctor anchors and
metadata rather than `src/*.ts` behaviour. See `CONTRACT.md` section 0.1,
"Tenth discrepancy".
