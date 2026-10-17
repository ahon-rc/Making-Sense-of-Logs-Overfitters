-- Full-text search indexes (SereneDB inverted indexes) used by the search_logs tool.
-- message is tokenised (lower-case words, positions kept for phrase search);
-- the other columns are indexed verbatim so filters run inside the same index scan.
-- Queries read FROM the index by name: SELECT ... FROM openstack_search WHERE message @@ '...'

DROP INDEX IF EXISTS openstack_search;
DROP INDEX IF EXISTS bgl_search;
DROP TEXT SEARCH DICTIONARY IF EXISTS log_text;

CREATE TEXT SEARCH DICTIONARY log_text AS split_text(case := 'lower') WITH (frequency, position);

CREATE INDEX openstack_search ON openstack_logs
    USING inverted (message log_text, level, component, service, instance_id, request_id, split, ts);

CREATE INDEX bgl_search ON bgl_logs
    USING inverted (message log_text, level, component, node, alert_label, ts);

-- make freshly loaded rows visible to the indexes right away
VACUUM (REFRESH_TABLE) openstack_logs;
VACUUM (REFRESH_TABLE) bgl_logs;
