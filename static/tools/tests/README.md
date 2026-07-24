# Provider Test Fixtures

This directory contains provider JSON fixtures and executable Python tests.
Most current files are fixtures; `test_gbif.py` is the current executable
provider test module.

Fixtures verify configuration, mapping, normalization, and schema behavior but
do not replace executable tests. Add `test_<provider>.py` modules for parsing,
validation failures, pagination state, normalization, and representative edge
cases. Tests should run without live credentials whenever possible.

Provider identifiers must match adapters, schemas, policies, examples, and
documentation.
