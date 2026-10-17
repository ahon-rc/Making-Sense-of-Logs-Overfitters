import argparse
import csv
import os
import re
import sys

# OpenStack line:
# <file> <date> <time> <pid> <LEVEL> <component> [req-... user tenant - - -] <message>
# (the [...] context is missing on traceback continuation lines)
OS_LINE = re.compile(
    r"^(?P<source_file>\S+)\s+(?P<date>\d{4}-\d{2}-\d{2})\s+(?P<time>\d{2}:\d{2}:\d{2}\.\d+)\s+"
    r"(?P<pid>\d+)\s+(?P<level>[A-Z]+)\s+(?P<component>\S+)\s*(?:\[(?P<ctx>[^\]]*)\]\s?)?(?P<message>.*)$"
)
OS_REQ = re.compile(r"(req-[0-9a-f-]{36})(?:\s+(\w+)\s+(\w+))?")
OS_INSTANCE = re.compile(r"\[instance: ([0-9a-f-]{36})\]")
OS_HTTP = re.compile(
    r'"(?P<method>[A-Z]+) (?P<path>\S+) HTTP/[\d.]+" status: (?P<status>\d+) len: \d+ time: (?P<latency>[\d.]+)'
)
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

OS_COLUMNS = [
    "dataset", "split", "line_no", "parsed", "ts", "source_file", "service", "pid", "level", "component",
    "request_id", "user_id", "tenant_id", "instance_id", "http_method", "http_path", "http_status",
    "latency_s", "is_labelled_anomaly", "message",
]

# BGL line:
# <alert_label> <epoch> <date> <node> <timestamp> <node_repeat> <type> <component> <LEVEL> <message>
BGL_COLUMNS = [
    "dataset", "line_no", "parsed", "ts", "epoch", "node", "type", "component", "level",
    "alert_label", "is_alert", "message",
]


def open_text(path):
    return open(path, encoding="utf-8", errors="replace", newline="")


def load_labels(path):
    if not path:
        return set()
    with open_text(path) as f:
        return set(UUID.findall(f.read()))


def split_name(path):
    # openstack_normal1.log -> normal1; anything else -> file name without extension
    base = os.path.splitext(os.path.basename(path))[0]
    return base.split("_", 1)[1] if base.startswith("openstack_") else base


def convert_openstack(paths, out, labels):
    w = csv.DictWriter(out, fieldnames=OS_COLUMNS)
    w.writeheader()
    total = bad = 0
    for path in paths:
        split = split_name(path)
        with open_text(path) as f:
            for line_no, line in enumerate(f, 1):
                line = line.rstrip("\r\n")
                if not line:
                    continue
                total += 1
                row = {"dataset": "openstack", "split": split, "line_no": line_no}
                m = OS_LINE.match(line)
                if not m:
                    bad += 1
                    w.writerow({**row, "parsed": "false", "message": line})
                    continue
                msg = m["message"]
                req = OS_REQ.search(m["ctx"] or "")
                inst = OS_INSTANCE.search(msg)
                http = OS_HTTP.search(msg)
                # some messages mention the instance only as a bare UUID inside a URL path
                instance_id = inst.group(1) if inst else None
                if not instance_id and http:
                    u = UUID.search(http["path"].split("/servers/", 1)[-1]) if "/servers/" in http["path"] else None
                    instance_id = u.group(0) if u else None
                row.update(
                    parsed="true",
                    ts=f"{m['date']} {m['time']}",
                    source_file=m["source_file"],
                    service=m["source_file"].split(".log")[0],  # nova-api / nova-compute / nova-scheduler
                    pid=m["pid"],
                    level=m["level"],
                    component=m["component"],
                    request_id=req.group(1) if req else None,
                    user_id=req.group(2) if req else None,
                    tenant_id=req.group(3) if req else None,
                    instance_id=instance_id,
                    http_method=http["method"] if http else None,
                    http_path=http["path"] if http else None,
                    http_status=http["status"] if http else None,
                    latency_s=http["latency"] if http else None,
                    is_labelled_anomaly="true" if instance_id and instance_id in labels else "false",
                    message=msg,
                )
                w.writerow(row)
    return total, bad


def convert_bgl(paths, out):
    w = csv.DictWriter(out, fieldnames=BGL_COLUMNS)
    w.writeheader()
    total = bad = 0
    for path in paths:
        with open_text(path) as f:
            for line_no, line in enumerate(f, 1):
                line = line.rstrip("\r\n")
                if not line:
                    continue
                total += 1
                row = {"dataset": "bgl", "line_no": line_no}
                parts = line.split(" ", 9)
                ts_raw = parts[4] if len(parts) > 4 else ""
                if len(parts) < 9 or not parts[1].isdigit() or len(ts_raw) < 19:
                    bad += 1
                    w.writerow({**row, "parsed": "false", "message": line})
                    continue
                # 2005-06-03-15.42.50.675872 -> 2005-06-03 15:42:50.675872
                ts = ts_raw[:10] + " " + ts_raw[11:].replace(".", ":", 2)
                label = parts[0]
                row.update(
                    parsed="true",
                    ts=ts,
                    epoch=parts[1],
                    node=parts[3],
                    type=parts[6],
                    component=parts[7],
                    level=parts[8],
                    alert_label=None if label == "-" else label,
                    is_alert="false" if label == "-" else "true",
                    message=parts[9] if len(parts) > 9 else "",
                )
                w.writerow(row)
    return total, bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", choices=["openstack", "bgl"])
    ap.add_argument("inputs", nargs="+", help="raw .log files")
    ap.add_argument("-o", "--output", required=True, help="CSV file to write")
    ap.add_argument("--labels", help="OpenStack anomaly_labels.txt (marks rows for the labelled instances)")
    args = ap.parse_args()

    with open(args.output, "w", encoding="utf-8", newline="") as out:
        if args.kind == "openstack":
            total, bad = convert_openstack(args.inputs, out, load_labels(args.labels))
        else:
            total, bad = convert_bgl(args.inputs, out)
    print(f"{args.output}: {total} rows written, {bad} unparsed lines kept as raw text", file=sys.stderr)


if __name__ == "__main__":
    main()
