/** Read aloud in the browser: the actions that prepare a message for listening and voice it. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** An OpenAI voice of the realtime speech model; cedar and marin sound best. */
export type OpenAiVoice =
  | 'cedar'
  | 'marin'
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'sage'
  | 'shimmer'
  | 'verse'

/** One section of a message, rewritten for listening, with the number of sections the message has. */
export type PreparedSection = { sections: number; spoken: string }

/**
 * `{ text, section }` → section `section` (from 0) of the Markdown `text`, rewritten for listening, with the number of
 * sections the text has. Cached by the section's text.
 */
export const PrepareAction = actionRef<{ text: string; section: number }, PreparedSection>(
  'read-aloud',
  'prepare',
)

/**
 * `{ voice, text }` → base64 audio and its MIME type. `local` renders with the optional speak extension's saved MLX
 * settings; other voices use OpenAI. Without text OpenAI opens its connection and local does nothing.
 */
export const SpeakAction = actionRef<
  { voice: OpenAiVoice | 'local'; text?: string },
  { audio?: string; mimeType?: string }
>('read-aloud', 'speak')

/** Availability of the independent server speech sources; browser speech needs neither. */
export const SpeechStatusAction = actionRef<null, { openai: boolean; local: boolean }>(
  'read-aloud',
  'status',
)
