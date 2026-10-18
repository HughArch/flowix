import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agent } from "@platform/tauri/client";
import { NotebookTreeResourceIcon } from "@features/memo/public/file-icon-api";

const IMAGE_MIME_RE = /^image\//i;

export interface ComposerAttachmentPreview {
  element: Element;
  onClick: () => void;
  destroy: () => void;
}

/** Owns attachment thumbnail loading and the portaled click preview lifecycle. */
export function createComposerAttachmentPreview(
  path: string,
  name: string,
  mimeType: string,
  anchor: HTMLElement,
): ComposerAttachmentPreview {
  if (!IMAGE_MIME_RE.test(mimeType)) {
    const template = document.createElement("template");
    template.innerHTML = renderToStaticMarkup(createElement(NotebookTreeResourceIcon, {
      path: name,
      className: "agent-composer__attachment-token-icon",
    }));
    const fileIcon = template.content.firstElementChild as SVGSVGElement;
    return {
      element: fileIcon,
      onClick: () => undefined,
      destroy: () => undefined,
    };
  }

  const imagePreview = document.createElement("img");
  imagePreview.className = "agent-composer__attachment-token-preview";
  imagePreview.alt = "";
  imagePreview.draggable = false;

  let imageDataUrl: string | undefined;
  let popover: HTMLDivElement | undefined;
  let popoverImage: HTMLImageElement | undefined;
  let popoverOpen = false;
  let destroyed = false;

  const positionPopover = (): void => {
    if (!popoverOpen || !popover?.isConnected) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const width = popoverRect.width || 272;
    const height = popoverRect.height || 120;
    const padding = 8;
    const left = Math.min(
      Math.max(anchorRect.left + (anchorRect.width - width) / 2, padding),
      Math.max(padding, window.innerWidth - width - padding),
    );
    const top = Math.max(padding, anchorRect.top - height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };

  const handleViewportChange = (): void => positionPopover();
  function closePopover(): void {
    popoverOpen = false;
    if (popover) popover.hidden = true;
    anchor.setAttribute("aria-expanded", "false");
    window.removeEventListener("resize", handleViewportChange);
    window.removeEventListener("scroll", handleViewportChange, true);
    document.removeEventListener("pointerdown", handleOutsidePointer, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  }
  function openPopover(): void {
    if (destroyed) return;
    if (!popover) {
      popover = document.createElement("div");
      popover.className = "agent-composer__image-preview-popover";
      popover.hidden = true;
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", `图片预览：${name}`);
      popoverImage = document.createElement("img");
      popoverImage.alt = name;
      popoverImage.draggable = false;
      popoverImage.addEventListener("load", () => {
        if (popoverOpen) positionPopover();
      });
      popover.append(popoverImage);
      document.body.append(popover);
    }
    if (imageDataUrl && popoverImage && popoverImage.src !== imageDataUrl) {
      popoverImage.src = imageDataUrl;
    }
    popoverOpen = true;
    anchor.setAttribute("aria-expanded", "true");
    popover.hidden = !imageDataUrl;
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleKeyDown, true);
    if (imageDataUrl) positionPopover();
  }

  function handleOutsidePointer(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && (anchor.contains(target) || popover?.contains(target))) return;
    closePopover();
  }
  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !popoverOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closePopover();
  }
  const togglePopover = (): void => {
    if (popoverOpen) closePopover();
    else openPopover();
  };

  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "false");

  void agent.readCachedAttachment(path)
    .then((dataUrl) => {
      if (destroyed || !dataUrl) return;
      imageDataUrl = dataUrl;
      imagePreview.src = dataUrl;
      if (popoverImage) popoverImage.src = dataUrl;
      if (popoverOpen && popover) popover.hidden = false;
      if (popoverOpen) positionPopover();
    })
    .catch(() => undefined);

  return {
    element: imagePreview,
    onClick: togglePopover,
    destroy: () => {
      destroyed = true;
      closePopover();
      popover?.remove();
      popover = undefined;
      popoverImage = undefined;
    },
  };
}
