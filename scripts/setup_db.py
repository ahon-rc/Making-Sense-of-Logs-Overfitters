"""One-command setup: raw Loghub logs -> CSV -> SereneDB tables, team ownership, search indexes, checks.

Usage (from the repo root, with SereneDB running via `docker compose up -d`):
    python scripts/setup_db.py              # use logs already in data/
    python scripts/setup_db.py --download   # first download + unpack BGL and OpenStack from Zenodo into data/raw/
    python scripts/setup_db.py --reconvert  # rebuild the CSVs even if they exist

What it does:
    1. finds the raw files anywhere under data/ (openstack_*.log, anomaly_labels.txt, BGL.log)
    2. converts them to data/openstack.csv and data/bgl.csv (skipped if the CSVs already exist)
    3. runs sql/01_schema, 02_load, 03_ownership, 05_search_index, 04_checks against SereneDB
No psql needed: SQL is sent with the same Python driver the MCP server uses.
"""
import argparse
import pathlib
import sys
import tarfile
import time
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))  # make `logsense` importable
sys.path.insert(0, str(ROOT / "scripts"))

import psycopg  # noqa: E402

import logs_to_csv  # noqa: E402
from logsense import tools  # noqa: E402

DATA = ROOT / "data"
SQL = ROOT / "sql"
SQL_ORDER = ["01_schema.sql", "02_load.sql", "03_ownership.sql", "05_search_index.sql", "04_checks.sql"]
DOWNLOADS = {
    "OpenStack.tar.gz": "https://zenodo.org/records/8196385/files/OpenStack.tar.gz?download=1",
    "BGL.zip": "https://zenodo.org/records/8196385/files/BGL.zip?download=1",
}
OPENSTACK_LOGS = ["openstack_normal1.log", "openstack_normal2.log", "openstack_abnormal.log"]


def step(msg):
    print(f"\n==> {msg}", flush=True)


def download():
    raw = DATA / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    for name, url in DOWNLOADS.items():
        archive = raw / name
        if not archive.exists():
            step(f"Downloading {name} (this can take a few minutes)")
            urllib.request.urlretrieve(url, archive)
        step(f"Unpacking {name}")
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(raw)
        else:
            with tarfile.open(archive) as t:
                try:
                    t.extractall(raw, filter="data")
                except TypeError:  # Python < 3.12
                    t.extractall(raw)


def find(name):
    hits = sorted(p for p in DATA.rglob(name) if p.is_file())
    return hits[0] if hits else None


def convert(force):
    os_csv, bgl_csv = DATA / "openstack.csv", DATA / "bgl.csv"
    if os_csv.exists() and bgl_csv.exists() and not force:
        step("CSVs already in data/ (use --reconvert to rebuild them)")
        return
    needed = OPENSTACK_LOGS + ["anomaly_labels.txt", "BGL.log"]
    found = {n: find(n) for n in needed}
    missing = [n for n, p in found.items() if p is None]
    if missing:
        sys.exit(f"Missing raw files under data/: {', '.join(missing)}\n"
                "Run with --download, or unpack BGL.zip and OpenStack.tar.gz from the brief into data/.")
    step("Converting OpenStack logs -> data/openstack.csv")
    with open(os_csv, "w", encoding="utf-8", newline="") as out:
        total, bad = logs_to_csv.convert_openstack([found[n] for n in OPENSTACK_LOGS], out,
                                                    logs_to_csv.load_labels(found["anomaly_labels.txt"]))
    print(f"    {total:,} rows, {bad} unparsed")
    step("Converting BGL log -> data/bgl.csv (about 4.7M lines, a minute or two)")
    with open(bgl_csv, "w", encoding="utf-8", newline="") as out:
        total, bad = logs_to_csv.convert_bgl([found["BGL.log"]], out)
    print(f"    {total:,} rows, {bad} unparsed")


def statements(sql_text):
    """Split a .sql file into statements, dropping -- comments (quote-aware, no psql needed)."""
    out, buf, in_quote, i = [], [], False, 0
    while i < len(sql_text):
        ch = sql_text[i]
        if ch == "'":
            in_quote = not in_quote
        if not in_quote and sql_text.startswith("--", i):
            i = sql_text.find("\n", i)
            if i == -1:
                break
            continue
        if not in_quote and ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def connect(wait_s=60):
    deadline = time.time() + wait_s
    while True:
        try:
            return tools._connect()
        except psycopg.OperationalError as e:
            if time.time() > deadline:
                sys.exit(f"Cannot reach SereneDB on {tools.os.getenv('SERENEDB_HOST', 'localhost')}:"
                        f"{tools.os.getenv('SERENEDB_PORT', '7890')}: {e}\nIs `docker compose up -d` running?")
            time.sleep(2)


def print_table(cur):
    names = [d.name for d in cur.description]
    rows = cur.fetchall()
    widths = [max(len(str(n)), *(len(f"{r[i]:,}" if isinstance(r[i], int) else str(r[i])) for r in rows))
            if rows else len(n) for i, n in enumerate(names)]
    fmt = lambda vals: "    " + "  ".join(str(v).ljust(w) for v, w in zip(vals, widths))  # noqa: E731
    print(fmt(names))
    for r in rows:
        print(fmt([f"{v:,}" if isinstance(v, int) else v for v in r]))


def load():
    step("Connecting to SereneDB")
    conn = connect()
    with conn.cursor() as cur:
        cur.execute("SELECT version()")
        print("   ", cur.fetchone()[0])
        for name in SQL_ORDER:
            step(f"Running sql/{name}")
            for stmt in statements((SQL / name).read_text(encoding="utf-8")):
                start = time.perf_counter()
                cur.execute(stmt)
                took = time.perf_counter() - start
                first = " ".join(stmt.split())[:70]
                if cur.description:
                    print(f"    {first}  ({took:.1f}s)")
                    print_table(cur)
                else:
                    print(f"    {first}  ({took:.1f}s{', ' + format(cur.rowcount, ',') + ' rows' if cur.rowcount > 0 else ''})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="download and unpack the raw logs from Zenodo first")
    ap.add_argument("--reconvert", action="store_true", help="rebuild the CSVs even if they exist")
    ap.add_argument("--skip-load", action="store_true", help="only prepare the CSVs")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    if args.download:
        download()
    convert(args.reconvert)
    if not args.skip_load:
        load()
    step("Done. Next: `python app/server.py` for the web app, or `claude` in this folder for the MCP tools.")


if __name__ == "__main__":
    main()
