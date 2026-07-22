/**
 * Rich table cells need a deliberately small HTML surface, but lists are
 * block content rather than inline formatting. Keeping their semantic tags is
 * important: it gives Word a real nested <ul>/<ol> structure to import and
 * gives Excel explicit line and indentation boundaries inside the surrounding
 * worksheet cell.
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

const UNORDERED_MARKERS = ["disc", "circle", "square"];
const ORDERED_MARKERS = ["decimal", "lower-alpha", "lower-roman"];

/**
 * Rewrites supported rich HTML into the conservative subset shared by Word
 * and Excel. Explicit inline list geometry is more portable than inherited
 * browser defaults, which vary and can collapse at deeper nesting levels.
 */
export function officeCompatibleRichHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
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

  parsed.body.querySelectorAll<HTMLElement>("ul, ol").forEach((list) => {
    const depth = listDepth(list);
    const markers = list.tagName === "OL" ? ORDERED_MARKERS : UNORDERED_MARKERS;
    const marker = explicitListMarker(list) ?? markers[(depth - 1) % markers.length];
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

function listDepth(list: HTMLElement): number {
  let depth = 1;
  for (let parent = list.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "UL" || parent.tagName === "OL") {
      depth++;
    }
  }
  return depth;
}

function explicitListMarker(list: HTMLElement): string | null {
  const type = list.getAttribute("type");
  if (!type) {
    return null;
  }
  if (list.tagName === "UL") {
    return ["disc", "circle", "square"].includes(type.toLowerCase())
      ? type.toLowerCase()
      : null;
  }
  return ({
    "1": "decimal",
    a: "lower-alpha",
    A: "upper-alpha",
    i: "lower-roman",
    I: "upper-roman",
  } as Record<string, string>)[type] ?? null;
}
