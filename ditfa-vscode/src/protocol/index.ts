/**
 * Typed surface over the ditfa app-server JSON-RPC protocol.
 *
 * `generated/` mirrors the ts-rs output from `ditfa-rs/app-server-protocol` and is
 * the authority on payload shapes. This module adds the request/response pairing
 * that the generated types express as a discriminated union but that a client
 * needs as a lookup: given a method name, what goes in and what comes back.
 */
import type { InitializeParams } from "./generated/InitializeParams";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { FuzzyFileSearchParams } from "./generated/FuzzyFileSearchParams";
import type { FuzzyFileSearchResponse } from "./generated/FuzzyFileSearchResponse";
import type { GitDiffToRemoteParams } from "./generated/GitDiffToRemoteParams";
import type { GitDiffToRemoteResponse } from "./generated/GitDiffToRemoteResponse";

import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadListParams } from "./generated/v2/ThreadListParams";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadSetNameParams } from "./generated/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse } from "./generated/v2/ThreadSetNameResponse";
import type { ThreadArchiveParams } from "./generated/v2/ThreadArchiveParams";
import type { ThreadArchiveResponse } from "./generated/v2/ThreadArchiveResponse";
import type { ThreadCompactStartParams } from "./generated/v2/ThreadCompactStartParams";
import type { ThreadCompactStartResponse } from "./generated/v2/ThreadCompactStartResponse";
import type { ThreadUnsubscribeParams } from "./generated/v2/ThreadUnsubscribeParams";
import type { ThreadUnsubscribeResponse } from "./generated/v2/ThreadUnsubscribeResponse";

import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse";
import type { ReviewStartParams } from "./generated/v2/ReviewStartParams";
import type { ReviewStartResponse } from "./generated/v2/ReviewStartResponse";

import type { ModelListParams } from "./generated/v2/ModelListParams";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { ConfigReadParams } from "./generated/v2/ConfigReadParams";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { PermissionProfileListParams } from "./generated/v2/PermissionProfileListParams";
import type { PermissionProfileListResponse } from "./generated/v2/PermissionProfileListResponse";

import type { GetAccountParams } from "./generated/v2/GetAccountParams";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { CancelLoginAccountParams } from "./generated/v2/CancelLoginAccountParams";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse";
import type { LogoutAccountResponse } from "./generated/v2/LogoutAccountResponse";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse";
import type { GetAccountTokenUsageResponse } from "./generated/v2/GetAccountTokenUsageResponse";

export type { ServerNotification } from "./generated/ServerNotification";
export type { ServerRequest } from "./generated/ServerRequest";
export type { Thread } from "./generated/v2/Thread";
export type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
export type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
export type { ThreadItem } from "./generated/v2/ThreadItem";
export type { ThreadStatus } from "./generated/v2/ThreadStatus";
export type { Turn } from "./generated/v2/Turn";
export type { TurnStatus } from "./generated/v2/TurnStatus";
export type { TurnError } from "./generated/v2/TurnError";
export type { TurnPlanStep } from "./generated/v2/TurnPlanStep";
export type { ThreadTokenUsage } from "./generated/v2/ThreadTokenUsage";
export type { UserInput } from "./generated/v2/UserInput";
export type { Model } from "./generated/v2/Model";
export type { Account } from "./generated/v2/Account";
export type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot";
export type { RateLimitWindow } from "./generated/v2/RateLimitWindow";
export type { AskForApproval } from "./generated/v2/AskForApproval";
export type { SandboxMode } from "./generated/v2/SandboxMode";
export type { ReasoningEffort } from "./generated/ReasoningEffort";
export type { FileUpdateChange } from "./generated/v2/FileUpdateChange";
export type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision";
export type { FileChangeApprovalDecision } from "./generated/v2/FileChangeApprovalDecision";
export type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams";
export type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams";
export type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams";
export type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams";
export type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification";
export type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification";
export type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification";
export type { ReasoningSummaryTextDeltaNotification } from "./generated/v2/ReasoningSummaryTextDeltaNotification";
export type { CommandExecutionOutputDeltaNotification } from "./generated/v2/CommandExecutionOutputDeltaNotification";
export type { TurnStartedNotification } from "./generated/v2/TurnStartedNotification";
export type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification";
export type { TurnPlanUpdatedNotification } from "./generated/v2/TurnPlanUpdatedNotification";
export type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification";
export type { ThreadStartedNotification } from "./generated/v2/ThreadStartedNotification";
export type { ErrorNotification } from "./generated/v2/ErrorNotification";
export type { AccountLoginCompletedNotification } from "./generated/v2/AccountLoginCompletedNotification";
export type { AccountUpdatedNotification } from "./generated/v2/AccountUpdatedNotification";
export type { AccountRateLimitsUpdatedNotification } from "./generated/v2/AccountRateLimitsUpdatedNotification";

/**
 * Client -> server calls this extension makes, paired with their responses.
 *
 * app-server exposes far more than this; the map covers what the extension
 * actually uses so an unlisted method is a compile error rather than a silent
 * `any`.
 */
export interface RequestMap {
  initialize: { params: InitializeParams; result: InitializeResponse };

  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "thread/read": { params: ThreadReadParams; result: ThreadReadResponse };
  "thread/name/set": { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  "thread/archive": { params: ThreadArchiveParams; result: ThreadArchiveResponse };
  "thread/compact/start": { params: ThreadCompactStartParams; result: ThreadCompactStartResponse };
  "thread/unsubscribe": { params: ThreadUnsubscribeParams; result: ThreadUnsubscribeResponse };

  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
  "turn/steer": { params: TurnSteerParams; result: TurnSteerResponse };
  "review/start": { params: ReviewStartParams; result: ReviewStartResponse };

  "model/list": { params: ModelListParams; result: ModelListResponse };
  "config/read": { params: ConfigReadParams; result: ConfigReadResponse };
  "permissionProfile/list": {
    params: PermissionProfileListParams;
    result: PermissionProfileListResponse;
  };

  "account/read": { params: GetAccountParams; result: GetAccountResponse };
  "account/login/start": { params: LoginAccountParams; result: LoginAccountResponse };
  "account/login/cancel": { params: CancelLoginAccountParams; result: CancelLoginAccountResponse };
  "account/logout": { params: undefined; result: LogoutAccountResponse };
  "account/rateLimits/read": { params: undefined; result: GetAccountRateLimitsResponse };
  "account/usage/read": { params: undefined; result: GetAccountTokenUsageResponse };

  fuzzyFileSearch: { params: FuzzyFileSearchParams; result: FuzzyFileSearchResponse };
  gitDiffToRemote: { params: GitDiffToRemoteParams; result: GitDiffToRemoteResponse };
}

export type RequestMethod = keyof RequestMap;
export type RequestParams<M extends RequestMethod> = RequestMap[M]["params"];
export type RequestResult<M extends RequestMethod> = RequestMap[M]["result"];

/** JSON-RPC id. app-server accepts both numeric and string ids. */
export type RequestId = number | string;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  id: RequestId;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return "id" in message && "result" in message;
}

export function isFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return "id" in message && "error" in message;
}
