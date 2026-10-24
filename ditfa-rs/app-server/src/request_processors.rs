use crate::bespoke_event_handling::apply_bespoke_event_handling;
use crate::command_exec::CommandExecManager;
use crate::command_exec::StartCommandExecParams;
use crate::config_manager::ConfigManager;
use crate::error_code::INPUT_TOO_LARGE_ERROR_CODE;
use crate::error_code::invalid_params;
use crate::models::supported_models;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::ConnectionRequestId;
use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::RequestContext;
use crate::outgoing_message::ThreadScopedOutgoingMessageSender;
use crate::skills_watcher::SkillsWatcher;
use crate::thread_status::ThreadWatchManager;
use crate::thread_status::resolve_thread_status;
use chrono::Duration as ChronoDuration;
use chrono::SecondsFormat;
use ditfa_analytics::AnalyticsEventsClient;
use ditfa_analytics::AnalyticsJsonRpcError;
use ditfa_analytics::InputError;
use ditfa_analytics::TurnSteerRequestError;
use ditfa_app_server_protocol::Account;
use ditfa_app_server_protocol::AccountLoginCompletedNotification;
use ditfa_app_server_protocol::AccountTokenUsageDailyBucket;
use ditfa_app_server_protocol::AccountTokenUsageSummary;
use ditfa_app_server_protocol::AccountUpdatedNotification;
use ditfa_app_server_protocol::AddCreditsNudgeCreditType;
use ditfa_app_server_protocol::AddCreditsNudgeEmailStatus;
use ditfa_app_server_protocol::AdditionalContextEntry;
use ditfa_app_server_protocol::AdditionalContextKind;
use ditfa_app_server_protocol::AppListUpdatedNotification;
use ditfa_app_server_protocol::AppSummary;
use ditfa_app_server_protocol::AppTemplateSummary;
use ditfa_app_server_protocol::AppTemplateUnavailableReason;
use ditfa_app_server_protocol::AppsInstalledParams;
use ditfa_app_server_protocol::AppsInstalledResponse;
use ditfa_app_server_protocol::AppsListParams;
use ditfa_app_server_protocol::AppsListResponse;
use ditfa_app_server_protocol::AppsReadParams;
use ditfa_app_server_protocol::AppsReadResponse;
use ditfa_app_server_protocol::AskForApproval;
use ditfa_app_server_protocol::AuthMode;
use ditfa_app_server_protocol::CancelLoginAccountParams;
use ditfa_app_server_protocol::CancelLoginAccountResponse;
use ditfa_app_server_protocol::CancelLoginAccountStatus;
use ditfa_app_server_protocol::ClientInfo;
use ditfa_app_server_protocol::ClientRequest;
use ditfa_app_server_protocol::ClientResponsePayload;
use ditfa_app_server_protocol::CollaborationModeListParams;
use ditfa_app_server_protocol::CollaborationModeListResponse;
use ditfa_app_server_protocol::CommandExecParams;
use ditfa_app_server_protocol::CommandExecResizeParams;
use ditfa_app_server_protocol::CommandExecTerminateParams;
use ditfa_app_server_protocol::CommandExecWriteParams;
use ditfa_app_server_protocol::ConfigWarningNotification;
use ditfa_app_server_protocol::ConsumeAccountRateLimitResetCreditOutcome;
use ditfa_app_server_protocol::ConsumeAccountRateLimitResetCreditParams;
use ditfa_app_server_protocol::ConsumeAccountRateLimitResetCreditResponse;
use ditfa_app_server_protocol::ConversationGitInfo;
use ditfa_app_server_protocol::ConversationSummary;
use ditfa_app_server_protocol::DeprecationNoticeNotification;
use ditfa_app_server_protocol::DitfaErrorInfo;
use ditfa_app_server_protocol::DynamicToolFunctionSpec;
use ditfa_app_server_protocol::DynamicToolNamespaceTool;
use ditfa_app_server_protocol::DynamicToolSpec;
use ditfa_app_server_protocol::EnvironmentAddParams;
use ditfa_app_server_protocol::EnvironmentAddResponse;
use ditfa_app_server_protocol::EnvironmentInfoParams;
use ditfa_app_server_protocol::EnvironmentInfoResponse;
use ditfa_app_server_protocol::EnvironmentShellInfo;
use ditfa_app_server_protocol::EnvironmentStatusKind;
use ditfa_app_server_protocol::EnvironmentStatusParams;
use ditfa_app_server_protocol::EnvironmentStatusResponse;
use ditfa_app_server_protocol::ExperimentalFeature as ApiExperimentalFeature;
use ditfa_app_server_protocol::ExperimentalFeatureListParams;
use ditfa_app_server_protocol::ExperimentalFeatureListResponse;
use ditfa_app_server_protocol::ExperimentalFeatureStage as ApiExperimentalFeatureStage;
use ditfa_app_server_protocol::FeedbackUploadParams;
use ditfa_app_server_protocol::FeedbackUploadResponse;
use ditfa_app_server_protocol::GetAccountParams;
use ditfa_app_server_protocol::GetAccountRateLimitsResponse;
use ditfa_app_server_protocol::GetAccountResponse;
use ditfa_app_server_protocol::GetAccountTokenUsageResponse;
use ditfa_app_server_protocol::GetAuthStatusParams;
use ditfa_app_server_protocol::GetAuthStatusResponse;
use ditfa_app_server_protocol::GetConversationSummaryParams;
use ditfa_app_server_protocol::GetConversationSummaryResponse;
use ditfa_app_server_protocol::GetWorkspaceMessagesResponse;
use ditfa_app_server_protocol::GitDiffToRemoteParams;
use ditfa_app_server_protocol::GitDiffToRemoteResponse;
use ditfa_app_server_protocol::GitInfo as ApiGitInfo;
use ditfa_app_server_protocol::HookMetadata;
use ditfa_app_server_protocol::HooksListParams;
use ditfa_app_server_protocol::HooksListResponse;
use ditfa_app_server_protocol::InitializeParams;
use ditfa_app_server_protocol::InitializeResponse;
use ditfa_app_server_protocol::InstalledApp;
use ditfa_app_server_protocol::JSONRPCErrorError;
use ditfa_app_server_protocol::ListMcpServerStatusParams;
use ditfa_app_server_protocol::ListMcpServerStatusResponse;
use ditfa_app_server_protocol::LoginAccountParams;
use ditfa_app_server_protocol::LoginAccountResponse;
use ditfa_app_server_protocol::LoginApiKeyParams;
use ditfa_app_server_protocol::LoginAppBrand;
use ditfa_app_server_protocol::LogoutAccountResponse;
use ditfa_app_server_protocol::MarketplaceAddParams;
use ditfa_app_server_protocol::MarketplaceAddResponse;
use ditfa_app_server_protocol::MarketplaceInterface;
use ditfa_app_server_protocol::MarketplaceRemoveParams;
use ditfa_app_server_protocol::MarketplaceRemoveResponse;
use ditfa_app_server_protocol::MarketplaceUpgradeErrorInfo;
use ditfa_app_server_protocol::MarketplaceUpgradeParams;
use ditfa_app_server_protocol::MarketplaceUpgradeResponse;
use ditfa_app_server_protocol::McpResourceReadParams;
use ditfa_app_server_protocol::McpResourceReadResponse;
use ditfa_app_server_protocol::McpServerOauthLoginCompletedNotification;
use ditfa_app_server_protocol::McpServerOauthLoginParams;
use ditfa_app_server_protocol::McpServerOauthLoginResponse;
use ditfa_app_server_protocol::McpServerRefreshResponse;
use ditfa_app_server_protocol::McpServerStatus;
use ditfa_app_server_protocol::McpServerStatusDetail;
use ditfa_app_server_protocol::McpServerToolCallParams;
use ditfa_app_server_protocol::McpServerToolCallResponse;
use ditfa_app_server_protocol::MemoryResetResponse;
use ditfa_app_server_protocol::MockExperimentalMethodParams;
use ditfa_app_server_protocol::MockExperimentalMethodResponse;
use ditfa_app_server_protocol::ModelListParams;
use ditfa_app_server_protocol::ModelListResponse;
use ditfa_app_server_protocol::PermissionProfileListParams;
use ditfa_app_server_protocol::PermissionProfileListResponse;
use ditfa_app_server_protocol::PermissionProfileSummary;
use ditfa_app_server_protocol::PluginDetail;
use ditfa_app_server_protocol::PluginInstallParams;
use ditfa_app_server_protocol::PluginInstallResponse;
use ditfa_app_server_protocol::PluginInstalledParams;
use ditfa_app_server_protocol::PluginInstalledResponse;
use ditfa_app_server_protocol::PluginInterface;
use ditfa_app_server_protocol::PluginListMarketplaceKind;
use ditfa_app_server_protocol::PluginListParams;
use ditfa_app_server_protocol::PluginListResponse;
use ditfa_app_server_protocol::PluginMarketplaceEntry;
use ditfa_app_server_protocol::PluginReadParams;
use ditfa_app_server_protocol::PluginReadResponse;
use ditfa_app_server_protocol::PluginShareCheckoutParams;
use ditfa_app_server_protocol::PluginShareCheckoutResponse;
use ditfa_app_server_protocol::PluginShareContext;
use ditfa_app_server_protocol::PluginShareDeleteParams;
use ditfa_app_server_protocol::PluginShareDeleteResponse;
use ditfa_app_server_protocol::PluginShareDiscoverability;
use ditfa_app_server_protocol::PluginShareListItem;
use ditfa_app_server_protocol::PluginShareListParams;
use ditfa_app_server_protocol::PluginShareListResponse;
use ditfa_app_server_protocol::PluginSharePrincipal;
use ditfa_app_server_protocol::PluginSharePrincipalType;
use ditfa_app_server_protocol::PluginShareSaveParams;
use ditfa_app_server_protocol::PluginShareSaveResponse;
use ditfa_app_server_protocol::PluginShareTarget;
use ditfa_app_server_protocol::PluginShareUpdateDiscoverability;
use ditfa_app_server_protocol::PluginShareUpdateTargetsParams;
use ditfa_app_server_protocol::PluginShareUpdateTargetsResponse;
use ditfa_app_server_protocol::PluginSkillReadParams;
use ditfa_app_server_protocol::PluginSkillReadResponse;
use ditfa_app_server_protocol::PluginSource;
use ditfa_app_server_protocol::PluginSummary;
use ditfa_app_server_protocol::PluginUninstallParams;
use ditfa_app_server_protocol::PluginUninstallResponse;
use ditfa_app_server_protocol::RateLimitResetCredit;
use ditfa_app_server_protocol::RateLimitResetCreditStatus;
use ditfa_app_server_protocol::RateLimitResetCreditsSummary;
use ditfa_app_server_protocol::RateLimitResetType;
use ditfa_app_server_protocol::RequestId;
use ditfa_app_server_protocol::ReviewDelivery as ApiReviewDelivery;
use ditfa_app_server_protocol::ReviewStartParams;
use ditfa_app_server_protocol::ReviewStartResponse;
use ditfa_app_server_protocol::ReviewTarget as ApiReviewTarget;
use ditfa_app_server_protocol::SandboxMode;
use ditfa_app_server_protocol::SendAddCreditsNudgeEmailParams;
use ditfa_app_server_protocol::SendAddCreditsNudgeEmailResponse;
use ditfa_app_server_protocol::ServerNotification;
use ditfa_app_server_protocol::ServerRequestResolvedNotification;
use ditfa_app_server_protocol::SkillSummary;
use ditfa_app_server_protocol::SkillsConfigWriteParams;
use ditfa_app_server_protocol::SkillsConfigWriteResponse;
use ditfa_app_server_protocol::SkillsExtraRootsSetParams;
use ditfa_app_server_protocol::SkillsExtraRootsSetResponse;
use ditfa_app_server_protocol::SkillsListParams;
use ditfa_app_server_protocol::SkillsListResponse;
use ditfa_app_server_protocol::SortDirection;
use ditfa_app_server_protocol::Thread;
use ditfa_app_server_protocol::ThreadApproveGuardianDeniedActionParams;
use ditfa_app_server_protocol::ThreadApproveGuardianDeniedActionResponse;
use ditfa_app_server_protocol::ThreadArchiveParams;
use ditfa_app_server_protocol::ThreadArchiveResponse;
use ditfa_app_server_protocol::ThreadArchivedNotification;
use ditfa_app_server_protocol::ThreadBackgroundTerminal;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsCleanParams;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsCleanResponse;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsListParams;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsListResponse;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsTerminateParams;
use ditfa_app_server_protocol::ThreadBackgroundTerminalsTerminateResponse;
use ditfa_app_server_protocol::ThreadClosedNotification;
use ditfa_app_server_protocol::ThreadCompactStartParams;
use ditfa_app_server_protocol::ThreadCompactStartResponse;
use ditfa_app_server_protocol::ThreadDecrementElicitationParams;
use ditfa_app_server_protocol::ThreadDecrementElicitationResponse;
use ditfa_app_server_protocol::ThreadDeleteParams;
use ditfa_app_server_protocol::ThreadDeleteResponse;
use ditfa_app_server_protocol::ThreadDeletedNotification;
use ditfa_app_server_protocol::ThreadForkParams;
use ditfa_app_server_protocol::ThreadForkResponse;
use ditfa_app_server_protocol::ThreadGoal;
use ditfa_app_server_protocol::ThreadGoalClearParams;
use ditfa_app_server_protocol::ThreadGoalClearResponse;
use ditfa_app_server_protocol::ThreadGoalClearedNotification;
use ditfa_app_server_protocol::ThreadGoalGetParams;
use ditfa_app_server_protocol::ThreadGoalGetResponse;
use ditfa_app_server_protocol::ThreadGoalSetParams;
use ditfa_app_server_protocol::ThreadGoalSetResponse;
use ditfa_app_server_protocol::ThreadGoalStatus;
use ditfa_app_server_protocol::ThreadGoalUpdatedNotification;
use ditfa_app_server_protocol::ThreadHistoryBuilder;
#[cfg(test)]
use ditfa_app_server_protocol::ThreadHistoryMode;
use ditfa_app_server_protocol::ThreadIncrementElicitationParams;
use ditfa_app_server_protocol::ThreadIncrementElicitationResponse;
use ditfa_app_server_protocol::ThreadInjectItemsParams;
use ditfa_app_server_protocol::ThreadInjectItemsResponse;
use ditfa_app_server_protocol::ThreadItem;
use ditfa_app_server_protocol::ThreadItemEntry;
use ditfa_app_server_protocol::ThreadItemsListParams;
use ditfa_app_server_protocol::ThreadItemsListResponse;
use ditfa_app_server_protocol::ThreadListCwdFilter;
use ditfa_app_server_protocol::ThreadListParams;
use ditfa_app_server_protocol::ThreadListResponse;
use ditfa_app_server_protocol::ThreadLoadedListParams;
use ditfa_app_server_protocol::ThreadLoadedListResponse;
use ditfa_app_server_protocol::ThreadMemoryModeSetParams;
use ditfa_app_server_protocol::ThreadMemoryModeSetResponse;
use ditfa_app_server_protocol::ThreadMetadataGitInfoUpdateParams;
use ditfa_app_server_protocol::ThreadMetadataUpdateParams;
use ditfa_app_server_protocol::ThreadMetadataUpdateResponse;
use ditfa_app_server_protocol::ThreadNameUpdatedNotification;
use ditfa_app_server_protocol::ThreadReadParams;
use ditfa_app_server_protocol::ThreadReadResponse;
use ditfa_app_server_protocol::ThreadRealtimeAppendAudioParams;
use ditfa_app_server_protocol::ThreadRealtimeAppendAudioResponse;
use ditfa_app_server_protocol::ThreadRealtimeAppendSpeechParams;
use ditfa_app_server_protocol::ThreadRealtimeAppendSpeechResponse;
use ditfa_app_server_protocol::ThreadRealtimeAppendTextParams;
use ditfa_app_server_protocol::ThreadRealtimeAppendTextResponse;
use ditfa_app_server_protocol::ThreadRealtimeListVoicesResponse;
use ditfa_app_server_protocol::ThreadRealtimeStartParams;
use ditfa_app_server_protocol::ThreadRealtimeStartResponse;
use ditfa_app_server_protocol::ThreadRealtimeStartTransport;
use ditfa_app_server_protocol::ThreadRealtimeStopParams;
use ditfa_app_server_protocol::ThreadRealtimeStopResponse;
use ditfa_app_server_protocol::ThreadResumeInitialTurnsPageParams;
use ditfa_app_server_protocol::ThreadResumeParams;
use ditfa_app_server_protocol::ThreadResumeResponse;
use ditfa_app_server_protocol::ThreadRollbackParams;
use ditfa_app_server_protocol::ThreadSearchOccurrence;
use ditfa_app_server_protocol::ThreadSearchOccurrencesParams;
use ditfa_app_server_protocol::ThreadSearchOccurrencesResponse;
use ditfa_app_server_protocol::ThreadSearchParams;
use ditfa_app_server_protocol::ThreadSearchResponse;
use ditfa_app_server_protocol::ThreadSearchResult;
use ditfa_app_server_protocol::ThreadSearchTextRange;
use ditfa_app_server_protocol::ThreadSetNameParams;
use ditfa_app_server_protocol::ThreadSetNameResponse;
use ditfa_app_server_protocol::ThreadSettings;
use ditfa_app_server_protocol::ThreadSettingsUpdateParams;
use ditfa_app_server_protocol::ThreadSettingsUpdateResponse;
use ditfa_app_server_protocol::ThreadShellCommandParams;
use ditfa_app_server_protocol::ThreadShellCommandResponse;
use ditfa_app_server_protocol::ThreadSortKey;
use ditfa_app_server_protocol::ThreadSourceKind;
use ditfa_app_server_protocol::ThreadStartParams;
use ditfa_app_server_protocol::ThreadStartResponse;
use ditfa_app_server_protocol::ThreadStartedNotification;
use ditfa_app_server_protocol::ThreadStatus;
use ditfa_app_server_protocol::ThreadTurnsListParams;
use ditfa_app_server_protocol::ThreadTurnsListResponse;
use ditfa_app_server_protocol::ThreadUnarchiveParams;
use ditfa_app_server_protocol::ThreadUnarchiveResponse;
use ditfa_app_server_protocol::ThreadUnarchivedNotification;
use ditfa_app_server_protocol::ThreadUnsubscribeParams;
use ditfa_app_server_protocol::ThreadUnsubscribeResponse;
use ditfa_app_server_protocol::ThreadUnsubscribeStatus;
use ditfa_app_server_protocol::Turn;
use ditfa_app_server_protocol::TurnEnvironmentParams;
use ditfa_app_server_protocol::TurnError;
use ditfa_app_server_protocol::TurnInterruptParams;
use ditfa_app_server_protocol::TurnInterruptResponse;
use ditfa_app_server_protocol::TurnItemsView;
use ditfa_app_server_protocol::TurnStartParams;
use ditfa_app_server_protocol::TurnStartResponse;
use ditfa_app_server_protocol::TurnStatus;
use ditfa_app_server_protocol::TurnSteerParams;
use ditfa_app_server_protocol::TurnSteerResponse;
use ditfa_app_server_protocol::UserInput as V2UserInput;
use ditfa_app_server_protocol::WindowsSandboxReadiness;
use ditfa_app_server_protocol::WindowsSandboxReadinessResponse;
use ditfa_app_server_protocol::WindowsSandboxSetupCompletedNotification;
use ditfa_app_server_protocol::WindowsSandboxSetupMode;
use ditfa_app_server_protocol::WindowsSandboxSetupStartParams;
use ditfa_app_server_protocol::WindowsSandboxSetupStartResponse;
use ditfa_app_server_protocol::WorkspaceMessage;
use ditfa_app_server_protocol::WorkspaceMessageType;
use ditfa_arg0::Arg0DispatchPaths;
use ditfa_backend_client::AddCreditsNudgeCreditType as BackendAddCreditsNudgeCreditType;
use ditfa_backend_client::Client as BackendClient;
use ditfa_backend_client::ConsumeRateLimitResetCreditCode as BackendConsumeRateLimitResetCreditCode;
use ditfa_backend_client::DitfaWorkspaceMessage as BackendWorkspaceMessage;
use ditfa_backend_client::DitfaWorkspaceMessageType as BackendWorkspaceMessageType;
use ditfa_backend_client::DitfaWorkspaceMessagesResponse as BackendWorkspaceMessagesResponse;
use ditfa_backend_client::RateLimitResetCreditDetails as BackendRateLimitResetCreditDetails;
use ditfa_backend_client::RateLimitResetCreditsDetails as BackendRateLimitResetCreditsDetails;
use ditfa_backend_client::RequestError as BackendRequestError;
use ditfa_backend_client::TokenUsageProfile;
use ditfa_chatgpt::connectors;
use ditfa_chatgpt::workspace_settings;
use ditfa_config::CloudConfigBundleLoadError;
use ditfa_config::CloudConfigBundleLoadErrorCode;
use ditfa_config::ConfigLayerStack;
use ditfa_config::loader::project_trust_key;
use ditfa_config::types::McpServerTransportConfig;
use ditfa_connectors::AppInfo;
use ditfa_core::DitfaThread;
use ditfa_core::DitfaThreadSettingsOverrides;
use ditfa_core::ForkSnapshot;
use ditfa_core::McpManager;
use ditfa_core::NewThread;
#[cfg(test)]
use ditfa_core::SessionMeta;
use ditfa_core::StartThreadOptions;
use ditfa_core::SteerInputError;
use ditfa_core::ThreadConfigSnapshot;
use ditfa_core::ThreadManager;
use ditfa_core::config::Config;
use ditfa_core::config::ConfigOverrides;
use ditfa_core::config::NetworkProxyAuditMetadata;
use ditfa_core::config::edit::ConfigEdit;
use ditfa_core::config::edit::ConfigEditsBuilder;
use ditfa_core::connectors::AccessibleConnectorsStatus;
use ditfa_core::exec::ExecCapturePolicy;
use ditfa_core::exec::ExecExpiration;
use ditfa_core::exec::ExecParams;
use ditfa_core::exec_env::create_env;
use ditfa_core::path_utils;
#[cfg(test)]
use ditfa_core::read_head_for_summary;
use ditfa_core::sandboxing::SandboxPermissions;
use ditfa_core::truncate_rollout_after_turn_id;
use ditfa_core::truncate_rollout_before_turn_id;
use ditfa_core::windows_sandbox::WindowsSandboxLevelExt;
use ditfa_core::windows_sandbox::WindowsSandboxSetupMode as CoreWindowsSandboxSetupMode;
use ditfa_core::windows_sandbox::WindowsSandboxSetupRequest;
use ditfa_core::windows_sandbox::sandbox_setup_is_complete;
use ditfa_core_plugins::PluginInstallError as CorePluginInstallError;
use ditfa_core_plugins::PluginInstallRequest;
use ditfa_core_plugins::PluginReadRequest;
use ditfa_core_plugins::PluginUninstallError as CorePluginUninstallError;
use ditfa_core_plugins::PluginsManager;
use ditfa_core_plugins::loader::load_plugin_apps;
use ditfa_core_plugins::loader::load_plugin_mcp_servers;
use ditfa_core_plugins::manifest::PluginManifestInterface;
use ditfa_core_plugins::marketplace::MarketplaceError;
use ditfa_core_plugins::marketplace::MarketplacePluginSource;
use ditfa_core_plugins::marketplace_add::MarketplaceAddError;
use ditfa_core_plugins::marketplace_add::MarketplaceAddRequest;
use ditfa_core_plugins::marketplace_add::add_marketplace as add_marketplace_to_ditfa_home;
use ditfa_core_plugins::marketplace_remove::MarketplaceRemoveError;
use ditfa_core_plugins::marketplace_remove::MarketplaceRemoveRequest as CoreMarketplaceRemoveRequest;
use ditfa_core_plugins::marketplace_remove::remove_marketplace;
use ditfa_core_plugins::remote::RemoteMarketplace;
use ditfa_core_plugins::remote::RemoteMarketplaceSource;
use ditfa_core_plugins::remote::RemotePluginCatalogError;
use ditfa_core_plugins::remote::RemotePluginDetail as RemoteCatalogPluginDetail;
use ditfa_core_plugins::remote::RemotePluginServiceConfig;
use ditfa_core_plugins::remote::RemotePluginShareContext as RemoteCatalogPluginShareContext;
use ditfa_core_plugins::remote::RemotePluginShareSummary as RemoteCatalogPluginShareSummary;
use ditfa_core_plugins::remote::RemotePluginSummary as RemoteCatalogPluginSummary;
use ditfa_exec_server::EnvironmentManager;
use ditfa_exec_server::EnvironmentObservedStatus;
use ditfa_exec_server::LOCAL_ENVIRONMENT_ID;
use ditfa_exec_server::LOCAL_FS;
use ditfa_features::FEATURES;
use ditfa_features::Feature;
use ditfa_features::Stage;
use ditfa_feedback::DitfaFeedback;
use ditfa_feedback::FeedbackAttachmentPath;
use ditfa_feedback::FeedbackUploadOptions;
use ditfa_git_utils::git_diff_to_remote;
use ditfa_git_utils::resolve_root_git_project_for_trust;
use ditfa_login::AuthManager;
use ditfa_login::DITFA_OPEN_APP_URL;
use ditfa_login::DitfaAuth;
use ditfa_login::LoginSuccessPage;
use ditfa_login::LoginSuccessPageBrand;
use ditfa_login::ServerOptions as LoginServerOptions;
use ditfa_login::ShutdownHandle;
use ditfa_login::complete_device_code_login;
use ditfa_login::login_with_api_key;
use ditfa_login::login_with_bedrock_api_key;
use ditfa_login::oauth_client_id;
use ditfa_login::request_device_code;
use ditfa_login::run_login_server;
use ditfa_mcp::McpRuntimeContext;
use ditfa_mcp::McpServerStatusSnapshot;
use ditfa_mcp::McpSnapshotDetail;
use ditfa_mcp::collect_mcp_server_status_snapshot_with_detail;
use ditfa_mcp::discover_supported_scopes_with_http_client;
use ditfa_mcp::read_mcp_resource as read_mcp_resource_without_thread;
use ditfa_mcp::resolve_oauth_scopes;
use ditfa_memories_write::clear_memory_roots_contents;
use ditfa_model_provider::create_model_provider;
use ditfa_models_manager::collaboration_mode_presets::builtin_collaboration_mode_presets;
use ditfa_protocol::ThreadId;
use ditfa_protocol::config_types::CollaborationMode;
use ditfa_protocol::config_types::ForcedLoginMethod;
use ditfa_protocol::config_types::Personality;
use ditfa_protocol::config_types::ReasoningSummary;
use ditfa_protocol::config_types::TrustLevel;
use ditfa_protocol::config_types::WindowsSandboxLevel;
use ditfa_protocol::error::DitfaErr;
use ditfa_protocol::error::Result as DitfaResult;
#[cfg(test)]
use ditfa_protocol::items::TurnItem;
use ditfa_protocol::models::ResponseItem;
use ditfa_protocol::openai_models::ReasoningEffort;
#[cfg(test)]
use ditfa_protocol::permissions::FileSystemSandboxPolicy;
use ditfa_protocol::protocol::AgentStatus;
use ditfa_protocol::protocol::ConversationAudioParams;
use ditfa_protocol::protocol::ConversationSpeechParams;
use ditfa_protocol::protocol::ConversationStartParams;
use ditfa_protocol::protocol::ConversationStartTransport;
use ditfa_protocol::protocol::ConversationTextParams;
use ditfa_protocol::protocol::EventMsg;
#[cfg(test)]
use ditfa_protocol::protocol::GitInfo as CoreGitInfo;
use ditfa_protocol::protocol::InitialHistory;
use ditfa_protocol::protocol::McpAuthStatus as CoreMcpAuthStatus;
use ditfa_protocol::protocol::Op;
use ditfa_protocol::protocol::RealtimeVoicesList;
use ditfa_protocol::protocol::ResumedHistory;
use ditfa_protocol::protocol::ReviewDelivery as CoreReviewDelivery;
use ditfa_protocol::protocol::ReviewRequest;
use ditfa_protocol::protocol::ReviewTarget as CoreReviewTarget;
use ditfa_protocol::protocol::RolloutItem;
use ditfa_protocol::protocol::SessionConfiguredEvent;
#[cfg(test)]
use ditfa_protocol::protocol::SessionMetaLine;
use ditfa_protocol::protocol::TurnEnvironmentSelection;
use ditfa_protocol::protocol::TurnEnvironmentSelections;
use ditfa_protocol::protocol::W3cTraceContext;
use ditfa_protocol::protocol::strip_user_message_prefix;
use ditfa_protocol::user_input::MAX_USER_INPUT_TEXT_CHARS;
use ditfa_protocol::user_input::UserInput as CoreInputItem;
use ditfa_rmcp_client::perform_oauth_login_return_url_with_http_client;
use ditfa_rollout::is_persisted_rollout_item;
use ditfa_rollout::state_db::StateDbHandle;
use ditfa_rollout::state_db::reconcile_rollout;
use ditfa_state::ThreadMetadata;
use ditfa_state::log_db::LogDbLayer;
use ditfa_thread_store::ArchiveThreadParams as StoreArchiveThreadParams;
use ditfa_thread_store::DeleteThreadsParams as StoreDeleteThreadsParams;
use ditfa_thread_store::GitInfoPatch as StoreGitInfoPatch;
use ditfa_thread_store::ListItemsParams as StoreListItemsParams;
use ditfa_thread_store::ListThreadsParams as StoreListThreadsParams;
use ditfa_thread_store::ListTurnsParams as StoreListTurnsParams;
use ditfa_thread_store::LoadThreadHistoryParams as StoreLoadThreadHistoryParams;
use ditfa_thread_store::LocalThreadStore;
use ditfa_thread_store::ReadThreadByRolloutPathParams as StoreReadThreadByRolloutPathParams;
use ditfa_thread_store::ReadThreadParams as StoreReadThreadParams;
use ditfa_thread_store::SearchThreadOccurrencesParams as StoreSearchThreadOccurrencesParams;
use ditfa_thread_store::SearchThreadsParams as StoreSearchThreadsParams;
use ditfa_thread_store::SortDirection as StoreSortDirection;
use ditfa_thread_store::StoredThread;
use ditfa_thread_store::StoredTurn;
use ditfa_thread_store::StoredTurnItemsView;
use ditfa_thread_store::StoredTurnStatus;
use ditfa_thread_store::ThreadMetadataPatch as StoreThreadMetadataPatch;
use ditfa_thread_store::ThreadRelationFilter as StoreThreadRelationFilter;
use ditfa_thread_store::ThreadSortKey as StoreThreadSortKey;
use ditfa_thread_store::ThreadStore;
use ditfa_thread_store::ThreadStoreError;
use ditfa_utils_absolute_path::AbsolutePathBuf;
use ditfa_utils_pty::DEFAULT_OUTPUT_BYTES_CAP;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Error as IoError;
use std::path::Path;
use std::path::PathBuf;
use std::result::Result;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use tokio::sync::SemaphorePermit;
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tokio_util::sync::DropGuard;
use tokio_util::task::TaskTracker;
use toml::Value as TomlValue;
use tracing::Instrument;
use tracing::error;
use tracing::info;
use tracing::warn;
use uuid::Uuid;

#[cfg(test)]
use ditfa_app_server_protocol::ServerRequest;

mod account_processor;
mod apps_processor;
mod bedrock_auth;
mod catalog_processor;
mod command_exec_processor;
mod config_processor;
mod environment_processor;
mod feedback_doctor_report;
mod feedback_processor;
mod fs_processor;
mod git_processor;
mod initialize_processor;
mod marketplace_processor;
mod mcp_processor;
mod plugins;
mod process_exec_processor;
mod remote_control_processor;
mod search;
mod thread_fork_goal;
mod thread_processor;
mod token_usage_replay;
mod turn_processor;
mod windows_sandbox_processor;

pub(crate) use account_processor::AccountRequestProcessor;
pub(crate) use apps_processor::AppsRequestProcessor;
pub(crate) use catalog_processor::CatalogRequestProcessor;
pub(crate) use command_exec_processor::CommandExecRequestProcessor;
pub(crate) use config_processor::ConfigRequestProcessor;
pub(crate) use environment_processor::EnvironmentRequestProcessor;
pub(crate) use feedback_processor::FeedbackRequestProcessor;
pub(crate) use fs_processor::FsRequestProcessor;
pub(crate) use git_processor::GitRequestProcessor;
pub(crate) use initialize_processor::InitializeRequestProcessor;
pub(crate) use marketplace_processor::MarketplaceRequestProcessor;
pub(crate) use mcp_processor::McpRequestProcessor;
pub(crate) use plugins::PluginRequestProcessor;
pub(crate) use process_exec_processor::ProcessExecRequestProcessor;
pub(crate) use remote_control_processor::RemoteControlRequestProcessor;
pub(crate) use search::SearchRequestProcessor;
pub(crate) use thread_goal_processor::ThreadGoalRequestProcessor;
pub(crate) use thread_processor::ThreadRequestProcessor;
pub(crate) use turn_processor::TurnRequestProcessor;
pub(crate) use windows_sandbox_processor::WindowsSandboxRequestProcessor;

use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use crate::filters::compute_source_filters;
use crate::filters::source_kind_matches;
use crate::thread_state::ConnectionCapabilities;
use crate::thread_state::ThreadListenerCommand;
use crate::thread_state::ThreadState;
use crate::thread_state::ThreadStateManager;
use token_usage_replay::restored_token_usage_turn_id;
use token_usage_replay::send_thread_token_usage_update_to_connection;

fn resolve_request_cwd(cwd: Option<PathBuf>) -> Result<Option<AbsolutePathBuf>, JSONRPCErrorError> {
    cwd.map(|cwd| {
        AbsolutePathBuf::relative_to_current_dir(path_utils::normalize_for_native_workdir(cwd))
            .map_err(|err| invalid_request(format!("invalid cwd: {err}")))
    })
    .transpose()
}

fn resolve_turn_environment_selections(
    thread_manager: &ThreadManager,
    environments: Option<Vec<TurnEnvironmentParams>>,
) -> Result<Option<Vec<TurnEnvironmentSelection>>, JSONRPCErrorError> {
    let Some(environments) = environments else {
        return Ok(None);
    };
    let mut selections = Vec::with_capacity(environments.len());
    for environment in environments {
        let environment_id = environment.environment_id;
        let cwd = environment
            .cwd
            .to_inferred_path_uri()
            .ok_or_else(|| {
                invalid_request(format!(
                    "invalid cwd for environment `{environment_id}`: path `{}` does not use absolute POSIX or Windows path syntax",
                    environment.cwd
                ))
            })?;
        let workspace_roots = environment
            .runtime_workspace_roots
            .map(|roots| {
                let mut resolved_roots = Vec::new();
                for root in roots {
                    let root = root.to_inferred_path_uri().ok_or_else(|| {
                        invalid_request(format!(
                            "invalid runtime workspace root for environment `{environment_id}`: path `{root}` does not use absolute POSIX or Windows path syntax"
                        ))
                    })?;
                    if !resolved_roots.contains(&root) {
                        resolved_roots.push(root);
                    }
                }
                Ok::<_, JSONRPCErrorError>(resolved_roots)
            })
            .transpose()?
            .unwrap_or_else(|| vec![cwd.clone()]);
        selections.push(TurnEnvironmentSelection {
            environment_id,
            cwd,
            workspace_roots,
        });
    }
    thread_manager
        .validate_environment_selections(&selections)
        .map_err(environment_selection_error)?;
    Ok(Some(selections))
}

fn resolve_runtime_workspace_roots(workspace_roots: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf> {
    let mut resolved_roots = Vec::new();
    for root in workspace_roots {
        if !resolved_roots.iter().any(|existing| existing == &root) {
            resolved_roots.push(root);
        }
    }
    resolved_roots
}

mod config_errors;
mod request_errors;
mod thread_delete;
mod thread_goal_processor;
mod thread_lifecycle;
mod thread_resume_redaction;
mod thread_summary;

use self::config_errors::*;
use self::request_errors::*;
use self::thread_goal_processor::api_thread_goal_from_state;
use self::thread_lifecycle::*;
use self::thread_resume_redaction::*;
use self::thread_summary::*;

pub(crate) use self::thread_lifecycle::populate_thread_turns_from_history;
pub(crate) use self::thread_processor::thread_from_stored_thread;
#[cfg(test)]
pub(crate) use self::thread_summary::read_summary_from_rollout;
#[cfg(test)]
pub(crate) use self::thread_summary::summary_to_thread;
pub(crate) use self::thread_summary::thread_settings_from_config_snapshot;
pub(crate) use self::thread_summary::thread_settings_from_core_snapshot;

pub(crate) fn build_legacy_api_turns_from_rollout_items(items: &[RolloutItem]) -> Vec<Turn> {
    let mut builder = ThreadHistoryBuilder::new();
    for item in items {
        if is_persisted_rollout_item(item, ditfa_protocol::protocol::ThreadHistoryMode::Legacy) {
            builder.handle_rollout_item(item);
        }
    }
    builder.finish()
}
