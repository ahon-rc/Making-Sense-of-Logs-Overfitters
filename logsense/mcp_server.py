"""MCP server: exposes the SereneDB log queries in log_tools.py as tools Claude can call.

Run by Claude Code over stdio (see .mcp.json); you don't start it by hand.
Each tool's docstring is what Claude reads when deciding which tool to call, so the descriptions
say what the tool is for, what it accepts and what it returns.
"""
import json
from typing import Annotated, Literal, Optional

import psycopg
from pydantic import Field

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from logsense import roles
from logsense import tools

INSTRUCTIONS = """\
Tools for investigating the Loghub OpenStack (2017, ~208k lines) and BGL (2005-06, ~4.7M lines) logs stored
in SereneDB. The database searches and counts; you explain.
Rules: call corpus_overview first if you don't know the time ranges or levels. Every number you state must come
from a tool result; quote the SQL from `queries` when you cite it. Counts are log lines, not incidents.
If `truncated` is true, say the rows shown are a sample and use count_by/trend for totals.
Keep observed facts, hypotheses and recommended next checks clearly separated.
"""

mcp = MCPServer("serenedb-logs", instructions=INSTRUCTIONS)


def _call(fn, *args):
    """Run a query function and return compact JSON; turn expected failures into messages Claude can act on."""
    try:
        return json.dumps(fn(*args), ensure_ascii=False, separators=(",", ":"), default=str)
    except ValueError as e:  # bad argument combination, e.g. an invalid group_by
        raise ToolError(str(e)) from e
    except psycopg.OperationalError as e:
        raise ToolError(f"Cannot reach SereneDB ({e}). Is the docker container running on port 7890?") from e
    except psycopg.Error as e:
        raise ToolError(f"SereneDB rejected the query: {e}") from e

Dataset = Annotated[Literal["openstack", "bgl"], Field(description="Which log corpus to query.")]
Start = Annotated[Optional[str], Field(description="Inclusive lower time bound, e.g. '2017-05-16 00:00:00'.")]
End = Annotated[Optional[str], Field(description="Exclusive upper time bound, e.g. '2017-05-17 00:00:00'.")]
Levels = Annotated[Optional[list[str]], Field(
    description="Only these log levels. OpenStack: INFO, WARNING, ERROR, CRITICAL. "
                "BGL: INFO, WARNING, SEVERE, ERROR, FAILURE, FATAL.")]
Team = Annotated[Optional[str], Field(description="Only components owned by this team (see corpus_overview).")]
Component = Annotated[Optional[str], Field(
    description="Exact component, e.g. 'nova.virt.libvirt.imagecache' (OpenStack) or 'KERNEL' (BGL).")]
SearchQuery = Annotated[str, Field(
    description="Web-search style full-text query over the message text, matched on whole words, case-insensitive. "
                "Words are ANDed; \"quoted phrase\" for exact phrases; OR between alternatives; -word to exclude. "
                "Example: '\"unknown base file\"' or 'traceback OR exception'.")]


@mcp.tool(structured_output=False)
def corpus_overview() -> str:
    """Describe what data exists before you query it.

    Returns, per dataset: total rows, unparsed rows, first and last timestamp, rows per log level;
    for OpenStack also each source file's rows and time window (normal1/normal2/abnormal cover different
    periods, so time gaps between them are not outages) and the 4 labelled anomaly instance ids; for BGL the number of alert lines; plus the team-ownership table (team -> components).
    Use it to state the data scope and to pick valid filters for the other tools.
    """
    return _call(tools.corpus_overview)


@mcp.tool(structured_output=False)
def search_logs(
    query: SearchQuery,
    dataset: Dataset,
    start: Start = None,
    end: End = None,
    levels: Levels = None,
    team: Team = None,
    component: Component = None,
    instance_id: Annotated[Optional[str], Field(description="OpenStack only: VM uuid.")] = None,
    node: Annotated[Optional[str], Field(description="BGL only: node id, e.g. 'R02-M1-N0-C:J12-U11'.")] = None,
    limit: Annotated[int, Field(description="Max lines to return (1-200).")] = 20,
    order: Annotated[Literal["oldest", "newest"], Field(description="Return earliest or latest matches first.")] = "oldest",
) -> str:
    """Full-text search for specific log lines (the engineer's starting point: "what failed?").

    Uses the SereneDB inverted index on the message text, combined with optional time, level, team,
    component, instance or node filters. Returns the matching lines (timestamp, level, component,
    ids, message, and source line number for citation), the exact number of matching lines in the whole
    dataset (total_matching_lines), whether the list was truncated, and the SQL that ran.
    Use count_by or trend, not this, to say how often something happens.
    """
    return _call(tools.search_logs, query, dataset, start, end, levels, team, component, instance_id, node, limit, order)


@mcp.tool(structured_output=False)
def get_context(
    dataset: Dataset,
    around: Annotated[str, Field(description="Centre timestamp, usually the ts of a line from search_logs.")],
    before_seconds: Annotated[float, Field(description="How far back to look.")] = 60,
    after_seconds: Annotated[float, Field(description="How far forward to look.")] = 60,
    instance_id: Annotated[Optional[str], Field(description="OpenStack only: narrow to one VM.")] = None,
    request_id: Annotated[Optional[str], Field(description="OpenStack only: narrow to one request (req-...).")] = None,
    node: Annotated[Optional[str], Field(description="BGL only: narrow to one node.")] = None,
    service: Annotated[Optional[Literal["nova-api", "nova-compute", "nova-scheduler"]],
                    Field(description="OpenStack only: narrow to one service.")] = None,
    levels: Levels = None,
    limit: Annotated[int, Field(description="Max lines to return (1-200).")] = 100,
) -> str:
    """Show what happened just before and after a moment (the engineer's "what led up to this?").

    Returns every log line in [around - before_seconds, around + after_seconds] in time order,
    optionally narrowed to one VM, request, node, service or set of levels; plus the total number of
    lines in that window and whether the list was truncated. Use it after search_logs finds an error.
    """
    return _call(tools.get_context, dataset, around, before_seconds, after_seconds, instance_id, request_id, node,
                                service, levels, limit)


@mcp.tool(structured_output=False)
def count_by(
    dataset: Dataset,
    group_by: Annotated[str, Field(
        description="openstack: team, component, level, service, instance_id, http_status, split, message_pattern. "
                    "bgl: team, component, level, node, alert_label, message_pattern. "
                    "message_pattern groups lines whose text is identical once ids and numbers are masked, "
                    "which is how you find recurring problems.")],
    query: Annotated[Optional[str], Field(description="Optional full-text filter, same syntax as search_logs.")] = None,
    start: Start = None,
    end: End = None,
    levels: Levels = None,
    team: Team = None,
    component: Component = None,
    top: Annotated[int, Field(description="Max groups to return, largest first (1-200).")] = 20,
) -> str:
    """Count log lines over the whole dataset, grouped by team, component, level, message pattern, etc.

    The team lead's and manager's main tool: "which problems recur, how often, and who owns them?".
    Each group returns: lines, share_pct of the scope, distinct VMs (OpenStack) or nodes (BGL) affected,
    first_seen, last_seen, and the owning team(s). Also returns total_lines_in_scope, total_groups, truncated, and the SQL.
    Counts are calculated in the database over every matching row, not from a sample.
    """
    return _call(tools.count_by, dataset, group_by, query, start, end, levels, team, component, top)


@mcp.tool(structured_output=False)
def trend(
    dataset: Dataset,
    bucket: Annotated[Literal["minute", "hour", "day", "week"], Field(description="Time bucket size.")] = "day",
    query: Annotated[Optional[str], Field(description="Optional full-text filter, same syntax as search_logs.")] = None,
    start: Start = None,
    end: End = None,
    levels: Levels = None,
    team: Team = None,
    component: Component = None,
) -> str:
    """Count matching log lines per time bucket to see whether a problem is growing, steady or a one-off burst.

    Returns one row per non-empty bucket (bucket_start, lines, distinct VMs or nodes), min/median/max
    lines per bucket, the peak bucket, total lines, and the SQL. Buckets with no matching lines are omitted, so gaps mean zero (or no data
    collected; check corpus_overview for the dataset's time span).
    """
    return _call(tools.trend, dataset, bucket, query, start, end, levels, team, component)


@mcp.tool(structured_output=False)
def instance_timeline(
    instance_id: Annotated[str, Field(description="OpenStack VM uuid, e.g. one of the labelled anomaly instances.")],
    levels: Levels = None,
    limit: Annotated[int, Field(description="Max lines to return (1-200).")] = 150,
) -> str:
    """Reconstruct the full life of one OpenStack VM: create request, claim, image, spawn, delete.

    Returns every line naming the instance plus the other lines of requests that touched only that
    instance (e.g. the POST that created it), in time order; and a summary (line count, requests,
    first/last seen, lines per level, whether it is one of the labelled anomalies). OpenStack only.
    """
    return _call(tools.instance_timeline, instance_id, levels, limit)


@mcp.tool(structured_output=False)
def duration_stats(
    metric: Annotated[Literal["spawn_seconds", "build_seconds", "destroy_seconds", "network_deallocate_seconds",
                            "api_latency_seconds"],
                    Field(description="VM lifecycle step durations parsed from 'Took X seconds to ...' lines, "
                                        "or API request latency from the nova-api access log.")],
    group_by: Annotated[Literal["none", "labelled_anomaly", "split", "service", "http_method", "http_status"],
                        Field(description="Compare groups, e.g. labelled_anomaly to compare the 4 labelled VMs "
                                        "with all others. http_* only for api_latency_seconds.")] = "none",
    start: Start = None,
    end: End = None,
    slowest: Annotated[int, Field(description="How many of the slowest individual cases to list (1-200).")] = 10,
) -> str:
    """Latency distribution for OpenStack: count, average, median (p50), p95 and max, per group.

    Also lists the slowest individual cases with their instance id, timestamp and source line, so
    outliers can be investigated with instance_timeline or get_context. OpenStack only.
    """
    return _call(tools.duration_stats, metric, group_by, start, end, slowest)


# ---------------------------------------------------------------------------------------------
# Role prompts: in Claude Code these appear as slash commands, e.g.
#   /mcp__serenedb-logs__engineer  /mcp__serenedb-logs__team_lead  /mcp__serenedb-logs__manager
# Same tools and data for everyone; each role changes the questions, evidence and recommendation.
# ---------------------------------------------------------------------------------------------

QuestionArg = Annotated[Optional[str], Field(description="Your question. Leave empty to use the role's default.")]


@mcp.prompt(title=roles.ROLES["engineer"]["title"])
def engineer(question: QuestionArg = None) -> str:
    """Investigate an error: what failed, where, what happened before and after, and the next check."""
    return roles.render("engineer", question)


@mcp.prompt(title=roles.ROLES["team_lead"]["title"])
def team_lead(question: QuestionArg = None) -> str:
    """Recurring problems: counts and trends per owning team, and what to investigate first."""
    return roles.render("team_lead", question)


@mcp.prompt(title=roles.ROLES["manager"]["title"])
def manager(question: QuestionArg = None) -> str:
    """Prioritised risks and actions from measured frequency, without invented impact."""
    return roles.render("manager", question)


if __name__ == "__main__":
    mcp.run()  # stdio: Claude Code starts this process and talks to it over stdin/stdout