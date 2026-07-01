export type LiveBlockType = "paragraph" | "table";

export interface LiveBlock {
  id: string;
  type: LiveBlockType;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
}

export interface LiveDocModel {
  version: number;
  text: string;
  blocks: LiveBlock[];
  meta: {
    dialect: "markdown-live-v4";
    parser: "table-first";
  };
}

export function createLiveDocModel({
  version = 0,
  text = "",
  blocks = [],
}: {
  version?: number;
  text?: string;
  blocks?: LiveBlock[];
} = {}): LiveDocModel {
  const normalizedText = typeof text === "string" ? text : "";
  const textLength = normalizedText.length;

  return {
    version: normalizeNumber(version),
    text: normalizedText,
    blocks: blocks
      .map((block, index) => normalizeBlock(block, index, textLength))
      .filter((block): block is LiveBlock => Boolean(block))
      .sort((left, right) => left.from - right.from || left.to - right.to),
    meta: {
      dialect: "markdown-live-v4",
      parser: "table-first",
    },
  };
}

export function createEmptyLiveDocModel(): LiveDocModel {
  return createLiveDocModel();
}

function normalizeBlock(
  block: LiveBlock,
  index: number,
  textLength: number,
): LiveBlock | null {
  if (!block || !Number.isFinite(block.from) || !Number.isFinite(block.to)) {
    return null;
  }

  const from = clampNumber(block.from, 0, textLength);
  const to = clampNumber(block.to, from, textLength);
  if (to <= from) {
    return null;
  }

  const type: LiveBlockType = block.type === "table" ? "table" : "paragraph";
  const lineFrom = Math.max(1, normalizeNumber(block.lineFrom, 1));
  const lineTo = Math.max(lineFrom, normalizeNumber(block.lineTo, lineFrom));

  return {
    id: block.id || `live-block-${index + 1}-${from}-${to}`,
    type,
    from,
    to,
    lineFrom,
    lineTo,
  };
}

function normalizeNumber(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) {
    return Math.max(0, Math.trunc(fallback));
  }
  return Math.max(0, Math.trunc(value));
}

function clampNumber(value: number, min: number, max: number): number {
  const normalized = normalizeNumber(value, min);
  return Math.max(min, Math.min(max, normalized));
}
