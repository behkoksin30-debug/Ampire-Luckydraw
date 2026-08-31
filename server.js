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
      subtitle: '上传订单截图，填写资料，登记您的抽奖资格'
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

/* ---------------- event config ---------------- */
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  res.json({ title: cfg.title || '幸运抽奖登记', subtitle: cfg.subtitle || '' });
});
app.put('/api/config', requireAdmin, (req, res) => {
  const cfg = readConfig();
  cfg.title = (req.body.title || cfg.title || '幸运抽奖登记').toString().slice(0, 60);
  cfg.subtitle = (req.body.subtitle || '').toString().slice(0, 140);
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
  const { name, contact, orderId, amount, photo } = req.body || {};
  if (!name || !contact || !orderId || !amount || !photo) {
    return res.status(400).json({ error: '资料不完整，请填写全部字段并上传照片' });
  }
  const id = genId('LD-', 6);
  const entry = {
    id,
    name: String(name).slice(0, 100),
    contact: String(contact).slice(0, 100),
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
  const files = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => readJson(path.join(ENTRIES_DIR, f), null)).filter(Boolean);
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
  const { name, qty } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入奖品名称' });
  const prizes = readJson(PRIZES_FILE, []);
  const prize = { id: genId('PZ-', 6), name: String(name).slice(0, 100), qty: Math.max(1, parseInt(qty, 10) || 1), createdAt: Date.now() };
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

/* ---------------- draws ---------------- */
app.get('/api/draws', requireAdmin, (req, res) => {
  res.json(readJson(DRAWS_FILE, []));
});
app.post('/api/draws', requireAdmin, (req, res) => {
  const { prizeId, entryId } = req.body || {};
  const prizes = readJson(PRIZES_FILE, []);
  const prize = prizes.find(p => p.id === prizeId);
  if (!prize || prize.qty < 1) return res.status(400).json({ error: '奖品无效或数量不足' });
  const entryFile = path.join(ENTRIES_DIR, entryId + '.json');
  const entry = readJson(entryFile, null);
  if (!entry) return res.status(400).json({ error: '参与者不存在，可能已被删除' });

  const draw = {
    id: genId('DR-', 6),
    prizeId, prizeName: prize.name,
    entryId, winnerName: entry.name, winnerContact: entry.contact, winnerOrderId: entry.orderId,
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
