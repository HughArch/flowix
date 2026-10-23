import { DocumentTitlebar } from './document-titlebar';
import type { DocumentTitlebarProps } from './document-titlebar-model';

export function DocumentTitlebarMac(props: DocumentTitlebarProps) {
  return <DocumentTitlebar {...props} platform="mac" />;
}
