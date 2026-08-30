#!/usr/bin/env node
// 云浏览器 v1.1.0 - 骨架：HTTP + 浏览器 + screencast + MJPEG
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CONFIG = {
  port: 8088,
  serverHost: 'YOUR_SERVER_IP',
  uiDir: path.join(__dirname, 'ui'),
  viewport: { width: 960, height: 266 },
  fps: 20,
  defaultUrl: 'https://m.baidu.com/'
};

let latestJpeg = null;
let latestJpegTime = 0;
let activeSession = null;
let sessions = new Map();
// HTTP 触控节流状态（与 TCP 触控独立，避免交叉干扰）
const touchState = { lastX: -1, lastY: -1, lastMoveTime: 0 };
// 网页输入框焦点状态（注入脚本上报，miniapp 轮询触发系统输入法）
let webInputPending = { active: false, type: '', value: '', placeholder: '', updatedAt: 0 };

function currentSession() {
  return sessions.get(0) || activeSession;
}

// ---- ClientSession (从 v1.0 已验证结构复刻) ----
class ClientSession {
  constructor(id) {
    this.id = id;
    this.url = CONFIG.defaultUrl;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSession = null;
    this.screencastActive = false;
    this.alive = true;
  }

  async start() {
    console.log(`[session ${this.id}] starting for ${this.url}`);
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-software-rasterizer', '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader', '--disable-features=VizDisplayCompositor'
      ],
      timeout: 30000
    });
    this.context = await this.browser.newContext({
      viewport: CONFIG.viewport, isMobile: false, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    });
    this.page = await this.context.newPage();
    this.page.on('crash', () => { console.log(`[session ${this.id}] page crash`); this.stop(); });

    // 弹窗
    this.context.on('page', async (newPage) => {
      if (newPage === this.page) return;
      console.log(`[session ${this.id}] popup: ${newPage.url() || 'about:blank'}`);
      const oldPage = this.page;
      this.page = newPage;
      try { if (this.cdpSession) this.cdpSession.detach().catch(() => {}); } catch (e) {}
      this.cdpSession = await this.context.newCDPSession(this.page);
      this.setupScreencast();
      this.startScreencast();
      newPage.on('load', () => {
        try { if (oldPage && !oldPage.isClosed()) oldPage.close().catch(() => {}); } catch (e) {}
      });
    });

    this.cdpSession = await this.context.newCDPSession(this.page);
    this.setupScreencast();
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    this.startScreencast();

    console.log(`[session ${this.id}] started okay`);
  }

  setupScreencast() {
    if (!this.cdpSession) return;
    this.cdpSession.on('Page.screencastFrame', async (params) => {
      const { data, sessionId } = params;
      try {
        const screenshot = Buffer.from(data, 'base64');
        latestJpeg = screenshot;
        latestJpegTime = Date.now();
        broadcastMjpeg(screenshot);
        if (this.cdpSession) {
          this.cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        }
      } catch (e) {
        console.error(`[session ${this.id}] frame error: ${e.message}`);
      }
    });
  }

  async startScreencast() {
    if (!this.cdpSession) return;
    try {
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg', quality: 70,
        maxWidth: CONFIG.viewport.width, maxHeight: CONFIG.viewport.height,
        everyNthFrame: 1
      });
      this.screencastActive = true;
      console.log(`[session ${this.id}] screencast started`);
    } catch (e) {
      console.error(`[session ${this.id}] startScreencast failed: ${e.message}`);
    }
  }

  async stop() {
    this.alive = false;
    try { if (this.cdpSession) this.cdpSession.detach().catch(() => {}); } catch (e) {}
    try { if (this.browser) this.browser.close().catch(() => {}); } catch (e) {}
    this.cdpSession = null; this.browser = null; this.page = null;
    console.log(`[session ${this.id}] stopped`);
  }
}

// 触摸触发即时截图：绕过 screencast 静止停帧的恢复延迟
let lastForceFrameTime = 0;
function forceFrame() {
  const s = currentSession();
  if (!s || !s.alive || !s.page || s.page.isClosed()) return;
  // 节流：100ms 内只截一次，避免滑动时 screenshot 堆积（300ms→100ms 提升拖动跟手性）
  const now = Date.now();
  if (now - lastForceFrameTime < 100) return;
  lastForceFrameTime = now;
  s.page.screenshot({ type: 'jpeg', quality: 70 }).then((buf) => {
    if (!buf || buf.length === 0) return;
    latestJpeg = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    latestJpegTime = Date.now();
    broadcastMjpeg(latestJpeg);
  }).catch(() => {});
}

// 页面输入框焦点轮询：服务器主动检测 activeElement（支持跨域 iframe 内的输入框）
setInterval(async () => {
  const s = currentSession();
  if (!s || !s.alive || !s.cdpSession || !s.page || s.page.isClosed()) return;
  try {
    // 1. 主 frame 检测
    const main = await s.page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { focused: false };
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'iframe') return { iframe: true, focused: false };
      const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
      if (!editable) return { focused: false };
      return {
        focused: true,
        type: tag === 'textarea' ? 'textarea' : (el.type || 'text'),
        value: (typeof el.value === 'string') ? el.value : '',
        placeholder: (el.getAttribute && el.getAttribute('placeholder')) || ''
      };
    }).catch(() => ({ focused: false }));

    if (main && main.focused) {
      webInputPending = { active: true, type: main.type, value: main.value, placeholder: main.placeholder, updatedAt: Date.now(), frameUrl: '' };
      return;
    }

    // 2. 主 frame 无焦点（或焦点在 iframe）→ 遍历子 frame 检测
    if (!main || !main.focused) {
      const frames = s.page.frames();
      for (const f of frames) {
        if (f === s.page.mainFrame()) continue;
        try {
          const r = await f.evaluate(() => {
            const el = document.activeElement;
            if (!el) return { focused: false };
            const tag = (el.tagName || '').toLowerCase();
            const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
            if (!editable) return { focused: false };
            return {
              focused: true,
              type: tag === 'textarea' ? 'textarea' : (el.type || 'text'),
              value: (typeof el.value === 'string') ? el.value : '',
              placeholder: (el.getAttribute && el.getAttribute('placeholder')) || ''
            };
          }).catch(() => ({ focused: false }));
          if (r && r.focused) {
            webInputPending = { active: true, type: r.type, value: r.value, placeholder: r.placeholder, updatedAt: Date.now(), frameUrl: f.url() };
            return;
          }
        } catch (e) {}
      }
    }

    // 3. 无任何输入框焦点，清除 pending
    if (webInputPending.active) webInputPending.active = false;
  } catch (e) {}
}, 250);

// ---- TCP 触控服务器 (端口 8089) ----
const net = require('net');
const touchServer = net.createServer((socket) => {
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let lastX = -1, lastY = -1;
  let lastMoveTime = 0;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 7) {
      const msg = buf.slice(0, 7);
      buf = buf.slice(7);
      const type = msg[0];
      const x = (msg[1] << 8) | msg[2];
      const y = (msg[3] << 8) | msg[4];
      console.log(`[touch-tcp] type=${String.fromCharCode(type)} x=${x} y=${y}`);
      const s = currentSession();
      if (!s || !s.cdpSession) continue;
      const cdp = s.cdpSession;

      if (type === 0x53) {
        // touchStart: 先 cancel 再 start
        cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
        cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 0 }], modifiers: 0 }).catch(() => {});
        forceFrame(); // 立即抓新帧，绕过 screencast 静止恢复延迟
        lastX = x; lastY = y;
      } else if (type === 0x4D) {
        // touchMove: 去重 + 50ms 节流 + fire-and-forget
        if (x === lastX && y === lastY) continue;
        const now = Date.now();
        if (now - lastMoveTime < 50) continue;
        cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 0 }], modifiers: 0 }).catch(() => {});
        forceFrame(); // move 也触发截图，保证滑动时画面实时
        lastX = x; lastY = y;
        lastMoveTime = now;
      } else if (type === 0x45) {
        // touchEnd
        cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers: 0 }).catch(() => {});
        lastX = -1; lastY = -1;
        // 提交按钮兜底：headless Chrome 合成事件不触发 submit，点击命中提交按钮时手动 requestSubmit
        const sx = x, sy = y;
        s.page.evaluate((p) => {
          const px = p.x, py = p.y;
          // 遍历所有 submit 按钮，判断点击点是否在矩形内（含容差）
          const btns = document.querySelectorAll('button[type=submit], input[type=submit], .se-bn, [class*=search] button, [class*=btn]');
          const positions = [];
          let best = null;
          btns.forEach((b) => {
            const r = b.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            positions.push({ cls: (b.className || '').toString().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
            const pad = 25;
            if (px >= r.left - pad && px <= r.right + pad && py >= r.top - pad && py <= r.bottom + pad) {
              best = b;
            }
          });
          if (best && best.form) {
            best.form.requestSubmit();
            return { submitted: true, tag: best.tagName, type: best.type || 'submit', positions };
          }
          // 兜底2：elementFromPoint 向上找（点击 input 时不提交）
          const el = document.elementFromPoint(px, py);
          let node = el;
          while (node && node !== document.documentElement) {
            if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable) {
              return { submitted: false, hitInput: true, positions };
            }
            const isSubmit = (node.tagName === 'BUTTON' && (!node.type || node.type === 'submit')) || node.type === 'submit';
            if (isSubmit && node.form) {
              node.form.requestSubmit();
              return { submitted: true, tag: node.tagName, type: node.type || 'submit', positions };
            }
            if (node.tagName === 'FORM') {
              node.requestSubmit();
              return { submitted: true, form: true, positions };
            }
            node = node.parentElement;
          }
          return { submitted: false, positions, atTop: el ? (el.tagName + '.' + (el.className || '').toString().slice(0, 30)) : null };
        }, { x: sx, y: sy }).then((r) => {
          if (r && r.submitted) console.log('[submit-fallback] tcp(' + sx + ',' + sy + ') -> ' + (r.tag || 'FORM') + '/' + (r.type || r.form || ''));
          else console.log('[submit-fallback] tcp MISS(' + sx + ',' + sy + ') top=' + (r ? r.atTop : 'eval-err') + ' btns=' + JSON.stringify(r ? r.positions : []));
        }).catch(() => {});
        forceFrame();
      }
    }
  });
  socket.on('error', () => {});
});
touchServer.listen(8089, () => {
  console.log('TCP触摸服务器：端口 8089');
});

// ---- H.264 裸 TCP 流 (端口 8090，设备 tcpclientsrc 用，省 HTTP 层) ----
const h264TcpClients = new Set();
const h264TcpServer = net.createServer((socket) => {
  socket.setNoDelay(true);
  h264TcpClients.add(socket);
  console.log('[h264-tcp] client connected');
  socket.on('close', () => h264TcpClients.delete(socket));
  socket.on('error', () => h264TcpClients.delete(socket));
});
h264TcpServer.listen(8090, () => {
  console.log('H.264 TCP裸流：端口 8090');
});

// ---- H.264 单例 ffmpeg ----
const h264Clients = new Set();
let h264Ffmpeg = null;
let h264Active = false;

function ensureH264() {
  if (h264Active) return;
  h264Active = true;
  console.log('[h264] starting singleton ffmpeg');

  h264Ffmpeg = spawn('ffmpeg', [
    '-f', 'image2pipe', '-c:v', 'mjpeg',
    '-framerate', String(CONFIG.fps), '-i', 'pipe:0',
    '-vf', 'scale=960:266:force_original_aspect_ratio=decrease,pad=960:266:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-level', '3.1',
    '-pix_fmt', 'yuv420p', '-bf', '0', '-refs', '1',
    '-b:v', '1200k',
    '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
    '-x264-params', 'repeat-headers=1:aud=1:scenecut=0:keyint=10:min-keyint=10',
    '-flush_packets', '1', '-muxdelay', '0',
    '-mpegts_flags', '+resend_headers',
    '-f', 'mpegts', 'pipe:1'
  ]);

  h264Ffmpeg.stdout.on('data', (chunk) => {
    for (const res of h264Clients) {
      try { res.write(chunk); } catch (e) { h264Clients.delete(res); }
    }
    for (const s of h264TcpClients) {
      try { s.write(chunk); } catch (e) { h264TcpClients.delete(s); }
    }
  });
  h264Ffmpeg.stderr.on('data', (d) => {
    const s = d.toString();
    // 完整记录 ffmpeg 警告，便于排查
    if (s.trim()) console.log('[h264 ffmpeg]', s.trim().split('\n').slice(0, 3).join(' | '));
  });
  h264Ffmpeg.on('close', () => {
    h264Active = false;
    h264Ffmpeg = null;
    for (const res of h264Clients) { try { res.end(); } catch(e) {} }
    h264Clients.clear();
    for (const s of h264TcpClients) { try { s.destroy(); } catch(e) {} }
    h264TcpClients.clear();
    console.log('[h264] ffmpeg stopped');
  });

  // 背压控制：stdin 缓冲满时暂停推帧（丢帧保实时），drain 后恢复
  let h264Paused = false;
  h264Ffmpeg.stdin.on('drain', () => { h264Paused = false; });
  let h264Dropped = 0;
  // 推帧循环（setInterval + 背压：宁可掉帧，不可积压延迟）
  const timer = setInterval(() => {
    if (!h264Active || !h264Ffmpeg || !latestJpeg || h264Paused) return;
    const ok = h264Ffmpeg.stdin.write(latestJpeg);
    if (!ok) { h264Paused = true; h264Dropped++; }
  }, 1000 / CONFIG.fps);
  h264Ffmpeg._frameTimer = timer;
  // 每 10 秒报告一次丢帧统计
  const statTimer = setInterval(() => {
    if (h264Dropped > 0) { console.log(`[h264] dropped ${h264Dropped} frames (backpressure)`); h264Dropped = 0; }
  }, 10000);
  h264Ffmpeg._statTimer = statTimer;
}

// ---- MJPEG ----
const mjpegClients = new Set();
function broadcastMjpeg(jpegBuffer) {
  if (mjpegClients.size === 0) return;
  const header = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuffer.length}\r\n\r\n`);
  const footer = Buffer.from('\r\n');
  for (const res of mjpegClients) {
    try { res.write(header); res.write(jpegBuffer); res.write(footer); } catch (e) { mjpegClients.delete(res); }
  }
}
// 定时推送静止帧，保证 MJPEG 流不中断
setInterval(() => { if (latestJpeg) broadcastMjpeg(latestJpeg); }, 1000 / CONFIG.fps);

// ---- HTTP 工具 ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}

// ---- HTTP 服务器 ----
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  if (urlPath === '/stream.mjpeg') {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    mjpegClients.add(res);
    req.on('close', () => { mjpegClients.delete(res); });
    // 立即推送当前帧（如果有的话）
    if (latestJpeg) {
      try {
        res.write(Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestJpeg.length}\r\n\r\n`));
        res.write(latestJpeg);
        res.write(Buffer.from('\r\n'));
      } catch (e) {}
    }
    return;
  }
  // H.264 实时流端点（单例 ffmpeg）
  if (urlPath === '/stream.h264') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('no session');
      return;
    }
    console.log('[h264] client connected');
    res.writeHead(200, {
      'Content-Type': 'video/x-h264',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    });
    h264Clients.add(res);
    req.on('close', () => { h264Clients.delete(res); });
    ensureH264();
    return;
  }
  if (urlPath === '/status.json') {
    sendJson(res, 200, { fps: CONFIG.fps, viewport: CONFIG.viewport, latestFrameAgeMs: latestJpegTime ? Date.now() - latestJpegTime : -1, sessions: sessions.size, mjpegClients: mjpegClients.size });
    return;
  }
  // 导航端点
  if (urlPath === '/nav' || urlPath === '/back' || urlPath === '/forward' || urlPath === '/refresh') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const doAction = async () => {
      try {
        if (urlPath === '/nav') {
          let url = '';
          if (req.method === 'POST') {
            url = await new Promise((resolve) => {
              let body = '';
              req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
              req.on('end', () => resolve(body));
            });
            try { const j = JSON.parse(body); url = j.url || ''; } catch (e) {}
          } else if (req.method === 'GET') {
            const q = req.url.split('?')[1] || '';
            const m = q.match(/url=([^&]+)/);
            if (m) url = decodeURIComponent(m[1]);
          }
          if (!url) { sendJson(res, 400, { error: 'missing url' }); return; }
          await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          sendJson(res, 200, { ok: true, url });
        } else if (urlPath === '/back') {
          await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          sendJson(res, 200, { ok: true });
        } else if (urlPath === '/forward') {
          await s.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          sendJson(res, 200, { ok: true });
        } else if (urlPath === '/refresh') {
          await s.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          sendJson(res, 200, { ok: true });
        }
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    };
    doAction();
    return;
  }
  // HTTP 触控端点（浏览器调试页用）
  if (urlPath === '/touch') {
    const s = currentSession();
    if (!s || !s.alive || !s.cdpSession) { sendJson(res, 503, { error: 'no session' }); return; }
    // GET: 从 query string 解析；POST: 从 body JSON 解析
    const finish = (params) => {
      const evtType = params.event === 'start' ? 'touchStart'
        : params.event === 'move' ? 'touchMove'
        : params.event === 'end' ? 'touchEnd'
        : null;
      if (!evtType) { sendJson(res, 400, { error: 'bad event' }); return; }
      const x = parseInt(params.x, 10) || 0;
      const y = parseInt(params.y, 10) || 0;
      const id = parseInt(params.id, 10) || 0;
      const cdp = s.cdpSession;
      const touchPoints = evtType === 'touchEnd' || evtType === 'touchCancel'
        ? [] : [{ x, y, radiusX: 5, radiusY: 5, force: 1, id }];
      if (evtType === 'touchStart') {
        cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
        cdp.send('Input.dispatchTouchEvent', { type: evtType, touchPoints }).catch(() => {});
        forceFrame();
        touchState.lastX = x; touchState.lastY = y; touchState.lastMoveTime = 0;
      } else if (evtType === 'touchMove') {
        // 坐标去重 + 50ms 节流
        if (x === touchState.lastX && y === touchState.lastY) { sendJson(res, 200, { ok: true }); return; }
        const now = Date.now();
        if (now - touchState.lastMoveTime < 50) { sendJson(res, 200, { ok: true }); return; }
        cdp.send('Input.dispatchTouchEvent', { type: evtType, touchPoints }).catch(() => {});
        forceFrame();
        touchState.lastX = x; touchState.lastY = y; touchState.lastMoveTime = now;
      } else {
        // touchEnd / touchCancel
        cdp.send('Input.dispatchTouchEvent', { type: evtType, touchPoints }).catch(() => {});
        touchState.lastX = -1; touchState.lastY = -1; touchState.lastMoveTime = 0;
        // 提交按钮兜底：headless Chrome 合成事件不触发 submit，点击命中提交按钮时手动 requestSubmit
        const sx = x, sy = y;
        s.page.evaluate((p) => {
          const px = p.x, py = p.y;
          // 遍历所有 submit 按钮，判断点击点是否在矩形内（含容差）
          const btns = document.querySelectorAll('button[type=submit], input[type=submit], .se-bn, [class*=search] button, [class*=btn]');
          const positions = [];
          let best = null;
          btns.forEach((b) => {
            const r = b.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return;
            positions.push({ cls: (b.className || '').toString().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
            const pad = 25;
            if (px >= r.left - pad && px <= r.right + pad && py >= r.top - pad && py <= r.bottom + pad) {
              best = b;
            }
          });
          if (best && best.form) {
            best.form.requestSubmit();
            return { submitted: true, tag: best.tagName, type: best.type || 'submit', positions };
          }
          // 兜底2：elementFromPoint 向上找（点击 input 时不提交）
          const el = document.elementFromPoint(px, py);
          let node = el;
          while (node && node !== document.documentElement) {
            if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable) {
              return { submitted: false, hitInput: true, positions };
            }
            const isSubmit = (node.tagName === 'BUTTON' && (!node.type || node.type === 'submit')) || node.type === 'submit';
            if (isSubmit && node.form) {
              node.form.requestSubmit();
              return { submitted: true, tag: node.tagName, type: node.type || 'submit', positions };
            }
            if (node.tagName === 'FORM') {
              node.requestSubmit();
              return { submitted: true, form: true, positions };
            }
            node = node.parentElement;
          }
          return { submitted: false, positions, atTop: el ? (el.tagName + '.' + (el.className || '').toString().slice(0, 30)) : null };
        }, { x: sx, y: sy }).then((r) => {
          if (r && r.submitted) console.log('[submit-fallback] touch(' + sx + ',' + sy + ') -> ' + (r.tag || 'FORM') + '/' + (r.type || r.form || ''));
          else console.log('[submit-fallback] MISS(' + sx + ',' + sy + ') top=' + (r ? r.atTop : 'eval-err') + ' btns=' + JSON.stringify(r ? r.positions : []));
        }).catch(() => {});
        forceFrame();
      }
      sendJson(res, 200, { ok: true });
    };
    if (req.method === 'GET') {
      const q = req.url.split('?')[1] || '';
      const params = {};
      q.split('&').forEach((kv) => {
        if (!kv) return;
        const idx = kv.indexOf('=');
        const k = idx >= 0 ? kv.slice(0, idx) : kv;
        const v = idx >= 0 ? kv.slice(idx + 1) : '';
        if (k) params[k] = decodeURIComponent(v || '');
      });
      finish(params);
      return;
    }
    // POST
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body || '{}'); } catch (e) {}
      finish(params);
    });
    return;
  }
  // 网页输入框焦点端点
  if (urlPath === '/debug-page') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    s.page.evaluate(() => {
      const vis = [];
      document.querySelectorAll('input, textarea').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          vis.push({ tag: el.tagName, type: el.type || '', ph: el.placeholder || '', val: el.value || '', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
      // 查找搜索按钮类元素
      const btns = [];
      document.querySelectorAll('button, [role=button], .s_btn, [class*=btn], [class*=search]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 300 && r.height < 100) {
          btns.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), txt: (el.textContent || '').trim().slice(0, 10), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
      // iframe 列表
      const frames = [];
      document.querySelectorAll('iframe').forEach((f) => {
        const r = f.getBoundingClientRect();
        frames.push({ src: (f.src || '').slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      });
      return {
        url: location.href,
        visibleInputs: vis.slice(0, 3),
        buttons: btns.slice(0, 6),
        frames,
        focused: document.activeElement ? (document.activeElement.tagName + '.' + (document.activeElement.type || '')) : 'none'
      };
    }).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 触控校准：移动校准页金点位置（配合 calibrate.html）
  if (urlPath === '/calib-move') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const mx = q.match(/x=([^&]*)/); const my = q.match(/y=([^&]*)/);
    const x = mx ? parseInt(mx[1], 10) : 480;
    const y = my ? parseInt(my[1], 10) : 133;
    s.page.evaluate((p) => {
      const dot = document.getElementById('centerDot');
      if (!dot) return { ok: false, error: 'no centerDot' };
      dot.style.left = p.x + 'px';
      dot.style.top = p.y + 'px';
      const label = document.getElementById('coordDisplay');
      if (label) label.textContent = '点击金点 (目标 ' + p.x + ',' + p.y + ')';
      return { ok: true, x: p.x, y: p.y };
    }, { x, y }).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 触控校准：在页面显示标记点（用于校准设备触控映射）
  if (urlPath === '/calib-start') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const points = [
      { id: 1, x: 480, y: 133 },   // 中心
      { id: 2, x: 120, y: 50 },    // 左上
      { id: 3, x: 840, y: 50 },    // 右上
      { id: 4, x: 120, y: 216 },   // 左下
      { id: 5, x: 840, y: 216 }    // 右下
    ];
    s.page.evaluate((pts) => {
      document.querySelectorAll('.cb-calib').forEach((el) => el.remove());
      const root = document.body || document.documentElement;
      pts.forEach((p) => {
        const d = document.createElement('div');
        d.className = 'cb-calib';
        d.style.cssText = 'position:fixed;left:' + (p.x - 25) + 'px;top:' + (p.y - 25) + 'px;width:50px;height:50px;border-radius:50%;background:rgba(255,0,0,0.8);z-index:99999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:bold;';
        d.textContent = String(p.id);
        root.appendChild(d);
      });
    }, points).then(() => {
      forceFrame(); // 立即截图让红点显示在画面
      sendJson(res, 200, { ok: true, points });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  if (urlPath === '/calib-clear') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    s.page.evaluate(() => { document.querySelectorAll('.cb-calib').forEach((el) => el.remove()); })
      .then(() => sendJson(res, 200, { ok: true }))
      .catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
    // 调试：列出所有 frame 并在每个 frame 内检测输入框（验证跨域 iframe 穿透）
  if (urlPath === '/debug-frames') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const frames = s.page.frames();
    const results = [];
    let i = 0;
    const next = () => {
      if (i >= frames.length) { sendJson(res, 200, results); return; }
      const f = frames[i];
      i++;
      const entry = { idx: i - 1, url: f.url().slice(0, 100), isMain: f === s.page.mainFrame() };
      f.evaluate(() => {
        const el = document.activeElement;
        const vis = [];
        document.querySelectorAll('input, textarea').forEach((inp) => {
          const r = inp.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            vis.push({ ph: inp.placeholder || '', type: inp.type || '', val: inp.value || '', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
          }
        });
        return {
          activeTag: el ? el.tagName : null,
          activeType: el && el.type ? el.type : null,
          inputs: vis.slice(0, 5)
        };
      }).then((r) => {
        entry.active = r.activeTag + (r.activeType ? '.' + r.activeType : '');
        entry.inputs = r.inputs;
        results.push(entry);
        next();
      }).catch((e) => {
        entry.error = e.message.slice(0, 80);
        results.push(entry);
        next();
      });
    };
    next();
    return;
  }
  // 调试：查看指定坐标处元素（排查遮挡层）
  if (urlPath === '/debug-element') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const m = q.match(/x=([^&]*)/); const my = q.match(/y=([^&]*)/);
    const x = m ? parseInt(m[1], 10) : 480;
    const y = my ? parseInt(my[1], 10) : 133;
    s.page.evaluate((p) => {
      const px = p.x, py = p.y;
      const el = document.elementFromPoint(px, py);
      const chain = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const r = n.getBoundingClientRect();
        chain.push({ tag: n.tagName, cls: (n.className || '').toString().slice(0, 50), id: n.id || '', type: n.type || '', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        n = n.parentElement;
      }
      return { at: [px, py], top: el ? { tag: el.tagName, cls: (el.className || '').toString().slice(0, 50), id: el.id || '' } : null, chain: chain.slice(0, 8) };
    }, { x, y }).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 调试：直接提交搜索表单（验证 form 提交是否触发跳转）
  if (urlPath === '/debug-submit') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const m = q.match(/text=([^&]*)/);
    const text = m ? decodeURIComponent(m[1]) : '';
    s.page.evaluate((t) => {
      const inp = document.querySelector('input[type=search], #index-kw, [name=word]');
      if (!inp) return { found: false };
      if (t) inp.value = t;
      const f = inp.form;
      if (!f) return { found: true, noForm: true };
      let used = 'submit';
      try { f.requestSubmit(); used = 'requestSubmit'; }
      catch (e) { try { f.submit(); } catch (e2) { return { found: true, used, err: e2.message }; } }
      return { found: true, used, action: f.action, word: inp.value };
    }, text).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 调试：检查页面搜索交互结构
  if (urlPath === '/debug-inspect') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    s.page.evaluate(() => {
      const inp = document.querySelector('input[type=search]');
      const btn = document.querySelector('.se-bn');
      const result = {};
      if (inp) {
        const f = inp.form;
        result.input = { inForm: !!f, formAction: f ? f.action : null, name: inp.name, id: inp.id };
      }
      if (btn) {
        result.btn = { type: btn.type, tag: btn.tagName, onclick: !!btn.onclick, html: btn.outerHTML.slice(0, 200) };
      }
      // 尝试完整交互：聚焦+设值+Enter
      try {
        if (inp) {
          inp.focus();
          inp.value = '你好';
          const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
          inp.dispatchEvent(ev);
          result.enterDispatched = true;
        }
      } catch (e) { result.interactError = e.message; }
      return result;
    }).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 调试：CDP 鼠标事件点击（验证按钮是否响应 mouse 事件）
  if (urlPath === '/debug-mouse') {
    const s = currentSession();
    if (!s || !s.alive || !s.cdpSession) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const params = {};
    q.split('&').forEach((kv) => {
      if (!kv) return;
      const idx = kv.indexOf('=');
      const k = idx >= 0 ? kv.slice(0, idx) : kv;
      const v = idx >= 0 ? kv.slice(idx + 1) : '';
      if (k) params[k] = decodeURIComponent(v || '');
    });
    const x = parseInt(params.x, 10) || 480;
    const y = parseInt(params.y, 10) || 133;
    const cdp = s.cdpSession;
    cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }).catch(() => {});
    cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }).catch(() => {});
    sendJson(res, 200, { ok: true, x, y });
    return;
  }
  // 调试：页面内直接点击元素（验证按钮本身是否可点）
  if (urlPath === '/debug-click') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const m = q.match(/sel=([^&]*)/);
    const sel = m ? decodeURIComponent(m[1]) : '';
    if (!sel) { sendJson(res, 400, { error: 'no sel' }); return; }
    s.page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName, cls: (el.className || '').toString().slice(0, 40) };
    }, sel).then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  // 网页输入框焦点端点
  if (urlPath === '/input-focus') {
    const q = req.url.split('?')[1] || '';
    const params = {};
    q.split('&').forEach((kv) => {
      if (!kv) return;
      const idx = kv.indexOf('=');
      const k = idx >= 0 ? kv.slice(0, idx) : kv;
      const v = idx >= 0 ? kv.slice(idx + 1) : '';
      if (k) params[k] = decodeURIComponent(v || '');
    });
    console.log(`[input-focus] type=${params.type} value=${params.value} placeholder=${params.placeholder}`);
    webInputPending = {
      active: true,
      type: params.type || 'text',
      value: params.value || '',
      placeholder: params.placeholder || '',
      updatedAt: Date.now()
    };
    sendJson(res, 200, { ok: true });
    return;
  }
  if (urlPath === '/input-blur') {
    webInputPending.active = false;
    sendJson(res, 200, { ok: true });
    return;
  }
  // 网页输入状态（miniapp 轮询：网页 input 聚焦时返回 pending）
  if (urlPath === '/input-status') {
    // 惰性超时：10 秒未更新视为焦点已失效
    if (webInputPending.active && Date.now() - webInputPending.updatedAt > 10000) {
      webInputPending.active = false;
    }
    sendJson(res, 200, {
      pending: webInputPending.active,
      type: webInputPending.type,
      value: webInputPending.value,
      placeholder: webInputPending.placeholder
    });
    return;
  }
  if (urlPath === '/input-submit') {
    const s = currentSession();
    if (!s || !s.alive || !s.cdpSession) { sendJson(res, 503, { error: 'no session' }); return; }
    const q = req.url.split('?')[1] || '';
    const m = q.match(/text=([^&]*)/);
    const text = m ? decodeURIComponent(m[1]) : '';
    if (text) {
      s.cdpSession.send('Input.insertText', { text }).catch(() => {});
    }
    // 输入完成后让输入框失焦，防止焦点轮询重新置 pending（否则会反复弹输入法）
    if (s.page && !s.page.isClosed()) {
      const doBlur = (frame) => {
        frame.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }).catch(() => {});
      };
      if (webInputPending.frameUrl) {
        // 焦点在 iframe 内 → 在对应 frame 里 blur
        const frames = s.page.frames();
        let blurred = false;
        for (const f of frames) {
          if (f.url() === webInputPending.frameUrl || f.url().includes(webInputPending.frameUrl)) {
            doBlur(f);
            blurred = true;
            break;
          }
        }
        if (!blurred) doBlur(s.page);
      } else {
        doBlur(s.page);
      }
    }
    // 输入已处理，清除焦点状态（防止重复弹输入法）
    webInputPending.active = false;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (urlPath === '/text' || urlPath === '/key') {
    const s = currentSession();
    if (!s || !s.alive || !s.page) { sendJson(res, 503, { error: 'no session' }); return; }
    const finish = (params) => {
      try {
        if (urlPath === '/text') {
          s.page.keyboard.insertText(params.text || '').then(() => sendJson(res, 200, { ok: true })).catch((e) => sendJson(res, 500, { error: e.message }));
        } else {
          s.page.keyboard.press(params.key || 'Enter').then(() => sendJson(res, 200, { ok: true })).catch((e) => sendJson(res, 500, { error: e.message }));
        }
      } catch (e) { sendJson(res, 400, { error: 'bad params' }); }
    };
    if (req.method === 'GET') {
      const q = req.url.split('?')[1] || '';
      const params = {};
      q.split('&').forEach((kv) => {
        if (!kv) return;
        const idx = kv.indexOf('=');
        const k = idx >= 0 ? kv.slice(0, idx) : kv;
        const v = idx >= 0 ? kv.slice(idx + 1) : '';
        if (k) params[k] = decodeURIComponent(v || '');
      });
      finish(params);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let params = {};
      try { params = JSON.parse(body || '{}'); } catch (e) {}
      finish(params);
    });
    return;
  }

  if (urlPath === '/' || urlPath === '/index.html') { sendFile(res, path.join(CONFIG.uiDir, 'index.html')); return; }

  // 静态文件：ui 目录下的 .html/.js/.css（校准页等）
  const staticMatch = urlPath.match(/^\/([A-Za-z0-9_\-\.]+\.(html|js|css))$/);
  if (staticMatch) {
    const file = path.join(CONFIG.uiDir, staticMatch[1]);
    if (fs.existsSync(file)) { sendFile(res, file); return; }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

httpServer.listen(CONFIG.port, async () => {
  console.log(`云浏览器 v1.1.0 启动：http://0.0.0.0:${CONFIG.port}`);
  console.log(`视口=${CONFIG.viewport.width}x${CONFIG.viewport.height} fps=${CONFIG.fps}`);

  const session = new ClientSession(0);
  sessions.set(0, session);
  activeSession = session;
  try {
    await session.start();
    console.log('[http] auto session 0 started');
  } catch (e) {
    console.error('[http] auto session 0 failed: ' + e.message);
  }
});