use super::*;
use crate::path_store;
#[allow(unused_imports)]
use crate::path_store::tests::ENV_LOCK;
use flowix_core::memo_file::NotebookConfig;

struct Notebook {
    root: std::path::PathBuf,
}

impl Drop for Notebook {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn notebook() -> Notebook {
    let root = std::env::temp_dir().join(format!(
        "flowix-cli-canvas-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let notebook_path = root.join("notes");
    std::fs::create_dir_all(&notebook_path).unwrap();
    let config_dir = root.join("config");
    let mf = flowix_core::memo_file::MemoFile::new(config_dir.clone());
    mf.write_notebook_configs(&[NotebookConfig {
        id: "work".into(),
        name: "Work".into(),
        icon: None,
        path: notebook_path.to_string_lossy().to_string(),
        is_default: true,
        sort: 0,
        created_at: 0,
        updated_at: 0,
    }])
    .unwrap();
    mf.write_selected_notebook_id(Some("work")).unwrap();
    Notebook { root }
}

fn placement(x: Option<f64>, y: Option<f64>, w: Option<f64>, h: Option<f64>) -> Placement {
    Placement { x, y, w, h }
}

#[test]
fn canvas_crud_round_trip() {
    let _lock = ENV_LOCK.lock().unwrap();
    let nb = notebook();
    let previous = std::env::var_os("FLOWIX_HOME");
    std::env::set_var("FLOWIX_HOME", nb.root.join("config"));
    let result = (|| -> Result<(), CliError> {
        // Create: unique file with the frontend's empty-document layout.
        let created = create(Some("work"), "计划", Some("画布"))?;
        let address = created["address"].as_str().unwrap().to_owned();
        assert_eq!(address, "work::画布/计划.flowix-canvas");
        let on_disk = std::fs::read_to_string(
            nb.root
                .join("notes")
                .join("画布")
                .join("计划.flowix-canvas"),
        )
        .unwrap();
        assert!(
            on_disk.starts_with("{\n  \"type\": \"flowix/canvas\""),
            "{on_disk}"
        );

        // Create again with the same name: ` (2)` suffix, like the dialog.
        let again = create(Some("work"), "计划", Some("画布"))?;
        assert_eq!(again["relativePath"], "画布/计划 (2).flowix-canvas");

        // A sticky card, auto-placed.
        let card = add_card(
            &address,
            None,
            Some("便签内容"),
            Some("blue"),
            None,
            placement(None, None, None, None),
        )?;
        let card_id = card["id"].as_str().unwrap().to_owned();
        assert!(card_id.starts_with("c_"));

        // A note referencing an existing note: identity + title snapshot.
        let note = path_store::create("work", "# 会议纪要\n正文\n")?;
        let note_address = note["note"]["address"].as_str().unwrap().to_owned();
        let note_card = add_card(
            &address,
            Some(&note_address),
            None,
            None,
            None,
            placement(Some(0.0), Some(0.0), None, None),
        )?;
        let note_card_id = note_card["id"].as_str().unwrap().to_owned();
        let shown = show(&address)?;
        assert_eq!(shown["counts"]["cards"], 2);
        let note_entry = shown["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == note_card_id.as_str())
            .unwrap()
            .clone();
        assert_eq!(note_entry["kind"], "note");
        assert_eq!(note_entry["notebookId"], "work");
        assert_eq!(note_entry["title"], "会议纪要");
        assert!(note_entry["path"].as_str().unwrap().ends_with(".md"));

        // Shapes / frames / edges.
        let shape = add_shape(
            &address,
            ShapeArgs {
                shape: "rect",
                text: Some("节点"),
                fill: None,
                stroke: None,
                placement: placement(Some(10.0), Some(10.0), Some(160.0), Some(100.0)),
                x2: None,
                y2: None,
            },
        )?;
        let shape_id = shape["id"].as_str().unwrap().to_owned();
        let frame = add_frame(
            &address,
            Some("Q4"),
            placement(Some(0.0), Some(0.0), Some(480.0), Some(360.0)),
        )?;
        let _ = frame["id"].as_str().unwrap();
        let edge = add_edge(&address, &note_card_id, &shape_id, Some("依赖"))?;
        assert!(edge["id"].as_str().unwrap().starts_with("e_"));
        // Duplicate edge is rejected.
        assert!(add_edge(&address, &note_card_id, &shape_id, None).is_err());

        // Batch note grid.
        let note2 = path_store::create("work", "# 第二篇\n")?;
        let note2_address = note2["note"]["address"].as_str().unwrap().to_owned();
        let batch = add_notes(
            &address,
            &[note_address.clone(), note2_address],
            GridPlan {
                columns: 2,
                gap_x: 40.0,
                gap_y: 40.0,
                w: Some(200.0),
                h: Some(100.0),
                start: Some((100.0, 100.0)),
            },
        )?;
        assert_eq!(batch["ids"].as_array().unwrap().len(), 2);

        // Remove cascades the edge but leaves the frame alone.
        let removed = remove(&address, &[note_card_id.clone(), card_id.clone()])?;
        assert_eq!(removed["removed"].as_array().unwrap().len(), 2);
        assert_eq!(removed["removedEdges"].as_array().unwrap().len(), 1);
        let shown = show(&address)?;
        assert_eq!(shown["counts"]["cards"], 2, "{shown}");
        assert_eq!(shown["counts"]["edges"], 0);
        assert_eq!(shown["counts"]["frames"], 1);
        assert_eq!(shown["counts"]["shapes"], 1);

        // Removing an unknown id is a NotFound.
        assert!(remove(&address, &["ghost".into()]).is_err());
        Ok(())
    })();
    if let Some(previous) = previous {
        std::env::set_var("FLOWIX_HOME", previous);
    } else {
        std::env::remove_var("FLOWIX_HOME");
    }
    result.unwrap();
}

#[test]
fn canvas_commands_validate_inputs() {
    let _lock = ENV_LOCK.lock().unwrap();
    let nb = notebook();
    let previous = std::env::var_os("FLOWIX_HOME");
    std::env::set_var("FLOWIX_HOME", nb.root.join("config"));
    let result = (|| -> Result<(), CliError> {
        let created = create(Some("work"), "空", None)?;
        let address = created["address"].as_str().unwrap().to_owned();

        // Sticky colors are validated.
        assert!(add_card(
            &address,
            None,
            Some("x"),
            Some("pink"),
            None,
            placement(None, None, None, None)
        )
        .is_err());
        // add-card needs a source.
        assert!(add_card(
            &address,
            None,
            None,
            None,
            None,
            placement(None, None, None, None)
        )
        .is_err());
        // Non-canvas addresses are rejected.
        assert!(show("work::notes/untitled.md").is_err());
        // Missing canvas is NotFound.
        assert!(show("work::ghost.flowix-canvas").is_err());
        // Folder traversal is rejected at create.
        assert!(create(Some("work"), "x", Some("../escape")).is_err());
        Ok(())
    })();
    if let Some(previous) = previous {
        std::env::set_var("FLOWIX_HOME", previous);
    } else {
        std::env::remove_var("FLOWIX_HOME");
    }
    result.unwrap();
}
