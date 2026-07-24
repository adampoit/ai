let
  version = "0.80.10";
in {
  npmDepsHash = "sha256-Ro2ovgqH6EpFb20M5DvcP6KIxXZPHcjeEdo1Sh4JbDM=";
  source = {
    hash = "sha256-Vs/ndHYzFyfN4CjPV2zMYblLXe9IuM13UrPJI1VsZEQ=";
    owner = "earendil-works";
    repo = "pi";
    rev = "v${version}";
  };
  inherit version;
}
