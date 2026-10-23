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
fn cli_adds_lists_resizes_and_removes_columns() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n\nbody\n").unwrap();

    let added = run(
        &config_dir,
        &["columns", "add", "note.md", "--columns", "2", "--json"],
    );
    assert_eq!(added["ok"], true);
    assert_eq!(added["blocks"][0]["columns"].as_array().unwrap().len(), 2);

    let listed = run(&config_dir, &["columns", "list", "note.md", "--json"]);
    assert_eq!(listed["blocks"][0]["columns"].as_array().unwrap().len(), 2);

    let resized = run(
        &config_dir,
        &[
            "columns", "width", "note.md", "--block", "1", "--widths", "50,150", "--json",
        ],
    );
    assert_eq!(resized["blocks"][0]["columns"][0]["width"], 50);
    assert_eq!(resized["blocks"][0]["columns"][1]["width"], 150);

    let removed = run(
        &config_dir,
        &[
            "columns", "remove", "note.md", "--block", "1", "--column", "1", "--json",
        ],
    );
    assert!(removed["blocks"].as_array().unwrap().is_empty());
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(!body.contains("::: columns"));
    assert!(body.contains(":::") == false);
}
