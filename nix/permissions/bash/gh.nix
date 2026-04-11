{
  "gh *" = "ask";

  "gh api" = "allow";
  "gh api *" = "allow";

  "gh api -X GET*" = "allow";
  "gh api -XGET*" = "allow";
  "gh api * -X GET*" = "allow";
  "gh api * -XGET*" = "allow";
  "gh api --method GET*" = "allow";
  "gh api --method=GET*" = "allow";
  "gh api * --method GET*" = "allow";
  "gh api * --method=GET*" = "allow";
  "gh api -X HEAD*" = "allow";
  "gh api -XHEAD*" = "allow";
  "gh api * -X HEAD*" = "allow";
  "gh api * -XHEAD*" = "allow";
  "gh api --method HEAD*" = "allow";
  "gh api --method=HEAD*" = "allow";
  "gh api * --method HEAD*" = "allow";
  "gh api * --method=HEAD*" = "allow";
  "gh api -X OPTIONS*" = "allow";
  "gh api -XOPTIONS*" = "allow";
  "gh api * -X OPTIONS*" = "allow";
  "gh api * -XOPTIONS*" = "allow";
  "gh api --method OPTIONS*" = "allow";
  "gh api --method=OPTIONS*" = "allow";
  "gh api * --method OPTIONS*" = "allow";
  "gh api * --method=OPTIONS*" = "allow";

  "gh api -X get*" = "allow";
  "gh api -Xget*" = "allow";
  "gh api * -X get*" = "allow";
  "gh api * -Xget*" = "allow";
  "gh api --method get*" = "allow";
  "gh api --method=get*" = "allow";
  "gh api * --method get*" = "allow";
  "gh api * --method=get*" = "allow";
  "gh api -X head*" = "allow";
  "gh api -Xhead*" = "allow";
  "gh api * -X head*" = "allow";
  "gh api * -Xhead*" = "allow";
  "gh api --method head*" = "allow";
  "gh api --method=head*" = "allow";
  "gh api * --method head*" = "allow";
  "gh api * --method=head*" = "allow";
  "gh api -X options*" = "allow";
  "gh api -Xoptions*" = "allow";
  "gh api * -X options*" = "allow";
  "gh api * -Xoptions*" = "allow";
  "gh api --method options*" = "allow";
  "gh api --method=options*" = "allow";
  "gh api * --method options*" = "allow";
  "gh api * --method=options*" = "allow";

  "gh auth" = "deny";
  "gh auth *" = "deny";

  "gh config set" = "deny";
  "gh config set *" = "deny";
}
