#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4030}"
LOG_FILE="${TMPDIR:-/tmp}/video_call_backend_smoke_${PORT}.log"

cleanup() {
  if [[ -n "${BACK_PID:-}" ]] && kill -0 "$BACK_PID" >/dev/null 2>&1; then
    kill "$BACK_PID" >/dev/null 2>&1 || true
    wait "$BACK_PID" 2>/dev/null || true
  fi
}

fail() {
  echo "[Backend] Smoke test failed: $1"
  echo "[Backend] Server log (tail):"
  tail -n 80 "$LOG_FILE" || true
  exit 1
}

require_contains() {
  local value="$1"
  local needle="$2"
  local message="$3"
  if [[ "$value" != *"$needle"* ]]; then
    fail "$message | actual: $value"
  fi
}

engine_open() {
  local caller_id="${1:-}"
  local url="http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling"
  if [[ -n "$caller_id" ]]; then
    url+="&callerId=${caller_id}"
  fi
  curl -fsS "$url"
}

extract_sid() {
  local open_response="$1"
  local sid
  sid=$(echo "$open_response" | sed -E 's/^0\{"sid":"([^"]+)".*/\1/')
  if [[ -z "$sid" || "$sid" == "$open_response" ]]; then
    fail "Unable to extract sid from response: $open_response"
  fi
  echo "$sid"
}

connect_client() {
  local caller_id="$1"
  local open_response
  local sid

  open_response=$(engine_open "$caller_id")
  sid=$(extract_sid "$open_response")

  curl -fsS -X POST \
    "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}&callerId=${caller_id}" \
    -H "Content-Type: text/plain;charset=UTF-8" \
    --data-binary "40" >/dev/null

  curl -fsS \
    "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}&callerId=${caller_id}" \
    >/dev/null

  echo "$sid"
}

trap cleanup EXIT

echo "[Backend] Installing dependencies"
npm ci

echo "[Backend] Starting signaling server on port ${PORT}"
PORT="$PORT" node app/index.js >"$LOG_FILE" 2>&1 &
BACK_PID=$!
sleep 2

if ! kill -0 "$BACK_PID" >/dev/null 2>&1; then
  fail "Server failed to start"
fi

echo "[Backend] Verifying callerId validation"
no_caller_open=$(engine_open)
no_caller_sid=$(extract_sid "$no_caller_open")
curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${no_caller_sid}" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  --data-binary "40" >/dev/null
no_caller_poll=$(curl -fsS "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${no_caller_sid}")
require_contains "$no_caller_poll" 'callerId query parameter is required' 'callerId middleware did not reject missing callerId'

echo "[Backend] Connecting employer/helper mock clients"
employer_sid=$(connect_client "employer_001")
helper_sid=$(connect_client "helper_001")

echo "[Backend] Verifying makeCall -> newCall"
curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  --data-binary '42["makeCall",{"calleeId":"helper_001","sdpOffer":"mock_offer_sdp"}]' >/dev/null
helper_new_call=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${helper_sid}&callerId=helper_001")
require_contains "$helper_new_call" '"newCall"' 'makeCall did not emit newCall'

echo "[Backend] Verifying answerCall -> callAnswered"
curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${helper_sid}&callerId=helper_001" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  --data-binary '42["answerCall",{"callerId":"employer_001","sdpAnswer":"mock_answer_sdp"}]' >/dev/null
employer_answered=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001")
require_contains "$employer_answered" '"callAnswered"' 'answerCall did not emit callAnswered'

echo "[Backend] Verifying endCall -> callEnded + leaveCall"
curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  --data-binary '42["endCall",{"calleeId":"helper_001"}]' >/dev/null
helper_ended=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${helper_sid}&callerId=helper_001")
employer_leave=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001")
require_contains "$helper_ended" '"callEnded"' 'endCall did not emit callEnded'
require_contains "$employer_leave" '"leaveCall"' 'endCall did not emit leaveCall'

echo "[Backend] Verifying STT invalid payload handling"
curl -fsS -X POST \
  "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001" \
  -H "Content-Type: text/plain;charset=UTF-8" \
  --data-binary '42["audioRecording",{"to":"helper_001","audio":"!!!invalid_base64!!!"}]' >/dev/null
employer_stt_error=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling&sid=${employer_sid}&callerId=employer_001")
require_contains "$employer_stt_error" '"sttError"' 'audioRecording invalid payload did not emit sttError'
require_contains "$employer_stt_error" '"STT_INVALID_PAYLOAD"' 'audioRecording invalid payload did not return STT_INVALID_PAYLOAD'

echo "[Backend] Video call + translation smoke test passed"
