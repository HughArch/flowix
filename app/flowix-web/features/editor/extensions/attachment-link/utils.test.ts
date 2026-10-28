import { describe, expect, it } from 'vitest';
import { isAbsoluteStorageKey, resolveAttachmentStorageKey } from './utils';

describe('isAbsoluteStorageKey', () => {
  it('separates notebook-relative keys from device-local paths', () => {
    expect(isAbsoluteStorageKey('attachments/photo.jpg')).toBe(false);
    expect(isAbsoluteStorageKey('D:\\vault\\attachments\\photo.jpg')).toBe(true);
    expect(isAbsoluteStorageKey('d:/vault/attachments/photo.jpg')).toBe(true);
    expect(isAbsoluteStorageKey('/home/user/vault/attachments/photo.jpg')).toBe(true);
    expect(isAbsoluteStorageKey('\\\\server\\share\\photo.jpg')).toBe(true);
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

  it('keeps absolute keys that already live inside this device notebook', () => {
    expect(resolveAttachmentStorageKey('C:\\vault\\attachments\\photo.jpg', 'C:\\vault'))
      .toBe('C:\\vault\\attachments\\photo.jpg');
  });

  it('matches notebook roots case-insensitively for drive-letter paths', () => {
    expect(resolveAttachmentStorageKey('C:\\Vault\\attachments\\photo.jpg', 'c:\\vault'))
      .toBe('C:\\Vault\\attachments\\photo.jpg');
  });

  it('rebases legacy absolute keys from another device onto the local attachments directory', () => {
    // Desktop persisted D:\flowix\...; the same file syncs to this device's
    // notebook under attachments/<name>.
    expect(resolveAttachmentStorageKey('D:\\flowix\\attachments\\133864360343560357.jpg', '/data/flowix'))
      .toBe('/data/flowix/attachments/133864360343560357.jpg');
    expect(resolveAttachmentStorageKey('/home/other/notes/attachments/photo.jpg', 'C:\\vault'))
      .toBe('C:/vault/attachments/photo.jpg');
  });

  it('leaves foreign absolute keys alone when they are not under an attachments directory', () => {
    expect(resolveAttachmentStorageKey('D:\\photos\\photo.jpg', '/data/flowix')).toBe('D:\\photos\\photo.jpg');
  });

  it('returns keys unchanged when the owning notebook is unknown', () => {
    expect(resolveAttachmentStorageKey('attachments/photo.jpg')).toBe('attachments/photo.jpg');
    expect(resolveAttachmentStorageKey('D:\\vault\\attachments\\photo.jpg')).toBe('D:\\vault\\attachments\\photo.jpg');
  });
});
