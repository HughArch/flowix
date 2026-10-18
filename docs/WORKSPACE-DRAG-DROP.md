# Workspace drag and drop

Cross-surface drag sessions use the foundation coordinator in
`app/flowix-web/shared/drag-drop/drag-drop-coordinator.ts`. It owns one active
session per WebView, registered drop targets, target priority, preview cleanup,
Escape/window-blur cancellation, and a fresh target lookup on release. It has no
feature imports and treats dragged items as opaque data.

Sources create a `DragPayload<Item>` and call `beginDragSession`,
`moveDragSession`, `endDragSession`, and `cancelDragSession`. Session IDs are
independent of the input device so Pointer Events, editor drag events, and
native file-drop adapters can use the same target contract.

Targets register `hitTest`, `evaluate`, `onPreview`, `onDrop`, and `onError`
handlers. `hitTest` returns a target-specific location, such as a calendar date
or an editor insertion position. A higher-priority target wins when targets
overlap; a rejected higher-priority target blocks lower-priority targets. The
target owns resource validation and the business operation after release.

Memo publishes file, folder, and note drag resource types from
`features/memo/public/drag-resource-api.ts`. The file tree adapts its existing
pointer gesture into a generic drag session. The calendar registers a target,
accepts notes from its notebook when its date field is writable, previews the
target date, and delegates persistence to the multidimensional-table feature.

Future editor and table drop zones should register targets with this
coordinator. Their source adapters can use the same session ID contract; the
coordinator does not assume Pointer Events. Native file dragging still uses the
existing Tauri external-file-drop router and can be migrated as a separate
source adapter.

Kanban card moves and notebook-note drops use the same Kanban target and resolve
the lane plus insertion position through the coordinator. Reordering the lane
headers remains its own gesture because it changes lane order rather than moving
records between lanes.
