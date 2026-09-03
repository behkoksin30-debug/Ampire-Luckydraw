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
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');

function defaultConfig() {
  return {
    title: '幸运抽奖登记',
    subtitle: '上传订单截图，填写资料，登记您的抽奖资格',
    conversionRate: 100,
    tiers: [],
    maxWinsPerPerson: 0,
    guaranteedGiftThreshold: 0,
    maxTicketsPerPerson: 0,
    registrationOpen: true,
    regStartDate: '',
    regEndDate: '',
    posterImage: null,
    tutorialImage: null,
    drawDurationSeconds: 5,
    registrationDeadline: '',
    soundTheme: 'classic',
    startGateEnforcedFor: ''
  };
}
function serverTodayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function enforceDeadline(cfg){
  if(cfg.registrationDeadline){
    const deadlineMs = new Date(cfg.registrationDeadline).getTime();
    if(!isNaN(deadlineMs) && Date.now() >= deadlineMs && cfg.registrationOpen !== false){
      cfg.registrationOpen = false;
      cfg.registrationDeadline = '';
      writeConfig(cfg);
    }
  }
  if(cfg.regStartDate){
    const today = serverTodayStr();
    if(today < cfg.regStartDate){
      if(cfg.registrationOpen !== false && cfg.startGateEnforcedFor !== cfg.regStartDate){
        cfg.registrationOpen = false;
        cfg.startGateEnforcedFor = cfg.regStartDate;
        writeConfig(cfg);
      }
    } else if(cfg.startGateEnforcedFor){
      cfg.startGateEnforcedFor = '';
      writeConfig(cfg);
    }
  }
  return cfg;
}

function ensureDirs() {
  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2));
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

function computeTicketCount(amount, rate, tiers, maxTicketsPerPerson) {
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
  let total = base + bonus;
  const cap = parseFloat(maxTicketsPerPerson) || 0;
  if (cap > 0 && total > cap) total = cap;
  return total;
}

/* ---------------- event config ---------------- */
function isDateStr(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
app.get('/api/config', (req, res) => {
  const cfg = enforceDeadline(readConfig());
  res.json({
    title: cfg.title || '幸运抽奖登记',
    subtitle: cfg.subtitle || '',
    conversionRate: cfg.conversionRate || 100,
    tiers: cfg.tiers || [],
    maxWinsPerPerson: cfg.maxWinsPerPerson || 0,
    guaranteedGiftThreshold: cfg.guaranteedGiftThreshold || 0,
    maxTicketsPerPerson: cfg.maxTicketsPerPerson || 0,
    registrationOpen: cfg.registrationOpen !== false,
    regStartDate: cfg.regStartDate || '',
    regEndDate: cfg.regEndDate || '',
    posterImage: cfg.posterImage || null,
    tutorialImage: cfg.tutorialImage || null,
    drawDurationSeconds: cfg.drawDurationSeconds || 5,
    registrationDeadline: cfg.registrationDeadline || '',
    soundTheme: cfg.soundTheme || 'classic'
  });
});
app.put('/api/config', requireAdmin, (req, res) => {
  const cfg = readConfig();
  cfg.title = (req.body.title || cfg.title || '幸运抽奖登记').toString().slice(0, 60);
  if (req.body.subtitle !== undefined) {
    cfg.subtitle = (req.body.subtitle || '').toString().slice(0, 140);
  }
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
  if (req.body.maxTicketsPerPerson !== undefined) {
    const mt = parseInt(req.body.maxTicketsPerPerson, 10);
    cfg.maxTicketsPerPerson = (!isNaN(mt) && mt >= 0) ? mt : (cfg.maxTicketsPerPerson || 0);
  }
  if (req.body.registrationOpen !== undefined) {
    cfg.registrationOpen = !!req.body.registrationOpen;
  }
  if (req.body.regStartDate !== undefined) {
    cfg.regStartDate = isDateStr(req.body.regStartDate) ? req.body.regStartDate : '';
  }
  if (req.body.regEndDate !== undefined) {
    cfg.regEndDate = isDateStr(req.body.regEndDate) ? req.body.regEndDate : '';
  }
  if (req.body.posterImage !== undefined) {
    cfg.posterImage = req.body.posterImage || null;
  }
  if (req.body.tutorialImage !== undefined) {
    cfg.tutorialImage = req.body.tutorialImage || null;
  }
  if (req.body.drawDurationSeconds !== undefined) {
    const ds = parseFloat(req.body.drawDurationSeconds);
    cfg.drawDurationSeconds = (!isNaN(ds) && ds >= 3 && ds <= 10) ? ds : (cfg.drawDurationSeconds || 5);
  }
  if (req.body.registrationDeadline !== undefined) {
    const dl = req.body.registrationDeadline;
    if (!dl) { cfg.registrationDeadline = ''; }
    else {
      const ms = new Date(dl).getTime();
      cfg.registrationDeadline = !isNaN(ms) ? dl : '';
    }
  }
  if (req.body.soundTheme !== undefined) {
    cfg.soundTheme = ['classic','electronic','drum'].includes(req.body.soundTheme) ? req.body.soundTheme : (cfg.soundTheme || 'classic');
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
  const cfg = enforceDeadline(readConfig());
  if (cfg.registrationOpen === false) {
    const today = serverTodayStr();
    if (cfg.regStartDate && today < cfg.regStartDate) {
      return res.status(400).json({ error: '报名尚未开始 / Registration has not started yet' });
    }
    return res.status(400).json({ error: '报名已结束 / Registration is closed' });
  }
  const { name, contact, ddName, customerName, orderId, amount, photo, ocrOverride } = req.body || {};
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
    ocrOverride: !!ocrOverride,
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
  const maxTickets = cfg.maxTicketsPerPerson || 0;
  const files = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => readJson(path.join(ENTRIES_DIR, f), null)).filter(Boolean);
  list.forEach(entry => {
    const count = computeTicketCount(entry.amount, rate, tiers, maxTickets);
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
app.delete('/api/entries', requireAdmin, (req, res) => {
  const files = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  files.forEach(f => fs.unlinkSync(path.join(ENTRIES_DIR, f)));
  res.json({ ok: true, deleted: files.length });
});

/* ---------------- prizes ---------------- */
app.get('/api/prizes', requireAdmin, (req, res) => {
  res.json(readJson(PRIZES_FILE, []));
});
const VALID_TIERS = ['', '大奖', '二奖', '三奖'];
app.post('/api/prizes', requireAdmin, (req, res) => {
  const { name, qty, photo, value, guaranteedEligible, guaranteedQty, tier } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请输入奖品名称' });
  const prizes = readJson(PRIZES_FILE, []);
  const prize = { id: genId('PZ-', 6), name: String(name).slice(0, 100), qty: Math.max(1, parseInt(qty, 10) || 1), photo: photo || null, value: value ? String(value).slice(0, 30) : '', guaranteedEligible: !!guaranteedEligible, guaranteedQty: Math.max(0, parseInt(guaranteedQty, 10) || 0), tier: VALID_TIERS.includes(tier) ? tier : '', createdAt: Date.now() };
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
  const { name, qty, photo, value, guaranteedEligible, guaranteedQty, tier } = req.body || {};
  if (name && String(name).trim()) prize.name = String(name).slice(0, 100);
  if (qty !== undefined) prize.qty = Math.max(0, parseInt(qty, 10) || 0);
  if (value !== undefined) prize.value = value ? String(value).slice(0, 30) : '';
  if (photo !== undefined) prize.photo = photo || null;
  if (guaranteedEligible !== undefined) prize.guaranteedEligible = !!guaranteedEligible;
  if (guaranteedQty !== undefined) prize.guaranteedQty = Math.max(0, parseInt(guaranteedQty, 10) || 0);
  if (tier !== undefined) prize.tier = VALID_TIERS.includes(tier) ? tier : '';
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
  if (!prize) return res.status(400).json({ error: '奖品无效' });
  if (guaranteed) {
    if ((prize.guaranteedQty || 0) < 1) return res.status(400).json({ error: '该礼物幸运轮盘预留数量不足' });
  } else {
    if (prize.qty < 1) return res.status(400).json({ error: '奖品无效或数量不足' });
  }
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
      return res.status(400).json({ error: '该顾客金额未达到幸运轮盘门槛' });
    }
    if (!prize.guaranteedEligible) {
      return res.status(400).json({ error: '该礼物未开放用于幸运轮盘' });
    }
    const allDraws = readJson(DRAWS_FILE, []);
    const alreadyGuaranteed = allDraws.some(d => d.entryId === entryId && d.guaranteed);
    if (alreadyGuaranteed) {
      return res.status(400).json({ error: '该顾客已经领取过幸运轮盘礼物，每人限领一次' });
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

  if (guaranteed) { prize.guaranteedQty = Math.max(0, (prize.guaranteedQty || 0) - 1); }
  else { prize.qty -= 1; }
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
  if (prize) {
    if (draw.guaranteed) prize.guaranteedQty = (prize.guaranteedQty || 0) + 1;
    else prize.qty += 1;
    writeJson(PRIZES_FILE, prizes);
  }

  const entryFile = path.join(ENTRIES_DIR, draw.entryId + '.json');
  const entry = readJson(entryFile, null);
  if (entry && entry.wonPrizes) {
    const idx = entry.wonPrizes.indexOf(draw.prizeName);
    if (idx > -1) entry.wonPrizes.splice(idx, 1);
    fs.writeFileSync(entryFile, JSON.stringify(entry));
  }
  res.json({ ok: true });
});
app.delete('/api/draws', requireAdmin, (req, res) => {
  const draws = readJson(DRAWS_FILE, []);
  const prizes = readJson(PRIZES_FILE, []);
  draws.forEach(draw => {
    const prize = prizes.find(p => p.id === draw.prizeId);
    if (prize) {
      if (draw.guaranteed) prize.guaranteedQty = (prize.guaranteedQty || 0) + 1;
      else prize.qty += 1;
    }
    const entryFile = path.join(ENTRIES_DIR, draw.entryId + '.json');
    const entry = readJson(entryFile, null);
    if (entry && entry.wonPrizes) {
      const idx = entry.wonPrizes.indexOf(draw.prizeName);
      if (idx > -1) entry.wonPrizes.splice(idx, 1);
      fs.writeFileSync(entryFile, JSON.stringify(entry));
    }
  });
  writeJson(PRIZES_FILE, prizes);
  writeJson(DRAWS_FILE, []);
  res.json({ ok: true, reset: draws.length });
});

/* ---------------- archives (snapshot current event, start fresh, restore) ---------------- */
const ACTIVE_ARCHIVE_FILE = path.join(DATA_DIR, 'active-archive.json');
function readActiveArchiveId() {
  const d = readJson(ACTIVE_ARCHIVE_FILE, { archiveId: null });
  return d.archiveId || null;
}
function writeActiveArchiveId(id) {
  writeJson(ACTIVE_ARCHIVE_FILE, { archiveId: id || null });
}
function snapshotActiveInto(archiveDir, label) {
  fs.mkdirSync(path.join(archiveDir, 'entries'), { recursive: true });
  const oldEntryFiles = fs.readdirSync(path.join(archiveDir, 'entries'));
  oldEntryFiles.forEach(f => fs.unlinkSync(path.join(archiveDir, 'entries', f)));
  const entryFiles = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  entryFiles.forEach(f => {
    fs.copyFileSync(path.join(ENTRIES_DIR, f), path.join(archiveDir, 'entries', f));
  });
  fs.copyFileSync(PRIZES_FILE, path.join(archiveDir, 'prizes.json'));
  fs.copyFileSync(DRAWS_FILE, path.join(archiveDir, 'draws.json'));
  fs.copyFileSync(CONFIG_FILE, path.join(archiveDir, 'config.json'));
  const draws = readJson(DRAWS_FILE, []);
  const cfg = readConfig();
  const existingMeta = readJson(path.join(archiveDir, 'meta.json'), null);
  const meta = {
    id: path.basename(archiveDir),
    label: label || (existingMeta && existingMeta.label) || (cfg.title || '未命名活动') + ' - ' + new Date().toLocaleString(),
    createdAt: (existingMeta && existingMeta.createdAt) || Date.now(),
    updatedAt: Date.now(),
    entryCount: entryFiles.length,
    drawCount: draws.length,
    title: cfg.title || ''
  };
  writeJson(path.join(archiveDir, 'meta.json'), meta);
  return meta;
}
function clearActiveData() {
  const entryFiles = fs.readdirSync(ENTRIES_DIR).filter(f => f.endsWith('.json'));
  entryFiles.forEach(f => fs.unlinkSync(path.join(ENTRIES_DIR, f)));
  writeJson(PRIZES_FILE, []);
  writeJson(DRAWS_FILE, []);
  const cfg = readConfig();
  const fresh = defaultConfig();
  fresh.passwordHash = cfg.passwordHash;
  fresh.passwordSalt = cfg.passwordSalt;
  writeConfig(fresh);
}

app.get('/api/archives', requireAdmin, (req, res) => {
  const ids = fs.readdirSync(ARCHIVES_DIR).filter(f => fs.statSync(path.join(ARCHIVES_DIR, f)).isDirectory());
  const list = ids.map(id => readJson(path.join(ARCHIVES_DIR, id, 'meta.json'), null)).filter(Boolean);
  list.sort((a, b) => (b.updatedAt||b.createdAt) - (a.updatedAt||a.createdAt));
  const activeId = readActiveArchiveId();
  list.forEach(m => { m.isActive = m.id === activeId; });
  res.json(list);
});
app.post('/api/archives', requireAdmin, (req, res) => {
  const id = genId('AR-', 8);
  const archiveDir = path.join(ARCHIVES_DIR, id);
  const meta = snapshotActiveInto(archiveDir, (req.body && req.body.label) || '');
  clearActiveData();
  writeActiveArchiveId(null);
  res.json(meta);
});
app.get('/api/archives/:id', requireAdmin, (req, res) => {
  const archiveDir = path.join(ARCHIVES_DIR, req.params.id);
  const meta = readJson(path.join(archiveDir, 'meta.json'), null);
  if (!meta) return res.status(404).json({ error: '存档不存在' });
  const cfg = readJson(path.join(archiveDir, 'config.json'), {});
  const rate = cfg.conversionRate || 100;
  const tiers = cfg.tiers || [];
  const maxTickets = cfg.maxTicketsPerPerson || 0;
  const entriesDir = path.join(archiveDir, 'entries');
  const entryFiles = fs.existsSync(entriesDir) ? fs.readdirSync(entriesDir).filter(f => f.endsWith('.json')) : [];
  const entries = entryFiles.map(f => readJson(path.join(entriesDir, f), null)).filter(Boolean);
  entries.forEach(entry => {
    const count = computeTicketCount(entry.amount, rate, tiers, maxTickets);
    entry.ticketCount = count;
  });
  entries.sort((a, b) => b.submittedAt - a.submittedAt);
  const prizes = readJson(path.join(archiveDir, 'prizes.json'), []);
  const draws = readJson(path.join(archiveDir, 'draws.json'), []);
  draws.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ meta, config: { title: cfg.title, subtitle: cfg.subtitle }, entries, prizes, draws });
});
app.post('/api/archives/:id/restore', requireAdmin, (req, res) => {
  const archiveDir = path.join(ARCHIVES_DIR, req.params.id);
  const meta = readJson(path.join(archiveDir, 'meta.json'), null);
  if (!meta) return res.status(404).json({ error: '存档不存在' });

  const currentActiveId = readActiveArchiveId();
  if (currentActiveId && currentActiveId !== req.params.id) {
    const currentArchiveDir = path.join(ARCHIVES_DIR, currentActiveId);
    if (fs.existsSync(currentArchiveDir)) {
      snapshotActiveInto(currentArchiveDir, null);
    }
  } else if (!currentActiveId) {
    const autoArchiveId = genId('AR-', 8);
    snapshotActiveInto(path.join(ARCHIVES_DIR, autoArchiveId), '自动备份 - ' + new Date().toLocaleString());
  }
  clearActiveData();

  const entriesDir = path.join(archiveDir, 'entries');
  if (fs.existsSync(entriesDir)) {
    fs.readdirSync(entriesDir).filter(f => f.endsWith('.json')).forEach(f => {
      fs.copyFileSync(path.join(entriesDir, f), path.join(ENTRIES_DIR, f));
    });
  }
  const archivedPrizes = readJson(path.join(archiveDir, 'prizes.json'), []);
  writeJson(PRIZES_FILE, archivedPrizes);
  const archivedDraws = readJson(path.join(archiveDir, 'draws.json'), []);
  writeJson(DRAWS_FILE, archivedDraws);

  const archivedConfig = readJson(path.join(archiveDir, 'config.json'), defaultConfig());
  const currentCfg = readConfig();
  archivedConfig.passwordHash = currentCfg.passwordHash;
  archivedConfig.passwordSalt = currentCfg.passwordSalt;
  writeConfig(archivedConfig);

  writeActiveArchiveId(req.params.id);
  res.json({ ok: true });
});
function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) rimraf(p);
    else fs.unlinkSync(p);
  });
  fs.rmdirSync(dir);
}
app.delete('/api/archives/:id', requireAdmin, (req, res) => {
  const archiveDir = path.join(ARCHIVES_DIR, req.params.id);
  const meta = readJson(path.join(archiveDir, 'meta.json'), null);
  if (!meta) return res.status(404).json({ error: '存档不存在' });
  rimraf(archiveDir);
  if (readActiveArchiveId() === req.params.id) writeActiveArchiveId(null);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('幸运抽奖系统 running on port ' + PORT));
