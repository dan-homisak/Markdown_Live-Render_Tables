import * as vscode from "vscode";

const LIVE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.liveEditor";
const LEGACY_TABLE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.tableEditor";
const DEBUG_SETTING = "debug";
const REOPEN_ACTIVE_EDITOR_WITH_COMMAND = "reopenActiveEditorWith";
const DEFAULT_EDITOR_ID = "default";

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

    webview.html = getEditorHtml(webview, scriptUri, document.getText(), document.uri);
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

  if (tabToClose && tabMatchesUri(tabToClose, targetUri)) {
    await reopenActiveEditorWith(LIVE_EDITOR_VIEW_TYPE);
    return;
  }

  await vscode.commands.executeCommand("vscode.openWith", targetUri, LIVE_EDITOR_VIEW_TYPE, {
    viewColumn,
    preserveFocus: false,
  });
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

  if (tabToClose && tabMatchesUri(tabToClose, targetUri)) {
    await reopenActiveEditorWith(DEFAULT_EDITOR_ID);
    return;
  }

  await vscode.window.showTextDocument(targetUri, {
    viewColumn: provider.getViewColumn(targetUri) ?? vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false,
  });
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

async function reopenActiveEditorWith(editorId: string): Promise<void> {
  await vscode.commands.executeCommand(REOPEN_ACTIVE_EDITOR_WITH_COMMAND, editorId);
}

function getEditorHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  initialText: string,
  documentUri: vscode.Uri,
): string {
  const nonce = getNonce();
  const initialDocumentScript = JSON.stringify(initialText).replace(
    /<\/script/gi,
    "<\\/script",
  );
  const editorMetricsCss = getEditorMetricsCss(documentUri);
  const editorOptionsScript = JSON.stringify(getEditorOptions(documentUri));
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
    :root {
${editorMetricsCss}
    }

    html,
    body,
    #app {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--mlrt-editor-font-family, var(--vscode-editor-font-family));
      font-size: var(--mlrt-editor-font-size, var(--vscode-editor-font-size));
    }

    .mm-live-v4-shell {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
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
      font-family: var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace));
      font-size: var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px));
      font-weight: var(--mlrt-editor-font-weight, normal);
      line-height: var(--mlrt-editor-line-height, normal);
      letter-spacing: var(--mlrt-editor-letter-spacing, normal);
      font-feature-settings: var(--mlrt-editor-font-feature-settings, normal);
      font-variation-settings: var(--mlrt-editor-font-variation-settings, normal);
    }

    .cm-content {
      caret-color: var(--vscode-editorCursor-foreground);
    }

    .mm-live-v4-table-widget {
      display: block;
      max-width: 100%;
      margin: 0;
      padding: 0;
      overflow-x: auto;
      overflow-y: hidden;
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    .mm-live-v4-table {
      width: calc(100vw - 8rem);
      max-width: none;
      box-sizing: border-box;
      border-collapse: collapse;
      table-layout: auto;
      color: var(--vscode-editor-foreground, #d4d4d4);
      background: var(--vscode-editor-background, #1e1e1e);
      font-family: var(--mlrt-editor-font-family, var(--vscode-editor-font-family, monospace));
      font-size: var(--mlrt-editor-font-size, var(--vscode-editor-font-size, 13px));
      font-weight: var(--mlrt-editor-font-weight, normal);
      line-height: var(--mlrt-editor-line-height, normal);
      letter-spacing: var(--mlrt-editor-letter-spacing, normal);
      font-feature-settings: var(--mlrt-editor-font-feature-settings, normal);
      font-variation-settings: var(--mlrt-editor-font-variation-settings, normal);
    }

    .mm-live-v4-table th,
    .mm-live-v4-table td {
      min-width: 5ch;
      max-width: none;
      padding: 0 1ch;
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
  <script nonce="${nonce}">
    window.__MLRT_INITIAL_DOCUMENT__ = ${initialDocumentScript};
    window.__MLRT_EDITOR_OPTIONS__ = ${editorOptionsScript};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getEditorMetricsCss(documentUri: vscode.Uri): string {
  const editorConfig = vscode.workspace.getConfiguration("editor", documentUri);
  const fontSize = clampNumber(editorConfig.get<number>("fontSize", 14), 6, 100);
  const configuredLineHeight = clampNumber(
    editorConfig.get<number>("lineHeight", 0),
    0,
    300,
  );
  const lineHeight =
    configuredLineHeight > 0 ? configuredLineHeight : Math.round(fontSize * 1.5);
  const cursorWidth = clampNumber(
    editorConfig.get<number>("cursorWidth", 1),
    1,
    10,
  );
  const letterSpacing = clampNumber(
    editorConfig.get<number>("letterSpacing", 0),
    -10,
    20,
  );
  const padding = editorConfig.get<{ top?: number; bottom?: number }>(
    "padding",
    {},
  );
  const paddingTop = clampNumber(padding.top ?? 0, 0, 200);
  const paddingBottom = clampNumber(padding.bottom ?? 0, 0, 200);
  const fontFamily = sanitizeCssValue(
    editorConfig.get<string>("fontFamily", "monospace"),
    "monospace",
  );
  const fontWeight = sanitizeCssValue(
    editorConfig.get<string>("fontWeight", "normal"),
    "normal",
  );
  const fontFeatureSettings = getFontFeatureSettings(editorConfig);
  const fontVariationSettings = getFontVariationSettings(editorConfig);

  return [
    `      --mlrt-editor-font-family: ${fontFamily};`,
    `      --mlrt-editor-font-size: ${fontSize}px;`,
    `      --mlrt-editor-font-weight: ${fontWeight};`,
    `      --mlrt-editor-line-height: ${lineHeight}px;`,
    `      --mlrt-editor-letter-spacing: ${letterSpacing}px;`,
    `      --mlrt-editor-font-feature-settings: ${fontFeatureSettings};`,
    `      --mlrt-editor-font-variation-settings: ${fontVariationSettings};`,
    `      --mlrt-editor-cursor-width: ${cursorWidth}px;`,
    `      --mlrt-editor-top-padding: ${paddingTop}px;`,
    `      --mlrt-editor-bottom-padding: ${paddingBottom}px;`,
  ].join("\n");
}

function getEditorOptions(documentUri: vscode.Uri): { lineWrapping: boolean } {
  const editorConfig = vscode.workspace.getConfiguration("editor", documentUri);
  const wordWrap = editorConfig.get<string>("wordWrap", "off");
  return {
    lineWrapping: wordWrap !== "off",
  };
}

function getFontFeatureSettings(
  editorConfig: vscode.WorkspaceConfiguration,
): string {
  const fontLigatures = editorConfig.get<boolean | string>(
    "fontLigatures",
    false,
  );
  if (typeof fontLigatures === "string") {
    return sanitizeCssValue(fontLigatures, "normal");
  }

  return fontLigatures ? "\"liga\" on, \"calt\" on" : "normal";
}

function getFontVariationSettings(
  editorConfig: vscode.WorkspaceConfiguration,
): string {
  const fontVariations = editorConfig.get<boolean | string>(
    "fontVariations",
    false,
  );
  if (typeof fontVariations === "string") {
    return sanitizeCssValue(fontVariations, "normal");
  }

  return fontVariations ? "normal" : "normal";
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeCssValue(value: string, fallback: string): string {
  const cleaned = value.replace(/[;{}<>]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
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
