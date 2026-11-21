# keep/voice-live-turn-taking

The commit below this note is the fork's `3c81253f`, cherry-picked onto its original parent `103cfdb0` (old fork main
`ac9e65e6` lineage, React voice-live).

## What it does

- Local engine turn-taking: a 900 ms cut, then up to 1.6 s more quiet when Smart Turn judges the sentence unfinished.
- Speech recovery: screen wake lock, audio-blocked hints and resume, stalled-capture and microphone-ended recovery,
  flush on close, playback deadlines, plain-answer speech fallback and a manual "Hear it" control.
- Voice agent prompt additions: continuation forwarding, naming what went to Ultimate, names instead of ids.

## Why it was dropped

In the Nov 21 fork sync onto upstream `937b38c5`, James chose: keep the local voice engine, take upstream's
turn-taking, drop ours. Upstream also moved voice-live to Solid, so this React patch no longer applies. The sync stack
carries the engine (`feat(voice-live): carry local speech engine selection`) and removes the hold
(`fix(voice-live): drop local unfinished-speech holds`).

## When to restore

If local voice cuts people off mid-sentence on upstream's turn-taking, or the recovery bits are missed on the phone
(screen sleeping during a session, silent playback after a stall). Restoring means porting the wanted parts onto
`extensions/voice-live/session-local.ts`, `live.solid.tsx` and `web.solid.tsx`; this commit is the reference.
