import type { GptSessionSummary } from "../../shared/gpt-sessions";

/**
 * Returns the display priority for a worker tab; lower numbers sort earlier.
 * Priorities are urgent input (0), active (1), unread result (2), idle (3),
 * and inactive or otherwise unrecognized states (4).
 */
export function getWorkerPriority(worker: GptSessionSummary): number {
  const isActive = worker.status === "running" || worker.status === "starting";

  if (worker.status === "waiting_input" || (worker.pendingQuestionCount ?? 0) > 0) return 0;
  if (isActive) return 1;
  if (Boolean(worker.hasUnreadReply) && !isActive) return 2;
  if (worker.status === "idle") return 3;
  return 4;
}

/**
 * Sorts workers by urgency, then most recently updated, then name and ID.
 * A new array is returned so the caller's worker list is never mutated.
 */
export function sortWorkerTabs(workers: readonly GptSessionSummary[]): GptSessionSummary[] {
  return [...workers].sort((a, b) => {
    const priorityDifference = getWorkerPriority(a) - getWorkerPriority(b);
    if (priorityDifference !== 0) return priorityDifference;

    const updateDifference = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (updateDifference !== 0) return updateDifference;

    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/**
 * Removes worker tabs dismissed in the current session without filtering workers
 * merely because their backend status is `closed`.
 */
export function filterClosedWorkerTabs(
  workers: readonly GptSessionSummary[],
  closedTabIds: ReadonlySet<string>,
): GptSessionSummary[] {
  return workers.filter((worker) => !closedTabIds.has(worker.id));
}
