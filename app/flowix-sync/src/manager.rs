use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, RwLock};

use crate::client::CloudClient;
use crate::error::SyncError;
use crate::models::{
    AppleAuthChallenge, AppleAuthorization, CloudAuthStatus, CloudCheckout, CloudMembership,
    CloudOrder, CloudOrderCheck, CloudProduct, CloudState, LocalChangeKind, RefreshTokenStore,
    RuntimeSession,
};
use crate::store::SyncStore;
use crate::v2::{
    V2AccountSyncReport, V2Bootstrap, V2Change, V2CloudAccount, V2EntityType, V2FreezeOperation,
    V2LocalNote, V2LocalNotebook, V2OperationKind, V2PushOperation, V2RemoteApply,
};
use chrono::Utc;

#[derive(Clone)]
pub struct SyncManager {
    client: CloudClient,
    store: SyncStore,
    auth: Arc<RwLock<AuthState>>,
    // Lock auth before membership to keep aggregate snapshots consistent.
    membership: Arc<RwLock<Option<CloudMembership>>>,
    membership_refresh: Arc<tokio::sync::Mutex<Option<u64>>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    auth_generation: Arc<std::sync::Mutex<u64>>,
    account_sync_lock: Arc<tokio::sync::Mutex<()>>,
    refresh_token_store: Option<Arc<dyn RefreshTokenStore>>,
    credential_retry: Arc<tokio::sync::Notify>,
    state_notifier: Arc<dyn Fn(CloudState) + Send + Sync>,
}

/// Local logout has completed; finish this value to revoke its server session.
pub struct PendingLogout {
    refresh_token: Option<String>,
    local_cleanup: Result<(), SyncError>,
}

struct AuthState {
    session: Option<RuntimeSession>,
    status: CloudAuthStatus,
    error: Option<String>,
    credential_error: Option<String>,
    pending_credential: Option<CredentialWrite>,
    revision: u64,
}

impl Default for AuthState {
    fn default() -> Self {
        Self {
            session: None,
            status: CloudAuthStatus::SignedOut,
            error: None,
            credential_error: None,
            pending_credential: None,
            revision: 0,
        }
    }
}

impl SyncManager {
    fn mark_restore_failed_at_generation(&self, generation: u64, error: impl Into<String>) {
        let Ok(guard) = self.require_auth_generation(generation) else {
            return;
        };
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        if auth.session.is_some() {
            return;
        }
        auth.status = CloudAuthStatus::SignedOut;
        auth.revision = auth.revision.saturating_add(1);
        auth.error = Some(error.into());
        drop(auth);
        drop(guard);
        self.notify_state_change();
    }

    fn notify_state_change(&self) {
        match self.state() {
            Ok(state) => (self.state_notifier)(state),
            Err(error) => tracing::warn!("failed to read cloud state for notification: {error}"),
        }
    }

    // Called only while the auth generation and AuthState write guards are held.
    fn persist_auth_token(&self, auth: &mut AuthState, token: &str) {
        let result = self
            .refresh_token_store
            .as_ref()
            .map_or(Ok(()), |store| store.save(token));
        auth.pending_credential = result
            .as_ref()
            .err()
            .map(|_| CredentialWrite::Save(token.to_owned()));
        if auth.pending_credential.is_some() {
            self.credential_retry.notify_one();
        }
        auth.credential_error = result
            .err()
            .map(|error| format!("登录凭据保存失败，重启后可能需要重新登录：{error}"));
    }

    fn delete_persisted_refresh_token(&self) -> Result<(), SyncError> {
        if let Some(store) = self.refresh_token_store.as_ref() {
            store.delete().map_err(SyncError::InvalidState)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
enum CredentialWrite {
    Save(String),
    Delete,
}

mod auth;
mod catalog;
mod lifecycle;
mod state;
mod v2_engine;
