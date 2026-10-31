use super::*;

const NOW: &str = "2026-10-31T08:00:00.000Z";

#[test]
fn create_text_matches_frontend_layout() {
    assert_eq!(
        CanvasDocument::create_text(NOW),
        "{\n  \"type\": \"flowix/canvas\",\n  \"version\": 1,\n  \"meta\": {\n    \"createdAt\": \"2026-10-31T08:00:00.000Z\",\n    \"updatedAt\": \"2026-10-31T08:00:00.000Z\"\n  },\n  \"elements\": [],\n  \"cards\": [],\n  \"shapes\": [],\n  \"ink\": [],\n  \"edges\": [],\n  \"frames\": [],\n  \"files\": {}\n}\n"
    );
}

#[test]
fn parse_serialize_round_trip_is_byte_stable() {
    // Fully pretty-printed, exactly how the frontend's
    // `JSON.stringify(document, null, 2)` stores a board document.
    let stored = r##"{
  "type": "flowix/canvas",
  "version": 1,
  "meta": {
    "createdAt": "2026-01-02T03:04:05.678Z",
    "updatedAt": "2026-01-03T03:04:05.678Z"
  },
  "elements": [],
  "cards": [
    {
      "id": "c_1",
      "kind": "note",
      "x": 0,
      "y": 20,
      "w": 320,
      "h": 220,
      "z": 3,
      "notebookId": "nb1",
      "notebookName": "Work",
      "path": "a/b.md",
      "title": "标题"
    },
    {
      "id": "c_2",
      "kind": "text",
      "x": -12.5,
      "y": 0,
      "w": 220,
      "h": 180,
      "text": "便签",
      "color": "blue"
    }
  ],
  "shapes": [
    {
      "id": "s_1",
      "shape": "ellipse",
      "x": 10,
      "y": 10,
      "w": 160,
      "h": 100,
      "fill": "#ffe3e3",
      "text": "节点"
    },
    {
      "id": "s_2",
      "shape": "arrow",
      "x": 0,
      "y": 0,
      "x2": 160,
      "y2": -40.5,
      "w": 160,
      "h": 40.5
    }
  ],
  "ink": [],
  "edges": [
    {
      "id": "e_1",
      "from": "c_1",
      "to": "s_1",
      "label": "依赖"
    }
  ],
  "frames": [
    {
      "id": "f_1",
      "title": "Q4",
      "x": 0,
      "y": 0,
      "w": 480,
      "h": 360
    }
  ],
  "files": {
    "img1": {
      "id": "img1",
      "mimeType": "image/png",
      "storageKey": "attachments/img1.png"
    }
  },
  "appState": {
    "viewport": {
      "x": 12,
      "y": -3,
      "zoom": 0.8
    },
    "futureKey": {
      "keep": true
    }
  }
}"##;
    let document = CanvasDocument::parse(stored, NOW).unwrap();
    assert_eq!(document.serialize(), format!("{stored}\n"));
    // Round two: parsing our own output is byte-stable too.
    let reparsed = CanvasDocument::parse(&document.serialize(), NOW).unwrap();
    assert_eq!(reparsed.serialize(), document.serialize());
    assert_eq!(document.viewport(), Some((12.0, -3.0, 0.8)));
}

/// Hand-written compact JSON parses fine; the first save re-indents it but
/// content (ids, numbers, unknown keys) survives untouched.
#[test]
fn compact_input_round_trips_without_content_loss() {
    let stored = r##"{
  "type": "flowix/canvas",
  "version": 1,
  "meta": {"createdAt": "2026-01-02T03:04:05.678Z", "updatedAt": "2026-01-03T03:04:05.678Z"},
  "elements": [],
  "cards": [
    {"id": "c_1", "kind": "note", "x": 0, "y": 20, "w": 320, "h": 220, "z": 3,
     "notebookId": "nb1", "notebookName": "Work", "path": "a/b.md", "title": "标题"},
    {"id": "c_2", "kind": "text", "x": -12.5, "y": 0, "w": 220, "h": 180, "text": "便签", "color": "blue"}
  ],
  "shapes": [
    {"id": "s_1", "shape": "ellipse", "x": 10, "y": 10, "w": 160, "h": 100, "fill": "#ffe3e3", "text": "节点"},
    {"id": "s_2", "shape": "arrow", "x": 0, "y": 0, "x2": 160, "y2": -40.5, "w": 160, "h": 40.5}
  ],
  "ink": [],
  "edges": [{"id": "e_1", "from": "c_1", "to": "s_1", "label": "依赖"}],
  "frames": [{"id": "f_1", "title": "Q4", "x": 0, "y": 0, "w": 480, "h": 360}],
  "files": {"img1": {"id": "img1", "mimeType": "image/png", "storageKey": "attachments/img1.png"}},
  "appState": {"viewport": {"x": 12, "y": -3, "zoom": 0.8}, "futureKey": {"keep": true}}
}"##;
    let document = CanvasDocument::parse(stored, NOW).unwrap();
    let first = document.serialize();
    let reparsed = CanvasDocument::parse(&first, NOW).unwrap();
    assert_eq!(reparsed.serialize(), first);
    assert_eq!(document.created_at, "2026-01-02T03:04:05.678Z");
    assert_eq!(document.updated_at, "2026-01-03T03:04:05.678Z");
    assert_eq!(document.board_cards().len(), 2);
    assert_eq!(document.board_cards()[0].path.as_deref(), Some("a/b.md"));
    assert_eq!(document.board_cards()[0].title.as_deref(), Some("标题"));
    assert_eq!(document.board_cards()[1].color.as_deref(), Some("blue"));
    assert_eq!(document.board_shapes().len(), 2);
    assert_eq!(document.board_shapes()[1].y2, Some(-40.5));
    assert_eq!(document.board_edges()[0].label.as_deref(), Some("依赖"));
    assert_eq!(document.board_frames()[0].title.as_deref(), Some("Q4"));
    // Unknown appState keys survive (this layer is more conservative than the
    // frontend's whitelist).
    let output: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(output["appState"]["futureKey"]["keep"], true);
    assert_eq!(
        output["files"]["img1"]["storageKey"],
        "attachments/img1.png"
    );
}

#[test]
fn parse_rejects_invalid_content() {
    assert!(CanvasDocument::parse("not json", NOW).is_err());
    assert!(CanvasDocument::parse("[]", NOW).is_err());
    assert!(CanvasDocument::parse(r#"{"type": "application/json", "version": 1}"#, NOW).is_err());
    assert!(CanvasDocument::parse(r#"{"type": "flowix/canvas", "version": 2}"#, NOW).is_err());
}

#[test]
fn parse_fills_missing_meta_and_layers() {
    let document =
        CanvasDocument::parse(r#"{"type": "flowix/canvas", "version": 1}"#, NOW).unwrap();
    assert_eq!(document.created_at, NOW);
    assert_eq!(document.updated_at, NOW);
    assert_eq!(document.card_count(), 0);
    assert_eq!(document.serialize(), CanvasDocument::create_text(NOW));
}

#[test]
fn note_card_gets_defaults_and_identity() {
    let mut document = CanvasDocument::create(NOW);
    let id = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb1".into(),
                notebook_name: Some("Work".into()),
                path: "notes/a.md".into(),
                title: Some("标题".into()),
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    assert!(id.starts_with("c_"));
    let cards = document.board_cards();
    assert_eq!(cards.len(), 1);
    let card = &cards[0];
    assert_eq!(card.kind, "note");
    assert_eq!((card.x, card.y), (0.0, 0.0));
    assert_eq!((card.w, card.h), NOTE_CARD_SIZE);
    assert_eq!(document.updated_at, NOW);
    let stored = &document.serialize();
    assert!(stored.contains("\"notebookId\": \"nb1\""), "{stored}");
    assert!(stored.contains("\"notebookName\": \"Work\""), "{stored}");
    assert!(stored.contains("\"path\": \"notes/a.md\""), "{stored}");
}

#[test]
fn text_card_validates_sticky_color() {
    let mut document = CanvasDocument::create(NOW);
    let id = document
        .add_text_card(
            &TextCardInput {
                x: Some(10.4),
                y: Some(20.6),
                w: None,
                h: None,
                text: Some("hi".into()),
                color: Some("blue".into()),
            },
            NOW,
        )
        .unwrap();
    let card = &document.board_cards()[0];
    assert_eq!(card.color.as_deref(), Some("blue"));
    assert_eq!((card.x, card.y), (10.0, 21.0));
    assert_eq!((card.w, card.h), STICKY_CARD_SIZE);
    assert_eq!(card.text.as_deref(), Some("hi"));
    let _ = id;

    let bad = document.add_text_card(
        &TextCardInput {
            color: Some("pink".into()),
            ..Default::default()
        },
        NOW,
    );
    assert!(bad.is_err());
}

#[test]
fn shape_defaults_follow_the_board_tools() {
    let mut document = CanvasDocument::create(NOW);
    let rect = document
        .add_shape(
            &ShapeInput {
                shape: "rect".into(),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    assert!(rect.starts_with("s_"));
    let shapes = document.board_shapes();
    assert_eq!(shapes[0].shape, "rect");
    assert_eq!((shapes[0].w, shapes[0].h), BOX_SHAPE_SIZE);
    assert_eq!(shapes[0].fill.as_deref(), Some(DEFAULT_FILL));
    assert_eq!(shapes[0].stroke.as_deref(), Some(DEFAULT_STROKE));

    let label = document
        .add_shape(
            &ShapeInput {
                shape: "text".into(),
                text: Some("标签".into()),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    let _ = label;
    let shapes = document.board_shapes();
    assert_eq!((shapes[1].w, shapes[1].h), TEXT_LABEL_SIZE);
    assert_eq!(shapes[1].text.as_deref(), Some("标签"));
    assert!(shapes[1].fill.is_none());

    let arrow = document
        .add_shape(
            &ShapeInput {
                shape: "arrow".into(),
                x: Some(0.0),
                y: Some(0.0),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    let _ = arrow;
    // On disk, a two-point shape keeps tail/head plus the derived box
    // (`w = |x2-x|`, `h = |y2-y|`, which may be smaller than the read clamp).
    let stored: Value = serde_json::from_str(&document.serialize()).unwrap();
    let stored_arrow = &stored["shapes"][2];
    assert_eq!(stored_arrow["shape"], "arrow");
    assert_eq!(stored_arrow["x2"], TWO_POINT_DEFAULT_LENGTH);
    assert_eq!(stored_arrow["y2"], 0);
    assert_eq!(stored_arrow["w"], TWO_POINT_DEFAULT_LENGTH);
    assert_eq!(stored_arrow["h"], 0);
    let shapes = document.board_shapes();
    assert_eq!(shapes[2].shape, "arrow");
    assert_eq!(shapes[2].x2, Some(TWO_POINT_DEFAULT_LENGTH));
    assert_eq!(shapes[2].y2, Some(0.0));

    assert!(document
        .add_shape(
            &ShapeInput {
                shape: "cloud".into(),
                ..Default::default()
            },
            NOW
        )
        .is_err());
}

#[test]
fn edges_validate_endpoints_and_duplicates() {
    let mut document = CanvasDocument::create(NOW);
    let card = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb1".into(),
                notebook_name: None,
                path: "a.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    let shape = document
        .add_shape(
            &ShapeInput {
                shape: "rect".into(),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    let edge = document.add_edge(&card, &shape, Some("依赖"), NOW).unwrap();
    assert!(edge.starts_with("e_"));
    assert_eq!(document.board_edges()[0].label.as_deref(), Some("依赖"));

    assert!(document.add_edge(&card, "missing", None, NOW).is_err());
    assert!(document.add_edge(&card, &shape, None, NOW).is_err());
}

#[test]
fn frames_use_board_defaults() {
    let mut document = CanvasDocument::create(NOW);
    let id = document
        .add_frame(
            &FrameInput {
                title: Some("Q4".into()),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    assert!(id.starts_with("f_"));
    let frames = document.board_frames();
    assert_eq!(frames[0].title.as_deref(), Some("Q4"));
    assert_eq!((frames[0].w, frames[0].h), FRAME_SIZE);
}

#[test]
fn remove_cascades_connected_edges() {
    let mut document = CanvasDocument::create(NOW);
    let a = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb".into(),
                notebook_name: None,
                path: "a.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    let b = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb".into(),
                notebook_name: None,
                path: "b.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    document.add_edge(&a, &b, None, NOW).unwrap();
    let report = document.remove(&[a.as_str()], NOW);
    assert_eq!(report.removed, vec![a]);
    assert_eq!(report.removed_edges.len(), 1);
    assert_eq!(document.card_count(), 1);
    assert_eq!(document.edge_count(), 0);
    assert_eq!(document.updated_at, NOW);

    let untouched = document.remove(&["ghost"], NOW);
    assert!(untouched.removed.is_empty());
}

#[test]
fn note_grid_places_column_first_beside_existing_content() {
    let mut document = CanvasDocument::create(NOW);
    document
        .add_text_card(
            &TextCardInput {
                x: Some(0.0),
                y: Some(0.0),
                w: Some(100.0),
                h: Some(100.0),
                text: None,
                color: None,
            },
            NOW,
        )
        .unwrap();
    let notes: Vec<NoteCardInput> = (0..5)
        .map(|index| NoteCardInput {
            notebook_id: "nb".into(),
            notebook_name: None,
            path: format!("{index}.md"),
            title: None,
            x: None,
            y: None,
            w: None,
            h: None,
            render_scope: None,
            heading: None,
        })
        .collect();
    let ids = document
        .add_note_cards(
            &notes,
            &GridPlan {
                columns: 2,
                gap_x: 40.0,
                gap_y: 60.0,
                w: Some(200.0),
                h: Some(100.0),
                start: None,
            },
            NOW,
        )
        .unwrap();
    assert_eq!(ids.len(), 5);
    let cards = document.board_cards();
    // Auto-placed right of the existing 0..100 box with a 40px gap.
    assert_eq!((cards[1].x, cards[1].y), (140.0, 0.0));
    assert_eq!((cards[2].x, cards[2].y), (380.0, 0.0));
    assert_eq!((cards[3].x, cards[3].y), (140.0, 160.0));
    assert_eq!((cards[4].x, cards[4].y), (380.0, 160.0));
    assert_eq!((cards[4].w, cards[4].h), (200.0, 100.0));

    assert!(document
        .add_note_cards(
            &notes[..1],
            &GridPlan {
                columns: 0,
                ..Default::default()
            },
            NOW
        )
        .is_err());
}

#[test]
fn board_caps_are_enforced() {
    let now = NOW;
    let stored = r#"{"type": "flowix/canvas", "version": 1, "cards": []}"#;
    let mut document = CanvasDocument::parse(stored, now).unwrap();
    for _ in 0..MAX_CANVAS_BOARD_ENTRIES {
        document
            .cards
            .push(json!({"id": "x", "x": 0, "y": 0, "w": 10, "h": 10}));
    }
    let result = document.add_text_card(&TextCardInput::default(), now);
    assert!(result.is_err());
}

#[test]
fn summary_reports_counts_and_viewport() {
    let mut document = CanvasDocument::create(NOW);
    document
        .add_shape(
            &ShapeInput {
                shape: "rect".into(),
                x: Some(0.0),
                y: Some(0.0),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    document.app_state = Some(json!({"viewport": {"x": 5, "y": 6, "zoom": 2}}));
    let summary = document.summary();
    assert_eq!(summary["counts"]["shapes"], 1);
    assert_eq!(summary["viewport"]["zoom"].as_f64(), Some(2.0));
    assert_eq!(summary["shapes"][0]["fill"], DEFAULT_FILL);
}

#[test]
fn unique_canvas_filename_appends_parenthesis_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert_eq!(unique_canvas_filename(root, "计划"), "计划.flowix-canvas");
    std::fs::write(root.join("计划.flowix-canvas"), "{}").unwrap();
    assert_eq!(
        unique_canvas_filename(root, "计划"),
        "计划 (2).flowix-canvas"
    );
    std::fs::write(root.join("计划 (2).flowix-canvas"), "{}").unwrap();
    assert_eq!(
        unique_canvas_filename(root, "计划"),
        "计划 (3).flowix-canvas"
    );
    // Case-insensitive on disk names, stem keeps its original casing.
    std::fs::write(root.join("plan.flowix-canvas"), "{}").unwrap();
    assert_eq!(
        unique_canvas_filename(root, "Plan"),
        "Plan (2).flowix-canvas"
    );
    assert_eq!(
        unique_canvas_filename(root, "a/b\\c:*.flowix-canvas"),
        "a b c.flowix-canvas"
    );
    assert_eq!(unique_canvas_filename(root, ""), "Untitled.flowix-canvas");
}

#[test]
fn list_canvas_files_finds_files_and_skips_hidden_trees() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("研究")).unwrap();
    std::fs::create_dir_all(root.join(".flowix")).unwrap();
    std::fs::write(root.join("board.flowix-canvas"), "{}").unwrap();
    std::fs::write(root.join("研究/deep.BOARD.flowix-canvas"), "{}").unwrap();
    std::fs::write(root.join("研究/note.md"), "x").unwrap();
    std::fs::write(root.join(".flowix/hidden.flowix-canvas"), "{}").unwrap();
    let found = list_canvas_files(root);
    assert_eq!(
        found,
        vec!["board.flowix-canvas", "研究/deep.BOARD.flowix-canvas"]
    );
}

#[test]
fn resolve_canvas_path_rejects_non_canvas_targets() {
    let dir = tempfile::tempdir().unwrap();
    assert!(resolve_canvas_path(dir.path(), "notes/a.md").is_err());
    assert!(resolve_canvas_path(dir.path(), "notes/.flowix/a.flowix-canvas").is_err());
    assert!(resolve_canvas_path(dir.path(), "../a.flowix-canvas").is_err());
    let resolved = resolve_canvas_path(dir.path(), "boards/a.flowix-canvas").unwrap();
    assert_eq!(resolved, dir.path().join("boards").join("a.flowix-canvas"));
}

#[test]
fn canvas_path_detection_is_extension_based() {
    assert!(is_canvas_path("a.flowix-canvas"));
    assert!(is_canvas_path("A.FLOWIX-CANVAS"));
    assert!(!is_canvas_path("a.md"));
    assert!(!is_canvas_path("a.flowix-canvas.md"));
}

#[test]
fn update_moves_resizes_and_retexts_elements() {
    let mut document = CanvasDocument::create(NOW);
    let card = document
        .add_text_card(
            &TextCardInput {
                x: Some(0.0),
                y: Some(0.0),
                w: None,
                h: None,
                text: Some("便签".into()),
                color: Some("blue".into()),
            },
            NOW,
        )
        .unwrap();
    let shape = document
        .add_shape(
            &ShapeInput {
                shape: "rect".into(),
                x: Some(0.0),
                y: Some(0.0),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();

    // Move + resize the sticky.
    let kind = document
        .update_element(
            &card,
            &ElementPatch {
                x: Some(120.4),
                y: Some(-30.0),
                w: Some(300.0),
                h: Some(90.0),
                x2: None,
                y2: None,
                text: Some("改过".into()),
                color: Some("red".into()),
                fill: None,
                stroke: None,
                label: None,
                from: None,
                to: None,
                title: None,
            },
            NOW,
        )
        .unwrap();
    assert_eq!(kind, "card");
    let updated = document
        .board_cards()
        .into_iter()
        .find(|c| c.id == card)
        .unwrap();
    assert_eq!((updated.x, updated.y), (120.0, -30.0));
    assert_eq!((updated.w, updated.h), (300.0, 90.0));
    assert_eq!(updated.text.as_deref(), Some("改过"));
    assert_eq!(updated.color.as_deref(), Some("red"));

    // Blank text clears the attribute.
    document
        .update_element(
            &card,
            &ElementPatch {
                text: Some("  ".into()),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    let cleared = document
        .board_cards()
        .into_iter()
        .find(|c| c.id == card)
        .unwrap();
    assert_eq!(cleared.text, None);

    // Wrong-kind fields fail loudly.
    assert!(document
        .update_element(
            &card,
            &ElementPatch {
                fill: Some("#fff".into()),
                ..Default::default()
            },
            NOW
        )
        .is_err());
    assert!(document
        .update_element(
            &shape,
            &ElementPatch {
                label: Some("x".into()),
                ..Default::default()
            },
            NOW
        )
        .is_err());
    assert!(document
        .update_element(
            "ghost",
            &ElementPatch {
                x: Some(1.0),
                ..Default::default()
            },
            NOW
        )
        .is_err());
    assert!(document
        .update_element(&card, &ElementPatch::default(), NOW)
        .is_err());

    // Unknown-version fields on shape geometry: x2/y2 rejected on box shapes.
    assert!(document
        .update_element(
            &shape,
            &ElementPatch {
                x2: Some(9.0),
                ..Default::default()
            },
            NOW
        )
        .is_err());
}

#[test]
fn update_two_point_shape_recomputes_box_and_edges_relink() {
    let mut document = CanvasDocument::create(NOW);
    let a = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb".into(),
                notebook_name: None,
                path: "a.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    let b = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb".into(),
                notebook_name: None,
                path: "b.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    let c = document
        .add_note_card(
            &NoteCardInput {
                notebook_id: "nb".into(),
                notebook_name: None,
                path: "c.md".into(),
                title: None,
                x: None,
                y: None,
                w: None,
                h: None,
                render_scope: None,
                heading: None,
            },
            NOW,
        )
        .unwrap();
    let arrow = document
        .add_shape(
            &ShapeInput {
                shape: "arrow".into(),
                x: Some(0.0),
                y: Some(0.0),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();

    // Move the head; box recomputes from endpoints.
    document
        .update_element(
            &arrow,
            &ElementPatch {
                x: None,
                y: None,
                w: None,
                h: None,
                x2: Some(320.0),
                y2: Some(40.0),
                text: None,
                color: None,
                fill: None,
                stroke: None,
                label: None,
                from: None,
                to: None,
                title: None,
            },
            NOW,
        )
        .unwrap();
    let stored: Value = serde_json::from_str(&document.serialize()).unwrap();
    assert_eq!(stored["shapes"][0]["x2"], 320);
    assert_eq!(stored["shapes"][0]["w"], 320);
    assert_eq!(stored["shapes"][0]["h"], 40);
    // Direct w/h on a two-point shape is rejected.
    assert!(document
        .update_element(
            &arrow,
            &ElementPatch {
                w: Some(99.0),
                ..Default::default()
            },
            NOW
        )
        .is_err());

    // Relink the edge a -> b to a -> c; duplicates and missing endpoints fail.
    let edge = document.add_edge(&a, &b, None, NOW).unwrap();
    // A second a->c edge exists before the relink, so to: c is a duplicate.
    document.add_edge(&a, &c, None, NOW).unwrap();
    assert!(document
        .update_element(
            &edge,
            &ElementPatch {
                to: Some(c.clone()),
                ..Default::default()
            },
            NOW
        )
        .is_err());
    // Remove the blocker, relink succeeds.
    document.remove(&[document.board_edges().last().unwrap().id.as_str()], NOW);
    document
        .update_element(
            &edge,
            &ElementPatch {
                to: Some(c.clone()),
                label: Some("改为".into()),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
    let relinked = document
        .board_edges()
        .into_iter()
        .find(|e| e.id == edge)
        .unwrap();
    assert_eq!(relinked.to, c);
    assert_eq!(relinked.label.as_deref(), Some("改为"));
    assert!(document
        .update_element(
            &edge,
            &ElementPatch {
                from: Some("ghost".into()),
                ..Default::default()
            },
            NOW
        )
        .is_err());
}
