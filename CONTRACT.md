# CONTRACT: the OmO pane-command grammar, and what the bridge does to it

This document freezes the contract between stock **oh-my-openagent (OmO)** and the
**psmux** terminal multiplexer on Windows, as mediated by this repository's bridge.

It is a specification, not a status report. `src/translate.ts` implements it; the
translator's unit tests are written against it; the parity sweep measures it.

Every clause below is one of exactly two things:

1. **A citation.** Written as `` `index.js:NNNN` → `<exact text>` `` for the OmO
   bundle, or `` `src/<file>.rs:NNNN` → `<exact text>` `` at a stated ref for
   psmux. The quoted text is a literal substring of the cited line. A checker
   script re-resolves every one of them and fails loudly on any drift.
2. **An inference.** Prefixed `INFERRED:` followed by the reasoning. An
   inference is never dressed up as a citation.

If a clause is neither, it does not belong in this document. Nothing here
records an aspiration as a fact.

## How to re-verify every citation

The OmO bundle citations are checked with:

```bash
sed -n 'NNNNp' \
  /home/daniel/.cache/opencode/packages/oh-my-openagent@5.1.18/node_modules/oh-my-openagent/dist/index.js
```

The psmux citations are checked from a checkout of the pinned ref, with the same
`sed -n` invocation against `src/<file>.rs` inside it.

The file is referred to as `index.js` throughout, but its real path is
`dist/index.js` inside the package.

---

## 0. The two sources of truth, pinned

### 0.1 OmO

The installed bundle is **oh-my-openagent 5.1.18**:

```
/home/daniel/.cache/opencode/packages/oh-my-openagent@5.1.18/node_modules/oh-my-openagent/dist/index.js
```

**Discrepancy on the record.** The work plan (todo 3 and todo 4 reference blocks)
and the research draft both cite `oh-my-openagent@5.1.17`. That version is **not
installed on this host**; only `5.1.18` is. Every citation in this document was
resolved against **5.1.18**, and the orchestrator spot-checked 20 of the plan's
line numbers against 5.1.18 before dispatch. The plan's line numbers are correct
for 5.1.18. Only the version string was stale. **5.1.17 is not installed and must
never be cited.**

### 0.2 psmux

All psmux citations are from **tag v3.3.8**, commit
`66cf61354c473b35d4f0c06c57384fc46d61ffdb`, cloned to
`/tmp/opencode/psmux-v338` **outside this repository**. psmux's master branch
diverges by roughly 17k lines, so line numbers do not transfer between the two
trees. Every psmux citation in this document states v3.3.8. Nothing here is
cited from master except where a master-only fact is explicitly labelled as
such, and those are cited as commits rather than as line numbers.

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

### 3.9 Everything else is pass-through

The bundle emits additional tmux verbs that carry no payload, including
`select-layout` (section 9), `set-window-option`, `resize-pane`, `has-session`,
`display`, `list-sessions`, and `send-keys`.

INFERRED: by the definition in section 3, none of these carries a payload, so
all of them are pass-through by contract, and the translator's classification of
them must be exactly that. This is derived from the payload definition plus the
cited argv shapes; no separate census citation is offered, and an agent-authored
verb via the `interactive_bash` tool is likewise unclassifiable ahead of time
and must default to pass-through.

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
path. The prior session measured the difference directly:

- `omo-psmux-bridge.md:609` → \`| \`respawn-pane -k -t %1 <命令>\` | ❌ 沒有 |\`
- `omo-psmux-bridge.md:610` → \`| \`respawn-pane -k -t %1 -- <命令>\` | ✅ 有 |\`

The pane id was unchanged in both cases, so `--` changes only whether the command
is read. It does not change pane identity or layout.

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

## 9. OPEN QUESTION: does `select-layout` work with no `-t`?

**This is open. It is not decided here, and nothing downstream may treat either
option as chosen.**

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

**What would settle it:** running `select-layout main-vertical` with no `-t`
against real psmux 3.3.8 in an isolated `-L` namespace, then reading
`display-message -p '#{window_width}'` before and after, and separately checking
the command's exit code and stderr. Todo 5 sub-probe (f) and todo 19 own this.
Until one of those runs, both options stay open.

**Contributing evidence, not a decision:** the bridge's parity posture argues
that untested rewriting is the more dangerous choice, since a wrong `-t` would
change which window gets laid out, whereas a wrong pass-through at worst
reproduces whatever OmO already does on native tmux.

INFERRED: Option A is the lower-risk default, on the grounds that pass-through
reproduces stock behaviour while a wrong injection invents behaviour. This is a
risk argument, **not** a determination that A is correct, and it must not be used
to close the question.

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

Every citation in this document was resolved by running the checker, not by
transcribing from the plan. Four numbers in the inherited material did not
resolve to the claimed content. The correct numbers are the ones used above.

| Claimed at | Claimed content | Actual | Status |
|---|---|---|---|
| plan todo 3 and todo 4, draft line 194 | `oh-my-openagent@5.1.17` is the installed bundle | only `5.1.18` is installed | **corrected**: document frozen against 5.1.18 |
| draft line 224, `docs/tmux_args_reference.md:93` | the `respawn-pane` row documenting the `--` form | `:93` is the `rotate-window` row | **corrected**: the `respawn-pane` row is `:91` |
| draft line 232, `installer/psmux.nsi:89-91` | `psmux.exe`, `pmux.exe`, `tmux.exe` | `:90` is `README.md`, `:91` is `LICENSE` | **corrected**: the three binaries are `:87-89` (which the plan's todo 1 block already had right) |
| draft line 226 | `cached_shell()` "reads `$SHELL`" | no `$SHELL` read exists in `src/*.rs` at v3.3.8 | **corrected**: it walks `pwsh` → `powershell` → `cmd`; the draft's conclusion holds more strongly than stated |

Everything else resolved as written, including all the bundle line numbers in
the plan's todo 3 and todo 4 reference blocks, which are correct for 5.1.18.

---

## 13. Open questions carried forward

| # | Question | Settled by |
|---|---|---|
| Q-CONTRACT-1 | Does `select-layout <layout>` with no `-t` work against psmux 3.3.8? Section 9, both options stated. | todo 5 sub-probe (f), todo 19 |
| Q-CONTRACT-2 | What is psmux 3.3.8's exact stderr text and exit code for `kill-pane` against a dead pane? Section 3.8 makes `/can't find pane/i` load-bearing. | todo 5 sub-probe (i) |
| Q-CONTRACT-3 | Does psmux 3.3.8 deliver `-e` to a `respawn-pane` pane when the bridge supplies it by its own route? Section 7.2 is source-read only. | todo 5 sub-probe (h) |
| Q-CONTRACT-4 | Which release will first contain `c20016c` and `4addc0a`? Section 8.2 is seeded `null` deliberately. | upgrade check, section 8.1 rule |

---

## 14. Maintenance

This document is only true of oh-my-openagent **5.1.18** and psmux **v3.3.8**.
When either is upgraded:

1. Re-run the citation checker. A single `MISMATCH` means the contract changed.
2. Re-check `respawn-window` for absence from the bundle, since its presence
   would make section 7.3 a live path.
3. Re-check the `-e` handling table in section 7.2, verb by verb.
4. Re-run the ancestry check in section 8.1 for both commits, and fill the
   `First release containing it` cells only from a real tag test.

Until step 1 passes for every citation, treat any bridge behaviour as unverified.
