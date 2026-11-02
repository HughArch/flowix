import { DocumentTitlebar } from './document-titlebar';
import type { DocumentTitlebarProps } from './document-titlebar-model';

export function DocumentTitlebarWin(props: DocumentTitlebarProps) {
  return <DocumentTitlebar {...props} platform="windows" />;
}
