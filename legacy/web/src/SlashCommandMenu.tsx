import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowDown, ArrowUp, CornerDownLeft, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { DialogSurface } from "./ModalSurface.tsx";
import { remapOptionNavigationKey } from "./optionNavigation.ts";
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
  onQueryChange,
  onChoose,
  onDismiss,
  onRemoveTrigger,
  onInsertNewline,
}: {
  readonly commands: ReadonlyArray<SlashCommandItem>;
  readonly query: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly onQueryChange: (query: string) => void;
  readonly onChoose: (command: SlashCommandItem) => void;
  readonly onDismiss: () => void;
  readonly onRemoveTrigger: () => void;
  readonly onInsertNewline: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const selectingRef = useRef(false);
  const [highlighted, setHighlighted] = useState<SlashCommandItem>();
  const choose = (command: SlashCommandItem) => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    onChoose(command);
  };

  return <DialogSurface
    className="slash-command-menu"
    backdropClassName="slash-command-backdrop"
    viewportClassName="slash-command-layer"
    initialFocus={searchRef}
    finalFocus={false}
    onClose={onDismiss}
  >
          <header>
            <div><span>RUNTIME CATALOG</span><Dialog.Title render={<b />}>Pi commands</Dialog.Title></div>
            <Dialog.Close aria-label="Close Pi commands"><X aria-hidden="true" /></Dialog.Close>
          </header>
          <Combobox.Root
            items={commands}
            filteredItems={commands}
            inputValue={query}
            onItemHighlighted={setHighlighted}
            onValueChange={(command) => { if (command) choose(command); }}
            itemToStringLabel={(command: SlashCommandItem) => command.name}
            inline
            open
            autoHighlight
          >
            <label className="slash-command-search">
              <Search aria-hidden="true" />
              <span aria-hidden="true">/</span>
              <Combobox.Input
                ref={searchRef}
                aria-label="Filter Pi commands"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Type a command name"
                onInput={(event) => {
                  if (!selectingRef.current && event.nativeEvent.isTrusted) onQueryChange(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || remapOptionNavigationKey(event)) return;
                  if (event.key === "Enter" && event.shiftKey) {
                    event.preventDefault();
                    onInsertNewline();
                  } else if (event.key === "Backspace" && query.length === 0) {
                    event.preventDefault();
                    onRemoveTrigger();
                  } else if ((highlighted ?? commands[0]) && (event.key === "Enter" || event.key === "Tab" && !event.shiftKey || event.key === " ")) {
                    event.preventDefault();
                    choose(highlighted ?? commands[0]!);
                  }
                }}
              />
              <small>{loading ? "…" : commands.length}</small>
            </label>
            <Combobox.List className="slash-command-results" aria-label="Pi commands">
              <Combobox.Status className="slash-command-status">
                {loading && <div className="slash-command-state"><i className="loading" />Reading this runtime’s commands…</div>}
                {!loading && error && <div className="slash-command-state error">{error}</div>}
                {!loading && !error && commands.length === 0 && <div className="slash-command-state">No matching commands in this runtime</div>}
              </Combobox.Status>
              {!loading && commands.map((command, index) => <Combobox.Item
                className={`slash-command-option source-${command.source}`}
                index={index}
                key={`${command.source}:${command.name}`}
                value={command}
                nativeButton
                render={<button type="button" />}
              >
                <span className="slash-command-mark" aria-hidden="true">/</span>
                <span className="slash-command-copy"><b>{command.name}</b><small>{command.description || "No description provided"}</small></span>
                <span className="slash-command-meta"><em>{SOURCE_LABELS[command.source]}</em>{command.scope && <small>{command.scope}</small>}</span>
              </Combobox.Item>)}
            </Combobox.List>
          </Combobox.Root>
          <footer className="slash-command-footer"><span><kbd><ArrowUp aria-hidden="true" /><ArrowDown aria-hidden="true" /></kbd><kbd>C-N</kbd><kbd>C-P</kbd> move</span><span><kbd><CornerDownLeft aria-hidden="true" /></kbd> insert command</span><span><kbd>esc</kbd> close</span></footer>
  </DialogSurface>;
}
