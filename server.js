// تشغيل: npm install && FOX_KEY=fr_test_xxx ADMIN_KEY=كلمة_سر node server.js   (Node 18+)
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

const { FOX_KEY, ADMIN_KEY } = process.env;
const FOX_BASE = process.env.FOX_BASE || 'https://api.foxreload.com/v1';
const MARKUP = Number(process.env.MARKUP_PERCENT || 10);
const PAYMENT_NOTE = process.env.PAYMENT_NOTE || 'حوّل المبلغ ثم أرسل رقم الطلب لنؤكّد الدفع.';
const DB = './orders.json';

if (!FOX_KEY || !ADMIN_KEY) { console.error('عيّن FOX_KEY و ADMIN_KEY أولًا.'); process.exit(1); }

const loadDb = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {});
const saveDb = (o) => fs.writeFileSync(DB, JSON.stringify(o, null, 1));

// ⚠️ المسارات وأسماء الحقول مأخوذة من أدلة خارجية — طابقها مع وثائق FoxReload الرسمية
async function fox(path, method = 'GET', body) {
  const r = await fetch(FOX_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${FOX_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `FoxReload ${r.status}`);
  return data;
}

let cache = { at: 0, items: [] };
async function catalog() {
  if (Date.now() - cache.at < 60000) return cache.items;
  const d = await fox('/catalog');
  const list = Array.isArray(d) ? d : d.products || d.data || [];
  cache = {
    at: Date.now(),
    items: list.map((p) => ({
      id: p.id, name: String(p.name), category: p.category || 'أخرى',
      cost: Number(p.price), inStock: p.in_stock ?? (p.stock ?? 1) > 0,
    })),
  };
  return cache.items;
}
const sell = (p) => Math.round(p.cost * (1 + MARKUP / 100) * 100) / 100;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(502).json({ error: e.message }));
const admin = (req, res, next) => (req.get('x-admin-key') === ADMIN_KEY ? next() : res.status(401).json({ error: 'غير مصرح' }));

app.get('/api/products', wrap(async (req, res) => {
  const items = await catalog();
  res.json(items.filter((p) => p.inStock).map((p) => ({ id: p.id, name: p.name, category: p.category, price: sell(p) })));
}));

app.post('/api/orders', wrap(async (req, res) => {
  const contact = String(req.body.contact || '').trim().slice(0, 100);
  if (!contact) return res.status(400).json({ error: 'أدخل وسيلة تواصل' });
  const p = (await catalog()).find((x) => String(x.id) === String(req.body.productId) && x.inStock);
  if (!p) return res.status(404).json({ error: 'المنتج غير متوفر' });
  const db = loadDb();
  const id = crypto.randomUUID().slice(0, 8);
  db[id] = { id, productId: p.id, name: p.name, price: sell(p), cost: p.cost, contact, status: 'pending', createdAt: Date.now() };
  saveDb(db);
  res.json({ id, paymentNote: PAYMENT_NOTE });
}));

app.get('/api/orders/:id', (req, res) => {
  const o = loadDb()[req.params.id];
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  res.json({ id: o.id, name: o.name, price: o.price, status: o.status, code: o.status === 'delivered' ? o.code : undefined });
});

app.get('/api/admin/orders', admin, (req, res) => {
  res.json(Object.values(loadDb()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50));
});

// بعد التأكد من وصول الدفع: يطلب الكود من FoxReload ويحفظه. الـ reference يمنع الشراء المكرر عند إعادة المحاولة.
app.post('/api/admin/orders/:id/confirm', admin, wrap(async (req, res) => {
  const db = loadDb();
  const o = db[req.params.id];
  if (!o) return res.status(404).json({ error: 'طلب غير موجود' });
  if (o.status === 'delivered') return res.json({ status: o.status });
  try {
    const r = await fox('/order', 'POST', { product_id: o.productId, quantity: 1, reference: o.id });
    const c = r.code ?? r.codes ?? r.data?.code ?? r;
    o.code = typeof c === 'string' ? c : JSON.stringify(c);
    o.status = 'delivered';
  } catch (e) {
    o.error = e.message;
    saveDb(db);
    throw e;
  }
  saveDb(db);
  res.json({ status: o.status });
}));

app.listen(process.env.PORT || 3000, () => console.log('المتجر يعمل على المنفذ', process.env.PORT || 3000));
