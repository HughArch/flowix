import type { Image as TauriImage } from '@tauri-apps/api/image';
import menuArchiveSvg from '@/assets/menu-icons/archive.svg?raw';
import menuCodeSvg from '@/assets/menu-icons/code.svg?raw';
import menuCopySvg from '@/assets/menu-icons/copy.svg?raw';
import menuDeleteSvg from '@/assets/menu-icons/delete.svg?raw';
import menuFolderOpenSvg from '@/assets/menu-icons/folder-open.svg?raw';
import menuHistorySvg from '@/assets/menu-icons/history.svg?raw';
import menuInfoSvg from '@/assets/menu-icons/info.svg?raw';
import menuLinkSvg from '@/assets/menu-icons/link.svg?raw';
import menuListChecksSvg from '@/assets/menu-icons/list-checks.svg?raw';
import menuMarkdownSvg from '@/assets/menu-icons/markdown.svg?raw';
import menuPaletteSvg from '@/assets/menu-icons/palette.svg?raw';
import menuPdfSvg from '@/assets/menu-icons/pdf.svg?raw';
import menuPencilSvg from '@/assets/menu-icons/pencil.svg?raw';
import menuPinSvg from '@/assets/menu-icons/pin.svg?raw';
import menuSplitSvg from '@/assets/menu-icons/split.svg?raw';
import menuStarSvg from '@/assets/menu-icons/star.svg?raw';
import menuTemplateSvg from '@/assets/menu-icons/template.svg?raw';
import menuUnpinSvg from '@/assets/menu-icons/unpin.svg?raw';
import menuWordSvg from '@/assets/menu-icons/word.svg?raw';

export type NativeMenuIconImage = TauriImage;

export type NativeMenuIconName =
  | 'archive'
  | 'code'
  | 'copy'
  | 'delete'
  | 'folder-open'
  | 'history'
  | 'info'
  | 'link'
  | 'list-checks'
  | 'markdown'
  | 'palette'
  | 'pdf'
  | 'pencil'
  | 'pin'
  | 'split'
  | 'star'
  | 'template'
  | 'unpin'
  | 'word';

const iconSources: Record<NativeMenuIconName, string> = {
  archive: menuArchiveSvg,
  code: menuCodeSvg,
  copy: menuCopySvg,
  delete: menuDeleteSvg,
  'folder-open': menuFolderOpenSvg,
  history: menuHistorySvg,
  info: menuInfoSvg,
  link: menuLinkSvg,
  'list-checks': menuListChecksSvg,
  markdown: menuMarkdownSvg,
  palette: menuPaletteSvg,
  pdf: menuPdfSvg,
  pencil: menuPencilSvg,
  pin: menuPinSvg,
  split: menuSplitSvg,
  star: menuStarSvg,
  template: menuTemplateSvg,
  unpin: menuUnpinSvg,
  word: menuWordSvg,
};

export async function loadNativeMenuIcons(
  names: readonly NativeMenuIconName[],
): Promise<Partial<Record<NativeMenuIconName, TauriImage>>> {
  const { phosphorMenuIcon } = await import('./phosphor-menu-icon');
  const loaded = await Promise.all(
    names.map(async (name) => [name, await phosphorMenuIcon(name, iconSources[name])] as const),
  );
  return Object.fromEntries(loaded);
}
