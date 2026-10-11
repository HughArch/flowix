use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flowix_core::memo_file::{FileLockIntent, MemoFile};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::path_is_inside;

pub(super) const MAX_ATTACHMENT_BYTES: u64 = 1024 * 1024 * 1024;

/// Saved path and whether this operation created a new notebook file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedNotebookAsset {
    pub(super) path: String,
    pub(super) created: bool,
}

fn copy_bounded(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        copied += read as u64;
        if copied > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ATTACHMENT_FILE_TOO_LARGE",
            ));
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), copied))
}

/// Resolve the owning notebook for a saved asset. Ownership is expressed by
/// path: `note_path` may be an absolute path inside a registered notebook or
/// a notebook-relative path (which then requires `notebook_id`). Returns the
/// resolved notebook id plus the notebook-relative note path when known.
pub(super) fn resolve_note_owner(
    store: &MemoFile,
    notebook_id: Option<&str>,
    note_path: Option<&str>,
) -> io::Result<(String, Option<String>)> {
    let Some(note_path) = note_path.filter(|path| !path.trim().is_empty()) else {
        let id = notebook_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "explicit notebook owner required",
                )
            })?;
        notebook_root(store, Some(id))?;
        return Ok((id.to_string(), None));
    };
    let candidate = Path::new(note_path);
    if candidate.is_absolute() {
        let canonical_note = dunce::canonicalize(candidate).map_err(|error| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("owner note not found: {error}"),
            )
        })?;
        for notebook in store.read_notebook_configs()? {
            let Ok(root) = dunce::canonicalize(&notebook.path) else {
                continue;
            };
            if let Ok(relative) = canonical_note.strip_prefix(&root) {
                if notebook_id.is_some_and(|id| id != notebook.id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "attachment notebook does not match note",
                    ));
                }
                return Ok((
                    notebook.id,
                    Some(relative.to_string_lossy().replace('\\', "/")),
                ));
            }
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "owner note is outside every registered notebook",
        ));
    }
    let id = notebook_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "a notebook-relative owner note requires an explicit notebook",
            )
        })?;
    let root = notebook_root(store, Some(id))?;
    let note = root.join(note_path);
    if !note.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "attachment owner note not found",
        ));
    }
    Ok((id.to_string(), Some(note_path.replace('\\', "/"))))
}

pub(super) fn notebook_root(store: &MemoFile, notebook_id: Option<&str>) -> io::Result<PathBuf> {
    let notebooks = store.read_notebook_configs()?;
    let selected = store.current_notebook_id_value();
    let id = notebook_id.or(selected.as_deref());
    let notebook = notebooks
        .iter()
        .find(|notebook| match id {
            Some(id) => notebook.id == id,
            None => notebook.is_default,
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "notebook is not registered"))?;
    let root = dunce::canonicalize(&notebook.path)?;
    if !root.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "notebook is not a directory",
        ));
    }
    Ok(root)
}

fn safe_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let sanitized: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches([' ', '.']);
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if sanitized.is_empty() {
        "attachment".to_string()
    } else if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        format!("_{sanitized}")
    } else {
        sanitized.to_string()
    }
}

pub(super) fn save_for_owner(
    store: &MemoFile,
    notebook_id: Option<&str>,
    note_path: Option<&str>,
    name: &str,
    reader: &mut impl Read,
    deduplicate: bool,
) -> io::Result<SavedNotebookAsset> {
    save_for_owner_in_directory(
        store,
        notebook_id,
        note_path,
        name,
        reader,
        deduplicate,
        None,
    )
}

/// Save into a canonical notebook directory; `None` selects `attachments/`.
pub(super) fn save_for_owner_in_directory(
    store: &MemoFile,
    notebook_id: Option<&str>,
    note_path: Option<&str>,
    name: &str,
    reader: &mut impl Read,
    deduplicate: bool,
    target_directory: Option<&Path>,
) -> io::Result<SavedNotebookAsset> {
    let (notebook_id, owner_note) = resolve_note_owner(store, notebook_id, note_path)?;
    save_locked(
        store,
        Some(&notebook_id),
        owner_note.as_deref(),
        name,
        reader,
        deduplicate,
        target_directory,
    )
}

#[cfg(test)]
fn save(
    store: &MemoFile,
    notebook_id: Option<&str>,
    name: &str,
    reader: &mut impl Read,
) -> io::Result<PathBuf> {
    save_locked(store, notebook_id, None, name, reader, false, None)
        .map(|saved| PathBuf::from(saved.path))
}

fn save_locked(
    store: &MemoFile,
    notebook_id: Option<&str>,
    owner_note: Option<&str>,
    name: &str,
    reader: &mut impl Read,
    deduplicate: bool,
    target_directory: Option<&Path>,
) -> io::Result<SavedNotebookAsset> {
    let root = notebook_root(store, notebook_id)?;
    let lock_id = store
        .read_notebook_configs()?
        .into_iter()
        .find(|notebook| {
            dunce::canonicalize(&notebook.path).ok().as_deref() == Some(root.as_path())
        })
        .map(|notebook| notebook.id)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "attachment notebook is not registered",
            )
        })?;
    let attachments_directory = root.join("attachments");
    if !path_is_inside(&attachments_directory, &root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "attachment directory escapes notebook",
        ));
    }
    let directory = if let Some(target_directory) = target_directory {
        let directory = dunce::canonicalize(target_directory)?;
        if !directory.starts_with(&root) || !directory.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "target directory is outside notebook or is not a directory",
            ));
        }
        directory
    } else {
        store.with_notebook_change(&[&lock_id], "create_attachment_directory", || {
            fs::create_dir_all(&attachments_directory)
        })?;
        let directory = dunce::canonicalize(&attachments_directory)?;
        if !directory.starts_with(&root) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "attachment directory escapes notebook",
            ));
        }
        directory
    };
    let name = safe_name(name);
    let name_path = Path::new(&name);
    let stem = name_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = name_path.extension().and_then(|value| value.to_str());
    let mut temporary = Some(tempfile::NamedTempFile::new_in(&directory)?);
    let fingerprint = copy_bounded(reader, temporary.as_mut().unwrap(), MAX_ATTACHMENT_BYTES)?;
    temporary.as_ref().unwrap().as_file().sync_all()?;
    // Prefer an already stored attachment when a caller selected a custom
    // notebook folder. This lets the editor and media library share assets.
    if deduplicate && directory != attachments_directory {
        if let Ok(attachment_directory) = dunce::canonicalize(&attachments_directory) {
            if attachment_directory.starts_with(&root) {
                let attachment = attachment_directory.join(&name);
                if existing_file_matches(store, &lock_id, &attachment, &fingerprint)? {
                    return Ok(SavedNotebookAsset {
                        path: attachment.to_string_lossy().into_owned(),
                        created: false,
                    });
                }
            }
        }
    }
    for index in 0..10_000 {
        let filename = if index == 0 {
            name.clone()
        } else {
            match extension {
                Some(extension) => format!("{stem}_{index}.{extension}"),
                None => format!("{stem}_{index}"),
            }
        };
        let target = directory.join(filename);
        enum TargetResult {
            Created,
            Reused,
            Occupied,
        }
        let result = store.with_file_write(
            &lock_id,
            &target,
            FileLockIntent::Create,
            "save_notebook_asset",
            |locked_target| {
                match fs::symlink_metadata(locked_target) {
                    Ok(metadata) => {
                        // Reuse only the exact requested filename. A numbered
                        // collision name can have a different original name.
                        if deduplicate
                            && index == 0
                            && matches_fingerprint(locked_target, &metadata, &fingerprint)?
                        {
                            return Ok(TargetResult::Reused);
                        }
                        return Ok(TargetResult::Occupied);
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                let journal = if path_is_inside(locked_target, &attachments_directory) {
                    Some(super::upload_journal::prepare(
                        &root,
                        locked_target,
                        owner_note,
                        &fingerprint,
                    )?)
                } else {
                    None
                };
                match temporary.take().unwrap().persist_noclobber(locked_target) {
                    Ok(_) => {
                        if let Some(journal) = journal {
                            if let Err(error) = journal.confirm() {
                                tracing::warn!(
                                    "Attachment saved; recovery confirmation failed: {error}"
                                );
                            }
                        }
                        Ok(TargetResult::Created)
                    }
                    Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                        temporary = Some(error.file);
                        Ok(TargetResult::Occupied)
                    }
                    Err(error) => Err(error.error),
                }
            },
        )?;
        match result {
            TargetResult::Created => {
                return Ok(SavedNotebookAsset {
                    path: target.to_string_lossy().into_owned(),
                    created: true,
                });
            }
            TargetResult::Reused => {
                return Ok(SavedNotebookAsset {
                    path: target.to_string_lossy().into_owned(),
                    created: false,
                });
            }
            TargetResult::Occupied => {}
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "notebook asset name limit reached",
    ))
}

fn existing_file_matches(
    store: &MemoFile,
    notebook_id: &str,
    path: &Path,
    fingerprint: &(String, u64),
) -> io::Result<bool> {
    store.with_file_write(
        notebook_id,
        path,
        FileLockIntent::Create,
        "reuse_attachment",
        |locked_path| match fs::symlink_metadata(locked_path) {
            Ok(metadata) => matches_fingerprint(locked_path, &metadata, fingerprint),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        },
    )
}

fn matches_fingerprint(
    path: &Path,
    metadata: &fs::Metadata,
    fingerprint: &(String, u64),
) -> io::Result<bool> {
    if !metadata.file_type().is_file() || metadata.len() != fingerprint.1 {
        return Ok(false);
    }
    let mut existing = fs::File::open(path)?;
    Ok(super::upload_journal::fingerprint(&mut existing)? == *fingerprint)
}

pub(super) fn authorized_attachment(store: &MemoFile, source: &Path) -> io::Result<PathBuf> {
    if !source.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "absolute attachment path required",
        ));
    }
    let source = dunce::canonicalize(source)?;
    if !source.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "attachment is not a file",
        ));
    }
    for notebook in store.read_notebook_configs()? {
        let root = Path::new(&notebook.path);
        let directory = root.join("attachments");
        if path_is_inside(&directory, root) && path_is_inside(&source, &directory) {
            return Ok(source);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "source is not a registered attachment",
    ))
}

#[cfg(test)]
mod tests;
