open! Core

let live_event_capacity = 4096

type history_action =
  | Start of string
  | Initial of string * Event_history.event list
  | Append of string * Event_history.event
  | History_failed of string * string

type deciding_action = Add of string | Remove of string | Reset

type runtime_state = {
  session_id : string option;
  snapshot : Runtime_domain.t option;
  loading : bool;
  error : string option;
}

type shell_model = { runtime : runtime_state; tab : Session_tabs.t }

type shell_action =
  | Runtime_start of string
  | Runtime_loaded of string * Runtime_domain.t
  | Runtime_failed of string * string
  | Select_tab of Session_tabs.t

let empty_runtime =
  { session_id = None; snapshot = None; loading = false; error = None }

let apply_shell _ model = function
  | Runtime_start session_id ->
      if Option.exists model.runtime.session_id ~f:(String.equal session_id)
      then
        {
          model with
          runtime = { model.runtime with loading = true; error = None };
        }
      else
        {
          runtime =
            {
              session_id = Some session_id;
              snapshot = None;
              loading = true;
              error = None;
            };
          tab = Agent;
        }
  | Runtime_loaded (session_id, snapshot)
    when Option.exists model.runtime.session_id ~f:(String.equal session_id) ->
      let previous =
        Option.map model.runtime.snapshot ~f:(fun value -> value.status)
      in
      {
        runtime =
          {
            session_id = Some session_id;
            snapshot = Some snapshot;
            loading = false;
            error = None;
          };
        tab =
          Session_tabs.select_after_snapshot ~previous ~next:snapshot.status
            model.tab;
      }
  | Runtime_failed (session_id, message)
    when Option.exists model.runtime.session_id ~f:(String.equal session_id) ->
      {
        model with
        runtime = { model.runtime with loading = false; error = Some message };
      }
  | Runtime_loaded _ | Runtime_failed _ -> model
  | Select_tab tab -> { model with tab }

let apply_history _ state = function
  | Start session_id -> Timeline_view.Loading session_id
  | Initial (session_id, events) -> (
      match state with
      | Timeline_view.Loading current when String.equal current session_id ->
          Loaded
            ( session_id,
              Event_buffer.create ~live_capacity:live_event_capacity events )
      | _ -> state)
  | Append (session_id, event) -> (
      match state with
      | Timeline_view.Loaded (current, buffer)
        when String.equal current session_id ->
          Loaded (current, Event_buffer.add buffer event)
      | _ -> state)
  | History_failed (session_id, message) -> (
      match state with
      | Timeline_view.Loading current when String.equal current session_id ->
          Failed (session_id, message)
      | _ -> state)

let apply_deciding _ deciding = function
  | Add request_id -> Set.add deciding request_id
  | Remove request_id -> Set.remove deciding request_id
  | Reset -> String.Set.empty
