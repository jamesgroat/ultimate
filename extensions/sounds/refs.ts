/** Sounds' narrator in the browser: the action that speaks a line. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * `{ text }` → the line spoken by the configured voice, as base64 16-bit mono PCM at 24 kHz;
 * `{ audio: null }` leaves speech to the browser when voices are unavailable or the source is off.
 */
export const SayAction = actionRef<{ text: string }, { audio: string | null }>('sounds', 'say')

/** No arguments → configured source, local venv availability and a setup hint when local is not installed. */
export const StatusAction = actionRef<
  null,
  { voice: 'openai' | 'local' | 'off'; localAvailable: boolean; hint?: string }
>('sounds', 'status')
