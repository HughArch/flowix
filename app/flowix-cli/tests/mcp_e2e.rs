use flowix_core::{memo_file::{MemoFile, NotebookConfig}, NoteService};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

fn seed_notebook(config_dir: &std::path::Path, notebook_dir: &std::path::Path) {
    std::fs::create_dir_all(notebook_dir).unwrap();
    let memo_file = MemoFile::new(config_dir.to_path_buf());
    memo_file
        .write_notebook_configs(&[NotebookConfig {
            id: "work".to_string(),
            name: "work".to_string(),
            icon: None,
            path: format!("{}/", notebook_dir.display()),
            is_default: true,
            sort: 0,
            created_at: 1,
            updated_at: 1,
        }])
        .unwrap();
}

fn spawn_mcp(config_dir: &std::path::Path) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .arg("mcp")
        .env("FLOWIX_HOME", config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, stdout)
}

fn request(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    )
    .unwrap();
    stdin.flush().unwrap();

    let mut response = String::new();
    stdout.read_line(&mut response).unwrap();
    assert!(!response.trim().is_empty());
    serde_json::from_str(&response).unwrap()
}

fn call_tool(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    command: &str,
    content: Option<&str>,
) -> Value {
    let mut arguments = json!({"command": command});
    if let Some(content) = content {
        arguments["stdin"] = Value::String(content.to_string());
    }
    request(
        stdin,
        stdout,
        id,
        "tools/call",
        json!({"name": "memo", "arguments": arguments}),
    )
}

fn call_structured(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    id: u64,
    arguments: Value,
) -> Value {
    request(
        stdin,
        stdout,
        id,
        "tools/call",
        json!({"name": "memo", "arguments": arguments}),
    )
}

#[test]
fn mcp_process_initializes_and_exposes_one_tool() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let initialized = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );
    assert_eq!(initialized["jsonrpc"], "2.0");
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(initialized["result"]["serverInfo"]["name"], "flowix-memo");

    let listed = request(&mut stdin, &mut stdout, 2, "tools/list", json!({}));
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "memo");
    assert!(tools[0]["inputSchema"]["properties"]["action"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action == "create"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn mcp_tool_creates_reads_and_rejects_shell_syntax() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let created = call_tool(
        &mut stdin,
        &mut stdout,
        1,
        "create work",
        Some("# MCP note\n\ncreated through one tool\n"),
    );
    assert_eq!(created["result"]["isError"], false);
    let address = created["result"]["structuredContent"]["note"]["address"]
        .as_str()
        .unwrap()
        .to_string();

    let shown = call_tool(&mut stdin, &mut stdout, 2, &format!("show {address}"), None);
    assert_eq!(shown["result"]["isError"], false);
    assert!(shown["result"]["structuredContent"]["body"]
        .as_str()
        .unwrap()
        .contains("created through one tool"));

    let rejected = call_tool(&mut stdin, &mut stdout, 3, "show note; rm -rf ~", None);
    assert_eq!(rejected["result"]["isError"], true);
    assert_eq!(
        rejected["result"]["structuredContent"]["error"]["code"],
        "INVALID_COMMAND"
    );
    assert!(rejected["result"]["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("shell syntax"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn structured_actions_create_edit_list_and_show_without_cli_strings() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let created = call_structured(
        &mut stdin,
        &mut stdout,
        1,
        json!({"action":"create", "content":"# 结构化 MCP\n\n首次正确生成\n"}),
    );
    assert_eq!(created["result"]["isError"], false, "{created}");
    let address = created["result"]["structuredContent"]["note"]["address"]
        .as_str()
        .unwrap()
        .to_string();

    let edited = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({"action":"edit", "address":address, "old":"首次正确生成", "content":"结构化编辑成功"}),
    );
    assert_eq!(edited["result"]["isError"], false, "{edited}");

    let listed = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({"action":"list", "limit":1, "offset":0}),
    );
    assert_eq!(
        listed["result"]["structuredContent"]["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let tags = call_structured(&mut stdin, &mut stdout, 4, json!({"action":"tags"}));
    assert_eq!(tags["result"]["isError"], false, "{tags}");
    assert!(tags["result"]["structuredContent"]["tags"].is_array());

    let shown = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({"action":"show", "address":address}),
    );
    assert!(shown["result"]["structuredContent"]["body"]
        .as_str()
        .unwrap()
        .contains("结构化编辑成功"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn structured_columns_actions_add_resize_and_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("columns.md"), "# Title\n\nbody\n").unwrap();

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let _ = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );

    let added = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({"action":"columns.add", "address":"columns.md", "count":2}),
    );
    assert_eq!(added["result"]["isError"], false, "{added}");
    assert_eq!(
        added["result"]["structuredContent"]["blocks"][0]["columns"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let listed = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({"action":"columns.list", "address":"columns.md"}),
    );
    assert_eq!(listed["result"]["isError"], false, "{listed}");
    assert_eq!(
        listed["result"]["structuredContent"]["blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let resized = call_structured(
        &mut stdin,
        &mut stdout,
        4,
        json!({"action":"columns.width", "address":"columns.md", "block":1, "widths":[50,150]}),
    );
    assert_eq!(resized["result"]["isError"], false, "{resized}");
    assert_eq!(
        resized["result"]["structuredContent"]["blocks"][0]["columns"][0]["width"],
        50
    );

    let removed = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({"action":"columns.remove", "address":"columns.md", "block":1, "column":1}),
    );
    assert_eq!(removed["result"]["isError"], false, "{removed}");
    assert!(removed["result"]["structuredContent"]["blocks"]
        .as_array()
        .unwrap()
        .is_empty());

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn structured_callout_actions_add_update_and_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("callout.md"), "# Title\n\nbody\n").unwrap();

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let _ = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );

    let added = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({
            "action": "callout.add",
            "address": "callout.md",
            "content": "Heads up",
            "icon": "✅",
            "color": "green"
        }),
    );
    assert_eq!(added["result"]["isError"], false, "{added}");
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["icon"], "✅");
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["color"], "green");
    assert_eq!(
        added["result"]["structuredContent"]["blocks"][0]["content"],
        "Heads up"
    );

    let updated = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({
            "action": "callout.set",
            "address": "callout.md",
            "block": 1,
            "icon": "⚠️",
            "color": "yellow"
        }),
    );
    assert_eq!(updated["result"]["isError"], false, "{updated}");
    assert_eq!(updated["result"]["structuredContent"]["blocks"][0]["icon"], "⚠️");
    assert_eq!(updated["result"]["structuredContent"]["blocks"][0]["color"], "yellow");

    let removed = call_structured(
        &mut stdin,
        &mut stdout,
        4,
        json!({
            "action": "callout.remove",
            "address": "callout.md",
            "block": 1,
            "keepContent": false
        }),
    );
    assert_eq!(removed["result"]["isError"], false, "{removed}");
    assert!(removed["result"]["structuredContent"]["blocks"]
        .as_array()
        .unwrap()
        .is_empty());
    let body = std::fs::read_to_string(notebook_dir.join("callout.md")).unwrap();
    assert!(!body.contains("Heads up"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn structured_toggle_actions_add_update_and_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("toggle.md"), "# Title\n\nbody\n").unwrap();

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let _ = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );

    let added = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({
            "action": "toggle.add",
            "address": "toggle.md",
            "title": "Details",
            "content": "Hidden body",
            "open": false,
            "bg": "yellow"
        }),
    );
    assert_eq!(added["result"]["isError"], false, "{added}");
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["title"], "Details");
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["body"], "Hidden body");
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["open"], false);
    assert_eq!(added["result"]["structuredContent"]["blocks"][0]["bg"], "yellow");

    let updated = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({
            "action": "toggle.set",
            "address": "toggle.md",
            "block": 1,
            "title": "New title",
            "open": true,
            "clearBg": true
        }),
    );
    assert_eq!(updated["result"]["isError"], false, "{updated}");
    assert_eq!(updated["result"]["structuredContent"]["blocks"][0]["title"], "New title");
    assert_eq!(updated["result"]["structuredContent"]["blocks"][0]["open"], true);
    assert_eq!(
        updated["result"]["structuredContent"]["blocks"][0]["bg"],
        serde_json::Value::Null
    );

    let removed = call_structured(
        &mut stdin,
        &mut stdout,
        4,
        json!({
            "action": "toggle.remove",
            "address": "toggle.md",
            "block": 1,
            "keepContent": false
        }),
    );
    assert_eq!(removed["result"]["isError"], false, "{removed}");
    assert!(removed["result"]["structuredContent"]["blocks"]
        .as_array()
        .unwrap()
        .is_empty());
    let body = std::fs::read_to_string(notebook_dir.join("toggle.md")).unwrap();
    assert!(!body.contains("Hidden body"));
    assert!(!body.contains("::: toggle"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn search_tag_filter_is_shared_by_structured_and_legacy_mcp() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let tagged = call_tool(
        &mut stdin,
        &mut stdout,
        1,
        "create work",
        Some("---\ntags: [项目/Flowix/CLI]\n---\n# 发布计划\n"),
    );
    assert_eq!(tagged["result"]["isError"], false, "{tagged}");

    let untagged = call_tool(
        &mut stdin,
        &mut stdout,
        2,
        "create work",
        Some("# 其他笔记\n\n发布计划在正文中，但没有项目标签。\n"),
    );
    assert_eq!(untagged["result"]["isError"], false, "{untagged}");

    let structured = call_structured(
        &mut stdin,
        &mut stdout,
        3,
        json!({
            "action": "search",
            "query": "发布计划",
            "tag": "#项目/Flowix",
            "limit": 20
        }),
    );
    assert_eq!(structured["result"]["isError"], false, "{structured}");
    assert_eq!(
        structured["result"]["structuredContent"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "{structured}"
    );

    let legacy = call_tool(
        &mut stdin,
        &mut stdout,
        4,
        "search 发布计划 --tag 项目/Flowix --json",
        None,
    );
    assert_eq!(legacy["result"]["isError"], false, "{legacy}");
    assert_eq!(
        legacy["result"]["structuredContent"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let invalid = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({
            "action": "search",
            "query": "发布计划",
            "tag": "项目//Flowix"
        }),
    );
    assert_eq!(invalid["result"]["isError"], true, "{invalid}");
    assert_eq!(
        invalid["result"]["structuredContent"]["error"]["code"],
        "INVALID_COMMAND"
    );
    assert!(invalid["result"]["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("valid tag path"));

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn concurrent_mcp_processes_do_not_overwrite_each_other() {
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};
    use std::thread;

    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);

    let barrier = Arc::new(Barrier::new(2));
    let handles = ["first process", "second process"]
        .into_iter()
        .map(|marker| {
            let barrier = barrier.clone();
            let config_dir = config_dir.clone();
            thread::spawn(move || {
                let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
                barrier.wait();
                let response = call_tool(
                    &mut stdin,
                    &mut stdout,
                    1,
                    "create work",
                    Some(&format!("# Concurrent note\n\n{marker}\n")),
                );
                assert_eq!(response["result"]["isError"], false, "{response}");
                drop(stdin);
                assert!(child.wait().unwrap().success());
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().expect("MCP process thread");
    }

    let memo_file = MemoFile::new(config_dir);
    let notes = NoteService::new(&memo_file).list("work").unwrap();
    assert_eq!(notes.len(), 2);
    let filenames = notes
        .iter()
        .map(|note| note.relative_path.clone())
        .collect::<HashSet<_>>();
    assert_eq!(filenames.len(), 2);
    let bodies = notes
        .iter()
        .map(|note| std::fs::read_to_string(notebook_dir.join(&note.relative_path)).unwrap())
        .collect::<Vec<_>>();
    assert!(bodies.iter().any(|body| body.contains("first process")));
    assert!(bodies.iter().any(|body| body.contains("second process")));
}

#[test]
fn structured_background_actions_set_list_and_clear() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(
        notebook_dir.join("background.md"),
        "# Title\n\nbody\n\n- item\n",
    )
    .unwrap();

    let (mut child, mut stdin, mut stdout) = spawn_mcp(&config_dir);
    let _ = request(
        &mut stdin,
        &mut stdout,
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "flowix-test", "version": "1"}
        }),
    );

    let set = call_structured(
        &mut stdin,
        &mut stdout,
        2,
        json!({"action":"background.set", "address":"background.md", "line":3, "color":"yellow"}),
    );
    assert_eq!(set["result"]["isError"], false, "{set}");
    assert_eq!(
        set["result"]["structuredContent"]["blocks"][0]["color"],
        "yellow"
    );
    assert_eq!(
        set["result"]["structuredContent"]["blocks"][0]["start_line"],
        3
    );

    let legacy = call_tool(
        &mut stdin,
        &mut stdout,
        3,
        "background set background.md --line 5 --color blue",
        None,
    );
    assert_eq!(legacy["result"]["isError"], false, "{legacy}");

    let listed = call_structured(
        &mut stdin,
        &mut stdout,
        4,
        json!({"action":"background.list", "address":"background.md"}),
    );
    assert_eq!(listed["result"]["isError"], false, "{listed}");
    let blocks = listed["result"]["structuredContent"]["blocks"]
        .as_array()
        .unwrap();
    assert_eq!(blocks.len(), 2);
    assert!(blocks.iter().any(|block| block["color"] == "yellow"));
    assert!(blocks.iter().any(|block| block["color"] == "blue"));

    let cleared = call_structured(
        &mut stdin,
        &mut stdout,
        5,
        json!({"action":"background.clear", "address":"background.md", "line":3}),
    );
    assert_eq!(cleared["result"]["isError"], false, "{cleared}");
    assert_eq!(
        cleared["result"]["structuredContent"]["blocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let rejected = call_structured(
        &mut stdin,
        &mut stdout,
        6,
        json!({"action":"background.set", "address":"background.md", "line":3, "color":"chartreuse"}),
    );
    assert_eq!(rejected["result"]["isError"], true, "{rejected}");

    drop(stdin);
    assert!(child.wait().unwrap().success());
}
