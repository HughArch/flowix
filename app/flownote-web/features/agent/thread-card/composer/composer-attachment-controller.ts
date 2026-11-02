import { agent } from "@platform/tauri/client";
import {
  createComposerAttachmentPreview,
  type ComposerAttachmentPreview,
} from "./composer-attachment-preview";
import { createInlineAtomCloseIcon } from "@features/editor/extensions/shared/inline-atom-nodeview";
import {
  composerAttachmentFileUrl,
  escapeMarkdownLinkLabel,
} from "./composer-attachment-token";
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

/**
 * Composer attachment state. Selected files are cached on the host and
 * rendered as removable chips in a strip above the input (mainstream
 * chat-composer pattern); the text input stays plain text.
 */
export class ComposerAttachmentController {
  private attachments: AgentThreadCardInputAttachment[];
  private pending = 0;
  private disposed = false;
  private locked = false;
  private readonly submittedPaths = new Set<string>();
  private strip?: HTMLElement;
  private readonly chipPreviews = new Map<string, ComposerAttachmentPreview>();

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

  /** Attach the strip that renders the attachment chips above the input. */
  connectStrip(strip: HTMLElement): void {
    if (this.disposed) return;
    this.strip = strip;
    this.renderStrip();
  }

  /**
   * Prompt markdown contributed by document attachments. Images ride the
   * wire as image paths; documents become file links the (text-capable)
   * agent can open, mirroring the legacy inline-token serialization.
   */
  documentPromptLinks(): string {
    return this.attachments
      .filter((attachment) => !isImageAttachment(attachment) && attachment.path)
      .map((attachment) =>
        `[${escapeMarkdownLinkLabel(attachment.name || "Attachment")}](${composerAttachmentFileUrl(attachment.path)})`,
      )
      .join(" ");
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
    const acceptedFiles = eligibleFiles.slice(0, availableSlots);
    this.pending += acceptedFiles.length;
    this.options.onStateChange();
    void this.cacheFilesInOrder(acceptedFiles);
  }

  /** Chip remove button; a locked (in-flight) submission pins its files. */
  removeAttachment(path: string): void {
    this.removeByPath(path, true);
  }

  clearAfterSubmit(): void {
    this.deleteUnsubmittedAttachments();
    this.attachments = [];
    this.renderStrip();
    this.options.onChange([]);
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
    for (const preview of this.chipPreviews.values()) preview.destroy();
    this.chipPreviews.clear();
    this.strip = undefined;
    this.deleteUnsubmittedAttachments();
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
    this.addFiles(files);
  };

  private async cache(file: File): Promise<void> {
    try {
      const content = await readFileAsDataUrl(file);
      const result = await agent.cacheAttachment(content, getAttachmentMimeType(file) ?? file.type);
      const cached = { ...result, name: file.name };
      if (this.disposed) {
        void agent.deleteCachedAttachment(cached.path).catch(() => undefined);
        return;
      }
      this.attachments = [...this.attachments, cached];
      this.renderStrip();
      this.options.onChange(this.readyAttachments);
    } catch (error) {
      if (!this.disposed) this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pending = Math.max(0, this.pending - 1);
      if (!this.disposed) this.options.onStateChange();
    }
  }

  private async cacheFilesInOrder(files: File[]): Promise<void> {
    let processed = 0;
    try {
      for (const file of files) {
        if (this.disposed || this.locked) break;
        await this.cache(file);
        processed += 1;
      }
    } finally {
      this.pending = Math.max(0, this.pending - (files.length - processed));
      if (!this.disposed) this.options.onStateChange();
    }
  }

  private removeByPath(path: string, deleteCachedFile: boolean): void {
    const attachment = this.attachments.find((candidate) => candidate.path === path);
    if (!attachment) return;
    if (this.locked && deleteCachedFile) return;
    this.attachments = this.attachments.filter((candidate) => candidate.path !== path);
    this.destroyChipPreview(path);
    this.renderStrip();
    this.options.onChange(this.readyAttachments);
    this.options.onStateChange();
    if (deleteCachedFile) {
      void agent.deleteCachedAttachment(path).catch(() => undefined);
    }
  }

  /** Delete cache files that are not part of an accepted submission. */
  private deleteUnsubmittedAttachments(): void {
    for (const image of this.attachments) {
      if (!this.submittedPaths.has(image.path)) {
        void agent.deleteCachedAttachment(image.path).catch(() => undefined);
      }
    }
  }

  private async validateCachedImage(image: AgentThreadCardInputAttachment): Promise<void> {
    try {
      const content = await agent.readCachedAttachment(image.path);
      if (this.disposed) return;
      if (!this.attachments.some((candidate) => candidate.path === image.path)) return;
      if (!content) {
        this.removeByPath(image.path, false);
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

  private renderStrip(): void {
    const strip = this.strip;
    if (!strip) return;
    for (const preview of this.chipPreviews.values()) preview.destroy();
    this.chipPreviews.clear();
    strip.replaceChildren();
    for (const attachment of this.attachments) {
      strip.append(this.createChip(attachment));
    }
    strip.hidden = this.attachments.length === 0;
    const composer = strip.closest(".agent-composer");
    composer?.classList.toggle(
      "agent-composer--has-attachments",
      this.attachments.length > 0,
    );
  }

  private createChip(attachment: AgentThreadCardInputAttachment): HTMLDivElement {
    const chip = document.createElement("div");
    chip.className = "agent-composer__attachment-chip";
    chip.title = attachment.name;

    const preview = createComposerAttachmentPreview(
      attachment.path,
      attachment.name,
      attachment.mimeType,
      chip,
    );
    this.chipPreviews.set(attachment.path, preview);
    chip.addEventListener("click", () => preview.onClick());

    const label = document.createElement("span");
    label.className = "agent-composer__attachment-chip-label";
    label.textContent = attachment.name;
    label.title = attachment.name;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "agent-composer__attachment-chip-remove";
    removeButton.setAttribute("aria-label", `移除附件 ${attachment.name}`);
    removeButton.append(createInlineAtomCloseIcon());
    removeButton.addEventListener("click", (event) => {
      // Chip-level click opens the preview popover; removal must not.
      event.stopPropagation();
      this.removeAttachment(attachment.path);
    });

    chip.append(preview.element, label, removeButton);
    return chip;
  }

  private destroyChipPreview(path: string): void {
    this.chipPreviews.get(path)?.destroy();
    this.chipPreviews.delete(path);
  }
}
