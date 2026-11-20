Read aloud: a speaker on each agent message's action row plays the whole answer as speech, lightly rewritten for listening.

## How it works

- **The button** sits in the hover action row of agent answers and message cards (`messageActions`), between Go back
  and Copy reference; user messages get none. While its message plays it turns into pause.
- **The rewrite** keeps the full text: every sentence and point, in order. The summary model (`summaryModel`, see
  `docs/settings.md`) only drops what does not work heard (code blocks, paths, URLs, shas, `#123` ids, Markdown and
  table marks) and turns list bullets into sentences. Without a summary model, or when its answer is cut off, empty or
  far shorter than the text, a plain strip in code (`speech.ts`) is read instead.
- **The voice** is local (fork): the speak extension's `render` action with its open model (Kokoro by default, the
  model, voice and rate saved in speak's settings), returned as AAC. Nothing goes to a paid speech API and there is no
  browser-voice fallback: where speak is off or its open-model venv is missing, as on a machine without it, the strip
  shows the error and Resume retries.
- **Sections:** the `speak` action (`{ text, section }`) splits the message into sections, a short first one so audio
  starts quickly, and returns one section's spoken text and audio. The browser fetches the next section while one plays.
  The last 200 sections are cached in memory by text and section, so a replay is instant and free; a restart clears it.
- **The player** is one per page: starting another message stops the current one. A one-line strip above the composer
  shows Preparing, Reading or Paused with a link to the message (`#conversation/entry`, which opens and scrolls to it),
  the section, the speed, pause and stop. The speed cycles 1× to 2× and 0.75×, and is remembered
  (`ext.read-aloud.rate`). It keeps playing when you switch conversations. On phones the Media Session API gives
  lock-screen pause and stop.
