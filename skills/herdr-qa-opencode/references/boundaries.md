# Boundaries

Every QA task text carries its own boundary. Keep all of these:

- Read only public UI/API, the named QA script, and PM-provided
  fixture notes. Never product source, journals, DB, `deploy/.env.ai`,
  or real credentials.
- Write only the owned script (`scripts/test/m8-*.cjs`) and the owned
  `/private/tmp/<evidence-dir>`. One QA owner per script and evidence
  directory; never share a viewer or edit the same draft.
- The fixture provider is an explicit stand-in, never real AI.
  Real-model wiring stays with PM; never hand keys to QA.
- No installs, deploys, service restarts, Git operations, or child
  agents. When the sandbox cannot run Docker or a browser, hand back
  an executable Node script for PM to run instead of faking a PASS.
- Report completion or blockers with `hc send <parent>`, stating
  files, evidence paths, checks actually run, and remaining limits.
