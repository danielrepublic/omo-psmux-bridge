# Windows Update, 2026-10-19

Target: `windows-daniel`, user `Daniel`. No Linux OpenCode upgrade was requested.

| Component | Before | After |
| --- | --- | --- |
| OpenCode v1 | 1.19.0 | 1.19.3 |
| oh-my-openagent | 5.1.34 | 5.1.35 |
| psmux | 3.4.0 | 3.4.0, already latest; Authenticode signature valid |

The bridge now recognizes the single-quoted placeholder emitted by current OmO,
preserves its older shipped grammar, and shares complete Q decoding between
placeholder and attach. The doctor handles legal JSONC trailing commas and no
longer prints malformed configuration contents through parser error messages.

## Verification

| Check | Observed |
| --- | --- |
| Linux `bun test` | 429 pass, 34 Windows-only skips, 0 fail |
| Windows `bun test` | 488 pass, 0 fail |
| `bunx tsc --noEmit` | exit 0 |
| `bun run contract:verify` | 180 citations, 0 problems |
| Installed doctor harness | 205 pass, 0 fail, 0 skip; [report](windows-update-doctor-20261019.txt) |
| Windows installer config probe | 30 pass, 0 fail |
| Installed runtime protocol smoke | 35 assertions pass; [report](windows-update-runtime-20261019.json), [driver](windows-update-smoke-20261019.cjs) |
| Historical ConPTY harness on psmux 3.4.0 | [failed initial-session discovery](windows-update-conpty-20261019.json); [explicit-session probe also failed](windows-update-conpty-explicit-20261019.json); not a passing interactive-parity result |

The protocol smoke creates a private `-L` namespace and drives the installed
shim's split, capture, respawn, attach, and close paths. It also starts real OpenCode,
checks health, verifies loaded OmO agents, creates and deletes a session, and
requires the installed doctor to exit 0 with 11/11 anchors. A context-only
`noReply` message supplies a unique marker, whose actual rendering in the
attached OpenCode pane proves session content rather than placeholder text.
It makes no model call and is not an end-to-end LLM delegation test.

The separate discovery probe found the live session through Node, the installed
`.cmd` launcher, and pwsh `Start-Process` with redirected output on both the
binary and launcher routes. Those observations are in the runtime report;
empty output from all discovery routes is ruled out. The legacy outer-ConPTY
client test remains unresolved. Its `psmux.cmd` launcher is byte-identical to
the pre-update backup, and psmux itself was already 3.4.0 before this update.

## Deployment

Cross-build: Bun 1.4.3, `bun run build:win`. Windows tests used Bun 1.4.2.
Installed `bin/tmux.exe` equals the cross-build, SHA-256:

```text
4e94e1df2735dc70a559f807ce0bc2eb37b7414acca0470aaece5505e9d28e39
```

The installer smoke passed. User PATH was already correct and remained
byte-identical; the machine PATH also remained unchanged. The previous bridge
was backed up to `%TEMP%\omo-bridge-update-20261019\bridge-backup`.
After runtime smoke cleanup, only the pre-existing psmux PID 36736 remained;
no OpenCode test server or private test namespace remained active.

## Remaining Limitations

- Existing issue #2 remains: the PS5.1 helper drops embedded double quotes from
  placeholder descriptions. The smoke records this observation explicitly.
- Outer-client ConPTY attach/resize/detach coverage remains unproven; the older
  harness fails before these assertions can establish their preconditions.
- The latest OmO dependency tree reports four critical npm-audit entries,
  rooted in `seroval` and propagated through `solid-js`, `@opentui/solid`, and
  `oh-my-openagent`. No forced dependency rewrite or downgrade was performed.
- The source-level psmux contract remains pinned to 3.3.8. A protocol smoke
  against 3.4.0 does not re-verify that source contract or retire workarounds.
