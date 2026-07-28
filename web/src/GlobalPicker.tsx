import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { pickerNavigationOffset, searchPickerItems, type PickerItem, type PickerMatcher } from "./picker.ts";

export function GlobalPicker<Action>({
  title,
  items,
  placeholder,
  searchLabel,
  emptyLabel,
  noItemsLabel,
  noItemsHint,
  emptyHint,
  matcher,
  onChoose,
  onClose,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<PickerItem<Action>>;
  readonly placeholder: string;
  readonly searchLabel: string;
  readonly emptyLabel: string;
  readonly noItemsLabel: string;
  readonly noItemsHint: string;
  readonly emptyHint: string;
  readonly matcher?: PickerMatcher;
  readonly onChoose: (action: Action) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const instanceId = useId().replaceAll(":", "");
  const resultsId = `${instanceId}-results`;
  const matches = useMemo(() => searchPickerItems(items, query, matcher).slice(0, 50), [items, matcher, query]);
  const highlightedMatch = matches[highlighted];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (highlighted < matches.length) return;
    setHighlighted(Math.max(0, matches.length - 1));
  }, [highlighted, matches.length]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(`#${instanceId}-option-${highlighted}`)?.scrollIntoView({ block: "nearest" });
  }, [highlighted, instanceId]);

  const choose = (index: number) => {
    const match = matches[index];
    if (match) onChoose(match.item.action);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const navigationOffset = pickerNavigationOffset(event);
    if (matches.length > 0 && navigationOffset !== undefined) {
      event.preventDefault();
      setHighlighted((current) => (current + navigationOffset + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter" && highlightedMatch) {
      event.preventDefault();
      choose(highlighted);
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']), input:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(<div className="global-picker-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="global-picker" role="dialog" aria-modal="true" aria-labelledby={`${instanceId}-title`} ref={dialogRef} onKeyDown={handleKeyDown}>
      <header>
        <div><span>GO TO</span><b id={`${instanceId}-title`}>{title}</b></div>
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLocaleLowerCase()} picker`}>×</button>
      </header>
      <label className="global-picker-search">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg>
        <span className="sr-only">{searchLabel}</span>
        <input
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={resultsId}
          aria-activedescendant={highlightedMatch ? `${instanceId}-option-${highlighted}` : undefined}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <kbd>ESC</kbd>
      </label>
      <div className="global-picker-results" id={resultsId} role={matches.length > 0 ? "listbox" : "status"} aria-label={matches.length > 0 ? title : undefined}>
        {matches.length === 0 && <div className="global-picker-empty"><i>∅</i><b>{items.length === 0 ? noItemsLabel : emptyLabel}</b><span>{items.length === 0 ? noItemsHint : emptyHint}</span></div>}
        {matches.map(({ item }, index) => <button
          className={index === highlighted ? "active" : ""}
          id={`${instanceId}-option-${index}`}
          key={item.id}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={index === highlighted}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHighlighted(index)}
          onClick={() => choose(index)}
        >
          <span className="global-picker-glyph" aria-hidden="true">↗</span>
          <span className="global-picker-copy"><b>{item.label}</b>{item.description && <small>{item.description}</small>}</span>
          {item.meta && <em>{item.meta}</em>}
        </button>)}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd><kbd>C-N</kbd><kbd>C-P</kbd> MOVE</span><span><kbd>↵</kbd> OPEN</span><b>{matches.length} / {items.length}</b></footer>
    </section>
  </div>, document.body);
}
