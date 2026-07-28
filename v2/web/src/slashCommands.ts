import type { PiSlashCommand } from "../../shared/domain.ts";
import { fuzzySubsequenceMatcher } from "./picker.ts";

export type ActiveSlashCommand = {
  readonly query: string;
  readonly end: number;
};

export function activeSlashCommand(text: string, cursor: number): ActiveSlashCommand | undefined {
  if (!text.startsWith("/") || cursor < 1) return;
  const tokenEnd = text.search(/\s/u);
  const end = tokenEnd < 0 ? text.length : tokenEnd;
  if (cursor > end) return;
  return { query: text.slice(1, cursor), end };
}

export function applySlashCommand(text: string, active: ActiveSlashCommand, name: string): {
  readonly text: string;
  readonly cursor: number;
} {
  const value = `/${name}`;
  const suffix = text.slice(active.end);
  const separator = suffix.length === 0 ? " " : "";
  return {
    text: `${value}${separator}${suffix}`,
    cursor: value.length + separator.length,
  };
}

export function filterSlashCommands(
  commands: ReadonlyArray<PiSlashCommand>,
  query: string,
): ReadonlyArray<PiSlashCommand> {
  const normalized = query.trim();
  if (!normalized) return commands;
  return commands.flatMap((command, index) => {
    const nameScore = fuzzySubsequenceMatcher(normalized, command.name);
    const descriptionScore = command.description ? fuzzySubsequenceMatcher(normalized, command.description) : undefined;
    const score = Math.max(nameScore ?? -1, descriptionScore === undefined ? -1 : descriptionScore * 0.35);
    return score < 0 ? [] : [{ command, score, index }];
  }).sort((left, right) => right.score - left.score || left.index - right.index).map(({ command }) => command);
}

export function isSlashCommandInput(text: string): boolean {
  return /^\/[^\s/]+(?:\s|$)/u.test(text.trim());
}
