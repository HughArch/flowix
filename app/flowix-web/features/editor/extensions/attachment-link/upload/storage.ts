import { notebookAssets } from '@platform/tauri/client';
import { acquireUploadSlot, readFileBase64 } from './io';
import { reportUploadFailure } from './feedback';
import { uploadInChunks } from './chunked';
import type { StoredAsset } from '@features/editor/extensions/attachment-link/upload/file-source';
import { assetUrl, safeFileName } from '@features/editor/extensions/attachment-link/utils';
import { fileNameFromPath, getFileKind, getFileKindFromName, mimeTypeFromName } from '@features/editor/extensions/attachment-link/upload/file-source';

export type AttachmentContentSaver = (params: { content: string; fileName: string }) => Promise<string | null>;
export type AttachmentFileSaver = (params: { file: File; fileName: string }) => Promise<string | null>;

export const MAX_ATTACHMENT_CONTENT_BYTES = 64 * 1024 * 1024;

export type AttachmentPathUploadOptions = {
    ownerPath?: string;
    notebookId?: string;
    signal?: AbortSignal;
    deduplicate?: boolean;
};

export async function createAttachmentUpload(
    files: File[],
    saveContent?: AttachmentContentSaver,
    saveFile?: AttachmentFileSaver,
    ownerPath?: string,
    signal?: AbortSignal,
    deduplicate = true,
): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!ownerPath && !saveContent && !saveFile) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const file of files) {
        if (signal?.aborted) break;
        const kind = getFileKind(file);
        const fileName = safeFileName(file.name);

        // `storageKey` is what note content persists: notebook-relative so the
        // same note resolves on every device. `localPath` only backs the
        // immediate preview URL.
        let storageKey: string | null = null;
        let localPath: string | null = null;
        let created = true;
        let release: (() => void) | undefined;
        try {
            release = acquireUploadSlot();
            if (saveFile) {
                storageKey = await saveFile({ file, fileName });
                localPath = storageKey;
            } else {
                if (file.size > MAX_ATTACHMENT_CONTENT_BYTES) {
                    throw new Error('ATTACHMENT_CONTENT_TOO_LARGE');
                }
                if (saveContent) {
                    const base64Content = await readFileBase64(file, signal);
                    if (signal?.aborted) break;
                    storageKey = await saveContent({ content: base64Content, fileName });
                    localPath = storageKey;
                } else {
                    const saved = await uploadInChunks(file, fileName, ownerPath!, signal, deduplicate);
                    storageKey = saved.key || saved.path;
                    localPath = saved.path;
                    created = saved.created;
                }
            }
            if (!storageKey) throw new Error('Attachment save returned no path');
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
            if (!signal?.aborted) reportUploadFailure(err);
        } finally {
            release?.();
        }

        if (!storageKey) continue;

        assets.push({
            kind,
            url: assetUrl(localPath ?? storageKey),
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            fileName,
            storageMode: 'attachment',
            storageKey,
            created,
            revokeObjectURL: false,
        });
    }

    return { assets };
}

export async function createAttachmentUploadFromPaths(
    paths: string[],
    { ownerPath, notebookId, signal, deduplicate = true }: AttachmentPathUploadOptions = {},
): Promise<{ assets: StoredAsset[] }> {
    const assets: StoredAsset[] = [];
    if (!ownerPath && !notebookId) {
        reportUploadFailure('OWNER_REQUIRED');
        return { assets };
    }

    for (const path of paths) {
        if (signal?.aborted) break;
        const name = fileNameFromPath(path);
        const fileName = safeFileName(name);
        let storageKey: string | null = null;
        let localPath: string | null = null;
        let created = true;
        let release: (() => void) | undefined;

        try {
            release = acquireUploadSlot();
            const saved = await notebookAssets.saveFromPath(path, {
                ...(notebookId ? { notebookId } : { notePath: ownerPath }),
                deduplicate,
                // Note attachments always live in attachments/, even when the
                // selected source is already somewhere else in the notebook.
                reuseNotebookFile: false,
            });
            if (!saved?.path) throw new Error('Attachment save returned no path');
            storageKey = saved.key || saved.path;
            localPath = saved.path;
            created = saved.created;
        } catch (err) {
            console.error('[FileUpload] Failed to save attachment:', err);
            if (!signal?.aborted) reportUploadFailure(err);
        } finally {
            release?.();
        }

        if (!storageKey) continue;

        assets.push({
            kind: getFileKindFromName(name),
            url: assetUrl(localPath ?? storageKey),
            name,
            mimeType: mimeTypeFromName(name),
            size: 0,
            fileName,
            storageMode: 'attachment',
            storageKey,
            created,
        });
    }

    return { assets };
}
