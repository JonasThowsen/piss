# PISS OCaml design notes

Status: **historical design record; the rewrite has advanced beyond this proposal.**
Scope: the native OCaml 5.5 services under `src/` and the OCaml 5.2
Bonsai/js_of_ocaml application under `web/`.
Companion to `OCAML-REWRITE.md` (which describes *what* to build) and
`ARCHITECTURE.md` (which describes the system *boundaries*); this
document focuses on *how to write the OCaml*.

The OCaml rewrite so far is structurally clean (modules are split by
concern, no spaghetti) but type-system-thick. The state record in
`src/worker/protocol.ml` is 17 fields with five mutable references and
two hashtables; the control plane's HTTP handler reaches into 11 sibling
modules; nothing has a `.mli`. The point of this rewrite is not to add
features but to make the existing pieces discoverable, type-checkable,
and extensible.

This document collects the OCaml design moves we should adopt and the
specific places they apply.

## 1. OCaml 5.5 features we should use

OCaml 5.5.0 was released 19 June 2026
([changelog](https://ocaml.org/changelog/2026-06-19-ocaml-5.5.0)).
Three of its new features are directly useful here; one breaking
change matters for the wire-protocol types.

### 1.1 Module-dependent functions (`(module M : S) -> ...`)

A new function-argument form lets a function take a *static* module as
an argument. The argument is a value, but unlike a first-class module
the type system tracks the module identity: the result type can depend
on it. The signature `val pp_map: (module M : Map.S) -> ...` cannot be
applied to a `(module Map.S)` produced at runtime, only to one
constructed at the call site. This rules out the usual first-class
module ergonomic problems (boxed allocations, no inlining) while
preserving the "give me your dictionary" expressivity.

This is the right tool for PISS in two places:

- *A generic JSON encoder for an opaque event ledger*. The current
  `Domain.event_to_yojson` is a hand-written conversion per event kind.
  A module-dependent function over a `Event.S` module would let us
  build a single encoder once per kind and reuse it.
- *A session-scoped store whose queries depend on which schema is
  current*. The `Store.t` type already does this implicitly; making it
  explicit lets the worker compile the queries once per session
  rather than parsing SQL on every call.

OCaml 5.5.0 supports `(module M : S) -> t[M]` syntax; PISS targets
OCaml ≥ 5.5 going forward (currently pinned at ≥ 5.4 in
`dune-project`, which we should bump).

### 1.2 Polymorphic functions as function arguments

Higher-rank polymorphic function arguments used to need an object or
record wrapper:

```ocaml
type map = { map: 'a 'b. ('a -> 'b) -> 'a list -> 'b list }
let apply_map {map} = map string_of_int [1;2;3]
```

OCaml 5.5 lets the polymorphism be expressed directly:

```ocaml
let apply_map (map: 'a 'b. ('a -> 'b) -> 'a list -> 'b list) =
  map string_of_int [1;2;3]
```

For PISS the immediate use case is `Wire.request_of_yojson` and
`Wire.response_to_yojson`. They are already polymorphic over `'a` and
`'b` and are routinely passed as continuations; the new syntax removes
the record wrapper that the current code does not have, but should
use once it grows. *We adopt this only when a record wrapper would
otherwise be needed.*

### 1.3 Generalized local definitions

OCaml 5.5 lifts the syntactic restriction that `let module`,
`let exception`, and `let type` only work at top level. Local
`type` declarations inside expressions are the most relevant for us:

```ocaml
let median t =
  let type outcome = Median of string | Before_and_after of string * string in
  ...
```

This is the right tool for *narrowing* a payload type to a specific
case at the boundary where it matters. `Wire.request` is a 17-variant
sum; inside `Protocol.handle` most cases never need the full type.
Today the function signature exposes the full type at every call site;
with generalized local definitions we can give each branch a tighter
local view. *We adopt this in `src/worker/protocol.ml` and
`src/control/http.ml` once the state-record refactor lands.*

### 1.4 External types (and the local-abstract change)

OCaml 5.5 introduces `type t = external "name"` for FFI types and
removes the previous brittle rule that locally-defined abstract types
were considered unique. Any code that relied on the rule (e.g. for
GADT type-level labels using abstract types) needs to switch to
external types.

The PISS code base does not use any abstract types as GADT labels.
The harness adapter and session IDs are plain strings; ACP envelope
IDs are JSON values. So this breaking change does not affect us, but
the rule of thumb going forward is: *if you need a type that is
provably distinct from every other type (for type-class
disambiguation, GADT labels, FFI handles), use
`type t = external "name"`*.

### 1.5 What we are *not* adopting

OCaml 5.5 also adds a relocatable compiler, idle GC phases, the
`String.split_first`/`replace_all`/`includes` family, and around 60
other standard-library functions. We use them where they fit (e.g.
`String.split_first` to parse `--flag=value` pairs in the CLI
parsers), but they are convenience rather than design moves.

## 2. Module design principles

The principles below are the ones that good OCaml libraries (Base,
Core, Eio, Jane Street's stdlib, ocaml-git, Irmin) consistently apply.
They are not novel; they are what the language is for.

### 2.1 Every type gets a module; the primary type is `t`

The convention `module M with type t = ...` and `M.t` for its primary
type is everywhere in the OCaml ecosystem. It means a reader of any
call site can guess where the types and operations come from without
grep.

For PISS this means:

- `Domain.session_id`, `Domain.worker_id`, `Domain.runtime_generation`
  are already wrapped correctly (each is an abstract type with a
  smart constructor inside `Domain`).
- `Workspace_files.mention` and `Workspace_files.resource` follow
  the same pattern.
- `Registry.workspace` and `Registry.session` and
  `Registry.peer_request` already do too.
- `Store.t` is fine as it stands.

Things that should *become* modules:

| Current | Should become |
| --- | --- |
| `Worker.protocol_state` record (17 fields) | `Worker.Protocol_state` module with `Protocol_state.t` and `make`/`update` functions |
| `Control.managed_workers` record | `Control.Managed_workers` module, with `t` and a `Managed_workers.of_*` constructor |
| The bare `mutable string ref` state sprinkled across `Control.workers` | Module fields, where the field types advertise what changes |

### 2.2 `mli` files are the public API

No PISS module currently has an `.mli`. That is the single largest
correctness and discoverability problem in the rewrite: every module
exposes every value, every type leaks its representation, and there
is no documentation that `odoc` can consume.

The migration rule is: *for every `.ml` file under `src/lib/` and
`src/control/` and `src/worker/`, write a matching `.mli` before
touching the implementation again.*

Order of attack (smallest first):

1. `src/lib/domain.mli` — pure types, 100 lines. Easy win, becomes
   the reference for everything else.
2. `src/lib/wire.mli` — request/response variants. The biggest payoff:
   callers will see only the variants they actually need.
3. `src/lib/workspace_files.mli`, `acp.mli`, `registry.mli`,
   `store.mli`.
4. `src/control/authentication.mli`, `event_stream.mli`,
   `worker_client.mli`, `headers.mli`, `assets.mli`,
   `lifecycle.mli`, `workspaces.mli`.
5. `src/control/workers.mli`, `broker.mli`, `http.mli` (the hard one).
6. `src/worker/config.mli`, `harness.mli`, `protocol.mli`.

Each `.mli` should answer: *what is this module for, what is its
primary type, what operations does it expose, and what invariants
does it maintain?*

### 2.3 Abstract by default, concrete only when pattern-matching wins

Real World OCaml's "Design with Modules" chapter is unambiguous: *most
types should be abstract.* The reasons are exactly the ones PISS
needs:

- An abstract type lets us change the implementation without breaking
  clients. The control plane currently passes
  `Domain.command_state` strings around; if we later want to track
  additional metadata (a per-state policy), keeping it abstract lets
  us add fields without touching the HTTP layer.
- An abstract type enforces invariants. `Session.t` could carry an
  invariant that the workspace it points at exists; if the type is
  abstract, only `Registry.insert` can construct one and the invariant
  holds everywhere.

Exceptions to the abstract-by-default rule:

- `event` in `Domain` — every reader needs to pattern-match on
  `kind` to dispatch. Expose the record.
- `request` and `response` in `Wire` — same reason.
- `snapshot` in `Domain` — exposed so the HTTP layer can convert it
  to JSON; expose the record but keep the constructors inside
  `Domain`.

### 2.4 Design for the call site

Real World OCaml again: *the interface should make the call obvious*.
For PISS that means:

- `Registry.open_ ~path` (not `Registry.create path`).
- `Workers.create_managed_session ~harness ~workspace_id ~title`
  rather than a positional 5-tuple.
- `Broker.send_peer_request ~net ~source json` — every cross-cutting
  capability passed by name, so a reader of any call sees exactly
  what it depends on.

### 2.5 Uniform interfaces across the modules that share a concept

Base/Core maintain the convention that *every* container module exposes
`length`, `is_empty`, `to_list`, `iter`, `fold`, `map`, etc. We are
not aiming for that depth (PISS is not a container library), but
within the PISS-specific clusters the same discipline applies:

- Every store module (`Store`, `Registry`) exposes
  `open_ ~path`, `close`, and is closed over `Eio.Switch.t` for
  resource lifetime.
- Every HTTP endpoint exposes `parse path` (returns the typed route)
  and `handle ~net ~clock ~state request body` (returns the typed
  response). The HTTP dispatcher in `Http.handler` becomes a single
  table of `(method * path * handler)` triples.

### 2.6 Interfaces before implementations

This is not just a style rule; it is a workflow. The order of work
should be:

1. Write the `.mli`.
2. Run `dune build` and see what fails. The errors tell us what the
   callers actually depend on.
3. Write the `.ml` until the `.mli` is satisfied.
4. Then call sites; only call sites.

For `src/lib/domain.mli` this is mechanical. For `src/control/http.mli`
this is the biggest payoff: every route becomes a small, named
function with a typed signature, and the HTTP dispatcher is a
table.

### 2.7 Modules-as-records anti-pattern

OCaml's module system is *the* way to bundle related values and types.
Using a plain record for that purpose is a known anti-pattern
sometimes called the "module-as-record" smell. PISS has it in two
places:

- `Control.managed_workers` (record with `state_root`,
  `runtime_root`, `launcher`, etc.) — should become a module with
  named constructors and field accessors.
- `Worker.protocol_state` (17-field record with 5 mutable refs, 2
  hash tables, and 2 closures) — should become a module with named
  operations: `Protocol_state.set_status`, `Protocol_state.record_dispatched`,
  etc. Each mutation becomes an explicit function whose type
  describes what changes.

The benefit is not just style: typed accessors let the type checker
catch missing updates. If `register_running_command` takes the new
`command_id` and the dispatch timestamp, the call site cannot forget
to add the command to the hashtable while updating the running count.

### 2.8 Capabilities as arguments, captured once at the edge

Eio's `Stdenv` pattern (network, clock, filesystem, process manager
passed as arguments; each function takes only the ones it needs) is
the canonical way to make concurrent OCaml testable and auditable.
PISS already uses this at the top level (`Eio_main.run @@ fun env -> run ~env args`),
but the rest of the code closes over the network, the clock, and
the directory from the env without declaring them. Concretely:

- `Worker.main` calls `Eio.Net.connect` directly inside the harness
  reader; it should take `net : Eio.Net.t` as an argument.
- `Worker.main` calls `Unix.gettimeofday ()` directly in many
  places; it should take `clock : Eio.Time.clock` and call
  `Eio.Time.now clock`.
- `Control.broker` calls `Eio.Time.sleep` and `Unix.gettimeofday ()`;
  same fix.

This is mostly mechanical, but the migration order matters: do it
together with the `.mli` rewrite so the `.mli` shows which
capabilities each module actually depends on. A reader of
`Worker.harness.ml` then sees at a glance "this module needs the
network and the process manager, nothing else" — a much stronger
property than reading the implementation.

### 2.9 Errors as typed variants, with a typed context

Today the control plane returns ad-hoc JSON error strings:
`Error ("same-origin mutation required")`. There is no way for a
client to programmatically tell *what* failed, only to display the
human string. The fix is to define a single error type at the top of
the API surface and let every layer construct it:

```ocaml
type error =
  | Not_found of { resource : string; id : string }
  | Forbidden of { reason : string }
  | Conflict of { reason : string }
  | Upstream_unavailable of { message : string }
  | Internal of { message : string; backtrace : string option }
```

Every endpoint becomes `... : (response, error) result`. The browser
already gets strings back; the change is invisible to it but a
huge win for tests and for any future programmatic client.

The same discipline applies inside the worker protocol: every
`Wire.Error string` becomes a typed variant.

## 3. Concrete refactor targets

### 3.1 `src/worker/protocol.ml` — collapse the state record

Today: a 17-field record with five refs and two hashtables, threaded
through every protocol handler.

Target: a `Worker.State` module with named operations.

```ocaml
module State : sig
  type t
  val make :
    args:Config.args ->
    store:Store.t ->
    workspace:string ->
    agent_name:string ->
    supports_load:bool ->
    supports_images:bool ->
    harness_session_id:string ->
    config_options:Yojson.Safe.t ->
    send:(Yojson.Safe.t -> unit) ->
    persist_config_values:(unit -> unit) ->
    create_session:(unit -> string) ->
    require_rpc_result:(id:string -> Yojson.Safe.t -> Yojson.Safe.t * Yojson.Safe.t) ->
    t

  val args : t -> Config.args
  val store : t -> Store.t
  val workspace : t -> string
  val snapshot : t -> Domain.snapshot
  val snapshot_with :
    t -> worker_pid:int -> harness_pid:int option -> Domain.snapshot

  (* The mutable fields become explicit operations. *)
  val set_status : t -> Domain.worker_status -> unit
  val record_dispatched : t -> command_id:string -> unit
  val record_completed : t -> command_id:string -> state:Domain.command_state -> unit
  val record_pending_permission : t -> request_id:string -> params:Yojson.Safe.t -> unit
  val resolve_permission : t -> request_id:string -> unit
  val begin_config_change : t -> (unit -> 'a) -> 'a  (* with a finally guarantee *)
  val start_upgrade : t -> target:string -> deadline:float -> Domain.event_sequence
  val expire_upgrade : t -> unit

  (* Read-only views for decision-making. *)
  val running_command_count : t -> int
  val pending_permission_count : t -> int
  val configuration_change_depth : t -> int
  val upgrade_target : t -> string option
  val upgrade_is_preparing : t -> bool
  val harness_session_id : t -> string
end
```

The module has only one `t`, the construction takes 11 named
arguments, and *every* mutation is an explicit function. After this
lands, `Protocol.handle` becomes a `match` over `request` that calls
`State.record_dispatched` etc., and the type system guarantees that
every code path updates everything it should.

The same pattern applies to `Control.managed_workers`. The current
record is a flat collection of strings; the module version groups
them:

```ocaml
module Managed_workers : sig
  type t
  val open_ :
    registry_path:string ->
    state_root:string ->
    runtime_root:string ->
    launcher:string ->
    stopper:string ->
    available_harnesses:string list ->
    default_harness:string ->
    default_workspace_id:string ->
    workspace_discovery_roots:string list ->
    max_active_sessions:int ->
    t * (string -> unit)  (* the manager and a close thunk *)

  val registry : t -> Registry.t
  val state_root : t -> string
  val runtime_root : t -> string
  val launcher : t -> string
  val stopper : t -> string
  val available_harnesses : t -> string list
  val default_harness : t -> string
  val default_workspace_id : t -> string
  val workspace_discovery_roots : t -> string list
  val max_active_sessions : t -> int

  val set_default_workspace_id : t -> string -> unit
end
```

Now `Config.parse` constructs the `Managed_workers.t` and `Workers`
and `Broker` accept it as a parameter; nothing reaches into fields
directly.

### 3.2 The control plane is a route table

Today `Http.handler` is a 700-line function with a giant nested
`match (method_, path)`. After the `.mli` refactor, every route
becomes its own typed function:

```ocaml
module Routes : sig
  type route =
    | Get_health
    | Get_session of { session_id : Session_id.t option }
    | Get_file_mentions of { query : string }
    | Get_config_options
    | Post_config_options
    | Get_event_stream of { after : int64 }
    | Get_events of { after : int64 option; before : int64 option; recent : int option }
    | Post_session_new
    | Post_commands
    | Post_cancel
    | Post_permissions
    | Get_broker_sessions
    | Post_broker_send
    | Post_broker_subscribe
    | Post_broker_ask
    | Post_broker_collect
    | Get_workspaces
    | Post_workspaces
    | Get_workspace_directories of { query : string }
    | Post_workspaces_delete of { id : Workspace_id.t }
    | Post_sessions of { harness : string option; workspace_id : string option; title : string option }
    | Post_sessions_archive of { id : Session_id.t }
    | Post_sessions_restore of { id : Session_id.t }
    | Post_sessions_rename of { id : Session_id.t; title : string }

  val parse : method_:Cohttp.Code.meth -> path:string -> (route, string) result
  val handle : route -> ctx -> Cohttp.Request.t -> body -> Cohttp.Response.t Lwt.t
end
```

`parse` is a pure function over `(method_, path)`. `handle` is a
dispatch by case over `route`. Each route handler becomes a small
function whose signature is enforced by the type checker. The
current 700-line `handler` collapses to roughly 50.

This is exactly the Real World OCaml "Design for the Call Site"
rule applied aggressively. Adding a new route is "add a case to
`route`, add a case to `parse`, add a case to `handle`". The
compiler tells you which file to touch.

### 3.3 The wire protocol becomes a typed error channel

`Wire.response_to_yojson` produces
`Ok : Yojson.Safe.t | Error : string`. The string is unstructured;
the HTTP layer must parse it to know if the error was a
`Conflict` or a `Service_unavailable`.

The fix is a single error type:

```ocaml
module Error : sig
  type t =
    | Not_found of { resource : string; id : string }
    | Forbidden of { reason : string }
    | Conflict of { reason : string }
    | Upstream_unavailable of { message : string }
    | Validation of { field : string; reason : string }
    | Internal of { message : string }

  val to_http : t -> Cohttp.Code.status
  val to_yojson : t -> Yojson.Safe.t
  val to_string : t -> string  (* for human display only *)
end
```

Every endpoint returns `(response, Error.t) result`. The HTTP
dispatcher becomes a single `Result.fold ~error:Error.to_http ~ok:handler`
chain. The browser still gets a JSON object — `{"error": {"kind":
"Not_found", "id": "..."}}` — and can pattern-match on `kind` if it
ever wants to.

### 3.4 The harness reader is a small interpreter

`Worker.main` has a 100-line `while true do ... done` loop that
pattern-matches on every ACP envelope kind and updates the protocol
state. The fix is to extract the dispatcher:

```ocaml
module Envelope_dispatch : sig
  type t
  val make :
    store:Store.t ->
    harness_pid:int ->
    pending_responses:(string -> [`Resolve of Yojson.Safe.t | `Reject of string]) ->
    running_commands:(string -> [`Dispatched of float | `Completed]) ->
    pending_permissions:(string -> [`Add of Yojson.Safe.t | `Resolve]) ->
    status:(Domain.worker_status -> unit) ->
    harness_send:(Yojson.Safe.t -> unit) ->
    t

  val handle : t -> Acp.envelope -> unit
end
```

`main` becomes:

```ocaml
let dispatch = Envelope_dispatch.make ~store ... in
Eio.Fiber.fork ~sw (fun () ->
    while true do
      let json = read_json harness_reader in
      ignore (Store.append_event store ~kind:(Harness.event_kind json)
                (Acp.redact_user_image_data json));
      Envelope_dispatch.handle dispatch (Acp.envelope_of_yojson json |> Result.get_ok))
```

The dispatcher becomes testable in isolation: feed it envelopes,
assert on the resulting state changes. The current code can only be
exercised end-to-end against a real harness.

### 3.5 Module-dependent functions for the event encoder

The current `Domain.event_to_yojson` is hand-written per event
kind. After the OCaml 5.5 upgrade, a module-dependent function
makes it pluggable:

```ocaml
module Event_encoder (E : sig
  type t
  val kind : t -> string
  val payload : t -> Yojson.Safe.t
end) : sig
  val encode : E.t -> Yojson.Safe.t
end
```

Each event kind becomes its own tiny module that exposes `t`,
`kind`, and `payload`. The encoder is generated once per kind.
The SSE source can then iterate over a list of event encoders
without any pattern-match on the constructor.

This is the OCaml 5.5 module-as-function-argument feature applied to
a place where first-class modules were previously too heavy.

## 4. Capability map

After the refactor, every module's `.mli` declares which Eio
capabilities it needs. The map becomes:

| Module | Capabilities |
| --- | --- |
| `Worker.Config` | none (pure) |
| `Worker.Harness` | `net`, `process_mgr` |
| `Worker.Envelope_dispatch` | none (state-only) |
| `Worker.Protocol` | `clock` |
| `Worker.Main` | `net`, `clock`, `process_mgr`, `fs` (for nothing — drop) |
| `Control.Authentication` | none |
| `Control.Assets` | `fs` (for static assets), `clock` (for cache headers) |
| `Control.Event_stream` | `clock` |
| `Control.Lifecycle` | `process_mgr` |
| `Control.Workspace_files` | `fs` (only when reading from the workspace) |
| `Control.Workspaces` | `fs` |
| `Control.Worker_client` | `net` |
| `Control.Broker` | `net`, `clock` |
| `Control.HTTP` | `net`, `clock` |

A new module that needs a capability becomes a `.mli` change that
the reviewer can audit. A capability leak from one module to another
becomes a compile error.

## 5. Migration order

Each step is independent and reviewable in isolation:

1. **`src/lib/domain.mli`** — pure types, no behavior change. Review
   the public surface.
2. **`src/lib/wire.mli`** — the variant types are large but
   mechanical. The biggest payoff for callers.
3. **`src/worker/state.ml`** (new) + **`src/worker/protocol.ml`** —
   collapse the 17-field state record. This unlocks the rest of the
   worker.
4. **`src/worker/{harness,config}.mli`** — small files, fast
   reviews.
5. **`src/worker/protocol.ml` → `src/worker/protocol.ml`** (split into
   `envelope_dispatch.ml` + `request.ml`) — the harness reader
   becomes testable in isolation.
6. **`src/control/authentication.mli`, `event_stream.mli`,
   `worker_client.mli`, `headers.mli`, `assets.mli`** — small.
7. **`src/control/lifecycle.mli`, `workspaces.mli`** — moderate.
8. **`src/control/managed_workers.ml`** (new) + **`src/control/config.ml`** —
   collapse the record. Same trick as `Worker.State`.
9. **`src/control/routes.ml`** (new) + **`src/control/http.ml`** —
   collapse the giant match. Unlocks the rest of the control plane.
10. **`src/control/workers.mli`, `broker.mli`, `http.mli`** — the
    big `.mli` files.
11. **`Error` module across the wire protocol + HTTP** — typed
    errors.
12. **`web/`** — same discipline applies; browser modules expose `.mli`
    interfaces where a public contract benefits from one.

The `.mli` files come first because they let reviewers catch the
*public* mistakes before the implementation drift hides them.

## 6. What we are deliberately not doing

- **No effect monad.** Eio's direct-style is the right tool here;
  introducing `let*`/`>>=` would be a regression.
- **No GADTs.** The wire types are simple enums; GADTs would buy us
  nothing and cost us readability.
- **No ppx rewriters in the control plane.** Bonsai and Jane Street ppx
  rewriters stay confined to the browser build; `src/` does not depend on
  them.
- **No first-class modules except where the type system needs
  them.** Module-dependent functions in OCaml 5.5 are the better
  tool when the module is static at the call site. We only fall back
  to `(module M : S)` first-class modules when the module is
  genuinely computed at runtime (e.g. choosing a harness adapter
  from configuration).

## 7. References

- [OCaml 5.5.0 release notes](https://ocaml.org/changelog/2026-06-19-ocaml-5.5.0) — the
  source for the modular explicits and higher-rank polymorphism
  descriptions in §1.
- [Real World OCaml, 2nd ed., chapter 2](https://dev.realworldocaml.org/files-modules-and-programs.html)
  — "Design with Modules" and "Interfaces Before Implementations"
  (§2).
- [Eio README](https://github.com/ocaml-multicore/eio) — capability-based
  design, `env` as argument, switches for structured concurrency
  (§2.8, §4).
- [Base/Core library conventions](https://opensource.janestreet.com/core_patterns.html) — module-per-type, `t` first, uniform
  interfaces (§2.1, §2.5).
- `docs/OCAML-REWRITE.md` — the slice plan this design enables.
- `docs/ARCHITECTURE.md` — the historical TypeScript architecture that
  preceded this design.
