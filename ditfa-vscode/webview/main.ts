import type {
  ActiveEditorInfo,
  AgentMode,
  ApprovalAnswer,
  ChatEntry,
  ContextAttachment,
  FileChangeSummary,
  FileSuggestion,
  HostMessage,
  ModelCatalog,
  SessionState,
  SetupOption,
  SlashCommand,
  ThreadSummary,
  WebviewMessage,
} from "../src/session/types";
import {
  commandOutputHtml,
  commandStatusLabel,
  diffStat,
  formatTokens,
  renderApproval,
  renderEntry,
  sumChanges,
  timeAgo,
  type RenderContext,
} from "./entries";
import { icons } from "./icons";
import { escapeHtml, renderMarkdown } from "./markdown";
import { markSvg } from "./mark";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

interface Draft {
  text: string;
  attachments: ContextAttachment[];
}

type Popover =
  | { kind: "files"; items: FileSuggestion[]; index: number }
  | { kind: "slash"; items: SlashCommand[]; index: number }
  | { kind: "modes"; index: number }
  | { kind: "models"; catalog: ModelCatalog | null; index: number; filter: string };

const MODES: { id: AgentMode; label: string; detail: string; icon: string }[] = [
  { id: "plan", label: "Plan", detail: "Reads and plans. Writing is blocked by the sandbox.", icon: icons.plan },
  { id: "ask", label: "Ask first", detail: "Asks before every edit and command.", icon: icons.shield },
  { id: "auto", label: "Auto", detail: "Works inside this workspace; asks to step outside it.", icon: icons.bolt },
  { id: "full", label: "Full access", detail: "No sandbox and no questions. Disposable machines only.", icon: icons.warn },
];

const STARTERS = [
  "Explain how this project is structured",
  "Find the most likely bug in this codebase",
  "Write tests for the code I have open",
];

const IMAGE_LIMIT_BYTES = 8_000_000;

const vscode = acquireVsCodeApi();

const state: SessionState = {
  header: {
    connection: "starting",
    connectionError: null,
    install: null,
    threadId: null,
    threadName: null,
    cwd: null,
    workspaceOpen: true,
    provider: null,
    providerLabel: null,
    model: null,
    reasoningEffort: null,
    mode: "auto",
    accountLabel: null,
    planLabel: null,
    usagePercent: null,
    needsSetup: false,
  },
  entries: [],
  plan: [],
  planExplanation: null,
  tokenUsage: null,
  turnActive: false,
  approvals: [],
  showReasoning: true,
};

/** Rendered rows, so a delta touches one row instead of the transcript. */
const entryNodes = new Map<string, HTMLElement>();
const entriesById = new Map<string, ChatEntry>();
const expanded = new Set<string>();
const codeBlocks = new Map<string, string[]>();

const saved = safeState();
let attachments: ContextAttachment[] = saved.attachments;
let activeEditor: ActiveEditorInfo | null = null;
let includeActiveFile = true;
let pendingSkill: { name: string; path: string } | null = null;
let slashCommands: SlashCommand[] = [];
let setupOptions: SetupOption[] = [];
let suggestionToken = 0;
let popover: Popover | null = null;
let threads: ThreadSummary[] | null = null;
let historyOpen = false;
let historySearchTimer = 0;
let confirmingDelete: string | null = null;
let promptCursor = -1;
let planOpen = true;
let turnStartedAt = 0;
let workingTimer = 0;
let lastGate = "";

const root = document.getElementById("root") as HTMLDivElement;
root.innerHTML = `
  <header class="topbar" id="topbar"></header>
  <main class="scroll" id="scroll">
    <div class="transcript" id="transcript"></div>
    <div class="working" id="working" hidden></div>
    <div class="approvals" id="approvals"></div>
  </main>
  <button class="jump" id="jump" type="button" hidden>${icons.chevron}<span>Latest</span></button>
  <footer class="footer" id="footer">
    <div class="popover" id="popover" hidden></div>
    <div class="plan" id="plan" hidden></div>
    <div class="changes" id="changes" hidden></div>
    <div class="composer" id="composer-box">
      <div class="chips-row" id="attachments"></div>
      <textarea id="composer" rows="1" dir="auto" placeholder="Ask Ditfa to build, explain, or fix something"></textarea>
      <div class="toolbar">
        <button class="tool" id="attach" type="button" title="Attach a file (@)">${icons.at}</button>
        <button class="tool mode" id="mode-button" type="button"></button>
        <span class="spacer"></span>
        <button class="ring" id="ring" type="button" hidden></button>
        <button class="tool model" id="model-button" type="button"></button>
        <button class="send" id="send" type="button" title="Send">${icons.send}</button>
      </div>
    </div>
  </footer>
  <section class="gate" id="gate" hidden></section>
  <section class="history" id="history" hidden></section>
`;

const composer = document.getElementById("composer") as HTMLTextAreaElement;
const scroll = document.getElementById("scroll") as HTMLElement;
const transcript = document.getElementById("transcript") as HTMLElement;

composer.value = saved.text;
autoGrow();
wireEvents();
renderAll();

window.addEventListener("message", (event: MessageEvent<HostMessage>) => handleMessage(event.data));
window.addEventListener("error", (event) =>
  vscode.postMessage({ type: "webviewError", message: event.message }),
);
window.addEventListener("unhandledrejection", (event) =>
  vscode.postMessage({ type: "webviewError", message: String(event.reason) }),
);

vscode.postMessage({ type: "ready" });

function safeState(): Draft {
  const stored = vscode.getState<Partial<Draft>>();
  return { text: stored?.text ?? "", attachments: stored?.attachments ?? [] };
}

function saveDraft(): void {
  // Pasted images would bloat the saved state; they stay in memory only.
  vscode.setState<Draft>({
    text: composer.value,
    attachments: attachments.filter((item) => item.kind !== "image"),
  });
}

function handleMessage(message: HostMessage): void {
  switch (message.type) {
    case "state":
      Object.assign(state, message.state);
      renderAll();
      break;
    case "entryUpsert":
      upsertEntry(message.entry);
      break;
    case "entryRemove":
      removeEntry(message.id);
      break;
    case "header":
      state.header = message.header;
      renderHeader();
      renderGate();
      renderToolbar();
      renderEmpty();
      break;
    case "plan":
      state.plan = message.plan;
      state.planExplanation = message.explanation;
      renderPlan();
      break;
    case "tokenUsage":
      state.tokenUsage = message.usage;
      renderToolbar();
      break;
    case "turnActive":
      setTurnActive(message.active);
      break;
    case "approvals":
      state.approvals = message.approvals;
      renderApprovals();
      break;
    case "composerInsert":
      insertText(message.text);
      break;
    case "composerSet":
      composer.value = message.text;
      autoGrow();
      saveDraft();
      composer.focus();
      break;
    case "composerAttach":
      addAttachment(message.attachment);
      break;
    case "focusComposer":
      composer.focus();
      break;
    case "fileSuggestions":
      if (message.token === String(suggestionToken)) {
        popover = message.results.length > 0 ? { kind: "files", items: message.results, index: 0 } : null;
        renderPopover();
      }
      break;
    case "threads":
      threads = message.threads;
      renderHistory();
      break;
    case "models":
      if (popover?.kind === "models") {
        popover.catalog = message.catalog;
        renderPopover();
      }
      break;
    case "setupOptions":
      setupOptions = message.options;
      lastGate = "";
      renderGate();
      break;
    case "slashCommands":
      slashCommands = message.commands;
      break;
    case "activeEditor":
      activeEditor = message.editor;
      renderAttachments();
      break;
  }
}

function renderAll(): void {
  renderHeader();
  renderGate();
  renderTranscript();
  renderPlan();
  renderApprovals();
  renderAttachments();
  renderToolbar();
  renderChanges();
  renderWorking();
}

function renderHeader(): void {
  const host = document.getElementById("topbar") as HTMLElement;
  const title = state.header.threadName ?? firstUserText() ?? "New conversation";
  host.innerHTML = `
    <span class="topbar-mark">${markSvg(state.turnActive ? "ripple" : "none")}</span>
    <button class="thread-title" type="button" data-open-history title="Conversations">
      <span>${escapeHtml(title)}</span>${icons.chevron}
    </button>
    <button class="tool" type="button" data-new-thread title="New conversation">${icons.plus}</button>
    <button class="tool" type="button" data-open-history title="Conversations">${icons.history}</button>
  `;
}

function firstUserText(): string | null {
  const first = state.entries.find((entry) => entry.kind === "user");
  return first?.kind === "user" ? first.text.split("\n")[0]?.slice(0, 60) ?? null : null;
}

/** Everything that stands between the user and a working chat. */
function renderGate(): void {
  const host = document.getElementById("gate") as HTMLElement;
  const { connection, connectionError, install, needsSetup } = state.header;
  const key = `${connection}|${connectionError ?? ""}|${needsSetup}|${install?.stage ?? ""}`;

  const show = connection !== "ready" || needsSetup;
  host.hidden = !show;
  document.getElementById("footer")?.classList.toggle("gated", show);
  if (!show) {
    lastGate = "";
    return;
  }

  if (key === lastGate && install) {
    // Keep the mark's animation and only move the bar.
    const bar = host.querySelector<HTMLElement>(".progress-fill");
    if (bar) {
      bar.style.width = `${install.percent ?? 100}%`;
    }
    const label = host.querySelector(".progress-label");
    if (label) {
      label.textContent = installLabel();
    }
    return;
  }
  if (key === lastGate) {
    return;
  }
  lastGate = key;

  const lines = `<div class="moving-lines" aria-hidden="true">${"<span></span>".repeat(9)}</div>`;
  switch (connection) {
    case "starting":
      host.innerHTML = `${lines}<div class="gate-body">${markSvg("assemble", "gate-mark")}<p class="gate-note">Starting the engine…</p></div>`;
      break;
    case "missingBinary":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("assemble", "gate-mark")}
        <h1>One step to go</h1>
        <p>Ditfa Code runs on a small engine on this machine. It is downloaded once from GitHub and checked against its published checksum.</p>
        <button class="primary large" type="button" data-install>Install the engine</button>
        <button class="link" type="button" data-locate>I already have ditfa installed</button>
      </div>`;
      break;
    case "installing":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("ripple", "gate-mark")}
        <h1>Setting up</h1>
        <div class="progress"><div class="progress-fill" style="width:${install?.percent ?? 100}%"></div></div>
        <p class="progress-label">${installLabel()}</p>
      </div>`;
      break;
    case "unavailable":
      host.innerHTML = `${lines}<div class="gate-body">
        ${markSvg("none", "gate-mark")}
        <h1>The engine could not start</h1>
        <pre class="gate-error">${escapeHtml(connectionError ?? "Unknown error")}</pre>
        <button class="primary large" type="button" data-retry>Try again</button>
        <button class="link" type="button" data-doctor>Run diagnostics</button>
        <button class="link" type="button" data-logs>Show logs</button>
      </div>`;
      break;
    case "ready":
      host.innerHTML = `${lines}<div class="gate-body setup">${markSvg("assemble", "gate-mark")}
        <h1>Connect a model</h1>
        <p>Pick how Ditfa reaches a model. You can change this at any time.</p>
        ${renderSetupOptions()}
      </div>`;
      break;
  }
}

function renderSetupOptions(): string {
  if (setupOptions.length === 0) {
    return `<p class="gate-note">Looking for what is available…</p>`;
  }
  const row = (option: SetupOption) => `
    <button class="setup-row" type="button" data-setup="${escapeHtml(option.id)}">
      <span class="setup-icon">${option.kind === "local" ? icons.cpu : icons.key}</span>
      <span class="setup-text"><span>${escapeHtml(option.label)}</span><small>${escapeHtml(option.detail)}</small></span>
      ${option.ready ? '<span class="status-dot"></span>' : ""}
    </button>`;
  const account = setupOptions.find((option) => option.kind === "account");
  const keys = setupOptions.filter((option) => option.kind === "apiKey");
  const local = setupOptions.filter((option) => option.kind === "local");
  return `
    ${account ? `<button class="primary large" type="button" data-setup="${escapeHtml(account.id)}">${escapeHtml(account.label)}</button><p class="gate-note">${escapeHtml(account.detail)}</p>` : ""}
    <h2>Your own API key</h2><div class="setup-list">${keys.map(row).join("")}</div>
    <h2>On this machine</h2><div class="setup-list">${local.map(row).join("")}</div>
  `;
}

function installLabel(): string {
  const install = state.header.install;
  switch (install?.stage) {
    case "verify":
      return "Checking the download";
    case "unpack":
      return "Unpacking";
    default:
      return install?.percent !== null && install?.percent !== undefined
        ? `Downloading ${install.percent}%`
        : "Downloading";
  }
}

function renderContext(): RenderContext {
  return {
    expanded,
    showReasoning: state.showReasoning,
    codeBlocks,
    turnActive: state.turnActive,
  };
}

function renderTranscript(): void {
  transcript.innerHTML = "";
  entryNodes.clear();
  entriesById.clear();
  for (const entry of state.entries) {
    entriesById.set(entry.id, entry);
    const node = buildEntry(entry);
    if (node) {
      entryNodes.set(entry.id, node);
      transcript.appendChild(node);
    }
  }
  renderEmpty();
  scrollToBottom();
}

/** The welcome screen lives inside the transcript and only exists while it is empty. */
function renderEmpty(): void {
  const existing = transcript.querySelector(".empty");
  if (state.entries.length > 0) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.toggleAttribute("data-no-folder", !state.header.workspaceOpen);
    return;
  }
  const node = document.createElement("div");
  node.className = "empty";
  node.toggleAttribute("data-no-folder", !state.header.workspaceOpen);
  node.innerHTML = `
    <div class="moving-lines" aria-hidden="true">${"<span></span>".repeat(9)}</div>
    ${markSvg("assemble", "empty-mark")}
    <h1>What are we building?</h1>
    <div class="starters">
      ${STARTERS.map((text) => `<button type="button" data-starter="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}
    </div>
    <p class="no-folder-note">No folder is open, so Ditfa can read but not change anything.
      <button class="link" type="button" data-open-folder>Open a folder</button></p>
    <p class="empty-hints"><kbd>@</kbd> files &nbsp;·&nbsp; <kbd>/</kbd> commands and skills</p>
  `;
  transcript.appendChild(node);
}

function buildEntry(entry: ChatEntry): HTMLElement | null {
  const html = renderEntry(entry, renderContext());
  if (html === null) {
    return null;
  }
  const node = document.createElement("div");
  node.className = `entry entry-${entry.kind}`;
  node.dataset.entryId = entry.id;
  node.innerHTML = html;
  return node;
}

function upsertEntry(entry: ChatEntry): void {
  const known = entriesById.has(entry.id);
  entriesById.set(entry.id, entry);
  if (known) {
    const index = state.entries.findIndex((existing) => existing.id === entry.id);
    state.entries[index] = entry;
  } else {
    state.entries.push(entry);
    renderEmpty();
  }

  const stick = isNearBottom();
  const existingNode = entryNodes.get(entry.id);

  if (existingNode && patchInPlace(existingNode, entry)) {
    // Patched without replacing the row.
  } else {
    const fresh = buildEntry(entry);
    if (!fresh) {
      existingNode?.remove();
      entryNodes.delete(entry.id);
    } else {
      if (existingNode) {
        existingNode.replaceWith(fresh);
      } else {
        transcript.appendChild(fresh);
      }
      entryNodes.set(entry.id, fresh);
    }
  }

  if (entry.kind === "fileChange") {
    renderChanges();
  }
  if (entry.kind === "user" && !known) {
    renderHeader();
    scrollToBottom();
  } else if (stick) {
    scrollToBottom();
  }
  updateJump();
}

/** Updates a streaming row in place, which keeps scroll position and text selection. */
function patchInPlace(node: HTMLElement, entry: ChatEntry): boolean {
  if (entry.kind === "assistant") {
    const body = node.querySelector(".markdown");
    if (body) {
      const rendered = renderMarkdown(entry.text);
      codeBlocks.set(entry.id, rendered.codeBlocks);
      body.innerHTML = rendered.html;
      return true;
    }
  }
  if (entry.kind === "command" && entry.status === "running") {
    const output = node.querySelector<HTMLElement>(".tool-output");
    const status = node.querySelector(".tool-status");
    if (output && status) {
      const pinned = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
      output.innerHTML = commandOutputHtml(entry);
      status.textContent = commandStatusLabel(entry);
      if (pinned) {
        output.scrollTop = output.scrollHeight;
      }
      return true;
    }
  }
  return false;
}

function removeEntry(id: string): void {
  entriesById.delete(id);
  state.entries = state.entries.filter((entry) => entry.id !== id);
  entryNodes.get(id)?.remove();
  entryNodes.delete(id);
  codeBlocks.delete(id);
}

function rerenderEntry(id: string): void {
  const entry = entriesById.get(id);
  const node = entryNodes.get(id);
  if (entry && node) {
    const fresh = buildEntry(entry);
    if (fresh) {
      node.replaceWith(fresh);
      entryNodes.set(id, fresh);
    }
  }
}

function setTurnActive(active: boolean): void {
  if (state.turnActive === active) {
    return;
  }
  state.turnActive = active;
  turnStartedAt = active ? Date.now() : 0;
  renderHeader();
  renderToolbar();
  renderWorking();
  renderChanges();
  // Restore buttons only exist between turns.
  for (const entry of state.entries) {
    if (entry.kind === "user") {
      rerenderEntry(entry.id);
    }
  }
}

function renderWorking(): void {
  const host = document.getElementById("working") as HTMLElement;
  window.clearInterval(workingTimer);
  host.hidden = !state.turnActive;
  if (!state.turnActive) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `${markSvg("ripple")}<span class="working-text">Working</span><span class="working-time"></span>`;
  const time = host.querySelector(".working-time") as HTMLElement;
  const tick = () => {
    const seconds = Math.floor((Date.now() - (turnStartedAt || Date.now())) / 1000);
    time.textContent = seconds >= 3 ? `${seconds}s` : "";
  };
  tick();
  workingTimer = window.setInterval(tick, 1000);
}

function renderPlan(): void {
  const host = document.getElementById("plan") as HTMLElement;
  host.hidden = state.plan.length === 0;
  if (state.plan.length === 0) {
    host.innerHTML = "";
    return;
  }
  const done = state.plan.filter((step) => step.status === "completed").length;
  const current = state.plan.find((step) => step.status === "in_progress");
  host.innerHTML = `
    <button class="plan-head" type="button" data-toggle-plan aria-expanded="${planOpen}">
      <span class="caret${planOpen ? " open" : ""}">${icons.caret}</span>
      <span class="plan-current">${escapeHtml(current?.step ?? "Plan")}</span>
      <span class="plan-count">${done}/${state.plan.length}</span>
    </button>
    ${
      planOpen
        ? `<ul class="plan-list">${state.plan
            .map(
              (step) =>
                `<li class="plan-step plan-${step.status}"><span class="plan-marker">${step.status === "completed" ? icons.check : ""}</span><span dir="auto">${escapeHtml(step.step)}</span></li>`,
            )
            .join("")}</ul>${state.planExplanation ? `<div class="plan-note" dir="auto">${escapeHtml(state.planExplanation)}</div>` : ""}`
        : ""
    }
  `;
}

function latestChanges(): { turnId: string; changes: FileChangeSummary[] } | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "fileChange" && entry.status === "applied" && entry.turnId) {
      const turnId = entry.turnId;
      const changes = state.entries.flatMap((candidate) =>
        candidate.kind === "fileChange" && candidate.status === "applied" && candidate.turnId === turnId
          ? candidate.changes
          : [],
      );
      return { turnId, changes };
    }
  }
  return null;
}

function renderChanges(): void {
  const host = document.getElementById("changes") as HTMLElement;
  const latest = state.turnActive ? null : latestChanges();
  host.hidden = !latest;
  if (!latest) {
    host.innerHTML = "";
    return;
  }
  const files = new Set(latest.changes.map((change) => change.path)).size;
  const totals = sumChanges(latest.changes);
  host.innerHTML = `
    <span class="changes-text">${files} file${files === 1 ? "" : "s"} changed <span class="diffstat">${diffStat(totals.additions, totals.deletions)}</span></span>
    <button type="button" class="ghost-button" data-review="${escapeHtml(latest.turnId)}">Review</button>
    <button type="button" class="ghost-button" data-restore="${escapeHtml(latest.turnId)}">Undo</button>
  `;
}

function renderApprovals(): void {
  const host = document.getElementById("approvals") as HTMLElement;
  host.innerHTML = state.approvals.map(renderApproval).join("");
  if (state.approvals.length > 0) {
    scrollToBottom();
    // With the composer idle, Enter answers the card.
    if (document.activeElement !== composer || composer.value.length === 0) {
      host.querySelector<HTMLButtonElement>("button.primary")?.focus();
    }
  }
}

function renderAttachments(): void {
  const host = document.getElementById("attachments") as HTMLElement;
  const chips = attachments.map(
    (item, index) =>
      `<span class="mini-chip">${item.kind === "image" && item.dataUrl ? `<img src="${escapeHtml(item.dataUrl)}" alt="" />` : icons.file}<span>${escapeHtml(item.label)}</span><button data-remove-attachment="${index}" type="button" title="Remove">${icons.close}</button></span>`,
  );
  if (activeEditor) {
    const selection = activeEditor.selection
      ? `:${activeEditor.selection.start}${activeEditor.selection.end !== activeEditor.selection.start ? `-${activeEditor.selection.end}` : ""}`
      : "";
    chips.unshift(
      `<button class="mini-chip active-file${includeActiveFile ? "" : " off"}" type="button" data-toggle-active title="${includeActiveFile ? "Ditfa can see this file. Click to hide it." : "Click to let Ditfa see this file."}">${icons.eye}<span>${escapeHtml(activeEditor.label)}${selection}</span></button>`,
    );
  }
  if (pendingSkill) {
    chips.push(
      `<span class="mini-chip">${icons.bolt}<span>${escapeHtml(pendingSkill.name)}</span><button data-remove-skill type="button" title="Remove">${icons.close}</button></span>`,
    );
  }
  host.innerHTML = chips.join("");
  host.hidden = chips.length === 0;
}

function renderToolbar(): void {
  const header = state.header;
  const send = document.getElementById("send") as HTMLButtonElement;
  const stop = state.turnActive && composer.value.trim().length === 0;
  send.innerHTML = stop ? icons.stop : icons.send;
  send.title = stop ? "Stop" : state.turnActive ? "Add to the current turn" : "Send";
  send.classList.toggle("stop", stop);
  send.disabled = header.connection !== "ready";

  const mode = MODES.find((item) => item.id === header.mode) ?? MODES[2];
  const modeButton = document.getElementById("mode-button") as HTMLButtonElement;
  modeButton.innerHTML = `${mode?.icon ?? ""}<span>${mode?.label ?? ""}</span>`;
  modeButton.title = mode?.detail ?? "";
  modeButton.classList.toggle("danger", header.mode === "full");
  modeButton.disabled = !header.workspaceOpen;

  const model = document.getElementById("model-button") as HTMLButtonElement;
  const name = header.model ?? header.providerLabel ?? "Model";
  model.innerHTML = `<span>${escapeHtml(name)}${header.reasoningEffort ? ` · ${escapeHtml(header.reasoningEffort)}` : ""}</span>${icons.chevron}`;
  model.title = `${header.providerLabel ?? "Default provider"}: change model`;

  const ring = document.getElementById("ring") as HTMLButtonElement;
  const usage = state.tokenUsage;
  ring.hidden = !usage || usage.percentUsed === null;
  if (usage && usage.percentUsed !== null) {
    const percent = usage.percentUsed;
    const circumference = 2 * Math.PI * 6;
    ring.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="ring-track"/><circle cx="8" cy="8" r="6" class="ring-fill${percent > 85 ? " high" : ""}" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - percent / 100)}"/></svg>`;
    ring.title = `${Math.round(percent)}% of context (${formatTokens(usage.used)} of ${formatTokens(usage.contextWindow ?? 0)}), ${formatTokens(usage.total)} tokens this conversation. Click to compact.`;
  }
}

function modeRows(index: number): string {
  return MODES.map(
    (mode, position) => `
      <button class="pop-row${position === index ? " selected" : ""}${mode.id === state.header.mode ? " current" : ""}" type="button" data-mode="${mode.id}">
        <span class="pop-icon">${mode.icon}</span>
        <span class="pop-text"><span>${mode.label}</span><small>${mode.detail}</small></span>
        ${mode.id === state.header.mode ? icons.check : ""}
      </button>`,
  ).join("");
}

function filteredModels(pop: Extract<Popover, { kind: "models" }>) {
  const filter = pop.filter.trim().toLowerCase();
  return (pop.catalog?.models ?? []).filter(
    (model) => !filter || model.id.toLowerCase().includes(filter) || model.label.toLowerCase().includes(filter),
  );
}

function modelRows(pop: Extract<Popover, { kind: "models" }>): string {
  const models = filteredModels(pop);
  const rows = models
    .slice(0, 60)
    .map((model, position) => {
      const current = model.id === state.header.model;
      const efforts =
        current && model.efforts.length > 1
          ? `<span class="effort-row">${model.efforts
              .map(
                (effort) =>
                  `<span class="effort${effort === state.header.reasoningEffort ? " on" : ""}" role="button" tabindex="0" data-model="${escapeHtml(model.id)}" data-effort="${escapeHtml(effort)}">${escapeHtml(effort)}</span>`,
              )
              .join("")}</span>`
          : "";
      return `
        <button class="pop-row${position === pop.index ? " selected" : ""}" type="button" data-model="${escapeHtml(model.id)}">
          <span class="pop-text"><span>${escapeHtml(model.label)}</span>${model.description ? `<small>${escapeHtml(model.description)}</small>` : ""}${efforts}</span>
          ${current ? icons.check : ""}
        </button>`;
    })
    .join("");

  const typed = pop.filter.trim();
  const custom =
    typed && !models.some((model) => model.id === typed)
      ? `<button class="pop-row" type="button" data-model="${escapeHtml(typed)}"><span class="pop-text"><span>Use “${escapeHtml(typed)}”</span></span></button>`
      : "";
  const body = !pop.catalog
    ? `<div class="pop-note">Loading models…</div>`
    : pop.catalog.error
      ? `<div class="pop-note">${escapeHtml(pop.catalog.error)} Type a model id above, or change the provider.</div>`
      : rows || (custom ? "" : `<div class="pop-note">No models found.</div>`);
  return `
    <input class="pop-search" id="model-filter" type="text" placeholder="Search or type a model id" value="${escapeHtml(pop.filter)}" />
    <div class="pop-scroll">${body}${custom}</div>
    <button class="pop-row footer-row" type="button" data-change-provider>
      <span class="pop-text"><span>${escapeHtml(pop.catalog?.providerLabel ?? "Provider")}</span><small>Change provider</small></span>
    </button>`;
}

function renderPopover(): void {
  const host = document.getElementById("popover") as HTMLElement;
  host.hidden = popover === null;
  if (!popover) {
    host.innerHTML = "";
    return;
  }
  switch (popover.kind) {
    case "modes":
      host.innerHTML = modeRows(popover.index);
      break;
    case "models": {
      const hadFocus = document.activeElement?.id === "model-filter";
      host.innerHTML = modelRows(popover);
      const input = document.getElementById("model-filter") as HTMLInputElement;
      if (hadFocus || !popover.catalog) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      break;
    }
    case "files":
      host.innerHTML = popover.items
        .map(
          (item, index) => `
          <button class="pop-row${index === (popover as { index: number }).index ? " selected" : ""}" type="button" data-pick="${index}">
            <span class="pop-icon">${item.kind === "folder" ? icons.folder : icons.file}</span>
            <span class="pop-text"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.path)}</small></span>
          </button>`,
        )
        .join("");
      break;
    case "slash":
      host.innerHTML = popover.items
        .map(
          (item, index) => `
          <button class="pop-row${index === (popover as { index: number }).index ? " selected" : ""}" type="button" data-pick="${index}">
            <span class="pop-text"><span>/${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail)}</small></span>
            ${item.kind === "skill" ? '<span class="pop-tag">skill</span>' : ""}
          </button>`,
        )
        .join("");
      break;
  }
  host.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function closePopover(): void {
  if (popover) {
    popover = null;
    renderPopover();
  }
}

function renderHistory(): void {
  const host = document.getElementById("history") as HTMLElement;
  host.hidden = !historyOpen;
  if (!historyOpen) {
    return;
  }
  let list = host.querySelector(".history-list");
  if (!list) {
    host.innerHTML = `
      <div class="history-head">
        <input class="pop-search" id="history-search" type="text" placeholder="Search conversations" />
        <button class="tool" type="button" data-close-history title="Close">${icons.close}</button>
      </div>
      <div class="history-list"></div>`;
    list = host.querySelector(".history-list") as HTMLElement;
    (document.getElementById("history-search") as HTMLInputElement).focus();
  }
  if (threads === null) {
    list.innerHTML = `<div class="pop-note">Loading…</div>`;
    return;
  }
  if (threads.length === 0) {
    list.innerHTML = `<div class="pop-note">No conversations here yet.</div>`;
    return;
  }
  list.innerHTML = threads
    .map(
      (thread) => `
      <div class="history-row${thread.active ? " active" : ""}">
        <button class="history-open" type="button" data-resume="${escapeHtml(thread.id)}">
          <span class="history-title" dir="auto">${escapeHtml(thread.title)}</span>
          <small>${timeAgo(thread.updatedAt)} · ${escapeHtml(thread.provider)}</small>
        </button>
        <button class="tool" type="button" data-rename="${escapeHtml(thread.id)}" title="Rename">${icons.pencil}</button>
        <button class="tool${confirmingDelete === thread.id ? " danger" : ""}" type="button" data-delete="${escapeHtml(thread.id)}" title="${confirmingDelete === thread.id ? "Click again to delete" : "Delete"}">${icons.trash}</button>
      </div>`,
    )
    .join("");
}

function openHistory(): void {
  historyOpen = true;
  threads = null;
  confirmingDelete = null;
  renderHistory();
  vscode.postMessage({ type: "listThreads", query: "" });
}

function closeHistory(): void {
  historyOpen = false;
  (document.getElementById("history") as HTMLElement).innerHTML = "";
  renderHistory();
  composer.focus();
}

function wireEvents(): void {
  composer.addEventListener("input", () => {
    autoGrow();
    saveDraft();
    promptCursor = -1;
    updateSuggestions();
    renderToolbar();
  });

  composer.addEventListener("keydown", onComposerKey);
  composer.addEventListener("paste", onPaste);

  const box = document.getElementById("composer-box") as HTMLElement;
  box.addEventListener("dragover", (event) => event.preventDefault());
  box.addEventListener("drop", onDrop);

  scroll.addEventListener("scroll", updateJump, { passive: true });
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onRootKey);
}

function onRootKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (event.key === "Escape") {
    if (historyOpen) {
      closeHistory();
    } else if (popover) {
      closePopover();
      composer.focus();
    } else if (state.turnActive) {
      vscode.postMessage({ type: "interrupt" });
    }
    return;
  }
  if (target.id === "model-filter" && popover?.kind === "models") {
    const models = filteredModels(popover);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      popover.index = (popover.index + delta + Math.max(models.length, 1)) % Math.max(models.length, 1);
      renderPopover();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = models[popover.index]?.id ?? popover.filter.trim();
      if (picked) {
        chooseModel(picked, null);
      }
    }
  }
}

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.id === "model-filter" && popover?.kind === "models") {
    popover.filter = target.value;
    popover.index = 0;
    renderPopover();
    target.focus();
  } else if (target.id === "history-search") {
    window.clearTimeout(historySearchTimer);
    historySearchTimer = window.setTimeout(() => {
      vscode.postMessage({ type: "listThreads", query: target.value });
    }, 200);
  }
}

function onComposerKey(event: KeyboardEvent): void {
  if (popover && (popover.kind === "files" || popover.kind === "slash")) {
    const count = popover.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      popover.index = (popover.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      renderPopover();
      return;
    }
    if ((event.key === "Enter" && !event.isComposing) || event.key === "Tab") {
      event.preventDefault();
      pickSuggestion(popover.index);
      return;
    }
  }

  if (event.key === "ArrowUp" && composer.value.length === 0 && !event.shiftKey) {
    recallPrompt(1);
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" && promptCursor >= 0) {
    recallPrompt(-1);
    event.preventDefault();
    return;
  }

  // During IME composition Enter confirms the candidate; it must not send.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function recallPrompt(direction: number): void {
  const prompts = state.entries.flatMap((entry) => (entry.kind === "user" ? [entry.text] : [])).reverse();
  const next = promptCursor + direction;
  if (next >= prompts.length) {
    return;
  }
  promptCursor = next;
  composer.value = next < 0 ? "" : (prompts[next] ?? "");
  autoGrow();
}

function onPaste(event: ClipboardEvent): void {
  for (const item of event.clipboardData?.items ?? []) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file && file.size <= IMAGE_LIMIT_BYTES) {
        event.preventDefault();
        attachImage(file);
      }
    }
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const list = event.dataTransfer?.getData("text/uri-list") ?? "";
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith("file://")) {
      const path = decodeURIComponent(line.replace(/^file:\/\//, ""));
      addAttachment({ kind: "file", path, label: path.split("/").pop() ?? path });
    }
  }
  for (const file of event.dataTransfer?.files ?? []) {
    if (file.type.startsWith("image/") && file.size <= IMAGE_LIMIT_BYTES) {
      attachImage(file);
    }
  }
}

function attachImage(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    addAttachment({
      kind: "image",
      path: file.name || "image",
      label: file.name || "Pasted image",
      dataUrl: String(reader.result),
    });
  };
  reader.readAsDataURL(file);
}

function addAttachment(attachment: ContextAttachment): void {
  if (!attachments.some((item) => item.path === attachment.path && item.label === attachment.label)) {
    attachments.push(attachment);
    renderAttachments();
    saveDraft();
  }
}

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  const hit = (selector: string) => target.closest<HTMLElement>(selector);

  if (!hit("#popover") && !hit("#mode-button") && !hit("#model-button") && !hit("#attach")) {
    closePopover();
  }

  const fileLink = hit("[data-open-file]");
  if (fileLink) {
    event.preventDefault();
    const line = fileLink.dataset.line;
    vscode.postMessage({
      type: "openFile",
      path: fileLink.dataset.openFile ?? "",
      ...(line ? { line: Number(line) } : {}),
    });
    return;
  }
  const link = hit("a[href]");
  if (link) {
    event.preventDefault();
    vscode.postMessage({ type: "openExternal", url: link.getAttribute("href") ?? "" });
    return;
  }

  if (hit("#send")) {
    submit();
  } else if (hit("#attach")) {
    insertText("@", true);
    updateSuggestions();
  } else if (hit("#mode-button")) {
    popover = popover?.kind === "modes" ? null : { kind: "modes", index: MODES.findIndex((mode) => mode.id === state.header.mode) };
    renderPopover();
  } else if (hit("#model-button")) {
    if (popover?.kind === "models") {
      closePopover();
    } else {
      popover = { kind: "models", catalog: null, index: 0, filter: "" };
      renderPopover();
      vscode.postMessage({ type: "requestModels" });
    }
  } else if (hit("#ring")) {
    vscode.postMessage({ type: "slashCommand", id: "compact" });
  } else if (hit("#jump")) {
    scrollToBottom();
    updateJump();
  } else if (hit("[data-open-history]")) {
    openHistory();
  } else if (hit("[data-close-history]")) {
    closeHistory();
  } else if (hit("[data-new-thread]")) {
    vscode.postMessage({ type: "newThread" });
  } else if (hit("[data-install]")) {
    vscode.postMessage({ type: "installEngine" });
  } else if (hit("[data-locate]")) {
    vscode.postMessage({ type: "locateBinary" });
  } else if (hit("[data-retry]")) {
    vscode.postMessage({ type: "retryConnection" });
  } else if (hit("[data-doctor]")) {
    vscode.postMessage({ type: "runDoctor" });
  } else if (hit("[data-logs]")) {
    vscode.postMessage({ type: "showLogs" });
  } else if (hit("[data-open-folder]")) {
    vscode.postMessage({ type: "openFolder" });
  } else if (hit("[data-remove-skill]")) {
    pendingSkill = null;
    renderAttachments();
  } else if (hit("[data-toggle-plan]")) {
    planOpen = !planOpen;
    renderPlan();
  } else if (hit("[data-toggle-active]")) {
    includeActiveFile = !includeActiveFile;
    renderAttachments();
  } else if (hit("[data-change-provider]")) {
    closePopover();
    vscode.postMessage({ type: "selectProvider" });
  } else {
    onDataClick(target, hit);
  }
}

function onDataClick(target: HTMLElement, hit: (selector: string) => HTMLElement | null): void {
  const setup = hit("[data-setup]")?.dataset.setup;
  const mode = hit("[data-mode]")?.dataset.mode as AgentMode | undefined;
  const effort = hit("[data-effort]");
  const model = hit("[data-model]")?.dataset.model;
  const pick = hit("[data-pick]")?.dataset.pick;
  const starter = hit("[data-starter]")?.dataset.starter;
  const toggle = hit("[data-toggle]")?.dataset.toggle;
  const copyIndex = hit("[data-copy-index]")?.dataset.copyIndex;
  const diffRow = hit("[data-diff-path]");
  const restore = hit("[data-restore]")?.dataset.restore;
  const review = hit("[data-review]")?.dataset.review;
  const errorAction = hit("[data-error-action]")?.dataset.errorAction;
  const removeAttachment = hit("[data-remove-attachment]")?.dataset.removeAttachment;
  const resume = hit("[data-resume]")?.dataset.resume;
  const rename = hit("[data-rename]")?.dataset.rename;
  const remove = hit("[data-delete]")?.dataset.delete;
  const approval = hit("[data-approval-id]");

  if (setup) {
    vscode.postMessage({ type: "setupProvider", id: setup });
  } else if (mode) {
    closePopover();
    vscode.postMessage({ type: "setMode", mode });
  } else if (effort) {
    chooseModel(effort.dataset.model ?? "", effort.dataset.effort ?? null);
  } else if (model) {
    chooseModel(model, null);
  } else if (pick !== undefined) {
    pickSuggestion(Number(pick));
  } else if (starter) {
    composer.value = starter;
    submit();
  } else if (toggle) {
    if (expanded.has(toggle)) {
      expanded.delete(toggle);
    } else {
      expanded.add(toggle);
    }
    rerenderEntry(toggle);
  } else if (copyIndex !== undefined) {
    const entryId = hit("[data-entry-id]")?.dataset.entryId;
    const code = entryId ? codeBlocks.get(entryId)?.[Number(copyIndex)] : undefined;
    const button = target.closest("button");
    if (code !== undefined && button) {
      vscode.postMessage({ type: "copy", text: code });
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1200);
    }
  } else if (diffRow) {
    vscode.postMessage({
      type: "openDiff",
      entryId: diffRow.dataset.diffEntry ?? "",
      path: diffRow.dataset.diffPath ?? "",
    });
  } else if (restore) {
    vscode.postMessage({ type: "restoreCheckpoint", turnId: restore });
  } else if (review) {
    vscode.postMessage({ type: "reviewTurn", turnId: review });
  } else if (errorAction) {
    vscode.postMessage({ type: "errorAction", action: errorAction as "retry" });
  } else if (removeAttachment !== undefined) {
    attachments.splice(Number(removeAttachment), 1);
    renderAttachments();
    saveDraft();
  } else if (resume) {
    vscode.postMessage({ type: "resumeThread", threadId: resume });
    closeHistory();
  } else if (rename) {
    startRename(rename);
  } else if (remove) {
    if (confirmingDelete === remove) {
      confirmingDelete = null;
      vscode.postMessage({ type: "deleteThread", threadId: remove });
    } else {
      confirmingDelete = remove;
      renderHistory();
    }
  } else if (approval) {
    handleApprovalClick(approval, target);
  }
}

function startRename(threadId: string): void {
  const row = document.querySelector(`[data-resume="${CSS.escape(threadId)}"]`);
  const thread = threads?.find((item) => item.id === threadId);
  if (!row || !thread) {
    return;
  }
  const input = document.createElement("input");
  input.className = "pop-search";
  input.value = thread.title;
  row.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const title = input.value.trim();
    if (title && title !== thread.title) {
      thread.title = title;
      vscode.postMessage({ type: "renameThread", threadId, title });
    }
    renderHistory();
  };
  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
}

function chooseModel(model: string, effort: string | null): void {
  const catalog = popover?.kind === "models" ? popover.catalog : null;
  const choice = catalog?.models.find((item) => item.id === model);
  vscode.postMessage({ type: "selectModel", model, effort });
  // Stay open when a model offers effort levels, so the choice is one click away.
  if (effort === null && choice && choice.efforts.length > 1 && popover?.kind === "models") {
    state.header.model = model;
    renderPopover();
    return;
  }
  closePopover();
  composer.focus();
}

function handleApprovalClick(node: HTMLElement, target: HTMLElement): void {
  const id = node.dataset.approvalId ?? "";
  const kind = node.dataset.approvalKind ?? "";
  const answer = (value: ApprovalAnswer) => {
    vscode.postMessage({ type: "approval", answer: value });
    node.classList.add("answered");
  };

  const decision = target.closest<HTMLElement>("[data-decision]")?.dataset.decision;
  if (decision) {
    if (kind === "command" || kind === "fileChange") {
      answer({ id, kind, decision: decision as "accept" });
    } else if (kind === "permissions" || kind === "elicitation") {
      answer({ id, kind, decision: decision as "accept" });
    }
    return;
  }
  const value = target.closest<HTMLElement>("[data-value]")?.dataset.value;
  if (value !== undefined) {
    answer({ id, kind: "userInput", value });
    return;
  }
  if (target.closest("[data-freeform]")) {
    const input = node.querySelector<HTMLInputElement>(".approval-input");
    answer({ id, kind: "userInput", value: input?.value ?? "" });
  }
}

function submit(): void {
  const text = composer.value.trim();
  if (text.length === 0) {
    if (state.turnActive) {
      vscode.postMessage({ type: "interrupt" });
    }
    return;
  }
  if (state.header.connection !== "ready") {
    return;
  }

  const command = /^\/(\S+)$/.exec(text)?.[1];
  const builtin = slashCommands.find((item) => item.kind === "builtin" && item.label === command);
  if (builtin) {
    vscode.postMessage({ type: "slashCommand", id: builtin.id });
  } else {
    vscode.postMessage({
      type: "send",
      text,
      attachments: [...attachments],
      skill: pendingSkill,
      includeActiveFile,
    });
  }

  composer.value = "";
  attachments = [];
  pendingSkill = null;
  promptCursor = -1;
  closePopover();
  renderAttachments();
  autoGrow();
  saveDraft();
  renderToolbar();
}

function updateSuggestions(): void {
  const upToCursor = composer.value.slice(0, composer.selectionStart);

  const slash = /^\/([^\s]*)$/.exec(upToCursor);
  if (slash) {
    const query = (slash[1] ?? "").toLowerCase();
    const items = slashCommands
      .filter((item) => item.label.toLowerCase().includes(query))
      .slice(0, 12);
    popover = items.length > 0 ? { kind: "slash", items, index: 0 } : null;
    renderPopover();
    return;
  }

  const mention = /(?:^|\s)@([^\s@]*)$/.exec(upToCursor);
  if (!mention) {
    if (popover?.kind === "files" || popover?.kind === "slash") {
      closePopover();
    }
    return;
  }
  suggestionToken += 1;
  vscode.postMessage({
    type: "requestFileSuggestions",
    token: String(suggestionToken),
    query: mention[1] ?? "",
  });
}

function pickSuggestion(index: number): void {
  if (popover?.kind === "files") {
    const item = popover.items[index];
    if (item) {
      const cursor = composer.selectionStart;
      const before = composer.value.slice(0, cursor).replace(/@[^\s@]*$/, "");
      const after = composer.value.slice(cursor);
      composer.value = `${before}${after}`;
      composer.selectionStart = before.length;
      composer.selectionEnd = before.length;
      addAttachment({ kind: item.kind, path: item.path, label: item.label });
    }
  } else if (popover?.kind === "slash") {
    const item = popover.items[index];
    if (item?.kind === "builtin") {
      composer.value = "";
      vscode.postMessage({ type: "slashCommand", id: item.id });
    } else if (item?.path) {
      pendingSkill = { name: item.label, path: item.path };
      composer.value = "";
      renderAttachments();
    }
  }
  closePopover();
  autoGrow();
  saveDraft();
  composer.focus();
}

function insertText(text: string, atCursor = false): void {
  if (atCursor) {
    const start = composer.selectionStart;
    composer.setRangeText(text, start, composer.selectionEnd, "end");
  } else {
    const separator = composer.value.trim().length > 0 ? "\n\n" : "";
    composer.value = `${composer.value}${separator}${text}`;
    composer.selectionStart = composer.value.length;
    composer.selectionEnd = composer.value.length;
  }
  autoGrow();
  saveDraft();
  composer.focus();
}

function autoGrow(): void {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 240)}px`;
}

function isNearBottom(): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
}

function scrollToBottom(): void {
  scroll.scrollTop = scroll.scrollHeight;
}

function updateJump(): void {
  (document.getElementById("jump") as HTMLElement).hidden = isNearBottom();
}

