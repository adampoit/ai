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
      permission = {
        bash = {
          # Jira
          "jira *" = "ask";
          "jira issue list" = "allow";
          "jira issue list *" = "allow";
          "jira issue view" = "allow";
          "jira issue view *" = "allow";
          "jira issue create *" = "deny";
          "jira issue create" = "deny";
          "jira issue edit *" = "deny";
          "jira issue edit" = "deny";
          "jira issue delete *" = "deny";
          "jira issue delete" = "deny";
          "jira issue move *" = "deny";
          "jira issue move" = "deny";
          "jira issue assign *" = "deny";
          "jira issue assign" = "deny";
          "jira issue link *" = "deny";
          "jira issue link" = "deny";
          "jira issue unlink *" = "deny";
          "jira issue unlink" = "deny";
          "jira issue clone *" = "deny";
          "jira issue clone" = "deny";
          "jira issue watch *" = "deny";
          "jira issue watch" = "deny";
          "jira issue worklog *" = "deny";
          "jira issue worklog" = "deny";
          "jira issue comment add *" = "deny";
          "jira issue comment add" = "deny";
          "jira issue comment edit *" = "deny";
          "jira issue comment edit" = "deny";
          "jira issue comment delete *" = "deny";
          "jira issue comment delete" = "deny";

          # GitHub CLI
          "gh *" = "ask";
          "gh repo view" = "allow";
          "gh repo view *" = "allow";
          "gh issue list" = "allow";
          "gh issue list *" = "allow";
          "gh issue view" = "allow";
          "gh issue view *" = "allow";
          "gh pr list" = "allow";
          "gh pr list *" = "allow";
          "gh pr view" = "allow";
          "gh pr view *" = "allow";
          "gh api *" = "allow";
          "gh pr create *" = "deny";
          "gh pr create" = "deny";
          "gh pr merge *" = "deny";
          "gh pr merge" = "deny";
          "gh pr edit *" = "deny";
          "gh pr edit" = "deny";
          "gh pr close *" = "deny";
          "gh pr close" = "deny";
          "gh issue create *" = "deny";
          "gh issue create" = "deny";
          "gh issue edit *" = "deny";
          "gh issue edit" = "deny";
          "gh issue close *" = "deny";
          "gh issue close" = "deny";
          "gh release create *" = "deny";
          "gh release create" = "deny";

          # Email (notmuch)
          "notmuch *" = "ask";
          "notmuch search *" = "allow";
          "notmuch show *" = "allow";

          # Calendar (khal)
          "khal *" = "ask";
          "khal list *" = "allow";
          "khal calendar *" = "allow";

          # Task management (taskwarrior)
          "task *" = "ask";
          "task list *" = "allow";

          # Dangerous commands
          "sudo *" = "deny";
        };
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
