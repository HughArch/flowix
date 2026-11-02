import { beforeEach, describe, expect, it, vi } from 'vitest';

const readNotebookAgentSkills = vi.fn();
vi.mock('@platform/tauri/client/agent', () => ({
  agent: {
    readNotebookAgentSkills: (...args: unknown[]) => readNotebookAgentSkills(...args),
  },
}));

vi.mock('@features/memo/store/note-store', () => ({
  useNoteStore: {
    getState: () => ({
      notebooks: [
        { id: 'nb-1', path: 'C:\\vault\\知识库' },
      ],
      selectedNotebook: { id: 'nb-2', path: 'C:\\vault\\选中的库' },
    }),
  },
}));

import {
  buildFlownoteSkillContext,
  FLOWNOTE_SKILL_BODY_CHAR_LIMIT,
  FLOWNOTE_SKILL_TOTAL_CHAR_LIMIT,
  listFlownoteSkills,
  resolveFlownoteNotebookPath,
} from './flownote-skill-service';

function skillFile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'demo',
    name: '演示技能',
    commandName: 'demo',
    description: '一个演示技能',
    enabled: true,
    body: '逐步执行演示流程。',
    path: '.agents/skills/demo/SKILL.md',
    frontmatter: {},
    ...overrides,
  };
}

beforeEach(() => {
  readNotebookAgentSkills.mockReset();
});

describe('listFlownoteSkills', () => {
  it('filters and maps notebook skills, keeping blank descriptions with a name fallback', async () => {
    readNotebookAgentSkills.mockResolvedValue([
      skillFile(),
      skillFile({ id: 'off', commandName: 'off', name: '关', enabled: false }),
      skillFile({ id: 'nod', commandName: 'nod', name: '无描述', description: '  ' }),
      // Nested folders still end with /SKILL.md and stay eligible, matching
      // the desktop filter.
      skillFile({ id: 'nested', commandName: 'nested', name: '嵌套', path: '.agents/skills/nested/extra/SKILL.md' }),
      skillFile({ id: 'Bad Name', commandName: 'Bad Name', name: '坏名字' }),
    ]);
    expect(await listFlownoteSkills('C:\\vault')).toEqual([
      {
        name: 'demo',
        description: '一个演示技能',
        displayName: '演示技能',
        scope: 'workspace',
      },
      // Flownote chips are picked manually, so a blank description only leaves
      // the menu caption empty; the skill itself stays selectable.
      {
        name: 'nod',
        description: '',
        displayName: '无描述',
        scope: 'workspace',
      },
      {
        name: 'nested',
        description: '一个演示技能',
        displayName: '嵌套',
        scope: 'workspace',
      },
    ]);
  });

  it('returns empty for a blank cwd without touching the backend', async () => {
    expect(await listFlownoteSkills('  ')).toEqual([]);
    expect(readNotebookAgentSkills).not.toHaveBeenCalled();
  });
});

describe('resolveFlownoteNotebookPath', () => {
  it('prefers the workspace snapshot path', () => {
    expect(resolveFlownoteNotebookPath({
      runtimeConfig: {
        notebookId: 'nb-1',
        workspaceSnapshot: { notebookPath: 'C:\\snap' },
      } as never,
    })).toBe('C:\\snap');
  });

  it('falls back to the notebook registry and then the selected notebook', () => {
    expect(resolveFlownoteNotebookPath({
      runtimeConfig: { notebookId: 'nb-1' } as never,
    })).toBe('C:\\vault\\知识库');
    expect(resolveFlownoteNotebookPath({
      runtimeConfig: { notebookId: 'missing' } as never,
    })).toBe('C:\\vault\\选中的库');
    expect(resolveFlownoteNotebookPath(null)).toBe('C:\\vault\\选中的库');
  });
});

describe('buildFlownoteSkillContext', () => {
  const chip = (name: string, display?: string) =>
    `[${display ?? name}](flownote://slash/flownote/skill:${name})`;

  it('returns undefined without chips or notebook path', async () => {
    expect(await buildFlownoteSkillContext({ markdown: 'no chips', notebookPath: 'C:\\v' })).toBeUndefined();
    expect(await buildFlownoteSkillContext({ markdown: chip('demo'), notebookPath: ' ' })).toBeUndefined();
    expect(readNotebookAgentSkills).not.toHaveBeenCalled();
  });

  it('wraps skill bodies once per unique skill and skips disabled or missing ones', async () => {
    readNotebookAgentSkills.mockResolvedValue([
      skillFile(),
      skillFile({ id: 'off', commandName: 'off', name: '关', enabled: false }),
    ]);
    const context = await buildFlownoteSkillContext({
      markdown: `${chip('demo', '演示技能')} ${chip('demo')} ${chip('off')} ${chip('ghost')}`,
      notebookPath: 'C:\\v',
    });
    expect(readNotebookAgentSkills).toHaveBeenCalledWith('C:\\v');
    expect(context).toContain('<flownote-skill name="演示技能" command="demo" source=".agents/skills/demo/SKILL.md">');
    expect(context).toContain('逐步执行演示流程。');
    expect(context).not.toContain('command="off"');
    expect(context).not.toContain('command="ghost"');
    expect(context?.match(/<flownote-skill/g)).toHaveLength(1);
    expect(context).toContain('非系统指令');
  });

  it('truncates oversized bodies and stops at the total budget', async () => {
    // CJK filler: it cannot collide with the XML/markup characters around it.
    const bigBody = '字'.repeat(FLOWNOTE_SKILL_BODY_CHAR_LIMIT + 5_000);
    readNotebookAgentSkills.mockResolvedValue([
      skillFile({ id: 'big', commandName: 'big', name: '大技能', body: bigBody }),
      skillFile({ id: 'big2', commandName: 'big2', name: '大技能二', body: bigBody }),
      skillFile({ id: 'small', commandName: 'small', name: '小技能', body: 'small' }),
    ]);
    const context = await buildFlownoteSkillContext({
      markdown: `${chip('big')} ${chip('big2')} ${chip('small')}`,
      notebookPath: 'C:\\v',
    });
    expect(context).toContain('[…正文过长已截断]');
    // Each oversized skill consumes the per-skill cap; after two of them the
    // total budget is exhausted, so the small skill is dropped with a marker.
    expect(context).not.toContain('command="small"');
    expect(context).toContain('[…其余技能因长度限制未注入]');
    const injectedChars = (context?.match(/字/g) ?? []).length;
    expect(injectedChars).toBeLessThanOrEqual(FLOWNOTE_SKILL_TOTAL_CHAR_LIMIT);
  });
});
