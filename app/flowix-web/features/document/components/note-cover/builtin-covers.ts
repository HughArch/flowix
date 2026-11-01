// 内置封面 — 统一来自 `/assets/covers/` (20 张 1200x400 JPEG, 已压缩)。
// 资源随应用打包 (vite import.meta.glob, 与 property-icons.ts 模式一致),
// 选择时只在 frontmatter 写入 `builtin:covers/<文件名>` 引用,
// 不复制进笔记本附件目录。
// 加载走 vite import.meta.glob (eager, import: 'default'), URL 直接喂 <img src=...>。

const COVER_MODULES = import.meta.glob<string>(
  '../../../../assets/covers/*.jpg',
  { eager: true, import: 'default' },
);

const toBuiltinKey = (modulePath: string): string =>
  `builtin:covers/${modulePath.split('/').pop() ?? modulePath}`;

const OPTIONS = Object.entries(COVER_MODULES)
  .map(([modulePath, src]) => ({ key: toBuiltinKey(modulePath), url: src }))
  .sort((left, right) => left.key.localeCompare(right.key));

/** Bundled cover gallery: `builtin:` frontmatter key + Vite asset URL. */
export const BUILTIN_COVER_OPTIONS: ReadonlyArray<{ key: string; url: string }> = OPTIONS;

/** Bundled cover gallery URLs (Vite-hashed), ordered by file name. */
export const BUILTIN_COVER_URLS: string[] = OPTIONS.map((option) => option.url);

export const BUILTIN_COVER_URL_BY_KEY = new Map(OPTIONS.map((option) => [option.key, option.url]));
