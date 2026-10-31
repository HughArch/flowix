//! CLI 命令调度层。
//!
//! `cli` 模块只负责把 argv 解析成结构化命令；这里负责把命令转给执行层。

use crate::{
    background_store, callout_store, canvas_store, cli, cloud, columns_store, errors::CliError,
    mcp, operation, path_store, paths, plugin, store, toggle_store,
};

/// 跑 CLI 主入口。
pub fn run_cli(args: &[String]) -> Result<(), CliError> {
    let command = match cli::parse(args)? {
        Some(command) => command,
        None => return Ok(()),
    };

    match command {
        cli::Cli::Version => {
            println!("{} {}", cli::DISPLAY_BIN, env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        cli::Cli::Notebooks { json } => {
            if json {
                store::cmd_notebooks_json()
            } else {
                store::cmd_notebooks()
            }
        }
        cli::Cli::List { notebook, json } => {
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::print(path_store::list(&notebook)?, json)
        }
        cli::Cli::Tags { notebook, json } => store::cmd_tags(notebook.as_deref(), json),
        cli::Cli::Show { id, json } => path_store::print(path_store::show(&id)?, json),
        cli::Cli::Create {
            notebook,
            file,
            stdin,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "create")?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            path_store::print(path_store::create(&notebook, &content)?, json)
        }
        cli::Cli::Delete { id, json } => path_store::print(path_store::delete(&id)?, json),
        cli::Cli::CollectionRead { notebook, collection_id, path, json } => {
            let data = operation::execute(operation::FlowixOperation::CollectionRead {
                notebook, collection_id, path,
            })?;
            path_store::print(data, json)
        }
        cli::Cli::Search {
            query,
            notebook,
            tag,
            limit,
            json,
        } => path_store::print(path_store::search(&query, notebook.as_deref(), tag.as_deref(), limit)?, json),
        cli::Cli::Edit {
            id,
            old,
            new,
            new_from_stdin,
            new_file,
            dry_run,
            json,
        } => {
            let old = old.ok_or_else(|| CliError::Usage("edit requires --old".into()))?;
            let replacement = if new_from_stdin {
                path_store::read_input(None, true, "edit")?
            } else if let Some(file) = new_file {
                path_store::read_input(Some(&file), false, "edit")?
            } else { new.ok_or_else(|| CliError::Usage("edit requires --new, --new-file or --new-stdin".into()))? };
            path_store::print(path_store::edit(&id, &old, &replacement, dry_run)?, json)
        },
        cli::Cli::Write {
            id,
            file,
            stdin,
            json,
        } => {
            let content = path_store::read_input(file.as_deref(), stdin, "write")?;
            path_store::print(path_store::write(&id, &content)?, json)
        },
        cli::Cli::CloudVersions { notebook, path, page, json } => {
            let paths = paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let data = cloud::list(&paths, &notebook, &path, page)?;
            if json { println!("{}", serde_json::to_string_pretty(&data).map_err(|e| CliError::Usage(e.to_string()))?); }
            else if let Some(versions) = data.get("versions").and_then(|v| v.as_array()) {
                if versions.is_empty() {
                    println!("no cloud versions ({}).", data.get("status").and_then(|s| s.as_str()).unwrap_or("ok"));
                }
                for version in versions {
                    println!("{}	{}	{}	{}",
                        version.get("historyId").and_then(|v| v.as_i64()).unwrap_or(0),
                        version.get("version").and_then(|v| v.as_i64()).unwrap_or(0),
                        version.get("createdAtMs").and_then(|v| v.as_i64()).unwrap_or(0),
                        version.get("clientName").and_then(|v| v.as_str()).unwrap_or(""));
                }
            } else {
                println!("{}", data.get("message").and_then(|m| m.as_str()).unwrap_or("no cloud versions"));
            }
            Ok(())
        }
        cli::Cli::CloudRestore { notebook, path, history, json } => {
            let paths = paths::resolve()?;
            let notebook = store::resolve_notebook_key(notebook.as_deref())?;
            let data = cloud::restore(&paths, &notebook, &path, history)?;
            if json { println!("{}", serde_json::to_string_pretty(&data).map_err(|e| CliError::Usage(e.to_string()))?); }
            else { println!("restored {} to cloud history {} (previous content archived as restore_backup)", path, history); }
            Ok(())
        }
        cli::Cli::PluginList { json } => plugin::cmd_list(json),
        cli::Cli::PluginDescribe { plugin_id, json } => plugin::cmd_describe(&plugin_id, json),
        cli::Cli::PluginCreate {
            plugin_id,
            notebook,
            source_note,
            producer,
            json,
        } => plugin::cmd_create(
            &plugin_id,
            notebook.as_deref(),
            source_note.as_deref(),
            &producer,
            json,
        ),
        cli::Cli::Completion { shell } => store::cmd_completion(&shell),
        cli::Cli::Columns { command, json } => match command {
            cli::ColumnsCommand::List { id } => path_store::print(columns_store::list(&id)?, json),
            cli::ColumnsCommand::Add { id, count, at } => {
                path_store::print(columns_store::add(&id, count, at)?, json)
            }
            cli::ColumnsCommand::Remove { id, block, column } => {
                path_store::print(columns_store::remove(&id, block, column)?, json)
            }
            cli::ColumnsCommand::Width { id, block, widths } => {
                path_store::print(columns_store::set_widths(&id, block, &widths)?, json)
            }
        },
        cli::Cli::Background { command, json } => match command {
            cli::BackgroundCommand::List { id } => {
                path_store::print(background_store::list(&id)?, json)
            }
            cli::BackgroundCommand::Set { id, line, color } => {
                path_store::print(background_store::set(&id, line, &color)?, json)
            }
            cli::BackgroundCommand::Clear { id, line } => {
                path_store::print(background_store::clear(&id, line)?, json)
            }
        },
        cli::Cli::Callout { command, json } => match command {
            cli::CalloutCommand::List { id } => path_store::print(callout_store::list(&id)?, json),
            cli::CalloutCommand::Add {
                id,
                at,
                icon,
                color,
                content,
                file,
                stdin,
            } => {
                let content = read_optional_input(content, file.as_deref(), stdin, "callout add")?;
                path_store::print(
                    callout_store::add(&id, at, icon.as_deref(), color.as_deref(), &content)?,
                    json,
                )
            }
            cli::CalloutCommand::Set {
                id,
                block,
                icon,
                color,
            } => path_store::print(
                callout_store::set(&id, block, icon.as_deref(), color.as_deref())?,
                json,
            ),
            cli::CalloutCommand::Remove {
                id,
                block,
                delete_content,
            } => path_store::print(callout_store::remove(&id, block, !delete_content)?, json),
        },
        cli::Cli::Toggle { command, json } => match command {
            cli::ToggleCommand::List { id } => path_store::print(toggle_store::list(&id)?, json),
            cli::ToggleCommand::Add {
                id,
                at,
                title,
                content,
                file,
                stdin,
                open,
                bg,
            } => {
                let content = read_optional_input(content, file.as_deref(), stdin, "toggle add")?;
                path_store::print(
                    toggle_store::add(
                        &id,
                        at,
                        title.as_deref().unwrap_or_default(),
                        &content,
                        open,
                        bg.as_deref(),
                    )?,
                    json,
                )
            }
            cli::ToggleCommand::Set {
                id,
                block,
                title,
                content,
                file,
                stdin,
                open,
                bg,
                clear_bg,
            } => {
                let content = read_update_input(content, file.as_deref(), stdin, "toggle set")?;
                path_store::print(
                    toggle_store::set(
                        &id,
                        block,
                        title.as_deref(),
                        content.as_deref(),
                        open,
                        bg.as_deref(),
                        clear_bg,
                    )?,
                    json,
                )
            }
            cli::ToggleCommand::Remove {
                id,
                block,
                delete_content,
            } => path_store::print(toggle_store::remove(&id, block, !delete_content)?, json),
        },
        cli::Cli::Canvas { command, json } => match command {
            cli::CanvasCommand::Create {
                notebook,
                name,
                folder,
            } => {
                let name = name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Untitled");
                path_store::print(
                    canvas_store::create(notebook.as_deref(), name, folder.as_deref())?,
                    json,
                )
            }
            cli::CanvasCommand::Show { id } => path_store::print(canvas_store::show(&id)?, json),
            cli::CanvasCommand::AddCard {
                id,
                note,
                text,
                color,
                title,
                x,
                y,
                w,
                h,
            } => path_store::print(
                canvas_store::add_card(
                    &id,
                    note.as_deref(),
                    text.as_deref(),
                    color.as_deref(),
                    title.as_deref(),
                    canvas_store::Placement { x, y, w, h },
                )?,
                json,
            ),
            cli::CanvasCommand::AddShape {
                id,
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
            } => path_store::print(
                canvas_store::add_shape(
                    &id,
                    canvas_store::ShapeArgs {
                        shape: &shape,
                        text: text.as_deref(),
                        fill: fill.as_deref(),
                        stroke: stroke.as_deref(),
                        placement: canvas_store::Placement { x, y, w, h },
                        x2,
                        y2,
                    },
                )?,
                json,
            ),
            cli::CanvasCommand::AddEdge {
                id,
                from,
                to,
                label,
            } => path_store::print(
                canvas_store::add_edge(&id, &from, &to, label.as_deref())?,
                json,
            ),
            cli::CanvasCommand::AddFrame {
                id,
                title,
                x,
                y,
                w,
                h,
            } => path_store::print(
                canvas_store::add_frame(
                    &id,
                    title.as_deref(),
                    canvas_store::Placement { x, y, w, h },
                )?,
                json,
            ),
            cli::CanvasCommand::AddNotes {
                id,
                notes,
                columns,
                x,
                y,
                gap_x,
                gap_y,
                w,
                h,
            } => path_store::print(
                canvas_store::add_notes(
                    &id,
                    &notes,
                    flowix_core::canvas::GridPlan {
                        columns: columns.unwrap_or(3),
                        gap_x: gap_x.unwrap_or(flowix_core::canvas::AUTO_PLACE_GAP),
                        gap_y: gap_y.unwrap_or(flowix_core::canvas::AUTO_PLACE_GAP),
                        w,
                        h,
                        start: x.zip(y),
                    },
                )?,
                json,
            ),
            cli::CanvasCommand::Remove { id, ids } => {
                path_store::print(canvas_store::remove(&id, &ids)?, json)
            }
            cli::CanvasCommand::Update {
                id,
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
            } => path_store::print(
                canvas_store::update(
                    &id,
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
                )?,
                json,
            ),
        },
        cli::Cli::Mcp => {
            use std::io::{stdin, stdout};
            mcp::run_mcp(stdin().lock(), stdout().lock())
        }
    }
}

/// Resolve `--content` / `--file` / `--stdin` for an insert command. The
/// three inputs are mutually exclusive; omitting all of them inserts empty
/// content.
fn read_optional_input(
    content: Option<String>,
    file: Option<&str>,
    stdin: bool,
    command: &str,
) -> Result<String, CliError> {
    match (content, file, stdin) {
        (Some(text), None, false) => Ok(text),
        (None, Some(_), false) | (None, None, true) => {
            path_store::read_input(file, stdin, command)
        }
        (None, None, false) => Ok(String::new()),
        _ => Err(CliError::Usage(format!(
            "{command}: provide at most one of --content, --file or --stdin"
        ))),
    }
}

/// Resolve update input. Unlike [`read_optional_input`], omitting every source
/// means "leave the body unchanged" rather than "set it to empty".
fn read_update_input(
    content: Option<String>,
    file: Option<&str>,
    stdin: bool,
    command: &str,
) -> Result<Option<String>, CliError> {
    match (content, file, stdin) {
        (Some(text), None, false) => Ok(Some(text)),
        (None, Some(_), false) | (None, None, true) => {
            Ok(Some(path_store::read_input(file, stdin, command)?))
        }
        (None, None, false) => Ok(None),
        _ => Err(CliError::Usage(format!(
            "{command}: provide at most one of --content, --file or --stdin"
        ))),
    }
}
