export type PickerSearchField = {
  readonly text: string;
  readonly weight?: number;
};

export type PickerItem<Action> = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly meta?: string;
  readonly searchFields: ReadonlyArray<PickerSearchField>;
  readonly priority?: number;
  readonly action: Action;
};

export type PickerMatch<Action> = {
  readonly item: PickerItem<Action>;
  readonly score: number;
};

export type PickerMatcher = (query: string, candidate: string) => number | undefined;

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function isBoundary(value: string, index: number): boolean {
  return index === 0 || /[\s/_.:\-]/.test(value[index - 1] ?? "");
}

/**
 * A small dependency-free matcher for the initial picker tracer. Consumers can
 * inject another PickerMatcher without changing sources or presentation.
 */
export const fuzzySubsequenceMatcher: PickerMatcher = (rawQuery, rawCandidate) => {
  const query = normalize(rawQuery.trim());
  const candidate = normalize(rawCandidate);
  if (!query) return 0;
  if (!candidate) return undefined;
  if (candidate === query) return 10_000;
  if (candidate.startsWith(query)) return 8_000 - Math.min(1_000, candidate.length - query.length);

  const substring = candidate.indexOf(query);
  if (substring >= 0) {
    const boundaryBonus = isBoundary(candidate, substring) ? 600 : 0;
    return 6_000 + boundaryBonus - Math.min(1_000, substring * 8 + candidate.length - query.length);
  }

  let candidateIndex = 0;
  let previousMatch = -2;
  let score = 1_000;
  for (const character of query) {
    const matchIndex = candidate.indexOf(character, candidateIndex);
    if (matchIndex < 0) return undefined;
    if (matchIndex === previousMatch + 1) score += 90;
    if (isBoundary(candidate, matchIndex)) score += 120;
    score -= Math.min(40, matchIndex - candidateIndex);
    previousMatch = matchIndex;
    candidateIndex = matchIndex + 1;
  }
  return score - Math.min(400, candidate.length - query.length);
};

export function searchPickerItems<Action>(
  items: ReadonlyArray<PickerItem<Action>>,
  rawQuery: string,
  matcher: PickerMatcher = fuzzySubsequenceMatcher,
): ReadonlyArray<PickerMatch<Action>> {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
  const ranked = items.flatMap((item, index) => {
    if (tokens.length === 0) return [{ item, score: 0, index }];

    let score = 0;
    for (const token of tokens) {
      let best: number | undefined;
      for (const field of item.searchFields) {
        const fieldScore = matcher(token, field.text);
        if (fieldScore === undefined) continue;
        const weighted = fieldScore * (field.weight ?? 1);
        if (best === undefined || weighted > best) best = weighted;
      }
      if (best === undefined) return [];
      score += best;
    }
    return [{ item, score, index }];
  });

  return ranked.sort((left, right) =>
    right.score - left.score
      || (right.item.priority ?? 0) - (left.item.priority ?? 0)
      || left.index - right.index,
  ).map(({ item, score }) => ({ item, score }));
}

export function pickerNavigationOffset(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): -1 | 1 | undefined {
  if (event.metaKey || event.altKey || event.shiftKey) return undefined;
  if (event.key === "ArrowDown" || event.ctrlKey && event.key.toLocaleLowerCase() === "n") return 1;
  if (event.key === "ArrowUp" || event.ctrlKey && event.key.toLocaleLowerCase() === "p") return -1;
  return undefined;
}
