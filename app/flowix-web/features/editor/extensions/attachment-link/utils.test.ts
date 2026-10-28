import { describe, expect, it } from 'vitest';
import { isAbsoluteStorageKey, resolveAttachmentStorageKey } from './utils';

describe('isAbsoluteStorageKey', () => {
  it('separates notebook-relative keys from device-local paths', () => {
    expect(isAbsoluteStorageKey('attachments/photo.jpg')).toBe(false);
    expect(isAbsoluteStorageKey('D:\\vault\\attachments\\photo.jpg')).toBe(true);
    expect(isAbsoluteStorageKey('/home/user/vault/attachments/photo.jpg')).toBe(true);
  });
});

describe('resolveAttachmentStorageKey', () => {
  it('joins notebook-relative keys onto the local notebook root', () => {
    expect(resolveAttachmentStorageKey('attachments/photo.jpg', 'C:\\vault')).toBe('C:/vault/attachments/photo.jpg');
    expect(resolveAttachmentStorageKey('attachments/photo.jpg', '/vault/')).toBe('/vault/attachments/photo.jpg');
  });

  it('normalizes separators in relative keys', () => {
    expect(resolveAttachmentStorageKey('attachments\\photo.jpg', 'C:\\vault')).toBe('C:/vault/attachments/photo.jpg');
  });

  it('leaves absolute keys untouched', () => {
    expect(resolveAttachmentStorageKey('C:\\vault\\attachments\\photo.jpg', 'C:\\vault'))
      .toBe('C:\\vault\\attachments\\photo.jpg');
  });

  it('returns keys unchanged when the owning notebook is unknown', () => {
    expect(resolveAttachmentStorageKey('attachments/photo.jpg')).toBe('attachments/photo.jpg');
  });
});
