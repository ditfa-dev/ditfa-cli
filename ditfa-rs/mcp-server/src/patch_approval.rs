use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use ditfa_core::DitfaThread;
use ditfa_protocol::ThreadId;
use ditfa_protocol::protocol::FileChange;
use ditfa_protocol::protocol::Op;
use ditfa_protocol::protocol::ReviewDecision;
use rmcp::model::ErrorData;
use rmcp::model::RequestId;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tracing::error;

use crate::outgoing_message::OutgoingMessageSender;

#[derive(Debug, Deserialize, Serialize)]
pub struct PatchApprovalElicitRequestParams {
    pub message: String,
    #[serde(rename = "requestedSchema")]
    pub requested_schema: Value,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    pub ditfa_elicitation: String,
    pub ditfa_mcp_tool_call_id: String,
    pub ditfa_event_id: String,
    pub ditfa_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ditfa_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ditfa_grant_root: Option<PathBuf>,
    pub ditfa_changes: HashMap<PathBuf, FileChange>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PatchApprovalResponse {
    pub decision: ReviewDecision,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_patch_approval_request(
    call_id: String,
    reason: Option<String>,
    grant_root: Option<PathBuf>,
    changes: HashMap<PathBuf, FileChange>,
    outgoing: Arc<OutgoingMessageSender>,
    ditfa: Arc<DitfaThread>,
    request_id: RequestId,
    tool_call_id: String,
    event_id: String,
    thread_id: ThreadId,
) {
    let approval_id = call_id.clone();
    let mut message_lines = Vec::new();
    if let Some(r) = &reason {
        message_lines.push(r.clone());
    }
    message_lines.push("Allow Ditfa to apply proposed code changes?".to_string());

    let params = PatchApprovalElicitRequestParams {
        message: message_lines.join("\n"),
        requested_schema: json!({"type":"object","properties":{}}),
        thread_id,
        ditfa_elicitation: "patch-approval".to_string(),
        ditfa_mcp_tool_call_id: tool_call_id.clone(),
        ditfa_event_id: event_id.clone(),
        ditfa_call_id: call_id,
        ditfa_reason: reason,
        ditfa_grant_root: grant_root,
        ditfa_changes: changes,
    };
    let params_json = match serde_json::to_value(&params) {
        Ok(value) => value,
        Err(err) => {
            let message = format!("Failed to serialize PatchApprovalElicitRequestParams: {err}");
            error!("{message}");

            outgoing
                .send_error(request_id.clone(), ErrorData::invalid_params(message, None))
                .await;

            return;
        }
    };

    let on_response = outgoing
        .send_request("elicitation/create", Some(params_json))
        .await;

    // Listen for the response on a separate task so we don't block the main agent loop.
    {
        let ditfa = ditfa.clone();
        let approval_id = approval_id.clone();
        tokio::spawn(async move {
            on_patch_approval_response(approval_id, on_response, ditfa).await;
        });
    }
}

pub(crate) async fn on_patch_approval_response(
    approval_id: String,
    receiver: tokio::sync::oneshot::Receiver<serde_json::Value>,
    ditfa: Arc<DitfaThread>,
) {
    let response = receiver.await;
    let value = match response {
        Ok(value) => value,
        Err(err) => {
            error!("request failed: {err:?}");
            if let Err(submit_err) = ditfa
                .submit(Op::PatchApproval {
                    id: approval_id.clone(),
                    decision: ReviewDecision::denied("approval request failed"),
                })
                .await
            {
                error!("failed to submit denied PatchApproval after request failure: {submit_err}");
            }
            return;
        }
    };

    let response = serde_json::from_value::<PatchApprovalResponse>(value).unwrap_or_else(|err| {
        error!("failed to deserialize PatchApprovalResponse: {err}");
        PatchApprovalResponse {
            decision: ReviewDecision::denied("approval request failed"),
        }
    });

    if let Err(err) = ditfa
        .submit(Op::PatchApproval {
            id: approval_id,
            decision: response.decision,
        })
        .await
    {
        error!("failed to submit PatchApproval: {err}");
    }
}
