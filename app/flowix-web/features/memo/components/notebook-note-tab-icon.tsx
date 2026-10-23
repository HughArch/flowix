import { ContentIcon } from '@features/content/public/content-api';
import {
  getPropertyIconGlyph,
  getPropertyIconOption,
} from '@features/document/public/property-display-api';
import { getNotebookIconOption, NotebookIcon } from './notebook-icon';

/** Render a resolved `flowix_icon`; absent or unknown values use the default note glyph. */
export function NotebookNoteTabIcon({ icon, className }: { icon: string | null; className?: string }) {
  const value = icon?.trim();
  const propertyIcon = value ? getPropertyIconOption(value) : null;
  if (propertyIcon) {
    return <img src={propertyIcon.src} alt="" aria-hidden="true" draggable={false} className={className} />;
  }
  const glyph = value ? getPropertyIconGlyph(value) : null;
  if (glyph) {
    return (
      <span
        aria-hidden="true"
        className={`${className ?? ''} inline-flex items-center justify-center text-[12px] leading-none`}
      >
        {glyph}
      </span>
    );
  }
  const notebookIcon = value ? getNotebookIconOption(value) : null;
  if (notebookIcon) {
    return <NotebookIcon icon={notebookIcon.id} className={className} imageClassName="h-full w-full" disableTitle />;
  }
  return <ContentIcon content={{ kind: 'note' }} className={className} />;
}
