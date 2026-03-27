use std::sync::Arc;

use ditfa_code_mode_protocol::CellId;
use ditfa_code_mode_protocol::CodeModeNestedToolCall;
use ditfa_code_mode_protocol::CodeModeSessionDelegate;
use ditfa_code_mode_protocol::NotificationFuture;
use ditfa_code_mode_protocol::ToolInvocationFuture;
use ditfa_code_mode_protocol::host::DelegateRequest;
use ditfa_code_mode_protocol::host::DelegateResponse;
use ditfa_code_mode_protocol::host::SessionId;
use tokio_util::sync::CancellationToken;

use crate::peer::HostPeer;

pub(super) struct RemoteDelegate {
    session_id: SessionId,
    peer: Arc<HostPeer>,
}

impl RemoteDelegate {
    pub(super) fn new(session_id: SessionId, peer: Arc<HostPeer>) -> Self {
        Self { session_id, peer }
    }
}

impl CodeModeSessionDelegate for RemoteDelegate {
    fn invoke_tool<'a>(
        &'a self,
        invocation: CodeModeNestedToolCall,
        cancellation_token: CancellationToken,
    ) -> ToolInvocationFuture<'a> {
        Box::pin(async move {
            match self
                .peer
                .call(
                    self.session_id.clone(),
                    DelegateRequest::InvokeTool {
                        invocation: invocation.into(),
                    },
                    cancellation_token,
                )
                .await?
            {
                DelegateResponse::ToolResult { result } => Ok(result),
                DelegateResponse::NotificationDelivered => {
                    Err("code-mode client returned an invalid tool result".to_string())
                }
            }
        })
    }

    fn notify<'a>(
        &'a self,
        call_id: String,
        cell_id: CellId,
        text: String,
        cancellation_token: CancellationToken,
    ) -> NotificationFuture<'a> {
        Box::pin(async move {
            match self
                .peer
                .call(
                    self.session_id.clone(),
                    DelegateRequest::Notify {
                        call_id,
                        cell_id: cell_id.into(),
                        text,
                    },
                    cancellation_token,
                )
                .await?
            {
                DelegateResponse::NotificationDelivered => Ok(()),
                DelegateResponse::ToolResult { .. } => {
                    Err("code-mode client returned an invalid notification result".to_string())
                }
            }
        })
    }

    fn cell_closed(&self, cell_id: &CellId) {
        self.peer
            .close_cell(self.session_id.clone(), cell_id.clone());
    }
}
