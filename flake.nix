{
  description = "AI skills, prompts, and OpenCode module";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = {
    self,
    nixpkgs,
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
    lspTestPackages = pkgs: [
      pkgs.basedpyright
      pkgs.bash-language-server
      pkgs.clang-tools
      pkgs.kotlin-language-server
      pkgs.lua-language-server
      pkgs.marksman
      pkgs.nixd
      pkgs.nodejs_24
      pkgs.roslyn-ls
      pkgs.ruff
      pkgs.sourcekit-lsp
      pkgs.swift
      pkgs.swiftpm
      pkgs.terraform-ls
      (vscodeLangservers pkgs)
      pkgs.vtsls
      pkgs.yaml-language-server
    ];
  in {
    homeManagerModules = {
      opencode = import ./nix/opencode.nix;
      pi-coding-agent = import ./nix/pi-coding-agent.nix;
      default = self.homeManagerModules.opencode;
    };

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = lspTestPackages pkgs;
      };
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);

    files = {
      globalInstructions = builtins.readFile ./global-instructions.md;
    };
  };
}
