import { ArrowDown, ArrowUp, CornerDownLeft, Search, X } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SlashCommandItem } from "./slashCommands.ts";

const SOURCE_LABELS: Readonly<Record<SlashCommandItem["source"], string>> = {
  builtin: "BUILT-IN",
  extension: "EXTENSION",
  prompt: "PROMPT",
  skill: "SKILL",
};

export function SlashCommandMenu({
  commands,
  query,
  loading,
  error,
  highlighted,
  pickerRef,
  onQueryChange,
  onChoose,
  onHighlight,
  onNavigate,
  onDismiss,
  onRemoveTrigger,
}: {
  readonly commands: ReadonlyArray<SlashCommandItem>;
  readonly query: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly highlighted: number;
  readonly pickerRef: RefObject<HTMLElement | null>;
  readonly onQueryChange: (query: string) => void;
  readonly onChoose: (command: SlashCommandItem) => void;
  readonly onHighlight: (index: number) => void;
  readonly onNavigate: (direction: 1 | -1) => void;
  readonly onDismiss: () => void;
  readonly onRemoveTrigger: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const hasOptions = commands.length > 0;
  const selected = commands[highlighted];

  useEffect(() => {
    window.requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.setSelectionRange(query.length, query.length);
    });
  }, []);

  return createPortal(<div
    className="slash-command-layer"
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onDismiss();
    }}
  >
    <section className="slash-command-menu" ref={pickerRef} role="dialog" aria-modal="true" aria-label="Pi commands">
      <header>
        <div><span>RUNTIME CATALOG</span><b>Pi commands</b></div>
        <button type="button" onClick={onDismiss} aria-label="Close Pi commands"><X aria-hidden="true" /></button>
      </header>
      <label className="slash-command-search">
        <Search aria-hidden="true" />
        <span aria-hidden="true">/</span>
        <input
          ref={searchRef}
          value={query}
          aria-label="Filter Pi commands"
          aria-controls={hasOptions ? "pi-command-options" : undefined}
          aria-activedescendant={selected ? `pi-command-${highlighted}` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Type a command name"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (hasOptions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              onNavigate(event.key === "ArrowDown" ? 1 : -1);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onDismiss();
              return;
            }
            if (event.key === "Backspace" && query.length === 0) {
              event.preventDefault();
              onRemoveTrigger();
              return;
            }
            if (selected && (event.key === "Enter" || event.key === "Tab" && !event.shiftKey || event.key === " ")) {
              event.preventDefault();
              onChoose(selected);
            }
          }}
        />
        <small>{loading ? "…" : commands.length}</small>
      </label>
      <div
        className="slash-command-results"
        id="pi-command-options"
        role={hasOptions ? "listbox" : "status"}
        aria-label={hasOptions ? "Pi commands" : undefined}
        aria-live={hasOptions ? undefined : "polite"}
      >
        {loading && <div className="slash-command-state"><i className="loading" />Reading this runtime’s commands…</div>}
        {!loading && error && <div className="slash-command-state error">{error}</div>}
        {!loading && !error && !hasOptions && <div className="slash-command-state">No matching commands in this runtime</div>}
        {!loading && commands.map((command, index) => <button
          className={`${index === highlighted ? "active" : ""} source-${command.source}`}
          id={`pi-command-${index}`}
          key={`${command.source}:${command.name}`}
          type="button"
          role="option"
          aria-selected={index === highlighted}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onChoose(command)}
        >
          <span className="slash-command-mark" aria-hidden="true">/</span>
          <span className="slash-command-copy"><b>{command.name}</b><small>{command.description || "No description provided"}</small></span>
          <span className="slash-command-meta"><em>{SOURCE_LABELS[command.source]}</em>{command.scope && <small>{command.scope}</small>}</span>
        </button>)}
      </div>
      <footer className="slash-command-footer"><span><kbd><ArrowUp aria-hidden="true" /><ArrowDown aria-hidden="true" /></kbd> move</span><span><kbd><CornerDownLeft aria-hidden="true" /></kbd> insert command</span><span><kbd>esc</kbd> close</span></footer>
    </section>
  </div>, document.body);
}
