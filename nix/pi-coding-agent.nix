{
  config,
  lib,
  pkgs,
  ...
}: let
  piCfg = config.programs.pi-coding-agent;
  piAgentSource = ./pi-coding-agent;
  kotlinLsp = pkgs.callPackage ./kotlin-lsp.nix {};

  piAgentDir = pkgs.runCommand "pi-agent-dir" {} ''
    mkdir -p $out
    cp -R ${piAgentSource}/components $out/components
    cp -R ${piAgentSource}/extensions $out/extensions
  '';

  vscodeLangservers = pkgs.runCommand "vscode-langservers-extracted-node22" {} ''
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

  settings = {
    theme = lib.mkDefault "gruvbox";
    hideThinkingBlock = lib.mkDefault false;
    enableSkillCommands = lib.mkDefault true;
    packages = ["npm:pi-web-access@0.13.0"];
  };

  piExtraPackages = [
    pkgs.alejandra
    pkgs.basedpyright
    pkgs.bash-language-server
    pkgs.cargo
    pkgs.clang-tools
    pkgs.clippy
    pkgs.delta
    (pkgs.lib.lowPrio pkgs.dotnet-sdk)
    pkgs.ffmpeg
    kotlinLsp
    pkgs.ktlint
    pkgs.lua-language-server
    pkgs.marksman
    pkgs.nixd
    pkgs.prettier
    pkgs.roslyn-ls
    pkgs.ruff
    pkgs.rust-analyzer
    pkgs.rustc
    pkgs.rustfmt
    pkgs.shfmt
    pkgs.sourcekit-lsp
    pkgs.swift
    pkgs.swiftpm
    pkgs.sqlfluff
    pkgs.stylua
    pkgs.swiftlint
    pkgs.terraform
    pkgs.terraform-ls
    vscodeLangservers
    pkgs.vtsls
    pkgs.yaml-language-server
    pkgs.yt-dlp
  ];

  impeccableBuildNpmPackage = pkgs.buildNpmPackage.override {nodejs = pkgs.nodejs_24;};
  impeccablePiSkill = impeccableBuildNpmPackage rec {
    pname = "impeccable-pi-skill";
    version = "3.9.1";

    src = pkgs.fetchFromGitHub {
      owner = "pbakaus";
      repo = "impeccable";
      rev = "skill-v${version}";
      hash = "sha256-YNNxyGiB5w4K8t/eRnD6wsW3Ot4ZQXPqg8IkPz730D4=";
    };

    postPatch = ''
      cp ${./impeccable/package-lock.json} package-lock.json
    '';

    npmDepsHash = "sha256-jDvanWIcycPPwOMVSdpTsrEbpaHct9d+G2eNZnCcNcM=";
    dontNpmBuild = true;
    PUPPETEER_SKIP_DOWNLOAD = "1";

    installPhase = ''
      runHook preInstall

      node scripts/build.js --skip-root-sync
      mkdir -p $out
      cp -R dist/pi/.pi/skills/impeccable/* $out/

      while IFS= read -r file; do
        substituteInPlace "$file" \
          --replace-quiet 'node .pi/skills/impeccable/scripts/' 'node ./scripts/' \
          --replace-quiet 'Bash(node .pi/skills/impeccable/scripts/*)' 'Bash(node ./scripts/*)'
      done < <(find $out -name '*.md')

      runHook postInstall
    '';
  };

  localSkillsDir = ../skills;
  localSkillEntries = builtins.readDir localSkillsDir;
  localSkillNames =
    builtins.filter (name: localSkillEntries.${name} == "directory")
    (builtins.attrNames localSkillEntries);
  piSkills = pkgs.linkFarm "pi-skills" (
    map (name: {
      inherit name;
      path = localSkillsDir + "/${name}";
    })
    localSkillNames
    ++ [
      {
        name = "impeccable";
        path = impeccablePiSkill;
      }
      {
        name = "playwright-cli";
        path = pkgs.playwright-cli + "/share/opencode/skills/playwright-cli";
      }
    ]
  );

  gruvboxTheme = {
    "$schema" = "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";
    name = "gruvbox";
    vars = {
      bg = "#282828";
      bg1 = "#3c3836";
      bg2 = "#504945";
      bg3 = "#665c54";
      fg = "#ebdbb2";
      fg0 = "#fbf1c7";
      fg2 = "#d5c4a1";
      fg4 = "#a89984";
      red = "#cc241d";
      green = "#98971a";
      yellow = "#d79921";
      blue = "#458588";
      purple = "#b16286";
      aqua = "#689d6a";
      orange = "#d65d0e";
      gray = "#a89984";
      brightred = "#fb4934";
      brightgreen = "#b8bb26";
      brightyellow = "#fabd2f";
      brightblue = "#83a598";
      brightpurple = "#d3869b";
      brightaqua = "#8ec07c";
      brightgray = "#928374";
    };
    colors = {
      accent = "yellow";
      border = "bg3";
      borderAccent = "yellow";
      borderMuted = "bg2";
      success = "green";
      error = "red";
      warning = "orange";
      muted = "gray";
      dim = "fg4";
      text = "";
      thinkingText = "fg2";
      selectedBg = "bg2";
      userMessageBg = "bg1";
      userMessageText = "";
      customMessageBg = "bg1";
      customMessageText = "";
      customMessageLabel = "yellow";
      toolPendingBg = "bg1";
      toolSuccessBg = "bg1";
      toolErrorBg = "bg1";
      toolTitle = "yellow";
      toolOutput = "";
      mdHeading = "orange";
      mdLink = "blue";
      mdLinkUrl = "aqua";
      mdCode = "yellow";
      mdCodeBlock = "";
      mdCodeBlockBorder = "bg3";
      mdQuote = "fg2";
      mdQuoteBorder = "gray";
      mdHr = "bg3";
      mdListBullet = "yellow";
      toolDiffAdded = "green";
      toolDiffRemoved = "red";
      toolDiffContext = "gray";
      syntaxComment = "gray";
      syntaxKeyword = "red";
      syntaxFunction = "blue";
      syntaxVariable = "fg";
      syntaxString = "green";
      syntaxNumber = "purple";
      syntaxType = "yellow";
      syntaxOperator = "orange";
      syntaxPunctuation = "fg4";
      thinkingOff = "bg3";
      thinkingMinimal = "brightgray";
      thinkingLow = "blue";
      thinkingMedium = "brightblue";
      thinkingHigh = "brightpurple";
      thinkingXhigh = "brightred";
      bashMode = "orange";
    };
    export = {
      pageBg = "#282828";
      cardBg = "#3c3836";
      infoBg = "#504945";
    };
  };
in {
  config = {
    programs.pi-coding-agent = {
      enable = true;
      context = ../global-instructions.md;
      extraPackages = piExtraPackages;
      inherit settings;
    };

    home.sessionVariables.PI_SKIP_VERSION_CHECK = lib.mkDefault "1";
    home.packages = lib.mkIf (piCfg.package == null) piExtraPackages;

    home.file = {
      "${piCfg.configDir}/themes/gruvbox.json".text = builtins.toJSON gruvboxTheme;
      "${piCfg.configDir}/components".source = piAgentDir + "/components";
      "${piCfg.configDir}/extensions".source = piAgentDir + "/extensions";
      "${piCfg.configDir}/skills".source = piSkills;
      "${piCfg.configDir}/prompts".source = ../prompts;
    };
  };
}
