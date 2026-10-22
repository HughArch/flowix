export interface BlockDragPreview {
  element: HTMLDivElement
  width: number
  height: number
}

const DRAG_PREVIEW_OFFSET_PX = 12
const DRAG_PREVIEW_VIEWPORT_PADDING_PX = 8
const DRAG_PREVIEW_MAX_WIDTH_PX = 480
const DRAG_PREVIEW_MAX_HEIGHT_PX = 320

/**
 * Build the floating ghost that follows the pointer.
 *
 * A single block keeps the original "lift the line" look. Several blocks are
 * stacked inside one card and labelled with their count, so a multi-block
 * drag reads as one payload instead of a wall of text.
 */
export function createBlockDragPreview(
  source: HTMLElement | readonly HTMLElement[] | null,
  clientX: number,
  clientY: number,
): BlockDragPreview | null {
  const sources = (Array.isArray(source) ? source : source ? [source] : [])
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
  if (sources.length === 0) return null

  const sourceRect = sources[0].getBoundingClientRect()
  const preview = document.createElement('div')
  preview.className = 'flowix-block-drag-preview'
  preview.dataset.blockCount = String(sources.length)
  preview.style.width = `${Math.min(Math.max(sourceRect.width, 1), DRAG_PREVIEW_MAX_WIDTH_PX)}px`
  preview.style.maxHeight = `${DRAG_PREVIEW_MAX_HEIGHT_PX}px`

  const cloneHost = document.createElement('div')
  cloneHost.className = sources.length > 1
    ? 'flowix-block-drag-preview-stack'
    : 'flowix-block-drag-preview-single'
  for (const element of sources) {
    cloneHost.appendChild(clonePreviewBlock(element))
  }
  if (sources.length > 1) {
    const badge = document.createElement('span')
    badge.className = 'flowix-block-drag-preview-count'
    badge.textContent = `${sources.length} 个块`
    preview.appendChild(badge)
  }

  // Keep the editor's scoped typography and node-view styles available to the
  // clone without moving the preview into the editor's overflow container.
  const previewEditor = document.createElement('div')
  previewEditor.className = 'markdown-editor'
  const previewContent = document.createElement('div')
  previewContent.className = 'ProseMirror'
  previewContent.setAttribute('aria-hidden', 'true')
  previewContent.style.minHeight = '0'
  previewContent.style.maxWidth = 'none'
  previewContent.style.margin = '0'
  previewContent.style.padding = '0'
  previewContent.style.height = 'auto'
  previewContent.style.overflow = 'visible'
  previewContent.appendChild(cloneHost)
  previewEditor.appendChild(previewContent)
  preview.appendChild(previewEditor)
  document.body.appendChild(preview)

  const previewRect = preview.getBoundingClientRect()
  const result: BlockDragPreview = {
    element: preview,
    width: previewRect.width,
    height: previewRect.height,
  }
  updateBlockDragPreview(result, clientX, clientY)
  return result
}

function clonePreviewBlock(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  clone.classList.remove('flowix-block-drag-source', 'is-block-selected', 'ProseMirror-selectednode')
  clone.removeAttribute('id')
  clone.removeAttribute('contenteditable')
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  clone.querySelectorAll('[contenteditable]').forEach((element) => element.removeAttribute('contenteditable'))
  return clone
}

export function updateBlockDragPreview(
  preview: BlockDragPreview | null,
  clientX: number,
  clientY: number,
): void {
  if (!preview) return

  const maxLeft = window.innerWidth - preview.width - DRAG_PREVIEW_VIEWPORT_PADDING_PX
  const maxTop = window.innerHeight - preview.height - DRAG_PREVIEW_VIEWPORT_PADDING_PX
  const left = Math.min(
    Math.max(DRAG_PREVIEW_VIEWPORT_PADDING_PX, clientX + DRAG_PREVIEW_OFFSET_PX),
    Math.max(DRAG_PREVIEW_VIEWPORT_PADDING_PX, maxLeft),
  )
  const top = Math.min(
    Math.max(DRAG_PREVIEW_VIEWPORT_PADDING_PX, clientY + DRAG_PREVIEW_OFFSET_PX),
    Math.max(DRAG_PREVIEW_VIEWPORT_PADDING_PX, maxTop),
  )
  preview.element.style.transform = `translate3d(${left}px, ${top}px, 0)`
}

export function removeBlockDragPreview(preview: BlockDragPreview | null): void {
  preview?.element.remove()
}
