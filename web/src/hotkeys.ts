import type { Hotkey } from "@tanstack/react-hotkeys";

/**
 * Product-level shortcut definitions live here instead of in components. This
 * keeps command identity stable if the registration library or defaults change.
 */
export const HOTKEYS = {
  openGlobalPicker: "Meta+K" as Hotkey,
  pickerNext: ["ArrowDown", "Control+N"] as const satisfies ReadonlyArray<Hotkey>,
  pickerPrevious: ["ArrowUp", "Control+P"] as const satisfies ReadonlyArray<Hotkey>,
};
