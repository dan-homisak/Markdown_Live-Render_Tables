export type CellAlignment = "left" | "center" | "right";

export interface ParsedCell {
  raw: string;
  start: number;
  end: number;
}

export interface ParsedRow {
  lineIndex: number;
  from: number;
  to: number;
  text: string;
  cells: ParsedCell[];
}

export interface ParsedTable {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  header: ParsedRow;
  delimiter: ParsedRow;
  body: ParsedRow[];
  columnCount: number;
  alignments: CellAlignment[];
}

/**
 * Minimal read-only document contract satisfied by both plain strings
 * (via a wrapper) and CodeMirror `Text` instances.
 */
export interface ReadonlyDocText {
  readonly length: number;
  sliceString(from: number, to: number): string;
  toString(): string;
}

export interface TableCellSourceEdit {
  from: number;
  to: number;
  insert: string;
}

interface SourceLine {
  index: number;
  from: number;
  to: number;
  text: string;
}

const DELIMITER_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

interface FenceState {
  marker: "`" | "~";
  length: number;
}

const parsedTablesByDoc = new WeakMap<object, ParsedTable[]>();

/**
 * Parses markdown tables from an immutable document object, memoized on the
 * document instance. CodeMirror `Text` values are immutable and shared across
 * states, so every extension that needs the table list for the same document
 * version reuses a single parse instead of re-scanning the full source.
 *
 * Callers must treat the returned tables as read-only; clone before mutating.
 */
export function getParsedTables(doc: ReadonlyDocText): ParsedTable[] {
  const cached = parsedTablesByDoc.get(doc);
  if (cached) {
    return cached;
  }

  const tables = parseMarkdownTables(doc.toString());
  parsedTablesByDoc.set(doc, tables);
  return tables;
}

/**
 * Position immediately after the table block, including the trailing newline
 * when one exists (the start of the next document line).
 */
export function positionAfterTable(
  doc: ReadonlyDocText,
  table: ParsedTable,
): number {
  return table.to < doc.length &&
    doc.sliceString(table.to, table.to + 1) === "\n"
    ? table.to + 1
    : table.to;
}

/** Position immediately before the table block (end of the previous line). */
export function positionBeforeTable(table: ParsedTable): number {
  return Math.max(0, table.from - 1);
}

export function parseMarkdownTables(source: string): ParsedTable[] {
  const lines = getSourceLines(source);
  const tables: ParsedTable[] = [];
  let activeFence: FenceState | null = null;
  let inHtmlComment = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (inHtmlComment) {
      if (line.text.includes("-->")) {
        inHtmlComment = false;
      }
      lineIndex++;
      continue;
    }

    if (activeFence) {
      if (isClosingFence(line.text, activeFence)) {
        activeFence = null;
      }
      lineIndex++;
      continue;
    }

    if (startsHtmlCommentBlock(line.text)) {
      inHtmlComment = !line.text.includes("-->");
      lineIndex++;
      continue;
    }

    const openingFence = parseOpeningFence(line.text);
    if (openingFence) {
      activeFence = openingFence;
      lineIndex++;
      continue;
    }

    if (isIndentedCodeLine(line.text)) {
      lineIndex++;
      continue;
    }

    const delimiterLine = lines[lineIndex + 1];
    const isHeaderCandidate =
      hasUnescapedPipe(line.text) &&
      Boolean(delimiterLine) &&
      !isIndentedCodeLine(delimiterLine.text) &&
      DELIMITER_RE.test(delimiterLine.text) &&
      hasUnescapedPipe(delimiterLine.text);

    if (!isHeaderCandidate || !delimiterLine) {
      lineIndex++;
      continue;
    }

    const header = parseRow(line);
    const delimiter = parseRow(delimiterLine);
    if (header.cells.length === 0 || delimiter.cells.length === 0) {
      lineIndex++;
      continue;
    }

    const body: ParsedRow[] = [];
    let bodyIndex = lineIndex + 2;
    while (bodyIndex < lines.length) {
      const bodyLine = lines[bodyIndex];
      if (
        parseOpeningFence(bodyLine.text) ||
        startsHtmlCommentBlock(bodyLine.text) ||
        isIndentedCodeLine(bodyLine.text) ||
        bodyLine.text.trim() === "" ||
        !hasUnescapedPipe(bodyLine.text)
      ) {
        break;
      }

      const row = parseRow(bodyLine);
      if (row.cells.length === 0) {
        break;
      }

      body.push(row);
      bodyIndex++;
    }

    const columnCount = Math.max(
      header.cells.length,
      delimiter.cells.length,
      ...body.map((row) => row.cells.length),
    );
    const endRow = body.length > 0 ? body[body.length - 1] : delimiter;

    tables.push({
      from: line.from,
      to: endRow.to,
      startLine: line.index,
      endLine: endRow.lineIndex,
      header,
      delimiter,
      body,
      columnCount,
      alignments: Array.from({ length: columnCount }, (_, column) =>
        parseAlignment(delimiter.cells[column]?.raw ?? ""),
      ),
    });

    lineIndex = bodyIndex;
  }

  return tables;
}

/**
 * Parses a CommonMark-style fenced-code opener. Closing fences are tracked by
 * marker and run length so a tilde fence cannot close a backtick fence, and a
 * shorter run cannot close a longer opener.
 */
function parseOpeningFence(text: string): FenceState | null {
  if (isIndentedCodeLine(text)) {
    return null;
  }

  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match) {
    return null;
  }

  const run = match[1];
  const marker = run[0] as FenceState["marker"];
  if (marker === "`" && match[2].includes("`")) {
    return null;
  }

  return { marker, length: run.length };
}

function isClosingFence(text: string, fence: FenceState): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(text);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length,
  );
}

function startsHtmlCommentBlock(text: string): boolean {
  return /^ {0,3}<!--/.test(text);
}

/** Four columns of leading indentation form an indented code block. */
function isIndentedCodeLine(text: string): boolean {
  let column = 0;
  for (const character of text) {
    if (character === " ") {
      column++;
    } else if (character === "\t") {
      column += 4 - (column % 4);
    } else {
      break;
    }

    if (column >= 4) {
      return true;
    }
  }

  return false;
}

export function rowToDisplayValues(
  row: ParsedRow,
  columnCount: number,
): string[] {
  return Array.from({ length: columnCount }, (_, column) =>
    markdownCellToDisplayText(row.cells[column]?.raw ?? ""),
  );
}

export function markdownCellToDisplayText(text: string): string {
  return text
    .trim()
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&#124;|&vert;/gi, "|");
}

export function formatMarkdownRow(values: string[]): string {
  return `| ${values.map((value) => formatMarkdownCell(value)).join(" | ")} |`;
}

export function formatMarkdownCell(
  value: string,
  options: { trim?: boolean } = {},
): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  return (options.trim === false ? normalized : normalized.trim())
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "&#124;");
}

/**
 * Makes raw cell source safe to place immediately before a generated table
 * separator. Markdown-it treats a separator preceded by any backslash run as
 * escaped (including an even run), which merges this cell with the next one.
 * Append invisible Markdown padding that the display-value parser trims off.
 */
export function ensureTableCellSeparatorSafe(raw: string): string {
  return raw.endsWith("\\") ? `${raw} ` : raw;
}

/** Adds the structural opener needed when a compact row's first cell changes. */
export function tableCellLeadingPipePrefix(
  row: ParsedRow,
  column: number,
): "" | "|" {
  const cell = row.cells[column];
  return column === 0 && cell?.start === row.from ? "|" : "";
}

export function formatTableCellEdit(
  row: ParsedRow,
  columnCount: number,
  column: number,
  value: string,
): string {
  const values = rowToDisplayValues(row, Math.max(columnCount, column + 1));
  values[column] = value;
  return formatMarkdownRow(values);
}

export function formatTableCellSourceEdit(
  row: ParsedRow,
  columnCount: number,
  column: number,
  value: string,
): TableCellSourceEdit {
  const cell = row.cells[column];
  if (!cell) {
    return {
      from: row.from,
      to: row.to,
      insert: formatTableCellEdit(row, columnCount, column, value),
    };
  }

  const { leadingWhitespace, trailingWhitespace } = getCellPaddingWhitespace(
    cell.raw,
  );

  return {
    from: cell.start,
    to: cell.end,
    insert: ensureTableCellSeparatorSafe(
      `${tableCellLeadingPipePrefix(row, column)}${leadingWhitespace}${formatMarkdownCell(value)}${trailingWhitespace}`,
    ),
  };
}

/**
 * Splits the raw cell text into the whitespace that padded it in the source
 * row, so cell edits can preserve the author's column spacing. A whitespace-only
 * cell is split down the middle to keep padding on both sides of the new value.
 */
export function getCellPaddingWhitespace(raw: string): {
  leadingWhitespace: string;
  trailingWhitespace: string;
} {
  if (raw.trim() === "") {
    const split = Math.floor(raw.length / 2);
    return {
      leadingWhitespace: raw.slice(0, split),
      trailingWhitespace: raw.slice(split),
    };
  }

  return {
    leadingWhitespace: raw.match(/^\s*/)?.[0] ?? "",
    trailingWhitespace: raw.match(/\s*$/)?.[0] ?? "",
  };
}

function getSourceLines(source: string): SourceLine[] {
  if (source.length === 0) {
    return [{ index: 0, from: 0, to: 0, text: "" }];
  }

  const lines: SourceLine[] = [];
  let from = 0;
  let index = 0;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const rawTo = newline === -1 ? source.length : newline;
    const to = rawTo > from && source[rawTo - 1] === "\r" ? rawTo - 1 : rawTo;
    lines.push({
      index,
      from,
      to,
      text: source.slice(from, to),
    });

    if (newline === -1) {
      break;
    }
    from = newline + 1;
    index++;
  }

  return lines;
}

function parseRow(line: SourceLine): ParsedRow {
  const pipes = findUnescapedPipes(line.text);
  const firstPipe = pipes[0];
  const lastPipe = pipes[pipes.length - 1];
  const hasLeadingPipe =
    firstPipe !== undefined && line.text.slice(0, firstPipe).trim() === "";
  const hasTrailingPipe =
    lastPipe !== undefined && line.text.slice(lastPipe + 1).trim() === "";
  const contentStart = hasLeadingPipe ? (firstPipe ?? -1) + 1 : 0;
  const contentEnd = hasTrailingPipe
    ? (lastPipe ?? line.text.length)
    : line.text.length;
  const separatorPipes = pipes.filter(
    (pipe) => pipe >= contentStart && pipe < contentEnd,
  );

  const cells: ParsedCell[] = [];
  let start = contentStart;
  for (const pipe of separatorPipes) {
    cells.push({
      raw: line.text.slice(start, pipe),
      start: line.from + start,
      end: line.from + pipe,
    });
    start = pipe + 1;
  }

  if (pipes.length > 0) {
    cells.push({
      raw: line.text.slice(start, contentEnd),
      start: line.from + start,
      end: line.from + contentEnd,
    });
  }

  return {
    lineIndex: line.index,
    from: line.from,
    to: line.to,
    text: line.text,
    cells,
  };
}

export function parseMarkdownTableRow(
  lineIndex: number,
  from: number,
  text: string,
): ParsedRow {
  return parseRow({
    index: lineIndex,
    from,
    to: from + text.length,
    text,
  });
}

function parseAlignment(delimiterCell: string): CellAlignment {
  const text = delimiterCell.trim();
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  return "left";
}

function hasUnescapedPipe(text: string): boolean {
  return findUnescapedPipes(text).length > 0;
}

function findUnescapedPipes(text: string): number[] {
  const pipes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "|" && !isEscaped(text, index)) {
      pipes.push(index);
    }
  }
  return pipes;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
