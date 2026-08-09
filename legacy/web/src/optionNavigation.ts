import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type OptionNavigationDirection = -1 | 1;

type NavigationKeyEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function controlNavigationDirection(event: NavigationKeyEvent): OptionNavigationDirection | undefined {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return undefined;
  const key = event.key.toLocaleLowerCase();
  return key === "n" ? 1 : key === "p" ? -1 : undefined;
}

export function optionNavigationDirection(event: NavigationKeyEvent): OptionNavigationDirection | undefined {
  if (event.key === "ArrowDown") return 1;
  if (event.key === "ArrowUp") return -1;
  return controlNavigationDirection(event);
}

export function remapOptionNavigationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  const direction = optionNavigationDirection(event);
  if (direction === undefined || event.key === "ArrowDown" || event.key === "ArrowUp") return false;
  event.preventDefault();
  event.currentTarget.dispatchEvent(new KeyboardEvent("keydown", {
    key: direction === 1 ? "ArrowDown" : "ArrowUp",
    bubbles: true,
    cancelable: true,
  }));
  return true;
}

export function nextOptionIndex(current: number, count: number, direction: OptionNavigationDirection): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

export function scrollOptionIntoView(option: string | HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    const element = typeof option === "string" ? document.getElementById(option) : option;
    element?.scrollIntoView({ block: "nearest" });
  });
}
