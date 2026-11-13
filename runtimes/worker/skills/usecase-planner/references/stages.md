# Stage planning and bindings

For a reused Stage, cite the supplied moduleTestId and immutable moduleVersionId. Describe named arguments as literal JSON values or bindings to an earlier stageId and path. An empty path means the whole returned value. bind is a display alias, not executable JavaScript. page is supplied by the runner and cannot be an argument override.

Inline Stages contain explicit user-editable steps and do not supply return bindings. Do not propose forward references, loops, conditions, parallel stages, cross-Workspace modules or Module-to-Module imports.

A useful Plan lists the observable goal, ordered stages, reuse/modify/new decisions, fixed versions where known, missing inputs and required assertions. Candidate version IDs come from the Server before compose/validation. Do not invent IDs, assume unpublished versions are in the Catalog, or claim a new candidate is published.
