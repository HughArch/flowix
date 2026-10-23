import { translate, type I18nKey, type I18nParams } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import {
  FrontmatterPropertyError,
  updateVisibleFrontmatterProperty,
} from '@features/document/properties/frontmatter-model';
import { resolvePropertyPreset } from '@features/document/properties/presets';
import type { PropertyKind } from '@/lib/property-types';
import { getPropertyPresets } from '@features/properties/public-api';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Single source of truth for surfacing frontmatter validation failures. */
export function describeFrontmatterPropertyError(error: unknown, t: Translate): string {
  if (!(error instanceof FrontmatterPropertyError)) {
    return error instanceof Error ? error.message : String(error);
  }
  switch (error.code) {
    case 'empty-key':
      return t('document.properties.emptyKey');
    case 'duplicate-key':
      return t('document.properties.duplicateKey');
    case 'reserved-key':
      return t('document.properties.picker.reservedKeyError', { key: 'flowix_property_types' });
    case 'invalid-tag':
      return t('document.properties.invalidTag');
    case 'invalid-color':
      return t('document.properties.invalidColor');
    default:
      return error.message;
  }
}

interface DraftPropertyCommit {
  /** YAML the draft is appended to. Empty string when the note has no frontmatter yet. */
  yamlContent: string;
  key: string;
  value: string;
  kind?: PropertyKind;
  storageKind?: PropertyKind;
  /** Receives the next YAML. The caller owns how it reaches the document. */
  apply: (nextYamlContent: string) => void;
  onError?: (message: string) => void;
}

/**
 * Commit a property typed directly into the empty row.
 *
 * The row itself never touches the document; only this commit does. The kind is
 * resolved from the matching preset so typing `tags` produces a tag list, just
 * like picking the preset from the picker.
 */
export function commitFrontmatterDraft(commit: DraftPropertyCommit): boolean {
  if (!commit.key.trim()) return false;
  const language = getCurrentAppLanguage();
  const t: Translate = (key, params) => translate(language, key, params);
  const preset = resolvePropertyPreset(commit.key, getPropertyPresets());
  try {
    commit.apply(updateVisibleFrontmatterProperty(
      commit.yamlContent,
      null,
      commit.key,
      commit.value,
      preset?.kind ?? commit.storageKind ?? commit.kind ?? 'Text',
      preset?.kind ?? commit.kind ?? 'Text',
    ));
    return true;
  } catch (error) {
    const message = describeFrontmatterPropertyError(error, t);
    commit.onError?.(message);
    toast.error(message);
    return false;
  }
}
