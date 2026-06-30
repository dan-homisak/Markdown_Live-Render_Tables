import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('markdownLiveRenderTables.helloWorld', () => {
    vscode.window.showInformationMessage('Markdown Live Render Tables is active.');
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {}
