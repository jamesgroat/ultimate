# Inbox

Everything that waits on the user, oldest first, answered in place: the `inbox` surface, first tab after Agent. Its
default items are exactly the messages `waiting` (questions) returns over the Messages log, read live and never copied
(`items.tsx`); an item leaves the moment it is answered or dismissed, wherever that happened. Browser only: no
`server.ts`, no documents, no actions of its own.

## Surface (`web.tsx`)

- **List**: one row per item, the asking branch's feature chip and `#id` as the sidebar draws them, a `preview` tag
  when the text links to a local preview (`http://127.0.0.1:…` or `localhost`), else `question`; the message's bold
  lead or first line as its title, its first question as the gist, and how long it has waited, amber past an hour.
- **Reading pane** for the selected item: the title, the rest of the text (messages' `Body`), its forwarded images
  (`MessageImages`), **Open preview** (a new tab) when it links one, **Open in branch #id** (messages'
  `messages:open {conversation, message}`), and the answer card itself (questions' `MessageQuestions`). When the shown
  item leaves, the one that took its place, the next oldest, shows.
- **Keys** (desktop): `j`/`k` move the selection, `⇧O` opens the branch (plain `o` is the card's "Something else…"),
  and the card's own keys (1–9, letters, ↵, ⇧↵) answer the shown item: the Inbox passes `keys` to the card. A
  branch's transcript keeps its own rule (`keyCard`) when the Inbox is not on screen.
- **Phone**: the list full width; a tap shows the item full screen with a back arrow, the answer card after the text.
- **Zero**: "Nothing waits on you", the questions answered or dismissed today, and **Back to @ultimate**.

`?inbox=<message>` on load opens the surface at that item and leaves the address; the `inbox:open {message}` event
does the same at runtime (a push notification's tap, `extensions/push`).

## Optional browser source (`ui.tsx`)

`InboxSource` is the single optional `inbox.source` web point. Provide it with
`provide(InboxSource, (local) => useBoard(local))`. The hook receives the live local `InboxBoard` and returns an
augmented `InboxBoard`, or `undefined` for today's local-only behavior. No settings, server endpoints or second
surface are needed. The built-in Inbox owns the list, reading pane, empty/status views, sidebar count, To-dos row,
phone layout and keys. `InboxData` shares the augmented board with these views and sorts the returned items oldest
first. The provider is invoked independently for the surface, sidebar and To-dos panel; share reads/subscriptions in
the provider (for example with `useAction`), not in another renderer.

```ts
type InboxBoard = {
  items: readonly InboxItem[]
  status: {
    state: 'complete' | 'loading' | 'partial' | 'error'
    text?: string
  }
}
```

Keep `local.items` in the result when augmenting it. Each local item is `{ message }`; add an optional `sourceLabel`
to show a quiet source label alongside its unchanged local asker, feature metadata, actions and images. Leave `source`
undefined for local items; no transport or remote content callbacks are needed. Without a label, local asker markup is
unchanged. Remote source labels appear as small chips in the list and reading pane, coloured by the stable `source`
namespace using the conversation feature-tag palette. Remote items require `sourceLabel` and have:

```ts
{
  source: 'machine/project', // stable namespace, NOT the connection URL
  sourceLabel: 'My project · workstation',
  sourceHref: 'https://project.example', // optional browser URL, NOT the server fetch URL
  message, // original Message, including numeric id/from and questions
  asker: '#42', // optional ReactNode; never resolved through local branch metadata
  openBranch: () => window.open(branchUrl, '_blank', 'noopener'), // optional, browser-reachable
  images: imageContent, // optional ReactNode, loaded by the provider
  preview: previewUrl, // optional browser-reachable URL; null hides it
  transport, // required MessageQuestionsTransport from questions/ui.tsx
}
```

The provider owns server fetch addresses privately; the contract carries only browser links. Choose `source` from
stable machine/project identity so switching loopback/tailnet URLs does not reset selection or drafts. `itemKey(item)`
exports the same composite identity the Inbox uses: `JSON.stringify([item.source ?? null, item.message.id])`. Never
rewrite numeric message IDs into global IDs. Distinct machine/projects must have distinct source IDs. A remote item without `asker`
shows its sender literally, not a local feature/agent lookup. Remote branch opening, images and answer/dismiss routing
never fall through to local behavior; a missing remote transport fails rather than calling local actions. Remote preview buttons are hidden unless `preview` explicitly supplies a usable
browser URL; a peer's localhost URL is not usable from a phone. Local preview discovery remains unchanged, with the
same optional `preview` override/hide path.

Remote reading content, including question option previews, runs inside `MarkdownSource` from
`@/components/ai/message`. Local link, inline-code and fenced-code extension renderers are disabled there; Markdown
and code retain their normal formatting. Mentions and relative links use `sourceHref` as their browser base, or stay
plain text without it. Entry-qualified mentions (`#123/456`) stay literal until peers support entry URL navigation;
plain conversation mentions (`#123`) can open the owning peer. External links retain the normal confirmation behavior.
Loopback links stay plain unless they exactly match an explicitly supplied `preview`; peer preview ports are never
rewritten. Markdown image URLs, including reference definitions, resolve against the peer browser base; unresolved or
loopback images are suppressed. Remote images cannot supply `srcSet`, and raw HTML is skipped. Local image defaults
and raw HTML behavior are unchanged.

`status.state: 'complete'` means **every source is known fresh**, not just that the reachable ones returned no items.
Use `loading` for initial unknown data, `partial` for unavailable/stale sources, and `error` when the board cannot be
read. Return these states for expected availability failures instead of throwing. Supply concise `status.text` (for example, "One source unavailable; showing two fresh sources"). The Inbox renders
it above nonempty results and in its zero view. Unknown/error zero states never claim every branch has what it needs;
the sidebar shows `N+` for incomplete results or `?` when none are known. The point's local input is `loading` until its Messages document arrives, then `complete`; providers must retain
that unknown state when combining freshness. Answered-today history remains local.

Provider deep links use `?inbox=<numeric-message-id>&inboxSource=<encoded-source>` or emit
`inbox:open { message: <number>, source: <string> }`. The source must exactly match the item's namespace. Both query
parameters are consumed on load. While the board is incomplete, a requested item can wait for its source to arrive;
explicit navigation overrides it. A complete board missing the requested item falls back to the usual selection.
Omitting `source` keeps local `?inbox=N` and `inbox:open {message}` behavior unchanged.

See [questions' transport contract](../questions/README.md#browser-transport) for answer/dismiss and keepalive semantics.

## Elsewhere

- **Sidebar**: a row under @ultimate's (`sidebar.under-ultimate`), amber `Inbox · N · oldest 2h` while items wait,
  a quiet `Inbox` at zero; a click opens the surface. @ultimate's own row then says only `waits on you`.
- **To-dos**: the panel's "For you" keeps one `Inbox · N` row that opens it.
- ⌘K **Open Inbox**.
