import {test,expect} from '@playwright/test';
import {loginAs} from 'whippet/login';

// Replace only with the actual roleId returned by the isolated Server.
// Credentials are supplied by its real HTTPS resolve, never this spec/env.
const roleId='REPLACE_WITH_SERVER_ROLE_UUID';

test('M8 real Server role login',async({page},testInfo)=>{
  await page.goto('/login');
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  const submitted=await loginAs(page,roleId,'#username','#password','button[type=submit]');
  expect(submitted).toEqual({submitted:true});
  await expect(page).toHaveURL(/\/session$/);
  await expect(page.getByRole('heading')).toHaveText('Authenticated');
  await expect(page.getByRole('listitem')).toHaveText(['alpha']);
  // Inspect only a boolean; never write cookie values into reports/logs.
  await expect.poll(async()=>
    (await page.context().cookies()).some((cookie)=>cookie.name==='session'&&cookie.httpOnly)
  ).toBe(true);
  await testInfo.attach('authenticated-safe',{body:await page.screenshot(),contentType:'image/png'});
});
