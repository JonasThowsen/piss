/* Reusable modal surface used across the PISS browser shell.
 *
 * Mirrors the role of the TypeScript ModalSurface from the previous Piss
 * app: a fixed-position backdrop that centers a popup with a
 * header / body / footer grid, ESC to dismiss, and C-n / C-p navigation
 * remapped to ArrowDown / ArrowUp so the existing arrow-key handlers in
 * the modal body keep working for terminal users.
 *
 * The popup layout uses `display: grid; grid-template-rows: auto
 * minmax(0, 1fr) auto;` so the body is the only scrolling region. On
 * mobile the popup fills the whole viewport, with the header and footer
 * pinned to the top and bottom respectively so the buttons never move
 * out of reach when the body scrolls.
 */

let backdrop = "modal-surface-backdrop";
let popup = "modal-surface-popup";
let header = "modal-surface-header";
let body = "modal-surface-body";
let footer = "modal-surface-footer";
let closeButton = "modal-surface-close";
let headerLabel = "modal-surface-label";
let headerTitle = "modal-surface-title";

type modifier =
  | Default
  | Alert;

let isEscapeKey: React.Event.Keyboard.t => bool = [%raw
  "event => event.key === 'Escape'"
];

let preventDefault: 'a => unit = [%raw "event => event.preventDefault()"];

let stopEventPropagation: 'a => unit = [%raw
  "event => event.stopPropagation()"
];

/* Translate C-n / C-p key events into ArrowDown / ArrowUp so that
 * the existing arrow-key handlers in the modal body keep working
 * for terminal users. The dispatched event is synthetic, so it
 * does not recurse into the same remapper. */
let remapControlNavigation: React.Event.Keyboard.t => bool = [%raw
  {|event => {
    if (event.altKey || event.metaKey || event.shiftKey) return false;
    if (!event.ctrlKey || event.isComposing) return false;
    const key = (event.key || '').toLocaleLowerCase();
    if (key !== 'n' && key !== 'p') return false;
    event.preventDefault();
    const direction = key === 'n' ? 'ArrowDown' : 'ArrowUp';
    const target = event.currentTarget;
    if (target && typeof target.dispatchEvent === 'function') {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: direction,
        bubbles: true,
        cancelable: true,
      }));
    }
    return true;
  }|}
];

[@react.component]
let make =
    (
      ~onClose: unit => unit,
      ~className: string="",
      ~ariaLabel: string,
      ~modifier: modifier=Default,
      ~children: React.element,
    ) => {
  let popupClass =
    popup ++ " modal-popup" ++ (className == "" ? "" : " " ++ className);
  let handleKeyDown = event =>
    if (isEscapeKey(event)) {
      preventDefault(event);
      onClose();
    };
  /* `watchVisibleViewport` keeps `--app-height` in sync with
   * `window.visualViewport.height`, which shrinks when the soft
   * keyboard opens, so the modal resizes with the keyboard instead of
   * shifting its content out of view. The popup keeps its CSS-driven
   * max-height; the inline `maxHeight` only constrains it so it can
   * never exceed the available viewport when the keyboard is open. */
  let backdropStyle =
    ReactDOM.Style.make(
      ~height="var(--app-height, 100dvh)",
      ~maxHeight="var(--app-height, 100dvh)",
      (),
    );
  let popupStyle =
    ReactDOM.Style.make(~maxHeight="var(--app-height, 100dvh)", ());
  <div
    className=backdrop
    style=backdropStyle
    onClick={_ => onClose()}
    onKeyDown=handleKeyDown
    tabIndex=(-1)
    role="presentation">
    <section
      className=popupClass
      style=popupStyle
      role={modifier == Alert ? "alertdialog" : "dialog"}
      ariaModal=true
      ariaLabel
      onClick={event => stopEventPropagation(event)}>
      children
    </section>
  </div>;
};

module Header = {
  [@react.component]
  let make = (~title: string, ~onClose: unit => unit, ~label: string="") => {
    <header className=header>
      <div>
        {label == ""
           ? React.null
           : <span className=headerLabel> {React.string(label)} </span>}
        <h2 className=headerTitle> {React.string(title)} </h2>
      </div>
      <button
        type_="button"
        className=closeButton
        ariaLabel="Close dialog"
        onClick={_ => onClose()}>
        {React.string(Js.String.fromCodePoint(0x00D7))}
      </button>
    </header>;
  };
};

module Body = {
  [@react.component]
  let make = (~children: React.element) => {
    <div className=body> children </div>;
  };
};

module Footer = {
  [@react.component]
  let make = (~children: React.element) => {
    <footer className=footer> children </footer>;
  };
};
