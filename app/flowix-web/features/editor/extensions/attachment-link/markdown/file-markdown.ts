import { Extension, type JSONContent, type MarkdownToken } from '@tiptap/core';
import { assetMarkdownUrl, decodeStorageKey } from './asset-markdown';
import { readMarkdownLinkDestination } from '@features/editor/extensions/shared/markdown-link-destination';

export function isAttachmentMarkdownUrl(url: string): boolean {
    return /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(url);
}

export function parseFileAttachmentMarkdown(token: MarkdownToken) {
    const url = typeof token.url === 'string' ? token.url : '';
    const title = typeof token.title === 'string' ? token.title : null;

    return {
        type: 'fileAttachment',
        attrs: {
            url,
            name: title ?? null,
            mimeType: null,
            size: 0,
            storageMode: 'attachment',
            storageKey: decodeStorageKey(url),
        },
    };
}

export function renderFileAttachmentMarkdown(node: JSONContent) {
    const { storageMode, storageKey, url, name } = node.attrs ?? {};
    const fileUrl = storageMode === 'attachment' && storageKey
        ? assetMarkdownUrl(String(storageKey))
        : url ?? '';
    return `[${name ?? ''}](${fileUrl})`;
}

export const fileAttachmentMarkdownSpec = {
    markdownTokenizer: {
        name: 'fileAttachment',
        level: 'inline' as const,
        start(src: string) {
            const assetLink = /\[[^\]]*\]\((?:asset:\/\/|https?:\/\/asset\.localhost\/)/.exec(src);
            return assetLink?.index ?? -1;
        },
        tokenize(src: string) {
            const closeBracket = src.indexOf(']');
            if (!src.startsWith('[') || closeBracket === -1 || src[closeBracket + 1] !== '(') return undefined;
            const destination = readMarkdownLinkDestination(src, closeBracket + 1);
            if (!destination || !isAttachmentMarkdownUrl(destination.url)) return undefined;
            return {
                type: 'fileAttachment',
                raw: src.slice(0, destination.end + 1),
                url: destination.url,
                title: src.slice(1, closeBracket),
            };
        },
    },
    parseMarkdown: parseFileAttachmentMarkdown,
};

export const FileAttachmentMarkdownExtension = Extension.create({
    name: 'fileAttachment',
    ...fileAttachmentMarkdownSpec,
});
