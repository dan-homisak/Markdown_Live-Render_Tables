# Markdown Live Editor

A VS Code extension that ports the Meeting_Minutes live editor into a custom
markdown editor. V1 is intentionally table-first: markdown tables render as live
editable grids, while the rest of the document remains editable markdown source.

## Usage

Open a markdown file and use the eye button in the editor title bar to toggle
the live editor for that document. You can also toggle with `Cmd+Ctrl+M` on
macOS or `Ctrl+Alt+M` on Windows/Linux. To change that shortcut later, open VS
Code Keyboard Shortcuts and search for `Markdown Live Editor: Toggle Markdown
Live Editor`.

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

Run the Extension Development Host pixel-parity check for VS Code editor layout
work:

```sh
npm run compile
node scripts/edh-visual-check.mjs
```

This check captures `qa/edh-stock.png` and `qa/edh-live.png` in the same
isolated VS Code workbench, then compares Monaco and live-editor metrics for
gutter width, content x-position, first glyph x-position, line-number glyph
position, font size, line height, table content x-position, and active gutter
highlighting. Use this for pixel-perfect rendered-vs-source parity work; the
standalone harness is not enough for that class of regression.

Package the extension:

```sh
npm run package
```

Install the latest local VSIX into VS Code:

```sh
./Build_and_Install
```

### Simple Install Flow

There are only two install paths to think about:

- On this Mac, run `./Build_and_Install`.
- For a Windows computer, copy the generated `install-bundles/Copy_to_Windows`
  folder to Windows and double-click `Install_Markdown_Live_Editor.cmd`.

You do not need to manage the `.cmd` and `.vsix` separately. Keep them together
inside `Copy_to_Windows`; that folder is disposable generated output and can be
rebuilt any time from this Mac.

`./Build_and_Install` does all of this for the Mac development loop:

```sh
./Build_and_Install
```

It builds the extension, bumps the patch version so VS Code treats it as a real
update, packages `markdown-live-render-tables-latest.vsix`, refreshes the
Windows copy folder, installs the VSIX into local VS Code, verifies the installed
payload, removes stale extension folders, and tries to reload the matching VS
Code project window.

The VS Code install itself uses the official VS Code CLI:
`code --install-extension <file.vsix> --force`. VS Code does not provide a
reliable CLI command to reload an already-open window after a local VSIX install,
so the Mac script still uses AppleScript only for that final window reload. If
the automatic reload is blocked, run `Developer: Reload Window` in VS Code.

To refresh just the Windows copy folder without installing on this Mac:

```sh
npm run package:windows
```

That folder intentionally contains only:

- `Install_Markdown_Live_Editor.cmd`
- `markdown-live-render-tables-latest.vsix`

If a managed work computer blocks scripts, install the same VSIX manually in VS
Code:

```text
Extensions view > ... menu > Install from VSIX...
```

Choose `markdown-live-render-tables-latest.vsix` from `Copy_to_Windows`. This
installs into the current Windows user profile and does not require publishing
the extension to the VS Code Marketplace.

## Project Layout

- `src/extension.ts` registers the VS Code custom editor and toolbar commands.
- `src/webview/liveEditor.ts` boots the webview CodeMirror editor.
- `src/live-v4` contains the Meeting_Minutes-style live runtime, parser, model,
  projection, and table renderer.
- `src/shared/tableModel.ts` contains the markdown table parsing and formatting
  logic used by the V1 renderer.
