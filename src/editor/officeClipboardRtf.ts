type ListKind = "ul" | "ol";

interface ListLevelDefinition {
  kind: ListKind;
  start: number;
  type: string | null;
}

interface ListDefinition {
  id: number;
  root: HTMLElement;
  levels: ListLevelDefinition[];
}

interface RenderContext {
  inTable: boolean;
  listDefinitions: Map<HTMLElement, ListDefinition>;
  forceBold?: boolean;
}

const UNORDERED_MARKERS = [8226, 9702, 9642];

/**
 * Builds a native RTF companion for Office Rich Copy. The HTML companion is
 * deliberately spreadsheet-safe; this representation carries real Word list
 * metadata while retaining the same outer table row/cell boundaries.
 */
export function officeRtfFromHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const definitions = collectListDefinitions(parsed);
  const definitionMap = new Map(
    definitions.map((definition) => [definition.root, definition]),
  );
  const body = Array.from(parsed.body.childNodes)
    .map((node) => renderBlockNode(node, {
      inTable: false,
      listDefinitions: definitionMap,
    }))
    .join("");
  const listTable = definitions.length > 0
    ? `{\\*\\listtable${definitions.map(renderListDefinition).join("")}}`
    : "";
  const overrideTable = definitions.length > 0
    ? `{\\*\\listoverridetable${definitions
        .map((definition) =>
          `{\\listoverride\\listid${definition.id}\\listoverridecount0\\ls${definition.id}}`
        )
        .join("")}}`
    : "";
  return [
    "{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0",
    "{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}{\\f1\\fmodern\\fcharset0 Courier New;}}",
    "{\\colortbl;\\red0\\green0\\blue0;}",
    listTable,
    overrideTable,
    "\\viewkind4\\fs22 ",
    body,
    "}",
  ].join("");
}

function collectListDefinitions(parsed: Document): ListDefinition[] {
  const roots = Array.from(parsed.body.querySelectorAll<HTMLElement>("ul, ol"))
    .filter((list) => !closestList(list.parentElement));
  return roots.map((root, index) => {
    const levels: ListLevelDefinition[] = [];
    collectListLevels(root, 0, levels);
    return { id: index + 1, root, levels };
  });
}

function collectListLevels(
  list: HTMLElement,
  depth: number,
  levels: ListLevelDefinition[],
): void {
  if (!levels[depth]) {
    levels[depth] = {
      kind: list.tagName === "OL" ? "ol" : "ul",
      start: listStart(list),
      type: list.getAttribute("type"),
    };
  }
  for (const item of directListItems(list)) {
    for (const nested of directNestedLists(item)) {
      collectListLevels(nested, Math.min(depth + 1, 8), levels);
    }
  }
}

function renderListDefinition(definition: ListDefinition): string {
  const fallback = definition.levels[definition.levels.length - 1] ?? {
    kind: "ul" as const,
    start: 1,
    type: null,
  };
  const levels = Array.from({ length: 9 }, (_, depth) =>
    renderListLevelDefinition(
      definition.levels[depth] ?? fallback,
      depth,
      definition.id * 10 + depth + 1,
    ),
  ).join("");
  return `{\\list\\listtemplateid${definition.id}\\listhybrid${levels}{\\listname ;}\\listid${definition.id}}`;
}

function renderListLevelDefinition(
  definition: ListLevelDefinition,
  depth: number,
  templateId: number,
): string {
  const indent = (depth + 1) * 720;
  const shared = [
    "\\leveljc0\\leveljcn0\\levelfollow0",
    `\\levelstartat${Math.max(1, definition.start)}`,
    "\\levelspace360\\levelindent0",
  ].join("");
  if (definition.kind === "ul") {
    const marker = UNORDERED_MARKERS[Math.min(depth, 2)];
    const markerName = ["disc", "circle", "square"][Math.min(depth, 2)];
    return [
      "{\\listlevel\\levelnfc23\\levelnfcn23",
      shared,
      `{\\*\\levelmarker \\{${markerName}\\}}`,
      `{\\leveltext\\leveltemplateid${templateId}\\'01\\uc0\\u${marker} ;}`,
      "{\\levelnumbers;}",
      `\\fi-360\\li${indent}\\lin${indent}}`,
    ].join("");
  }
  const numberStyle = orderedNumberStyle(definition.type, depth);
  const placeholder = depth.toString(16).padStart(2, "0");
  return [
    `{\\listlevel\\levelnfc${numberStyle}\\levelnfcn${numberStyle}`,
    shared,
    `{\\leveltext\\leveltemplateid${templateId}\\'02\\'${placeholder}.;}`,
    `{\\levelnumbers\\'01;}`,
    `\\fi-360\\li${indent}\\lin${indent}}`,
  ].join("");
}

function renderBlockNode(node: Node, context: RenderContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    return text.trim() ? renderParagraph(rtfEscape(text), context) : "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (node.tagName === "META" || node.tagName === "STYLE") {
    return "";
  }
  if (node.tagName === "TABLE") {
    return renderTable(node, context);
  }
  if (isList(node)) {
    return renderList(node, 0, context);
  }
  if (node.tagName === "BR") {
    return renderParagraph("", context);
  }
  if (node.tagName === "HR") {
    return renderParagraph("________________", context);
  }
  if (isBlockElement(node)) {
    const content = renderInlineChildren(node, context);
    const headingSize = headingFontSize(node.tagName);
    const formatted = headingSize
      ? `{\\b\\fs${headingSize} ${content}}`
      : content;
    const paragraph = renderParagraph(formatted, context);
    const nested = Array.from(node.children)
      .filter((child): child is HTMLElement =>
        child instanceof HTMLElement && (isList(child) || child.tagName === "TABLE")
      )
      .map((child) => renderBlockNode(child, context))
      .join("");
    return paragraph + nested;
  }
  return renderParagraph(renderInlineNode(node, context), context);
}

function renderParagraph(content: string, context: RenderContext): string {
  const table = context.inTable ? "\\intbl\\itap1" : "";
  return `\\pard${table} ${content}\\par `;
}

function renderTable(table: HTMLElement, context: RenderContext): string {
  const rows = directTableRows(table);
  return rows.map((row) => {
    const cells = Array.from(row.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        (child.tagName === "TD" || child.tagName === "TH"),
    );
    if (cells.length === 0) {
      return "";
    }
    const cellWidth = 2400;
    const definitions = cells.map((_, index) => [
      "\\clvertalt",
      "\\clbrdrt\\brdrs\\brdrw10",
      "\\clbrdrl\\brdrs\\brdrw10",
      "\\clbrdrb\\brdrs\\brdrw10",
      "\\clbrdrr\\brdrs\\brdrw10",
      `\\cellx${(index + 1) * cellWidth}`,
    ].join("")).join("");
    const contents = cells.map((cell) =>
      `${renderTableCell(cell, {
        ...context,
        inTable: true,
        forceBold: cell.tagName === "TH",
      })}\\cell `
    ).join("");
    return `\\trowd\\trgaph108\\trleft0${definitions}${contents}\\row `;
  }).join("");
}

function renderTableCell(cell: HTMLElement, context: RenderContext): string {
  const output: string[] = [];
  let inlineNodes: Node[] = [];
  const flushInline = (): void => {
    if (inlineNodes.length === 0) {
      return;
    }
    const content = inlineNodes.map((node) => renderInlineNode(node, context)).join("");
    if (content || output.length === 0) {
      output.push(renderParagraph(
        context.forceBold ? `{\\b ${content}}` : content,
        context,
      ));
    }
    inlineNodes = [];
  };
  for (const child of Array.from(cell.childNodes)) {
    if (child instanceof HTMLElement && isList(child)) {
      flushInline();
      output.push(renderList(child, 0, context));
    } else if (child instanceof HTMLElement && child.tagName === "TABLE") {
      flushInline();
      output.push(renderTable(child, context));
    } else {
      inlineNodes.push(child);
    }
  }
  flushInline();
  return output.join("") || renderParagraph("", context);
}

function renderList(
  list: HTMLElement,
  depth: number,
  context: RenderContext,
): string {
  const root = closestListRoot(list);
  const definition = context.listDefinitions.get(root);
  if (!definition) {
    return "";
  }
  const level = Math.min(depth, 8);
  const indent = (level + 1) * 720;
  const table = context.inTable ? "\\intbl\\itap1" : "";
  const ordered = list.tagName === "OL";
  const reversed = ordered && list.hasAttribute("reversed");
  const items = directListItems(list);
  let value = listStart(list, reversed ? items.length : 1);
  const step = reversed ? -1 : 1;
  const output: string[] = [];
  for (const item of items) {
    value = listItemValue(item, value, ordered);
    const marker = ordered
      ? orderedMarker(value, list.getAttribute("type"))
      : String.fromCodePoint(UNORDERED_MARKERS[Math.min(level, 2)]);
    const content = Array.from(item.childNodes)
      .filter((child) => !(child instanceof HTMLElement && isList(child)))
      .map((child) => renderInlineNode(child, context))
      .join("");
    output.push([
      `\\pard${table}\\tx${indent}\\li${indent}\\fi-360`,
      `\\ls${definition.id}\\ilvl${level}`,
      `{\\listtext ${rtfEscape(marker)}\\tab }`,
      context.forceBold ? `{\\b ${content}}` : content,
      "\\par ",
    ].join(""));
    for (const nested of directNestedLists(item)) {
      output.push(renderList(nested, level + 1, context));
    }
    value += step;
  }
  return output.join("");
}

function renderInlineChildren(
  element: HTMLElement,
  context: RenderContext,
): string {
  return Array.from(element.childNodes)
    .filter((child) =>
      !(child instanceof HTMLElement && (isList(child) || child.tagName === "TABLE"))
    )
    .map((child) => renderInlineNode(child, context))
    .join("");
}

function renderInlineNode(node: Node, context: RenderContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return rtfEscape(node.textContent ?? "");
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (node.tagName === "BR") {
    return "\\line ";
  }
  if (isList(node) || node.tagName === "TABLE") {
    return "";
  }
  const content = Array.from(node.childNodes)
    .map((child) => renderInlineNode(child, context))
    .join("");
  if (node.tagName === "A" && node.getAttribute("href")) {
    const href = rtfEscapeFieldInstruction(node.getAttribute("href") ?? "");
    return `{\\field{\\*\\fldinst{HYPERLINK "${href}"}}{\\fldrslt{${content}}}}`;
  }
  const controls: string[] = [];
  const style = node.getAttribute("style")?.toLowerCase() ?? "";
  if (
    node.tagName === "B" ||
    node.tagName === "STRONG" ||
    /font-weight\s*:\s*(bold|[6-9]00)/.test(style)
  ) {
    controls.push("\\b");
  }
  if (
    node.tagName === "I" ||
    node.tagName === "EM" ||
    style.includes("font-style:italic")
  ) {
    controls.push("\\i");
  }
  if (node.tagName === "U" || style.includes("text-decoration:underline")) {
    controls.push("\\ul");
  }
  if (
    node.tagName === "S" ||
    node.tagName === "DEL" ||
    style.includes("line-through")
  ) {
    controls.push("\\strike");
  }
  if (node.tagName === "CODE" || style.includes("font-family:monospace")) {
    controls.push("\\f1");
  }
  if (node.tagName === "SUB") {
    controls.push("\\sub");
  }
  if (node.tagName === "SUP") {
    controls.push("\\super");
  }
  return controls.length > 0 ? `{${controls.join("")} ${content}}` : content;
}

function directTableRows(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of Array.from(table.children)) {
    if (child instanceof HTMLElement && child.tagName === "TR") {
      rows.push(child);
      continue;
    }
    if (
      child instanceof HTMLElement &&
      (child.tagName === "THEAD" ||
        child.tagName === "TBODY" ||
        child.tagName === "TFOOT")
    ) {
      rows.push(...Array.from(child.children).filter(
        (row): row is HTMLElement =>
          row instanceof HTMLElement && row.tagName === "TR",
      ));
    }
  }
  return rows;
}

function directListItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.tagName === "LI",
  );
}

function directNestedLists(item: HTMLElement): HTMLElement[] {
  return Array.from(item.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && isList(child),
  );
}

function closestList(element: HTMLElement | null): HTMLElement | null {
  for (let current = element; current; current = current.parentElement) {
    if (isList(current)) {
      return current;
    }
  }
  return null;
}

function closestListRoot(list: HTMLElement): HTMLElement {
  let root = list;
  for (let parent = closestList(list.parentElement); parent; parent = closestList(parent.parentElement)) {
    root = parent;
  }
  return root;
}

function listStart(list: HTMLElement, fallback = 1): number {
  const parsed = list.hasAttribute("start")
    ? Number(list.getAttribute("start"))
    : Number.NaN;
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function listItemValue(
  item: HTMLElement,
  fallback: number,
  ordered: boolean,
): number {
  const parsed = item.hasAttribute("value")
    ? Number(item.getAttribute("value"))
    : Number.NaN;
  return ordered && Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function orderedNumberStyle(type: string | null, depth: number): number {
  if (type === "A") return 3;
  if (type === "a") return 4;
  if (type === "I") return 1;
  if (type === "i") return 2;
  return [0, 4, 2][depth % 3];
}

function orderedMarker(value: number, type: string | null): string {
  if (type === "A" || type === "a") {
    const marker = alphabetic(value);
    return `${type === "A" ? marker.toUpperCase() : marker}.`;
  }
  if (type === "I" || type === "i") {
    const marker = roman(value);
    return `${type === "I" ? marker.toUpperCase() : marker}.`;
  }
  return `${value}.`;
}

function alphabetic(value: number): string {
  let remaining = Math.max(1, Math.trunc(value));
  let result = "";
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function roman(value: number): string {
  let remaining = Math.max(1, Math.min(3999, Math.trunc(value)));
  let result = "";
  const numerals: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

function headingFontSize(tagName: string): number | null {
  const level = /^H([1-6])$/.exec(tagName)?.[1];
  return level ? [40, 34, 30, 26, 24, 22][Number(level) - 1] : null;
}

function isBlockElement(element: HTMLElement): boolean {
  return [
    "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "H5", "H6", "PRE",
  ].includes(element.tagName);
}

function isList(element: HTMLElement): boolean {
  return element.tagName === "UL" || element.tagName === "OL";
}

function rtfEscape(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const character = value[index];
    if (character === "\\" || character === "{" || character === "}") {
      result += `\\${character}`;
    } else if (character === "\n") {
      result += "\\line ";
    } else if (character === "\r") {
      continue;
    } else if (character === "\t") {
      result += "\\tab ";
    } else if (code >= 32 && code <= 126) {
      result += character;
    } else {
      result += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return result;
}

function rtfEscapeFieldInstruction(value: string): string {
  return value.replace(/([\\{}"])/g, "\\$1");
}
