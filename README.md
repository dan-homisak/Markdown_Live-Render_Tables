# Markdown Live Render Tables

A VS Code extension that live-renders GitHub-flavored markdown tables directly in
the source editor so you can read and edit them without fighting the pipe fences.

When a table is detected it is rendered in place, non-destructively (your file text
is never changed):

- Columns are aligned into a clean grid using visual-only padding.
- The `|` pipe fences are dimmed so they read as subtle grid lines.
- The `|---|---|` delimiter row is dimmed into a quiet header divider.
- Header cells are bolded.

Everything stays fully editable — you are still editing the real markdown.

## Usage

Rendering is on by default for markdown files. Use the command
`Markdown Live Render Tables: Toggle Table Rendering` to turn it on or off, or set
`markdownLiveRenderTables.enabled` in settings.

## Development

Install dependencies:

```sh
npm install
```

Compile TypeScript:

```sh
npm run compile
```

Run the extension:

1. Open this folder in VS Code.
2. Press `F5` or run the `Run Extension` launch configuration.
3. In the Extension Development Host, open any markdown file that contains a table
   (for example `standard-markdown-fixture.md`) to see it rendered in the editor.

## Project Layout

- `src/extension.ts` contains the extension activation entrypoint.
- `package.json` declares VS Code contribution points and build scripts.
- `.vscode/launch.json` starts an Extension Development Host for local testing.
