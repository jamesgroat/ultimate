Warns you in the status line when a model provider stops working on this machine, and posts one Inbox notice when a provider runs out of credits, hits a usage limit or rejects its login. It tracks whether each model provider works on this machine, from every real response, and reports a failing one to the `setup` status-line item.

## What is stored

One file per machine, `~/.ultimate/health.json`, written by every Ultimate home of the user:

```json
{
  "providers": {
    "anthropic": {
      "lastOk": 0,
      "lastFail": 0,
      "error": "invalid_grant",
      "lastUsed": 0
    }
  }
}
```

Times are epoch milliseconds. `lastOk`, `lastFail` and `lastUsed` come from real calls; nothing pings a provider. Two more fields count failures: `lastAuth`, and `transient`, the newest three transient failure times. They decide the state and are not reported. Only failures newer than `lastOk` count, so writes arriving out of order from two homes still give the same state.

## When a provider is failing

Each failure is classified by its summary (`failureKind` in `store.ts`):

- **auth** (401, 403, `invalid_grant`, `authentication_error`, `revoked`, …) turns the provider `failing` at once: the login is broken.
- **capacity** (429, 529, `overloaded_error`, rate-limit and quota codes) never does: the provider is busy, not the login. It is kept as the last error only.
- **transient** (timeouts, network errors, any other failure) turns it `failing` at the third in a row with no success between, or at one 5 minutes or more after the first of the streak. Capacity failures neither count toward a streak nor stretch its window.
- **billing** (402: a credit or spending limit, such as OpenRouter's `in_flight_budget_exhausted`) counts like a transient failure, but the provider's `cause` is `billing`, so the setup popover asks for credits instead of a new login.

A success newer than the failures ends both. A streak failure older than a day stops counting when health is read (`STALE`), so a provider nobody calls any more stops warning; an auth failure keeps warning until a success or a login change. A failing provider carries its `cause`: `auth`, `billing` or `transient`. Otherwise a provider is `ok` once it has a `lastOk`, else `unknown`. Writes read, merge each timestamp by its maximum (the `error` stays with the newest `lastFail`), count the new failure and rename a temporary file into place; two homes writing at once lose at most one event. An error is stored only as a structured summary: the HTTP status (when the message starts with it or names it, `status 401`) and the words of a fixed list of provider error codes and network errors it contains (`invalid_grant`, `rate_limit_error`, `overloaded`, `ECONNREFUSED`, …, `KNOWN` in `store.ts`), or "request failed". Its free text never is, so no request or auth contents reach the file; add a code to `KNOWN` to keep it. Health stays on this machine.

## Login changes

A login says nothing about the one it replaced, so a change starts that provider over at `unknown` (`reset` in `store.ts` drops its entry). Ultimate's own login and logout (`extensions/models`) reset the provider when they finish. A login made outside Ultimate (`pi` /login) resets nothing, but its first successful call ends any earlier failure. Health covers only providers with a login here: `providers()` leaves out entries of providers without one, and a real call to such a provider records nothing, so a stale failure never warns.

A write that flips a provider's state (`ok`, `failing`, `unknown`) emits `health.changed` `{ provider, state, error? }`
(`Changed` in `refs.ts`) with the sanitised error, in a commit of its own right after the file write (a login change's
reset, in the reactor's commit); a write that keeps the state emits nothing.

Every machine keeps its own logins: never copy `auth.json` between machines. OAuth logins rotate their refresh token, so the first refresh on one machine revokes the other's copy with `invalid_grant`.

## Real usage

A `GenerationTask` `afterResponse` hook records every terminal provider message at no cost: `stopReason: 'error'` records a failure with `errorMessage`, `aborted` nothing, anything else a success. The write never blocks or fails the generation.

## Status line

In every home the `setup` status-line item lists a failing provider with its error (`providers()`).

## Inbox notices

When a provider runs out of credits, hits a usage limit or rejects its login, health posts one Inbox notice (tag
`Provider`) through the `NoticesApi` service of `notices/api.ts`, when a notices extension provides it (Life's does; the
built-in only toasts). Its title says what happened ("TypeSafe: out of credits", "Claude Code: usage limit reached
(resets 3:40 PM)", "OpenAI: key rejected"); its text names the agent definitions that run on that provider and the
extensions known to call it, the reset time when known, and where to add credits or check usage.

`classifyFailure` (`failure.ts`) sorts a failure from its HTTP status and message: `auth` and 402 (`billing`) come
from `failureKind` in `store.ts` and win over any wording; `usage` is a used-up plan or quota that Pi does not retry
(Codex "usage limit", `insufficient_quota`, Claude Code's usage-credit refusal), with `resetsAt` when the error names
it; credit wording without a status is `billing`. Everything else is `other`, and so is a retryable throttle such as a
tokens-per-minute 429: `watchdog` owns those, and they never post.

**One notice per episode.** An episode is one provider in one class, open from its first failure until that
provider's next success, which closes all of the provider's episodes (`episodes.ts`, kept in
`<project home>/health-notices.json`, so a restart does not post again). Failures while it is open post nothing,
however many there are; a provider failing in two classes in turn has two episodes, never more. An episode is marked
`delivered` on disk only after its notice was posted; until then each failure (or exhausted reading) of it delivers
again under the same key, so a post that failed, found no notices service or was cut off by a restart is retried. One
delivery per key runs at a time. Writes and deliveries go through one queue per project home that outlives facet
reloads; release drains both. The key is `health:<provider>:<class>:<epoch ms of the first failure>`; the notices channel never reposts a
key, also after Done. Every episode of a provider posts into the slot `health:<provider>`, so a new episode replaces
the provider's notice while it still waits, and a flapping provider keeps a single Inbox item (Life's notices also
coalesce more than three posts an hour into one slot).

**Subscription exhaustion.** Health watches subscription routing's root document (`subscription-routing.state`, when
that extension is loaded; when it is not yet, health tries to attach again every minute until it can). When a pair's reading for a provider flips to `exhausted`, that opens a `usage` episode with
the reading's `resetsAt`, the same episode a model error opens, so the two paths never post twice. `paced` alone
posts nothing.

**Reporting in.** Every real model response feeds the episodes. Extensions that call a provider outside the model
catalogue report each outcome with `HealthApi.report({ provider, ok, status?, error?, resetsAt? })` (`want` it);
`classify` reports TypeSafe this way. The error is only classified, never stored or shown.
