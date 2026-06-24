let
  greet = name: "Hello ${name}!";
  message = greet "Pi";
in
  message
