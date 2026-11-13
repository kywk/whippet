# Diagnose at the Stage boundary

1. Locate the failed Stage’s test.step and its actual assertion/error. Keep the pinned version, parameters and previous Stage output in view.
2. If the Module harness fails with the same supported inputs, investigate the Module or target site. If the harness passes but the composed Stage fails, inspect preconditions, parameter bindings and prior Stage state before changing locators.
3. A connection/scope/login blocker is not evidence that an assertion is wrong. Request environment correction or permission confirmation rather than broadening scope or fabricating selectors.
4. After a scoped repair, rerun the Module harness where relevant and the composed Use Case through the independent validation capability. Report what actually ran. A pending validation is not a pass.

Do not remove assertions, use skip/only, catch errors to force success, change expected values merely to match a broken site, or increase sleeps/retries to hide ordering bugs. If intended behavior is uncertain, ask the user rather than rewriting the goal.
