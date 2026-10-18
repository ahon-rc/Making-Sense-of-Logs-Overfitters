# data/

This folder holds the log data. Everything in it except this file and `raw logs/README.md` is ignored by git, because the files are large (about 1.5 GB in total).

You don't need to fill it by hand. Running `python scripts/setup_db.py --download` downloads the Loghub archives from Zenodo into `data/raw/` and unpacks them there.

If you already have the raw files, put them anywhere under `data/`. The setup script searches subfolders for:

| File | Dataset |
|---|---|
| `openstack_normal1.log`, `openstack_normal2.log`, `openstack_abnormal.log` | OpenStack (2017, about 208k lines) |
| `anomaly_labels.txt` | the 4 labelled anomalous OpenStack VMs |
| `BGL.log` | BlueGene/L (2005–06, about 4.7M lines) |

The setup script writes `openstack.csv` and `bgl.csv` here. `docker-compose.yml` mounts this folder into the SereneDB container as `/data`, which is where `sql/02_load.sql` reads the CSVs from.
