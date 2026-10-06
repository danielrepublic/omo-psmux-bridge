# Provenance of the CI-measured layout artifacts

These two files are **not** hand-copied from a local session. They were produced
by an automated run, downloaded from that run's artifact, and committed. Every
other claim of theirs is checkable; this file is what makes them checkable.

| | |
|---|---|
| Workflow | `.github/workflows/parity.yml`, job `layout-probes` |
| Run | https://github.com/danielrepublic/omo-psmux-bridge/actions/runs/37517410205 |
| Run conclusion | `success` |
| Produced at | 2026-10-06T19:14:04Z |
| Commit under test | `c227f0128b4fb0936ebb0c37bc64fdcc95bb969d` |
| psmux | tag `v3.3.8`, commit `66cf61354c473b35d4f0c06c57384fc46d61ffdb` |
| psmux provenance | release asset `psmux-v3.3.8-windows-x64.zip`, extracted to `%LOCALAPPDATA%\psmux`, tag read from `scripts/contract/pins.json` rather than hardcoded |
| Bun | 1.4.2 (pinned, same value as `release.yml`) |
| Runner | `windows-latest` |
| Isolation | each probe used its own `-L` namespace (`omo_t19`, `omo_t19b`); both tore down clean (`after_teardown` empty) |

## Files

| File | Bytes | Produced by |
|---|---|---|
| `ci-layout-which-window.json` | 1777 | `scripts/windows/parity/layout-which-window.cjs`, namespace `omo_t19b`, session `lay2` |
| `ci-layout-probe.json` | 3397 | `scripts/windows/parity/layout-probe.cjs`, namespace `omo_t19`, session `lay` |

## What the run establishes, and what it does not

`ci-layout-which-window.json` answers the question in CONTRACT.md section 9: an
untargeted `select-layout <name>` **does** apply, and it applies to **the window
the client most recently made current** — two trials, each changing only the
window it had made current, and neither touching the other.

Two things it does **not** establish, and they are recorded here so this file
cannot be read as a blanket clearance:

- **One client, two windows, sequential trials.** It does not show what happens
  with two clients attached at once, which is a different question.
- **Valid layout names only.** Its `invalid_layout_name` entry shows an unknown
  name is a silent no-op. That refutes a claim CONTRACT.md section 9 used to make
  about a fallback to `even-horizontal`; the correction is recorded there.

`ci-layout-probe.json` is included for completeness but **its `which_window`
control cannot answer the question it was written for.** It applies
`even-horizontal` to both windows in turn (`layout-probe.cjs:94`), and by that
point window 0 is already in `even-horizontal` — the layout string `f890` is
59/60, an even split. So "unchanged" is the correct result of re-applying the
layout already in effect, and it is not evidence about which window is current.
Read `ci-layout-which-window.json` for that; it varies the layout name so a
change is actually possible. This is a defect in the probe, not in psmux.

## Reproducing

```bash
gh workflow run parity.yml --ref main
gh run download <run-id> -n parity-probe-output
```

The workflow does not commit probe output. It publishes an artifact, and a human
or a follow-up change commits it, because CONTRACT.md admits a measurement as
evidence only when the artifact is under version control and an automated commit
would let a probe rewrite the specification unread.