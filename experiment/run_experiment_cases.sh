#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$ROOT_DIR/config.yaml}"
PYTHON_SCRIPT="$ROOT_DIR/run_pilotdeck_experiment.py"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file does not exist: $CONFIG_FILE" >&2
  exit 1
fi

eval "$(
  python3 - "$CONFIG_FILE" "$ROOT_DIR" <<'PY'
import os
import shlex
import sys

config_file, root_dir = sys.argv[1:3]

def parse_scalar(raw):
    raw = raw.strip()
    if not raw:
        return ""
    if raw[0:1] in {"'", '"'} and raw[-1:] == raw[0]:
        return raw[1:-1]
    low = raw.lower()
    if low in {"true", "yes", "on"}:
        return "1"
    if low in {"false", "no", "off"}:
        return "0"
    return raw

def read_config(path):
    data = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip().replace("-", "_")
            value = value.split(" #", 1)[0]
            data[key] = parse_scalar(value)
    return data

def choose(env_name, config_key, default=""):
    value = os.environ.get(env_name)
    if value is not None and value != "":
        return value
    value = config.get(config_key)
    if value is not None and str(value) != "":
        return str(value)
    return default

def abs_from_root(value):
    if not value:
        return ""
    expanded = os.path.expanduser(os.path.expandvars(value))
    if os.path.isabs(expanded):
        return expanded
    return os.path.abspath(os.path.join(root_dir, expanded))

config = read_config(config_file)

values = {
    "PILOTDECK_API_KEY": choose("PILOTDECK_API_KEY", "pilotdeck_api_key"),
    "PROJECT_PATH": abs_from_root(choose("PROJECT_PATH", "project_path")),
    "CASE_FILE": abs_from_root(choose("CASE_FILE", "case_file", "experiment_case.txt")),
    "SERVER_URL": choose("PILOTDECK_SERVER_URL", "server_url", "http://127.0.0.1:3001"),
    "LOG_ROOT": abs_from_root(choose("LOG_ROOT", "log_dir", "experiment_logs")),
    "NO_STREAM": choose("NO_STREAM", "no_stream", "0"),
    "VIEW": choose("VIEW", "view", "compact"),
    "TOOL_RESULT_LIMIT": choose("TOOL_RESULT_LIMIT", "tool_result_limit", "600"),
    "TIMEOUT": choose("TIMEOUT", "timeout", "3600"),
}

for key, value in values.items():
    print(f"{key}={shlex.quote(str(value))}")
PY
)"

export PILOTDECK_API_KEY

if [[ -z "${PILOTDECK_API_KEY:-}" || "$PILOTDECK_API_KEY" == "ck_replace_me" ]]; then
  echo "Missing PILOTDECK_API_KEY." >&2
  echo "Set pilotdeck_api_key in $CONFIG_FILE or export PILOTDECK_API_KEY=ck_xxx." >&2
  exit 1
fi

if [[ ! -f "$CASE_FILE" ]]; then
  echo "Case file does not exist: $CASE_FILE" >&2
  exit 1
fi

if [[ ! -f "$PYTHON_SCRIPT" ]]; then
  echo "Python runner does not exist: $PYTHON_SCRIPT" >&2
  exit 1
fi

if [[ -z "${PROJECT_PATH:-}" ]]; then
  echo "Missing project_path." >&2
  echo "Set project_path in $CONFIG_FILE or export PROJECT_PATH=/absolute/path/to/project." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Project path does not exist: $PROJECT_PATH" >&2
  exit 1
fi

PYTHON_CMD=(python)

RUN_ID="$(date +%Y%m%d_%H%M%S)"
LOG_DIR="${LOG_DIR:-$LOG_ROOT/$RUN_ID}"
mkdir -p "$LOG_DIR"
SUMMARY_TSV="$LOG_DIR/summary.tsv"
printf "case\tstatus\tsession_id\ttools\terrors\treadable_log\traw_jsonl\n" > "$SUMMARY_TSV"

echo "Config: $CONFIG_FILE"
echo "Project: $PROJECT_PATH"
echo "Case file: $CASE_FILE"
echo "Log directory: $LOG_DIR"
echo "Summary: $SUMMARY_TSV"

case_no=0
failures=0
while IFS= read -r prompt || [[ -n "$prompt" ]]; do
  [[ -z "${prompt//[[:space:]]/}" ]] && continue
  case_no=$((case_no + 1))
  case_id="$(printf "%02d" "$case_no")"
  readable_log="$LOG_DIR/case_${case_id}.readable.log"
  raw_jsonl="$LOG_DIR/case_${case_id}.raw.jsonl"
  summary_json="$LOG_DIR/case_${case_id}.summary.json"

  runner_args=(
    "$PYTHON_SCRIPT"
    --server "$SERVER_URL"
    --project-path "$PROJECT_PATH"
    --message "$prompt"
    --view "$VIEW"
    --tool-result-limit "$TOOL_RESULT_LIMIT"
    --timeout "$TIMEOUT"
    --raw-jsonl "$raw_jsonl"
    --summary-json "$summary_json"
  )
  if [[ "$NO_STREAM" =~ ^(1|true|TRUE|yes|YES|on|ON)$ ]]; then
    runner_args+=(--no-stream)
  fi

  set +e
  {
    echo
    echo "===== case $case_id ====="
    echo "$prompt"
    echo
    "${PYTHON_CMD[@]}" "${runner_args[@]}"
  } 2>&1 | tee "$readable_log"
  run_status="${PIPESTATUS[0]}"
  set -e

  if [[ "$run_status" -ne 0 ]]; then
    failures=$((failures + 1))
  fi

  if [[ -f "$summary_json" ]]; then
    python3 - "$summary_json" "$case_id" "$readable_log" "$raw_jsonl" <<'PY' >> "$SUMMARY_TSV"
import json
import sys

summary_path, case_id, readable_log, raw_jsonl = sys.argv[1:5]
with open(summary_path, "r", encoding="utf-8") as handle:
    summary = json.load(handle)

row = [
    case_id,
    str(summary.get("status") or "unknown"),
    str(summary.get("sessionId") or ""),
    str(len(summary.get("toolCalls") or [])),
    str(len(summary.get("errors") or [])),
    readable_log,
    raw_jsonl,
]
print("\t".join(item.replace("\t", " ") for item in row))
PY
  else
    printf "%s\tfailed\t\t0\t1\t%s\t%s\n" "$case_id" "$readable_log" "$raw_jsonl" >> "$SUMMARY_TSV"
  fi
done < "$CASE_FILE"

echo
echo "Finished $case_no case(s)."
echo "Readable logs: $LOG_DIR/case_*.readable.log"
echo "Raw event logs: $LOG_DIR/case_*.raw.jsonl"
echo "Summary: $SUMMARY_TSV"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures case(s) failed." >&2
  exit 1
fi
