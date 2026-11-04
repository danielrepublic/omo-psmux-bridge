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

**Which version this document was last verified against:** **5.1.60**, read from
that package's own `package.json`. This number is a *record of a past
verification*, not an install instruction, and the two must not be confused —
that confusion is what made the pin unusable before.

`scripts/contract/pins.json` carries both halves as `omo.bundleGlob` and
`omo.verifiedAgainst`, and the checker compares them on every run:

| installed in `@latest` | `omo.verifiedAgainst` | result |
|---|---|---|
| 5.1.43 | 5.1.43 | clean |
| 5.1.44 | 5.1.43 | `PIN_DRIFT`, naming both |

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
triple, the five payload verbs, the `-e` auth environment, and the
`TeamModeConfigSchema` default still resolves
verbatim. The contract's claims survive; the pin did not, which is exactly the
asymmetry §14 step 1 exists to catch.

**Fourth discrepancy, recorded 2026-10-12.** The tree reached **`5.1.30`**, and
all 90 bundle citations were re-resolved against it. Of the 90, **89** were stale
and **1** still resolved on its cited line unaltered. Of the 89:

- **85** moved by line offset alone. Their quoted text was not touched; only the
  `index.js:NNNN` head was rewritten. The median offset was small and several
  whole regions shifted by a uniform +7, which is what a bundle of this shape
  does when unrelated code is inserted above.
- **4** needed the quoted text changed as well, and all four were the same
  thing: the bundler's zod alias counter renumbering `z44`→`z45` and `z48`→`z49`
  in the `TeamModeConfigSchema` and `TmuxConfigSchema` declarations. The schemas,
  their fields, their defaults and their consumers are otherwise identical.

  **Correction to the 85, recorded 2026-10-12.** The re-resolution above matched
  each quoted text by first global substring occurrence, and a scoped re-audit
  (each head checked against its enclosing function in the isolated `5.1.30`
  tree) found **18** of the 85 heads pointing at unrelated occurrences of generic
  text: `return [];` at `index.js:1228` (a JSON formatter, not
  `buildPaneAuthEnvironmentArgs`), `const args = [` at `index.js:3347` (a YAML
  directive parser, not `spawnTmuxPane`/`spawnTmuxWindow`), `] : [` at
  `index.js:4451` (a glob merger, not `spawnTmuxSession`), `continue;` at
  `index.js:195` (a string scanner, not the attach-URL skip), several
  `"-d"`/`"#{pane_id}"`/`placeholderCmd`/`"new-window"` heads citing a sibling
  call site's identical line, and both §3.6 title pairs collapsed onto
  `spawnTmuxPane` when the second belongs to `replaceTmuxPane`. All 18 now cite
  the line inside the function the surrounding clause names. The counts above are
  unchanged: the same 89 heads moved, only their destinations are now scoped
  rather than first-match.

  **Second correction, recorded 2026-10-12: bare refs are unchecked, and 23 of
  them were stale.** A *bare* reference — `` `index.js:NNNN` `` in prose with no
  `→` arrow and therefore no quoted text — is not a citation, so
  `contract:verify` neither parses nor checks it. The 90 verified heads are only
  half of what this document asserts about the bundle; the other half is
  unfalsifiable by the current checker. Measuring every bare reference against
  the isolated `5.1.30` tree found **23 stale tokens**, each off by the same
  uniform shift the verified heads were: the `8914`/`8920-8921`/`8937` layout
  triple and its four restatements, the `8915-8916`/`8918`/`8921`/`8922` spawn
  options and awaits, the `9083`/`8390` §4.4 INFERRED pair, the `26718` §4.5
  schema, `8501`/`8549` in the `--` trap, `8336` in §2.2, and the `8414`/`8501`
  pane-id pair in §12. All 23 are corrected here. Every bare reference now names
  a line that holds what its clause says it holds.

  The honest statement of the gap is this: **`contract:verify` is sound about
  citations and silent about bare references, and a silent check reads as a
  passing one.** Until a bare `index.js:NNNN` is either given quoted text or
  rejected, the number of bundle claims this document makes is larger than the
  number it proves, and no green run closes that difference. §14 step 1 says to
  re-resolve *the citations*; from here it has to mean the bare refs too.

At that verification, `omo.verifiedAgainst` became `5.1.30`.

**5.1.21 → 5.1.30 changed nothing this document depends on.** This is a
measured result, not an assumption, and it was measured by diffing each cited
region between the two bundles rather than by re-matching quoted text. Every
region this document cites — `spawnTmuxPane`, `replaceTmuxPane`,
`activateTmuxPane`, `spawnTmuxWindow`, `spawnTmuxSession`, the `closeTmuxPane`
teardown, the layout triple, the attach-URL sweep, `findVerifiedTmuxPath`,
`resolveCallerTmuxSession`, `createTeamLayoutInCallerWindow`, and
`resolveServerUrl` — is byte-identical between the two bundles under a constant
line shift (+7 for all but `resolveServerUrl`, which moves +5413). The five
payload verbs, the `-e` auth environment, the layout triple and both config
gates therefore all still resolve verbatim, and the gates are unchanged as
*behaviour*, not merely as quoted text: gate two reads
`!deps.isInsideTmux() && !deps.isCmuxCompatEnvironment()` in both, so the cmux
disjunct was already part of the contract at `5.1.21` and is not new here.

Three lines in the cited regions do differ, and all three are bundler artefacts
rather than behaviour: the module-local dependency bag is renamed
`defaultDeps7`→`defaultDeps8` at `index.js:19684` and `index.js:19732`, and the
tmux option-name constant's line differs only in its own bundler numbering. None
is quoted by this document and none changes an argv.

**Fifth discrepancy, recorded 2026-10-14.** The tree reached **`5.1.33`**.
Six of the 90 OmO citations moved while retaining their quoted text, and one
unchecked bare reference moved with them: the team-mode and tmux schemas moved
by +5 lines, while `resolveServerUrl` moved by +249 lines. The remaining 84 OmO
citations still resolve at their prior lines. The complete tmux/team region from
`isInsideTmuxEnvironment` through the team layout functions is byte-identical
between 5.1.30 and 5.1.33, as is the complete `resolveServerUrl` function after
accounting for its offset. The five payload verbs, argv ordering, auth `-e`
arguments, layout commands, and all three gates are therefore unchanged as
behaviour; this pass requires citation and doctor-anchor maintenance only.

**Sixth discrepancy, recorded 2026-10-19.** The tree reached **`5.1.35`**.
All 90 OmO citations moved; **85** by line offset alone and **5** with quoted
text changed. The offsets are small and regional: the pane-command head moves
−3 (helpers above it) then +7 to +10 (three new helpers and two new limit
constants inserted between the templates and the auth builder), the spawn and
teardown verbs move +5 to +7, the layout pair moves +2, the doctor-anchor gates
move −3 to +7, the schemas move +62, and `resolveServerUrl` moves +92. The five
text changes are all behaviour the document now depends on rather than bundler
renumbering: the `TMUX_COMMAND_SHELL` line now carries
`PLACEHOLDER_DESCRIPTION_LIMIT = 2000` and `PANE_TITLE_DESCRIPTION_LIMIT = 20`
(`index.js:8360`); the placeholder banner is built with the single-quote `Q`
helper instead of the deleted double-quote escaper (`index.js:8344`), and
`shellEscapeForDoubleQuotedCommand` returns zero occurrences in the bundle; both
title sites call `buildSubagentPaneTitle` (`index.js:8432`, `index.js:8519`);
and the team first-split working directory gains `escapeTmuxFormat`
(`index.js:19645`). The five payload verbs, argv ordering, auth `-e`
arguments, layout commands, and all three gates are unchanged as behaviour;
the placeholder change requires a bridge grammar and decoder update as well as
citation, claim, doctor-anchor, and installer-comment maintenance. Every citation
below was re-resolved in function scope
against the installed `5.1.35` bundle, not by first global match — the
correction recorded above for the `5.1.30` pass is the reason that scoping is
stated rather than assumed.

**Seventh discrepancy, recorded 2026-10-21.** The tree reached **`5.1.40`**.
Of the 90 OmO citations, **71 moved by line offset alone and 19 stayed on their
existing lines**: no quoted text changed, and no claim needed rewriting. The offsets are
small and regional, and each has a mechanical cause rather than a source change:

- The pane-command, spawn, teardown and layout regions all move by a uniform
  **+4**. The cause is a bundler module-order change, not an edit: the
  four-line `bun-spawn-shim` module initializer, which the `5.1.35` bundle
  emitted at the END of that region, is emitted at its START in `5.1.40`, so
  every line between the two points shifts down by four and every line after
  the end of the region shifts back to where it was.
- `findVerifiedTmuxPath` does not move at all, for the same reason: it sits
  after the point the shifted block moved to.
- The two zod config schemas move much further, because the whole
  config-schema block was **relocated** by the bundler rather than edited:
  `TeamModeConfigSchema` moves from `index.js:26998` in the `5.1.35` tree to
  `index.js:88956` in the `5.1.40` tree, and `TmuxConfigSchema` from
  `index.js:27071` to `index.js:89029` across the same move. Both schema
  bodies are byte-identical, field for field and default for default.
- `resolveServerUrl` moves by **+32**, from `index.js:156456` in the `5.1.35`
  tree to `index.js:156488` in the `5.1.40` tree, and its body is
  byte-identical.
- The team-mode region does not move at all: `resolveCallerTmuxSession`,
  `createTeamLayoutInCallerWindow`, `buildSplitArgs` and the `display` pair all
  keep their lines.

**Nothing this document depends on changed.** Every function this document
cites was extracted from both bundles and compared byte for byte — thirty of
them, from `isInsideTmuxEnvironment` through `spawnTmuxSession`, the layout
triple, `findVerifiedTmuxPath`, `resolveServerUrl`, the team-layout family and
both config schemas — and all thirty are identical. The five payload verbs, the
argv ordering, the `-e` auth environment, the layout commands, the `-F` rewrite
target and every gate in section 4 are therefore unchanged as *behaviour*, not
merely as quoted text. The translator needs no change and none was made: the
grammar region it implements is byte-identical between the two bundles. The
only textual delta anywhere in the cited surface is the bundler's import-alias
renumbering inside the two config-resolution helpers (`posix` to `posix4`,
`resolve` to `resolve9`, `join` to `join34`), which this document does not cite
and the doctor and installer cite only in comments.

**The cmux-auth skip branches are not new.** Each of the five payload-carrying
call sites skips an authenticated cmux pane, and the `spawnTmuxPane` one logs
`[spawnTmuxPane] SKIP: authenticated cmux panes are unsupported`. Those
branches were already present at `5.1.35`; they are not a consequence of this
upgrade, they only move with the region they sit in. No new gate is introduced
by `5.1.40`.

**The zod aliases did not churn at `5.1.40` -- but they did at `5.1.42`.** The
note below predicted that the four zod-alias citations would change again on
the next release, because the alias number is a bundler artefact rather than a
name. That prediction did not fire at `5.1.40`: `z45` and `z49` were the same
aliases in both bundles, and those four citations resolved unchanged apart from
the relocation. It **did** fire at `5.1.42`, where the eighth discrepancy below
records `z45`→`z46` and `z49`→`z50`: those four citations now name the new
aliases. The prediction therefore stands as a recurring risk, not a one-off:
the aliases are generated, and `PIN_DRIFT` naming them is the honest outcome
when they move.

**Eighth discrepancy, recorded 2026-10-23.** The tree reached **`5.1.42`**.
Of the 90 OmO citations, **84 stayed on their existing lines and 6 moved**:
no claim needed rewriting, and the tmux grammar region is byte-identical
between the two bundles, so no `src/*.ts` behaviour change was needed or made.
The six movers all shift by a uniform **+78**, the same kind of regional
bundler relocation recorded for the previous release:

- **4** are the zod-schema rows. Two alias renames account for all four text
  changes: `z45`→`z46` at `index.js:88956` (now `index.js:89034`) and
  `index.js:88958` (now `index.js:89036`) in `TeamModeConfigSchema`, and
  `z49`→`z50` at `index.js:89029` (now `index.js:89107`) and `index.js:89030`
  (now `index.js:89108`) in `TmuxConfigSchema`. The schema bodies are otherwise
  byte-identical, field for field and default for default.
- **2** are pure line moves with no text change: `resolveServerUrl` from
  `index.js:156488` to `index.js:156566`, and its port-0 fallback warning from
  `index.js:156498` to `index.js:156576`. Both bodies are byte-identical.

This **falsifies the "the zod aliases did not churn this time" claim recorded
for `5.1.40`** above. That claim was true of that release; it is not a
standing property of the bundle, and it did not survive the next one. The
config-resolution helpers also renumbered nothing this pass: `join34` and the
other import aliases cited in comments are unchanged, only their line numbers
move with the `+72`/`+78` regional shifts. Nothing else this document depends
on changed: the five payload verbs, the argv ordering, the `-e` auth
environment, the layout commands, the `-F` rewrite target, every gate in
section 4 and both schema bodies are unchanged as *behaviour*.

**Ninth discrepancy, recorded 2026-10-29.** The tree reached **`5.1.51`**.
Of the 90 OmO citations, **all 90 moved and none stayed**: every head names a
new line, and two quoted texts changed to track renamed upstream bytes (both
in `buildPaneAuthEnvironmentArgs`, section 2). The offsets are regional: the
pane-command, spawn, teardown and layout regions move **+52 to +59** (a new
pane-auth module emitted ahead of them accounts for the shift, while
`buildPaneAuthEnvironmentArgs` itself relocates earlier, from its 5.1.43 line
`index.js:8352` to `index.js:8266`); the two config schemas relocate by
**+2686** (`TeamModeConfigSchema` from `index.js:89034` to `index.js:91720`,
`TmuxConfigSchema` from `index.js:89107` to `index.js:91793`) with bodies
byte-identical and aliases unchanged (`z46`, `z50` — the churn recorded for
`5.1.42` did not fire again); the team-layout region moves by **+1567 to
+1579**; and `resolveServerUrl` moves by **+4439**, from `index.js:156566` to
`index.js:161005`, with its body byte-identical.

The tmux grammar region is otherwise byte-identical between the two bundles:
every cited function from `shellQuoteForNestedCommand` through
`sweepStaleOmoAttachPanesWith` was extracted from both trees and compared
byte for byte, and all are identical except the four auth functions named
below and one one-line caller change (`buildSplitArgs` now calls
`buildPaneAuthEnvironmentArgs`; upstream deleted the team-side
`buildPaneEnvironmentArgs`, which this document never cited). The five
payload verbs, argv ordering, layout commands, the `-F` rewrite target and
every gate in section 4 are unchanged as *behaviour*.

**5.1.51 added the one-use auth file prefix and `-e
OPENCODE_SERVER_PASSWORD_FILE`.** `buildPaneAuthEnvironmentArgs` no longer
emits `-e OPENCODE_SERVER_PASSWORD=<secret>`; it writes the secret to a
one-use file and emits `-e OPENCODE_SERVER_PASSWORD_FILE=<path>`, and
`withPaneAuth`, `buildTmuxAttachCommand` and `buildTmuxPlaceholderCommand`
now prepend the constant auth prefix —
`. "$OPENCODE_SERVER_PASSWORD_FILE" && rm -f --
"$OPENCODE_SERVER_PASSWORD_FILE" && ` in team send-keys text (raw), escaped
inside the subagent payload bodies — which sources and deletes the file
before the real command runs. With no password configured `withPaneAuth`
returns its input unchanged, so the unauthenticated payload is byte-identical
to the 5.1.48 form. The bridge now handles the prefix: it strips the escaped
form before template parsing while keeping the original bytes as provenance.
No claim is made about the upstream pane lifecycle: this pass moves citations
and records the prefix, and does not assert that any lifecycle behaviour was
fixed.

**Tenth discrepancy, recorded 2026-11-04.** The tree reached **`5.1.60`**.
All 90 OmO citations were re-resolved against it: **86** moved by line offset
alone and **4** changed their quoted text. The four text changes are the same
bundler artefact the eighth discrepancy recorded, one zod-alias generation
further on: `z46`→`z47` in `TeamModeConfigSchema` (`index.js:99875` and
`index.js:99877`) and `z50`→`z51` in `TmuxConfigSchema`
(`index.js:99948` and `index.js:99949`). The schemas are otherwise unchanged
apart from one new field: `TmuxConfigSchema` now carries
`isolation: TmuxIsolationSchema.default("inline")`. That default is the
previous behaviour, the fields this document cites keep their values, and the
gate in section 4.1 is unchanged.

The offsets are regional. The pane-command, auth, spawn, teardown and layout
region moves by a uniform **+1**; `TeamModeConfigSchema` and `TmuxConfigSchema`
relocate by **+8155** (91720→99875 and 91793→99948); the team-layout family
(`resolveCallerTmuxSession`, `listPanesInWindow`, `buildSplitArgs`,
`createTeamLayoutInCallerWindow`) moves by **+456**; and `resolveServerUrl`
moves by **+8740** (161005→169745).

The combined pane-auth and team-layout region, and the `resolveServerUrl` body,
were extracted from both bundles and compared byte for byte. They are identical
under those constant shifts: the five payload verbs, the argv ordering, the
`-e` auth environment, the `-F` rewrite target, the layout triple and every
gate in section 4 are unchanged as *behaviour*. The bridge therefore needs no
`src/*.ts` change for `5.1.60`; this pass is citation, doctor-anchor and version
maintenance only. The unauthenticated payload remains byte-identical, and the
one-use auth file prefix is unchanged.

**A note on the bare references in the dated paragraphs above.** A bare
`` `index.js:NNNN` `` inside a discrepancy record names a line in the tree that
record describes, not in the current one — the `5.1.30` correction cites the
`5.1.30` tree, and the sixth discrepancy cites the `5.1.35` tree. Those are
left as they were written, because rewriting them would falsify the record
they are. A record that names both trees, like the seventh discrepancy above,
says which is which in the sentence. Every bare reference OUTSIDE those
records names a line in the current tree, and all of them were re-resolved in
function scope for this pass.

Note the asymmetry with
§0.2 — the psmux tree is pinned to a commit and did not move at all, so all 90
psmux citations were untouched by this pass, and that is also why they are worth
having a mechanism for in the first place.

The four zod-alias citations will churn again on some future OmO release,
because the alias number is a bundler artefact rather than a name. That is the
cost of quoting a generated identifier, and `PIN_DRIFT` naming it is the honest
outcome — the alternative, quoting a shorter span that dodges the counter, would
cite a fragment too small to carry the claim. The seventh discrepancy above
records that the churn did **not** happen at `5.1.40`; the eighth records that
it **did** happen at `5.1.42` (`z45`→`z46`, `z49`→`z50`). This is therefore a
recurring cost rather than a one-off: the aliases survived one release and
moved on the next.

### 0.2 psmux

All **current** psmux citations are from **tag v3.4.0**, commit
`20aa1d7254ee93f64dafa059ef89341d9767470a`, checked out at **`.contract/psmux`**
— inside this repository, git-ignored. psmux's master branch diverges from any
tagged tree, so line numbers do not transfer between trees. Every unqualified
`src/...:LINE` reference in this document states v3.4.0. Facts that are true only
of the previously pinned **v3.3.8** tree are labelled v3.3.8; historical arrow
citations use a commit-pinned GitHub permalink, never the v3.4.0 checkout, and
the remaining historical line numbers are bare and explicitly labelled. The bridge's
minimum supported psmux is **exactly 3.4.0** (INSTALL.md): v2.0.0 retired the
compatibility responses whose upstream cause v3.4.0 fixed (rule 1a, the
respawn `--` insertion, rule 1d), while the env-slot credential delivery is
kept as the credential boundary rather than as a 3.3.8 shim.

**The checkout path moved, 2026-10-07, and this is a correctness fix rather than
a preference.** The pin used to be `/tmp/opencode/psmux-src`. That path is under
`/tmp`, so the checkout evaporated, and with it the only way to re-resolve the
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

**Re-verified 2026-11-04 against tag v3.4.0:** every psmux arrow citation
resolves on its cited line with its cited text, alongside the OmO citations; the
checker prints the exact total. The previous pin, v3.3.8, was re-verified on
2026-10-07 against a fresh clone (84 psmux citations at the time). That earlier
count and the two local-transcript references that failed it are historical;
see §7.1, where those references remain demoted to what the preamble's rules
require. Re-anchoring the pin does not prove the conclusions drawn from the
lines: the source is checked, the behavioural claims are not.

INFERRED: this document goes stale the moment either tool is upgraded. The
version pins above are the whole of the validity condition, so they are stated
before any claim rather than at the end.

---

## 1. The hardcoded shell

OmO does not ask what shell the platform has. It hardcodes POSIX `sh`, as a
module-level constant with no environment override, no platform branch, and no
configuration key:

- `index.js:8413` → `var TMUX_COMMAND_SHELL = "/bin/sh", PLACEHOLDER_DESCRIPTION_LIMIT = 2000, PANE_TITLE_DESCRIPTION_LIMIT = 20;`

This is the single most important clause in the document. Every payload OmO
emits begins with `/bin/sh -c "`, which does not exist on a stock Windows
machine. That is the entire reason a bridge exists.

### 1.1 The quoting helper

Values interpolated into the nested command are wrapped in single quotes and then
escaped. The escaping order is: single-quote replacement first, then a blanket
backslash doubling, then `$`, then backtick, then double-quote:

- `index.js:8385` → `function shellQuoteForNestedCommand(value) {`
- `index.js:8386` → `value.replaceAll("'`

### 1.2 The two payload templates

There are exactly **two** command strings OmO ever builds, and both hardcode the
shell from section 1.

**Template A: the attach payload.** Used when a pane becomes a real, focusable
subagent session.

- `index.js:8388` → `function buildTmuxAttachCommand(serverUrl, sessionId, directory = process.cwd()) {`
- `index.js:8393` → `opencode attach ${escapedUrl} --session ${escapedSessionId} --dir ${escapedDirectory}`

Rendered shape, with `Q` standing for whatever `shellQuoteForNestedCommand`
produced:

```
/bin/sh -c "opencode attach <Q(serverUrl)> --session <Q(sessionId)> --dir <Q(directory)>"
```

**Template B: the placeholder payload.** Used for the pane's brief pre-attach
life, so the pane is titled and survivable rather than dead on arrival.

- `index.js:8405` → `function buildTmuxPlaceholderCommand(description) {`
- `index.js:8408` → `const banner = shellQuoteForNestedCommand(\`OMO subagent pane ready: ${shown}\`);`
- `index.js:8411` → `while :; do sleep 86400; done`

The description is first NUL-stripped (`index.js:8395`, bare) and truncated to
2000 characters with an ellipsis (`PLACEHOLDER_DESCRIPTION_LIMIT`,
`index.js:8413`), then quoted with the same `Q` helper as Template A — not with
a separate double-quote escaper. The old `shellEscapeForDoubleQuotedCommand`
helper is gone from the bundle: a search for the name returns zero occurrences.
Both the banner and the hint (`"Focus this pane to attach."`) are
single-quoted `Q(...)` operands to `printf '%s\n%s\n'`.

Rendered shape, with `Q` standing for whatever `shellQuoteForNestedCommand`
produced and `<shown>` for the stripped, truncated description:

```
/bin/sh -c "printf '%s\n%s\n' <Q(OMO subagent pane ready: <shown>)> <Q(Focus this pane to attach.)>; while :; do sleep 86400; done"
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

- `index.js:8267` → `function buildPaneAuthEnvironmentArgs() {`
- `index.js:8268` → `const password = process.env.OPENCODE_SERVER_PASSWORD;`
- `index.js:8270` → `return [];`
- `index.js:8280` → `const args = ["-e", \`OPENCODE_SERVER_PASSWORD_FILE=${file}\`];`
- `index.js:8283` → `args.push("-e", \`OPENCODE_SERVER_USERNAME=${username}\`);`
- `index.js:8284` → `return args;`

### 2.1 The empty-`-e` case is the normal case

`OPENCODE_SERVER_PASSWORD` is unset in the ordinary case, so
`buildPaneAuthEnvironmentArgs()` returns an **empty array** (`index.js:8270`)
and the `-e` pairs simply do not appear in argv. The consequence for the
translator is precise and load-bearing: **`-e` must be a genuinely optional
element of the grammar, with a real zero-occurrence path.** A parser that
assumes at least one `-e` pair, or that requires a password to be set, is wrong
about the common case rather than an edge case.

INFERRED: because the empty case is the default, any bridge logic that
special-cases "the credential args" must be written against the empty array
first and treat the populated case as the exception. This follows directly from
`index.js:8270` returning `[]` whenever the password is falsy.

### 2.2 Credential in argv, recorded, not fixed

**Corrected 2026-10-29: the password value itself no longer travels in
argv.** At `5.1.51` the cited function writes the password to a one-use file
(mode `0600`, created exclusive) and places only the file path into argv; each
payload body sources and deletes that file through the `withPaneAuth` prefix
before the real command runs. The secret is therefore visible to process
listing only as a path, and only until the first payload consumes it. The
username, when set, is still placed into argv verbatim, so the two
consequences below stand with the redaction target widened from the password
value to the file path and the username:

- `index.js:8280` → `OPENCODE_SERVER_PASSWORD_FILE=${file}`

This is recorded as a non-blocking security note and explicitly **not** in
scope to fix, because the only fix would be patching OmO. Two consequences
bind the bridge:

1. The bridge's own logging must redact `-e OPENCODE_SERVER_PASSWORD_FILE=...`
   and `-e OPENCODE_SERVER_USERNAME=...` values.
2. Because the file path is already in argv before the bridge ever sees it,
   the bridge must not make it *more* exposed, which is why the argv it
   constructs for the respawn path is not logged in full.

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

- `index.js:8472` → `deps.isCmuxCompatEnvironment() ? buildTmuxAttachCommand`
- `index.js:8473` → `const args = [`
- `index.js:8474` → `"split-window",`
- `index.js:8475` → `splitDirection,`
- `index.js:8480` → `...targetPaneId ? ["-t", targetPaneId] : [],`
- `index.js:8481` → `...authEnvArgs,`
- `index.js:8482` → `initialCmd`
- `index.js:8484` → `const result = await runTmuxCommand(tmux, args);`

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

- `index.js:8571` → `const placeholderCmd = buildTmuxPlaceholderCommand(description);`
- `index.js:8572` → `["respawn-pane", "-k", ...authEnvArgs, "-t", paneId, placeholderCmd]`

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

- `index.js:8618` → `const opencodeCmd = buildTmuxAttachCommand(serverUrl, sessionId, directory);`
- `index.js:8619` → `const result = await deps.runTmuxCommand(tmux, [`
- `index.js:8620` → `"respawn-pane",`
- `index.js:8621` → `"-k",`
- `index.js:8625` → `opencodeCmd`

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

- `index.js:8688` → `const args = [`
- `index.js:8689` → `"new-window",`
- `index.js:8690` → `"-d",`
- `index.js:8692` → `ISOLATED_WINDOW_NAME,`
- `index.js:8695` → `"#{pane_id}",`
- `index.js:8697` → `placeholderCmd`
- `index.js:8718` → `var ISOLATED_WINDOW_NAME = "omo-agents";`

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

The window name is the literal `omo-agents`, from `index.js:8718`. There is no
`-t` on this shape.

### 3.5 `new-session`, and its already-exists variant (`spawnTmuxSession`)

This is one call site producing **two** argv shapes, chosen by a runtime branch:

- `index.js:8798` → `const args = sessionAlreadyExists ? [`
- `index.js:8799` → `"new-window",`
- `index.js:8801` → `isolatedSessionName,`
- `index.js:8807` → `] : [`
- `index.js:8809` → `"-d",`
- `index.js:8812` → `...sizeArgs,`
- `index.js:8817` → `placeholderCmd`

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

- `index.js:8489` → `const title = buildSubagentPaneTitle(description);`
- `index.js:8490` → `["select-pane", "-t", paneId, "-T", title]`
- `index.js:8577` → `const title = buildSubagentPaneTitle(description);`
- `index.js:8578` → `["select-pane", "-t", paneId, "-T", title]`

Exact argv:

```
select-pane
  -t
  <paneId>
  -T
  omo-subagent-<first 20 NUL-stripped chars of description, `#` doubled>
```

The title is built by `buildSubagentPaneTitle` (`index.js:8401`–`index.js:8404`,
bare): NUL-strip, slice to `PANE_TITLE_DESCRIPTION_LIMIT` (20, `index.js:8413`),
and `escapeTmuxFormat` doubling every `#` to `##` so tmux does not read it as a
format opener.

`select-pane` carries no payload, so by the definition in section 3 it is not
one of the five. It is listed because it always follows one of them.

### 3.7 Pane-id capture

- `index.js:8485` → `const paneId = result.output;`
- `index.js:8486` → `if (result.exitCode !== 0 || !paneId) {`

The pane id is read from `result.output` and is **not trimmed**, and an empty
string counts as failure. So the bridge must not introduce a trailing newline
into stdout of a `split-window`, `new-window` or `new-session` it forwards. This
is a byte-transparency requirement on the *response* side, not just the request
side.

### 3.8 Teardown, and the success-on-failure rule

- `index.js:8519` → `["send-keys", "-t", paneId, "C-c"]`
- `index.js:8522` → `["kill-pane", "-t", paneId]`
- `index.js:8524` → `result.exitCode !== 0 && /can't find pane/i.test(trimmedStderr)`

A `kill-pane` against an already-dead pane is **treated as success** by OmO, but
only when the stderr matches `/can't find pane/i`. If psmux's wording for that
condition differs, every close reports failure. This makes psmux's exact stderr
text load-bearing for teardown, and it is why todo 5 probes it.

### 3.9 Everything else is pass-through, except two live layout rules (plus retired rule 1a)

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
translate-stage concern. Two live rules carve the carve-out — 1b and 1c — and
each one is pinned to a named psmux defect still present at v3.4.0. A third
rule, 1a, used to carve it too; v2.0.0 retired it because v3.4.0 parses the
`%` form. Together the live rules are what makes the main pane occupy the
LEFT half of the window with the subagent panes stacked in the RIGHT half.

**What the carve-out costs, stated before the rules.** This section is not
"pass-through with a footnote". Of the live rules:

- **1b ADDS a backend invocation the caller never asked for.** For every
  `set-window-option` on a `main-pane-*` option, the bridge issues a second psmux
  command — `select-layout main-vertical` or `select-layout main-horizontal` —
  after the one OmO sent. On the three-command spawn sequence below the caller
  sends three invocations and the backend sees four.
- 1c drops a command outright and exits 0.
- Retired in v2.0.0: 1a used to rewrite an argument the caller sent
  (`set-window-option main-pane-width "50%"` → `… "50"`). The sizing argv is
  now forwarded byte-identically; only the 1b follow-up is added.

Nothing else in this document adds, drops or rewrites a backend command, and 1b
is the only place the bridge originates a call. A reader who assumes "the bridge
forwards what OmO sends, with the documented exceptions in section 7" will be
wrong about 1b, so it is disclosed here rather than left to be discovered from a
process trace.

The three commands OmO emits around every subagent spawn and every subagent
close, in this order, as three separate process invocations:

| # | argv | source |
|---|---|---|
| 1 | `select-layout main-vertical` | `index.js:8985` |
| 2 | `set-window-option <main-pane-width\|main-pane-height> <n>%` | `index.js:8991-8992` |
| 3 | `resize-pane -t <mainPaneId> -x <cells>` | `index.js:9008` |

`main-vertical` is the correct layout and the bridge does not change which layout
is used: in psmux it is the `Horizontal` split whose first child is the main pane
(`src/layout.rs:1369-1378`), i.e. main on the left and the rest in a right column.
`main-horizontal` would put the main pane on top.

#### Rule 1a — RETIRED in v2.0.0 (was: one trailing `%` stripped from a main-pane sizing option)

v2.0.0 forwards the sizing argv byte-identically: when the verb is
`set-window-option`, `setw`, `set-option` or `set`, and the option being set is
`main-pane-width` or `main-pane-height`, the value passes through unchanged
whether or not it ends in `%`. Nothing moves — same verb, same flags, same
order, same target, same value. The only addition on this path is rule 1b's
`select-layout` follow-up. What follows is the history of why the strip existed.

**The upstream premise is historical at v3.4.0.** Both setters now route through
`parse_main_pane_size`, which trims one trailing `%` before parsing:

- `src/server/options.rs:1022` → `"main-pane-width" => {`
- `src/server/options.rs:1023` → `if let Some(n) = parse_main_pane_size(value) { app.main_pane_width = n; }`
- `src/server/options.rs:80` → `pub(crate) fn parse_main_pane_size(value: &str) -> Option<u16> {`
- `src/server/options.rs:81` → `value.trim().trim_end_matches('%').parse::<u16>().ok()`
- `src/config.rs:1810` → `"main-pane-width" => {`
- `src/config.rs:1811` → `if let Some(n) = crate::server::options::parse_main_pane_size(value) {`

At v3.3.8 both setters parsed a bare `u16` instead; the old source is preserved
as history:
[`options.rs:527-528`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/server/options.rs#L527-L528)
and
[`config.rs:1207-1209`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/config.rs#L1207-L1209).
There, `"50%".parse::<u16>()` failed, the `if let Ok(n)` arm never fired, and
the option was silently never set. tmux accepted `50%`, so OmO's spelling was
correct and psmux's parser was the defect.

**Partly corroborated by psmux's own test suite.** The integer path is asserted
at v3.4.0 exactly as it was at v3.3.8:

- `tests-rs/test_config_exhaustive.rs:1545` → `fn cli_set_main_pane_width() {`
- `tests-rs/test_config_exhaustive.rs:1548` → `assert_eq!(app.main_pane_width, 60);`

That test drives `set-option -g main-pane-width 60` and asserts the option lands,
so the integer path is asserted by psmux's authors, not merely read off a source
line. It does not assert the `%` path; the v3.4.0 observation below does.

**MEASURED 2026-10-07 at v3.3.8. This rule's premise held there.** Evidence
`.omo/evidence/ci-main-pane-width-probe.json`, produced by an automated
`windows-latest` run of `main-pane-width-probe.cjs` against v3.3.8; provenance
including run id and commit under test is in `.omo/evidence/README-parity-ci.md`.
Main-pane share of the window width, read at every step:

| step | share | what it shows |
|---|---|---|
| baseline, option never set | **0.5917** | psmux's ~60% default, matching `src/layout.rs:1338` |
| `set-window-option main-pane-width "50%"` | **0.5917** | the `%` form was stored as nothing — the v3.3.8 premise |
| then an untargeted `select-layout main-vertical` | 0.5917 | nothing to apply, because nothing was stored |
| `set-window-option main-pane-width "50"` | 0.5917 | the bare form stores, but applying it is deferred |
| then an untargeted `select-layout main-vertical` | **0.4917** | the stored 50 takes effect only once a layout runs |

0.5917 against a `min(95)`-capped 60 default is psmux's own fallback, and 0.4917
is the stored 50. Both numbers are shares rather than column counts because a
bare `pane_width` cannot distinguish "50% of 199" from "50% of 120" — which is
exactly how the single `119` in `issue-1-team-layout-probe-after.json` came to
read as proof of this rule when it was the 60% default instead.

**Scope of that measurement.** One session, one window, one client, sequential
calls, v3.3.8. It does not cover a multi-window session, nor two clients at
once, and it does not cover `main-pane-height`.

**MEASURED 2026-11-04 at v3.4.0: the `%` form now stores.** The independent
runtime artifact `.omo/evidence/psmux340-windows-parity.json` (one session, one
window, one client, 120-column window) recorded `set-window-option
main-pane-width "50%"` alone leaving the share at 0.5917, then an untargeted
`select-layout main-vertical` moving it to 0.4917 with no bare value stored in
between; on the height axis the same sequence went 0.5667 → 0.3667. Setting the
option alone is still inert; that is rule 1b's separate claim, not this one. The
3.4.0 parser and the observation agree that the percentage is stored, so **rule
1a is no longer needed by a 3.4.0 backend**.

**Retired in v2.0.0: the strip is gone.** The bridge makes no runtime version
decision and the v2.0.0 support floor is exactly psmux 3.4.0, so there is no
older backend left for the strip to serve. The paragraph above is retained as
history; the shipped behaviour is byte-identical forwarding. A value with no
`%`, or any other option name, was and remains forwarded byte-identically.

#### Rule 1b — the matching layout is re-applied after the option is set

Independently of the retired rule 1a, forwarding `set-window-option` alone changes nothing:
psmux reads the sizing option from **inside** the layout application, so setting
it does not re-lay-out. At v3.4.0 the read is window-local first, with the global
value as the fallback:

- `src/layout.rs:1300` → `pub fn apply_layout(app: &mut AppState, layout: &str) {`
- `src/layout.rs:1306` → `crate::server::options::window_local_option(app, window_index, name)`
- `src/layout.rs:1307` → `.and_then(crate::server::options::parse_main_pane_size)`
- `src/layout.rs:1311` → `let main_pane_width = window_main_size("main-pane-width", app.main_pane_width);`
- `src/layout.rs:1336` → `// Determine main-pane percentage`
- `src/layout.rs:1338` → `let main_v_pct = if main_pane_width > 0 { main_pane_width.min(95) } else { 60 };`
- `src/layout.rs:1371` → `"main-vertical" | "main-v" => {`
- `src/layout.rs:1378` → `sizes: vec![main_v_pct, 100 - main_v_pct],`
- `src/layout.rs:1386` → `sizes: vec![main_v_pct, 100 - main_v_pct],`
- `src/layout.rs:1337` → `let main_h_pct = if main_pane_height > 0 { main_pane_height.min(95) } else { 60 };`
- `src/layout.rs:1351` → `"main-horizontal" | "main-h" => {`

`src/layout.rs:1378` is the two-pane shape and `src/layout.rs:1386` the nested
one; both put the main pane first in a root `Horizontal` split, which is why the
rule's injected command is layout-specific rather than layout-agnostic.

**Window-local lookup is new at v3.4.0 (#648), and it narrows what the follow-up
means.** A `set-window-option` without `-g` now writes the target window's own
option table (`src/server/connection.rs:3901` through
`src/server/connection.rs:3921`), and `apply_layout` reads the option from the
window it is applying the layout to, falling back to the global store. OmO emits
both calls without `-t` (`index.js:8991-8992`), so the write and the follow-up
land on the same active window. A caller that targets the write but leaves the
follow-up untargeted could split the two; the bridge is not such a caller and
does not invent a `-t` for the follow-up.

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

- `index.js:8990` → `if (layout.startsWith("main-")) {`
- `index.js:8991` → `const dimension = layout === "main-horizontal" ? "main-pane-height" : "main-pane-width";`

The re-applied command carries **no `-t`**, matching the `select-layout` shape
OmO itself emits at `index.js:8985`, and carries the same leading `-L` / `-S` /
`-f` globals as the primary command, so both reach the same psmux server.
Section 9 records separately that an injected `-t` would be discarded by psmux
before dispatch; this rule does not rest on that, and would be unchanged if
section 9 settled the other way. Its stdout, stderr and exit code are all
discarded: OmO spawns its own layout calls with `stdout: "ignore", stderr:
"ignore"` (`index.js:8986-8987`, `index.js:8992`) and awaits each without reading
a code (`index.js:8989`, `index.js:8993`), and the primary command's exit code is
the only one OmO branches on (`index.js:8486`).

**MEASURED 2026-10-07 at v3.3.8, and this rule needed it more than rule 1a did.**
The same run as rule 1a — `.omo/evidence/ci-main-pane-width-probe.json` — tests
both halves of this rule directly, and its `verdict` block reads
`rule_1b_option_alone_inert: true`, `rule_1b_followup_applies: true`,
`rule_1b_order_matters: true`.

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

**MEASURED 2026-11-04 at v3.4.0: the follow-up is still required.** The same
`.omo/evidence/psmux340-windows-parity.json` run recorded option-alone inert
(0.5917 unchanged, and the height axis 0.5667 unchanged), the untargeted
follow-up applying the stored value (width 0.5917 → 0.4917; height 0.5667 →
0.3667), and the reverse order — layout first, then set `40` — leaving the share
at 0.4917. Window-local lookup did not move the read out of `apply_layout`, so
rule 1b still has a live premise on 3.4.0. This differs from rule 1a: there the
3.4.0 source and observation removed the premise, and v2.0.0 retired the
translation.

`apply_layout` still has **no test coverage in psmux** — a search across
`tests-rs/` at v3.4.0 returns zero hits — so nothing here is asserted upstream.
That is no longer a gap in the evidence, because the behaviour is now observed
directly rather than inferred from the source.

**The height axis, measured too at v3.3.8.** Rules 1a and 1b name
`main-pane-height` beside `main-pane-width`, and the bridge treats them
identically — same option-parsing path, same follow-up shape, only the layout
name differs — so measuring one axis would have left half of each rule
unmeasured. Same run, same probe, `main-horizontal` instead:

| step | height share |
|---|---|
| baseline, option never set | 0.5667 |
| `set-window-option main-pane-height "40%"` | **0.5667** |
| `set-window-option main-pane-height "40"`, no layout | **0.5667** |
| then untargeted `select-layout main-horizontal` | **0.3667** |

At v3.3.8 the behaviour was identical on both axes: the `%` form was dropped,
the bare form stored and applied nothing on its own, and the follow-up applied
it. 0.3667 against a 30-row window is 11 of 29 available rows after the one-row
divider, which is what 40% of the usable space is. The width-axis rows in the
same artifact read 1.0 for height share, correctly — `main-vertical` splits side
by side, so the pane's height is the window's height. At v3.4.0 the `%` form
stores (retired rule 1a), but the option-alone/follow-up behaviour on the height axis is
unchanged, per the same 2026-11-04 artifact.

Scope matches rule 1a's: one session, one window, one client. Not covered:
multi-window sessions, or concurrent clients — the latter is measured separately
in section 9.5, where two clients collide.

INFERRED: with `main_pane_width = 50`, `src/layout.rs:1386` builds
`sizes: vec![50, 50]` at the root and `src/layout.rs:1382-1383` gives the
right-hand column `equal_sizes` shares, so a 200-column window should show a main
pane of 99 cells with the remainder in the right column, and a 240-column window
a main pane of 119.

**Two of the three things this paragraph used to leave open are now measured, and
the third is corrected above.** The order — option before layout — is no longer
structural-by-inference: the probes ran both orders and only option-then-layout
moved the pane (see the tables above). The `50%`-vs-`50` storage difference was
rule 1a's at v3.3.8; at v3.4.0 both forms store, while setting either one alone
is still inert. The column counts below remain INFERRED arithmetic
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
`src/layout.rs:1338` — the value this whole rule exists to change. If rule 1a
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

- `src/window_ops.rs:3241` → `let new = target.max(1);`
- `src/window_ops.rs:3243` → `sizes[idx] = new;`
- `src/window_ops.rs:3245` → `if idx + 1 < sizes.len() {`
- `src/window_ops.rs:3246` → `sizes[idx + 1] = (sizes[idx + 1] as i16 - diff).max(1) as u16;`
- `src/window_ops.rs:3247` → `} else if idx > 0 {`
- `src/layout.rs:1378` → `sizes: vec![main_v_pct, 100 - main_v_pct],`

Two properties of that code decide what a forwarded `-x` would actually do to a
`main-vertical` tree, and both are load-bearing for this rule:

1. **The tree is nested, so the root `sizes` array holds two elements, not three.**
   With more than one remaining pane, `main-vertical` builds a right-hand
   `Vertical` split and hangs it off the root `Horizontal` split
   (`src/layout.rs:1382-1387`), and `equal_sizes` always sums to 100
   (`src/layout.rs:1327-1334`). A flat three-element `[60, 20, 20]` is not a
   state this layout can be in.
2. **The difference is absorbed from exactly one neighbour** — the next sibling
   if there is one, otherwise the previous (`src/window_ops.rs:3245-3249`). No
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
`[197, 2, 80]`. Nothing captured that run.

**MEASURED 2026-10-07 — this rule is now observed, not inferred.** Evidence
`.omo/evidence/ci-resize-pane-cells-probe.json` from
`scripts/windows/parity/resize-pane-cells-probe.cjs`; run id and commit under test
in `.omo/evidence/README-parity-ci.md`. Against a 120-column window carrying a
`main-vertical` two-pane tree:

| arm | main pane | share | reading |
|---|---|---|---|
| baseline, nothing resized | 71 | 0.5917 | psmux's ~60% default |
| `resize-pane -t <pane> -x 99`, **direct** | **117** | **0.975** | read as a PERCENTAGE |
| the same argv **through the shim** | 71 | 0.5917 | suppressed by rule 1c, geometry untouched |

117 columns is not 99. It is 98% of the window: with the one-column divider,
119 usable columns times 0.99 is 117. **The cell count arrives as a percentage**,
which is the whole claim of this rule, and it now rests on an observation rather
than on a reading of `src/tree.rs`.

The second row is the bridge half. A rule that drops a command is only earning its
keep if forwarding that command would have done damage, and this is the first
measurement of that: the identical argv, unrouted, reaches ~98% of the window;
routed through the bridge, nothing moves at all.

**Scope.** One session, one window, two panes, one client, v3.3.8. Not covered:
`resize-pane -y`, the `-l` form, a tree nested more than two deep, or the
percentage form's conversion back to an absolute count, which remains the
INFERRED `src/server/mod.rs:7589` arithmetic above. **Reproduced at v3.4.0 on
2026-11-04:** the independent artifact `.omo/evidence/psmux340-windows-parity.json`
recorded `resize-pane -t <pane> -x 99` direct at 117/120 (share 0.975) and the
identical argv through the bridge as a logged suppression with the geometry
unchanged. The source cited below is the same code path in both tags; the
observation is what separates "still defective" from "read off the source".

No argument form rescues it. psmux parses a bare `-x` token as an ABSOLUTE value
and only treats a `%` suffix as a percentage, so there is no spelling of the cell
count that means "cell count" to it:

- `src/server/connection.rs:3105` → `if let Some(pct) = xval.strip_suffix('%').and_then(|n| n.parse::<u8>().ok()) {`
- `src/server/connection.rs:3107` → `} else if let Ok(abs) = xval.parse::<u16>() {`

**The parser looks correct, and stopping there concludes this rule is
unnecessary. That conclusion is wrong, and the mistake is worth naming because it
is the obvious one.** The two cited lines really do route a bare `-x 99` to
`ResizePaneAbsolute` rather than to the percentage arm — read in isolation they
look like working tmux semantics, and a reader who stops at the parse will
conclude rule 1c is superfluous.

The defect is one layer down, in what `resize_pane_absolute` does with the number:

- `src/window_ops.rs:3241` → `let new = target.max(1);`
- `src/window_ops.rs:3243` → `sizes[idx] = new;`

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
`src/server/connection.rs:3105` / `src/server/connection.rs:3107` will conclude
this bridge suppresses a command psmux handles correctly, and that conclusion is
wrong.

What the cited parser settles without a host run, and what it does not:

- `-x -20`: `strip_suffix('%')` yields nothing and `parse::<u16>()` fails on a
  leading minus, so neither arm fires and **no request is sent at all**. A true
  silent no-op.
- `-x 99%`: the percentage arm fires, and psmux converts the percentage straight
  back into an absolute cell count before resizing —
  `let abs_size = ((total as u32) * (pct as u32) / 100).max(1) as u16;`
  (`src/server/mod.rs:7589`) — which then lands in `resize_pane_absolute` as a
  cell count. A percentage does not buy a percentage. This is also why the 3.4.0
  team shape `-x "30%"` lands at 42/120 rather than a 30% share; rule 1e records
  that measurement and its unresolved bridge-side comparison.
- `-l 25`: **not a no-op, and not inert either.** `-l` matches neither the `-x`
  nor the `-y` arm, so control reaches the fallback, which takes the first
  argument that parses as a `u16` — `25` — as the amount, and defaults the
  direction to `"D"`:
- `src/server/connection.rs:3117` → `let amount = args.iter().find(|a| a.parse::<u16>().is_ok()).and_then(|s| s.parse::<u16>().ok()).unwrap_or(1);`
- `src/server/connection.rs:3122` → `else { "D" };`
- `src/server/connection.rs:3123` → `let _ = tx.send(CtrlReq::ResizePane(dir.to_string(), amount));`
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
invocations in the bundle are `index.js:9008` (`-x <cells>`) and `index.js:21703`
(`-x "30%"`, in team-mode layout). The second one is a percentage form, so rule
1c suppresses it as well, and by the `-x 99%` reasoning above that suppression is
correct on psmux. An agent-authored `-l` argv is not off-path in the same way and
would need its own decision, which this document does not make.

`-Z` is **not** affected. Zoom is a different request, checked before the `-x`/`-y`
arms, and it works:

- `src/server/connection.rs:2488` → `"zoom-pane" | "resize-pane" | "resizep" if args.iter().any(|a| *a == "-Z") => { let _ = tx.send(CtrlReq::ZoomPane); }`

`resize-pane -Z` is forwarded byte-identically.

**The tradeoff, stated plainly.** This is a deliberate, user-approved decision to
lose a command rather than forward it. It is safe because rule 1b already
produces the geometry the command was trying to produce, so `resize-pane -x` is a
no-op in *intent* — and forwarding a no-op that is actively destructive is strictly
worse than dropping it. The cost is that the bridge is now suppressing a command
OmO believes it sent, and that suppression has to be visible rather than silent,
which is why it is a distinct translation kind and a distinct outcome in both logs
(`kind: "suppressed"`, `outcome: "suppressed"`) with the dropped argv still
recorded. Nothing else in this document suppresses a command.

### 3.10 Team-mode visualization: the `createTeamLayoutInCallerWindow` family, and rules 1e and D0 (plus retired rule 1d)

**What is verified here, and what is not — stated before the rules rather than
after them.** Every psmux line this section cites is now mechanically re-checked
against the pinned tree: `bun run contract:verify` reads all 200 citations in this
document and reports 0 problems, including the 90 on the psmux side. So the
*premises* quoted below are confirmed present-and-unchanged at v3.4.0.

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
2. **A reader who knows psmux 3.4.0 disagrees with any rule here.** The rules
   carry file:line citations precisely so that can happen without trusting this
   document's conclusions.

The 2026-11-04 Windows parity probe measured the individual rules, but it did
not complete a full team-layout replay, and its one rule-1e through-bridge
observation is inconclusive (section 3.10 rule 1e). Treat the *shape* of these
rules as well-corroborated and their *consequences* as argued rather than
demonstrated.

OmO's team-mode visualization is gated separately from the subagent-pane gates
in section 4. The config key is `team_mode.tmux_visualization`, off by default:

- `index.js:99875` → `var TeamModeConfigSchema = z47.object({`
- `index.js:99877` → `tmux_visualization: z47.boolean().default(false),`

(The schema runs to `index.js:99887`; the default is the whole of the gating
fact.) When `resolveCallerTmuxSession` (`index.js:21616-21637`) returns null,
no layout is attempted at all:

- `index.js:21736` → `deps.log("tmux visualization requires a resolvable caller tmux pane, skipping", { teamRunId });`

The caller session is resolved with two `display` calls carrying `-F`:

- `index.js:21620` → `const sessionResult = await runCommand(tmuxPath, ["display", "-p", "-F", "#{session_id}", "-t", callerPaneId]);`
- `index.js:21628` → `const windowResult = await runCommand(tmuxPath, ["display", "-p", "-F", "#{session_name}:#{window_index}", "-t", callerPaneId]);`

and the returned strings must match the session and window-target patterns
(`index.js:21625` tests `TMUX_SESSION_ID_PATTERN` against the session id;
`index.js:21633` tests `TMUX_WINDOW_TARGET_PATTERN` against the window
target). Anything that corrupts the `display` output therefore skips the whole
team layout, which is why rule D0 below is load-bearing rather than cosmetic.

Per member, `createTeamLayoutInCallerWindow` (`index.js:21684-21707`) emits, in
this order: `list-panes` in the caller window first (via `listPanesInWindow`):

- `index.js:21656` → `const result = await deps.runTmuxCommand(tmuxPath, ["list-panes", "-t", windowTarget, "-F", "#{pane_id}"]);`

then `split-window`, built by `buildSplitArgs` (the first split carries
`-l 70%`; later splits carry no `-l`, alternate `-v`/`-h`, and split the middle
teammate pane rather than the last — second arm at `index.js:21670-21682`,
bare):

- `index.js:21668` → `return ["split-window", ...environmentArgs, "-t", callerPaneId, "-h", "-d", "-l", "70%", "-P", "-F", "#{pane_id}", "-c", escapeTmuxFormat(getPaneWorkingDirectory(member))];`

The working directory now travels as a `-c` operand, tmux-format-escaped
(`escapeTmuxFormat`, same `##` helper as the pane titles). The team attach
command itself is single-quote-only (`shellSingleQuote`,
`index.js:21611-21613`, bare), a narrower escaper than the subagent path's
`shellQuoteForNestedCommand`. No claim is made here about whether that narrower
escaper round-trips every directory spelling; the bridge forwards the team
attach verbatim and the classification below does not depend on it.

then a `select-pane` title call:

- `index.js:21695` → `await deps.runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", `${TEAM_PANE_TITLE_PREFIX}${member.name}`]);`

then two `set-option -p` calls:

- `index.js:21696` → `await deps.runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, OMO_ATTACH_SERVER_URL_OPTION2, serverUrl]);`
- `index.js:21697` → `await deps.runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, OMO_ATTACH_SESSION_ID_OPTION, member.sessionId]);`

then `send-keys` with the attach command plus `Enter`:

- `index.js:21698` → `await deps.runTmuxCommand(tmuxPath, ["send-keys", "-t", paneId, buildAttachCommand(member, serverUrl), "Enter"]);`

and after all members, a targeted `select-layout` and a caller resize:

- `index.js:21700` → `const layoutResult = await deps.runTmuxCommand(tmuxPath, ["select-layout", "-t", windowTarget, "main-vertical"]);`
- `index.js:21703` → `const resizeResult = await deps.runTmuxCommand(tmuxPath, ["resize-pane", "-t", callerPaneId, "-x", "30%"]);`

None of these carries a payload, so all classify as `pass-through`, and all
are handled on the translate stage on the same branch as rules 1b-1c. One live
rule (1e) plus rule D0 carve the carve-out, each pinned to a named psmux defect
still present at v3.4.0, plus the `display` rewrite that the whole sequence
depends on. A further rule, 1d, used to carve it too; v2.0.0 retired it, and the
two `@omo_attach_*` writes are now forwarded like any other `set-option`.

#### Rule 1d — RETIRED in v2.0.0 (was: `set-option -p ... @omo_attach_*` suppressed, not forwarded)

**Retired because the upstream premise is gone at v3.4.0.** psmux 3.3.8 refused
every pane-scoped option except `remain-on-exit`; v3.4.0 stores any `@name`
user option (#728), so the v2.0.0 floor removes the reason to suppress. v2.0.0
forwards both `@omo_attach_*` writes to psmux and reports psmux's own result.
OmO ignores both results either way.

At v3.4.0 the pane-option writer stores user options:

- `src/server/options.rs:1185` → `pub(crate) fn apply_set_pane_option(`
- `src/server/options.rs:1200` → `"remain-on-exit" | "@mouse-force" => {`
- `src/server/options.rs:1225` → `name if name.starts_with('@') && name.len() > 1 => {`
- `src/server/options.rs:1238` → `store.insert(name.to_string(), stored);`
- `src/server/mod.rs:5669` → `// #613 \`@mouse-force\`, #580 \`remain-on-exit\` and every`
- `src/server/mod.rs:5672` → `let reply = crate::server::options::apply_set_pane_option(`

The loud refusal that remains at v3.4.0 is only for non-`@` names:

- `src/server/options.rs:1245` → `"ERROR: pane-scoped option '{}' is not supported (supported: remain-on-exit, @mouse-force, any @user option)",`

At v3.3.8 the refusal covered the `@omo_attach_*` names; the old source is
preserved as history:
[`mod.rs:3862`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/server/mod.rs#L3862).
The bridge's call log used to record
`suppressionReason: "psmux-refuses-pane-scoped-options"`; that string named the
3.3.8 premise, not a current v3.4.0 fact. v2.0.0 removed the suppression and
the slug with it — `SuppressionReason` in `src/translate.ts` now carries only
rule 1c's slug — because a forwarded write needs no reason.

Forwarding is safe because OmO ignores both results: the two calls at
`index.js:21696-21697` are awaited bare, with no success check and no branch
on the outcome. `@omo_attach_session_id` has no readers anywhere else in the
bundle (a search for the string finds only its definition at `index.js:21804`
and the write at `index.js:21697`). The only reader of
`@omo_attach_server_url` skips a pane whose URL resolves to null:

- `index.js:9483` → `const rawServerUrl = pane.attachServerUrl || extractAttachServerUrl(pane.commandLine);`
- `index.js:9484` → `if (rawServerUrl === null)`
- `index.js:9485` → `continue;`

so absence reads as "unknown", not as failure.

**What the retirement changed, stated with the rule.** v2.0.0 performs the
backend invocation the old rule skipped: the two `set-option -p` writes run
against psmux and the bridge reports psmux's own result. Measured at v3.3.8
(history): through the old shim each of the four probe `set-option -p` calls
exited 1 with the refusal stderr above
(`.omo/evidence/issue-1-team-layout-probe-before.json`, direct and shim arms);
in the after-run the same four argv exit 0 with no backend call
(`.omo/evidence/issue-1-team-layout-probe-after.json`, shim arm). Measured at
v3.4.0: the direct writes exit 0 and `show-options -p -t <pane>` reads the
value back, and the bridge now forwards them the same way
(`.omo/evidence/psmux340-windows-parity.json`, `rule_1d`). Effects on
OmO's stale-attach sweep at v3.4.0 were not measured.

The retired rule was deliberately narrow: verb in the four set-option spellings, a
bare `-p`, and the option name one of exactly the two `@omo_attach_*` names.
`remain-on-exit` stays pass-through, `set` without `-p` stays pass-through,
and no other option name is touched. v2.0.0 forwards these argv without matching
them at all.

#### Rule 1e: the team resize becomes `set-option main-pane-width <n>` plus a re-applied layout

`resize-pane -t <callerPane> -x "30%"` (`index.js:21703`) carries a bare `-x`,
so rule 1c would suppress it, leaving psmux's 60% default. But this exact
shape is a PERCENTAGE on `-x` with no `-y` and no `-Z`, and psmux has a sizing
option that means the same thing: `main-pane-width` is parsed as a bare
`u16`:

- `src/server/options.rs:1022` → `"main-pane-width" => {`
- `src/server/options.rs:1023` → `if let Some(n) = parse_main_pane_size(value) { app.main_pane_width = n; }`

read from inside the layout application:

- `src/layout.rs:1336` → `// Determine main-pane percentage`
- `src/layout.rs:1338` → `let main_v_pct = if main_pane_width > 0 { main_pane_width.min(95) } else { 60 };`

and consumed by the `main-vertical` arm:

- `src/layout.rs:1371` → `"main-vertical" | "main-v" => {`
- `src/layout.rs:1378` → `sizes: vec![main_v_pct, 100 - main_v_pct],`

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
and `main-vertical` putting the main pane first (`src/layout.rs:1371-1378`);
the measured widths are what keep it honest.

**At v3.4.0 the backend defect is still present.** The 2026-11-04 parity probe
on a 120-column window measured `resize-pane -t <caller> -x "30%"` direct at
main width 42 (about 35%), while a direct `set-option main-pane-width 30` plus
`select-layout main-vertical` pair produced 35 (about 29%). The rewrite's
premise therefore still holds. The same probe's through-bridge arm recorded the
rewrite but left geometry at 59; the retained artifact lacks the target-window
context and the follow-up execution trace, so that outcome is inconclusive, not
a bridge verdict (`.omo/evidence/psmux340-windows-parity.json`, `rule_1e`).

#### Rule D0: the one non-final `-F` comes off `display` / `display-message`

psmux's client does not recognise `-F` for `display` / `display-message`: the
client-side match handles `-t`, `-p`, `-d` and `-I` and pushes every other
element into the message text, which is then joined, quoted and sent as the
- `src/main.rs:3928` → `"display-message" | "display" => {`
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
sites are `index.js:21620` and `index.js:21628`. Without this rule the whole
team layout is skipped: the corrupted `-F $N` output fails the session-id
pattern test, `resolveCallerTmuxSession` returns null, and the layout logs
the skip (measured baseline: `-F $1303` against the pattern at
`index.js:21625`; `.omo/evidence/issue-1-team-layout-probe-before.json`,
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

- `index.js:99948` → `var TmuxConfigSchema = z51.object({`
- `index.js:99949` → `enabled: z51.boolean().default(false),`

Off by default. This is the reason a stock Windows OmO produces zero panes and
no error.

### 4.2 Gate two: inside a multiplexer

- `index.js:8294` → `function isInsideTmuxEnvironment(environment) {`
- `index.js:8295` → `return Boolean(environment.TMUX);`
- `index.js:8300` → `function isInsideTmux() {`
- `index.js:8449` → `if (!deps.isInsideTmux() && !deps.isCmuxCompatEnvironment()) {`

The predicate is a bare truthiness test on the `TMUX` environment variable. No
value validation, no socket check, no liveness probe. Section 5 explains why
that is enough, given psmux.

### 4.3 Gate three: the OpenCode server answers a health check

- `index.js:8456` → `const serverRunning = await deps.isServerRunning(serverUrl);`
- `index.js:8461` → `const tmux = await deps.getTmuxPath();`
- `index.js:169745` → `function resolveServerUrl(rawServerUrl, env, log) {`
- `index.js:169755` → `ctx.serverUrl has port 0; falling back.`

INFERRED: `resolveServerUrl` reads `OPENCODE_PORT` and otherwise falls back to a
default, so on Windows an `opencode` that binds no explicit port produces a
server URL that the health check never reaches, and every pane is skipped with
no user-visible error. The citation supports the function's existence and the
fallback warning; the causal chain to "zero panes" is inference from gate three
plus that warning.

### 4.4 Gate four: a `tmux` on PATH that answers `-V`

This is the gate that makes the whole bridge mechanism work, and it is stricter
than it looks:

- `index.js:9139` → `async function findVerifiedTmuxPath() {`
- `index.js:9140` → `const path = await findCommandPath("tmux");`
- `index.js:9145` → `const verifyProc = spawn([path, "-V"], {`
- `index.js:9151` → `if (verifyExitCode !== 0) {`
- `index.js:8461` → `const tmux = await deps.getTmuxPath();`

**The contract consequence, stated as a requirement:** the shim must answer
`-V` with **exit code 0**. A shim that answers `-V` correctly but exits non-zero,
or that does not recognise `-V` and falls through to a passthrough that fails,
makes `getTmuxPath()` return null, and every tmux feature then silently no-ops
with no error at all.

INFERRED: the requirement that `-V` exit 0 is derived directly from
`index.js:9151` returning null on non-zero and from `index.js:8461` feeding that
null into the skip path. The silent-no-op consequence is inferred from there
being no error branch on that path.

### 4.5 There is no config field for the tmux binary

`TmuxConfigSchema` (`index.js:99948`) has no path or binary field, and its
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

- `src/pane.rs:2183` → `pub fn set_tmux_env(builder: &mut CommandBuilder, pane_id: usize, control_port: Option<u16>, socket_name: Option<&str>, session_name: &str, fix_tty: bool, _force_interactive: bool) {`
- `src/pane.rs:2188` → `builder.env("TMUX", format!("{},{},0", crate::socket_path::server_tmux_env_path(socket_name), port));`
- `src/pane.rs:2191` → `builder.env("TMUX_PANE", format!("%{}", pane_id));`
- `src/pane.rs:2201` → `builder.env("MSYS2_ENV_CONV_EXCL", "TMUX");`

This closes gate two from section 4.2 with nothing done by the bridge: psmux
panes already have a truthy `TMUX`, so `Boolean(environment.TMUX)` is true.

`MSYS2_ENV_CONV_EXCL=TMUX` (`src/pane.rs:2201`) exists so that a Git Bash layer
cannot mangle the value on its way in. That is psmux handling its own
compatibility, not something the bridge must replicate.

INFERRED: because psmux sets these variables itself and correctly, any bridge
design that injected `TMUX` or `TMUX_PANE` would be adding a second, competing
source of truth for a value psmux already owns. The correct bridge behaviour is
to pass the environment through untouched on this path. This is a design
conclusion drawn from the three cited lines, not a claim about code that exists.

### 5.1 Why the bridge does not rely on psmux's pane shell

`/bin/sh -c ...` is translated by psmux before any shell runs, so changing
psmux's notion of the pane shell does not make POSIX semantics available: the
wrapper is detected and its payload is rebuilt for the resolved Windows shell.

- `src/pane.rs:2552` → `fn detect_bash_c_wrapper(cmd: &str) -> Option<(&str, &str)> {`
- `src/pane.rs:2555` → `("/bin/sh -c ", "sh"),`
- `src/pane.rs:3045` → `if let Some((inner_script, _)) = detect_bash_c_wrapper(trimmed) {`
- `src/pane.rs:1115` → `let mut shell_cmd = if command.is_some() {`
- `src/pane.rs:385` → `static CACHED_SHELL_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();`
- `src/pane.rs:446` → `pub fn cached_shell() -> Option<&'static str> {`

`detect_bash_c_wrapper` recognises and strips a `/bin/sh -c ` prefix, then hands
the remainder to `cached_shell()`, which is a `OnceLock` resolved once per
process (`src/pane.rs:385`). At v3.4.0 it first consults `$SHELL`, then walks
`pwsh`, then `powershell`, then `cmd` (`src/pane.rs:452` through
`src/pane.rs:457`). The branch at `src/pane.rs:1115` is on `command.is_some()`,
so a command-bearing pane and an interactive pane take different paths.

**Correction to the research draft, and the v3.4.0 change.** The draft states
that `cached_shell()` "reads `$SHELL`". At v3.3.8 that was false: a search for
`env::var("SHELL")` and `env::var_os("SHELL")` across `src/*.rs` returned
nothing. At v3.4.0 it is true: `cached_shell()` now consults `$SHELL` first and
accepts it only when it names a spawnable Windows shell (#683):

- `src/pane.rs:452` → `if let Some(from_env) = shell_from_env() {`
- `src/pane.rs:491` → `shell_from_env_value(std::env::var("SHELL").ok()?.as_str())`

The command-bearing path still runs through `build_command`, so `$SHELL` cannot
make `/bin/sh` semantics available; it can, however, change which shell runs the
translated command when the caller sets it to a Windows path. The bridge does
not set `SHELL` and forwards the environment untouched, so this is a backend
choice, not a bridge rewrite. The old claim that no `$SHELL` route exists is
therefore historical at v3.3.8 and no longer accurate at v3.4.0.

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

## 7. The three psmux respawn defects, and the bridge's response to each

All three were source-read facts at **v3.3.8**, the release the bridge's
compatibility responses were written for. **v3.4.0 now contains the upstream
fixes**: both `c20016c` and `4addc0a` are ancestors of the v3.4.0 tag
(§8.1). v2.0.0 moved the support floor to exactly psmux 3.4.0, so the `--`
insertion of §7.1 is retired; the env-slot delivery of §7.2 is kept as the
credential boundary (§8.2).

### 7.1 Defect 1: `respawn-pane` dropped a positional command operand at v3.3.8

At **v3.3.8** the command operand was read **only** behind `--`. There was no
positional fallback, so OmO's no-`--` argv (`index.js:8572`, `index.js:8620`)
lost its payload and the pane came back as a default shell.

**Fixed at v3.4.0.** The command is now read behind `--` or, when `--` is
absent, as the first positional operand that is not a flag or a `-c`/`-e`/`-t`
value:

- `src/server/connection.rs:528` → `fn respawn_positional_command(args: &[&str]) -> Option<String> {`
- `src/server/connection.rs:532` → `if a == "-c" || a == "-e" || a == "-t" {`
- `src/server/connection.rs:3494` → `let command = args.iter().position(|a| *a == "--")`
- `src/server/connection.rs:3498` → `format!("-- {}", requote_command_tail(tail))`
- `src/server/connection.rs:3521` → `let _ = tx.send(CtrlReq::RespawnPane(workdir, kill, command, empty, resp_s, env_sets));`

The v3.3.8 source is preserved as history:
[`connection.rs:2093-2106`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/server/connection.rs#L2093-L2106)
and
[`docs/tmux_args_reference.md:91`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/docs/tmux_args_reference.md#L91).

**Bridge response: none — the `--` insertion is RETIRED in v2.0.0.** The
`respawn-pane` argv is forwarded without an inserted `--`: 3.4.0 reads the
first positional command operand (connection.rs 528-532, 3494-3498), so there
is no older backend left for the insertion to serve. The `--` form is still
honored by psmux, but the bridge no longer emits it.

The reference documentation at v3.4.0 still documents the `-- <command>` form
(`docs/tmux_args_reference.md:93`), so a `--` in argv remains a legitimate
spelling — it is just no longer one the bridge adds.

**Withdrawn 2026-10-07: the "measured the difference directly" claim.** This
paragraph previously read "The prior session measured the difference directly"
and supported it with two lines from `omo-psmux-bridge.md:609-610`, comparing
`respawn-pane -k -t %1 <command>` against the `--` form. That file is the local
session transcript, which `.gitignore` excludes from this repository, so those
two lines are not a record this repository holds of anything. Under the
preamble's third category they are **inadmissible**: a measurement whose run
left no artifact under version control is never the ground for a conclusion.
They are removed rather than restated.

The conclusion is unaffected, because it never needed them. At v3.3.8 it rested
on the source linked above: the operand was unreachable without `--`, and the
reference table documented only the `--` form. What is withdrawn is the
*strength* of the claim, not its direction: this was verified by reading psmux,
and no artifact here records anyone watching the pane fail to start.

INFERRED: the retired `--` insertion changed the meaning of argv OmO emitted,
so it was a translation and not a passthrough, and it was confined to the
`respawn-pane` path. No other verb needs it, because no other verb had this defect.

### 7.2 Defect 2: `respawn-pane` dropped `-e NAME=VALUE` at v3.3.8

At **v3.3.8**, `-e` support was uneven across the verbs that accept it. Counting
`-e` handling inside each verb's parse arm:

| Verb | v3.3.8 parse arm | Handles `-e`? |
|---|---|---|
| `split-window` | `src/server/connection.rs:1092` | yes |
| `new-window` | `src/server/connection.rs:1062` | yes |
| `new-session` | `src/server/connection.rs:3353` | yes |
| `respawn-pane` | `src/server/connection.rs:2093` | **no** |
| `respawn-window` | `src/server/connection.rs:3580` | **no** |

Those v3.3.8 line numbers are historical. **Fixed at v3.4.0.** Both respawn arms
now read every `-e KEY=VALUE` through `env_flag_values` and send the pairs with
the respawn request:

- `src/server/connection.rs:549` → `pub(crate) fn env_flag_values(args: &[&str]) -> Vec<(String, String)> {`
- `src/server/connection.rs:3520` → `let env_sets = env_flag_values(&args);`
- `src/server/connection.rs:3521` → `let _ = tx.send(CtrlReq::RespawnPane(workdir, kill, command, empty, resp_s, env_sets));`
- `src/server/connection.rs:5482` → `let env_sets = env_flag_values(&args);`
- `src/server/connection.rs:5483` → `let _ = tx.send(CtrlReq::RespawnWindow(workdir, command, resp_s, env_sets));`

The helper's own comment records that `split-window` and `new-window` collect
their `-e` values inline, and that `new-session` did too at v3.3.8; the v3.4.0
change adds the two respawn verbs rather than replacing the other three paths.

**Bridge response: strip `-e` on all five payload forms and deliver the
assignments through the pane helper's environment slots.** This was introduced
for the 3.3.8 drop, but it is retained deliberately at v3.4.0: it is the one
credential-delivery mechanism, it keeps values out of the psmux argv, and it
preserves the helper's consume-once and verified-delete behavior (§2.2).
Forwarding `-e` through psmux instead would put the values back in argv and
bypass that boundary. The `OPENCODE_SERVER_PASSWORD_FILE` path
(`index.js:8280`) is delivered by the same mechanism.

INFERRED: the credential must still be redacted from the bridge's own logs
(section 2.2), and the env-slot/file delivery remains the shipped path at
v3.4.0: it is the credential boundary, kept deliberately rather than as a
3.3.8 shim.

### 7.3 Defect 3: `respawn-window` dropped every argument at v3.3.8

At **v3.3.8** the whole arm sent a request with no arguments at all. **Fixed at
v3.4.0** by the same `c20016c` helper:

- `src/server/connection.rs:5463` → `"respawn-window" | "respawnw" => {`
- `src/server/connection.rs:5483` → `let _ = tx.send(CtrlReq::RespawnWindow(workdir, command, resp_s, env_sets));`
- `docs/tmux_args_reference.md:94` → \`| \`respawn-window\` | \`respawnw\` | \`kc:e:t:\` plus a command | CLI, SRV, CFG |\`

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

Each workaround in section 7 exists because of a specific upstream defect. A
workaround is removed when its fix ships in a release **and** the minimum
supported psmux version moves past the release that still needs it. v2.0.0
moved that floor to exactly psmux 3.4.0, so the second clause now fires: the
responses whose upstream cause v3.4.0 fixed are retired in the table below.

### 8.1 Why a version string cannot settle this

A semver string in a config file cannot prove ancestry. `3.4.0` might contain
`c20016c` or might not, and nothing in the string says which. The ancestry check
is what settles it:

```bash
$ for c in c20016c1ebd8557748ca3c4a7e7f99f5d872aa90 4addc0a730e57f827c286c76eec24489a5667200; do
    git merge-base --is-ancestor "$c" v3.4.0; echo "$c => $?";
  done
c20016c1ebd8557748ca3c4a7e7f99f5d872aa90 => 0
4addc0a730e57f827c286c76eec24489a5667200 => 0
$ git tag --contains c20016c1ebd8557748ca3c4a7e7f99f5d872aa90
v3.4.0
$ git tag --contains 4addc0a730e57f827c286c76eec24489a5667200
v3.4.0
```

Both fixes are therefore in v3.4.0, and v3.4.0 is the first tagged release that
contains both. The retirement actions below were gated on the minimum
supported version, not on the tag name alone — and v2.0.0 moved that floor to
exactly v3.4.0, so the gate is now open.

### 8.2 The table

| Workaround | Defect | Upstream commit | Commit subject | Commit date | In a release? | First release containing it | Action when filled |
|---|---|---|---|---|---|---|---|
| RETIRED in v2.0.0: was inserting `--` before the payload on `respawn-pane` | 7.1, `respawn-pane` positional operand drop | `c20016c` | `fix(#580): accept the documented respawn shell-command operand and forward it whole` | 2026-09-03 | **yes** | **v3.4.0** | retired: the v2.0.0 floor is 3.4.0, which reads the first positional operand, so nothing is inserted. The `--` form is still honored by psmux but no longer emitted |
| Apply `-e NAME=VALUE` on the respawn path | 7.2, `respawn-pane` `-e` drop | `4addc0a` | `fix(#708): respawn-pane keeps the pane's history and applies -e` | 2026-09-29 | **yes** | **v3.4.0** | **do not retire the env-slot/file delivery when 3.3.8 is dropped**: it is the bridge's credential boundary, not only a 3.3.8 shim. The old "forward `-e` through" action is withdrawn |
| Nothing, off-path | 7.3, `respawn-window` argument drop | `c20016c` | same commit as row 1 | 2026-09-03 | **yes** | **v3.4.0** | no bridge change; re-check only if a future bundle emits the verb |
| RETIRED in v2.0.0: was stripping the `%` from `main-pane-width` / `main-pane-height` | 3.9 rule 1a, `options.rs` `u16` parse of a percentage | `38c5c037` | `fix(#628 follow up): type main-pane sizes as tmux does and report out of range values the way tmux does` | 2026-09-04 | **yes** | **v3.4.0** | retired: v2.0.0 forwards the sizing argv byte-identically; at v3.4.0 the `%` form stores |
| Re-apply the consuming layout after the sizing option | 3.9 rule 1b, `layout.rs` reads the option only inside `apply_layout` | `null` | not fixed in v3.4.0 | `null` | **no** | `null` | keep; setting the option still does not apply a layout |
| Suppress `resize-pane -x` / `-y` | 3.9 rule 1c, `window_ops.rs` writes a cell count into a percentage array | `null` | not fixed in v3.4.0 | `null` | **no** | `null` | keep; v3.4.0 still turns `-x 99` into about 98% of the window (parity probe: 117/120) |
| Drop the non-final `-F` on `display` / `display-message` | 3.10 rule D0, `main.rs` folds `-F` into the message text | `null` | not fixed in v3.4.0 | `null` | **no** | `null` | keep; the v3.4.0 client still prints `-F <value>` for these two verbs (parity probe) |
| RETIRED in v2.0.0: was suppressing `set-option -p ... @omo_attach_*` | 3.10 rule 1d, `mod.rs` refused pane-scoped options at v3.3.8 | `6685cf29` | `fix(options): pane scoped user options (#728)` | 2026-10-03 | **yes** | **v3.4.0** | retired: v2.0.0 forwards the options; at v3.4.0 they store and read back. The effect on OmO's stale-attach sweep is unmeasured |
| Rewrite the team `resize-pane -t <pane> -x "<n>%"` to `set-option main-pane-width <n>` plus `select-layout main-vertical` | 3.10 rule 1e, `connection.rs` has no percentage spelling that reaches psmux as a cell count | `null` | not fixed in v3.4.0 | `null` | **no** | `null` | keep until the v3.4.0 team-resize parity discrepancy is resolved; the direct backend still turns `-x 30%` into about 35%, not 30% |

Three rows are RETIRED in v2.0.0: the `--` insertion, rule 1a, and rule
1d. In each case the v2.0.0 floor (exactly psmux 3.4.0) removed the older
backend the response served. Rows 1b, 1c and D0 remain unfixed in v3.4.0 by
source and by the Windows parity probe. Row 1e stays until the team-resize
discrepancy below is resolved.

**Rule 1e is separate.** The v3.4.0 source still converts `-x <n>%` to a cell
count and then writes that count into the percentage array, so forwarding the
raw team resize is still not the intended 30%. The Windows probe also recorded
a through-bridge outcome that did not match its recorded rewrite; that
observation is inconclusive and needs a retained execution trace before any
retirement decision. The rule stays until that is resolved.

Full commit hashes, for exactness:

- `c20016c` = `c20016c1ebd8557748ca3c4a7e7f99f5d872aa90`
- `4addc0a` = `4addc0a730e57f827c286c76eec24489a5667200`
- `38c5c037` = `38c5c037d2edc6993ea36167b273a283e796a62c`
- `6685cf29` = `6685cf29ff9fd84f6e3a11edb306b7d6d0ea10da`

All four were resolved with `git log -1` in the pinned checkout, and all four
were tested with `git merge-base --is-ancestor` against v3.4.0. The tags
containing each are `v3.4.0`; none is an ancestor of v3.3.8.

### 8.3 `c20016c` also fixes defect 3

INFERRED from the diff: that commit introduces a
`respawn_positional_command` helper and applies it to **both** the
`respawn-pane` and the `respawn-window` arms. So defect 3 shares a retirement
condition with defect 1. v3.4.0 is the first tagged release containing it.

### 8.4 What does *not* retire

Defect 2's fix is a separate commit (`4addc0a`) from defect 1's (`c20016c`), but
both are in v3.4.0, so the hypothetical "one fix without the other" release does
not describe this pin. The bridge retains the env-slot delivery because it is
the credential boundary, not because `4addc0a` is absent.

---

## 9. `select-layout` with no `-t`: MEASURED, and Option A is correct

**Status as of 2026-10-07: settled by measurement at v3.3.8.** Option A holds
— an untargeted `select-layout <name>` **does** apply, and it applies to **the
window that client most recently made current**. The evidence is
`.omo/evidence/ci-layout-which-window.json`, produced by an automated
`windows-latest` run of `layout-which-window.cjs`; its provenance is recorded in
`.omo/evidence/README-parity-ci.md`. Section 9.3 reads the run out in full. What
follows is the reasoning that led there, kept because 9.3's conclusion is only
legible against it, and because one claim in it has since been **refuted by the
run** and is corrected in place.

**The v3.4.0 target machinery changed, and this measurement was not re-run.**
v3.4.0 replaced the fire-and-forget temporary focus with validated target
routing (section 9.2 and `src/server/connection.rs:2236`), so the v3.3.8
two-window result is not automatically a v3.4.0 result. The 2026-11-04 parity
probe measured only single-window rules. Treat Option A as measured at v3.3.8
and still consistent with the v3.4.0 source, not as re-measured at v3.4.0.

Nothing downstream may inject a `-t` onto `select-layout`. That was already
settled on source (9.1) and the measurement confirms it: an injected `-t` is
stripped before dispatch, so it cannot retarget anything.

OmO applies the layout with no target at all:

- `index.js:8969` → `function calculateMainPaneWidth(windowWidth, options) {`
- `index.js:8985` → `const layoutProc = spawnCommand([tmux, "select-layout", layout], {`
- `index.js:8992` → `const sizeProc = spawnCommand([tmux, "set-window-option", dimension, \`${mainPaneSize}%\`], {`
- `index.js:9008` → `await deps.runTmuxCommand(tmux, ["resize-pane", "-t", mainPaneId, "-x", String(mainWidth)]);`

Note the asymmetry in that last group. The **width** enforcement carries an
explicit target (`-t mainPaneId`, `index.js:9008`). The **layout** call does not
(`index.js:8985`). So `select-layout` is the odd one out among the layout verbs.

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

- `src/server/connection.rs:4470` → `"select-layout" | "selectl" => {`
- `src/server/connection.rs:4471` → `let layout = args.iter().find(|a| !a.starts_with('-')).unwrap_or(&"tiled").to_string();`
- `src/server/connection.rs:4472` → `let _ = tx.send(CtrlReq::SelectLayout(layout));`
- `src/server/connection.rs:2077` → `let target_scan_end = crate::cli::outer_target_scan_end(cmd, &args);`
- `src/server/connection.rs:2080` → `if args[i] == "-t" {`
- `src/server/connection.rs:2097` → `i += 2; continue;`

`-t` and its value are stripped from the argument vector **before any handler sees
it**, and `SelectLayout` carries no window at all:

- `src/server/mod.rs:6647` → `CtrlReq::SelectLayout(layout) => {`
- `src/server/mod.rs:6649` → `apply_layout(&mut app, &layout);`

INFERRED: an injected `-t` therefore cannot retarget the call — it is discarded
before dispatch, so Option B is not a riskier way of being right, it is a no-op
way of being wrong. On this specific point: **nothing downstream may inject a `-t`
onto `select-layout`.** That statement is scoped to `-t` and to what psmux does
with one; it does not depend on this section being settled, and it survives
unchanged either way. It is a statement about Option B's mechanics, not a
determination that Option A is correct.

What the source does **not** settle is Option A. `apply_layout` opens by taking
the active window and documents itself as acting on the current one:

- `src/layout.rs:1298` → `/// Apply a named layout to the current window.`
- `src/layout.rs:1300` → `pub fn apply_layout(app: &mut AppState, layout: &str) {`
- `src/layout.rs:1312` → `let win = &mut app.windows[app.active_idx];`

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

- `src/layout.rs:1415` → `_ => {`
- `src/layout.rs:1416` → `// Unknown layout name — try to parse as tmux layout string`
- `src/layout.rs:1422` → `let sizes = equal_sizes(pane_count);`

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

- `src/server/connection.rs:2236` → `// Validated target (issue #545): the server resolves the window/pane`

with the focus request itself dispatched at:

- `src/server/mod.rs:3000` → `CtrlReq::Targeted(target, inner) => {`

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

**RETRACTED AND REFUTED 2026-10-07.** The claim was: "a `select-window` issued by
a process which then **exits** does not steer a later process at all — the
untargeted layout does nothing." It rested on two readings whose `changed_windows`
were empty.

Those two readings **never issued the layout call.** Their recorded `apply_exit`
was `null`: the probe gated the call on `applyInSameProcess || skipSetCurrent`, and
both were `false, undefined`, so the step was skipped and the empty result recorded
the probe's own omission. An artifact contradicting the claim sat in the repository
the whole time, invisible because only `changed_windows` was read.

Re-run with the call unconditional, the claim is not merely unsupported — it is
**false**:

| reading | `apply_exit` | window that changed |
|---|---|---|
| R3 control, pointer and layout in one process | 0 | the one made current |
| **R1** pointer set to w0 by an earlier process, layout from another | **0** | **w0** |
| **R2** pointer set to w1 by an earlier process, layout from another | **0** | **w1** |
| R4 no `select-window` anywhere | 0 | w1 |

`pointer_survives_connection: true`. Each cross-process layout landed on the
window its earlier process had selected. **The pointer survives the connection, and
a later untargeted layout follows it.**

This is good news for rules 1b and 1e, and it is the opposite of what this section
claimed an hour ago: their follow-up does not merely work when nothing has touched
the window (R4), it lands on the window the caller's own earlier command selected.
The weakness recorded here before — "an untargeted layout may be inert in a real
session" — is **not supported**. What remains is 9.5's collision, which is about two
clients racing rather than about the pointer evaporating.

The generalisable lesson, since this is the second time a probe's silence was read
as a finding: `changed_windows` alone cannot distinguish "psmux declined" from
"the probe did not run". Every reading must record whether the call was issued —
`apply_exit` is that field — and a probe of an untargeted psmux command needs a
same-trial control, because psmux returns exit 0 whether it acted or not.

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

**Superseded — this "disagreement" was between a void reading and a real one.** This
paragraph originally reported that R1/R2 and step E disagreed about what happens after
an exited `select-window`, and left the general question open.

There was no disagreement. **R1 and R2 never issued the layout call at all** — see the
retraction above — so they were not evidence of inertness, and the tension was an
artifact of a probe that skipped a step. With the corrected readings, R1 and R2 both
applied their layout and landed on the window their earlier process had selected, and
the tolerance sweep below finds layouts applying at every gap from 0 ms upward. So the
question this left open — *when is a bare untargeted layout inert, and why* — is
**answered: it is not inert after an exited `select-window`**, and the apparent
inertness was a baseline collision in the measurement, twice over.

The bridge's own sequence therefore rests on firmer ground than this section claimed:
its untargeted follow-up applies, and it applies to the window the caller's earlier
command selected.

**The tolerance sweep, after two wrong turns of its own.** `collision-tolerance.cjs`
varies the delay between two clients' untargeted layouts — 0, 50, 150, 400, 1000,
2500 ms — to find how close they must be before they interfere. It ran for a while
reporting "nothing changed" at every gap. **That result was the probe's fault, twice
over, and both times the same fault: a baseline the operation could reproduce.**

First the control checked `tiled` from an `even-horizontal` baseline, but `tiled` on a
two-pane window *is* a balanced split, so a perfectly successful apply scored as
"not applied" — contradicting `test_layout.rs:159`, which lists `tiled` as accepted.
Then, once the control passed, the trial still reset w1 to `even-horizontal` and
ended with `tiled`, so

```
even-horizontal --A(main-vertical)--> main-vertical --B(tiled)--> even-horizontal
```

returned the window to exactly its starting state. A sweep in which **both layouts
applied perfectly** was scored `NONE` at every gap.

With the baselines fixed and the control passing, the sweep reports:

| gap (ms) | 0 | 50 | 150 | 400 | 1000 | 2500 |
|---|---|---|---|---|---|---|
| outcome | `CHANGED_ONE` (w1) | `CHANGED_ONE` | `CHANGED_ONE` | `CHANGED_ONE` | `CHANGED_ONE` | `CHANGED_ONE` |

**No disturbed outcome at any separation up to 2500 ms** — neither the `NONE` nor the
`BOTH_ON_ONE` that 9.5 calls a collision. Read narrowly, that is a result: no
separation in this range produced a collision.

**And the big one: the sweep is what refuted 9.4's own claim.** It was built on the
theory that an untargeted layout goes inert once a process has issued `select-window`
and exited, which is why `NONE` was expected at every gap. That expectation was
built on a baseline collision. Once the baseline stopped being reproducible, layouts
applied at every gap including zero. There was no inertness to find.

**A concurrent poller settles what the sweep could not.** The sweep samples only
before and after, so `CHANGED_ONE` on w1 is equally consistent with "A applied then B
overwrote it" and "only B applied" — B's layout is the end state either way, and A's
effect is gone before anything looks.

The obvious fix — sample between the two applies — does not work, and the artifact
shows why. `layouts()` is a `spawnSync`, so it blocks the event loop and both applies
have finished by the time it returns. The first attempt recorded `mid` and, at every
gap, `mid` was byte-identical to `after`: the sample was the end state wearing a
mid-flight label, and `a_landed_at_every_gap: true` was crediting A for a change B had
already made. Moving the sample earlier is not available either — it delays B's spawn
and changes the very gap the sweep exists to vary.

So the observer is replaced rather than repositioned. A **second process** polls
`list-windows` on its own clock, appending `{t, windows}` per snapshot, while the sweep
issues its applies. Each trial brackets itself with timestamps and the two timelines
are joined afterwards, so observing delays nothing it observes. A's and B's expected
trees come from the control, which already records what each name produces, so the
comparison is against a measured reference.

| gap (ms) | 0 | 50 | 150 | 400 | 1000 | 2500 |
|---|---|---|---|---|---|---|
| snapshots taken in the trial window | 27 | 28 | 31 | 36 | 47 | 80 |
| distinct states w1 held | **1** | **2** | **2** | **2** | **2** | **2** |
| snapshots showing A's layout | **0** | 2 | 4 | 9 | 21 | 53 |
| first sighting, ms after A's apply | — | 1 | −2 | 26 | 35 | 12 |

**A's layout is delivered and then overwritten, at every gap the poller can resolve.**
From 50 ms upward w1 genuinely holds two different states — A's tree, then B's — and A's
first appearance is always within ~35 ms of its apply. That is the discarded-work
mechanism of 9.5, measured here without disturbing the sequence.

**At gap 0 the poller saw nothing, and that is the observer's limit rather than psmux's.**
The poller polls through `spawnSync`, so its real interval is tens of milliseconds —
longer than the whole gap. `a_observed_by_gap` reports this per gap precisely so that
"not observed at gap 0" stays distinguishable from "not observed anywhere". The sweep's
tolerance conclusion is unaffected: it concerns whether a *disturbed* outcome appears,
and none did at any gap.

**One overstatement of my own, caught by the key added to catch it.** The in-process
sample was described as *never* mid-flight, on the strength of one run where it was not.
`in_process_sample_ever_midflight` records that it was, at least once, in a later run —
which is what an unreliable observer looks like, as opposed to an impossible one. The
claim that survives is the weaker and correct one: the in-process sample is not a
trustworthy mid-flight observer, which is why the poller exists. `mid` is `null` in every
trial and `mid_source` says why.

The per-trial `a_landed` / `a_landed_on` fields are **removed, not nulled**. They were
first written gated to `null` whenever the sample was unusable, and the gate fired often
enough that a field that is usually null and named like a finding is a trap for whoever
reads the artifact next. `sample_was_midflight` is the only thing the in-process sample
contributes, and the poller is the only source for whether A's layout landed. Artifacts
from runs before this change carry the old fields; they are not comparable on that key.

**The rule, learned twice.** A probe that concludes "nothing happened" from an
unchanged end state must be able to prove the operation *could* have changed that
state — and the baseline must be a state the operation cannot reproduce. Twice here,
a successful apply was invisible because the baseline was a state the apply could
land on. This is the same failure as the R1/R2 omission above, and the same one the
§9.3 unknown-layout guard ran into: psmux exits 0 whether it acted or not, so no
exit-code guard can substitute for demonstrating that something was possible.

**Scope.** One session, one window each of two, sequential, v3.3.8, one client at
a time. Not covered: more than two windows, or any layout other than
`main-horizontal` / `main-vertical` / `even-horizontal`. Concurrent clients are
covered next, in 9.5.

### 9.5 Two clients that each set the pointer collide — deterministically, not in a race

Measured 2026-10-07. Evidence `.omo/evidence/ci-concurrent-clients.json` from
`scripts/windows/parity/concurrent-clients.cjs`; run id and commit under test in
`.omo/evidence/README-parity-ci.md`.

**Everything this section previously reported was unsound, and is withdrawn.** It
carried a table — serialised landing in 1 run of 3, concurrent "nothing changed" in
all 3 — plus a "this is a race, not reproducible on demand" correction on top. All of
it was measured by a probe with two faults, each of which makes a result unable to
come out the other way:

- Client B applied `tiled` to a window reset to `even-horizontal`. `#{window_layout}`
  returns the **serialised layout tree**, not the layout name, and `tiled` and
  `even-horizontal` produce the same tree at two panes — `collision-tolerance.cjs`
  records byte-identical strings either side of a `tiled` apply,
  `aliased_with_reset: true`. So B's apply was invisible whether it landed or not.
- `repair_succeeded` read its reference layout strings from the live server *after*
  the repair, so `wantedLayouts` was a re-read of `recovered` and the comparison
  could not fail. It was vacuously `true`, and it was the only thing bounding the
  risk claim.

Neither fault changes the geometry in the artifacts. Both change what the probe was
entitled to conclude from it.

**What the repaired probe measures.** Client A names w0 and applies `main-horizontal`;
client B names w1 and applies `even-vertical`. w0 resets to `main-vertical`, w1 to
`even-horizontal`, so every window starts in a state neither client's layout can
reproduce.

| trial | pause | windows that changed |
|---|---|---|
| distinct targets, concurrent | 0.7 s | `[1]` |
| distinct targets, long pause | 2.5 s | `[1]` |
| collision, before recovery | 2.5 s | `[1]` |

`concurrency_changed_the_outcome: false`. All eight invocations exited 0.

**w0 never received a layout.** A's apply would have moved w0 off `main-vertical` and
been plainly visible; w0's line is byte-identical before and after. Only w1 changed,
landing on B's layout (`42b2`, a stacked tree). So both clients' untargeted applies
resolved to the pointer's final value, and one client's work was discarded while every
invocation reported success.

**This is structural, and the 2.5 s pause is what proves it.** The earlier text called
this a race. It is not. The pointer is global server state — `active_idx` at
`src/layout.rs:1070`, one value for the session, and psmux strips `-t` before dispatch
(§9.1). Two clients that each set the pointer and then apply untargeted layouts will
both apply to whichever window wrote last, **however far apart they are**. A quarter of
a second, or two and a half seconds, makes no difference, because there is no window in
which the two layouts race — the loser's layout is simply computed against a pointer
the winner has already moved.

**And a collision is recoverable.** The repair step now captures its reference layout
strings *before* the collision, so the comparison is independent of the state it
judges, and it is genuinely non-vacuous: `after_collision` leaves w0 at `7f70` while
the reference is `b7ad`, and only the targeted repair brings w0 to `b7ad`.

```
after_collision      : 0|7f70,…{71x30,…}   1|42b2,…[120x14,120x15]
wanted_layouts       : b7ad,…[120x17,120x12]   42b2,…[120x14,120x15]
after_targeted_repair: b7ad,…[120x17,120x12]   42b2,…[120x14,120x15]
repair_succeeded     : true
```

So the failure mode is a **wrong frame that the next correctly-targeted layout call
repairs**, not a session left mislaid out with no way back.

**Why this matters here.** Team mode creates several agents laying out at the same
time, and rules 1b and 1e each inject an untargeted `select-layout`. Two overlapping
injections therefore land on one window and one agent's layout is silently dropped.
**This is the one measured defect in this document the bridge cannot work around**:
rule 1a is retired (v3.4.0 parses a percentage); 1b retires when the option is read outside
`apply_layout`, 1c when `sizes` stops being proportions — but there is no bridge-side
fix for a global current-window pointer, because the only handle psmux offers (`-t`)
is discarded before dispatch. The mitigation available is the one measured above: a
later targeted call repairs it, so the exposure is a dropped layout for one frame, not
a permanently mislaid-out session.

**The mechanism is now measured, not inferred.** Trials 1-3 start both applies with
`Promise.all`, so nothing is observable between them and `changed: [1]` is equally
consistent with A's layout being computed and overwritten and with it never being
computed. A fourth trial staggers phase 2 and samples the gap. Phase 2 is serial there
and parallel in trials 1-3, so its record is kept **out of `out.trials`** and labelled
`phase 2 staggered (serial), NOT pooled with trials 1-3` — pooling a different condition
into one series is what produced both earlier errors in this file.

**The flaw in that trial, found and fixed.** w0 was first reset to `main-horizontal`,
which is *also* client A's layout, so w0 sitting unchanged proved nothing — it would
look identical whether A's apply landed correctly or was dropped. That is the baseline
fault this document keeps finding: a reset the operation can reproduce hides the
operation.

w0 now resets to `main-vertical`, which neither client applies (A applies
`main-horizontal`, B `even-vertical`), yielding `7f70` — `{71x30 / 48x30}`, a tree
distinct from either. The trial then gives two independent observations:

| sample | w0 | w1 |
|---|---|---|
| before | `7f70` | `7899` side-by-side |
| after both `select-window` | `7f70` | `7899` — unchanged, as expected |
| **mid — after A alone** | `7f70` — **did not move** | **`b7b2` stacked** |
| after B | `7f70` | `42b2` stacked |

w0 does not move even though it is in a state A's layout differs from, so A's apply
genuinely did not reach the window A named. w1 moved to `b7b2`, a
`main-horizontal`-shaped tree (120x17 over 120x12) that only A's apply could have
produced. So A's layout **was computed — against the pointer B had already moved — and
then overwritten** by B's `even-vertical` (`42b2`). Last-writer-wins on a global pointer
is confirmed from both sides, and "discarded" is now distinguished from "never
computed".

Pooled trials 1–3 remain `changed: [1]` on this run, and `repair_succeeded: true`.

**Still not covered.** More than two clients, more than two windows, and a real OmO
team-mode sequence. The tolerance sweep shares the before/after-only limitation, though
its question — whether either layout applied — is answered, since its control applies
one and observes it.

**Scope.** One session, two windows, two clients, v3.3.8.

---

## 10. The `#{pane_start_command}` trap

At **v3.3.8** `#{pane_start_command}` answered `app.default_shell` for **every**
pane, so it could not distinguish a placeholder pane from an attach pane from an
ordinary shell pane. **Fixed at v3.4.0** (#580): the format now reports the
pane's own start command and an empty string for a pane running the default
shell:

- `src/format.rs:2167` → `"pane_start_command" => target_pane()`
- `src/format.rs:2168` → `.map(|p| crate::pane::start_command_display(&p.start_command))`

The v3.3.8 behavior is preserved as history:
[`format.rs:1525`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/format.rs#L1525).
At v3.4.0 the trap no longer exists; pane ownership keyed on this format would
now work, but the bridge does not depend on it.

INFERRED: the bridge's own descriptor remains the correct correlation record.
The bridge is the only party that applies `-e` on the respawn
path (section 7), so it can record pane ownership at the moment it performs a
translation, keyed on the pane id OmO itself supplies (`index.js:8485`,
`index.js:8572`). That is the reason `src/descriptor.ts` exists; it is now a
design choice rather than a workaround for the v3.3.8 format trap.

---

## 11. psmux facts that constrain the design

### 11.1 One server process per session

psmux's model is the opposite of tmux's. There is no single psmux port to
discover, hardcode, or health-check:

- `docs/integration.md:424` → \`> **Supervising a namespace.** Unlike tmux, psmux runs one server process per\`
- `docs/scripting.md:477` → \`psmux runs one server per session, so this is session-scoped\`

INFERRED: N sessions means N servers and N unrelated ports. The bridge must
therefore never cache or hardcode a control port, and must resolve the port per
session, per invocation. This follows directly from one-server-per-session plus
the ephemeral-port allocation in section 11.2.

### 11.2 The control port is OS-assigned and ephemeral

- `src/server/mod.rs:2104` → `let listener = TcpListener::bind(("127.0.0.1", 0))?;`

Port `0` is the OS "assign me any free port" sentinel. There is no base port, no
scan loop, and no configuration knob.

INFERRED: a port collision is structurally impossible, because binding port `0`
cannot fail with `EADDRINUSE`. That is why the bridge must not implement
collision handling or retry logic for psmux's own port, and why the separate
OpenCode port reservation in the port wrapper is a genuinely different problem
that does need its own protocol.

### 11.3 `PSMUX_DATA_DIR` was broken as an isolation lever at 3.3.8

At **v3.3.8** the per-session named mutex was built from the session name alone,
with no component derived from the data root, so two roots could not both hold a
session of the same name (upstream issue #599). **Fixed at v3.4.0**: the mutex
name now includes the data-root tag, and `PSMUX_DATA_DIR` is validated and
namespaced:

- `src/platform.rs:357` → `pub fn acquire_session_mutex(name: &str) -> Option<SessionMutex> {`
- `src/platform.rs:347` → \`format!("Local\\\\psmux-session-{}-{}", crate::paths::data_root_tag(), sanitized)\`
- `src/paths.rs:144` → `pub fn data_root_tag() -> String {`
- `src/paths.rs:100` → \`if let Some(raw) = std::env::var_os("PSMUX_DATA_DIR") {\`
- `src/paths.rs:91` → \`"PSMUX_DATA_DIR must be an absolute non-empty path"\`

The v3.3.8 source is preserved as history:
[`paths.rs:79-83`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/paths.rs#L79-L83)
and
[`platform.rs:333-346`](https://github.com/psmux/psmux/blob/66cf61354c473b35d4f0c06c57384fc46d61ffdb/src/platform.rs#L333-L346).
At v3.4.0, two different `PSMUX_DATA_DIR` roots can hold same-named sessions;
the bridge and the parity harness still prefer `-L` because it is the lever
they already verify.

### 11.4 `-L` is the working isolation lever

- `docs/faq.md:171` → \`**Q: Can I run multiple isolated psmux servers?**\`
- `docs/faq.md:172` → \`A: Yes, use the \`-L\` flag for server namespaces\`

Server identity is `{namespace}__{session}`:

- `src/types.rs:2906` → `pub fn port_file_base(&self) -> String {`
- `src/types.rs:2907` → `if let Some(ref sn) = self.socket_name {`
- `src/types.rs:2908` → `format!("{}__{}", sn, self.session_name)`

INFERRED: because the namespace is folded into the discovery-file name and into
the mutex name, `-L alpha` and `-L beta` are fully independent. Every probe and
every test that must not touch the user's real registry uses its own `-L`
namespace; at v3.4.0 `PSMUX_DATA_DIR` is also a working isolation lever, but the
parity harness keeps `-L` because that is the lever it already verifies.

### 11.5 Installed binary names and install directory

- `installer/psmux.nsi:64` → \`InstallDir "$LOCALAPPDATA\\psmux"\`
- `installer/psmux.nsi:65` → \`InstallDirRegKey HKCU "Software\\psmux" "InstallDir"\`
- `installer/psmux.nsi:124` → `File "${SOURCE_DIR}\psmux.exe"`
- `installer/psmux.nsi:125` → `File "${SOURCE_DIR}\pmux.exe"`
- `installer/psmux.nsi:126` → `File "${SOURCE_DIR}\tmux.exe"`

Three binaries are installed side by side, including `tmux.exe`. This is the
mechanism that makes `findCommandPath("tmux")` (`index.js:9140`) able to find
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
| draft line 226 | `cached_shell()` "reads `$SHELL`" | no `$SHELL` read existed in `src/*.rs` at v3.3.8; v3.4.0's `cached_shell()` prefers `$SHELL` when it names a spawnable Windows shell | **corrected for v3.3.8, changed at v3.4.0** (`src/pane.rs:452`, `src/pane.rs:491`) |

Everything else resolved as written, including all the bundle line numbers in
the plan's todo 3 and todo 4 reference blocks, which are correct for 5.1.18.

---

## 13. Open questions carried forward

| # | Question | Settled by |
|---|---|---|
| Q-CONTRACT-1 | Does `select-layout <layout>` with no `-t` work against psmux 3.3.8, and which window does it act on? | **SETTLED 2026-10-07.** Measured on a `windows-latest` runner: it applies, and applies to the client's current window. Option A confirmed, no code change required. Section 9.3, evidence `ci-layout-which-window.json`. Residual, not closed: whether the current window is always the one OmO meant, and the two-concurrent-clients case. |
| Q-CONTRACT-2 | What is psmux's exact stderr text and exit code for `kill-pane` against a dead pane? Section 3.8 makes `/can't find pane/i` load-bearing. | **MEASURED at v3.3.8 (todo 5) and re-observed at v3.4.0**: exit 1 with `psmux: can't find pane: %3`, matching the regex (`.omo/evidence/psmux340-windows-parity.json`). |
| Q-CONTRACT-3 | Does psmux deliver `-e` to a `respawn-pane` pane when the bridge supplies it by its own route? Section 7.2 is source-read only. | **ANSWERED at v3.4.0**: `4addc0a` applies `-e` via `env_flag_values`; the bridge still self-applies through env slots for the credential boundary. |
| Q-CONTRACT-4 | Which release first contains `c20016c` and `4addc0a`? | **ANSWERED**: v3.4.0; both commits are ancestors of the tag, and `git tag --contains` returns only v3.4.0. |
| Q-CONTRACT-5 | Does a pane description containing a double quote survive the placeholder? Section 13.1. | **MEASURED 2026-10-12: NO.** The loss is reachable and user-visible. Not fixed by decision; see 13.1. |

---

## 13.1. A double quote in a pane description is silently dropped by the placeholder

**Status: measured, reachable, user-visible, and deliberately NOT fixed.** The
bridge does not lose the argument — the shell the bridge builds the placeholder
for does. This section records the exact repro so the behaviour is never
mistaken for working, and so a future fix can be judged against a known target.

### What happens

Template B (section 1.2) wraps the description in a PowerShell **single**-quoted
string, because inside single quotes PowerShell treats everything literally
except `''`. A double quote therefore needs no escaping and is emitted into the
token raw. The pane command vector that carries it is
`[shell, -NoProfile, -NonInteractive, -Command, <that token>]`, and the helper
execs it with `& $program @commandArgs`.

Windows PowerShell 5.1's native command-line binder **does not escape an embedded
double quote** and does not quote an argument it does not consider to need it, so
the quote is removed from the command line before the child parses it. The child
therefore receives a *different program text* than the bridge sent.

### Measured, on Windows PowerShell 5.1.26100.9444

Both stages were run against the token that the production translator
(`translate()` in `src/translate.ts`) actually emits for the description this
repository's own hostile fixture uses, `it's a $HOME \`cmd\` with "quotes" and
\backslash\` (`HOSTILE_DESCRIPTION_RAW`, `test/translate.test.ts`). That token's
program is `powershell`, because `cli.ts` calls `translateArgv` without a
`shellPath` and `HELPER_CONTRACT.shell` is `powershell` — which on Windows is
always 5.1.

Stage 1, the argument as received:

```
SENT     : ...it''s a $HOME `cmd` with "quotes" and \backslash\'...
RECEIVED : ...it''s a $HOME `cmd` with quotes and \backslash\'...
IDENTICAL = False
```

Stage 2, the real helper `runtime/Start-PaneFromDescriptor.ps1` running that same
command vector, and the text that lands in the user's pane:

```
OMO subagent pane ready: it's a $HOME `cmd` with quotes and \backslash\
Focus this pane to attach.
```

`"quotes"` became `quotes`. Nothing warns, nothing fails, and the pane's exit
code is unaffected — which is precisely why it must be written down rather than
left to be discovered.

### Reachability

Reachable, on the default configuration, for the **placeholder** path of section
3.2. Three measured facts, none of them an assumption:

1. The input is ordinary. A description containing `"` is not exotic; it is the
   description this repository's own contract fixture uses to prove hostile input
   round-trips.
2. Nothing on the path escapes the quote. `powerShellSingleQuoted` in
   `src/translate.ts` needs to escape only `'`, and the token carries `"` raw
   (confirmed above).
3. The interpreter is fixed, not incidental. Both the helper and the placeholder
   run under `powershell`, so this is not a "pwsh happened to be missing" case.

**The attach path (section 3.3) is not affected, and that is measured too.** Its
tokens are a URL, `--session`, and `--dir`; a directory with spaces round-trips
byte-exactly, and a Windows path **cannot contain a double quote at all**. So the
retry path the helper implements (upstream OpenCode #3505) is not exposed to this.

**PowerShell 7 is not affected.** `pwsh` binds both the embedded quote and an
empty argument correctly. The loss is a property of the 5.1 binder specifically.

### What is deliberately not done

The executor is **not** rewritten to work around this. Quoting a native argument
correctly from 5.1 means replacing `& $program @commandArgs` with an explicit
`ProcessStartInfo`/`ArgumentList` or a `CommandLineToArgvW`-correct builder, which
changes how **every** pane on every host is launched. That is a behavioural change
to the whole bridge and needs its own evidence and its own decision; it does not
belong in a QA pass, and a partial mitigation (for the placeholder only) would
leave the other four verbs silently exposed while making the code look as though
the problem were handled.

What ships instead is this record, plus the measurement pinned as tests in
`test/windows-helper-runtime.test.ts`, which assert each interpreter's own
measured behaviour so a future change to the executor is noticed in CI rather
than in a pane.

**Do not read "the bridge passes its tests" as "a description containing a double
quote renders correctly." It does not.** Until the executor is replaced or the
placeholder shell is switched to `pwsh`, that input is lossy on Windows PowerShell
5.1.

---

---

## 14. Maintenance

This document is only true of the oh-my-openagent recorded as
`omo.verifiedAgainst` in `scripts/contract/pins.json` (**5.1.60** at this
revision) and of psmux **v3.4.0**. The v2.0.0 floor is exactly psmux 3.4.0:
the retired responses in sections 7 and 8 (rule 1a, the `--` insertion,
rule 1d) stay retired, and the env-slot delivery stays as the credential
boundary. When either pin is upgraded:

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

   **A passing run does not cover bare references.** `` `index.js:NNNN` `` in
   prose with no `→` arrow is not a citation, so the checker never sees it, and a
   stale bare number survives a green run silently — 23 of them did, through the
   `5.1.21`→`5.1.30` pass. When you re-verify, sweep the bare refs too: list
   every `` `index.js:NNNN` `` in the document, resolve each against the bundle,
   and confirm it names the line its clause says it names. That is a mechanical
   sweep, not a judgement call, and skipping it is how this document ended up
   asserting 23 things it could not prove.

   An OmO-side `PIN_DRIFT` additionally requires bumping `omo.verifiedAgainst` in
   `scripts/contract/pins.json` once the re-verification passes. That bump is the
   last step, not the first: re-verify first, because a pin that claims a version
   nobody checked against is worse than a pin that is honestly behind.
2. Re-check `respawn-window` for absence from the bundle, since its presence
   would make section 7.3 a live path.
3. Re-check the `-e` handling table in section 7.2, verb by verb.
4. Re-run the ancestry check in section 8.1 for both commits, and fill the
   `First release containing it` cells only from a real tag test.
5. Re-check the layout rules in section 3.9 against the new psmux source,
   in the order they depend on each other. Rule 1a is retired in v2.0.0
   (v3.4.0 parses the `%` form); rule 1b is still present, and rule 1c's
   cell-count defect is still present. Rule 1c stays: dropping it while 1b
   holds would re-expose the layout to the defect being suppressed.

   **All three now retire on a boolean, not on someone's reading.** All three are
   measured behaviourally — apply, then read the geometry — and rule 1c's claim
   has the same shape: a tmux CELL
   COUNT passed to `resize-pane -x` arrives as a PERCENTAGE. Sending a number
   whose two readings cannot coincide answers it outright. On a 120-column window
   `-x 99` gives 117 columns — about 98% of the window after the one-column
   divider — rather than 99 columns, which is what a cell reading would give.
   `rule_1c_defect_present: true` in `.omo/evidence/ci-resize-pane-cells-probe.json`.

   The same run proves the bridge's half is doing its job: the identical argv
   through the shim, where rule 1c suppresses it, leaves the geometry untouched
   at the 60% default. A rule that suppresses a command is only earning its keep
   if forwarding that command would have done damage, and now that is measured
   rather than assumed.

   So `parity.yml` prints
   `rule_1b_option_alone_inert`, `rule_1b_followup_applies`,
   `rule_1b_order_matters`, and
   `rule_1c_defect_present` on every run (`rule_1a_percent_form_ignored` and
   `height_percent_form_ignored` stay printed for continuity with the older
   artifacts, but rule 1a is retired in v2.0.0 and they are not retirement
   signals any more). Retire in the order the booleans go false, not in the
   order that seems tidy: with 1a retired, the remaining dependency is 1b
   before 1c, and dropping 1c while 1b still holds re-exposes the layout
   to the defect being suppressed.
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
8. Re-check pane-option support in the new psmux server source. v3.4.0 stores
   arbitrary `@name` pane options (#728), so rule 1d's premise is gone and
   v2.0.0 retired the rule: the bridge forwards the options. The effect on OmO's
   stale-attach sweep is unmeasured. Re-measure the team-layout probe before changing rule 1e,
   since its caller-is-main assumption rests on a measured run, not on source
   alone.

Until step 1 passes for every citation, treat any bridge behaviour as unverified.
