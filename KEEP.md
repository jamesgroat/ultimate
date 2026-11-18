# keep/questions-incomplete-send

**What it does.** Commit `43078d2c` (fork PR #213, `contrib/questions-incomplete-send-255109`) makes a card sent with
questions left unanswered hold the answer for 8 s instead of 3 s, show "Sending · N unanswered" in amber with a
pulse, and lets a tap anywhere on the pending card undo it.

**Why it existed.** On a phone, James sent cards with a question still unanswered and had no time or obvious target to
undo the send.

**Why it was dropped (sync of Nov 18, upstream `ca4993f0`).** Upstream's questions rework (`ecfc6e96` through
`3b345f67`) answers the same need its own way: Send shows "Send 2 of 5" while questions are unanswered, sending locks
the card and turns Send into a filling Undo for 3 s, Escape or `u` undoes, and holding Send sends at once. The patch no
longer applies to that card. What upstream does not have: the longer 8 s window for incomplete answers, the amber
unanswered warning while sending, and tap-anywhere-to-undo.

**When to restore it.** If James still misses the incomplete warning or the longer window after using upstream's
locked card. Then reimplement the warning on upstream's Undo button, not this patch.
