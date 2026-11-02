/**
 * Read-only note body inside a canvas card.
 *
 * `html` comes from the read-only render pipeline (editor/read-only). The
 * wrapper mirrors the editor's DOM chain so the editor stylesheet applies;
 * canvas-board.css then relaxes the document-shell sizing for the card box.
 * Gesture/scroll arbitration around this body lives in canvas-board-view.
 */
export function NoteCardContent({ html }: { html: string }) {
  return (
    <div className="canvas-note-content">
      <div className="markdown-editor">
        <div className="editor-document-body">
          <div
            className="ProseMirror tiptap canvas-note-content__body"
            aria-readonly="true"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
}
