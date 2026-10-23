//! CLI 命令调度层。
//!
//! `cli` 模块只负责把 argv 解析成结构化命令；这里负责把命令转给执行层。

use crate::{
    background_store, callout_store, cli, columns_store, errors::CliError, mcp, operation,
    path_store, plugin, store, toggle_store,
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
