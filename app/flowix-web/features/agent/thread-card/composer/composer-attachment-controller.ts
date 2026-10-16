import { agent } from "@platform/tauri/client";
import type { ComposerInsertionAnchor, ComposerInsertionPoint } from "./composer-insertion-anchor";
import type { ComposerAttachmentDocumentPort } from "./composer-attachment-document";
import type { AgentThreadCardInputAttachment } from "./composer-attachment-types";

export type { AgentThreadCardInputAttachment } from "./composer-attachment-types";

const MAX_COMPOSER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_COMPOSER_ATTACHMENT_COUNT = 5;

export const COMPOSER_ATTACHMENT_ACCEPT = [
  "image/*", ".doc", ".docx", ".pdf", ".xls", ".xlsx", ".ppt", ".pptx",
].join(",");

const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

function isSupportedAttachment(file: File): boolean {
  return Boolean(getAttachmentMimeType(file));
}

function getAttachmentMimeType(file: File): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith("image/") || SUPPORTED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return mimeType;
  }
  const extension = file.name.toLowerCase().split(".").pop();
  const byExtension: Record<string, string> = {
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return (extension && byExtension[extension]) || null;
}

function isImageAttachment(file: { mimeType: string }): boolean {
  return file.mimeType.toLowerCase().startsWith("image/");
}

export interface ComposerAttachmentControllerOptions {
  input: HTMLElement;
  initialAttachments: AgentThreadCardInputAttachment[];
  onChange: (attachments: AgentThreadCardInputAttachment[]) => void;
  onStateChange: () => void;
  onError: (message: string) => void;
  onLimitExceeded: (kind: "count" | "size") => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment"));
    reader.readAsDataURL(file);
  });
}

export class ComposerAttachmentController {
  private attachments: AgentThreadCardInputAttachment[];
  /** Detached tokens stay cached while editor undo/history can restore them. */
  private readonly detachedAttachments = new Map<string, AgentThreadCardInputAttachment>();
  private pending = 0;
  private disposed = false;
  private locked = false;
  private readonly submittedPaths = new Set<string>();
  private insertionAnchor?: ComposerInsertionAnchor;
  private readonly activeAnchors = new Set<ComposerInsertionAnchor>();
  private document?: ComposerAttachmentDocumentPort;

  constructor(private readonly options: ComposerAttachmentControllerOptions) {
    this.attachments = options.initialAttachments.slice(0, MAX_COMPOSER_ATTACHMENT_COUNT);
    options.input.addEventListener("paste", this.handlePaste);
    for (const image of this.attachments) {
      if (isImageAttachment(image)) void this.validateCachedImage(image);
    }
  }

  get readyAttachments(): AgentThreadCardInputAttachment[] {
    return [...this.attachments];
  }

  get hasAttachments(): boolean {
    return this.attachments.length > 0;
  }

  get hasPending(): boolean {
    return this.pending > 0;
  }

  connectDocument(document: ComposerAttachmentDocumentPort): void {
    if (this.disposed) return;
    this.document?.dispose();
    this.document = document;

    // Restore persisted attachments into the editor before tracking removals.
    let position: ComposerInsertionPoint = { from: 1, to: 1 };
    for (const image of this.attachments) {
      position = document.insertAttachmentToken(image, position) ?? position;
    }
    document.setAttachmentTokensChanged((attachments) => this.syncInlineAttachments(attachments));
  }

  captureInsertionAnchor(): void {
    this.cancelInsertionAnchor();
    this.insertionAnchor = this.document?.captureAttachmentInsertionAnchor();
  }

  cancelInsertionAnchor(): void {
    this.insertionAnchor?.dispose();
    this.insertionAnchor = undefined;
  }

  syncInlineAttachments(attachments: readonly AgentThreadCardInputAttachment[]): void {
    if (this.disposed) return;
    const paths = new Set(attachments.map((attachment) => attachment.path));
    for (const image of this.attachments) {
      if (!paths.has(image.path)) this.detachedAttachments.set(image.path, image);
    }
    const nextAttachments = [...new Map(attachments.map((attachment) => [attachment.path, attachment])).values()];
    for (const image of nextAttachments) this.detachedAttachments.delete(image.path);

    const unchanged = nextAttachments.length === this.attachments.length &&
      nextAttachments.every((image, index) => image.path === this.attachments[index]?.path);
    if (unchanged) return;
    this.attachments = nextAttachments;
    this.options.onChange(this.readyAttachments);
    this.options.onStateChange();
  }

  /** Add picker-selected attachments through the same cache path as pasted attachments. */
  addFiles(files: File[]): void {
    if (this.locked || this.disposed) return;
    const eligibleFiles = files.filter((file) => {
      if (!isSupportedAttachment(file)) return false;
      if (file.size <= MAX_COMPOSER_ATTACHMENT_BYTES) return true;
      this.options.onLimitExceeded("size");
      return false;
    });
    const availableSlots = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENT_COUNT - this.attachments.length - this.pending,
    );
    if (eligibleFiles.length > availableSlots) {
      this.options.onLimitExceeded("count");
    }
    const anchor = this.insertionAnchor;
    this.insertionAnchor = undefined;
    const acceptedFiles = eligibleFiles.slice(0, availableSlots);
    this.pending += acceptedFiles.length;
    this.options.onStateChange();
    void this.cacheFilesInOrder(acceptedFiles, anchor);
  }

  clearAfterSubmit(): void {
    this.attachments = [];
    for (const image of this.detachedAttachments.values()) {
      if (!this.submittedPaths.has(image.path)) {
        void agent.deleteCachedAttachment(image.path).catch(() => undefined);
      }
    }
    this.detachedAttachments.clear();
    this.options.onChange([]);
    // Acceptance may leave an edited follow-up draft visible. Rebuild from that document.
    this.document?.setAttachmentTokensChanged((attachments) => this.syncInlineAttachments(attachments));
    this.options.onStateChange();
  }

  /** Keep in-flight request files available until the request is accepted. */
  setLocked(locked: boolean): void {
    if (this.disposed || this.locked === locked) return;
    this.locked = locked;
    this.submittedPaths.clear();
    if (locked) for (const image of this.attachments) this.submittedPaths.add(image.path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.input.removeEventListener("paste", this.handlePaste);
    this.document?.dispose();
    this.document = undefined;
    this.cancelInsertionAnchor();
    for (const anchor of this.activeAnchors) anchor.dispose();
    this.activeAnchors.clear();
    for (const image of this.detachedAttachments.values()) {
      if (!this.submittedPaths.has(image.path)) {
        void agent.deleteCachedAttachment(image.path).catch(() => undefined);
      }
    }
    this.detachedAttachments.clear();
  }

  private readonly handlePaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length === 0) return;

    // Clipboard image payloads often also contain a generated filename as text.
    // Prevent that text from being inserted; genuine text-only paste stays native.
    event.preventDefault();
    this.captureInsertionAnchor();
    this.addFiles(files);
  };

  private async cache(file: File, anchor?: ComposerInsertionAnchor): Promise<void> {
    try {
      const content = await readFileAsDataUrl(file);
      const result = await agent.cacheAttachment(content, getAttachmentMimeType(file) ?? file.type);
      const cached = { ...result, name: file.name };
      if (this.disposed) {
        void agent.deleteCachedAttachment(cached.path).catch(() => undefined);
        return;
      }
      this.attachments = [...this.attachments, cached];
      if (this.document) {
        const nextPosition = this.document.insertAttachmentToken(cached, anchor?.resolve());
        if (nextPosition) anchor?.advance(nextPosition);
      }
      this.options.onChange(this.readyAttachments);
    } catch (error) {
      if (!this.disposed) this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pending = Math.max(0, this.pending - 1);
      if (!this.disposed) this.options.onStateChange();
    }
  }

  private async cacheFilesInOrder(files: File[], anchor?: ComposerInsertionAnchor): Promise<void> {
    if (anchor) this.activeAnchors.add(anchor);
    let processed = 0;
    try {
      for (const file of files) {
        if (this.disposed || this.locked) break;
        await this.cache(file, anchor);
        processed += 1;
      }
    } finally {
      this.pending = Math.max(0, this.pending - (files.length - processed));
      anchor?.dispose();
      if (anchor) this.activeAnchors.delete(anchor);
      if (!this.disposed) this.options.onStateChange();
    }
  }

  private remove(
    image: AgentThreadCardInputAttachment,
    deleteCachedFile: boolean = true,
  ): void {
    if (this.locked && deleteCachedFile) return;
    this.attachments = this.attachments.filter((candidate) => candidate.path !== image.path);
    this.options.onChange(this.readyAttachments);
    this.options.onStateChange();
    if (deleteCachedFile) {
      void agent.deleteCachedAttachment(image.path).catch(() => undefined);
    } else {
      this.document?.removeAttachmentToken(image.path);
    }
  }

  private async validateCachedImage(image: AgentThreadCardInputAttachment): Promise<void> {
    try {
      const content = await agent.readCachedAttachment(image.path);
      if (this.disposed) return;
      if (!this.attachments.some((candidate) => candidate.path === image.path)) return;
      if (!content) {
        this.remove(image, false);
        return;
      }
    } catch (error) {
      if (!this.disposed) {
        this.options.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
