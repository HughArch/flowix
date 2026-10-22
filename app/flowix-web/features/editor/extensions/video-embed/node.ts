import { Node } from '@tiptap/core';
import { normalizeVideoInfo, parseVideoHtml, videoProviders } from './providers';
import { videoEmbedMarkdownSpec } from './markdown';
import { createVideoEmbedView, renderVideoEmbed } from './view';

export const VideoEmbed = Node.create({
  name: 'videoEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      provider: { default: '' },
      videoId: { default: '' },
      sourceUrl: { default: '' },
      ...Object.fromEntries(videoProviders.flatMap(provider => Object.entries(provider.attributes))),
    };
  },
  parseHTML() {
    return [{
      tag: 'div[data-video-embed]',
      getAttrs: element => parseVideoHtml(element) ?? false,
    }];
  },
  renderHTML: ({ node }) => renderVideoEmbed(normalizeVideoInfo(node.attrs)),
  addNodeView: () => createVideoEmbedView,
  ...videoEmbedMarkdownSpec,
});
