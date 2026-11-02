//! Initialization is not availability. Heartbeats expire and retry can recover.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) struct RoutingHealth {
    last_heartbeat: Mutex<Option<Instant>>,
}
impl RoutingHealth {
    pub(super) fn new() -> Self {
        Self {
            last_heartbeat: Mutex::new(None),
        }
    }
    pub(super) fn retrying(&self) {
        *self
            .last_heartbeat
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }
    pub(super) fn heartbeat(&self, now: Instant) {
        *self
            .last_heartbeat
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(now);
    }
    pub(super) fn ready(&self, now: Instant) -> bool {
        self.last_heartbeat
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_secs(3))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_initialization_is_not_reported_as_ready_on_retry() {
        let status = RoutingHealth::new();
        let now = Instant::now();
        status.retrying();
        assert!(!status.ready(now));
        status.retrying();
        assert!(!status.ready(now));
        status.heartbeat(now);
        assert!(status.ready(now));
    }
    #[test]
    fn stalled_pump_is_detected_and_a_recovered_pump_becomes_ready() {
        let status = RoutingHealth::new();
        let now = Instant::now();
        status.heartbeat(now);
        assert!(!status.ready(now + Duration::from_secs(4)));
        status.heartbeat(now + Duration::from_secs(4));
        assert!(status.ready(now + Duration::from_secs(4)));
    }
}
