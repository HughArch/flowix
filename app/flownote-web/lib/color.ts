/** Stable hue for a label, independent of render order and session. */
export function stableTextHue(label: string): number {
  let hash = 2166136261;
  const normalized = label.normalize('NFKC').trim().toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}
