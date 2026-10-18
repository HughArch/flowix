import type { JSONContent } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { createMarkdownParserExtensions, hasUnsupportedWorkerMarkdown } from './markdown-parser-extensions'
import { normalizeMarkdownTableEmptyCells } from './markdown-normalization'

interface WorkerRequest {
  id: number
  markdown: string
}

let manager: MarkdownManager | null = null

function containsRawHtmlToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawHtmlToken)
  if (!value || typeof value !== 'object') return false
  const token = value as Record<string, unknown>
  if (token.type === 'html') return true
  return Object.values(token).some(containsRawHtmlToken)
}

function createManager(): MarkdownManager {
  const extensions = createMarkdownParserExtensions()
  return new MarkdownManager({
    extensions,
    markedOptions: { gfm: true, breaks: true },
  })
}

function getManager(): MarkdownManager {
  if (!manager) manager = createManager()
  return manager
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, markdown } = event.data
  const startedAt = performance.now()
  try {
    const activeManager = getManager()
    const normalizedMarkdown = normalizeMarkdownTableEmptyCells(markdown)
    if (hasUnsupportedWorkerMarkdown(normalizedMarkdown)) {
      throw new Error('Markdown uses a legacy Agent Thread Card form; preserve the main-thread parser')
    }
    if (containsRawHtmlToken(activeManager.instance.lexer(normalizedMarkdown))) {
      throw new Error('Markdown contains raw HTML; preserve the main-thread HTML parser')
    }
    const document: JSONContent = activeManager.parse(normalizedMarkdown)
    self.postMessage({
      id,
      ok: true,
      document,
      workerMs: Math.round((performance.now() - startedAt) * 10) / 10,
    })
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
