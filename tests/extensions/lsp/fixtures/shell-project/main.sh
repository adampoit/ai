#!/usr/bin/env bash

make_greeting() {
	local name="$1"
	printf 'Hello, %s\n' "$name"
}

make_greeting "Pi"
