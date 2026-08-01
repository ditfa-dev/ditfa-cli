use ditfa_analytics::CompactionImplementation;
use ditfa_analytics::CompactionReason;
use ditfa_otel::SessionTelemetry;
use ditfa_protocol::error::DitfaErr;
use tracing::warn;

/// Retries failures that may be model-specific and succeed with a different model.
pub(crate) fn should_retry_with_current_model(error: &DitfaErr) -> bool {
    matches!(
        error,
        DitfaErr::InvalidRequest(_)
            | DitfaErr::UnexpectedStatus(_)
            | DitfaErr::ContextWindowExceeded
            | DitfaErr::UsageLimitReached(_)
            | DitfaErr::ServerOverloaded
            | DitfaErr::InternalServerError
            | DitfaErr::RetryLimit(_)
    )
}

pub(crate) fn record_model_fallback(
    session_telemetry: &SessionTelemetry,
    previous_model: &str,
    current_model: &str,
    reason: CompactionReason,
    implementation: CompactionImplementation,
    fallback_error: Option<&DitfaErr>,
) {
    let reason_tag = match reason {
        CompactionReason::UserRequested => "user_requested",
        CompactionReason::ContextLimit => "context_limit",
        CompactionReason::ModelDownshift => "model_downshift",
        CompactionReason::CompHashChanged => "comp_hash_changed",
    };
    let implementation_tag = match implementation {
        CompactionImplementation::Responses => "responses",
        CompactionImplementation::ResponsesCompactionV2 => "responses_compaction_v2",
        CompactionImplementation::ResponsesCompact => "responses_compact",
    };
    let outcome = if fallback_error.is_none() {
        "succeeded"
    } else {
        "failed"
    };
    session_telemetry.counter(
        "ditfa.compaction.model_fallback",
        /*inc*/ 1,
        &[
            ("reason", reason_tag),
            ("implementation", implementation_tag),
            ("outcome", outcome),
        ],
    );
    warn!(
        previous_model,
        current_model,
        ?reason,
        ?implementation,
        outcome,
        ?fallback_error,
        "previous-model compaction failed; retried with current model"
    );
}
