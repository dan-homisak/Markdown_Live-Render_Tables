# Markdown Live Editor

Markdown Live Editor is a Visual Studio Code extension that makes Markdown tables easier to work with. It presents tables as editable grids while keeping the rest of the document in familiar Markdown source form, combining structured table editing with the precision and portability of plain text.

Edits are written directly back to the underlying Markdown, so documents remain standard `.md` files that work with existing tools, version control, and publishing workflows.

## Highlights

- Edit Markdown tables through a live, spreadsheet-like interface
- Navigate cells by keyboard and create multiline cell content
- Select individual cells, rows, columns, or rectangular ranges
- Copy and paste across Markdown editors, spreadsheets, and rich-text applications
- Preserve table alignment, escaped pipes, and Markdown formatting
- Expand tables safely when pasted data exceeds their current dimensions
- Switch between the live editor and VS Code's standard Markdown editor at any time

## Getting started

Open a `.md` or `.markdown` file in VS Code, then select the eye icon in the editor title bar to toggle Markdown Live Editor.

You can also use the default keyboard shortcut:

- macOS: `Cmd+Ctrl+M`
- Windows and Linux: `Ctrl+Alt+M`

To customize the shortcut, open **Keyboard Shortcuts** and search for **Markdown Live Editor: Toggle Markdown Live Editor**.

## Working with tables

Click a table cell to edit it. Press `Tab` or `Shift+Tab` to move between cells, and use `Shift+Enter` to add a line break within a cell.

Ordinary arrow keys navigate characters and visual lines normally, crossing into another cell only after the caret reaches a cell edge. For immediate geometric navigation to an adjacent cell, hold the configured function key (`F2` by default) while pressing an arrow key; the caret lands at the end of the destination cell so you can continue typing there.

Press `Escape` while editing to select the current cell. From there, use the arrow keys to move the selection or hold `Shift` to extend it. Range selections can also be created by dragging or by shift-clicking another cell.

The editor provides several clipboard formats for moving content between Markdown, spreadsheets, and rich-text tools. Smart copy is the default and keeps list content inside spreadsheet cells using portable inline markers and same-cell line breaks. **Copy Rich** preserves semantic nested lists for Word and other rich-text tools. Dedicated **Copy Plain Text** and **Copy Markdown** actions are also available from the context menu.

## Configuration

The following settings are available in VS Code:

- `markdownLiveRenderTables.tableNavigation.modifierKey` - chooses the function key used with arrow keys for direct cell navigation
- `markdownLiveRenderTables.clipboard.defaultCopyMode` - sets the default copy representation
- `markdownLiveRenderTables.clipboard.defaultPasteMode` - sets the default paste interpretation
- `markdownLiveRenderTables.debug` - enables diagnostic logging for development and troubleshooting

## Development

Requirements:

- Node.js and npm
- Visual Studio Code 1.101 or later

Install dependencies and build the extension:

```sh
npm install
npm run compile
```

Run the automated test suite:

```sh
npm test
```

Create a local VSIX package:

```sh
npm run package
```

## License

This project is available under the MIT License.
