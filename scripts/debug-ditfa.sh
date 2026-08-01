#!/bin/bash

# Set "chatgpt.cliExecutable": "/Users/<USERNAME>/code/ditfa/scripts/debug-ditfa.sh" in VSCode settings to always get the 
# latest ditfa-rs binary when debugging Ditfa Code Extension.


set -euo pipefail

DITFA_RS_DIR=$(realpath "$(dirname "$0")/../ditfa-rs")
(cd "$DITFA_RS_DIR" && cargo run --quiet --bin ditfa -- "$@")