import { CellRectangle } from "../shared/clipboardModel";

export interface PendingTableCut {
  kind: "table";
  token: string;
  sourceDocument: string;
  tableFrom: number;
  rectangle: CellRectangle;
  sourceTableText: string;
}

export interface PendingDocumentCut {
  kind: "document";
  token: string;
  sourceDocument: string;
  from: number;
  to: number;
  markdown: string;
}

export interface PendingCompositeCutChange {
  from: number;
  to: number;
  insert: string;
}

export interface PendingCompositeCut {
  kind: "composite";
  token: string;
  sourceDocument: string;
  sourceDocumentText: string;
  markdown: string;
  changes: PendingCompositeCutChange[];
}

export type PendingClipboardCut =
  | PendingTableCut
  | PendingDocumentCut
  | PendingCompositeCut;

const pendingCuts = new WeakMap<Document, PendingClipboardCut>();

export function getPendingClipboardCut(
  doc: Document,
): PendingClipboardCut | null {
  return pendingCuts.get(doc) ?? null;
}

export function setPendingClipboardCut(
  doc: Document,
  pending: PendingClipboardCut,
): void {
  clearPendingClipboardCut(doc);
  pendingCuts.set(doc, pending);
}

export function clearPendingClipboardCut(doc: Document): void {
  pendingCuts.delete(doc);
  doc.querySelectorAll<HTMLElement>(".mlrt-table-cut-source-pending")
    .forEach((wrapper) => wrapper.classList.remove("mlrt-table-cut-source-pending"));
  doc.querySelectorAll<HTMLElement>(".mlrt-table-cut-source")
    .forEach((cell) =>
      cell.classList.remove(
        "mlrt-table-cut-source",
        "mlrt-table-cut-source-top",
        "mlrt-table-cut-source-right",
        "mlrt-table-cut-source-bottom",
        "mlrt-table-cut-source-left",
      ),
    );
}
