import notebookTemplateIndex from '../../../../.flownote/templates/notebook-templates/index.json';

export interface NotebookTemplateFile {
  path: string;
  content: string;
}

export const DEFAULT_NOTEBOOK_TEMPLATE_ID = notebookTemplateIndex.defaultTemplateId;
export const NOTEBOOK_TEMPLATES = notebookTemplateIndex.templates;

// This source-tree helper is used only to inspect the shipped seed files.
// The installed app reads the user's ~/.flownote/templates directory through IPC.
const NOTEBOOK_TEMPLATE_FILES = import.meta.glob<string>(
  [
    '../../../../.flownote/templates/notebook-templates/*/**/*.md',
    '../../../../.flownote/templates/notebook-templates/*/.agents/**/*',
    '../../../../.flownote/templates/notebook-templates/*/**/*.csv',
    '../../../../.flownote/templates/notebook-templates/*/**/*.json',
    '../../../../.flownote/templates/notebook-templates/*/**/*.txt',
    '../../../../.flownote/templates/notebook-templates/*/.gitignore',
    '../../../../.flownote/templates/notebook-templates/*/CODEOWNERS',
  ],
  {
    eager: true,
    import: 'default',
    query: '?raw',
  },
);

export function getNotebookTemplateFiles(templateId: string): NotebookTemplateFile[] {
  const template = NOTEBOOK_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error(`未知的笔记本模板：${templateId}`);
  const sourcePrefix = `../../../../.flownote/templates/notebook-templates/${template.sourceDirectory}/`;

  return Object.entries(NOTEBOOK_TEMPLATE_FILES)
    .filter(([path]) => path.startsWith(sourcePrefix))
    .map(([path, content]) => ({
      path: path.slice(sourcePrefix.length),
      content,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
