use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use super::app_server::AppServerClient;
use super::protocol;
use super::transport::DshClient;

#[derive(Clone)]
pub(crate) struct HostLaunchSpec {
    pub(crate) session_root: PathBuf,
    pub(crate) dsh_home: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) credentials_path: PathBuf,
    pub(crate) plugin_settings_path: PathBuf,
}

#[async_trait::async_trait]
pub(crate) trait DshClientFactory: Send + Sync {
    async fn spawn(&self, spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String>;
}

pub(crate) struct ProcessDshClientFactory;
#[async_trait::async_trait]
impl DshClientFactory for ProcessDshClientFactory {
    async fn spawn(&self, spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String> {
        let launch = app_server_command(&spec.dsh_home)?;
        let mut env = launch.environment;
        env.insert("FLOWIX_DSH_APPSERVER_STDIO".into(), "1".into());
        env.insert(
            "DSH_HOME".into(),
            spec.dsh_home.to_string_lossy().into_owned(),
        );
        env.insert(
            "DSH_PROFILE_DIR".into(),
            spec.dsh_home
                .join("profiles")
                .join("flowix")
                .to_string_lossy()
                .into_owned(),
        );
        env.insert(
            "DSH_SETTINGS_PATH".into(),
            spec.settings_path.to_string_lossy().into_owned(),
        );
        env.insert(
            "DSH_CREDENTIALS_PATH".into(),
            spec.credentials_path.to_string_lossy().into_owned(),
        );
        env.insert(
            "FLOWIX_DSH_PLUGIN_SETTINGS_PATH".into(),
            spec.plugin_settings_path.to_string_lossy().into_owned(),
        );
        let client =
            AppServerClient::spawn(&launch.executable.to_string_lossy(), &launch.args, &env)
                .await?;
        let initialize =
            protocol::app_initialize_request(client.next_request_id(), env!("CARGO_PKG_VERSION"));
        let initialized = match client.request(initialize).await {
            Ok(initialized) => initialized,
            Err(error) => {
                client.shutdown().await;
                return Err(error);
            }
        };
        let version = initialized
            .get("protocolVersion")
            .and_then(serde_json::Value::as_u64);
        if version != Some(super::protocol::APP_SERVER_PROTOCOL_VERSION) {
            client.shutdown().await;
            return Err(format!(
                "dsh-appserver protocol version mismatch (server={version:?}, client={})",
                super::protocol::APP_SERVER_PROTOCOL_VERSION
            ));
        }
        let client: Arc<dyn DshClient> = client;
        Ok(client)
    }
}

fn app_server_command(dsh_home: &std::path::Path) -> Result<crate::dsh::cli::DshCliLaunch, String> {
    if let Ok(command) = std::env::var("FLOWIX_DSH_APPSERVER_COMMAND") {
        let args = std::env::var("FLOWIX_DSH_APPSERVER_ARGS")
            .ok()
            .map(|raw| {
                serde_json::from_str::<Vec<String>>(&raw)
                    .map_err(|error| format!("FLOWIX_DSH_APPSERVER_ARGS is invalid: {error}"))
            })
            .transpose()?
            .unwrap_or_default();
        return Ok(crate::dsh::cli::DshCliLaunch {
            executable: PathBuf::from(command),
            args,
            environment: crate::dsh::cli::child_environment(),
        });
    }

    if !crate::dsh::flowix_profile_installed(dsh_home) {
        return Err(
            "DSH App Server profile is not installed; install it from Flowix Preferences"
                .to_string(),
        );
    }
    crate::dsh::resolve_cli_launch(&["--profile", "flowix"])
}

pub(crate) struct HostRegistry {
    state: Mutex<RegistryState>,
    factory: Arc<dyn DshClientFactory>,
}

#[derive(Default)]
struct RegistryState {
    host: Option<SharedHost>,
    active_runs: usize,
}

struct SharedHost {
    client: Arc<dyn DshClient>,
    activity: Arc<HostActivity>,
}

struct HostActivity {
    active_requests: AtomicUsize,
    last_used_at: std::sync::Mutex<Instant>,
}

pub(crate) struct HostLease {
    client: Arc<dyn DshClient>,
    activity: Arc<HostActivity>,
}

impl HostLease {
    pub(crate) fn client(&self) -> Arc<dyn DshClient> {
        self.client.clone()
    }
}

impl std::ops::Deref for HostLease {
    type Target = dyn DshClient;

    fn deref(&self) -> &Self::Target {
        self.client.as_ref()
    }
}

impl Drop for HostLease {
    fn drop(&mut self) {
        self.activity.active_requests.fetch_sub(1, Ordering::AcqRel);
        *self.activity.last_used_at.lock().unwrap() = Instant::now();
    }
}

impl HostRegistry {
    pub(crate) fn new(factory: Arc<dyn DshClientFactory>) -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            factory,
        }
    }

    pub(crate) async fn ensure(
        &self,
        spec: &HostLaunchSpec,
        credential: Option<(&str, &str)>,
    ) -> Result<HostLease, String> {
        // Holding the registry lock across spawn intentionally provides a
        // single-flight guarantee. Host startup is rare and bounded; duplicate
        // children would be more dangerous than serial startup across routes.
        let mut state = self.state.lock().await;
        if let Some(cached) = state.host.as_ref().filter(|host| !host.client.is_closed()) {
            cached
                .activity
                .active_requests
                .fetch_add(1, Ordering::AcqRel);
            *cached.activity.last_used_at.lock().unwrap() = Instant::now();
            let lease = HostLease {
                client: cached.client.clone(),
                activity: cached.activity.clone(),
            };
            if let Some((reference, secret)) = credential {
                lease
                    .request(protocol::credential_set_request(
                        lease.next_request_id(),
                        reference,
                        secret,
                    ))
                    .await?;
            }
            return Ok(lease);
        }
        std::fs::create_dir_all(&spec.session_root)
            .map_err(|e| format!("failed to create DSH session root: {e}"))?;
        let host = self.factory.spawn(spec).await?;
        let activity = Arc::new(HostActivity {
            active_requests: AtomicUsize::new(1),
            last_used_at: std::sync::Mutex::new(Instant::now()),
        });
        let lease = HostLease {
            client: host.clone(),
            activity: activity.clone(),
        };
        if let Some((reference, secret)) = credential {
            if let Err(error) = lease
                .request(protocol::credential_set_request(
                    lease.next_request_id(),
                    reference,
                    secret,
                ))
                .await
            {
                host.shutdown().await;
                return Err(error);
            }
        }
        state.host = Some(SharedHost {
            client: host,
            activity,
        });
        Ok(lease)
    }

    pub(crate) async fn shared(&self, spec: &HostLaunchSpec) -> Result<HostLease, String> {
        self.ensure(spec, None).await
    }

    pub(crate) async fn cancellation_targets(&self) -> Vec<Arc<dyn DshClient>> {
        self.state
            .lock()
            .await
            .host
            .as_ref()
            .filter(|host| !host.client.is_closed())
            .map(|host| host.client.clone())
            .into_iter()
            .collect()
    }

    pub(crate) async fn touch(&self) {
        if let Some(host) = self.state.lock().await.host.as_ref() {
            *host.activity.last_used_at.lock().unwrap() = Instant::now();
        }
    }

    pub(crate) async fn run_started(&self) {
        let mut state = self.state.lock().await;
        state.active_runs += 1;
        if let Some(host) = state.host.as_ref() {
            *host.activity.last_used_at.lock().unwrap() = Instant::now();
        }
    }

    pub(crate) async fn run_finished(&self) {
        let mut state = self.state.lock().await;
        state.active_runs = state.active_runs.saturating_sub(1);
        if let Some(host) = state.host.as_ref() {
            *host.activity.last_used_at.lock().unwrap() = Instant::now();
        }
    }

    pub(crate) async fn clear_runs(&self) {
        self.state.lock().await.active_runs = 0;
    }

    pub(crate) async fn shutdown_if_no_runs(&self) -> Result<usize, String> {
        let host = {
            let mut state = self.state.lock().await;
            if state.active_runs > 0 {
                return Err("DeepSeek Harness is running a task".to_string());
            }
            if state
                .host
                .as_ref()
                .is_some_and(|host| host.activity.active_requests.load(Ordering::Acquire) > 0)
            {
                return Err("DeepSeek Harness is handling a request".to_string());
            }
            state.host.take()
        };
        if let Some(host) = host {
            host.client.shutdown().await;
            Ok(1)
        } else {
            Ok(0)
        }
    }

    pub(crate) async fn shutdown_if_idle(&self, idle_timeout: Duration) -> bool {
        let host = {
            let mut state = self.state.lock().await;
            if state.active_runs == 0
                && state.host.as_ref().is_some_and(|host| {
                    host.activity.active_requests.load(Ordering::Acquire) == 0
                        && host.activity.last_used_at.lock().unwrap().elapsed() >= idle_timeout
                })
            {
                state.host.take()
            } else {
                None
            }
        };
        if let Some(host) = host {
            host.client.shutdown().await;
            true
        } else {
            false
        }
    }

    pub(crate) async fn shutdown_all(&self) -> usize {
        let host = self.state.lock().await.host.take();
        if let Some(host) = host {
            host.client.shutdown().await;
            1
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::transport::fake::FakeDshClient;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeFactory {
        spawns: AtomicUsize,
    }

    struct FailingCredentialFactory {
        client: std::sync::Mutex<Option<Arc<FakeDshClient>>>,
    }

    #[async_trait::async_trait]
    impl DshClientFactory for FailingCredentialFactory {
        async fn spawn(&self, _spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String> {
            let client = Arc::new(FakeDshClient::new(vec![Err(
                "credential initialization failed".into(),
            )]));
            *self.client.lock().unwrap() = Some(client.clone());
            Ok(client)
        }
    }
    #[async_trait::async_trait]
    impl DshClientFactory for FakeFactory {
        async fn spawn(&self, _spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeDshClient::new(Vec::new())))
        }
    }
    fn spec(root: PathBuf) -> HostLaunchSpec {
        HostLaunchSpec {
            session_root: root.clone(),
            dsh_home: root.clone(),
            settings_path: root.join("settings"),
            credentials_path: root.join("credentials"),
            plugin_settings_path: root.join("plugins"),
        }
    }

    #[tokio::test]
    async fn concurrent_ensure_is_single_flight_for_shared_host() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = Arc::new(HostRegistry::new(factory.clone()));
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        let (a, b) = tokio::join!(registry.ensure(&spec, None), registry.ensure(&spec, None));
        assert!(Arc::ptr_eq(&a.unwrap().client(), &b.unwrap().client()));
        assert_eq!(factory.spawns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn closed_host_is_replaced_and_shutdown_clears_registry() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = HostRegistry::new(factory.clone());
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        let first = registry.ensure(&spec, None).await.unwrap();
        first.shutdown().await;
        let second = registry.ensure(&spec, None).await.unwrap();
        assert!(!Arc::ptr_eq(&first.client(), &second.client()));
        assert_eq!(registry.shutdown_all().await, 1);
        assert_eq!(factory.spawns.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn idle_shared_host_is_shut_down_once() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = HostRegistry::new(factory);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        registry.shared(&spec).await.unwrap();

        assert!(registry.shutdown_if_idle(Duration::ZERO).await);
        assert!(!registry.shutdown_if_idle(Duration::ZERO).await);
    }

    #[tokio::test]
    async fn active_lease_prevents_idle_shutdown() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = HostRegistry::new(factory);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        let lease = registry.shared(&spec).await.unwrap();

        assert!(!registry.shutdown_if_idle(Duration::ZERO).await);
        drop(lease);
        assert!(registry.shutdown_if_idle(Duration::ZERO).await);
    }

    #[tokio::test]
    async fn active_run_prevents_idle_and_explicit_shutdown() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = HostRegistry::new(factory);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        drop(registry.shared(&spec).await.unwrap());
        registry.run_started().await;

        assert!(!registry.shutdown_if_idle(Duration::ZERO).await);
        assert!(registry.shutdown_if_no_runs().await.is_err());
        registry.run_finished().await;
        assert!(registry.shutdown_if_idle(Duration::ZERO).await);
    }

    #[tokio::test]
    async fn failed_credential_initialization_closes_unregistered_host() {
        let factory = Arc::new(FailingCredentialFactory {
            client: std::sync::Mutex::new(None),
        });
        let registry = HostRegistry::new(factory.clone());
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());

        assert!(registry
            .ensure(&spec, Some(("DSH_TEST_KEY", "secret")))
            .await
            .is_err());
        assert!(factory.client.lock().unwrap().as_ref().unwrap().is_closed());
        assert_eq!(registry.shutdown_all().await, 0);
    }

    /// Run with FLOWIX_DSH_SMOKE_CLI and FLOWIX_DSH_SMOKE_HOME pointing at an
    /// official npm-installed DSH and a disposable home containing the Flowix
    /// profile. This covers the same resolver, environment and handshake used
    /// for locally installed DSH users.
    #[tokio::test]
    #[ignore = "requires an official DSH CLI and disposable installed profile"]
    async fn official_dsh_cli_starts_the_flowix_appserver_profile() {
        let _env_lock = crate::agent_external::acquire_test_env_lock();
        let cli = std::env::var("FLOWIX_DSH_SMOKE_CLI").expect("set FLOWIX_DSH_SMOKE_CLI");
        let home = PathBuf::from(
            std::env::var("FLOWIX_DSH_SMOKE_HOME").expect("set FLOWIX_DSH_SMOKE_HOME"),
        );
        let previous_cli = std::env::var_os("FLOWIX_DSH_CLI_PATH");
        std::env::set_var("FLOWIX_DSH_CLI_PATH", &cli);
        let spec = HostLaunchSpec {
            session_root: home.join("sessions"),
            settings_path: home.join("settings.yaml"),
            credentials_path: home.join(".credentials.yaml"),
            plugin_settings_path: home.join("plugin-settings.json"),
            dsh_home: home,
        };

        let result = async {
            let client = ProcessDshClientFactory.spawn(&spec).await?;
            let request = protocol::model_settings_describe_request(client.next_request_id());
            let settings = client.request(request).await;
            client.shutdown().await;
            settings
        }
        .await;

        match previous_cli {
            Some(value) => std::env::set_var("FLOWIX_DSH_CLI_PATH", value),
            None => std::env::remove_var("FLOWIX_DSH_CLI_PATH"),
        }
        let settings =
            result.expect("official DSH profile must complete handshake and read model settings");
        assert!(settings.get("providers").is_some());
    }
}
