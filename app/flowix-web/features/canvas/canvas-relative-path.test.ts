import { describe, expect, it } from 'vitest';
import { notebookRelativeCanvasPath } from './canvas-relative-path';

describe('notebookRelativeCanvasPath', () => {
  it('strips the notebook root and joins with forward slashes', () => {
    expect(notebookRelativeCanvasPath('D:\\notes\\Boards\\Plan.flowix-canvas', 'D:\\notes'))
      .toBe('Boards/Plan.flowix-canvas');
    expect(notebookRelativeCanvasPath('/home/me/notes/Plan.flowix-canvas', '/home/me/notes/'))
      .toBe('Plan.flowix-canvas');
  });

  it('keeps the original casing of the relative part', () => {
    expect(notebookRelativeCanvasPath('/n/Boards/Road Map.flowix-canvas', '/n'))
      .toBe('Boards/Road Map.flowix-canvas');
  });

  it('rejects files outside the notebook root or a sibling with the same prefix', () => {
    expect(notebookRelativeCanvasPath('/other/Plan.flowix-canvas', '/notes')).toBeNull();
    expect(notebookRelativeCanvasPath('/notes-archive/Plan.flowix-canvas', '/notes')).toBeNull();
    expect(notebookRelativeCanvasPath('/notes', '/notes')).toBeNull();
  });
});
