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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          source =
            files:
            nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions files;
            };
          playwrightFfmpeg = pkgs.runCommand "playwright-ffmpeg-1011" { } ''
            mkdir -p $out/ffmpeg-1011
            ln -s ${pkgs.ffmpeg}/bin/ffmpeg $out/ffmpeg-1011/ffmpeg-linux
          '';
          common = {
            version = "0.1.0";
            npmDepsHash = "sha256-AMohshQsdsjF4hK3/bWly258P2eOGLXuJI/jytGaqTw=";
            npmDepsFetcherVersion = 2;
          };
        in
        rec {
          opencode = opencode-src.packages.${system}.opencode;

          pi-acp = pkgs.buildNpmPackage {
            pname = "pi-acp";
            version = "0.0.33";
            src = pi-acp-src;
            npmDepsHash = "sha256-/fX79XucKojL/6gZbK5eizEfrXso8rlTgiHfJffmDuY=";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            npmBuildScript = "build";
            doCheck = false;
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

          piss-next-native = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-next";
            version = "0.1.0-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./LICENSE
              ./next
            ];
            propagatedBuildInputs = with pkgs.ocamlPackages; [
              eio_main
              cohttp-eio
              yojson
              ocaml_sqlite3
              logs
              fmt
            ];
            checkInputs = [ pkgs.ocamlPackages.alcotest ];
            doCheck = true;
            meta = {
              description = "Combined OCaml PISS development and test package";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              platforms = systems;
            };
          };

          piss-next-control = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-next";
            version = "0.1.0-control-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./LICENSE
              ./next/lib
              ./next/control
            ];
            propagatedBuildInputs = piss-next-native.propagatedBuildInputs;
            doCheck = false;
            meta = piss-next-native.meta // {
              description = "Replaceable OCaml PISS control plane";
              mainProgram = "pissd-next";
            };
          };

          piss-next-worker = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-next";
            version = "0.1.0-worker-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./LICENSE
              ./next/lib
              ./next/worker
            ];
            propagatedBuildInputs = piss-next-native.propagatedBuildInputs;
            doCheck = false;
            meta = piss-next-native.meta // {
              description = "Independently supervised OCaml PISS session worker";
              mainProgram = "piss-session-worker";
            };
          };

          piss-next-session-mcp = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-next";
            version = "0.1.0-session-mcp-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./LICENSE
              ./next/session_mcp
            ];
            propagatedBuildInputs = [ pkgs.ocamlPackages.yojson ];
            doCheck = false;
            meta = piss-next-native.meta // {
              description = "Harness-neutral MCP server for PISS session collaboration";
              mainProgram = "piss-session-mcp";
            };
          };

          piss-next-mock-agent = pkgs.ocamlPackages.buildDunePackage {
            pname = "piss-next";
            version = "0.1.0-mock-agent-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./LICENSE
              ./next/lib
              ./next/mock_agent
            ];
            propagatedBuildInputs = piss-next-native.propagatedBuildInputs;
            doCheck = false;
            meta = piss-next-native.meta // {
              description = "Deterministic ACP fixture for PISS integration tests";
              mainProgram = "piss-mock-agent";
            };
          };

          piss-next-web = pkgs.buildNpmPackage {
            pname = "piss-next-web";
            version = "0.1.0-tracer";
            src = source [
              ./.ocamlformat
              ./dune-project
              ./piss-next.opam
              ./package.json
              ./package-lock.json
              ./web-next
            ];
            inherit (common) npmDepsHash npmDepsFetcherVersion;
            nativeBuildInputs = [
              pkgs.dune_3
              pkgs.esbuild
              pkgs.ocamlPackages.ocaml
              pkgs.ocamlPackages.melange
              pkgs.ocamlPackages.reason
            ];
            buildInputs = nixpkgs.lib.closePropagation (
              with pkgs.ocamlPackages;
              [
                melange
                reason
                reason-react
                reason-react-ppx
              ]
            );
            OCAMLPATH = nixpkgs.lib.makeSearchPath "lib/ocaml/${pkgs.ocamlPackages.ocaml.version}/site-lib" (
              nixpkgs.lib.closePropagation [
                pkgs.ocamlPackages.melange
                pkgs.ocamlPackages.reason
                pkgs.ocamlPackages.reason-react
                pkgs.ocamlPackages.reason-react-ppx
              ]
            );
            npmBuildScript = "build:next:web";
            doCheck = false;
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/piss-next/public
              cp -r web-next/public/. $out/share/piss-next/public/
              cp _build/default/web-next/app.js $out/share/piss-next/public/app.js
              runHook postInstall
            '';
            meta = {
              description = "OCaml/Melange browser shell for the PISS rewrite";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              platforms = systems;
            };
          };

          piss-server = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss-server";
              src = source [
                ./package.json
                ./package-lock.json
                ./server
                ./shared
                ./workflow-resources
              ];
              nativeBuildInputs = [ pkgs.makeWrapper ];
              npmBuildScript = "build:server";
              doCheck = false;
              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin $out/lib/piss
                cp dist/server.js $out/lib/piss/server.js
                cp -r workflow-resources $out/lib/piss/workflow-resources
                npm prune --omit=dev --offline
                cp -r node_modules $out/lib/piss/node_modules

                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                  --add-flags $out/lib/piss/server.js \
                  --set PISS_WORKFLOW_RESOURCE_DIR $out/lib/piss/workflow-resources \
                  --set PISS_BROWSER_EXECUTABLE_PATH ${pkgs.chromium}/bin/chromium \
                  --set PISS_BROWSER_FFMPEG_PATH ${pkgs.ffmpeg}/bin/ffmpeg \
                  --set PISS_BROWSER_FFPROBE_PATH ${pkgs.ffmpeg}/bin/ffprobe \
                  --set PLAYWRIGHT_BROWSERS_PATH ${playwrightFfmpeg} \
                  --prefix NODE_PATH : $out/lib/piss/node_modules \
                  --prefix PATH : ${
                    nixpkgs.lib.makeBinPath [
                      pkgs.gitMinimal
                      pkgs.bubblewrap
                      pkgs.ffmpeg
                    ]
                  }

                runHook postInstall
              '';
              meta = {
                description = "Effect-based PISS runtime server";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                mainProgram = "piss";
                platforms = systems;
              };
            }
          );

          piss-web = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss-web";
              src = source [
                ./package.json
                ./package-lock.json
                ./vite.config.ts
                ./shared
                ./web
              ];
              npmBuildScript = "build:web";
              doCheck = false;
              installPhase = ''
                runHook preInstall

                mkdir -p $out/share/piss
                cp -r dist/public $out/share/piss/public

                runHook postInstall
              '';
              meta = {
                description = "PISS browser shell";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                platforms = systems;
              };
            }
          );

          piss = pkgs.buildNpmPackage (
            common
            // {
              pname = "piss";
              src = source [
                ./CONTRIBUTING.md
                ./LICENSE
                ./README.md
                ./SECURITY.md
                ./package.json
                ./package-lock.json
                ./playwright.config.ts
                ./tsconfig.json
                ./vite.config.ts
                ./browser-test
                ./server
                ./shared
                ./test
                ./web
                ./workflow-resources
              ];
              nativeBuildInputs = [ pkgs.makeWrapper ];
              nativeCheckInputs = [
                pkgs.chromium
                pkgs.ffmpeg
                pkgs.fontconfig
                pkgs.dejavu_fonts
                pkgs.gitMinimal
                pkgs.bubblewrap
              ];
              PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
              FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
              npmBuildScript = "build";
              doCheck = true;
              checkPhase = ''
                runHook preCheck
                # Nix's build network namespace has no usable loopback device,
                # so TCP-backed Chromium/PWA tests run via the canonical dev-shell
                # commands rather than being made less realistic with mocks here.
                PISS_SKIP_NETWORK_TESTS=1 npm run check
                ${pkgs.chromium}/bin/chromium --version
                runHook postCheck
              '';
              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin $out/lib/piss
                cp dist/server.js $out/lib/piss/server.js
                cp -r dist/public $out/lib/piss/public
                cp -r workflow-resources $out/lib/piss/workflow-resources
                npm prune --omit=dev --offline
                cp -r node_modules $out/lib/piss/node_modules

                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                  --add-flags $out/lib/piss/server.js \
                  --set PISS_PUBLIC_DIR $out/lib/piss/public \
                  --set PISS_WORKFLOW_RESOURCE_DIR $out/lib/piss/workflow-resources \
                  --set PISS_BROWSER_EXECUTABLE_PATH ${pkgs.chromium}/bin/chromium \
                  --set PISS_BROWSER_FFMPEG_PATH ${pkgs.ffmpeg}/bin/ffmpeg \
                  --set PISS_BROWSER_FFPROBE_PATH ${pkgs.ffmpeg}/bin/ffprobe \
                  --set PLAYWRIGHT_BROWSERS_PATH ${playwrightFfmpeg} \
                  --prefix NODE_PATH : $out/lib/piss/node_modules \
                  --prefix PATH : ${
                    nixpkgs.lib.makeBinPath [
                      pkgs.gitMinimal
                      pkgs.bubblewrap
                      pkgs.ffmpeg
                    ]
                  }

                runHook postInstall
              '';
              meta = {
                description = "Effect-based PISS workspace control plane";
                homepage = "https://github.com/JonasThowsen/piss";
                license = nixpkgs.lib.licenses.mit;
                mainProgram = "piss";
                platforms = systems;
              };
            }
          );

          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/piss";
          meta.description = "Run the Effect-based PISS control plane";
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
                  environmentFiles = [ "/run/secrets/piss-api-keys.env" ];
                  sshAgentSocket = "/run/user/1000/ssh-agent";
                };
              }
            ];
          };
          nextModuleEvaluation = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.next
              {
                services.piss-next = {
                  enable = true;
                  allowedUsers = [ "owner@example.com" ];
                  harness = "mock";
                };
              }
            ];
          };
          opencodeModuleEvaluation = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.next
              {
                services.piss-next = {
                  enable = true;
                  allowedUsers = [ "owner@example.com" ];
                  harness = "opencode";
                };
              }
            ];
          };
        in
        {
          piss-next-native = self.packages.${system}.piss-next-native;
          piss-next-control = self.packages.${system}.piss-next-control;
          piss-next-worker = self.packages.${system}.piss-next-worker;
          piss-next-mock-agent = self.packages.${system}.piss-next-mock-agent;
          piss-next-session-mcp = self.packages.${system}.piss-next-session-mcp;
          piss-next-web = self.packages.${system}.piss-next-web;
          nixos-module =
            assert
              moduleEvaluation.config.systemd.user.services.piss.serviceConfig.EnvironmentFile == [
                "/run/secrets/piss-api-keys.env"
              ]
              &&
                moduleEvaluation.config.systemd.user.services.piss.environment.PISS_SSH_AUTH_SOCK
                == "/run/user/1000/ssh-agent"
              &&
                moduleEvaluation.config.systemd.user.services.piss.environment.SSH_AUTH_SOCK
                == "/run/user/1000/ssh-agent";
            pkgs.runCommand "piss-nixos-module-check" { } "touch $out";
          piss-next-nixos-module =
            assert nextModuleEvaluation.config.services.piss-next.port == 4318;
            assert nextModuleEvaluation.config.services.piss-next.tailscale.hostname == "piss-ocaml";
            assert
              nextModuleEvaluation.config.systemd.user.services."piss-ocaml-worker@".serviceConfig.Restart
              == "on-failure";
            assert nixpkgs.lib.hasInfix "--available-harness opencode"
              nextModuleEvaluation.config.systemd.user.services.piss-ocaml.serviceConfig.ExecStart;
            assert nixpkgs.lib.hasInfix "--default-harness opencode"
              opencodeModuleEvaluation.config.systemd.user.services.piss-ocaml.serviceConfig.ExecStart;
            pkgs.runCommand "piss-next-nixos-module-check" { } "touch $out";
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          playwrightFfmpeg = pkgs.runCommand "playwright-ffmpeg-1011" { } ''
            mkdir -p $out/ffmpeg-1011
            ln -s ${pkgs.ffmpeg}/bin/ffmpeg $out/ffmpeg-1011/ffmpeg-linux
          '';
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              chromium
              ffmpeg
              bubblewrap
              gitMinimal
              tailscale
              jq
              nixfmt
              dune_3
              esbuild
              ocamlPackages.ocaml
              ocamlPackages.findlib
              ocamlPackages.ocamlformat
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
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              export PISS_BROWSER_FFMPEG_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
              export PISS_BROWSER_FFPROBE_PATH="${pkgs.ffmpeg}/bin/ffprobe"
              export PLAYWRIGHT_BROWSERS_PATH="${playwrightFfmpeg}"
              echo "PISS development shell — Node $(node --version), OCaml $(ocamlc -version)"
              echo "Run npm ci once for the legacy app; use dune build @all for the rewrite"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      overlays.default = final: _prev: {
        piss = self.packages.${final.stdenv.hostPlatform.system}.piss;
        piss-server = self.packages.${final.stdenv.hostPlatform.system}.piss-server;
        piss-web = self.packages.${final.stdenv.hostPlatform.system}.piss-web;
      };
      nixosModules = {
        default = import ./nix/nixos-module.nix self;
        next = import ./nix/nixos-next-module.nix self;
      };
    };
}
