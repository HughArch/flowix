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
fn cli_adds_lists_updates_and_removes_toggles() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n\nbody\n").unwrap();

    let added = run(
        &config_dir,
        &[
            "toggle",
            "add",
            "note.md",
            "--title",
            "Details",
            "--content",
            "Hidden body",
            "--collapsed",
            "--bg",
            "yellow",
            "--json",
        ],
    );
    assert_eq!(added["ok"], true);
    assert_eq!(added["blocks"][0]["title"], "Details");
    assert_eq!(added["blocks"][0]["body"], "Hidden body");
    assert_eq!(added["blocks"][0]["open"], false);
    assert_eq!(added["blocks"][0]["bg"], "yellow");

    let listed = run(&config_dir, &["toggle", "list", "note.md", "--json"]);
    assert_eq!(listed["blocks"].as_array().unwrap().len(), 1);

    let updated = run(
        &config_dir,
        &[
            "toggle", "set", "note.md", "--block", "1", "--title", "New title", "--open", "--bg",
            "green", "--json",
        ],
    );
    assert_eq!(updated["blocks"][0]["title"], "New title");
    assert_eq!(updated["blocks"][0]["body"], "Hidden body");
    assert_eq!(updated["blocks"][0]["open"], true);
    assert_eq!(updated["blocks"][0]["bg"], "green");

    let cleared = run(
        &config_dir,
        &[
            "toggle", "set", "note.md", "--block", "1", "--clear-bg", "--json",
        ],
    );
    assert_eq!(cleared["blocks"][0]["bg"], Value::Null);

    let removed = run(
        &config_dir,
        &["toggle", "remove", "note.md", "--block", "1", "--json"],
    );
    assert!(removed["blocks"].as_array().unwrap().is_empty());
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(!body.contains("::: toggle"));
    // The default removes the container but keeps its title and body.
    assert!(body.contains("New title"));
    assert!(body.contains("Hidden body"));
}

#[test]
fn cli_can_delete_the_toggle_content() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n").unwrap();

    let added = run(
        &config_dir,
        &[
            "toggle",
            "add",
            "note.md",
            "--title",
            "Do not delete me",
            "--content",
            "Body too",
            "--json",
        ],
    );
    assert_eq!(added["blocks"][0]["open"], true);

    let removed = run(
        &config_dir,
        &[
            "toggle",
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
    assert!(!body.contains("::: toggle"));
    assert!(!body.contains("Do not delete me"));
    assert!(!body.contains("Body too"));
}

#[test]
fn cli_reads_toggle_body_from_a_file() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n").unwrap();
    let body = tmp.path().join("body.md");
    std::fs::write(&body, "- item one\n- item two").unwrap();

    let added = run(
        &config_dir,
        &[
            "toggle",
            "add",
            "note.md",
            "--title",
            "List",
            "--file",
            body.to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(added["blocks"][0]["title"], "List");
    assert_eq!(added["blocks"][0]["body"], "- item one\n- item two");
}

#[test]
fn cli_rejects_unknown_toggle_colors() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("note.md"), "# Title\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_flowix-cli"))
        .args(["toggle", "add", "note.md", "--bg", "teal", "--json"])
        .env("FLOWIX_HOME", &config_dir)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let body: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(body["ok"], false);
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unknown toggle background color"));
}
