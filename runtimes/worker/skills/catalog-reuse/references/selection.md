# Reuse selection

Compare each candidate against the Stage goal: input compatibility, return bindings used by later stages, required setup/state, asserted postcondition, allowed target site and latest supplied verification evidence. Prefer the smallest matching contract over a broad helper with hidden setup.

An upgrade is a new candidate revision requiring fresh verification. A bundle cannot contain two versions of the same slug/moduleTestId; if stages require conflicting versions, stop and resolve the Plan instead of renaming aliases to disguise the conflict. Repeated references to the same version may share one file.

Catalog results are Workspace-scoped and immutable version references are authoritative. If a module needs another Module, redesign the Use Case stages rather than creating a forbidden transitive dependency.
