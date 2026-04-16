let
  rules = action: names:
    builtins.listToAttrs (map (name: {
        inherit name;
        value = action;
      })
      names);
  apiFields = builtins.concatMap (flag: ["gh api ${flag}*" "gh api * ${flag}*"]) ["-f" "-F" "--raw-field" "--field" "--input"];
  apiMethods = builtins.concatMap (method: [
    "gh api -X ${method}*"
    "gh api -X${method}*"
    "gh api * -X ${method}*"
    "gh api * -X${method}*"
    "gh api --method ${method}*"
    "gh api --method=${method}*"
    "gh api * --method ${method}*"
    "gh api * --method=${method}*"
  ]) ["POST" "PUT" "PATCH" "DELETE" "post" "put" "patch" "delete"];
  cmds = builtins.concatLists (map ({
    scope,
    names,
  }:
    map (name: "gh ${scope} ${name}*") names) [
    {
      scope = "pr";
      names = ["close" "comment" "create" "edit" "lock" "merge" "ready" "reopen" "revert" "review" "unlock" "update-branch"];
    }
    {
      scope = "issue";
      names = ["close" "comment" "create" "delete" "develop" "edit" "lock" "pin" "reopen" "transfer" "unlock" "unpin"];
    }
    {
      scope = "repo";
      names = ["archive" "create" "delete" "edit" "fork" "rename" "set-default" "sync" "unarchive"];
    }
    {
      scope = "repo autolink";
      names = ["create" "delete"];
    }
    {
      scope = "repo deploy-key";
      names = ["add" "delete"];
    }
    {
      scope = "release";
      names = ["create" "delete" "delete-asset" "edit" "upload"];
    }
    {
      scope = "workflow";
      names = ["disable" "enable" "run"];
    }
    {
      scope = "cache";
      names = ["delete"];
    }
    {
      scope = "project";
      names = ["close" "copy" "create" "delete" "edit" "field-create" "field-delete" "item-add" "item-archive" "item-create" "item-delete" "item-edit" "link" "mark-template" "unlink"];
    }
    {
      scope = "label";
      names = ["clone" "create" "delete" "edit"];
    }
    {
      scope = "gist";
      names = ["create" "delete" "edit" "rename"];
    }
    {
      scope = "ssh-key";
      names = ["add" "delete"];
    }
    {
      scope = "gpg-key";
      names = ["add" "delete"];
    }
    {
      scope = "extension";
      names = ["exec" "install" "remove" "upgrade"];
    }
    {
      scope = "alias";
      names = ["delete" "import" "set"];
    }
    {
      scope = "secret";
      names = ["delete" "set"];
    }
    {
      scope = "variable";
      names = ["delete" "set"];
    }
    {
      scope = "agent-task";
      names = ["create"];
    }
  ]);
in
  (rules "ask" (apiFields ++ apiMethods ++ cmds))
  // (rules "deny" ["gh auth*" "gh config set*"])
