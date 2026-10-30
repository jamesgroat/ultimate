import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatAgo, useDialog, useNow } from '@/sdk'
import { FeatureTag, useOverview } from '../conversations/ui.tsx'
import { tones, useSelectThread, useThread, useThreads } from './model.tsx'
import { Dot, Fresh } from './roots.tsx'

export const picker = 'threads.picker'

export function ThreadPicker() {
  const found = useThreads()
  const [open, setOpen] = useDialog(picker)
  if (!found) return null
  const activity = new Map(found.threads.threads.map((thread) => [thread.id, thread.first]))
  for (const entry of found.entries)
    for (const id of found.threads.of.get(entry.id) ?? []) activity.set(id, entry.id)
  const threads = found.threads.threads.toSorted(
    (a, b) => activity.get(b.id)! - activity.get(a.id)!,
  )
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          type="button"
        >
          Threads <ChevronDownIcon className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
        <PickerList ids={threads.map((thread) => thread.id)} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function PickerList({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  return (
    <Command label="Threads" shouldFilter={false}>
      <CommandInput
        className="text-[13px]"
        onValueChange={setQuery}
        placeholder="Search threads…"
        value={query}
      />
      <CommandList>
        <CommandEmpty>{ids.length ? 'No matching threads.' : 'No threads loaded.'}</CommandEmpty>
        <CommandGroup>
          {ids.map((id) => (
            <PickerRow id={id} key={id} onClose={onClose} query={query} />
          ))}
        </CommandGroup>
      </CommandList>
      <p className="border-t border-border/60 px-3 py-2 font-mono text-[10px] text-muted-foreground">
        Only threads in the loaded conversation.
      </p>
    </Command>
  )
}

function PickerRow({ id, query, onClose }: { id: number; query: string; onClose: () => void }) {
  const shown = useThread(id)
  const feature = useOverview()[id]?.feature
  const select = useSelectThread()
  const now = useNow(30_000)
  if (!shown) return null
  const title = shown.title ?? `#${id}`
  if (!`${title} ${feature ?? ''} #${id}`.toLowerCase().includes(query.trim().toLowerCase()))
    return null
  return (
    <CommandItem
      className="min-w-0 items-start gap-2 px-3 py-2 text-[12px]"
      data-thread-choice={id}
      onSelect={() => {
        select(id, shown.newest)
        onClose()
      }}
      value={String(id)}
    >
      <Dot className="mt-1.5" tone={shown.tone} />
      <span className="sr-only">{tones[shown.tone].word}: </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={title}>
          {title}
        </span>
        <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          {feature && <FeatureTag feature={feature} />}
          {shown.at !== undefined && <span>{formatAgo(shown.at, now)}</span>}
        </span>
      </span>
      <Fresh count={shown.fresh} />
    </CommandItem>
  )
}
