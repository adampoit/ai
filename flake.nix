{
  description = "AI skills, prompts, and OpenCode module";

  outputs = {self, ...}: {
    homeManagerModules = {
      opencode = import ./nix/opencode.nix;
      pi-coding-agent = import ./nix/pi-coding-agent.nix;
      default = self.homeManagerModules.opencode;
    };

    files = {
      globalInstructions = builtins.readFile ./global-instructions.md;
    };
  };
}
