// Isolated M10 acceptance fixture. No external assets, payments or real accounts.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const username = process.env.FIXTURE_USERNAME;
const password = process.env.FIXTURE_PASSWORD;
if (!username || !password) throw new Error('Synthetic fixture credentials required');
const sessions = new Map();
const orders = new Map();
const product = { id: 'whippet-notebook', name: 'Whippet Notebook', price: 120 };
const escape = (v) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><body><h1>${escape(title)}</h1>${body}</body></html>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, title, body = '') => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(title, body));
  };
  const redirect = path => { res.writeHead(303, { Location: path }); res.end(); };
  try {
    const url = new URL(req.url, 'http://fixture.local');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, 'ready');
    if (req.method === 'GET' && url.pathname === '/login') return send(200, 'Synthetic shop login', '<form method="post" action="/login"><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="submit">Log in</button></form>');
    const body = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk.toString('utf8');
        if (Buffer.byteLength(data) > 8192) throw new Error('body limit');
      }
      return new URLSearchParams(data);
    };
    if (req.method === 'POST' && url.pathname === '/login') {
      const form = await body();
      if (!equal(form.get('username') || '', username) || !equal(form.get('password') || '', password)) return send(401, 'Login rejected');
      const token = randomUUID();
      sessions.set(token, Date.now() + 60 * 60 * 1000);
      res.setHeader('Set-Cookie', `m10_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      return redirect('/products');
    }
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('m10_session='))?.slice(12);
    if (!token || (sessions.get(token) || 0) <= Date.now()) return send(401, 'Authentication required', '<a href="/login">Log in</a>');
    const account = '<p data-testid="account-state">Authenticated synthetic customer</p>';
    if (req.method === 'GET' && ['/', '/products'].includes(url.pathname)) {
      const query = url.searchParams.get('q') || '';
      const match = product.name.toLowerCase().includes(query.toLowerCase());
      return send(200, 'Products', account + '<form action="/products"><label>Search<input name="q"></label><button>Search</button></form>' + (match ? `<article data-testid="product" data-product-id="${product.id}"><h2>${product.name}</h2><p>Unit price <span data-testid="unit-price">${product.price}</span> TWD</p><form method="post" action="/orders"><input type="hidden" name="productId" value="${product.id}"><label>Quantity<input name="quantity" type="number" min="1" max="10" value="1"></label><button>Create synthetic order</button></form></article>` : '<p>No products found</p>'));
    }
    if (req.method === 'POST' && url.pathname === '/orders') {
      const form = await body();
      const quantity = Number(form.get('quantity'));
      if (form.get('productId') !== product.id || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return send(400, 'Invalid order');
      const id = randomUUID();
      orders.set(id, { token, quantity, total: quantity * product.price });
      return redirect(`/orders/${id}`);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/orders/')) {
      const id = url.pathname.slice('/orders/'.length), order = orders.get(id);
      if (!order || order.token !== token) return send(404, 'Order not found');
      return send(200, 'Order details', account + `<dl><dt>Order ID</dt><dd data-testid="order-id">${escape(id)}</dd><dt>Product ID</dt><dd data-testid="product-id">${product.id}</dd><dt>Quantity</dt><dd data-testid="quantity">${order.quantity}</dd><dt>Total TWD</dt><dd data-testid="total">${order.total}</dd><dt>Status</dt><dd data-testid="status">confirmed</dd></dl><a href="/orders/${escape(id)}">Reload this order</a>`);
    }
    return send(404, 'Not found');
  } catch { return send(400, 'Invalid request'); }
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
