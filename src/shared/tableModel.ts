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
  id: string;
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

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const DELIMITER_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function parseMarkdownTables(source: string): ParsedTable[] {
  const lines = getSourceLines(source);
  const tables: ParsedTable[] = [];
  let inFence = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (FENCE_RE.test(line.text)) {
      inFence = !inFence;
      lineIndex++;
      continue;
    }
    if (inFence) {
      lineIndex++;
      continue;
    }

    const delimiterLine = lines[lineIndex + 1];
    const isHeaderCandidate =
      hasUnescapedPipe(line.text) &&
      !DELIMITER_RE.test(line.text) &&
      Boolean(delimiterLine) &&
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
        FENCE_RE.test(bodyLine.text) ||
        bodyLine.text.trim() === "" ||
        !hasUnescapedPipe(bodyLine.text)
      ) {
        break;
      }

      const row = parseRow(bodyLine);
      if (row.cells.length === 0 || DELIMITER_RE.test(bodyLine.text)) {
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
      id: `table-${line.from}-${endRow.to}`,
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
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ");
  return (options.trim === false ? normalized : normalized.trim())
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "&#124;");
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

  const { leadingWhitespace, trailingWhitespace } =
    getCellPaddingWhitespace(cell.raw);

  return {
    from: cell.start,
    to: cell.end,
    insert: `${leadingWhitespace}${formatMarkdownCell(value)}${trailingWhitespace}`,
  };
}

function getCellPaddingWhitespace(raw: string): {
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
  const contentEnd = hasTrailingPipe ? lastPipe ?? line.text.length : line.text.length;
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
