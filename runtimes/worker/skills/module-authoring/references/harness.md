# Module harness design

A setup module returns the created identifiers/state; its harness checks those values and the observable prepared state. A step module accepts page plus named inputs and returns the output needed by later stages. A page module exposes a narrow page abstraction; its harness checks a representative action and visible postcondition.

Use `export async function perform({page, ...inputs})` with an explicit TypeScript type suited to the actual function. Server composes calls as `exportName({page,...args})`; inputs must not override page. The harness is a complete Playwright spec importing `@lib/<slug>` and the exported function. Fix the exported API and harness together when behavior changes.

A harness must fail if its promised postcondition is false. Do not replace the asserted outcome with a click result, HTTP 200, truthy page, skip or catch-and-ignore. Record environment failures separately from implementation failures. Version pinning and publication remain Server decisions.
