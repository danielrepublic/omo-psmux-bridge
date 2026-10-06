# Provenance of the CI-measured layout artifacts

These two files are **not** hand-copied from a local session. They were produced
by an automated run, downloaded from that run's artifact, and committed. Every
other claim of theirs is checkable; this file is what makes them checkable.

| | |
|---|---|
| Workflow | `.github/workflows/parity.yml`, job `layout-probes` |
| Runs | [37517410205](https://github.com/danielrepublic/omo-psmux-bridge/actions/runs/37517410205) (layout probes), [37518808644](https://github.com/danielrepublic/omo-psmux-bridge/actions/runs/37518808644) (all three, including the sizing probe) |
| Run conclusion | `success` on both |
| Commit under test | `c227f0128b4fb0936ebb0c37bc64fdcc95bb969d` (layout probes), `7fe273a4b20d62ee47f4d44e8f4f7cd95d774bac` (all three) |
| psmux | tag `v3.3.8`, commit `66cf61354c473b35d4f0c06c57384fc46d61ffdb` |
| psmux provenance | release asset `psmux-v3.3.8-windows-x64.zip`, extracted to `%LOCALAPPDATA%\psmux`, tag read from `scripts/contract/pins.json` rather than hardcoded |
| Bun | 1.4.2 (pinned, same value as `release.yml`) |
| Runner | `windows-latest` |
| Isolation | each probe used its own `-L` namespace (`omo_t19`, `omo_t19b`, `omo_t20`); all tore down clean (`after_teardown` empty) |

## Files

| File | Bytes | Produced by |
|---|---|---|
| `ci-current-window-survival.json` | 3443 | `scripts/windows/parity/current-window-survival.cjs`, namespace `omo_t21`, session `cur`. Run [37520072031](https://github.com/danielrepublic/omo-psmux-bridge/actions/runs/37520072031), commit `aa382bf`. Settles CONTRACT.md section 9.4. |
| `ci-main-pane-width-probe.json` | 3784 | `scripts/windows/parity/main-pane-width-probe.cjs`, namespace `omo_t20`, session `mpw`. Run 37518808644. |
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

## What the sizing probe establishes

`ci-main-pane-width-probe.json` settles CONTRACT.md section 3.9 rules 1a and 1b,
which until now were the document's only "unrecorded, not measured" claims about
the layout. Its `verdict` block:

```json
{ "rule_1a_percent_form_ignored": true,
  "rule_1b_option_alone_inert":  true,
  "rule_1b_followup_applies":    true,
  "rule_1b_order_matters":       true,
  "baseline_share": 0.5917 }
```

Read as a sequence of main-pane shares of the window width:

| step | share | what it shows |
|---|---|---|
| baseline, option never set | 0.5917 | psmux's ~60% default |
| `set-window-option main-pane-width "50%"` | 0.5917 | the `%` form is silently dropped — rule 1a |
| then `select-layout` | 0.5917 | nothing to apply, because nothing was stored |
| `set-window-option main-pane-width "50"` | 0.5917 | storing alone changes nothing — rule 1b's premise |
| then `select-layout` | **0.4917** | the follow-up is what makes it take effect — rule 1b's remedy |
| `select-layout`, then `main-pane-width "40"` | 0.4917 | setting after a layout is inert — rule 1b's ordering claim |

The share is recorded rather than the raw column count on purpose. A bare
`pane_width` cannot distinguish "50% of 199" from "50% of 120", and that is
precisely how the single `119` in `issue-1-team-layout-probe-after.json` came to
read as proof of rule 1a when it was psmux's 60% default.

**Scope.** One session, one window, one client, sequential calls, against v3.3.8.
It says nothing about a session with several windows, and nothing about two
clients at once.

## Reproducing

```bash
gh workflow run parity.yml --ref main
gh run download <run-id> -n parity-probe-output
```

The workflow does not commit probe output. It publishes an artifact, and a human
or a follow-up change commits it, because CONTRACT.md admits a measurement as
evidence only when the artifact is under version control and an automated commit
would let a probe rewrite the specification unread.