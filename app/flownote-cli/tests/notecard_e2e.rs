use flownote_core::memo_file::{MemoFile, NotebookConfig};
use serde_json::Value;
use std::process::Command;

fn seed_notebook(config_dir: &std::path::Path, notebook_dir: &std::path::Path) {
    std::fs::create_dir_all(notebook_dir).unwrap();
    let memo_file = MemoFile::new(config_dir.to_path_buf());
    memo_file
        .write_notebook_configs(&[NotebookConfig {
            id: "work".to_string(),
            name: "Work".to_string(),
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
    let output = Command::new(env!("CARGO_BIN_EXE_flownote-cli"))
        .args(args)
        .env("FLOWNOTE_HOME", config_dir)
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

fn run_failing(config_dir: &std::path::Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_flownote-cli"))
        .args(args)
        .env("FLOWNOTE_HOME", config_dir)
        .output()
        .unwrap();
    assert!(!output.status.success(), "command unexpectedly succeeded");
    let body: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(body["ok"], false);
    body
}

#[test]
fn cli_adds_lists_updates_and_removes_note_cards() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    let note = notebook_dir.join("note.md");
    std::fs::write(&note, "# Title\n\nbody\n").unwrap();
    std::fs::write(
        notebook_dir.join("Target.md"),
        "# Target note\n\nsome text\n",
    )
    .unwrap();

    let added = run(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "work::Target.md",
            "--layout",
            "cardLarge",
            "--color",
            "blue",
            "--text",
            "read this",
            "--json",
        ],
    );
    assert_eq!(added["ok"], true);
    assert_eq!(added["action"], "notecard.add");
    let block = &added["blocks"][0];
    assert_eq!(block["address"], "work::Target.md");
    assert_eq!(block["notebookId"], "work");
    assert_eq!(block["notebookName"], "Work");
    assert_eq!(block["relativePath"], "Target.md");
    assert_eq!(block["title"], "Target note");
    assert_eq!(block["layout"], "cardLarge");
    assert_eq!(block["color"], "blue");
    assert_eq!(block["customText"], "read this");
    // "# Title", "", "body", separator, card.
    assert_eq!(block["startLine"], 5);
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(
        body.starts_with("# Title\n\nbody\n\n::notecard{\"notebookId\":\"work\""),
        "{body}"
    );

    let listed = run(&config_dir, &["notecard", "list", "note.md", "--json"]);
    assert_eq!(listed["blocks"].as_array().unwrap().len(), 1);

    let updated = run(
        &config_dir,
        &[
            "notecard",
            "set",
            "note.md",
            "--block",
            "1",
            "--layout",
            "line",
            "--clear-color",
            "--title",
            "Custom",
            "--json",
        ],
    );
    let block = &updated["blocks"][0];
    assert_eq!(block["layout"], "line");
    assert_eq!(block["color"], "");
    assert_eq!(block["title"], "Custom");
    // Untouched presentation fields survive the rewrite.
    assert_eq!(block["customText"], "read this");
    assert_eq!(block["address"], "work::Target.md");

    let removed = run(
        &config_dir,
        &["notecard", "remove", "note.md", "--block", "1", "--json"],
    );
    assert!(removed["blocks"].as_array().unwrap().is_empty());
    let body = std::fs::read_to_string(&note).unwrap();
    assert!(!body.contains("::notecard"));
    assert!(body.contains("body"));
}

#[test]
fn cli_defaults_to_the_card_layout_and_resolves_bare_relative_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("note.md"), "# Title\n").unwrap();
    std::fs::write(notebook_dir.join("Target.md"), "# T\n").unwrap();

    let added = run(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "Target.md",
            "--at",
            "1",
            "--json",
        ],
    );
    let block = &added["blocks"][0];
    assert_eq!(block["layout"], "card");
    assert_eq!(block["color"], "");
    assert_eq!(block["customText"], "");
    assert_eq!(block["address"], "work::Target.md");
    assert_eq!(block["startLine"], 1);
}

#[test]
fn cli_references_a_canvas_by_file_stem() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("note.md"), "# Title\n").unwrap();
    std::fs::create_dir_all(notebook_dir.join("boards")).unwrap();
    std::fs::write(notebook_dir.join("boards").join("Plan.fanvas"), "{}").unwrap();

    let added = run(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "work::boards/Plan.fanvas",
            "--json",
        ],
    );
    let block = &added["blocks"][0];
    assert_eq!(block["address"], "work::boards/Plan.fanvas");
    assert_eq!(block["title"], "Plan");

    let missing = run_failing(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "work::boards/Nope.fanvas",
            "--json",
        ],
    );
    assert!(missing["error"]["message"]
        .as_str()
        .unwrap()
        .contains("canvas not found"));
}

#[test]
fn cli_rejects_missing_targets_and_invalid_values() {
    let tmp = tempfile::tempdir().unwrap();
    let config_dir = tmp.path().join("config");
    let notebook_dir = tmp.path().join("notebooks").join("work");
    seed_notebook(&config_dir, &notebook_dir);
    std::fs::write(notebook_dir.join("note.md"), "# Title\n").unwrap();
    std::fs::write(notebook_dir.join("Target.md"), "# T\n").unwrap();

    run_failing(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "work::Missing.md",
            "--json",
        ],
    );

    let layout = run_failing(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "Target.md",
            "--layout",
            "huge",
            "--json",
        ],
    );
    assert!(layout["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unknown note card layout"));

    let color = run_failing(
        &config_dir,
        &[
            "notecard",
            "add",
            "note.md",
            "--note",
            "Target.md",
            "--color",
            "teal",
            "--json",
        ],
    );
    assert!(color["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unknown note card color"));

    let conflict = run_failing(
        &config_dir,
        &[
            "notecard",
            "set",
            "note.md",
            "--block",
            "1",
            "--color",
            "red",
            "--clear-color",
            "--json",
        ],
    );
    assert!(conflict["error"]["message"]
        .as_str()
        .unwrap()
        .contains("at most one of color or clear-color"));

    let body = std::fs::read_to_string(notebook_dir.join("note.md")).unwrap();
    assert!(!body.contains("::notecard"));
}
