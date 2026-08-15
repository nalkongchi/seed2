const QUESTION_SET = buildQuestionSet(QUESTION_RULES);
const EXAM_TYPES = ["포장검사", "종자검사"];
const CROPS = ["벼", "보리", "밀", "콩", "팥", "라이밀(트리티케일)"];
const STAGE_GROUPS = ["원원종", "원종", "보급종"];
const STAGE_GROUP_MAP = {
  "원원종": ["원원종", "원원종포"],
  "원종": ["원종", "원종포"],
  "보급종": ["보급종", "보급종포", "채종포 1세대"]
};
const EXCLUDED_STAGES = ["채종포 2세대"];
const COMPLETION_TARGET = 10;
const TIME_CHECKPOINT_VERSION = 3;
const LEGACY_TIME_CHECKPOINT_VERSION = 1;
const COMBO_TIME_CHECKPOINT_VERSION = 2;
const TIME_CHECKPOINT_PHASES = ["spin", "answer", "feedback"];
const STORAGE_KEYS = {
  best: "seedTraining_v1_2_bestTimeAttack",
  completionBest: "seedTraining_v1_2_bestCompletion",
  inProgress: "seedTraining_v1_2_inProgressCompletion",
  wrongs: "seedTraining_v1_2_wrongNotes",
  settings: "seedTraining_v1_2_settings"
};
const MODE_META = {
  time: { en: "Time Attack", title: "실전모드", pill: "⚡ 10정답 완주", sub: "전체 범위 랜덤 · 정답 10개" },
  practice: { en: "Practice", title: "연습모드", pill: "∞ 무한모드" },
  "wrong-practice": { en: "Wrong Notes", title: "오답 연습", pill: "📝 오답만", sub: "오답노트에 저장된 문제만 출제" }
};

const state = {
  mode: null, // time | practice | wrong-practice
  selectedExamTypes: [...EXAM_TYPES],
  selectedStageGroups: [...STAGE_GROUPS],
  selectedCrops: [...CROPS],
  pool: [],
  curQuestion: null,
  spinning: false,
  spinIntervals: [],
  correct: 0,
  wrong: 0,
  combo: 0,
  maxCombo: 0,
  tries: 0,
  recentWrongs: [],
  wrongNotes: [],
  preservedWrongNotes: [],
  pendingWrongNoteAdds: [],
  pendingWrongNoteClear: null,
  settings: { bgmLevel: 3, sfx: true, vibrate: true },
  settingsDraft: null,
  elapsedMs: 0,
  completionElapsedSeconds: null,
  resultCompletionRecord: null,
  stopwatchStarted: false,
  stopwatchRunning: false,
  stopwatchStartedAt: null,
  runPhase: "idle",
  runId: null,
  timeCheckpoint: null,
  timeInterval: null,
  nextTimeout: null,
  ngTimeout: null,
  scored: false,
  runEnded: false,
  countdownTimer: null,
  audioCtx: null,
  timeAttackBest: { correct: 0, tries: 0, acc: 0 },
  bestCompletion: null,
  audioReady: false,
  currentBgm: null
};

const modalOpeners = new Map();
const MODAL_FOCUSABLE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function isMobileView() {
  return window.matchMedia("(max-width: 700px)").matches;
}

function $(id) { return document.getElementById(id); }
function isAllowedQuestion(q) { return q && !EXCLUDED_STAGES.includes(q.stage); }
function showPage(id, opts = {}) {
  document.querySelectorAll(".base-page").forEach(p => p.classList.remove("active"));
  $("page-" + id).classList.add("active");
  closeAllModals();
  if (opts.syncBgm !== false) syncBgmForPage(id);
}
function isAvailableFocusable(el) {
  return !!el && !el.disabled && !el.hidden && el.getAttribute?.("aria-hidden") !== "true" &&
    !el.classList?.contains("hidden") && !el.closest?.(".hidden") && typeof el.focus === "function";
}
function getModalFocusables(modal) {
  return modal ? [...modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)].filter(isAvailableFocusable) : [];
}
function getActiveModal() {
  return document.querySelector(".modal-layer.active");
}
function restoreModalOpener(modal) {
  const opener = modalOpeners.get(modal);
  modalOpeners.delete(modal);
  if (!opener || opener.isConnected === false || !document.contains(opener) || !isAvailableFocusable(opener)) return;
  opener.focus();
}
function openModal(id, opener = document.activeElement) {
  const modal = $("page-" + id);
  if (!modal) return;
  document.querySelectorAll(".modal-layer.active").forEach(active => {
    if (active !== modal) closeModal(active.id.replace("page-", ""), { restoreFocus: false });
  });
  modalOpeners.set(modal, opener);
  modal.classList.add("active");
  getModalFocusables(modal)[0]?.focus();
}
function closeModal(id, { restoreFocus = true } = {}) {
  const modal = $("page-" + id);
  if (!modal || !modal.classList.contains("active")) return;
  if (id === "settings") discardSettingsDraft();
  modal.classList.remove("active");
  if (restoreFocus) restoreModalOpener(modal);
  else modalOpeners.delete(modal);
}
function closeAllModals() {
  document.querySelectorAll(".modal-layer.active").forEach(modal => {
    closeModal(modal.id.replace("page-", ""), { restoreFocus: false });
  });
}
function handleModalKeydown(e) {
  const modal = getActiveModal();
  if (!modal) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeModal(modal.id.replace("page-", ""));
    return true;
  }
  if (e.key !== "Tab") return true;
  const focusables = getModalFocusables(modal);
  if (!focusables.length) {
    e.preventDefault();
    return true;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const current = document.activeElement;
  if (!modal.contains(current) || (!e.shiftKey && current === last) || (e.shiftKey && current === first)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
  return true;
}
function show(id, visible) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function isStoredQuestion(value) {
  return isPlainObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.examType) &&
    isNonEmptyString(value.crop) &&
    isNonEmptyString(value.stage) &&
    isNonEmptyString(value.item) &&
    isNonEmptyString(value.answer) &&
    /^\d+(?:\.\d+)?$/.test(value.answer) &&
    (typeof value.unit === "undefined" || typeof value.unit === "string") &&
    (typeof value.label === "undefined" || typeof value.label === "string");
}
function isValidBestRecord(value) {
  return isPlainObject(value) &&
    Number.isInteger(value.correct) && value.correct >= 0 &&
    Number.isInteger(value.tries) && value.tries >= value.correct &&
    Number.isInteger(value.acc) && value.acc >= 0 && value.acc <= 100;
}
function isValidCompletionBest(value) {
  return isPlainObject(value) &&
    Number.isInteger(value.elapsedSeconds) && value.elapsedSeconds >= 0 &&
    Number.isInteger(value.tries) && value.tries >= COMPLETION_TARGET;
}
function findQuestionById(id) {
  return QUESTION_SET.find(q => q.id === id && isAllowedQuestion(q)) || null;
}
function createRunId() {
  try {
    const id = window.crypto?.randomUUID?.();
    if (isNonEmptyString(id)) return id;
  } catch (e) {}
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function createLegacyRunId(value) {
  const source = JSON.stringify(value);
  let first = 2166136261;
  let second = 2246822519;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `legacy-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
function normalizeTimeCheckpoint(value) {
  if (!isPlainObject(value) || ![
    LEGACY_TIME_CHECKPOINT_VERSION,
    COMBO_TIME_CHECKPOINT_VERSION,
    TIME_CHECKPOINT_VERSION
  ].includes(value.version)) return null;
  if (!Number.isInteger(value.correct) || value.correct < 0 || value.correct >= COMPLETION_TARGET) return null;
  if (!Number.isInteger(value.tries) || value.tries < value.correct) return null;
  if (!Number.isInteger(value.wrong) || value.wrong < 0) return null;
  if (value.tries !== value.correct + value.wrong) return null;
  if (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) return null;
  if (!TIME_CHECKPOINT_PHASES.includes(value.phase)) return null;
  if (!isNonEmptyString(value.questionId) || !findQuestionById(value.questionId)) return null;
  if (!Array.isArray(value.recentWrongIds) || !value.recentWrongIds.every(id => typeof id === "string")) return null;
  const combo = value.version === LEGACY_TIME_CHECKPOINT_VERSION ? 0 : value.combo;
  const maxCombo = value.version === LEGACY_TIME_CHECKPOINT_VERSION ? 0 : value.maxCombo;
  if (!Number.isInteger(combo) || combo < 0) return null;
  if (!Number.isInteger(maxCombo) || maxCombo < 0) return null;
  if (combo > maxCombo || combo > value.correct || maxCombo > value.correct) return null;
  const runId = value.version === TIME_CHECKPOINT_VERSION ? value.runId : createLegacyRunId(value);
  if (!isNonEmptyString(runId)) return null;
  return { ...value, version: TIME_CHECKPOINT_VERSION, combo, maxCombo, runId };
}
function isValidTimeCheckpoint(value) {
  return normalizeTimeCheckpoint(value) !== null;
}
function normalizeTimeCheckpointTerminal(value) {
  if (!isPlainObject(value) || value.version !== TIME_CHECKPOINT_VERSION || value.terminal !== true) return null;
  if (!isNonEmptyString(value.runId)) return null;
  return { version: TIME_CHECKPOINT_VERSION, runId: value.runId, terminal: true };
}
function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { ok: true, exists: false, value: undefined };
    return { ok: true, exists: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, exists: false, value: undefined };
  }
}
function loadJSON(key, fallback) {
  const stored = readJSON(key);
  return stored.ok && stored.exists ? stored.value : fallback;
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}
function removeJSON(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    return false;
  }
}


function markImageAsset(imgId, cardId, isBackground = false) {
  const img = $(imgId);
  if (!img) return;
  img.setAttribute("draggable", "false");
  const card = cardId ? $(cardId) : img.closest(".home-image-btn, .home-asset-card");
  const success = () => {
    if (isBackground) {
      img.parentElement?.classList.add("bg-loaded");
    } else {
      card?.classList.add("asset-loaded");
    }
  };
  const fail = () => {
    img.classList.add("is-missing");
  };
  img.addEventListener("load", success);
  img.addEventListener("error", fail);
  if (img.complete) {
    if (img.naturalWidth > 0) success();
    else fail();
  }
}

function initHomeAssets() {
  markImageAsset("asset-home-bg", null, true);
  markImageAsset("asset-home-title", "card-home-title");
  markImageAsset("asset-btn-home-time");
  markImageAsset("asset-btn-home-practice");
  markImageAsset("asset-btn-home-wrong");
  markImageAsset("asset-btn-home-settings");
}

function preventImageLongPress() {
  const stopImageMenu = event => {
    if (event.target?.closest?.("img, .home-hit-btn, .image-button")) event.preventDefault();
  };
  document.querySelectorAll("img").forEach(img => {
    img.setAttribute("draggable", "false");
    img.addEventListener("contextmenu", event => event.preventDefault());
    img.addEventListener("dragstart", event => event.preventDefault());
    img.addEventListener("selectstart", event => event.preventDefault());
  });
  document.addEventListener("contextmenu", stopImageMenu, { capture: true });
  document.addEventListener("dragstart", stopImageMenu, { capture: true });
}

function getBgmVolume(settings = state.settings) {
  const level = Math.max(0, Math.min(5, Number(settings?.bgmLevel ?? 3)));
  return [0, 0.14, 0.26, 0.42, 0.55, 0.70][level] || 0;
}
function applyAudioVolumes(settings = state.settings) {
  const bgmVol = getBgmVolume(settings);
  ["bgm-home","bgm-play","bgm-play2"].forEach(id => {
    const el = $(id);
    if (el) el.volume = bgmVol;
  });
  ["se-correct","se-wrong","se-finish"].forEach(id => {
    const el = $(id);
    if (el) el.volume = 0.72;
  });
}
function prepareAudio() {
  if (!state.audioReady) {
    state.audioReady = true;
    ["bgm-home","bgm-play","bgm-play2","se-correct","se-wrong","se-finish"].forEach(id => {
      const el = $(id);
      if (el) {
        try { el.load(); } catch (e) {}
      }
    });
  }
  applyAudioVolumes();
}

function stopAllBgm() {
  ["bgm-home","bgm-play","bgm-play2"].forEach(id => {
    const el = $(id);
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  });
  state.currentBgm = null;
}

function playBgm(id) {
  prepareAudio();
  if (getBgmVolume() <= 0) { stopAllBgm(); return; }
  const next = $(id);
  if (!next) return;
  if (state.currentBgm === id && !next.paused) return;
  stopAllBgm();
  applyAudioVolumes();
  const promise = next.play();
  state.currentBgm = id;
  if (promise && typeof promise.catch === "function") {
    promise.catch(() => {
      state.currentBgm = null;
    });
  }
}

function syncBgmForPage(pageId) {
  if (getBgmVolume() <= 0) { stopAllBgm(); return; }
  if (pageId === "home") playBgm("bgm-home");
  else if (pageId === "play") {
    if (state.mode === "practice" || state.mode === "wrong-practice") playBgm("bgm-play2");
    else playBgm("bgm-play");
  }
  else if (pageId === "result") playBgm("bgm-home");
}

function ensureHomeBgm(force = false) {
  prepareAudio();
  // 같은 BGM이 이미 재생 중이면 메뉴/팝업 클릭으로 음악을 처음부터 다시 시작하지 않는다.
  syncBgmForPage(document.querySelector(".base-page.active")?.id?.replace("page-","") || "home");
}

function playEffect(id, fallbackType = "") {
  if (!state.settings.sfx) return;
  prepareAudio();
  const el = $(id);
  if (el) {
    try {
      el.currentTime = 0;
      const promise = el.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(() => { if (fallbackType) maybeBeep(fallbackType, true); });
      }
      return;
    } catch (e) {}
  }
  if (fallbackType) maybeBeep(fallbackType, true);
}
function normalizeSettings(raw) {
  const base = { bgmLevel: 3, sfx: true, vibrate: true };
  const source = isPlainObject(raw) ? raw : {};
  const hasOwnBgmLevel = Object.prototype.hasOwnProperty.call(source, "bgmLevel");
  const hasValidBgmLevel = hasOwnBgmLevel &&
    Number.isInteger(source.bgmLevel) && source.bgmLevel >= 0 && source.bgmLevel <= 5;
  let bgmLevel = base.bgmLevel;
  if (hasValidBgmLevel) bgmLevel = source.bgmLevel;
  else if (!hasOwnBgmLevel && source.bgm === false) bgmLevel = 0;
  return {
    bgmLevel,
    sfx: typeof source.sfx === "boolean" ? source.sfx : base.sfx,
    vibrate: typeof source.vibrate === "boolean" ? source.vibrate : base.vibrate
  };
}
function updateBgmVolumeUI() {
  const el = $("bgm-volume-level");
  if (el) el.textContent = String(state.settings.bgmLevel ?? 3);
}
function updateSettingsDraftUI() {
  const draft = state.settingsDraft || state.settings;
  const level = $("bgm-volume-level");
  if (level) level.textContent = String(draft.bgmLevel ?? 3);
  const sfx = $("toggle-sfx");
  if (sfx) sfx.checked = !!draft.sfx;
  const vibrate = $("toggle-vibrate");
  if (vibrate) vibrate.checked = !!draft.vibrate;
}
function beginSettingsEdit() {
  state.settingsDraft = { ...state.settings };
  updateSettingsDraftUI();
}
function syncSettingsDraftFromUI() {
  if (!state.settingsDraft) return;
  state.settingsDraft.sfx = !!$("toggle-sfx")?.checked;
  state.settingsDraft.vibrate = !!$("toggle-vibrate")?.checked;
}
function restoreCommittedAudio() {
  applyAudioVolumes(state.settings);
  if (state.settings.bgmLevel <= 0) stopAllBgm();
  else syncBgmForPage(document.querySelector(".base-page.active")?.id?.replace("page-","") || "home");
}
function discardSettingsDraft() {
  if (!state.settingsDraft) return;
  state.settingsDraft = null;
  updateSettingsDraftUI();
  restoreCommittedAudio();
}
function previewBgmLevel() {
  const draft = state.settingsDraft;
  if (!draft) return;
  applyAudioVolumes(draft);
  if (draft.bgmLevel <= 0) {
    stopAllBgm();
    return;
  }
  const current = state.currentBgm && $(state.currentBgm);
  if (current && current.paused) {
    try {
      const promise = current.play();
      if (promise && typeof promise.catch === "function") promise.catch(() => {});
    } catch (e) {}
  }
}
function adjustBgmLevel(delta) {
  prepareAudio();
  const target = state.settingsDraft || state.settings;
  target.bgmLevel = Math.max(0, Math.min(5, Number(target.bgmLevel ?? 3) + delta));
  updateSettingsDraftUI();
  if (state.settingsDraft) {
    previewBgmLevel();
    return;
  }
  applyAudioVolumes();
  saveJSON(STORAGE_KEYS.settings, state.settings);
  if (state.settings.bgmLevel <= 0) stopAllBgm();
  else syncBgmForPage(document.querySelector(".base-page.active")?.id?.replace("page-","") || "home");
}
function loadSettings() {
  const fallback = { bgmLevel: 3, sfx: true, vibrate: true };
  const stored = readJSON(STORAGE_KEYS.settings);
  const raw = stored.ok && stored.exists ? stored.value : fallback;
  const shouldMigrateLegacyBgm = stored.ok && stored.exists && isPlainObject(raw) &&
    !Object.prototype.hasOwnProperty.call(raw, "bgmLevel") &&
    (raw.bgm === false || raw.bgm === true);
  state.settings = normalizeSettings(raw);
  state.settingsDraft = null;
  updateBgmVolumeUI();
  $("toggle-sfx").checked = !!state.settings.sfx;
  $("toggle-vibrate").checked = !!state.settings.vibrate;
  if (shouldMigrateLegacyBgm) saveJSON(STORAGE_KEYS.settings, state.settings);
}
function saveSettings() {
  if (state.settingsDraft) syncSettingsDraftFromUI();
  else {
    state.settings.sfx = !!$("toggle-sfx")?.checked;
    state.settings.vibrate = !!$("toggle-vibrate")?.checked;
  }
  state.settings = normalizeSettings(state.settingsDraft || state.settings);
  state.settingsDraft = null;
  saveJSON(STORAGE_KEYS.settings, state.settings);
  restoreCommittedAudio();
  updateSettingsDraftUI();
  setFeedback("설정을 저장했어요.", "");
  maybeBeep("button");
}

const CANONICAL_QUESTION_FIELDS = ["id", "examType", "stage", "crop", "item", "answer", "unit", "label"];

function hasQuestionTuple(q) {
  return isPlainObject(q) &&
    isNonEmptyString(q.examType) &&
    isNonEmptyString(q.stage) &&
    isNonEmptyString(q.crop) &&
    isNonEmptyString(q.item);
}

function findCanonicalQuestion(q) {
  if (!hasQuestionTuple(q)) return null;
  const crop = q.crop === "트리티케일(사료용)" ? "라이밀(트리티케일)" : q.crop;
  const item = q.item === "피해출현율" ? "메벼출현율" : q.item;
  return QUESTION_SET.find(candidate =>
    candidate.examType === q.examType &&
    candidate.stage === q.stage &&
    candidate.crop === crop &&
    candidate.item === item
  ) || null;
}

function normalizeWrongNoteRecords(loaded) {
  let migrated = false;
  let hasMalformedItems = false;
  const seen = new Set();
  const active = [];
  const preserved = [];
  const records = [];

  loaded.forEach(q => {
    if (!hasQuestionTuple(q)) {
      hasMalformedItems = true;
      preserved.push(q);
      records.push(q);
      return;
    }
    const current = findCanonicalQuestion(q);
    if (!current || !isAllowedQuestion(current)) {
      if (!isStoredQuestion(q)) hasMalformedItems = true;
      preserved.push(q);
      records.push(q);
      return;
    }
    if (!isStoredQuestion(q)) hasMalformedItems = true;
    if (seen.has(current.id)) {
      migrated = true;
      return;
    }
    seen.add(current.id);
    active.push(current);
    records.push(current);
    if (CANONICAL_QUESTION_FIELDS.some(field => current[field] !== q[field])) migrated = true;
  });

  return { active, preserved, records, migrated, hasMalformedItems };
}

function applyWrongNoteSnapshot(snapshot) {
  state.wrongNotes = snapshot.active;
  state.preservedWrongNotes = snapshot.preserved;
}

function getWrongNoteIntentKey(record) {
  const canonical = findCanonicalQuestion(record);
  if (canonical && isAllowedQuestion(canonical)) return `question:${canonical.id}`;
  if (isPlainObject(record) && isNonEmptyString(record.id)) return `stored:${record.id}`;
  try {
    return `raw:${JSON.stringify(record)}`;
  } catch (e) {
    return `raw:${String(record)}`;
  }
}

function filterPendingWrongNoteClear(records) {
  const intent = state.pendingWrongNoteClear;
  if (!intent) return records;
  if (intent.all) return [];
  const keys = new Set(intent.keys);
  return records.filter(record => !keys.has(getWrongNoteIntentKey(record)));
}

function queuePendingWrongNoteAdd(canonical) {
  if (state.pendingWrongNoteAdds.some(item => item.id === canonical.id)) return;
  state.pendingWrongNoteAdds.unshift(canonical);
}

function applyLocalWrongNoteIntent() {
  const local = normalizeWrongNoteRecords([
    ...state.pendingWrongNoteAdds,
    ...state.wrongNotes,
    ...state.preservedWrongNotes
  ]);
  applyWrongNoteSnapshot(local);
}

function loadWrongNotes() {
  state.pendingWrongNoteAdds = [];
  state.pendingWrongNoteClear = null;
  const stored = readJSON(STORAGE_KEYS.wrongs);
  if (!stored.ok || !stored.exists || !Array.isArray(stored.value)) {
    state.wrongNotes = [];
    state.preservedWrongNotes = [];
    return;
  }
  const snapshot = normalizeWrongNoteRecords(stored.value);
  applyWrongNoteSnapshot(snapshot);

  if (snapshot.migrated && !snapshot.hasMalformedItems) saveWrongNotes(snapshot.records);
}
function saveWrongNotes(records = state.wrongNotes) {
  return saveJSON(STORAGE_KEYS.wrongs, records);
}
function loadBestRecord() {
  const fallback = { correct: 0, tries: 0, acc: 0 };
  const loaded = loadJSON(STORAGE_KEYS.best, fallback);
  state.timeAttackBest = isValidBestRecord(loaded) ? loaded : fallback;
}
function saveBestRecord() {
  saveJSON(STORAGE_KEYS.best, state.timeAttackBest);
}
function loadCompletionBest() {
  const stored = readJSON(STORAGE_KEYS.completionBest);
  state.bestCompletion = stored.ok && stored.exists && isValidCompletionBest(stored.value)
    ? stored.value
    : null;
}
function isCheckpointRunCompleted(runId) {
  return isNonEmptyString(runId) && state.bestCompletion?.completedRunId === runId;
}
function saveCompletionBest(record = state.bestCompletion) {
  return saveJSON(STORAGE_KEYS.completionBest, record);
}
function isBetterCompletionRecord(candidate, previous) {
  if (!isValidCompletionBest(candidate)) return false;
  if (!isValidCompletionBest(previous)) return true;
  if (candidate.elapsedSeconds !== previous.elapsedSeconds) {
    return candidate.elapsedSeconds < previous.elapsedSeconds;
  }
  return candidate.tries < previous.tries;
}
function isSameCompletionRecord(first, second) {
  return isValidCompletionBest(first) && isValidCompletionBest(second) &&
    first.elapsedSeconds === second.elapsedSeconds && first.tries === second.tries;
}
function refreshCompletionBestBeforeWrite() {
  const stored = readJSON(STORAGE_KEYS.completionBest);
  if (!stored.ok) return { allowWrite: false };
  if (!stored.exists) return { allowWrite: true, exists: false, record: null };
  if (!isValidCompletionBest(stored.value)) return { allowWrite: false };
  if (isBetterCompletionRecord(stored.value, state.bestCompletion)) {
    state.bestCompletion = stored.value;
  }
  return { allowWrite: true, exists: true, record: stored.value };
}
function persistCompletionBest(candidate) {
  const latest = refreshCompletionBestBeforeWrite();
  const candidateIsBetter = isBetterCompletionRecord(candidate, state.bestCompletion);
  if (candidateIsBetter) state.bestCompletion = candidate;
  const desired = state.bestCompletion;

  if (!latest.allowWrite) {
    return { isNew: false, saveFailed: candidateIsBetter, persisted: false };
  }
  const needsWrite = isValidCompletionBest(desired) &&
    (!latest.exists || isBetterCompletionRecord(desired, latest.record));
  if (!needsWrite) {
    return { isNew: false, saveFailed: false, persisted: true };
  }
  if (!saveCompletionBest(desired)) {
    return { isNew: false, saveFailed: candidateIsBetter, persisted: false };
  }

  let verified = readJSON(STORAGE_KEYS.completionBest);
  if (!verified.ok || !verified.exists || !isValidCompletionBest(verified.value)) {
    return { isNew: false, saveFailed: candidateIsBetter, persisted: false };
  }
  if (isBetterCompletionRecord(verified.value, state.bestCompletion)) {
    state.bestCompletion = verified.value;
  } else if (isBetterCompletionRecord(state.bestCompletion, verified.value)) {
    const retryRecord = state.bestCompletion;
    if (!saveCompletionBest(retryRecord)) {
      return { isNew: false, saveFailed: candidateIsBetter, persisted: false };
    }
    verified = readJSON(STORAGE_KEYS.completionBest);
    if (!verified.ok || !verified.exists || !isValidCompletionBest(verified.value)) {
      return { isNew: false, saveFailed: candidateIsBetter, persisted: false };
    }
    if (isBetterCompletionRecord(verified.value, state.bestCompletion)) {
      state.bestCompletion = verified.value;
    }
  }

  const persistedRecord = verified.value;
  const persistedAtLeastAsGood = !isBetterCompletionRecord(state.bestCompletion, persistedRecord);
  return {
    isNew: candidateIsBetter && persistedAtLeastAsGood && isSameCompletionRecord(candidate, persistedRecord),
    saveFailed: candidateIsBetter && !persistedAtLeastAsGood,
    persisted: persistedAtLeastAsGood
  };
}
function reconcileCompletionBestFromStorage(newValue) {
  let incoming;
  try {
    incoming = typeof newValue === "string" ? JSON.parse(newValue) : null;
  } catch (e) {
    return;
  }
  if (!isValidCompletionBest(incoming)) return;

  const stored = readJSON(STORAGE_KEYS.completionBest);
  if (!stored.ok || (stored.exists && !isValidCompletionBest(stored.value))) return;
  let best = state.bestCompletion;
  if (isBetterCompletionRecord(incoming, best)) best = incoming;
  if (stored.exists && isBetterCompletionRecord(stored.value, best)) best = stored.value;
  state.bestCompletion = best;
  if (isValidCompletionBest(best) && (!stored.exists || isBetterCompletionRecord(best, stored.value))) {
    saveCompletionBest(best);
  }
  if ($("page-result")?.classList.contains("active")) {
    renderCompletionBestResult();
    if (isBetterCompletionRecord(state.bestCompletion, state.resultCompletionRecord)) {
      $("new-badge").classList.add("hidden");
    }
  }
}
function markCompletedRunInBest(runId) {
  if (!isNonEmptyString(runId)) return false;
  const stored = readJSON(STORAGE_KEYS.completionBest);
  if (!stored.ok || !stored.exists || !isValidCompletionBest(stored.value)) return false;
  const marker = { ...stored.value, completedRunId: runId };
  if (!saveCompletionBest(marker)) return false;
  const verified = readJSON(STORAGE_KEYS.completionBest);
  const marked = verified.ok && verified.exists && isValidCompletionBest(verified.value) &&
    verified.value.completedRunId === runId;
  if (marked) state.bestCompletion = verified.value;
  return marked;
}
function readTimeCheckpointSnapshot() {
  const stored = readJSON(STORAGE_KEYS.inProgress);
  if (!stored.ok) return { ok: false, exists: false, checkpoint: null, terminal: null };
  if (!stored.exists) return { ok: true, exists: false, checkpoint: null, terminal: null };
  return {
    ok: true,
    exists: true,
    checkpoint: normalizeTimeCheckpoint(stored.value),
    terminal: normalizeTimeCheckpointTerminal(stored.value)
  };
}
function loadTimeCheckpoint() {
  const stored = readTimeCheckpointSnapshot();
  state.timeCheckpoint = stored.ok && !isCheckpointRunCompleted(stored.checkpoint?.runId)
    ? stored.checkpoint
    : null;
  return state.timeCheckpoint;
}
function buildTimeCheckpoint(phase = state.runPhase) {
  const questionId = state.curQuestion?.id || "";
  const candidate = {
    version: TIME_CHECKPOINT_VERSION,
    runId: state.runId,
    correct: state.correct,
    tries: state.tries,
    wrong: state.wrong,
    combo: state.combo,
    maxCombo: state.maxCombo,
    elapsedMs: getElapsedMilliseconds(),
    phase,
    questionId,
    recentWrongIds: state.recentWrongs.map(q => q.id)
  };
  return isValidTimeCheckpoint(candidate) ? candidate : null;
}
function saveTimeCheckpoint(phase = state.runPhase) {
  if (state.mode !== "time" || state.runEnded || !state.stopwatchStarted) return false;
  const checkpoint = buildTimeCheckpoint(phase);
  if (!checkpoint) return false;
  state.runPhase = phase;
  state.timeCheckpoint = checkpoint;
  const stored = readTimeCheckpointSnapshot();
  if (!stored.ok) return false;
  if (stored.exists && !stored.terminal && !isCheckpointRunCompleted(stored.checkpoint?.runId) &&
      (!stored.checkpoint || stored.checkpoint.runId !== checkpoint.runId)) return false;
  return saveJSON(STORAGE_KEYS.inProgress, checkpoint);
}
function invalidateOwnedTimeCheckpoint(runId) {
  if (!isNonEmptyString(runId)) return { invalidated: false, conflict: false, terminal: false };
  const observed = readTimeCheckpointSnapshot();
  if (!observed.ok) return { invalidated: false, conflict: false, terminal: false };
  if (!observed.exists) return { invalidated: true, conflict: false, terminal: false };
  if (observed.terminal) {
    return observed.terminal.runId === runId
      ? { invalidated: true, conflict: false, terminal: true }
      : { invalidated: false, conflict: true, terminal: false };
  }
  if (!observed.checkpoint || observed.checkpoint.runId !== runId) {
    return { invalidated: false, conflict: true, terminal: false };
  }

  const verified = readTimeCheckpointSnapshot();
  if (!verified.ok || !verified.exists || !verified.checkpoint || verified.checkpoint.runId !== runId) {
    return { invalidated: !verified.exists, conflict: verified.exists, terminal: false };
  }
  if (removeJSON(STORAGE_KEYS.inProgress)) {
    return { invalidated: true, conflict: false, terminal: false };
  }

  const afterRemove = readTimeCheckpointSnapshot();
  if (!afterRemove.ok) return { invalidated: false, conflict: false, terminal: false };
  if (!afterRemove.exists) return { invalidated: true, conflict: false, terminal: false };
  if (afterRemove.terminal) {
    return afterRemove.terminal.runId === runId
      ? { invalidated: true, conflict: false, terminal: true }
      : { invalidated: false, conflict: true, terminal: false };
  }
  if (!afterRemove.checkpoint || afterRemove.checkpoint.runId !== runId) {
    return { invalidated: false, conflict: true, terminal: false };
  }
  const terminal = saveJSON(STORAGE_KEYS.inProgress, {
    version: TIME_CHECKPOINT_VERSION,
    runId,
    terminal: true
  });
  return { invalidated: terminal, conflict: false, terminal };
}
function clearTimeCheckpoint(runId = state.runId || state.timeCheckpoint?.runId) {
  if (state.timeCheckpoint?.runId === runId) state.timeCheckpoint = null;
  return invalidateOwnedTimeCheckpoint(runId).invalidated;
}
function refreshTimeCheckpointForIntro() {
  const stored = readTimeCheckpointSnapshot();
  if (!stored.ok) return state.timeCheckpoint;
  if (stored.checkpoint && !isCheckpointRunCompleted(stored.checkpoint.runId)) state.timeCheckpoint = stored.checkpoint;
  else if (stored.checkpoint && isCheckpointRunCompleted(stored.checkpoint.runId)) state.timeCheckpoint = null;
  else if (stored.terminal && state.timeCheckpoint?.runId === stored.terminal.runId) state.timeCheckpoint = null;
  else if (!stored.exists && !isValidTimeCheckpoint(state.timeCheckpoint)) state.timeCheckpoint = null;
  return state.timeCheckpoint;
}
function getCheckpointSummary(checkpoint = state.timeCheckpoint) {
  if (!isValidTimeCheckpoint(checkpoint)) return "";
  return `정답 ${checkpoint.correct} / ${COMPLETION_TARGET} · 플레이 시간 ${formatTime(Math.floor(checkpoint.elapsedMs / 1000))}`;
}
function renderTimeIntro({ refresh = true } = {}) {
  if (refresh) refreshTimeCheckpointForIntro();
  const checkpoint = state.timeCheckpoint;
  const resumable = isValidTimeCheckpoint(checkpoint);
  show("time-resume-card", resumable);
  show("btn-time-intro-start", !resumable);
  show("time-resume-actions", resumable);
  if (resumable) setText("time-resume-summary", getCheckpointSummary(checkpoint));
}

function renderPracticeOptions() {
  const examGrid = $("examtype-grid");
  const stageGrid = $("stage-grid");
  const cropGrid = $("crop-grid");
  examGrid.innerHTML = "";
  if (stageGrid) stageGrid.innerHTML = "";
  cropGrid.innerHTML = "";

  EXAM_TYPES.forEach(type => {
    const label = document.createElement("label");
    label.className = "check-item";
    label.innerHTML = `<input type="checkbox" class="exam-check" value="${type}" checked><span>${type}</span>`;
    examGrid.appendChild(label);
  });

  STAGE_GROUPS.forEach(stage => {
    const label = document.createElement("label");
    label.className = "check-item stage-item";
    label.innerHTML = `<input type="checkbox" class="stage-check" value="${stage}" checked><span>${stage}</span>`;
    stageGrid.appendChild(label);
  });

  CROPS.forEach(crop => {
    const label = document.createElement("label");
    label.className = "check-item";
    const cropText = crop === "라이밀(트리티케일)" ? "라이밀<br>(트리티케일)" : crop;
    label.innerHTML = `<input type="checkbox" class="crop-check" value="${crop}" checked><span>${cropText}</span>`;
    cropGrid.appendChild(label);
  });
}

function getSelectedValues(selector) {
  return [...document.querySelectorAll(selector)].filter(el => el.checked).map(el => el.value);
}

function stageMatchesSelectedGroups(stage, selectedGroups) {
  return selectedGroups.some(group => (STAGE_GROUP_MAP[group] || [group]).includes(stage));
}

function validatePracticeSelection() {
  const selectedExamTypes = getSelectedValues(".exam-check");
  const selectedStageGroups = getSelectedValues(".stage-check");
  const selectedCrops = getSelectedValues(".crop-check");
  const messages = [];
  if (selectedExamTypes.length === 0) messages.push("검사종류는 최소 1개 이상 선택해야 해요.");
  if (selectedStageGroups.length === 0) messages.push("채종단계는 최소 1개 이상 선택해야 해요.");
  if (selectedCrops.length === 0) messages.push("작물은 최소 1개 이상 선택해야 해요.");

  const previewPool = messages.length ? [] : filterQuestions(selectedExamTypes, selectedStageGroups, selectedCrops);
  if (!messages.length && previewPool.length === 0) messages.push("선택한 범위에 출제할 문제가 없어요. 범위를 다시 선택해 주세요.");

  if (messages.length) {
    $("setup-note").innerHTML = messages.join("<br>");
    $("setup-note").classList.add("error");
    return false;
  }
  $("setup-note").textContent = "선택한 범위 안에서 무제한으로 반복 출제됩니다.";
  $("setup-note").classList.remove("error");
  state.selectedExamTypes = selectedExamTypes;
  state.selectedStageGroups = selectedStageGroups;
  state.selectedCrops = selectedCrops;
  return true;
}

function filterQuestions(examTypes, stageGroups, crops) {
  return QUESTION_SET.filter(q =>
    isAllowedQuestion(q) &&
    examTypes.includes(q.examType) &&
    crops.includes(q.crop) &&
    stageMatchesSelectedGroups(q.stage, stageGroups)
  );
}

function clearRunHandles() {
  clearInterval(state.timeInterval);
  clearTimeout(state.nextTimeout);
  clearTimeout(state.ngTimeout);
  clearInterval(state.countdownTimer);
  state.spinIntervals.forEach(iv => clearInterval(iv));
  state.timeInterval = null;
  state.nextTimeout = null;
  state.ngTimeout = null;
  state.countdownTimer = null;
  state.spinIntervals = [];
  state.spinning = false;
  const overlay = $("countdown-overlay");
  if (overlay) overlay.classList.remove("active");
}

function resetRunCommon() {
  clearRunHandles();
  state.runId = null;
  state.curQuestion = null;
  state.spinning = false;
  state.scored = false;
  state.correct = 0;
  state.wrong = 0;
  state.combo = 0;
  state.maxCombo = 0;
  state.tries = 0;
  state.recentWrongs = [];
  state.runEnded = false;
  state.elapsedMs = 0;
  state.completionElapsedSeconds = null;
  state.resultCompletionRecord = null;
  state.stopwatchStarted = false;
  state.stopwatchRunning = false;
  state.stopwatchStartedAt = null;
  state.runPhase = "idle";
  $("ans").value = "";
  $("ans").className = "ans-input";
  $("ans").setAttribute("aria-invalid", "false");
  $("ans").placeholder = "숫자 입력";
  setText("answer-guide", "");
  show("input-row", false);
  show("mobile-keypad", false);
  show("btn-submit", false);
  show("btn-stop", false);
  setFeedback("", "");
  $("ans").setAttribute("aria-invalid", "false");
  setQuestionText("문제를 불러오는 중...");
  setText("answer-guide", "");
  resetSlots();
}

function resetSlots() {
  setText("play-examtype-chip", "검사종류");
  $("play-examtype-chip").classList.remove("spinning");
  setText("shell-hint", "STOP으로 확정");
  renderSlotValue($("slot-stage-val"), "?");
  renderSlotValue($("slot-crop-val"), "?");
  renderSlotValue($("slot-item-val"), "?");
  ["slot-stage","slot-crop","slot-item"].forEach(id => {
    $(id).classList.remove("spinning","stopped");
  });
}
function getAnswerGuideText(q) {
  return "";
}

function getAnswerPlaceholder(q) {
  return "숫자 입력";
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatQuestionHTML(q) {
  return `<span class="q-label">질문</span><span class="q-line q-context"><strong>${escapeHTML(q.examType)}</strong> · <strong>${escapeHTML(q.stage)}</strong> · <strong>${escapeHTML(q.crop)}</strong></span><span class="q-line q-ask"><span class="q-item">${escapeHTML(q.item)}</span> 기준값은?</span>`;
}

function showLatestTimeCheckpointIntro() {
  refreshTimeCheckpointForIntro();
  renderTimeIntro({ refresh: false });
  if (!$('page-time-intro')?.classList.contains('active')) openModal("time-intro");
}

function startTimeMode({ takeoverRunId = null } = {}) {
  const stored = readTimeCheckpointSnapshot();
  if (stored.ok && stored.checkpoint && !isCheckpointRunCompleted(stored.checkpoint.runId)) {
    if (!isNonEmptyString(takeoverRunId) || stored.checkpoint.runId !== takeoverRunId) {
      state.timeCheckpoint = stored.checkpoint;
      showLatestTimeCheckpointIntro();
      return false;
    }
    const takeover = invalidateOwnedTimeCheckpoint(takeoverRunId);
    if (!takeover.invalidated) {
      showLatestTimeCheckpointIntro();
      return false;
    }
  }
  prepareAudio();
  closeModal("time-intro");
  state.mode = "time";
  state.pool = QUESTION_SET.filter(isAllowedQuestion);
  resetRunCommon();
  state.runId = createRunId();
  state.timeCheckpoint = null;
  updatePlayHeader();
  showPage("play");
  state.runPhase = "countdown";
  startCountdown(3, "실전모드 시작", () => {
    maybeBeep("start");
    startStopwatch();
    startRound();
  });
  return true;
}

function resumeTimeMode() {
  let checkpoint = state.timeCheckpoint;
  if (!isValidTimeCheckpoint(checkpoint) || isCheckpointRunCompleted(checkpoint.runId)) {
    state.timeCheckpoint = null;
    renderTimeIntro();
    return false;
  }
  const stored = readTimeCheckpointSnapshot();
  if (stored.ok && (!stored.checkpoint || stored.checkpoint.runId !== checkpoint.runId)) {
    state.timeCheckpoint = stored.checkpoint;
    renderTimeIntro({ refresh: false });
    return false;
  }
  const question = findQuestionById(checkpoint.questionId);
  if (!question) {
    state.timeCheckpoint = null;
    renderTimeIntro();
    return false;
  }
  prepareAudio();
  closeModal("time-intro");
  state.mode = "time";
  state.pool = QUESTION_SET.filter(isAllowedQuestion);
  resetRunCommon();
  state.runId = checkpoint.runId;
  state.correct = checkpoint.correct;
  state.tries = checkpoint.tries;
  state.wrong = checkpoint.wrong;
  state.elapsedMs = checkpoint.elapsedMs;
  state.recentWrongs = checkpoint.recentWrongIds.map(findQuestionById).filter(Boolean);
  state.combo = checkpoint.combo;
  state.maxCombo = checkpoint.maxCombo;
  state.curQuestion = question;
  state.runPhase = checkpoint.phase;
  updatePlayHeader();
  showPage("play");
  startStopwatch(checkpoint.elapsedMs);
  if (checkpoint.phase === "spin") {
    startRound(question);
  } else if (checkpoint.phase === "answer") {
    showCurrentQuestionForAnswer();
    saveTimeCheckpoint("answer");
  } else {
    startRound();
  }
  return true;
}

function startNewTimeModeFromCheckpoint() {
  const checkpoint = state.timeCheckpoint;
  if (!isValidTimeCheckpoint(checkpoint)) {
    startTimeMode();
    return;
  }
  const summary = `${checkpoint.correct}/${COMPLETION_TARGET} · ${formatTime(Math.floor(checkpoint.elapsedMs / 1000))}`;
  if (!confirm(`진행 중인 기록(${summary})을 삭제하고 새로 시작할까요?`)) return;
  startTimeMode({ takeoverRunId: checkpoint.runId });
}

function startPracticeMode() {
  prepareAudio();
  if (!validatePracticeSelection()) return;
  state.mode = "practice";
  state.pool = filterQuestions(state.selectedExamTypes, state.selectedStageGroups, state.selectedCrops);
  resetRunCommon();
  updatePlayHeader();
  closeModal("practice-setup");
  showPage("play");
  startRound();
}

function startWrongPracticeMode() {
  prepareAudio();
  if (state.wrongNotes.length === 0) {
    alert("오답노트가 비어 있어요.");
    return;
  }
  state.mode = "wrong-practice";
  state.pool = state.wrongNotes.filter(isAllowedQuestion);
  state.selectedExamTypes = [...new Set(state.pool.map(q => q.examType))];
  state.selectedStageGroups = STAGE_GROUPS.filter(group => state.pool.some(q => stageMatchesSelectedGroups(q.stage, [group])));
  state.selectedCrops = [...new Set(state.pool.map(q => q.crop))];
  resetRunCommon();
  updatePlayHeader();
  closeModal("wrong");
  showPage("play");
  startRound();
}

function summarizeSelection(selected, allOptions, allLabel, maxItems) {
  const items = Array.isArray(selected) ? selected.filter(Boolean) : [];
  const all = Array.isArray(allOptions) ? allOptions.filter(Boolean) : [];
  if (!items.length) return "";
  const isAll = all.length > 0 && items.length === all.length && all.every(item => items.includes(item));
  if (isAll) return allLabel;
  if (items.length > maxItems) return `${items.slice(0, maxItems).join("/")} 외 ${items.length - maxItems}`;
  return items.join("/");
}

function updatePlayHeader() {
  const meta = MODE_META[state.mode] || MODE_META.time;
  const pagePlay = $("page-play");
  if (pagePlay) {
    pagePlay.classList.remove("mode-time", "mode-practice", "mode-wrong-practice");
    pagePlay.classList.add(`mode-${state.mode || "time"}`);
  }
  setText("play-mode-en", meta.en);
  setText("play-mode-title", meta.title);
  $("play-mode-pill").textContent = meta.pill;
  $("play-mode-pill").classList.remove("hidden");
  const sub = $("play-mode-sub");
  if (state.mode === "practice") {
    const examLine = summarizeSelection(state.selectedExamTypes, EXAM_TYPES, "전체검사", 2);
    const stageLine = summarizeSelection(state.selectedStageGroups, STAGE_GROUPS, "전체단계", 3);
    const cropLine = summarizeSelection(state.selectedCrops, CROPS, "전체작물", 4);
    sub.innerHTML = `<span class="range-label">선택 범위</span> <span class="range-line">${escapeHTML(examLine)} · ${escapeHTML(stageLine)} · ${escapeHTML(cropLine)}</span>`;
  } else if (state.mode === "wrong-practice") {
    sub.innerHTML = `<span class="range-label">오답 범위</span> <span class="range-line">${escapeHTML(meta.sub || "오답노트에 저장된 문제만 출제")}</span>`;
  } else {
    sub.textContent = meta.sub || "";
  }
  updateStatus();
}

function updateStatus() {
  const pbar = $("pbar");
  const pbarTrack = pbar?.parentElement;
  if (pbarTrack) pbarTrack.classList.toggle("time-mode", state.mode === "time");
  if (state.mode === "time") {
    setText("status-1-lbl", "경과 시간");
    setText("status-1-val", formatTime(getElapsedSeconds()));
    setText("status-2-lbl", "진행도");
    setText("status-2-val", `${state.correct} / ${COMPLETION_TARGET}`);
    const progressPct = Math.max(0, Math.min(100, (state.correct / COMPLETION_TARGET) * 100));
    pbar.style.position = "absolute";
    pbar.style.right = "auto";
    pbar.style.left = "0";
    pbar.style.top = "0";
    pbar.style.bottom = "0";
    pbar.style.width = `${progressPct}%`;
    pbar.style.marginLeft = "0";
    pbar.style.transformOrigin = "left center";
  } else {
    setText("status-1-lbl", "맞힘 수");
    setText("status-1-val", String(state.correct));
    setText("status-2-lbl", "틀림 수");
    setText("status-2-val", String(state.wrong));
    pbar.style.position = "relative";
    pbar.style.left = "0";
    pbar.style.right = "auto";
    pbar.style.top = "auto";
    pbar.style.bottom = "auto";
    pbar.style.marginLeft = "0";
    pbar.style.transformOrigin = "left center";
    pbar.style.width = state.pool.length ? `${Math.min(100, (state.correct / Math.max(10, state.correct + state.wrong + 1)) * 100)}%` : "0%";
  }
}

function startCountdown(sec, label, onDone) {
  const overlay = $("countdown-overlay");
  const num = $("countdown-num");
  const lbl = $("countdown-lbl");
  overlay.classList.add("active");
  lbl.textContent = label;
  let current = sec;
  num.textContent = current;
  state.countdownTimer = setInterval(() => {
    current -= 1;
    if (current <= 0) {
      clearInterval(state.countdownTimer);
      overlay.classList.remove("active");
      onDone();
    } else {
      num.textContent = current;
      maybeBeep("tick");
    }
  }, 700);
}

function getClockNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getElapsedMilliseconds(at = getClockNow()) {
  const activeMs = state.stopwatchRunning && state.stopwatchStartedAt !== null
    ? Math.max(0, at - state.stopwatchStartedAt)
    : 0;
  return Math.max(0, state.elapsedMs + activeMs);
}

function getElapsedSeconds() {
  if (state.completionElapsedSeconds !== null) return state.completionElapsedSeconds;
  return Math.floor(getElapsedMilliseconds() / 1000);
}

function resumeStopwatch() {
  if (!state.stopwatchStarted || state.stopwatchRunning || state.runEnded || document.hidden) return;
  state.stopwatchStartedAt = getClockNow();
  state.stopwatchRunning = true;
  clearInterval(state.timeInterval);
  state.timeInterval = setInterval(updateStatus, 250);
}

function pauseStopwatch() {
  if (!state.stopwatchRunning || state.stopwatchStartedAt === null) return;
  state.elapsedMs = getElapsedMilliseconds();
  state.stopwatchStartedAt = null;
  state.stopwatchRunning = false;
  clearInterval(state.timeInterval);
  state.timeInterval = null;
  updateStatus();
}

function startStopwatch(initialElapsedMs = 0) {
  state.elapsedMs = Number.isFinite(initialElapsedMs) && initialElapsedMs >= 0 ? initialElapsedMs : 0;
  state.completionElapsedSeconds = null;
  state.stopwatchStarted = true;
  state.stopwatchRunning = false;
  state.stopwatchStartedAt = null;
  resumeStopwatch();
  updateStatus();
}

function freezeStopwatch() {
  if (state.stopwatchRunning && state.stopwatchStartedAt !== null) {
    state.elapsedMs = getElapsedMilliseconds();
  }
  state.stopwatchStartedAt = null;
  state.stopwatchRunning = false;
  state.stopwatchStarted = false;
  clearInterval(state.timeInterval);
  state.timeInterval = null;
  state.completionElapsedSeconds = Math.floor(Math.max(0, state.elapsedMs) / 1000);
  return state.completionElapsedSeconds;
}

function handleVisibilityChange() {
  if (state.mode !== "time" || state.runEnded || !state.stopwatchStarted) return;
  if (document.hidden) {
    pauseStopwatch();
    saveTimeCheckpoint();
  }
  else resumeStopwatch();
}

function getStageWeight(stage) {
  if (["보급종", "보급종포", "채종포 1세대"].includes(stage)) return 3;
  if (["원종", "원종포"].includes(stage)) return 1.5;
  if (["원원종", "원원종포"].includes(stage)) return 1;
  return 1;
}

function getCropWeight(crop) {
  return ({
    "벼": 3,
    "콩": 3,
    "보리": 2.5,
    "밀": 2.5,
    "팥": 1,
    "라이밀(트리티케일)": 1
  })[crop] || 1;
}

function getQuestionWeight(q) {
  return Math.max(0.1, getStageWeight(q.stage) * getCropWeight(q.crop));
}

function weightedPick(source) {
  const total = source.reduce((sum, q) => sum + getQuestionWeight(q), 0);
  if (!Number.isFinite(total) || total <= 0) return source[Math.floor(Math.random() * source.length)];
  let cursor = Math.random() * total;
  for (const q of source) {
    cursor -= getQuestionWeight(q);
    if (cursor <= 0) return q;
  }
  return source[source.length - 1];
}

function pickQuestion() {
  if (!state.pool.length) return null;
  const candidates = state.pool.filter(q => !state.curQuestion || q.id !== state.curQuestion.id);
  const source = candidates.length ? candidates : state.pool;
  return weightedPick(source);
}

function setMobileControlsActive(active, mode = "submit") {
  const mobile = isMobileView();
  const zone = $("answer-zone");
  if (!zone) return;
  zone.classList.toggle("mode-stop", mobile && mode === "stop");
  zone.classList.toggle("mode-submit", mobile && mode === "submit");
  zone.classList.toggle("is-disabled", mobile && !active);
  if (mobile) {
    const isSubmit = mode === "submit";
    show("input-row", isSubmit);
    show("mobile-keypad", isSubmit);
    show("btn-submit", isSubmit);
    show("btn-stop", mode === "stop");
    $("btn-submit").disabled = !active || !isSubmit;
    $("ans").readOnly = true;
    $("ans").blur();
  } else {
    zone.classList.remove("mode-stop", "mode-submit", "is-disabled");
    $("btn-submit").disabled = !active;
    $("ans").readOnly = false;
  }
}

function syncPlayControlsForViewport() {
  const pagePlay = $("page-play");
  if (!pagePlay?.classList.contains("active") || state.runEnded || !state.curQuestion) return;
  const mobile = isMobileView();

  if (state.spinning || state.runPhase === "spin") {
    setMobileControlsActive(true, "stop");
    show("input-row", false);
    show("mobile-keypad", false);
    show("btn-submit", false);
    show("btn-stop", true);
    return;
  }

  if (!state.scored) {
    setMobileControlsActive(true, "submit");
    show("input-row", true);
    show("mobile-keypad", mobile);
    show("btn-submit", true);
    show("btn-stop", false);
    return;
  }

  setMobileControlsActive(false, "submit");
  show("input-row", false);
  show("mobile-keypad", mobile);
  show("btn-submit", mobile);
  show("btn-stop", false);
}

function formatFeedback(q, isCorrect, combo = state.combo) {
  const word = isCorrect ? "정답!" : "오답!";
  const criteria = `${q.item} ${q.stage} ${q.answer}${q.unit || ""}`;
  const streak = isCorrect && combo >= 3
    ? `<span class="streak">🔥 ${combo}연속!</span>`
    : "";
  return `<span class="result-word">${word}</span><span class="criteria">${escapeHTML(criteria)}</span>${streak}`;
}

function startRound(restoredQuestion = null) {
  if (state.runEnded) return;
  state.scored = false;
  state.curQuestion = restoredQuestion || pickQuestion();
  if (!state.curQuestion) return;
  setText("play-examtype-chip", state.curQuestion.examType);
  $("play-examtype-chip").classList.add("spinning");
  setText("shell-hint", "STOP으로 확정");
  $("ans").value = "";
  $("ans").className = "ans-input";
  $("ans").setAttribute("aria-invalid", "false");
  $("ans").placeholder = "숫자 입력";
  setText("answer-guide", "");
  setFeedback("", "");
  setQuestionText("슬롯이 돌아가는 중...");
  state.runPhase = "spin";
  syncPlayControlsForViewport();
  startSpinVisual(state.curQuestion);
  saveTimeCheckpoint("spin");
}

function startSpinVisual(targetQ) {
  state.spinning = true;
  const examPool = state.mode === "time" ? EXAM_TYPES : [...new Set(state.pool.map(q => q.examType))];
  const pools = [
    [...new Set(state.pool.map(q => q.stage))],
    state.mode === "time" ? CROPS : [...new Set(state.pool.map(q => q.crop))],
    [...new Set(state.pool.map(q => q.item))]
  ];
  const slots = [
    { box: $("slot-stage"), val: $("slot-stage-val"), target: targetQ.stage, type: "text" },
    { box: $("slot-crop"), val: $("slot-crop-val"), target: targetQ.crop, type: "text" },
    { box: $("slot-item"), val: $("slot-item-val"), target: targetQ.item, type: "item" },
  ];
  state.spinIntervals.forEach(iv => clearInterval(iv));
  state.spinIntervals = [];
  let e = 0;
  state.spinIntervals.push(setInterval(() => {
    setText("play-examtype-chip", examPool[e % examPool.length] || "검사종류");
    e += 1;
  }, 115));
  slots.forEach((slot, idx) => {
    slot.box.classList.add("spinning");
    slot.box.classList.remove("stopped");
    let i = 0;
    state.spinIntervals.push(setInterval(() => {
      const text = pools[idx][i % pools[idx].length] || "?";
      renderSlotValue(slot.val, text, slot.type);
      i += 1;
    }, 95 + idx * 10));
  });
}

function stopSpin() {
  if (!state.spinning || state.runEnded) return;
  state.spinning = false;
  state.scored = false;
  state.spinIntervals.forEach(iv => clearInterval(iv));
  state.spinIntervals = [];
  state.runPhase = "answer";
  showCurrentQuestionForAnswer();
  saveTimeCheckpoint("answer");
}

function showCurrentQuestionForAnswer() {
  const q = state.curQuestion;
  if (!q) return;
  state.spinning = false;
  state.scored = false;
  setText("play-examtype-chip", q.examType);
  $("play-examtype-chip").classList.remove("spinning");
  setText("shell-hint", "");
  renderSlotValue($("slot-stage-val"), q.stage);
  renderSlotValue($("slot-crop-val"), q.crop);
  renderSlotValue($("slot-item-val"), q.item, "item");
  ["slot-stage","slot-crop","slot-item"].forEach(id => {
    $(id).classList.remove("spinning");
    $(id).classList.add("stopped");
  });
  setFeedback("", "");
  $("ans").setAttribute("aria-invalid", "false");
  setQuestionText(formatQuestionHTML(q));
  setText("answer-guide", getAnswerGuideText(q));
  $("ans").placeholder = getAnswerPlaceholder(q);
  $("unit-tag").textContent = q.unit || "%";
  syncPlayControlsForViewport();
  if (isMobileView()) $("ans").blur();
  else $("ans").focus();
}

function setQuestionText(html) {
  $("q-text").innerHTML = html;
}

function setFeedback(msg, cls) {
  const el = $("feedback");
  if (!msg) {
    el.innerHTML = "";
    el.className = "feedback hidden";
    $("answer-zone")?.classList.remove("result-feedback");
    return;
  }
  el.innerHTML = msg;
  el.className = "feedback" + (cls ? " " + cls : "");
}

function formatTime(totalSec) {
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function normalizeAnswer(raw) {
  return String(raw).replace(/%/g, "").replace(/,/g, "").trim();
}
function isValidAnswerFormat(raw) {
  return /^\d+(?:\.\d+)?$/.test(raw);
}

function isAnswerCorrect(raw, correctText) {
  const input = String(raw).trim();
  const answer = String(correctText).trim();
  if (!isValidAnswerFormat(input) || !isValidAnswerFormat(answer)) return false;
  const inputNumber = Number(input);
  const answerNumber = Number(answer);
  if (!Number.isFinite(inputNumber) || !Number.isFinite(answerNumber)) return false;
  return inputNumber === answerNumber;
}

function handleKeypadInput(key) {
  const input = $("ans");
  let value = input.value || "";
  if (key === "backspace") {
    input.value = value.slice(0, -1);
    return;
  }
  if (key === ".") {
    if (value.includes(".")) return;
    input.value = value === "" ? "0." : value + ".";
    return;
  }
  input.value = value + key;
}

function evaluateAnswer() {
  if (state.runEnded || !state.curQuestion) return;
  if (state.scored) return;
  const raw = normalizeAnswer($("ans").value);
  if (raw === "" || !isValidAnswerFormat(raw)) {
    $("ans").classList.add("ng");
    $("ans").setAttribute("aria-invalid", "true");
    clearTimeout(state.ngTimeout);
    state.ngTimeout = setTimeout(() => $("ans").classList.remove("ng"), 450);
    return;
  }
  const correctText = String(state.curQuestion.answer);
  const isCorrect = isAnswerCorrect(raw, correctText);
  state.scored = true;
  state.tries += 1;
  let completedTimeMode = false;
  if (isCorrect) {
    state.correct += 1;
    state.combo += 1;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    completedTimeMode = state.mode === "time" && state.correct >= COMPLETION_TARGET;
    if (completedTimeMode) freezeStopwatch();
    $("ans").classList.add("ok");
    $("ans").setAttribute("aria-invalid", "false");
    setFeedback(
      completedTimeMode ? "🎉 10개 정답 달성!" : formatFeedback(state.curQuestion, true, state.combo),
      "ok"
    );
    playEffect("se-correct", "correct");
    maybeVibrate([40]);
  } else {
    state.wrong += 1;
    state.combo = 0;
    $("ans").classList.add("ng");
    $("ans").setAttribute("aria-invalid", "true");
    setFeedback(formatFeedback(state.curQuestion, false), "ng");
    playEffect("se-wrong", "wrong");
    maybeVibrate([50, 70, 40]);
    pushWrongNote(state.curQuestion);
    state.recentWrongs.push(state.curQuestion);
  }
  updateStatus();
  if (completedTimeMode) {
    finishTimeMode();
    return;
  }
  if (state.mode === "time") {
    state.runPhase = "feedback";
    saveTimeCheckpoint("feedback");
  }
  $("answer-zone")?.classList.add("result-feedback");
  syncPlayControlsForViewport();
  clearTimeout(state.nextTimeout);
  state.nextTimeout = setTimeout(() => {
    if (state.runEnded) return;
    if ($("ans").classList.contains("ok")) $("ans").classList.remove("ok");
    if ($("ans").classList.contains("ng")) $("ans").classList.remove("ng");
    startRound();
  }, state.mode === "time" ? 850 : 1100);
}

function pushWrongNote(q) {
  if (!isAllowedQuestion(q)) return;
  const canonical = QUESTION_SET.find(candidate => candidate.id === q.id) || findCanonicalQuestion(q);
  if (!canonical || !isAllowedQuestion(canonical)) return;

  const stored = readJSON(STORAGE_KEYS.wrongs);
  if (!stored.ok || (stored.exists && !Array.isArray(stored.value))) {
    if (!state.wrongNotes.some(item => item.id === canonical.id)) {
      queuePendingWrongNoteAdd(canonical);
    }
    applyLocalWrongNoteIntent();
    return false;
  }

  const persistedRecords = filterPendingWrongNoteClear(stored.exists ? stored.value : []);
  const snapshot = normalizeWrongNoteRecords(persistedRecords);
  const alreadyPersisted = snapshot.active.some(item => item.id === canonical.id);
  if (!alreadyPersisted) queuePendingWrongNoteAdd(canonical);

  if (!state.pendingWrongNoteAdds.length && !state.pendingWrongNoteClear) {
    applyWrongNoteSnapshot(snapshot);
    if (snapshot.migrated && !snapshot.hasMalformedItems) return saveWrongNotes(snapshot.records);
    return true;
  }

  const mergedRecords = [...state.pendingWrongNoteAdds, ...snapshot.records];
  const merged = normalizeWrongNoteRecords(mergedRecords);
  applyWrongNoteSnapshot(merged);
  const saved = saveWrongNotes(merged.records);
  if (saved) {
    state.pendingWrongNoteAdds = [];
    state.pendingWrongNoteClear = null;
  }
  return saved;
}

function renderCompletionBestResult(saveFailed = false) {
  const best = state.bestCompletion;
  const bestAcc = best ? Math.round((COMPLETION_TARGET / best.tries) * 100) : 0;
  const label = best ? `${formatTime(best.elapsedSeconds)} · 정답률 ${bestAcc}%` : "기록 없음";
  setText("r-best", saveFailed ? `${label} · 기록 저장 실패` : label);
}

function finishTimeMode() {
  if (state.runEnded) return;
  if (state.completionElapsedSeconds === null) freezeStopwatch();
  state.runEnded = true;
  clearRunHandles();
  show("btn-stop", false);
  show("btn-submit", false);
  show("mobile-keypad", false);
  show("input-row", false);
  setFeedback("🎉 10개 정답 달성!", "ok");
  stopAllBgm();
  playEffect("se-finish", "start");
  maybeVibrate([80, 60, 120]);
  const acc = state.tries ? Math.round((COMPLETION_TARGET / state.tries) * 100) : 0;
  const candidate = {
    elapsedSeconds: state.completionElapsedSeconds,
    tries: state.tries
  };
  state.resultCompletionRecord = candidate;
  const bestResult = persistCompletionBest(candidate);
  const completedRunId = state.runId || state.timeCheckpoint?.runId;
  const checkpointInvalidated = clearTimeCheckpoint(completedRunId);
  if (!checkpointInvalidated && bestResult.persisted) markCompletedRunInBest(completedRunId);
  $("new-badge").classList.toggle("hidden", !bestResult.isNew);
  setText("r-correct", formatTime(state.completionElapsedSeconds));
  renderCompletionBestResult(bestResult.saveFailed);
  setText("r-tries", String(state.tries));
  setText("r-acc", `${acc}%`);
  setText("r-wrong", String(state.wrong));
  setText("r-max-combo", String(state.maxCombo));
  renderResultWrongs();
  showPage("result", { syncBgm: false });
  if (bestResult.isNew) launchConfetti();
  setTimeout(() => {
    if ($("page-result")?.classList.contains("active")) playBgm("bgm-home");
  }, 750);
}

function launchConfetti() {
  const host = $("page-result");
  if (!host) return;
  host.querySelectorAll(".confetti-layer").forEach(node => node.remove());
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  const colors = ["#f5c842", "#61e88e", "#6ec9ff", "#ff7d9f", "#ffffff", "#b89bff"];
  const count = 32;
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    const left = Math.random() * 100;
    const drift = (Math.random() * 2 - 1) * 24;
    const delay = Math.random() * 420;
    const duration = 2600 + Math.random() * 900;
    const size = 6 + Math.random() * 6;
    piece.style.left = `${left}%`;
    piece.style.top = `${-8 - Math.random() * 16}%`;
    piece.style.width = `${size}px`;
    piece.style.height = `${size * (0.58 + Math.random() * 0.42)}px`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty("--drift", `${drift}px`);
    piece.style.animationDelay = `${delay}ms`;
    piece.style.animationDuration = `${duration}ms`;
    layer.appendChild(piece);
  }
  host.appendChild(layer);
  setTimeout(() => layer.remove(), 4300);
}

function renderResultWrongs() {
  const list = $("result-wrong-list");
  list.innerHTML = "";
  const unique = [];
  const seen = new Set();
  state.recentWrongs.forEach(q => {
    if (!seen.has(q.id)) {
      seen.add(q.id);
      unique.push(q);
    }
  });
  if (unique.length === 0) {
    if (state.tries === 0) {
      list.innerHTML = `<div class="empty-state"><strong>푼 문제가 없어요.</strong><br>이번 판에는 아직 기록이 없어요.</div>`;
    } else {
      list.innerHTML = `<div class="empty-state"><strong>오답 없음!</strong><br>이번 판은 완벽했어요.</div>`;
    }
    return;
  }
  unique.forEach(q => {
    list.appendChild(makeNoteItem(q));
  });
}

function renderWrongPage() {
  const list = $("wrong-list");
  list.innerHTML = "";
  setText("wrong-total", String(state.wrongNotes.length));
  if (state.wrongNotes.length === 0) {
    list.innerHTML = `<div class="empty-state"><strong>아직 저장된 오답이 없어요.</strong><br>실전이나 연습에서 틀린 문제가 여기 쌓입니다.</div>`;
    $("btn-wrong-practice").disabled = true;
    $("btn-wrong-clear").disabled = true;
    return;
  }
  $("btn-wrong-practice").disabled = false;
  $("btn-wrong-clear").disabled = false;
  state.wrongNotes.forEach(q => list.appendChild(makeNoteItem(q)));
}

function makeNoteItem(q) {
  const div = document.createElement("div");
  div.className = "note-item";
  const text = document.createElement("div");
  text.className = "txt";
  const title = document.createElement("strong");
  title.textContent = `${q.examType} · ${q.crop}`;
  text.appendChild(title);
  text.appendChild(document.createTextNode(`\n      ${q.stage} / ${q.item}`));
  const answer = document.createElement("div");
  answer.className = "ans";
  answer.textContent = `${q.answer}${q.unit || ""}`;
  div.appendChild(text);
  div.appendChild(answer);
  return div;
}

function clearWrongNotes() {
  if (!state.wrongNotes.length && !state.pendingWrongNoteClear) return;
  if (!confirm("오답노트를 모두 삭제할까요?")) return;
  const stored = readJSON(STORAGE_KEYS.wrongs);
  const existingIntent = state.pendingWrongNoteClear;
  if (!stored.ok || (stored.exists && !Array.isArray(stored.value))) {
    state.pendingWrongNoteClear = { all: true, keys: [] };
  } else {
    const clearRecords = [
      ...(stored.exists ? stored.value : []),
      ...state.wrongNotes,
      ...state.preservedWrongNotes,
      ...state.pendingWrongNoteAdds
    ];
    const keys = new Set(existingIntent?.keys || []);
    clearRecords.forEach(record => keys.add(getWrongNoteIntentKey(record)));
    state.pendingWrongNoteClear = { all: !!existingIntent?.all, keys: [...keys] };
  }
  state.wrongNotes = [];
  state.preservedWrongNotes = [];
  state.pendingWrongNoteAdds = [];
  if (saveWrongNotes([])) state.pendingWrongNoteClear = null;
  renderWrongPage();
}

function handleQuitPlay() {
  if (state.mode === "time" && !state.runEnded && state.stopwatchStarted) {
    if (!confirm("현재 기록을 저장하고 홈으로 갈까요?\n다음에 이어서 할 수 있어요.")) return;
    pauseStopwatch();
    saveTimeCheckpoint();
  } else if (!confirm("진행 중인 플레이를 종료하고 홈으로 갈까요?")) {
    return;
  }
  state.runEnded = true;
  state.stopwatchStarted = false;
  state.stopwatchRunning = false;
  state.stopwatchStartedAt = null;
  clearRunHandles();
  showPage("home");
}

function handlePageHide() {
  if (state.mode !== "time" || state.runEnded || !state.stopwatchStarted) return;
  pauseStopwatch();
  saveTimeCheckpoint();
}

function handleStorageChange(event) {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (event.key === STORAGE_KEYS.completionBest) {
    reconcileCompletionBestFromStorage(event.newValue);
    return;
  }
  if (event.key !== STORAGE_KEYS.inProgress) return;
  if (state.mode === "time" && !state.runEnded && state.stopwatchStarted) return;

  if (event.newValue === null) {
    state.timeCheckpoint = null;
  } else {
    let value;
    try {
      value = JSON.parse(event.newValue);
    } catch (e) {
      return;
    }
    const checkpoint = normalizeTimeCheckpoint(value);
    const terminal = normalizeTimeCheckpointTerminal(value);
    if (checkpoint && !isCheckpointRunCompleted(checkpoint.runId)) state.timeCheckpoint = checkpoint;
    else if (checkpoint) state.timeCheckpoint = null;
    else if (terminal) state.timeCheckpoint = null;
    else return;
  }
  if ($("page-time-intro")?.classList.contains("active")) renderTimeIntro({ refresh: false });
}

function renderSlotValue(el, text, kind = "text") {
  el.className = "slot-val";
  if (text === "?") {
    el.textContent = "?";
    return;
  }
  if (kind === "item" && String(text).includes("-")) {
    const [top, bottom] = String(text).split("-");
    el.classList.add("split");
    const maxLen = Math.max(top.length, bottom.length);
    if (maxLen >= 8) el.classList.add("small");
    if (maxLen >= 10) el.classList.add("tiny");
    el.innerHTML = `<span class="split-top">${top}</span><span class="split-bottom">${bottom}</span>`;
    return;
  }
  const plain = String(text);
  if (plain.length >= 8) el.classList.add("small");
  if (plain.length >= 11) el.classList.add("tiny");
  el.textContent = plain;
}

function maybeVibrate(pattern) {
  if (!state.settings.vibrate || !navigator.vibrate) return;
  try { navigator.vibrate(pattern); } catch (e) {}
}

function maybeBeep(type, force = false) {
  if (type === "button") maybeVibrate([20]);
  if (!state.settings.sfx) return;
  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const cfg = {
      button: [520, .035],
      tick: [700, .03],
      start: [880, .09],
      correct: [880, .11],
      wrong: [220, .16]
    }[type] || [520, .05];
    osc.type = type === "wrong" ? "sawtooth" : "sine";
    osc.frequency.setValueAtTime(cfg[0], now);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(.0001, now + cfg[1]);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + cfg[1] + 0.02);
  } catch (e) {}
}

function bindEvents() {
  const homeInteract = () => ensureHomeBgm();
  $("page-home").addEventListener("pointerdown", homeInteract, { passive: true });
  $("page-home").addEventListener("touchstart", homeInteract, { passive: true });
  $("page-home").addEventListener("click", homeInteract, { passive: true });

  $("btn-home-time").addEventListener("click", (e) => { ensureHomeBgm(); maybeBeep("button"); renderTimeIntro(); openModal("time-intro", e.currentTarget); });
  $("btn-home-practice").addEventListener("click", (e) => { ensureHomeBgm(); maybeBeep("button"); validatePracticeSelection(); openModal("practice-setup", e.currentTarget); });
  $("btn-home-wrong").addEventListener("click", (e) => { ensureHomeBgm(); maybeBeep("button"); renderWrongPage(); openModal("wrong", e.currentTarget); });
  $("btn-home-settings").addEventListener("click", (e) => { ensureHomeBgm(); maybeBeep("button"); beginSettingsEdit(); openModal("settings", e.currentTarget); });

  $("btn-time-intro-close").addEventListener("click", () => { maybeBeep("button"); closeModal("time-intro"); });
  $("btn-time-intro-start").addEventListener("click", () => { maybeBeep("button"); startTimeMode(); });
  $("btn-time-resume").addEventListener("click", () => { maybeBeep("button"); resumeTimeMode(); });
  $("btn-time-new").addEventListener("click", () => { maybeBeep("button"); startNewTimeModeFromCheckpoint(); });

  $("btn-practice-close").addEventListener("click", () => { maybeBeep("button"); closeModal("practice-setup"); });
  $("btn-practice-start").addEventListener("click", () => { maybeBeep("button"); startPracticeMode(); });

  $("btn-stop").addEventListener("click", () => { maybeBeep("button"); stopSpin(); });
  $("btn-submit").addEventListener("click", () => evaluateAnswer());
  $("mobile-keypad").addEventListener("click", (e) => {
    const btn = e.target.closest(".keypad-btn");
    if (!btn || $("answer-zone")?.classList.contains("is-disabled")) return;
    maybeBeep("button");
    handleKeypadInput(btn.dataset.key);
  });
  $("btn-play-home").addEventListener("click", () => { maybeBeep("button"); handleQuitPlay(); });

  $("btn-result-retry").addEventListener("click", () => { maybeBeep("button"); startTimeMode(); });
  $("btn-result-home").addEventListener("click", () => { maybeBeep("button"); showPage("home"); });

  $("btn-wrong-practice").addEventListener("click", () => { maybeBeep("button"); startWrongPracticeMode(); });
  $("btn-wrong-clear").addEventListener("click", () => { maybeBeep("button"); clearWrongNotes(); });
  $("btn-wrong-close").addEventListener("click", () => { maybeBeep("button"); closeModal("wrong"); });

  $("btn-settings-save").addEventListener("click", () => { maybeBeep("button"); saveSettings(); closeModal("settings"); });
  $("btn-settings-close").addEventListener("click", () => { maybeBeep("button"); discardSettingsDraft(); closeModal("settings"); });
  $("btn-bgm-down").addEventListener("click", () => { maybeBeep("button"); adjustBgmLevel(-1); });
  $("btn-bgm-up").addEventListener("click", () => { maybeBeep("button"); adjustBgmLevel(1); });
  $("toggle-sfx").addEventListener("change", syncSettingsDraftFromUI);
  $("toggle-vibrate").addEventListener("change", syncSettingsDraftFromUI);

  document.addEventListener("keydown", (e) => {
    if (handleModalKeydown(e)) return;
    if (e.key !== "Enter" || e.repeat || e.isComposing) return;
    if (!$("page-play")?.classList.contains("active") || state.runEnded) return;

    // PC 키보드 흐름: 룰렛 회전 중 Enter = STOP, 문제 확정 후 Enter = 제출
    if (state.spinning) {
      const stop = $("btn-stop");
      if (!stop || stop.classList.contains("hidden") || stop.disabled) return;
      e.preventDefault();
      maybeBeep("button");
      stopSpin();
      return;
    }

    const submit = $("btn-submit");
    if (!submit || submit.classList.contains("hidden") || submit.disabled) return;
    if ($("answer-zone")?.classList.contains("is-disabled")) return;
    if (state.scored) return;
    e.preventDefault();
    evaluateAnswer();
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches(".exam-check, .stage-check, .crop-check")) validatePracticeSelection();
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("resize", syncPlayControlsForViewport);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("storage", handleStorageChange);

  document.querySelectorAll(".modal-layer").forEach(layer => {
    layer.addEventListener("click", (e) => {
      if (e.target !== layer) return;
      closeModal(layer.id.replace("page-", ""));
    });
  });
}

function init() {
  loadSettings();
  loadWrongNotes();
  loadBestRecord();
  loadCompletionBest();
  loadTimeCheckpoint();
  initHomeAssets();
  preventImageLongPress();
  renderPracticeOptions();
  validatePracticeSelection();
  bindEvents();
  showPage("home");
  const unlock = () => {
    prepareAudio();
    ensureHomeBgm();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("touchstart", unlock);
    window.removeEventListener("click", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("touchstart", unlock, { once: true, passive: true });
  window.addEventListener("click", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

document.addEventListener("DOMContentLoaded", init);
