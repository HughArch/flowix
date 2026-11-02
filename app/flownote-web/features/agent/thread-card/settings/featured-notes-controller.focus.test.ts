import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@platform/tauri/client', () => ({
  notes: {},
  files: { listTableDocuments: vi.fn(async () => []) },
  externalDocuments: {},
}));
vi.mock('@features/memo/public/note-navigation-api', () => ({ openNoteByNotebookPath: vi.fn() }));
vi.mock('@features/memo/store/note-store', () => ({ useNoteStore: { getState: () => ({ notebooks: [{ id: 'book' }] }) } }));
vi.mock('@features/multidimensional-table/parse-table-document', () => ({ parseTableDocumentAsync: vi.fn() }));
vi.mock('./featured-note-cards', () => ({
  FEATURED_NOTE_MOBILE_PAGE_SIZE: 2,
  FEATURED_NOTE_PAGE_SIZE: 4,
  appendFeaturedNoteIconContent: vi.fn(),
  getFeaturedNotePage: () => [],
  getFeaturedNotePageCountForSize: () => 1,
  getFeaturedPathNoteCards: () => [],
  readFeaturedNotesTableSelection: async () => null,
  writeFeaturedNotesTableSelection: vi.fn(),
}));
import { FeaturedNotesController } from './featured-notes-controller';

const controllers: FeaturedNotesController[] = [];

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  controllers.forEach(controller => controller.dispose());
  controllers.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  const controller = new FeaturedNotesController({
    getNotebookId: () => 'book',
    t: key => key,
    isDestroyed: () => false,
  });
  controllers.push(controller);
  const card = document.createElement('div');
  document.body.append(card);
  await controller.appendFeaturedNotes(card);
  const trigger = card.querySelector<HTMLButtonElement>('.agent-thread-card__featured-notes-settings-button')!;
  const popover = [...document.body.querySelectorAll<HTMLDivElement>('.agent-thread-card__featured-notes-view-picker')].slice(-1)[0]!;
  return { trigger, popover };
}

function pointer(target: HTMLElement) {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

function bodyEditor() {
  const editor = document.createElement('div');
  editor.tabIndex = 0;
  document.body.append(editor);
  editor.focus();
  return editor;
}

it('does not move document focus to any closed card settings button on repeated outside pointers', async () => {
  const first = await mount();
  const second = await mount();
  const editor = bodyEditor();
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  pointer(editor);
  pointer(editor);
  expect(document.activeElement).toBe(editor);
  expect(focus).not.toHaveBeenCalled();
  expect(first.popover.hidden).toBe(true);
  expect(second.popover.hidden).toBe(true);
});

it('closes an open popover on outside pointer without returning focus to its trigger', async () => {
  const { trigger, popover } = await mount();
  trigger.click();
  const editor = bodyEditor();
  const focus = vi.spyOn(trigger, 'focus');
  pointer(editor);
  expect(popover.hidden).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect(focus).not.toHaveBeenCalled();
});

it('returns Escape focus without scrolling only while the popover owns focus', async () => {
  const { trigger, popover } = await mount();
  trigger.click();
  expect(popover.contains(document.activeElement)).toBe(true);
  const focus = vi.spyOn(trigger, 'focus');
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(popover.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  trigger.click();
  const editor = bodyEditor();
  focus.mockClear();
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
});

it('does not handle outside pointers after disposal', async () => {
  const { trigger } = await mount();
  controllers[0].dispose();
  const editor = bodyEditor();
  const focus = vi.spyOn(trigger, 'focus');
  pointer(editor);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
});
