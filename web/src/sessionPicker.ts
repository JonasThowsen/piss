import type { OwnedSessionSummary } from "../../shared/domain.ts";
import { ATTENTION_STATE_LABELS } from "../../shared/sessionState.ts";
import type { SessionOpenHistory } from "./lastOpenedSession.ts";
import type { PickerItem } from "./picker.ts";

export type SelectSessionAction = {
  readonly _tag: "SelectSession";
  readonly sessionId: string;
};

type SessionPickerSession = {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly branch: string | null;
  readonly status: OwnedSessionSummary["status"];
};
type SessionPickerWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
};

const STATUS_ORDER: Readonly<Record<OwnedSessionSummary["status"], number>> = {
  blocked: 0,
  finished: 0,
  crashed: 0,
  starting: 1,
  working: 1,
  stopping: 1,
  idle: 2,
  stopped: 2,
};

export function sessionPickerItems(
  sessions: ReadonlyArray<SessionPickerSession>,
  workspaces: ReadonlyArray<SessionPickerWorkspace>,
  openedAtBySession: SessionOpenHistory = {},
): ReadonlyArray<PickerItem<SelectSessionAction>> {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));
  const orderedSessions = [...sessions].sort((left, right) => {
    const leftWorkspace = workspaceById.get(left.workspaceId)?.name ?? "Unknown workspace";
    const rightWorkspace = workspaceById.get(right.workspaceId)?.name ?? "Unknown workspace";
    return STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
      || leftWorkspace.localeCompare(rightWorkspace)
      || (openedAtBySession[right.id] ?? 0) - (openedAtBySession[left.id] ?? 0)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id);
  });

  return orderedSessions.map((session, index) => {
    const workspace = workspaceById.get(session.workspaceId);
    const workspaceName = workspace?.name ?? "Unknown workspace";
    const status = ATTENTION_STATE_LABELS[session.status];
    const branch = session.branch ?? "";
    return {
      id: `session:${session.id}`,
      label: session.name,
      description: branch ? `${workspaceName} · ${branch}` : workspaceName,
      meta: status,
      searchFields: [
        { text: session.name },
        { text: workspaceName, weight: 0.82 },
        { text: workspace?.root ?? "", weight: 0.48 },
        { text: branch, weight: 0.72 },
        { text: status, weight: 0.45 },
      ],
      priority: orderedSessions.length - index,
      action: { _tag: "SelectSession", sessionId: session.id },
    };
  });
}
