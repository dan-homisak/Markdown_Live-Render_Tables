import * as vscode from "vscode";

const LIVE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.liveEditor";
const LEGACY_TABLE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.tableEditor";
const DEBUG_SETTING = "debug";

let debugOutputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkdownLiveEditorProvider(context);
  debugOutputChannel = vscode.window.createOutputChannel("Markdown Live Editor");

  context.subscriptions.push(
    debugOutputChannel,
    vscode.window.registerCustomEditorProvider(
      LIVE_EDITOR_VIEW_TYPE,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.window.registerCustomEditorProvider(
      LEGACY_TABLE_EDITOR_VIEW_TYPE,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.toggleEditor",
      async (uri?: vscode.Uri) => {
        await toggleEditor(uri, provider);
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.openSourceEditor",
      async (uri?: vscode.Uri) => {
        await openSourceEditor(uri, provider);
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.showDebugLog",
      () => {
        debugOutputChannel?.show(true);
      },
    ),
  );
}

export function deactivate(): void {}

class MarkdownLiveEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panelsByDocument = new Map<string, vscode.WebviewPanel>();
  private activeLiveDocumentUri: vscode.Uri | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getActiveDocumentUri(): vscode.Uri | undefined {
    return this.activeLiveDocumentUri;
  }

  public getViewColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return this.panelsByDocument.get(uri.toString())?.viewColumn;
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const webview = webviewPanel.webview;
    const scriptFileName =
      webviewPanel.viewType === LEGACY_TABLE_EDITOR_VIEW_TYPE
        ? "tableEditor.js"
        : "liveEditor.js";
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", scriptFileName),
    );
    const documentKey = document.uri.toString();

    this.panelsByDocument.set(documentKey, webviewPanel);
    if (webviewPanel.active) {
      this.activeLiveDocumentUri = document.uri;
    }

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webviewPanel.title = document.fileName.split(/[\\/]/).pop() ?? "Markdown";

    let applyingFromWebview = false;
    let applyQueue: Promise<void> = Promise.resolve();
    let documentRevision = 0;

    const postDocument = (): void => {
      documentRevision++;
      void webview.postMessage({
        type: "setDocument",
        text: document.getText(),
        revision: documentRevision,
        debug: isDebugEnabled(),
      } satisfies HostSetDocumentMessage);
    };

    const applyFromWebview = (message: ChangeMessage): void => {
      applyQueue = applyQueue
        .then(async () => {
          applyingFromWebview = true;
          try {
            if (message.changes?.length) {
              logDebug(
                `apply ${message.changes.length} change(s) from webview at revision ${message.baseRevision}`,
              );
              await applyDocumentChanges(document, message.changes);
            } else {
              vscode.window.showWarningMessage(
                "Markdown live editor ignored a change without source ranges.",
              );
              logDebug("ignored change message without source ranges");
            }
          } finally {
            applyingFromWebview = false;
          }

          if (document.getText() !== message.text) {
            vscode.window.showWarningMessage(
              "Markdown live editor changes were applied, but the editor document is out of sync.",
            );
          }
          postDocument();
        })
        .catch((error: unknown) => {
          applyingFromWebview = false;
          vscode.window.showErrorMessage(
            `Markdown live editor could not apply changes: ${String(error)}`,
          );
        });
    };

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          event.document.uri.toString() === documentKey &&
          !applyingFromWebview
        ) {
          postDocument();
        }
      }),
      webviewPanel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) {
          this.activeLiveDocumentUri = document.uri;
        }
      }),
      webview.onDidReceiveMessage((message: unknown) => {
        if (isReadyMessage(message)) {
          postDocument();
          return;
        }

        if (isOpenSourceMessage(message)) {
          logDebug(`open source requested for ${document.uri.toString()}`);
          void openSourceEditor(
            document.uri,
            this,
            vscode.window.tabGroups.activeTabGroup.activeTab,
          );
          return;
        }

        if (isDebugMessage(message)) {
          logDebug(`${message.event}: ${JSON.stringify(message.details)}`);
          return;
        }

        if (
          isChangeMessage(message) &&
          message.text !== document.getText() &&
          message.baseRevision <= documentRevision
        ) {
          applyFromWebview(message);
        }
      }),
    );

    webview.html = getEditorHtml(webview, scriptUri, document.getText());
    setTimeout(postDocument, 0);
    setTimeout(postDocument, 250);

    webviewPanel.onDidDispose(() => {
      this.panelsByDocument.delete(documentKey);
      if (this.activeLiveDocumentUri?.toString() === documentKey) {
        this.activeLiveDocumentUri = undefined;
      }
      vscode.Disposable.from(...disposables).dispose();
    });
  }
}

async function toggleEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
): Promise<void> {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const activeInput = activeTab?.input;

  if (
    activeInput instanceof vscode.TabInputCustom &&
    isLiveEditorViewType(activeInput.viewType)
  ) {
    await openSourceEditor(uri ?? activeInput.uri, provider, activeTab);
    return;
  }

  if (activeInput instanceof vscode.TabInputText) {
    await openLiveEditor(uri ?? activeInput.uri, provider, activeTab);
    return;
  }

  const activeTextUri = vscode.window.activeTextEditor?.document.uri;
  const activeLiveUri = provider.getActiveDocumentUri();
  if (activeTextUri) {
    await openLiveEditor(
      uri ?? activeTextUri,
      provider,
      vscode.window.tabGroups.activeTabGroup.activeTab,
    );
    return;
  }
  await openSourceEditor(
    uri ?? activeLiveUri,
    provider,
    vscode.window.tabGroups.activeTabGroup.activeTab,
  );
}

function isLiveEditorViewType(viewType: string): boolean {
  return (
    viewType === LIVE_EDITOR_VIEW_TYPE ||
    viewType === LEGACY_TABLE_EDITOR_VIEW_TYPE
  );
}

async function openLiveEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
  tabToClose?: vscode.Tab,
): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showWarningMessage("Open a markdown file before opening the live editor.");
    return;
  }

  const viewColumn =
    vscode.window.activeTextEditor?.viewColumn ??
    provider.getViewColumn(targetUri) ??
    vscode.ViewColumn.Active;

  await vscode.commands.executeCommand(
    "vscode.openWith",
    targetUri,
    LIVE_EDITOR_VIEW_TYPE,
    {
      viewColumn,
      preserveFocus: false,
    },
  );
  await closeTabIfReplaced(tabToClose, targetUri);
}

async function openSourceEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
  tabToClose?: vscode.Tab,
): Promise<void> {
  const targetUri =
    uri ?? provider.getActiveDocumentUri() ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    vscode.window.showWarningMessage("Open a live markdown editor before returning to source.");
    return;
  }

  const viewColumn = provider.getViewColumn(targetUri) ?? vscode.ViewColumn.Active;
  await vscode.window.showTextDocument(targetUri, {
    viewColumn,
    preview: false,
    preserveFocus: false,
  });
  await closeTabIfReplaced(tabToClose, targetUri);
}

async function closeTabIfReplaced(
  tab: vscode.Tab | undefined,
  uri: vscode.Uri,
): Promise<void> {
  if (!tab || !tabMatchesUri(tab, uri)) {
    return;
  }

  if (vscode.window.tabGroups.activeTabGroup.activeTab === tab) {
    return;
  }

  const document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === uri.toString(),
  );
  if (document?.isDirty) {
    logDebug(
      `leaving renderer tab open for dirty document ${uri.toString()} to avoid save prompt`,
    );
    return;
  }

  await vscode.window.tabGroups.close(tab, true);
}

function tabMatchesUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
  const input = tab.input;
  return (
    (input instanceof vscode.TabInputText &&
      input.uri.toString() === uri.toString()) ||
    (input instanceof vscode.TabInputCustom &&
      input.uri.toString() === uri.toString())
  );
}

async function applyDocumentChanges(
  document: vscode.TextDocument,
  changes: readonly DocumentChange[],
): Promise<void> {
  if (changes.length === 0) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const change of changes) {
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(change.from),
        document.positionAt(change.to),
      ),
      change.text,
    );
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showWarningMessage("Markdown live editor could not apply changes.");
  }
}

interface ReadyMessage {
  type: "ready";
}

interface DocumentChange {
  from: number;
  to: number;
  text: string;
}

interface ChangeMessage {
  type: "change";
  text: string;
  changes?: DocumentChange[];
  baseRevision: number;
}

interface DebugMessage {
  type: "debug";
  event: string;
  details: unknown;
}

interface OpenSourceMessage {
  type: "openSource";
}

interface HostSetDocumentMessage {
  type: "setDocument";
  text: string;
  revision: number;
  debug: boolean;
}

function isReadyMessage(message: unknown): message is ReadyMessage {
  return isMessageRecord(message) && message.type === "ready";
}

function isChangeMessage(message: unknown): message is ChangeMessage {
  return (
    isMessageRecord(message) &&
    message.type === "change" &&
    typeof message.text === "string" &&
    (message.changes === undefined ||
      (Array.isArray(message.changes) &&
        message.changes.every(isDocumentChange))) &&
    typeof message.baseRevision === "number"
  );
}

function isDocumentChange(change: unknown): change is DocumentChange {
  if (!isMessageRecord(change)) {
    return false;
  }

  const from = change.from;
  const to = change.to;
  return (
    typeof from === "number" &&
    Number.isInteger(from) &&
    from >= 0 &&
    typeof to === "number" &&
    Number.isInteger(to) &&
    to >= from &&
    typeof change.text === "string"
  );
}

function isOpenSourceMessage(message: unknown): message is OpenSourceMessage {
  return isMessageRecord(message) && message.type === "openSource";
}

function isDebugMessage(message: unknown): message is DebugMessage {
  return (
    isMessageRecord(message) &&
    message.type === "debug" &&
    typeof message.event === "string" &&
    "details" in message
  );
}

function isMessageRecord(message: unknown): message is Record<string, unknown> {
  return Boolean(message) && typeof message === "object";
}

function isDebugEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("markdownLiveRenderTables")
    .get<boolean>(DEBUG_SETTING, false);
}

function logDebug(message: string): void {
  if (!isDebugEnabled()) {
    return;
  }

  debugOutputChannel?.appendLine(
    `[${new Date().toISOString()}] ${message}`,
  );
}

function getEditorHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  initialText: string,
): string {
  const nonce = getNonce();
  const initialDocumentScript = JSON.stringify(initialText).replace(
    /<\/script/gi,
    "<\\/script",
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html,
    body,
    #app {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .mm-live-v4-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }

    .mm-live-v4-toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex: 0 0 auto;
      min-height: 28px;
      padding: 0.2rem 0.5rem;
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      background: var(--vscode-editorWidget-background, #252526);
    }

    .mm-live-v4-source-button {
      flex: 0 0 auto;
      min-height: 22px;
      padding: 0 0.55rem;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      color: var(--vscode-button-foreground, #ffffff);
      background: var(--vscode-button-background, #0e639c);
      font: 12px/20px var(--vscode-font-family, sans-serif);
      cursor: pointer;
    }

    .mm-live-v4-source-button:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    .mm-live-v4-source-button:focus {
      outline: 1px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }

    .mm-live-v4-status {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--vscode-descriptionForeground, #cccccc);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: text;
    }

    .mm-live-v4-editor-mount {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }

    .cm-editor {
      height: 100%;
      min-height: 0;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    .cm-scroller {
      overflow: auto !important;
      height: 100%;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
    }

    .cm-content {
      caret-color: var(--vscode-editorCursor-foreground);
    }

    .mm-live-v4-table-widget {
      display: block;
      max-width: 100%;
      margin: 0;
      padding: 0.35rem 0;
      overflow-x: auto;
      overflow-y: hidden;
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    .mm-live-v4-table {
      width: max-content;
      max-width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      color: var(--vscode-editor-foreground, #d4d4d4);
      background: var(--vscode-editor-background, #1e1e1e);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
    }

    .mm-live-v4-table th,
    .mm-live-v4-table td {
      min-width: 7rem;
      max-width: 24rem;
      padding: 0.25rem 0.45rem;
      border: 1px solid var(--vscode-editorWidget-border, #6a6a6a);
      vertical-align: top;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .mm-live-v4-table th {
      background: var(--vscode-editorWidget-background, #252526);
      font-weight: 600;
    }

    .mm-live-v4-table-cell[contenteditable="true"] {
      outline: none;
    }

    .mm-live-v4-table-cell[contenteditable="true"]:focus {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }

    .mm-live-v4-loading {
      padding: 1rem;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-font-family);
    }
  </style>
  <title>Markdown Live Editor</title>
</head>
<body>
  <div id="app"><div class="mm-live-v4-loading">Loading Markdown live editor...</div></div>
  <script nonce="${nonce}">window.__MLRT_INITIAL_DOCUMENT__ = ${initialDocumentScript};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
