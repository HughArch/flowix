use std::time::{Duration, Instant};

pub(super) struct PendingGoogleLogin {
    state: String,
    created_at: Instant,
    code_verifier: String,
    generation: u64,
    callback_received: bool,
}

pub(crate) enum GoogleCallback {
    Success { code: String, state: String },
    Failure { error: String, state: String },
}

impl PendingGoogleLogin {
    pub(super) fn new(state: String, code_verifier: String, generation: u64) -> Self {
        Self { state, code_verifier, generation, created_at: Instant::now(), callback_received: false }
    }

    fn claim_once(&mut self, state: &str) -> Result<bool, &'static str> {
        if self.state != state { return Ok(false); }
        // Browser fallback links and OS delivery can repeat the same callback.
        // Exchange its one-time code at most once, including while in flight.
        if self.callback_received {
            return Ok(false);
        }
        if self.created_at.elapsed() >= Duration::from_secs(300) {
            return Err("Google sign-in expired; please try again");
        }
        self.callback_received = true;
        Ok(true)
    }

    pub(super) fn claim(&mut self, state: &str) -> Result<Option<(String, u64)>, &'static str> {
        if !self.claim_once(state)? { return Ok(None); }
        Ok(Some((std::mem::take(&mut self.code_verifier), self.generation)))
    }

    pub(super) fn claim_failure(&mut self, state: &str) -> Result<bool, &'static str> {
        let claimed = self.claim_once(state)?;
        if claimed { self.code_verifier.clear(); }
        Ok(claimed)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_callback_cannot_exchange_again_or_report_expiry() {
        let mut attempt = PendingGoogleLogin::new("state".into(), "verifier".into(), 7);
        assert_eq!(attempt.claim("state"), Ok(Some(("verifier".into(), 7))));
        assert_eq!(attempt.claim("state"), Ok(None));
        assert!(attempt.code_verifier.is_empty());
    }

    #[test]
    fn stale_callback_does_not_consume_current_attempt() {
        let mut attempt = PendingGoogleLogin::new("current".into(), "verifier".into(), 8);
        assert_eq!(attempt.claim("old").unwrap(), None);
        assert_eq!(attempt.claim("current"), Ok(Some(("verifier".into(), 8))));
    }

    #[test]
    fn expired_attempt_cannot_be_exchanged() {
        let mut attempt = PendingGoogleLogin::new("state".into(), "verifier".into(), 7);
        attempt.created_at -= Duration::from_secs(301);
        assert_eq!(attempt.claim("state"), Err("Google sign-in expired; please try again"));
        assert!(!attempt.callback_received);
    }

    #[test]
    fn failure_callback_must_match_and_only_claim_once() {
        let mut attempt = PendingGoogleLogin::new("state".into(), "verifier".into(), 7);
        assert!(!attempt.claim_failure("stale").unwrap());
        assert!(attempt.claim_failure("state").unwrap());
        assert!(!attempt.claim_failure("state").unwrap());
        assert!(attempt.code_verifier.is_empty());
    }

    #[test]
    fn expired_failure_callback_is_reported_only_for_the_matching_attempt() {
        let mut attempt = PendingGoogleLogin::new("state".into(), "verifier".into(), 7);
        attempt.created_at -= Duration::from_secs(301);
        assert_eq!(attempt.claim_failure("state"), Err("Google sign-in expired; please try again"));
        assert!(!attempt.callback_received);
    }
}
