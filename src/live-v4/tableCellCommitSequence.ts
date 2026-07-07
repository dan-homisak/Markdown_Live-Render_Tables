import { Annotation } from "@codemirror/state";

export interface TableCellCommitSequence {
  steps: TableCellCommitStep[];
}

export interface TableCellCommitStep {
  change: {
    from: number;
    to: number;
    text: string;
  };
  restore: TableCellCommitRestore;
}

export interface TableCellCommitRestore {
  tableFrom: number;
  rowKind: string;
  rowIndex: number;
  column: number;
  from: number;
  to: number;
  restoreCaretOffset: number;
}

export const tableCellCommitSequence =
  Annotation.define<TableCellCommitSequence>();

export const tableCellLiveEdit = Annotation.define<TableCellCommitStep>();
