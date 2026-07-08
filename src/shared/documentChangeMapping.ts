export interface DocumentChangeLike {
  from: number;
  to: number;
  text: string;
}

export interface LineCharacter {
  line: number;
  character: number;
}

export interface MappedDocumentChange {
  from: LineCharacter;
  to: LineCharacter;
  text: string;
}

export function normalizeDocumentText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function getHostLineSeparator(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeChangeTextLineEndings(
  text: string,
  lineSeparator: "\r\n" | "\n",
): string {
  return lineSeparator === "\n"
    ? normalizeDocumentText(text)
    : normalizeDocumentText(text).replace(/\n/g, lineSeparator);
}

export function lineCharacterAtNormalizedOffset(
  normalizedText: string,
  offset: number,
): LineCharacter {
  const clampedOffset = Math.min(Math.max(0, offset), normalizedText.length);
  let line = 0;
  let lineStart = 0;

  for (let index = 0; index < clampedOffset; index++) {
    if (normalizedText.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }

  return {
    line,
    character: clampedOffset - lineStart,
  };
}

export function mapNormalizedDocumentChangesToHost(
  hostText: string,
  changes: readonly DocumentChangeLike[],
): MappedDocumentChange[] {
  const normalizedHostText = normalizeDocumentText(hostText);
  const lineSeparator = getHostLineSeparator(hostText);

  return changes.map((change) => ({
    from: lineCharacterAtNormalizedOffset(normalizedHostText, change.from),
    to: lineCharacterAtNormalizedOffset(normalizedHostText, change.to),
    text: normalizeChangeTextLineEndings(change.text, lineSeparator),
  }));
}
