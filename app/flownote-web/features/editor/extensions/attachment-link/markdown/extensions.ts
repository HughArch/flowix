import { FileAttachmentMarkdownExtension } from './file-markdown';
import { ImageMarkdownExtension } from './image-markdown';
import { VideoMarkdownExtension } from './video-markdown';

/** Parser-only attachment extensions. They deliberately have no NodeViews, commands, or Tauri imports. */
export const AttachmentMarkdownExtensions = [
  ImageMarkdownExtension,
  VideoMarkdownExtension,
  FileAttachmentMarkdownExtension,
];
