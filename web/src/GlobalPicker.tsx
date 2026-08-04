import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowDown, ArrowUp, CornerDownLeft, ExternalLink, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { DialogSurface } from "./ModalSurface.tsx";
import { remapOptionNavigationKey, scrollOptionIntoView } from "./optionNavigation.ts";
import { searchPickerItems, type PickerItem, type PickerMatcher } from "./picker.ts";

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
  finalFocus,
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
  readonly finalFocus: () => HTMLElement | null;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<PickerItem<Action>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const matches = useMemo(() => searchPickerItems(items, query, matcher).slice(0, 50).map(({ item }) => item), [items, matcher, query]);

  return <DialogSurface
    className="global-picker"
    backdropClassName="global-picker-backdrop"
    viewportClassName="global-picker-layer"
    initialFocus={inputRef}
    finalFocus={finalFocus}
    onClose={onClose}
  >
          <header>
            <div><span>GO TO</span><Dialog.Title render={<b />}>{title}</Dialog.Title></div>
            <Dialog.Close aria-label={`Close ${title.toLocaleLowerCase()} picker`}><X aria-hidden="true" /></Dialog.Close>
          </header>
          <Combobox.Root
            items={matches}
            filteredItems={matches}
            inputValue={query}
            onOpenChange={(open) => { if (!open) onClose(); }}
            onInputValueChange={(value, details) => {
              if (details.event instanceof InputEvent && details.event.inputType) {
                setHighlighted(undefined);
                setQuery(value);
              }
            }}
            onItemHighlighted={(item) => {
              setHighlighted(item);
              const index = item ? matches.indexOf(item) : -1;
              if (index >= 0) scrollOptionIntoView(optionRefs.current[index] ?? null);
            }}
            onValueChange={(item) => { if (item) onChoose(item.action); }}
            itemToStringLabel={(item: PickerItem<Action>) => item.label}
            inline
            open
            autoHighlight
          >
            <label className="global-picker-search">
              <Search aria-hidden="true" />
              <span className="sr-only">{searchLabel}</span>
              <Combobox.Input
                ref={inputRef}
                aria-label={searchLabel}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                onKeyDownCapture={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                  } else if (event.key === "Enter" && matches.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    onChoose((highlighted && matches.includes(highlighted) ? highlighted : matches[0]!).action);
                  }
                }}
                onKeyDown={remapOptionNavigationKey}
              />
              <kbd>ESC</kbd>
            </label>
            <Combobox.List className="global-picker-results" aria-label={title}>
              {matches.length === 0 && <div className="global-picker-empty"><i aria-hidden="true"><Search /></i><b>{items.length === 0 ? noItemsLabel : emptyLabel}</b><span>{items.length === 0 ? noItemsHint : emptyHint}</span></div>}
              {matches.map((item, index) => <Combobox.Item
                className="global-picker-option"
                key={item.id}
                ref={(element) => { optionRefs.current[index] = element; }}
                value={item}
                index={index}
              >
                <span className="global-picker-glyph" aria-hidden="true"><ExternalLink /></span>
                <span className="global-picker-copy"><b>{item.label}</b>{item.description && <small>{item.description}</small>}</span>
                {item.meta && <em>{item.meta}</em>}
              </Combobox.Item>)}
            </Combobox.List>
          </Combobox.Root>
          <footer><span><kbd aria-label="Up Arrow"><ArrowUp aria-hidden="true" /></kbd><kbd aria-label="Down Arrow"><ArrowDown aria-hidden="true" /></kbd><kbd>C-N</kbd><kbd>C-P</kbd> MOVE</span><span><kbd aria-label="Enter"><CornerDownLeft aria-hidden="true" /></kbd> OPEN</span><b>{matches.length} / {items.length}</b></footer>
  </DialogSurface>;
}
