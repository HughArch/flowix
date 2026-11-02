import type {
  ShikiHighlightBlockResult,
  ShikiHighlightInput,
} from './shiki-decorations'

interface WorkerReply {
  id: number
  ok: boolean
  blocks?: ShikiHighlightBlockResult[]
  workerMs?: number
  error?: string
}

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, {
  resolve: (reply: WorkerReply) => void
  reject: (error: Error) => void
}>()

function failWorker(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
  worker?.terminate()
  worker = null
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./shiki-tokenizer.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.ok) request.resolve(event.data)
    else request.reject(new Error(event.data.error ?? 'Shiki worker failed'))
  })
  worker.addEventListener('error', (event) => {
    failWorker(new Error(event.message || 'Shiki worker crashed'))
  })
  worker.addEventListener('messageerror', () => {
    failWorker(new Error('Shiki worker returned an unreadable result'))
  })
  return worker
}

export function tokenizeCodeBlocksInWorker(
  blocks: readonly ShikiHighlightInput[],
): Promise<WorkerReply> {
  if (blocks.length === 0) {
    return Promise.resolve({ id: 0, ok: true, blocks: [], workerMs: 0 })
  }
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Workers are unavailable'))

  const id = ++nextRequestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      getWorker().postMessage({ id, blocks })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
