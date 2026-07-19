export type StoredDraft = { text: string; delivery: "steer" | "followUp"; updatedAt: number };

const DRAFT_PREFIX = "piss:draft:";
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function readDraft(sessionId: string): StoredDraft | undefined {
  try {
    const value = localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`);
    if (!value) return;
    const draft = JSON.parse(value) as Partial<StoredDraft>;
    if (typeof draft.text !== "string") return;
    const updatedAt = typeof draft.updatedAt === "number" ? draft.updatedAt : Date.now();
    if (Date.now() - updatedAt > DRAFT_MAX_AGE) {
      localStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`);
      return;
    }
    return {
      text: draft.text,
      delivery: draft.delivery === "followUp" ? "followUp" : "steer",
      updatedAt,
    };
  } catch {
    return;
  }
}

export function writeDraft(sessionId: string, text: string, delivery: "steer" | "followUp") {
  try {
    const key = `${DRAFT_PREFIX}${sessionId}`;
    if (!text) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ text, delivery, updatedAt: Date.now() } satisfies StoredDraft));
  } catch {
    // Storage can be unavailable in strict private-browsing configurations.
  }
}
