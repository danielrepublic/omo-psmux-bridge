# OmO Windows Pane Bridge

This context connects OmO's tmux-shaped pane requests to psmux on Windows.
The bridge preserves the caller's intent while compensating for measured incompatibilities.

## Language

**OmO**:
The oh-my-openagent plugin that requests panes for subagents and teammates.
_Avoid_: OpenCode (the agent runtime is a different party).

**Bridge**:
The intermediary between OmO's pane requests and the Windows multiplexer.
_Avoid_: multiplexer, agent runtime.

**Shim**:
The bridge entry point selected when a caller resolves the command name `tmux`.
_Avoid_: backend.

**Backend**:
The real psmux program receiving requests from the bridge, never the shim itself.
_Avoid_: shim, launcher.

**Payload**:
A single command operand containing either OmO's placeholder command or its attach command.
It is not the entire tmux argument list.

**Placeholder Payload**:
The command keeping a new pane alive until its subagent session can be attached.
_Avoid_: attach payload.

**Attach Payload**:
The command connecting a pane to an OpenCode session.
_Avoid_: placeholder payload.

**Classification Pass-Through**:
A request whose payload shape is not one of the bridge's recognized templates.
It may still receive an explicitly defined compatibility rewrite.
_Avoid_: byte-transparent forwarding (a stronger, different claim).

**Byte-Transparent Forwarding**:
A forwarded request whose argument elements and order are unchanged.
_Avoid_: classification pass-through.

**Suppression**:
An acknowledged request deliberately not sent to psmux because a known incompatibility makes forwarding incorrect.
_Avoid_: successful backend invocation.

**Follow-Up**:
An additional backend request introduced by the bridge to complete a compatibility workaround.
_Avoid_: retry (a follow-up is a different request).

**Pane Descriptor**:
The bridge-owned description of a pane command and the delivery of its environment assignments.
_Avoid_: pane start command (psmux's reported shell is not an ownership record).

**Environment Slot**:
A numbered carrier of one environment assignment destined for the pane process.
Its value is sensitive even when its name does not look like a credential.

**Fallback Descriptor**:
A consume-once carrier used when the pane cannot inherit all of its environment slots.
_Avoid_: log, credential cache.

**Correlation ID**:
The identity connecting one pane invocation, its descriptor, and its credential-free trace.
_Avoid_: pane ID, OpenCode session ID.

**Multiplexer Session**:
A collection of psmux windows and panes with its own server.
_Avoid_: OpenCode session (an agent conversation attached inside a pane).

**Namespace**:
The psmux server naming scope separating test sessions from user sessions.
_Avoid_: data directory (a different directory alone does not isolate servers).

**Contract Citation**:
A source reference and quoted text checked against a specified upstream version.
It establishes textual evidence, not the correctness of every conclusion drawn from that text.

**Parity Evidence**:
Recorded observations comparing bridge and backend behavior on a named Windows build.
_Avoid_: proof from a green workflow alone.

**Retirement Condition**:
Evidence that the upstream fix for a particular workaround has shipped in a release.
_Avoid_: version-number comparison alone.
