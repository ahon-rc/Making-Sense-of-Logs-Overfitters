# logsense: the right insights for the right people

An engineer, a team lead and a manager ask questions about the same logs (Loghub BGL and OpenStack) and each gets an answer shaped for their job.
SereneDB does the searching and counting. Claude chooses which tools to call through an MCP server, reads the results and explains them.
Every number in an answer comes with the SQL that produced it.

There are three ways to use it:

- **A local web app** (`python app/server.py`). Pick a role, ask a question, and watch Claude's tool calls and their SQL appear live next to the answer. It also has a data explorer and a one-button setup.
- **Claude Code** in this folder. It starts the MCP server from `.mcp.json`, and the three roles are slash commands.
- **A recorded investigation** (`python scripts/run_investigation.py`). It runs all three roles headless and saves the answers with every tool call and query.

## Quick start

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/), Python 3.10 or newer, and [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), signed in once by running `claude`.

From the repo folder:

```
docker compose up -d                   # 1. start SereneDB 26.10.1 on localhost:7890
pip install -r requirements.txt        # 2. Python packages
python scripts/setup_db.py --download  # 3. download the logs, convert, load, index, check
python app/server.py                   # 4. open the web app at http://127.0.0.1:8000
```

On macOS and Linux, use `python3` and `pip3` if `python` is not Python 3.

About step 3:

- If you already have the raw files, put them anywhere under `data/` and leave out `--download`. The files are `openstack_normal1.log`, `openstack_normal2.log`, `openstack_abnormal.log`, `anomaly_labels.txt` and `BGL.log`.
- If `data/openstack.csv` and `data/bgl.csv` already exist, conversion is skipped.
- Converting and loading the 4.7M BGL lines takes a few minutes.
- You can also run this step from the web app's **Setup** tab, which streams the same output.

`setup_db.py` sends the SQL in `sql/` with the same Python driver the tools use, so you don't need `psql`.
If you prefer `psql`, run `psql -h localhost -p 7890 -U postgres -f sql/rebuild.sql` after the CSVs exist.

## Using it

### Web app

`python app/server.py` serves on `127.0.0.1:8000` and opens your browser. It only listens on your own machine, because it can run setup commands.

| Tab | What it does | Path through the system |
|---|---|---|
| **Ask Claude** | Pick Manager, Team lead or Engineer. The role's default question is filled in and you can change it. Claude's tool calls appear in the Evidence panel as they happen, each with its headline numbers, first rows and the exact SQL. The answer is saved to `investigation/runs/`, and **Show a saved answer** replays any earlier answer instantly. | browser → Claude Code (`claude -p`) → MCP server → SereneDB |
| **Explore data** | Charts and tables from the same query functions, without the LLM. It shows non-INFO lines by team, a trend with a full-text filter, the top recurring message patterns, VM spawn times, and log search. Every panel has a **SQL** toggle. | browser → query layer → SereneDB |
| **Setup** | A checklist of what is ready (database, CSVs, tables, indexes, Claude Code, `.mcp.json`) and a **Run setup** button. | browser → `scripts/setup_db.py` |

The Ask tab uses your own Claude Code login, so questions count against your Claude plan. Each answer shows how long it took and what it cost.

### Claude Code

```
claude
```

Run this in the repo folder. Claude Code reads `.mcp.json` and starts the `serenedb-logs` MCP server itself. Approve it when asked, then check with `/mcp` that it shows as connected.

Then either ask a question in your own words, or use a role:

```
/mcp__serenedb-logs__engineer
/mcp__serenedb-logs__team_lead
/mcp__serenedb-logs__manager  Which BGL problems should we look at first?
```

With no text after the command, the role's default question is used.

### Recorded investigation

```
python scripts/run_investigation.py            # all three roles
python scripts/run_investigation.py engineer   # one role
python scripts/run_investigation.py engineer --question "What happened to instance 544fd51c-4edc-4780-baae-ba1d80a0acfc?"
```

For each role this writes `investigation/<role>.md`, which holds the question, the answer, and every tool call in order with its arguments, headline numbers and exact SQL.
The full event stream goes to `investigation/raw/<role>.jsonl`.

## How it works

```mermaid
flowchart LR
  q["<b>Question</b><br/>web app, slash command<br/>or script"] --> c["<b>Claude Code</b><br/>picks the tools,<br/>writes the answer"]
  c -- MCP --> m["<b>logsense/mcp_server.py</b><br/>7 tools + 3 role prompts"]
  m --> t["<b>logsense/tools.py</b><br/>fixed SQL templates"]
  t -- SQL --> d[("<b>SereneDB</b><br/>log tables +<br/>full-text indexes")]
  d -. "rows, true totals and the SQL that ran" .-> c
```

- **SereneDB holds the logs**, one row per log line, in typed tables with inverted (full-text) indexes. All searching and counting happens there.
- **The query layer** (`logsense/tools.py`) is seven fixed SQL templates. Claude never writes SQL. It picks a tool and its filters, and every result carries the exact SQL that ran, the scope, the true total, and a `truncated` flag.
- **The MCP server** (`logsense/mcp_server.py`) publishes those functions as tools, with descriptions written for Claude to read. It also publishes the three role playbooks as prompts.
- **The roles** (`logsense/roles.py`) are playbooks, not separate programs. The same agent, tools and data serve all three people. What changes is the question, the evidence each role gathers and the kind of recommendation.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains each layer, the web app, the design choices and one question followed end to end.

## Repository layout

![How the folders connect: what you run at the top, the logsense package in the middle, SereneDB at the bottom, and the one-time database build on the right](docs/repo-structure.svg)

| Folder | What's in it | You open it to |
|---|---|---|
| `app/` | The web app: `server.py` is the API, `static/` is the page | change the web page |
| `logsense/` | The shared Python package: `tools.py` (the 7 SQL queries), `mcp_server.py` (offers them to Claude), `roles.py` (the 3 role playbooks), `agent.py` (runs Claude Code and records its tool calls) | change a query, a tool description or a role |
| `scripts/` | Commands you run: `setup_db.py` builds the database, `logs_to_csv.py` parses the raw logs, `run_investigation.py` records the 3 role answers | set up, or record the investigation |
| `sql/` | The database build, in order: schema, load, team ownership, search indexes, checks | change the tables or the team mapping |
| `data/` | Your raw logs and the generated CSVs (not in git) | add the log files |
| `investigation/` | The saved role answers, each with every tool call and its SQL | check what Claude said and why |
| `docs/` | `ARCHITECTURE.md` and this diagram | read the full explanation |

Three files sit at the top level: `docker-compose.yml` starts SereneDB, `.mcp.json` tells Claude Code how to start the MCP server, and `requirements.txt` lists the Python packages.

## Tools

Every tool returns JSON with `queries` (the exact SQL that ran, with timings and row counts), `scope` (the dataset and filters used) and `truncated`.
Results are capped at 200 rows and messages at 400 characters. Totals are always counted in the database, not from the returned sample.

| Tool | Inputs | Returns |
|---|---|---|
| `corpus_overview` | none | rows, time span and rows per level for each dataset; the time window of each OpenStack source file; the labelled anomaly VMs; BGL alert lines; the team → components mapping |
| `search_logs` | `query` (full-text: `"phrase"`, `OR`, `-exclude`), `dataset`, optional `start`/`end`/`levels`/`team`/`component`/`instance_id`/`node`, `limit`, `order` | matching lines and the exact `total_matching_lines` |
| `get_context` | `dataset`, `around` timestamp, `before_seconds`/`after_seconds`, optional VM/request/node/service/level filters, `limit` | every line in that time window, in order |
| `count_by` | `dataset`, `group_by` (team, component, level or message_pattern; also service, instance_id, http_status and split for OpenStack, node and alert_label for BGL), optional `query`/time/levels/team/component, `top` | per group: lines, share %, distinct VMs or nodes, first and last seen, owning teams; the total in scope and the number of groups |
| `trend` | `dataset`, `bucket` (minute/hour/day/week), optional `query`/time/levels/team/component | lines per bucket, min/median/max per bucket, and the peak bucket |
| `instance_timeline` | `instance_id`, optional `levels`, `limit` | the life of one OpenStack VM in order, plus a summary |
| `duration_stats` | `metric` (spawn/build/destroy/network-deallocate seconds, or API latency), `group_by`, optional time range, `slowest` | count, average, p50, p95 and max per group, plus the slowest individual cases |

`message_pattern` masks ids, long hex strings and numbers, so lines that differ only by a VM id count as one recurring problem.

## The three roles

The roles form a ladder of technical depth. The manager gets plain language, the team lead gets component names, counts and trends, and the engineer gets raw log lines, ids and stack frames.

| | Manager | Team lead | Engineer |
|---|---|---|---|
| **Detail level** | Plain language: no jargon, a few rounded numbers | Some technical detail: components, counts, shares, trends | Full technical detail: raw lines, ids, millisecond timelines, stack frames |
| **Default question** | Which observed problems deserve attention first, and what should happen next? | Which problems recur, how often, and which components or teams are involved? | What failed, in which component, and what happened just before and after? |
| **Evidence it gathers** | team totals for both datasets, the top problems, whether the top one is ongoing, slow-start risk | counts per team and per message pattern for both datasets, hourly or daily trends, spawn-time comparison | full-text search for the error, the events around it, the VM's timeline, how often this exact error occurs |
| **What it recommends** | at most 3 priorities, each with an owner, a next step and a confidence level, plus what the logs can't tell us | the 1–3 problems each team investigates first, and the measurement that will show it is fixed | the likely cause with alternatives, and concrete next checks: commands, config values, follow-up queries |
| **Facts and guesses labelled as** | Measured / What it probably means / Next step | OBSERVED / HYPOTHESIS / NEXT CHECK | OBSERVED / HYPOTHESIS / NEXT CHECK |

Every role states the data scope, counts log lines rather than incidents, never invents costs, downtime or customer impact, and ends with the SQL behind each number. In the web app that SQL section is folded under the answer, one click away.

## Worked investigation

The saved answers are in [investigation/](investigation/). The OpenStack findings are below. The BGL ones are in the role files.

- **Engineer.** The 8 nova-compute ERROR tracebacks all come from the image-cache periodic task (`_run_image_cache_manager_pass`) failing with `InvalidDiskInfo`. `qemu-img info` ran on an instance disk that had been deleted about 20 ms earlier. The answer labels this a likely race between deleting an instance and the cache audit. It is a hypothesis to confirm on the other 7 occurrences.
- **Team lead.** `Unknown base file` warnings are 3,059 of the 3,314 non-INFO OpenStack lines (92%), all from Storage & Images. They appear in 26 of the 32 hours the logs cover, at 37 to 136 lines per hour (median 128), and they drown out the real image-cache errors owned by Platform Runtime.
- **Manager.** Priority 1 is the image-cache warnings, because they are constant and hide real errors. Priority 2 is the image-cache task failures. Slow VM starts are flagged but not ranked: the 4 labelled VMs averaged 38.3 s to spawn against 19.8 s for the other 2,062, and 4 cases are too few to call a trend.

What the data does not establish: user impact, downtime or cost; whether the warnings cause any failure; and the cause of the traceback, which stays a hypothesis.
The three OpenStack files cover separate time windows (05-14 19:39–21:56, 05-16 00:00–06:25 and 05-16 15:15 to 05-17 12:02), so the gaps between them are not outages.

## How this meets the brief

| Criterion | Where to look |
|---|---|
| Role-appropriate insight (30%) | `logsense/roles.py`. Each role uses different tools, evidence and recommendations, not just a different answer length. See `investigation/*.md`. |
| Search and analytics together (25%) | `search_logs` and `get_context` use SereneDB's inverted index, with phrases, OR, exclusions and time filters. `count_by` and `trend` aggregate over the whole tables, joined to team ownership. Every result reports its true total and whether it was truncated. |
| Recommendation quality (25%) | Statements are labelled OBSERVED / HYPOTHESIS / NEXT CHECK, each number links to its SQL, and every answer has a "what we don't know" section. |
| Execution (20%) | `docker compose up -d` and one setup script, tested from a clean copy. The web app shows the workflow live. |
| Best MCP Server (special award) | 7 tools with descriptions written for the agent, allow-listed arguments, row and message limits, errors that list the valid options, and 3 role prompts. |

## Data model

### `openstack_logs` (207,820 rows)

There is one row per line of `openstack_normal1.log`, `openstack_normal2.log` and `openstack_abnormal.log`.

- `ts`, `service` (nova-api, nova-compute or nova-scheduler), `level`, `component` and `message`.
- `request_id` links the API and compute lines of one request.
- `instance_id` is the VM.
- `http_method`, `http_path`, `http_status` and `latency_s` are set on API access lines.
- `is_labelled_anomaly` is true when `instance_id` is one of the 4 ids in `anomaly_labels.txt`.
- `split` and `line_no` point back to the source file and line.

### `bgl_logs` (4,747,963 rows)

There is one row per line of `BGL.log`.

- `ts`, `node`, `component`, `level` and `message`.
- `alert_label` is the Loghub alert category, which is NULL for normal lines, and `is_alert` is its boolean form.

Lines that don't match the expected format are kept with `parsed = false` and the raw text in `message`, so row counts always equal line counts.

## Team ownership (fictional)

The brief asks for an invented component → team mapping, so that counts can be grouped by team. It lives in `sql/03_ownership.sql`.

| Dataset | Component | Team |
|---|---|---|
| openstack | nova.osapi_compute.wsgi.server, nova.api.openstack.wsgi, nova.api.openstack.compute.server_external_events, nova.metadata.wsgi.server | API Gateway |
| openstack | keystonemiddleware.auth_token | Identity & Access |
| openstack | nova.scheduler.host_manager | Scheduling |
| openstack | nova.compute.manager, nova.compute.claims, nova.compute.resource_tracker | Compute |
| openstack | nova.virt.libvirt.driver | Virtualization |
| openstack | nova.virt.libvirt.imagecache | Storage & Images |
| openstack | oslo_service.periodic_task | Platform Runtime |
| bgl | KERNEL | HPC Node Software |
| bgl | APP | HPC User Workloads |
| bgl | MMCS, BGLMASTER, CMCS | HPC Control System |
| bgl | DISCOVERY, HARDWARE, MONITOR | HPC Hardware Ops |
| bgl | LINKCARD, SERV_NET | HPC Network |

Check 2 in `sql/04_checks.sql` lists any component without a team, so gaps show up right after loading.

## Connecting to another SereneDB instance

The tools, setup script and web app read `SERENEDB_HOST`, `SERENEDB_PORT`, `SERENEDB_USER`, `SERENEDB_DB` and `SERENEDB_PASSWORD`. The defaults are `localhost`, `7890`, `postgres`, `postgres` and no password.

- For Claude Code, change the `env` block in `.mcp.json`.
- For the web app and scripts, set the variables in your shell before running them.

`sql/02_load.sql` reads `/data/openstack.csv` and `/data/bgl.csv` from the database server's own filesystem. A remote instance therefore needs those files at that path, which `docker-compose.yml` arranges for the local one.

## Troubleshooting

- **`'claude' is not recognized`** (Windows): Claude Code is not on your PATH. Reinstall it or open a new terminal. The web app's Setup tab shows whether it found `claude`.
- **`role "root" does not exist`** or a password prompt from `psql`: add `-U postgres -d postgres`. The container accepts that user without a password.
- **Port 7890 already in use**: an older SereneDB container is still running. Remove it with `docker rm -f serenedb`, then run `docker compose up -d`.
- **The MCP server doesn't show in `/mcp`**: start `claude` from the repo folder, so that `python -m logsense.mcp_server` can find the package. Run `pip install -r requirements.txt` in the same Python that `python` points to.

## Known limitations

- OpenStack timestamps have no timezone, so they are stored as written.
- `instance_id` is only set when a line names the VM, either as `[instance: …]` or in a `/servers/<id>` URL. Other lines of the same request are reached through `request_id`.
- A Python traceback spans several log lines and each becomes its own ERROR row. Counts are log lines, not separate incidents, and the answers say so.
- Only 4 OpenStack VMs are labelled anomalous, which is too few for statistical claims. The answers treat the spawn-time gap as a signal, not a trend.
- The web app is for one person on one machine. It has no login and only listens on `127.0.0.1`.
