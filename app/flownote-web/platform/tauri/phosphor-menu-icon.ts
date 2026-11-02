import { Image as TauriImage } from '@tauri-apps/api/image';

const iconCache = new Map<string, Promise<TauriImage>>();

/** Rasterize a bundled Phosphor SVG and retain its Tauri image resource. */
export function phosphorMenuIcon(key: string, svgSource: string): Promise<TauriImage> {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim() || '#4b4b4b';
  const cacheKey = `${color}:${key}`;
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
    // muda displays custom macOS menu icons at a fixed 18pt height. Supply a
    // 2x Retina canvas, while keeping the glyph itself at ~14pt so it does
    // not visually crowd the menu label. This is slightly larger than the
    // original 26px glyph while preserving the native menu's fixed slot.
    const canvasSize = 36;
    const glyphSize = 28;
    const glyphOffset = (canvasSize - glyphSize) / 2;
    const markup = svgSource.split('currentColor').join(color);
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new window.Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvasSize;
      canvas.height = canvasSize;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.drawImage(image, glyphOffset, glyphOffset, glyphSize, glyphSize);
      const rgba = context.getImageData(0, 0, canvasSize, canvasSize).data;
      return TauriImage.new(new Uint8Array(rgba), canvasSize, canvasSize);
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  iconCache.set(cacheKey, pending);
  // Do not permanently poison the cache when SVG decoding or canvas creation
  // fails once (for example during a transient WebView startup). A later
  // menu opening should be allowed to retry the rasterization.
  void pending.catch(() => {
    if (iconCache.get(cacheKey) === pending) iconCache.delete(cacheKey);
  });
  return pending;
}
