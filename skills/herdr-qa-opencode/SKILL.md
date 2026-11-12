---
name: herdr-qa-opencode
description: Launch Whippet black-box QA in a Herdr-visible interactive opencode pane. Use this whenever starting a QA subagent, dispatching m7/m8/m9 black-box scripts, or when a pane shows status null instead of working/idle.
metadata:
  version: "1"
---

# Herdr QA opencode

Use a fresh QA conversation under `hc` with explicit parent and crew labels.
Never use `opencode mini`. Standard `opencode run` has been used for M8;
verify actual reported status rather than assuming all modes emit OSC.
Read [launch](references/launch.md) for the RPG session boundary.

## Steps

1. Verify the model default once in an interactive pane footer:
   `Muse Spark 1.3 Contributor` with `xhigh`. Never silently
   substitute another model or effort.
2. Launch a fresh conversation, one terminal per QA owner. Apply the parent/labels in launch.md to the chosen command. Optional interactive template:
   `hc run --bg --name <qa-name> --cwd /Users/kywk/kywk/project/whippet whippet-qa "<task>"`.
   Read [launch](references/launch.md) for readiness, send, wait,
   and cleanup commands.
3. Keep the black-box boundary in every task: synthetic data and
   public UI/API plus the designated QA scripts only. No product
   source, no `deploy/.env.ai`, no real secrets, no install/deploy/
   Git, no child agents. Read [boundaries](references/boundaries.md)
   before writing the task text.
4. Finish with `hc send <parent> "<result or blocker>"` and a short
   report: files written, evidence directory, checks run, remaining
   limits. Clean up only terminals you started.

## Template source

`assets/whippet-qa.md` is the single source of truth for the
`hc` template. Install with:

```sh
mkdir -p ~/.config/herdr-core/templates
cp skills/herdr-qa-opencode/assets/whippet-qa.md ~/.config/herdr-core/templates/whippet-qa.md
hc templates
```
