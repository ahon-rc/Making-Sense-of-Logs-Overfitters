# Architecture

The system has four layers, with role playbooks on top and a web app as an optional front door. Each layer does one job. Requests flow down to the database and results flow back up.

```
 You (engineer / team lead / manager)
        │  plain-English question, from the web app, Claude Code or run_investigation.py
        ▼
 ┌──────────────────────────────┐
 │ Claude Code (the agent)      │  decides which tools to call, reads the results, writes the answer
 └──────────────┬───────────────┘
                │  MCP over stdio: "call count_by(dataset='openstack', group_by='team')"
                ▼
 ┌──────────────────────────────┐
 │ logsense/mcp_server.py       │  lists the 7 tools and 3 role prompts, checks arguments,
 │ (MCP layer)                  │  turns errors into messages Claude can act on
 └──────────────┬───────────────┘
                │  Python function call
                ▼
 ┌──────────────────────────────┐
 │ logsense/tools.py            │  fills in a fixed SQL template, runs it, returns
 │ (query layer)                │  rows + exact SQL + scope + true totals + truncated flag
 └──────────────┬───────────────┘
                │  SQL over the PostgreSQL wire protocol (port 7890)
                ▼
 ┌──────────────────────────────┐
 │ SereneDB (docker compose)    │  tables: openstack_logs, bgl_logs, team_ownership
 │                              │  full-text indexes: openstack_search, bgl_search
 └──────────────────────────────┘
                ▲
                │  one-off load: scripts/setup_db.py → logs_to_csv.py → CSV → sql/01..05
          raw Loghub .log files in data/
```

## The layers

### 1. Data layer: `scripts/` and `sql/`

The raw logs are plain text. `scripts/logs_to_csv.py` splits each line into columns (time, level, component, VM id, request id, message and so on) and writes them to CSV. SereneDB then loads the CSVs into typed tables and builds the full-text indexes:

| File | What it does |
|---|---|
| `sql/01_schema.sql` | creates `openstack_logs` and `bgl_logs` |
| `sql/02_load.sql` | `INSERT … SELECT * FROM read_csv('/data/…csv')` |
| `sql/03_ownership.sql` | the fictional component → team table |
| `sql/05_search_index.sql` | a lower-casing text dictionary and the inverted indexes `openstack_search` and `bgl_search` |
| `sql/04_checks.sql` | row counts, components without a team, rows per team |

`scripts/setup_db.py` runs the whole chain with one command. It finds the raw files under `data/` (or downloads them with `--download`), converts them, and sends each SQL file through psycopg, so no `psql` is needed. It runs `05` before `04` so the checks can use the indexes.

`docker-compose.yml` mounts `data/` into the container as `/data`. That is why `read_csv` uses `/data/...` paths: the database server reads the file, not Python.

This only happens once. After it, every question is answered from the database.

### 2. Query layer: `logsense/tools.py`

Each tool is a **fixed SQL template with a few parameters**. Claude never writes SQL. It only chooses the tool and the filters.

That has two benefits:
- The queries are known to be correct and safe. The driver quotes parameters, and options like `group_by` must come from an allow-list.
- The answers are reproducible. Every result includes `queries[].sql`, the exact SQL that ran, which you can paste into `psql` to check a number.

Every result also includes:
- `scope`: the dataset and filters used, so the answer can say what data it covers.
- `truncated`: true when there are more rows than were returned.
- `total_matching_lines` or `total_lines_in_scope`: the real total, counted in the database. Claude never estimates "how often" from the 20 lines it can see.

### 3. MCP layer: `logsense/mcp_server.py`

MCP (Model Context Protocol) is a standard way for an AI app to find and call tools.

The server publishes each tool's name, its **description** (the docstring) and its **input schema** (parameter types, allowed values and a description for each parameter). Claude reads these to decide which tool fits a question, so the descriptions are written for Claude, not for people.

Claude Code starts the server itself as a child process, using the command in `.mcp.json` (`python -m logsense.mcp_server`), and talks to it over stdin and stdout. You never run the server by hand.

### 3b. Role prompts: `logsense/roles.py`

The brief asks for three roles using **the same agent and the same data**. So the roles are not separate programs. They are three **playbooks**: text that tells Claude what that person needs, which tools to reach for and how to shape the answer.

The same text reaches Claude by three routes:
- the MCP server publishes it as **prompts**, which Claude Code shows as slash commands;
- `scripts/run_investigation.py` sends it to `claude -p` to record the worked investigation;
- the web app's Ask tab sends it to `claude -p` and streams the result to the browser.

| | Engineer | Team lead | Manager |
|---|---|---|---|
| Question | What failed and why? | What recurs, and who owns it? | What first, and what next? |
| Main tools | `search_logs`, `get_context`, `instance_timeline` | `count_by` (team, message_pattern), `trend` | `count_by` (team), `duration_stats`, `trend` |
| Evidence shown | raw log lines with source line numbers | tables of counts, shares and trends | one measured number per priority |
| Recommendation | the next technical check | what the team investigates first | ranked actions with a confidence level |

### 4. Agent: Claude Code, driven by `logsense/agent.py`

Claude Code plans the steps. For example, it searches for the error, looks at the surrounding events, counts how often it happens, then explains. It calls the tools and writes the answer.

The server's `instructions` set the ground rules:
- Cite the SQL behind every number.
- Count log lines, not incidents.
- Keep facts, hypotheses and next checks separate.

`logsense/agent.py` runs Claude Code headless and makes its work visible. It starts `claude -p --output-format stream-json` with this repo's `.mcp.json` as its only MCP config, and it pre-approves only the `serenedb-logs` tools. It then reads the event stream as it arrives. Each tool call is paired with its result and reduced to a headline (totals, groups, truncated), the first rows and the SQL. `save()` writes the readable `.md` and the raw `.jsonl`. Both the web app and `run_investigation.py` use this module, so they show exactly the same evidence.

## The web app: `app/`

`app/server.py` is a small FastAPI server on `127.0.0.1:8000`. The page (`app/static/`) is plain HTML, CSS and JavaScript with no build step. Three vendored libraries render markdown (marked and DOMPurify) and charts (Chart.js).

```
 Ask      browser ─POST /api/ask─► agent.py ─► claude -p ─MCP─► mcp_server.py ─► tools.py ─► SereneDB
          ◄──── server-sent events: tool_call, tool_result (headline + SQL), note, final, saved

 Explore  browser ─POST /api/tools/<name>─► tools.py ─► SereneDB      (same functions, no LLM)

 Setup    browser ─POST /api/setup─► scripts/setup_db.py              (output streamed line by line)
          browser ─GET  /api/status─► checks DB, tables, indexes, claude, .mcp.json, CSVs
```

Some design points:

- **The Ask tab goes through Claude Code, not a separate agent.** The web app shows exactly what Claude does in the terminal. It is a window onto the real workflow, not a second implementation of it.
- **Explore calls the query layer directly.** Charts load instantly and cost nothing, and each panel's SQL toggle shows the same SQL Claude would get.
- **Streaming.** `/api/ask` and `/api/setup` return `text/event-stream`, so tool calls and setup output appear as they happen. The browser reads them with `fetch` and a small parser, because `EventSource` cannot send a POST body.
- **Safety.** The server only binds to `127.0.0.1`, because it can run setup. `/api/tools` only accepts the 7 tool names. Claude's markdown is sanitised with DOMPurify before it is shown.

## The tools and who they serve

| Tool | Main role | Question it answers | Database feature |
|---|---|---|---|
| `corpus_overview` | all | What data exists, which time ranges, which teams? | plain aggregates |
| `search_logs` | Engineer | Which lines mention X? | inverted index (`@@`, `websearch_to_tsquery`) |
| `get_context` | Engineer | What happened just before and after? | time-range scan |
| `instance_timeline` | Engineer | What's the full story of one VM? | id lookup + request-id join |
| `count_by` | Team lead, Manager | Which problems recur, how often, which team owns them? | `GROUP BY` + ownership join + `message_pattern` |
| `trend` | Team lead, Manager | Is it growing, steady or a one-off burst? | `date_trunc` buckets |
| `duration_stats` | All | How slow is it, and are the outliers special? | `quantile_cont`, regex extraction |

**`message_pattern`** masks ids and numbers in each message, so lines that differ only by a VM id count as one recurring problem. It is the key grouping for the team-lead question.

## Following one question end to end

The question: *"Something was wrong with instance 544fd51c… What happened?"*

1. Claude reads the tool list and picks `instance_timeline(instance_id='544fd51c…')`.
2. `logsense/mcp_server.py` validates the argument and calls `tools.instance_timeline`.
3. That function runs three SQL queries in SereneDB: a summary, counts per level, and the lines in time order. It returns 28 lines plus the SQL.
4. Claude sees that the spawn took 41.8 s, roughly double the usual 20 s. It calls `duration_stats(metric='spawn_seconds', group_by='labelled_anomaly')` to compare against every other VM.
5. Claude answers with the facts and their SQL, its hypothesis, and the next check.

In the web app, steps 1 to 4 appear one by one in the Evidence panel while they run, and step 5 fills the Answer panel.

## Design choices worth knowing

- **Fixed templates instead of letting Claude write SQL.** The brief allows either. Fixed templates are safer, faster to verify and easier for judges to check.
- **`ClientCursor` in psycopg.** The parameters are merged into the SQL text on our side, so the `sql` we report is exactly what SereneDB ran.
- **Output limits.** Results are capped at 200 rows and messages are cut at 400 characters, which keeps each tool result small enough for Claude's context.
- **Compact JSON output.** Results are sent as compact JSON without pretty-printing, to save tokens.
- **Errors Claude can act on.** An invalid argument returns a message listing the valid options, so Claude can retry with a correct call.
- **One package, many front doors.** `logsense/` holds all the logic. The MCP server, the web app and the scripts are thin wrappers around it, so a fix in one place shows up everywhere.
