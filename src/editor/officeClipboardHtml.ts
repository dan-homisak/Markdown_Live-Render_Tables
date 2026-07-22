/**
 * Rich table cells need a deliberately small HTML surface. Semantic list tags
 * are accepted as input, then either flattened for spreadsheet-safe HTML or
 * retained while building Rich Copy's native Word/RTF companion.
 */
export const OFFICE_RICH_CELL_ALLOWED_TAGS = [
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "code",
  "br",
  "sub",
  "sup",
  "ul",
  "ol",
  "li",
];

export const OFFICE_RICH_CELL_ALLOWED_ATTR = [
  "href",
  "title",
  "start",
  "reversed",
  "type",
  "value",
];

const SMART_UNORDERED_MARKERS = ["•", "◦", "▪"];

/**
 * Rewrites supported rich HTML into inline formatting shared by Word and
 * Excel. Lists become inline spans separated by same-cell line breaks; no
 * block elements remain for Excel to reinterpret as rows or columns.
 */
export function officeCompatibleRichHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  normalizeRichInlineFormatting(parsed);
  flattenRichLists(parsed);
  return parsed.body.innerHTML;
}

/**
 * Keeps semantic list elements while applying explicit per-level geometry for
 * Rich Copy's native Word/RTF companion. Excel never receives this block-list
 * HTML representation.
 */
export function officeCompatibleWordHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  normalizeRichInlineFormatting(parsed);
  parsed.body.querySelectorAll<HTMLElement>("ul, ol").forEach((list) => {
    const depth = listDepth(list);
    const marker = list.tagName === "OL"
      ? orderedListStyle(list.getAttribute("type"), depth)
      : ["disc", "circle", "square"][(depth - 1) % 3];
    list.setAttribute(
      "style",
      [
        "margin-top:0",
        "margin-bottom:0",
        "padding-left:24pt",
        "list-style-position:outside",
        `list-style-type:${marker}`,
      ].join(";"),
    );
  });
  parsed.body.querySelectorAll<HTMLElement>("li").forEach((item) => {
    item.setAttribute("style", "margin:0;padding:0");
  });
  return parsed.body.innerHTML;
}

function normalizeRichInlineFormatting(parsed: Document): void {
  const replaceWithSpan = (selector: string, style: string): void => {
    parsed.body.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const span = parsed.createElement("span");
      span.setAttribute("style", style);
      span.append(...Array.from(element.childNodes));
      element.replaceWith(span);
    });
  };
  replaceWithSpan("strong, b", "font-weight:700");
  replaceWithSpan("em, i", "font-style:italic");
  replaceWithSpan("code", "font-family:monospace");
  replaceWithSpan("s, del", "text-decoration:line-through");
  parsed.body.querySelectorAll("br").forEach((br) =>
    br.setAttribute("style", "mso-data-placement:same-cell"),
  );
}

function flattenRichLists(parsed: Document): void {
  const roots = Array.from(parsed.body.querySelectorAll<HTMLElement>("ul, ol"))
    .filter((list) => !list.parentElement?.closest("ul, ol"));
  for (const root of roots) {
    const nodes: Node[] = [];
    appendRichListNodes(root, nodes, 0, parsed);
    root.replaceWith(...nodes);
  }
}

function appendRichListNodes(
  list: HTMLElement,
  nodes: Node[],
  depth: number,
  parsed: Document,
): void {
  const ordered = list.tagName === "OL";
  const items = listItems(list);
  const reversed = ordered && list.hasAttribute("reversed");
  let value = listStart(list, items.length, reversed);
  const step = reversed ? -1 : 1;
  for (const item of items) {
    value = explicitItemValue(item, value, ordered);
    if (nodes.length > 0) {
      const br = parsed.createElement("br");
      br.setAttribute("style", "mso-data-placement:same-cell");
      nodes.push(br);
    }
    const content = item.cloneNode(true) as HTMLElement;
    content.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => nested.remove());
    const line = parsed.createElement("span");
    line.setAttribute("style", "white-space:pre-wrap");
    const marker = ordered
      ? smartOrderedMarker(value, list.getAttribute("type"))
      : SMART_UNORDERED_MARKERS[depth % SMART_UNORDERED_MARKERS.length];
    line.append(
      parsed.createTextNode(`${"\u00a0".repeat(depth * 4)}${marker} `),
      ...Array.from(content.childNodes),
    );
    nodes.push(line);
    for (const nested of Array.from(item.children)) {
      if (nested instanceof HTMLElement && isList(nested)) {
        appendRichListNodes(nested, nodes, depth + 1, parsed);
      }
    }
    value += step;
  }
}

function listDepth(list: HTMLElement): number {
  let depth = 1;
  for (let parent = list.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "UL" || parent.tagName === "OL") {
      depth++;
    }
  }
  return depth;
}

function orderedListStyle(type: string | null, depth: number): string {
  return ({
    "1": "decimal",
    a: "lower-alpha",
    A: "upper-alpha",
    i: "lower-roman",
    I: "upper-roman",
  } as Record<string, string>)[type ?? ""] ??
    ["decimal", "lower-alpha", "lower-roman"][(depth - 1) % 3];
}

/**
 * Converts semantic lists to inline text and same-cell line breaks for Smart
 * Copy. Nested block lists are useful to Word but Excel can interpret their
 * levels as worksheet columns. This representation keeps every level inside
 * the existing <td> without tabs or nested block elements.
 */
export function officeCompatibleSmartListHtml(html: string): string | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  if (!parsed.body.querySelector("ul, ol")) {
    return null;
  }
  const lines: string[] = [];
  for (const child of Array.from(parsed.body.childNodes)) {
    if (child instanceof HTMLElement && isList(child)) {
      appendSmartListLines(child, lines, 0);
      continue;
    }
    const text = visibleNodeText(child).trim();
    if (text) {
      lines.push(text);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  const container = parsed.createElement("span");
  lines.forEach((line, index) => {
    if (index > 0) {
      const br = parsed.createElement("br");
      br.setAttribute("style", "mso-data-placement:same-cell");
      container.append(br);
    }
    container.append(parsed.createTextNode(line));
  });
  return container.innerHTML;
}

function appendSmartListLines(
  list: HTMLElement,
  lines: string[],
  depth: number,
): void {
  const ordered = list.tagName === "OL";
  const items = listItems(list);
  const reversed = ordered && list.hasAttribute("reversed");
  let value = listStart(list, items.length, reversed);
  const step = reversed ? -1 : 1;
  for (const item of items) {
    value = explicitItemValue(item, value, ordered);
    const clone = item.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(":scope > ul, :scope > ol").forEach((nested) => nested.remove());
    const itemLines = visibleNodeText(clone)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const indent = "\u00a0".repeat(depth * 4);
    const marker = ordered
      ? smartOrderedMarker(value, list.getAttribute("type"))
      : SMART_UNORDERED_MARKERS[depth % SMART_UNORDERED_MARKERS.length];
    lines.push(`${indent}${marker} ${itemLines[0] ?? ""}`.trimEnd());
    for (const continuation of itemLines.slice(1)) {
      lines.push(`${indent}\u00a0\u00a0${continuation}`);
    }
    for (const nested of Array.from(item.children)) {
      if (nested instanceof HTMLElement && isList(nested)) {
        appendSmartListLines(nested, lines, depth + 1);
      }
    }
    value += step;
  }
}

function listItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.tagName === "LI",
  );
}

function listStart(
  list: HTMLElement,
  itemCount: number,
  reversed: boolean,
): number {
  const parsedStart = list.hasAttribute("start")
    ? Number(list.getAttribute("start"))
    : Number.NaN;
  return Number.isFinite(parsedStart)
    ? parsedStart
    : reversed
      ? itemCount
      : 1;
}

function explicitItemValue(
  item: HTMLElement,
  fallback: number,
  ordered: boolean,
): number {
  const explicitValue = item.hasAttribute("value")
    ? Number(item.getAttribute("value"))
    : Number.NaN;
  return ordered && Number.isFinite(explicitValue)
    ? explicitValue
    : fallback;
}

function smartOrderedMarker(value: number, type: string | null): string {
  if (type === "a" || type === "A") {
    const marker = numberToAlphabetic(value);
    return `${type === "A" ? marker.toUpperCase() : marker}.`;
  }
  if (type === "i" || type === "I") {
    const marker = numberToRoman(value);
    return `${type === "I" ? marker.toUpperCase() : marker}.`;
  }
  return `${value}.`;
}

function numberToAlphabetic(value: number): string {
  let remaining = Math.max(1, Math.trunc(value));
  let result = "";
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function numberToRoman(value: number): string {
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

function visibleNodeText(node: Node): string {
  const container = document.createElement("span");
  container.append(node.cloneNode(true));
  container.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (container.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");
}

function isList(element: HTMLElement): boolean {
  return element.tagName === "UL" || element.tagName === "OL";
}
