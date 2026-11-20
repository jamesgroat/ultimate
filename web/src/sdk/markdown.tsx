import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { island } from './island.tsx'
import {
  Markdown,
  MentionText as SolidMentionText,
} from '../components/markdown/markdown.solid.tsx'
import type { MarkdownOrigin } from '../components/markdown/source.ts'

const MarkdownIsland = island(Markdown)
const MentionIsland = island(SolidMentionText, { inline: true })

const SourceContext = createContext<MarkdownOrigin | undefined>(undefined)

export function MarkdownSource({
  children,
  url,
  preview,
}: MarkdownOrigin & { children: ReactNode }) {
  const source = useMemo(() => ({ url, preview }), [url, preview])
  return <SourceContext value={source}>{children}</SourceContext>
}

export function MessageResponse({
  children,
  className,
  isAnimating,
  without,
}: {
  children: string
  className?: string
  isAnimating?: boolean
  without?: readonly string[]
}) {
  const origin = useContext(SourceContext)
  return (
    <MarkdownIsland
      class={className}
      origin={origin}
      streaming={isAnimating}
      text={children}
      without={without}
    />
  )
}

export function MentionText({ text }: { text: string }) {
  return <MentionIsland text={text} />
}
