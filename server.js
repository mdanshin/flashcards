import express from 'express';
import morgan from 'morgan';
import { OAuth2Client } from 'google-auth-library';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const DATA_DIR = path.join(__dirname, 'server-data');
const STORAGE_FILE = path.join(DATA_DIR, 'progress.json');
const MAX_HISTORY_LENGTH = 100;
const ALLOWED_HISTORY_MODES = new Set(['en-ru', 'ru-en']);

const app = express();
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
let writeQueue = Promise.resolve();

async function ensureDirectory() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStorage() {
  await writeQueue.catch(() => {});
  try {
    const raw = await fs.readFile(STORAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { users: {} };
    }
    if (!parsed.users || typeof parsed.users !== 'object') {
      parsed.users = {};
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { users: {} };
    }
    throw error;
  }
}

async function writeStorage(data) {
  writeQueue = writeQueue
    .catch((error) => {
      console.error('Previous write operation failed, continuing', error);
    })
    .then(async () => {
      await ensureDirectory();
      await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2));
    });
  return writeQueue.catch((error) => {
    console.error('Failed to write progress storage', error);
  });
}

function sanitizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeProgress(progress = {}) {
  const meta = progress.meta && typeof progress.meta === 'object' ? progress.meta : {};
  const sanitizedMeta = {
    lastReviewDay: typeof meta.lastReviewDay === 'string' ? meta.lastReviewDay : new Date().toISOString().slice(0, 10),
    reviewsToday: sanitizeNumber(meta.reviewsToday, 0),
    newToday: sanitizeNumber(meta.newToday, 0),
  };

  const sanitizedCards = Object.create(null);
  if (progress.cards && typeof progress.cards === 'object') {
    for (const [word, entry] of Object.entries(progress.cards)) {
      if (!entry || typeof entry !== 'object') continue;
      const key = String(word);
      let lastReview = null;
      if (entry.lastReview != null) {
        const value = Number(entry.lastReview);
        if (Number.isFinite(value)) {
          lastReview = value;
        }
      }
      sanitizedCards[key] = {
        ease: sanitizeNumber(entry.ease, 2.5),
        interval: Math.max(0, sanitizeNumber(entry.interval, 0)),
        repetitions: Math.max(0, sanitizeNumber(entry.repetitions, 0)),
        due: Math.max(0, sanitizeNumber(entry.due, 0)),
        lastReview,
        totalReviews: Math.max(0, sanitizeNumber(entry.totalReviews, 0)),
        lapses: Math.max(0, sanitizeNumber(entry.lapses, 0)),
        seen: Boolean(entry.seen),
      };
    }
  }

  return {
    cards: sanitizedCards,
    meta: sanitizedMeta,
  };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .slice(0, MAX_HISTORY_LENGTH)
    .map((item) => ({
      word: typeof item.word === 'string' ? item.word : '',
      mode:
        typeof item.mode === 'string' && ALLOWED_HISTORY_MODES.has(item.mode) ? item.mode : 'en-ru',
      grade: Math.max(0, Math.min(3, sanitizeNumber(item.grade, 0))),
      timestamp: sanitizeNumber(item.timestamp, Date.now()),
    }))
    .filter((item) => item.word && Number.isFinite(item.timestamp));
}

async function authenticate(req, res, next) {
  if (!oauthClient || !GOOGLE_CLIENT_ID) {
    res.status(500).json({ error: 'Сервер не настроен для проверки Google ID токенов' });
    return;
  }
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Отсутствует токен авторизации' });
    return;
  }
  const token = match[1].trim();
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      throw new Error('Google credential missing sub');
    }
    req.user = {
      sub: payload.sub,
      email: payload.email || null,
      name: payload.name || null,
    };
    next();
  } catch (error) {
    console.error('Failed to verify Google ID token', error);
    res.status(401).json({ error: 'Недействительный Google токен' });
  }
}

app.get('/api/progress', authenticate, async (req, res) => {
  const store = await readStorage();
  const entry = store.users?.[req.user.sub];
  if (!entry) {
    res.status(404).json({ error: 'Прогресс не найден' });
    return;
  }
  res.json({
    progress: sanitizeProgress(entry.progress),
    history: sanitizeHistory(entry.history),
  });
});

app.post('/api/progress', authenticate, async (req, res) => {
  const { progress, history } = req.body || {};
  const sanitizedProgress = sanitizeProgress(progress);
  const sanitizedHistory = sanitizeHistory(history);

  const store = await readStorage();
  if (!store.users || typeof store.users !== 'object') {
    store.users = {};
  }
  store.users[req.user.sub] = {
    progress: sanitizedProgress,
    history: sanitizedHistory,
    updatedAt: new Date().toISOString(),
  };
  await writeStorage(store);
  res.status(204).end();
});

app.delete('/api/progress', authenticate, async (req, res) => {
  const store = await readStorage();
  if (store.users && store.users[req.user.sub]) {
    delete store.users[req.user.sub];
    await writeStorage(store);
  }
  res.status(204).end();
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Flashcards server listening on port ${PORT}`);
});
