//! CLI 命令定义与 argv 解析。
//!
//! 执行调度在 `dispatch` 模块，具体 memo 操作在 `store` 模块。

use clap::{Arg, ArgAction, Command};

use crate::errors::CliError;

pub(crate) const DISPLAY_BIN: &str = "flowix";

/// 解析后的 CLI 命令。
#[derive(Debug)]
pub enum Cli {
    Version,
    Notebooks {
        json: bool,
    },
    List {
        notebook: Option<String>,
        json: bool,
    },
    Tags {
        notebook: Option<String>,
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Create {
        notebook: Option<String>,
        file: Option<String>,
        stdin: bool,
        json: bool,
    },
    Delete {
        id: String,
        json: bool,
    },
    CollectionRead {
        notebook: String,
        collection_id: Option<String>,
        path: Option<String>,
        json: bool,
    },
    Search {
        query: String,
        notebook: Option<String>,
        tag: Option<String>,
        limit: usize,
        json: bool,
    },
    Edit {
        id: String,
        /// 旧字符串 (精确匹配, 必须唯一)
        old: Option<String>,
        /// 新字符串
        new: Option<String>,
        /// 从 stdin 读 new (避免歧义)
        new_from_stdin: bool,
        /// 从 UTF-8 文件读取 new
        new_file: Option<String>,
        dry_run: bool,
        json: bool,
    },
    /// 覆盖整个笔记内容 (从 stdin 读) ── `edit` 的非交互等价物。
    /// 覆盖 Markdown 内容，不改变物理文件名；标题改名使用独立操作。
    Write {
        id: String,
        file: Option<String>,
        stdin: bool,
        json: bool,
    },
    PluginList {
        json: bool,
    },
    PluginDescribe {
        plugin_id: String,
        json: bool,
    },
    PluginCreate {
        plugin_id: String,
        notebook: Option<String>,
        source_note: Option<String>,
        producer: String,
        json: bool,
    },
    Completion {
        shell: String,
    },
    /// Inspect or edit Notion-style content columns in a note.
    Columns {
        command: ColumnsCommand,
        json: bool,
    },
    /// Inspect or edit line background colors in a note.
    Background {
        command: BackgroundCommand,
        json: bool,
    },
    /// Inspect or edit Flowus-style callouts in a note.
    Callout {
        command: CalloutCommand,
        json: bool,
    },
    /// Model Context Protocol over stdio。向外部 Agent 暴露唯一工具
    /// `memo`，工具参数采用受限的 Flowix CLI 语法。
    Mcp,
}

#[derive(Debug)]
pub enum ColumnsCommand {
    List {
        id: String,
    },
    Add {
        id: String,
        count: usize,
        at: Option<usize>,
    },
    Remove {
        id: String,
        block: usize,
        column: usize,
    },
    Width {
        id: String,
        block: usize,
        widths: Vec<u32>,
    },
}

#[derive(Debug)]
pub enum BackgroundCommand {
    List {
        id: String,
    },
    Set {
        id: String,
        line: usize,
        color: String,
    },
    Clear {
        id: String,
        line: usize,
    },
}

#[derive(Debug)]
pub enum CalloutCommand {
    List {
        id: String,
    },
    Add {
        id: String,
        at: Option<usize>,
        icon: Option<String>,
        color: Option<String>,
        content: Option<String>,
        file: Option<String>,
        stdin: bool,
    },
    Set {
        id: String,
        block: usize,
        icon: Option<String>,
        color: Option<String>,
    },
    Remove {
        id: String,
        block: usize,
        delete_content: bool,
    },
}

/// 解析 argv。`Ok(None)` 表示"打印了 help 正常退出"。
pub(crate) fn parse(args: &[String]) -> Result<Option<Cli>, CliError> {
    if args.is_empty() {
        print_help();
        return Ok(None);
    }
    if matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    ) {
        print_help();
        return Ok(None);
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        return Ok(Some(Cli::Version));
    }

    let argv = std::iter::once(DISPLAY_BIN.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let matches = match cli_command().try_get_matches_from(argv) {
        Ok(matches) => matches,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return Ok(None);
        }
        Err(error) => return Err(clap_to_cli_error(error)),
    };
    let json = matches.get_flag("json");

    match matches.subcommand() {
        Some(("notebooks", _)) => Ok(Some(Cli::Notebooks { json })),
        Some(("list", sub)) => Ok(Some(Cli::List {
            notebook: sub.get_one::<String>("notebook").cloned(),
            json,
        })),
        Some(("tags", sub)) => Ok(Some(Cli::Tags {
            notebook: sub.get_one::<String>("notebook").cloned(),
            json,
        })),
        Some(("show", sub)) => Ok(Some(Cli::Show {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("create", sub)) => Ok(Some(Cli::Create {
            notebook: sub.get_one::<String>("notebook").cloned(),
            file: sub.get_one::<String>("file").cloned(),
            stdin: sub.get_flag("stdin"),
            json,
        })),
        Some(("delete", sub)) => Ok(Some(Cli::Delete {
            id: required_string(sub, "id")?,
            json,
        })),
        Some(("collection", sub)) => match sub.subcommand() {
            Some(("read", command)) => Ok(Some(Cli::CollectionRead {
                notebook: required_string(command, "notebook")?,
                collection_id: command.get_one::<String>("collection-id").cloned(),
                path: command.get_one::<String>("path").cloned(),
                json,
            })),
            Some((other, _)) => Err(CliError::Usage(format!("unknown collection command: `{other}`"))),
            None => Err(CliError::Usage(format!("usage: {DISPLAY_BIN} collection read"))),
        },
        Some(("edit", sub)) => Ok(Some(Cli::Edit {
            id: required_string(sub, "id")?,
            old: joined_values(sub, "old"),
            new: joined_values(sub, "new"),
            new_from_stdin: sub.get_flag("new-stdin"),
            new_file: sub.get_one::<String>("new-file").cloned(),
            dry_run: sub.get_flag("dry-run"),
            json,
        })),
        Some(("write", sub)) => Ok(Some(Cli::Write {
            id: required_string(sub, "id")?,
            file: sub.get_one::<String>("file").cloned(),
            stdin: sub.get_flag("stdin"),
            json,
        })),
        Some(("search", sub)) => {
            let limit = *sub.get_one::<usize>("limit").unwrap_or(&20);
            if limit == 0 {
                return Err(CliError::Usage(
                    "search: --limit/-l requires a positive integer".into(),
                ));
            }
            Ok(Some(Cli::Search {
                query: required_string(sub, "query")?,
                notebook: sub.get_one::<String>("notebook").cloned(),
                tag: sub.get_one::<String>("tag").cloned(),
                limit,
                json,
            }))
        }
        Some(("plugin", sub)) => match sub.subcommand() {
            Some(("list", _)) => Ok(Some(Cli::PluginList { json })),
            Some(("describe", command)) => Ok(Some(Cli::PluginDescribe {
                plugin_id: required_string(command, "plugin-id")?,
                json,
            })),
            Some(("create", command)) => Ok(Some(Cli::PluginCreate {
                plugin_id: required_string(command, "plugin-id")?,
                notebook: command.get_one::<String>("notebook").cloned(),
                source_note: command.get_one::<String>("source-note").cloned(),
                producer: command
                    .get_one::<String>("producer")
                    .cloned()
                    .unwrap_or_else(|| "agent-cli".to_string()),
                json,
            })),
            Some((other, _)) => Err(CliError::Usage(format!(
                "unknown plugin command: `{other}`"
            ))),
            None => Err(CliError::Usage(format!(
                "usage: {DISPLAY_BIN} plugin <list|describe|create>"
            ))),
        },
        Some(("completion", sub)) => Ok(Some(Cli::Completion {
            shell: required_string(sub, "shell")?,
        })),
        Some(("columns", sub)) => {
            let command = match sub.subcommand() {
                Some(("list", command)) => ColumnsCommand::List {
                    id: required_string(command, "id")?,
                },
                Some(("add", command)) => ColumnsCommand::Add {
                    id: required_string(command, "id")?,
                    count: *command.get_one::<usize>("count").unwrap_or(&2),
                    at: command.get_one::<usize>("at").copied(),
                },
                Some(("remove", command)) => ColumnsCommand::Remove {
                    id: required_string(command, "id")?,
                    block: *command.get_one::<usize>("block").unwrap_or(&1),
                    column: *command.get_one::<usize>("column").unwrap_or(&1),
                },
                Some(("width", command)) => ColumnsCommand::Width {
                    id: required_string(command, "id")?,
                    block: *command.get_one::<usize>("block").unwrap_or(&1),
                    widths: command
                        .get_many::<u32>("widths")
                        .map(|values| values.copied().collect())
                        .unwrap_or_default(),
                },
                Some((other, _)) => {
                    return Err(CliError::Usage(format!(
                        "unknown columns command: `{other}`"
                    )))
                }
                None => {
                    return Err(CliError::Usage(format!(
                        "usage: {DISPLAY_BIN} columns <list|add|remove|width>"
                    )))
                }
            };
            Ok(Some(Cli::Columns { command, json }))
        }
        Some(("background", sub)) => {
            let command = match sub.subcommand() {
                Some(("list", command)) => BackgroundCommand::List {
                    id: required_string(command, "id")?,
                },
                Some(("set", command)) => BackgroundCommand::Set {
                    id: required_string(command, "id")?,
                    line: *command.get_one::<usize>("line").unwrap_or(&1),
                    color: required_string(command, "color")?,
                },
                Some(("clear", command)) => BackgroundCommand::Clear {
                    id: required_string(command, "id")?,
                    line: *command.get_one::<usize>("line").unwrap_or(&1),
                },
                Some((other, _)) => {
                    return Err(CliError::Usage(format!(
                        "unknown background command: `{other}`"
                    )))
                }
                None => {
                    return Err(CliError::Usage(format!(
                        "usage: {DISPLAY_BIN} background <list|set|clear>"
                    )))
                }
            };
            Ok(Some(Cli::Background { command, json }))
        }
        Some(("callout", sub)) => {
            let command = match sub.subcommand() {
                Some(("list", command)) => CalloutCommand::List {
                    id: required_string(command, "id")?,
                },
                Some(("add", command)) => CalloutCommand::Add {
                    id: required_string(command, "id")?,
                    at: command.get_one::<usize>("at").copied(),
                    icon: command.get_one::<String>("icon").cloned(),
                    color: command.get_one::<String>("color").cloned(),
                    content: command.get_one::<String>("content").cloned(),
                    file: command.get_one::<String>("file").cloned(),
                    stdin: command.get_flag("stdin"),
                },
                Some(("set", command)) => CalloutCommand::Set {
                    id: required_string(command, "id")?,
                    block: *command.get_one::<usize>("block").unwrap_or(&1),
                    icon: command.get_one::<String>("icon").cloned(),
                    color: command.get_one::<String>("color").cloned(),
                },
                Some(("remove", command)) => CalloutCommand::Remove {
                    id: required_string(command, "id")?,
                    block: *command.get_one::<usize>("block").unwrap_or(&1),
                    delete_content: command.get_flag("delete-content"),
                },
                Some((other, _)) => {
                    return Err(CliError::Usage(format!(
                        "unknown callout command: `{other}`"
                    )))
                }
                None => {
                    return Err(CliError::Usage(format!(
                        "usage: {DISPLAY_BIN} callout <list|add|set|remove>"
                    )))
                }
            };
            Ok(Some(Cli::Callout { command, json }))
        }
        Some(("mcp", _)) => Ok(Some(Cli::Mcp)),
        Some((other, _)) => Err(CliError::Usage(format!(
            "unknown command: `{other}`\n(run `{DISPLAY_BIN} --help` for usage)"
        ))),
        None => {
            print_help();
            Ok(None)
        }
    }
}

pub(crate) fn cli_command() -> Command {
    Command::new(DISPLAY_BIN)
        .version(env!("CARGO_PKG_VERSION"))
        .about("Manage local Flowix notebooks, Markdown notes, and artifacts")
        .after_help("For Markdown content, --file is recommended (especially on Windows PowerShell 5.1). Files must be UTF-8. Note addresses use <notebook-id>::<relative-path> or an absolute path. Examples:\n  flowix create <notebook> --file body.md --json\n  flowix show work::Notes/Example.md --json\n  flowix write work::Notes/Example.md --file body.md --json\n  flowix list\n  flowix search TODO --tag project/flowix --limit 20\n  flowix background set work::Notes/Example.md --line 3 --color yellow --json\n  flowix callout add work::Notes/Example.md --icon \"⚠️\" --color yellow --content \"Check this\" --json\n  flowix collection read --notebook <notebook-id> --id <collection-id> --json\n  flowix collection read --notebook <notebook-id> --path 'Assets/Images.index.yaml' --json\n  flowix mcp")
        .arg(
            Arg::new("json")
                .long("json")
                .short('j')
                .global(true)
                .action(ArgAction::SetTrue),
        )
        .subcommand_required(true)
        .subcommand(Command::new("notebooks").about("List notebooks"))
        .subcommand(
            Command::new("list")
                .about("List notes; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1)),
        )
        .subcommand(
            Command::new("tags")
                .about("List all tags in a notebook; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1)),
        )
        .subcommand(Command::new("show").about("Show a note").arg(required_arg("id")))
        .subcommand(
            Command::new("create")
                .about("Create a note; use --file for UTF-8 Markdown (recommended), or --stdin explicitly; defaults to the current notebook")
                .arg(Arg::new("notebook").allow_hyphen_values(true).num_args(1))
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(Command::new("delete").about("Delete a note").arg(required_arg("id")))
        .subcommand(
            Command::new("collection")
                .about("Read collection datasets")
                .subcommand_required(true)
                .subcommand(
                    Command::new("read")
                        .about("Read one table or media library collection")
                        .arg(Arg::new("notebook").long("notebook").required(true).num_args(1))
                        .arg(Arg::new("collection-id").long("id").num_args(1))
                        .arg(Arg::new("path").long("path").num_args(1))
                        .group(
                            clap::ArgGroup::new("selector")
                                .args(["collection-id", "path"])
                                .required(true)
                                .multiple(false),
                        ),
                ),
        )
        .subcommand(
            Command::new("edit")
                .about("Replace one exact occurrence in a note")
                .arg(required_arg("id"))
                .arg(
                    Arg::new("old")
                        .long("old")
                        .short('o')
                        .required(true)
                        .num_args(1..),
                )
                .arg(Arg::new("new").long("new").short('n').num_args(1..))
                .arg(
                    Arg::new("new-stdin")
                        .long("new-stdin")
                        .action(ArgAction::SetTrue),
                )
                .arg(Arg::new("new-file").long("new-file").num_args(1))
                .arg(
                    Arg::new("dry-run")
                        .long("dry-run")
                        .action(ArgAction::SetTrue),
                )
                .group(
                    clap::ArgGroup::new("replacement")
                        .args(["new", "new-stdin", "new-file"])
                        .required(true)
                        .multiple(false),
                ),
        )
        .subcommand(
            Command::new("write")
                .about("Replace a complete note; use --file for UTF-8 Markdown (recommended), or --stdin explicitly")
                .arg(required_arg("id"))
                .arg(Arg::new("file").long("file").short('f').value_name("UTF-8-MARKDOWN").help("Recommended: read Markdown content directly from a UTF-8 file").num_args(1))
                .arg(Arg::new("stdin").long("stdin").action(ArgAction::SetTrue).help("Read Markdown from stdin; required explicitly on Windows"))
                .group(clap::ArgGroup::new("input").args(["file", "stdin"]).multiple(false)),
        )
        .subcommand(
            Command::new("search")
                .about("Search Markdown note text")
                .arg(required_arg("query"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(
                    Arg::new("tag")
                        .long("tag")
                        .short('t')
                        .value_name("TAG-PATH")
                        .help("Only return notes tagged with this path or one of its sub-tags")
                        .num_args(1),
                )
                .arg(
                    Arg::new("limit")
                        .long("limit")
                        .short('l')
                        .value_parser(clap::value_parser!(usize))
                        .num_args(1),
                ),
        )
        .subcommand(
            Command::new("plugin")
                .about("Manage declared artifact tools")
                .subcommand_required(true)
                .subcommand(Command::new("list"))
                .subcommand(Command::new("describe").arg(required_arg("plugin-id")))
                .subcommand(
                    Command::new("create")
                        .arg(required_arg("plugin-id"))
                        .arg(
                            Arg::new("notebook")
                                .long("notebook")
                                .short('b')
                                .allow_hyphen_values(true)
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("source-note")
                                .long("source-note")
                                .allow_hyphen_values(true)
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("producer")
                                .long("producer")
                                .allow_hyphen_values(true)
                                .num_args(1),
                        ),
                ),
        )
        .subcommand(
            Command::new("columns")
                .about("Inspect or edit Notion-style content columns in a note")
                .subcommand_required(true)
                .subcommand(
                    Command::new("list")
                        .about("List columns blocks in a note")
                        .arg(required_arg("id")),
                )
                .subcommand(
                    Command::new("add")
                        .about("Insert an empty columns block")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("count")
                                .long("columns")
                                .short('c')
                                .value_parser(clap::value_parser!(usize))
                                .default_value("2")
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("at")
                                .long("at")
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        ),
                )
                .subcommand(
                    Command::new("remove")
                        .about("Remove one column and hoist its content")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("block")
                                .long("block")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("column")
                                .long("column")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        ),
                )
                .subcommand(
                    Command::new("width")
                        .about("Set column widths (comma-separated relative weights)")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("block")
                                .long("block")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("widths")
                                .long("widths")
                                .required(true)
                                .value_delimiter(',')
                                .num_args(1..)
                                .value_parser(clap::value_parser!(u32)),
                        ),
                ),
        )
        .subcommand(
            Command::new("background")
                .about("Inspect or edit line background colors in a note")
                .subcommand_required(true)
                .subcommand(
                    Command::new("list")
                        .about("List colored lines in a note")
                        .arg(required_arg("id")),
                )
                .subcommand(
                    Command::new("set")
                        .about("Set the background color of the text block containing --line")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("line")
                                .long("line")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("color")
                                .long("color")
                                .required(true)
                                .value_name("COLOR")
                                .num_args(1),
                        ),
                )
                .subcommand(
                    Command::new("clear")
                        .about("Clear the background color of the text block containing --line")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("line")
                                .long("line")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        ),
                ),
        )
        .subcommand(
            Command::new("callout")
                .about("Inspect or edit Flowus-style callouts in a note")
                .subcommand_required(true)
                .subcommand(
                    Command::new("list")
                        .about("List callouts in a note")
                        .arg(required_arg("id")),
                )
                .subcommand(
                    Command::new("add")
                        .about("Insert a callout (defaults: 💡 icon and orange background)")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("at")
                                .long("at")
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(Arg::new("icon").long("icon").value_name("EMOJI").num_args(1))
                        .arg(
                            Arg::new("color")
                                .long("color")
                                .value_name("COLOR")
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("content")
                                .long("content")
                                .value_name("TEXT")
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("file")
                                .long("file")
                                .short('f')
                                .value_name("UTF-8-MARKDOWN")
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("stdin")
                                .long("stdin")
                                .action(ArgAction::SetTrue),
                        )
                        .group(
                            clap::ArgGroup::new("callout-input")
                                .args(["content", "file", "stdin"])
                                .multiple(false),
                        ),
                )
                .subcommand(
                    Command::new("set")
                        .about("Update a callout's icon and/or background color")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("block")
                                .long("block")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(Arg::new("icon").long("icon").value_name("EMOJI").num_args(1))
                        .arg(
                            Arg::new("color")
                                .long("color")
                                .value_name("COLOR")
                                .num_args(1),
                        ),
                )
                .subcommand(
                    Command::new("remove")
                        .about("Remove a callout; keeps its content unless --delete-content is set")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("block")
                                .long("block")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("delete-content")
                                .long("delete-content")
                                .action(ArgAction::SetTrue),
                        ),
                ),
        )
        .subcommand(Command::new("completion").about("Generate shell completion").arg(required_arg("shell")))
        .subcommand(Command::new("mcp").about("Run the Flowix MCP server over stdio"))
}

fn required_arg(name: &'static str) -> Arg {
    let arg = Arg::new(name)
        .required(true)
        .allow_hyphen_values(true)
        .num_args(1);
    if name == "id" {
        arg.value_name("NOTEBOOK::RELATIVE-PATH-OR-ABSOLUTE-PATH")
    } else {
        arg
    }
}

fn required_string(matches: &clap::ArgMatches, name: &str) -> Result<String, CliError> {
    matches
        .get_one::<String>(name)
        .cloned()
        .ok_or_else(|| CliError::Usage(format!("missing required argument `{name}`")))
}

fn joined_values(matches: &clap::ArgMatches, name: &str) -> Option<String> {
    matches
        .get_many::<String>(name)
        .map(|values| values.map(String::as_str).collect::<Vec<_>>().join(" "))
}

fn clap_to_cli_error(err: clap::Error) -> CliError {
    CliError::Usage(err.to_string())
}
pub fn print_help() {
    let mut command = cli_command();
    let _ = command.print_long_help();
    println!();
}

#[cfg(test)]
mod tests;
