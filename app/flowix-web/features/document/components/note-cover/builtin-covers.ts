// 内置封面 — 统一来自 `/assets/covers/` (20 张 1200x400 JPEG)。
// 选择后会把原图字节复制进当前笔记本的 attachments 目录再写入
// `flowix_cover`, 因此打包资源只需随应用分发一份。
// 加载走 vite import.meta.glob (eager, import: 'default'), 与
// property-icons.ts 的模式一致, URL 直接喂 <img src=...>。

const COVER_MODULES = import.meta.glob<string>(
  '../../../assets/covers/*.jpg',
  { eager: true, import: 'default' },
);

/** Bundled cover gallery URLs (Vite-hashed), ordered by file name. */
export const BUILTIN_COVER_URLS: string[] = Object.entries(COVER_MODULES)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, src]) => src);
