import { TABLE_CELL_SELECTOR } from "./cellSelection";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const OVERLAY_SELECTOR = ":scope > .mlrt-table-selection-overlay";
const LEGACY_OUTLINE_SELECTOR = ":scope > .mlrt-table-selection-outline";
const COORDINATE_TOLERANCE = 0.25;

interface SelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Renders every solid selection line in one SVG coordinate space.
 *
 * Cells own only the selection fill. The SVG owns both the interior rails and
 * the perimeter, which prevents independently clipped cell shadows from
 * leaving gaps or crossing the blue frame at grid intersections.
 */
export function syncTableSelectionOverlay(wrapper: HTMLElement): void {
  const scroll = wrapper.querySelector<HTMLElement>(".mlrt-table-scroll");
  const existing = scroll?.querySelector<SVGSVGElement>(OVERLAY_SELECTOR);
  // Remove an outline created by builds that predate the unified SVG overlay.
  scroll
    ?.querySelector<HTMLElement>(LEGACY_OUTLINE_SELECTOR)
    ?.remove();

  if (!scroll) {
    existing?.remove();
    return;
  }

  const selected = Array.from(
    wrapper.querySelectorAll<HTMLElement>(
      `${TABLE_CELL_SELECTOR}.mlrt-table-cell-selected, ` +
        `${TABLE_CELL_SELECTOR}.mlrt-document-range-selected`,
    ),
  );
  if (selected.length === 0) {
    existing?.remove();
    return;
  }

  const rectangles = selected.map((cell) => cell.getBoundingClientRect());
  const bounds: SelectionBounds = {
    left: Math.min(...rectangles.map((rect) => rect.left)),
    top: Math.min(...rectangles.map((rect) => rect.top)),
    right: Math.max(...rectangles.map((rect) => rect.right)),
    bottom: Math.max(...rectangles.map((rect) => rect.bottom)),
  };
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0) {
    existing?.remove();
    return;
  }

  const verticalRails = uniqueInteriorCoordinates(
    rectangles.map((rect) => rect.left),
    bounds.left,
    bounds.right,
  ).map((coordinate) => coordinate - bounds.left);
  const horizontalRails = uniqueInteriorCoordinates(
    rectangles.map((rect) => rect.top),
    bounds.top,
    bounds.bottom,
  ).map((coordinate) => coordinate - bounds.top);

  const overlay =
    existing ??
    wrapper.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  overlay.classList.add("mlrt-table-selection-overlay");
  overlay.classList.toggle(
    "mlrt-table-selection-overlay-cut-pending",
    wrapper.classList.contains("mlrt-table-cut-pending"),
  );
  overlay.setAttribute("aria-hidden", "true");
  overlay.setAttribute("focusable", "false");
  const formattedWidth = formatCoordinate(width);
  const formattedHeight = formatCoordinate(height);
  overlay.setAttribute("width", formattedWidth);
  overlay.setAttribute("height", formattedHeight);
  overlay.setAttribute(
    "viewBox",
    `0 0 ${formattedWidth} ${formattedHeight}`,
  );
  overlay.dataset.verticalRailCount = String(verticalRails.length);
  overlay.dataset.horizontalRailCount = String(horizontalRails.length);
  overlay.dataset.verticalRails = verticalRails.map(formatCoordinate).join(",");
  overlay.dataset.horizontalRails = horizontalRails
    .map(formatCoordinate)
    .join(",");

  const scrollRect = scroll.getBoundingClientRect();
  overlay.style.left = `${bounds.left - scrollRect.left + scroll.scrollLeft}px`;
  overlay.style.top = `${bounds.top - scrollRect.top + scroll.scrollTop}px`;
  overlay.style.width = `${formattedWidth}px`;
  overlay.style.height = `${formattedHeight}px`;

  const inset = Math.min(1, width / 2, height / 2);
  const gridCommands = [
    ...verticalRails.map(
      (x) =>
        `M ${formatCoordinate(x)} ${formatCoordinate(inset)} ` +
        `V ${formatCoordinate(height - inset)}`,
    ),
    ...horizontalRails.map(
      (y) =>
        `M ${formatCoordinate(inset)} ${formatCoordinate(y)} ` +
        `H ${formatCoordinate(width - inset)}`,
    ),
  ];
  const gridPath = gridCommands.join(" ");
  const frameWidth = formatCoordinate(Math.max(0, width - 1));
  const frameHeight = formatCoordinate(Math.max(0, height - 1));
  const geometrySignature = [
    formattedWidth,
    formattedHeight,
    gridPath,
  ].join("|");
  const currentGrid = overlay.querySelector<SVGPathElement>(
    ":scope > .mlrt-table-selection-grid",
  );
  const currentFrame = overlay.querySelector<SVGRectElement>(
    ":scope > .mlrt-table-selection-frame",
  );
  if (
    overlay.dataset.geometrySignature !== geometrySignature ||
    !currentGrid ||
    !currentFrame ||
    overlay.lastElementChild !== currentFrame
  ) {
    const grid = wrapper.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    grid.classList.add("mlrt-table-selection-grid");
    grid.setAttribute("d", gridPath);

    // Paint the frame last. Its stroke therefore wins at every rail endpoint,
    // and the half-pixel inset keeps the stroke inside the selected cell union.
    const frame = wrapper.ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
    frame.classList.add("mlrt-table-selection-frame");
    frame.setAttribute("x", "0.5");
    frame.setAttribute("y", "0.5");
    frame.setAttribute("width", frameWidth);
    frame.setAttribute("height", frameHeight);

    overlay.replaceChildren(grid, frame);
    overlay.dataset.geometrySignature = geometrySignature;
  }
  if (!existing) {
    scroll.append(overlay);
  }
}

function uniqueInteriorCoordinates(
  values: readonly number[],
  minimum: number,
  maximum: number,
): number[] {
  const sorted = values
    .filter(
      (value) =>
        value > minimum + COORDINATE_TOLERANCE &&
        value < maximum - COORDINATE_TOLERANCE,
    )
    .sort((left, right) => left - right);
  const groups: Array<{ sum: number; count: number }> = [];
  for (const value of sorted) {
    const group = groups.at(-1);
    if (
      !group ||
      Math.abs(value - group.sum / group.count) >
        COORDINATE_TOLERANCE
    ) {
      groups.push({ sum: value, count: 1 });
    } else {
      group.sum += value;
      group.count += 1;
    }
  }
  return groups.map((group) => group.sum / group.count);
}

function formatCoordinate(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
