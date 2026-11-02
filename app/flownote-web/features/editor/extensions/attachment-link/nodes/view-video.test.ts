import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoAttachment } from './view-video';

describe('VideoAttachment NodeView', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects the video and restores editor focus after the native click', () => {
    vi.useFakeTimers();
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);

    const editor = new Editor({
      element: host,
      extensions: [StarterKit, VideoAttachment],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph' },
          {
            type: 'videoAttachment',
            attrs: { src: 'https://example.com/video.mp4' },
          },
        ],
      },
    });

    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    video!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.view.hasFocus()).toBe(false);

    vi.runAllTimers();

    expect(editor.view.hasFocus()).toBe(true);

    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    video!.currentTime = 50;
    video!.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'MediaTrackNext',
    }));
    expect(video!.currentTime).toBe(60);

    video!.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'MediaTrackPrevious',
    }));
    expect(video!.currentTime).toBe(50);

    editor.destroy();
    host.remove();
    load.mockRestore();
  });

  it('does not steal focus from an already selected video', () => {
    vi.useFakeTimers();
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);

    const editor = new Editor({
      element: host,
      extensions: [StarterKit, VideoAttachment],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph' },
          {
            type: 'videoAttachment',
            attrs: { src: 'https://example.com/video.mp4' },
          },
        ],
      },
    });

    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    video!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    video!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    vi.runAllTimers();

    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.view.hasFocus()).toBe(false);

    editor.destroy();
    host.remove();
    load.mockRestore();
  });
});
