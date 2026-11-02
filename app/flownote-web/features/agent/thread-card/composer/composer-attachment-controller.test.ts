import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerAttachmentController, type AgentThreadCardInputAttachment } from './composer-attachment-controller';

const mocks = vi.hoisted(() => ({ cacheAttachment: vi.fn(), deleteCachedAttachment: vi.fn(), readCachedAttachment: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ agent: mocks }));
const controllers: ComposerAttachmentController[] = [];
function setup(initialAttachments: AgentThreadCardInputAttachment[] = []) {
  const composer = document.createElement('div');
  composer.className = 'agent-composer';
  const strip = document.createElement('div');
  composer.append(strip);
  const input = document.createElement('div');
  document.body.append(composer, input);
  const onChange = vi.fn();
  const onLimitExceeded = vi.fn();
  const controller = new ComposerAttachmentController({
    input, initialAttachments, onChange, onLimitExceeded, onError: vi.fn(), onStateChange: vi.fn(),
  });
  controller.connectStrip(strip);
  controllers.push(controller);
  return { controller, input, strip, composer, onChange, onLimitExceeded };
}
const chipLabels = (strip: HTMLElement) =>
  [...strip.querySelectorAll('.agent-composer__attachment-chip-label')].map((node) => node.textContent);

beforeEach(() => {
  mocks.cacheAttachment.mockImplementation(async (_content: string, mimeType: string) => ({ path: `/tmp/${mocks.cacheAttachment.mock.calls.length}`, mimeType, name: 'generated' }));
  mocks.readCachedAttachment.mockResolvedValue('data:image/png;base64,AQID');
  mocks.deleteCachedAttachment.mockResolvedValue(true);
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) },
  });
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  document.body.replaceChildren();
  vi.resetAllMocks();
});

describe('ComposerAttachmentController', () => {
  it('pastes an image into the chip strip and retains the original filename', async () => {
    const { controller, input, strip } = setup();
    const file = new File(['image'], 'photo.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } });
    input.dispatchEvent(event);
    await vi.waitFor(() => expect(controller.hasPending).toBe(false));
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(chipLabels(strip)).toEqual(['photo.png']));
    expect(controller.readyAttachments[0].name).toBe('photo.png');
  });

  it('restores initial image and PDF attachments as removable chips', () => {
    const attachments = [
      { path: '/tmp/photo.png', mimeType: 'image/png', name: 'photo.png' },
      { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
    ];
    const { strip, composer, controller } = setup(attachments);
    expect(chipLabels(strip)).toEqual(['photo.png', 'report.pdf']);
    expect(strip.hidden).toBe(false);
    expect(composer.classList.contains('agent-composer--has-attachments')).toBe(true);
    expect(controller.readyAttachments).toEqual(attachments);
  });

  it('removes a chip from the strip and deletes its cache file', async () => {
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    const { strip, composer, controller, onChange } = setup([attachment]);
    controller.removeAttachment(attachment.path);
    await vi.waitFor(() => expect(mocks.deleteCachedAttachment).toHaveBeenCalledWith(attachment.path));
    expect(chipLabels(strip)).toEqual([]);
    expect(strip.hidden).toBe(true);
    expect(composer.classList.contains('agent-composer--has-attachments')).toBe(false);
    expect(controller.hasAttachments).toBe(false);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('removes an attachment through the chip remove button', () => {
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    const { strip, controller } = setup([attachment]);
    const removeButton = strip.querySelector<HTMLButtonElement>('.agent-composer__attachment-chip-remove');
    expect(removeButton).not.toBeNull();
    removeButton!.click();
    expect(controller.hasAttachments).toBe(false);
    expect(mocks.deleteCachedAttachment).toHaveBeenCalledWith(attachment.path);
  });

  it('keeps in-flight submission files pinned against chip removal', () => {
    const attachment = { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' };
    const { controller } = setup([attachment]);
    controller.setLocked(true);
    controller.removeAttachment(attachment.path);
    expect(controller.hasAttachments).toBe(true);
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
    controller.clearAfterSubmit();
    expect(controller.hasAttachments).toBe(false);
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

  it('removes missing cached-image metadata and its chip', async () => {
    mocks.readCachedAttachment.mockResolvedValue(null);
    const { controller, strip, onChange } = setup([{ path: '/tmp/missing.png', name: 'missing.png', mimeType: 'image/png' }]);
    await vi.waitFor(() => expect(controller.hasAttachments).toBe(false));
    await vi.waitFor(() => expect(chipLabels(strip)).toEqual([]));
    expect(onChange).toHaveBeenCalledWith([]);
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
  });

  it('prompts document attachments as file links while images ride the wire', () => {
    const attachments = [
      { path: '/tmp/photo.png', mimeType: 'image/png', name: 'photo.png' },
      { path: '/tmp/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
    ];
    const { controller } = setup(attachments);
    expect(controller.documentPromptLinks()).toBe('[report.pdf](file:///tmp/report.pdf)');
  });
});
