import { describe, expect, it } from 'vitest';
import {
  FileCodeIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';

import { getFileIcon } from '@features/memo/components/file-type-icon';

describe('getFileIcon', () => {
  it.each([
    ['README.MD', FileMdIcon],
    ['index.html', FileHtmlIcon],
    ['app.tsx', FileCodeIcon],
    ['photo.JPEG', FileImageIcon],
    ['report.docx', FileDocIcon],
    ['slides.pptx', FilePptIcon],
    ['recording.mp4', FileVideoIcon],
    ['archive.zip', FileZipIcon],
    ['budget.xlsx', FileXlsIcon],
    ['manual.pdf', FilePdfIcon],
  ])('maps %s to its file icon', (filename, expectedIcon) => {
    expect(getFileIcon(filename)).toBe(expectedIcon);
  });

  it('uses a generic file icon for unknown extensions', () => {
    // 图标语言统一（content-icon 分类，03fa4900）：无扩展名与未知扩展名
    // 都归入 generic 文本图标，无扩展名文本文件不再特判为代码图标。
    expect(getFileIcon('LICENSE')).toBe(FileTextIcon);
    expect(getFileIcon('data.bin')).toBe(FileTextIcon);
  });
});
