terraform {
  required_version = ">= 1.0"
}

variable "name" {
  type    = string
  default = "Pi"
}

locals {
  greeting = "Hello, ${var.name}"
}

output "greeting" {
  value = local.greeting
}
