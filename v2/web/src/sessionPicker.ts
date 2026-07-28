import type { OwnedSessionSummary } from "../../shared/domain.ts";
import { ATTENTION_STATE_LABELS } from "../../shared/sessionState.ts";
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
  readonly lastActivityAt: string;
};
type SessionPickerWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly root: string;
};

export function sessionPickerItems(
  sessions: ReadonlyArray<SessionPickerSession>,
  workspaces: ReadonlyArray<SessionPickerWorkspace>,
): ReadonlyArray<PickerItem<SelectSessionAction>> {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const));

  return sessions.map((session) => {
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
      priority: Number.isFinite(Date.parse(session.lastActivityAt)) ? Date.parse(session.lastActivityAt) : 0,
      action: { _tag: "SelectSession", sessionId: session.id },
    };
  });
}
