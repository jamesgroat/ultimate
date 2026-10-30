# Screenshot first-frame wait

The fix waits for one rendering opportunity using animation frames before `Page.captureScreenshot`, within the existing deadline.

On omarchy4090, a zero-wait capture once returned "Unable to capture screenshot" before the first paint, even with the DOM and fonts loaded. This was never measured at a reliable rate.

Dropped from fork main on October 29, 2026: current upstream (`1475c80e`) passed `test/e2e/browser.test.ts` 20/20 on macOS and 10/10 on omarchy4090. The fix made no difference, so it was removed to keep the fork stack clean.

Restore it if "Unable to capture screenshot" appears again. Cherry-pick the fix commit, this branch's first commit after upstream (`6fae3aa8`), not this note.
