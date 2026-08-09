import type { Hotkey } from "@tanstack/react-hotkeys";

/**
 * Product-level shortcut definitions live here instead of in components. This
 * keeps command identity stable if the registration library or defaults change.
 */
export const HOTKEYS = {
  openGlobalPicker: "Mod+K" as Hotkey,
};
