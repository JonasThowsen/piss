type response;
type requestInit;

[@mel.scope "globalThis"]
external fetch: string => Js.Promise.t(response) = "fetch";

[@mel.scope "globalThis"]
external fetchWithInit: (string, requestInit) => Js.Promise.t(response) =
  "fetch";

[@mel.send] external responseText: response => Js.Promise.t(string) = "text";

[@mel.scope "String"] external fromCodePoint: int => string = "fromCodePoint";

let makePostInit: (Js.Dict.t(string), string) => requestInit = [%raw
  "(headers, body) => ({ method: 'POST', headers, body })"
];

let thenPromise = (promise, callback) => Js.Promise.then_(callback, promise);
let catchPromise = (promise, callback) =>
  Js.Promise.catch(callback, promise);

let getText = url => fetch(url)->thenPromise(responseText);

let postJson = (url, body) => {
  let headers = Js.Dict.empty();
  Js.Dict.set(headers, "Content-Type", "application/json");
  fetchWithInit(url, makePostInit(headers, body))
  ->thenPromise(responseText);
};

let ignorePromise = promise =>
  promise->catchPromise(_ => Js.Promise.resolve())->ignore;

module App = {
  [@react.component]
  let make = () => {
    let (session, setSession) =
      React.useState(() => "Connecting to the session worker...");
    let (events, setEvents) = React.useState(() => "[]");
    let (control, setControl) =
      React.useState(() => "Control plane is starting");
    let (busy, setBusy) = React.useState(() => false);

    let refresh = () => {
      getText("/health")
      ->thenPromise(text => {
          setControl(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
      getText("/api/v2/session")
      ->thenPromise(text => {
          setSession(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
      getText("/api/v2/events?after=0")
      ->thenPromise(text => {
          setEvents(_ => text);
          Js.Promise.resolve();
        })
      ->ignorePromise;
    };

    React.useEffect0(() => {
      refresh();
      let timer = Js.Global.setInterval(~f=refresh, 1000);
      Some(() => Js.Global.clearInterval(timer));
    });

    let startProof = _event =>
      if (!busy) {
        setBusy(_ => true);
        let commandId = "browser-" ++ string_of_float(Js.Date.now());
        let body =
          Js.Json.stringify(
            Js.Json.object_(
              Js.Dict.fromArray([|
                ("commandId", Js.Json.string(commandId)),
                (
                  "text",
                  Js.Json.string(
                    "Prove that replacing the PISS control plane does not interrupt this agent.",
                  ),
                ),
              |]),
            ),
          );
        postJson("/api/v2/commands", body)
        ->thenPromise(text => {
            setControl(_ => text);
            setBusy(_ => false);
            refresh();
            Js.Promise.resolve();
          })
        ->catchPromise(_ => {
            setControl(_ => "Could not submit the tracer command");
            setBusy(_ => false);
            Js.Promise.resolve();
          })
        ->ignore;
      };

    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            {React.string(fromCodePoint(0x03c0))}
          </span>
          <div>
            <p className="eyebrow">
              {React.string("CONTROL PLANE / OCAML TRACER")}
            </p>
            <h1> {React.string("PISS, without the blast radius.")} </h1>
          </div>
        </div>
        <span className="live-indicator">
          <i />
          {React.string(
             "LOCAL " ++ fromCodePoint(0x00b7) ++ " RECONNECTABLE",
           )}
        </span>
      </header>
      <section className="hero-grid">
        <article className="proof-card">
          <div className="card-heading">
            <span className="step-number"> {React.string("01")} </span>
            <div>
              <p className="eyebrow">
                {React.string("REPLACEABILITY PROOF")}
              </p>
              <h2>
                {React.string(
                   "Keep the worker. Replace everything around it.",
                 )}
              </h2>
            </div>
          </div>
          <p className="lede">
            {React.string(
               "Start a long-running ACP tool, kill the API process, and reconnect. The worker and harness PIDs must remain unchanged while every event is retained.",
             )}
          </p>
          <button className="primary-action" disabled=busy onClick=startProof>
            <span>
              {React.string(busy ? "PROOF RUNNING" : "START STABILITY PROOF")}
            </span>
            <b>
              {React.string(
                 busy
                   ? fromCodePoint(0x2022)
                     ++ fromCodePoint(0x2022)
                     ++ fromCodePoint(0x2022)
                   : fromCodePoint(0x2192),
               )}
            </b>
          </button>
        </article>
        <aside className="principles-card">
          <p className="eyebrow"> {React.string("THREE HARD BOUNDARIES")} </p>
          <ol>
            <li>
              <b> {React.string("CONTROL")} </b>
              <span>
                {React.string("Replaceable API and browser projection")}
              </span>
            </li>
            <li>
              <b> {React.string("RUNTIME")} </b>
              <span>
                {React.string("Independently supervised session worker")}
              </span>
            </li>
            <li>
              <b> {React.string("HARNESS")} </b>
              <span>
                {React.string("ACP-compatible and disposable by session")}
              </span>
            </li>
          </ol>
        </aside>
      </section>
      <section className="telemetry-grid">
        <article className="telemetry-card">
          <div className="telemetry-title">
            <span> {React.string("CONTROL")} </span>
            <small> {React.string("/health")} </small>
          </div>
          <pre> {React.string(control)} </pre>
        </article>
        <article className="telemetry-card">
          <div className="telemetry-title">
            <span> {React.string("WORKER")} </span>
            <small> {React.string("DURABLE SNAPSHOT")} </small>
          </div>
          <pre> {React.string(session)} </pre>
        </article>
        <article className="telemetry-card event-log">
          <div className="telemetry-title">
            <span> {React.string("EVENT SPOOL")} </span>
            <small>
              {React.string(
                 "SQLITE WAL " ++ fromCodePoint(0x00b7) ++ " 1S POLL",
               )}
            </small>
          </div>
          <pre> {React.string(events)} </pre>
        </article>
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
