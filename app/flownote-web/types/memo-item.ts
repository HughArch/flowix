/** Path-keyed memo event projection mirrored from the Core note DTO. */
import {
  noteListItemKey,
  noteListItemRelativePath,
  noteListItemTitle,
} from './note-item';
import type { NoteColor, AgentThreadItem } from './note-item';

export {
  type AgentThreadItem,
  type NoteColor,
  NOTE_COLORS,
  type NoteListItem,
  noteListItemKey,
  noteListItemRelativePath,
  noteListItemTitle,
} from './note-item';

/** @deprecated Use NoteListItem for path-identified Notes. */
export interface MemoItem {
  filename: string;
  /** Path relative to the notebook root, using `/` separators. */
  relativePath: string;
  preview: string;
  thumbnail?: string | null;
  tags: string[];
  todos: { content: string; status: string }[];
  agents: AgentThreadItem[];
  createdAt: number;
  updatedAt: number;
  favorited: boolean;
  icon: string | null;
  colors: NoteColor[];
  properties: Record<string, unknown>;
  isOpen?: boolean;
}

/** @deprecated Use noteListItemKey. */
export const memoListItemKey = noteListItemKey;
/** @deprecated Use noteListItemRelativePath. */
export const memoListItemRelativePath = noteListItemRelativePath;
/** @deprecated Use noteListItemTitle. */
export const memoListItemTitle = noteListItemTitle;
