# CONTRACT: the OmO pane-command grammar, and what the bridge does to it

This document freezes the contract between stock **oh-my-openagent (OmO)** and the
**psmux** terminal multiplexer on Windows, as mediated by this repository's bridge.

It is a specification, not a status report. `src/translate.ts` implements it; the
translator's unit tests are written against it; the parity sweep measures it.

Every clause below is one of exactly two things:

1. **A citation.** Written as `` `index.js:NNNN` → `<exact text>` `` for the OmO
   bundle, or `` `src/<file>.rs:NNNN` → `<exact text>` `` at a stated ref for
   psmux. The quoted text is a literal substring of the cited line. Citations are
   re-resolved **mechanically**, by `bun run contract:verify`, which reads every
   citation in this file, resolves it against the two pinned trees named in
   section 0, and fails on the first mismatch. It is not a suggestion and it is
   not advisory: it runs in CI on every push and a red build means a citation
   here is wrong.

   The verifier is `scripts/contract/verify-citations.ts`, the pins it reads are
   `scripts/contract/pins.json`, and the trees it needs are materialised by
   `bun run contract:fetch`. **Added 2026-10-07.** Until then this paragraph
   said citations were re-resolved by hand and that "there is no checker script
   in this repository — no `scripts/` entry, no npm script, no CI step", so a
   citation was "exactly as trustworthy as the last person who ran `sed`". That
   was true and it lasted a few months: the pin moved from `5.1.18` to `5.1.21`
   and from `/tmp/opencode/psmux-src` to nothing at all, and for a window no
   citation in this document could be re-checked by anyone. The prose procedure
   below is kept because it explains what the checker does, and because the
   checker's output is only as good as someone's decision to run it — but the
   enumeration of every citation is now mechanical.
2. **An inference.** Prefixed `INFERRED:` followed by the reasoning. An
   inference is never dressed up as a citation.

A third category turns up in draft material and is **not admissible**: a
`Measured on …` / `Verified on …` block whose run left no artifact under version
control. No script, log or captured output for the section 3.9 geometry tables
exists in this repository, and the one capture of the section 9 `select-layout`
result lives in the `.omo/` scratch tree, which is not this repository's record
of anything. Where such a block survives, it is marked unrecorded and states
what would settle it; it is never the ground for a conclusion.

`.omo/` is git-ignored with one exception: `.omo/evidence/` is tracked, and it
is tracked wholesale rather than file by file. 16 of the 19 `task-*` artifacts
there are cited by this document or by `scripts/windows/bin/omo-opencode-port.ps1`,
which ships in the release archive, so a shipped script points at evidence that
has to exist. The three uncited ones are siblings from the same runs; dropping
them would be arbitrary, and leaving them untracked-but-visible would put them
one `git add -A` from being committed by accident.

The exception narrows what "under version control" means here; it does not widen
it. An artifact outside `.omo/evidence/` — a session transcript, a scratch draft
— is still not a record of anything, and a claim resting only on one is still
inadmissible. Section 7.1 had exactly that defect and was corrected on
2026-10-07.

If a clause is neither a citation, an inference, nor an explicitly marked
unrecorded observation, it does not belong in this document. Nothing here records
an aspiration as a fact.

## How to re-verify every citation

```bash
bun run contract:fetch    # materialise both pinned trees
bun run contract:verify   # check every citation in this file; non-zero on drift
```

That is the whole mechanism, and section 14 step 1 is now a green build rather
than a person reading `sed` output. What follows is what the checker does, kept
because it is the specification it implements — and because when the checker
disagrees with it, one of the two is a bug worth finding.

Each citation is a backtick-quoted `PATH[:LINE[-LINE]]`, an arrow, and the text
the cited line is expected to contain. The quoted text is compared as a literal
substring of the cited line, after one level of markdown unescaping, because
this file escapes its own quotes: a citation inside a code span carries `\``,
`\\` and `\"` in the markdown and the bare characters in the source.

A citation whose path is `index.js` resolves against the OmO bundle pin in
section 0.1; every other path — `src/*.rs`, `docs/*.md`, `installer/*.nsi` —
resolves against the psmux tree in section 0.2. For a range `A-B`, the expected
text may be on any single line of the range or span the range joined by newlines.

To do one of these by hand, which is occasionally faster than starting the
checker when you are chasing a single line:

```bash
sed -n 'NNNNp' \
  $HOME/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent/dist/index.js
```

If the pinned tree is not on disk, `contract:verify` reports `PIN_TREE_MISSING`
rather than quietly resolving against whatever version happens to be installed.
That is deliberate and it is the pin doing its job: the pin is the validity
condition (section 14), so an absent pin is not a licence to read the nearest
version and call it verified.

The psmux citations resolve against `src/<file>.rs` inside the pinned checkout
named in section 0.2 — **and only that checkout**, which is why the checker
verifies `git rev-parse HEAD` against the pinned commit before reading anything.
The same `sed -n` against the wrong tree returns a confident, wrong line number,
which is worse than no answer at all.

The file is referred to as `index.js` throughout, but its real path is
`dist/index.js` inside the package.

---

## 0. The two sources of truth, pinned

### 0.1 OmO

**Which tree to read:** always `@latest`, because that is where OmO actually
lives and where it keeps living.

```
$HOME/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent/dist/index.js
```

**Which version this document was last verified against:** **5.1.21**, read from
that package's own `package.json`. This number is a *record of a past
verification*, not an install instruction, and the two must not be confused —
that confusion is what made the pin unusable before.

`scripts/contract/pins.json` carries both halves as `omo.bundleGlob` and
`omo.verifiedAgainst`, and the checker compares them on every run:

| installed in `@latest` | `omo.verifiedAgainst` | result |
|---|---|---|
| 5.1.21 | 5.1.21 | clean |
| 5.1.22 | 5.1.21 | `PIN_DRIFT`, naming both |

**A `PIN_DRIFT` on the OmO side is routine, not an incident.** OmO ships with the
agent and moves to a new version often, so `@latest` will outrun this document
regularly. What `PIN_DRIFT` means is precisely: *re-verify the 90 bundle
citations against the new bundle, then bump `omo.verifiedAgainst`.* Suppressing
it would be worse than useless — it would turn "the document is stale" into
silence, which is the exact failure this whole mechanism exists to prevent.

CI is the deliberate exception. `.github/workflows/contract.yml` installs the
exact `omo.verifiedAgainst` version from npm rather than `@latest`, so a CI run
does not depend on which OmO shipped that morning and a green build means the
same thing today as it did last week. Reproducibility on the machine that
asserts, freshness on the machine that reads.

**Third discrepancy, recorded 2026-10-07.** The pin above was `5.1.18`; the tree
for `5.1.18` no longer exists on this host. The second recorded discrepancy
(§0.1, earlier) had already re-resolved all bundle citations against `5.1.19`
and found every number still correct. The tree is now at **`5.1.21`**, three
patch releases further on, and **all 90 bundle citations verify against it**,
each on its cited line with its cited text. So the line numbers have survived
three releases — but that is now a *measured* fact about three specific
releases, recorded here, rather than an assumption carried forward.

The count is 90, not the 74 stated in the earlier discrepancy. 74 was an
undercount, and it was wrong twice over: a hand pass that only matched citations
starting a markdown list item sees 87 of the 90, because three are written as
continuation lines. `bun run contract:verify` counts all 90, which is the number
that matters and the reason the count is mechanical now.

**5.1.19 → 5.1.21 changed nothing this document depends on.** Every cited line
in `createTeamLayoutInCallerWindow`, `resolveCallerTmuxSession`, the layout
triple at `index.js:8914`/`8920-8921`/`8937`, the five payload verbs, the `-e`
auth environment, and the `TeamModeConfigSchema` default still resolves
verbatim. The contract's claims survive; the pin did not, which is exactly the
asymmetry §14 step 1 exists to catch.

### 0.2 psmux

All psmux citations are from **tag v3.3.8**, commit
`66cf61354c473b35d4f0c06c57384fc46d61ffdb`, checked out at **`.contract/psmux`**
— inside this repository, git-ignored. psmux's master branch diverges by roughly
17k lines, so line numbers do not transfer between the two trees. Every psmux
citation in this document states v3.3.8. Nothing here is cited from master
except where a master-only fact is explicitly labelled as such, and those are
cited as commits rather than as line numbers.

**The checkout path moved, 2026-10-07, and this is a correctness fix rather than
a preference.** The pin used to be `/tmp/opencode/psmux-src`. That path is under
`/tmp`, so the checkout evaporated, and with it the only way to re-resolve the 74
psmux citations in this document: on 2026-10-07 both `/tmp/opencode/psmux-src`
and `/tmp/opencode/psmux` were **absent**, and the document's own validity
condition (§14) could not be checked at all. A pin that can disappear between
sessions is not a pin. `.contract/psmux` is git-ignored, so the tree never
enters version control, and `bun run contract:fetch` recreates it at the pinned
commit from `scripts/contract/pins.json`.

**Why a single checkout, still.** The original warning about `/tmp/opencode/psmux`
was that a second, newer clone sat beside the pinned one and returned confident
wrong line numbers. That hazard is now structural rather than advisory: exactly
one checkout path is named, in exactly one place (`pins.json`), and the checker
verifies `git rev-parse HEAD` against the pinned commit before reading a single
line. A tree at the wrong commit is `PIN_DRIFT`, not a silently wrong answer.

**Re-verified 2026-10-07 against a fresh clone:** all **84** psmux citations
resolve on their cited line with their cited text — 84, not the 74 the earlier
discrepancy counted, for the same reason the bundle count moved. The 2
citations that failed this audit were `omo-psmux-bridge.md:609` and
`omo-psmux-bridge.md:610`, which are not psmux citations at all; see §7.1, where
they are demoted to what the preamble's rules require.

INFERRED: this document goes stale the moment either tool is upgraded. The
version pins above are the whole of the validity condition, so they are stated
before any claim rather than at the end.

---

## 1. The hardcoded shell

OmO does not ask what shell the platform has. It hardcodes POSIX `sh`, as a
module-level constant with no environment override, no platform branch, and no
configuration key:

- `index.js:8343` → `var TMUX_COMMAND_SHELL = "/bin/sh";`

This is the single most important clause in the document. Every payload OmO
emits begins with `/bin/sh -c "`, which does not exist on a stock Windows
machine. That is the entire reason a bridge exists.

### 1.1 The quoting helper

Values interpolated into the nested command are wrapped in single quotes and then
escaped. The escaping order is: single-quote replacement first, then a blanket
backslash doubling, then `$`, then backtick, then double-quote:

- `index.js:8318` → `function shellQuoteForNestedCommand(value) {`
- `index.js:8319` → `value.replaceAll("'`

### 1.2 The two payload templates

There are exactly **two** command strings OmO ever builds, and both hardcode the
shell from section 1.

**Template A: the attach payload.** Used when a pane becomes a real, focusable
subagent session.

- `index.js:8321` → `function buildTmuxAttachCommand(serverUrl, sessionId, directory = process.cwd()) {`
- `index.js:8325` → `opencode attach ${escapedUrl} --session ${escapedSessionId} --dir ${escapedDirectory}`

Rendered shape, with `Q` standing for whatever `shellQuoteForNestedCommand`
produced:

```
/bin/sh -c "opencode attach <Q(serverUrl)> --session <Q(sessionId)> --dir <Q(directory)>"
```

**Template B: the placeholder payload.** Used for the pane's brief pre-attach
life, so the pane is titled and survivable rather than dead on arrival.

- `index.js:8327` → `function buildTmuxPlaceholderCommand(description) {`
- `index.js:8329` → `OMO subagent pane ready: ${escapedDescription}`
- `index.js:8329` → `while :; do sleep 86400; done`

Rendered shape, with `E` standing for `shellEscapeForDoubleQuotedCommand`
(a different helper from the one above, and correct for a double-quoted
context):

```
/bin/sh -c "printf '%s\n%s\n' \"OMO subagent pane ready: <E(description)>\" \"Focus this pane to attach.\"; while :; do sleep 86400; done"
```

INFERRED: Template B's infinite `sleep 86400` loop is what keeps the placeholder
pane alive, which is why the placeholder must survive whatever the transport
does with `/bin/sh`. The inference is from the loop's presence and from the prior
session's observation that the pane survives; the citation supports only that the
loop exists in the template.

---

## 2. The `-e` auth environment, and the empty case

OmO passes server credentials to the pane as `-e NAME=VALUE` argv pairs, built by
one function:

- `index.js:8331` → `function buildPaneAuthEnvironmentArgs() {`
- `index.js:8332` → `const password = process.env.OPENCODE_SERVER_PASSWORD;`
- `index.js:8334` → `return [];`
- `index.js:8336` → `const args = ["-e", \`OPENCODE_SERVER_PASSWORD=${password}\`];`
- `index.js:8339` → `args.push("-e", \`OPENCODE_SERVER_USERNAME=${username}\`);`
- `index.js:8341` → `return args;`

### 2.1 The empty-`-e` case is the normal case

`OPENCODE_SERVER_PASSWORD` is unset in the ordinary case, so
`buildPaneAuthEnvironmentArgs()` returns an **empty array** (`index.js:8334`)
and the `-e` pairs simply do not appear in argv. The consequence for the
translator is precise and load-bearing: **`-e` must be a genuinely optional
element of the grammar, with a real zero-occurrence path.** A parser that
assumes at least one `-e` pair, or that requires a password to be set, is wrong
about the common case rather than an edge case.

INFERRED: because the empty case is the default, any bridge logic that
special-cases "the credential args" must be written against the empty array
first and treat the populated case as the exception. This follows directly from
`index.js:8334` returning `[]` whenever the password is falsy.

### 2.2 Credential in argv, recorded, not fixed

The password value is placed into argv with no escaping:

- `index.js:8336` → `OPENCODE_SERVER_PASSWORD=${password}`

So it is visible to any process listing on the machine. This is recorded as a
non-blocking security note and explicitly **not** in scope to fix, because the
only fix would be patching OmO. Two consequences bind the bridge:

1. The bridge's own logging must redact `-e OPENCODE_SERVER_PASSWORD=...` values.
2. Because the value is already in argv before the bridge ever sees it, the
   bridge must not make it *more* exposed, which is why the argv it constructs
   for the respawn path is not logged in full.

INFERRED: the redaction requirement follows from the credential being present in
argv; no code in the bundle was found that redacts it, and the bridge is a
separate process that would otherwise print it verbatim.

---

## 3. The five payload-carrying verbs, and their exact argv

A verb "carries a payload" when OmO appends one of the two templates from
section 1 as a positional operand. There are **five** such argv shapes, across
five call sites. A sixth site is a sixth shape of one of them.

Every one is followed by a `select-pane` title call.

### 3.1 `split-window` (the `isolation: "inline"` path)

- `index.js:8401` → `deps.isCmuxCompatEnvironment() ? buildTmuxAttachCommand`
- `index.js:8402` → `const args = [`
- `index.js:8403` → `"split-window",`
- `index.js:8404` → `splitDirection,`
- `index.js:8409` → `...targetPaneId ? ["-t", targetPaneId] : [],`
- `index.js:8410` → `...authEnvArgs,`
- `index.js:8411` → `initialCmd`
- `index.js:8413` → `const result = await runTmuxCommand(tmux, args);`

Exact argv, in order:

```
split-window
  <splitDirection>              # "-h" by default, or "-v"
  -d
  -P
  -F
  #{pane_id}
  [-t <targetPaneId>]           # present only when targetPaneId is set
  [-e NAME=VALUE]...            # zero or more, see section 2.1
  <payload>
```

INFERRED: `splitDirection` defaults to `-h` because the function signature
declares `splitDirection = "-h"`; the bridge need not care which value it sees,
only that it occupies the second position and is a bare flag.

### 3.2 `respawn-pane` with the placeholder (`replaceTmuxPane`)

- `index.js:8500` → `const placeholderCmd = buildTmuxPlaceholderCommand(description);`
- `index.js:8501` → `["respawn-pane", "-k", ...authEnvArgs, "-t", paneId, placeholderCmd]`

Exact argv, in order:

```
respawn-pane
  -k
  [-e NAME=VALUE]...
  -t
  <paneId>
  <payload>                     # placeholder template
```

This is the single-line form. Note there is **no `--`** before the payload. That
absence is the whole of defect 1 in section 7.

### 3.3 `respawn-pane` with the attach command (`activateTmuxPane`)

Same verb and same shape, but multi-line and carrying Template A instead of
Template B:

- `index.js:8547` → `const opencodeCmd = buildTmuxAttachCommand(serverUrl, sessionId, directory);`
- `index.js:8548` → `const result = await deps.runTmuxCommand(tmux, [`
- `index.js:8549` → `"respawn-pane",`
- `index.js:8550` → `"-k",`
- `index.js:8554` → `opencodeCmd`

Exact argv, in order:

```
respawn-pane
  -k
  [-e NAME=VALUE]...
  -t
  <paneId>
  <payload>                     # attach template
```

### 3.4 `new-window` (`spawnTmuxWindow`)

- `index.js:8617` → `const args = [`
- `index.js:8618` → `"new-window",`
- `index.js:8619` → `"-d",`
- `index.js:8621` → `ISOLATED_WINDOW_NAME,`
- `index.js:8624` → `"#{pane_id}",`
- `index.js:8626` → `placeholderCmd`
- `index.js:8647` → `var ISOLATED_WINDOW_NAME = "omo-agents";`

Exact argv, in order:

```
new-window
  -d
  -n
  omo-agents
  -P
  -F
  #{pane_id}
  [-e NAME=VALUE]...
  <payload>                     # placeholder template
```

The window name is the literal `omo-agents`, from `index.js:8647`. There is no
`-t` on this shape.

### 3.5 `new-session`, and its already-exists variant (`spawnTmuxSession`)

This is one call site producing **two** argv shapes, chosen by a runtime branch:

- `index.js:8727` → `const args = sessionAlreadyExists ? [`
- `index.js:8728` → `"new-window",`
- `index.js:8730` → `isolatedSessionName,`
- `index.js:8736` → `] : [`
- `index.js:8738` → `"-d",`
- `index.js:8741` → `...sizeArgs,`
- `index.js:8746` → `placeholderCmd`

When the session does **not** exist:

```
new-session
  -d
  -s
  <isolatedSessionName>
  [-x <width> -y <height>]     # present only when sizeArgs is non-empty
  -P
  -F
  #{pane_id}
  [-e NAME=VALUE]...
  <payload>                     # placeholder template
```

When it **does** exist:

```
new-window
  -t
  <isolatedSessionName>
  -P
  -F
  #{pane_id}
  [-e NAME=VALUE]...
  <payload>                     # placeholder template
```

INFERRED: `sizeArgs` is empty when the source pane's dimensions cannot be
read, so the `-x`/`-y` pair is conditional rather than always present. The
translator must tolerate its absence; it must not require it.

### 3.6 The trailing title call, on every one of the five

Every payload verb is immediately followed by a title call:

- `index.js:8418` → `const title = \`omo-subagent-${description.slice(0, 20)}\`;`
- `index.js:8419` → `["select-pane", "-t", paneId, "-T", title]`
- `index.js:8506` → `const title = \`omo-subagent-${description.slice(0, 20)}\`;`
- `index.js:8507` → `["select-pane", "-t", paneId, "-T", title]`

Exact argv:

```
select-pane
  -t
  <paneId>
  -T
  omo-subagent-<first 20 chars of description>
```

`select-pane` carries no payload, so by the definition in section 3 it is not
one of the five. It is listed because it always follows one of them.

### 3.7 Pane-id capture

- `index.js:8414` → `const paneId = result.output;`
- `index.js:8415` → `if (result.exitCode !== 0 || !paneId) {`

The pane id is read from `result.output` and is **not trimmed**, and an empty
string counts as failure. So the bridge must not introduce a trailing newline
into stdout of a `split-window`, `new-window` or `new-session` it forwards. This
is a byte-transparency requirement on the *response* side, not just the request
side.

### 3.8 Teardown, and the success-on-failure rule

- `index.js:8448` → `["send-keys", "-t", paneId, "C-c"]`
- `index.js:8451` → `["kill-pane", "-t", paneId]`
- `index.js:8453` → `result.exitCode !== 0 && /can't find pane/i.test(trimmedStderr)`

A `kill-pane` against an already-dead pane is **treated as success** by OmO, but
only when the stderr matches `/can't find pane/i`. If psmux's wording for that
condition differs, every close reports failure. This makes psmux's exact stderr
text load-bearing for teardown, and it is why todo 5 probes it.

### 3.9 Everything else is pass-through, except three named layout rules

The bundle emits additional tmux verbs that carry no payload, including
`select-layout` (section 9), `set-window-option`, `resize-pane`, `has-session`,
`display`, `list-sessions`, and `send-keys`.

INFERRED: by the definition in section 3, none of these carries a payload, so
all of them are `pass-through` **at the classification level**, and the
translator's classification of them must be exactly that. This is derived from the
payload definition plus the cited argv shapes; no separate census citation is
offered, and an agent-authored verb via the `interactive_bash` tool is likewise
unclassifiable ahead of time and must default to pass-through.

That classification is unchanged. `classifyArgv` still has no verb arm for
`set-window-option` or `resize-pane`, and no `RecognisedKind` was added, because
neither verb carries a payload and the payload grammar is not what is wrong with
them. What is wrong is **what psmux does with them afterwards**, and that is a
translate-stage concern. Three named rules carve the carve-out, and each one is
pinned to a named psmux defect. Together they are what makes the main pane occupy
the LEFT half of the window with the subagent panes stacked in the RIGHT half.

**What the carve-out costs, stated before the rules.** This section is not
"pass-through with a footnote". Of the three rules:

- 1a rewrites an argument the caller sent (`set-window-option main-pane-width
  "50%"` → `… "50"`).
- **1b ADDS a backend invocation the caller never asked for.** For every
  `set-window-option` on a `main-pane-*` option, the bridge issues a second psmux
  command — `select-layout main-vertical` or `select-layout main-horizontal` —
  after the one OmO sent. On the three-command spawn sequence below the caller
  sends three invocations and the backend sees four.
- 1c drops a command outright and exits 0.

Nothing else in this document adds, drops or rewrites a backend command, and 1b
is the only place the bridge originates a call. A reader who assumes "the bridge
forwards what OmO sends, with the documented exceptions in section 7" will be
wrong about 1b, so it is disclosed here rather than left to be discovered from a
process trace.

The three commands OmO emits around every subagent spawn and every subagent
close, in this order, as three separate process invocations:

| # | argv | source |
|---|---|---|
| 1 | `select-layout main-vertical` | `index.js:8914` |
| 2 | `set-window-option <main-pane-width\|main-pane-height> <n>%` | `index.js:8920-8921` |
| 3 | `resize-pane -t <mainPaneId> -x <cells>` | `index.js:8937` |

`main-vertical` is the correct layout and the bridge does not change which layout
is used: in psmux it is the `Horizontal` split whose first child is the main pane
(`src/layout.rs:1129-1136`), i.e. main on the left and the rest in a right column.
`main-horizontal` would put the main pane on top.

#### Rule 1a — one trailing `%` is stripped from a main-pane sizing option

When the verb is `set-window-option`, `setw`, `set-option` or `set`, and the
option being set is `main-pane-width` or `main-pane-height`, and its value ends in
`%`: forward the command with exactly one trailing `%` removed. Nothing else
moves — same verb, same flags, same order, same target.

- `src/server/options.rs:527` → `"main-pane-width" => {`
- `src/server/options.rs:528` → `if let Ok(n) = value.parse::<u16>() { app.main_pane_width = n; }`
- `src/config.rs:1207` → `"main-pane-width" => {`

psmux parses the value as a bare `u16` in both places. `"50%".parse::<u16>()`
fails, the `if let Ok(n)` arm never fires, and there is no error: the option is
simply never set. tmux accepts `50%`, so OmO's spelling is correct and psmux's
parser is the defect.

**Partly corroborated by psmux's own test suite, 2026-10-07.** Two independent
supports for the premise, neither of which is a measurement of this bridge:

- `tests-rs/test_config_exhaustive.rs:1467` → `fn cli_set_main_pane_width() {`
- `tests-rs/test_config_exhaustive.rs:1470` → `assert_eq!(app.main_pane_width, 60);`

That test drives `set-option -g main-pane-width 60` and asserts the option lands,
so **the integer path is asserted by psmux's authors, not merely read off a
source line.** The rejection of `"50%"` is then not an empirical claim at all but
a guarantee of the language: `str::parse::<u16>` accepts only decimal digits, and
there is no trailing-character allowance, so a `%` cannot survive it. Between the
two, this rule's premise no longer rests on the author's reading of two lines.

**MEASURED 2026-10-07. This rule is no longer inference.** Evidence
`.omo/evidence/ci-main-pane-width-probe.json`, produced by an automated
`windows-latest` run of `main-pane-width-probe.cjs` against v3.3.8; provenance
including run id and commit under test is in `.omo/evidence/README-parity-ci.md`.
Main-pane share of the window width, read at every step:

| step | share | what it shows |
|---|---|---|
| baseline, option never set | **0.5917** | psmux's ~60% default, matching `src/layout.rs:1096` |
| `set-window-option main-pane-width "50%"` | **0.5917** | the `%` form is stored as nothing — this rule's premise |
| then an untargeted `select-layout main-vertical` | 0.5917 | nothing to apply, because nothing was stored |
| `set-window-option main-pane-width "50"` | 0.5917 | the bare form stores, but applying it is deferred |
| then an untargeted `select-layout main-vertical` | **0.4917** | the stored 50 takes effect only once a layout runs |

0.5917 against a `min(95)`-capped 60 default is psmux's own fallback, and 0.4917
is the stored 50. Both numbers are shares rather than column counts because a
bare `pane_width` cannot distinguish "50% of 199" from "50% of 120" — which is
exactly how the single `119` in `issue-1-team-layout-probe-after.json` came to
read as proof of this rule when it was the 60% default instead.

**Scope of the measurement.** One session, one window, one client, sequential
calls, v3.3.8. It does not cover a multi-window session, nor two clients at
once, and it does not cover `main-pane-height`.

The arithmetic this section used to carry as INFERRED is now settled: `"50%"`
leaves the main pane at psmux's default, and `"50"` followed by a layout moves it
to the stored share. Nothing further is needed from a host run for this rule.

A value with no `%`, or any other option name, is forwarded byte-identically.

#### Rule 1b — the matching layout is re-applied after the option is set

Because of rule 1a, forwarding `set-window-option` alone changes nothing: psmux
reads the sizing option from **inside** the layout application, so setting it does
not re-lay-out.

- `src/layout.rs:1094` → `// Determine main-pane percentage`
- `src/layout.rs:1096` → `let main_v_pct = if app.main_pane_width > 0 { app.main_pane_width.min(95) } else { 60 };`
- `src/layout.rs:1129` → `"main-vertical" | "main-v" => {`
- `src/layout.rs:1136` → `sizes: vec![main_v_pct, 100 - main_v_pct],`
- `src/layout.rs:1144` → `sizes: vec![main_v_pct, 100 - main_v_pct],`
- `src/layout.rs:1095` → `let main_h_pct = if app.main_pane_height > 0 { app.main_pane_height.min(95) } else { 60 };`
- `src/layout.rs:1109` → `"main-horizontal" | "main-h" => {`

`1136` is the two-pane shape and `1144` the nested one; both put the main pane
first in a root `Horizontal` split, which is why the rule's injected command is
layout-specific rather than layout-agnostic.

So the bridge runs a **second** psmux command after the corrected
`set-window-option`:

| option set | layout re-applied |
|---|---|
| `main-pane-width` | `select-layout main-vertical` |
| `main-pane-height` | `select-layout main-horizontal` |

This is the injection disclosed in this section's opening: the caller sent one
`set-window-option`, and the backend sees `set-window-option` followed by
`select-layout`. The injected call is not derived from the caller's argv beyond
the option name; nothing in it is a rewrite of anything OmO sent.

The mapping is not a guess. `main_pane_width` is read by the `main-vertical` arm
and `main_pane_height` by the `main-horizontal` arm, and OmO emits exactly these
two options for its two `main-*` layouts:

- `index.js:8919` → `if (layout.startsWith("main-")) {`
- `index.js:8920` → `const dimension = layout === "main-horizontal" ? "main-pane-height" : "main-pane-width";`

The re-applied command carries **no `-t`**, matching the `select-layout` shape
OmO itself emits at `index.js:8914`, and carries the same leading `-L` / `-S` /
`-f` globals as the primary command, so both reach the same psmux server.
Section 9 records separately that an injected `-t` would be discarded by psmux
before dispatch; this rule does not rest on that, and would be unchanged if
section 9 settled the other way. Its stdout, stderr and exit code are all
discarded: OmO spawns its own layout calls with `stdout: "ignore", stderr:
"ignore"` (`index.js:8915-8916`, `index.js:8921`) and awaits each without reading
a code (`index.js:8918`, `index.js:8922`), and the primary command's exit code is
the only one OmO branches on (`index.js:8415`).

**MEASURED 2026-10-07, and this rule needed it more than rule 1a did.** The same
run as rule 1a — `.omo/evidence/ci-main-pane-width-probe.json` — tests both halves
of this rule directly, and its `verdict` block reads `rule_1b_option_alone_inert:
true`, `rule_1b_followup_applies: true`, `rule_1b_order_matters: true`.

| step | share | what it shows |
|---|---|---|
| `set-window-option main-pane-width "50"`, nothing else | 0.5917 | storing the option applies **nothing** — this rule's premise |
| then an untargeted `select-layout main-vertical` | **0.4917** | the injected follow-up is what makes it take effect |
| `select-layout` first, then `main-pane-width "40"` | 0.4917 | setting the option **after** a layout is inert |

That third row is the ordering claim, which was the weakest part of this rule and
is now falsifiable rather than merely plausible: the same option, the same
window, the same layout — the order is the only variable, and only one order
works. It is why the bridge emits option-then-layout and why the injected
`select-layout` is load-bearing rather than decorative.

`apply_layout` still has **no test coverage in psmux** — a search across
`tests-rs/` at v3.3.8 returns zero hits — so nothing here is asserted upstream.
That is no longer a gap in the evidence, because the behaviour is now observed
directly rather than inferred from the source.

Scope matches rule 1a's: one session, one window, one client, v3.3.8. Not covered:
multi-window sessions, concurrent clients, or `main-pane-height`.

INFERRED: with `main_pane_width = 50`, `src/layout.rs:1144` builds
`sizes: vec![50, 50]` at the root and `src/layout.rs:1140-1141` gives the
right-hand column `equal_sizes` shares, so a 200-column window should show a main
pane of 99 cells with the remainder in the right column, and a 240-column window
a main pane of 119.

**Two of the three things this paragraph used to leave open are now measured, and
the third is corrected above.** The order — option before layout — is no longer
structural-by-inference: the probe ran both orders and only option-then-layout
moved the pane (see the table above). The `50%`-vs-`50` storage difference is
rule 1a's, measured there. The column counts below remain INFERRED arithmetic
rather than observation, and deliberately so: the probe recorded **shares** of the
window width (0.5917 and 0.4917), not absolute cells, because the runner's window
width is psmux's default and is not 200 or 240. The shares are what the rules
depend on; the specific cell counts are illustrations of them.

A run at a fixed 200-column window would settle the counts, and would need a
probe that sizes the window rather than accepting the default. Nothing else in
this document depends on it.

| window columns | panes | main | agents |
|---|---|---|---|
| 200 | 2 | 99 | the remainder stacked right |
| 200 | 4 | 99 | four stacked in the right column |
| 240 | 2 | 119 | the remainder stacked right |

**The committed probe artifact contains a `119` that is NOT this rule working, and
it is the single easiest number in this document to misread.** The after-run in
`.omo/evidence/issue-1-team-layout-probe-after.json` records a 200-column window
going `%1 0 59` / `%2 60 140` to `%1 0 119` / `%2 120 80`, and 119 is roughly
200 × 60%. That 60% is **psmux's own default** from
`src/layout.rs:1096` — the value this whole rule exists to change. If rule 1a
were working, the main pane would be at 200 × 50% ≈ **99**, which is the number in
the table above. So that artifact is evidence of the *defect* rule 1a and 1b
address, not evidence that the fix was applied: the probe exercised a targeted
`select-layout -t`, never `set-window-option main-pane-width` followed by the
rule's untargeted `select-layout main-vertical`. Anyone reading `119` as
confirmation has read psmux's fallback as the bridge's output.

#### Rule 1c — `resize-pane -x` / `-y` is suppressed, not forwarded

When the verb is `resize-pane` or `resizep` and the argv contains a bare `-x` or
`-y` element, the bridge performs **no backend call at all** and exits 0.

psmux's absolute resize assigns the caller's value straight into the layout tree's
`sizes` array, but those entries are PERCENTAGES while tmux's `-x` / `-y` is a CELL
COUNT:

- `src/window_ops.rs:1782` → `let new = target.max(1);`
- `src/window_ops.rs:1784` → `sizes[idx] = new;`
- `src/window_ops.rs:1786` → `if idx + 1 < sizes.len() {`
- `src/window_ops.rs:1787` → `sizes[idx + 1] = (sizes[idx + 1] as i16 - diff).max(1) as u16;`
- `src/window_ops.rs:1788` → `} else if idx > 0 {`
- `src/layout.rs:1136` → `sizes: vec![main_v_pct, 100 - main_v_pct],`

Two properties of that code decide what a forwarded `-x` would actually do to a
`main-vertical` tree, and both are load-bearing for this rule:

1. **The tree is nested, so the root `sizes` array holds two elements, not three.**
   With more than one remaining pane, `main-vertical` builds a right-hand
   `Vertical` split and hangs it off the root `Horizontal` split
   (`src/layout.rs:1140-1145`), and `equal_sizes` always sums to 100
   (`src/layout.rs:1085-1092`). A flat three-element `[60, 20, 20]` is not a
   state this layout can be in.
2. **The difference is absorbed from exactly one neighbour** — the next sibling
   if there is one, otherwise the previous (`src/window_ops.rs:1786-1790`). No
   third element moves, and none is renormalised.

INFERRED: `-x 99` against a `main-vertical` root of `[60, 40]` with the main pane
active therefore writes `sizes[0] = 99`, computes `diff = 39`, and leaves the root
at `[99, 1]` — a main pane at 99% and a right column at 1%, with every agent pane
inside that column squeezed to nothing. With the main pane *not* active the same
call lands on `idx = 1`, `diff = 99 - 40 = 59`, and the root becomes `[1, 99]`.
Either way the layout is destroyed, and no arrangement of `-x 99` means "99
cells" to this code.

**The figures this paragraph used to carry are retracted.** It claimed that `-x
99` on `sizes = [60, 20, 20]` yields `[99, 1, 1]`, and offered `resize-pane -t %1
-x 99` turning `[119, 80, 80]` into `[197, 2, 2]` as a measurement. Both were
wrong, and neither was a citation. The input array is unreachable per point 1;
and under point 2 a flat `[60, 20, 20]` with the first element set to 99 becomes
`[99, 1, 20]`, not `[99, 1, 1]`. The measurement does not close on its own terms
either — `119 + 80 = 199` against `197 + 2 + 2 = 201` — and it cannot be the
output of `resize_pane_absolute`, which adjusts one neighbour and leaves the rest
alone, so `[119, 80, 80]` with `idx = 0` and `diff = 78` would give
`[197, 2, 80]`. Nothing captured that run. What would settle it: run `resize-pane
-t %1 -x 99` against a known tree in a throwaway `-L` namespace and store
`list-panes -a -F '#{pane_left},#{pane_width}'` from both sides of the call.

No argument form rescues it. psmux parses a bare `-x` token as an ABSOLUTE value
and only treats a `%` suffix as a percentage, so there is no spelling of the cell
count that means "cell count" to it:

- `src/server/connection.rs:1768` → `if let Some(pct) = xval.strip_suffix('%').and_then(|n| n.parse::<u8>().ok()) {`
- `src/server/connection.rs:1770` → `} else if let Ok(abs) = xval.parse::<u16>() {`

**The parser looks correct, and stopping there concludes this rule is
unnecessary. That conclusion is wrong, and the mistake is worth naming because it
is the obvious one.** The two cited lines really do route a bare `-x 99` to
`ResizePaneAbsolute` rather than to the percentage arm — read in isolation they
look like working tmux semantics, and a reader who stops at the parse will
conclude rule 1c is superfluous.

The defect is one layer down, in what `resize_pane_absolute` does with the number:

- `src/window_ops.rs:1782` → `let new = target.max(1);`
- `src/window_ops.rs:1784` → `sizes[idx] = new;`

`sizes` is a vector of **proportions, not pixels**, and this is settled by the
consumer rather than by the writer. `split_with_gaps` normalises:

- `src/tree.rs:21` → `let total_pct: u32 = sizes.iter().map(|&s| s as u32).sum();`
- `src/tree.rs:31` → `let s = ((total_available as u32 * pct as u32) / total_pct) as u16;`

The variable is named `total_pct`, the divisor is the sum, and each child is a
share of the whole. So a cell count written into `sizes` is re-read as a
percentage of the window. Worked through, against the `[60, 40]` root below:
`sizes[0] = 99`, `diff = 99 - 60 = 39`, `sizes[1] = (40 - 39).max(1) = 1`, and
`split_with_gaps` then hands the main pane `total_available * 99 / 100`.

**`-x 99` therefore yields 99% of the window's width, not 99 columns.** That is
the whole defect, and it is invisible at the parse site. Anything that stops at
`connection.rs:1768`/`1770` will conclude this bridge suppresses a command psmux
handles correctly, and that conclusion is wrong.

What the cited parser settles without a host run, and what it does not:

- `-x -20`: `strip_suffix('%')` yields nothing and `parse::<u16>()` fails on a
  leading minus, so neither arm fires and **no request is sent at all**. A true
  silent no-op.
- `-x 99%`: the percentage arm fires, and psmux converts the percentage straight
  back into an absolute cell count before resizing —
  `let abs_size = ((total as u32) * (pct as u32) / 100).max(1) as u16;`
  (`src/server/mod.rs:5462`) — which then lands in `resize_pane_absolute` as a
  cell count. A percentage does not buy a percentage.
- `-l 25`: **not a no-op, and not inert either.** `-l` matches neither the `-x`
  nor the `-y` arm, so control reaches the fallback, which takes the first
  argument that parses as a `u16` — `25` — as the amount, and defaults the
  direction to `"D"`:
  - `src/server/connection.rs:1780` → `let amount = args.iter().find(|a| a.parse::<u16>().is_ok()).and_then(|s| s.parse::<u16>().ok()).unwrap_or(1);`
  - `src/server/connection.rs:1785` → `else { "D" };`
  - `src/server/connection.rs:1786` → `let _ = tx.send(CtrlReq::ResizePane(dir.to_string(), amount));`
  So `resize-pane -l 25` is a **25-cell downward step**, not a request to size to
  25. This paragraph previously listed it beside `-x -20` as a silent no-op; the
  source refutes that, and the fallback path is shared by every `-x`-less,
  `-y`-less, `-Z`-less `resize-pane`.

The remaining per-form verdicts — `-x 99`, `-x 100`, `-x +0` — were recorded as
measured and are not: no capture of them exists in this repository, and `-x +0`
in particular turns on whether Rust's `u16` `FromStr` accepts a leading `+`, which
nothing cited here establishes. What is established is the narrower and sufficient
claim: **no spelling of a cell count reaches psmux as a cell count**, because the
percentage arm converts back to cells and the absolute arm takes the caller's
number as a percentage.

**Scope note, because `-l` exposes it.** Rule 1c keys on a bare `-x` or `-y`
element, so a `-l`-form `resize-pane` would **pass through** and land on that
downward-step fallback. No cited OmO argv takes that form: the two `resize-pane`
invocations in the bundle are `index.js:8937` (`-x <cells>`) and `index.js:19672`
(`-x "30%"`, in team-mode layout). The second one is a percentage form, so rule
1c suppresses it as well, and by the `-x 99%` reasoning above that suppression is
correct on psmux. An agent-authored `-l` argv is not off-path in the same way and
would need its own decision, which this document does not make.

`-Z` is **not** affected. Zoom is a different request, checked before the `-x`/`-y`
arms, and it works:

- `src/server/connection.rs:1236` → `"zoom-pane" | "resize-pane" | "resizep" if args.iter().any(|a| *a == "-Z") => { let _ = tx.send(CtrlReq::ZoomPane); }`

`resize-pane -Z` is forwarded byte-identically.

**The tradeoff, stated plainly.** This is a deliberate, user-approved decision to
lose a command rather than forward it. It is safe because rules 1a and 1b already
produce the geometry the command was trying to produce, so `resize-pane -x` is a
no-op in *intent* — and forwarding a no-op that is actively destructive is strictly
worse than dropping it. The cost is that the bridge is now suppressing a command
OmO believes it sent, and that suppression has to be visible rather than silent,
which is why it is a distinct translation kind and a distinct outcome in both logs
(`kind: "suppressed"`, `outcome: "suppressed"`) with the dropped argv still
recorded. Nothing else in this document suppresses a command.

### 3.10 Team-mode visualization: the `createTeamLayoutInCallerWindow` family, and rules 1d, 1e and D0

**What is verified here, and what is not — stated before the rules rather than
after them.** Every psmux line this section cites is now mechanically re-checked
against the pinned tree: `bun run contract:verify` reads all 174 citations in this
document and reports 0 problems, including the 84 on the psmux side. So the
*premises* quoted below are confirmed present-and-unchanged at v3.3.8.

That is a narrower claim than it looks, and the gap should be named rather than
assumed away. Verifying a citation proves the quoted text is still on that line.
It does **not** prove that the rule built on top of it is the right rule, because
this section and the code implementing it were authored together — so a rule
resting on a citation here rests on the same author's reading of that line. That
is the circularity, it is structural, and no amount of re-running the checker
removes it. Two things do:

1. **Re-run `scripts/windows/parity/team-layout-probe.cjs` and confirm the
   after-run artifact reproduces** — an independent observation of the behaviour
   rather than of the source. Needs a Windows host.
2. **A reader who knows psmux 3.3.8 disagrees with any rule here.** The rules
   carry file:line citations precisely so that can happen without trusting this
   document's conclusions.

Until at least one of those happens, treat the *shape* of these rules as
well-corroborated and their *consequences* as argued rather than demonstrated.

OmO's team-mode visualization is gated separately from the subagent-pane gates
in section 4. The config key is `team_mode.tmux_visualization`, off by default:

- `index.js:26645` → `var TeamModeConfigSchema = z44.object({`
- `index.js:26647` → `tmux_visualization: z44.boolean().default(false),`

(The schema runs to `index.js:26656`; the default is the whole of the gating
fact.) When `resolveCallerTmuxSession` (`index.js:19573-19590`) returns null,
no layout is attempted at all:

- `index.js:19705` → `deps.log("tmux visualization requires a resolvable caller tmux pane, skipping", { teamRunId });`

The caller session is resolved with two `display` calls carrying `-F`:

- `index.js:19577` → `const sessionResult = await runCommand(tmuxPath, ["display", "-p", "-F", "#{session_id}", "-t", callerPaneId]);`
- `index.js:19585` → `const windowResult = await runCommand(tmuxPath, ["display", "-p", "-F", "#{session_name}:#{window_index}", "-t", callerPaneId]);`

and the returned strings must match the session and window-target patterns
(`index.js:19582` tests `TMUX_SESSION_ID_PATTERN` against the session id;
`index.js:19590` tests `TMUX_WINDOW_TARGET_PATTERN` against the window
target). Anything that corrupts the `display` output therefore skips the whole
team layout, which is why rule D0 below is load-bearing rather than cosmetic.

Per member, `createTeamLayoutInCallerWindow` (`index.js:19653-19674`) emits, in
this order: `list-panes` in the caller window first (via `listPanesInWindow`):

- `index.js:19625` → `const result = await deps.runTmuxCommand(tmuxPath, ["list-panes", "-t", windowTarget, "-F", "#{pane_id}"]);`

then `split-window` (the first split carries `-l 70%`; later splits carry no
`-l`, splitting the last teammate pane instead):

- `index.js:19637` → `return ["split-window", ...environmentArgs, "-t", callerPaneId, "-h", "-d", "-l", "70%", "-P", "-F", "#{pane_id}", "-c", getPaneWorkingDirectory(member)];`

then a `select-pane` title call:

- `index.js:19664` → `await deps.runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", `${TEAM_PANE_TITLE_PREFIX}${member.name}`]);`

then two `set-option -p` calls:

- `index.js:19665` → `await deps.runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, OMO_ATTACH_SERVER_URL_OPTION2, serverUrl]);`
- `index.js:19666` → `await deps.runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, OMO_ATTACH_SESSION_ID_OPTION, member.sessionId]);`

then `send-keys` with the attach command plus `Enter`:

- `index.js:19667` → `await deps.runTmuxCommand(tmuxPath, ["send-keys", "-t", paneId, buildAttachCommand(member, serverUrl), "Enter"]);`

and after all members, a targeted `select-layout` and a caller resize:

- `index.js:19669` → `const layoutResult = await deps.runTmuxCommand(tmuxPath, ["select-layout", "-t", windowTarget, "main-vertical"]);`
- `index.js:19672` → `const resizeResult = await deps.runTmuxCommand(tmuxPath, ["resize-pane", "-t", callerPaneId, "-x", "30%"]);`

None of these carries a payload, so all classify as `pass-through`, and all
are handled on the translate stage on the same branch as rules 1a-1c. Three
further rules carve the carve-out, each pinned to a named psmux defect, plus
the `display` rewrite that the whole sequence depends on.

#### Rule 1d: `set-option -p ... @omo_attach_*` is suppressed, not forwarded

psmux refuses every pane-scoped option except `remain-on-exit`:

- `src/server/mod.rs:3862` → `other => format!("ERROR: pane-scoped option '{}' is not supported (supported: remain-on-exit)", other),`

and the parse arm that gets there reads the option name as the first
non-flag argument that is not a `-t` value (`src/server/connection.rs:2355-2415`,
opening at `src/server/connection.rs:2355` →
`"set-option" | "set" | "set-window-option" | "setw" => {`).

Suppression is safe because OmO ignores both results: the two calls at
`index.js:19665-19666` are awaited bare, with no success check and no branch
on the outcome. `@omo_attach_session_id` has no readers anywhere else in the
bundle (a search for the string finds only its definition at `index.js:19773`
and the write at `index.js:19666`). The only reader of
`@omo_attach_server_url` skips a pane whose URL resolves to null:

- `index.js:9415` → `const rawServerUrl = pane.attachServerUrl || extractAttachServerUrl(pane.commandLine);`
- `index.js:9416` → `if (rawServerUrl === null)`
- `index.js:9417` → `continue;`

so absence reads as "unknown", not as failure.

**What the carve-out costs, stated with the rule.** This is the second rule in
this document (after rule 1c) that performs ZERO backend invocations: no psmux
command runs at all, and the bridge exits 0. It is recorded as
`suppressionReason: "psmux-refuses-pane-scoped-options"` in the call log
(`src/translate.ts` `SuppressionReason`; `src/cli.ts` record key), so the
dropped argv stays auditable. Measured: through the old shim each of the four
probe `set-option -p` calls exited 1 with the refusal stderr above
(`.omo/evidence/issue-1-team-layout-probe-before.json`, direct and shim arms);
in the after-run the same four argv exit 0 with no backend call
(`.omo/evidence/issue-1-team-layout-probe-after.json`, shim arm).

The rule is deliberately narrow: verb in the four set-option spellings, a
bare `-p`, and the option name one of exactly the two `@omo_attach_*` names.
`remain-on-exit` stays pass-through, `set` without `-p` stays pass-through,
and no other option name is touched.

#### Rule 1e: the team resize becomes `set-option main-pane-width <n>` plus a re-applied layout

`resize-pane -t <callerPane> -x "30%"` (`index.js:19672`) carries a bare `-x`,
so rule 1c would suppress it, leaving psmux's 60% default. But this exact
shape is a PERCENTAGE on `-x` with no `-y` and no `-Z`, and psmux has a sizing
option that means the same thing: `main-pane-width` is parsed as a bare
`u16`:

- `src/server/options.rs:527` → `"main-pane-width" => {`
- `src/server/options.rs:528` → `if let Ok(n) = value.parse::<u16>() { app.main_pane_width = n; }`

read from inside the layout application:

- `src/layout.rs:1094` → `// Determine main-pane percentage`
- `src/layout.rs:1096` → `let main_v_pct = if app.main_pane_width > 0 { app.main_pane_width.min(95) } else { 60 };`

and consumed by the `main-vertical` arm:

- `src/layout.rs:1129` → `"main-vertical" | "main-v" => {`
- `src/layout.rs:1136` → `sizes: vec![main_v_pct, 100 - main_v_pct],`

So the bridge rewrites the one caller invocation into `set-option
main-pane-width <n>` (the digits before the `%`) followed by `select-layout
main-vertical`, for the same reason rule 1b exists: setting the option
applies nothing until a layout runs. The `-t` is dropped because
`main-pane-width` is a window option, not a pane one, and the follow-up
carries no `-t` for the same reason rule 1b's does.

**What the carve-out costs, stated with the rule.** Like rule 1b, this rule
turns ONE caller invocation into TWO backend invocations. The log shows
`verb: "resize-pane"`, `rewritten: true`, and the follow-up reason
`psmux-reads-main-pane-size-only-inside-apply-layout` (`src/translate.ts`
`FollowUpReason`; `src/cli.ts` follow-up record).

Gates, exactly: a resize verb, no `-Z`, no `-y`, exactly one bare `-x`, and
a non-zero whole-number percentage directly after it. `-x <cells>` (no `%`),
`-y`, `0%`, non-digit values, and any argv carrying both axes keep rule 1c's
suppression. `-Z` precedence is unchanged: zoom is checked first and forwarded.

The now-MEASURED caller-is-main fact: with a valid target, `select-layout`
applies and the rule-1e sequence yields `%1` width 59 of 199 (about 30%),
while forwarding the raw resize yields 59% (`.omo/evidence/issue-1-windows-team-mode-validation.txt`,
section 2; GitHub issue #1, D2 comment). INFERRED: the rule therefore assumes
the caller pane is the window's first (main) pane, so `main-pane-width` sizes
the caller. The inference is from the team splitting the caller pane first
and `main-vertical` putting the main pane first (`src/layout.rs:1129-1136`);
the measured widths are what keep it honest.

#### Rule D0: the one non-final `-F` comes off `display` / `display-message`

psmux's client does not recognise `-F` for `display` / `display-message`: the
client-side match handles `-t`, `-p`, `-d` and `-I` and pushes every other
element into the message text, which is then joined, quoted and sent as the
message (`src/main.rs:2799-2865`, opening at `src/main.rs:2799` →
`"display-message" | "display" => {`). Measured direct on psmux 3.3.8:

- `display -p -F "#{session_id}" -t %1` prints `-F $1303` (tmux 3.7c prints
  `$0` for the same argv);
- `display -p -F "#{session_name}:#{window_index}" -t %1` prints `-F p:0`.

Dropping the bare `-F` element is the validated spelling: psmux then prints
`$1303` / `p:0` (`.omo/evidence/issue-1-windows-team-mode-validation.txt`,
section 1). The bridge removes exactly the ONE non-final `-F` element, and
only for these two verbs: every other verb's `-F` is parsed correctly by
psmux and stays byte-identical.

**What the rewrite costs, stated with the rule.** Recorded as `rewriteReason:
"psmux-client-treats-display-F-as-message-text"` (`src/translate.ts`
`RewriteReason`; `src/cli.ts` record key), because the logged argv alone
cannot say whether the caller omitted the flag or the bridge did. OmO's use
sites are `index.js:19577` and `index.js:19585`. Without this rule the whole
team layout is skipped: the corrupted `-F $N` output fails the session-id
pattern test, `resolveCallerTmuxSession` returns null, and the layout logs
the skip (measured baseline: `-F $1303` against the pattern at
`index.js:19582`; `.omo/evidence/issue-1-team-layout-probe-before.json`,
direct arm).

#### Measured results, with on-disk artifacts

The before/after probe runs replay the team-layout sequence in throwaway `-L`
namespaces, direct arm plus shim arm, both completing with `cleanup.ok=true`
and `sessionsLeft=[]`:

- `.omo/evidence/issue-1-team-layout-probe-before.json`: `display` prints
  `-F $1299` / `-F probe:0`; the corrupted target fails `list-panes -t` and
  `select-layout -t` with `no server running on session 'tbase1__-F probe'`;
  all four `set-option -p @omo_attach_*` calls exit 1 with the refusal stderr;
  `split-window` returns `%2` / `%3`; `send-keys` markers are captured;
  `select-layout` geometry rows are unchanged (an artifact of the corrupted
  target, not a layout defect); the dead-pane `kill-pane` exits 1 with
  `psmux: can't find pane: %2`.
- `.omo/evidence/issue-1-team-layout-probe-after.json` (staged new binary,
  SHA-256 recorded in the validation file): `display` prints `$1310` /
  `probe:0`; `list-panes -t probe:0` exits 0 with `%1`; the four `set-option
  -p` calls are suppressed at exit 0 with no backend call; `select-layout -t
  probe:0 main-vertical` exits 0 with geometry 59/140 going to 119/80; the
  rewritten resize yields 59/140 (about 30%); `send-keys` markers are still
  captured; the dead-pane `kill-pane` is identical. The direct arm (control)
  still shows the raw psmux behaviour (`-F $1308`, corrupted-target exit 1),
  so the treatment's success is attributable to the shim.
- `.omo/evidence/issue-1-windows-team-mode-validation.txt`: the D0 fix
  spelling table, the rule-1e geometry table (team splits 59/140, valid-target
  `select-layout` 119/80, rule-1e sequence 59/140), and the per-command
  after-run record quoted above.

These are measured observations with on-disk artifacts in this repository, not
citations and not inferences: each row names the file that holds it.

---

## 4. The gating predicates

OmO emits **no pane command at all** unless every gate below opens. All three
look identical from outside, which is why they are recorded together.

### 4.1 Gate one: config enabled

- `index.js:26718` → `var TmuxConfigSchema = z48.object({`
- `index.js:26719` → `enabled: z48.boolean().default(false),`

Off by default. This is the reason a stock Windows OmO produces zero panes and
no error.

### 4.2 Gate two: inside a multiplexer

- `index.js:8227` → `function isInsideTmuxEnvironment(environment) {`
- `index.js:8228` → `return Boolean(environment.TMUX);`
- `index.js:8233` → `function isInsideTmux() {`
- `index.js:8378` → `if (!deps.isInsideTmux() && !deps.isCmuxCompatEnvironment()) {`

The predicate is a bare truthiness test on the `TMUX` environment variable. No
value validation, no socket check, no liveness probe. Section 5 explains why
that is enough, given psmux.

### 4.3 Gate three: the OpenCode server answers a health check

- `index.js:8385` → `const serverRunning = await deps.isServerRunning(serverUrl);`
- `index.js:8390` → `const tmux = await deps.getTmuxPath();`
- `index.js:150702` → `function resolveServerUrl(rawServerUrl, env, log) {`
- `index.js:150712` → `ctx.serverUrl has port 0; falling back.`

INFERRED: `resolveServerUrl` reads `OPENCODE_PORT` and otherwise falls back to a
default, so on Windows an `opencode` that binds no explicit port produces a
server URL that the health check never reaches, and every pane is skipped with
no user-visible error. The citation supports the function's existence and the
fallback warning; the causal chain to "zero panes" is inference from gate three
plus that warning.

### 4.4 Gate four: a `tmux` on PATH that answers `-V`

This is the gate that makes the whole bridge mechanism work, and it is stricter
than it looks:

- `index.js:9071` → `async function findVerifiedTmuxPath() {`
- `index.js:9072` → `const path = await findCommandPath("tmux");`
- `index.js:9077` → `const verifyProc = spawn([path, "-V"], {`
- `index.js:9083` → `if (verifyExitCode !== 0) {`
- `index.js:8390` → `const tmux = await deps.getTmuxPath();`

**The contract consequence, stated as a requirement:** the shim must answer
`-V` with **exit code 0**. A shim that answers `-V` correctly but exits non-zero,
or that does not recognise `-V` and falls through to a passthrough that fails,
makes `getTmuxPath()` return null, and every tmux feature then silently no-ops
with no error at all.

INFERRED: the requirement that `-V` exit 0 is derived directly from
`index.js:9083` returning null on non-zero and from `index.js:8390` feeding that
null into the skip path. The silent-no-op consequence is inferred from there
being no error branch on that path.

### 4.5 There is no config field for the tmux binary

`TmuxConfigSchema` (`index.js:26718`) has no path or binary field, and its
generated JSON schema sets `additionalProperties: false`.

INFERRED: therefore no OmO configuration key and no environment variable can
redirect the tmux binary, and **PATH ordering is the only available lever** for
interception. This is the load-bearing reason the bridge is a PATH shim and not a
configured backend. The absence of such a field is inferred from the cited schema
object plus the `additionalProperties: false` claim, which is asserted in the
research draft rather than cited to a line here.

---

## 5. psmux supplies `TMUX` and `TMUX_PANE` itself

**No environment injection is needed, and none should be added.**

psmux sets both variables on every pane it spawns, in the pane's own process
environment:

- `src/pane.rs:938` → `pub fn set_tmux_env(builder: &mut CommandBuilder, pane_id: usize, control_port: Option<u16>, socket_name: Option<&str>, session_name: &str, fix_tty: bool, _force_interactive: bool) {`
- `src/pane.rs:944` → `builder.env("TMUX", format!("/tmp/psmux-{}/{},{},0", server_pid, sn, port));`
- `src/pane.rs:945` → `builder.env("TMUX_PANE", format!("%{}", pane_id));`
- `src/pane.rs:955` → `builder.env("MSYS2_ENV_CONV_EXCL", "TMUX");`

This closes gate two from section 4.2 with nothing done by the bridge: psmux
panes already have a truthy `TMUX`, so `Boolean(environment.TMUX)` is true.

`MSYS2_ENV_CONV_EXCL=TMUX` (`src/pane.rs:955`) exists so that a Git Bash layer
cannot mangle the value on its way in. That is psmux handling its own
compatibility, not something the bridge must replicate.

INFERRED: because psmux sets these variables itself and correctly, any bridge
design that injected `TMUX` or `TMUX_PANE` would be adding a second, competing
source of truth for a value psmux already owns. The correct bridge behaviour is
to pass the environment through untouched on this path. This is a design
conclusion drawn from the three cited lines, not a claim about code that exists.

### 5.1 What psmux does *not* let you choose

`/bin/sh -c ...` cannot be rescued by changing psmux's notion of the pane
shell, because a pane that carries a command does not go through the default
shell at all:

- `src/pane.rs:1283` → `fn detect_bash_c_wrapper(cmd: &str) -> Option<(&str, &str)> {`
- `src/pane.rs:1286` → `("/bin/sh -c ", "sh"),`
- `src/pane.rs:1562` → `if let Some((inner_script, _)) = detect_bash_c_wrapper(trimmed) {`
- `src/pane.rs:392` → `let mut shell_cmd = if command.is_some() {`
- `src/pane.rs:100` → `static CACHED_SHELL_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();`
- `src/pane.rs:161` → `pub fn cached_shell() -> Option<&'static str> {`

`detect_bash_c_wrapper` recognises and strips a `/bin/sh -c ` prefix, then hands
the remainder to `cached_shell()`, which is a `OnceLock` resolved once per
process (`src/pane.rs:100`) and walks `pwsh`, then `powershell`, then `cmd`
(`src/pane.rs:163` through `src/pane.rs:165`). The branch at `src/pane.rs:392`
is on `command.is_some()`, so a command-bearing pane and an interactive pane take
different paths.

**Correction to the research draft.** The draft states that `cached_shell()`
"reads `$SHELL`". At v3.3.8 it does not. A search for
`env::var("SHELL")` and `env::var_os("SHELL")` across `src/*.rs` at this ref
returns nothing. The conclusion the draft drew, that no `$SHELL` route can fix a
command-bearing pane, is **stronger** than stated, not weaker: psmux 3.3.8 never
consults `$SHELL` for this purpose at all.

---

## 6. The payload is always the final positional argument

Every one of the five shapes in section 3 puts its payload last, after all
flags and after all `-e` pairs. This is what makes the grammar parseable without a
full tmux option parser: the payload is whatever remains at the end.

INFERRED: the translator may therefore extract the payload as "the final
argument", provided it first classifies the verb. That is sound only because
OmO builds these argv arrays itself, in the order shown, and is not subject to
agent-authored reordering. It would **not** be sound for an arbitrary
agent-authored argv, which is a further reason unrecognised input is pass-through
rather than an error.

---

## 7. The three known psmux 3.3.8 defects, and the bridge's response to each

All three are source-read facts at tag v3.3.8. Todo 5 converts them to runtime
evidence. Until then they are what the source says, not what a machine was
observed to do.

### 7.1 Defect 1: `respawn-pane` drops a positional command operand

At v3.3.8 the command operand is read **only** behind `--`. There is no
positional fallback:

- `src/server/connection.rs:2093` → `"respawn-pane" | "respawnp" => {`
- `src/server/connection.rs:2102` → `let command = args.iter().position(|a| *a == "--")`
- `src/server/connection.rs:2103` → `.map(|i| args[i + 1..].join(" "))`
- `src/server/connection.rs:2106` → `let _ = tx.send(CtrlReq::RespawnPane(workdir, kill, command, empty));`

The four-tuple sent carries `workdir`, `kill`, `command`, `empty`, and `command`
is `None` whenever `--` is absent:

- `src/server/mod.rs:3890` → `CtrlReq::RespawnPane(workdir, kill, command, empty) => {`

Because OmO emits `respawn-pane` with **no `--`** (`index.js:8501`,
`index.js:8549`), the payload never arrives. The pane is respawned with the
default shell instead, and the subagent never starts.

The reference documentation documents only the `--` form, so `--` is not an
invented workaround, it is the documented interface:

- `docs/tmux_args_reference.md:91` → \`| \`respawn-pane\` | \`respawnp\`, \`resp\` | \`kc:t:\` plus \`-- <command>\` |\`

**Bridge response: insert `--` before the payload** on the `respawn-pane`
path. The basis is the source read above, not a runtime capture: the operand is
read only behind `--`, and the reference table documents only the `--` form.

**Withdrawn 2026-10-07: the "measured the difference directly" claim.** This
paragraph previously read "The prior session measured the difference directly"
and supported it with two lines from `omo-psmux-bridge.md:609-610`, comparing
`respawn-pane -k -t %1 <command>` against the `--` form. That file is the local
session transcript, which `.gitignore` excludes from this repository, so those
two lines are not a record this repository holds of anything. Under the
preamble's third category they are **inadmissible**: a measurement whose run
left no artifact under version control is never the ground for a conclusion.
They are removed rather than restated.

The conclusion is unaffected, because it never needed them. `insert --` rests on
`src/server/connection.rs:2093`/`:2102`/`:2103`/`:2106` — the operand is
unreachable without `--` — together with `docs/tmux_args_reference.md:91`, which
documents `-- <command>` as the interface. All five are citations that
`bun run contract:verify` re-checks. What is withdrawn is the *strength* of the
claim, not its direction: this was verified by reading psmux, and no artifact
here records anyone watching the pane fail to start.

INFERRED: inserting `--` changes the meaning of argv OmO emitted, so it is a
translation and not a passthrough, and it is confined to the `respawn-pane`
path. No other verb needs it, because no other verb has this defect.

### 7.2 Defect 2: `respawn-pane` drops `-e NAME=VALUE`

At v3.3.8, `-e` support is uneven across the verbs that accept it. Counting
`-e` handling inside each verb's parse arm:

| Verb | Parse arm | Handles `-e`? |
|---|---|---|
| `split-window` | `src/server/connection.rs:1092` | yes |
| `new-window` | `src/server/connection.rs:1062` | yes |
| `new-session` | `src/server/connection.rs:3353` | yes |
| `respawn-pane` | `src/server/connection.rs:2093` | **no** |
| `respawn-window` | `src/server/connection.rs:3580` | **no** |

The `respawn-pane` arm (`src/server/connection.rs:2093` through
`src/server/connection.rs:2106`) reads `-c`, `-E`, `-k` and `--`, and nothing
else.

**Bridge response: apply `-e NAME=VALUE` itself on the respawn path.** The bridge
sets the variable in the pane's environment by whatever mechanism it has
available on its side of the spawn, rather than relying on psmux to forward it.
Without this, `OPENCODE_SERVER_PASSWORD` (`index.js:8336`) never reaches the
attach pane.

INFERRED: because the credential is dropped by psmux on this path, the bridge
must both apply the variable itself **and** redact it from its own logs
(section 2.2). Applying it is not optional and dropping it is not an acceptable
simplification.

### 7.3 Defect 3: `respawn-window` drops every argument

Worse than defect 1, and in a different way. The whole arm is three lines and
sends a request with no arguments whatsoever:

- `src/server/connection.rs:3580` → `"respawn-window" | "respawnw" => {`
- `src/server/connection.rs:3581` → `let _ = tx.send(CtrlReq::RespawnWindow);`
- `docs/tmux_args_reference.md:92` → \`| \`respawn-window\` | \`respawnw\` | none |\`

**Bridge response: none, and deliberately so. This is off-path.** A search for
the string `respawn-window` in the installed OmO bundle returns **zero
occurrences**. OmO never emits this verb, so there is no argv shape for the
bridge to get wrong.

INFERRED: adding special handling for `respawn-window` would be speculative
code guarding a path that cannot be reached. The correct response is to leave it
as pass-through and record that it is off-path, so that a future bundle which
does emit it is a visible contract change rather than a silent breakage.

---

## 8. Retirement conditions

Each workaround in section 7 exists because of a specific upstream defect, and
each must be removed when a specific upstream commit ships **in a release**.

The distinction between "on master" and "in a release" is load-bearing and is
stated here as a rule, not as a convenience.

### 8.1 Why a version string cannot settle this

Both upstream fixes exist on psmux master. Neither is in any tagged release.
Verified in this session at the pinned v3.3.8 checkout:

```bash
$ for t in $(git tag); do git merge-base --is-ancestor <commit> $t && echo "$t"; done
   (no output, for either commit)
```

A semver string in a config file cannot prove ancestry. `3.3.9` might contain
`c20016c` or might not, and nothing in the string says which. Therefore the
retirement thresholds below are a **maintained table seeded `null`**, to be
filled in by a human or an agent who has actually run the ancestry check against
a named tag. It is never computed by comparing version numbers.

### 8.2 The table

| Workaround | Defect | Upstream commit | Commit subject | Commit date | In a release? | First release containing it | Action when filled |
|---|---|---|---|---|---|---|---|
| Insert `--` before the payload on `respawn-pane` | 7.1, `respawn-pane` positional operand drop | `c20016c` | `fix(#580): accept the documented respawn shell-command operand and forward it whole` | 2026-09-03 | **no** | `null` | drop the `--` insertion, keep pass-through |
| Apply `-e NAME=VALUE` on the respawn path | 7.2, `respawn-pane` `-e` drop | `4addc0a` | `fix(#708): respawn-pane keeps the pane's history and applies -e` | 2026-09-29 | **no** | `null` | drop the self-application, forward `-e` through |
| Nothing, off-path | 7.3, `respawn-window` argument drop | `c20016c` | same commit as row 1 | 2026-09-03 | **no** | `null` | no change; re-check only if a future bundle emits the verb |
| Strip the `%` from `main-pane-width` / `main-pane-height` | 3.9 rule 1a, `options.rs:527` `u16` parse of a percentage | `null` | not yet identified | `null` | `null` | `null` | stop stripping; OmO's `50%` will parse on its own |
| Re-apply the consuming layout after the sizing option | 3.9 rule 1b, `layout.rs:1094-1096` reads the option only inside `apply_layout` | `null` | not yet identified | `null` | `null` | `null` | stop injecting the follow-up |
| Suppress `resize-pane -x` / `-y` | 3.9 rule 1c, `window_ops.rs:1771-1796` writes a cell count into a percentage array | `null` | not yet identified | `null` | `null` | `null` | forward the command again, and only once 1a and 1b are both retired |
| Drop the non-final `-F` on `display` / `display-message` | 3.10 rule D0, `main.rs:2799-2865` folds `-F` into the message text | `null` | not yet identified | `null` | `null` | `null` | stop dropping `-F`; forward the argv byte-identically once the psmux client parses `-F` as the format selector for these two verbs |
| Suppress `set-option -p ... @omo_attach_*` | 3.10 rule 1d, `mod.rs:3862` refuses pane-scoped options | `null` | not yet identified | `null` | `null` | `null` | stop suppressing; forward the options once psmux stores arbitrary pane options |
| Rewrite the team `resize-pane -t <pane> -x "<n>%"` to `set-option main-pane-width <n>` plus `select-layout main-vertical` | 3.10 rule 1e, `connection.rs:1767-1778` has no percentage spelling that reaches psmux as a cell count | `null` | not yet identified | `null` | `null` | `null` | forward the resize again once psmux's `-x <n>%` sizes the pane correctly |

The last six rows are seeded exactly like the first three, and for the same
reason: a semver string cannot prove that an upstream fix is present, so the
commit is `null` until someone runs the ancestry check named in section 8.1. The
retirement action is stated in each row because the three layout workarounds are
**not** independent of one another: rule 1c may only be dropped once 1a and 1b are
gone, or the suppressed `resize-pane` would become the only thing setting the
geometry and psmux would still destroy it. Of the three new rows, D0 and 1d
retire independently of every other row; rule 1e's rewrite exists to produce
the geometry rules 1a and 1b would otherwise produce for the caller pane, so
forwarding the raw team resize again is only correct once psmux sizes it
correctly, whatever the state of the other rows.

Full commit hashes, for exactness:

- `c20016c` = `c20016c1ebd8557748ca3c4a7e7f99f5d872aa90`
- `4addc0a` = `4addc0a730e57f827c286c76eec24489a5667200`

Both hashes were resolved with `git log -1` in the pinned checkout, and both were
tested with `git merge-base --is-ancestor` against every tag the clone carries
(`v3.3.4-fix-88`, `v3.3.5`, `v3.3.6`, `v3.3.7`, `v3.3.8`). Neither is an
ancestor of any of them.

### 8.3 `c20016c` also fixes defect 3

INferred from the diff: that commit introduces a
`respawn_positional_command` helper and applies it to **both** the
`respawn-pane` and the `respawn-window` arms. So defect 3 shares a retirement
condition with defect 1. Recorded so that row 3 of the table is not mistaken for
an independent dependency.

### 8.4 What does *not* retire

Defect 2's fix is a separate commit (`4addc0a`) from defect 1's (`c20016c`), so
the two workarounds retire independently. A release that ships `c20016c` but not
`4addc0a` still needs the `-e` self-application.

---

## 9. `select-layout` with no `-t`: MEASURED, and Option A is correct

**Status as of 2026-10-07: settled by measurement.** Option A holds — an
untargeted `select-layout <name>` **does** apply, and it applies to **the window
that client most recently made current**. The evidence is
`.omo/evidence/ci-layout-which-window.json`, produced by an automated
`windows-latest` run of `layout-which-window.cjs`; its provenance is recorded in
`.omo/evidence/README-parity-ci.md`. Section 9.3 reads the run out in full. What
follows is the reasoning that led there, kept because 9.3's conclusion is only
legible against it, and because one claim in it has since been **refuted by the
run** and is corrected in place.

Nothing downstream may inject a `-t` onto `select-layout`. That was already
settled on source (9.1) and the measurement confirms it: an injected `-t` is
stripped before dispatch, so it cannot retarget anything.

OmO applies the layout with no target at all:

- `index.js:8898` → `function calculateMainPaneWidth(windowWidth, options) {`
- `index.js:8914` → `const layoutProc = spawnCommand([tmux, "select-layout", layout], {`
- `index.js:8921` → `const sizeProc = spawnCommand([tmux, "set-window-option", dimension, \`${mainPaneSize}%\`], {`
- `index.js:8937` → `await deps.runTmuxCommand(tmux, ["resize-pane", "-t", mainPaneId, "-x", String(mainWidth)]);`

Note the asymmetry in that last group. The **width** enforcement carries an
explicit target (`-t mainPaneId`, `index.js:8937`). The **layout** call does not
(`index.js:8914`). So `select-layout` is the odd one out among the layout verbs.

Two options, and the bridge must be built to survive either until the question
is settled:

**Option A: pass it through unchanged.** Emit `select-layout <layout>` with no
`-t`, exactly as OmO does. Correct if psmux resolves the implicit target the way
OmO expects.

**Option B: inject an explicit `-t`.** Have the bridge rewrite it to
`select-layout -t <window> <layout>`. Correct if psmux needs an explicit target,
and wrong if it would then apply the layout to a window OmO did not intend.

### 9.1 What the source settles, and what it does not

The source is decisive about Option B and silent about Option A, and the
distinction matters. It rules the injected `-t` out on source alone, and says
nothing at all about whether the untargeted call does what OmO meant.

- `src/server/connection.rs:2741` → `"select-layout" | "selectl" => {`
- `src/server/connection.rs:2742` → `let layout = args.iter().find(|a| !a.starts_with('-')).unwrap_or(&"tiled").to_string();`
- `src/server/connection.rs:2743` → `let _ = tx.send(CtrlReq::SelectLayout(layout));`
- `src/server/connection.rs:973` → `// Build args without -t and its value so command handlers get clean positional args`
- `src/server/connection.rs:978` → `if args[i] == "-t" {`
- `src/server/connection.rs:979` → `i += 2; // skip -t and its value`

`-t` and its value are stripped from the argument vector **before any handler sees
it**, and `SelectLayout` carries no window at all:

- `src/server/mod.rs:4610` → `CtrlReq::SelectLayout(layout) => {`
- `src/server/mod.rs:4612` → `apply_layout(&mut app, &layout);`

INFERRED: an injected `-t` therefore cannot retarget the call — it is discarded
before dispatch, so Option B is not a riskier way of being right, it is a no-op
way of being wrong. On this specific point: **nothing downstream may inject a `-t`
onto `select-layout`.** That statement is scoped to `-t` and to what psmux does
with one; it does not depend on this section being settled, and it survives
unchanged either way. It is a statement about Option B's mechanics, not a
determination that Option A is correct.

What the source does **not** settle is Option A. `apply_layout` opens by taking
the active window and documents itself as acting on the current one:

- `src/layout.rs:1067` → `/// Apply a named layout to the current window.`
- `src/layout.rs:1069` → `pub fn apply_layout(app: &mut AppState, layout: &str) {`
- `src/layout.rs:1070` → `let win = &mut app.windows[app.active_idx];`

So "the active window" is well defined. Whether that is the window OmO meant is a
different and harder question: for a detached client in a namespaced server, which
window counts as active is server state that no cited line answers, and a silent
mis-target would be invisible — `SelectLayout` carries no reply channel at all
(`src/server/connection.rs:2743` sends without a `resp`), so neither a wrong
window nor a rejected layout name can report anything back.

### 9.2 What would settle it

Running the call, not reasoning about it. Two probes exist for exactly this and
are the thing to run. Neither has a committed output in this repository, so as of
this revision neither has settled anything:

- `scripts/windows/parity/layout-probe.cjs` — the primary question. Two windows,
  so "which window" is answerable rather than assumed; runs
  `select-layout <layout>` with no `-t` for four layout names including one
  psmux does not know, plus a targeted control, a per-window "which is current"
  sweep, and the same call through the shim. Writes
  `%TEMP%\omo-t14\layout-probe.json`.
- `scripts/windows/parity/layout-which-window.cjs` — the residual question. Both
  windows get two panes and *different* layouts, so applying one named layout to
  either one is visible, and the untargeted call is made once per candidate
  "current" window. Writes `%TEMP%\omo-t14\layout-which-window.json`.

What to read out of them, per the preamble: the exit code, the stderr, and
`list-panes -a -F '#{pane_left},#{pane_width}'` on both sides of the call. Exit 0
alone settles nothing, because psmux cannot fail this command.

**Corrected 2026-10-07 — this paragraph previously went further and was wrong.**
It claimed that an unrecognised layout name "lands in the catch-all arm and
quietly falls back to `even-horizontal`", citing:

- `src/layout.rs:1173` → `_ => {`
- `src/layout.rs:1174` → `// Unknown layout name — try to parse as tmux layout string`
- `src/layout.rs:1180` → `let sizes = equal_sizes(pane_count);`

The cited lines are real and still say what they say. The **conclusion drawn from
them is not what psmux does.** Measured on a `windows-latest` runner against
v3.3.8, `select-layout no-such-layout-anywhere` returned exit 0 with empty stderr
and left **both windows byte-identical**:

```
before: 0|7f70,120x30,0,0{71x30,0,0,1,48x30,72,0,2}|2p   1|7899,...
after : 0|7f70,120x30,0,0{71x30,0,0,1,48x30,72,0,2}|2p   1|7899,...
```

(`ci-layout-which-window.json`, `invalid_layout_name`.) An unknown name is a
**silent no-op**. It does not re-lay-out at all, so it does not fall back to
`even-horizontal` and it does not fall back to `equal_sizes` either — had the
catch-all fired, the 71/48 split would have become an even 59/60.

This makes the surrounding advice sharper rather than obsolete, and it is worth
being precise about why: an unknown name now differs from a **known** name in
something observable — geometry moves or it does not — where before this
document's account said the two were indistinguishable at the geometry level. So
"exit 0 settles nothing" remains true, but "before and after are identical too"
no longer implies the name was unknown. The geometry comparison is the only
discriminator, which is why 9.3 reads the artifact for `before`/`after` and not
for exit codes.

INFERRED, and not measured: the catch-all arm is probably not reached at all —
`src/layout.rs:1174` parses the name as a tmux layout string, and
`no-such-layout-anywhere` is not a valid layout string, so some later branch
declines to touch the tree. Which branch does that is a question about psmux's
source that this document does not answer, and it is left open rather than
guessed.

**Contributing evidence, not a decision:** the bridge's parity posture argues
that untested rewriting is the more dangerous choice, since a wrong `-t` would
change which window gets laid out, whereas a wrong pass-through at worst
reproduces whatever OmO already does on native tmux. On the cited source the
first horn is blunt — a `-t` cannot change which window gets laid out, because it
never reaches the handler — so this argument now reduces to its second horn.

INFERRED: Option A is the lower-risk default, on the grounds that pass-through
reproduces stock behaviour while a wrong injection invents behaviour. This is a
risk argument, **not** a determination that A is correct, and it must not be used
to close the question.

One observation of the primary question is on record from a session capture that
lives in the gitignored `.omo/` scratch tree and is therefore not part of this
repository's evidence: it reports the untargeted call exiting 0, silent, and
re-laying-out the active window in a single-window namespace. That is consistent
with section 9.1 and settles nothing beyond the single-window case, which is
precisely what the second probe exists to widen. That capture has now been
superseded by a committed measurement — see 9.3 — and unlike it, the measurement
is in a two-window namespace.

**Contributing evidence, not a decision.** The team-mode after-run applies a
TARGETED `select-layout` and the geometry moves: `select-layout -t probe:0
main-vertical` exits 0 with `%1 0 59` / `%2 60 140` / `%3 60 140` going to
`%1 0 119` / `%2 120 80` / `%3 120 80`
(`.omo/evidence/issue-1-team-layout-probe-after.json`, shim arm). That
targeted call travels psmux's validated temporary-focus path, whose source is:

- `src/server/connection.rs:1032` → `// Validated temporary focus (issue #545): the server resolves the`

with the focus request itself dispatched at:

- `src/server/mod.rs:1884` → `CtrlReq::FocusTargetTemp { win, win_is_id, win_name, pane, pane_is_id, resp } => {`

INFERRED: the targeted form therefore has both a mechanism (temporary focus
resolves the window before the command runs) and a measured application, which
is more than the untargeted form had at the time this was written. 9.3 now
supplies the untargeted form's measurement, and it is the two-window case this
argument said was missing.

### 9.3 The measurement

Source: `.omo/evidence/ci-layout-which-window.json`, produced by an automated
`windows-latest` run of `layout-which-window.cjs` against psmux `v3.3.8`
(`66cf6135`). Run id, commit under test, runner image and Bun version are in
`.omo/evidence/README-parity-ci.md`. Both windows carried two panes and
**different** layouts before any call, so a change on either is attributable:

```
window 0: 7f70  {71x30,0,0,1,48x30,72,0,2}   main on the left, 71/48
window 1: 7899  {59x30,0,0,3,60x30,60,0,4}   even, 59/60
```

| trial | window made current | applied, no `-t` | window 0 | window 1 |
|---|---|---|---|---|
| 0 | `lay2:0` | `even-horizontal` | `7f70` → **`7890`** (71/48 → 59/60) | `7899` unchanged |
| 1 | `lay2:1` | `main-vertical` | `7f70` unchanged | `7899` → **`7f79`** (59/60 → 71/48) |

Both calls: exit 0, stderr empty. Each changed **only** the window that trial had
made current, and neither touched the other.

**What this settles.** The untargeted call is not a silent no-op. It applies, and
it applies to the client's current window — `select-window` moves the target that
the next untargeted `select-layout` lands on. Option A is therefore correct:
pass OmO's `select-layout <layout>` through unchanged. That is what the bridge
does today, so **no code change follows from this measurement**; what changes is
that the rule stops being an assumption.

**What it does not settle, stated so it is not over-read.**

- One client, sequential trials. Two clients attached at once is a different
  question and this run says nothing about it. INFERRED and explicitly untested:
  each client probably carries its own current-window pointer, in which case two
  agents laying out concurrently would each hit their own window — but psmux's
  `active_idx` is server state (`src/layout.rs:1070`), so this cannot be asserted
  from what was measured.
- Rule 1b's and rule 1e's injected `select-layout main-vertical` inherits this
  behaviour, including its risk: if the current window is not the window OmO
  meant, the layout lands on the wrong one and reports success. **Now measured,
  2026-10-07 — see 9.4. The follow-up is not inert, but its target is server
  state the bridge does not set.**

- Nothing here bears on rules 1a/1b's `main-pane-width` geometry. That was
  unmeasured when this section was first written and is now measured separately —
  see section 3.9.

**A defect in the probe that was supposed to answer this.** The companion
artifact `ci-layout-probe.json` also carries a `which_window` control, and it is
**inconclusive by construction**: `layout-probe.cjs:94` applies
`even-horizontal` to each window in turn, but by that point window 0 is already
`f890`, which *is* the even split (59/60). Re-applying the layout already in
effect is correctly a no-op, so its "unchanged" rows say nothing about which
window is current. `layout-which-window.cjs` avoids this by starting the windows
in *different* layouts and varying the requested name so a change is possible.
Recorded rather than quietly dropped, because the two artifacts disagree on their
face and a reader deserves to know which one to believe.

### 9.4 Does the injected follow-up actually do anything?

Measured 2026-10-07, because 9.3's residual was not answerable from 9.3. Evidence
`.omo/evidence/ci-current-window-survival.json` from
`scripts/windows/parity/current-window-survival.cjs`; run id and commit under test
in `.omo/evidence/README-parity-ci.md`. Two windows reset to different layouts
before every reading, and the layout applied is `main-horizontal` — which differs
from both reset layouts, so any landing is visible and "nothing changed" is a real
answer rather than an artefact.

| reading | what ran | result |
|---|---|---|
| R3 control | `select-window`, then apply, **same process** | window **1** changed |
| R1 | `select-window` to 0 in one process, apply in another | **nothing changed** |
| R2 | `select-window` to 1 in one process, apply in another | **nothing changed** |
| R4 | **no `select-window` at all**, fresh process applies | window **1** changed |

**The good news first, because it is what rules 1b and 1e depend on.** Their
follow-up is spawned by `runFollowUps` as its own process, which is R4's shape: a
process that never issued a `select-window`. R4 changed a window, so **the
injected untargeted `select-layout` is not inert.** It does not need a
current-window pointer of its own.

**The risk, stated precisely.** R4 landed on window 1 because the session happened
to be in that state — the probe's own preceding targeted layouts had just touched
window 1. **That is not evidence that it lands on the window the caller meant.**
It is evidence that it lands on *whatever the server considers current*, and the
bridge does not set that. So the failure mode is not "the follow-up is dropped";
it is "the follow-up silently re-lays-out a window the caller did not name, and
reports success". 9.1 already established that this cannot be fixed by injecting
`-t`, because psmux strips it before dispatch.

**And a finding that was not being looked for.** R1 and R2 show that a
`select-window` issued by a process which then **exits** does not steer a later
process at all — the untargeted layout does nothing. So a client that selects a
window and disconnects leaves the server in a state where an untargeted layout is
a silent no-op, and OmO spawns one process per command, which is exactly that
shape.

**The sequence rule 1b actually emits was then measured directly, and it works.**
`main-pane-width-probe.cjs` step E puts a `select-window` from a process that exits
*between* rule 1b's option-set and its follow-up — the rule's own two commands plus
one it does not emit:

| step | share |
|---|---|
| reset to `main-pane-width 60` | 0.5917 |
| set `50`, then `select-window` from a process that exits | — |
| then the follow-up, untargeted `select-layout main-vertical`, in its own process | **0.4917** |

`rule_1b_survives_intervening_select_window: true`. So the intervening selection
does not disarm the remedy, and the risk this section raised does not apply to the
sequence the bridge emits.

**What is still not explained, and is not papered over.** R1/R2 and step E disagree
about what happens after an exited `select-window`: in R1/R2 an untargeted layout
changed nothing, in E one applied and moved the geometry. The difference between
the two probes is that E sets a sizing option immediately beforehand. A plausible
reading is that `apply_layout` did run in R1/R2 but had nothing to change, which
would make them consistent — but that is a guess about psmux's internals, it is not
measured, and this document does not record guesses as findings. So the narrow
question 9.4 was left with is now answered in the direction that matters (the
bridge's own sequence works) while the general question (when is a bare untargeted
layout inert, and why) stays open.

**Scope.** One session, one window each of two, sequential, v3.3.8, one client at
a time. Not covered: more than two windows, or any layout other than
`main-horizontal` / `main-vertical` / `even-horizontal`. Concurrent clients are
covered next, in 9.5.

### 9.5 Concurrent clients collide, and this one is a real risk to the bridge

Measured 2026-10-07. Evidence `.omo/evidence/ci-concurrent-clients.json` from
`scripts/windows/parity/concurrent-clients.cjs`; run id and commit under test in
`.omo/evidence/README-parity-ci.md`. This is the last claim 9.3 left INFERRED and
9.4 explicitly declared uncovered.

Two clients, each naming a **different** window, then each applying an untargeted
layout the other window is not already in. Both phases are pairs of overlapping
psmux processes:

| trial | result |
|---|---|
| serialised (2.5 s between phases) | **only window 0 changed**, `7f70` → `7890` |
| concurrent (0.7 s between phases) | **nothing changed** |
| `concurrency_changed_the_outcome` | **true** |

All eight invocations exited 0. The probe refuses to compute any verdict key
unless they all did, because its first run reported an empty result for both
trials — every invocation had exited 1 on a `cmd.exe` quoting error — and an empty
result from a probe that never ran is indistinguishable in the artifact from an
empty result that means something.

**What it shows.** In the serialised trial, client B's `tiled` landed on window
**0** — the window client **A** had selected — and client A's `main-horizontal`
left no visible trace anywhere. Both clients succeeded. So the current-window
pointer is **global server state, not per-client**: the last `select-window` wins,
and every untargeted layout issued afterwards lands on that one window. This is
`active_idx` at `src/layout.rs:1070`, behaving as one value for the session, which
9.3 flagged as the reason the claim could not be asserted and 9.1 made
un-targetable — psmux strips `-t` before dispatch.

**Why this matters here and not merely as trivia.** Team mode creates several
agents laying out at the same time, and rules 1b and 1e each inject an untargeted
`select-layout`. Two overlapping injections therefore either collide on one window
(what the serialised trial shows) or both do nothing (what the concurrent trial
shows). In both cases the layout lands somewhere the caller did not name, and every
invocation reports success. **This is the one measured defect in this document that
the bridge cannot work around**: rule 1a can be dropped when psmux learns to parse
a percentage, rule 1b when the option is read outside `apply_layout`, rule 1c when
`sizes` stops being proportions — but there is no bridge-side fix for a global
current-window pointer, because the only handle psmux offers (`-t`) is discarded
before dispatch.

INFERRED, explicitly untested: whether this bites in practice depends on how often
two injections overlap, which this run does not measure — it forced overlap in
both trials. A real team-mode session may rarely collide. That is the difference
between a defect that is certain and one that is merely possible, and this
document does not have the data to say which.

**Scope.** One session, two windows, two clients, v3.3.8. Not covered: more than
two clients, more than two windows, or a real OmO team-mode sequence.

---

## 10. The `#{pane_start_command}` trap

`#{pane_start_command}` answers `app.default_shell` for **every** pane at
v3.3.8:

- `src/format.rs:1525` → `"pane_start_command" => app.default_shell.clone(),`

There is no per-pane value. It ignores whatever command the pane was actually
started with.

**Contract consequence: pane ownership must never be keyed on
`#{pane_start_command}`.** It cannot distinguish a placeholder pane from an
attach pane from an ordinary shell pane, so any teardown or bookkeeping logic
that reads it will act on the wrong pane, or on all of them.

INFERRED: the correct discriminator is something the bridge itself controls.
Since the bridge is the only party that inserts `--` and applies `-e` on the
respawn path (section 7), it can record pane ownership at the moment it performs
a translation, keyed on the pane id OmO itself supplies (`index.js:8414`,
`index.js:8501`). This is inference from the cited trap plus the cited pane-id
capture, and it is the reason `src/descriptor.ts` exists in this project.

---

## 11. psmux facts that constrain the design

### 11.1 One server process per session

psmux's model is the opposite of tmux's. There is no single psmux port to
discover, hardcode, or health-check:

- `docs/integration.md:421` → \`> **Supervising a namespace.** Unlike tmux, psmux runs one server process per\`
- `docs/scripting.md:420` → \`psmux runs one server per session, so this is session-scoped\`

INFERRED: N sessions means N servers and N unrelated ports. The bridge must
therefore never cache or hardcode a control port, and must resolve the port per
session, per invocation. This follows directly from one-server-per-session plus
the ephemeral-port allocation in section 11.2.

### 11.2 The control port is OS-assigned and ephemeral

- `src/server/mod.rs:884` → `let listener = TcpListener::bind(("127.0.0.1", 0))?;`

Port `0` is the OS "assign me any free port" sentinel. There is no base port, no
scan loop, and no configuration knob.

INFERRED: a port collision is structurally impossible, because binding port `0`
cannot fail with `EADDRINUSE`. That is why the bridge must not implement
collision handling or retry logic for psmux's own port, and why the separate
OpenCode port reservation in the port wrapper is a genuinely different problem
that does need its own protocol.

### 11.3 `PSMUX_DATA_DIR` is broken as an isolation lever at 3.3.8

The per-session named mutex is built from the session name alone, with no
component derived from the data root:

- `src/platform.rs:333` → `pub fn acquire_session_mutex(name: &str) -> Option<SessionMutex> {`
- `src/platform.rs:346` → \`let obj = format!("Local\\\\psmux-session-{sanitized}");\`
- `src/paths.rs:79` → \`if let Some(raw) = std::env::var_os("PSMUX_DATA_DIR") {\`
- `src/paths.rs:83` → \`"PSMUX_DATA_DIR must be an absolute non-empty path"\`

A search for `data_root_tag` across `src/` at v3.3.8 returns **zero**
occurrences, while the same identifier is present in master's `platform.rs`. So
the fix for this is master-only.

**Consequence: two different `PSMUX_DATA_DIR` roots cannot both hold a session
of the same name at v3.3.8** (upstream issue #599). Data-root isolation is not
available on the pinned version.

### 11.4 `-L` is the working isolation lever

- `docs/faq.md:120` → \`**Q: Can I run multiple isolated psmux servers?**\`
- `docs/faq.md:121` → \`A: Yes, use the \`-L\` flag for server namespaces\`

Server identity is `{namespace}__{session}`:

- `src/types.rs:1345` → `pub fn port_file_base(&self) -> String {`
- `src/types.rs:1346` → `if let Some(ref sn) = self.socket_name {`
- `src/types.rs:1347` → `format!("{}__{}", sn, self.session_name)`

INFERRED: because the namespace is folded into the discovery-file name and into
the mutex name, `-L alpha` and `-L beta` are fully independent. Every probe and
every test that must not touch the user's real registry must therefore use its
own `-L` namespace and must never rely on `PSMUX_DATA_DIR` for isolation. This
is the discipline the parity harness already used, per-side, to make pane ids
directly comparable.

### 11.5 Installed binary names and install directory

- `installer/psmux.nsi:34` → \`InstallDir "$LOCALAPPDATA\\psmux"\`
- `installer/psmux.nsi:35` → \`InstallDirRegKey HKCU "Software\\psmux" "InstallDir"\`
- `installer/psmux.nsi:87` → `File "${SOURCE_DIR}\psmux.exe"`
- `installer/psmux.nsi:88` → `File "${SOURCE_DIR}\pmux.exe"`
- `installer/psmux.nsi:89` → `File "${SOURCE_DIR}\tmux.exe"`

Three binaries are installed side by side, including `tmux.exe`. This is the
mechanism that makes `findCommandPath("tmux")` (`index.js:9072`) able to find
something at all on a Windows box with no tmux installed.

INFERRED: the shim must be named `tmux.exe` and must precede psmux's own
`tmux.exe` on PATH for interception to occur, and the launcher must resolve the
real psmux by absolute path from the registry key at `installer/psmux.nsi:35`
rather than by name, so that the shim cannot shadow the launcher. This is the
concrete form the PATH-ordering requirement from section 4.5 takes.

---

## 12. Corrections to line numbers carried in the plan and draft

Every citation in this document was resolved by reading the cited line, not by
transcribing from the plan. Four numbers in the inherited material did not
resolve to the claimed content. The correct numbers are the ones used above.

| Claimed at | Claimed content | Actual | Status |
|---|---|---|---|
| plan todo 3 and todo 4, draft line 194 | `oh-my-openagent@5.1.17` is the installed bundle | `5.1.17` was never installed; the pin is `5.1.18` | **corrected**: document frozen against 5.1.18 (see also the second discrepancy in section 0.1) |
| draft line 224, `docs/tmux_args_reference.md:93` | the `respawn-pane` row documenting the `--` form | `:93` is the `rotate-window` row | **corrected**: the `respawn-pane` row is `:91` |
| draft line 232, `installer/psmux.nsi:89-91` | `psmux.exe`, `pmux.exe`, `tmux.exe` | `:90` is `README.md`, `:91` is `LICENSE` | **corrected**: the three binaries are `:87-89` (which the plan's todo 1 block already had right) |
| draft line 226 | `cached_shell()` "reads `$SHELL`" | no `$SHELL` read exists in `src/*.rs` at v3.3.8 | **corrected**: it walks `pwsh` → `powershell` → `cmd`; the draft's conclusion holds more strongly than stated |

Everything else resolved as written, including all the bundle line numbers in
the plan's todo 3 and todo 4 reference blocks, which are correct for 5.1.18.

---

## 13. Open questions carried forward

| # | Question | Settled by |
|---|---|---|
| Q-CONTRACT-1 | Does `select-layout <layout>` with no `-t` work against psmux 3.3.8, and which window does it act on? | **SETTLED 2026-10-07.** Measured on a `windows-latest` runner: it applies, and applies to the client's current window. Option A confirmed, no code change required. Section 9.3, evidence `ci-layout-which-window.json`. Residual, not closed: whether the current window is always the one OmO meant, and the two-concurrent-clients case. |
| Q-CONTRACT-2 | What is psmux 3.3.8's exact stderr text and exit code for `kill-pane` against a dead pane? Section 3.8 makes `/can't find pane/i` load-bearing. | todo 5 sub-probe (i) |
| Q-CONTRACT-3 | Does psmux 3.3.8 deliver `-e` to a `respawn-pane` pane when the bridge supplies it by its own route? Section 7.2 is source-read only. | todo 5 sub-probe (h) |
| Q-CONTRACT-4 | Which release will first contain `c20016c` and `4addc0a`? Section 8.2 is seeded `null` deliberately. | upgrade check, section 8.1 rule |

---

## 14. Maintenance

This document is only true of the oh-my-openagent recorded as
`omo.verifiedAgainst` in `scripts/contract/pins.json` (**5.1.21** at this
revision) and of psmux **v3.3.8**. When either is upgraded:

1. Run `bun run contract:fetch && bun run contract:verify`. This step used to be
   "a person with `sed`" and said so, because there was no checker to run; it is
   mechanical as of 2026-10-07 and runs in CI on every push. A non-zero exit means
   at least one citation no longer resolves, which means the contract changed —
   read the reported line, do not bulk-rewrite the numbers to make it green. One
   citation that no longer resolves is a fact about the world that this document
   is supposed to be reporting, so fix the prose, not the number. Note that a
   *passing* run means only that the quoted text is still on the cited line; it
   does not mean the conclusion drawn from that line is still correct. Steps 2
   through 8 are what cover that, and they remain human work.

   An OmO-side `PIN_DRIFT` additionally requires bumping `omo.verifiedAgainst` in
   `scripts/contract/pins.json` once the re-verification passes. That bump is the
   last step, not the first: re-verify first, because a pin that claims a version
   nobody checked against is worse than a pin that is honestly behind.
2. Re-check `respawn-window` for absence from the bundle, since its presence
   would make section 7.3 a live path.
3. Re-check the `-e` handling table in section 7.2, verb by verb.
4. Re-run the ancestry check in section 8.1 for both commits, and fill the
   `First release containing it` cells only from a real tag test.
5. Re-check the three layout rules in section 3.9 against the new psmux source,
   in the order they depend on each other: if `options.rs` learns to parse a
   percentage, drop rule 1a; if `apply_layout` reads the sizing option outside
   itself, drop rule 1b; only then drop rule 1c and forward `resize-pane -x` again.
   Dropping 1c first re-exposes the layout to the defect it was suppressing.

   **Rules 1a and 1b are now mechanically checkable, so do not check them by
   reading.** Both are observed rather than inferred as of 2026-10-07, and
   `.github/workflows/parity.yml` re-measures them on every run:
   `main-pane-width-probe.cjs` prints `rule_1a_percent_form_ignored`,
   `rule_1b_option_alone_inert`, `rule_1b_followup_applies` and
   `rule_1b_order_matters` as booleans. On a psmux that has learned to parse a
   percentage, `rule_1a_percent_form_ignored` flips to `false` — that is the
   retirement signal, and it arrives without anyone deciding to look for it.
   Retire in the order the booleans go false, not in the order that seems
   tidy: the dependency is 1a, then 1b, then 1c, and dropping 1c while 1a or 1b
   still holds re-exposes the layout to the defect being suppressed.

   Rule 1c has no such probe. Its premise is in `resize_pane_absolute` writing a
   cell count into a proportions vector (`src/tree.rs:21`/`:31`), so detecting its
   retirement means checking that `split_with_gaps` now takes absolute input —
   which is source-reading, and is left as such deliberately: a probe that inferred
   it would report on the layout rather than on the parser.
6. Re-resolve every team-mode citation in section 3.10 by hand, on either
   upgrade (OmO or psmux): the `createTeamLayoutInCallerWindow` sequence, the
   `resolveCallerTmuxSession` display pair, the `TeamModeConfigSchema`
   defaults, the `mod.rs` pane-option refusal, the `options.rs` / `layout.rs`
   sizing path, and the `main.rs` display-client parse. One citation that no
   longer resolves means the team-mode contract changed.
7. Re-check the `display` `-F` classification in the new psmux client source:
   if `-F` is parsed as the format selector for `display` / `display-message`,
   retire rule D0 per section 8.2; other verbs' `-F` was never rewritten and
   needs no check.
8. Re-check pane-option support in the new psmux server source: if psmux
   stores arbitrary pane options, retire rule 1d per section 8.2. Only then
   revisit the rules: re-run the ancestry check in section 8.1 for any
   candidate fix commit, and re-measure the team-layout probe before changing
   rule 1e, since its caller-is-main assumption rests on a measured run, not
   on source alone.

Until step 1 passes for every citation, treat any bridge behaviour as unverified.
