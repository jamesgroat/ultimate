# keep/extension-enablement-sequential

**What it does.** Commit `773a1aad` turns the `it.concurrent` tests in `test/extension-enablement.test.ts` into plain
`it`, so the file's Vite-backed faux servers boot one after another instead of all at once.

**Why it existed.** On Nov 13 the fork's gate on this Mac failed these tests under CPU contention: every concurrent
test's clock covered the whole file's work.

**Why it was dropped (sync of Nov 17, upstream `9bd52084`).** Upstream `81dea786` ("Run server-booting tests one
after another") made the same change to the same file and also closes each test's server in `afterEach`. On pinned
upstream the patch is a no-op, so it cannot be a cherry-pickable patch there; this branch keeps it on its original
parent in the old fork history.

**When to restore it.** Only if upstream returns this file to `it.concurrent` and the Mac gate times out in it again.
Then reapply the idea (sequential tests), not this exact patch.
