open! Bonsai_web.Cont

let class_ name = [ Vdom.Attr.class_ name ]

let render ~audit_active ~header ~navigation_scrim ~session_rail ~workbench
    ~search_dialog ~session_lifecycle ~workspace_dialogs =
  Vdom.Node.div ~attrs:(class_ "app-shell")
    [
      Vdom.Node.main
        ~attrs:
          ([ Vdom.Attr.id "control-room" ]
          @ class_
              (if audit_active then "control-room audit-fullscreen-mode"
               else "control-room"))
        [
          header;
          Vdom.Node.section ~attrs:(class_ "workspace-grid")
            [ navigation_scrim; session_rail; workbench ];
        ];
      search_dialog;
      session_lifecycle;
      workspace_dialogs;
    ]
