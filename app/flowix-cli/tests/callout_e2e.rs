use flowix_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::Value;
use std::process::Command;

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

fn run(config_dir: &std::path::Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(args)
        .env("FLOWIX_HOME", config_dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "command failed: {}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn cli_adds_lists_updates_and_removes_callouts() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n\nbody\n").unwrap();

    let added = run(
        &config_dir,
        &[
            "callout",
            "add",
            "note.md",
            "--content",
            "Heads up",
            "--icon",
            "✅",
            "--color",
            "green",
            "--json",
        ],
    );
    assert_eq!(added["ok"], true);
    assert_eq!(added["blocks"][0]["icon"], "✅");
    assert_eq!(added["blocks"][0]["color"], "green");
    assert_eq!(added["blocks"][0]["content"], "Heads up");

    let listed = run(&config_dir, &["callout", "list", "note.md", "--json"]);
    assert_eq!(listed["blocks"].as_array().unwrap().len(), 1);

    let updated = run(
        &config_dir,
        &[
            "callout", "set", "note.md", "--block", "1", "--icon", "⚠️", "--color", "yellow",
            "--json",
        ],
    );
    assert_eq!(updated["blocks"][0]["icon"], "⚠️");
    assert_eq!(updated["blocks"][0]["color"], "yellow");
    assert_eq!(updated["blocks"][0]["content"], "Heads up");

    let removed = run(
        &config_dir,
        &["callout", "remove", "note.md", "--block", "1", "--json"],
    );
    assert!(removed["blocks"].as_array().unwrap().is_empty());
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(!body.contains("::: callout"));
    // The default removes the container but keeps its content.
    assert!(body.contains("Heads up"));
}

#[test]
fn cli_uses_the_info_default_and_can_delete_content() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n").unwrap();

    let added = run(
        &config_dir,
        &[
            "callout",
            "add",
            "note.md",
            "--content",
            "Do not delete me",
            "--json",
        ],
    );
    assert_eq!(added["blocks"][0]["icon"], "💡");
    assert_eq!(added["blocks"][0]["color"], "orange");

    let removed = run(
        &config_dir,
        &[
            "callout",
            "remove",
            "note.md",
            "--block",
            "1",
            "--delete-content",
            "--json",
        ],
    );
    assert!(removed["blocks"].as_array().unwrap().is_empty());
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(!body.contains("::: callout"));
    assert!(!body.contains("Do not delete me"));
}

#[test]
fn cli_reads_callout_content_from_a_file() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n").unwrap();
    let body = tmp.path().join("body.md");
    std::fs::write(&body, "Line from a file").unwrap();

    let added = run(
        &config_dir,
        &[
            "callout",
            "add",
            "note.md",
            "--file",
            body.to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(added["blocks"][0]["content"], "Line from a file");
}

#[test]
fn cli_rejects_unknown_colors() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("note.md"), "# Title\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(["callout", "add", "note.md", "--color", "teal", "--json"])
        .env("FLOWIX_HOME", &config_dir)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let body: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(body["ok"], false);
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unknown callout color"));
}
