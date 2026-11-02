import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ResultTooLargeError } from '../protocol/domain-errors.js'

export class ExportStore {
  constructor({ inlineBytes = 1024 * 1024, maxBytes = 100 * 1024 * 1024, ttlMs = 15 * 60_000 } = {}) {
    this.inlineBytes = inlineBytes; this.maxBytes = maxBytes; this.ttlMs = ttlMs
    this.root = join(tmpdir(), 'flownote-dsh-exports'); this.files = new Map()
  }
  async create(filename, content) {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.maxBytes) throw new ResultTooLargeError(bytes, this.maxBytes, { operation: 'export' })
    if (bytes <= this.inlineBytes) return { filename, content, bytes, delivery: 'inline' }
    await mkdir(this.root, { recursive: true })
    const receiptId = randomUUID(), path = join(this.root, `${receiptId}.json`)
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    const expiresAt = Date.now() + this.ttlMs
    const timer = setTimeout(() => void this.remove(receiptId), this.ttlMs); timer.unref?.()
    this.files.set(receiptId, { path, timer })
    return { filename, receiptId, path, bytes, expiresAt: new Date(expiresAt).toISOString(), delivery: 'temporary-file' }
  }
  async remove(receiptId) {
    const row = this.files.get(receiptId); if (!row) return
    this.files.delete(receiptId); clearTimeout(row.timer)
    try { await unlink(row.path) } catch { /* already removed */ }
  }
  async read(receiptId) {
    const row = this.files.get(String(receiptId))
    if (!row) return null
    return { ...row, content: await readFile(row.path, 'utf8') }
  }
  async dispose() { await Promise.allSettled([...this.files.keys()].map(id => this.remove(id))) }
}
