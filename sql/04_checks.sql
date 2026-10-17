-- Sanity checks after loading. Expected numbers for the full corpus are in README.md.

-- 1. Row counts per dataset (OpenStack should be 207,820; BGL 4,747,963)
SELECT 'openstack' AS dataset, count(*) AS rows, count(*) FILTER (WHERE NOT parsed) AS unparsed FROM openstack_logs
UNION ALL
SELECT 'bgl', count(*), count(*) FILTER (WHERE NOT parsed) FROM bgl_logs;

-- 2. Components with no owning team (should return 0 rows)
SELECT 'openstack' AS dataset, o.component, count(*) AS rows
FROM openstack_logs o LEFT JOIN team_ownership t ON t.dataset = 'openstack' AND t.component = o.component
WHERE t.team IS NULL AND o.component IS NOT NULL GROUP BY o.component
UNION ALL
SELECT 'bgl', b.component, count(*)
FROM bgl_logs b LEFT JOIN team_ownership t ON t.dataset = 'bgl' AND t.component = b.component
WHERE t.team IS NULL AND b.component IS NOT NULL GROUP BY b.component;

-- 3. Rows per team and level, whole corpus (first real aggregation for the team lead / manager roles)
SELECT t.dataset, t.team, o.level, count(*) AS rows
FROM openstack_logs o JOIN team_ownership t ON t.dataset = 'openstack' AND t.component = o.component
GROUP BY t.dataset, t.team, o.level
UNION ALL
SELECT t.dataset, t.team, b.level, count(*)
FROM bgl_logs b JOIN team_ownership t ON t.dataset = 'bgl' AND t.component = b.component
GROUP BY t.dataset, t.team, b.level
ORDER BY dataset, team, rows DESC;