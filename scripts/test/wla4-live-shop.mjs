import http from 'node:http';

const username = process.env.FIXTURE_USERNAME;
const password = process.env.FIXTURE_PASSWORD;
if (!username || !password) throw new Error('Synthetic fixture credentials required');

const transitions = { before: 'login', sensitive: 'submit', after: 'finished', finished: 'before' };
let phase = 'before';
let loginStatus = null;
let releaseResponse;

function html(title, body, marker) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
    <style>
      .marker { position: relative; width: 240px; height: 144px; margin-block: 16px; }
      .marker::after { content: ''; position: absolute; inset-block-end: 8px; width: 16px;
        height: 16px; background: #111; animation: sweep 800ms linear infinite alternate; }
      @keyframes sweep { from { transform: translateX(8px); } to { transform: translateX(216px); } }
      [data-marker="before"] { background: #0077ff; }
      [data-marker="sensitive"] { background: #ff00aa; }
      [data-marker="after"] { background: #00aa55; }
    </style></head><body><h1>${title}</h1>
    <div class="marker" data-marker="${marker}" aria-hidden="true"></div>${body}</body></html>`;
}

const loginForm = html('Synthetic shop login', `<form method="post" action="/login">
  <label>Username <input name="username" autocomplete="username" required></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit" disabled>Log in</button>
</form><script>
  const form = document.querySelector('form');
  let marked = false;
  form.addEventListener('input', () => {
    if (marked || !form.elements.namedItem('password').value) return;
    marked = true;
    document.querySelector('.marker').dataset.marker = 'sensitive';
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      const permission = await fetch('/val2/marked', { method: 'POST' });
      if (permission.ok) form.querySelector('button').disabled = false;
    }));
  });
</script>`, 'before');

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  res.setHeader('Cache-Control', 'no-store');
  if (method === 'GET' && url === '/healthz') return res.writeHead(200).end('ready');
  if (method === 'GET' && url === '/val2/phase') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ phase, loginStatus }));
  }
  if (method === 'POST' && Object.hasOwn(transitions, phase) && url === `/val2/advance/${phase}`) {
    phase = transitions[phase];
    if (phase === 'before') loginStatus = null;
    res.writeHead(204).end();
    if (phase === 'submit') releaseResponse();
    return;
  }
  if (method === 'POST' && url === '/val2/marked' && phase === 'login') {
    phase = 'sensitive';
    // Keep the form on screen while the marked input is observed. The fetch carries no values.
    await new Promise(resolve => {
      releaseResponse = resolve;
      res.once('close', resolve);
    });
    if (res.destroyed) { phase = 'aborted'; return; }
    return res.writeHead(204).end();
  }
  if (url !== '/login') return res.writeHead(404).end();
  const sendPage = (status, content) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(content);
  if (method === 'GET') return sendPage(200, loginForm);
  if (method !== 'POST' || phase !== 'submit') return res.writeHead(409).end();
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 8192) return res.writeHead(413).end();
    }
    if (phase !== 'submit') return res.writeHead(409).end();
    const fields = new URLSearchParams(body);
    loginStatus = fields.get('username') === username && fields.get('password') === password ? 200 : 401;
    phase = 'after';
    const outcome = loginStatus === 200 ? 'Authenticated synthetic customer' : 'Login rejected';
    return sendPage(loginStatus, html('Synthetic login response', `<p data-testid="val2-outcome">${outcome}</p>`, 'after'));
  } catch {
    res.writeHead(400).end();
  }
});
server.listen(8080, '0.0.0.0');
