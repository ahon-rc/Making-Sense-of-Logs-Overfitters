DROP TABLE IF EXISTS openstack_logs;
CREATE TABLE openstack_logs (
    dataset             VARCHAR,    -- always 'openstack'
    split               VARCHAR,    -- normal1 / normal2 / abnormal (which source file)
    line_no             BIGINT,     -- line number inside that source file
    parsed              BOOLEAN,    -- false = line didn't match the format, raw text kept in message
    ts                  TIMESTAMP,
    source_file         VARCHAR,    -- original rotated log file name, e.g. nova-api.log.1.2017-05-16_13:53:08
    service             VARCHAR,    -- nova-api / nova-compute / nova-scheduler
    pid                 BIGINT,
    level               VARCHAR,    -- INFO / WARNING / ERROR / CRITICAL
    component           VARCHAR,    -- python logger, e.g. nova.compute.manager
    request_id          VARCHAR,    -- req-<uuid>, ties API and compute lines for one request together
    user_id             VARCHAR,
    tenant_id           VARCHAR,
    instance_id         VARCHAR,    -- VM uuid when the line mentions one
    http_method         VARCHAR,    -- only on API access lines
    http_path           VARCHAR,
    http_status         BIGINT,
    latency_s           DOUBLE,     -- request time in seconds, from "time: x.xxx"
    is_labelled_anomaly BOOLEAN,    -- instance_id is one of the 4 ids in anomaly_labels.txt
    message             VARCHAR
);

DROP TABLE IF EXISTS bgl_logs;
CREATE TABLE bgl_logs (
    dataset     VARCHAR,    -- always 'bgl'
    line_no     BIGINT,
    parsed      BOOLEAN,
    ts          TIMESTAMP,
    epoch       BIGINT,     -- unix seconds
    node        VARCHAR,    -- e.g. R02-M1-N0-C:J12-U11 (rack-midplane-node-card)
    type        VARCHAR,    -- RAS
    component   VARCHAR,    -- KERNEL / APP / MMCS / DISCOVERY / HARDWARE / ...
    level       VARCHAR,    -- INFO / WARNING / SEVERE / ERROR / FAILURE / FATAL
    alert_label VARCHAR,    -- alert category (e.g. KERNDTLB), NULL for normal lines
    is_alert    BOOLEAN,
    message     VARCHAR
);