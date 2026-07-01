# Markdown Live Editor

A VS Code extension that ports the Meeting_Minutes live editor into a custom
markdown editor. V1 is intentionally table-first: markdown tables render as live
editable grids, while the rest of the document remains editable markdown source.

## Usage

Open a markdown file and use the preview button in the editor title bar to open
the live editor for that document. In the live editor, use the code button in the
editor title bar to return to the normal VS Code markdown source editor.

In V1, tables support:

- live rendered grid editing
- cell edits that write back to markdown source
- Tab and Shift-Tab cell navigation
- Shift-Enter multiline cells
- escaped pipes
- alignment preservation

Broader markdown live rendering is planned for V2.

## Development

Install dependencies:

```sh
npm install
```

Compile TypeScript and bundle the webview:

```sh
npm run compile
```

Run tests:

```sh
npm test
```

Generate a standalone browser harness for the live editor bundle:

```sh
npm run qa:harness
```

Capture that harness with headless Chrome when visual layout needs checking:

```sh
npm run qa:screenshot
```

Package the extension:

```sh
npm run package
```

Install the latest local VSIX into VS Code:

```sh
./Build_and_Install
```

## Project Layout

- `src/extension.ts` registers the VS Code custom editor and toolbar commands.
- `src/webview/liveEditor.ts` boots the webview CodeMirror editor.
- `src/live-v4` contains the Meeting_Minutes-style live runtime, parser, model,
  projection, and table renderer.
- `src/shared/tableModel.ts` contains the markdown table parsing and formatting
  logic used by the V1 renderer.
