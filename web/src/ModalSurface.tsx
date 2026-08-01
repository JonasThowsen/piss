import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode, RefObject } from "react";

type SharedModalSurfaceProps = {
  readonly className: string;
  readonly backdropClassName?: string;
  readonly viewportClassName?: string;
  readonly pending?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly fallbackFocus?: HTMLElement | null;
  readonly initialFocus?: RefObject<HTMLElement | null> | true | false;
  readonly finalFocus?: false | (() => HTMLElement | null);
  readonly onClose: () => void;
  readonly render?: ReactElement;
  readonly children: ReactNode;
};

function classes(base: string, additional?: string): string {
  return additional ? `${base} ${additional}` : base;
}

function focusAfterModal(returnFocus?: HTMLElement | null, fallbackFocus?: HTMLElement | null): HTMLElement | null {
  return returnFocus?.isConnected && !returnFocus.matches(":disabled") ? returnFocus : fallbackFocus?.isConnected ? fallbackFocus : null;
}

export function DialogSurface({
  className,
  backdropClassName = "dialog-backdrop",
  viewportClassName = "dialog-layer",
  pending = false,
  returnFocus,
  fallbackFocus,
  initialFocus = true,
  finalFocus,
  onClose,
  render,
  children,
}: SharedModalSurfaceProps) {
  return <Dialog.Root
    open
    disablePointerDismissal={pending}
    onOpenChange={(open, details) => {
      if (open) return;
      if (pending) { details.cancel(); return; }
      onClose();
    }}
  >
    <Dialog.Portal>
      <Dialog.Backdrop className={classes("modal-backdrop", backdropClassName)} />
      <Dialog.Viewport className={classes("modal-layer", viewportClassName)}>
        <Dialog.Popup
          className={classes("modal-surface", className)}
          initialFocus={initialFocus}
          finalFocus={finalFocus ?? (() => focusAfterModal(returnFocus, fallbackFocus))}
          render={render}
        >{children}</Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function AlertDialogSurface({
  className,
  backdropClassName = "dialog-backdrop",
  viewportClassName = "dialog-layer",
  pending = false,
  returnFocus,
  fallbackFocus,
  initialFocus = true,
  finalFocus,
  onClose,
  render,
  children,
}: SharedModalSurfaceProps) {
  return <AlertDialog.Root
    open
    onOpenChange={(open, details) => {
      if (open) return;
      if (pending) { details.cancel(); return; }
      onClose();
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className={classes("modal-backdrop", backdropClassName)} />
      <AlertDialog.Viewport className={classes("modal-layer", viewportClassName)}>
        <AlertDialog.Popup
          className={classes("modal-surface", className)}
          initialFocus={initialFocus}
          finalFocus={finalFocus ?? (() => focusAfterModal(returnFocus, fallbackFocus))}
          render={render}
        >{children}</AlertDialog.Popup>
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
