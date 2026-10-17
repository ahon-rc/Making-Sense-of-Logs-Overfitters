INSERT INTO openstack_logs SELECT * FROM read_csv('/data/openstack.csv');
INSERT INTO bgl_logs       SELECT * FROM read_csv('/data/bgl.csv');
