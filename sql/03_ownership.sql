-- Fictional team-ownership table: maps each log component to the team that "owns" it.
-- Invented for the hackathon (no real org behind it); documented in README.md.

DROP TABLE IF EXISTS team_ownership;
CREATE TABLE team_ownership (
    dataset   VARCHAR,
    component VARCHAR,
    team      VARCHAR,
    notes     VARCHAR
);

INSERT INTO team_ownership VALUES
    -- OpenStack (component = python logger name)
    ('openstack', 'nova.osapi_compute.wsgi.server',                   'API Gateway',       'Public compute API access log'),
    ('openstack', 'nova.api.openstack.wsgi',                          'API Gateway',       'API request handling'),
    ('openstack', 'nova.api.openstack.compute.server_external_events','API Gateway',       'Events posted by Neutron/Cinder'),
    ('openstack', 'nova.metadata.wsgi.server',                        'API Gateway',       'Instance metadata service'),
    ('openstack', 'keystonemiddleware.auth_token',                    'Identity & Access', 'Token validation'),
    ('openstack', 'nova.scheduler.host_manager',                      'Scheduling',        'Placement of VMs on hosts'),
    ('openstack', 'nova.compute.manager',                             'Compute',           'VM lifecycle on the host'),
    ('openstack', 'nova.compute.claims',                              'Compute',           'CPU/RAM/disk claims for new VMs'),
    ('openstack', 'nova.compute.resource_tracker',                    'Compute',           'Host capacity accounting'),
    ('openstack', 'nova.virt.libvirt.driver',                         'Virtualization',    'Hypervisor (libvirt/KVM) driver'),
    ('openstack', 'nova.virt.libvirt.imagecache',                     'Storage & Images',  'Base image cache on the host'),
    ('openstack', 'oslo_service.periodic_task',                       'Platform Runtime',  'Background periodic jobs'),
    -- BGL (component = BlueGene/L subsystem)
    ('bgl', 'KERNEL',    'HPC Node Software',   'Compute node kernel'),
    ('bgl', 'APP',       'HPC User Workloads', 'User applications / jobs'),
    ('bgl', 'MMCS',      'HPC Control System', 'Midplane management control system'),
    ('bgl', 'BGLMASTER', 'HPC Control System', 'Control system master process'),
    ('bgl', 'CMCS',      'HPC Control System', 'Control system'),
    ('bgl', 'DISCOVERY', 'HPC Hardware Ops',   'Hardware discovery'),
    ('bgl', 'HARDWARE',  'HPC Hardware Ops',   'Hardware faults'),
    ('bgl', 'LINKCARD',  'HPC Network',        'Link cards / torus network'),
    ('bgl', 'SERV_NET',  'HPC Network',        'Service network'),
    ('bgl', 'MONITOR',   'HPC Hardware Ops',   'Environmental monitoring');
