# Windows OMO 5.1.40: Lead Verification

Date: 2026-10-21. Host: WINDOWS-DANIEL. This is a new verification record;
the earlier execution reports have not been overwritten.

## Final State

- Windows OpenCode remains 1.19.3; psmux remains 3.4.0.
- Installed OMO plugin is 5.1.40. Its bundle SHA-256 is
  `d3d603598b6f0a9ce5da8681d6f0aa680220fd8216b314cfcf20a7bb127b36fd`.
- Installed bridge `tmux.exe` SHA-256 is
  `4e94e1df2735dc70a559f807ce0bc2eb37b7414acca0470aaece5505e9d28e39`.
- Installed doctor SHA-256 is
  `426c8d3183ad5d0806f6ed0dce221aba0516538562c4559890ca2f3116ff3269`.
- Installed installer SHA-256 is
  `109d0ac465047009437bc64b625769da492f433316c21a1a2a6d060a36d80fd3`.
- The install.cmd MOTW hotfix remains installed, SHA-256
  `5146a4cc6bba61c420e402a185edc4318833330678529c1a787f2830264c8613`.

## Lead-Owned Runtime QA

The lead personally reran the inspected protocol driver through SSH after
checking its SHA-256 against the local copy. The new report is
[windows-omo5140-lead-smoke-20261021T044345Z.json](windows-omo5140-lead-smoke-20261021T044345Z.json).

All 39 assertions passed: plugin version and bundle, actual plugin agent
loading, placeholder literal-text safety, split, respawn, real OpenCode attach
with a context-only marker, close, and doctor exit 0 with 11/11 anchors.
The QA conversation, private psmux namespace and owned server were cleaned up.
No model call was made. Existing psmux PIDs were unchanged by this QA run.

The earlier artifacts were also read directly: cache rebuild 28/28, deployment
23/23, team-layout replay 25/25, Windows tests 491 pass / 0 fail, and doctor
harness 205 pass / 0 fail / 0 skip. Linux tests were 432 pass / 34 Windows-only
skips / 0 fail; typechecking passed. Contract verification was rerun after the
documentation correction and reported 180 citations / 0 problems.

## Final Cleanup And Limits

The lead removed only the two task-created duplicate files under
`%USERPROFILE%\.cache\opencode\skills\skills` after verifying their hashes
matched both top-level skill files and the external backup. The two top-level
skills remain byte-identical to their originals. The full cache and bridge
backup remains at `%TEMP%\omo5140-backup`.

The incorrect new discrepancy count in CONTRACT.md was corrected to 71 moved
citations and 19 unchanged citations; no runtime source changed.

PowerShell 5.1 still drops embedded double quotes in placeholder descriptions
(existing issue #2). Outer-client ConPTY interactive parity remains unproven.
The psmux source contract stays pinned to 3.3.8; runtime smoke on 3.4.0 does
not retire its workarounds. Markdown and PowerShell LSPs are not configured;
native Windows tests and the doctor harness supply their execution checks.

All team tasks were terminal and the team was shut down and deleted.
No git commit, push, release, or tag was created.
