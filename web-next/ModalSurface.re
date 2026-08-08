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

let backdrop = [%cx {|
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  width: 100%;
  height: 100vh;
  display: grid;
  place-items: center;
  padding: 22px;
  background: rgba(28, 31, 28, 0.5);
  @media (max-width: 760px) {
    padding: 12px;
  }
|}];

let popup = [%cx {|
  position: relative;
  width: min(580px, 100%);
  max-height: min(760px, calc(100vh - 44px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 18px 48px 0 #181c1820;
  overflow: hidden;
  @media (max-width: 760px) {
    width: 100%;
    max-height: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
|}];

let header = [%cx {|
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  flex: none;
  @media (max-width: 760px) {
    padding: 10px 14px;
    gap: 10px;
  }
|}];

let body = [%cx {|
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: grid;
  gap: 10px;
  align-content: start;
  @media (max-width: 760px) {
    padding: 12px 14px;
    gap: 8px;
  }
|}];

let footer = [%cx {|
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--surface);
  flex: none;
  @media (max-width: 760px) {
    padding: 10px 14px;
  }
|}];

let closeButton = [%cx {|
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  flex: none;
  &:hover:not(:disabled) {
    background: var(--soft);
    color: var(--text);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  @media (max-width: 760px) {
    width: 44px;
    height: 44px;
  }
|}];

let headerLabel = [%cx {|
  color: var(--accent);
  font-weight: 700;
  font-size: 9px;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
|}];

let headerTitle = [%cx {|
  margin: 2px 0 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.15;
  @media (max-width: 760px) {
    font-size: 19px;
  }
|}];

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
let make = (
  ~onClose: unit => unit,
  ~className: string="",
  ~ariaLabel: string,
  ~modifier: modifier=Default,
  ~children: React.element,
) => {
  let popupClass =
    popup ++ " modal-popup" ++ (className == "" ? "" : " " ++ className);
  let handleKeyDown = event => {
    if (isEscapeKey(event)) {
      preventDefault(event);
      onClose();
    };
  };
  /* The dynamic-viewport-height units (`dvh`) and CSS custom properties
   * are not accepted by the styled-ppx 0.61.0 ppx parser, so we have
   * to size the backdrop against `--app-height` via inline styles.
   * `watchVisibleViewport` keeps that custom property in sync with
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
    ReactDOM.Style.make(
      ~maxHeight="var(--app-height, 100dvh)",
      (),
    );
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
  let make = (
    ~title: string,
    ~onClose: unit => unit,
    ~label: string="",
  ) => {
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
        {React.string("\u00D7")}
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

