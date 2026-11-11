# Playwright recipe

## Stable locators and assertions

In generated TypeScript, prefer getByRole with an observed accessible name for buttons/links, and getByLabel for labelled inputs. Use observed placeholder/test-id/stable-id contracts when those semantics are unavailable. Narrow to the relevant form/list instead of guessing structure or hiding ambiguity with first()/nth().

Plain listitem text usually is NOT its accessible name. Match item text with filter({ hasText }) or assert the expected list; use name only when an actual accessible name is observed. Recipes (adapt expected items to the user's goal):

```ts
await page.getByLabel('Task').fill('alpha');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await expect(page.getByRole('listitem')).toHaveText(['alpha']);
const item = page.getByRole('listitem').filter({ hasText: 'alpha' });
await expect(item).toHaveText('alpha');
```

Await actions and web-first assertions such as expect(locator).toHaveText/toBeVisible/toHaveValue/toHaveCount. Locators auto-wait; do not use hard sleeps, waitForTimeout, or unrelated timeout/retry increases to mask a locator or logic error.

## Screenshot evidence

For requested key checkpoints, use `async ({ page }, testInfo)` and attach a PNG after the relevant assertion. The HTML report includes these attachments; a screenshot complements assertions, not an automatic visual check. Runner also captures failure screenshots.

```ts
await testInfo.attach('after-submit', {
  body: await page.screenshot({ type: 'png', fullPage: true }),
  contentType: 'image/png',
});
```

Keep every intended assertion. No skip/only, assertion weakening, arbitrary shell/eval, or secret access. PNG limits: 10 MiB each, 32 files/64 MiB per run. Failed runs automatically retain trace ZIP/error-context Markdown for download; open traces locally, with no embedded viewer. Video attachments remain unsupported.
