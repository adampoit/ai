{
  description = "AI skills, prompts, and OpenCode module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    unified-review = {
      url = "github:adampoit/unified-review.nvim";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    unified-review,
    ...
  }: let
    supportedSystems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    forAllSystems = function:
      nixpkgs.lib.genAttrs supportedSystems (system:
        function (import nixpkgs {inherit system;}));
    tuiTest = pkgs: let
      version = "0.1.0-beta.1";
      release =
        {
          aarch64-darwin = {
            target = "aarch64-apple-darwin";
            hash = "sha256-dTgneM5pSW4xfG8cRZ8TmY9hP8o9QzKXB2cODflsX64=";
          };
          x86_64-darwin = {
            target = "x86_64-apple-darwin";
            hash = "sha256-5I4SHpaR4BCOxeCaYA8hRPzOxclUwhePwPawAux67zM=";
          };
          aarch64-linux = {
            target = "aarch64-unknown-linux-musl";
            hash = "sha256-8KdCC1fYJgcfGPmqpSXWH/0sQ0aA5dllkV1CkVz/KJY=";
          };
          x86_64-linux = {
            target = "x86_64-unknown-linux-musl";
            hash = "sha256-grGMos4wtrrSdNcQkhva+Q41w2eqJXHYyKZJ/x/ZfFk=";
          };
        }.${
          pkgs.stdenv.hostPlatform.system
        };
    in
      pkgs.stdenvNoCC.mkDerivation {
        pname = "tui-test";
        inherit version;
        src = pkgs.fetchurl {
          url = "https://github.com/microsoft/tui-test/releases/download/${version}/tui-test-${release.target}.tar.gz";
          inherit (release) hash;
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 tui-test $out/bin/tui-test
          ln -s tui-test $out/bin/shell-use
          runHook postInstall
        '';
        meta = {
          description = "Headless terminal CLI for driving and testing terminal applications";
          homepage = "https://github.com/microsoft/tui-test";
          license = pkgs.lib.licenses.mit;
          mainProgram = "tui-test";
          platforms = supportedSystems;
        };
      };
    vscodeLangservers = pkgs:
      pkgs.runCommand "vscode-langservers-extracted-node22" {} ''
        mkdir -p $out
        cp -R ${pkgs.vscode-langservers-extracted}/* $out/
        chmod -R u+w $out

        writeWrapper() {
          local name="$1"
          local entrypoint="$2"
          printf '%s\n' \
            '#!${pkgs.runtimeShell}' \
            "exec ${pkgs.nodejs_22}/bin/node \"$out/lib/extensions/$entrypoint\" \"\$@\"" \
            > "$out/bin/$name"
          chmod +x "$out/bin/$name"
        }

        writeWrapper vscode-html-language-server html-language-features/server/dist/node/htmlServerMain.js
        writeWrapper vscode-css-language-server css-language-features/server/dist/node/cssServerMain.js
        writeWrapper vscode-json-language-server json-language-features/server/dist/node/jsonServerMain.js
        writeWrapper vscode-eslint-language-server eslint-language-features/server/out/eslintServer.js
      '';
    kotlinLsp = pkgs: pkgs.callPackage ./nix/kotlin-lsp.nix {};
    piPackage = pkgs: pkgs.callPackage ./nix/pi-coding-agent-package.nix {};
    piVersion = (import ./nix/pi-coding-agent-source.nix).version;
    packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    piNpmPackages = [
      "@earendil-works/pi-agent-core"
      "@earendil-works/pi-ai"
      "@earendil-works/pi-coding-agent"
      "@earendil-works/pi-tui"
    ];
    piVersionsMatch =
      builtins.all
      (package: packageJson.devDependencies.${package} == piVersion)
      piNpmPackages;
    xtermHeadless = pkgs: pkgs.callPackage ./nix/xterm-headless.nix {};
    lspTestPackages = pkgs: [
      pkgs.basedpyright
      pkgs.bash-language-server
      pkgs.cargo
      pkgs.clang-tools
      pkgs.clippy
      pkgs.delta
      pkgs.dotnet-sdk_9
      pkgs.git
      (kotlinLsp pkgs)
      pkgs.lua-language-server
      pkgs.marksman
      pkgs.nix-update
      pkgs.nixd
      pkgs.nodejs_24
      pkgs.roslyn-ls
      pkgs.ruff
      pkgs.rust-analyzer
      pkgs.rustc
      pkgs.sourcekit-lsp
      pkgs.swift
      pkgs.swiftpm
      pkgs.terraform-ls
      (vscodeLangservers pkgs)
      pkgs.vtsls
      pkgs.which
      pkgs.yaml-language-server
    ];
  in {
    homeManagerModules = {
      opencode = import ./nix/opencode.nix;
      pi-coding-agent = import ./nix/pi-coding-agent.nix {inherit piPackage unified-review;};
      default = self.homeManagerModules.opencode;
    };

    packages = forAllSystems (pkgs: {
      kotlin-lsp = kotlinLsp pkgs;
      pi-coding-agent = piPackage pkgs;
      tui-test = tuiTest pkgs;
      shell-use = tuiTest pkgs;
      xterm-headless = xtermHeadless pkgs;
      default = tuiTest pkgs;
    });

    checks = forAllSystems (pkgs: {
      pi-coding-agent = piPackage pkgs;
      pi-version-sync = pkgs.runCommand "pi-version-sync" {} (
        assert piVersionsMatch; ''touch $out''
      );
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages =
          lspTestPackages pkgs
          ++ [
            (tuiTest pkgs)
          ];
      };
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);

    files = {
      globalInstructions = builtins.readFile ./global-instructions.md;
    };
  };
}
