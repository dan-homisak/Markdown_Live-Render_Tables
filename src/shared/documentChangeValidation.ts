/**
 * A source change expressed as offsets into one exact document snapshot.
 */
export interface ValidatedDocumentChange {
  from: number;
  to: number;
  text: string;
}

interface DocumentChangeClaimBase {
  /** Document snapshot against which the first change range was calculated. */
  beforeText: string;
  /** Exact document text the sender claims the change(s) produce. */
  finalText: string;
}

/**
 * One simultaneous change list. Every range is measured against `beforeText`.
 */
export interface SimultaneousDocumentChangeClaim
  extends DocumentChangeClaimBase {
  changes: readonly ValidatedDocumentChange[];
  changeGroups?: never;
}

/**
 * Sequential change groups. Ranges in each group are measured against the
 * result of the preceding group, while changes inside one group are
 * simultaneous.
 */
export interface SequentialDocumentChangeClaim extends DocumentChangeClaimBase {
  changeGroups: readonly (readonly ValidatedDocumentChange[])[];
  changes?: never;
}

export type DocumentChangeClaim =
  | SimultaneousDocumentChangeClaim
  | SequentialDocumentChangeClaim;

export type DocumentChangeValidationFailureCode =
  | "invalid-claim"
  | "before-text-mismatch"
  | "invalid-change"
  | "out-of-range"
  | "unsorted-changes"
  | "overlapping-changes"
  | "final-text-mismatch";

export interface DocumentChangeValidationSuccess {
  ok: true;
  finalText: string;
  mode: "simultaneous" | "sequential";
  changeCount: number;
}

export interface DocumentChangeValidationFailure {
  ok: false;
  code: DocumentChangeValidationFailureCode;
  groupIndex?: number;
  changeIndex?: number;
}

export type DocumentChangeValidationResult =
  | DocumentChangeValidationSuccess
  | DocumentChangeValidationFailure;

interface GroupApplicationSuccess {
  ok: true;
  text: string;
}

type GroupApplicationResult =
  | GroupApplicationSuccess
  | DocumentChangeValidationFailure;

/**
 * Validates and replays a document change claim without mutating external
 * state.
 *
 * `authoritativeBeforeText` must be the document text at the moment the caller
 * is about to apply the claim. Comparing it with `claim.beforeText` prevents a
 * once-valid offset list from being spliced into a document that changed while
 * the message was queued.
 *
 * A successful result proves all of the following:
 *
 * - the claim selected exactly one change mode,
 * - every range is an integer range inside the snapshot it targets,
 * - simultaneous ranges are sorted, non-overlapping, and unambiguous,
 * - replaying every change produces `claim.finalText` exactly.
 */
export function validateDocumentChangeClaim(
  authoritativeBeforeText: string,
  claim: DocumentChangeClaim,
): DocumentChangeValidationResult {
  if (!isRecord(claim)) {
    return failure("invalid-claim");
  }

  const beforeText = claim.beforeText;
  const finalText = claim.finalText;
  if (typeof beforeText !== "string" || typeof finalText !== "string") {
    return failure("invalid-claim");
  }
  if (beforeText !== authoritativeBeforeText) {
    return failure("before-text-mismatch");
  }

  const candidate = claim as unknown as Record<string, unknown>;
  const hasChanges = Array.isArray(candidate.changes);
  const hasChangeGroups = Array.isArray(candidate.changeGroups);
  if (hasChanges === hasChangeGroups) {
    return failure("invalid-claim");
  }

  if (hasChanges) {
    const changes = candidate.changes as unknown[];
    const applied = applySimultaneousChangeGroup(beforeText, changes, 0);
    if (!applied.ok) {
      return applied;
    }
    if (applied.text !== finalText) {
      return failure("final-text-mismatch");
    }
    return {
      ok: true,
      finalText: applied.text,
      mode: "simultaneous",
      changeCount: changes.length,
    };
  }

  const groups = candidate.changeGroups as unknown[];
  let currentText = beforeText;
  let changeCount = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!Array.isArray(group)) {
      return failure("invalid-claim", groupIndex);
    }
    const applied = applySimultaneousChangeGroup(
      currentText,
      group,
      groupIndex,
    );
    if (!applied.ok) {
      return applied;
    }
    currentText = applied.text;
    changeCount += group.length;
  }

  if (currentText !== finalText) {
    return failure("final-text-mismatch");
  }
  return {
    ok: true,
    finalText: currentText,
    mode: "sequential",
    changeCount,
  };
}

function applySimultaneousChangeGroup(
  source: string,
  changes: readonly unknown[],
  groupIndex: number,
): GroupApplicationResult {
  const parts: string[] = [];
  let sourceCursor = 0;
  let previous: ValidatedDocumentChange | null = null;

  for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
    const candidate = changes[changeIndex];
    if (!isDocumentChange(candidate)) {
      return failure("invalid-change", groupIndex, changeIndex);
    }
    const change = candidate;
    if (change.from < 0 || change.to < change.from || change.to > source.length) {
      return failure("out-of-range", groupIndex, changeIndex);
    }

    if (previous) {
      if (change.from < previous.from) {
        return failure("unsorted-changes", groupIndex, changeIndex);
      }

      // Equal starts are ambiguous whenever either edit inserts at a point;
      // ordinary replacement ranges with equal starts overlap via the second
      // condition. Rejecting the whole case avoids relying on host-specific
      // ordering for two edits at the same source position.
      if (
        change.from === previous.from ||
        change.from < previous.to
      ) {
        return failure("overlapping-changes", groupIndex, changeIndex);
      }
    }

    parts.push(source.slice(sourceCursor, change.from), change.text);
    sourceCursor = change.to;
    previous = change;
  }

  parts.push(source.slice(sourceCursor));
  return { ok: true, text: parts.join("") };
}

function isDocumentChange(value: unknown): value is ValidatedDocumentChange {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isInteger(value.from) &&
    Number.isInteger(value.to) &&
    typeof value.text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function failure(
  code: DocumentChangeValidationFailureCode,
  groupIndex?: number,
  changeIndex?: number,
): DocumentChangeValidationFailure {
  return {
    ok: false,
    code,
    ...(groupIndex === undefined ? {} : { groupIndex }),
    ...(changeIndex === undefined ? {} : { changeIndex }),
  };
}
