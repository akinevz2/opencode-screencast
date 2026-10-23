#!/bin/bash
# Arguments: $1 = Command to execute remotely

COMMAND=$1

if [ -z "$COMMAND" ]; then
  echo "ERROR: No command provided to execute." >&2
  exit 1
fi

echo "Executing command: $COMMAND"

# Assuming 'herbstctl' is the CLI tool for herbstluftwm
herbstctl execute --window-id=123 --command "$COMMAND"