export type StoredDraft = {
  readonly text: string;
  readonly delivery: "steer" | "followUp";
  readonly updatedAt: number;
};

const DRAFT_PREFIX = "piss:v2:draft:";
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_DRAFT_LENGTH = 512 * 1024;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type EnumerableDraftStorage = DraftStorage & Pick<Storage, "key" | "length">;

export function draftStorageKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

export function readDraft(sessionId: string, storage: DraftStorage = localStorage): StoredDraft | undefined {
  const key = draftStorageKey(sessionId);
  try {
    const value = storage.getItem(key);
    if (!value) return;
    const draft = JSON.parse(value) as Partial<StoredDraft>;
    if (typeof draft.text !== "string" || draft.text.length > MAX_DRAFT_LENGTH) {
      storage.removeItem(key);
      return;
    }
    const updatedAt = typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt) ? draft.updatedAt : Date.now();
    if (Date.now() - updatedAt > DRAFT_MAX_AGE) {
      storage.removeItem(key);
      return;
    }
    return {
      text: draft.text,
      delivery: draft.delivery === "followUp" ? "followUp" : "steer",
      updatedAt,
    };
  } catch {
    try { storage.removeItem(key); } catch { /* storage is optional */ }
    return;
  }
}

export function writeDraft(sessionId: string, text: string, delivery: "steer" | "followUp", storage: DraftStorage = localStorage): void {
  try {
    const key = draftStorageKey(sessionId);
    if (!text) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ text: text.slice(0, MAX_DRAFT_LENGTH), delivery, updatedAt: Date.now() } satisfies StoredDraft));
  } catch {
    // Storage may be unavailable or full in private browsing modes.
  }
}

export function removeDraft(sessionId: string, storage: DraftStorage = localStorage): void {
  try { storage.removeItem(draftStorageKey(sessionId)); } catch { /* storage is optional */ }
}

export function pruneDrafts(storage: EnumerableDraftStorage = localStorage): void {
  try {
    const sessionIds: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) sessionIds.push(key.slice(DRAFT_PREFIX.length));
    }
    for (const sessionId of sessionIds) readDraft(sessionId, storage);
  } catch {
    // Storage enumeration can also be denied.
  }
}
