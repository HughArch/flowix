use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::State;

use crate::agent_external_config::{AgentExternalEntry, AgentExternalSource};
use crate::app::state::AppState;

const CODEX_VERSION_TOO_LOW_CODE: &str = "version-too-low";
const CODEX_VERSION_TOO_LOW_REASON: &str = "Codex CLI version below 0.150.0";
const MIN_CODEX_CLI_VERSION: (u64, u64, u64) = (0, 150, 0);
const STARTUP_CLI_DETECTION_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum InstallationState {
    Unknown,
    Installed,
    Missing,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ReadinessState {
    Unknown,
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeSnapshot {
    installation: InstallationState,
    readiness: ReadinessState,
    reason_code: Option<String>,
    reason: Option<String>,
}

impl AgentRuntimeSnapshot {
    fn new(
        installation: InstallationState,
        readiness: ReadinessState,
        reason_code: Option<&str>,
        reason: Option<String>,
    ) -> Self {
        Self {
            installation,
            readiness,
            reason_code: reason_code.map(str::to_string),
            reason,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeAgents {
    pi: AgentRuntimeSnapshot,
    codex: AgentRuntimeSnapshot,
    #[serde(rename = "claudecode")]
    claude_code: AgentRuntimeSnapshot,
    opencode: AgentRuntimeSnapshot,
    hermes: AgentRuntimeSnapshot,
    #[serde(rename = "dsh")]
    dsh: AgentRuntimeSnapshot,
    /// Built-in assistant (移动端): no binary to detect; configured = ready.
    #[serde(rename = "flowix")]
    flowix_builtin: AgentRuntimeSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    agents: AgentRuntimeAgents,
}

fn executable_available(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }

    if path.components().count() != 1 {
        return false;
    }

    std::env::var_os("PATH")
        .map(|path_var| std::env::split_paths(&path_var).any(|dir| dir.join(path).is_file()))
        .unwrap_or(false)
}

/// 基于 `agent-external-config` 里�?录的 path 算单�?external agent 的可用性�?/// `path = None` -> �?���?(�?��探测没探�?; `path = Some` 但失�?-> not found;
/// �?�� -> `None` (调用方再叠加 preflight 错�?, �?codex �?Node 依赖)�?
fn external_availability(entry: AgentExternalEntry, label: &str) -> AgentRuntimeSnapshot {
    let available = entry
        .path
        .as_ref()
        .map(|p| executable_available(p))
        .unwrap_or(false);
    match (&entry.path, available, entry.detected) {
        (None, _, false) => AgentRuntimeSnapshot::new(
            InstallationState::Unknown,
            ReadinessState::Unknown,
            Some("path-not-detected"),
            Some(format!("{label} path has not been detected")),
        ),
        (None, _, true) => AgentRuntimeSnapshot::new(
            InstallationState::Missing,
            ReadinessState::Unknown,
            Some("runtime-not-installed"),
            Some(format!("{label} was not found")),
        ),
        (Some(path), false, _) => AgentRuntimeSnapshot::new(
            InstallationState::Missing,
            ReadinessState::Unknown,
            Some("configured-path-missing"),
            Some(format!("{label} not found ({})", path.display())),
        ),
        (Some(_), true, _) => AgentRuntimeSnapshot::new(
            InstallationState::Installed,
            ReadinessState::Ready,
            None,
            None,
        ),
    }
}

async fn codex_version_is_too_low() -> bool {
    let Some(output) = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        crate::agent_external::codex::build_codex_entrypoint()
            .arg("--version")
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok) else {
        return false;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let Some(version) = text.split_whitespace().find_map(|part| {
        crate::agent_external::codex::parse_codex_version(part.trim_start_matches('v'))
    }) else {
        return false;
    };

    version < MIN_CODEX_CLI_VERSION
}

#[tauri::command]
pub async fn agent_runtime_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentRuntimeStatus, String> {
    let startup_detection_finished = tokio::time::timeout(
        STARTUP_CLI_DETECTION_WAIT,
        state.agents.agent_external_config.wait_for_startup_detect(),
    )
    .await
    .is_ok();
    if !startup_detection_finished {
        tracing::warn!(
            wait_seconds = STARTUP_CLI_DETECTION_WAIT.as_secs(),
            "startup CLI detection did not finish before the runtime status deadline"
        );
    }
    // The external CLI path comes from agent-external-config.json. Runtime
    // preflight can still add dependency details without hiding the entry.
    let cfg = &state.agents.agent_external_config;
    let mut codex = external_availability(cfg.get_entry("codex"), "Codex CLI");
    if matches!(codex.installation, InstallationState::Installed) {
        if codex_version_is_too_low().await {
            codex.readiness = ReadinessState::Blocked;
            codex.reason_code = Some(CODEX_VERSION_TOO_LOW_CODE.to_string());
            codex.reason = Some(CODEX_VERSION_TOO_LOW_REASON.to_string());
        } else {
            if let Err(reason) = crate::agent_external::codex::preflight_codex() {
                codex.readiness = ReadinessState::Blocked;
                codex.reason_code = Some("preflight-failed".to_string());
                codex.reason = Some(reason);
            }
        }
    }
    let claude_code = external_availability(cfg.get_entry("claudecode"), "Claude Code CLI");
    let hermes = external_availability(cfg.get_entry("hermes"), "Hermes Agent CLI");
    let opencode = external_availability(cfg.get_entry("opencode"), "OpenCode CLI");
    let pi = if crate::agent_external::pi::resolve_pi_binary(&app).is_ok() {
        AgentRuntimeSnapshot::new(
            InstallationState::Installed,
            ReadinessState::Ready,
            None,
            None,
        )
    } else {
        AgentRuntimeSnapshot::new(
            InstallationState::Missing,
            ReadinessState::Unknown,
            Some("runtime-not-installed"),
            Some("The bundled Pi runtime is missing or not executable".to_string()),
        )
    };
    let dsh_status = crate::dsh::status();
    let deepseek_harness = if !dsh_status.installed {
        AgentRuntimeSnapshot::new(
            InstallationState::Missing,
            ReadinessState::Unknown,
            Some("runtime-not-installed"),
            dsh_status
                .message
                .or_else(|| Some("DeepSeek Harness runtime is not installed".to_string())),
        )
    } else if !dsh_status.app_server_profile_installed {
        AgentRuntimeSnapshot::new(
            InstallationState::Installed,
            ReadinessState::Blocked,
            Some("appserver-profile-not-installed"),
            Some("Install the DSH App Server plugin from Flowix Preferences".to_string()),
        )
    } else {
        match state.agents.deepseek_harness.dsh_model_configs().await {
            Ok(configs)
                if configs.iter().any(|config| {
                    crate::agent_external::deepseek_harness::resolve_runtime_config(
                        &config.model,
                        None,
                    )
                    .is_ok()
                }) =>
            {
                AgentRuntimeSnapshot::new(
                    InstallationState::Installed,
                    ReadinessState::Ready,
                    None,
                    None,
                )
            }
            Ok(configs) if configs.is_empty() => AgentRuntimeSnapshot::new(
                InstallationState::Installed,
                ReadinessState::Blocked,
                Some("no-model-configured"),
                Some("No DeepSeek Harness model is configured".to_string()),
            ),
            Ok(_) => AgentRuntimeSnapshot::new(
                InstallationState::Installed,
                ReadinessState::Blocked,
                Some("no-usable-model"),
                Some("DeepSeek Harness has no usable model configuration".to_string()),
            ),
            Err(error) => AgentRuntimeSnapshot::new(
                InstallationState::Installed,
                ReadinessState::Unknown,
                Some("status-check-failed"),
                Some(format!("Could not read DeepSeek Harness models: {error}")),
            ),
        }
    };

    Ok(AgentRuntimeStatus {
        agents: AgentRuntimeAgents {
            pi,
            codex,
            claude_code,
            opencode,
            hermes,
            dsh: deepseek_harness,
            flowix_builtin: builtin_availability(&state),
        },
    })
}

/// Built-in assistant availability: pure configuration check, no binary
/// detection. Enabled + fully configured → ready; otherwise missing with a
/// setup hint so the UI can route the user to its dedicated config entry.
fn builtin_availability(state: &State<'_, AppState>) -> AgentRuntimeSnapshot {
    let config = state.agent_builtin.load_config();
    if config.enabled && config.is_configured() {
        AgentRuntimeSnapshot::new(InstallationState::Installed, ReadinessState::Ready, None, None)
    } else if config.enabled {
        AgentRuntimeSnapshot::new(
            InstallationState::Installed,
            ReadinessState::Blocked,
            Some("no-model-configured"),
            Some("内置 AI 助手缺少 API 地址 / Key / 模型配置".to_string()),
        )
    } else {
        AgentRuntimeSnapshot::new(
            InstallationState::Missing,
            ReadinessState::Unknown,
            Some("runtime-not-installed"),
            Some("内置 AI 助手未启用".to_string()),
        )
    }
}

/// 偏好设置展示用的 external agent 条目视图�?
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEntryView {
    pub path: Option<String>,
    pub source: AgentExternalSource,
    pub available: bool,
}

impl AgentExternalEntryView {
    fn from_entry(entry: AgentExternalEntry) -> Self {
        let available = entry
            .path
            .as_ref()
            .map(|p| executable_available(p))
            .unwrap_or(false);
        Self {
            path: entry.path.map(|p| p.to_string_lossy().to_string()),
            source: entry.source,
            available,
        }
    }
}

/// 读取全部 external agent 的路径配�?(供偏好�?�?���?�?
#[tauri::command]
pub fn get_agent_external_config(
    state: State<'_, AppState>,
) -> HashMap<String, AgentExternalEntryView> {
    state
        .agents.agent_external_config
        .snapshot()
        .into_iter()
        .map(|(k, e)| (k, AgentExternalEntryView::from_entry(e)))
        .collect()
}

/// 用户手改 path: �?`source = user` 并同步注册表�?
#[tauri::command]
pub fn set_agent_external_path(
    agent_type: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<AgentExternalEntryView, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let path_buf = PathBuf::from(trimmed);
    // 校验: 必须�?��实存在的�?��行文�?── 拒绝�?��/文档/无执行权限的文件,
    // 避免把无效路径写�?agent-external-config.json 导致后续 spawn 失败�?
    if !crate::agent_external::cli_resolver::is_executable_file(&path_buf) {
        return Err(format!(
            "not a valid executable file: {}",
            path_buf.display()
        ));
    }
    let entry = state
        .agents.agent_external_config
        .set_user_path(&agent_type, path_buf)
        .map_err(|e| e.to_string())?;
    Ok(AgentExternalEntryView::from_entry(entry))
}

/// 重新探测单个 agent: 清注册表该项 -> 跑探测链 -> �?`source = auto` -> 回填注册表�?
#[tauri::command]
pub fn redetect_agent_external(
    agent_type: String,
    state: State<'_, AppState>,
) -> Result<AgentExternalEntryView, String> {
    state
        .agents.agent_external_config
        .redetect(&agent_type)
        .map_err(|e| e.to_string())?;
    Ok(AgentExternalEntryView::from_entry(
        state.agents.agent_external_config.get_entry(&agent_type),
    ))
}

/// 打开文件浏�?器�?用户选一�?CLI �?��行文�? 返回其绝对路径�?/// 供偏好�?�?切换"按钮调用 ── �?���?��通过文件选择器指�? 不允许手输�?
#[tauri::command]
pub async fn select_external_cli_path(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let result = handle
            .dialog()
            .file()
            .set_title("Select CLI executable")
            .blocking_pick_file()
            .map(|p| p.to_string());
        tx.send(result).ok();
    });
    rx.recv().ok().flatten()
}
