type requestInit;

type timelineItem;
type permissionOption;
type sessionSnapshot;
type sessionSummary;
type workspaceSummary;
type directoryCandidate;
type configOption;
type configChoice;

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
[@mel.get] external snapshotAgentName: sessionSnapshot => string = "agentName";
[@mel.get] external snapshotWorkerPid: sessionSnapshot => int = "workerPid";
[@mel.get] external snapshotHarnessPid: sessionSnapshot => int = "harnessPid";
[@mel.get] external snapshotSequence: sessionSnapshot => int = "lastSequence";
[@mel.get] external sessionId: sessionSummary => string = "id";
[@mel.get] external sessionTitle: sessionSummary => string = "title";
[@mel.get] external sessionHarness: sessionSummary => string = "harness";
[@mel.get] external sessionStatus: sessionSummary => string = "status";
[@mel.get]
external sessionWorkspaceId: sessionSummary => string = "workspaceId";
[@mel.get] external workspaceId: workspaceSummary => string = "id";
[@mel.get] external workspaceName: workspaceSummary => string = "name";
[@mel.get] external workspaceRoot: workspaceSummary => string = "root";
[@mel.get] external directoryPath: directoryCandidate => string = "path";
[@mel.get] external directoryName: directoryCandidate => string = "name";
[@mel.get] external configId: configOption => string = "id";
[@mel.get] external configCategory: configOption => string = "category";
[@mel.get] external configName: configOption => string = "name";
[@mel.get]
external configCurrentValue: configOption => string = "currentValue";
[@mel.get]
external configChoices: configOption => array(configChoice) = "options";
[@mel.get] external choiceValue: configChoice => string = "value";

[@mel.scope "String"] external fromCodePoint: int => string = "fromCodePoint";

let icon: string => React.element = [%raw
  "name => { const n = { menu: [['path',{d:'M4 5h16'}],['path',{d:'M4 12h16'}],['path',{d:'M4 19h16'}]], search: [['path',{d:'m21 21-4.34-4.34'}],['circle',{cx:11,cy:11,r:8}]], plus: [['path',{d:'M5 12h14'}],['path',{d:'M12 5v14'}]], more: [['circle',{cx:12,cy:12,r:1}],['circle',{cx:19,cy:12,r:1}],['circle',{cx:5,cy:12,r:1}]], chevron: [['path',{d:'m6 9 6 6 6-6'}]], up: [['path',{d:'m5 12 7-7 7 7'}],['path',{d:'M12 19V5'}]], down: [['path',{d:'M12 5v14'}],['path',{d:'m19 12-7 7-7-7'}]], at: [['circle',{cx:12,cy:12,r:4}],['path',{d:'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8'}]], bot: [['path',{d:'M12 8V4H8'}],['rect',{width:16,height:12,x:4,y:8,rx:2}],['path',{d:'M2 14h2'}],['path',{d:'M20 14h2'}],['path',{d:'M15 13v2'}],['path',{d:'M9 13v2'}]], diff: [['path',{d:'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z'}],['path',{d:'M9 10h6'}],['path',{d:'M12 13V7'}],['path',{d:'M9 17h6'}]], gauge: [['path',{d:'m12 14 4-4'}],['path',{d:'M3.34 19a10 10 0 1 1 17.32 0'}]], x: [['path',{d:'M18 6 6 18'}],['path',{d:'m6 6 12 12'}]], archive: [['rect',{width:20,height:5,x:2,y:3,rx:1}],['path',{d:'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'}],['path',{d:'M10 12h4'}]], check: [['path',{d:'M20 6 9 17l-5-5'}]] }; return React.createElement('svg',{viewBox:'0 0 24 24',width:24,height:24,fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},...(n[name]||[]).map(([tag,props],i)=>React.createElement(tag,{...props,key:i}))); }"
];

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
let fieldValue: string => string = [%raw
  "id => document.getElementById(id)?.value?.trim() || ''"
];
let confirmRename: string => option(string) = [%raw
  "current => { const value = window.prompt('Rename session', current); return value && value.trim() ? value.trim() : undefined; }"
];

let clearPrompt: unit => unit = [%raw
  "() => { const field = document.getElementById('prompt-input'); if (field) { field.value = ''; field.focus(); } }"
];
let eventValue: 'a => string = [%raw
  "event => event.currentTarget?.value || ''"
];
let eventKey: 'a => string = [%raw "event => event.key || ''"];
let preventAnyDefault: 'a => unit = [%raw "event => event.preventDefault()"];
let timelineAwayFromBottom: 'a => bool = [%raw
  "event => event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight > 80"
];
let jumpTimelineToBottom: unit => unit = [%raw
  "() => { const timeline = document.getElementById('timeline'); if (timeline) timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' }); }"
];

let preventDefault: React.Event.Form.t => unit = [%raw
  "event => event.preventDefault()"
];
let isRejectOption: string => bool = [%raw
  "value => value.includes('reject')"
];
let scrollTimeline: unit => unit = [%raw
  "() => requestAnimationFrame(() => { const timeline = document.getElementById('timeline'); if (!timeline) return; const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 280; if (nearBottom || !timeline.dataset.seen) { timeline.scrollTop = timeline.scrollHeight; timeline.dataset.seen = 'true'; } })"
];
let composerKeyDown: React.Event.Keyboard.t => unit = [%raw
  "event => { if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey || !matchMedia('(max-width: 760px)').matches)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }"
];

let parseSnapshot: string => sessionSnapshot = [%raw
  "text => { try { return JSON.parse(text); } catch (_) { return { status: 'offline', agentName: 'ACP agent', workerPid: 0, harnessPid: 0, lastSequence: 0 }; } }"
];
let parseSessions: string => array(sessionSummary) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseWorkspaces: string => array(workspaceSummary) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseDirectories: string => array(directoryCandidate) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let parseConfigOptions: string => array(configOption) = [%raw
  "text => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch (_) { return []; } }"
];
let configOptionsFromSnapshot: string => string = [%raw
  "text => { try { const value = JSON.parse(text).configOptions; return JSON.stringify(Array.isArray(value) ? value : []); } catch (_) { return '[]'; } }"
];
let findConfigOption: (array(configOption), string) => option(configOption) = [%raw
  "(options, category) => options.find(option => option.category === category)"
];
let configCurrentName: configOption => string = [%raw
  "option => { const name = option.options?.find(choice => choice.value === option.currentValue)?.name || option.currentValue || 'Choose'; return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name; }"
];
let choiceDisplayName: configChoice => string = [%raw
  "choice => choice.name.includes('/') ? choice.name.slice(choice.name.indexOf('/') + 1) : choice.name"
];
let sessionsForWorkspace:
  (array(sessionSummary), string) => array(sessionSummary) = [%raw
  "(sessions, workspaceId) => sessions.filter(session => session.workspaceId === workspaceId)"
];
let searchSessions:
  (array(sessionSummary), array(workspaceSummary), string) =>
  array(sessionSummary) = [%raw
  "(sessions, workspaces, query) => { const needle = query.trim().toLocaleLowerCase(); const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace])); const ordered = [...sessions].sort((left, right) => left.title.localeCompare(right.title)); if (!needle) return ordered; return ordered.filter(session => { const workspace = workspaceById.get(session.workspaceId); return [session.title, session.id, session.harness, session.status, workspace?.name, workspace?.root].some(value => String(value || '').toLocaleLowerCase().includes(needle)); }); }"
];
let sessionWorkspaceName: (sessionSummary, array(workspaceSummary)) => string = [%raw
  "(session, workspaces) => workspaces.find(workspace => workspace.id === session.workspaceId)?.name || 'Unknown workspace'"
];
let idInJson: (string, string) => bool = [%raw
  "(text, id) => { try { return JSON.parse(text).includes(id); } catch (_) { return false; } }"
];
let toggleIdJson: (string, string) => string = [%raw
  "(text, id) => { let values = []; try { values = JSON.parse(text); } catch (_) {} return JSON.stringify(values.includes(id) ? values.filter(value => value !== id) : [...values, id]); }"
];
let selectedWorkspaceName:
  (array(sessionSummary), array(workspaceSummary), string) => string = [%raw
  "(sessions, workspaces, id) => { const workspaceId = sessions.find(session => session.id === id)?.workspaceId; return workspaces.find(workspace => workspace.id === workspaceId)?.name || 'PISS'; }"
];
let workspaceNameById: (array(workspaceSummary), string) => string = [%raw
  "(workspaces, id) => workspaces.find(workspace => workspace.id === id)?.name || 'workspace'"
];
let sessionTitleById: (array(sessionSummary), string) => string = [%raw
  "(sessions, id) => sessions.find(session => session.id === id)?.title || 'Session'"
];
let sessionHarnessById: (array(sessionSummary), string) => string = [%raw
  "(sessions, id) => sessions.find(session => session.id === id)?.harness || 'unknown'"
];
let selectSessionId: (string, string) => string = [%raw
  "(text, current) => { try { const sessions = JSON.parse(text); if (!Array.isArray(sessions) || sessions.length === 0) return ''; return sessions.some(session => session.id === current) ? current : sessions[0].id; } catch (_) { return ''; } }"
];
let sessionUrl: (string, string) => string = [%raw
  "(path, id) => `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(id)}`"
];
let archiveUrl: string => string = [%raw
  "id => `/api/v2/sessions/${encodeURIComponent(id)}/archive`"
];
let restoreUrl: string => string = [%raw
  "id => `/api/v2/sessions/${encodeURIComponent(id)}/restore`"
];
let directorySearchUrl: string => string = [%raw
  "query => `/api/v2/workspace-directories?query=${encodeURIComponent(query)}`"
];
let createdSessionId: string => string = [%raw
  "text => { try { return JSON.parse(text).id || ''; } catch (_) { return ''; } }"
];
let settledNotice: string => string = [%raw
  "current => current === 'Connecting to the durable worker...' || current === 'Switching durable session...' || current === 'Isolated session worker is starting.' || current === 'Event stream reconnecting...' || current.startsWith('Eio.Io ') ? 'Durable event stream connected.' : current"
];
let mergeSessionSnapshot: (string, string, string) => string = [%raw
  "(sessionsText, id, snapshotText) => { try { const sessions = JSON.parse(sessionsText); const snapshot = JSON.parse(snapshotText); if (!Array.isArray(sessions)) return sessionsText; return JSON.stringify(sessions.map(session => session.id === id ? { ...session, ...snapshot } : session)); } catch (_) { return sessionsText; } }"
];
let appendEvent: (string, string) => string = [%raw
  "(eventsText, eventText) => { try { const events = JSON.parse(eventsText); const event = JSON.parse(eventText); if (!Array.isArray(events) || !Number.isSafeInteger(event.sequence)) return eventsText; const next = events.filter(existing => existing.sequence !== event.sequence); next.push(event); next.sort((a, b) => a.sequence - b.sequence); return JSON.stringify(next.slice(-500)); } catch (_) { return eventsText; } }"
];
let eventChangesRuntime: string => bool = [%raw
  "text => { try { const kind = JSON.parse(text).kind || ''; return kind === 'command.state' || kind.startsWith('acp.permission.') || kind === 'acp.session.loaded' || kind === 'acp.session.load_failed'; } catch (_) { return false; } }"
];
let eventCompletesTurn: string => bool = [%raw
  "text => { try { const event = JSON.parse(text); return event.kind === 'command.state' && ['completed', 'cancelled', 'rejected', 'ambiguous'].includes(event.payload?.state); } catch (_) { return false; } }"
];
let connectEventStream:
  (string, string => unit, string => unit, unit => unit, unit => unit, unit) =>
  unit = [%raw
  {|(id, onInitial, onEvent, onOpen, onError) => {
    let closed = false;
    let source = null;
    const close = () => { closed = true; if (source) source.close(); };
    fetch(`/api/v2/events?recent=500&session=${encodeURIComponent(id)}`)
      .then(async response => {
        const text = await response.text();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
        if (closed) return;
        let events;
        try { events = JSON.parse(text); } catch (_) { events = []; }
        if (!Array.isArray(events)) events = [];
        onInitial(JSON.stringify(events));
        const after = events.reduce((cursor, event) => Math.max(cursor, Number(event.sequence) || 0), 0);
        source = new EventSource(`/api/v2/event-stream?session=${encodeURIComponent(id)}&after=${after}`);
        source.onmessage = event => { if (!closed) onEvent(event.data); };
        source.onopen = () => { if (!closed) onOpen(); };
        source.onerror = () => { if (!closed) onError(); };
      })
      .catch(() => { if (!closed) onError(); });
    return close;
  }|}
];

let projectTimeline: (string, string) => array(timelineItem) = [%raw
  {|(text, agentName) => {
    let events;
    try { events = JSON.parse(text); } catch (_) { return []; }
    if (!Array.isArray(events)) return [];
    const resetIndex = events.findLastIndex(event => event.kind === 'timeline.reset');
    if (resetIndex >= 0) events = events.slice(resetIndex + 1);
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
      if (event.kind.startsWith('session.ask.')) {
        const direction = event.kind === 'session.ask.sent' ? 'Sent to' : event.kind === 'session.ask.queued' ? 'Queued for' : event.kind === 'session.ask.dispatched' ? 'Dispatched to' : event.kind === 'session.ask.received' ? 'Request from' : event.kind === 'session.ask.failed' ? 'Failed for' : 'Response from';
        items.push({
          id: `${event.kind}-${payload.requestId || event.sequence}`,
          role: 'peer',
          title: `${direction} ${payload.peerId || 'session'}`,
          text: payload.text || '',
          status: event.kind === 'session.ask.completed' ? 'completed' : event.kind === 'session.ask.failed' ? 'failed' : event.kind === 'session.ask.queued' ? 'pending' : event.kind === 'session.ask.dispatched' ? 'in_progress' : '',
          options: [],
          sequence: event.sequence
        });
        currentAgent = null;
      } else if (event.kind === 'command.accepted' && payload.text && !acpUserTexts.has(payload.text)) {
        const isWake = payload.text.startsWith('PISS durable collaboration wake-up.');
        const item = { id: payload.commandId || `user-${event.sequence}`, role: isWake ? 'peer' : 'user', title: isWake ? 'PISS wake-up' : 'You', text: payload.text, status: '', options: [], sequence: event.sequence };
        items.push(item);
        currentAgent = null;
      } else if (event.kind === 'acp.user_message_chunk' || event.kind === 'acp.agent_message_chunk') {
        const role = event.kind === 'acp.user_message_chunk' ? 'user' : 'agent';
        const chunkText = contentText(update.content);
        if (role === 'user' && chunkText.startsWith('Inter-session request from ')) continue;
        const id = update.messageId || (role === 'agent' && currentAgent ? currentAgent.id : `${role}-${event.sequence}`);
        const isWake = role === 'user' && chunkText.startsWith('PISS durable collaboration wake-up.');
        let item = messages.get(id);
        if (!item) {
          item = { id, role: isWake ? 'peer' : role, title: isWake ? 'PISS wake-up' : role === 'user' ? 'You' : agentName, text: '', status: '', options: [], sequence: event.sequence };
          messages.set(id, item);
          items.push(item);
        }
        item.text += chunkText;
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
        "{\"status\":\"connecting\",\"agentName\":\"ACP agent\",\"workerPid\":0,\"harnessPid\":0,\"lastSequence\":0}"
      );
    let (eventsJson, setEventsJson) = React.useState(() => "[]");
    let (sessionsJson, setSessionsJson) = React.useState(() => "[]");
    let (workspacesJson, setWorkspacesJson) = React.useState(() => "[]");
    let (configOptionsJson, setConfigOptionsJson) =
      React.useState(() => "[]");
    let (configMenu, setConfigMenu) = React.useState(() => "");
    let (activeSessionId, setActiveSessionId) = React.useState(() => "");
    let (activeView, setActiveView) = React.useState(() => "agent");
    let (drawerOpen, setDrawerOpen) = React.useState(() => false);
    let (searchOpen, setSearchOpen) = React.useState(() => false);
    let (searchQuery, setSearchQuery) = React.useState(() => "");
    let (showJumpToBottom, setShowJumpToBottom) = React.useState(() => false);
    let (creatorOpen, setCreatorOpen) = React.useState(() => false);
    let (creatorWorkspaceId, setCreatorWorkspaceId) =
      React.useState(() => "");
    let (workspaceCreatorOpen, setWorkspaceCreatorOpen) =
      React.useState(() => false);
    let (directoriesJson, setDirectoriesJson) = React.useState(() => "[]");
    let (selectedWorkspacePath, setSelectedWorkspacePath) =
      React.useState(() => "");
    let (collapsedWorkspacesJson, setCollapsedWorkspacesJson) =
      React.useState(() => "[]");
    let (sessionMenuId, setSessionMenuId) = React.useState(() => "");
    let (archiveTargetId, setArchiveTargetId) = React.useState(() => "");
    let (archiveTargetTitle, setArchiveTargetTitle) =
      React.useState(() => "");
    let (notice, setNotice) =
      React.useState(() => "Connecting to the durable worker...");
    let (submitting, setSubmitting) = React.useState(() => false);

    let refreshSession = id =>
      if (id != "") {
        getText(sessionUrl("/api/v2/session", id))
        ->thenPromise(text => {
            setSessionJson(_ => text);
            setConfigOptionsJson(_ => configOptionsFromSnapshot(text));
            setSessionsJson(current =>
              mergeSessionSnapshot(current, id, text)
            );
            setNotice(current => settledNotice(current));
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let refresh = () => {
      getText("/api/v2/sessions")
      ->thenPromise(text => {
          setSessionsJson(_ => text);
          let selected = selectSessionId(text, activeSessionId);
          if (selected != activeSessionId) {
            setActiveSessionId(_ => selected);
            setEventsJson(_ => "[]");
          };
          refreshSession(selected);
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
      getText("/api/v2/workspaces")
      ->thenPromise(text => {
          setWorkspacesJson(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
    };

    React.useEffect0(() => {
      refresh();
      None;
    });

    React.useEffect1(
      () =>
        if (activeSessionId == "") {
          None;
        } else {
          let close =
            connectEventStream(
              activeSessionId,
              text => {
                setEventsJson(_ => text);
                scrollTimeline();
              },
              event => {
                setEventsJson(current => appendEvent(current, event));
                if (eventChangesRuntime(event)) {
                  refreshSession(activeSessionId);
                };
                if (eventCompletesTurn(event)) {
                  setNotice(_ => "Durable event stream connected.");
                };
                scrollTimeline();
              },
              () => refreshSession(activeSessionId),
              () => setNotice(_ => "Event stream reconnecting..."),
            );
          Some(close);
        },
      [|activeSessionId|],
    );

    let snapshot = parseSnapshot(sessionJson);
    let status = snapshotStatus(snapshot);
    let running = status == "running" || status == "requires_action";
    let timeline = projectTimeline(eventsJson, snapshotAgentName(snapshot));
    let sessions = parseSessions(sessionsJson);
    let workspaces = parseWorkspaces(workspacesJson);
    let configOptions = parseConfigOptions(configOptionsJson);
    let modelOption = findConfigOption(configOptions, "model");
    let thinkingOption = findConfigOption(configOptions, "thought_level");
    let searchResults = searchSessions(sessions, workspaces, searchQuery);

    let applyConfig = (option, value) =>
      if (!running && !submitting) {
        setSubmitting(_ => true);
        setConfigMenu(_ => "");
        let body =
          jsonBody([|
            ("configId", Js.Json.string(configId(option))),
            ("value", Js.Json.string(value)),
          |]);
        postText(sessionUrl("/api/v2/config-options", activeSessionId), body)
        ->thenPromise(text => {
            let resultOptions: string => string = [%raw
              "text => { try { return JSON.stringify(JSON.parse(text).configOptions || []); } catch (_) { return '[]'; } }"
            ];
            setConfigOptionsJson(_ => resultOptions(text));
            setSubmitting(_ => false);
            setNotice(_ => "Session configuration updated.");
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setSubmitting(_ => false);
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

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
        postText(sessionUrl("/api/v2/commands", activeSessionId), body)
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

    let newSession = event => {
      preventDefault(event);
      if (!submitting) {
        let harness = fieldValue("new-session-harness");
        let workspaceId = creatorWorkspaceId;
        let title = fieldValue("new-session-title");
        if (workspaceId != "" && title != "") {
          setSubmitting(_ => true);
          setNotice(_ => "Starting an isolated " ++ harness ++ " worker...");
          let body =
            jsonBody([|
              ("harness", Js.Json.string(harness)),
              ("workspaceId", Js.Json.string(workspaceId)),
              ("title", Js.Json.string(title)),
            |]);
          postText("/api/v2/sessions", body)
          ->thenPromise(text => {
              let selected = createdSessionId(text);
              setActiveSessionId(_ => selected);
              setEventsJson(_ => "[]");
              setNotice(_ => "Isolated session worker is starting.");
              setSubmitting(_ => false);
              setCreatorOpen(_ => false);
              setDrawerOpen(_ => false);
              refreshSession(selected);
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
    };

    let renameSession = session =>
      switch (confirmRename(sessionTitle(session))) {
      | None => ()
      | Some(title) =>
        let body = jsonBody([|("title", Js.Json.string(title))|]);
        postText(
          "/api/v2/sessions/" ++ sessionId(session) ++ "/rename",
          body,
        )
        ->thenPromise(_ => {
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };

    let selectSession = id => {
      setActiveSessionId(_ => id);
      setEventsJson(_ => "[]");
      setConfigOptionsJson(_ => "[]");
      setConfigMenu(_ => "");
      setNotice(_ => "Switching durable session...");
      setDrawerOpen(_ => false);
      setSearchOpen(_ => false);
      setSearchQuery(_ => "");
      setShowJumpToBottom(_ => false);
      refreshSession(id);
    };

    let archiveSession = id =>
      if (!submitting && id != "") {
        setSubmitting(_ => true);
        postText(archiveUrl(id), "{}")
        ->thenPromise(_ => {
            if (id == activeSessionId) {
              setActiveSessionId(_ => "");
              setEventsJson(_ => "[]");
            };
            setArchiveTargetId(_ => "");
            setSessionMenuId(_ => "");
            setNotice(_ => "Session archived; its ledger remains durable.");
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

    let searchDirectories = _ => {
      let query = fieldValue("workspace-search");
      setSelectedWorkspacePath(_ => "");
      getText(directorySearchUrl(query))
      ->thenPromise(text => {
          setDirectoriesJson(_ => text);
          Js.Promise.resolve();
        })
      ->catchPromise(error => {
          setNotice(_ => errorMessage(error));
          Js.Promise.resolve();
        })
      ->ignore;
    };

    let registerWorkspace = event => {
      preventDefault(event);
      let path = selectedWorkspacePath;
      if (path != "" && !submitting) {
        setSubmitting(_ => true);
        postText(
          "/api/v2/workspaces",
          jsonBody([|("path", Js.Json.string(path))|]),
        )
        ->thenPromise(_ => {
            setSubmitting(_ => false);
            setWorkspaceCreatorOpen(_ => false);
            setNotice(_ => "Local workspace added.");
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(error => {
            setSubmitting(_ => false);
            setNotice(_ => errorMessage(error));
            Js.Promise.resolve();
          })
        ->ignore;
      };
    };

    let cancel = _ => {
      setNotice(_ => "Cancellation requested...");
      postText(sessionUrl("/api/v2/cancel", activeSessionId), "{}")
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
      postText(sessionUrl("/api/v2/permissions", activeSessionId), body)
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
        <button
          className="mobile-menu"
          type_="button"
          ariaLabel={
            drawerOpen
              ? "Close workspaces and sessions"
              : "Open workspaces and sessions"
          }
          ariaExpanded=drawerOpen
          onClick={_ => setDrawerOpen(current => !current)}>
          {icon("menu")}
        </button>
        <div className="brand-lockup">
          <span className="brand-mark">
            {React.string(fromCodePoint(0x03c0))}
          </span>
          <div>
            <h1>
              {React.string(
                 selectedWorkspaceName(sessions, workspaces, activeSessionId),
               )}
            </h1>
            <p className="eyebrow">
              {React.string("DURABLE AGENT WORKBENCH")}
            </p>
          </div>
        </div>
        <button
          className="search-trigger"
          type_="button"
          title="Search sessions"
          ariaLabel="Search sessions"
          ariaExpanded=searchOpen
          onClick={_ => {
            setDrawerOpen(_ => false);
            setSearchOpen(_ => true);
          }}>
          {icon("search")}
        </button>
        <div className={"connection-pill connection-" ++ status}>
          <i />
          <span> {React.string(status)} </span>
        </div>
      </header>
      <section className="workspace-grid">
        {drawerOpen
           ? <button
               className="sidebar-scrim visible"
               type_="button"
               ariaLabel="Close navigation"
               onClick={_ => setDrawerOpen(_ => false)}
             />
           : React.null}
        <aside
          className={"runtime-rail " ++ (drawerOpen ? "mobile-open" : "")}>
          <div className="rail-heading">
            <div>
              <p className="eyebrow"> {React.string("WORKSPACES")} </p>
              <h2> {React.string("Sessions")} </h2>
            </div>
            <button
              className="create-session-trigger"
              type_="button"
              ariaLabel="Add workspace"
              onClick={_ => {
                setWorkspaceCreatorOpen(_ => true);
                searchDirectories();
              }}>
              {icon("plus")}
            </button>
          </div>
          <nav className="session-index" ariaLabel="Workspaces and sessions">
            {Array.map(
               workspace => {
                 let workspaceSessions =
                   sessionsForWorkspace(sessions, workspaceId(workspace));
                 let collapsed =
                   idInJson(collapsedWorkspacesJson, workspaceId(workspace));
                 <section
                   className="workspace-group" key={workspaceId(workspace)}>
                   <header className="workspace-heading">
                     <button
                       className="workspace-toggle"
                       type_="button"
                       ariaExpanded={!collapsed}
                       onClick={_ =>
                         setCollapsedWorkspacesJson(current =>
                           toggleIdJson(current, workspaceId(workspace))
                         )
                       }>
                       <span
                         className={
                           "workspace-chevron "
                           ++ (collapsed ? "collapsed" : "")
                         }>
                         {icon("chevron")}
                       </span>
                       <span>
                         <strong>
                           {React.string(workspaceName(workspace))}
                         </strong>
                         <small title={workspaceRoot(workspace)}>
                           {React.string(workspaceRoot(workspace))}
                         </small>
                       </span>
                     </button>
                     <button
                       type_="button"
                       ariaLabel={
                         "New session in " ++ workspaceName(workspace)
                       }
                       onClick={_ => {
                         setCreatorWorkspaceId(_ => workspaceId(workspace));
                         setCreatorOpen(_ => true);
                       }}>
                       {icon("plus")}
                     </button>
                   </header>
                   {collapsed
                      ? React.null
                      : <div className="session-list">
                          {Array.length(workspaceSessions) == 0
                             ? <p className="empty-workspace">
                                 {React.string("No sessions")}
                               </p>
                             : Array.map(
                                 session => {
                                   let id = sessionId(session);
                                   <div className="session-row-wrap" key=id>
                                     <button
                                       type_="button"
                                       className={
                                         "session-row "
                                         ++ (
                                           id == activeSessionId
                                             ? "session-row-active" : ""
                                         )
                                       }
                                       disabled=submitting
                                       onClick={_ => selectSession(id)}>
                                       <i
                                         className={
                                           "session-dot status-"
                                           ++ sessionStatus(session)
                                         }
                                       />
                                       <span>
                                         <strong>
                                           {React.string(
                                              sessionTitle(session),
                                            )}
                                         </strong>
                                         <small>
                                           {React.string(
                                              sessionStatus(session)
                                              ++ " / "
                                              ++ sessionHarness(session),
                                            )}
                                         </small>
                                       </span>
                                     </button>
                                     <div className="session-menu-wrap">
                                       <button
                                         className="session-more"
                                         type_="button"
                                         ariaLabel={
                                           "Session settings for "
                                           ++ sessionTitle(session)
                                         }
                                         ariaExpanded={sessionMenuId == id}
                                         onClick={_ =>
                                           setSessionMenuId(current =>
                                             current == id ? "" : id
                                           )
                                         }>
                                         {icon("more")}
                                       </button>
                                       {sessionMenuId == id
                                          ? <div
                                              className="session-menu"
                                              role="menu">
                                              <button
                                                type_="button"
                                                role="menuitem"
                                                onClick={_ => {
                                                  setSessionMenuId(_ => "");
                                                  renameSession(session);
                                                }}>
                                                {React.string("RENAME")}
                                              </button>
                                              <button
                                                className="danger"
                                                type_="button"
                                                role="menuitem"
                                                onClick={_ => {
                                                  setArchiveTargetId(_ => id);
                                                  setArchiveTargetTitle(_ =>
                                                    sessionTitle(session)
                                                  );
                                                  setSessionMenuId(_ => "");
                                                }}>
                                                {icon("archive")}
                                                {React.string("ARCHIVE")}
                                              </button>
                                            </div>
                                          : React.null}
                                     </div>
                                   </div>;
                                 },
                                 workspaceSessions,
                               )
                               ->React.array}
                        </div>}
                 </section>;
               },
               workspaces,
             )
             ->React.array}
          </nav>
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
                 "This page may disappear. Session workers, harnesses, tools, and SQLite timelines continue independently.",
               )}
            </p>
          </div>
        </aside>
        <section className="conversation-panel">
          <nav className="capability-tabs" ariaLabel="Session views">
            <button
              className={activeView == "agent" ? "active" : ""}
              type_="button"
              ariaPressed={activeView == "agent" ? "true" : "false"}
              onClick={_ => setActiveView(_ => "agent")}>
              {icon("bot")}
              {React.string("Agent")}
            </button>
            <button
              disabled=true type_="button" title="Changes view is coming next">
              {icon("diff")}
              {React.string("Changes")}
            </button>
            <button
              className={activeView == "details" ? "active" : ""}
              type_="button"
              ariaPressed={activeView == "details" ? "true" : "false"}
              onClick={_ => setActiveView(_ => "details")}>
              {icon("gauge")}
              {React.string("Details")}
            </button>
          </nav>
          {activeView == "details"
             ? <section
                 className="session-details"
                 role="tabpanel"
                 ariaLabel="Session details">
                 <header>
                   <span> {React.string("SESSION DETAILS")} </span>
                   <h2>
                     {React.string(
                        sessionTitleById(sessions, activeSessionId),
                      )}
                   </h2>
                   <p>
                     {React.string(
                        "Live values reported by the independently supervised worker.",
                      )}
                   </p>
                 </header>
                 <dl>
                   <div>
                     <dt> {React.string("STATUS")} </dt>
                     <dd> {React.string(status)} </dd>
                   </div>
                   <div>
                     <dt> {React.string("WORKSPACE")} </dt>
                     <dd>
                       {React.string(
                          selectedWorkspaceName(
                            sessions,
                            workspaces,
                            activeSessionId,
                          ),
                        )}
                     </dd>
                   </div>
                   <div>
                     <dt> {React.string("HARNESS")} </dt>
                     <dd>
                       {React.string(
                          sessionHarnessById(sessions, activeSessionId),
                        )}
                     </dd>
                   </div>
                   <div>
                     <dt> {React.string("AGENT")} </dt>
                     <dd> {React.string(snapshotAgentName(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("WORKER PID")} </dt>
                     <dd> {React.int(snapshotWorkerPid(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("HARNESS PID")} </dt>
                     <dd> {React.int(snapshotHarnessPid(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("EVENT SEQUENCE")} </dt>
                     <dd> {React.int(snapshotSequence(snapshot))} </dd>
                   </div>
                   <div>
                     <dt> {React.string("SESSION ID")} </dt>
                     <dd title=activeSessionId>
                       {React.string(activeSessionId)}
                     </dd>
                   </div>
                 </dl>
                 <section className="details-config">
                   <h3> {React.string("ACP CONFIGURATION")} </h3>
                   {Array.length(configOptions) == 0
                      ? <p>
                          {React.string(
                             "This worker generation does not expose ACP configuration options.",
                           )}
                        </p>
                      : <div>
                          {Array.map(
                             option =>
                               <p key={configId(option)}>
                                 <span>
                                   {React.string(configName(option))}
                                 </span>
                                 <b>
                                   {React.string(configCurrentName(option))}
                                 </b>
                               </p>,
                             configOptions,
                           )
                           ->React.array}
                        </div>}
                 </section>
               </section>
             : <div className="timeline-wrap">
                 <div
                   id="timeline"
                   className="timeline"
                   tabIndex=0
                   ariaLive="polite"
                   onScroll={event => {
                     let away = timelineAwayFromBottom(event);
                     setShowJumpToBottom(_ => away);
                   }}>
                   {Array.length(timeline) == 0
                      ? <div className="empty-state">
                          <span>
                            {React.string(fromCodePoint(0x2198))}
                          </span>
                          <h3>
                            {React.string(
                               "Give the worker something real to do.",
                             )}
                          </h3>
                          <p>
                            {React.string(
                               "Ask the agent to inspect code, run tests, or implement a focused change. Output and tool calls stream back here.",
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
                 {showJumpToBottom
                    ? <button
                        className="timeline-jump"
                        type_="button"
                        ariaLabel="Jump to latest message"
                        onClick={_ => {
                          jumpTimelineToBottom();
                          setShowJumpToBottom(_ => false);
                        }}>
                        {icon("down")}
                      </button>
                    : React.null}
               </div>}
          <div className="composer-wrap">
            <p className="notice" role="status"> {React.string(notice)} </p>
            <form className="composer" onSubmit=submitPrompt>
              <textarea
                id="prompt-input"
                name="prompt"
                rows=2
                maxLength=65536
                ariaLabel="Message agent"
                disabled={running || submitting}
                onKeyDown=composerKeyDown
                placeholder={
                  running
                    ? "The agent is working. Cancel the turn to interrupt it."
                    : "Message agent / commands @ files"
                }
              />
              <div className="composer-footer">
                <div className="composer-insertions">
                  <button
                    type_="button"
                    disabled=true
                    title="Image attachments are coming next"
                    ariaLabel="Attach images">
                    {icon("plus")}
                  </button>
                  <button
                    type_="button"
                    disabled=true
                    title="File mentions are coming next"
                    ariaLabel="Mention a file">
                    {icon("at")}
                  </button>
                </div>
                <div
                  className="composer-config"
                  role="group"
                  ariaLabel="Model configuration">
                  {switch (modelOption) {
                   | None => React.null
                   | Some(option) =>
                     <div className="config-control">
                       <button
                         className="composer-config-trigger model"
                         type_="button"
                         disabled={running || submitting}
                         ariaExpanded={configMenu == "model"}
                         ariaLabel={"Model: " ++ configCurrentName(option)}
                         onClick={_ =>
                           setConfigMenu(current =>
                             current == "model" ? "" : "model"
                           )
                         }>
                         <span>
                           <small> {React.string("MODEL")} </small>
                           <b> {React.string(configCurrentName(option))} </b>
                         </span>
                         {icon("chevron")}
                       </button>
                       {configMenu == "model"
                          ? <div
                              className="composer-config-menu model-menu"
                              role="menu"
                              ariaLabel="Model options">
                              <header>
                                <span>
                                  {React.string("AVAILABLE MODELS")}
                                </span>
                                <small>
                                  {React.int(
                                     Array.length(configChoices(option)),
                                   )}
                                </small>
                              </header>
                              {Array.map(
                                 choice =>
                                   <button
                                     className={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "selected" : ""
                                     }
                                     type_="button"
                                     role="menuitemradio"
                                     ariaChecked={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "true" : "false"
                                     }
                                     key={choiceValue(choice)}
                                     onClick={_ =>
                                       applyConfig(
                                         option,
                                         choiceValue(choice),
                                       )
                                     }>
                                     <span>
                                       <b>
                                         {React.string(
                                            choiceDisplayName(choice),
                                          )}
                                       </b>
                                       <small>
                                         {React.string(choiceValue(choice))}
                                       </small>
                                     </span>
                                     {choiceValue(choice)
                                      == configCurrentValue(option)
                                        ? icon("check") : React.null}
                                   </button>,
                                 configChoices(option),
                               )
                               ->React.array}
                            </div>
                          : React.null}
                     </div>
                   }}
                  {switch (thinkingOption) {
                   | None => React.null
                   | Some(option) =>
                     <div className="config-control">
                       <button
                         className="composer-config-trigger thinking"
                         type_="button"
                         disabled={running || submitting}
                         ariaExpanded={configMenu == "thinking"}
                         ariaLabel={"Thinking: " ++ configCurrentName(option)}
                         onClick={_ =>
                           setConfigMenu(current =>
                             current == "thinking" ? "" : "thinking"
                           )
                         }>
                         <span>
                           <small> {React.string("THINKING")} </small>
                           <b> {React.string(configCurrentName(option))} </b>
                         </span>
                         {icon("chevron")}
                       </button>
                       {configMenu == "thinking"
                          ? <div
                              className="composer-config-menu thinking-menu"
                              role="menu"
                              ariaLabel="Thinking options">
                              <header>
                                <span>
                                  {React.string("THINKING LEVEL")}
                                </span>
                              </header>
                              {Array.map(
                                 choice =>
                                   <button
                                     className={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "selected" : ""
                                     }
                                     type_="button"
                                     role="menuitemradio"
                                     ariaChecked={
                                       choiceValue(choice)
                                       == configCurrentValue(option)
                                         ? "true" : "false"
                                     }
                                     key={choiceValue(choice)}
                                     onClick={_ =>
                                       applyConfig(
                                         option,
                                         choiceValue(choice),
                                       )
                                     }>
                                     <span>
                                       <b>
                                         {React.string(
                                            choiceDisplayName(choice),
                                          )}
                                       </b>
                                     </span>
                                     {choiceValue(choice)
                                      == configCurrentValue(option)
                                        ? icon("check") : React.null}
                                   </button>,
                                 configChoices(option),
                               )
                               ->React.array}
                            </div>
                          : React.null}
                     </div>
                   }}
                </div>
                {running
                   ? <button
                       className="cancel-action"
                       type_="button"
                       onClick=cancel
                       ariaLabel="Cancel turn">
                       {icon("x")}
                     </button>
                   : <button
                       className="send-action"
                       type_="submit"
                       disabled=submitting
                       ariaLabel="Send message">
                       {submitting ? React.string("...") : icon("up")}
                     </button>}
              </div>
            </form>
          </div>
        </section>
      </section>
      {searchOpen
         ? <div className="global-search-layer">
             <button
               className="global-search-backdrop"
               type_="button"
               ariaLabel="Close session search"
               onClick={_ => {
                 setSearchOpen(_ => false);
                 setSearchQuery(_ => "");
               }}
             />
             <section
               className="global-search"
               role="dialog"
               ariaModal=true
               ariaLabel="Search sessions">
               <header>
                 <div>
                   <span> {React.string("SESSION SWITCHER")} </span>
                   <b> {React.string("Go to a session")} </b>
                 </div>
                 <button
                   type_="button"
                   ariaLabel="Close session search"
                   onClick={_ => {
                     setSearchOpen(_ => false);
                     setSearchQuery(_ => "");
                   }}>
                   {icon("x")}
                 </button>
               </header>
               <div className="global-search-field">
                 {icon("search")}
                 <input
                   autoFocus=true
                   ariaLabel="Search sessions"
                   placeholder="Search sessions and workspaces..."
                   onInput={event => {
                     let value = eventValue(event);
                     setSearchQuery(_ => value);
                   }}
                   onKeyDown={event =>
                     switch (eventKey(event)) {
                     | "Escape" =>
                       preventAnyDefault(event);
                       setSearchOpen(_ => false);
                       setSearchQuery(_ => "");
                     | "Enter" =>
                       if (Array.length(searchResults) > 0) {
                         preventAnyDefault(event);
                         selectSession(sessionId(searchResults[0]));
                       }
                     | _ => ()
                     }
                   }
                 />
               </div>
               <div
                 className="global-search-results"
                 role="listbox"
                 ariaLabel="Matching sessions">
                 {Array.length(searchResults) == 0
                    ? <div className="global-search-empty">
                        {icon("search")}
                        <b> {React.string("No matching sessions")} </b>
                        <span>
                          {React.string(
                             "Try a session name, workspace, harness, or status.",
                           )}
                        </span>
                      </div>
                    : Array.map(
                        session =>
                          <button
                            type_="button"
                            role="option"
                            ariaSelected={
                              sessionId(session) == activeSessionId
                            }
                            key={sessionId(session)}
                            onClick={_ => selectSession(sessionId(session))}>
                            <i
                              className={
                                "session-dot status-"
                                ++ sessionStatus(session)
                              }
                            />
                            <span>
                              <b> {React.string(sessionTitle(session))} </b>
                              <small>
                                {React.string(
                                   sessionWorkspaceName(session, workspaces)
                                   ++ " / "
                                   ++ sessionHarness(session),
                                 )}
                              </small>
                            </span>
                            <em> {React.string(sessionStatus(session))} </em>
                          </button>,
                        searchResults,
                      )
                      ->React.array}
               </div>
               <footer>
                 <span> {React.string("ENTER TO OPEN")} </span>
                 <b>
                   {React.string(
                      string_of_int(Array.length(searchResults))
                      ++ " SESSIONS",
                    )}
                 </b>
               </footer>
             </section>
           </div>
         : React.null}
      {creatorOpen
         ? <div className="dialog-backdrop" role="presentation">
             <form className="session-dialog" onSubmit=newSession>
               <header>
                 <div>
                   <span> {React.string("NEW SESSION")} </span>
                   <h2> {React.string("Start an agent")} </h2>
                 </div>
                 <button
                   type_="button"
                   ariaLabel="Close new session dialog"
                   onClick={_ => setCreatorOpen(_ => false)}>
                   {icon("x")}
                 </button>
               </header>
               <label htmlFor="new-session-title">
                 {React.string("NAME")}
               </label>
               <input
                 id="new-session-title"
                 name="title"
                 maxLength=120
                 required=true
                 placeholder="Implementation agent"
               />
               <p className="fixed-workspace">
                 {React.string("Creating in ")}
                 <strong>
                   {React.string(
                      workspaceNameById(workspaces, creatorWorkspaceId),
                    )}
                 </strong>
               </p>
               <label htmlFor="new-session-harness">
                 {React.string("HARNESS")}
               </label>
               <select id="new-session-harness" name="harness">
                 <option value="pi"> {React.string("Pi")} </option>
                 <option value="opencode">
                   {React.string("OpenCode")}
                 </option>
               </select>
               <footer>
                 <button
                   type_="button" onClick={_ => setCreatorOpen(_ => false)}>
                   {React.string("CANCEL")}
                 </button>
                 <button
                   className="launch-session"
                   type_="submit"
                   disabled=submitting>
                   {React.string(submitting ? "STARTING..." : "START SESSION")}
                 </button>
               </footer>
             </form>
           </div>
         : React.null}
      {workspaceCreatorOpen
         ? <div className="dialog-backdrop" role="presentation">
             <form
               className="session-dialog workspace-dialog"
               onSubmit=registerWorkspace>
               <header>
                 <div>
                   <span> {React.string("ADD WORKSPACE")} </span>
                   <h2> {React.string("Choose a local directory")} </h2>
                 </div>
                 <button
                   type_="button"
                   ariaLabel="Close workspace dialog"
                   onClick={_ => setWorkspaceCreatorOpen(_ => false)}>
                   {icon("x")}
                 </button>
               </header>
               <label htmlFor="workspace-search">
                 {React.string("SEARCH THIS COMPUTER")}
               </label>
               <div className="directory-search">
                 <input
                   id="workspace-search"
                   placeholder="Search directories..."
                   onInput=searchDirectories
                 />
                 {icon("search")}
               </div>
               <span className="dialog-field-label">
                 {React.string("DIRECTORY")}
               </span>
               <div
                 className="directory-options"
                 role="listbox"
                 ariaLabel="Local directories">
                 {Array.map(
                    directory => {
                      let path = directoryPath(directory);
                      <button
                        type_="button"
                        role="option"
                        ariaSelected={selectedWorkspacePath == path}
                        className={
                          selectedWorkspacePath == path ? "selected" : ""
                        }
                        key=path
                        onClick={_ => setSelectedWorkspacePath(_ => path)}>
                        <strong>
                          {React.string(directoryName(directory))}
                        </strong>
                        <small> {React.string(path)} </small>
                      </button>;
                    },
                    parseDirectories(directoriesJson),
                  )
                  ->React.array}
               </div>
               <p className="dialog-help">
                 {React.string(
                    "Only directories inside administrator-approved local roots are available.",
                  )}
               </p>
               <footer>
                 <button
                   type_="button"
                   onClick={_ => setWorkspaceCreatorOpen(_ => false)}>
                   {React.string("CANCEL")}
                 </button>
                 <button
                   className="launch-session"
                   type_="submit"
                   disabled={submitting || selectedWorkspacePath == ""}>
                   {React.string(submitting ? "ADDING..." : "ADD WORKSPACE")}
                 </button>
               </footer>
             </form>
           </div>
         : React.null}
      {archiveTargetId != ""
         ? <div className="dialog-backdrop" role="presentation">
             <section
               className="session-dialog archive-dialog"
               role="alertdialog"
               ariaModal=true
               ariaLabel="Archive session">
               <header>
                 <div>
                   <span> {React.string("ARCHIVE SESSION")} </span>
                   <h2>
                     {React.string("Archive " ++ archiveTargetTitle ++ "?")}
                   </h2>
                 </div>
                 <button
                   type_="button"
                   ariaLabel="Close archive dialog"
                   onClick={_ => setArchiveTargetId(_ => "")}>
                   {icon("x")}
                 </button>
               </header>
               <p>
                 {React.string(
                    "The worker will stop, but its durable ledger will remain available for a future restoration interface.",
                  )}
               </p>
               <footer>
                 <button
                   type_="button" onClick={_ => setArchiveTargetId(_ => "")}>
                   {React.string("CANCEL")}
                 </button>
                 <button
                   className="danger-action"
                   type_="button"
                   disabled=submitting
                   onClick={_ => archiveSession(archiveTargetId)}>
                   {React.string(
                      submitting ? "ARCHIVING..." : "ARCHIVE SESSION",
                    )}
                 </button>
               </footer>
             </section>
           </div>
         : React.null}
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
