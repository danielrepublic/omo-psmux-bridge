# Deliver Pane Credentials Outside the Command Line

Pane environment assignments travel through numbered environment slots first, then a restricted-ACL, consume-once descriptor when the long-lived psmux server cannot inherit the shim's new environment. Putting values into the helper's argument list, even encoded, would expose credentials through process listings; a partial slot set is rejected instead of mixing delivery mechanisms.

The correlation ID ties delivery to a pane trace without recording credential values. Exclusive trace creation claims consumption, and fallback deletion failure prevents execution. The descriptor digest checks completeness, not protection against another process running as the same user. See `src/descriptor.ts` and `scripts/windows/runtime/Start-PaneFromDescriptor.ps1`.
