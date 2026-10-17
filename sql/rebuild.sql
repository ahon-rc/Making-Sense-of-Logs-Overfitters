-- Rebuild the whole database from the CSVs in one go:
-- psql -h localhost -p 7890 -U postgres -f sql/rebuild.sql
\set ON_ERROR_STOP on
\ir 01_schema.sql
\ir 02_load.sql
\ir 03_ownership.sql
\ir 04_checks.sql
