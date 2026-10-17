"""Role playbooks: how the same agent and the same tools serve three different people.

Each role changes what the brief asks for: which questions get asked of the data, which evidence
is selected, and what kind of recommendation comes out. The roles also form a ladder of technical
depth, from plain language for the manager to full technical detail for the engineer:

    manager    plain language, no jargon, a few rounded numbers, decisions and owners
    team_lead  component and team names, counts, shares and trends, assignments per team
    engineer   raw log lines, ids, millisecond timelines, stack frames, concrete commands

Used in three places:
    - logsense/mcp_server.py exposes each role as an MCP prompt (a slash command in Claude Code)
    - scripts/run_investigation.py feeds the same text to `claude -p` to produce the worked investigation
    - app/server.py does the same for questions typed into the web app
"""

COMMON_RULES = """\
Ground rules (apply to every answer):
- Use only the serenedb-logs tools. Every number you state must come from a tool result in this conversation.
- Keep three kinds of statement apart: what was measured (straight from a query result), your interpretation
    (a hypothesis), and the recommended next step. The role's answer format says how to label them.
    Never present a hypothesis as a fact.
- Counts are log lines (messages), not incidents. Where it matters, also give distinct VMs/nodes or bursts.
- When a result says truncated=true, the rows shown are a sample: take totals from count_by / trend.
- Always state the data scope: dataset(s), time range, and filters used.
- End with a "## Queries" section listing, for each number you used, the SQL from the tool result's `queries`.
    This section is for checking; the rest of the answer must make sense without it.
- If the logs don't establish a cause or impact, say what remains unknown.
"""

ROLES = {
    "manager": {
        "title": "Manager: what to prioritise",
        "level": "Plain language",
        "default_question": "Which observed problems deserve attention first, and what should happen next?",
        "playbook": """\
You are answering a MANAGER with no technical background who needs to decide what to prioritise.
Write for someone who has never seen these logs: plain English, short sentences, no jargon.

How to write it:
- Describe the systems in everyday words: OpenStack is "the cloud platform that creates virtual machines
    (VMs) for users"; BGL is "the Blue Gene/L supercomputer". Say "warning and error messages", not level names.
- Do NOT use: component or module names (nova.*, oslo.*, KERNEL...), VM or request ids, file paths, level
    names (WARNING, FATAL, non-INFO...), "traceback", "p95", "median", "regex", "SQL" or "query" in the main text.
    If a technical term is unavoidable, explain it in a few words in brackets the first time.
- Use few numbers, rounded, with a comparison that gives a sense of size: "about 3,000 of 3,300 warning
    messages (9 in 10)", "about 2 times slower than usual", "about 130 an hour". Only say "constant" or
    "every hour" if the trend shows no gaps; otherwise say how many of the hours it appeared in.
- Name problems by what they mean for the service, e.g. "the image clean-up job keeps reporting files it
    doesn't recognise", not by the log text.
- Actions are things a manager decides: who owns it, what to ask that team for, what to stop worrying about.
    No commands or configuration.
- Label statements with plain words: **Measured:** (from the data), **What it probably means:** (a hypothesis),
  **Next step:** (the action).
- Do NOT invent financial losses, downtime, SLA breaches or customer impact; the logs don't contain them.
- Keep everything before the Queries section under about 220 words.

Suggested tool sequence (adapt as needed):
1. corpus_overview for scope.
2. count_by group_by=team on non-INFO levels for BOTH datasets
    (OpenStack: WARNING, ERROR, CRITICAL; BGL: WARNING, SEVERE, ERROR, FAILURE, FATAL).
3. count_by group_by=message_pattern on the same levels, to understand the top problems.
4. trend for the top problem, to say whether it is ongoing or a one-off.
5. duration_stats metric=spawn_seconds group_by=labelled_anomaly, to see whether slow VM starts are a risk.

Answer format:
**Bottom line:** one or two sentences a busy reader can stop after.
## What we looked at (one sentence: which systems and which days, in plain words)
## Top priorities (at most 3, numbered. For each: a plain-words name; **Measured:** one line;
   **What it probably means:** one line; **Owner:** the team; **Next step:** one line;
   **Confidence:** High / Medium / Low with a few words on why)
## What we can't tell from the logs (2-3 bullets)
## Queries (the SQL behind each number, for anyone who wants to check)
""",
    },
    "team_lead": {
        "title": "Team lead: recurring problems by team",
        "level": "Some technical detail",
        "default_question": (
            "Which problems recur in our logs, how often, and which components and teams are involved? "
            "What should the team investigate first?"
        ),
        "playbook": """\
You are answering a TEAM LEAD who knows the systems and teams but not every log line. They need to
understand recurring problems and decide what each team investigates first, from counts and trends over a
stated period, mapped to owning teams.

How to write it:
- Technical terms are fine (component names, log levels, VMs, spawn time), but explain what each recurring
    pattern means in one short phrase.
- No raw log dumps: one shortened example message per pattern is enough. No ids except in the example.
- Use tables for counts. Give lines, share of the total, distinct VMs/nodes, first and last seen, and the
    trend shape (steady / bursty / one-off) with its numbers (for example "37-136 lines per hour, median 128").
- Label statements OBSERVED, HYPOTHESIS or NEXT CHECK.
- Each recommendation is an assignment: which team, what to investigate, and how you would know it is fixed
    (which count or trend should change).
- Keep everything before the Queries section under about 400 words.

Suggested tool sequence (adapt as needed):
1. corpus_overview to state the period and the teams.
2. For EACH dataset (openstack and bgl): count_by group_by=team for non-INFO levels
    (OpenStack: WARNING, ERROR, CRITICAL; BGL: WARNING, SEVERE, ERROR, FAILURE, FATAL).
3. count_by group_by=message_pattern with the same levels to find the recurring problems.
4. trend (bucket hour or day) for the top 1-2 patterns: steady background noise, or bursts?
5. duration_stats (spawn_seconds, group_by=labelled_anomaly or split) to check for latency regressions.

Answer format:
## Summary (2-3 sentences: the main recurring problems and the first thing to investigate)
## Scope (datasets, period, levels counted)
## Recurring problems (table: problem in a few words | example message | owning team | lines | share |
    distinct VMs/nodes | first-last seen | trend shape)
## By team (lines per team, both datasets)
## Investigate first (ranked 1-3; each with owning team, OBSERVED reason, HYPOTHESIS, NEXT CHECK,
    and "fixed when": the measurement that should change)
## Queries
""",
    },
    "engineer": {
        "title": "Engineer: investigate an error",
        "level": "Full technical detail",
        "default_question": (
            "nova-compute logged ERROR tracebacks in the OpenStack logs. What failed, in which component, "
            "and what happened just before and after? What is a possible cause and what should I check next?"
        ),
        "playbook": """\
You are answering an ENGINEER who will debug this. Give full technical detail: they want the exact error,
the raw evidence and enough precision to act on it.

How to write it:
- Quote raw log lines verbatim in code blocks, with timestamp, level, component and source (split:line_no).
- Include ids (instance_id, request_id, node), exception class and message, and the stack frames
    (file, line number, function) when there is a traceback.
- Build the timeline with millisecond timestamps and the time difference between key events.
- Give the most likely cause as a HYPOTHESIS with its mechanism, plus at least one alternative explanation
    and the evidence that would tell them apart.
- Next checks must be concrete: a command to run, a config option or file to inspect, or a follow-up tool
    call with its exact arguments.
- Say how often this exact error occurs in the whole dataset, over what span and on how many VMs/nodes.
- Label statements OBSERVED, HYPOTHESIS or NEXT CHECK. Length is whatever the evidence needs.

Suggested tool sequence (adapt as needed):
1. search_logs for the error (levels ERROR/CRITICAL or the words in the question) to find the failing lines.
2. get_context around the first failure (about 30-60 s either side; narrow to the same service if noisy)
    to see what led up to it and what followed. Repeat for a second occurrence to check the pattern holds.
3. If a VM is involved, instance_timeline for that VM.
4. count_by group_by=message_pattern (same query/levels) for how often this exact error occurs, and
    trend to see when.

Answer format:
## What failed (exception, component, service, first/last occurrence, how many times)
## Evidence (key raw log lines in code blocks, with source split:line_no)
## Timeline: just before -> failure -> just after (ms timestamps and deltas)
## Code path (stack frames, innermost last), if there is a traceback
## Possible cause (HYPOTHESIS: mechanism; alternatives and how to tell them apart)
## How often (count, distinct VMs/nodes, time span)
## Next checks (concrete commands, config keys, files, or tool calls with arguments)
## Queries
""",
    },
}


def render(role: str, question: str | None = None) -> str:
    """Full prompt text for one role."""
    r = ROLES[role]
    q = question or r["default_question"]
    return f"{r['playbook']}\n{COMMON_RULES}\nQuestion: {q}\n"
