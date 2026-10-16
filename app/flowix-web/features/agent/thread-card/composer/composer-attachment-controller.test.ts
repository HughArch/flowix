import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachmentDocumentPort } from './composer-attachment-document';
import { ComposerAttachmentController, type AgentThreadCardInputAttachment } from './composer-attachment-controller';

const mocks = vi.hoisted(() => ({ cacheAttachment: vi.fn(), deleteCachedAttachment: vi.fn(), readCachedAttachment: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ agent: mocks }));
const controllers: ComposerAttachmentController[] = [];
function setup(initialAttachments: AgentThreadCardInputAttachment[] = []) {
  const input = document.createElement('div');
  document.body.append(input);
  const onChange = vi.fn();
  const onLimitExceeded = vi.fn();
  const controller = new ComposerAttachmentController({
    input, initialAttachments, onChange, onLimitExceeded, onError: vi.fn(), onStateChange: vi.fn(),
  });
  const insertAttachmentToken = vi.fn((_attachment: AgentThreadCardInputAttachment, point = { from: 1, to: 1 }) => ({ from: point.from + 1, to: point.from + 1 }));
  const composer: ComposerAttachmentDocumentPort = {
    captureAttachmentInsertionAnchor: () => undefined,
    insertAttachmentToken,
    removeAttachmentToken: vi.fn(),
    setAttachmentTokensChanged: vi.fn(),
    dispose: vi.fn(),
  };
  controller.connectDocument(composer);
  controllers.push(controller);
  return { controller, input, onChange, onLimitExceeded, insertAttachmentToken };
}
beforeEach(() => {
  mocks.cacheAttachment.mockImplementation(async (_content: string, mimeType: string) => ({ path: `/tmp/${mocks.cacheAttachment.mock.calls.length}`, mimeType, name: 'generated' }));
  mocks.readCachedAttachment.mockResolvedValue('data:image/png;base64,AQID');
  mocks.deleteCachedAttachment.mockResolvedValue(true);
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  document.body.replaceChildren();
  vi.resetAllMocks();
});

describe('ComposerAttachmentController', () => {
  it('pastes an image into the editor and retains the original filename', async () => {
    const { controller, input, insertAttachmentToken } = setup();
    const file = new File(['image'], 'photo.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } });
    input.dispatchEvent(event);
    await vi.waitFor(() => expect(controller.hasPending).toBe(false));
    expect(event.defaultPrevented).toBe(true);
    expect(insertAttachmentToken).toHaveBeenCalledWith(expect.objectContaining({ name: 'photo.png' }), undefined);
    expect(controller.readyAttachments[0].name).toBe('photo.png');
  });

  it('restores image and PDF attachments into the editor without an external preview container', () => {
    const attachments = [
      { path: '/tmp/photo.png', mimeType: 'image/png', name: 'photo.png' },
      { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
    ];
    const { insertAttachmentToken, controller } = setup(attachments);
    expect(insertAttachmentToken.mock.calls.map(([attachment]) => attachment)).toEqual(attachments);
    expect(controller.readyAttachments).toEqual(attachments);
  });

  it('keeps removed attachments available for undo and cleans them when the surface closes', () => {
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    const { controller } = setup([attachment]);
    controller.syncInlineAttachments([]);
    expect(controller.hasAttachments).toBe(false);
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
    controller.syncInlineAttachments([attachment]);
    expect(controller.readyAttachments).toEqual([attachment]);
    controller.syncInlineAttachments([]);
    controller.dispose();
    expect(mocks.deleteCachedAttachment).toHaveBeenCalledWith(attachment.path);
  });

  it('rebuilds attachments from persisted editor nodes even when host metadata is absent', () => {
    const { controller } = setup();
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    controller.syncInlineAttachments([attachment]);
    expect(controller.readyAttachments).toEqual([attachment]);
  });

  it('does not delete files belonging to an in-flight submission when its visible draft clears', () => {
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    const { controller } = setup([attachment]);
    controller.setLocked(true);
    controller.syncInlineAttachments([]);
    controller.clearAfterSubmit();
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
  });

  it('reserves all queued upload slots and enforces the file size limit', async () => {
    const { controller, onLimitExceeded } = setup();
    const files = Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.pdf`, { type: 'application/pdf' }));
    controller.addFiles([...files, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' })]);
    controller.addFiles([files[0]]);
    await vi.waitFor(() => expect(controller.hasPending).toBe(false));
    expect(mocks.cacheAttachment).toHaveBeenCalledTimes(5);
    expect(onLimitExceeded).toHaveBeenCalledWith('count');
    expect(onLimitExceeded).toHaveBeenCalledWith('size');
  });

  it('removes missing cached-image metadata and its inline node', async () => {
    mocks.readCachedAttachment.mockResolvedValue(null);
    const { controller, onChange } = setup([{ path: '/tmp/missing.png', name: 'missing.png', mimeType: 'image/png' }]);
    await vi.waitFor(() => expect(controller.hasAttachments).toBe(false));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
  });
});
