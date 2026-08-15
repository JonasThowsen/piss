{
  description = "Piss - Pi sin sidecar";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-ocaml-lsp.url = "github:NixOS/nixpkgs/ac62194c3917d5f474c1a844b6fd6da2db95077d";
    pi-acp-src = {
      url = "github:svkozak/pi-acp/d1cffc047ab37a096ee70ca39cfc1de463db8d12";
      flake = false;
    };
    opencode-src = {
      url = "github:anomalyco/opencode/f51665191af10f1e4e0512af3708e9c2c58ecb8d";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-ocaml-lsp,
      pi-acp-src,
      opencode-src,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_2;
          bonsaiWeb = import ./nix/bonsai-web.nix { inherit pkgs; };
          dependencies = with ocamlPackages; [
            alcotest
            cohttp-eio
            eio_main
            fmt
            logs
            ocaml_sqlite3
            yojson
          ];
          source = nixpkgs.lib.fileset.toSource {
            root = ./.;
            fileset = nixpkgs.lib.fileset.unions [
              ./.ocamlformat
              ./dune
              ./dune-project
              ./LICENSE
              ./piss.opam
              ./shared
              ./src
              ./web/public
            ];
          };
          pissWeb = bonsaiWeb.ocamlPackages.buildDunePackage {
            pname = "piss-web";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./web;
              fileset = nixpkgs.lib.fileset.unions [
                ./web/.ocamlformat
                ./web/acp_content.ml
                ./web/acp_content.mli
                ./web/acp_content_test.ml
                ./web/dune
                ./web/dune-project
                ./web/dune-workspace
                ./web/app_header.ml
                ./web/app_header.mli
                ./web/app_state.ml
                ./web/app_state.mli
                ./web/artifact_view.ml
                ./web/artifact_view.mli
                ./web/audit_domain.ml
                ./web/audit_domain.mli
                ./web/audit_domain_test.ml
                ./web/audit_view.ml
                ./web/audit_view.mli
                ./web/browser_http.ml
                ./web/browser_http.mli
                ./web/clipboard.ml
                ./web/clipboard.mli
                ./web/command_id.ml
                ./web/command_id.mli
                ./web/composer.ml
                ./web/composer.mli
                ./web/composer_draft.ml
                ./web/composer_draft.mli
                ./web/composer_ui.ml
                ./web/composer_ui.mli
                ./web/composer_domain_test.ml
                ./web/composer_policy.ml
                ./web/composer_policy.mli
                ./web/config_controls.ml
                ./web/config_controls.mli
                ./web/control_plane.ml
                ./web/control_plane.mli
                ./web/control_plane_test.ml
                ./web/details_view.ml
                ./web/details_view.mli
                ./web/event_buffer.ml
                ./web/event_buffer.mli
                ./web/event_buffer_test.ml
                ./web/event_decode.ml
                ./web/event_decode.mli
                ./web/event_history.ml
                ./web/event_history.mli
                ./web/global_search.ml
                ./web/global_search.mli
                ./web/history_loader.ml
                ./web/history_loader.mli
                ./web/http_error.ml
                ./web/http_error.mli
                ./web/http_error_test.ml
                ./web/event_stream.ml
                ./web/event_stream.mli
                ./web/image_attachment.ml
                ./web/image_attachment.mli
                ./web/image_batch.ml
                ./web/image_batch.mli
                ./web/image_attachments.ml
                ./web/image_attachments.mli
                ./web/last_opened_session.ml
                ./web/main.ml
                ./web/markdown_syntax.ml
                ./web/markdown_syntax.mli
                ./web/markdown_syntax_test.ml
                ./web/markdown_view.ml
                ./web/markdown_view.mli
                ./web/managed_workflow_test.ml
                ./web/modal.ml
                ./web/modal.mli
                ./web/mention_picker.ml
                ./web/mention_picker.mli
                ./web/mention_picker_test.ml
                ./web/mention_request.ml
                ./web/mention_request.mli
                ./web/mobile_shell.ml
                ./web/mobile_shell.mli
                ./web/outbox_projection.ml
                ./web/outbox_projection.mli
                ./web/outbox_view.ml
                ./web/outbox_view.mli
                ./web/permission_decision.ml
                ./web/permission_decision.mli
                ./web/permission_view.ml
                ./web/permission_view.mli
                ./web/prompt_command.ml
                ./web/prompt_command.mli
                ./web/request_target.ml
                ./web/request_target.mli
                ./web/runtime_domain.ml
                ./web/runtime_domain.mli
                ./web/session_protocol_test.ml
                ./web/session_rail.ml
                ./web/session_rail.mli
                ./web/session_lifecycle.ml
                ./web/session_lifecycle.mli
                ./web/search_dialog.ml
                ./web/search_dialog.mli
                ./web/session_tabs.ml
                ./web/session_tabs.mli
                ./web/timeline_view.ml
                ./web/timeline_view.mli
                ./web/timeline_projection.ml
                ./web/timeline_projection.mli
                ./web/timeline_projection_test.ml
                ./web/timeline_scroll.ml
                ./web/timeline_scroll.mli
                ./web/timeline_entry_view.ml
                ./web/timeline_entry_view.mli
                ./web/workbench_domain_test.ml
                ./web/workspace_catalog.ml
                ./web/workspace_catalog.mli
                ./web/workspace_dialogs.ml
                ./web/workspace_dialogs.mli
              ];
            };
            nativeBuildInputs = [
              bonsaiWeb.js_of_ocaml_compiler
              bonsaiWeb.ocamlPackages.ppx_jane
            ];
            buildInputs = [
              bonsaiWeb.bonsai
              bonsaiWeb.ocamlPackages.ppx_pattern_bind
              bonsaiWeb.ocamlPackages.uri
              bonsaiWeb.ocamlPackages.yojson
            ];
            buildPhase = ''
              runHook preBuild
              dune build --profile release main.bc.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/piss-web"
              cp _build/default/main.bc.js "$out/share/piss-web/app.js"
              test "$(stat -c %s "$out/share/piss-web/app.js")" -lt 5242880
              runHook postInstall
            '';
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              dune runtest
              runHook postCheck
            '';
          };
          piss = ocamlPackages.buildDunePackage {
            pname = "piss";
            version = "0.1.0";
            src = source;
            nativeBuildInputs = [
              pkgs.git
              pkgs.landrun
              pkgs.makeWrapper
            ];
            buildInputs = dependencies;
            postInstall = ''
              mkdir -p "$out/share/piss"
              cp -r web/public "$out/share/piss/public"
              cp ${pissWeb}/share/piss-web/app.js "$out/share/piss/public/app.js"
              wrapProgram "$out/bin/pissd" --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.git
                  pkgs.landrun
                ]
              }
            '';
            doCheck = true;
            meta = {
              description = "Private web workspace for coding-agent sessions";
              homepage = "https://github.com/JonasThowsen/piss";
              license = pkgs.lib.licenses.mit;
              mainProgram = "pissd";
              platforms = systems;
            };
          };
        in
        {
          inherit piss;
          opencode = opencode-src.packages.${system}.opencode;
          pi-acp = pkgs.buildNpmPackage {
            pname = "pi-acp";
            version = "0.0.33";
            src = pi-acp-src;
            patches = [
              ./nix/pi-acp-delivery.patch
              ./nix/pi-acp-mcp.patch
            ];
            npmDepsHash = "sha256-/fX79XucKojL/6gZbK5eizEfrXso8rlTgiHfJffmDuY=";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            preBuild = "npm run typecheck";
            npmBuildScript = "build";
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm test
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin $out/lib/pi-acp
              cp dist/index.js package.json $out/lib/pi-acp/
              npm prune --omit=dev --offline
              cp -r node_modules $out/lib/pi-acp/node_modules
              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/pi-acp \
                --add-flags $out/lib/pi-acp/index.js
              runHook postInstall
            '';
            meta = {
              description = "ACP adapter for the Pi coding agent";
              homepage = "https://github.com/svkozak/pi-acp";
              license = nixpkgs.lib.licenses.mit;
              mainProgram = "pi-acp";
              platforms = systems;
            };
          };
          piss-web = pissWeb;
          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/pissd";
          meta.description = "Run the Piss control plane";
        };
      });

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          moduleEvaluation = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.piss = {
                  enable = true;
                  allowedUsers = [ "owner@example.com" ];
                  harness = "mock";
                  piCommand = nixpkgs.lib.getExe pkgs.pi-coding-agent;
                  workspaces.default = {
                    name = "Piss";
                    path = "/var/empty";
                  };
                };
              }
            ];
          };
        in
        {
          inherit (self.packages.${system}) piss piss-web pi-acp;
          nixos-module =
            assert moduleEvaluation.config.services.piss.port == 4318;
            assert moduleEvaluation.config.services.piss.tailscale.hostname == "piss";
            assert moduleEvaluation.config.services.piss.tailscale.stateName == "piss-tailscale";
            assert builtins.elem "piss-ocaml-tailscale-up.service"
              moduleEvaluation.config.systemd.user.services.piss-ocaml-tailscale-serve.requires;
            assert
              moduleEvaluation.config.systemd.user.services."piss-ocaml-worker@".serviceConfig.Restart
              == "on-failure";
            assert builtins.elem "-%h/.pi"
              moduleEvaluation.config.systemd.user.services."piss-ocaml-worker@".serviceConfig.ReadWritePaths;
            assert nixpkgs.lib.hasInfix "--default-harness mock"
              moduleEvaluation.config.systemd.user.services.piss-ocaml.serviceConfig.ExecStart;
            assert
              moduleEvaluation.config.systemd.user.timers.piss-ocaml-worker-upgrade.timerConfig.OnUnitActiveSec
              == "1min";
            let
              workerRunner = builtins.head (
                nixpkgs.lib.splitString " "
                  moduleEvaluation.config.systemd.user.services."piss-ocaml-worker@".serviceConfig.ExecStart
              );
              upgradeRunner =
                moduleEvaluation.config.systemd.user.services.piss-ocaml-worker-upgrade.serviceConfig.ExecStart;
              tailscaleUpRunner =
                moduleEvaluation.config.systemd.user.services.piss-ocaml-tailscale-up.serviceConfig.ExecStart;
            in
            pkgs.runCommand "piss-nixos-module-check" { } ''
              grep -F -- 'STATE_DIRECTORY' ${workerRunner}
              grep -F -- 'for suffix in "" -wal -shm' ${workerRunner}
              grep -F -- '--harness-arg acp' ${workerRunner}
              grep -F -- 'prepare_upgrade' ${upgradeRunner}
              grep -F -- 'systemctl --user restart' ${upgradeRunner}
              grep -F -- ' set ' ${tailscaleUpRunner}
              grep -F -- '--hostname=piss' ${tailscaleUpRunner}
              touch $out
            '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ocamlPackages = pkgs.ocaml-ng.ocamlPackages_5_2;
          bonsaiWeb = import ./nix/bonsai-web.nix { inherit pkgs; };
          ocamlLspPackages = nixpkgs-ocaml-lsp.legacyPackages.${system}.ocaml-ng.ocamlPackages_5_2;
          ocamlLsp = pkgs.writeShellScriptBin "ocamllsp" ''
            set -euo pipefail

            if [[ "''${1:-}" == "--version" ]]; then
              exec ${ocamlLspPackages.ocaml-lsp}/bin/ocamllsp "$@"
            fi

            project_root=$PWD
            if [[ ! -f "$project_root/dune-project" ]]; then
              exec ${ocamlLspPackages.ocaml-lsp}/bin/ocamllsp "$@"
            fi

            state_dir="''${XDG_STATE_HOME:-$HOME/.local/state}/piss/ocamllsp"
            mkdir -p "$state_dir"
            project_key=$(printf '%s' "$project_root" | sha256sum | cut -c1-16)
            watch_log="$state_dir/dune-$project_key.log"

            ${ocamlPackages.dune_3}/bin/dune build --root "$project_root" \
              --watch --display=quiet >"$watch_log" 2>&1 &
            dune_pid=$!

            cleanup() {
              kill "$dune_pid" 2>/dev/null || true
              wait "$dune_pid" 2>/dev/null || true
            }
            trap cleanup EXIT INT TERM

            rpc_registry="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/dune/rpc"
            for _ in $(seq 1 100); do
              [[ -f "$rpc_registry/$dune_pid.csexp" ]] && break
              kill -0 "$dune_pid" 2>/dev/null || break
              sleep 0.05
            done
            rpc_available=false
            for rpc_file in "$rpc_registry"/*.csexp; do
              if [[ -f "$rpc_file" ]]; then
                rpc_available=true
                break
              fi
            done
            if [[ ! -f "$rpc_registry/$dune_pid.csexp" ]] && ! $rpc_available; then
              printf 'Dune RPC did not start for %s. Watcher output:\n' \
                "$project_root" >&2
              tail -n 40 "$watch_log" >&2 || true
              exit 1
            fi

            for _ in $(seq 1 2400); do
              grep -Eq 'Success|waiting for filesystem changes' "$watch_log" && break
              kill -0 "$dune_pid" 2>/dev/null || break
              sleep 0.05
            done

            # OCaml-LSP 1.21 discovers Merlin configurations through Dune RPC.
            # Keep one watcher beside the LSP process so Neovim gets project
            # types without requiring a separate `dune build --watch` command.
            ${ocamlLspPackages.ocaml-lsp}/bin/ocamllsp "$@"
          '';
        in
        {
          default = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.piss ];
            packages = [
              ocamlPackages.ocaml
              ocamlPackages.dune_3
              ocamlLsp
              ocamlPackages.ocamlformat
              ocamlPackages.utop
              pkgs.chromium
              pkgs.curl
              pkgs.jq
              pkgs.just
              pkgs.nodejs_24
            ];
            PLAYWRIGHT_CORE_PATH = "${pkgs.playwright}";
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
          };
          web = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.piss-web ];
            packages = [
              bonsaiWeb.ocamlPackages.ocaml
              bonsaiWeb.ocamlPackages.dune_3
              ocamlLsp
              bonsaiWeb.ocamlPackages.ocamlformat
            ];
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      nixosModules.default = import ./nix/nixos-module.nix self;
    };
}
