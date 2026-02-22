{
  description = "AI skills, prompts, and OpenCode module";

  outputs = {self, ...}: {
    homeManagerModules = {
      opencode = import ./nix/opencode.nix;
      default = self.homeManagerModules.opencode;
    };
  };
}
