//! Transport-neutral Flownote operations shared by CLI and MCP adapters.

use crate::{
    background_store, callout_store, canvas_store, cloud, collection_store, columns_store,
    errors::CliError, fmt, notecard_store, output, path_store, plugin, store, toggle_store,
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum FlownoteOperation {
    Notebooks,
    List {
        notebook: Option<String>,
        limit: usize,
        offset: usize,
    },
    Tags {
        notebook: Option<String>,
    },
    Show {
        address: String,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
    },
    Create {
        notebook: Option<String>,
        content: String,
    },
    Edit {
        address: String,
        old: String,
        replacement: String,
        dry_run: bool,
    },
    Write {
        address: String,
        content: String,
    },
    Delete {
        address: String,
    },
    CloudVersions {
        notebook: Option<String>,
        path: String,
        page: u32,
    },
    CloudRestore {
        notebook: Option<String>,
        path: String,
        history_id: i64,
    },
    CollectionRead {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
    },
    ArtifactList,
    ArtifactDescribe {
        plugin_id: String,
    },
    ArtifactCreate {
        plugin_id: String,
        notebook: Option<String>,
        source_note: Option<String>,
        producer: String,
        content: String,
    },
    ColumnsList {
        address: String,
    },
    ColumnsAdd {
        address: String,
        count: usize,
        at: Option<usize>,
    },
    ColumnsRemove {
        address: String,
        block: usize,
        column: usize,
    },
    ColumnsWidth {
        address: String,
        block: usize,
        widths: Vec<u32>,
    },
    BackgroundList {
        address: String,
    },
    BackgroundSet {
        address: String,
        line: usize,
        color: String,
    },
    BackgroundClear {
        address: String,
        line: usize,
    },
    CalloutList {
        address: String,
    },
    CalloutAdd {
        address: String,
        at: Option<usize>,
        icon: Option<String>,
        color: Option<String>,
        content: String,
    },
    CalloutSet {
        address: String,
        block: usize,
        icon: Option<String>,
        color: Option<String>,
    },
    CalloutRemove {
        address: String,
        block: usize,
        keep_content: bool,
    },
    ToggleList {
        address: String,
    },
    ToggleAdd {
        address: String,
        at: Option<usize>,
        title: String,
        content: String,
        open: bool,
        bg: Option<String>,
    },
    ToggleSet {
        address: String,
        block: usize,
        title: Option<String>,
        content: Option<String>,
        open: Option<bool>,
        bg: Option<String>,
        clear_bg: bool,
    },
    ToggleRemove {
        address: String,
        block: usize,
        keep_content: bool,
    },
    NotecardList {
        address: String,
    },
    NotecardAdd {
        address: String,
        note: String,
        at: Option<usize>,
        layout: Option<String>,
        color: Option<String>,
        text: Option<String>,
        title: Option<String>,
    },
    NotecardSet {
        address: String,
        block: usize,
        layout: Option<String>,
        title: Option<String>,
        color: Option<String>,
        clear_color: bool,
        text: Option<String>,
        clear_text: bool,
    },
    NotecardRemove {
        address: String,
        block: usize,
    },
    CanvasCreate {
        notebook: Option<String>,
        name: String,
        folder: Option<String>,
    },
    CanvasShow {
        address: String,
    },
    CanvasAddCard {
        address: String,
        note: Option<String>,
        text: Option<String>,
        color: Option<String>,
        title: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    CanvasAddShape {
        address: String,
        shape: String,
        text: Option<String>,
        fill: Option<String>,
        stroke: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
        x2: Option<f64>,
        y2: Option<f64>,
    },
    CanvasAddEdge {
        address: String,
        from: String,
        to: String,
        label: Option<String>,
    },
    CanvasAddFrame {
        address: String,
        title: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    CanvasAddNotes {
        address: String,
        notes: Vec<String>,
        columns: Option<usize>,
        x: Option<f64>,
        y: Option<f64>,
        gap_x: Option<f64>,
        gap_y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    CanvasRemove {
        address: String,
        ids: Vec<String>,
    },
    CanvasUpdate {
        address: String,
        element: String,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
        x2: Option<f64>,
        y2: Option<f64>,
        text: Option<String>,
        color: Option<String>,
        fill: Option<String>,
        stroke: Option<String>,
        label: Option<String>,
        from: Option<String>,
        to: Option<String>,
        title: Option<String>,
    },
}

pub(crate) fn execute(operation: FlownoteOperation) -> Result<Value, CliError> {
    match operation {
        FlownoteOperation::Notebooks => {
            let (configs, selected) = store::notebooks_list_data()?;
            let counts = store::notebook_note_counts(&configs)?;
            let tag_counts = store::notebook_tag_counts(&configs)?;
            Ok(fmt::notebooks_to_json(
                &configs,
                &counts,
                &tag_counts,
                selected.as_deref(),
            ))
        }
        FlownoteOperation::List {
            notebook,
            limit,
            offset,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let entries = path_store::list(&notebook)?["notes"].as_array().cloned().unwrap_or_default();
            let total = entries.len();
            let notes = entries
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "ok": true,
                "action": "list",
                "notebook": notebook,
                "notes": notes,
                "total": total,
                "offset": offset,
                "limit": limit,
                "next_offset": (offset + notes.len() < total).then_some(offset + notes.len())
            }))
        }
        FlownoteOperation::Tags { notebook } => store::notebook_tags(notebook.as_deref()),
        FlownoteOperation::Show { address } => path_store::show(&address),
        FlownoteOperation::Search {
            query,
            notebook,
            tag,
            limit,
        } => {
            path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit)
        }
        FlownoteOperation::Create { notebook, content } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::create(&notebook, &content)
        }
        FlownoteOperation::Edit {
            address,
            old,
            replacement,
            dry_run,
        } => {
            path_store::edit(&address, &old, &replacement, dry_run)
        }
        FlownoteOperation::Write { address, content } => {
            path_store::write(&address, &content)
        }
        FlownoteOperation::Delete { address } => {
            path_store::delete(&address)
        }
        FlownoteOperation::CloudVersions { notebook, path, page } => {
            let paths = crate::paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            cloud::list(&paths, &notebook, &path, page)
        }
        FlownoteOperation::CloudRestore { notebook, path, history_id } => {
            let paths = crate::paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            cloud::restore(&paths, &notebook, &path, history_id)
        }
        FlownoteOperation::CollectionRead { notebook, collection_id, path } => {
            collection_store::read(&notebook, collection_id.as_deref(), path.as_deref())
        }
        FlownoteOperation::ArtifactList => output::to_json_value(&plugin::list_data()),
        FlownoteOperation::ArtifactDescribe { plugin_id } => {
            output::to_json_value(&plugin::describe_data(&plugin_id)?)
        }
        FlownoteOperation::ArtifactCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            content,
        } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            output::to_json_value(&plugin::create_data(
                &plugin_id,
                &notebook,
                source_note.as_deref(),
                &producer,
                &content,
            )?)
        }
        FlownoteOperation::ColumnsList { address } => columns_store::list(&address),
        FlownoteOperation::ColumnsAdd {
            address,
            count,
            at,
        } => columns_store::add(&address, count, at),
        FlownoteOperation::ColumnsRemove {
            address,
            block,
            column,
        } => columns_store::remove(&address, block, column),
        FlownoteOperation::ColumnsWidth {
            address,
            block,
            widths,
        } => columns_store::set_widths(&address, block, &widths),
        FlownoteOperation::BackgroundList { address } => background_store::list(&address),
        FlownoteOperation::BackgroundSet {
            address,
            line,
            color,
        } => background_store::set(&address, line, &color),
        FlownoteOperation::BackgroundClear { address, line } => {
            background_store::clear(&address, line)
        }
        FlownoteOperation::CalloutList { address } => callout_store::list(&address),
        FlownoteOperation::CalloutAdd {
            address,
            at,
            icon,
            color,
            content,
        } => callout_store::add(&address, at, icon.as_deref(), color.as_deref(), &content),
        FlownoteOperation::CalloutSet {
            address,
            block,
            icon,
            color,
        } => callout_store::set(&address, block, icon.as_deref(), color.as_deref()),
        FlownoteOperation::CalloutRemove {
            address,
            block,
            keep_content,
        } => callout_store::remove(&address, block, keep_content),
        FlownoteOperation::ToggleList { address } => toggle_store::list(&address),
        FlownoteOperation::ToggleAdd {
            address,
            at,
            title,
            content,
            open,
            bg,
        } => toggle_store::add(&address, at, &title, &content, open, bg.as_deref()),
        FlownoteOperation::ToggleSet {
            address,
            block,
            title,
            content,
            open,
            bg,
            clear_bg,
        } => toggle_store::set(
            &address,
            block,
            title.as_deref(),
            content.as_deref(),
            open,
            bg.as_deref(),
            clear_bg,
        ),
        FlownoteOperation::ToggleRemove {
            address,
            block,
            keep_content,
        } => toggle_store::remove(&address, block, keep_content),
        FlownoteOperation::NotecardList { address } => notecard_store::list(&address),
        FlownoteOperation::NotecardAdd {
            address,
            note,
            at,
            layout,
            color,
            text,
            title,
        } => notecard_store::add(
            &address,
            &note,
            at,
            layout.as_deref(),
            color.as_deref(),
            text.as_deref(),
            title.as_deref(),
        ),
        FlownoteOperation::NotecardSet {
            address,
            block,
            layout,
            title,
            color,
            clear_color,
            text,
            clear_text,
        } => notecard_store::set(
            &address,
            block,
            layout.as_deref(),
            title.as_deref(),
            color.as_deref(),
            clear_color,
            text.as_deref(),
            clear_text,
        ),
        FlownoteOperation::NotecardRemove { address, block } => {
            notecard_store::remove(&address, block)
        }
        FlownoteOperation::CanvasCreate {
            notebook,
            name,
            folder,
        } => canvas_store::create(notebook.as_deref(), &name, folder.as_deref()),
        FlownoteOperation::CanvasShow { address } => canvas_store::show(&address),
        FlownoteOperation::CanvasAddCard {
            address,
            note,
            text,
            color,
            title,
            x,
            y,
            w,
            h,
        } => canvas_store::add_card(
            &address,
            note.as_deref(),
            text.as_deref(),
            color.as_deref(),
            title.as_deref(),
            canvas_store::Placement { x, y, w, h },
        ),
        FlownoteOperation::CanvasAddShape {
            address,
            shape,
            text,
            fill,
            stroke,
            x,
            y,
            w,
            h,
            x2,
            y2,
        } => canvas_store::add_shape(
            &address,
            canvas_store::ShapeArgs {
                shape: &shape,
                text: text.as_deref(),
                fill: fill.as_deref(),
                stroke: stroke.as_deref(),
                placement: canvas_store::Placement { x, y, w, h },
                x2,
                y2,
            },
        ),
        FlownoteOperation::CanvasAddEdge {
            address,
            from,
            to,
            label,
        } => canvas_store::add_edge(&address, &from, &to, label.as_deref()),
        FlownoteOperation::CanvasAddFrame {
            address,
            title,
            x,
            y,
            w,
            h,
        } => canvas_store::add_frame(
            &address,
            title.as_deref(),
            canvas_store::Placement { x, y, w, h },
        ),
        FlownoteOperation::CanvasAddNotes {
            address,
            notes,
            columns,
            x,
            y,
            gap_x,
            gap_y,
            w,
            h,
        } => canvas_store::add_notes(
            &address,
            &notes,
            flownote_core::canvas::GridPlan {
                columns: columns.unwrap_or(3),
                gap_x: gap_x.unwrap_or(flownote_core::canvas::AUTO_PLACE_GAP),
                gap_y: gap_y.unwrap_or(flownote_core::canvas::AUTO_PLACE_GAP),
                w,
                h,
                start: x.zip(y),
            },
        ),
        FlownoteOperation::CanvasRemove { address, ids } => canvas_store::remove(&address, &ids),
        FlownoteOperation::CanvasUpdate {
            address,
            element,
            x,
            y,
            w,
            h,
            x2,
            y2,
            text,
            color,
            fill,
            stroke,
            label,
            from,
            to,
            title,
        } => canvas_store::update(
            &address,
            &element,
            &canvas_store::UpdateArgs {
                x,
                y,
                w,
                h,
                x2,
                y2,
                text: text.as_deref(),
                color: color.as_deref(),
                fill: fill.as_deref(),
                stroke: stroke.as_deref(),
                label: label.as_deref(),
                from: from.as_deref(),
                to: to.as_deref(),
                title: title.as_deref(),
            },
        ),
    }
}
