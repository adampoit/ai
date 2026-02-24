{pkgs, ...}: {
  programs.opencode = {
    enable = true;

    rules = builtins.readFile ../global-instructions.md;

    agents = ../agents;
    commands = ../prompts;
    skills = let
      localSkillsDir = ../skills;
      localSkillEntries = builtins.readDir localSkillsDir;
      localSkillNames =
        builtins.filter (name: localSkillEntries.${name} == "directory")
        (builtins.attrNames localSkillEntries);
      localSkills = builtins.listToAttrs (map (name: {
          inherit name;
          value = localSkillsDir + "/${name}";
        })
        localSkillNames);
    in
      localSkills
      // {
        playwright-cli = "${pkgs.playwright-cli}/share/opencode/skills/playwright-cli";
      };

    settings = {
      permission = let
        bashPermissionFiles = [
          ./permissions/bash/core.nix
          ./permissions/bash/jira.nix
          ./permissions/bash/gh.nix
          ./permissions/bash/notmuch.nix
          ./permissions/bash/khal.nix
          ./permissions/bash/task.nix
        ];
      in {
        bash =
          builtins.foldl'
          (merged: file: merged // import file)
          {}
          bashPermissionFiles;
      };

      keybinds = {
        messages_half_page_up = "ctrl+u";
        messages_half_page_down = "ctrl+d";
      };

      theme = "gruvbox";

      formatter = {
        alejandra = {
          command = ["alejandra" "$FILE"];
          extensions = [".nix"];
        };

        sqlfluff = {
          command = ["sqlfluff" "fix" "$FILE"];
          extensions = [".sql"];
        };

        stylua = {
          command = ["stylua" "$FILE"];
          extensions = [".lua"];
        };

        swiftlint = {
          command = ["swiftlint" "format" "--path" "$FILE"];
          extensions = [".swift"];
        };
      };

      plugin = ["@slkiser/opencode-quota"];
    };
  };
}
