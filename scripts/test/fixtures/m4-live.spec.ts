import { test, expect } from '@playwright/test';

test('M4 live 監看驗收', async ({ page }, testInfo) => {
  test.setTimeout(90000);

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; font-family: sans-serif; background: #0b1020; color: #fff; }
  .wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  h1 { font-size: 72px; margin: 0; letter-spacing: 4px; }
  #seconds { font-size: 160px; font-weight: 900; line-height: 1; }
  #phase { font-size: 48px; font-weight: 700; }
  #status { font-size: 96px; font-weight: 900; padding: 8px 48px; border-radius: 16px; background: #334155; }
  #bar { width: min(720px, 80vw); height: 24px; background: #1e293b; border-radius: 12px; overflow: hidden; }
  #fill { height: 100%; width: 0%; background: #22d3ee; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Whippet M4 Live</h1>
  <div id="seconds">0</div>
  <div id="phase">準備中</div>
  <div id="status">進行中</div>
  <div id="bar"><div id="fill"></div></div>
</div>
<script>
  var sec = 0;
  var hues = [190, 150, 100, 40, 320, 260];
  var timer = setInterval(function () {
    sec += 1;
    document.getElementById('seconds').textContent = String(sec);
    var phase = sec < 15 ? '進行中' : (sec < 35 ? '收尾中' : '結算中');
    document.getElementById('phase').textContent = phase;
    document.getElementById('fill').style.width = Math.min(100, (sec / 45) * 100) + '%';
    document.body.style.background = 'hsl(' + hues[sec % hues.length] + ' 45% 14%)';
    document.getElementById('seconds').style.color = 'hsl(' + hues[(sec + 2) % hues.length] + ' 90% 65%)';
    if (sec >= 45) {
      clearInterval(timer);
      document.getElementById('phase').textContent = '完成';
      var st = document.getElementById('status');
      st.textContent = '完成';
      st.style.background = '#16a34a';
      document.body.style.background = '#052e16';
    }
  }, 1000);
</script>
</body>
</html>`;

  await page.setContent(html);
  await testInfo.attach('開始', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await expect(page.locator('#status')).toHaveText('完成', { timeout: 60000 });

  await testInfo.attach('結束', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
