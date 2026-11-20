/** @jsxImportSource @solidjs/web */
import { Inbox as InboxIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, For, Show } from 'solid-js'
import {
  Header,
  ProvidedValue,
  Sidebar,
  useProvided,
  useNow,
  useSurface,
  useViewport,
} from '@/sdk/solid'
import { Badge, LinkOverlay, SidebarRow, Zero } from './chrome.solid.tsx'
import { SURFACE, answeredToday } from './items.ts'
import { List } from './list.solid.tsx'
import { QuestionPane } from './points.ts'
import { Reading } from './reading.solid.tsx'
import { useSelection } from './selection.solid.tsx'
import { Waiting } from './ui.solid.tsx'

export function Inbox() {
  const { entries, messages, failures, status } = Waiting()
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  const now = useNow(60_000)
  const { item, selected, setSelected } = useSelection(entries)
  const paneFailures = (<span class="contents" />) as HTMLElement
  const takeover = useProvided(
    QuestionPane,
    () => ({ message: item()?.message, phone: phone() }),
    paneFailures,
  )
  const reading = () => takeover() != null || (!!item() && !!selected()?.open)
  const close = () => setSelected((current) => current && { ...current, open: false })
  const openItem = createMemo(() => {
    const entry = item()
    return entry ? [entry] : []
  })
  const pane = () => (
    <Show
      when={takeover() != null}
      fallback={
        <For each={openItem()} keyed={(entry) => entry.key}>
          {(entry) => <Reading entry={entry()} now={now()} onBack={close} phone={phone()} />}
        </For>
      }
    >
      <Show when={typeof takeover() === 'function'} fallback={<ProvidedValue value={takeover()} />}>
        {(takeover() as () => JSX.Element)()}
      </Show>
    </Show>
  )
  return (
    <div class="flex min-h-0 flex-1">
      <Sidebar />
      <main class="flex min-w-0 flex-1 flex-col">
        <Show when={!phone() || !reading()}>
          <Header>
            <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
              <InboxIcon class="size-4 text-muted-foreground" />
              Inbox <Badge count={entries().length} status={status()} />
            </span>
          </Header>
        </Show>
        <div class="flex flex-col gap-1 px-3 has-[[data-extension-error]]:py-1.5">
          {failures}
          {paneFailures}
        </div>
        <Show when={entries().length > 0 && status().text && takeover() == null}>
          <output class="border-b border-border/70 px-5 py-2 text-[12px] text-muted-foreground">
            {status().text}
          </output>
        </Show>
        <Show
          when={entries().length > 0 || takeover() != null}
          fallback={<Zero today={answeredToday(messages(), now())} status={status()} />}
        >
          <Show
            when={!phone()}
            fallback={
              <Show
                when={reading()}
                fallback={<List entries={entries()} phone status={status()} />}
              >
                {pane()}
              </Show>
            }
          >
            <div class="flex min-h-0 flex-1">
              <div class="flex w-[24rem] shrink-0 flex-col border-r border-border/70">
                <List entries={entries()} phone={false} status={status()} />
              </div>
              {pane()}
            </div>
          </Show>
        </Show>
      </main>
    </div>
  )
}

export function InboxSidebar() {
  const active = useSurface()
  const { entries, failures, status } = Waiting()
  return (
    <>
      <SidebarRow
        active={active() === SURFACE}
        count={entries().length}
        oldest={entries()[0]?.at}
        status={status()}
      />
      {failures}
    </>
  )
}

export function WaitingBadge() {
  const { entries, failures, status } = Waiting()
  return (
    <>
      <Badge count={entries().length} status={status()} />
      {failures}
    </>
  )
}

export function WaitingLink() {
  const { entries } = Waiting()
  return <LinkOverlay entries={entries()} />
}
