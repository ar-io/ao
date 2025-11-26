#!/usr/bin/env sh

# Exit immediately if a command exits with a non-zero status
set -e
# Exit if an uninitialized variable is used
set -u

DEBUG=true

debug_log() {
  if [ "$DEBUG" = true ]; then
    echo "[DEBUG] $1"
  fi
}

# Check for required argument
if [ "$#" -lt 1 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: $0 <processId> [--dry-run]"
  echo ""
  echo "Start the CU server with checkpoint block height parameters derived from"
  echo "the verification database's latest nonce."
  echo ""
  echo "Options:"
  echo "  --dry-run    Show derived parameters without starting the server"
  echo ""
  echo "Example:"
  echo "  $0 qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE"
  echo "  $0 qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE --dry-run"
  exit 0
fi

PROCESS_ID="$1"
shift

# Check for dry-run option
DRY_RUN=false
if [ "$#" -gt 0 ] && [ "$1" = "--dry-run" ]; then
  DRY_RUN=true
  debug_log "Dry-run mode enabled."
fi

debug_log "Process ID: $PROCESS_ID"

# Checkpoint wallet addresses (can be overridden via environment variable)
# Default includes known checkpoint signers
CHECKPOINT_OWNERS="${CHECKPOINT_WALLET_ADDRESSES:-WjnS-s03HWsDSdMnyTdzB1eHZB2QheUWP_FVRVYxkXk,-HFe6PleLxj1EdFMYMSetT2NIJioDsZIktn-Y0AwP54}"

debug_log "Checkpoint owners: $CHECKPOINT_OWNERS"

# Verification database path
VERIFICATION_DB="./data/verification/${PROCESS_ID}.sqlite"

# Check if the database exists
if [ ! -f "$VERIFICATION_DB" ]; then
  echo "Error: Verification database not found at $VERIFICATION_DB" >&2
  exit 1
fi

debug_log "Fetching latest nonce from verification database..."

# Step 1: Get the row with the highest nonce from the verification database
latest_row=$(sqlite3 -csv "$VERIFICATION_DB" "SELECT nonce, input_message_id FROM verification_messages ORDER BY nonce DESC LIMIT 1;")

if [ -z "$latest_row" ]; then
  echo "Error: No messages found in verification database" >&2
  exit 1
fi

# Parse the CSV result
max_nonce=$(echo "$latest_row" | cut -d ',' -f1)
input_message_id=$(echo "$latest_row" | cut -d ',' -f2)

debug_log "Max nonce: $max_nonce"
debug_log "Input message ID: $input_message_id"

# Function to validate if a value is an integer
validate_integer() {
  if ! echo "$1" | grep -qE '^[0-9]+$'; then
    echo "Error: Expected integer but got '$1'" >&2
    exit 1
  fi
}

validate_integer "$max_nonce"

# Step 2: Fetch block height for the max nonce
debug_log "Fetching block height for nonce $max_nonce..."

block_height_result=$(node get_block_heights.js "$PROCESS_ID" "$max_nonce" "$PROCESS_ID" "$max_nonce")
debug_log "block_height_result: $block_height_result"

block_height=$(echo "$block_height_result" | jq -r '.block_height_1')

if [ "$block_height" = "null" ] || [ -z "$block_height" ]; then
  echo "Error: Could not determine block height for nonce $max_nonce" >&2
  exit 1
fi

validate_integer "$block_height"
debug_log "Block height: $block_height"

# Step 3: Calculate checkpoint block height range
max_checkpoint_block_height="$block_height"
min_checkpoint_block_height=$((max_checkpoint_block_height - 10000))

debug_log "max_checkpoint_block_height: $max_checkpoint_block_height"
debug_log "min_checkpoint_block_height: $min_checkpoint_block_height"

# Step 4: Query for checkpoint in the block range
debug_log "Querying for checkpoint in block range $min_checkpoint_block_height - $max_checkpoint_block_height..."

checkpoint_result=$(node get_checkpoint.js "$PROCESS_ID" "$min_checkpoint_block_height" "$max_checkpoint_block_height" "$CHECKPOINT_OWNERS")
debug_log "checkpoint_result: $checkpoint_result"

checkpoint_found=$(echo "$checkpoint_result" | jq -r '.found')

echo ""
echo "=== Checkpoint Search Results ==="
echo "  Block range: $min_checkpoint_block_height - $max_checkpoint_block_height"

if [ "$checkpoint_found" = "true" ]; then
  checkpoint_id=$(echo "$checkpoint_result" | jq -r '.id')
  checkpoint_owner=$(echo "$checkpoint_result" | jq -r '.owner')
  checkpoint_nonce=$(echo "$checkpoint_result" | jq -r '.tags.Nonce // "N/A"')
  checkpoint_timestamp=$(echo "$checkpoint_result" | jq -r '.tags.Timestamp // "N/A"')
  checkpoint_module=$(echo "$checkpoint_result" | jq -r '.tags.Module // "N/A"')
  checkpoint_encoding=$(echo "$checkpoint_result" | jq -r '.tags["Content-Encoding"] // "N/A"')

  echo "  Checkpoint found!"
  echo "  Message ID: $checkpoint_id"
  echo "  Owner: $checkpoint_owner"
  echo "  Tags:"
  echo "    Nonce: $checkpoint_nonce"
  echo "    Timestamp: $checkpoint_timestamp"
  echo "    Module: $checkpoint_module"
  echo "    Content-Encoding: $checkpoint_encoding"
else
  echo "  No checkpoint found in block range"
fi
echo ""

# Dry-run behavior
if [ "$DRY_RUN" = true ]; then
  debug_log "Dry run complete. Exiting."
  echo "Dry run: MIN_CHECKPOINT_BLOCK_HEIGHT=$min_checkpoint_block_height"
  echo "Dry run: MAX_CHECKPOINT_BLOCK_HEIGHT=$max_checkpoint_block_height"
  exit 0
fi

debug_log "Starting server with MIN_CHECKPOINT_BLOCK_HEIGHT=$min_checkpoint_block_height and MAX_CHECKPOINT_BLOCK_HEIGHT=$max_checkpoint_block_height..."

# Start server
exec env MIN_CHECKPOINT_BLOCK_HEIGHT=$min_checkpoint_block_height \
         MAX_CHECKPOINT_BLOCK_HEIGHT=$max_checkpoint_block_height \
         npm start
