const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '12mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ENTRIES_DIR = path.join(DATA_DIR, 'entries');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PRIZES_FILE = path.join(DATA_DIR, 'prizes.json');
const DRAWS_FILE = path.join(DATA_DIR, 'draws.json');

function ensureDirs() {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      title: '幸运抽奖登记',
      subtitle: '上传订单截图，填写资料，登记您的抽奖资格',
      conversionRate: 100,
      tiers: [],
      maxWinsPerPerson: 0,
      guaranteedGiftThreshold: 0
    }, null, 2));
  }
  if (!fs.existsSync(PRIZES_FILE)) fs.writeFileSync(PRIZES_FILE, '[]');
  if (!fs.existsSync(DRAWS_FILE)) fs.writeFileSync(DRAWS_FILE, '[]');
}
ensureDirs();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readConfig() { return readJson(CONFIG_FILE, {}); }
function writeConfig(cfg) { writeJson(CONFIG_FILE, cfg); }

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex')); }
  catch (e) { return false; }
}

// in-memory admin session tokens (cleared on server restart -> admin just logs in again)
const tokens = new Map();
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + 1000 * 60 * 60 * 12); // valid 12 hours
  return token;
}
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const expiry = token && tokens.get(token);
  if (!expiry || expiry < Date.now()) {
    return res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
  }
  next();
}

function genId(prefix, len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < (len || 6); i++) s += chars[Math.floor(Math.random() * chars.length)];
  return prefix + s;
}

function computeTicketCount(amount, rate, tiers) {
  const amt = parseFloat(amount) || 0;
  const r = parseFloat(rate) || 0;
  let base = 0;
  if (r <= 0) base = amt > 0 ? 1 : 0;
  else base = Math.max(0, Math.floor(amt / r));
  let bonus = 0;
  (tiers || []).forEach(t => {
    const threshold = parseFloat(t.threshold) || 0;
    const b = parseFloat(t.bonus) || 0;
    if (threshold > 0 && amt >= threshold) bonus += b;
  });
  return base + bonus;
}

/* ---------------- event config ---------------- */
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  res.json({
    title: cfg.title || '幸运抽奖登记',
    subtitle: cfg.subtitle || '',
    conversionRate: cfg.conversionRate || 100,
    tiers: cfg.tiers || [],
    maxWinsPerPerson: cfg.maxWinsPerPerson || 0,
    guaranteedGiftThreshold: cfg.guaranteedGiftThreshold || 0
  });
});
app.put('/api/config', requireAdmin, (req, res) => {
  const cfg = readConfig();
  cfg.title = (req.body.title || cfg.title || '幸运抽奖登记').toString().slice(0, 60);
  cfg.subtitle = (req.body.subtitle || '').toString().slice(0, 140);
  const rate = parseFloat(req.body.conversionRate);
  cfg.conversionRate = (!isNaN(rate) && rate > 0) ? rate : (cfg.conversionRate || 100);
  if (Array.isArray(req.body.tiers)) {
    cfg.tiers = req.body.tiers
      .map(t => ({ threshold: parseFloat(t.threshold), bonus: parseFloat(t.bonus) }))
      .filter(t => !isNaN(t.threshold) && t.threshold > 0 && !isNaN(t.bonus) && t.bonus >= 0)
      .sort((a, b) => a.threshold - b.threshold);
  }
  if (req.body.maxWinsPerPerson !== undefined) {
    const m = parseInt(req.body.maxWinsPerPerson, 10);
    cfg.maxWinsPerPerson = (!isNaN(m) && m >= 0) ? m : (cfg.maxWinsPerPerson || 0);
  }
  if (req.body.guaranteedGiftThreshold !== undefined) {
    const g = parseFloat(req.body.guaranteedGiftThreshold);
    cfg.guaranteedGiftThreshold = (!isNaN(g) && g >= 0) ? g : (cfg.guaranteedGiftThreshold || 0);
  }
  writeConfig(cfg);
  res.json({ ok: true });
});

/* ---------------- admin auth ---------------- */
app.get('/api/admin/status', (req, res) => {
  const cfg = readConfig();
  res.json({ passwordSet: !!cfg.passwordHash });
});
app.post('/api/admin/setup', (req, res) => {
  const cfg = readConfig();
  if (cfg.passwordHash) return res.status(400).json({ error: '管理员密码已经设置过了' });
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const { salt, hash } = hashPassword(password);
  cfg.passwordSalt = salt; cfg.passwordHash = hash;
  writeConfig(cfg);
  res.json({ token: issueToken() });
});
app.post('/api/admin/login', (req, res) => {
  const cfg = readConfig();
  const { password } = req.body || {};
  if (!verifyPassword(password, cfg.passwordSalt, cfg.passwordHash)) {
    return res.status(401).json({ error: '密码不正确' });
  }
  res.json({ token: issueToken() });
});
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少4位' });
  const cfg = readConfig();
  const { salt, hash } = hashPassword(password);
  cfg.passwordSalt = salt; cfg.passwordHash = hash;
  writeConfig(cfg);
  res.json({ ok: true });
});

/* ---------------- entries (public submits, admin manages) ---------------- */
app.post('/api/entries', (req, res) => {
  const { name, contact, ddName, customerName, orderId, amount, photo } = req.body || {};
  if (!name || !contact || !ddName || !customerName || !orderId || !amount || !photo) {
    return res.status(400).json({ error: '资料不完整，请填写全部字段并上传照片 / Missing information, please fill in all fields and upload a photo' });
  }
  const orderIdNorm = String(orderId).trim().toLowerCase();
  const existingFiles = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  const isDuplicate = existingFiles.some(f => {
    const existing = readJson(path.join(ENTRIES_DIR, f), null);
    return existing && String(existing.orderId || '').trim().toLowerCase() === orderIdNorm;
  });
  if (isDuplicate) {
    return res.status(400).json({ error: '该订单号已经登记过 / This Order ID has already been registered' });
  }
  const id = genId('LD-', 6);
  const entry = {
    id,
    name: String(name).slice(0, 100),
    contact: String(contact).slice(0, 100),
    ddName: String(ddName).slice(0, 100),
    customerName: String(customerName).slice(0, 100),
    orderId: String(orderId).slice(0, 100),
    amount: String(amount).slice(0, 50),
    photo,
    submittedAt: Date.now(),
    wonPrizes: []
  };
  fs.writeFileSync(path.join(ENTRIES_DIR, id + '.json'), JSON.stringify(entry));
  res.json({ id });
});
app.get('/api/entries', requireAdmin, (req, res) => {
  const cfg = readConfig();
  const rate = cfg.conversionRate || 100;
  const tiers = cfg.tiers || [];
  const files = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => readJson(path.join(ENTRIES_DIR, f), null)).filter(Boolean);
  list.forEach(entry => {
    const count = computeTicketCount(entry.amount, rate, tiers);
    entry.ticketCount = count;
    entry.ticketIds = Array.from({ length: count }, (_, i) => entry.id + '-' + (i + 1));
  });
  list.sort((a, b) => b.submittedAt - a.submittedAt);
  res.json(list);
});
app.delete('/api/entries/:id', requireAdmin, (req, res) => {
  const file = path.join(ENTRIES_DIR, req.params.id + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

/* ---------------- prizes ---------------- */
app.get('/api/prizes', requireAdmin, (req, res) => {
  res.json(readJson(PRIZES_FILE, []));
});
app.post('/api/prizes', requireAdmin, (req, res) => {
  const { name, qty, photo, value } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入奖品名称' });
  const prizes = readJson(PRIZES_FILE, []);
  const prize = { id: genId('PZ-', 6), name: String(name).slice(0, 100), qty: Math.max(1, parseInt(qty, 10) || 1), photo: photo || null, value: value ? String(value).slice(0, 30) : '', createdAt: Date.now() };
  prizes.push(prize);
  writeJson(PRIZES_FILE, prizes);
  res.json(prize);
});
app.delete('/api/prizes/:id', requireAdmin, (req, res) => {
  let prizes = readJson(PRIZES_FILE, []);
  prizes = prizes.filter(p => p.id !== req.params.id);
  writeJson(PRIZES_FILE, prizes);
  res.json({ ok: true });
});
app.put('/api/prizes/:id', requireAdmin, (req, res) => {
  const prizes = readJson(PRIZES_FILE, []);
  const prize = prizes.find(p => p.id === req.params.id);
  if (!prize) return res.status(404).json({ error: '奖品不存在' });
  const { name, qty, photo, value } = req.body || {};
  if (name && String(name).trim()) prize.name = String(name).slice(0, 100);
  if (qty !== undefined) prize.qty = Math.max(0, parseInt(qty, 10) || 0);
  if (value !== undefined) prize.value = value ? String(value).slice(0, 30) : '';
  if (photo !== undefined) prize.photo = photo || null;
  writeJson(PRIZES_FILE, prizes);
  res.json(prize);
});
/* ---------------- draws ---------------- */
app.get('/api/draws', requireAdmin, (req, res) => {
  res.json(readJson(DRAWS_FILE, []));
});
app.post('/api/draws', requireAdmin, (req, res) => {
  const { prizeId, entryId, guaranteed } = req.body || {};
  const cfg = readConfig();
  const prizes = readJson(PRIZES_FILE, []);
  const prize = prizes.find(p => p.id === prizeId);
  if (!prize || prize.qty < 1) return res.status(400).json({ error: '奖品无效或数量不足' });
  const entryFile = path.join(ENTRIES_DIR, entryId + '.json');
  const entry = readJson(entryFile, null);
  if (!entry) return res.status(400).json({ error: '参与者不存在，可能已被删除' });

  const maxWins = cfg.maxWinsPerPerson || 0;
  const currentWins = (entry.wonPrizes || []).length;
  if (maxWins > 0 && currentWins >= maxWins) {
    return res.status(400).json({ error: '该顾客已达到最多中奖次数上限' });
  }
  if (guaranteed) {
    const threshold = cfg.guaranteedGiftThreshold || 0;
    if (threshold > 0 && (parseFloat(entry.amount) || 0) < threshold) {
      return res.status(400).json({ error: '该顾客金额未达到满额保证送礼门槛' });
    }
  }

  const draw = {
    id: genId('DR-', 6),
    prizeId, prizeName: prize.name, prizeValue: prize.value || '',
    entryId, winnerName: entry.name, winnerContact: entry.contact,
    winnerDdName: entry.ddName || '', winnerCustomerName: entry.customerName || '',
    winnerOrderId: entry.orderId,
    guaranteed: !!guaranteed,
    timestamp: Date.now()
  };
  const draws = readJson(DRAWS_FILE, []);
  draws.push(draw);
  writeJson(DRAWS_FILE, draws);

  prize.qty -= 1;
  writeJson(PRIZES_FILE, prizes);

  entry.wonPrizes = entry.wonPrizes || [];
  entry.wonPrizes.push(prize.name);
  fs.writeFileSync(entryFile, JSON.stringify(entry));

  res.json(draw);
});
app.delete('/api/draws/:id', requireAdmin, (req, res) => {
  let draws = readJson(DRAWS_FILE, []);
  const draw = draws.find(d => d.id === req.params.id);
  if (!draw) return res.status(404).json({ error: '记录不存在' });
  draws = draws.filter(d => d.id !== req.params.id);
  writeJson(DRAWS_FILE, draws);

  const prizes = readJson(PRIZES_FILE, []);
  const prize = prizes.find(p => p.id === draw.prizeId);
  if (prize) { prize.qty += 1; writeJson(PRIZES_FILE, prizes); }

  const entryFile = path.join(ENTRIES_DIR, draw.entryId + '.json');
  const entry = readJson(entryFile, null);
  if (entry && entry.wonPrizes) {
    const idx = entry.wonPrizes.indexOf(draw.prizeName);
    if (idx > -1) entry.wonPrizes.splice(idx, 1);
    fs.writeFileSync(entryFile, JSON.stringify(entry));
  }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('幸运抽奖系统 running on port ' + PORT));
