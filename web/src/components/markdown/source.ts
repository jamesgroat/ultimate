import type { Nodes as MdastNodes, Root } from 'mdast'
import { parseMention } from '../ai/mentions.ts'

export type MarkdownOrigin = { url?: string; preview?: string | null }

const loopback = (url: URL) =>
  url.hostname === 'localhost' ||
  url.hostname.endsWith('.localhost') ||
  url.hostname.startsWith('127.') ||
  url.hostname === '[::1]' ||
  url.hostname === '0.0.0.0'

export function sourceHref(href: string | undefined, source: MarkdownOrigin) {
  if (!href || href.startsWith('streamdown:')) return undefined
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

export function sourceImage(src: string | undefined, source: MarkdownOrigin) {
  if (!src || !URL.canParse(src, source.url)) return undefined
  const url = new URL(src, source.url)
  return ['http:', 'https:'].includes(url.protocol) && !loopback(url) ? url.href : undefined
}

type Node = MdastNodes & { children?: Node[]; url?: string; identifier?: string; alt?: string }

export function scopeToSource(tree: Root, source: MarkdownOrigin) {
  const definitions = new Map<string, string>()
  const collect = (node: Node) => {
    if (
      node.type === 'definition' &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url)
    node.children?.forEach(collect)
  }
  collect(tree as Node)
  const visit = (node: Node) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): Node[] => {
      visit(child)
      if (child.type === 'html' || child.type === 'definition') return []
      const reference = child.type === 'linkReference' || child.type === 'imageReference'
      const url = reference ? definitions.get(child.identifier ?? '') : child.url
      if (child.type === 'link' || child.type === 'linkReference') {
        const href = sourceHref(url, source)
        return href
          ? [{ type: 'link', url: href, children: child.children ?? [] }]
          : (child.children ?? [])
      }
      if (child.type === 'image' || child.type === 'imageReference') {
        const src = sourceImage(url, source)
        return src
          ? [{ type: 'image', url: src, alt: child.alt ?? '' }]
          : [{ type: 'text', value: child.alt ?? '' }]
      }
      return [child]
    })
  }
  visit(tree as Node)
}
