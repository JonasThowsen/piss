import { ArrowDown, ArrowUp, CornerDownLeft } from "lucide-react";
import type { PiSlashCommand } from "../../shared/domain.ts";

const SOURCE_LABELS: Readonly<Record<PiSlashCommand["source"], string>> = {
  extension: "EXTENSION",
  prompt: "PROMPT",
  skill: "SKILL",
};

export function SlashCommandMenu({
  commands,
  loading,
  error,
  highlighted,
  onChoose,
  onHighlight,
}: {
  readonly commands: ReadonlyArray<PiSlashCommand>;
  readonly loading: boolean;
  readonly error?: string;
  readonly highlighted: number;
  readonly onChoose: (command: PiSlashCommand) => void;
  readonly onHighlight: (index: number) => void;
}) {
  const hasOptions = commands.length > 0;
  return <section
    className="slash-command-menu"
    id="pi-command-options"
    role={hasOptions ? "listbox" : "status"}
    aria-label={hasOptions ? "Pi commands" : undefined}
    aria-live={hasOptions ? undefined : "polite"}
  >
    <header><span><i aria-hidden="true">/</i><b>PI COMMANDS</b></span><small><kbd aria-label="Up Arrow"><ArrowUp aria-hidden="true" /></kbd><kbd aria-label="Down Arrow"><ArrowDown aria-hidden="true" /></kbd> PICK <kbd aria-label="Enter"><CornerDownLeft aria-hidden="true" /></kbd> INSERT</small></header>
    <div className="slash-command-results">
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
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => onHighlight(index)}
        onClick={() => onChoose(command)}
      >
        <span className="slash-command-mark" aria-hidden="true">/</span>
        <span className="slash-command-copy"><b>{command.name}</b><small>{command.description || "No description provided"}</small></span>
        <span className="slash-command-meta"><em>{SOURCE_LABELS[command.source]}</em>{command.scope && <small>{command.scope}</small>}</span>
      </button>)}
    </div>
  </section>;
}
