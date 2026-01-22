#!/bin/sh

set -e

echo "Starting AO CU with Message Tracking and Verification..."

# Start the CU server in the background
echo "Starting CU server..."
npm start &
CU_PID=$!

# Function to run verifier with auto-restart on failure
run_verifier_with_retry() {
  PROCESS_ID="$1"
  RETRY_DELAY="${VERIFIER_RESTART_DELAY:-60}"
  
  while true; do
    echo "[$(date)] Starting verifier for process: $PROCESS_ID"
    
    # Build verifier command
    VERIFIER_CMD="node scripts/run-verifier.js $PROCESS_ID"
    VERIFIER_CMD="$VERIFIER_CMD --discovery-dir ${MESSAGE_TRACKING_DB_DIR:-/data/process-messages}"
    VERIFIER_CMD="$VERIFIER_CMD --verification-dir ${VERIFICATION_DB_DIR:-/data/verification}"
    VERIFIER_CMD="$VERIFIER_CMD --interval ${VERIFIER_INTERVAL_MS:-60000}"
    VERIFIER_CMD="$VERIFIER_CMD --batch-size ${VERIFIER_BATCH_SIZE:-100}"
    VERIFIER_CMD="$VERIFIER_CMD --retry-after ${VERIFIER_RETRY_AFTER_MINUTES:-10}"
    
    if [ -n "${VERIFIER_USE_CACHE:-}" ]; then
      VERIFIER_CMD="$VERIFIER_CMD --use-cache $VERIFIER_USE_CACHE"
    fi
    
    # Run verifier (will exit if no data or on error)
    $VERIFIER_CMD || true
    
    echo "[$(date)] Verifier for $PROCESS_ID exited. Restarting in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"
  done
}

# Wait for CU to be ready before starting verifiers
STARTUP_DELAY="${VERIFIER_STARTUP_DELAY:-30}"
echo "Waiting ${STARTUP_DELAY}s for CU to initialize..."
sleep "$STARTUP_DELAY"

# Start verifiers for configured process IDs
# VERIFIER_PROCESS_IDS should be a comma-separated list of process IDs
if [ -n "${VERIFIER_PROCESS_IDS:-}" ]; then
  echo "Starting verifiers for process IDs: $VERIFIER_PROCESS_IDS"
  
  # Parse comma-separated list using tr and read
  echo "$VERIFIER_PROCESS_IDS" | tr ',' '\n' | while read -r PROCESS_ID; do
    # Trim whitespace
    PROCESS_ID=$(echo "$PROCESS_ID" | tr -d '[:space:]')
    
    if [ -n "$PROCESS_ID" ]; then
      # Run verifier with auto-restart in background
      run_verifier_with_retry "$PROCESS_ID" &
      echo "Verifier wrapper started for $PROCESS_ID"
    fi
  done
else
  echo "No VERIFIER_PROCESS_IDS configured. Verifier not started."
  echo "Set VERIFIER_PROCESS_IDS=id1,id2,id3 to enable verification."
fi

# Wait for CU process (if it exits, container exits)
wait $CU_PID
