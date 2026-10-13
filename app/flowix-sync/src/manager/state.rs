use super::*;

impl SyncManager {
    /// Creates an in-memory session without persistent credentials or notifications.
    pub fn new(api_base: &str, database_path: impl AsRef<Path>) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, None, Arc::new(|_| {}))
    }

    /// Creates a persistent session without state notifications (for headless callers).
    pub fn new_with_token_store(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
    ) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, Some(token_store), Arc::new(|_| {}))
    }

    /// Creates a persistent session manager with notifications wired before any transitions.
    pub fn new_with_session_dependencies(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Arc<dyn RefreshTokenStore>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        Self::create(api_base, database_path, Some(token_store), state_notifier)
    }

    fn create(
        api_base: &str,
        database_path: impl AsRef<Path>,
        token_store: Option<Arc<dyn RefreshTokenStore>>,
        state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
    ) -> Result<Self, SyncError> {
        let sync_store = SyncStore::new(database_path)?;
        let restore_blocked = sync_store.session_restore_blocked()?;
        let credential_retry = Arc::new(tokio::sync::Notify::new());
        let mut auth = AuthState::default();
        if let Some(store) = token_store.as_ref() {
            if restore_blocked {
                auth.pending_credential = Some(CredentialWrite::Delete);
                credential_retry.notify_one();
            } else {
                match store.load() {
                    Ok(Some(_)) => auth.status = CloudAuthStatus::Restoring,
                    Ok(None) => {}
                    Err(error) => auth.error = Some(error),
                }
            }
        }
        Ok(Self {
            client: CloudClient::new(api_base)?,
            store: sync_store,
            auth: Arc::new(RwLock::new(auth)),
            membership: Arc::new(RwLock::new(None)),
            membership_refresh: Arc::new(tokio::sync::Mutex::new(None)),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            auth_generation: Arc::new(std::sync::Mutex::new(0)),
            account_sync_lock: Arc::new(tokio::sync::Mutex::new(())),
            refresh_token_store: token_store,
            credential_retry,
            state_notifier,
        })
    }

    pub fn store(&self) -> &SyncStore {
        &self.store
    }

    pub fn state(&self) -> Result<CloudState, SyncError> {
        let auth = self.auth.read().unwrap_or_else(|p| p.into_inner());
        Ok(CloudState {
            revision: auth.revision,
            authenticated: auth.session.is_some(),
            auth_status: if auth.session.is_some() {
                CloudAuthStatus::Authenticated
            } else {
                auth.status
            },
            auth_error: auth.error.clone().or_else(|| auth.credential_error.clone()),
            account: self.store.v2_account()?,
            membership: self
                .membership
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        })
    }
}
