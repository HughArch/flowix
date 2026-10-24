//! Minimal probe for an FNS instance.
//!
//! Credentials are never passed on the command line. They are read from:
//!   1. `--credentials <path>`
//!   2. `FNS_CREDENTIALS_FILE`
//!   3. `<repo>/.local/fns-credentials.json` (gitignored)
//!
//! Usage:
//!   fns-probe                      pull changes from the configured vault
//!   fns-probe push <path> <text>   upload one note, then pull to verify

use std::env;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use flowix_fns::protocol::OfflineSyncStrategy;
use flowix_fns::{
    delete_note, pull_notes, push_note, sync_notebook, ClientInfo, FnsClient, FsNoteStore,
    PushNote, SyncState,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Credentials {
    api: String,
    #[serde(rename = "apiToken")]
    api_token: String,
    vault: String,
    /// Must match the `c:` dimension bound to the token on the server.
    /// Tokens copied from the Obsidian plugin use `obsidianPlugin`.
    #[serde(default, rename = "clientType")]
    client_type: Option<String>,
    #[serde(default)]
    last_time: Option<i64>,
}

fn credentials_path() -> Option<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--credentials" {
            return args.next().map(PathBuf::from);
        }
    }
    if let Ok(path) = env::var("FNS_CREDENTIALS_FILE") {
        return Some(PathBuf::from(path));
    }
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.local/fns-credentials.json");
    default.exists().then_some(default)
}

fn positionals() -> Vec<String> {
    let mut out = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--credentials" {
            let _ = args.next();
            continue;
        }
        out.push(arg);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = credentials_path().ok_or(
        "credentials not found: pass --credentials, set FNS_CREDENTIALS_FILE, \
         or create .local/fns-credentials.json",
    )?;
    let raw = std::fs::read(&path)?;
    let credentials: Credentials = serde_json::from_slice(&raw)?;

    let client_type = credentials
        .client_type
        .clone()
        .unwrap_or_else(|| "obsidianPlugin".to_owned());
    let info = ClientInfo {
        name: "Flowix Probe".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        client_type: client_type.clone(),
        offline_sync_strategy: Some(OfflineSyncStrategy::NewTimeMerge.as_str().to_owned()),
    };

    println!(
        "connecting to {} (vault={}, clientType={})",
        credentials.api, credentials.vault, client_type
    );
    let mut client = FnsClient::connect(&credentials.api, &credentials.api_token, &info).await?;
    println!("handshake ok");

    let args = positionals();
    if args.first().map(String::as_str) == Some("sync") {
        let root = args.get(1).ok_or("sync requires <notebook-root>")?;
        let root_path = std::path::Path::new(root);
        let store = FsNoteStore::new(root_path)?;

        let default_vault = root_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| credentials.vault.clone());
        let mut state = match SyncState::load(root_path)? {
            Some(state) => state,
            None => {
                let vault = args.get(2).cloned().unwrap_or(default_vault);
                SyncState::new(vault, uuid::Uuid::new_v4().to_string())
            }
        };
        println!(
            "syncing notebook {} with vault {} (lastTime={})",
            root_path.display(),
            state.vault,
            state.last_time
        );

        let report = sync_notebook(
            &mut client,
            &store,
            &store,
            &mut state,
            OfflineSyncStrategy::NewTimeMerge,
            &flowix_fns::SyncOptions::default(),
        )
        .await?;
        state.save(root_path)?;
        println!(
            "sync done: pulled={} pushed={} deletedLocal={} renamed={} filesPulled={} filesPushed={} conflicts={:?} cursor={}",
            report.pulled,
            report.pushed,
            report.deleted_local,
            report.renamed,
            report.files_pulled,
            report.files_pushed,
            report.conflicts,
            report.last_time
        );
        client.close().await?;
        return Ok(());
    }

    if args.first().map(String::as_str) == Some("push") {
        let note_path = args.get(1).ok_or("push requires <path>")?;
        let content = args.get(2).ok_or("push requires <text>")?;
        let now = now_ms();
        let ack = push_note(
            &mut client,
            PushNote {
                vault: &credentials.vault,
                path: note_path,
                content,
                ctime_ms: now,
                mtime_ms: now,
                base_hash: None,
                create_only: false,
            },
        )
        .await?;
        println!(
            "pushed {} (server lastTime={}, pathHash={})",
            ack.path, ack.last_time, ack.path_hash
        );
    } else if args.first().map(String::as_str) == Some("delete") {
        let note_path = args.get(1).ok_or("delete requires <path>")?;
        delete_note(&mut client, &credentials.vault, note_path).await?;
        println!("deleted {note_path}");
    }

    let result = pull_notes(
        &mut client,
        &credentials.vault,
        credentials.last_time.unwrap_or(0),
        Vec::new(),
        Vec::new(),
        OfflineSyncStrategy::NewTimeMerge,
    )
    .await?;

    if let Some(end) = &result.end {
        println!(
            "server counts: upload={} modify={} mtime={} delete={}",
            end.need_upload_count,
            end.need_modify_count,
            end.need_sync_mtime_count,
            end.need_delete_count
        );
    }
    println!("incremental cursor: {}", result.last_time);
    println!(
        "received: modified={} deleted={} renamed={} mtime={} needPush={}",
        result.modified.len(),
        result.deleted.len(),
        result.renamed.len(),
        result.mtime_only.len(),
        result.need_push.len()
    );

    for note in result.modified.iter().take(20) {
        let preview: String = note.content.chars().take(40).collect();
        println!(
            "  M {} ({} bytes, hash={}) {:?}",
            note.path,
            note.content.len(),
            note.content_hash,
            preview
        );
    }
    for note in result.deleted.iter().take(20) {
        println!("  D {}", note.path);
    }
    for note in result.need_push.iter().take(20) {
        println!("  P {}", note.path);
    }

    client.close().await?;
    Ok(())
}
