//! Regression coverage for app-server thread operations backed by a non-local
//! `ThreadStore`.
//!
//! The app-server startup path should honor `experimental_thread_store`
//! by routing all thread persistence through the configured store. This suite uses
//! the thread-store crate's test-only in-memory store to exercise the non-local
//! config-driven selection path without touching local rollout or sqlite storage.
//!
//! The important failure mode is accidentally materializing local persistence
//! while a non-local store is configured. After `thread/start` and a simple turn,
//! the temporary `ditfa_home` must not contain rollout session files or sqlite
//! state files. This does not observe read-only probes that leave no artifact; it
//! is a stop-gap that prevents additional local persistence writes from slipping
//! in unnoticed.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::create_mock_responses_server_repeating_assistant;
use ditfa_app_server::in_process;
use ditfa_app_server::in_process::InProcessClientHandle;
use ditfa_app_server::in_process::InProcessServerEvent;
use ditfa_app_server::in_process::InProcessStartArgs;
use ditfa_app_server_protocol::ClientInfo;
use ditfa_app_server_protocol::ClientRequest;
use ditfa_app_server_protocol::InitializeParams;
use ditfa_app_server_protocol::JSONRPCError;
use ditfa_app_server_protocol::RequestId;
use ditfa_app_server_protocol::ServerNotification;
use ditfa_app_server_protocol::ThreadDeleteParams;
use ditfa_app_server_protocol::ThreadDeleteResponse;
use ditfa_app_server_protocol::ThreadHistoryMode;
use ditfa_app_server_protocol::ThreadListParams;
use ditfa_app_server_protocol::ThreadListResponse;
use ditfa_app_server_protocol::ThreadResumeParams;
use ditfa_app_server_protocol::ThreadStartParams;
use ditfa_app_server_protocol::ThreadStartResponse;
use ditfa_app_server_protocol::TurnStartParams;
use ditfa_app_server_protocol::UserInput as V2UserInput;
use ditfa_arg0::Arg0DispatchPaths;
use ditfa_config::CloudConfigBundleLoader;
use ditfa_config::LoaderOverrides;
use ditfa_config::NoopThreadConfigLoader;
use ditfa_core::config::Config;
use ditfa_core::config::ConfigBuilder;
use ditfa_exec_server::EnvironmentManager;
use ditfa_features::Feature;
use ditfa_feedback::CodexFeedback;
use ditfa_protocol::ThreadId;
use ditfa_protocol::models::BaseInstructions;
use ditfa_protocol::protocol::SessionSource;
use ditfa_protocol::protocol::ThreadMemoryMode;
use ditfa_thread_store::CreateThreadParams as StoreCreateThreadParams;
use ditfa_thread_store::InMemoryThreadStore;
use ditfa_thread_store::ThreadPersistenceMetadata;
use ditfa_thread_store::ThreadStore;
use ditfa_utils_absolute_path::test_support::PathExt;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[tokio::test]
async fn thread_start_rejects_paginated_history_without_list_support() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let ditfa_home = TempDir::new()?;
    let store_id = Uuid::new_v4().to_string();
    create_config_toml_with_thread_store(ditfa_home.path(), &server.uri(), &store_id)?;

    let _in_memory_store = InMemoryThreadStoreId { store_id };
    let mut mcp = TestAppServer::builder()
        .with_codex_home(ditfa_home.path())
        .build()
        .await?;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.initialize_with_client_info(ClientInfo {
            name: "codex-app-server-tests".to_string(),
            title: None,
            version: "0.1.0".to_string(),
        }),
    )
    .await??;
    let request_id = mcp
        .send_thread_start_request_with_auto_env(ThreadStartParams {
            history_mode: Some(ThreadHistoryMode::Paginated),
            ..Default::default()
        })
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;

    assert_eq!(error.error.code, -32600);
    assert_eq!(
        error.error.message,
        "paginated threads require thread/turns/list and thread/items/list support"
    );

    Ok(())
}

#[tokio::test]
async fn thread_delete_with_non_local_thread_store_does_not_create_local_persistence() -> Result<()>
{
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let ditfa_home = TempDir::new()?;
    let store_id = Uuid::new_v4().to_string();
    // Plugin startup warmups may create `.tmp` under ditfa_home. Disable them
    // here so this regression stays focused on thread persistence artifacts.
    create_config_toml_with_thread_store(ditfa_home.path(), &server.uri(), &store_id)?;

    let thread_store = InMemoryThreadStore::for_id(store_id.clone());
    let _in_memory_store = InMemoryThreadStoreId { store_id };

    let mut client = start_in_process_server(ditfa_home.path()).await?;

    let response = client
        .request(ClientRequest::ThreadStart {
            request_id: RequestId::Integer(1),
            params: ThreadStartParams::default(),
        })
        .await?
        .expect("thread/start should succeed");
    let ThreadStartResponse { thread, .. } =
        serde_json::from_value(response).expect("thread/start response should parse");
    assert_eq!(thread.path, None);

    client
        .request(ClientRequest::TurnStart {
            request_id: RequestId::Integer(2),
            params: TurnStartParams {
                thread_id: thread.id.clone(),
                client_user_message_id: None,
                input: vec![V2UserInput::Text {
                    text: "Hello".to_string(),
                    text_elements: Vec::new(),
                }],
                ..Default::default()
            },
        })
        .await?
        .expect("turn/start should succeed");

    timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let Some(event) = client.next_event().await else {
                anyhow::bail!("in-process app-server stopped before turn/completed");
            };
            if let InProcessServerEvent::ServerNotification(ServerNotification::TurnCompleted(
                completed,
            )) = event
                && completed.thread_id == thread.id
            {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;

    let response = client
        .request(ClientRequest::ThreadList {
            request_id: RequestId::Integer(3),
            params: ThreadListParams {
                cursor: None,
                limit: Some(10),
                sort_key: None,
                sort_direction: None,
                model_providers: Some(Vec::new()),
                source_kinds: None,
                archived: None,
                is_pinned: None,
                cwd: None,
                use_state_db_only: false,
                search_term: None,
                parent_thread_id: None,
                ancestor_thread_id: None,
            },
        })
        .await?
        .expect("thread/list should succeed");
    let ThreadListResponse { data, .. } =
        serde_json::from_value(response).expect("thread/list response should parse");
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].id, thread.id);
    assert_eq!(data[0].path, None);

    delete_thread(&client, /*request_id*/ 4, thread.id.clone()).await?;
    let unloaded_thread_id = ThreadId::from_string(&Uuid::new_v4().to_string())?;
    thread_store
        .create_thread(StoreCreateThreadParams {
            session_id: unloaded_thread_id.into(),
            thread_id: unloaded_thread_id,
            extra_config: None,
            forked_from_id: None,
            parent_thread_id: None,
            source: SessionSource::Cli,
            thread_source: None,
            originator: "test_originator".to_string(),
            base_instructions: BaseInstructions::default(),
            dynamic_tools: Vec::new(),
            selected_capability_roots: Vec::new(),
            multi_agent_version: None,
            history_mode: Default::default(),
            subagent_history_start_ordinal: None,
            initial_window_id: Uuid::now_v7().to_string(),
            metadata: ThreadPersistenceMetadata {
                cwd: Some(ditfa_home.path().to_path_buf()),
                model_provider: "mock_provider".to_string(),
                memory_mode: ThreadMemoryMode::Enabled,
            },
        })
        .await?;
    delete_thread(
        &client,
        /*request_id*/ 5,
        unloaded_thread_id.to_string(),
    )
    .await?;

    client.shutdown().await?;

    let calls = thread_store.calls().await;
    assert_eq!(calls.create_thread, 2);
    assert_eq!(calls.list_threads, 1);
    assert_eq!(calls.delete_thread, 2);
    assert!(
        calls.append_items > 0,
        "turn/start should append rollout items through the injected store"
    );
    assert!(
        calls.flush_thread > 0,
        "turn completion should flush through the injected store"
    );

    assert_no_local_persistence_artifacts(ditfa_home.path())?;

    Ok(())
}

#[tokio::test]
async fn cold_thread_resume_reuses_non_local_history_probe() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let ditfa_home = TempDir::new()?;
    let store_id = Uuid::new_v4().to_string();
    create_config_toml_with_thread_store(ditfa_home.path(), &server.uri(), &store_id)?;

    let loader_overrides = LoaderOverrides::without_managed_config_for_tests();
    let config = Arc::new(
        ConfigBuilder::default()
            .ditfa_home(ditfa_home.path().to_path_buf())
            .fallback_cwd(Some(ditfa_home.path().to_path_buf()))
            .loader_overrides(loader_overrides.clone())
            .build()
            .await?,
    );
    let thread_store = InMemoryThreadStore::for_id(store_id.clone());
    let _in_memory_store = InMemoryThreadStoreId { store_id };

    let mut client = start_in_process_client(config.clone(), loader_overrides.clone()).await?;
    let response = client
        .request(ClientRequest::ThreadStart {
            request_id: RequestId::Integer(1),
            params: ThreadStartParams::default(),
        })
        .await?
        .expect("thread/start should succeed");
    let ThreadStartResponse { thread, .. } = serde_json::from_value(response)?;

    client
        .request(ClientRequest::TurnStart {
            request_id: RequestId::Integer(2),
            params: TurnStartParams {
                thread_id: thread.id.clone(),
                client_user_message_id: None,
                input: vec![V2UserInput::Text {
                    text: "Materialize the thread".to_string(),
                    text_elements: Vec::new(),
                }],
                ..Default::default()
            },
        })
        .await?
        .expect("turn/start should succeed");
    timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let Some(event) = client.next_event().await else {
                anyhow::bail!("in-process app-server stopped before turn/completed");
            };
            if let InProcessServerEvent::ServerNotification(ServerNotification::TurnCompleted(
                completed,
            )) = event
                && completed.thread_id == thread.id
            {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;
    client.shutdown().await?;

    let client = start_in_process_client(config, loader_overrides).await?;
    let reads_before_resume = thread_store.calls().await.read_thread_with_history;
    // The in-memory store is pathless, so resume currently fails later while
    // assembling the response. The history-bearing probe must still be reused.
    let _resume_result = client
        .request(ClientRequest::ThreadResume {
            request_id: RequestId::Integer(3),
            params: ThreadResumeParams {
                thread_id: thread.id.clone(),
                ..Default::default()
            },
        })
        .await?;

    assert_eq!(
        thread_store.calls().await.read_thread_with_history,
        reads_before_resume + 1
    );

    client.shutdown().await?;
    Ok(())
}

async fn start_in_process_server(ditfa_home: &Path) -> Result<InProcessClientHandle> {
    let loader_overrides = LoaderOverrides::without_managed_config_for_tests();
    let config = Arc::new(
        ConfigBuilder::default()
            .ditfa_home(ditfa_home.to_path_buf())
            .fallback_cwd(Some(ditfa_home.to_path_buf()))
            .loader_overrides(loader_overrides.clone())
            .build()
            .await?,
    );

    Ok(start_in_process_client(config, loader_overrides).await?)
}

async fn start_in_process_client(
    config: Arc<Config>,
    loader_overrides: LoaderOverrides,
) -> std::io::Result<InProcessClientHandle> {
    in_process::start(InProcessStartArgs {
        arg0_paths: Arg0DispatchPaths::default(),
        config,
        cli_overrides: Vec::new(),
        loader_overrides,
        strict_config: false,
        cloud_config_bundle: CloudConfigBundleLoader::default(),
        thread_config_loader: Arc::new(NoopThreadConfigLoader),
        feedback: CodexFeedback::new(),
        log_db: None,
        state_db: None,
        environment_manager: Arc::new(EnvironmentManager::default_for_tests()),
        config_warnings: Vec::new(),
        session_source: SessionSource::Cli,
        enable_codex_api_key_env: false,
        initialize: InitializeParams {
            client_info: ClientInfo {
                name: "codex-app-server-tests".to_string(),
                title: None,
                version: "0.1.0".to_string(),
            },
            capabilities: None,
        },
        channel_capacity: in_process::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    })
    .await
}

async fn delete_thread(
    client: &InProcessClientHandle,
    request_id: i64,
    thread_id: String,
) -> Result<()> {
    let response = client
        .request(ClientRequest::ThreadDelete {
            request_id: RequestId::Integer(request_id),
            params: ThreadDeleteParams { thread_id },
        })
        .await?
        .map_err(|error| anyhow::anyhow!("thread/delete failed: {}", error.message))?;
    let _: ThreadDeleteResponse = serde_json::from_value(response)?;
    Ok(())
}

fn assert_no_local_persistence_artifacts(ditfa_home: &Path) -> Result<()> {
    // These are the observable tripwires for accidental local persistence. If a
    // future code path constructs a local rollout/session store or opens the
    // local thread sqlite database, it should leave one of these artifacts in
    // the isolated test ditfa_home.
    assert!(
        !ditfa_home.join("sessions").exists(),
        "non-local thread persistence should not create local rollout sessions"
    );
    assert!(
        !ditfa_home.join("archived_sessions").exists(),
        "non-local thread persistence should not create archived rollout sessions"
    );
    assert!(
        !ditfa_state::SqliteConfig::new_for_testing(ditfa_home.abs())
            .state_db_path()
            .exists(),
        "non-local thread persistence should not create local thread sqlite"
    );

    let sqlite_artifacts = std::fs::read_dir(ditfa_home)?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.ends_with(".sqlite")
                        || name.ends_with(".sqlite-shm")
                        || name.ends_with(".sqlite-wal")
                })
        })
        .collect::<Vec<_>>();

    assert!(
        sqlite_artifacts.is_empty(),
        "non-local thread persistence should not create sqlite artifacts: {sqlite_artifacts:?}"
    );
    let mut entries = ditfa_home_entries(ditfa_home)?;
    // Bazel test runs may initialize shell snapshot storage under ditfa_home.
    // That is not thread persistence; keep the assertion focused on rollout,
    // session, sqlite, and other unexpected thread-store artifacts.
    entries.remove("shell_snapshots");
    assert_eq!(
        entries,
        BTreeSet::from([
            ".sandbox_migration".to_string(),
            "config.toml".to_string(),
            "installation_id".to_string(),
            "skills".to_string(),
        ]),
        "non-local thread persistence should not create unexpected files in ditfa_home"
    );

    Ok(())
}

fn ditfa_home_entries(ditfa_home: &Path) -> Result<BTreeSet<String>> {
    Ok(std::fs::read_dir(ditfa_home)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            Some(entry.file_name().to_string_lossy().into_owned())
        })
        .collect())
}

struct InMemoryThreadStoreId {
    store_id: String,
}

impl Drop for InMemoryThreadStoreId {
    fn drop(&mut self) {
        InMemoryThreadStore::remove_id(&self.store_id);
    }
}

fn create_config_toml_with_thread_store(
    ditfa_home: &Path,
    server_uri: &str,
    store_id: &str,
) -> std::io::Result<()> {
    MockResponsesConfig::new(server_uri)
        .with_root_config(&format!(
            "experimental_thread_store = {{ type = \"in_memory\", id = \"{store_id}\" }}"
        ))
        .disable_feature(Feature::Plugins)
        .write(ditfa_home)
}
