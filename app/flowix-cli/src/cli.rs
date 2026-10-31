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
    /// 列出一篇笔记的云端 (FNS note_history) 历史版本。
    CloudVersions {
        notebook: Option<String>,
        path: String,
        page: u32,
        json: bool,
    },
    /// 恢复一篇笔记到指定云端版本 (当前内容先本地自保为 restore_backup)。
    CloudRestore {
        notebook: Option<String>,
        path: String,
        history: i64,
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
    /// Inspect or edit Flowus-style toggle blocks in a note.
    Toggle {
        command: ToggleCommand,
        json: bool,
    },
    /// Create, inspect and edit `.flowix-canvas` board documents.
    Canvas {
        command: CanvasCommand,
        json: bool,
    },
    /// Model Context Protocol over stdio。向外部 Agent 暴露唯一工具
    /// `memo`，工具参数采用受限的 Flowix CLI 语法。
    Mcp,
}

#[derive(Debug)]
pub enum CanvasCommand {
    /// Create an empty canvas with a unique `<name>.flowix-canvas` filename.
    Create {
        notebook: Option<String>,
        name: Option<String>,
        folder: Option<String>,
    },
    Show {
        id: String,
    },
    /// Add a note card (referencing an existing note) or a sticky text card.
    AddCard {
        id: String,
        note: Option<String>,
        text: Option<String>,
        color: Option<String>,
        title: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    /// Add a diagram shape (rect/ellipse/diamond/text/arrow/line).
    AddShape {
        id: String,
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
    AddEdge {
        id: String,
        from: String,
        to: String,
        label: Option<String>,
    },
    AddFrame {
        id: String,
        title: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    /// Place several notes as a grid of note cards.
    AddNotes {
        id: String,
        notes: Vec<String>,
        columns: Option<usize>,
        x: Option<f64>,
        y: Option<f64>,
        gap_x: Option<f64>,
        gap_y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    },
    // Remove cards/shapes/frames/ink/edges by id (connected edges go with them).
    Remove {
        id: String,
        ids: Vec<String>,
    },
    // Move / resize / retext / relink one existing element.
    Update {
        id: String,
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

#[derive(Debug)]
pub enum ToggleCommand {
    List {
        id: String,
    },
    Add {
        id: String,
        at: Option<usize>,
        title: Option<String>,
        content: Option<String>,
        file: Option<String>,
        stdin: bool,
        open: bool,
        bg: Option<String>,
    },
    Set {
        id: String,
        block: usize,
        title: Option<String>,
        content: Option<String>,
        file: Option<String>,
        stdin: bool,
        open: Option<bool>,
        bg: Option<String>,
        clear_bg: bool,
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
        Some(("cloud-versions", sub)) => {
            let page = *sub.get_one::<u32>("page").unwrap_or(&1);
            if page == 0 {
                return Err(CliError::Usage("cloud-versions: --page requires a positive integer".into()));
            }
            Ok(Some(Cli::CloudVersions {
                notebook: sub.get_one::<String>("notebook").cloned(),
                path: required_string(sub, "path")?,
                page,
                json,
            }))
        }
        Some(("cloud-restore", sub)) => Ok(Some(Cli::CloudRestore {
            notebook: sub.get_one::<String>("notebook").cloned(),
            path: required_string(sub, "path")?,
            history: *sub.get_one::<i64>("history").unwrap_or(&0),
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
        Some(("toggle", sub)) => {
            let command = match sub.subcommand() {
                Some(("list", command)) => ToggleCommand::List {
                    id: required_string(command, "id")?,
                },
                Some(("add", command)) => ToggleCommand::Add {
                    id: required_string(command, "id")?,
                    at: command.get_one::<usize>("at").copied(),
                    title: command.get_one::<String>("title").cloned(),
                    content: command.get_one::<String>("content").cloned(),
                    file: command.get_one::<String>("file").cloned(),
                    stdin: command.get_flag("stdin"),
                    open: !command.get_flag("collapsed"),
                    bg: command.get_one::<String>("bg").cloned(),
                },
                Some(("set", command)) => {
                    let open = if command.get_flag("collapsed") {
                        Some(false)
                    } else if command.get_flag("open") {
                        Some(true)
                    } else {
                        None
                    };
                    ToggleCommand::Set {
                        id: required_string(command, "id")?,
                        block: *command.get_one::<usize>("block").unwrap_or(&1),
                        title: command.get_one::<String>("title").cloned(),
                        content: command.get_one::<String>("content").cloned(),
                        file: command.get_one::<String>("file").cloned(),
                        stdin: command.get_flag("stdin"),
                        open,
                        bg: command.get_one::<String>("bg").cloned(),
                        clear_bg: command.get_flag("clear-bg"),
                    }
                }
                Some(("remove", command)) => ToggleCommand::Remove {
                    id: required_string(command, "id")?,
                    block: *command.get_one::<usize>("block").unwrap_or(&1),
                    delete_content: command.get_flag("delete-content"),
                },
                Some((other, _)) => {
                    return Err(CliError::Usage(format!(
                        "unknown toggle command: `{other}`"
                    )))
                }
                None => {
                    return Err(CliError::Usage(format!(
                        "usage: {DISPLAY_BIN} toggle <list|add|set|remove>"
                    )))
                }
            };
            Ok(Some(Cli::Toggle { command, json }))
        }
        Some(("canvas", sub)) => {
            let optional_f64 = |command: &clap::ArgMatches, name: &str| command.get_one::<f64>(name).copied();
            let command = match sub.subcommand() {
                Some(("create", command)) => CanvasCommand::Create {
                    notebook: command.get_one::<String>("notebook").cloned(),
                    name: command.get_one::<String>("name").cloned(),
                    folder: command.get_one::<String>("folder").cloned(),
                },
                Some(("show", command)) => CanvasCommand::Show {
                    id: required_string(command, "id")?,
                },
                Some(("add-card", command)) => CanvasCommand::AddCard {
                    id: required_string(command, "id")?,
                    note: command.get_one::<String>("note").cloned(),
                    text: command.get_one::<String>("text").cloned(),
                    color: command.get_one::<String>("color").cloned(),
                    title: command.get_one::<String>("title").cloned(),
                    x: optional_f64(command, "x"),
                    y: optional_f64(command, "y"),
                    w: optional_f64(command, "w"),
                    h: optional_f64(command, "h"),
                },
                Some(("add-shape", command)) => CanvasCommand::AddShape {
                    id: required_string(command, "id")?,
                    shape: required_string(command, "shape")?,
                    text: command.get_one::<String>("text").cloned(),
                    fill: command.get_one::<String>("fill").cloned(),
                    stroke: command.get_one::<String>("stroke").cloned(),
                    x: optional_f64(command, "x"),
                    y: optional_f64(command, "y"),
                    w: optional_f64(command, "w"),
                    h: optional_f64(command, "h"),
                    x2: optional_f64(command, "x2"),
                    y2: optional_f64(command, "y2"),
                },
                Some(("add-edge", command)) => CanvasCommand::AddEdge {
                    id: required_string(command, "id")?,
                    from: required_string(command, "from")?,
                    to: required_string(command, "to")?,
                    label: command.get_one::<String>("label").cloned(),
                },
                Some(("add-frame", command)) => CanvasCommand::AddFrame {
                    id: required_string(command, "id")?,
                    title: command.get_one::<String>("title").cloned(),
                    x: optional_f64(command, "x"),
                    y: optional_f64(command, "y"),
                    w: optional_f64(command, "w"),
                    h: optional_f64(command, "h"),
                },
                Some(("add-notes", command)) => CanvasCommand::AddNotes {
                    id: required_string(command, "id")?,
                    notes: command
                        .get_many::<String>("notes")
                        .map(|values| values.cloned().collect())
                        .unwrap_or_default(),
                    columns: command.get_one::<usize>("columns").copied(),
                    x: optional_f64(command, "x"),
                    y: optional_f64(command, "y"),
                    gap_x: optional_f64(command, "gap-x"),
                    gap_y: optional_f64(command, "gap-y"),
                    w: optional_f64(command, "w"),
                    h: optional_f64(command, "h"),
                },
                Some(("remove", command)) => CanvasCommand::Remove {
                    id: required_string(command, "id")?,
                    ids: command
                        .get_many::<String>("ids")
                        .map(|values| values.cloned().collect())
                        .unwrap_or_default(),
                },
                Some(("update", command)) => CanvasCommand::Update {
                    id: required_string(command, "id")?,
                    element: required_string(command, "element")?,
                    x: optional_f64(command, "x"),
                    y: optional_f64(command, "y"),
                    w: optional_f64(command, "w"),
                    h: optional_f64(command, "h"),
                    x2: optional_f64(command, "x2"),
                    y2: optional_f64(command, "y2"),
                    text: command.get_one::<String>("text").cloned(),
                    color: command.get_one::<String>("color").cloned(),
                    fill: command.get_one::<String>("fill").cloned(),
                    stroke: command.get_one::<String>("stroke").cloned(),
                    label: command.get_one::<String>("label").cloned(),
                    from: command.get_one::<String>("from").cloned(),
                    to: command.get_one::<String>("to").cloned(),
                    title: command.get_one::<String>("title").cloned(),
                },
                Some((other, _)) => {
                    return Err(CliError::Usage(format!(
                        "unknown canvas command: `{other}`"
                    )))
                }
                None => {
                    return Err(CliError::Usage(format!(
                        "usage: {DISPLAY_BIN} canvas <create|show|add-card|add-shape|add-edge|add-frame|add-notes|remove>"
                    )))
                }
            };
            Ok(Some(Cli::Canvas { command, json }))
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
        .after_help("For Markdown content, --file is recommended (especially on Windows PowerShell 5.1). Files must be UTF-8. Note addresses use <notebook-id>::<relative-path> or an absolute path. Examples:\n  flowix create <notebook> --file body.md --json\n  flowix show work::Notes/Example.md --json\n  flowix write work::Notes/Example.md --file body.md --json\n  flowix list\n  flowix search TODO --tag project/flowix --limit 20\n  flowix background set work::Notes/Example.md --line 3 --color yellow --json\n  flowix callout add work::Notes/Example.md --icon \"⚠️\" --color yellow --content \"Check this\" --json\n  flowix toggle add work::Notes/Example.md --title \"Details\" --collapsed --bg yellow --content \"Hidden body\" --json\n  flowix collection read --notebook <notebook-id> --id <collection-id> --json\n  flowix collection read --notebook <notebook-id> --path 'Assets/Images.index.yaml' --json\n  flowix canvas create work --name 计划 --json\n  flowix canvas add-card work::画布/计划.flowix-canvas --note work::Notes/Example.md --json\n  flowix canvas add-notes work::画布/计划.flowix-canvas --notes work::A.md,work::B.md --columns 3 --json\n  flowix mcp")
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
            Command::new("cloud-versions")
                .about("List cloud (FNS note_history) versions of a note")
                .arg(required_arg("path"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(Arg::new("page").long("page").num_args(1).value_parser(clap::value_parser!(u32)).help("1-based page, 20 per page")),
        )
        .subcommand(
            Command::new("cloud-restore")
                .about("Restore a note to a cloud version (current content is archived locally as restore_backup first)")
                .arg(required_arg("path"))
                .arg(Arg::new("notebook").long("notebook").short('b').num_args(1))
                .arg(Arg::new("history").long("history").required(true).num_args(1).value_parser(clap::value_parser!(i64)).help("Cloud history id, from cloud-versions")),
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
        .subcommand(
            Command::new("toggle")
                .about("Inspect or edit Flowus-style toggle blocks in a note")
                .subcommand_required(true)
                .subcommand(
                    Command::new("list")
                        .about("List toggle blocks in a note")
                        .arg(required_arg("id")),
                )
                .subcommand(
                    Command::new("add")
                        .about("Insert a toggle (title and body may be empty; open by default)")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("at")
                                .long("at")
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("title")
                                .long("title")
                                .value_name("MARKDOWN")
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
                            clap::ArgGroup::new("toggle-input")
                                .args(["content", "file", "stdin"])
                                .multiple(false),
                        )
                        .arg(
                            Arg::new("collapsed")
                                .long("collapsed")
                                .action(ArgAction::SetTrue),
                        )
                        .arg(
                            Arg::new("bg")
                                .long("bg")
                                .value_name("COLOR")
                                .num_args(1),
                        ),
                )
                .subcommand(
                    Command::new("set")
                        .about("Update a toggle's title, body, fold state or background")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("block")
                                .long("block")
                                .required(true)
                                .value_parser(clap::value_parser!(usize))
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("title")
                                .long("title")
                                .value_name("MARKDOWN")
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
                            clap::ArgGroup::new("toggle-set-input")
                                .args(["content", "file", "stdin"])
                                .multiple(false),
                        )
                        .arg(
                            Arg::new("collapsed")
                                .long("collapsed")
                                .action(ArgAction::SetTrue),
                        )
                        .arg(
                            Arg::new("open")
                                .long("open")
                                .action(ArgAction::SetTrue)
                                .conflicts_with("collapsed"),
                        )
                        .arg(
                            Arg::new("bg")
                                .long("bg")
                                .value_name("COLOR")
                                .num_args(1)
                                .conflicts_with("clear-bg"),
                        )
                        .arg(
                            Arg::new("clear-bg")
                                .long("clear-bg")
                                .action(ArgAction::SetTrue),
                        ),
                )
                .subcommand(
                    Command::new("remove")
                        .about("Remove a toggle; keeps its title and body unless --delete-content is set")
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
        .subcommand(
            Command::new("canvas")
                .about("Create, inspect and edit .flowix-canvas board documents")
                .subcommand_required(true)
                .subcommand(
                    Command::new("create")
                        .about("Create an empty canvas with a unique filename")
                        .arg(
                            Arg::new("notebook")
                                .allow_hyphen_values(true)
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("name")
                                .long("name")
                                .value_name("NAME")
                                .help("Canvas name (filename stem); defaults to Untitled")
                                .num_args(1),
                        )
                        .arg(
                            Arg::new("folder")
                                .long("folder")
                                .value_name("DIR")
                                .help("Notebook-relative target folder")
                                .num_args(1),
                        ),
                )
                .subcommand(Command::new("show").about("Show the board as a normalized summary").arg(required_arg("id")))
                .subcommand(
                    Command::new("add-card")
                        .about("Add a note card (--note) or a sticky text card (--text)")
                        .arg(required_arg("id"))
                        .arg(Arg::new("note").long("note").value_name("NOTE-ADDRESS").num_args(1))
                        .arg(Arg::new("text").long("text").value_name("TEXT").num_args(1))
                        .arg(Arg::new("color").long("color").value_name("COLOR").help("Sticky tint: yellow/red/green/blue/purple").num_args(1))
                        .arg(Arg::new("title").long("title").value_name("TITLE").help("Card title snapshot (overrides the note title)").num_args(1))
                        .arg(Arg::new("x").long("x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y").long("y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("w").long("w").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("h").long("h").value_parser(clap::value_parser!(f64)).num_args(1))
                        .group(clap::ArgGroup::new("card-source").args(["note", "text"]).required(true).multiple(false)),
                )
                .subcommand(
                    Command::new("add-shape")
                        .about("Add a rect/ellipse/diamond/text/arrow/line shape")
                        .arg(required_arg("id"))
                        .arg(Arg::new("shape").long("shape").value_name("KIND").num_args(1))
                        .arg(Arg::new("text").long("text").value_name("TEXT").num_args(1))
                        .arg(Arg::new("fill").long("fill").value_name("COLOR").num_args(1))
                        .arg(Arg::new("stroke").long("stroke").value_name("COLOR").num_args(1))
                        .arg(Arg::new("x").long("x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y").long("y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("w").long("w").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("h").long("h").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("x2").long("x2").value_parser(clap::value_parser!(f64)).help("Arrow/line head X").num_args(1))
                        .arg(Arg::new("y2").long("y2").value_parser(clap::value_parser!(f64)).help("Arrow/line head Y").num_args(1)),
                )
                .subcommand(
                    Command::new("add-edge")
                        .about("Connect two cards/shapes with a labeled edge")
                        .arg(required_arg("id"))
                        .arg(Arg::new("from").long("from").value_name("ELEMENT-ID").num_args(1))
                        .arg(Arg::new("to").long("to").value_name("ELEMENT-ID").num_args(1))
                        .arg(Arg::new("label").long("label").value_name("TEXT").num_args(1)),
                )
                .subcommand(
                    Command::new("add-frame")
                        .about("Add a grouping frame (defaults to 480x360, auto-placed)")
                        .arg(required_arg("id"))
                        .arg(Arg::new("title").long("title").value_name("TITLE").num_args(1))
                        .arg(Arg::new("x").long("x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y").long("y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("w").long("w").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("h").long("h").value_parser(clap::value_parser!(f64)).num_args(1)),
                )
                .subcommand(
                    Command::new("add-notes")
                        .about("Place notes as a grid of note cards (auto-placed beside existing content)")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("notes")
                                .long("notes")
                                .value_name("NOTE-ADDRESS")
                                .value_delimiter(',')
                                .num_args(1..)
                                .help("Comma-separated note addresses"),
                        )
                        .arg(Arg::new("columns").long("columns").value_parser(clap::value_parser!(usize)).num_args(1))
                        .arg(Arg::new("x").long("x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y").long("y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("gap-x").long("gap-x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("gap-y").long("gap-y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("w").long("w").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("h").long("h").value_parser(clap::value_parser!(f64)).num_args(1)),
                )
                .subcommand(
                    Command::new("remove")
                        .about("Remove elements by id (connected edges are removed too)")
                        .arg(required_arg("id"))
                        .arg(
                            Arg::new("ids")
                                .long("ids")
                                .value_name("ELEMENT-ID")
                                .value_delimiter(',')
                                .num_args(1..),
                        ),
                )
                .subcommand(
                    Command::new("update")
                        .about("Move, resize, retext or relink one element by id")
                        .arg(required_arg("id"))
                        .arg(Arg::new("element").long("element").value_name("ELEMENT-ID").help("Element id to update (from canvas show)").num_args(1))
                        .arg(Arg::new("x").long("x").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y").long("y").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("w").long("w").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("h").long("h").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("x2").long("x2").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("y2").long("y2").value_parser(clap::value_parser!(f64)).num_args(1))
                        .arg(Arg::new("text").long("text").value_name("TEXT").num_args(1))
                        .arg(Arg::new("color").long("color").value_name("COLOR").num_args(1))
                        .arg(Arg::new("fill").long("fill").value_name("COLOR").num_args(1))
                        .arg(Arg::new("stroke").long("stroke").value_name("COLOR").num_args(1))
                        .arg(Arg::new("label").long("label").value_name("TEXT").num_args(1))
                        .arg(Arg::new("from").long("from").value_name("ELEMENT-ID").num_args(1))
                        .arg(Arg::new("to").long("to").value_name("ELEMENT-ID").num_args(1))
                        .arg(Arg::new("title").long("title").value_name("TITLE").num_args(1)),
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
