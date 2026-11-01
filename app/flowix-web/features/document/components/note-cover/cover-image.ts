/**
 * Cover images are persisted as center-cropped 3:1 JPEG attachments so cards
 * and the editor banner render without further processing (Notion-style).
 */
export const COVER_ASPECT_RATIO = 3;
export const COVER_MAX_WIDTH = 1200;

/** SVG cannot be drawn through `createImageBitmap`; keep those bytes as-is. */
export function isSvgPayload(mime: string | null | undefined, fileName?: string): boolean {
  if (mime && /svg/i.test(mime)) return true;
  return Boolean(fileName && /\.svg$/i.test(fileName));
}

export async function cropToCoverBlob(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const ratio = bitmap.width / bitmap.height;
    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;
    if (ratio > COVER_ASPECT_RATIO) {
      sw = Math.round(bitmap.height * COVER_ASPECT_RATIO);
      sx = Math.round((bitmap.width - sw) / 2);
    } else if (ratio < COVER_ASPECT_RATIO) {
      sh = Math.round(bitmap.width / COVER_ASPECT_RATIO);
      sy = Math.round((bitmap.height - sh) / 2);
    }
    const width = Math.min(COVER_MAX_WIDTH, Math.max(sw, 1));
    const height = Math.max(Math.round(width / COVER_ASPECT_RATIO), 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Encoding the cover image failed');
    return blob;
  } finally {
    bitmap.close();
  }
}

export async function bytesToBase64(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBlob(contentBase64: string, mime: string | null | undefined): Blob {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}
