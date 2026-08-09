{
  description = "PISS — Pi sin sidecar";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pi-acp-src = {
      url = "github:svkozak/pi-acp";
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
      pi-acp-src,
      opencode-src,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      source = files: nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions files;
      };
      ocamlSource = source [
        ./.ocamlformat
        ./dune-project
        ./LICENSE
        ./src
      ];
      webSource = source [
        ./.ocamlformat
        ./dune-project
        ./package.json
        ./web
      ];
      styled-ppx = system: import ./nix/styled-ppx.nix nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          ocamlDeps = with pkgs.ocamlPackages; [
            eio_main
            cohttp-eio
            yojson
            ocaml_sqlite3
            logs
            fmt
            alcotest
          ];
          webDeps = with pkgs.ocamlPackages; [
            melange
            reason
            reason-react
            reason-react-ppx
          ] ++ [ (styled-ppx system) ];
          buildDuneExe =
            {
              pname,
              version ? "0.1.0-tracer",
              binary,
              extraFiles ? [ ],
              extraBuildInputs ? [ ],
              description,
            }:
            pkgs.ocamlPackages.buildDunePackage {
              inherit pname version;
              src = ocamlSource;
              buildInputs = ocamlDeps ++ extraBuildInputs;
              doCheck = false;
              installPhase = ''
                runHook preInstall
                mkdir -p $out/bin $out/lib/${pname}
                cp _build/default/${binary} $out/bin/${pname}
                ${pkgs.lib.concatMapStringsSep "\n" (f: "cp -r ${f} $out/lib/${pname}/") extraFiles}
                runHook postInstall
              '';
              meta = {
                inherit description;
                license = pkgs.lib.licenses.mit;
                mainProgram = pname;
                platforms = systems;
              };
            };
        in
        {
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
              license = pkgs.lib.licenses.mit;
              mainProgram = "pi-acp";
              platforms = systems;
            };
          };

          opencode = opencode-src.packages.${system}.opencode;

          piss-core = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-core";
            version = "0.1.0-tracer";
            src = ocamlSource;
            buildInputs = ocamlDeps;
            doCheck = false;
            meta = {
              description = "Shared OCaml types, protocols, and SQLite stores for PISS.";
              license = pkgs.lib.licenses.mit;
              platforms = systems;
            };
          };

          piss-control = buildDuneExe {
            pname = "piss-control";
            binary = "src/control/main.exe";
            description = "Replaceable OCaml PISS control plane.";
          };

          piss-worker = buildDuneExe {
            pname = "piss-session-worker";
            binary = "src/worker/main.exe";
            description = "Independently supervised OCaml PISS session worker.";
          };

          piss-session-mcp = buildDuneExe {
            pname = "piss-session-mcp";
            binary = "src/session_mcp/main.exe";
            description = "Harness-neutral MCP server for PISS session collaboration.";
          };

          piss-mock-agent = buildDuneExe {
            pname = "piss-mock-agent";
            binary = "src/mock_agent/main.exe";
            description = "Deterministic ACP fixture for PISS integration tests.";
          };

          piss-web = pkgs.buildNpmPackage {
            pname = "piss-web";
            version = "0.1.0-tracer";
            src = webSource;
            nativeBuildInputs = [
              pkgs.dune_3
              pkgs.esbuild
              pkgs.ocamlPackages.ocaml
            ] ++ webDeps;
            OCAMLPATH = pkgs.lib.makeSearchPath
              "lib/ocaml/${pkgs.ocamlPackages.ocaml.version}/site-lib"
              webDeps;
            npmBuildScript = "build:web";
            doCheck = false;
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/piss
              cp -r web/public $out/share/piss/public
              cp _build/default/web/app.js $out/share/piss/public/app.js
              runHook postInstall
            '';
            meta = {
              description = "OCaml/Melange browser shell for the PISS rewrite.";
              homepage = "https://github.com/JonasThowsen/piss";
              license = pkgs.lib.licenses.mit;
              platforms = systems;
            };
          };

          default = self.packages.${system}.piss-control;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss-control}/bin/main.exe";
          meta.description = "Run the OCaml PISS control plane.";
        };
      });

      checks = forAllSystems (system: let
        pkgs = nixpkgs.legacyPackages.${system};
        moduleEvaluation = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.default
            {
              services.piss = {
                enable = true;
                allowedUsers = [ "owner@example.com" ];
                environmentFiles = [ "/run/secrets/piss-api-keys.env" ];
                sshAgentSocket = "/run/user/1000/ssh-agent";
              };
            }
          ];
        };
      in {
        piss-core = self.packages.${system}.piss-core;
        piss-control = self.packages.${system}.piss-control;
        piss-worker = self.packages.${system}.piss-worker;
        piss-session-mcp = self.packages.${system}.piss-session-mcp;
        piss-mock-agent = self.packages.${system}.piss-mock-agent;
        piss-web = self.packages.${system}.piss-web;
        nixos-module = assert
          moduleEvaluation.config.systemd.user.services."piss-worker@".serviceConfig.EnvironmentFile == [ "/run/secrets/piss-api-keys.env" ] &&
          moduleEvaluation.config.services.piss.sshAgentSocket == "/run/user/1000/ssh-agent" &&
          moduleEvaluation.config.services.piss.enable == true;
        pkgs.runCommand "piss-nixos-module-check" { } "touch $out";
      });

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              opam
              chromium
              ffmpeg
              bubblewrap
              gitMinimal
              tailscale
              jq
              nixfmt
              ocamlPackages.ocaml
              ocamlPackages.ocamlformat
              ocamlPackages.ocaml-lsp
              ocamlPackages.eio_main
              ocamlPackages.cohttp-eio
              ocamlPackages.yojson
              ocamlPackages.ocaml_sqlite3
              ocamlPackages.logs
              ocamlPackages.fmt
              ocamlPackages.alcotest
              ocamlPackages.melange
              ocamlPackages.reason
              ocamlPackages.reason-react
              ocamlPackages.reason-react-ppx
              (styled-ppx system)
            ];
            shellHook = ''
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              export PISS_BROWSER_FFMPEG_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
              export PISS_BROWSER_FFPROBE_PATH="${pkgs.ffmpeg}/bin/ffprobe"
              echo "PISS development shell — install OCaml deps with: just switch"
            '';
          };
        });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      overlays.default = final: _prev: {
        piss = self.packages.${final.stdenv.hostPlatform.system}.piss-control;
        piss-core = self.packages.${final.stdenv.hostPlatform.system}.piss-core;
        piss-control = self.packages.${final.stdenv.hostPlatform.system}.piss-control;
        piss-worker = self.packages.${final.stdenv.hostPlatform.system}.piss-worker;
        piss-session-mcp = self.packages.${final.stdenv.hostPlatform.system}.piss-session-mcp;
        piss-mock-agent = self.packages.${final.stdenv.hostPlatform.system}.piss-mock-agent;
        piss-web = self.packages.${final.stdenv.hostPlatform.system}.piss-web;
      };
      nixosModules.default = import ./nix/nixos-module.nix self;
    };
}
