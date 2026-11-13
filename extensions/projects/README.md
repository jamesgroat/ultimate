A project switcher at the window's left edge: every Ultimate running on this machine, and on the other machines you name in `remotes`, one click away.

## How it works

- **Rail** (`shell.rail`, on desktop and tablet; nothing on a phone): one tile per running instance, two letters of its project's name, in project order; then each other machine's, under a thin rule with the machine's name. The project this page shows has the brand colour and a bar on the edge. It shows only while at least two projects run.
  - Hovering opens it over the app with names and ports; **pin** keeps it open beside the app. The pin is one value for every instance on this machine (`~/.ultimate/projects-rail.json`), so jumping keeps the rail as it was.
  - Where a tile links depends on how this page was opened. From loopback (`127.0.0.1`, `localhost`, `*.localhost` such as the supervisor's `ultimate.localhost` app window), this machine's instances link to their loopback URLs. From anywhere else (the tailnet), they link to the full HTTPS URL each one advertises through its own Tailscale extension. That keeps the port Serve assigned, which need not match the loopback port. An instance that advertises none (Tailscale off or not ready) has no link there, and its port reads `no tailnet`. Another machine's instance links to the URL set in `remotes` either way. Every tile names the port of the address it opens; the tile for this page names its own that way too, without a link.
  - A tile is a plain link to the instance's `/`, which opens its `@ultimate`: a click goes there in this tab, mod-click or middle-click opens a new tab, Back returns. The old page stays until the new one paints (seconds while the target builds its web bundle), so a click marks the tile pulsing with "opening…" and a thin brand bar runs along the window's top; a page restored by Back clears it.
  - Live state, polled every 4 s while the tab is visible: a pulsing brand dot while an agent works, a yellow count of questions waiting for the user. The footer sums it up (`1 for you · 2 working`). An instance that does not answer in time gets a dashed, dimmed tile and reads `unavailable`, with no dot or count, rather than looking idle.
- **Another rail wins:** when any other enabled extension fills `shell.rail` (a fleet switcher of your own, say), this one renders nothing and stops polling, so the window never shows two rails.

## Files

- `server.ts`
  - `list`, `{}` → `RunningProject[]` (`refs.ts`): the projects `host.projects()` finds running (their supervisor lock is held by a live process), each with its loopback URL and, while it is published, its Tailscale `tailnet` URL. This instance's comes from `host.want(TailscaleApi)`, another's from its `tailscale/status` action. Then come the instances in `remotes` (`{ <machine>: { <project>: url } }`, user settings only; [Discovery and settings](../../docs/settings.md)), each with its `machine` and configured `url`. This instance's `busy` and `questions` come from its own conversations and open questions. Every other instance's come from its `status` action, waiting at most 1.5 s, and so does the advertised URL. One that does not answer in time is listed `available: false`, without them. A machine's instance answers only when this machine's tailnet login is in that instance's `tailscale.allow`.
  - `pin`, `{ pinned? }` → `{ pinned }`: the shared pin, written first when `pinned` is given.
- `link.ts`: `href(project, hostname)`, where a tile links from a page on that host.
- `web.tsx`: the rail and the opening bar.
