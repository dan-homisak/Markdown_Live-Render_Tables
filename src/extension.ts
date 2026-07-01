import * as vscode from "vscode";

const LIVE_EDITOR_VIEW_TYPE = "markdownLiveRenderTables.liveEditor";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkdownLiveEditorProvider(context);

  context.subscriptions.push(
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
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.openLiveEditor",
      async (uri?: vscode.Uri) => {
        await openLiveEditor(uri, provider);
      },
    ),
    vscode.commands.registerCommand(
      "markdownLiveRenderTables.openSourceEditor",
      async (uri?: vscode.Uri) => {
        await openSourceEditor(uri, provider);
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "liveEditor.js"),
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
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let documentRevision = 0;

    const postDocument = (): void => {
      documentRevision++;
      void webview.postMessage({
        type: "setDocument",
        text: document.getText(),
        revision: documentRevision,
      } satisfies HostSetDocumentMessage);
    };

    const scheduleApplyFromWebview = (text: string): void => {
      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        void applyFullDocumentEdit(document, text, () => {
          applyingFromWebview = true;
        }).finally(() => {
          applyingFromWebview = false;
        });
      }, 150);
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

        if (
          isChangeMessage(message) &&
          message.text !== document.getText() &&
          message.baseRevision <= documentRevision
        ) {
          scheduleApplyFromWebview(message.text);
        }
      }),
    );

    webview.html = getEditorHtml(webview, scriptUri, document.getText());
    setTimeout(postDocument, 0);
    setTimeout(postDocument, 250);

    webviewPanel.onDidDispose(() => {
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      this.panelsByDocument.delete(documentKey);
      if (this.activeLiveDocumentUri?.toString() === documentKey) {
        this.activeLiveDocumentUri = undefined;
      }
      vscode.Disposable.from(...disposables).dispose();
    });
  }
}

async function openLiveEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
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
}

async function openSourceEditor(
  uri: vscode.Uri | undefined,
  provider: MarkdownLiveEditorProvider,
): Promise<void> {
  const targetUri = uri ?? provider.getActiveDocumentUri();
  if (!targetUri) {
    vscode.window.showWarningMessage("Open a live markdown editor before returning to source.");
    return;
  }

  const viewColumn = provider.getViewColumn(targetUri) ?? vscode.ViewColumn.Active;
  try {
    await vscode.commands.executeCommand("vscode.openWith", targetUri, "default", {
      viewColumn,
      preserveFocus: false,
    });
  } catch {
    await vscode.window.showTextDocument(targetUri, {
      viewColumn,
      preview: false,
      preserveFocus: false,
    });
  }
}

async function applyFullDocumentEdit(
  document: vscode.TextDocument,
  text: string,
  beforeApply: () => void,
): Promise<void> {
  if (text === document.getText()) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const range = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  edit.replace(document.uri, range, text);

  beforeApply();
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showWarningMessage("Markdown live editor could not apply changes.");
  }
}

interface ReadyMessage {
  type: "ready";
}

interface ChangeMessage {
  type: "change";
  text: string;
  baseRevision: number;
}

interface HostSetDocumentMessage {
  type: "setDocument";
  text: string;
  revision: number;
}

function isReadyMessage(message: unknown): message is ReadyMessage {
  return isMessageRecord(message) && message.type === "ready";
}

function isChangeMessage(message: unknown): message is ChangeMessage {
  return (
    isMessageRecord(message) &&
    message.type === "change" &&
    typeof message.text === "string" &&
    typeof message.baseRevision === "number"
  );
}

function isMessageRecord(message: unknown): message is Record<string, unknown> {
  return Boolean(message) && typeof message === "object";
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
      min-height: 0;
    }

    .mm-live-v4-status {
      flex: 0 0 auto;
      padding: 0.25rem 0.75rem;
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      color: var(--vscode-descriptionForeground, #cccccc);
      background: var(--vscode-editorWidget-background, #252526);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      line-height: 1.4;
      user-select: text;
    }

    .mm-live-v4-editor-mount {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }

    .cm-editor {
      height: 100%;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
    }

    .cm-scroller {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
    }

    .cm-content {
      caret-color: var(--vscode-editorCursor-foreground);
    }

    .mm-live-v4-table-widget {
      display: block;
      max-width: 100%;
      margin: 0.2rem 0;
      overflow-x: auto;
      overflow-y: hidden;
      color: var(--vscode-editor-foreground);
    }

    .mm-live-v4-table {
      width: max-content;
      max-width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .mm-live-v4-table th,
    .mm-live-v4-table td {
      min-width: 7rem;
      max-width: 24rem;
      padding: 0.25rem 0.45rem;
      border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
      vertical-align: top;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .mm-live-v4-table th {
      background: var(--vscode-editorWidget-background);
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
