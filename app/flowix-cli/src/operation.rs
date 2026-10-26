//! Transport-neutral Flowix operations shared by CLI and MCP adapters.

use crate::{
    background_store, callout_store, cloud, collection_store, columns_store, errors::CliError, fmt,
    output, path_store, plugin, store, toggle_store,
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum FlowixOperation {
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
}

pub(crate) fn execute(operation: FlowixOperation) -> Result<Value, CliError> {
    match operation {
        FlowixOperation::Notebooks => {
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
        FlowixOperation::List {
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
        FlowixOperation::Tags { notebook } => store::notebook_tags(notebook.as_deref()),
        FlowixOperation::Show { address } => path_store::show(&address),
        FlowixOperation::Search {
            query,
            notebook,
            tag,
            limit,
        } => {
            path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit)
        }
        FlowixOperation::Create { notebook, content } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::create(&notebook, &content)
        }
        FlowixOperation::Edit {
            address,
            old,
            replacement,
            dry_run,
        } => {
            path_store::edit(&address, &old, &replacement, dry_run)
        }
        FlowixOperation::Write { address, content } => {
            path_store::write(&address, &content)
        }
        FlowixOperation::Delete { address } => {
            path_store::delete(&address)
        }
        FlowixOperation::CloudVersions { notebook, path, page } => {
            let paths = crate::paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            cloud::list(&paths, &notebook, &path, page)
        }
        FlowixOperation::CloudRestore { notebook, path, history_id } => {
            let paths = crate::paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            cloud::restore(&paths, &notebook, &path, history_id)
        }
        FlowixOperation::CollectionRead { notebook, collection_id, path } => {
            collection_store::read(&notebook, collection_id.as_deref(), path.as_deref())
        }
        FlowixOperation::ArtifactList => output::to_json_value(&plugin::list_data()),
        FlowixOperation::ArtifactDescribe { plugin_id } => {
            output::to_json_value(&plugin::describe_data(&plugin_id)?)
        }
        FlowixOperation::ArtifactCreate {
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
        FlowixOperation::ColumnsList { address } => columns_store::list(&address),
        FlowixOperation::ColumnsAdd {
            address,
            count,
            at,
        } => columns_store::add(&address, count, at),
        FlowixOperation::ColumnsRemove {
            address,
            block,
            column,
        } => columns_store::remove(&address, block, column),
        FlowixOperation::ColumnsWidth {
            address,
            block,
            widths,
        } => columns_store::set_widths(&address, block, &widths),
        FlowixOperation::BackgroundList { address } => background_store::list(&address),
        FlowixOperation::BackgroundSet {
            address,
            line,
            color,
        } => background_store::set(&address, line, &color),
        FlowixOperation::BackgroundClear { address, line } => {
            background_store::clear(&address, line)
        }
        FlowixOperation::CalloutList { address } => callout_store::list(&address),
        FlowixOperation::CalloutAdd {
            address,
            at,
            icon,
            color,
            content,
        } => callout_store::add(&address, at, icon.as_deref(), color.as_deref(), &content),
        FlowixOperation::CalloutSet {
            address,
            block,
            icon,
            color,
        } => callout_store::set(&address, block, icon.as_deref(), color.as_deref()),
        FlowixOperation::CalloutRemove {
            address,
            block,
            keep_content,
        } => callout_store::remove(&address, block, keep_content),
        FlowixOperation::ToggleList { address } => toggle_store::list(&address),
        FlowixOperation::ToggleAdd {
            address,
            at,
            title,
            content,
            open,
            bg,
        } => toggle_store::add(&address, at, &title, &content, open, bg.as_deref()),
        FlowixOperation::ToggleSet {
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
        FlowixOperation::ToggleRemove {
            address,
            block,
            keep_content,
        } => toggle_store::remove(&address, block, keep_content),
    }
}
