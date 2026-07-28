import type { PiSlashCommand } from "../../shared/domain.ts";
import { fuzzySubsequenceMatcher } from "./picker.ts";

export type NativeSlashCommandName = "compact" | "model" | "name" | "new" | "resume" | "session";
export type SlashCommandItem = Omit<PiSlashCommand, "source"> & {
  readonly source: PiSlashCommand["source"] | "builtin";
};

export const NATIVE_SLASH_COMMANDS: ReadonlyArray<SlashCommandItem & { readonly name: NativeSlashCommandName }> = [
  { name: "resume", description: "Resume a different session", source: "builtin", scope: null },
  { name: "new", description: "Start a new session in this workspace", source: "builtin", scope: null },
  { name: "model", description: "Select the model and reasoning level", source: "builtin", scope: null },
  { name: "compact", description: "Manually compact the session context", source: "builtin", scope: null },
  { name: "name", description: "Set the session display name", source: "builtin", scope: null },
  { name: "session", description: "Show session information and usage", source: "builtin", scope: null },
];

const NATIVE_COMMAND_NAMES = new Set<NativeSlashCommandName>(NATIVE_SLASH_COMMANDS.map(({ name }) => name));

export function slashCommandCatalog(runtimeCommands: ReadonlyArray<PiSlashCommand>): ReadonlyArray<SlashCommandItem> {
  return [...NATIVE_SLASH_COMMANDS, ...runtimeCommands.filter(({ name }) => !NATIVE_COMMAND_NAMES.has(name as NativeSlashCommandName))];
}

export function nativeSlashCommand(text: string): NativeSlashCommandName | undefined {
  const match = /^\/([^\s/]+)\s*$/u.exec(text.trim());
  const name = match?.[1] as NativeSlashCommandName | undefined;
  return name && NATIVE_COMMAND_NAMES.has(name) ? name : undefined;
}

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
  commands: ReadonlyArray<SlashCommandItem>,
  query: string,
): ReadonlyArray<SlashCommandItem> {
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
