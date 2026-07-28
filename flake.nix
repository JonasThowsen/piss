{
  description = "PISS — Pi sin sidecar";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
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
        in
        rec {
          piss = pkgs.buildNpmPackage {
            pname = "piss";
            version = "0.1.0";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./CONTRIBUTING.md
                ./LICENSE
                ./README.md
                ./SECURITY.md
                ./package.json
                ./package-lock.json
                ./playwright.config.ts
                ./tsconfig.json
                ./vite.config.ts
                ./extensions
                ./server
                ./shared
                ./test
                ./v2
                ./web
              ];
            };
            npmDepsHash = "sha256-oJqs2sCjZ37c0fm/BYqrqBlGuEHPYKiJulT9g4IuBrg=";
            npmDepsFetcherVersion = 2;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            nativeCheckInputs = [
              pkgs.gitMinimal
              pkgs.bubblewrap
            ];
            npmBuildScript = "build";
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm run check
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin $out/lib/piss
              cp dist/server.js $out/lib/piss/server.js
              cp -r dist/public $out/lib/piss/public

              # Keep the Pi package at the output root. Pi provides the optional
              # coding-agent peer; prune and retain PISS's server dependencies.
              cp CONTRIBUTING.md LICENSE README.md SECURITY.md package.json $out/
              cp -r extensions shared $out/
              npm prune --omit=dev --offline
              cp -r node_modules $out/node_modules

              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss \
                --add-flags $out/lib/piss/server.js

              runHook postInstall
            '';
            meta = {
              description = "Pi sin sidecar — private web control for live Pi sessions";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              mainProgram = "piss";
              platforms = systems;
            };
          };

          # Keep the V2 server and browser shell in separate derivations. The
          # NixOS module can then update browser assets without restarting the
          # process that owns active Pi runtimes.
          piss-v2-server = pkgs.buildNpmPackage {
            pname = "piss-v2-server";
            version = "0.0.1";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./package.json
                ./package-lock.json
                ./server/browser-auth.ts
                ./shared
                ./v2/server
                ./v2/shared
              ];
            };
            npmDepsHash = "sha256-oJqs2sCjZ37c0fm/BYqrqBlGuEHPYKiJulT9g4IuBrg=";
            npmDepsFetcherVersion = 2;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            npmBuildScript = "build:v2:server";
            doCheck = false;
            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin $out/lib/piss-v2
              cp dist-v2/server.js $out/lib/piss-v2/server.js
              npm prune --omit=dev --offline
              cp -r node_modules $out/lib/piss-v2/node_modules

              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss-v2 \
                --add-flags $out/lib/piss-v2/server.js \
                --prefix NODE_PATH : $out/lib/piss-v2/node_modules \
                --prefix PATH : ${
                  nixpkgs.lib.makeBinPath [
                    pkgs.gitMinimal
                    pkgs.bubblewrap
                  ]
                }

              runHook postInstall
            '';
            meta = {
              description = "Effect-based PISS V2 runtime server";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              mainProgram = "piss-v2";
              platforms = systems;
            };
          };

          piss-v2-web = pkgs.buildNpmPackage {
            pname = "piss-v2-web";
            version = "0.0.1";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./package.json
                ./package-lock.json
                ./v2/vite.config.ts
                ./v2/shared
                ./v2/web
              ];
            };
            npmDepsHash = "sha256-oJqs2sCjZ37c0fm/BYqrqBlGuEHPYKiJulT9g4IuBrg=";
            npmDepsFetcherVersion = 2;
            npmBuildScript = "build:v2:web";
            doCheck = false;
            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/piss-v2
              cp -r dist-v2/public $out/share/piss-v2/public

              runHook postInstall
            '';
            meta = {
              description = "PISS V2 browser shell";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              platforms = systems;
            };
          };

          piss-v2 = pkgs.buildNpmPackage {
            pname = "piss-v2";
            version = "0.0.1";
            src = nixpkgs.lib.fileset.toSource {
              root = ./.;
              fileset = nixpkgs.lib.fileset.unions [
                ./package.json
                ./package-lock.json
                ./playwright.config.ts
                ./tsconfig.json
                ./vite.config.ts
                ./extensions
                ./server
                ./shared
                ./test
                ./v2
                ./web
              ];
            };
            npmDepsHash = "sha256-oJqs2sCjZ37c0fm/BYqrqBlGuEHPYKiJulT9g4IuBrg=";
            npmDepsFetcherVersion = 2;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            nativeCheckInputs = [
              pkgs.chromium
              pkgs.fontconfig
              pkgs.dejavu_fonts
              pkgs.gitMinimal
              pkgs.bubblewrap
            ];
            PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
            FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
            npmBuildScript = "build:v2";
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm run check
              npm run test:browser
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall

              mkdir -p $out/bin $out/lib/piss-v2
              cp dist-v2/server.js $out/lib/piss-v2/server.js
              cp -r dist-v2/public $out/lib/piss-v2/public
              npm prune --omit=dev --offline
              cp -r node_modules $out/lib/piss-v2/node_modules

              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/piss-v2 \
                --add-flags $out/lib/piss-v2/server.js \
                --set PISS_V2_PUBLIC_DIR $out/lib/piss-v2/public \
                --prefix NODE_PATH : $out/lib/piss-v2/node_modules \
                --prefix PATH : ${
                  nixpkgs.lib.makeBinPath [
                    pkgs.gitMinimal
                    pkgs.bubblewrap
                  ]
                }

              runHook postInstall
            '';
            meta = {
              description = "Effect-based PISS V2 workspace control plane";
              homepage = "https://github.com/JonasThowsen/piss";
              license = nixpkgs.lib.licenses.mit;
              mainProgram = "piss-v2";
              platforms = systems;
            };
          };

          default = piss;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.piss}/bin/piss";
          meta.description = "Run PISS on loopback";
        };
        v2 = {
          type = "app";
          program = "${self.packages.${system}.piss-v2}/bin/piss-v2";
          meta.description = "Run the Effect-based PISS V2 control plane";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              chromium
              bubblewrap
              gitMinimal
              tailscale
              jq
              nixfmt
            ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              echo "PISS development shell — Node $(node --version)"
              echo "Run npm ci once, then npm run dev"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      overlays.default = final: _prev: {
        piss = self.packages.${final.stdenv.hostPlatform.system}.piss;
        piss-v2 = self.packages.${final.stdenv.hostPlatform.system}.piss-v2;
      };
      nixosModules = {
        default = import ./nix/nixos-module.nix self;
        v2 = import ./nix/nixos-v2-module.nix self;
      };
    };
}
