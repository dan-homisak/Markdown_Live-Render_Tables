import {
  CellAlignment,
  ensureTableCellSeparatorSafe,
  formatMarkdownCell,
  getCellPaddingWhitespace,
  markdownCellToDisplayText,
  ParsedRow,
  ParsedTable,
  TableCellSourceEdit,
} from "./tableModel";

export const MLRT_CLIPBOARD_MIME =
  "application/x-markdown-live-editor+json";
export const MLRT_CLIPBOARD_VERSION = 1 as const;

export type ClipboardCopyMode = "smart" | "rich" | "plain" | "markdown";
export type ClipboardPasteMode = "auto" | "rich" | "plain" | "markdown";

export interface ClipboardCell {
  /** The exact visible value, with LF line endings. */
  text: string;
  /** Exact raw markdown cell source, including its original padding. */
  markdown?: string;
}

export interface ClipboardGridPayload {
  version: typeof MLRT_CLIPBOARD_VERSION;
  kind: "grid";
  sourceDocument: string;
  rows: ClipboardCell[][];
  alignments: CellAlignment[];
  includesHeader: boolean;
  exactMarkdown?: string;
  cutToken?: string;
}

export interface ClipboardDocumentPayload {
  version: typeof MLRT_CLIPBOARD_VERSION;
  kind: "document";
  sourceDocument: string;
  markdown: string;
  cutToken?: string;
}

export type MlrtClipboardPayload =
  | ClipboardGridPayload
  | ClipboardDocumentPayload;

export interface CellRectangle {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface GridPastePlan {
  rows: ClipboardCell[][];
  sourceAlignments?: CellAlignment[];
  destination: CellRectangle;
}

const VALID_ALIGNMENTS = new Set<CellAlignment>([
  "left",
  "center",
  "right",
]);

export function normalizeCellText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function validateClipboardPayload(
  value: unknown,
): MlrtClipboardPayload | null {
  if (!isRecord(value) || value.version !== MLRT_CLIPBOARD_VERSION) {
    return null;
  }
  if (typeof value.sourceDocument !== "string") {
    return null;
  }
  const cutToken =
    value.cutToken === undefined || typeof value.cutToken === "string"
      ? value.cutToken
      : null;
  if (cutToken === null) {
    return null;
  }

  if (value.kind === "document") {
    if (typeof value.markdown !== "string") {
      return null;
    }
    return {
      version: MLRT_CLIPBOARD_VERSION,
      kind: "document",
      sourceDocument: value.sourceDocument,
      markdown: normalizeCellText(value.markdown),
      ...(cutToken ? { cutToken } : {}),
    };
  }

  if (
    value.kind !== "grid" ||
    !Array.isArray(value.rows) ||
    value.rows.length === 0 ||
    !Array.isArray(value.alignments) ||
    typeof value.includesHeader !== "boolean" ||
    (value.exactMarkdown !== undefined &&
      typeof value.exactMarkdown !== "string")
  ) {
    return null;
  }

  const width = Array.isArray(value.rows[0]) ? value.rows[0].length : 0;
  if (width === 0) {
    return null;
  }
  const rows: ClipboardCell[][] = [];
  for (const candidateRow of value.rows) {
    if (!Array.isArray(candidateRow) || candidateRow.length !== width) {
      return null;
    }
    const row: ClipboardCell[] = [];
    for (const candidateCell of candidateRow) {
      if (
        !isRecord(candidateCell) ||
        typeof candidateCell.text !== "string" ||
        (candidateCell.markdown !== undefined &&
          typeof candidateCell.markdown !== "string")
      ) {
        return null;
      }
      const text = normalizeCellText(candidateCell.text);
      const markdown = candidateCell.markdown;
      row.push({
        text,
        ...(typeof markdown === "string" &&
        isSafeRawCellSource(markdown, text)
          ? { markdown }
          : {}),
      });
    }
    rows.push(row);
  }

  const alignments: CellAlignment[] = [];
  for (let column = 0; column < width; column++) {
    const alignment = value.alignments[column];
    alignments.push(
      typeof alignment === "string" &&
        VALID_ALIGNMENTS.has(alignment as CellAlignment)
        ? (alignment as CellAlignment)
        : "left",
    );
  }

  return {
    version: MLRT_CLIPBOARD_VERSION,
    kind: "grid",
    sourceDocument: value.sourceDocument,
    rows,
    alignments,
    includesHeader: value.includesHeader,
    ...(typeof value.exactMarkdown === "string"
      ? { exactMarkdown: normalizeCellText(value.exactMarkdown) }
      : {}),
    ...(cutToken ? { cutToken } : {}),
  };
}

export function parseClipboardPayload(text: string): MlrtClipboardPayload | null {
  try {
    return validateClipboardPayload(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function serializeDelimitedGrid(
  rows: readonly (readonly string[])[],
  delimiter: "\t" | ",",
): string {
  return rows
    .map((row) => row.map((value) => quoteDelimited(value, delimiter)).join(delimiter))
    .join("\r\n");
}

export function parseDelimitedGrid(
  input: string,
  delimiter: "\t" | ",",
): string[][] | null {
  const text = normalizeCellText(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }
  if (quoted) {
    return null;
  }
  row.push(field);
  rows.push(row);
  if (
    rows.length > 1 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === "" &&
    text.endsWith("\n")
  ) {
    rows.pop();
  }
  const width = Math.max(...rows.map((candidate) => candidate.length));
  return rows.map((candidate) => [
    ...candidate,
    ...Array.from({ length: width - candidate.length }, () => ""),
  ]);
}

export function gridToMarkdown(
  rows: readonly (readonly ClipboardCell[])[],
  alignments: readonly CellAlignment[] = [],
): string {
  if (rows.length === 0 || rows[0].length === 0) {
    return "";
  }
  const width = rows[0].length;
  const sourceRows = rows.map((row) =>
    `|${Array.from({ length: width }, (_, column) =>
      ensureTableCellSeparatorSafe(sourceCellForMarkdown(row[column])),
    ).join("|")}|`,
  );
  const delimiter = `|${Array.from({ length: width }, (_, column) =>
    alignmentDelimiter(alignments[column] ?? "left"),
  ).join("|")}|`;
  return [sourceRows[0], delimiter, ...sourceRows.slice(1)].join("\n");
}

/**
 * Public plain-text fallback for a copied grid.
 *
 * Smart/Rich clipboard consumers such as Word and Excel use the HTML table,
 * while source editors generally consume only `text/plain`. Publishing
 * Markdown here therefore keeps the table intact in stock Markdown editors;
 * explicit Plain Text remains the tab-delimited worksheet representation.
 */
export function gridPlainTextForCopy(
  payload: ClipboardGridPayload,
  mode: ClipboardCopyMode,
): string {
  if (mode === "plain") {
    return serializeDelimitedGrid(
      payload.rows.map((row) => row.map((cell) => cell.text)),
      "\t",
    );
  }
  return payload.exactMarkdown ??
    gridToMarkdown(payload.rows, payload.alignments);
}

/**
 * Places Markdown produced from an external HTML cell safely inside a pipe
 * table without changing its literal backslashes. Entity-encoding pipes is
 * the repository's canonical representation and, unlike `\|`, does not leave
 * visible escape slashes in the live cell editor.
 */
export function importedMarkdownToTableCellSource(value: string): string {
  return normalizeCellText(value)
    .replace(/\|/g, "&#124;")
    .replace(/\n/g, "<br>");
}

export function gridToHtml(
  rows: readonly (readonly ClipboardCell[])[],
  options: {
    alignments?: readonly CellAlignment[];
    embeddedPayload?: string;
    htmlCells?: readonly (readonly (string | undefined)[])[];
    headerRow?: boolean;
  } = {},
): string {
  const alignments = options.alignments ?? [];
  const metadata = options.embeddedPayload
    ? `<meta name="mlrt-clipboard" content="${escapeHtmlAttribute(options.embeddedPayload)}">`
    : "";
  const body = rows
    .map((row, rowIndex) => {
      const tagName = rowIndex === 0 && options.headerRow !== false ? "th" : "td";
      return `<tr>${row
        .map((cell, column) => {
          const alignment = alignments[column] ?? "left";
          const style = `text-align:${alignment};border:1px solid #000000;padding:2px 6px;vertical-align:top;white-space:pre-wrap`;
          const content =
            options.htmlCells?.[rowIndex]?.[column] !== undefined
              ? options.htmlCells[rowIndex][column]
              : cellTextToHtml(cell.text);
          return `<${tagName} style="${style}">${content}</${tagName}>`;
        })
        .join("")}</tr>`;
    })
    .join("");
  return `${metadata}<table style="border-collapse:collapse">${body}</table>`;
}

export function tableRectanglePayload(
  table: ParsedTable,
  rectangle: CellRectangle,
  sourceDocument: string,
  cutToken?: string,
): ClipboardGridPayload {
  const rows = tableDataRows(table);
  const selected = rows
    .slice(rectangle.top, rectangle.bottom + 1)
    .map((row) => row.slice(rectangle.left, rectangle.right + 1));
  const fullTable =
    rectangle.top === 0 &&
    rectangle.bottom === rows.length - 1 &&
    rectangle.left === 0 &&
    rectangle.right === table.columnCount - 1;
  return {
    version: MLRT_CLIPBOARD_VERSION,
    kind: "grid",
    sourceDocument,
    rows: selected,
    alignments: table.alignments.slice(rectangle.left, rectangle.right + 1),
    includesHeader: rectangle.top === 0,
    ...(fullTable
      ? { exactMarkdown: tableSourceText(table) }
      : {}),
    ...(cutToken ? { cutToken } : {}),
  };
}

export function resolveGridPasteRows(
  source: readonly (readonly ClipboardCell[])[],
  destination: CellRectangle,
): ClipboardCell[][] | null {
  if (source.length === 0 || source[0]?.length === 0) {
    return null;
  }
  const sourceHeight = source.length;
  const sourceWidth = source[0].length;
  if (source.some((row) => row.length !== sourceWidth)) {
    return null;
  }
  const destinationHeight = destination.bottom - destination.top + 1;
  const destinationWidth = destination.right - destination.left + 1;
  const isSingleAnchor = destinationHeight === 1 && destinationWidth === 1;
  if (isSingleAnchor) {
    return source.map((row) => row.map(cloneCell));
  }
  if (
    destinationHeight % sourceHeight !== 0 ||
    destinationWidth % sourceWidth !== 0
  ) {
    return null;
  }
  return Array.from({ length: destinationHeight }, (_, row) =>
    Array.from({ length: destinationWidth }, (_, column) =>
      cloneCell(source[row % sourceHeight][column % sourceWidth]),
    ),
  );
}

export function buildGridPasteEdit(
  table: ParsedTable,
  plan: GridPastePlan,
): TableCellSourceEdit {
  const sourceHeight = plan.rows.length;
  const sourceWidth = plan.rows[0]?.length ?? 0;
  const requiredRows = Math.max(
    table.body.length + 1,
    plan.destination.top + sourceHeight,
  );
  const requiredColumns = Math.max(
    table.columnCount,
    plan.destination.left + sourceWidth,
  );
  const dataRows = [table.header, ...table.body];
  const rawRows = Array.from({ length: requiredRows }, (_, rowIndex) =>
    Array.from({ length: requiredColumns }, (_, column) =>
      existingRawCell(dataRows[rowIndex], column),
    ),
  );

  for (let row = 0; row < sourceHeight; row++) {
    for (let column = 0; column < sourceWidth; column++) {
      const targetRow = plan.destination.top + row;
      const targetColumn = plan.destination.left + column;
      const sourceCell = plan.rows[row][column];
      const existingRaw = rawRows[targetRow][targetColumn];
      rawRows[targetRow][targetColumn] = sourceCell.markdown ??
        formatDisplayCellForDestination(sourceCell.text, existingRaw);
    }
  }

  const delimiterRaw = Array.from({ length: requiredColumns }, (_, column) => {
    if (column < table.columnCount) {
      return table.delimiter.cells[column]?.raw ?? " --- ";
    }
    const sourceColumn = column - plan.destination.left;
    const alignment = plan.sourceAlignments?.[sourceColumn] ?? "left";
    return alignmentDelimiter(alignment);
  });
  const lines = [rawRows[0], delimiterRaw, ...rawRows.slice(1)].map(
    (rawCells) =>
      `|${rawCells.map(ensureTableCellSeparatorSafe).join("|")}|`,
  );
  return {
    from: table.from,
    to: table.to,
    insert: lines.join(tableLineSeparator(table)),
  };
}

export function buildGridClearEdit(
  table: ParsedTable,
  rectangle: CellRectangle,
): TableCellSourceEdit {
  const rows = Array.from(
    { length: rectangle.bottom - rectangle.top + 1 },
    () =>
      Array.from(
        { length: rectangle.right - rectangle.left + 1 },
        (): ClipboardCell => ({ text: "" }),
      ),
  );
  return buildGridPasteEdit(table, { rows, destination: rectangle });
}

function tableDataRows(table: ParsedTable): ClipboardCell[][] {
  return [table.header, ...table.body].map((row) =>
    Array.from({ length: table.columnCount }, (_, column) => ({
      text: markdownCellToDisplayText(row.cells[column]?.raw ?? ""),
      markdown: row.cells[column]?.raw ?? "  ",
    })),
  );
}

function tableSourceText(table: ParsedTable): string {
  return [table.header, table.delimiter, ...table.body]
    .map((row) => row.text)
    .join(tableLineSeparator(table));
}

function existingRawCell(row: ParsedRow | undefined, column: number): string {
  return row?.cells[column]?.raw ?? "  ";
}

function formatDisplayCellForDestination(text: string, raw: string): string {
  const { leadingWhitespace, trailingWhitespace } =
    getCellPaddingWhitespace(raw);
  const leading = leadingWhitespace || " ";
  const trailing = trailingWhitespace || " ";
  return `${leading}${formatMarkdownCell(normalizeCellText(text), {
    trim: false,
  })}${trailing}`;
}

function sourceCellForMarkdown(cell: ClipboardCell | undefined): string {
  if (cell?.markdown && isSafeRawCellSource(cell.markdown, cell.text)) {
    return cell.markdown;
  }
  return ` ${formatMarkdownCell(cell?.text ?? "", { trim: false })} `;
}

function isSafeRawCellSource(raw: string, text: string): boolean {
  return (
    !/[\r\n]/.test(raw) &&
    !raw.includes("|") &&
    markdownCellToDisplayText(raw) === text
  );
}

function alignmentDelimiter(alignment: CellAlignment): string {
  if (alignment === "center") {
    return " :---: ";
  }
  if (alignment === "right") {
    return " ---: ";
  }
  return " --- ";
}

function tableLineSeparator(table: ParsedTable): string {
  return table.delimiter.from - table.header.to === 2 ? "\r\n" : "\n";
}

function quoteDelimited(value: string, delimiter: string): string {
  const normalized = normalizeCellText(value);
  if (
    normalized.includes(delimiter) ||
    normalized.includes('"') ||
    normalized.includes("\n")
  ) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function cellTextToHtml(value: string): string {
  return escapeHtml(normalizeCellText(value)).replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "&#10;");
}

function cloneCell(cell: ClipboardCell): ClipboardCell {
  return { text: cell.text, ...(cell.markdown ? { markdown: cell.markdown } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
