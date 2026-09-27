// ============================================================
// 原神拡大クイズ王 メインアプリ
// ============================================================

import { initializeApp, getApps, getApp } from
  "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { APP_VERSION } from './version.js';

// ============================================================
// ゲーム設定  ← ゲームバランスはここで調整
// ============================================================
const GAME_CONFIG = {
  QUESTION_TIME_MS:      30000,   // 1問の時間（ms）
  REVEAL_STEPS:          6,       // 得点段階数（STEP_INTERVAL_MSは自動計算）
  INITIAL_ZOOM_SCALE:    12.0,    // 初期拡大倍率
  FINAL_ZOOM_SCALE:      2.0,     // 最終拡大倍率
  INITIAL_CROP_SIZE:     80,      // 有効領域判定サンプルサイズ（px）
  MAX_CROP_PICK_TRIES:   20,      // 有効位置探索の最大試行回数
  MIN_FOREGROUND_RATIO:  0.20,    // 有効画素率の閾値
  ALPHA_THRESHOLD:       10,      // 透明判定アルファ閾値
  WHITE_THRESHOLD:       245,     // 白背景判定輝度閾値
  WHITE_DIFF_THRESHOLD:  12,      // 白背景判定チャンネル差閾値
  SAFE_AREA_INSET_RATIO: 0.12     // 画像端からの除外割合
};

// ステップ間隔：全体時間を (REVEAL_STEPS + 1) で均等割り
// 例）30秒 ÷ 7 ≈ 4.3秒ずつ → STEP6 は最後の約2/7を占める
const STEP_INTERVAL_MS = GAME_CONFIG.QUESTION_TIME_MS / (GAME_CONFIG.REVEAL_STEPS + 1);

// 得点テーブル（STEP1〜STEP6）
const STEP_SCORES = [10, 8, 6, 4, 2, 1];

const APP_NAME           = '原神ズームアップ';
const RESULT_SEC         = 6;
const ANSWER_COOLDOWN_MS = 800;

// チャット色プリセット（12色）
const CHAT_COLORS = [
  '#ff8c00', '#ffd700', '#00bcd4', '#ff69b4',
  '#4caf50', '#f44336', '#9c27b0', '#000000',
  '#ffc107', '#8bc34a', '#26c6da', '#ff6b6b',
];

// ============================================================
// グローバル状態
// ============================================================
let db;
let clientId;
let imageList       = [];
let currentState    = null;

let timerInterval      = null;
let correctUnsub       = null;
let zoomAnimFrame      = null;
let zoomLoopActive     = false;

let isAnswerLocked     = false;
let isInCooldown       = false;
let isAdminMode        = false; // sharedUserRolesから取得(loadAdminRole参照)
let roundEndAttempted  = false;
let roundStartAttempted = false;
let offlineMode        = false;
let isPageVisible      = true;

// フォーカス追跡
let lastFocusedInput = 'answer';

// オフラインモード用 直近問題履歴
let offlineRecentImages = [];

// チャット状態
let chatSentCount  = 0;
let chatRoundId    = null;
let chatUnsub      = null;
let selectedColor  = localStorage.getItem('uq_chatColor') || '#ff8c00';
const LANE_COUNT   = 6;
const laneActive   = new Array(LANE_COUNT).fill(false);

// ============================================================
// エントリーポイント
// ============================================================
async function init() {
  document.getElementById('appTitle').textContent = APP_NAME;
  document.getElementById('version').textContent = APP_VERSION;

  clientId = localStorage.getItem('uq_clientId');
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
    localStorage.setItem('uq_clientId', clientId);
  }

  const savedName = localStorage.getItem('uq_name');
  if (savedName) document.getElementById('nameInput').value = savedName;
  updateAdminIndicator();

  // 画像リスト読み込み
  try {
    const res = await fetch('data/imageList.json');
    imageList = await res.json();
    if (!imageList.length) throw new Error('画像リストが空');
  } catch (e) {
    setLoading('画像リストの読み込みに失敗しました。再読み込みしてください。');
    console.error(e);
    return;
  }

  // Firebase 初期化
  try {
    // account-status.js が先に同じデフォルトAppを作っている場合があるので、あれば使い回す
    const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
    db = getFirestore(app);
  } catch (e) {
    setLoading('Firebase初期化に失敗しました。firebase-config.jsを確認してください。');
    console.error(e);
    return;
  }
  await loadAdminRole();

  isPageVisible = !document.hidden;
  document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
    if (isPageVisible && currentState) {
      onStateChange(currentState);
    } else {
      clearInterval(timerInterval);
    }
  });

  let firstSnapReceived = false;
  const connectionTimeout = setTimeout(() => {
    if (!firstSnapReceived) {
      console.warn('[ZQ] Firestore接続タイムアウト → オフラインモード');
      startOfflineMode('timeout');
    }
  }, 3000);

  const stateRef = doc(db, 'quizZoomState', 'current');
  onSnapshot(stateRef, (snap) => {
    clearTimeout(connectionTimeout);
    firstSnapReceived = true;
    if (!snap.exists()) {
      firstRound();
    } else {
      onStateChange(snap.data());
    }
  }, (err) => {
    clearTimeout(connectionTimeout);
    firstSnapReceived = true;
    const category = categorizeFirestoreError(err);
    console.error(`[ZQ] Firestore接続エラー [${category}]:`, err.message);
    startOfflineMode(category);
  });
}

// ============================================================
// 状態変化ハンドラ
// ============================================================
function onStateChange(state) {
  const prevRoundId = currentState?.roundId;
  currentState      = state;

  if (state.status === 'running') {
    setActiveScreen('quizScreen');
    startZoomDisplay(state);
    startLocalTimer();

    if (prevRoundId !== state.roundId) {
      resetInput();
      resetChat(state.roundId);
    }

    subscribeCorrectCount(state.roundId);

  } else if (state.status === 'revealing') {
    stopZoomLoop();
    setActiveScreen('resultScreen');
    renderResult();
  }
}

// ============================================================
// ズーム表示（requestAnimationFrame ループ）
// ============================================================
function startZoomDisplay(state) {
  stopZoomLoop();

  const canvas = document.getElementById('zoomCanvas');
  const ctx    = canvas.getContext('2d');
  const img    = new Image();

  img.onload = () => {
    zoomLoopActive = true;

    function render() {
      if (!zoomLoopActive) return;

      const elapsed  = Math.max(0, Date.now() - state.startedAtMs);
      const progress = Math.min(elapsed / GAME_CONFIG.QUESTION_TIME_MS, 1);
      const zoom     = GAME_CONFIG.INITIAL_ZOOM_SCALE +
                       (GAME_CONFIG.FINAL_ZOOM_SCALE - GAME_CONFIG.INITIAL_ZOOM_SCALE) * progress;

      // 正方形クロップ（歪みなし）
      const side = Math.min(img.naturalWidth, img.naturalHeight) / zoom;
      const srcX = clamp(
        state.cropX * img.naturalWidth  - side / 2,
        0,
        img.naturalWidth  - side
      );
      const srcY = clamp(
        state.cropY * img.naturalHeight - side / 2,
        0,
        img.naturalHeight - side
      );

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, srcX, srcY, side, side, 0, 0, canvas.width, canvas.height);

      // STEP / スコア表示更新
      const step  = Math.min(
        Math.floor(elapsed / STEP_INTERVAL_MS),
        GAME_CONFIG.REVEAL_STEPS - 1
      );
      document.getElementById('stepBadge').textContent =
        `STEP ${step + 1}  今なら${STEP_SCORES[step]}点`;

      zoomAnimFrame = requestAnimationFrame(render);
    }

    zoomAnimFrame = requestAnimationFrame(render);
  };

  img.onerror = () => {
    ctx.fillStyle = '#555';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('画像を読み込めませんでした', canvas.width / 2, canvas.height / 2);
  };

  img.src = 'img/' + state.imageFile;
}

function stopZoomLoop() {
  zoomLoopActive = false;
  if (zoomAnimFrame !== null) {
    cancelAnimationFrame(zoomAnimFrame);
    zoomAnimFrame = null;
  }
}

// ============================================================
// 有効クロップ位置の自動検出
// ============================================================
async function findValidCropPosition(imageFile) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const offCanvas = document.createElement('canvas');
      offCanvas.width  = img.naturalWidth;
      offCanvas.height = img.naturalHeight;
      const ctx = offCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const inset = GAME_CONFIG.SAFE_AREA_INSET_RATIO;
      const minX = inset, maxX = 1 - inset;
      const minY = inset, maxY = 1 - inset;

      for (let i = 0; i < GAME_CONFIG.MAX_CROP_PICK_TRIES; i++) {
        const cx = minX + Math.random() * (maxX - minX);
        const cy = minY + Math.random() * (maxY - minY);
        if (isForegroundRegion(ctx, cx, cy, img.naturalWidth, img.naturalHeight)) {
          resolve({ cropX: cx, cropY: cy });
          return;
        }
      }

      // フォールバック: 画像中央
      resolve({ cropX: 0.5, cropY: 0.5 });
    };

    img.onerror = () => resolve({ cropX: 0.5, cropY: 0.5 });
    img.src = 'img/' + imageFile;
  });
}

function isForegroundRegion(ctx, cx, cy, imgW, imgH) {
  const cs = GAME_CONFIG.INITIAL_CROP_SIZE;
  const px = clamp(Math.round(cx * imgW - cs / 2), 0, imgW - cs);
  const py = clamp(Math.round(cy * imgH - cs / 2), 0, imgH - cs);

  let pixels;
  try {
    pixels = ctx.getImageData(px, py, cs, cs).data;
  } catch (e) {
    return true; // CORS等でアクセス不可の場合はOKとみなす
  }

  let fgCount = 0;
  const total = cs * cs;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a <= GAME_CONFIG.ALPHA_THRESHOLD) continue;
    if (
      r > GAME_CONFIG.WHITE_THRESHOLD &&
      g > GAME_CONFIG.WHITE_THRESHOLD &&
      b > GAME_CONFIG.WHITE_THRESHOLD &&
      Math.abs(r - g) < GAME_CONFIG.WHITE_DIFF_THRESHOLD &&
      Math.abs(r - b) < GAME_CONFIG.WHITE_DIFF_THRESHOLD &&
      Math.abs(g - b) < GAME_CONFIG.WHITE_DIFF_THRESHOLD
    ) continue;
    fgCount++;
  }

  return fgCount / total >= GAME_CONFIG.MIN_FOREGROUND_RATIO;
}

// ============================================================
// タイマー
// ============================================================
function startLocalTimer() {
  clearInterval(timerInterval);
  roundEndAttempted = false;
  const el = document.getElementById('timerDisplay');

  timerInterval = setInterval(() => {
    if (!currentState) return;
    const remaining = Math.max(0, currentState.endsAtMs - Date.now());
    const secs      = Math.ceil(remaining / 1000);
    el.textContent  = `残り ${secs}秒`;
    el.classList.toggle('urgent', secs <= 5);

    if (remaining === 0 && !roundEndAttempted && isPageVisible) {
      roundEndAttempted = true;
      if (offlineMode) startOfflineReveal();
      else             transitionToRevealing();
    }
  }, 500);
}

// ============================================================
// 結果画面
// ============================================================
function renderResult() {
  const top3    = currentState?.top3      || [];
  const answer  = currentState?.answerText || '';
  const imgFile = currentState?.imageFile  || null;

  const listEl = document.getElementById('top3List');
  listEl.innerHTML = '';

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < 3; i++) {
    const item  = document.createElement('div');
    item.className = 'top3-item';
    const name  = top3[i]?.name  ?? '—';
    const score = top3[i]?.score ?? null;
    item.innerHTML =
      `<span class="top3-rank">${medals[i]}</span>` +
      `<span class="top3-name">${escapeHtml(name)}` +
      (score !== null ? `<span class="top3-score"> ${score}点</span>` : '') +
      `</span>`;
    listEl.appendChild(item);
  }

  document.getElementById('answerReveal').innerHTML =
    `<span class="label">こたえ</span>${escapeHtml(answer)}`;

  const answerImgContainer = document.getElementById('answerImageContainer');
  const answerImg          = document.getElementById('answerImage');
  if (imgFile) {
    answerImg.src = 'img/' + imgFile;
    answerImgContainer.style.display = 'flex';
  } else {
    answerImgContainer.style.display = 'none';
  }

  startResultCountdown();
}

function startResultCountdown() {
  clearInterval(timerInterval);
  roundStartAttempted = false;
  const el           = document.getElementById('nextCountdown');
  const revealEndsAt = (currentState?.endsAtMs || Date.now()) + RESULT_SEC * 1000;

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, revealEndsAt - Date.now());
    const secs      = Math.ceil(remaining / 1000);
    el.textContent  = secs > 0 ? `次の問題まで：${secs}秒` : '次の問題へ…';

    if (remaining === 0 && !roundStartAttempted && isPageVisible) {
      roundStartAttempted = true;
      if (!offlineMode) transitionToRunning();
    }
  }, 500);
}

// ============================================================
// ラウンド遷移（トランザクションで1クライアントのみ実行）
// ============================================================

/** running → revealing */
async function transitionToRevealing() {
  if (!currentState || currentState.status !== 'running') return;

  const roundId = currentState.roundId;
  const entry   = imageList.find(i => i.file === currentState.imageFile);
  const answer  = entry?.answer || '';

  // 全正解者取得 → スコア降順・時刻昇順でTOP3
  let top3 = [];
  try {
    const snap = await getDocs(query(collection(db, 'quizAnswers'), where('roundId', '==', roundId)));
    const all  = snap.docs.map(d => d.data());
    all.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.answeredAt?.toMillis?.() || 0) - (b.answeredAt?.toMillis?.() || 0);
    });
    top3 = all.slice(0, 3).map(d => ({ name: d.name, score: d.score }));
  } catch (e) {
    console.error('TOP3取得失敗:', e);
  }

  try {
    const stateRef = doc(db, 'quizZoomState', 'current');
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.data();
      if (data?.status !== 'running' || data?.roundId !== roundId) return;
      tx.update(stateRef, {
        status:           'revealing',
        top3:             top3,
        answerText:       answer,
        leaderId:         clientId,
        leaderLastSeenMs: Date.now()
      });
    });
  } catch (e) {
    console.error('revealing遷移失敗:', e);
  }
}

/** revealing → running */
async function transitionToRunning() {
  if (!currentState || currentState.status !== 'revealing') return;

  // 非同期処理はトランザクション外で完了させる（GenshinQuizと同じ構成）
  const entry          = pickImageEntry(currentState.recentImages || []);
  const { cropX, cropY } = await findValidCropPosition(entry.file);
  const now            = Date.now();

  try {
    const stateRef = doc(db, 'quizZoomState', 'current');
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.data();
      if (data?.status !== 'revealing') return;

      // Firestoreの最新値でrecentImagesを更新（GenshinQuizのlastQuestionIdsと同じ方式）
      const recentImages  = data.recentImages || [];
      const updatedRecent = [...recentImages, entry.file].slice(-30);

      tx.set(stateRef, {
        roundId:          generateId(),
        imageFile:        entry.file,
        cropX,
        cropY,
        status:           'running',
        startedAt:        serverTimestamp(),
        startedAtMs:      now,
        endsAtMs:         now + GAME_CONFIG.QUESTION_TIME_MS,
        answerText:       '',
        top3:             [],
        recentImages:     updatedRecent,
        leaderId:         clientId,
        leaderLastSeenMs: now
      });
    });
  } catch (e) {
    console.error('running遷移失敗:', e);
  }
}

/** 初回ラウンド作成（ドキュメントなし時）*/
async function firstRound() {
  const entry          = pickImageEntry([]);
  const { cropX, cropY } = await findValidCropPosition(entry.file);
  const now            = Date.now();
  const stateRef       = doc(db, 'quizZoomState', 'current');

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      if (snap.exists()) return;
      tx.set(stateRef, {
        roundId:          generateId(),
        imageFile:        entry.file,
        cropX,
        cropY,
        status:           'running',
        startedAt:        serverTimestamp(),
        startedAtMs:      now,
        endsAtMs:         now + GAME_CONFIG.QUESTION_TIME_MS,
        answerText:       '',
        top3:             [],
        recentImages:     [entry.file],
        leaderId:         clientId,
        leaderLastSeenMs: now
      });
    });
  } catch (e) {
    console.error('初回ラウンド作成失敗:', e);
  }
}

// ============================================================
// 回答処理
// ============================================================
function setupAnswerForm() {
  const submitBtn   = document.getElementById('submitBtn');
  const answerInput = document.getElementById('answerInput');
  const nameInput   = document.getElementById('nameInput');

  submitBtn.addEventListener('click', handleSubmit);
  answerInput.addEventListener('focus', () => { lastFocusedInput = 'answer'; });
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });

  nameInput.addEventListener('change', () => {
    const val = sanitizeName(nameInput.value.trim());
    nameInput.value = val;
    localStorage.setItem('uq_name', val);
  });
}

async function handleSubmit() {
  if (isAnswerLocked || isInCooldown)     return;
  if (currentState?.status !== 'running') return;

  const nameInput   = document.getElementById('nameInput');
  const answerInput = document.getElementById('answerInput');
  const name        = nameInput.value.trim();

  if (!name) { flashBorder(nameInput); nameInput.focus(); return; }
  if (!answerInput.value.trim()) return;

  const input   = normalizeAnswer(answerInput.value);
  const entry   = imageList.find(i => i.file === currentState.imageFile);
  const correct = normalizeAnswer(entry?.answer || '');

  if (!correct) return;

  if (input === correct) {
    const elapsed = Math.max(0, Date.now() - currentState.startedAtMs);
    const step    = Math.min(
      Math.floor(elapsed / STEP_INTERVAL_MS),
      GAME_CONFIG.REVEAL_STEPS - 1
    );
    const score = STEP_SCORES[step];
    if (!offlineMode) await saveCorrectAnswer(name, score);
    showCorrectMessage(score);
    lockInput();
  } else {
    answerInput.value = '';
    flashBorder(answerInput);
    setCooldown();
  }
}

function normalizeAnswer(str) {
  return katakanaToHiragana(str.trim()).replace(/\s/g, '');
}

function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

async function saveCorrectAnswer(name, score) {
  // ドキュメントID: roundId_clientId で同一クライアントの重複回答を防ぐ
  const ref = doc(db, 'quizAnswers', `${currentState.roundId}_${clientId}`);
  try {
    await setDoc(ref, {
      roundId:    currentState.roundId,
      name,
      score,
      answeredAt: serverTimestamp(),
      imageFile:  currentState.imageFile,
      expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
  } catch (e) {
    console.error('正解保存失敗:', e);
  }
}

function lockInput() {
  isAnswerLocked = true;
  document.getElementById('answerInput').disabled = true;
  document.getElementById('submitBtn').disabled   = true;
}

function resetInput() {
  isAnswerLocked = false;
  isInCooldown   = false;
  const answerInput = document.getElementById('answerInput');
  answerInput.disabled = false;
  answerInput.value    = '';
  document.getElementById('submitBtn').disabled = false;
  document.getElementById('correctMessage').classList.add('hidden');
  document.getElementById('correctCount').textContent = '正解者: 0人';
  if (lastFocusedInput === 'chat') {
    document.getElementById('chatInput').focus();
  } else {
    answerInput.focus();
  }
}

function showCorrectMessage(score) {
  const el = document.getElementById('correctMessage');
  el.textContent = `正解！ ${score}点`;
  el.classList.remove('hidden');
}

function setCooldown() {
  isInCooldown = true;
  document.getElementById('submitBtn').disabled = true;
  setTimeout(() => {
    isInCooldown = false;
    if (!isAnswerLocked) document.getElementById('submitBtn').disabled = false;
  }, ANSWER_COOLDOWN_MS);
}

function flashBorder(el) {
  el.style.borderColor = 'var(--wrong)';
  setTimeout(() => { el.style.borderColor = ''; }, 700);
}

// ============================================================
// 正解者数リアルタイム購読
// ============================================================
function subscribeCorrectCount(roundId) {
  if (offlineMode) return;
  if (correctUnsub) correctUnsub();
  const colRef = query(collection(db, 'quizAnswers'), where('roundId', '==', roundId));
  correctUnsub = onSnapshot(colRef, (snap) => {
    document.getElementById('correctCount').textContent = `正解者: ${snap.size}人`;
  });
}

// ============================================================
// オフラインモード
// ============================================================
function categorizeFirestoreError(err) {
  const msg  = err?.message || '';
  const code = err?.code    || '';
  if (code === 'permission-denied' || msg.includes('403'))          return 'permission-denied';
  if (msg.includes('has not been used') || msg.includes('disabled')) return 'api-disabled';
  if (msg.includes('blocked') || msg.includes('ERR_BLOCKED'))        return 'blocked/client';
  return 'unknown';
}

function startOfflineMode(reason) {
  offlineMode = true;
  const labels = {
    'timeout':           'Firestoreに接続できません（タイムアウト）',
    'permission-denied': 'Firestoreのルール/権限エラー（403）',
    'api-disabled':      'Firestore APIが未有効です',
    'blocked/client':    '通信がブロックされています（拡張機能を確認）',
    'unknown':           'Firestore接続エラー'
  };
  const msg = labels[reason] || labels['unknown'];
  setLoading(`⚠ ${msg} — オフラインモードで起動します...`);
  setTimeout(() => startOfflineRound(), 2000);
}

async function startOfflineRound() {
  const entry          = pickImageEntry(offlineRecentImages);
  offlineRecentImages  = [...offlineRecentImages, entry.file].slice(-30);
  const { cropX, cropY } = await findValidCropPosition(entry.file);
  const now            = Date.now();

  currentState = {
    roundId:     'offline',
    imageFile:   entry.file,
    cropX,
    cropY,
    status:      'running',
    startedAtMs: now,
    endsAtMs:    now + GAME_CONFIG.QUESTION_TIME_MS,
    top3:        [],
    answerText:  ''
  };

  setActiveScreen('quizScreen');
  startZoomDisplay(currentState);
  startLocalTimer();
  resetInput();
  resetChat(null);
  document.getElementById('correctCount').textContent = 'オフラインモード';
}

function startOfflineReveal() {
  const entry  = imageList.find(i => i.file === currentState.imageFile);
  currentState = {
    ...currentState,
    status:     'revealing',
    answerText: entry?.answer || ''
  };
  stopZoomLoop();
  renderResult();
  setTimeout(() => startOfflineRound(), RESULT_SEC * 1000);
}

// ============================================================
// チャット
// ============================================================
function setupChatForm() {
  const toggleBtn = document.getElementById('colorToggleBtn');
  const palette   = document.getElementById('colorPalette');
  const sendBtn   = document.getElementById('chatSendBtn');
  const chatInput = document.getElementById('chatInput');

  toggleBtn.style.background = selectedColor;

  CHAT_COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-btn' + (color === selectedColor ? ' selected' : '');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      toggleBtn.style.background = color;
      localStorage.setItem('uq_chatColor', color);
      palette.classList.add('hidden');
      palette.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    palette.appendChild(btn);
  });

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    palette.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-color-wrap')) palette.classList.add('hidden');
  });

  sendBtn.addEventListener('click', handleChatSend);
  chatInput.addEventListener('focus', () => { lastFocusedInput = 'chat'; });
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleChatSend(); });
}

function handleChatSend() {
  if (chatSentCount >= 3) return;
  const chatInput = document.getElementById('chatInput');
  const nameInput = document.getElementById('nameInput');
  const text = chatInput.value.trim();
  const name = nameInput.value.trim();
  if (!name) { flashBorder(nameInput); nameInput.focus(); return; }
  if (!text) return;

  chatInput.value = '';
  chatSentCount++;
  if (chatSentCount >= 3) document.getElementById('chatSendBtn').disabled = true;

  renderFlyingComment(name, text, selectedColor, isAdminMode);

  if (!offlineMode && chatRoundId) {
    const ref = doc(db, 'quizMessages', `${chatRoundId}_${clientId}_${chatSentCount}`);
    setDoc(ref, {
      roundId:   chatRoundId,
      text, name, color: selectedColor, clientId,
      isAdmin:   isAdminMode,
      sentAt:    serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000 * 3)
    }).catch(e => console.error('チャット送信失敗:', e));
  }
}

function subscribeChat(roundId) {
  if (chatUnsub) chatUnsub();
  let isFirst = true;
  chatUnsub = onSnapshot(query(collection(db, 'quizMessages'), where('roundId', '==', roundId)), snap => {
    if (isFirst) { isFirst = false; return; }
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added' && ch.doc.data().clientId !== clientId) {
        const d = ch.doc.data();
        renderFlyingComment(d.name || '名無し', d.text, d.color, d.isAdmin === true);
      }
    });
  });
}

function resetChat(roundId) {
  chatSentCount = 0;
  chatRoundId   = roundId;
  document.getElementById('chatSendBtn').disabled = false;
  if (!offlineMode && roundId) subscribeChat(roundId);
}

function renderFlyingComment(name, text, color, isAdmin = false) {
  const overlay = document.getElementById('commentOverlay');
  let lane = laneActive.findIndex(v => !v);
  if (lane === -1) lane = Math.floor(Math.random() * LANE_COUNT);
  laneActive[lane] = true;

  const displayName = isAdmin ? `🔧${name}` : name;
  const el = document.createElement('div');
  el.className   = 'fly-comment' + (isAdmin ? ' fly-comment--admin' : '');
  el.textContent = `${displayName}：${text}`;
  el.style.color = color;
  el.style.top   = `${lane * (80 / LANE_COUNT) + 5}%`;
  overlay.appendChild(el);

  el.addEventListener('animationend', () => {
    laneActive[lane] = false;
    el.remove();
  });
}

// ============================================================
// 画面管理
// ============================================================
function setActiveScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setLoading(msg) {
  setActiveScreen('loadingScreen');
  if (msg) document.querySelector('.loading-text').textContent = msg;
}

// ============================================================
// ユーティリティ
// ============================================================
function pickImageEntry(recentImages = []) {
  const pool = imageList.filter(i => !recentImages.includes(i.file));
  const list = pool.length > 0 ? pool : imageList;
  return list[Math.floor(Math.random() * list.length)];
}

function generateId() {
  return 'r_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
}

// 🔧 を名前から除去（なりすまし防止）
function sanitizeName(name) {
  return name.replace(/🔧/g, '').trim();
}

// 管理者モードの視覚インジケーター更新（名前欄の枠色）
function updateAdminIndicator() {
  const el = document.getElementById('nameInput');
  if (!el) return;
  el.style.borderColor = isAdminMode ? '#FFD700' : '';
  el.title = isAdminMode ? '🔧 管理者モード中' : '';
}

// うこ氏サイト群共通ID（同一オリジンのlocalStorageを共有する前提。omikuji/userData.jsのgetUserId()と同じロジック）
function getSharedUserId() {
  let id = localStorage.getItem('genshinOmikuji_userId');
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'u_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('genshinOmikuji_userId', id);
  }
  return id;
}

// 管理者ロールをsharedUserRolesから取得(genshin-bakatare01に統合済みなのでdbをそのまま使う)
async function loadAdminRole() {
  try {
    const snap = await getDoc(doc(db, 'sharedUserRoles', getSharedUserId()));
    isAdminMode = !!(snap.exists() && snap.data().role === 'admin');
  } catch (e) {
    console.warn('[UZ] 管理者ロール取得に失敗:', e);
  }
  updateAdminIndicator();
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 起動
// ============================================================
setupAnswerForm();
setupChatForm();
init();
