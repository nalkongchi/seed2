const QUESTION_SET = buildQuestionSet(QUESTION_RULES);
const EXAM_TYPES = ["포장검사", "종자검사"];
const CROPS = ["벼", "보리", "밀", "콩", "팥", "트리티케일(사료용)"];
const STAGE_GROUPS = ["원원종", "원종", "보급종"];
const STAGE_GROUP_MAP = {
  "원원종": ["원원종", "원원종포"],
  "원종": ["원종", "원종포"],
  "보급종": ["보급종", "보급종포", "채종포 1세대"]
};
const EXCLUDED_STAGES = ["채종포 2세대"];
const STORAGE_KEYS = {
  best: "seedTraining_v1_2_bestTimeAttack",
  wrongs: "seedTraining_v1_2_wrongNotes",
  settings: "seedTraining_v1_2_settings"
};
const MODE_META = {
  time: { en: "Time Attack", title: "실전모드", pill: "⚡ 1분 타임어택", sub: "전체 범위 랜덤 · 1분 제한" },
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
  tries: 0,
  recentWrongs: [],
  wrongNotes: [],
  settings: { bgmLevel: 3, sfx: true, vibrate: true },
  timeLeft: 60,
  timeInterval: null,
  nextTimeout: null,
  ngTimeout: null,
  scored: false,
  runEnded: false,
  countdownTimer: null,
  audioCtx: null,
  timeAttackBest: { correct: 0, tries: 0, acc: 0 },
  audioReady: false,
  currentBgm: null
};

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
function openModal(id) {
  $("page-" + id).classList.add("active");
}
function closeModal(id) {
  const el = $("page-" + id);
  if (el) el.classList.remove("active");
}
function closeAllModals() {
  document.querySelectorAll(".modal-layer").forEach(p => p.classList.remove("active"));
}
function show(id, visible) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
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

function getBgmVolume() {
  const level = Math.max(0, Math.min(5, Number(state.settings.bgmLevel ?? 3)));
  return [0, 0.14, 0.26, 0.42, 0.55, 0.70][level] || 0;
}
function applyAudioVolumes() {
  const bgmVol = getBgmVolume();
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
  const out = Object.assign(base, raw || {});
  if (typeof out.bgmLevel === "undefined") out.bgmLevel = out.bgm === false ? 0 : 3;
  out.bgmLevel = Math.max(0, Math.min(5, Number(out.bgmLevel ?? 3)));
  return out;
}
function updateBgmVolumeUI() {
  const el = $("bgm-volume-level");
  if (el) el.textContent = String(state.settings.bgmLevel ?? 3);
}
function adjustBgmLevel(delta) {
  prepareAudio();
  state.settings.bgmLevel = Math.max(0, Math.min(5, Number(state.settings.bgmLevel ?? 3) + delta));
  updateBgmVolumeUI();
  applyAudioVolumes();
  saveJSON(STORAGE_KEYS.settings, state.settings);
  if (state.settings.bgmLevel <= 0) stopAllBgm();
  else syncBgmForPage(document.querySelector(".base-page.active")?.id?.replace("page-","") || "home");
}
function loadSettings() {
  state.settings = normalizeSettings(loadJSON(STORAGE_KEYS.settings, { bgmLevel: 3, sfx: true, vibrate: true }));
  updateBgmVolumeUI();
  $("toggle-sfx").checked = !!state.settings.sfx;
  $("toggle-vibrate").checked = !!state.settings.vibrate;
}
function saveSettings() {
  state.settings.sfx = $("toggle-sfx").checked;
  state.settings.vibrate = $("toggle-vibrate").checked;
  state.settings.bgmLevel = Math.max(0, Math.min(5, Number(state.settings.bgmLevel ?? 3)));
  saveJSON(STORAGE_KEYS.settings, state.settings);
  applyAudioVolumes();
  if (state.settings.bgmLevel <= 0) stopAllBgm();
  else syncBgmForPage(document.querySelector(".base-page.active")?.id?.replace("page-","") || "home");
  setFeedback("설정을 저장했어요.", "");
  maybeBeep("button");
}

function loadWrongNotes() {
  state.wrongNotes = loadJSON(STORAGE_KEYS.wrongs, []);
}
function saveWrongNotes() {
  saveJSON(STORAGE_KEYS.wrongs, state.wrongNotes);
}
function loadBestRecord() {
  state.timeAttackBest = loadJSON(STORAGE_KEYS.best, { correct: 0, tries: 0, acc: 0 });
}
function saveBestRecord() {
  saveJSON(STORAGE_KEYS.best, state.timeAttackBest);
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
    const cropText = crop === "트리티케일(사료용)" ? "트리티케일<br>(사료용)" : crop;
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

function resetRunCommon() {
  clearInterval(state.timeInterval);
  clearTimeout(state.nextTimeout);
  clearTimeout(state.ngTimeout);
  clearInterval(state.countdownTimer);
  state.timeInterval = null;
  state.nextTimeout = null;
  state.ngTimeout = null;
  state.countdownTimer = null;
  state.curQuestion = null;
  state.spinning = false;
  state.scored = false;
  state.spinIntervals.forEach(iv => clearInterval(iv));
  state.spinIntervals = [];
  state.correct = 0;
  state.wrong = 0;
  state.tries = 0;
  state.recentWrongs = [];
  state.runEnded = false;
  state.timeLeft = 60;
  $("ans").value = "";
  $("ans").className = "ans-input";
  $("ans").placeholder = "숫자 입력";
  setText("answer-guide", "");
  show("input-row", false);
  show("mobile-keypad", false);
  show("btn-submit", false);
  show("btn-stop", false);
  setFeedback("", "");
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
  if (!q) return "";
  if (q.item === "발아율") return "정수로 입력";
  const answer = String(q.answer);
  const decimals = answer.includes(".") ? answer.split(".")[1].length : 0;
  if (decimals === 1) return "소수 첫째 자리까지 입력";
  if (decimals === 2) return "소수 둘째 자리까지 입력";
  return "숫자로 입력";
}

function getAnswerPlaceholder(q) {
  if (!q) return "숫자 입력";
  if (q.item === "발아율") return "예) 85";
  const answer = String(q.answer);
  const decimals = answer.includes(".") ? answer.split(".")[1].length : 0;
  if (decimals === 1) return "예) 0.0";
  if (decimals === 2) return "예) 0.00";
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

function startTimeMode() {
  prepareAudio();
  closeModal("time-intro");
  state.mode = "time";
  state.pool = QUESTION_SET.filter(isAllowedQuestion);
  resetRunCommon();
  updatePlayHeader();
  showPage("play");
  startCountdown(3, "실전모드 시작", () => {
    maybeBeep("start");
    startTimeAttackTimer();
    startRound();
  });
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
    setText("status-1-lbl", "남은 시간");
    setText("status-1-val", formatTime(state.timeLeft));
    setText("status-2-lbl", "정답 수");
    setText("status-2-val", String(state.correct));
    const remainPct = Math.max(0, Math.min(100, (state.timeLeft / 60) * 100));
    // v1.2-25: 실전모드 시간바는 오른쪽에 남은 시간이 붙고 왼쪽부터 비워지게 한다.
    pbar.style.position = "absolute";
    pbar.style.right = "0";
    pbar.style.left = "auto";
    pbar.style.top = "0";
    pbar.style.bottom = "0";
    pbar.style.width = `${remainPct}%`;
    pbar.style.marginLeft = "0";
    pbar.style.transformOrigin = "right center";
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

function startTimeAttackTimer() {
  state.timeLeft = 60;
  updateStatus();
  state.timeInterval = setInterval(() => {
    state.timeLeft -= 1;
    updateStatus();
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      clearInterval(state.timeInterval);
      finishTimeMode();
    }
  }, 1000);
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
    "트리티케일(사료용)": 1
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
  }
}

function formatFeedback(q, isCorrect) {
  const word = isCorrect ? "정답!" : "오답!";
  const criteria = `${q.item} ${q.stage} ${q.answer}${q.unit || ""}`;
  return `<span class="result-word">${word}</span><span class="criteria">${escapeHTML(criteria)}</span>`;
}

function startRound() {
  if (state.runEnded) return;
  state.scored = false;
  state.curQuestion = pickQuestion();
  if (!state.curQuestion) return;
  setText("play-examtype-chip", state.curQuestion.examType);
  $("play-examtype-chip").classList.add("spinning");
  setText("shell-hint", "STOP으로 확정");
  $("ans").value = "";
  $("ans").className = "ans-input";
  $("ans").placeholder = "숫자 입력";
  setText("answer-guide", "");
  setMobileControlsActive(true, "stop");
  if (!isMobileView()) {
    show("input-row", false);
    show("mobile-keypad", false);
    show("btn-submit", false);
    show("btn-stop", true);
  }
  setFeedback("", "");
  setQuestionText("슬롯이 돌아가는 중...");
  startSpinVisual(state.curQuestion);
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
  const q = state.curQuestion;
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
  setQuestionText(formatQuestionHTML(q));
  setText("answer-guide", getAnswerGuideText(q));
  $("ans").placeholder = getAnswerPlaceholder(q);
  show("btn-stop", false);
  show("input-row", true);
  show("mobile-keypad", isMobileView());
  show("btn-submit", true);
  $("unit-tag").textContent = q.unit || "%";
  setMobileControlsActive(true, "submit");
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

function getDecimalPlaces(value) {
  const text = String(value).trim();
  if (!text.includes(".")) return 0;
  return text.split(".")[1].length;
}
function isAnswerCorrect(raw, correctText) {
  const userNum = Number(raw);
  const correctNum = Number(correctText);
  if (!Number.isFinite(userNum) || !Number.isFinite(correctNum)) return false;
  if (Math.abs(userNum - correctNum) >= 1e-9) return false;
  return getDecimalPlaces(raw) === getDecimalPlaces(correctText);
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
    clearTimeout(state.ngTimeout);
    state.ngTimeout = setTimeout(() => $("ans").classList.remove("ng"), 450);
    return;
  }
  const correctText = String(state.curQuestion.answer);
  const isCorrect = isAnswerCorrect(raw, correctText);
  state.scored = true;
  state.tries += 1;
  if (isCorrect) {
    state.correct += 1;
    $("ans").classList.add("ok");
    setFeedback(formatFeedback(state.curQuestion, true), "ok");
    playEffect("se-correct", "correct");
    maybeVibrate([40]);
  } else {
    state.wrong += 1;
    $("ans").classList.add("ng");
    setFeedback(formatFeedback(state.curQuestion, false), "ng");
    playEffect("se-wrong", "wrong");
    maybeVibrate([50, 70, 40]);
    pushWrongNote(state.curQuestion);
    state.recentWrongs.push(state.curQuestion);
  }
  updateStatus();
  if (isMobileView()) {
    setMobileControlsActive(false, "submit");
    $("answer-zone")?.classList.add("result-feedback");
    show("input-row", false);
    show("btn-submit", true);
  } else {
    show("btn-submit", false);
    show("mobile-keypad", false);
    show("input-row", false);
  }
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
  const exists = state.wrongNotes.some(item => item.id === q.id);
  if (!exists) {
    state.wrongNotes.unshift(q);
    saveWrongNotes();
  }
}

function finishTimeMode() {
  state.runEnded = true;
  clearInterval(state.timeInterval);
  clearTimeout(state.nextTimeout);
  clearTimeout(state.ngTimeout);
  show("btn-stop", false);
  show("btn-submit", false);
  show("mobile-keypad", false);
  show("input-row", false);
  setFeedback("⏰ 시간이 종료되었습니다.", "");
  stopAllBgm();
  playEffect("se-finish", "start");
  maybeVibrate([80, 60, 120]);
  const acc = state.tries ? Math.round(state.correct / state.tries * 100) : 0;
  const prev = state.timeAttackBest;
  const isNew = state.correct > (prev.correct || 0) || (state.correct === (prev.correct || 0) && acc > (prev.acc || 0));
  if (isNew) {
    state.timeAttackBest = { correct: state.correct, tries: state.tries, acc };
    saveBestRecord();
  }
  $("new-badge").classList.toggle("hidden", !isNew);
  setText("r-correct", `${state.correct}개`);
  $("r-best").innerHTML = `<span class="best-num">${state.timeAttackBest.correct || 0}</span>개`;
  setText("r-tries", String(state.tries));
  setText("r-acc", `${acc}%`);
  setText("r-wrong", String(state.wrong));
  renderResultWrongs();
  showPage("result", { syncBgm: false });
  if (isNew) launchConfetti();
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
  div.innerHTML = `
    <div class="txt">
      <strong>${q.examType} · ${q.crop}</strong>
      ${q.stage} / ${q.item}
    </div>
    <div class="ans">${q.answer}${q.unit}</div>
  `;
  return div;
}

function clearWrongNotes() {
  if (!state.wrongNotes.length) return;
  if (!confirm("오답노트를 모두 삭제할까요?")) return;
  state.wrongNotes = [];
  saveWrongNotes();
  renderWrongPage();
}

function handleQuitPlay() {
  if (!confirm("진행 중인 플레이를 종료하고 홈으로 갈까요?")) return;
  clearInterval(state.timeInterval);
  clearTimeout(state.nextTimeout);
  clearTimeout(state.ngTimeout);
  clearTimeout(state.ngTimeout);
  clearInterval(state.countdownTimer);
  state.runEnded = true;
  showPage("home");
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

  $("btn-home-time").addEventListener("click", () => { ensureHomeBgm(); maybeBeep("button"); openModal("time-intro"); });
  $("btn-home-practice").addEventListener("click", () => { ensureHomeBgm(); maybeBeep("button"); validatePracticeSelection(); openModal("practice-setup"); });
  $("btn-home-wrong").addEventListener("click", () => { ensureHomeBgm(); maybeBeep("button"); renderWrongPage(); openModal("wrong"); });
  $("btn-home-settings").addEventListener("click", () => { ensureHomeBgm(); maybeBeep("button"); openModal("settings"); });

  $("btn-time-intro-close").addEventListener("click", () => { maybeBeep("button"); closeModal("time-intro"); });
  $("btn-time-intro-start").addEventListener("click", () => { maybeBeep("button"); startTimeMode(); });

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
  $("btn-settings-close").addEventListener("click", () => { maybeBeep("button"); closeModal("settings"); });
  $("btn-bgm-down").addEventListener("click", () => { maybeBeep("button"); adjustBgmLevel(-1); });
  $("btn-bgm-up").addEventListener("click", () => { maybeBeep("button"); adjustBgmLevel(1); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const submit = $("btn-submit");
    if (!submit || submit.classList.contains("hidden") || submit.disabled) return;
    if ($("answer-zone")?.classList.contains("is-disabled")) return;
    if (state.scored) return;
    evaluateAnswer();
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches(".exam-check, .stage-check, .crop-check")) validatePracticeSelection();
  });

  document.querySelectorAll(".modal-layer").forEach(layer => {
    layer.addEventListener("click", (e) => {
      if (e.target === layer) layer.classList.remove("active");
    });
  });
}

function init() {
  loadSettings();
  loadWrongNotes();
  loadBestRecord();
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
