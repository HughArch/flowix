/**
 * Persisted attachment names retained for old Thread Card drafts and HTML.
 * Keep these aliases at the serialization boundary; editor code uses
 * attachment terminology throughout.
 */
export const COMPOSER_ATTACHMENT_NODE_NAME = "composerAttachmentToken";

export const COMPOSER_ATTACHMENT_HTML_ATTRIBUTE = "data-composer-attachment";
export const LEGACY_COMPOSER_IMAGE_HTML_ATTRIBUTE = "data-composer-image";

export const THREAD_CARD_ATTACHMENTS_ATTRIBUTE = "inputAttachments";
export const LEGACY_THREAD_CARD_IMAGES_ATTRIBUTE = "inputImages";
export const THREAD_CARD_ATTACHMENTS_HTML_ATTRIBUTE = "data-input-attachments";
export const LEGACY_THREAD_CARD_IMAGES_HTML_ATTRIBUTE = "data-input-images";
