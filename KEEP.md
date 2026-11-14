# Local Kokoro narrator

This branch preserves the fork's 7a97414f implementation as an independently cherry-pickable patch on pinned upstream af3d8e0e. It bundled a Kokoro worker and local narrator settings beneath the upstream announcement queue so the narrator could speak locally.

The ready fork replaces that implementation with the generic stdin/audio command adapter from 0b23ccef. A personal command can reuse an existing warm speech worker without bundling a second model runtime. Local command failure now falls back only to browser speech, never OpenAI. The preserved implementation's local-to-OpenAI fallback is rejected and must not be restored.

Restore implementation pieces only if a future explicitly approved requirement cannot use the generic command adapter; reassess them against then-current upstream and remove the paid fallback first. This explanation is a separate note commit and is not required to recover the implementation.
