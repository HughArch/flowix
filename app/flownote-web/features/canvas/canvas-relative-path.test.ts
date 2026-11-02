import { describe, expect, it } from 'vitest';
import { notebookRelativeCanvasPath } from './canvas-relative-path';

describe('notebookRelativeCanvasPath', () => {
  it('strips the notebook root and joins with forward slashes', () => {
    expect(notebookRelativeCanvasPath('D:\\notes\\Boards\\Plan.fanvas', 'D:\\notes'))
      .toBe('Boards/Plan.fanvas');
    expect(notebookRelativeCanvasPath('/home/me/notes/Plan.fanvas', '/home/me/notes/'))
      .toBe('Plan.fanvas');
  });

  it('keeps the original casing of the relative part', () => {
    expect(notebookRelativeCanvasPath('/n/Boards/Road Map.fanvas', '/n'))
      .toBe('Boards/Road Map.fanvas');
  });

  it('rejects files outside the notebook root or a sibling with the same prefix', () => {
    expect(notebookRelativeCanvasPath('/other/Plan.fanvas', '/notes')).toBeNull();
    expect(notebookRelativeCanvasPath('/notes-archive/Plan.fanvas', '/notes')).toBeNull();
    expect(notebookRelativeCanvasPath('/notes', '/notes')).toBeNull();
  });
});
