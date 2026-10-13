import { expect, it, vi } from 'vitest';
import { compareAndPatchDocumentProperties, compareAndSetDocumentProperty, patchDocumentProperties, setDocumentProperties } from './path-properties';
import { ensureFileDisplayIdentity, reconcileFileDisplays } from '@/lib/file-display-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import { applyLoadedContent, getBuffer } from '../store/buffer-registry';
import { recordDocumentEdit } from '../store/document-session-service';
const mocks = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn() }));
vi.mock('../use-cases/local-document-operations', () => ({ localDocumentOperations: { write: mocks.write } }));
vi.mock('../use-cases/memo-document-operations', () => ({ memoDocumentOperations: { read: mocks.read } }));

it('preserves body bytes, comments and unrelated YAML while setting colors', () => {
  const body = '# Title\r\n\r\nunchanged  \r\n';
  const result = patchDocumentProperties('---\n# keep comment\nstatus: draft\n---\n' + body, { flowix_colors: ['blue'] });
  expect(result).toContain('# keep comment');
  expect(result).toContain('status: draft');
  expect(result.endsWith(body)).toBe(true);
  expect(result).not.toContain('flowix_key');
});

it('rejects malformed YAML instead of overwriting it', () => {
  expect(() => patchDocumentProperties('---\nstatus: [broken\n---\nbody', { flowix_favorited: true })).toThrow();
});

it('saves properties with unsaved body edits through the same document buffer', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/note.md'));
  reconcileFileDisplays([{ path: identity.path }]);
  applyLoadedContent(identity, identity.path, '# Initial\n', { setAsCurrent: false });
  recordDocumentEdit(identity, '# Latest unsaved body\n');
  mocks.write.mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
  expect(await setDocumentProperties(identity.path, { flowix_colors: ['green'] })).toBe(true);
  const request = mocks.write.mock.calls[0][0];
  expect(request.path).toBe(identity.path);
  expect(request.content).toContain('# Latest unsaved body');
  expect(request.content).toContain('green');
  expect(request.content).not.toContain('flowix_key');
  expect(request.expectedContent).toBe('# Initial\n');
  expect(request.memoId).toBeUndefined();
  expect(getBuffer(identity)?.content).toBe(request.content);
});

it('updates an empty frontmatter block and does not displace a UTF-8 BOM into the body', () => {
  expect(patchDocumentProperties('---\n---\nbody', { flowix_favorited: true }).match(/---/g)).toHaveLength(2);
  expect(patchDocumentProperties('\uFEFFbody', { flowix_favorited: true })).not.toContain('\uFEFF');
  expect(patchDocumentProperties('body\n---\nstatus: prose\n---\n', { flowix_favorited: true })).toContain('body\n---\nstatus: prose\n---\n');
});

it('refuses to overwrite a property changed after the migration snapshot', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/concurrent.md'));
  applyLoadedContent(identity, identity.path, '---\nstatus: new\n---\nbody', { setAsCurrent: false });
  recordDocumentEdit(identity, '---\nstatus: user-edit\n---\nbody');
  mocks.write.mockClear();
  expect(await compareAndSetDocumentProperty(identity.path, 'status', { exists: true, value: 'new' }, { exists: true, value: 'old' })).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(getBuffer(identity)?.content).toContain('user-edit');
});

it('checks property presence before restoring a removed value', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/removed.md'));
  applyLoadedContent(identity, identity.path, '---\nother: keep\n---\nbody', { setAsCurrent: false });
  mocks.write.mockClear();
  mocks.write.mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
  expect(await compareAndSetDocumentProperty(identity.path, 'status', { exists: false }, { exists: true, value: 'old' })).toBe(true);
  expect(mocks.write.mock.calls[0][0].content).toContain('status: old');
});

it('restores the buffer when a guarded write encounters a disk conflict', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/conflict.md'));
  const content = '---\nstatus: old\n---\nbody';
  applyLoadedContent(identity, identity.path, content, { setAsCurrent: false });
  mocks.write.mockResolvedValue({ status: 'conflict', content: 'external content' });
  expect(await compareAndSetDocumentProperty(identity.path, 'status', { exists: true, value: 'old' }, { exists: true, value: 'new' })).toBe(false);
  expect(getBuffer(identity)?.content).toBe(content);
});

it('moves a key in one guarded write and preserves other properties and body', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/rename.md'));
  applyLoadedContent(identity, identity.path, '---\nstatus: old\nother: keep\n---\nbody\n', { setAsCurrent: false });
  mocks.write.mockClear();
  mocks.write.mockImplementation(async request => ({ status: 'saved', path: request.path, content: request.content }));
  expect(await compareAndPatchDocumentProperties(identity.path,
    { status: { exists: true, value: 'old' }, renamed: { exists: false } },
    { status: { exists: false }, renamed: { exists: true, value: 'old' } },
  )).toBe(true);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  const content = mocks.write.mock.calls[0][0].content;
  expect(content).not.toContain('status:');
  expect(content).toContain('renamed: old');
  expect(content).toContain('other: keep');
  expect(content.endsWith('body\n')).toBe(true);
});

it('refuses a key move if another edit has created its destination', async () => {
  const identity = documentIdentityFromFile(ensureFileDisplayIdentity('/properties/rename-conflict.md'));
  applyLoadedContent(identity, identity.path, '---\nstatus: old\nrenamed: user-value\n---\nbody', { setAsCurrent: false });
  mocks.write.mockClear();
  expect(await compareAndPatchDocumentProperties(identity.path,
    { status: { exists: true, value: 'old' }, renamed: { exists: false } },
    { status: { exists: false }, renamed: { exists: true, value: 'old' } },
  )).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled();
});
