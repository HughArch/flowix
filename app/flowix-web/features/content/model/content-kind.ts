/** Factual content categories shared by surfaces that display resources. */
export type FileContentKind =
  | 'note'
  | 'image'
  | 'video'
  | 'pdf'
  | 'html'
  | 'code'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'archive'
  | 'text'
  | 'unknown';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif']);
const VIDEO_EXTENSIONS = new Set(['3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'webm', 'wmv']);
const HTML_EXTENSIONS = new Set(['htm', 'html', 'xhtml']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docm', 'docx', 'dot', 'dotx', 'odt', 'rtf']);
const PRESENTATION_EXTENSIONS = new Set(['key', 'odp', 'pot', 'potx', 'ppt', 'pptm', 'pptx']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsb', 'xlsm', 'xlsx', 'xlt', 'xltx']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz', 'bz2', 'cab', 'gz', 'iso', 'lz', 'lzma', 'rar', 'tar', 'tgz', 'xz', 'zip', 'zst']);

// The desktop reader validates editability independently; these lists describe UI content categories.
const CODE_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'vue', 'svelte', 'py', 'pyw', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh',
  'hpp', 'hxx', 'cs', 'swift', 'php', 'rb', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'lua',
  'r', 'dart', 'scala', 'ex', 'exs', 'erl', 'hrl', 'fs', 'fsx', 'vb', 'pl', 'pm', 'proto', 'ini', 'conf',
  'cfg', 'properties', 'gradle',
]);
const PLAIN_TEXT_EXTENSIONS = new Set(['txt', 'text', 'log']);
const CODE_FILENAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'procfile', 'justfile', 'rakefile',
  '.gitattributes', '.gitignore', '.dockerignore', '.editorconfig', '.npmrc', '.nvmrc',
  '.prettierrc', '.eslintrc',
]);
const TEXT_FILENAMES = new Set(['license', 'licence']);
const CODE_FILENAME_PREFIXES = ['dockerfile.', 'containerfile.', 'makefile.'];

const TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/javascript',
  'application/x-javascript', 'application/x-yaml', 'application/toml', 'application/sql', 'application/graphql',
]);

export function fileExtension(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? path;
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

export function normalizeMimeType(mimeType?: string | null): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function isTextMimeType(mimeType?: string | null): boolean {
  const mime = normalizeMimeType(mimeType);
  return !!mime && (mime.startsWith('text/') || TEXT_APPLICATION_MIME_TYPES.has(mime));
}

export function isMarkdownFilePath(path: string): boolean { return MARKDOWN_EXTENSIONS.has(fileExtension(path)); }
export function isCodeTextFilePath(path: string): boolean {
  return (isCodeFileName(path) || CODE_EXTENSIONS.has(fileExtension(path))) && !isMarkdownFilePath(path);
}

function isCodeFileName(path: string): boolean {
  const filename = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  return CODE_FILENAMES.has(filename) || CODE_FILENAME_PREFIXES.some((prefix) => filename.startsWith(prefix));
}
export function isImageFilePath(path: string): boolean { return IMAGE_EXTENSIONS.has(fileExtension(path)); }
export function isVideoFilePath(path: string): boolean { return VIDEO_EXTENSIONS.has(fileExtension(path)); }
// Preserve the renderer's established HTML extension set; XHTML still gets the factual HTML icon.
export function isHtmlFilePath(path: string): boolean { return ['htm', 'html'].includes(fileExtension(path)); }

export function classifyFileContent(path: string, mimeType?: string | null): FileContentKind {
  const filename = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const extension = fileExtension(path);
  const mime = normalizeMimeType(mimeType);
  if (MARKDOWN_EXTENSIONS.has(extension) || mime === 'text/markdown' || mime === 'application/markdown' || mime === 'text/x-markdown') return 'note';
  if (IMAGE_EXTENSIONS.has(extension) || mime.startsWith('image/')) return 'image';
  if (VIDEO_EXTENSIONS.has(extension) || mime.startsWith('video/')) return 'video';
  if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (HTML_EXTENSIONS.has(extension) || mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (DOCUMENT_EXTENSIONS.has(extension) || mime.includes('wordprocessingml') || mime === 'application/msword' || mime === 'application/rtf') return 'document';
  if (PRESENTATION_EXTENSIONS.has(extension) || mime.includes('presentation') || mime === 'application/vnd.ms-powerpoint') return 'presentation';
  if (SPREADSHEET_EXTENSIONS.has(extension) || mime.includes('spreadsheet') || mime === 'application/vnd.ms-excel') return 'spreadsheet';
  if (ARCHIVE_EXTENSIONS.has(extension) || /(?:zip|compressed|x-7z|x-rar|x-tar)/.test(mime)) return 'archive';
  if (TEXT_FILENAMES.has(filename) || PLAIN_TEXT_EXTENSIONS.has(extension)) return 'text';
  if (isCodeFileName(path) || CODE_EXTENSIONS.has(extension) || TEXT_APPLICATION_MIME_TYPES.has(mime)) return 'code';
  if (isTextMimeType(mimeType)) return 'text';
  return 'unknown';
}

export function isEditableTextFilePath(path: string, mimeType?: string | null): boolean {
  const filename = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  return isMarkdownFilePath(path)
    || isCodeTextFilePath(path)
    || TEXT_FILENAMES.has(filename)
    || PLAIN_TEXT_EXTENSIONS.has(fileExtension(path))
    || isTextMimeType(mimeType);
}

export type ResourceKind = 'note' | 'image' | 'video' | 'other';

/** Legacy workspace resource classification. MIME helps classify resources without a useful extension. */
export function resourceKindFromPath(path: string, mimeType?: string | null): ResourceKind {
  const kind = classifyFileContent(path, mimeType);
  if (kind === 'note') return 'note';
  if (kind === 'image' || kind === 'video') return kind;
  return 'other';
}

export function isNotebookResourcePath(path: string): boolean {
  const kind = resourceKindFromPath(path);
  return kind === 'note' || kind === 'image' || kind === 'video';
}
