/** Field IDs deliberately use the table contract's existing prefix. */
export function createPropertyId(): string {
  return `fld_${crypto.randomUUID().replace(/-/g, '')}`;
}
export function createPropertyOptionId(): string {
  return `opt_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Stable legacy IDs make migration independent of window/device load order. */
export function legacyPropertyId(key: string): string {
  const text = key.trim().toLowerCase();
  const words = [2166136261, 2246822507, 3266489909, 668265263];
  for (const char of text) for (let i = 0; i < words.length; i++) words[i] = Math.imul(words[i] ^ char.charCodeAt(0), 16777619 + i * 2) >>> 0;
  return `fld_${words.map((word) => word.toString(16).padStart(8, '0')).join('')}`;
}
