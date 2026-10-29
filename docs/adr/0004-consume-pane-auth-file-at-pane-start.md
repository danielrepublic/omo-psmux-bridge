# Consume the OmO Pane Auth File at Pane Start

OmO 5.1.51 writes a one-use POSIX export file and passes its path in
`OPENCODE_SERVER_PASSWORD_FILE`; the payload body begins with a constant
source-and-delete fragment. The bridge recognises that fragment, keeps the
credential out of its own descriptor, and lets the pane helper read, parse,
delete, and verify the file at pane start. A shim-time delete was rejected
because OmO retries the same argv after a transient psmux failure; consuming
early would make the retry undeliverable. Attach fails closed when the file is
absent, malformed, or cannot be deleted; a placeholder keeps the pane alive so
the later attach can carry its own file. See `src/grammar.ts`,
`scripts/windows/runtime/Start-PaneFromDescriptor.ps1`, and `CONTRACT.md` §0.1.
