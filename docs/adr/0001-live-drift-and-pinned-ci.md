# Detect Live Drift Locally, Verify a Fixed Version in CI

Local contract checks read OmO's installed `@latest` bundle and report `PIN_DRIFT` when its manifest disagrees with `verifiedAgainst`. CI instead materializes exactly `verifiedAgainst` on its disposable runner. This deliberately favors freshness locally and reproducibility in CI; replacing the local target with an always-matching snapshot would hide an installed upgrade that has not been reviewed.

Maintenance may fetch another version into an isolated test home to reproduce CI, but must not replace the installed agent cache or claim that a passing citation check proves unchanged behavior. See `CONTRACT.md` sections 0.1 and 14.
