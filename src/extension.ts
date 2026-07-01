import * as vscode from "vscode";

const CONFIG_SECTION = "markdownLiveRenderTables";
const NBSP = "\u00A0";

let enabled = true;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

let pipeDecoration: vscode.TextEditorDecorationType;
let delimiterDecoration: vscode.TextEditorDecorationType;
let headerDecoration: vscode.TextEditorDecorationType;
let paddingDecoration: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext): void {
  enabled = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("enabled", true);
  createDecorationTypes();

  context.subscriptions.push(
    pipeDecoration,
    delimiterDecoration,
    headerDecoration,
    paddingDecoration,
    vscode.commands.registerCommand(`${CONFIG_SECTION}.toggle`, () =>
      toggleEnabled(),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateDecorations(editor);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() =>
      updateAllVisibleEditors(),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "markdown") {
        scheduleUpdate();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        enabled = vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<boolean>("enabled", true);
        updateAllVisibleEditors();
      }
    }),
  );

  updateAllVisibleEditors();
}

export function deactivate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

async function toggleEnabled(): Promise<void> {
  enabled = !enabled;
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update("enabled", enabled, vscode.ConfigurationTarget.Global);
  updateAllVisibleEditors();
  vscode.window.showInformationMessage(
    `Markdown table rendering ${enabled ? "enabled" : "disabled"}.`,
  );
}

function createDecorationTypes(): void {
  const faint = new vscode.ThemeColor("editorWhitespace.foreground");
  pipeDecoration = vscode.window.createTextEditorDecorationType({
    color: faint,
  });
  delimiterDecoration = vscode.window.createTextEditorDecorationType({
    color: faint,
    opacity: "0.5",
  });
  headerDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: "bold",
  });
  paddingDecoration = vscode.window.createTextEditorDecorationType({});
}

function scheduleUpdate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => updateAllVisibleEditors(), 150);
}

function updateAllVisibleEditors(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    updateDecorations(editor);
  }
}

function clearDecorations(editor: vscode.TextEditor): void {
  editor.setDecorations(pipeDecoration, []);
  editor.setDecorations(delimiterDecoration, []);
  editor.setDecorations(headerDecoration, []);
  editor.setDecorations(paddingDecoration, []);
}

function updateDecorations(editor: vscode.TextEditor): void {
  if (editor.document.languageId !== "markdown" || !enabled) {
    clearDecorations(editor);
    return;
  }

  const tables = parseTables(editor.document);

  const pipeRanges: vscode.Range[] = [];
  const delimiterRanges: vscode.Range[] = [];
  const headerRanges: vscode.Range[] = [];
  const paddingOptions: vscode.DecorationOptions[] = [];

  const alignRow = (row: TableRow, columnWidths: number[]): void => {
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      const padCount = columnWidths[c] - cell.width;
      if (padCount > 0) {
        paddingOptions.push({
          range: new vscode.Range(
            row.line,
            cell.closingPipe,
            row.line,
            cell.closingPipe,
          ),
          renderOptions: { after: { contentText: NBSP.repeat(padCount) } },
        });
      }
    }
  };

  for (const table of tables) {
    // Header row: align, dim its pipes, and bold the cell contents.
    alignRow(table.header, table.columnWidths);
    for (const pipe of table.header.pipes) {
      pipeRanges.push(
        new vscode.Range(table.header.line, pipe, table.header.line, pipe + 1),
      );
    }
    for (const cell of table.header.cells) {
      headerRanges.push(
        new vscode.Range(
          table.header.line,
          cell.start,
          table.header.line,
          cell.end,
        ),
      );
    }

    // Delimiter row: align, then dim the whole "|---|---|" span into a quiet divider.
    alignRow(table.delimiter, table.columnWidths);
    if (table.delimiter.pipes.length > 0) {
      const first = table.delimiter.pipes[0];
      const last = table.delimiter.pipes[table.delimiter.pipes.length - 1];
      delimiterRanges.push(
        new vscode.Range(
          table.delimiter.line,
          first,
          table.delimiter.line,
          last + 1,
        ),
      );
    }

    // Body rows: align and dim the pipes.
    for (const row of table.body) {
      alignRow(row, table.columnWidths);
      for (const pipe of row.pipes) {
        pipeRanges.push(new vscode.Range(row.line, pipe, row.line, pipe + 1));
      }
    }
  }

  editor.setDecorations(pipeDecoration, pipeRanges);
  editor.setDecorations(delimiterDecoration, delimiterRanges);
  editor.setDecorations(headerDecoration, headerRanges);
  editor.setDecorations(paddingDecoration, paddingOptions);
}

interface CellSegment {
  text: string;
  start: number; // UTF-16 offset where the cell content starts (after the opening pipe)
  end: number; // UTF-16 offset where the cell content ends (at the closing pipe)
  closingPipe: number; // UTF-16 offset of the closing pipe (== end)
  width: number; // display width of the cell content
}

interface TableRow {
  line: number;
  pipes: number[]; // UTF-16 offsets of every unescaped pipe on the line
  cells: CellSegment[]; // segments strictly between consecutive pipes
}

interface Table {
  header: TableRow;
  delimiter: TableRow;
  body: TableRow[];
  columnWidths: number[];
}

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseTables(document: vscode.TextDocument): Table[] {
  const tables: Table[] = [];
  const lineCount = document.lineCount;
  let inFence = false;
  let i = 0;

  while (i < lineCount) {
    const text = document.lineAt(i).text;

    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }

    const isHeaderCandidate =
      hasUnescapedPipe(text) &&
      !DELIMITER_RE.test(text) &&
      i + 1 < lineCount &&
      DELIMITER_RE.test(document.lineAt(i + 1).text) &&
      hasUnescapedPipe(document.lineAt(i + 1).text);

    if (!isHeaderCandidate) {
      i++;
      continue;
    }

    const header = parseRow(text, i);
    const delimiter = parseRow(document.lineAt(i + 1).text, i + 1);
    if (header.cells.length === 0 || delimiter.cells.length === 0) {
      i++;
      continue;
    }

    const body: TableRow[] = [];
    let j = i + 2;
    while (j < lineCount) {
      const bodyText = document.lineAt(j).text;
      if (
        FENCE_RE.test(bodyText) ||
        bodyText.trim() === "" ||
        !hasUnescapedPipe(bodyText)
      ) {
        break;
      }
      const row = parseRow(bodyText, j);
      if (row.cells.length === 0) {
        break;
      }
      body.push(row);
      j++;
    }

    const allRows = [header, delimiter, ...body];
    const maxCols = Math.max(...allRows.map((row) => row.cells.length));
    const columnWidths: number[] = [];
    for (let c = 0; c < maxCols; c++) {
      let width = 0;
      for (const row of allRows) {
        if (row.cells[c]) {
          width = Math.max(width, row.cells[c].width);
        }
      }
      columnWidths.push(width);
    }

    tables.push({ header, delimiter, body, columnWidths });
    i = j;
  }

  return tables;
}

function parseRow(text: string, line: number): TableRow {
  const pipes: number[] = [];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "|" && text[k - 1] !== "\\") {
      pipes.push(k);
    }
  }

  const cells: CellSegment[] = [];
  for (let p = 0; p + 1 < pipes.length; p++) {
    const start = pipes[p] + 1;
    const end = pipes[p + 1];
    const cellText = text.substring(start, end);
    cells.push({
      text: cellText,
      start,
      end,
      closingPipe: end,
      width: displayWidth(cellText),
    });
  }

  return { line, pipes, cells };
}

function hasUnescapedPipe(text: string): boolean {
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "|" && text[k - 1] !== "\\") {
      return true;
    }
  }
  return false;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, symbols
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs
    (code >= 0x1f300 && code <= 0x1faff) || // Emoji and pictographs
    (code >= 0x20000 && code <= 0x3fffd) // CJK Extension B+
  );
}
