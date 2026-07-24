# Provider Policies

This directory contains one JSON policy per provider plus
`provider-priority.json`. Policies control provider priority, accepted statuses,
rank mapping, synonyms, authority aliases, trust, conflicts, licensing,
retries, and publication eligibility.

Provider identifiers must match adapters, schemas, examples, tests, and
documentation. Policy changes can alter canonical names, conflicts, hashes, and
database output, so they must be deterministic, reviewed, and followed by a
full rebuild. Never include credentials.
