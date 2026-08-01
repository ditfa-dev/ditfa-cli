use pretty_assertions::assert_eq;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

use super::*;

#[tokio::test]
async fn sqlite_sink_drops_low_level_opentelemetry_sdk_logs() {
    let ditfa_home =
        std::env::temp_dir().join(format!("ditfa-state-log-db-filter-{}", Uuid::new_v4()));
    let runtime = StateRuntime::init(ditfa_home.clone(), "test-provider".to_string())
        .await
        .expect("initialize runtime");
    let layer = start(runtime.clone());

    let guard = tracing_subscriber::registry()
        .with(layer.clone().with_filter(default_filter()))
        .set_default();

    tracing::trace!(target: "opentelemetry_sdk", "dropped-trace");
    tracing::debug!(target: "opentelemetry_sdk", "dropped-debug");
    tracing::info!(target: "opentelemetry_sdk", "retained-info");
    tracing::trace!(target: "ditfa_state", "retained-trace");
    tracing::trace!(
        target: "ditfa_api::responses_websocket_timing",
        payload = "complete timing payload",
        "dropped-websocket-timing"
    );

    layer.flush().await;
    drop(guard);

    let logs = runtime
        .query_logs(&crate::LogQuery::default())
        .await
        .expect("query logs after flush");
    assert_eq!(
        logs.iter()
            .map(|row| (
                row.level.as_str(),
                row.target.as_str(),
                row.message.as_deref()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("INFO", "opentelemetry_sdk", Some("retained-info")),
            ("TRACE", "ditfa_state", Some("retained-trace")),
        ]
    );

    let _ = tokio::fs::remove_dir_all(ditfa_home).await;
}
