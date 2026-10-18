use super::*;

impl SyncManager {
    pub async fn refresh_membership(&self) -> Result<CloudMembership, SyncError> {
        let generation = self.auth_generation();
        let mut refresh = match self.membership_refresh.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                let guard = self.membership_refresh.lock().await;
                // Share a successful in-flight refresh only within its session.
                let _generation = self.require_auth_generation(generation)?;
                if *guard == Some(generation) {
                    if let Some(membership) = self
                        .membership
                        .read()
                        .unwrap_or_else(|p| p.into_inner())
                        .clone()
                    {
                        return Ok(membership);
                    }
                }
                guard
            }
        };
        // Failure or cancellation must not let waiters reuse an older cache.
        *refresh = None;
        let token = self.access_token(generation).await?;
        let first = self.client.entitlements(&token).await;
        let entitlement = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.entitlements(&refreshed).await?
        } else {
            first?
        };
        let membership: CloudMembership = entitlement.into();
        let _generation = self.require_auth_generation(generation)?;
        let mut auth = self.auth.write().unwrap_or_else(|p| p.into_inner());
        *self.membership.write().unwrap_or_else(|p| p.into_inner()) = Some(membership.clone());
        auth.revision = auth.revision.saturating_add(1);
        drop(auth);
        drop(_generation);
        *refresh = Some(generation);
        drop(refresh);
        self.notify_state_change();
        Ok(membership)
    }

    pub async fn products(&self) -> Result<Vec<CloudProduct>, SyncError> {
        self.client.products().await
    }

    pub async fn create_checkout(
        &self,
        product_id: &str,
        idempotency_key: &str,
    ) -> Result<CloudCheckout, SyncError> {
        let generation = self.auth_generation();
        let token = self.access_token(generation).await?;
        let first = self
            .client
            .checkout(&token, product_id, idempotency_key)
            .await;
        let result = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client
                .checkout(&refreshed, product_id, idempotency_key)
                .await
        } else {
            first
        };
        let _generation = self.require_auth_generation(generation)?;
        result
    }
}
