import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyApTqcB68Jqdm3U6K-uWz40s5pD6BuCfCU',
  authDomain: 'flashcards-706bb.firebaseapp.com',
  projectId: 'flashcards-706bb',
  storageBucket: 'flashcards-706bb.firebasestorage.app',
  messagingSenderId: '1068598237549',
  appId: '1:1068598237549:web:a83c28c29be44d18b12264',
  measurementId: 'G-8W5VMC6TZV',
};

const firebaseApp = initializeApp(firebaseConfig);
const firestore = getFirestore(firebaseApp);
const firebaseAuth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const DATA_URL = 'data/cards.json';
const STORAGE_KEY = 'oxford3000-progress-v1';
function getProgressFromLocalStorage() {
  return loadProgressFromLocalStorage();
}

// Backend for imported Anki decks (progress synced by Firebase uid).
const API_BASE = 'https://api.danshin.ms';
const OXFORD_DECK_ID = 'oxford';

let oxfordCards = [];
let importedDecks = [];
let activeDeckId = OXFORD_DECK_ID;

function isOxfordDeck() {
  return activeDeckId === OXFORD_DECK_ID;
}

function cardKey(card) {
  return card.key || card.word;
}

async function apiToken() {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('not-signed-in');
  return user.getIdToken();
}

async function apiFetch(path, options = {}) {
  const token = await apiToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `API ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function apiListDecks() {
  return apiFetch('/api/decks');
}

async function apiImportDeck(file) {
  const token = await apiToken();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/decks/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    let detail = `API ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch (err) {
      /* keep default */
    }
    throw new Error(detail);
  }
  return res.json();
}

function apiGetDeck(id) {
  return apiFetch(`/api/decks/${id}`);
}

function apiDeleteDeck(id) {
  return apiFetch(`/api/decks/${id}`, { method: 'DELETE' });
}

function apiGetDeckProgress(id) {
  return apiFetch(`/api/decks/${id}/progress`);
}

function apiPutDeckProgress(id, data) {
  return apiFetch(`/api/decks/${id}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

const SETTINGS_KEY = 'oxford3000-settings-v1';
const DEFAULT_SETTINGS = {
  dailyNewLimit: 20,
  lapseMinutes: 10,
  autoplayAudio: false,
  theme: 'system',
  preferredMode: 'en-ru',
  preferredLevel: 'all',
};

// Settings synced to the cloud alongside progress (all of them, theme included).
const SYNCED_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const GOOGLE_EVENT_NAME = 'google-identity-loaded';

const LEVEL_LABELS = [
  { value: 'all', label: 'Все уровни' },
  { value: 'A1', label: 'A1' },
  { value: 'A2', label: 'A2' },
  { value: 'B1', label: 'B1' },
  { value: 'B2', label: 'B2' },
];

const MODE_LABELS = {
  'en-ru': 'EN → RU',
  'ru-en': 'RU → EN',
};

const GRADE_LABELS = {
  0: 'Снова',
  1: 'Трудно',
  2: 'Хорошо',
  3: 'Легко',
};

const formatter = new Intl.NumberFormat('ru-RU');

let cards = [];
let filteredCards = [];
let progress = createEmptyProgress();
let settings = { ...DEFAULT_SETTINGS };

let currentUser = null;
let googleInitialized = false;
let authSettled = false;
let saveDebounceTimer = null;
let keepAuthMessage = false;
let manualGoogleButton = null;
let manualGoogleButtonVisible = false;
let googleButtonHint = '';

const state = {
  mode: 'en-ru',
  level: 'all',
  searchTerm: '',
  reviewQueue: [],
  newQueue: [],
  currentCard: null,
  currentKind: null,
  showingAnswer: false,
  history: [],
};

const elements = {};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function createEmptyProgress() {
  return {
    cards: {},
    meta: {
      lastReviewDay: getTodayKey(),
      reviewsToday: 0,
      newToday: 0,
    },
  };
}

function getProgressStorageKey() {
  const deckSuffix = isOxfordDeck() ? '' : `::deck-${activeDeckId}`;
  if (currentUser?.id) {
    return `${STORAGE_KEY}::${currentUser.id}${deckSuffix}`;
  }
  return `${STORAGE_KEY}${deckSuffix}`;
}

function isSignedIn() {
  return Boolean(currentUser?.id);
}

function loadProgressFromLocalStorage() {
  const key = getProgressStorageKey();
  const raw = localStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    const stored = JSON.parse(raw);
    if (stored.cards && stored.meta) {
      return stored;
    }
  } catch (err) {
    console.warn('Failed to parse progress, resetting', err);
  }
  return null;
}

function saveProgressToLocalStorage() {
  const key = getProgressStorageKey();
  localStorage.setItem(key, JSON.stringify(progress));
}

function ensureProgressForToday() {
  const today = getTodayKey();
  if (!progress.meta) {
    progress.meta = {
      lastReviewDay: today,
      reviewsToday: 0,
      newToday: 0,
    };
  }
  if (progress.meta.lastReviewDay !== today) {
    progress.meta.lastReviewDay = today;
    progress.meta.reviewsToday = 0;
    progress.meta.newToday = 0;
  }
  if (!progress.cards || typeof progress.cards !== 'object') {
    progress.cards = {};
  }
}

async function loadProgress() {
  const fallbackProgress = (() => {
    try {
      return JSON.parse(JSON.stringify(progress));
    } catch (error) {
      return createEmptyProgress();
    }
  })();
  const fallbackHistory = Array.isArray(state.history) ? [...state.history] : [];
  const storedProgress = loadProgressFromLocalStorage();

  progress = createEmptyProgress();
  state.history = [];

  if (!isOxfordDeck()) {
    // Imported decks live on our API, cached locally.
    progress = storedProgress?.cards ? storedProgress : createEmptyProgress();
    if (isSignedIn()) {
      try {
        const data = await apiGetDeckProgress(activeDeckId);
        if (data?.progress?.cards && data?.progress?.meta) {
          progress = data.progress;
          state.history = Array.isArray(data.history) ? data.history.slice(0, 100) : [];
          saveProgressToLocalStorage();
        }
        showAuthMessage('');
      } catch (error) {
        console.error('Failed to load deck progress', error);
        showAuthMessage('Не удалось загрузить прогресс колоды из облака');
      }
    }
    ensureProgressForToday();
    state.history = state.history.slice(0, 12);
    renderHistory();
    return;
  }

  if (isSignedIn()) {
    try {
      const docRef = doc(firestore, 'progress', currentUser.id);
      const snapshot = await getDoc(docRef);

      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data?.progress?.cards && data?.progress?.meta) {
          progress = data.progress;
        } else {
          const fallback = storedProgress || fallbackProgress;
          progress = fallback?.cards ? fallback : createEmptyProgress();
        }
        if (Array.isArray(data?.history)) {
          state.history = data.history.slice(0, 100);
        }
        applyCloudSettings(data?.settings);
        saveProgressToLocalStorage();
        showAuthMessage('');
      } else {
        // First sign-in with no cloud document yet — a normal empty state,
        // not an error. Progress will sync to the cloud on the first answer.
        const fallback = storedProgress || fallbackProgress;
        progress = fallback?.cards ? fallback : createEmptyProgress();
        state.history = fallbackHistory;
        showAuthMessage('');
      }
    } catch (error) {
      console.error('Failed to load progress from Firebase', error);
      const fallback = storedProgress || fallbackProgress;
      progress = fallback?.cards ? fallback : createEmptyProgress();
      state.history = fallbackHistory;
      if (isSignedIn()) {
        showAuthMessage('Не удалось загрузить прогресс из облака, данные использованы из локального хранилища');
      } else {
        if (!keepAuthMessage) {
          showAuthMessage('');
        }
      }
    }
  } else {
    const fallback = storedProgress;
    progress = fallback?.cards ? fallback : createEmptyProgress();
    state.history = fallbackHistory;
    if (!keepAuthMessage) {
      showAuthMessage('');
    }
  }

  ensureProgressForToday();
  state.history = state.history.slice(0, 12);
  renderHistory();
}

async function persistProgress() {
  if (!isOxfordDeck()) {
    saveProgressToLocalStorage();
    if (isSignedIn()) {
      try {
        await apiPutDeckProgress(activeDeckId, {
          progress,
          history: state.history.slice(0, 100),
        });
        showAuthMessage('');
      } catch (error) {
        console.error('Failed to save deck progress', error);
        showAuthMessage('Не удалось синхронизировать прогресс колоды с облаком');
      }
    }
    return;
  }

  if (isSignedIn()) {
    try {
      const docRef = doc(firestore, 'progress', currentUser.id);
      await setDoc(docRef, {
        progress,
        history: state.history.slice(0, 100),
        settings: getSyncableSettings(),
        updatedAt: serverTimestamp(),
      });
      saveProgressToLocalStorage();
      showAuthMessage('');
      return;
    } catch (error) {
      console.error('Failed to save progress to Firebase', error);
      saveProgressToLocalStorage();
      if (isSignedIn()) {
        showAuthMessage('Не удалось синхронизировать прогресс с облаком, данные сохранены локально');
      }
      throw error;
    }
  } else {
    saveProgressToLocalStorage();
  }
}

function saveProgress(options = {}) {
  const { immediate = false } = options;
  if (immediate) {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
    }
    return persistProgress();
  }

  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    persistProgress().catch((error) => console.error('Delayed save failed', error));
  }, 400);

  return Promise.resolve();
}

function validateSettings() {
  const availableModes = Object.keys(MODE_LABELS);
  if (!availableModes.includes(settings.preferredMode)) {
    settings.preferredMode = DEFAULT_SETTINGS.preferredMode;
  }
  const availableLevels = LEVEL_LABELS.map((item) => item.value);
  if (!availableLevels.includes(settings.preferredLevel)) {
    settings.preferredLevel = DEFAULT_SETTINGS.preferredLevel;
  }
  state.mode = settings.preferredMode;
  state.level = settings.preferredLevel;
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      const stored = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (err) {
      console.warn('Failed to parse settings, using defaults', err);
    }
  }
  validateSettings();
}

function persistSettingsLocal() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getSyncableSettings() {
  const subset = {};
  for (const key of SYNCED_SETTING_KEYS) {
    if (settings[key] !== undefined) subset[key] = settings[key];
  }
  return subset;
}

function saveSettings() {
  persistSettingsLocal();
  // When signed in, fold settings into the same debounced cloud write as
  // progress so they follow the user across devices.
  if (isSignedIn()) {
    saveProgress();
  }
}

// Merge settings pulled from the cloud into the local ones and reflect them in
// the UI. Writes only to localStorage (not back to the cloud) to avoid a loop.
function applyCloudSettings(cloudSettings) {
  if (!cloudSettings || typeof cloudSettings !== 'object') return;
  let changed = false;
  for (const key of SYNCED_SETTING_KEYS) {
    if (cloudSettings[key] !== undefined && cloudSettings[key] !== settings[key]) {
      settings[key] = cloudSettings[key];
      changed = true;
    }
  }
  if (!changed) return;
  validateSettings();
  persistSettingsLocal();
  applySettingsToUI();
}

function applySettingsToUI() {
  const form = document.getElementById('settings-form');
  if (form) {
    if (form.dailyNewLimit) form.dailyNewLimit.value = settings.dailyNewLimit;
    if (form.lapseMinutes) form.lapseMinutes.value = settings.lapseMinutes;
    if (form.autoplayAudio) form.autoplayAudio.checked = settings.autoplayAudio;
    if (form.theme) form.theme.value = settings.theme;
  }
  if (elements.levelSelect) elements.levelSelect.value = state.level;
  if (Array.isArray(elements.modeButtons)) {
    elements.modeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === state.mode);
    });
  }
  applyTheme(settings.theme);
}

function showAuthMessage(message) {
  if (!elements.authMessage) return;
  keepAuthMessage = Boolean(message);
  if (!message) {
    elements.authMessage.textContent = '';
    elements.authMessage.classList.add('hidden');
    return;
  }
  elements.authMessage.textContent = message;
  elements.authMessage.classList.remove('hidden');
}

async function handleManualGoogleSignIn() {
  if (!firebaseAuth) return;
  showAuthMessage('');
  try {
    await signInWithPopup(firebaseAuth, googleProvider);
  } catch (error) {
    console.error('Failed to sign in with Google popup', error);
    showAuthMessage('Не удалось войти через Google, попробуйте снова');
  }
}

function setManualGoogleButtonVisibility(visible) {
  manualGoogleButtonVisible = Boolean(visible);
  if (manualGoogleButton) {
    const hideManualButton = !manualGoogleButtonVisible && Boolean(window.google?.accounts?.id);
    manualGoogleButton.classList.toggle('hidden', hideManualButton);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
  }
  if (googleInitialized) {
    renderGoogleButton();
    updateAuthUI();
  }
}

function matchesLevel(card, level) {
  if (level === 'all') return true;
  return (card.level || '').toUpperCase() === level.toUpperCase();
}

function buildQueues() {
  const now = Date.now();
  // The CEFR level filter only applies to the Oxford deck.
  filteredCards = isOxfordDeck()
    ? cards.filter((card) => matchesLevel(card, state.level))
    : cards.slice();
  const review = [];
  const fresh = [];

  for (const card of filteredCards) {
    const entry = progress.cards[cardKey(card)];
    if (!entry) {
      fresh.push(card);
      continue;
    }
    if (entry.due && entry.due <= now) {
      review.push(card);
    } else if (!entry.due) {
      fresh.push(card);
    }
  }

  review.sort((a, b) => {
    const dueA = progress.cards[cardKey(a)]?.due ?? 0;
    const dueB = progress.cards[cardKey(b)]?.due ?? 0;
    return dueA - dueB;
  });

  const remainingNew = Math.max(0, settings.dailyNewLimit - progress.meta.newToday);
  const newQueue = [];
  for (const card of fresh) {
    if (newQueue.length >= remainingNew) break;
    newQueue.push(card);
  }

  state.reviewQueue = review;
  state.newQueue = newQueue;
  updateStats();
}

function updateStats() {
  const dueCount = state.reviewQueue.length;
  const newRemaining = Math.max(0, settings.dailyNewLimit - progress.meta.newToday);
  const learnt = progress.meta.reviewsToday;
  elements.statsDue.textContent = formatter.format(dueCount);
  elements.statsNew.textContent = formatter.format(newRemaining);
  elements.statsStudied.textContent = formatter.format(learnt);
  elements.statsTotal.textContent = formatter.format(cards.length);
  const nextDue = state.reviewQueue.length
    ? progress.cards[cardKey(state.reviewQueue[0])]?.due
    : null;
  elements.nextDue.textContent = nextDue ? new Date(nextDue).toLocaleString('ru-RU') : '—';

  updateDailyLedger(newRemaining, learnt);
}

function updateDailyLedger(newRemaining, reviewsToday) {
  if (!elements.dailyBar || !elements.dailyLabel) return;
  const limit = Math.max(1, settings.dailyNewLimit);
  const introduced = Math.min(limit, limit - newRemaining);
  const percent = Math.round((introduced / limit) * 100);
  elements.dailyBar.style.width = `${percent}%`;
  const track = elements.dailyBar.parentElement;
  if (track) {
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(limit));
    track.setAttribute('aria-valuenow', String(introduced));
  }
  const reviewsWord = pluralizeReviews(reviewsToday);
  elements.dailyLabel.textContent =
    `${introduced} из ${limit} новых слов · ${reviewsToday} ${reviewsWord} за день`;
}

function pluralizeReviews(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'повторение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'повторения';
  return 'повторений';
}

function pickNextCard() {
  if (state.reviewQueue.length) {
    const card = state.reviewQueue.shift();
    state.currentCard = card;
    state.currentKind = 'review';
    return card;
  }
  if (state.newQueue.length) {
    const card = state.newQueue.shift();
    state.currentCard = card;
    state.currentKind = 'new';
    return card;
  }
  state.currentCard = null;
  state.currentKind = null;
  return null;
}

// Mueller entries look like "1. v. 1) покидать 2) … 2. n. …": "1." / "2." mark
// part-of-speech groups, "1)" / "2)" mark senses inside them, and each sense
// mixes the Russian gloss with English examples. Turn that into a clean list of
// Russian glosses.
function cleanGloss(chunk) {
  let c = (chunk || '').trim();
  let prev = null;
  // Peel off leading abbreviations/labels ending in a dot (v. n. adv. книж. p-p.)
  // and leading form notes in parentheses (e.g. "(began - begun)").
  while (c && c !== prev) {
    prev = c;
    c = c.replace(/^[a-zа-яё-]{1,6}\.\s+/i, '');
    c = c.replace(/^\([^)]*\)\s*/, '');
  }
  // The Russian gloss starts at the first Cyrillic character.
  const cyr = c.match(/[а-яё]/i);
  if (!cyr) return '';
  c = c.slice(cyr.index);
  // Drop the trailing English example, keeping just the Russian gloss.
  const latin = c.match(/[A-Za-z]{2,}/);
  if (latin) c = c.slice(0, latin.index);
  c = c.replace(/^[\s;,.–-]+|[\s;,.–-]+$/g, '');
  // Skip stray single letters left over from OCR noise.
  return c.length >= 2 ? c : '';
}

function parseSenses(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s*\b\d+[.)]\s*/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const gloss = cleanGloss(part);
    if (!gloss || !/[а-яё]/i.test(gloss)) continue;
    const key = gloss.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gloss);
  }
  return out.length ? out : [trimmed];
}

function renderCard() {
  const card = state.currentCard;
  const front = elements.cardFront;
  const back = elements.cardBack;
  const frontTitle = elements.frontTitle;
  const frontMeta = elements.frontMeta;
  const backTitle = elements.backTitle;
  const translationList = elements.translationList;
  const sources = elements.sourceLinks;
  const metaBadges = elements.metaBadges;
  const audioControls = elements.audioControls;

  if (!card) {
    frontTitle.textContent = 'Колода разобрана';
    frontMeta.textContent = '';
    if (metaBadges) metaBadges.innerHTML = '';
    if (elements.cardMessage) {
      elements.cardMessage.textContent =
        'Все запланированные на сегодня карточки пройдены. Возвращайтесь завтра или увеличьте лимит новых слов в настройках.';
    }
    backTitle.textContent = '';
    translationList.innerHTML = '';
    sources.innerHTML = '';
    audioControls.innerHTML = '';
    elements.showAnswer.classList.add('hidden');
    elements.actionsContainer.classList.add('disabled');
    elements.actionsContainer.classList.add('hidden');
    back.classList.add('hidden');
    return;
  }

  if (elements.cardMessage && elements.defaultCardMessage != null) {
    elements.cardMessage.innerHTML = elements.defaultCardMessage;
  }

  if (elements.card) elements.card.classList.toggle('imported', Boolean(card.imported));

  elements.showAnswer.classList.toggle('hidden', state.showingAnswer);
  elements.actionsContainer.classList.toggle('hidden', !state.showingAnswer);
  elements.actionsContainer.classList.toggle('disabled', !state.showingAnswer);

  // Study status — the same for any deck.
  const entry = progress.cards[cardKey(card)];
  if (!entry || !entry.seen) {
    frontMeta.textContent = 'Новая';
  } else if (entry.state === 'learning' || entry.state === 'relearning') {
    frontMeta.textContent = 'Учу';
  } else {
    frontMeta.textContent = 'Повтор';
  }

  metaBadges.innerHTML = '';
  translationList.innerHTML = '';
  sources.innerHTML = '';

  if (card.imported) {
    // Generic front/back card from an imported Anki deck.
    frontTitle.textContent = card.word;
    backTitle.textContent = card.translation;
    translationList.classList.add('single');
  } else {
    const level = card.level ? card.level.toUpperCase() : null;
    const parts = (card.pos || []).join(', ');
    if (state.mode === 'en-ru') {
      frontTitle.textContent = card.word;
    } else {
      const senses = parseSenses(card.translation);
      frontTitle.textContent = senses[0] || card.translation;
    }
    if (level) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = level;
      metaBadges.appendChild(badge);
    }
    if (parts) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = parts;
      metaBadges.appendChild(badge);
    }
    // The back is the full dictionary entry for the English lemma.
    backTitle.textContent = card.word;
    const segments = parseSenses(card.translation);
    translationList.classList.toggle('single', segments.length <= 1);
    segments.forEach((segment) => {
      const li = document.createElement('li');
      li.textContent = segment;
      translationList.appendChild(li);
    });
    if (card.oxford_urls && card.oxford_urls.length) {
      card.oxford_urls.slice(0, 2).forEach((url) => {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Oxford';
        sources.appendChild(link);
      });
    }
  }

  audioControls.innerHTML = '';
  if (card.audio && (card.audio.uk || card.audio.us)) {
    ['uk', 'us'].forEach((variant) => {
      const src = card.audio[variant];
      if (!src) return;
      const button = document.createElement('button');
      button.className = 'audio-button';
      button.dataset.audio = src;
      button.innerHTML = `${variant.toUpperCase()} ▸`;
      button.addEventListener('click', () => playAudio(src));
      audioControls.appendChild(button);
    });
  }

  if (state.showingAnswer) {
    back.classList.remove('hidden');
  } else {
    back.classList.add('hidden');
  }
}

function playAudio(src) {
  const audio = new Audio(src);
  audio.play().catch((err) => console.warn('Audio playback error', err));
}

function revealAnswer() {
  if (!state.currentCard) return;
  state.showingAnswer = true;
  renderCard();
  if (settings.autoplayAudio && state.mode === 'en-ru') {
    const src = state.currentCard.audio?.uk || state.currentCard.audio?.us;
    if (src) playAudio(src);
  }
}

function ensureCardSelected() {
  if (!state.currentCard) {
    pickNextCard();
    state.showingAnswer = false;
    renderCard();
  }
}

// --- Anki-style scheduler ----------------------------------------------------
// Cards move through states new → learning → review, dropping to relearning on a
// lapse. Learning/relearning use short minute-steps; review uses day-intervals
// scaled by the card's ease. Grades: 0 Again, 1 Hard, 2 Good, 3 Easy.
const SRS = {
  learningSteps: [1, 10], // minutes, for brand-new cards
  graduatingInterval: 1, // days, when a card leaves learning on "Good"
  easyInterval: 4, // days, when it leaves learning on "Easy"
  startingEase: 2.5,
  easyBonus: 1.3,
  hardFactor: 1.2,
  intervalModifier: 1.0,
  lapseIntervalPct: 0, // fraction of the old interval kept after a lapse
  minInterval: 1, // days
  maxInterval: 36500, // days
};

const MS_MIN = 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

let learningTimer = null;

function relearnSteps() {
  return [Math.max(1, settings.lapseMinutes || 10)];
}

function fuzzedInterval(intervalDays) {
  let value = intervalDays;
  if (value >= 2.5) {
    const spread = Math.max(1, value * 0.05);
    value += (Math.random() * 2 - 1) * spread;
  }
  return Math.min(SRS.maxInterval, Math.max(SRS.minInterval, Math.round(value)));
}

function createEntry(now) {
  return {
    state: 'learning',
    step: 0,
    ease: SRS.startingEase,
    interval: 0,
    due: now,
    lastReview: null,
    totalReviews: 0,
    lapses: 0,
    seen: false,
  };
}

// Fill defaults and migrate entries saved by the old SM-2 model (no `state`).
function normalizeEntry(entry, now) {
  if (!entry) return createEntry(now);
  if (!entry.state) {
    entry.state = entry.interval && entry.interval >= 1 ? 'review' : 'learning';
    entry.step = 0;
  }
  if (typeof entry.ease !== 'number') entry.ease = SRS.startingEase;
  if (typeof entry.interval !== 'number') entry.interval = 0;
  if (typeof entry.step !== 'number') entry.step = 0;
  return entry;
}

function graduateEntry(entry, now, easy, fromRelearn) {
  entry.state = 'review';
  entry.step = 0;
  if (fromRelearn) {
    entry.interval = Math.max(SRS.minInterval, Math.round(entry.interval || SRS.minInterval));
  } else {
    entry.interval = easy ? SRS.easyInterval : SRS.graduatingInterval;
  }
  entry.due = now + entry.interval * MS_DAY;
}

function scheduleLearn(entry, grade, now, steps, fromRelearn) {
  if (grade === 0) {
    entry.step = 0;
    entry.due = now + steps[0] * MS_MIN;
  } else if (grade === 3) {
    graduateEntry(entry, now, true, fromRelearn);
  } else if (grade === 1) {
    const s = Math.min(entry.step, steps.length - 1);
    entry.due = now + steps[s] * MS_MIN;
  } else {
    const next = entry.step + 1;
    if (next >= steps.length) {
      graduateEntry(entry, now, false, fromRelearn);
    } else {
      entry.step = next;
      entry.due = now + steps[next] * MS_MIN;
    }
  }
}

function scheduleReview(entry, grade, now) {
  const ease = entry.ease || SRS.startingEase;
  if (grade === 0) {
    entry.lapses = (entry.lapses || 0) + 1;
    entry.ease = Math.max(1.3, ease - 0.2);
    entry.interval = Math.max(SRS.minInterval, Math.round(entry.interval * SRS.lapseIntervalPct));
    entry.state = 'relearning';
    entry.step = 0;
    entry.due = now + relearnSteps()[0] * MS_MIN;
    return;
  }
  let interval;
  if (grade === 1) {
    entry.ease = Math.max(1.3, ease - 0.15);
    interval = entry.interval * SRS.hardFactor * SRS.intervalModifier;
  } else if (grade === 2) {
    interval = entry.interval * ease * SRS.intervalModifier;
  } else {
    entry.ease = ease + 0.15;
    interval = entry.interval * ease * SRS.intervalModifier * SRS.easyBonus;
  }
  interval = Math.max(entry.interval + 1, interval); // never shrink a review
  entry.interval = fuzzedInterval(interval);
  entry.due = now + entry.interval * MS_DAY;
}

function applyGrade(entry, grade, now) {
  if (entry.state === 'review') {
    scheduleReview(entry, grade, now);
  } else if (entry.state === 'relearning') {
    scheduleLearn(entry, grade, now, relearnSteps(), true);
  } else {
    scheduleLearn(entry, grade, now, SRS.learningSteps, false);
  }
}

// When only near-future learning cards remain, wake up and show them.
function scheduleLearningWakeup() {
  if (learningTimer) {
    clearTimeout(learningTimer);
    learningTimer = null;
  }
  const now = Date.now();
  let soonest = Infinity;
  for (const card of filteredCards) {
    const entry = progress.cards[cardKey(card)];
    if (entry && entry.due > now && (entry.state === 'learning' || entry.state === 'relearning')) {
      if (entry.due < soonest) soonest = entry.due;
    }
  }
  if (soonest === Infinity || soonest - now > 20 * MS_MIN) return null;
  learningTimer = setTimeout(() => {
    learningTimer = null;
    if (!state.currentCard) {
      buildQueues();
      showNextCard();
    }
  }, soonest - now + 250);
  return soonest;
}

function pluralizeMinutes(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'минуту';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'минуты';
  return 'минут';
}

function gradeCard(grade) {
  if (state.currentCard == null) return;
  const card = state.currentCard;
  const now = Date.now();
  const today = getTodayKey();
  const entry = normalizeEntry(progress.cards[cardKey(card)], now);

  if (progress.meta.lastReviewDay !== today) {
    progress.meta.lastReviewDay = today;
    progress.meta.reviewsToday = 0;
    progress.meta.newToday = 0;
  }

  if (!entry.seen) {
    entry.seen = true;
    progress.meta.newToday = Math.min(settings.dailyNewLimit, progress.meta.newToday + 1);
  }

  progress.meta.reviewsToday += 1;
  entry.totalReviews = (entry.totalReviews || 0) + 1;

  applyGrade(entry, grade, now);

  entry.lastReview = now;
  progress.cards[cardKey(card)] = entry;
  saveProgress();

  state.history.unshift({
    word: card.word,
    mode: state.mode,
    grade,
    timestamp: now,
  });
  state.history = state.history.slice(0, 12);
  renderHistory();

  state.currentCard = null;
  state.currentKind = null;
  state.showingAnswer = false;
  buildQueues();
  showNextCard();
}

function renderHistory() {
  elements.history.innerHTML = '';
  state.history.forEach((item) => {
    const li = document.createElement('li');
    const when = new Date(item.timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    li.innerHTML = `<span class="history-word">${item.word}</span><span class="history-grade grade-${item.grade}">${GRADE_LABELS[item.grade]}</span><span class="history-time">${when}</span>`;
    elements.history.appendChild(li);
  });
}

function showNextCard() {
  if (learningTimer) {
    clearTimeout(learningTimer);
    learningTimer = null;
  }
  pickNextCard();
  state.showingAnswer = false;
  renderCard();
  if (!state.currentCard) {
    const soonest = scheduleLearningWakeup();
    if (soonest && elements.frontTitle && elements.cardMessage) {
      const mins = Math.max(1, Math.round((soonest - Date.now()) / MS_MIN));
      elements.frontTitle.textContent = 'Небольшой перерыв';
      elements.cardMessage.textContent =
        `Следующая карточка примерно через ${mins} ${pluralizeMinutes(mins)} — она появится сама.`;
    }
  }
}

function handleModeChange(mode) {
  state.mode = mode;
  elements.modeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  if (settings.preferredMode !== mode) {
    settings.preferredMode = mode;
    saveSettings();
  }
  renderCard();
}

function handleLevelChange(event) {
  state.level = event.target.value;
  if (settings.preferredLevel !== state.level) {
    settings.preferredLevel = state.level;
    saveSettings();
  }
  buildQueues();
  showNextCard();
}

function handleSearch(event) {
  const term = event.target.value.trim().toLowerCase();
  state.searchTerm = term;
  elements.searchResults.innerHTML = '';
  if (!term) return;
  // Rank word matches above translation-only matches, exact/prefix first, so a
  // query like "time" surfaces the word itself before phrases that mention it.
  const scored = [];
  for (const card of cards) {
    const word = card.word.toLowerCase();
    const inWord = word.includes(term);
    const inTranslation = card.translation.toLowerCase().includes(term);
    if (!inWord && !inTranslation) continue;
    let score = 3;
    if (word === term) score = 0;
    else if (word.startsWith(term)) score = 1;
    else if (inWord) score = 2;
    scored.push({ card, score });
  }
  scored.sort((a, b) => a.score - b.score || a.card.word.localeCompare(b.card.word));
  const matches = scored.slice(0, 20).map((item) => item.card);
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Ничего не найдено';
    elements.searchResults.appendChild(empty);
    return;
  }
  matches.forEach((card) => {
    const button = document.createElement('button');
    button.className = 'search-result';
    const preview = parseSenses(card.translation)[0] || card.translation;
    button.innerHTML = `<strong>${card.word}</strong><span>${preview}</span>`;
    button.addEventListener('click', () => {
      state.currentCard = card;
      state.currentKind = progress.cards[cardKey(card)] ? 'review' : 'new';
      state.showingAnswer = false;
      renderCard();
      elements.searchResults.innerHTML = '';
      elements.searchInput.value = '';
      closeDrawers();
    });
    elements.searchResults.appendChild(button);
  });
}

function handleSettingsChange(event) {
  const { name, type, value, checked } = event.target;
  if (!(name in settings)) return;
  if (type === 'checkbox') {
    settings[name] = checked;
  } else if (type === 'number') {
    settings[name] = Number(value);
  } else if (type === 'select-one') {
    settings[name] = value;
    if (name === 'theme') {
      applyTheme(settings.theme);
    }
  }
  saveSettings();
  if (name === 'dailyNewLimit') {
    buildQueues();
    showNextCard();
  }
}

async function resetProgress() {
  if (!confirm('Удалить прогресс и начать заново?')) return;

  try {
    localStorage.removeItem(getProgressStorageKey());
    // Only the Oxford deck lives in Firestore; imported decks are reset by
    // writing an empty progress blob back through the API (saveProgress below).
    if (isOxfordDeck() && isSignedIn()) {
      await deleteDoc(doc(firestore, 'progress', currentUser.id));
    }
    showAuthMessage('');
  } catch (error) {
    console.error('Failed to reset progress', error);
    showAuthMessage('Не удалось очистить данные в облаке');
  }

  progress = createEmptyProgress();
  state.history = [];
  renderHistory();
  saveProgress({ immediate: true }).catch((error) => console.error('Failed to persist reset', error));
  buildQueues();
  showNextCard();
}

function getGoogleClientId() {
  const meta = document.querySelector('meta[name="google-signin-client-id"]');
  const value = meta?.content?.trim();
  return value || null;
}

function updateAuthUI() {
  if (!elements.authSignedIn || !elements.authSignedOut) return;
  const signedIn = isSignedIn();
  elements.authSignedIn.classList.toggle('hidden', !signedIn);
  elements.authSignedOut.classList.toggle('hidden', signedIn);
  if (signedIn) {
    const displayName = currentUser.name || currentUser.email || 'Пользователь';
    if (elements.authName) {
      elements.authName.textContent = displayName;
    }
    if (elements.authAvatar) {
      if (currentUser.picture) {
        elements.authAvatar.src = currentUser.picture;
        elements.authAvatar.classList.remove('hidden');
      } else {
        elements.authAvatar.removeAttribute('src');
        elements.authAvatar.classList.add('hidden');
      }
    }
  } else {
    if (elements.authName) {
      elements.authName.textContent = '';
    }
    if (elements.authAvatar) {
      elements.authAvatar.removeAttribute('src');
      elements.authAvatar.classList.add('hidden');
    }
  }
}

// Show the Google One Tap prompt only once Firebase has confirmed the user is
// genuinely signed out — otherwise it flashes on every reload while the
// persisted session is still being restored.
function maybePromptOneTap() {
  if (!authSettled || isSignedIn()) return;
  if (googleInitialized && window.google?.accounts?.id) {
    window.google.accounts.id.prompt();
  }
}

async function handleUserChange() {
  // Imported decks belong to a signed-in user; drop back to Oxford on sign-out.
  if (!isSignedIn() && !isOxfordDeck()) {
    activeDeckId = OXFORD_DECK_ID;
    cards = oxfordCards;
    updateDeckUI();
  }
  await loadProgress();
  if (cards.length) {
    buildQueues();
    showNextCard();
  }
  loadImportedDecks().catch((error) => console.error('Failed to list decks', error));
}

function setCurrentUser(user, { forceReload = false } = {}) {
  const previousId = currentUser?.id || null;
  currentUser = user
    ? {
        id: user.id,
        name: user.name || null,
        email: user.email || null,
        picture: user.picture || null,
      }
    : null;

  updateAuthUI();
  const nextId = currentUser?.id || null;
  if (previousId !== nextId || forceReload) {
    handleUserChange().catch((error) => console.error('Failed to refresh user state', error));
  }
}

async function handleCredentialResponse(response) {
  if (!response?.credential || !firebaseAuth) return;
  try {
    const credential = GoogleAuthProvider.credential(response.credential);
    await signInWithCredential(firebaseAuth, credential);
  } catch (error) {
    console.error('Failed to authenticate with Google credential', error);
    setManualGoogleButtonVisibility(true);
    renderGoogleButton();
    showAuthMessage('Не удалось войти через Google, попробуйте снова');
  }
}

const GOOGLE_G_SVG =
  '<svg class="g-logo" viewBox="0 0 18 18" aria-hidden="true">' +
  '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>' +
  '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/>' +
  '<path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"/>' +
  '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>' +
  '</svg>';

// A custom sign-in button styled to match the top bar, instead of Google's
// rendered widget (which ignores our palette and reads white on dark). It uses
// the same signInWithPopup flow; One Tap still runs separately.
function renderGoogleButton() {
  if (!elements.authSignedOut) return;
  const container = elements.authSignedOut;
  container.innerHTML = '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'google-btn';
  button.innerHTML = `${GOOGLE_G_SVG}<span>Войти через Google</span>`;
  button.addEventListener('click', handleManualGoogleSignIn);
  container.appendChild(button);

  if (googleButtonHint) {
    const hint = document.createElement('span');
    hint.className = 'auth-hint';
    hint.textContent = googleButtonHint;
    container.appendChild(hint);
  }
}

function setupGoogleSignIn() {
  const clientId = getGoogleClientId();
  if (!elements.authSignedOut) return;
  if (!clientId) {
    googleButtonHint = 'Добавьте Google Client ID в index.html, чтобы включить вход через Google';
    setManualGoogleButtonVisibility(true);
    renderGoogleButton();
    return;
  }
  googleButtonHint = '';
  if (!window.google?.accounts?.id) {
    setManualGoogleButtonVisibility(false);
    renderGoogleButton();
    return;
  }

  if (!googleInitialized) {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    googleInitialized = true;
  }

  renderGoogleButton();
  updateAuthUI();
  maybePromptOneTap();
}

async function signOut() {
  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
  try {
    await firebaseSignOut(firebaseAuth);
  } catch (error) {
    console.warn('Failed to sign out from Firebase', error);
  }
  setCurrentUser(null, { forceReload: true });
}

async function initAuth() {
  onAuthStateChanged(firebaseAuth, (user) => {
    authSettled = true;
    if (user) {
      setCurrentUser({
        id: user.uid,
        name: user.displayName || user.email || 'Пользователь',
        email: user.email || null,
        picture: user.photoURL || null,
      });
    } else {
      setCurrentUser(null);
      maybePromptOneTap();
    }
  });

  await loadProgress();
  updateAuthUI();

  const clientId = getGoogleClientId();
  if (clientId) {
    window.addEventListener(GOOGLE_EVENT_NAME, setupGoogleSignIn, { once: false });
  }
  setupGoogleSignIn();
}

function openDrawer(id, focusSelector) {
  closeDrawers();
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  if (elements.scrim) elements.scrim.classList.add('open');
  document.body.classList.add('drawer-open');
  if (focusSelector) {
    const target = drawer.querySelector(focusSelector);
    if (target) window.requestAnimationFrame(() => target.focus());
  }
}

function closeDrawers() {
  document.querySelectorAll('.drawer.open').forEach((drawer) => {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  });
  if (elements.scrim) elements.scrim.classList.remove('open');
  document.body.classList.remove('drawer-open');
}

function setupDrawers() {
  if (elements.openSettings) {
    elements.openSettings.addEventListener('click', () => openDrawer('settings-drawer'));
  }
  if (elements.openSearch) {
    elements.openSearch.addEventListener('click', () => openDrawer('search-drawer', '#search-input'));
  }
  document.querySelectorAll('[data-close-drawer]').forEach((button) => {
    button.addEventListener('click', closeDrawers);
  });
  if (elements.scrim) {
    elements.scrim.addEventListener('click', closeDrawers);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawers();
  });
}

function initUI() {
  elements.modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  elements.levelSelect = document.getElementById('level-filter');
  elements.showAnswer = document.getElementById('show-answer');
  elements.actionsContainer = document.getElementById('answer-actions');
  elements.card = document.getElementById('card');
  elements.cardFront = document.getElementById('card-front');
  elements.cardBack = document.getElementById('card-back');
  elements.frontTitle = document.getElementById('front-title');
  elements.frontMeta = document.getElementById('front-meta');
  elements.backTitle = document.getElementById('back-title');
  elements.translationList = document.getElementById('translation-list');
  elements.sourceLinks = document.getElementById('sources');
  elements.audioControls = document.getElementById('audio-controls');
  elements.metaBadges = document.getElementById('meta-badges');
  elements.cardMessage = document.querySelector('#card-front .card-message');
  if (elements.cardMessage) {
    elements.defaultCardMessage = elements.cardMessage.innerHTML;
  }
  elements.statsDue = document.getElementById('stats-due');
  elements.statsNew = document.getElementById('stats-new');
  elements.statsStudied = document.getElementById('stats-studied');
  elements.statsTotal = document.getElementById('stats-total');
  elements.nextDue = document.getElementById('next-due');
  elements.dailyBar = document.getElementById('daily-progress-bar');
  elements.dailyLabel = document.getElementById('daily-progress-label');
  elements.history = document.getElementById('session-history');
  elements.searchInput = document.getElementById('search-input');
  elements.searchResults = document.getElementById('search-results');
  elements.resetButton = document.getElementById('reset-progress');
  elements.scrim = document.getElementById('scrim');
  elements.openSettings = document.getElementById('open-settings');
  elements.openSearch = document.getElementById('open-search');
  elements.authSignedIn = document.getElementById('auth-signed-in');
  elements.authSignedOut = document.getElementById('auth-signed-out');
  elements.authAvatar = document.getElementById('auth-avatar');
  elements.authName = document.getElementById('auth-name');
  elements.authSignOut = document.getElementById('auth-signout');
  elements.authMessage = document.getElementById('auth-message');
  elements.deckSelect = document.getElementById('deck-select');
  elements.apkgInput = document.getElementById('apkg-input');
  elements.importLabel = document.getElementById('import-label');
  elements.importStatus = document.getElementById('import-status');
  elements.deleteDeck = document.getElementById('delete-deck');
  elements.decksHint = document.getElementById('decks-hint');
  elements.sectionDirection = document.getElementById('section-direction');
  elements.sectionLevel = document.getElementById('section-level');

  const settingsForm = document.getElementById('settings-form');
  settingsForm.dailyNewLimit.value = settings.dailyNewLimit;
  settingsForm.lapseMinutes.value = settings.lapseMinutes;
  settingsForm.autoplayAudio.checked = settings.autoplayAudio;
  settingsForm.theme.value = settings.theme;

  elements.modeButtons.forEach((button) => {
    button.addEventListener('click', () => handleModeChange(button.dataset.mode));
  });

  LEVEL_LABELS.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    elements.levelSelect.appendChild(option);
  });
  elements.levelSelect.value = state.level;
  elements.levelSelect.addEventListener('change', handleLevelChange);

  elements.showAnswer.addEventListener('click', () => {
    revealAnswer();
  });

  elements.actionsContainer.querySelectorAll('button[data-grade]').forEach((button) => {
    button.addEventListener('click', () => gradeCard(Number(button.dataset.grade)));
  });

  elements.searchInput.addEventListener('input', handleSearch);
  setupDrawers();
  if (elements.deckSelect) elements.deckSelect.addEventListener('change', handleDeckSelect);
  if (elements.apkgInput) elements.apkgInput.addEventListener('change', handleImportApkg);
  if (elements.deleteDeck) {
    elements.deleteDeck.addEventListener('click', () => {
      deleteActiveDeck().catch((error) => console.error('Failed to delete deck', error));
    });
  }
  renderDeckOptions();
  elements.resetButton.addEventListener('click', () => {
    resetProgress().catch((error) => console.error('Failed to reset progress', error));
  });
  settingsForm.addEventListener('input', handleSettingsChange);
  settingsForm.addEventListener('change', handleSettingsChange);
  if (elements.authSignOut) {
    elements.authSignOut.addEventListener('click', signOut);
  }

  document.addEventListener('keydown', (event) => {
    if (document.body.classList.contains('drawer-open')) {
      return;
    }
    if (event.target && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) {
      return;
    }
    switch (event.key) {
      case ' ': {
        event.preventDefault();
        if (!state.showingAnswer) {
          revealAnswer();
        }
        break;
      }
      case '1':
        if (state.showingAnswer) gradeCard(0);
        break;
      case '2':
        if (state.showingAnswer) gradeCard(1);
        break;
      case '3':
        if (state.showingAnswer) gradeCard(2);
        break;
      case '4':
        if (state.showingAnswer) gradeCard(3);
        break;
      case 'ArrowRight':
        if (!state.showingAnswer) revealAnswer();
        break;
      default:
        break;
    }
  });

  applyTheme(settings.theme);
  handleModeChange(state.mode);
}

// --- Deck management (Oxford built-in + imported .apkg decks) ----------------
function renderDeckOptions() {
  const select = elements.deckSelect;
  if (!select) return;
  select.innerHTML = '';
  const oxfordOption = document.createElement('option');
  oxfordOption.value = OXFORD_DECK_ID;
  oxfordOption.textContent = 'The Oxford 3000';
  select.appendChild(oxfordOption);
  importedDecks.forEach((deck) => {
    const option = document.createElement('option');
    option.value = String(deck.id);
    option.textContent = `${deck.name} (${deck.count})`;
    select.appendChild(option);
  });
  select.value = String(activeDeckId);
  updateDeckUI();
}

function updateDeckUI() {
  const oxford = isOxfordDeck();
  if (elements.sectionDirection) elements.sectionDirection.classList.toggle('hidden', !oxford);
  if (elements.sectionLevel) elements.sectionLevel.classList.toggle('hidden', !oxford);
  if (elements.deleteDeck) elements.deleteDeck.classList.toggle('hidden', oxford);
  if (elements.importLabel) elements.importLabel.classList.toggle('disabled', !isSignedIn());
  if (elements.decksHint) {
    elements.decksHint.textContent = isSignedIn()
      ? 'Импортируйте колоду Anki (.apkg) — берутся лицо и оборот карточек.'
      : 'Войдите через Google, чтобы импортировать и синхронизировать свои колоды.';
  }
  if (elements.deckSelect) elements.deckSelect.value = String(activeDeckId);
}

function setImportStatus(message, isError) {
  if (!elements.importStatus) return;
  elements.importStatus.textContent = message || '';
  elements.importStatus.classList.toggle('error', Boolean(isError));
}

async function loadImportedDecks() {
  if (!isSignedIn()) {
    importedDecks = [];
    renderDeckOptions();
    return;
  }
  try {
    importedDecks = await apiListDecks();
  } catch (error) {
    console.error('Failed to list decks', error);
    importedDecks = [];
  }
  renderDeckOptions();
}

async function switchDeck(deckId) {
  activeDeckId = deckId;
  if (isOxfordDeck()) {
    cards = oxfordCards;
  } else {
    try {
      const deck = await apiGetDeck(deckId);
      cards = (deck.cards || []).map((card) => ({
        key: `imp-${card.id}`,
        word: card.front,
        translation: card.back,
        level: null,
        pos: [],
        oxford_urls: [],
        audio: {},
        imported: true,
      }));
    } catch (error) {
      console.error('Failed to load deck', error);
      showAuthMessage('Не удалось загрузить колоду');
      activeDeckId = OXFORD_DECK_ID;
      cards = oxfordCards;
    }
  }
  updateDeckUI();
  await loadProgress();
  state.currentCard = null;
  state.showingAnswer = false;
  buildQueues();
  showNextCard();
}

function handleDeckSelect(event) {
  switchDeck(event.target.value).catch((error) => console.error('Failed to switch deck', error));
}

async function handleImportApkg(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!isSignedIn()) {
    setImportStatus('Сначала войдите через Google', true);
    return;
  }
  setImportStatus('Импорт…');
  try {
    const result = await apiImportDeck(file);
    await loadImportedDecks();
    setImportStatus(`Готово: «${result.name}», ${result.count} карточек`);
    await switchDeck(result.id);
  } catch (error) {
    console.error('Import failed', error);
    setImportStatus(`Ошибка импорта: ${error.message}`, true);
  }
}

async function deleteActiveDeck() {
  if (isOxfordDeck()) return;
  const deck = importedDecks.find((item) => String(item.id) === String(activeDeckId));
  const name = deck ? deck.name : 'эту колоду';
  if (!confirm(`Удалить колоду «${name}» и весь прогресс по ней?`)) return;
  try {
    localStorage.removeItem(getProgressStorageKey());
    await apiDeleteDeck(activeDeckId);
  } catch (error) {
    console.error('Delete failed', error);
    showAuthMessage('Не удалось удалить колоду');
    return;
  }
  await loadImportedDecks();
  await switchDeck(OXFORD_DECK_ID);
}

async function bootstrap() {
  loadSettings();
  initUI();
  await initAuth();
  const response = await fetch(DATA_URL);
  oxfordCards = await response.json();
  cards = oxfordCards;
  buildQueues();
  showNextCard();
  loadImportedDecks().catch((error) => console.error('Failed to list decks', error));
}

bootstrap().catch((error) => {
  console.error('Failed to load flashcards', error);
  const message = document.querySelector('.card-message');
  if (message) {
    message.textContent = 'Не удалось загрузить данные';
  }
});

