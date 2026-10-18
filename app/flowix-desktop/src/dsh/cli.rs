//! One CLI resolver and child environment for official and managed DSH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use crate::agent_external::cli_resolver::{
    is_executable_file, resolve_external_cli_uncached, ExternalCliSpec,
};

static USER_SELECTED_DSH_CLI: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

pub(crate) fn set_user_selected_dsh_cli(path: Option<PathBuf>) {
    if let Ok(mut selected) = USER_SELECTED_DSH_CLI
        .get_or_init(|| RwLock::new(None))
        .write()
    {
        *selected = path;
    }
}

pub(crate) fn is_valid_dsh_cli_path(path: &Path) -> bool {
    if is_executable_file(path) {
        return true;
    }
    let is_node_script = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension, "js" | "mjs" | "cjs"))
        .unwrap_or(false);
    is_node_script
        && std::fs::metadata(path)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
}

pub(crate) struct DshCliLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub environment: HashMap<String, String>,
}

fn extra_candidates() -> Vec<PathBuf> {
    let mut paths = vec![super::dsh_home_path().join("bin/dsh")];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/share/pnpm/dsh"));
    }
    paths
}

#[cfg(windows)]
fn windows_candidates() -> Vec<PathBuf> {
    let mut directories = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    directories.push(super::dsh_home_path().join("bin"));
    if let Some(app_data) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(app_data).join("npm"));
    }
    directories
        .into_iter()
        .flat_map(|directory| {
            ["dsh.exe", "dsh.cmd", "dsh.bat"]
                .into_iter()
                .map(move |name| directory.join(name))
        })
        .collect()
}

pub(super) fn local_dsh_executable() -> Option<PathBuf> {
    let selected = USER_SELECTED_DSH_CLI
        .get_or_init(|| RwLock::new(None))
        .read()
        .ok()
        .and_then(|selected| selected.clone())
        .filter(|path| is_valid_dsh_cli_path(path));
    if selected.is_some() {
        return selected;
    }
    let path = resolve_external_cli_uncached(&ExternalCliSpec {
        binary_name: "dsh",
        #[cfg(windows)]
        windows_binary_name: "dsh.cmd",
        env_vars: &["FLOWIX_DSH_CLI_PATH"],
        extra_unix_candidates: extra_candidates,
        #[cfg(windows)]
        extra_windows_candidates: windows_candidates,
    });
    path.is_absolute()
        .then_some(path)
        .filter(|path| is_executable_file(path))
}

fn local_node(cli: &Path) -> Option<PathBuf> {
    if let Some(node) = std::env::var_os("FLOWIX_DSH_NODE_PATH")
        .map(PathBuf::from)
        .filter(|path| is_executable_file(path))
    {
        return Some(node);
    }
    // npm/nvm install their CLI shims alongside the matching Node binary.
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(node) = cli
        .parent()
        .map(|parent| parent.join(name))
        .filter(|path| is_executable_file(path))
    {
        return Some(node);
    }
    if let Some(node) = crate::agent_external::node::resolve_node_binary("FLOWIX_DSH_NODE_PATH") {
        return Some(node);
    }
    let node = resolve_external_cli_uncached(&ExternalCliSpec {
        binary_name: "node",
        #[cfg(windows)]
        windows_binary_name: "node.exe",
        env_vars: &["FLOWIX_DSH_NODE_PATH"],
        extra_unix_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
        #[cfg(windows)]
        extra_windows_candidates: crate::agent_external::cli_resolver::no_extra_candidates,
    });
    is_executable_file(&node).then_some(node)
}

pub(super) fn local_launch(cli: PathBuf, args: &[&str]) -> Result<DshCliLaunch, String> {
    let mut environment = super::dsh_plugin_environment();
    let node = local_node(&cli);
    let key = if cfg!(windows) { "Path" } else { "PATH" };
    let mut paths = cli
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(parent) = node.as_ref().and_then(|node| node.parent()) {
        paths.push(parent.to_path_buf());
    }
    if let Some(path) = std::env::var_os(key).or_else(|| std::env::var_os("PATH")) {
        paths.extend(std::env::split_paths(&path));
    }
    let path =
        std::env::join_paths(paths).map_err(|error| format!("prepare DSH CLI PATH: {error}"))?;
    #[cfg(windows)]
    environment.remove("PATH");
    environment.insert(key.into(), path.to_string_lossy().into_owned());

    let resolved = std::fs::canonicalize(&cli).unwrap_or_else(|_| cli.clone());
    let mut cli_args = Vec::new();
    let executable = match resolved
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js" | "mjs" | "cjs") => {
            cli_args.push(resolved.to_string_lossy().into_owned());
            node.ok_or("DSH requires Node.js; install Node.js or set FLOWIX_DSH_NODE_PATH")?
        }
        _ => cli,
    };
    cli_args.extend(args.iter().map(|arg| (*arg).to_string()));
    Ok(DshCliLaunch {
        executable,
        args: cli_args,
        environment,
    })
}

pub(crate) fn resolve_cli_launch(args: &[&str]) -> Result<DshCliLaunch, String> {
    if let Some(cli) = local_dsh_executable() {
        return local_launch(cli, args);
    }
    let launch = super::managed_launch_spec().ok_or("DeepSeek Harness runtime is not installed")?;
    let mut environment = super::dsh_plugin_environment();
    environment.extend(super::managed_child_environment(&launch.root));
    environment.insert(
        "FLOWIX_DSH_ROOT".into(),
        launch.root.to_string_lossy().into_owned(),
    );
    let mut cli_args = Vec::new();
    if let Some(cli) = launch.cli_entrypoint {
        cli_args.push(cli.to_string_lossy().into_owned());
    } else {
        environment.insert("DSH_EMBEDDED_CLI_MODE".into(), "1".into());
    }
    cli_args.extend(args.iter().map(|arg| (*arg).to_string()));
    Ok(DshCliLaunch {
        executable: launch.executable,
        args: cli_args,
        environment,
    })
}

/// The explicit App Server command override keeps the same environment boundary.
pub(crate) fn child_environment() -> HashMap<String, String> {
    super::dsh_plugin_environment()
}
