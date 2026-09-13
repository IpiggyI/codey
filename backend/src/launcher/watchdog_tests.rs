use super::*;

#[test]
fn cdp_watchdog_requires_consecutive_failures_before_reinjecting() {
    let mut failures = 0;

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert_eq!(failures, 1);
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Healthy
    ));
    assert_eq!(failures, 0);
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert!(watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
}

#[test]
fn cdp_watchdog_does_not_reinject_after_renderer_timeouts() {
    let mut failures = 0;

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert_eq!(failures, 0);

    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Unhealthy
    ));
    assert!(!watchdog_should_reinject(
        &mut failures,
        InjectionHealth::Inconclusive
    ));
    assert_eq!(failures, 0);
}

#[test]
fn cdp_watchdog_immediately_rediscovers_an_unavailable_target() {
    let mut failures = 1;

    assert!(watchdog_should_reinject(
        &mut failures,
        InjectionHealth::TargetUnavailable
    ));
    assert_eq!(failures, 0);
}
