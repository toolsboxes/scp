const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// PostgreSQL 连接
const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://scp:520520@localhost:5432/scp',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Redis 连接
const redisConfig = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL }
  : { password: '520520' };
const redisClient = redis.createClient(redisConfig);
redisClient.on('error', err => console.log('Redis Error:', err));
redisClient.connect().catch(() => console.log('Redis 连接失败，继续运行'));

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 会话存储在 Redis
async function getSession(token) {
  try {
    const data = await redisClient.get('session:' + token);
    return data ? JSON.parse(data) : null;
  } catch (e) { return null; }
}
async function setSession(token, user) {
  try {
    await redisClient.setEx('session:' + token, 86400 * 7, JSON.stringify(user));
  } catch (e) {}
}

// 中间件：验证登录
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  const user = await getSession(token);
  if (!user) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = user;
  next();
}

// 中间件：验证管理员
async function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(403).json({ error: '需要管理员权限' });
  const user = await getSession(token);
  if (!user || user.username !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  req.user = user;
  next();
}

// 初始化数据库表
async function initDB() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(64) NOT NULL
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS echoes (
      id SERIAL PRIMARY KEY,
      text TEXT,
      image VARCHAR(255),
      username VARCHAR(50),
      time VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending'
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      user_id INT,
      filename VARCHAR(255),
      filesize BIGINT,
      filetype VARCHAR(100),
      stored_name VARCHAR(255),
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    const adminHash = crypto.createHash('sha256').update('520520').digest('hex');
    await db.query(`INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING`, ['admin', adminHash]);
    console.log('数据库初始化完成');
  } catch (e) {
    console.log('数据库初始化失败:', e.message);
  }
}
initDB();

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== 用户系统 ==========
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.length < 2 || password.length < 4) {
      return res.status(400).json({ error: '用户名至少2位，密码至少4位' });
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    await db.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hash]);
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') res.status(400).json({ error: '用户名已存在' });
    else res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const result = await db.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, hash]);
    if (!result.rows.length) return res.status(401).json({ error: '用户名或密码错误' });
    const token = crypto.randomBytes(32).toString('hex');
    await setSession(token, { id: result.rows[0].id, username: result.rows[0].username });
    res.json({ token, username: result.rows[0].username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 回声洞 ==========
app.get('/api/echo', async (req, res) => {
  try {
    const result = await db.query("SELECT id, text, image, username, time FROM echoes WHERE status = 'approved' ORDER BY id DESC LIMIT 100");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/echo', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { text } = req.body;
    if (!text && !req.file) return res.status(400).json({ error: '内容不能为空' });
    const image = req.file ? '/uploads/' + req.file.filename : null;
    const time = new Date().toLocaleString('zh-CN');
    await db.query("INSERT INTO echoes (text, image, username, time, status) VALUES ($1, $2, $3, $4, 'pending')",
      [text || '', image, req.user.username, time]);
    res.json({ success: true, message: '发布成功，等待审核' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/echo/pending', requireAdmin, async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM echoes WHERE status = 'pending' ORDER BY id DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/echo/:id/approve', requireAdmin, async (req, res) => {
  try {
    await db.query("UPDATE echoes SET status = 'approved' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/echo/:id', requireAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT image FROM echoes WHERE id = $1', [req.params.id]);
    if (result.rows[0]?.image) {
      const imgPath = path.join(__dirname, result.rows[0].image);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await db.query('DELETE FROM echoes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 云盘 ==========
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT id, filename, filesize, filetype, uploaded_at FROM files WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
    const usedResult = await db.query('SELECT COALESCE(SUM(filesize), 0) as total FROM files WHERE user_id = $1', [req.user.id]);
    res.json({ files: result.rows, used: usedResult.rows[0].total, limit: 10 * 1024 * 1024 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/files', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const usedResult = await db.query('SELECT COALESCE(SUM(filesize), 0) as total FROM files WHERE user_id = $1', [req.user.id]);
    const limit = 10 * 1024 * 1024;
    if (parseInt(usedResult.rows[0].total) + req.file.size > limit) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '存储空间不足（每人10MB）' });
    }
    await db.query('INSERT INTO files (user_id, filename, filesize, filetype, stored_name) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, req.file.originalname, req.file.size, req.file.mimetype, req.file.filename]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(uploadDir, result.rows[0].stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });
    res.download(filePath, result.rows[0].filename);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(uploadDir, result.rows[0].stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await db.query('DELETE FROM files WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== 服务器状态 ==========
app.get('/api/status', async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = ((1 - freeMem / totalMem) * 100).toFixed(1);
    const cpuUsage = ((os.loadavg()[0] / os.cpus().length) * 100).toFixed(1);
    res.json({ cpu: cpuUsage, mem: memUsage, disk: 'N/A', net: '正常', postgresql: true, redis: true, node: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SCP 服务器运行在 http://0.0.0.0:${PORT}`);
});
