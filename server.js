const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let clientStatus = 'disconnected';
let lastQR = null;
let retryCount = 0;
let isSending = false;
let sendProgress = { current: 0, total: 0 };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getChromePath() {
  const paths = [
    '/run/current-system/sw/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/nix/var/nix/profiles/default/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium'
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        console.log('✅ Chrome ditemukan:', p);
        return p;
      }
    } catch (e) {}
  }
  console.log('⚠️ Pakai Chrome bawaan Puppeteer');
  return null;
}

function initClient() {
  try {
    if (client) {
      try { client.destroy(); } catch (e) {}
      client = null;
    }

    const puppeteerConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-extensions',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--window-size=1280,720',
        '--disable-features=VizDisplayCompositor'
      ]
    };

    const chromePath = getChromePath();
    if (chromePath) puppeteerConfig.executablePath = chromePath;

    client = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: puppeteerConfig,
      restartOnAuthFail: true
    });

    client.on('qr', async (qr) => {
      try {
        clientStatus = 'qr';
        lastQR = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        io.emit('qr', lastQR);
        io.emit('status', { state: 'qr', message: 'Scan QR Code dengan WhatsApp' });
        console.log('📱 QR Code siap di-scan');
      } catch (err) {
        console.error('QR error:', err.message);
      }
    });

    client.on('loading_screen', (percent, message) => {
      io.emit('loading', { percent, message });
      console.log(`Loading ${percent}%:`, message);
    });

    client.on('authenticated', () => {
      clientStatus = 'authenticated';
      lastQR = null;
      io.emit('status', { state: 'authenticated', message: 'Login berhasil, memuat...' });
      console.log('✅ Authenticated!');
    });

    client.on('ready', () => {
      clientStatus = 'ready';
      lastQR = null;
      retryCount = 0;
      io.emit('status', { state: 'ready', message: 'WhatsApp Terhubung!' });
      console.log('🚀 WhatsApp siap!');
    });

    client.on('auth_failure', () => {
      clientStatus = 'disconnected';
      lastQR = null;
      io.emit('status', { state: 'disconnected', message: 'Login gagal, mencoba ulang...' });
      console.error('❌ Auth gagal');
      setTimeout(() => initClient(), 3000);
    });

    client.on('disconnected', (reason) => {
      clientStatus = 'disconnected';
      isSending = false;
      lastQR = null;
      console.log('🔌 Disconnected:', reason);
      if (retryCount < 10) {
        retryCount++;
        const delay = Math.min(retryCount * 3000, 15000);
        io.emit('status', { state: 'disconnected', message: `Reconnect dalam ${delay/1000}s... (${retryCount}/10)` });
        setTimeout(() => initClient(), delay);
      } else {
        io.emit('status', { state: 'failed', message: 'Gagal konek. Silakan refresh halaman.' });
      }
    });

    client.initialize().catch((err) => {
      console.error('❌ Init error:', err.message);
      clientStatus = 'disconnected';
      io.emit('status', { state: 'disconnected', message: 'Error, mencoba ulang...' });
      if (retryCount < 10) {
        retryCount++;
        setTimeout(() => initClient(), 8000);
      }
    });

  } catch (err) {
    console.error('❌ Client error:', err.message);
    setTimeout(() => initClient(), 8000);
  }
}

initClient();

io.on('connection', (socket) => {
  console.log('🌐 Browser konek:', socket.id);
  socket.emit('status', {
    state: clientStatus,
    message: clientStatus === 'ready' ? 'WhatsApp Terhubung!' :
             clientStatus === 'qr' ? 'Scan QR Code' :
             clientStatus === 'authenticated' ? 'Memuat WhatsApp...' : 'Menghubungkan...'
  });
  if (clientStatus === 'qr' && lastQR) socket.emit('qr', lastQR);
  if (isSending) socket.emit('sending_state', sendProgress);
  socket.on('disconnect', () => console.log('🌐 Browser putus:', socket.id));
});

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, isSending, progress: sendProgress });
});

app.get('/api/chats', async (req, res) => {
  if (clientStatus !== 'ready')
    return res.status(400).json({ error: 'WhatsApp belum terhubung!' });
  try {
    const chats = await client.getChats();
    if (!chats || !chats.length) return res.json([]);
    const result = chats.slice(0, 60).map(c => ({
      id: c.id._serialized,
      name: c.name || c.id.user || 'Unknown',
      isGroup: c.isGroup || false,
      isChannel: c.id.server === 'newsletter',
      unreadCount: c.unreadCount || 0,
      lastMessage: c.lastMessage ? (c.lastMessage.body || '📎 Media').slice(0, 60) : '-',
      timestamp: c.timestamp || 0
    }));
    result.sort((a, b) => b.timestamp - a.timestamp);
    res.json(result);
  } catch (err) {
    console.error('Chats error:', err.message);
    res.status(500).json({ error: 'Gagal ambil chat: ' + err.message });
  }
});

app.post('/api/react', async (req, res) => {
  if (clientStatus !== 'ready')
    return res.status(400).json({ error: 'WhatsApp belum terhubung!' });
  if (isSending)
    return res.status(400).json({ error: 'Sedang mengirim, tunggu selesai!' });

  const { chatId, emoji, count } = req.body;
  const total = Math.min(parseInt(count) || 300, 1000);

  if (!chatId || !emoji)
    return res.status(400).json({ error: 'chatId dan emoji wajib!' });

  isSending = true;
  sendProgress = { current: 0, total };
  res.json({ success: true, message: `Mulai ${total} reaction ${emoji}` });

  ;(async () => {
    try {
      io.emit('reaction_start', { total, emoji });
      const chat = await client.getChatById(chatId);
      if (!chat) throw new Error('Chat tidak ditemukan!');
      const messages = await chat.fetchMessages({ limit: 10 });
      if (!messages || !messages.length) throw new Error('Tidak ada pesan!');
      const lastMsg = messages[messages.length - 1];
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < total; i++) {
        if (!isSending) { io.emit('reaction_stopped', { sent: successCount }); break; }
        if (clientStatus !== 'ready') { io.emit('reaction_error', { message: 'WhatsApp terputus!', sent: successCount }); break; }
        try {
          await lastMsg.react(emoji);
          successCount++;
          sendProgress = { current: successCount, total };
          io.emit('reaction_progress', {
            current: successCount, total, emoji,
            percent: Math.round((successCount / total) * 100)
          });
        } catch (err) {
          failCount++;
          console.error(`Reaction ${i+1} error:`, err.message);
          if (failCount > 30) {
            io.emit('reaction_error', { message: 'Terlalu banyak error, berhenti otomatis.', sent: successCount });
            break;
          }
          await sleep(1000);
        }
        await sleep(300);
      }

      if (isSending) io.emit('reaction_done', { sent: successCount, emoji });

    } catch (err) {
      console.error('React error:', err.message);
      io.emit('reaction_error', { message: err.message, sent: sendProgress.current });
    } finally {
      isSending = false;
      sendProgress = { current: 0, total: 0 };
    }
  })();
});

app.post('/api/stop', (req, res) => {
  isSending = false;
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    isSending = false;
    await client.logout();
    clientStatus = 'disconnected';
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server jalan di port ${PORT}`));
