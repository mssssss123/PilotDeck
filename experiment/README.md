# PilotDeck Experiment Runner

This folder contains a small, open-source-friendly batch runner for launching
PilotDeck sessions from the command line.

It does not require changes to PilotDeck core code. It calls the existing
`POST /api/agent` endpoint.

## Files

- `config.yaml`: tracked example config. Keep secrets empty before committing.
- `experiment_case.txt`: one prompt per line.
- `run_experiment_cases.sh`: runs all prompts and writes logs.
- `run_pilotdeck_experiment.py`: runs one prompt.
- `experiment_logs/`: generated logs. Runtime logs are ignored by Git.

## 1. Start PilotDeck

From the PilotDeck repository root:

```bash
npm run dev
```

Keep that terminal running. By default the experiment runner talks to:

```text
http://127.0.0.1:3001
```

## 2. Enter This Folder

In another terminal:

```bash
cd experiment
```

## 3. Prepare Conda

If your environment already exists:

```bash
conda activate pilotdeck-exp
```

If `conda` is not on your PATH but Miniconda is installed under `~/miniconda3`:

```bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate pilotdeck-exp
```

If the environment does not exist yet:

```bash
conda create -y -n pilotdeck-exp -c conda-forge --override-channels python=3.11
conda activate pilotdeck-exp
```

Verify:

```bash
python --version
```

The runner uses the `python` command from the currently active shell environment.

## 4. Configure `config.yaml`

Open `config.yaml` and fill these two required fields:

```yaml
pilotdeck_api_key: "ck_your_key_here"
project_path: "/absolute/path/to/your/project"
```

You can generate a PilotDeck API key from the local server:

```bash
export PILOTDECK_API_KEY="$(
  curl -s -X POST http://127.0.0.1:3001/api/settings/api-keys \
    -H 'Content-Type: application/json' \
    -d '{"keyName":"batch-experiments"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["apiKey"]["apiKey"])'
)"
```

```bash
echo "$PILOTDECK_API_KEY"
```bash

Then write it into `config.yaml`.


Important: do not commit a real `pilotdeck_api_key`.

If you prefer not to edit the tracked `config.yaml`, copy it to a local ignored
file:

```bash
cp config.yaml config.local.yaml
```

Then edit `config.local.yaml` and run with:

```bash
CONFIG_FILE=config.local.yaml bash run_experiment_cases.sh
```

## 5. Run All Cases

```bash
bash run_experiment_cases.sh
```

The script reads:

```text
config.yaml
experiment_case.txt
```

It prints a compact live view and writes logs under:

```text
experiment_logs/YYYYMMDD_HHMMSS/
```

## 6. Read Results

The script prints the exact log directory after every run.

Summary table:

```bash
cat experiment_logs/YYYYMMDD_HHMMSS/summary.tsv
```

Readable case log:

```bash
cat experiment_logs/YYYYMMDD_HHMMSS/case_01.readable.log
```

Raw SSE events:

```bash
cat experiment_logs/YYYYMMDD_HHMMSS/case_01.raw.jsonl
```

Machine-readable summary:

```bash
cat experiment_logs/YYYYMMDD_HHMMSS/case_01.summary.json
```

## Configuration Reference

`config.yaml` supports this simple flat YAML shape:

```yaml
pilotdeck_api_key: ""
project_path: ""
server_url: "http://127.0.0.1:3001"
case_file: "experiment_case.txt"
log_dir: "experiment_logs"
no_stream: false
view: "compact"
tool_result_limit: 600
timeout: 3600
```

Environment variables override YAML:

```bash
PILOTDECK_API_KEY=ck_xxx PROJECT_PATH=/path/to/project bash run_experiment_cases.sh
```

Useful overrides:

```bash
CASE_FILE=/path/to/cases.txt bash run_experiment_cases.sh
LOG_ROOT=/tmp/pilotdeck-exp-logs bash run_experiment_cases.sh
NO_STREAM=1 bash run_experiment_cases.sh
VIEW=raw bash run_experiment_cases.sh
```

## Run One Case

```bash
python run_pilotdeck_experiment.py \
  --message "$(sed -n '1p' experiment_case.txt)" \
  --view compact
```

The single-case runner also reads `config.yaml` by default.

## Troubleshooting

Check PilotDeck Web:

```bash
curl http://127.0.0.1:3001/api/agents/runtime-config
```

If you see `Missing PILOTDECK_API_KEY`, set `pilotdeck_api_key` in the config
or export `PILOTDECK_API_KEY`.

If you see `Project path does not exist`, set `project_path` to an existing
absolute path.
