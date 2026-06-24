#include "greeter.hpp"

namespace toy {
std::string greet(const std::string &name) { return "Hello, " + name; }

std::string sample_greeting() { return greet("Pi"); }
} // namespace toy
