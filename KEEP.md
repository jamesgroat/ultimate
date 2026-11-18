# keep/owed-request-handover

**What it does.** Commit `28c8aa9d` makes `branch` and `automation create` name the request they take over, and adds
`serves: false` to start unrelated work that takes none (dreams start with it).

**Why it existed.** On Nov 17 an unrelated Vault branch took Life's billing request 537 (and an automation 550), so the
real answer went out interim and the branch's result answered the wrong request.

**Why it was dropped (sync of Nov 18, upstream `ca4993f0`, James's decision).** Upstream rewrote request ownership
(`a28ff5c0`..`52c5d999`): new work owns a request only when the run read that asker's request or output, and the
delivered prompt names what a branch works on. The patch conflicts with that model.

**When to restore it.** If an unrelated branch or automation again takes over a request on the new routing. Then
reimplement the opt-out on upstream's `serve`, not this patch.
