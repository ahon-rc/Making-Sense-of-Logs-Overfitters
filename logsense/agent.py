"""Run Claude Code headless against our MCP server and turn its event stream into checkable evidence.

Shared by scripts/run_investigation.py (batch) and app/server.py (live, streamed to the browser).
Claude Code does the agent work; we only start it, watch which tools it calls, and record the
SQL each tool ran next to Claude's final answer.
"""
import json
import pathlib
import shutil
import subprocess
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOL_PREFIX = "mcp__serenedb-logs__"

# fields worth showing at a glance for each tool result
HEADLINE_KEYS = ["total_matching_lines", "total_lines_in_window", "total_lines_in_scope", "total_groups",
                "total_lines", "buckets_with_data", "lines_per_bucket", "peak_bucket", "summary", "groups",
                "returned", "truncated"]


def claude_path():
    return shutil.which("claude")


def raw_events(prompt: str):
    """Start `claude -p` with our MCP server only, feed it the prompt, yield its JSON events as they arrive."""
    exe = claude_path()
    if not exe:
        yield {"type": "_error", "message": "Claude Code CLI not found on PATH. Install it and run `claude` once to sign in."}
        return
    cmd = [exe, "-p", "--output-format", "stream-json", "--verbose",
        "--mcp-config", str(ROOT / ".mcp.json"), "--strict-mcp-config",
        "--allowedTools", f"{TOOL_PREFIX}*"]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    other = []
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                if line:
                    other.append(line)
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                other.append(line)
        proc.wait()
        if proc.returncode != 0:
            yield {"type": "_error", "message": "\n".join(other[-20:]) or f"claude exited with code {proc.returncode}"}
    finally:
        if proc.poll() is None:  # browser went away mid-answer: don't leave Claude running
            proc.kill()


def _parse_result(content):
    text = content if isinstance(content, str) else "".join(
        c.get("text", "") for c in content or [] if isinstance(c, dict))
    try:
        parsed = json.loads(text)
        # some clients wrap plain-text tool output as {"result": "<json>"}
        if isinstance(parsed, dict) and set(parsed) == {"result"} and isinstance(parsed["result"], str):
            parsed = json.loads(parsed["result"])
        return parsed
    except json.JSONDecodeError:
        return {"error": text}


def summarize(result: dict) -> dict:
    """The parts of a tool result worth showing a person: headline numbers, a few rows, the SQL."""
    return {
        "headline": {k: result[k] for k in HEADLINE_KEYS if k in result},
        "rows_preview": (result.get("rows") or [])[:5],
        "queries": result.get("queries", []),
        "error": result.get("error"),
    }


class Transcript:
    """Accumulates one Claude run: tool calls paired with results, the final answer, cost."""

    def __init__(self):
        self.raw, self.calls, self._by_id = [], [], {}
        self.answer, self.cost_usd, self.duration_ms, self.error = "", None, None, None

    def feed(self, ev: dict) -> list:
        """Record one raw event; return simplified events for live display."""
        self.raw.append(ev)
        out = []
        if ev.get("type") == "_error":
            self.error = ev["message"]
            return [{"type": "error", "message": ev["message"]}]
        msg = ev.get("message") or {}
        content = msg.get("content") if isinstance(msg.get("content"), list) else []
        for block in content:
            kind = block.get("type")
            if kind == "tool_use" and block.get("name", "").startswith(TOOL_PREFIX):
                call = {"id": block["id"], "tool": block["name"][len(TOOL_PREFIX):], "args": block.get("input", {}),
                        "result": None}
                self._by_id[block["id"]] = call
                self.calls.append(call)
                out.append({"type": "tool_call", "id": call["id"], "tool": call["tool"], "args": call["args"]})
            elif kind == "tool_result" and block.get("tool_use_id") in self._by_id:
                call = self._by_id[block["tool_use_id"]]
                call["result"] = _parse_result(block.get("content"))
                out.append({"type": "tool_result", "id": call["id"], "tool": call["tool"], **summarize(call["result"])})
            elif kind == "text" and ev.get("type") == "assistant" and block.get("text", "").strip():
                out.append({"type": "note", "text": block["text"]})
        if ev.get("type") == "result":
            self.answer = ev.get("result", "") or ""
            self.cost_usd, self.duration_ms = ev.get("total_cost_usd"), ev.get("duration_ms")
            out.append({"type": "final", "answer": self.answer, "cost_usd": self.cost_usd,
                        "duration_ms": self.duration_ms, "tool_calls": len(self.calls)})
        return out


def run(prompt: str) -> Transcript:
    t = Transcript()
    for ev in raw_events(prompt):
        t.feed(ev)
    return t


def to_markdown(title: str, question: str, t: Transcript) -> str:
    lines = [f"# {title}", "", f"_Generated with Claude Code + the serenedb-logs MCP server on {datetime.now():%Y-%m-%d %H:%M}._",
            "", "## Question", "", f"> {question}", "", "## Answer", "", (t.answer or f"(no answer: {t.error})").strip(),
            "", f"## Tool calls ({len(t.calls)})", "", "Every call Claude made, in order, with the exact SQL SereneDB ran.", ""]
    for i, c in enumerate(t.calls, 1):
        res = c["result"] or {}
        lines += [f"### {i}. `{c['tool']}`", "", "```json", json.dumps(c["args"], ensure_ascii=False), "```", ""]
        if "error" in res:
            lines += [f"Error: {res['error']}", ""]
            continue
        s = summarize(res)
        if s["headline"]:
            lines += ["Result headline:", "", "```json", json.dumps(s["headline"], ensure_ascii=False)[:1500], "```", ""]
        if s["rows_preview"]:
            lines += [f"First rows ({min(3, len(s['rows_preview']))} of {res.get('returned', len(res['rows']))} returned):",
                    "", "```json"]
            lines += [json.dumps(row, ensure_ascii=False)[:400] for row in s["rows_preview"][:3]]
            lines += ["```", ""]
        for q in s["queries"]:
            lines += [f"SQL ({q['ms']} ms, {q['rows']} rows):", "", "```sql", q["sql"], "```", ""]
    return "\n".join(lines)


def save(t: Transcript, title: str, question: str, out_dir: pathlib.Path, stem: str) -> pathlib.Path:
    """Write <stem>.md (readable) and raw/<stem>.jsonl (full event stream, for auditing)."""
    (out_dir / "raw").mkdir(parents=True, exist_ok=True)
    (out_dir / "raw" / f"{stem}.jsonl").write_text("\n".join(json.dumps(e) for e in t.raw), encoding="utf-8")
    path = out_dir / f"{stem}.md"
    path.write_text(to_markdown(title, question, t), encoding="utf-8")
    return path
