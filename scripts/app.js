const DATA_URL = 'data/cards.json';
const STORAGE_KEY = 'oxford3000-progress-v1';
const SETTINGS_KEY = 'oxford3000-settings-v1';
const API_BASE_URL = '/api';
const PROGRESS_ENDPOINT = `${API_BASE_URL}/progress`;
const DEFAULT_SETTINGS = {
  dailyNewLimit: 20,
  lapseMinutes: 10,
  autoplayAudio: false,
  theme: 'system',
  preferredMode: 'en-ru',
  preferredLevel: 'all',
};

const AUTH_STORAGE_KEY = 'oxford3000-auth-user-v1';
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
let currentIdToken = null;
let googleInitialized = false;
let saveDebounceTimer = null;

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
  if (currentUser?.sub) {
    return `${STORAGE_KEY}::${currentUser.sub}`;
  }
  return STORAGE_KEY;
}

function isSignedIn() {
  return Boolean(currentUser?.sub);
}

function hasAuthToken() {
  return Boolean(currentIdToken);
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

  if (isSignedIn() && hasAuthToken()) {
    try {
      const response = await fetch(PROGRESS_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${currentIdToken}`,
        },
        cache: 'no-store',
      });
      if (response.status === 401) {
        currentIdToken = null;
        throw new Error('Unauthorized');
      }
      if (response.ok) {
        const payload = await response.json();
        if (payload?.progress?.cards && payload?.progress?.meta) {
          progress = payload.progress;
        }
        if (Array.isArray(payload?.history)) {
          state.history = payload.history.slice(0, 100);
        }
        saveProgressToLocalStorage();
        showAuthMessage('');
      } else if (response.status === 404) {
        const fallback = storedProgress || fallbackProgress;
        progress = fallback?.cards ? fallback : createEmptyProgress();
        state.history = fallbackHistory;
        showAuthMessage('Сервер синхронизации недоступен, прогресс сохраняется локально');
      } else {
        throw new Error(`Unexpected status ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to load progress from server', error);
      if (currentUser?.sub && !currentIdToken) {
        const fallback = storedProgress || fallbackProgress;
        progress = fallback?.cards ? fallback : createEmptyProgress();
        state.history = fallbackHistory;
        showAuthMessage('Сессия истекла, прогресс сохранён локально. Войдите через Google заново');
        if (window.google?.accounts?.id) {
          window.google.accounts.id.prompt();
        }
      } else {
        const fallback = storedProgress || fallbackProgress;
        progress = fallback?.cards ? fallback : createEmptyProgress();
        state.history = fallbackHistory;
        showAuthMessage('Не удалось загрузить прогресс с сервера, используется локальное сохранение');
      }
    }
  } else if (isSignedIn()) {
    showAuthMessage('Ожидаем подтверждение Google, прогресс будет загружен');
    const fallback = storedProgress || fallbackProgress;
    progress = fallback?.cards ? fallback : createEmptyProgress();
    state.history = fallbackHistory;
  } else {
    const fallback = storedProgress;
    progress = fallback?.cards ? fallback : createEmptyProgress();
    showAuthMessage('');
  }

  ensureProgressForToday();
  state.history = state.history.slice(0, 12);
  renderHistory();
}

async function persistProgress() {
  if (isSignedIn()) {
    if (!hasAuthToken()) {
      saveProgressToLocalStorage();
      showAuthMessage('Войдите через Google, чтобы синхронизировать прогресс');
      return;
    }
    try {
      const response = await fetch(PROGRESS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentIdToken}`,
        },
        body: JSON.stringify({
          progress,
          history: state.history,
        }),
      });
      if (response.status === 401) {
        currentIdToken = null;
        saveProgressToLocalStorage();
        showAuthMessage('Сессия истекла, прогресс сохранён локально. Войдите через Google заново');
        throw new Error('Unauthorized');
      }
      if (response.status === 404) {
        saveProgressToLocalStorage();
        showAuthMessage('Сервер синхронизации недоступен, прогресс сохраняется локально');
        return;
      }
      if (!response.ok) {
        throw new Error(`Unexpected status ${response.status}`);
      }
      saveProgressToLocalStorage();
      showAuthMessage('');
    } catch (error) {
      console.error('Failed to save progress to server', error);
      if (error?.message !== 'Unauthorized') {
        saveProgressToLocalStorage();
        showAuthMessage('Не удалось синхронизировать прогресс с сервером, данные сохранены локально');
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

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function showAuthMessage(message) {
  if (!elements.authMessage) return;
  if (!message) {
    elements.authMessage.textContent = '';
    elements.authMessage.classList.add('hidden');
    return;
  }
  elements.authMessage.textContent = message;
  elements.authMessage.classList.remove('hidden');
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
  filteredCards = cards.filter((card) => matchesLevel(card, state.level));
  const review = [];
  const fresh = [];

  for (const card of filteredCards) {
    const entry = progress.cards[card.word];
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
    const dueA = progress.cards[a.word]?.due ?? 0;
    const dueB = progress.cards[b.word]?.due ?? 0;
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
    ? progress.cards[state.reviewQueue[0].word]?.due
    : null;
  elements.nextDue.textContent = nextDue ? new Date(nextDue).toLocaleString('ru-RU') : '—';
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
    frontTitle.textContent = 'Все карточки на сегодня разобраны!';
    frontMeta.textContent = '';
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

  elements.showAnswer.classList.toggle('hidden', state.showingAnswer);
  elements.actionsContainer.classList.toggle('hidden', !state.showingAnswer);
  elements.actionsContainer.classList.toggle('disabled', !state.showingAnswer);

  const level = card.level ? card.level.toUpperCase() : null;
  const parts = (card.pos || []).join(', ');
  const metaBits = [];
  if (state.currentKind === 'new') {
    metaBits.push('Новая');
  } else if (state.currentKind === 'review') {
    metaBits.push('Повтор');
  }
  if (level) metaBits.push(`CEFR ${level}`);
  if (parts) metaBits.push(parts);
  frontMeta.textContent = metaBits.join(' • ');

  if (state.mode === 'en-ru') {
    frontTitle.textContent = card.word;
  } else {
    const primary = card.translation.split(/;|\./)[0];
    frontTitle.textContent = primary.trim();
  }

  metaBadges.innerHTML = '';
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

  backTitle.textContent = state.mode === 'en-ru' ? card.translation : card.word;
  translationList.innerHTML = '';
  const segments = card.translation
    .split(/(?<=\.)\s+|;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  segments.forEach((segment) => {
    const li = document.createElement('li');
    li.textContent = segment;
    translationList.appendChild(li);
  });

  sources.innerHTML = '';
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

function gradeCard(grade) {
  if (state.currentCard == null) return;
  const card = state.currentCard;
  const now = Date.now();
  const today = getTodayKey();
  const entry = progress.cards[card.word] || {
    ease: 2.5,
    interval: 0,
    repetitions: 0,
    due: now,
    lastReview: null,
    totalReviews: 0,
    lapses: 0,
  };

  if (progress.meta.lastReviewDay !== today) {
    progress.meta.lastReviewDay = today;
    progress.meta.reviewsToday = 0;
    progress.meta.newToday = 0;
  }

  if (state.currentKind === 'new' && !entry.seen) {
    entry.seen = true;
    progress.meta.newToday = Math.min(
      settings.dailyNewLimit,
      progress.meta.newToday + 1,
    );
  }

  progress.meta.reviewsToday += 1;
  entry.totalReviews += 1;

  if (grade === 0) {
    entry.repetitions = 0;
    entry.interval = 0;
    entry.ease = Math.max(1.3, (entry.ease || 2.5) - 0.2);
    entry.due = now + settings.lapseMinutes * 60 * 1000;
    entry.lapses = (entry.lapses || 0) + 1;
  } else {
    entry.ease = entry.ease || 2.5;
    if (grade === 1) {
      entry.ease = Math.max(1.3, entry.ease - 0.15);
      entry.interval = entry.interval ? Math.max(1, Math.round(entry.interval * 1.2)) : 1;
    } else if (grade === 2) {
      if (entry.repetitions === 0) {
        entry.interval = 1;
      } else if (entry.repetitions === 1) {
        entry.interval = 6;
      } else {
        entry.interval = Math.max(1, Math.round(entry.interval * entry.ease));
      }
      entry.repetitions += 1;
    } else if (grade === 3) {
      entry.ease = entry.ease + 0.15;
      if (entry.repetitions === 0) {
        entry.interval = 4;
      } else if (entry.repetitions === 1) {
        entry.interval = Math.round(entry.interval * 2.5);
      } else {
        entry.interval = Math.max(1, Math.round(entry.interval * entry.ease * 1.3));
      }
      entry.repetitions += 1;
    }
    entry.due = now + (entry.interval || 1) * 86400000;
  }

  entry.lastReview = now;
  progress.cards[card.word] = entry;
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
  pickNextCard();
  renderCard();
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
  pickNextCard();
  state.showingAnswer = false;
  renderCard();
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
  const matches = cards.filter((card) => {
    return (
      card.word.toLowerCase().includes(term) ||
      card.translation.toLowerCase().includes(term)
    );
  }).slice(0, 20);
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
    const preview = card.translation.split(/;|\./)[0].trim();
    button.innerHTML = `<strong>${card.word}</strong><span>${preview}</span>`;
    button.addEventListener('click', () => {
      state.currentCard = card;
      state.currentKind = progress.cards[card.word] ? 'review' : 'new';
      state.showingAnswer = false;
      renderCard();
      elements.searchResults.innerHTML = '';
      elements.searchInput.value = '';
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
    if (isSignedIn()) {
      const response = await fetch(PROGRESS_ENDPOINT, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${currentIdToken}`,
        },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Unexpected status ${response.status}`);
      }
      showAuthMessage('');
    } else {
      localStorage.removeItem(getProgressStorageKey());
    }
  } catch (error) {
    console.error('Failed to reset progress on server', error);
    showAuthMessage('Не удалось очистить данные на сервере');
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

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const decoded = atob(padded);
    const json = decodeURIComponent(
      decoded
        .split('')
        .map((char) => `%${`00${char.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(''),
    );
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to decode Google credential', error);
    return null;
  }
}

function updateAuthUI() {
  if (!elements.authSignedIn || !elements.authSignedOut) return;
  const signedIn = Boolean(currentUser);
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
    if (googleInitialized && window.google?.accounts?.id) {
      window.google.accounts.id.prompt();
    }
  }
}

async function handleUserChange() {
  await loadProgress();
  if (cards.length) {
    buildQueues();
    showNextCard();
  }
}

function setCurrentUser(user, { forceReload = false } = {}) {
  const previousId = currentUser?.sub || null;
  currentUser = user;
  if (user) {
    const payload = {
      sub: user.sub,
      name: user.name,
      email: user.email,
      picture: user.picture,
    };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  updateAuthUI();
  const nextId = currentUser?.sub || null;
  if (previousId !== nextId || forceReload) {
    handleUserChange().catch((error) => console.error('Failed to refresh user state', error));
  }
}

function handleCredentialResponse(response) {
  if (!response?.credential) return;
  const payload = decodeJwtPayload(response.credential);
  if (!payload?.sub) return;
  const forceReload = currentUser?.sub === payload.sub;
  currentIdToken = response.credential;
  setCurrentUser({
    sub: payload.sub,
    name: payload.name,
    email: payload.email,
    picture: payload.picture,
  }, { forceReload });
}

function renderGoogleButton() {
  if (!elements.authSignedOut || !window.google?.accounts?.id) return;
  elements.authSignedOut.innerHTML = '';
  window.google.accounts.id.renderButton(elements.authSignedOut, {
    theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline',
    size: 'medium',
    type: 'standard',
    text: 'signin_with',
    shape: 'pill',
  });
}

function setupGoogleSignIn() {
  const clientId = getGoogleClientId();
  if (!clientId || !elements.authSignedOut) return;
  if (!window.google?.accounts?.id) return;

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
  if (!currentUser) {
    window.google.accounts.id.prompt();
  }
}

function signOut() {
  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
  currentIdToken = null;
  setCurrentUser(null);
}

async function initAuth() {
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.sub) {
        currentUser = parsed;
      }
    }
  } catch (error) {
    console.warn('Failed to parse stored user', error);
  }

  await loadProgress();
  updateAuthUI();

  const clientId = getGoogleClientId();
  if (!clientId) {
    if (elements.authSignedOut) {
      elements.authSignedOut.innerHTML =
        '<span class="auth-hint">Добавьте Google Client ID в index.html, чтобы включить вход через Google</span>';
    }
    return;
  }

  window.addEventListener(GOOGLE_EVENT_NAME, setupGoogleSignIn, { once: false });
  if (window.google?.accounts?.id) {
    setupGoogleSignIn();
  }
}

function initUI() {
  elements.modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  elements.levelSelect = document.getElementById('level-filter');
  elements.showAnswer = document.getElementById('show-answer');
  elements.actionsContainer = document.getElementById('answer-actions');
  elements.cardFront = document.getElementById('card-front');
  elements.cardBack = document.getElementById('card-back');
  elements.frontTitle = document.getElementById('front-title');
  elements.frontMeta = document.getElementById('front-meta');
  elements.backTitle = document.getElementById('back-title');
  elements.translationList = document.getElementById('translation-list');
  elements.sourceLinks = document.getElementById('sources');
  elements.audioControls = document.getElementById('audio-controls');
  elements.metaBadges = document.getElementById('meta-badges');
  elements.statsDue = document.getElementById('stats-due');
  elements.statsNew = document.getElementById('stats-new');
  elements.statsStudied = document.getElementById('stats-studied');
  elements.statsTotal = document.getElementById('stats-total');
  elements.nextDue = document.getElementById('next-due');
  elements.history = document.getElementById('session-history');
  elements.searchInput = document.getElementById('search-input');
  elements.searchResults = document.getElementById('search-results');
  elements.settingsPanel = document.getElementById('settings-panel');
  elements.settingsToggle = document.getElementById('toggle-settings');
  elements.resetButton = document.getElementById('reset-progress');
  elements.authSignedIn = document.getElementById('auth-signed-in');
  elements.authSignedOut = document.getElementById('auth-signed-out');
  elements.authAvatar = document.getElementById('auth-avatar');
  elements.authName = document.getElementById('auth-name');
  elements.authSignOut = document.getElementById('auth-signout');
  elements.authMessage = document.getElementById('auth-message');

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
  elements.settingsToggle.addEventListener('click', () => {
    elements.settingsPanel.classList.toggle('open');
  });
  elements.resetButton.addEventListener('click', () => {
    resetProgress().catch((error) => console.error('Failed to reset progress', error));
  });
  settingsForm.addEventListener('input', handleSettingsChange);
  settingsForm.addEventListener('change', handleSettingsChange);
  if (elements.authSignOut) {
    elements.authSignOut.addEventListener('click', signOut);
  }

  document.addEventListener('keydown', (event) => {
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

async function bootstrap() {
  loadSettings();
  initUI();
  await initAuth();
  const response = await fetch(DATA_URL);
  cards = await response.json();
  buildQueues();
  showNextCard();
}

bootstrap().catch((error) => {
  console.error('Failed to load flashcards', error);
  const message = document.querySelector('.card-message');
  if (message) {
    message.textContent = 'Не удалось загрузить данные';
  }
});
