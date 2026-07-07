#!/usr/bin/env python3
"""
Run a PilotDeck experiment turn through the existing /api/agent endpoint.

Prerequisites:
  1. Start PilotDeck so the Web UI is listening, usually on http://127.0.0.1:3001.
  2. Create an external API key in PilotDeck Settings -> API Keys.
  3. Export it before running:
       export PILOTDECK_API_KEY=ck_your_key_here

Examples:
  python run_pilotdeck_experiment.py \
    --project-path /path/to/physics-project \
    --message "Run experiment case A and report the result."

  python run_pilotdeck_experiment.py \
    --project-path /path/to/physics-project \
    --message-file prompts/case_a.txt \
    --no-stream
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Optional


DEFAULT_SERVER = "http://127.0.0.1:3001"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(SCRIPT_DIR, "config.yaml")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Launch a PilotDeck project and inject an initial prompt.",
    )
    parser.add_argument(
        "--config",
        default=os.environ.get("EXPERIMENT_CONFIG", DEFAULT_CONFIG),
        help="Path to experiment config.yaml.",
    )
    parser.add_argument(
        "--server",
        default=None,
        help=f"PilotDeck Web server URL. Default: {DEFAULT_SERVER}",
    )
    parser.add_argument(
        "--api-key",
        default=None,
        help="External API key. Prefer setting PILOTDECK_API_KEY.",
    )
    parser.add_argument(
        "--project-path",
        default=None,
        help="Absolute path of the PilotDeck project/workspace. Default: current directory.",
    )
    message_group = parser.add_mutually_exclusive_group(required=True)
    message_group.add_argument(
        "--message",
        help="Initial prompt to send to PilotDeck.",
    )
    message_group.add_argument(
        "--message-file",
        help="Read the initial prompt from a UTF-8 text file.",
    )
    parser.add_argument(
        "--session-id",
        help="Optional existing PilotDeck session id to resume.",
    )
    parser.add_argument(
        "--model",
        help="Optional model hint accepted by the server.",
    )
    parser.add_argument(
        "--no-stream",
        action="store_true",
        default=None,
        help="Wait for a single JSON response instead of reading SSE events.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="HTTP timeout in seconds. Default: 3600.",
    )
    parser.add_argument(
        "--view",
        choices=("raw", "compact"),
        default=None,
        help="Terminal output style. compact hides token-by-token thinking noise.",
    )
    parser.add_argument(
        "--tool-result-limit",
        type=int,
        default=None,
        help="Max tool-result characters to print in compact view. Default: 600.",
    )
    parser.add_argument(
        "--raw-jsonl",
        help="Optional path to write every SSE event as JSONL.",
    )
    parser.add_argument(
        "--summary-json",
        help="Optional path to write a compact run summary as JSON.",
    )
    return parser.parse_args()


def parse_config_scalar(raw: str) -> Any:
    raw = raw.strip()
    if not raw:
        return ""
    if raw[0:1] in {"'", '"'} and raw[-1:] == raw[0]:
        return raw[1:-1]
    lowered = raw.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    try:
        if "." in raw:
            return float(raw)
        return int(raw)
    except ValueError:
        return raw


def read_simple_yaml(path: str) -> dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    data: dict[str, Any] = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip().replace("-", "_")
            value = value.split(" #", 1)[0]
            data[key] = parse_config_scalar(value)
    return data


def resolve_config_path(config_path: str, value: Any, fallback: str = "") -> str:
    text = str(value if value not in (None, "") else fallback)
    if not text:
        return ""
    expanded = os.path.expanduser(os.path.expandvars(text))
    if os.path.isabs(expanded):
        return expanded
    base = os.path.dirname(os.path.abspath(config_path)) if config_path else SCRIPT_DIR
    return os.path.abspath(os.path.join(base, expanded))


def env_or_config(env_name: str, config: dict[str, Any], key: str, fallback: Any = None) -> Any:
    env_value = os.environ.get(env_name)
    if env_value not in (None, ""):
        return env_value
    config_value = config.get(key)
    if config_value not in (None, ""):
        return config_value
    return fallback


def apply_config(args: argparse.Namespace) -> argparse.Namespace:
    config = read_simple_yaml(args.config)

    args.server = args.server or str(env_or_config("PILOTDECK_SERVER_URL", config, "server_url", DEFAULT_SERVER))
    args.api_key = args.api_key or str(env_or_config("PILOTDECK_API_KEY", config, "pilotdeck_api_key", ""))
    args.project_path = args.project_path or resolve_config_path(
        args.config,
        env_or_config("PROJECT_PATH", config, "project_path", os.getcwd()),
    )

    if args.timeout is None:
        args.timeout = float(env_or_config("TIMEOUT", config, "timeout", 3600))
    if args.view is None:
        args.view = str(env_or_config("VIEW", config, "view", "raw"))
    if args.tool_result_limit is None:
        args.tool_result_limit = int(env_or_config("TOOL_RESULT_LIMIT", config, "tool_result_limit", 600))
    if args.no_stream is None:
        value = env_or_config("NO_STREAM", config, "no_stream", False)
        args.no_stream = str(value).lower() in {"1", "true", "yes", "on"}

    return args


def read_prompt(args: argparse.Namespace) -> str:
    if args.message is not None:
        return args.message.strip()
    with open(args.message_file, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def build_payload(args: argparse.Namespace, prompt: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "projectPath": os.path.abspath(args.project_path),
        "message": prompt,
        "stream": not args.no_stream,
        "provider": "pilotdeck",
    }
    if args.session_id:
        payload["sessionId"] = args.session_id
    if args.model:
        payload["model"] = args.model
    return payload


def open_agent_request(args: argparse.Namespace, payload: dict[str, Any]):
    if not args.api_key:
        raise SystemExit(
            "Missing API key. Set PILOTDECK_API_KEY or pass --api-key."
        )

    url = args.server.rstrip("/") + "/api/agent"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": args.api_key,
        },
        method="POST",
    )
    return urllib.request.urlopen(request, timeout=args.timeout)


def new_run_state(prompt: str, project_path: str) -> dict[str, Any]:
    return {
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "finishedAt": None,
        "projectPath": os.path.abspath(project_path),
        "prompt": prompt,
        "sessionId": None,
        "status": "running",
        "assistantText": "",
        "toolCalls": [],
        "errors": [],
        "completed": False,
        "done": False,
    }


def truncate_text(value: str, limit: int) -> str:
    if limit <= 0 or len(value) <= limit:
        return value
    return value[:limit].rstrip() + f"\n... [truncated {len(value) - limit} chars]"


def record_event(event: dict[str, Any], state: dict[str, Any]) -> None:
    kind = event.get("kind") or event.get("type") or "event"
    if kind == "session_created":
        state["sessionId"] = event.get("newSessionId") or event.get("sessionId")
    elif kind == "stream_delta":
        state["assistantText"] += str(event.get("content") or "")
    elif kind == "tool_use":
        state["toolCalls"].append(
            {
                "name": event.get("toolName"),
                "input": event.get("toolInput"),
            }
        )
    elif kind == "error":
        state["status"] = "error"
        state["errors"].append(event.get("content") or event.get("error") or event)
    elif kind == "complete":
        state["completed"] = True
        if state["status"] != "error":
            state["status"] = "complete"
    elif kind == "done":
        state["done"] = True


def write_raw_event(handle, event: dict[str, Any]) -> None:
    if handle is None:
        return
    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    handle.flush()


def print_event(event: dict[str, Any], args: argparse.Namespace, state: dict[str, Any]) -> None:
    kind = event.get("kind") or event.get("type") or "event"
    if args.view == "compact":
        print_compact_event(event, args, state)
        return

    if kind == "session_created":
        print(f"[session] {event.get('newSessionId') or event.get('sessionId')}")
    elif kind == "status":
        print(f"[status] {event.get('text') or event.get('message') or event}")
    elif kind == "stream_delta":
        print(event.get("content", ""), end="", flush=True)
    elif kind == "thinking":
        text = event.get("content")
        if text:
            print(f"\n[thinking] {text}", flush=True)
    elif kind == "tool_use":
        print(f"\n[tool] {event.get('toolName')} {event.get('toolInput')}")
    elif kind == "tool_result":
        content = event.get("content", "")
        if content:
            print(f"\n[tool-result] {content}")
    elif kind == "error":
        print(f"\n[error] {event.get('content') or event.get('error') or event}")
    elif kind == "complete":
        print("\n[complete]")
    elif kind == "done":
        print("[done]")
    else:
        print(f"\n[{kind}] {json.dumps(event, ensure_ascii=False)}")


def print_compact_event(event: dict[str, Any], args: argparse.Namespace, state: dict[str, Any]) -> None:
    kind = event.get("kind") or event.get("type") or "event"

    if kind == "session_created":
        print(f"[session] {event.get('newSessionId') or event.get('sessionId')}")
    elif kind == "status":
        text = event.get("text") or event.get("message")
        if text and text not in {"started", "token_budget", "model_request_started", "structured"}:
            print(f"[status] {text}")
    elif kind == "thinking":
        return
    elif kind == "stream_delta":
        print(event.get("content", ""), end="", flush=True)
    elif kind == "tool_use":
        name = event.get("toolName") or "tool"
        tool_input = event.get("toolInput")
        if isinstance(tool_input, dict):
            short_input = json.dumps(tool_input, ensure_ascii=False)
        else:
            short_input = str(tool_input or "")
        print(f"\n[tool] {name} {truncate_text(short_input, 180)}")
    elif kind == "tool_result":
        content = str(event.get("content") or "")
        if content:
            print(f"\n[tool-result] {truncate_text(content, args.tool_result_limit)}")
    elif kind == "error":
        print(f"\n[error] {event.get('content') or event.get('error') or event}")
    elif kind == "complete":
        print("\n[complete]")
    elif kind == "done":
        print("[done]")
    elif kind not in {"structured_output"}:
        print(f"\n[{kind}] {json.dumps(event, ensure_ascii=False)}")


def write_summary(path: Optional[str], state: dict[str, Any]) -> None:
    if not path:
        return
    state["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def run_streaming(response, args: argparse.Namespace, state: dict[str, Any]) -> None:
    raw_handle = None
    if args.raw_jsonl:
        os.makedirs(os.path.dirname(os.path.abspath(args.raw_jsonl)), exist_ok=True)
        raw_handle = open(args.raw_jsonl, "w", encoding="utf-8")
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if not data:
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            print(data)
            continue
        record_event(event, state)
        write_raw_event(raw_handle, event)
        print_event(event, args, state)
    if raw_handle is not None:
        raw_handle.close()


def run_non_streaming(response, state: dict[str, Any]) -> None:
    body = response.read().decode("utf-8", errors="replace")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        print(body)
        return
    if parsed.get("success") is True:
        state["status"] = "complete"
        state["completed"] = True
        state["sessionId"] = parsed.get("sessionId")
    else:
        state["status"] = "error"
        state["errors"].append(parsed.get("error") or parsed)
    print(json.dumps(parsed, ensure_ascii=False, indent=2))


def main() -> int:
    args = apply_config(parse_args())
    prompt = read_prompt(args)
    if not prompt:
        print("Prompt is empty.", file=sys.stderr)
        return 2

    payload = build_payload(args, prompt)
    state = new_run_state(prompt, args.project_path)
    try:
        with open_agent_request(args, payload) as response:
            if args.no_stream:
                run_non_streaming(response, state)
            else:
                run_streaming(response, args, state)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"HTTP {error.code}: {detail}", file=sys.stderr)
        state["status"] = "error"
        state["errors"].append(f"HTTP {error.code}: {detail}")
        write_summary(args.summary_json, state)
        return 1
    except urllib.error.URLError as error:
        print(f"Request failed: {error}", file=sys.stderr)
        state["status"] = "error"
        state["errors"].append(f"Request failed: {error}")
        write_summary(args.summary_json, state)
        return 1
    write_summary(args.summary_json, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
