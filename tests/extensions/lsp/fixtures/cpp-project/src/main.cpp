#include "greeter.hpp"

int main() {
  auto message = toy::greet("Pi");
  return message.empty() ? 1 : 0;
}
