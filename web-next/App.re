type requestInit;

type timelineItem;
type permissionOption;
type sessionSnapshot;

[@mel.get] external itemId: timelineItem => string = "id";
[@mel.get] external itemRole: timelineItem => string = "role";
[@mel.get] external itemTitle: timelineItem => string = "title";
[@mel.get] external itemText: timelineItem => string = "text";
[@mel.get] external itemStatus: timelineItem => string = "status";
[@mel.get]
external itemOptions: timelineItem => array(permissionOption) = "options";
[@mel.get] external optionId: permissionOption => string = "optionId";
[@mel.get] external optionName: permissionOption => string = "name";
[@mel.get] external snapshotStatus: sessionSnapshot => string = "status";
[@mel.get] external snapshotWorkerPid: sessionSnapshot => int = "workerPid";
[@mel.get] external snapshotHarnessPid: sessionSnapshot => int = "harnessPid";
[@mel.get] external snapshotSequence: sessionSnapshot => int = "lastSequence";

[@mel.scope "String"] external fromCodePoint: int => string = "fromCodePoint";

let getText: string => Js.Promise.t(string) = [%raw
  "url => fetch(url).then(async response => { const text = await response.text(); if (!response.ok) throw new Error(text || `HTTP ${response.status}`); return text; })"
];

let postText: (string, string) => Js.Promise.t(string) = [%raw
  "(url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(async response => { const text = await response.text(); if (!response.ok) throw new Error(text || `HTTP ${response.status}`); return text; })"
];

let errorMessage: Js.Promise.error => string = [%raw
  "error => { try { const parsed = JSON.parse(error?.message || ''); return parsed.error || error.message; } catch (_) { return error?.message || 'Request failed'; } }"
];

let promptValue: unit => string = [%raw
  "() => document.getElementById('prompt-input')?.value?.trim() || ''"
];

let clearPrompt: unit => unit = [%raw
  "() => { const field = document.getElementById('prompt-input'); if (field) { field.value = ''; field.focus(); } }"
];

let preventDefault: React.Event.Form.t => unit = [%raw
  "event => event.preventDefault()"
];
let isRejectOption: string => bool = [%raw
  "value => value.includes('reject')"
];

let parseSnapshot: string => sessionSnapshot = [%raw
  "text => { try { return JSON.parse(text); } catch (_) { return { status: 'offline', workerPid: 0, harnessPid: 0, lastSequence: 0 }; } }"
];

let projectTimeline: string => array(timelineItem) = [%raw
  {|text => {
    let events;
    try { events = JSON.parse(text); } catch (_) { return []; }
    if (!Array.isArray(events)) return [];
    const items = [];
    const messages = new Map();
    const tools = new Map();
    const permissions = new Map();
    const acpUserTexts = new Set(events
      .filter(event => event.kind === 'acp.user_message_chunk')
      .map(event => event.payload?.params?.update?.content?.text)
      .filter(Boolean));
    let currentAgent = null;
    const contentText = content => {
      if (!content) return '';
      if (typeof content.text === 'string') return content.text;
      if (content.type === 'content') return contentText(content.content);
      return '';
    };
    for (const event of events) {
      const payload = event.payload || {};
      const update = payload.params?.update || {};
      if (event.kind === 'command.accepted' && payload.text && !acpUserTexts.has(payload.text)) {
        const item = { id: payload.commandId || `user-${event.sequence}`, role: 'user', title: 'You', text: payload.text, status: '', options: [], sequence: event.sequence };
        items.push(item);
        currentAgent = null;
      } else if (event.kind === 'acp.user_message_chunk' || event.kind === 'acp.agent_message_chunk') {
        const role = event.kind === 'acp.user_message_chunk' ? 'user' : 'agent';
        const id = update.messageId || (role === 'agent' && currentAgent ? currentAgent.id : `${role}-${event.sequence}`);
        let item = messages.get(id);
        if (!item) {
          item = { id, role, title: role === 'user' ? 'You' : 'Pi', text: '', status: '', options: [], sequence: event.sequence };
          messages.set(id, item);
          items.push(item);
        }
        item.text += contentText(update.content);
        if (role === 'agent') currentAgent = item;
      } else if (event.kind === 'acp.tool_call') {
        currentAgent = null;
        const id = update.toolCallId || `tool-${event.sequence}`;
        const item = {
          id,
          role: 'tool',
          title: update.title || 'Tool call',
          text: update.rawInput ? JSON.stringify(update.rawInput, null, 2) : '',
          status: update.status || 'pending',
          options: [],
          sequence: event.sequence
        };
        tools.set(id, item);
        items.push(item);
      } else if (event.kind === 'acp.tool_call_update') {
        const id = update.toolCallId || `tool-${event.sequence}`;
        let item = tools.get(id);
        if (!item) {
          item = { id, role: 'tool', title: 'Tool call', text: '', status: 'pending', options: [], sequence: event.sequence };
          tools.set(id, item);
          items.push(item);
        }
        if (update.title) item.title = update.title;
        if (update.status) item.status = update.status;
        const addition = Array.isArray(update.content) ? update.content.map(contentText).filter(Boolean).join('\n') : '';
        if (addition) item.text = item.text ? `${item.text}\n${addition}` : addition;
      } else if (event.kind === 'acp.permission.requested') {
        const id = String(payload.id ?? event.sequence);
        const params = payload.params || {};
        const tool = params.toolCall || {};
        const item = {
          id,
          role: 'permission',
          title: tool.title || 'Permission required',
          text: tool.rawInput ? JSON.stringify(tool.rawInput, null, 2) : 'The agent is waiting for your decision.',
          status: 'pending',
          options: Array.isArray(params.options) ? params.options : [],
          sequence: event.sequence
        };
        permissions.set(id, item);
        items.push(item);
      } else if (event.kind === 'acp.permission.resolved' || event.kind === 'acp.permission.cancelled') {
        const id = String(payload.requestId ?? '');
        const item = permissions.get(id);
        if (item) item.status = 'resolved';
      }
    }
    return items.sort((a, b) => a.sequence - b.sequence);
  }|}
];

let jsonBody = pairs =>
  Js.Json.stringify(Js.Json.object_(Js.Dict.fromArray(pairs)));

let thenPromise = (promise, callback) => Js.Promise.then_(callback, promise);
let catchPromise = (promise, callback) =>
  Js.Promise.catch(callback, promise);

let ignorePromise = promise =>
  promise->catchPromise(_ => Js.Promise.resolve())->ignore;

module TimelineItem = {
  [@react.component]
  let make = (~item, ~onPermission) => {
    let role = itemRole(item);
    let status = itemStatus(item);
    <article className={"timeline-item timeline-" ++ role}>
      <div className="message-meta">
        <span className="message-role">
          {React.string(itemTitle(item))}
        </span>
        {status == ""
           ? React.null
           : <span className={"message-status status-" ++ status}>
               {React.string(status)}
             </span>}
      </div>
      {itemText(item) == ""
         ? React.null
         : <pre className="message-body">
             {React.string(itemText(item))}
           </pre>}
      {role == "permission" && status == "pending"
         ? <div className="permission-actions">
             {Array.map(
                option =>
                  <button
                    key={optionId(option)}
                    className={
                      isRejectOption(optionId(option))
                        ? "permission-button reject"
                        : "permission-button allow"
                    }
                    type_="button"
                    onClick={_ =>
                      onPermission(itemId(item), Some(optionId(option)))
                    }>
                    {React.string(optionName(option))}
                  </button>,
                itemOptions(item),
              )
              ->React.array}
             <button
               className="permission-button reject"
               type_="button"
               onClick={_ => onPermission(itemId(item), None)}>
               {React.string("Cancel")}
             </button>
           </div>
         : React.null}
    </article>;
  };
};

module App = {
  [@react.component]
  let make = () => {
    let (sessionJson, setSessionJson) =
      React.useState(() =>
        "{\"status\":\"connecting\",\"workerPid\":0,\"harnessPid\":0,\"lastSequence\":0}"
      );
    let (eventsJson, setEventsJson) = React.useState(() => "[]");
    let (notice, setNotice) =
      React.useState(() => "Connecting to the durable worker...");
    let (submitting, setSubmitting) = React.useState(() => false);

    let refresh = () => {
      getText("/api/v2/session")
      ->thenPromise(text => {
          setSessionJson(_ => text);
          setNotice(current =>
            current == "Connecting to the durable worker..."
              ? "Durable timeline synchronized." : current
          );
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
      getText("/api/v2/events?recent=500")
      ->thenPromise(text => {
          setEventsJson(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
    };

    React.useEffect0(() => {
      refresh();
      let timer = Js.Global.setInterval(~f=refresh, 750);
      Some(() => Js.Global.clearInterval(timer));
    });

    let snapshot = parseSnapshot(sessionJson);
    let status = snapshotStatus(snapshot);
    let running = status == "running" || status == "requires_action";
    let timeline = projectTimeline(eventsJson);

    let submitPrompt = event => {
      preventDefault(event);
      let text = promptValue();
      if (text != "" && !running && !submitting) {
        setSubmitting(_ => true);
        setNotice(_ => "Dispatching prompt durably...");
        let commandId = "web-" ++ string_of_float(Js.Date.now());
        let body =
          jsonBody([|
            ("commandId", Js.Json.string(commandId)),
            ("text", Js.Json.string(text)),
          |]);
        postText("/api/v2/commands", body)
        ->thenPromise(_ => {
            clearPrompt();
            setNotice(_ => "Prompt accepted. The worker owns this turn.");
            setSubmitting(_ => false);
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            setSubmitting(_ => false);
            Js.Promise.resolve();
          })
        ->ignore;
      };
    };

    let cancel = _ => {
      setNotice(_ => "Cancellation requested...");
      postText("/api/v2/cancel", "{}")
      ->thenPromise(_ => {
          setNotice(_ => "Cancellation delivered to the agent.");
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    let resolvePermission = (requestId, optionId) => {
      let optionJson =
        switch (optionId) {
        | Some(value) => Js.Json.string(value)
        | None => Js.Json.null
        };
      let body =
        jsonBody([|
          ("requestId", Js.Json.string(requestId)),
          ("optionId", optionJson),
        |]);
      postText("/api/v2/permissions", body)
      ->thenPromise(_ => {
          setNotice(_ => "Permission decision delivered.");
          refresh();
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    <main className="control-room">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark">
            {React.string(fromCodePoint(0x03c0))}
          </span>
          <div>
            <p className="eyebrow">
              {React.string("PISS / OCAML CONTROL PLANE")}
            </p>
            <h1> {React.string("A durable room for agent work.")} </h1>
          </div>
        </div>
        <div className={"connection-pill connection-" ++ status}>
          <i />
          {React.string(status)}
        </div>
      </header>
      <section className="workspace-grid">
        <aside className="runtime-rail">
          <div>
            <p className="eyebrow"> {React.string("ACTIVE RUNTIME")} </p>
            <h2> {React.string("Pi / piss-ocaml")} </h2>
            <p className="runtime-copy">
              {React.string(
                 "One real ACP session, independently supervised and rooted in the OCaml rewrite workspace.",
               )}
            </p>
          </div>
          <dl className="runtime-facts">
            <div>
              <dt> {React.string("WORKER")} </dt>
              <dd> {React.int(snapshotWorkerPid(snapshot))} </dd>
            </div>
            <div>
              <dt> {React.string("HARNESS")} </dt>
              <dd> {React.int(snapshotHarnessPid(snapshot))} </dd>
            </div>
            <div>
              <dt> {React.string("EVENTS")} </dt>
              <dd> {React.int(snapshotSequence(snapshot))} </dd>
            </div>
          </dl>
          <div className="boundary-note">
            <span> {React.string("REPLACEABLE CONTROL")} </span>
            <p>
              {React.string(
                 "This page may disappear. The worker, Pi process, tools, and SQLite timeline do not.",
               )}
            </p>
          </div>
        </aside>
        <section className="conversation-panel">
          <div className="conversation-heading">
            <div>
              <p className="eyebrow"> {React.string("LIVE SESSION")} </p>
              <h2> {React.string("Agent timeline")} </h2>
            </div>
            <span className="sequence-label">
              {React.string(
                 string_of_int(Array.length(timeline)) ++ " entries",
               )}
            </span>
          </div>
          <div className="timeline" ariaLive="polite">
            {Array.length(timeline) == 0
               ? <div className="empty-state">
                   <span> {React.string(fromCodePoint(0x2198))} </span>
                   <h3>
                     {React.string("Give the worker something real to do.")}
                   </h3>
                   <p>
                     {React.string(
                        "Ask Pi to inspect code, run tests, or implement a focused change. Output and tool calls stream back here.",
                      )}
                   </p>
                 </div>
               : Array.map(
                   item =>
                     <TimelineItem
                       key={itemId(item)}
                       item
                       onPermission=resolvePermission
                     />,
                   timeline,
                 )
                 ->React.array}
          </div>
          <div className="composer-wrap">
            <p className="notice" role="status"> {React.string(notice)} </p>
            <form className="composer" onSubmit=submitPrompt>
              <label htmlFor="prompt-input">
                {React.string("Message Pi")}
              </label>
              <textarea
                id="prompt-input"
                name="prompt"
                rows=4
                maxLength=65536
                disabled={running || submitting}
                placeholder={
                  running
                    ? "Pi is working. Cancel the turn to interrupt it."
                    : "Inspect the worker protocol and suggest the next smallest improvement..."
                }
              />
              <div className="composer-actions">
                <span> {React.string("ACP v1 / durable dispatch")} </span>
                {running
                   ? <button
                       className="cancel-action" type_="button" onClick=cancel>
                       {React.string("Cancel turn")}
                     </button>
                   : <button
                       className="send-action"
                       type_="submit"
                       disabled=submitting>
                       <span>
                         {React.string(
                            submitting ? "Dispatching" : "Send to worker",
                          )}
                       </span>
                       <b> {React.string(fromCodePoint(0x2192))} </b>
                     </button>}
              </div>
            </form>
          </div>
        </section>
      </section>
    </main>;
  };
};

let () =
  switch (ReactDOM.querySelector("#root")) {
  | None => Js.Console.error("Missing #root element")
  | Some(element) =>
    let root = ReactDOM.Client.createRoot(element);
    ReactDOM.Client.render(root, <App />);
  };
