/** Public note-opening commands for features that navigate to Memo content. */
export {
  openNotebookById,
  openNoteByDeepLink,
  openNoteByNotebookPath,
  openNoteByPhysicalPath,
} from '@features/memo/use-cases/open-by-target';
export type { OpenNoteDestinationOptions } from '@features/memo/use-cases/open-by-target';
