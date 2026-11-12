# Fresh conversation, same RPG session

Read the current PM handoff for the root terminal and space/tab IDs.
The RPG mod groups `crew=1` terminals by following their `parent` chain;
a common tab alone does not keep agents in the same RPG session.
Use explicit `--parent <new-pm>` (whose chain reaches the existing root),
`--label crew=1`, matching `herdr.space`/`herdr.tab`, explicit repo cwd,
and `--keep --outlive-parent`. Keep the root terminal; do not remove it.

Start a new conversation for each new task; do not resume old long sessions.
Never start `opencode mini`. Standard command used in M8:

```sh
hc run --bg --keep --outlive-parent --parent <new-pm> \
  --name <qa-name> --cwd /Users/kywk/kywk/project/whippet \
  --label crew=1 --label crew.tool=opencode \
  --label crew.model=opencode-go/muse-spark-1.3-contributor \
  --label crew.effort=xhigh --label crew.task=<task> \
  --label herdr.space=<existing-space> --label herdr.tab=<existing-tab> \
  -- /opt/homebrew/bin/opencode run \
  --model opencode-go/muse-spark-1.3-contributor#xhigh --title <title> <task>
```

Alternatively use the full interactive template after checking its effective
model. Do not silently replace model or effort. `hc get` confirms parent,
labels, argv and reported status; `hc read` confirms actual progress/model.
If status is unreported, retain the original attempt and inspect output;
do not create duplicate work or declare the model unavailable.

Use `hc read`/`hc wait` for results. Report exact files/evidence and observed
PASS/FAIL/UNVERIFIED. Close only your own completed helpers, never the RPG root.
