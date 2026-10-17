"""
Three tabs, three paths through the same layers:
    Ask      browser -> /api/ask   -> Claude Code (claude -p) -> MCP server -> logsense.tools -> SereneDB
        (tool calls and their SQL stream back live, the answer is saved to investigation/runs/;
            /api/replay re-streams a saved answer instantly, which keeps a demo independent of wait times)
    Explore  browser -> /api/tools -> logsense.tools -> SereneDB  (same queries, no LLM: instant charts)
    Setup    browser -> /api/setup -> scripts/setup_db.py         (convert + load + index, output streamed)
Binds to 127.0.0.1 only: it can run commands on this machine, so it is not meant to be exposed.
"""
import json
import os
import pathlib
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))  # make `logsense` importable

import psycopg  # noqa: E402
from fastapi import Body, FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from logsense import agent, roles, tools  # noqa: E402

STATIC = pathlib.Path(__file__).resolve().parent / "static"
RUNS = ROOT / "investigation" / "runs"
TOOLS = {f.__name__: f for f in (tools.corpus_overview, tools.search_logs, tools.get_context, tools.count_by,
                                tools.trend, tools.instance_timeline, tools.duration_stats)}
_db_lock = threading.Lock()  # one shared DB connection; requests run in a thread pool

app = FastAPI(title="logsense")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def sse(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False, default=str)}\n\n"


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status():
    db = {"ok": False}
    try:
        with _db_lock:
            conn = tools._connect()
            with conn.cursor() as cur:
                cur.execute("SELECT version()")
                db["version"] = cur.fetchone()[0]
                db["tables"] = {}
                for table in ("openstack_logs", "bgl_logs", "team_ownership"):
                    try:
                        cur.execute(f"SELECT count(*) FROM {table}")
                        db["tables"][table] = cur.fetchone()[0]
                    except psycopg.Error:
                        db["tables"][table] = None
                try:
                    cur.execute("SELECT count(*) FROM openstack_search WHERE message @@ 'instance'")
                    db["search_index"] = True
                except psycopg.Error:
                    db["search_index"] = False
        db["ok"] = True
    except psycopg.Error as e:
        tools._conn = None
        db["error"] = str(e).strip().splitlines()[0]
    data = ROOT / "data"
    return {
        "db": db,
        "claude": agent.claude_path(),
        "mcp_config": (ROOT / ".mcp.json").exists(),
        "csv": {name: (data / name).exists() for name in ("openstack.csv", "bgl.csv")},
    }


@app.get("/api/roles")
def list_roles():
    return [{"id": k, "title": v["title"], "level": v["level"], "question": v["default_question"]}
            for k, v in roles.ROLES.items()]


def _saved_runs():
    """Answers saved by run_investigation.py (investigation/) and by the Ask tab (investigation/runs/)."""
    by_title = {v["title"]: k for k, v in roles.ROLES.items()}
    runs = []
    for folder, source in ((ROOT / "investigation", "worked investigation"), (RUNS, "asked in the web app")):
        for md in folder.glob("*.md"):
            raw = folder / "raw" / f"{md.stem}.jsonl"
            if not raw.exists():
                continue
            lines = md.read_text(encoding="utf-8").splitlines()
            title = lines[0].lstrip("# ").strip() if lines else md.stem
            question = next((ln[2:].strip() for ln in lines if ln.startswith("> ")), "")
            runs.append({"id": md.relative_to(ROOT).as_posix(), "role": by_title.get(title), "title": title,
                        "question": question, "source": source, "mtime": md.stat().st_mtime, "raw": raw})
    return sorted(runs, key=lambda r: r["mtime"], reverse=True)


@app.get("/api/runs")
def list_runs():
    return [{k: v for k, v in r.items() if k != "raw"} for r in _saved_runs()]


@app.post("/api/replay")
def replay(body: dict = Body(...)):
    """Re-stream a saved answer through the same pipeline as a live one (instant, no Claude call)."""
    run = next((r for r in _saved_runs() if r["id"] == body.get("id")), None)
    if not run:
        raise HTTPException(404, "no saved answer with that id")

    def events():
        t = agent.Transcript()
        yield sse({"type": "start", "role": run["role"], "question": run["question"], "replay": run["id"]})
        for line in run["raw"].read_text(encoding="utf-8").splitlines():
            if line.strip():
                for ev in t.feed(json.loads(line)):
                    yield sse(ev)
        yield sse({"type": "done"})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/tools/{name}")
def call_tool(name: str, args: dict = Body(default={})):
    """Explore tab: run one of the MCP tools' query functions directly (no LLM in the loop)."""
    if name not in TOOLS:
        raise HTTPException(404, f"unknown tool {name}")
    try:
        with _db_lock:
            return TOOLS[name](**args)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    except psycopg.Error as e:
        tools._conn = None
        raise HTTPException(502, f"SereneDB error: {str(e).strip().splitlines()[0]}")


@app.post("/api/ask")
def ask(body: dict = Body(...)):
    """Ask Claude a role question; stream its tool calls, their SQL and the final answer as server-sent events."""
    role = body.get("role")
    if role not in roles.ROLES:
        raise HTTPException(400, f"role must be one of {list(roles.ROLES)}")
    question = (body.get("question") or "").strip() or roles.ROLES[role]["default_question"]

    def events():
        t = agent.Transcript()
        yield sse({"type": "start", "role": role, "question": question})
        for raw in agent.raw_events(roles.render(role, question)):
            for ev in t.feed(raw):
                yield sse(ev)
        if t.answer:
            stem = f"{datetime.now():%Y%m%d-%H%M%S}-{role}"
            path = agent.save(t, roles.ROLES[role]["title"], question, RUNS, stem)
            yield sse({"type": "saved", "path": str(path.relative_to(ROOT)).replace(os.sep, "/")})
        yield sse({"type": "done"})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/setup")
def setup(body: dict = Body(default={})):
    """Run scripts/setup_db.py and stream its output line by line."""
    cmd = [sys.executable, "-u", str(ROOT / "scripts" / "setup_db.py")]
    if body.get("download"):
        cmd.append("--download")
    if body.get("reconvert"):
        cmd.append("--reconvert")

    def lines():
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace", cwd=ROOT)
        try:
            for line in proc.stdout:
                yield sse({"type": "line", "text": line.rstrip("\n")})
            proc.wait()
            yield sse({"type": "done", "ok": proc.returncode == 0})
        finally:
            if proc.poll() is None:
                proc.kill()
            tools._conn = None  # tables were rebuilt: start the next query on a fresh connection

    return StreamingResponse(lines(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("LOGSENSE_PORT", "8000"))
    url = f"http://127.0.0.1:{port}"
    print(f"logsense web app on {url}  (Ctrl+C to stop)")
    if not os.getenv("LOGSENSE_NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
