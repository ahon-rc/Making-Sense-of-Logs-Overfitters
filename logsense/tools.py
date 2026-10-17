"""Query layer: the parameterised SereneDB queries behind each MCP tool.

SereneDB does all searching and counting; these functions only build SQL from a fixed set of
templates, run it, and package the answer. Every result carries:
    - queries:   the exact SQL that ran (copy-paste into psql to re-check) and how long it took
    - scope:     the dataset and filters that were applied
    - truncated: whether more rows/groups exist than were returned
so the agent can show its evidence and never has to guess counts from a sample.

Connection settings come from environment variables (defaults match the README's docker command):
    SERENEDB_HOST=localhost  SERENEDB_PORT=7890  SERENEDB_USER=postgres  SERENEDB_DB=postgres  SERENEDB_PASSWORD=
"""
import os
import time
from datetime import date, datetime, timedelta
from decimal import Decimal

import psycopg

DATASETS = {
    # entity = the thing an "incident" happens to: a VM for OpenStack, a node for BGL
    "openstack": {"table": "openstack_logs", "index": "openstack_search", "entity": "instance_id",
                "columns": ["ts", "split", "line_no", "level", "service", "component",
                            "instance_id", "request_id", "message"]},
    "bgl": {"table": "bgl_logs", "index": "bgl_search", "entity": "node",
            "columns": ["ts", "line_no", "level", "component", "node", "alert_label", "message"]},
}

# columns count_by may group on (team comes from the ownership table, message_pattern is computed)
GROUP_BY = {
    "openstack": ["team", "component", "level", "service", "instance_id", "http_status", "split", "message_pattern"],
    "bgl": ["team", "component", "level", "node", "alert_label", "message_pattern"],
}

# Collapses ids and numbers so repeated messages group together, e.g.
# "Unknown base file: /var/lib/nova/instances/_base/<ID>"
MESSAGE_PATTERN_SQL = (
    "regexp_replace(regexp_replace(l.message, "
    "'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|req-[0-9a-f-]+', '<ID>', 'g'), "
    "'[0-9]+([.:][0-9]+)*', '<N>', 'g')"
)

BUCKETS = ["minute", "hour", "day", "week"]
MAX_ROWS = 200
MAX_MESSAGE_CHARS = 400

_conn = None


def _connect():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg.connect(
            host=os.getenv("SERENEDB_HOST", "localhost"),
            port=int(os.getenv("SERENEDB_PORT", "7890")),
            user=os.getenv("SERENEDB_USER", "postgres"),
            dbname=os.getenv("SERENEDB_DB", "postgres"),
            password=os.getenv("SERENEDB_PASSWORD") or None,
            autocommit=True,
            # client-side parameter binding: the SQL we log is exactly the SQL the server ran
            cursor_factory=psycopg.ClientCursor,
        )
    return _conn


def _clean(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, str) and len(value) > MAX_MESSAGE_CHARS:
        return value[:MAX_MESSAGE_CHARS] + "…[cut]"
    return value


def _run(sql, params, log):
    """Run one query, append {sql, ms, rows} to log, return list of dicts."""
    conn = _connect()
    with conn.cursor() as cur:
        executed = cur.mogrify(sql, params)
        start = time.perf_counter()
        cur.execute(sql, params)
        rows = cur.fetchall()
        ms = round((time.perf_counter() - start) * 1000, 1)
        names = [d.name for d in cur.description]
    log.append({"sql": " ".join(executed.split()), "ms": ms, "rows": len(rows)})
    return [{k: _clean(v) for k, v in zip(names, row)} for row in rows]


def _dataset(name):
    if name not in DATASETS:
        raise ValueError(f"dataset must be one of {list(DATASETS)}, got {name!r}")
    return DATASETS[name]


def _limit(n, default):
    return max(1, min(int(n or default), MAX_ROWS))


def _filters(dataset, *, start=None, end=None, levels=None, team=None, component=None,
            instance_id=None, request_id=None, node=None, service=None, alias="l"):
    """Shared WHERE clauses. Returns (clauses, params, scope)."""
    clauses, params, scope = [], [], {"dataset": dataset}
    col = f"{alias}." if alias else ""
    if start:
        clauses.append(f"{col}ts >= %s::timestamp"); params.append(start); scope["start"] = start
    if end:
        clauses.append(f"{col}ts < %s::timestamp"); params.append(end); scope["end"] = end
    if levels:
        levels = [lv.upper() for lv in levels]
        clauses.append(f"{col}level IN ({', '.join(['%s'] * len(levels))})"); params += levels; scope["levels"] = levels
    if team:
        clauses.append(f"{col}component IN (SELECT component FROM team_ownership WHERE dataset = %s AND team = %s)")
        params += [dataset, team]; scope["team"] = team
    for name, value in (("component", component), ("instance_id", instance_id), ("request_id", request_id),
                        ("node", node), ("service", service)):
        if value:
            if name in ("instance_id", "request_id", "service") and dataset != "openstack":
                raise ValueError(f"{name} filter only applies to the openstack dataset")
            if name == "node" and dataset != "bgl":
                raise ValueError("node filter only applies to the bgl dataset")
            clauses.append(f"{col}{name} = %s"); params.append(value); scope[name] = value
    return clauses, params, scope


def _where(clauses):
    return ("WHERE " + " AND ".join(clauses)) if clauses else ""


# ---------------------------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------------------------

def corpus_overview():
    log = []
    out = {}
    for name, d in DATASETS.items():
        summary = _run(f"SELECT count(*) AS rows, count(*) FILTER (WHERE NOT parsed) AS unparsed_rows, "
                    f"min(ts) AS first_ts, max(ts) AS last_ts FROM {d['table']}", [], log)[0]
        summary["rows_by_level"] = {r["level"]: r["rows"] for r in _run(
            f"SELECT level, count(*) AS rows FROM {d['table']} GROUP BY level ORDER BY rows DESC", [], log)}
        out[name] = summary
    # the three OpenStack files cover different time windows, so gaps between them are not outages
    out["openstack"]["source_files"] = _run(
        "SELECT split, count(*) AS rows, min(ts) AS first_ts, max(ts) AS last_ts "
        "FROM openstack_logs GROUP BY split ORDER BY first_ts", [], log)
    out["openstack"]["labelled_anomaly_instances"] = [r["instance_id"] for r in _run(
        "SELECT DISTINCT instance_id FROM openstack_logs WHERE is_labelled_anomaly ORDER BY instance_id", [], log)]
    out["bgl"]["alert_rows"] = _run("SELECT count(*) AS n FROM bgl_logs WHERE is_alert", [], log)[0]["n"]
    out["teams"] = _run("SELECT dataset, team, list(component ORDER BY component) AS components "
                        "FROM team_ownership GROUP BY dataset, team ORDER BY dataset, team", [], log)
    return {"tool": "corpus_overview", "scope": {"dataset": "all"}, "result": out, "queries": log,
            "truncated": False}


def search_logs(query, dataset, start=None, end=None, levels=None, team=None, component=None,
                instance_id=None, node=None, limit=20, order="oldest"):
    d = _dataset(dataset)
    limit = _limit(limit, 20)
    clauses, params, scope = _filters(dataset, start=start, end=end, levels=levels, team=team, component=component,
                                    instance_id=instance_id, node=node)
    clauses.insert(0, "l.message @@ websearch_to_tsquery(%s)")
    params.insert(0, query)
    scope["query"] = query
    log = []
    where = _where(clauses)
    total = _run(f"SELECT count(*) AS n FROM {d['index']} l {where}", params, log)[0]["n"]
    direction = "DESC" if order == "newest" else "ASC"
    cols = ", ".join(f"l.{c}" for c in d["columns"])
    rows = _run(f"SELECT {cols} FROM {d['index']} l {where} ORDER BY l.ts {direction}, l.line_no LIMIT {limit}",
                params, log)
    return {"tool": "search_logs", "scope": scope, "total_matching_lines": total, "returned": len(rows),
            "truncated": total > len(rows), "rows": rows, "queries": log}


def get_context(dataset, around, before_seconds=60, after_seconds=60, instance_id=None, request_id=None,
                node=None, service=None, levels=None, limit=100):
    d = _dataset(dataset)
    limit = _limit(limit, 100)
    centre = datetime.fromisoformat(str(around).replace("T", " "))
    start = (centre - timedelta(seconds=float(before_seconds))).isoformat(sep=" ")
    end = (centre + timedelta(seconds=float(after_seconds))).isoformat(sep=" ")
    clauses, params, scope = _filters(dataset, levels=levels, instance_id=instance_id, request_id=request_id,
                                    node=node, service=service)
    clauses = ["l.ts >= %s::timestamp", "l.ts <= %s::timestamp"] + clauses
    params = [start, end] + params
    scope.update(around=str(around), window_start=start, window_end=end)
    log = []
    where = _where(clauses)
    total = _run(f"SELECT count(*) AS n FROM {d['table']} l {where}", params, log)[0]["n"]
    cols = ", ".join(f"l.{c}" for c in d["columns"])
    rows = _run(f"SELECT {cols} FROM {d['table']} l {where} ORDER BY l.ts, l.line_no LIMIT {limit}", params, log)
    return {"tool": "get_context", "scope": scope, "total_lines_in_window": total, "returned": len(rows),
            "truncated": total > len(rows), "rows": rows, "queries": log}


def count_by(dataset, group_by, query=None, start=None, end=None, levels=None, team=None, component=None, top=20):
    d = _dataset(dataset)
    if group_by not in GROUP_BY[dataset]:
        raise ValueError(f"group_by for {dataset} must be one of {GROUP_BY[dataset]}")
    top = _limit(top, 20)
    clauses, params, scope = _filters(dataset, start=start, end=end, levels=levels, team=team, component=component)
    source = d["table"]
    if query:
        source = d["index"]
        clauses.insert(0, "l.message @@ websearch_to_tsquery(%s)")
        params.insert(0, query)
        scope["query"] = query
    scope["group_by"] = group_by
    key = {"team": "coalesce(t.team, '(unowned)')", "message_pattern": MESSAGE_PATTERN_SQL}.get(group_by, f"l.{group_by}")
    # always join ownership so every group says which team(s) own its lines
    join = f"LEFT JOIN team_ownership t ON t.dataset = '{dataset}' AND t.component = l.component"
    teams_col = "" if group_by == "team" else ", list(DISTINCT coalesce(t.team, '(unowned)')) AS teams"
    entity = d["entity"]
    where = _where(clauses)
    log = []
    totals = _run(f"SELECT count(*) AS lines, count(DISTINCT {key}) AS groups FROM {source} l {join} {where}",
                params, log)[0]
    rows = _run(
        f"SELECT {key} AS {group_by}, count(*) AS lines, count(DISTINCT l.{entity}) AS distinct_{entity}s, "
        f"min(l.ts) AS first_seen, max(l.ts) AS last_seen{teams_col} "
        f"FROM {source} l {join} {where} GROUP BY 1 ORDER BY lines DESC, 1 LIMIT {top}", params, log)
    for r in rows:
        r["share_pct"] = round(100.0 * r["lines"] / totals["lines"], 2) if totals["lines"] else 0.0
    return {"tool": "count_by", "scope": scope, "total_lines_in_scope": totals["lines"],
            "total_groups": totals["groups"], "returned": len(rows), "truncated": totals["groups"] > len(rows),
            "rows": rows, "queries": log,
            "note": "Counts are log lines, not incidents: one failure can write many lines."}


def trend(dataset, bucket="day", query=None, start=None, end=None, levels=None, team=None, component=None):
    d = _dataset(dataset)
    if bucket not in BUCKETS:
        raise ValueError(f"bucket must be one of {BUCKETS}")
    clauses, params, scope = _filters(dataset, start=start, end=end, levels=levels, team=team, component=component)
    source = d["table"]
    if query:
        source = d["index"]
        clauses.insert(0, "l.message @@ websearch_to_tsquery(%s)")
        params.insert(0, query)
        scope["query"] = query
    scope["bucket"] = bucket
    log = []
    max_buckets = 500
    rows = _run(f"SELECT date_trunc('{bucket}', l.ts) AS bucket_start, count(*) AS lines, "
                f"count(DISTINCT l.{d['entity']}) AS distinct_{d['entity']}s "
                f"FROM {source} l {_where(clauses)} GROUP BY 1 ORDER BY 1 LIMIT {max_buckets + 1}", params, log)
    truncated = len(rows) > max_buckets
    rows = rows[:max_buckets]
    total = sum(r["lines"] for r in rows)
    peak = max(rows, key=lambda r: r["lines"]) if rows else None
    counts = sorted(r["lines"] for r in rows)
    per_bucket = ({"min": counts[0], "median": counts[len(counts) // 2], "max": counts[-1]} if counts else None)
    return {"tool": "trend", "scope": scope, "total_lines": total, "buckets_with_data": len(rows),
            "lines_per_bucket": per_bucket, "peak_bucket": peak, "truncated": truncated, "rows": rows,
            "queries": log,
            "note": "Buckets with zero matching lines are not listed. lines_per_bucket covers non-empty buckets "
                    "only; the first and last buckets may be partial."}


def instance_timeline(instance_id, levels=None, limit=150):
    limit = _limit(limit, 150)
    log = []
    # Lines that name the VM, plus the other lines of requests that touched only this VM
    # (e.g. the POST /servers that created it). Requests spanning many VMs, like nova-compute's
    # periodic power-state sync, are left out: they would pull in thousands of unrelated lines.
    match = ("(l.instance_id = %s OR l.request_id IN "
            "(SELECT request_id FROM openstack_logs WHERE request_id IN "
            "(SELECT request_id FROM openstack_logs WHERE instance_id = %s) "
            "GROUP BY request_id HAVING count(DISTINCT instance_id) = 1))")
    clauses, params, scope = _filters("openstack", levels=levels)
    clauses.insert(0, match)
    params = [instance_id, instance_id] + params
    scope["instance_id"] = instance_id
    where = _where(clauses)
    summary = _run(
        f"SELECT count(*) AS lines, count(DISTINCT l.request_id) AS requests, min(l.ts) AS first_seen, "
        f"max(l.ts) AS last_seen, bool_or(l.is_labelled_anomaly) AS labelled_anomaly, "
        f"count(*) FILTER (WHERE l.level <> 'INFO') AS non_info_lines "
        f"FROM openstack_logs l {where}", params, log)[0]
    summary["lines_by_level"] = {r["level"]: r["lines"] for r in _run(
        f"SELECT l.level, count(*) AS lines FROM openstack_logs l {where} GROUP BY 1 ORDER BY 2 DESC", params, log)}
    cols = ", ".join(f"l.{c}" for c in DATASETS["openstack"]["columns"])
    rows = _run(f"SELECT {cols} FROM openstack_logs l {where} ORDER BY l.ts, l.line_no LIMIT {limit}", params, log)
    return {"tool": "instance_timeline", "scope": scope, "summary": summary, "returned": len(rows),
            "truncated": summary["lines"] > len(rows), "rows": rows, "queries": log}


# OpenStack writes "Took X seconds to <operation>." for each VM lifecycle step; the API access log
# carries "time: X" per request. These are the numeric signals behind the latency questions.
DURATION_METRICS = {
    "spawn_seconds": "spawn the instance on the hypervisor",
    "build_seconds": "build instance",
    "destroy_seconds": "destroy the instance on the hypervisor",
    "network_deallocate_seconds": "deallocate network for instance",
    "api_latency_seconds": None,  # uses the parsed latency_s column
}
DURATION_GROUPS = ["none", "labelled_anomaly", "split", "service", "http_method", "http_status"]


def duration_stats(metric, group_by="none", start=None, end=None, slowest=10):
    if metric not in DURATION_METRICS:
        raise ValueError(f"metric must be one of {list(DURATION_METRICS)}")
    if group_by not in DURATION_GROUPS:
        raise ValueError(f"group_by must be one of {DURATION_GROUPS}")
    if group_by in ("http_method", "http_status") and metric != "api_latency_seconds":
        raise ValueError("http_method / http_status grouping only applies to api_latency_seconds")
    slowest = _limit(slowest, 10)
    operation = DURATION_METRICS[metric]
    clauses, params, scope = _filters("openstack", start=start, end=end)
    if operation is None:
        value = "l.latency_s"
        clauses.insert(0, "l.latency_s IS NOT NULL")
    else:
        value = f"CAST(regexp_extract(l.message, 'Took ([0-9.]+) seconds to {operation}', 1) AS DOUBLE)"
        clauses.insert(0, f"l.message LIKE '%%seconds to {operation}%%'")
    scope.update(metric=metric, group_by=group_by)
    key = {"none": "'all'", "labelled_anomaly": "l.is_labelled_anomaly"}.get(group_by, f"l.{group_by}")
    where = _where(clauses)
    log = []
    groups = _run(
        f"SELECT {key} AS {group_by if group_by != 'none' else 'grp'}, count(*) AS n, round(avg({value}), 3) AS avg_s, "
        f"round(quantile_cont({value}, 0.5), 3) AS p50_s, round(quantile_cont({value}, 0.95), 3) AS p95_s, "
        f"round(max({value}), 3) AS max_s FROM openstack_logs l {where} GROUP BY 1 ORDER BY 1", params, log)
    top = _run(
        f"SELECT l.ts, l.split, l.line_no, l.instance_id, l.is_labelled_anomaly, l.http_method, l.http_path, "
        f"{value} AS seconds FROM openstack_logs l {where} ORDER BY seconds DESC LIMIT {slowest}", params, log)
    return {"tool": "duration_stats", "scope": scope, "groups": groups, "slowest": top,
            "truncated": False, "queries": log}
