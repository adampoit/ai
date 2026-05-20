{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi;

  settings =
    {
      theme = "gruvbox";
      hideThinkingBlock = false;
      enableSkillCommands = true;
    }
    // lib.optionalAttrs (cfg.enabledModels != []) {
      enabledModels = cfg.enabledModels;
    };

  piAgentDir = pkgs.runCommand "pi-agent-dir" {} ''
    mkdir -p $out
    cp -R ${./pi/components} $out/components
    cp -R ${./pi/extensions} $out/extensions
  '';

  piSkills = pkgs.runCommand "pi-skills" {} ''
    mkdir -p $out
    cp -R ${../skills}/. $out/
    ln -s ${pkgs.playwright-cli}/share/opencode/skills/playwright-cli $out/playwright-cli
  '';

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
  options.programs.pi.enabledModels = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [];
    example = [
      "github-copilot/claude-opus-4.6"
      "openai-codex/gpt-5.5"
    ];
    description = ''
      Pi model IDs to enable in ~/.pi/agent/settings.json.
      Optional; if empty, no prioritized models are set.
    '';
  };

  config = {
    home.sessionVariables.PI_SKIP_VERSION_CHECK = "1";

    home.packages = [
      pkgs.alejandra
      pkgs.clang-tools
      pkgs.delta
      (pkgs.lib.lowPrio pkgs.dotnet-sdk)
      pkgs.ktlint
      pkgs.lua-language-server
      pkgs.nixd
      pkgs.prettier
      pkgs.roslyn-ls
      pkgs.ruff
      pkgs.shfmt
      pkgs.sqlfluff
      pkgs.stylua
      pkgs.swiftlint
      pkgs.terraform
      pkgs.vtsls
    ];

    home.file = {
      ".pi/agent/settings.json".text = builtins.toJSON settings;
      ".pi/agent/themes/gruvbox.json".text = builtins.toJSON gruvboxTheme;
      ".pi/agent/AGENTS.md".source = ../global-instructions.md;
      ".pi/agent/components".source = piAgentDir + "/components";
      ".pi/agent/extensions".source = piAgentDir + "/extensions";
      ".pi/agent/skills".source = piSkills;
      ".pi/agent/prompts".source = ../prompts;
    };
  };
}
