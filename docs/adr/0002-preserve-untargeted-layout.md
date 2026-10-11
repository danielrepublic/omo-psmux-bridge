# Do Not Invent a Target for Untargeted Layout Requests

The bridge preserves OmO's untargeted `select-layout` request. In psmux 3.3.8, `-t` is stripped before layout dispatch and the request acts on the server's current-window state, so injecting a target cannot repair the ambiguity and would falsely imply a guarantee the backend does not provide.

Compatibility follow-ups retain their ordering and namespace, but are not a concurrency-isolation mechanism. Tests and probes use their own namespaces; observations from sequential calls must not be reported as proof about simultaneous clients. See `CONTRACT.md` sections 3.9 and 9.
