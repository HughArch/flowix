import { describe, expect, it } from 'vitest';

import type { PropertyFieldConfig } from '@/lib/constants';
import {
  getAllPresets,
  getCustomPresets,
  CUSTOM_PROPERTY_KINDS,
  isBuiltinPresetKey,
  moveNameAndDescriptionPresetsToEnd,
  PROPERTY_KINDS,
  resolvePropertyPreset,
} from './presets';
import { resolvePropertyType } from './property-type';

const label = (key: string) => key;
const choices = (labels: string[]) => labels.map((label, index) => ({ label, id: 'opt_' + String(index).padStart(32, '0') }));

describe('property preset runtime model', () => {
  const fields: PropertyFieldConfig[] = [
    { key: 'priority', type: 'Select', options: choices(['高', '低']) },
    { key: 'labels', type: 'MultiSelect', options: choices(['前端', '后端']) },
    { key: 'archived', type: 'Boolean' },
  ];

  it('exposes custom presets with the same shape as built-ins', () => {
    expect(getCustomPresets(fields)).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'priority',
        label: 'priority',
        kind: 'Select',
        options: ['高', '低'],
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'labels',
        label: 'labels',
        kind: 'MultiSelect',
        options: ['前端', '后端'],
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'archived',
        label: 'archived',
        kind: 'Boolean',
        options: undefined,
      },
    ]);
    expect(getAllPresets(fields, label).find((preset) => preset.key === 'priority'))
      .toMatchObject({ source: 'custom', label: 'priority', kind: 'Select' });
  });

  it('keeps built-in keys authoritative over conflicting custom settings', () => {
    expect(isBuiltinPresetKey('NAME')).toBe(true);
    expect(isBuiltinPresetKey('tag')).toBe(true);
    expect(getCustomPresets([
      { key: 'name', type: 'Text' },
      { key: 'TAG', type: 'Text' },
      { key: 'Priority', type: 'Number' },
      { key: 'priority', type: 'Text' },
    ])).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'Priority',
        label: 'Priority',
        kind: 'Number',
        options: undefined,
      },
    ]);
    expect(resolvePropertyPreset('name', [
      { key: 'name', type: 'Number' },
    ], label)).toMatchObject({ source: 'builtin', key: 'name' });
  });

  it('moves Name and Description to the end while preserving other preset order', () => {
    const options = [
      { value: 'name' },
      { value: 'tags' },
      { value: 'description' },
      { value: 'flowix_colors' },
      { value: 'status' },
    ];

    expect(moveNameAndDescriptionPresetsToEnd(options, (option) => option.value).map((option) => option.value))
      .toEqual(['tags', 'flowix_colors', 'status', 'name', 'description']);
    expect(options.map((option) => option.value))
      .toEqual(['name', 'tags', 'description', 'flowix_colors', 'status']);
  });

  it('uses the shared resolver for preset-bound note properties', () => {
    expect(resolvePropertyType('priority', '高', false, fields).kind).toBe('Select');
    expect(resolvePropertyType('labels', ['前端'], false, fields).kind).toBe('MultiSelect');
    expect(resolvePropertyType('archived', true, false, fields).kind).toBe('Boolean');
  });

  it('exposes URL as a system preset type, not a user custom type', () => {
    expect(PROPERTY_KINDS).toContain('URL');
    expect(PROPERTY_KINDS).toEqual([
      'Text', 'Boolean', 'Number', 'Date',
      'URL', 'Select', 'MultiSelect', 'Tag', 'Color', 'Icon', 'Image',
    ]);
    expect(CUSTOM_PROPERTY_KINDS).toEqual(['Text', 'Boolean', 'Number', 'Date', 'Tag']);
    expect(getAllPresets([], label).map((preset) => [preset.key, preset.kind])).toContainEqual(['tags', 'Tag']);
    expect(getAllPresets([], label).map((preset) => [preset.key, preset.kind])).toContainEqual(['flowix_colors', 'Color']);
  });

  it('ignores options for semantic tag and color presets', () => {
    expect(getCustomPresets([
      { key: 'topics', type: 'Tag', options: choices(['旧选项']) },
      { key: 'keywords', type: 'Tag', options: choices(['旧选项']) },
      { key: 'accent', type: 'Color', options: choices(['blue']) },
    ])).toEqual([
      {
        source: 'custom',
        category: 'custom',
        key: 'topics',
        label: 'topics',
        kind: 'Tag',
        options: undefined,
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'keywords',
        label: 'keywords',
        kind: 'Tag',
        options: undefined,
      },
      {
        source: 'custom',
        category: 'custom',
        key: 'accent',
        label: 'accent',
        kind: 'Color',
        options: undefined,
      },
    ]);
  });
});
