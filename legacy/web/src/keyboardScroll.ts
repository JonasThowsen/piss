import { useEffect, useRef, type RefObject } from "react";
import { controlNavigationDirection, type OptionNavigationDirection } from "./optionNavigation.ts";

type KeyboardScrollEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

const SCROLL_SELECTOR = "[data-keyboard-scroll]";
const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll"]);

export function keyboardScrollDirection(event: KeyboardScrollEvent): OptionNavigationDirection | undefined {
  return controlNavigationDirection(event);
}

export function keyboardScrollAmount(clientHeight: number): number {
  return Math.max(48, Math.min(320, Math.round(clientHeight * 0.33)));
}

function isScrollSurface(element: HTMLElement): boolean {
  const explicitlyScrollable = element.matches(SCROLL_SELECTOR);
  const overflowScrollable = SCROLLABLE_OVERFLOW.has(window.getComputedStyle(element).overflowY);
  return explicitlyScrollable || (overflowScrollable && element.scrollHeight > element.clientHeight + 1);
}

function canScroll(element: HTMLElement, direction: OptionNavigationDirection): boolean {
  if (!isScrollSurface(element)) return false;
  if (direction < 0) return element.scrollTop > 0;
  return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
}

function scrollableAncestors(target: HTMLElement): ReadonlyArray<HTMLElement> {
  const results: HTMLElement[] = [];
  let current: HTMLElement | null = target;
  while (current) {
    if (isScrollSurface(current)) results.push(current);
    current = current.parentElement;
  }
  return results;
}

function scrollTarget(
  target: HTMLElement,
  direction: OptionNavigationDirection,
  fallback: HTMLElement | null,
): HTMLElement | undefined {
  const ancestors = scrollableAncestors(target);
  const advancingAncestor = ancestors.find((element) => canScroll(element, direction));
  if (advancingAncestor) return advancingAncestor;

  const dialog = target.closest<HTMLElement>("[role='dialog'], [role='alertdialog']");
  if (dialog) {
    const surfaces = Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter(isScrollSurface);
    return surfaces.find((element) => canScroll(element, direction)) ?? ancestors[0] ?? surfaces[0] ?? dialog;
  }

  if (fallback && isScrollSurface(fallback)) return fallback;
  return ancestors[0];
}

export function useSharedKeyboardScrolling(
  fallbackRef: RefObject<HTMLElement | null>,
  onBeforeScroll?: (element: HTMLElement, direction: OptionNavigationDirection) => void,
): void {
  const beforeScrollRef = useRef(onBeforeScroll);
  beforeScrollRef.current = onBeforeScroll;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const direction = keyboardScrollDirection(event);
      if (direction === undefined || !(event.target instanceof HTMLElement)) return;
      const element = scrollTarget(event.target, direction, fallbackRef.current);
      if (!element) return;

      event.preventDefault();
      beforeScrollRef.current?.(element, direction);
      element.scrollTop += direction * keyboardScrollAmount(element.clientHeight);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [fallbackRef]);
}
