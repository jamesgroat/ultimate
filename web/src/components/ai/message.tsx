// Adapted from vercel/ai-elements packages/elements/src/message.tsx (Apache-2.0, see LICENSE).
// Changes: `from` is a plain role, no branches or actions; only the code plugin; denser typography; links go through
// the extensions' `link` renderers, inline code through their `inlineCode` renderers.
import { cn } from 'cn'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { createContext, memo, useContext, useMemo } from 'react'
import {
  CodeBlock,
  CodeBlockCopyButton,
  defaultComponents,
  defaultRemarkPlugins,
  Streamdown,
} from 'streamdown'
import type { CustomRendererProps, ExtraProps } from 'streamdown'
import { ExtensionBoundary } from '../../app/boundary.tsx'
import { useExtensions } from '../../sdk/hooks.ts'
import {
  codeBlockLanguages,
  codeBlockRenderers,
  inlineCodeRenderers,
  linkRenderers,
} from '../../sdk/registry.ts'
import { codePlugin } from './code-block.tsx'
import { mentionHref, parseMention, remarkMentions, splitMentions } from './mentions.ts'

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-2',
      from === 'user' ? 'is-user' : 'is-assistant',
      className,
    )}
    data-from={from}
    {...props}
  />
)

export const MessageContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex min-w-0 max-w-full flex-col gap-2 text-[14px] leading-relaxed',
      'group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border/70 group-[.is-user]:bg-secondary/60 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5',
      className,
    )}
    {...props}
  />
)

type Source = { url?: string; preview?: string | null }
const SourceContext = createContext<Source | undefined>(undefined)

/** Remote Markdown: browser base for links/images, plus an explicitly usable preview URL. Presence disables local renderers and raw HTML. */
export function MarkdownSource({ children, url, preview }: Source & { children: ReactNode }) {
  const source = useMemo(() => ({ url, preview }), [url, preview])
  return <SourceContext value={source}>{children}</SourceContext>
}

const loopback = (url: URL) =>
  url.hostname === 'localhost' ||
  url.hostname.endsWith('.localhost') ||
  url.hostname.startsWith('127.') ||
  url.hostname === '[::1]' ||
  url.hostname === '0.0.0.0'

function sourceHref(href: string | undefined, source: Source) {
  if (!href || href === 'streamdown:incomplete-link') return undefined
  const mention = parseMention(href)
  if (mention?.entry !== undefined) return undefined
  const target = mention ? `?conversation=${mention.conversation}` : href
  if (!URL.canParse(target, source.url)) return undefined
  const url = new URL(target, source.url)
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return undefined
  if (
    loopback(url) &&
    (!source.preview || !URL.canParse(source.preview) || new URL(source.preview).href !== url.href)
  )
    return undefined
  return url.href
}

function sourceImage(src: string | undefined, source: Source) {
  if (!src || !URL.canParse(src, source.url)) return undefined
  const url = new URL(src, source.url)
  return ['http:', 'https:'].includes(url.protocol) && !loopback(url) ? url.href : undefined
}

type SourceNode = {
  type: string
  url?: string
  identifier?: string
  alt?: string
  value?: string
  children?: SourceNode[]
}
function sourceLinks(source: Source) {
  return (tree: SourceNode) => {
    const definitions = new Map<string, string>()
    const collect = (node: SourceNode) => {
      if (
        node.type === 'definition' &&
        node.identifier &&
        node.url &&
        !definitions.has(node.identifier)
      )
        definitions.set(node.identifier, node.url)
      node.children?.forEach(collect)
    }
    collect(tree)
    const visit = (node: SourceNode) => {
      node.children = node.children?.flatMap((child) => {
        visit(child)
        // Streamdown's rehypeRaw runs before skipHtml; remove raw nodes first (#135567).
        if (child.type === 'html' || child.type === 'definition') return []
        const reference = child.type === 'linkReference' || child.type === 'imageReference'
        const url = reference ? definitions.get(child.identifier ?? '') : child.url
        if (child.type === 'link' || child.type === 'linkReference') {
          const href = sourceHref(url, source)
          return href ? [{ ...child, type: 'link', url: href }] : (child.children ?? [])
        }
        if (child.type === 'image' || child.type === 'imageReference') {
          const src = sourceImage(url, source)
          return src
            ? [{ ...child, type: 'image', url: src }]
            : [{ type: 'text', value: child.alt ?? '' }]
        }
        return [child]
      })
    }
    visit(tree)
  }
}

const CoreImage = defaultComponents.img
function Image(props: ComponentProps<'img'> & ExtraProps) {
  const source = useContext(SourceContext)
  if (!source) return <CoreImage {...props} />
  const src = sourceImage(typeof props.src === 'string' ? props.src : undefined, source)
  return src ? <CoreImage {...props} src={src} srcSet={undefined} /> : <>{props.alt}</>
}

const CoreLink = defaultComponents.a
/** A link as the `link` renderers compose it, starting with Streamdown's, which asks before opening a new tab. */
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const renderers = linkRenderers(useExtensions())
  const source = useContext(SourceContext)
  const { href, children } = props
  if (source) {
    const remote = sourceHref(href, source)
    return remote ? <CoreLink {...props} href={remote} /> : <>{children}</>
  }
  // A `#id` mention stays its text unless a renderer knows the conversation.
  const core = href && parseMention(href) ? <>{children}</> : <CoreLink {...props} />
  // Streamdown marks a link whose Markdown is still streaming.
  if (!href || href === 'streamdown:incomplete-link') return core
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary
        extension={extension}
        fallback={inner}
        key={extension}
        variant="inline"
        version={version}
      >
        <Renderer core={inner} href={href}>
          {children}
        </Renderer>
      </ExtensionBoundary>
    ),
    core,
  )
}

/**
 * Plain text with its `#id` mentions rendered as Markdown mentions are (conversation chips), for text shown verbatim
 * rather than as Markdown: prompts, abstracts, divergences.
 */
export function MentionText({ text }: { text: string }) {
  return splitMentions(text).map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- Mention positions in split text; mentions may repeat.
      <Link href={mentionHref(part.conversation, part.entry)} key={index}>
        {part.text}
      </Link>
    ),
  )
}

const CoreCode = defaultComponents.code
/** An inline code span as the `inlineCode` renderers compose it, starting with Streamdown's. */
function InlineCode(props: ComponentProps<'code'> & ExtraProps) {
  const renderers = inlineCodeRenderers(useExtensions())
  const source = useContext(SourceContext)
  const { children } = props
  const core = <CoreCode {...props} />
  if (source || typeof children !== 'string') return core
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary
        extension={extension}
        fallback={inner}
        key={extension}
        variant="inline"
        version={version}
      >
        <Renderer code={children} core={inner} />
      </ExtensionBoundary>
    ),
    core,
  )
}

const components = { a: Link, img: Image, inlineCode: InlineCode }
// After GFM, so autolinked URLs are links already and keep their `#fragment`.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkMentions]

/** A fenced code block as the `codeBlocks` renderers of its language compose it, starting with the core block. */
function ExtensionCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  const renderers = codeBlockRenderers(useExtensions(), language)
  const source = useContext(SourceContext)
  const core = (
    <CodeBlock code={code} isIncomplete={isIncomplete} language={language} lineNumbers={false}>
      <CodeBlockCopyButton />
    </CodeBlock>
  )
  if (source) return core
  return renderers.reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer code={code} core={inner} incomplete={isIncomplete} language={language} />
      </ExtensionBoundary>
    ),
    core,
  )
}
const controls = { code: { copy: true, download: false }, table: false, mermaid: false } as const

/** Markdown that may still be streaming. */
export const MessageResponse = memo(
  ({ className, ...props }: ComponentProps<typeof Streamdown>) => {
    const extensions = useExtensions()
    const source = useContext(SourceContext)
    const languages = source ? '' : codeBlockLanguages(extensions).join(' ')
    const remarks = useMemo(
      () =>
        source
          ? [...remarkPlugins, [sourceLinks, source] as [typeof sourceLinks, Source]]
          : remarkPlugins,
      [source],
    )
    const plugins = useMemo(
      () => ({
        code: codePlugin,
        renderers: languages
          ? [{ language: languages.split(' '), component: ExtensionCodeBlock }]
          : [],
      }),
      [languages],
    )
    // Streamdown's memo ignores remarkPlugins; a source change must reparse links (#135567).
    return (
      <Streamdown
        key={source ? JSON.stringify([source.url ?? null, source.preview ?? null]) : undefined}
        className={cn('markdown min-w-0', className)}
        components={components}
        controls={controls}
        lineNumbers={false}
        plugins={plugins}
        remarkPlugins={remarks}
        shikiTheme={codePlugin.getThemes()}
        {...props}
        {...(source ? { skipHtml: true } : {})}
      />
    )
  },
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
)
MessageResponse.displayName = 'MessageResponse'
