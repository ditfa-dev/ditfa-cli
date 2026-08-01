use crate::backend::BackendBundleClient;
use crate::service::CLOUD_CONFIG_BUNDLE_TIMEOUT;
use crate::service::CloudConfigBundleService;
use ditfa_config::CloudConfigBundleLoadError;
use ditfa_config::CloudConfigBundleLoadErrorCode;
use ditfa_config::CloudConfigBundleLoader;
use ditfa_config::types::AuthCredentialsStoreMode;
use ditfa_http_client::HttpClientFactory;
use ditfa_login::AuthKeyringBackendKind;
use ditfa_login::AuthManager;
use ditfa_login::AuthRouteConfig;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tokio::task::JoinHandle;

fn refresher_task_slot() -> &'static Mutex<Option<JoinHandle<()>>> {
    static REFRESHER_TASK: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    REFRESHER_TASK.get_or_init(|| Mutex::new(None))
}

pub fn cloud_config_bundle_loader(
    auth_manager: Arc<AuthManager>,
    chatgpt_base_url: String,
    ditfa_home: PathBuf,
    http_client_factory: HttpClientFactory,
) -> CloudConfigBundleLoader {
    let service = CloudConfigBundleService::new(
        auth_manager,
        Arc::new(BackendBundleClient::new(
            chatgpt_base_url,
            http_client_factory,
        )),
        ditfa_home,
        CLOUD_CONFIG_BUNDLE_TIMEOUT,
    );
    let refresh_service = service.clone();
    let task = tokio::spawn(async move { service.load_startup_bundle_with_timeout().await });
    let refresh_task =
        tokio::spawn(async move { refresh_service.refresh_cache_in_background().await });
    let mut refresher_guard = refresher_task_slot().lock().unwrap_or_else(|err| {
        tracing::warn!("cloud config bundle refresher task slot was poisoned");
        err.into_inner()
    });
    if let Some(existing_task) = refresher_guard.replace(refresh_task) {
        existing_task.abort();
    }
    CloudConfigBundleLoader::new(async move {
        task.await.map_err(|err| {
            tracing::error!(error = %err, "Cloud config bundle task failed");
            CloudConfigBundleLoadError::new(
                CloudConfigBundleLoadErrorCode::Internal,
                /*status_code*/ None,
                format!("cloud config bundle load failed: {err}"),
            )
        })?
    })
}

pub async fn cloud_config_bundle_loader_for_storage(
    ditfa_home: PathBuf,
    enable_ditfa_api_key_env: bool,
    credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    chatgpt_base_url: String,
    auth_route_config: AuthRouteConfig,
) -> CloudConfigBundleLoader {
    let http_client_factory = auth_route_config.http_client_factory().clone();
    let auth_manager = AuthManager::shared(
        ditfa_home.clone(),
        enable_ditfa_api_key_env,
        credentials_store_mode,
        /*forced_chatgpt_workspace_id*/ None,
        Some(chatgpt_base_url.clone()),
        keyring_backend_kind,
        auth_route_config,
    )
    .await;
    cloud_config_bundle_loader(
        auth_manager,
        chatgpt_base_url,
        ditfa_home,
        http_client_factory,
    )
}
