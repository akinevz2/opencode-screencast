#!/bin/bash
# Arguments: $1 = Command to run in the window, $2 = Log output file

CLIENT_COMMAND="my-application-for-presentation" # Replace with actual application
LOG_FILE="$2"

echo "Starting hermbstluft observer for presentation..."

# Run the application and capture all output to the specified log file
# This simulates the agent reading the 'state' of the window content
$CLIENT_COMMAND >> $LOG_FILE 2>&1 & 

echo "Observer started successfully. Agent should monitor $LOG_FILE."
