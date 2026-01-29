import type {
  ApprovalRequest,
  ChatEntry,
  FileChangeSummary,
  HostMessage,
  PlanStep,
  SessionHeader,
  SessionState,
  TokenUsageView,
  WebviewMessage,
} from "../src/session/types";
import { escapeHtml, renderMarkdown, stripAnsi } from "./markdown";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const vscode = acquireVsCodeApi();

const state: SessionState = {
  header: {
    connection: "starting",
    connectionError: null,
    threadId: null,
    threadName: null,
    cwd: null,
    provider: null,
    model: null,
    reasoningEffort: null,
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    accountLabel: null,
    planLabel: null,
    usagePercent: null,
  },
  entries: [],
  plan: [],
  planExplanation: null,
  tokenUsage: null,
  turnActive: false,
  approvals: [],
  showReasoning: true,
};

/** Rendered entry nodes, so a delta re-renders one row instead of the transcript. */
const entryNodes = new Map<string, HTMLElement>();
/** Code block text per entry, keyed for the copy buttons. */
const codeBlocksByEntry = new Map<string, string[]>();
const collapsedEntries = new Set<string>();

let attachments: string[] = [];
let suggestionToken = 0;
let activeSuggestions: { label: string; path: string }[] = [];
let suggestionIndex = 0;

const root = document.getElementById("root") as HTMLDivElement;
render();

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      Object.assign(state, message.state);
      entryNodes.clear();
      render();
      break;
    case "entries":
      state.entries = message.entries;
      entryNodes.clear();
      renderTranscript();
      break;
    case "entryUpsert":
      upsertEntry(message.entry);
      break;
    case "header":
      state.header = message.header;
      renderHeader();
      break;
    case "plan":
      state.plan = message.plan;
      state.planExplanation = message.explanation;
      renderPlan();
      break;
    case "tokenUsage":
      state.tokenUsage = message.usage;
      renderUsage();
      break;
    case "turnActive":
      state.turnActive = message.active;
      renderComposerState();
      break;
    case "approvals":
      state.approvals = message.approvals;
      renderApprovals();
      break;
    case "composerInsert":
      insertIntoComposer(message.text);
      break;
    case "focusComposer":
      composer()?.focus();
      break;
    case "fileSuggestions":
      if (message.token === String(suggestionToken)) {
        activeSuggestions = message.results;
        suggestionIndex = 0;
        renderSuggestions();
      }
      break;
  }
});

vscode.postMessage({ type: "ready" });

function render(): void {
  root.innerHTML = `
    <div class="header" id="header"></div>
    <div class="scroll" id="scroll">
      <div class="plan" id="plan"></div>
      <div class="transcript" id="transcript"></div>
      <div class="approvals" id="approvals"></div>
    </div>
    <div class="footer">
      <div class="usage" id="usage"></div>
      <div class="composer">
        <div class="attachments" id="attachments"></div>
        <div class="suggestions" id="suggestions"></div>
        <textarea id="composer" rows="1" placeholder="Ask Ditfa to build, explain, or fix something.  Use @ to attach a file."></textarea>
        <div class="composer-actions">
          <div class="composer-hint" id="composer-hint"></div>
          <button id="send" class="primary" type="button">Send</button>
        </div>
      </div>
    </div>
  `;

  wireComposer();
  renderHeader();
  renderPlan();
  renderTranscript();
  renderApprovals();
  renderUsage();
  renderComposerState();
}

function renderHeader(): void {
  const host = document.getElementById("header");
  if (!host) {
    return;
  }
  const header = state.header;

  if (header.connection === "unavailable") {
    host.className = "header header-error";
    host.innerHTML = `
      <div class="header-error-body">
        <span class="codicon-warning">⚠</span>
        <span>${escapeHtml(header.connectionError ?? "Ditfa is not connected.")}</span>
      </div>
      <div class="header-error-actions">
        <button data-action="retryConnection" type="button">Retry</button>
        <button data-action="showLogs" type="button">Logs</button>
      </div>
    `;
    return;
  }

  host.className = "header";
  const modelLabel = header.model ?? "default model";
  const effort = header.reasoningEffort ? ` · ${header.reasoningEffort}` : "";
  const account = header.accountLabel
    ? `${header.accountLabel}${header.planLabel ? ` · ${header.planLabel}` : ""}`
    : "Not signed in";

  host.innerHTML = `
    <button class="chip" data-action="selectModel" type="button" title="Change provider or model">
      <span class="chip-icon">◆</span>
      <span>${escapeHtml(header.provider ? `${header.provider}/${modelLabel}` : modelLabel)}${escapeHtml(effort)}</span>
    </button>
    <button class="chip" data-action="selectApprovalMode" type="button" title="Change approval mode">
      <span class="chip-icon">${header.sandboxMode === "danger-full-access" ? "⚠" : "🛡"}</span>
      <span>${escapeHtml(approvalLabel(header))}</span>
    </button>
    <button class="chip chip-right" data-action="${header.accountLabel ? "showAccount" : "signIn"}" type="button" title="Ditfa account and usage">
      <span class="chip-icon">◐</span>
      <span>${escapeHtml(account)}</span>
      ${header.usagePercent !== null ? `<span class="chip-usage">${Math.round(header.usagePercent)}%</span>` : ""}
    </button>
  `;
}

function approvalLabel(header: SessionHeader): string {
  if (header.sandboxMode === "danger-full-access") {
    return "Full access";
  }
  if (header.sandboxMode === "read-only") {
    return "Read only";
  }
  return header.approvalPolicy === "never" ? "Auto" : "Ask on request";
}

function renderPlan(): void {
  const host = document.getElementById("plan");
  if (!host) {
    return;
  }
  if (state.plan.length === 0) {
    host.innerHTML = "";
    host.classList.remove("visible");
    return;
  }
  host.classList.add("visible");
  const done = state.plan.filter((step) => step.status === "completed").length;
  host.innerHTML = `
    <div class="plan-head">
      <span>Plan</span>
      <span class="plan-count">${done}/${state.plan.length}</span>
    </div>
    <ul class="plan-list">
      ${state.plan.map(renderPlanStep).join("")}
    </ul>
    ${state.planExplanation ? `<div class="plan-note">${escapeHtml(state.planExplanation)}</div>` : ""}
  `;
}

function renderPlanStep(step: PlanStep): string {
  const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "◐" : "○";
  return `<li class="plan-step plan-${step.status}"><span class="plan-marker">${marker}</span>${escapeHtml(step.step)}</li>`;
}

function renderTranscript(): void {
  const host = document.getElementById("transcript");
  if (!host) {
    return;
  }
  host.innerHTML = "";
  entryNodes.clear();
  if (state.entries.length === 0) {
    host.innerHTML = emptyStateHtml();
    return;
  }
  for (const entry of state.entries) {
    const node = buildEntry(entry);
    if (node) {
      entryNodes.set(entry.id, node);
      host.appendChild(node);
    }
  }
  scrollToBottom();
}

function emptyStateHtml(): string {
  return `
    <div class="empty">
      <div class="empty-title">Ditfa Code</div>
      <p>A multi-provider coding agent that reads, writes, and runs code in this workspace.</p>
      <ul class="empty-hints">
        <li><kbd>@</kbd> attaches a file from the workspace</li>
        <li>Select code in the editor, then <em>Add Selection to Chat</em></li>
        <li>Every command and file edit is shown before it is applied</li>
      </ul>
    </div>
  `;
}

function upsertEntry(entry: ChatEntry): void {
  const index = state.entries.findIndex((existing) => existing.id === entry.id);
  if (index === -1) {
    state.entries.push(entry);
  } else {
    state.entries[index] = entry;
  }

  const host = document.getElementById("transcript");
  if (!host) {
    return;
  }
  if (host.querySelector(".empty")) {
    host.innerHTML = "";
  }

  const atBottom = isNearBottom();
  const fresh = buildEntry(entry);
  const existingNode = entryNodes.get(entry.id);

  if (!fresh) {
    if (existingNode) {
      existingNode.remove();
      entryNodes.delete(entry.id);
    }
    return;
  }

  if (existingNode) {
    existingNode.replaceWith(fresh);
  } else {
    host.appendChild(fresh);
  }
  entryNodes.set(entry.id, fresh);

  if (atBottom) {
    scrollToBottom();
  }
}

function buildEntry(entry: ChatEntry): HTMLElement | null {
  if (entry.kind === "reasoning" && !state.showReasoning) {
    return null;
  }

  const node = document.createElement("div");
  node.className = `entry entry-${entry.kind}`;
  node.dataset.entryId = entry.id;

  switch (entry.kind) {
    case "user":
      node.innerHTML = `
        <div class="bubble user-bubble">
          <div class="entry-text">${escapeHtml(entry.text).replace(/\n/g, "<br />")}</div>
          ${
            entry.attachments.length > 0
              ? `<div class="chips">${entry.attachments
                  .map((path) => `<span class="mini-chip">@${escapeHtml(path)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>
      `;
      break;

    case "assistant": {
      const rendered = renderMarkdown(entry.text);
      codeBlocksByEntry.set(entry.id, rendered.codeBlocks);
      node.innerHTML = `
        <div class="markdown">${rendered.html}</div>
        ${entry.streaming ? '<div class="cursor"></div>' : ""}
      `;
      break;
    }

    case "reasoning": {
      const collapsed = collapsedEntries.has(entry.id);
      node.innerHTML = `
        <button class="reasoning-toggle" type="button" data-toggle="${escapeHtml(entry.id)}">
          <span class="caret">${collapsed ? "▸" : "▾"}</span> Thinking${entry.streaming ? "…" : ""}
        </button>
        ${collapsed ? "" : `<div class="reasoning-body">${escapeHtml(entry.summary).replace(/\n/g, "<br />")}</div>`}
      `;
      break;
    }

    case "command": {
      const collapsed = collapsedEntries.has(entry.id);
      const output = stripAnsi(entry.output);
      node.innerHTML = `
        <div class="tool-card status-${entry.status}">
          <button class="tool-head" type="button" data-toggle="${escapeHtml(entry.id)}">
            <span class="caret">${collapsed ? "▸" : "▾"}</span>
            <span class="tool-icon">$</span>
            <code class="tool-title">${escapeHtml(entry.command)}</code>
            <span class="tool-status">${commandStatusLabel(entry.status, entry.exitCode, entry.durationMs)}</span>
          </button>
          ${
            collapsed || output.trim() === ""
              ? ""
              : `<pre class="tool-output">${escapeHtml(tailLines(output, 400))}</pre>`
          }
        </div>
      `;
      break;
    }

    case "fileChange": {
      const totals = entry.changes.reduce(
        (acc, change) => ({
          additions: acc.additions + change.additions,
          deletions: acc.deletions + change.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      node.innerHTML = `
        <div class="tool-card patch-${entry.status}">
          <div class="tool-head static">
            <span class="tool-icon">±</span>
            <span class="tool-title">${entry.changes.length} file${entry.changes.length === 1 ? "" : "s"} changed</span>
            <span class="diffstat"><span class="add">+${totals.additions}</span> <span class="del">-${totals.deletions}</span></span>
            <span class="tool-status">${patchStatusLabel(entry.status)}</span>
          </div>
          <div class="file-list">
            ${entry.changes.map((change) => renderFileRow(entry.id, change)).join("")}
          </div>
        </div>
      `;
      break;
    }

    case "toolCall":
      node.innerHTML = `
        <div class="tool-card status-${entry.status}">
          <div class="tool-head static">
            <span class="tool-icon">⚙</span>
            <span class="tool-title">${escapeHtml(entry.title)}</span>
            <span class="tool-status">${entry.status}${entry.durationMs ? ` · ${formatDuration(entry.durationMs)}` : ""}</span>
          </div>
          ${entry.detail ? `<pre class="tool-output">${escapeHtml(entry.detail)}</pre>` : ""}
        </div>
      `;
      break;

    case "webSearch":
      node.innerHTML = `
        <div class="tool-card">
          <div class="tool-head static">
            <span class="tool-icon">⌕</span>
            <span class="tool-title">Searched the web for “${escapeHtml(entry.query)}”</span>
          </div>
        </div>
      `;
      break;

    case "notice":
      node.innerHTML = `<div class="notice notice-${entry.tone}">${escapeHtml(entry.text)}</div>`;
      break;

    case "error":
      node.innerHTML = `
        <div class="error-card">
          <div class="error-title">${escapeHtml(entry.message)}</div>
          ${entry.details ? `<pre class="error-details">${escapeHtml(entry.details)}</pre>` : ""}
          ${entry.retrying ? '<div class="error-retry">Retrying…</div>' : ""}
        </div>
      `;
      break;
  }

  return node;
}

function renderFileRow(entryId: string, change: FileChangeSummary): string {
  const kindMark = change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M";
  return `
    <button class="file-row" type="button" data-diff-entry="${escapeHtml(entryId)}" data-diff-path="${escapeHtml(change.path)}">
      <span class="file-kind kind-${change.kind}">${kindMark}</span>
      <span class="file-name">${escapeHtml(change.label)}</span>
      <span class="file-path">${escapeHtml(change.path)}</span>
      <span class="diffstat"><span class="add">+${change.additions}</span> <span class="del">-${change.deletions}</span></span>
    </button>
  `;
}

function renderApprovals(): void {
  const host = document.getElementById("approvals");
  if (!host) {
    return;
  }
  host.innerHTML = state.approvals.map(renderApproval).join("");
  if (state.approvals.length > 0) {
    scrollToBottom();
  }
}

function renderApproval(request: ApprovalRequest): string {
  switch (request.kind) {
    case "command":
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="command">
          <div class="approval-title">Run this command?</div>
          ${request.reason ? `<div class="approval-reason">${escapeHtml(request.reason)}</div>` : ""}
          <pre class="approval-command">${escapeHtml(request.command)}</pre>
          ${request.cwd ? `<div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>` : ""}
          <div class="approval-actions">
            <button class="primary" data-decision="accept" type="button">Run</button>
            ${request.canAlwaysAllow ? '<button data-decision="acceptForSession" type="button">Always in this session</button>' : ""}
            <button data-decision="decline" type="button">Skip</button>
            <button class="ghost" data-decision="cancel" type="button">Stop</button>
          </div>
        </div>
      `;

    case "fileChange": {
      const totals = request.changes.reduce(
        (acc, change) => ({
          additions: acc.additions + change.additions,
          deletions: acc.deletions + change.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="fileChange">
          <div class="approval-title">Apply these edits?</div>
          ${request.reason ? `<div class="approval-reason">${escapeHtml(request.reason)}</div>` : ""}
          <div class="approval-diffstat">
            ${request.changes.length} file${request.changes.length === 1 ? "" : "s"}
            <span class="add">+${totals.additions}</span> <span class="del">-${totals.deletions}</span>
          </div>
          <div class="file-list">
            ${request.changes.map((change) => renderFileRow(request.id, change)).join("")}
          </div>
          <div class="approval-actions">
            <button class="primary" data-decision="accept" type="button">Apply</button>
            <button data-decision="acceptForSession" type="button">Always in this session</button>
            <button data-decision="decline" type="button">Skip</button>
            <button class="ghost" data-decision="cancel" type="button">Stop</button>
          </div>
        </div>
      `;
    }

    case "permissions":
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="permissions">
          <div class="approval-title">Grant ${escapeHtml(request.summary)}?</div>
          ${request.reason ? `<div class="approval-reason">${escapeHtml(request.reason)}</div>` : ""}
          <div class="approval-cwd">in ${escapeHtml(request.cwd)}</div>
          <div class="approval-actions">
            <button class="primary" data-decision="accept" type="button">Grant</button>
            <button data-decision="decline" type="button">Deny</button>
          </div>
        </div>
      `;

    case "userInput":
      return `
        <div class="approval" data-approval-id="${escapeHtml(request.id)}" data-approval-kind="userInput">
          <div class="approval-title">${escapeHtml(request.question)}</div>
          <div class="approval-actions">
            ${request.options
              .map(
                (option) =>
                  `<button data-value="${escapeHtml(option.value)}" type="button">${escapeHtml(option.label)}</button>`,
              )
              .join("")}
          </div>
          ${
            request.allowFreeform
              ? `<div class="approval-freeform">
                   <input type="text" class="approval-input" placeholder="Type an answer…" />
                   <button class="primary" data-freeform="1" type="button">Reply</button>
                 </div>`
              : ""
          }
        </div>
      `;
  }
}

function renderUsage(): void {
  const host = document.getElementById("usage");
  if (!host) {
    return;
  }
  const usage: TokenUsageView | null = state.tokenUsage;
  if (!usage) {
    host.innerHTML = "";
    return;
  }
  const percent = usage.percentUsed;
  host.innerHTML = `
    <div class="usage-row">
      <span>${formatTokens(usage.used)} tokens</span>
      ${
        percent !== null
          ? `<span class="usage-bar"><span class="usage-fill${percent > 85 ? " high" : ""}" style="width:${percent.toFixed(1)}%"></span></span>
             <span>${Math.round(percent)}% of context</span>`
          : ""
      }
    </div>
  `;
}

function renderComposerState(): void {
  const send = document.getElementById("send") as HTMLButtonElement | null;
  const hint = document.getElementById("composer-hint");
  if (!send || !hint) {
    return;
  }
  if (state.turnActive) {
    const hasDraft = (composer()?.value.trim().length ?? 0) > 0;
    send.textContent = hasDraft ? "Steer" : "Stop";
    send.classList.toggle("stop", !hasDraft);
    hint.textContent = "Ditfa is working — type to steer it";
  } else {
    send.textContent = "Send";
    send.classList.remove("stop");
    hint.textContent = "Enter to send · Shift+Enter for a new line";
  }
  send.disabled = state.header.connection !== "ready";
}

function renderAttachments(): void {
  const host = document.getElementById("attachments");
  if (!host) {
    return;
  }
  host.innerHTML = attachments
    .map(
      (path) =>
        `<span class="mini-chip">@${escapeHtml(path)}<button data-remove-attachment="${escapeHtml(path)}" type="button">×</button></span>`,
    )
    .join("");
}

function renderSuggestions(): void {
  const host = document.getElementById("suggestions");
  if (!host) {
    return;
  }
  if (activeSuggestions.length === 0) {
    host.innerHTML = "";
    host.classList.remove("visible");
    return;
  }
  host.classList.add("visible");
  host.innerHTML = activeSuggestions
    .map(
      (item, index) =>
        `<button class="suggestion${index === suggestionIndex ? " selected" : ""}" data-suggestion="${escapeHtml(item.path)}" type="button">
           <span class="suggestion-label">${escapeHtml(item.label)}</span>
           <span class="suggestion-path">${escapeHtml(item.path)}</span>
         </button>`,
    )
    .join("");
}

function wireComposer(): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }

  textarea.addEventListener("input", () => {
    autoGrow(textarea);
    maybeRequestSuggestions(textarea);
    if (state.turnActive) {
      // While a turn runs the button means "stop" only when there is nothing to
      // steer with, so its label tracks the composer contents.
      renderComposerState();
    }
  });

  textarea.addEventListener("keydown", (event) => {
    if (activeSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        suggestionIndex = (suggestionIndex + 1) % activeSuggestions.length;
        renderSuggestions();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        suggestionIndex = (suggestionIndex - 1 + activeSuggestions.length) % activeSuggestions.length;
        renderSuggestions();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = activeSuggestions[suggestionIndex];
        if (picked) {
          acceptSuggestion(picked.path);
        }
        return;
      }
      if (event.key === "Escape") {
        activeSuggestions = [];
        renderSuggestions();
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  root.addEventListener("click", onClick);
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (action) {
    handleAction(action);
    return;
  }

  const send = target.closest("#send");
  if (send) {
    submit();
    return;
  }

  const toggle = target.closest("[data-toggle]")?.getAttribute("data-toggle");
  if (toggle) {
    if (collapsedEntries.has(toggle)) {
      collapsedEntries.delete(toggle);
    } else {
      collapsedEntries.add(toggle);
    }
    const entry = state.entries.find((candidate) => candidate.id === toggle);
    if (entry) {
      upsertEntry(entry);
    }
    return;
  }

  const copyIndex = target.closest("[data-copy-index]")?.getAttribute("data-copy-index");
  if (copyIndex !== null && copyIndex !== undefined) {
    const entryId = target.closest("[data-entry-id]")?.getAttribute("data-entry-id");
    const blocks = entryId ? codeBlocksByEntry.get(entryId) : undefined;
    const code = blocks?.[Number(copyIndex)];
    if (code !== undefined) {
      vscode.postMessage({ type: "copy", text: code });
      const button = target.closest("button");
      if (button) {
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1200);
      }
    }
    return;
  }

  const fileRow = target.closest("[data-diff-path]");
  if (fileRow) {
    vscode.postMessage({
      type: "openDiff",
      entryId: fileRow.getAttribute("data-diff-entry") ?? "",
      path: fileRow.getAttribute("data-diff-path") ?? "",
    });
    return;
  }

  const suggestion = target.closest("[data-suggestion]")?.getAttribute("data-suggestion");
  if (suggestion) {
    acceptSuggestion(suggestion);
    return;
  }

  const removeAttachment = target
    .closest("[data-remove-attachment]")
    ?.getAttribute("data-remove-attachment");
  if (removeAttachment) {
    attachments = attachments.filter((path) => path !== removeAttachment);
    renderAttachments();
    return;
  }

  const approvalNode = target.closest("[data-approval-id]") as HTMLElement | null;
  if (approvalNode) {
    handleApprovalClick(approvalNode, target);
  }
}

function handleAction(action: string): void {
  switch (action) {
    case "selectModel":
      vscode.postMessage({ type: "selectModel" });
      break;
    case "selectApprovalMode":
      vscode.postMessage({ type: "selectApprovalMode" });
      break;
    case "signIn":
      vscode.postMessage({ type: "signIn" });
      break;
    case "showAccount":
      vscode.postMessage({ type: "showAccount" });
      break;
    case "showLogs":
      vscode.postMessage({ type: "showLogs" });
      break;
    case "retryConnection":
      vscode.postMessage({ type: "retryConnection" });
      break;
  }
}

function handleApprovalClick(approvalNode: HTMLElement, target: HTMLElement): void {
  const id = approvalNode.getAttribute("data-approval-id") ?? "";
  const kind = approvalNode.getAttribute("data-approval-kind") ?? "";

  const decision = target.closest("[data-decision]")?.getAttribute("data-decision");
  if (decision) {
    if (kind === "command" || kind === "fileChange") {
      vscode.postMessage({
        type: "approval",
        answer: { id, kind, decision: decision as "accept" | "acceptForSession" | "decline" | "cancel" },
      });
    } else if (kind === "permissions") {
      vscode.postMessage({
        type: "approval",
        answer: { id, kind: "permissions", decision: decision as "accept" | "decline" },
      });
    }
    approvalNode.classList.add("answered");
    return;
  }

  const value = target.closest("[data-value]")?.getAttribute("data-value");
  if (value !== null && value !== undefined) {
    vscode.postMessage({ type: "approval", answer: { id, kind: "userInput", value } });
    approvalNode.classList.add("answered");
    return;
  }

  if (target.closest("[data-freeform]")) {
    const input = approvalNode.querySelector(".approval-input") as HTMLInputElement | null;
    vscode.postMessage({
      type: "approval",
      answer: { id, kind: "userInput", value: input?.value ?? "" },
    });
    approvalNode.classList.add("answered");
  }
}

function submit(): void {
  if (state.turnActive) {
    const textarea = composer();
    const text = textarea?.value.trim() ?? "";
    if (text.length === 0) {
      vscode.postMessage({ type: "interrupt" });
      return;
    }
    // Non-empty text during an active turn steers instead of stopping.
  }

  const textarea = composer();
  if (!textarea) {
    return;
  }
  const text = textarea.value.trim();
  if (text.length === 0) {
    return;
  }

  vscode.postMessage({ type: "send", text, attachments: [...attachments] });
  textarea.value = "";
  attachments = [];
  activeSuggestions = [];
  renderAttachments();
  renderSuggestions();
  autoGrow(textarea);
}

function maybeRequestSuggestions(textarea: HTMLTextAreaElement): void {
  const upToCursor = textarea.value.slice(0, textarea.selectionStart);
  const match = /@([^\s@]*)$/.exec(upToCursor);
  if (!match) {
    if (activeSuggestions.length > 0) {
      activeSuggestions = [];
      renderSuggestions();
    }
    return;
  }
  suggestionToken += 1;
  vscode.postMessage({
    type: "requestFileSuggestions",
    token: String(suggestionToken),
    query: match[1] ?? "",
  });
}

function acceptSuggestion(path: string): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }
  const cursor = textarea.selectionStart;
  const before = textarea.value.slice(0, cursor).replace(/@[^\s@]*$/, "");
  const after = textarea.value.slice(cursor);
  textarea.value = `${before}${after}`;
  textarea.selectionStart = before.length;
  textarea.selectionEnd = before.length;

  if (!attachments.includes(path)) {
    attachments.push(path);
  }
  activeSuggestions = [];
  renderAttachments();
  renderSuggestions();
  autoGrow(textarea);
  textarea.focus();
}

function insertIntoComposer(text: string): void {
  const textarea = composer();
  if (!textarea) {
    return;
  }
  const separator = textarea.value.trim().length > 0 ? "\n\n" : "";
  textarea.value = `${textarea.value}${separator}${text}`;
  autoGrow(textarea);
  textarea.focus();
  textarea.selectionStart = textarea.value.length;
  textarea.selectionEnd = textarea.value.length;
}

function composer(): HTMLTextAreaElement | null {
  return document.getElementById("composer") as HTMLTextAreaElement | null;
}

function autoGrow(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

function scrollElement(): HTMLElement | null {
  return document.getElementById("scroll");
}

function isNearBottom(): boolean {
  const scroll = scrollElement();
  if (!scroll) {
    return true;
  }
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
}

function scrollToBottom(): void {
  const scroll = scrollElement();
  if (scroll) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

function commandStatusLabel(
  status: string,
  exitCode: number | null,
  durationMs: number | null,
): string {
  if (status === "running") {
    return "running…";
  }
  const parts: string[] = [];
  if (exitCode !== null) {
    parts.push(exitCode === 0 ? "exit 0" : `exit ${exitCode}`);
  }
  if (durationMs !== null) {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" · ") || status;
}

function patchStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "awaiting approval";
    case "applied":
      return "applied";
    case "aborted":
      return "skipped";
    default:
      return "failed";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Terminal output can be enormous; only the tail is interesting while scanning. */
function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) {
    return text;
  }
  return `… ${lines.length - max} earlier lines hidden\n${lines.slice(-max).join("\n")}`;
}
