const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const DATA_SOURCE = fs.readFileSync(path.join(ROOT, "js", "data.js"), "utf8");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8") + `
globalThis.__storageTest = {
  STORAGE_KEYS,
  COMPLETION_TARGET,
  TIME_CHECKPOINT_VERSION,
  QUESTION_SET,
  state,
  init,
  loadSettings,
  loadWrongNotes,
  loadBestRecord,
  loadCompletionBest,
  loadTimeCheckpoint,
  saveTimeCheckpoint,
  clearTimeCheckpoint,
  invalidateOwnedTimeCheckpoint,
  buildTimeCheckpoint,
  renderTimeIntro,
  evaluateAnswer,
  finishTimeMode,
  startTimeMode,
  resumeTimeMode,
  startNewTimeModeFromCheckpoint,
  startPracticeMode,
  startStopwatch,
  getElapsedSeconds,
  handleVisibilityChange,
  handlePageHide,
  isBetterCompletionRecord,
  persistCompletionBest,
  handleStorageChange,
  normalizeTimeCheckpoint,
  isValidTimeCheckpoint,
  weightedPick,
  pickQuestion,
  stopSpin,
  handleQuitPlay,
  saveSettings,
  openModal,
  closeModal,
  beginSettingsEdit,
  discardSettingsDraft,
  adjustBgmLevel,
  syncSettingsDraftFromUI,
  getBgmVolume,
  pushWrongNote,
  clearWrongNotes,
  startWrongPracticeMode,
  renderWrongPage,
  makeNoteItem,
  isAnswerCorrect,
  getAnswerGuideText,
  getAnswerPlaceholder,
  formatFeedback,
  syncPlayControlsForViewport,
  resetRunCommon
};`;

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = typeof force === "boolean" ? force : !this.contains(name);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = { setProperty() {} };
    this.dataset = {};
    this.children = [];
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.complete = false;
    this.naturalWidth = 0;
    this.paused = true;
    this.currentTime = 0;
    this.volume = 1;
    this.hidden = false;
    this.isConnected = true;
    this.attributes = new Map();
    this.focusableChildren = [];
    this.onFocus = null;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  click() {
    (this.listeners.get("click") || []).forEach(listener => listener({ target: this, currentTarget: this }));
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  appendChild(child) { this.children.push(child); return child; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return this.focusableChildren; }
  contains(target) { return this === target || this.focusableChildren.includes(target); }
  remove() { this.isConnected = false; }
  blur() {}
  focus() { if (this.onFocus) this.onFocus(this); }
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

function createStorage(initialStorage = {}, options = {}) {
  const values = new Map(Object.entries(initialStorage));
  let hooks = {};
  let getCalls = 0;
  let setCalls = 0;
  let removeCalls = 0;
  return {
    getItem(key) {
      getCalls += 1;
      if (options.throwOnGet || options.shouldThrowOnGet?.(key, getCalls)) throw new Error("forced getItem failure");
      const value = values.has(key) ? values.get(key) : null;
      (hooks.afterGet || options.afterGet)?.(key, value, getCalls);
      return value;
    },
    setItem(key, value) {
      setCalls += 1;
      const text = String(value);
      (hooks.beforeSet || options.beforeSet)?.(key, text, setCalls);
      if (options.throwOnSet || options.shouldThrowOnSet?.(key, text, setCalls)) throw new Error("forced setItem failure");
      values.set(key, text);
      (hooks.afterSet || options.afterSet)?.(key, text, setCalls);
    },
    removeItem(key) {
      removeCalls += 1;
      (hooks.beforeRemove || options.beforeRemove)?.(key, removeCalls);
      if (options.throwOnRemove || options.shouldThrowOnRemove?.(key, removeCalls)) throw new Error("forced removeItem failure");
      values.delete(key);
      (hooks.afterRemove || options.afterRemove)?.(key, removeCalls);
    },
    raw(key) { return values.get(key); },
    setRaw(key, value) {
      if (typeof value === "undefined") values.delete(key);
      else values.set(key, String(value));
    },
    setHooks(nextHooks = {}) { hooks = nextHooks; },
    getCalls() { return getCalls; },
    setCalls() { return setCalls; },
    removeCalls() { return removeCalls; }
  };
}

let runtimeSequence = 0;
function createRuntime(initialStorage = {}, options = {}) {
  const elements = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  let nextTimerId = 1;
  const runtimeId = ++runtimeSequence;
  let uuidSequence = 0;
  let nowMs = options.nowMs || 0;
  let viewportWidth = options.viewportWidth || 1000;
  let activeElement = null;

  const getElement = id => {
    if (!elements.has(id)) {
      const element = new FakeElement(id);
      element.onFocus = focused => { activeElement = focused; };
      elements.set(id, element);
    }
    return elements.get(id);
  };
  ["page-home", "page-play", "page-result"].forEach(getElement);

  const modalFocusIds = {
    "page-time-intro": ["btn-time-intro-close", "btn-time-intro-start", "btn-time-resume", "btn-time-new"],
    "page-practice-setup": ["btn-practice-close", "btn-practice-start"],
    "page-wrong": ["btn-wrong-close", "btn-wrong-practice", "btn-wrong-clear"],
    "page-settings": ["btn-settings-close", "btn-bgm-down", "btn-bgm-up", "toggle-sfx", "toggle-vibrate", "btn-settings-save"]
  };
  Object.entries(modalFocusIds).forEach(([modalId, ids]) => {
    getElement(modalId).focusableChildren = ids.map(getElement);
  });

  const document = {
    hidden: false,
    get activeElement() { return activeElement; },
    getElementById: getElement,
    createElement: tag => new FakeElement(tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text), children: [] }),
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    querySelector(selector) {
      if (selector === ".base-page.active") {
        return [...elements.values()].find(el => el.classList.contains("active")) || null;
      }
      if (selector === ".modal-layer.active") {
        return Object.keys(modalFocusIds).map(getElement).find(el => el.classList.contains("active")) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".base-page") {
        return [getElement("page-home"), getElement("page-play"), getElement("page-result")];
      }
      if (selector === ".modal-layer") {
        return Object.keys(modalFocusIds).map(getElement);
      }
      if (selector === ".modal-layer.active") {
        return Object.keys(modalFocusIds).map(getElement).filter(el => el.classList.contains("active"));
      }
      return [];
    },
    contains(element) { return !!element && element.isConnected !== false; }
  };

  const localStorage = options.localStorage || createStorage(initialStorage, options);

  const context = vm.createContext({
    console,
    document,
    localStorage,
    navigator: { vibrate() {} },
    window: {
      crypto: { randomUUID: () => `test-run-${runtimeId}-${++uuidSequence}` },
      matchMedia: query => ({
        matches: query === "(max-width: 700px)" && viewportWidth <= 700
      }),
      addEventListener(type, listener) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(listener);
      },
      removeEventListener(type, listener) {
        const listeners = windowListeners.get(type) || [];
        windowListeners.set(type, listeners.filter(item => item !== listener));
      }
    },
    confirm: () => options.confirmResult !== false,
    alert() {},
    Math,
    Date,
    performance: { now: () => nowMs },
    Promise,
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timeouts.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, delay) {
      const id = nextTimerId++;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); }
  });

  vm.runInContext(DATA_SOURCE, context, { filename: "js/data.js" });
  vm.runInContext(APP_SOURCE, context, { filename: "js/app.js" });

  return {
    api: context.__storageTest,
    element: getElement,
    raw: key => localStorage.raw(key),
    setCalls: () => localStorage.setCalls(),
    removeCalls: () => localStorage.removeCalls(),
    advance(ms) { nowMs += ms; },
    setHidden(hidden) {
      document.hidden = hidden;
      (documentListeners.get("visibilitychange") || []).forEach(listener => listener());
    },
    triggerPageHide() {
      (windowListeners.get("pagehide") || []).forEach(listener => listener());
    },
    triggerStorage(key, newValue, oldValue = null) {
      const event = { key, newValue, oldValue, storageArea: localStorage };
      (windowListeners.get("storage") || []).forEach(listener => listener(event));
    },
    activeElement: () => activeElement,
    triggerKeydown(key, overrides = {}) {
      const event = {
        key,
        repeat: false,
        isComposing: false,
        shiftKey: false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...overrides
      };
      (documentListeners.get("keydown") || []).forEach(listener => listener(event));
      return event;
    },
    resizeTo(width) {
      viewportWidth = width;
      (windowListeners.get("resize") || []).forEach(listener => listener());
    },
    runInterval(delay, count = 1) {
      for (let i = 0; i < count; i += 1) {
        const pending = [...intervals.entries()].filter(([, timer]) => timer.delay === delay);
        pending.forEach(([id, timer]) => {
          if (intervals.has(id)) timer.fn();
        });
      }
    },
    intervalCount(delay) {
      return [...intervals.values()].filter(timer => typeof delay === "undefined" || timer.delay === delay).length;
    },
    timeoutCount(delay) {
      return [...timeouts.values()].filter(timer => typeof delay === "undefined" || timer.delay === delay).length;
    },
    runTimeout(delay) {
      const pending = [...timeouts.entries()].filter(([, timer]) => timer.delay === delay);
      pending.forEach(([id, timer]) => {
        timeouts.delete(id);
        timer.fn();
      });
    }
  };
}

function json(value) { return JSON.stringify(value); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function collectText(node) {
  return `${node.textContent || ""}${(node.children || []).map(collectText).join("")}`;
}

function finishCompletion(runtime, elapsedSeconds, tries) {
  runtime.api.state.mode = "time";
  runtime.api.state.correct = runtime.api.COMPLETION_TARGET;
  runtime.api.state.wrong = tries - runtime.api.COMPLETION_TARGET;
  runtime.api.state.tries = tries;
  runtime.api.state.completionElapsedSeconds = elapsedSeconds;
  runtime.api.state.runEnded = false;
  runtime.api.finishTimeMode();
}

test("A: storage key가 없는 신규 사용자는 기본값으로 부팅한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.api.state.settings)),
    { bgmLevel: 3, sfx: true, vibrate: true }
  );
  assert.equal(runtime.api.state.wrongNotes.length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(runtime.api.state.timeAttackBest)),
    { correct: 0, tries: 0, acc: 0 }
  );
  assert.equal(runtime.setCalls(), 0);
});

test("B: 정상 기존 settings, wrongNotes, best를 그대로 연결한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const storage = {
    [seed.api.STORAGE_KEYS.settings]: json({ bgmLevel: 5, sfx: false, vibrate: false }),
    [seed.api.STORAGE_KEYS.wrongs]: json([question]),
    [seed.api.STORAGE_KEYS.best]: json({ correct: 7, tries: 9, acc: 78 }),
    [seed.api.STORAGE_KEYS.completionBest]: json({ elapsedSeconds: 208, tries: 18 })
  };
  const runtime = createRuntime(storage);
  runtime.api.init();
  assert.equal(runtime.api.state.settings.bgmLevel, 5);
  assert.equal(runtime.api.state.settings.sfx, false);
  assert.equal(runtime.api.state.wrongNotes[0].id, question.id);
  assert.equal(runtime.api.state.timeAttackBest.correct, 7);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 208, tries: 18 });
  assert.equal(runtime.setCalls(), 0);
});

test("C: invalid JSON은 원문을 덮어쓰지 않고 fallback으로 부팅한다", () => {
  const seed = createRuntime();
  const invalid = "{not-json";
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.settings]: invalid,
    [seed.api.STORAGE_KEYS.wrongs]: invalid,
    [seed.api.STORAGE_KEYS.best]: invalid,
    [seed.api.STORAGE_KEYS.completionBest]: invalid,
    [seed.api.STORAGE_KEYS.inProgress]: invalid
  });
  runtime.api.init();
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  Object.values(seed.api.STORAGE_KEYS).forEach(key => assert.equal(runtime.raw(key), invalid));
  assert.equal(runtime.setCalls(), 0);
});

for (const [name, value] of [["null", null], ["object", {}], ["string", "wrong"], ["number", 7]]) {
  test(`D: wrongNotes ${name} shape는 빈 메모리 fallback을 사용하고 원문을 보존한다`, () => {
    const seed = createRuntime();
    const raw = json(value);
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: raw });
    runtime.api.init();
    assert.equal(runtime.api.state.wrongNotes.length, 0);
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.wrongs), raw);
    assert.equal(runtime.setCalls(), 0);
  });
}

test("E: wrongNotes 배열의 비정상 항목은 격리하고 raw 배열은 보존한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET.find(q => q.crop === "라이밀(트리티케일)");
  const legacy = { ...question, id: `legacy-${question.id}`, crop: "트리티케일(사료용)" };
  const raw = json([legacy, null, {}, { examType: question.examType }]);
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: raw });
  runtime.api.init();
  assert.deepEqual(plain(runtime.api.state.wrongNotes.map(item => item.id)), [question.id]);
  assert.equal(runtime.api.state.preservedWrongNotes.length, 3);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.wrongs), raw);
  assert.equal(runtime.setCalls(), 0);
});

for (const [name, value] of [
  ["null", null],
  ["empty object", {}],
  ["invalid fields", { correct: "7", tries: -1, acc: 101 }]
]) {
  test(`F: best ${name}은 안전한 메모리 fallback을 사용한다`, () => {
    const seed = createRuntime();
    const raw = json(value);
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.best]: raw });
    runtime.api.init();
    assert.deepEqual(
      JSON.parse(JSON.stringify(runtime.api.state.timeAttackBest)),
      { correct: 0, tries: 0, acc: 0 }
    );
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.best), raw);
  });
}

test("G/H: settings 누락·비정상 필드는 기본값과 합치고 유효 필드는 보존한다", () => {
  const seed = createRuntime();
  const cases = [
    [{ sfx: false }, { bgmLevel: 3, sfx: false, vibrate: true }],
    [{ bgmLevel: "5", sfx: "no", vibrate: false }, { bgmLevel: 3, sfx: true, vibrate: false }],
    [{ bgmLevel: -1, sfx: true, vibrate: true }, { bgmLevel: 3, sfx: true, vibrate: true }],
    [{ bgmLevel: 6, sfx: true, vibrate: true }, { bgmLevel: 3, sfx: true, vibrate: true }],
    [{ bgmLevel: 2.5, sfx: true, vibrate: true }, { bgmLevel: 3, sfx: true, vibrate: true }]
  ];
  cases.forEach(([stored, expected]) => {
    const raw = json(stored);
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: raw });
    runtime.api.loadSettings();
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.api.state.settings)), expected);
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), raw);
  });
});

test("I: 기존 crop/item alias migration은 canonical question으로 저장한다", () => {
  const seed = createRuntime();
  const cropQuestion = seed.api.QUESTION_SET.find(q => q.crop === "라이밀(트리티케일)");
  const itemQuestion = seed.api.QUESTION_SET.find(q => q.item === "메벼출현율");
  assert.ok(cropQuestion);
  assert.ok(itemQuestion);
  const legacyCrop = { ...cropQuestion, id: `legacy-crop-${cropQuestion.id}`, crop: "트리티케일(사료용)" };
  const legacyItem = { ...itemQuestion, id: `legacy-item-${itemQuestion.id}`, item: "피해출현율" };
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.wrongs]: json([legacyCrop, legacyItem])
  });
  runtime.api.loadWrongNotes();
  assert.deepEqual(
    plain(runtime.api.state.wrongNotes.map(q => q.id)),
    [cropQuestion.id, itemQuestion.id]
  );
  assert.deepEqual(
    JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.wrongs)).map(q => q.id),
    [cropQuestion.id, itemQuestion.id]
  );
});

test("J1: migration setItem throw가 init과 canonical 메모리 복원을 막지 않는다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET.find(q => q.crop === "라이밀(트리티케일)");
  const legacy = { ...question, id: `legacy-${question.id}`, crop: "트리티케일(사료용)" };
  const excluded = {
    id: "legacy__crop__채종포 2세대__item",
    examType: "포장검사",
    crop: "벼",
    stage: "채종포 2세대",
    item: "legacy item",
    answer: "1.0",
    unit: "%",
    label: "legacy"
  };
  const raw = json([legacy, { ...legacy }, excluded]);
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.wrongs]: raw },
    { throwOnSet: true }
  );
  assert.doesNotThrow(() => runtime.api.init());
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  assert.deepEqual(plain(runtime.api.state.wrongNotes.map(q => q.id)), [question.id]);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.wrongs), raw);
  assert.equal(runtime.setCalls(), 1);
});

test("J2: 오답 저장 setItem throw 후에도 채점과 다음 round가 진행된다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.element("ans").value = "999999";
  assert.doesNotThrow(() => runtime.api.evaluateAnswer());
  assert.equal(runtime.api.state.tries, 1);
  assert.equal(runtime.api.state.wrong, 1);
  assert.equal(runtime.api.state.wrongNotes[0].id, question.id);
  runtime.runTimeout(1100);
  assert.equal(runtime.api.state.curQuestion.id, question.id);
  assert.equal(runtime.api.state.spinning, true);
});

test("J3: 신규 최고기록 setItem throw 후에도 현재 실전 결과 화면이 표시된다", () => {
  const seed = createRuntime();
  const raw = json(null);
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.completionBest]: raw },
    { throwOnSet: true }
  );
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.wrong = 4;
  runtime.api.state.tries = 14;
  runtime.api.state.elapsedMs = 208900;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.element("r-correct").textContent, "03:28");
  assert.equal(runtime.element("r-tries").textContent, "14");
  assert.equal(runtime.element("r-acc").textContent, "71%");
  assert.equal(runtime.element("r-wrong").textContent, "4");
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 208, tries: 14 });
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), raw);
});

test("J4: settings setItem throw가 메모리 설정 적용과 앱 사용을 막지 않는다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  runtime.element("toggle-sfx").checked = false;
  runtime.element("toggle-vibrate").checked = false;
  assert.doesNotThrow(() => runtime.api.saveSettings());
  assert.equal(runtime.api.state.settings.sfx, false);
  assert.equal(runtime.api.state.settings.vibrate, false);
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
});

test("2단계 B: 두 탭 add/add는 persisted 최신값을 기준으로 모두 병합한다", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET.slice(0, 3);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a]) });
  const tab1 = createRuntime({}, { localStorage: storage });
  const tab2 = createRuntime({}, { localStorage: storage });
  tab1.api.init();
  tab2.api.init();
  tab1.api.pushWrongNote(b);
  tab2.api.pushWrongNote(c);
  const ids = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)).map(q => q.id);
  assert.deepEqual(ids, [c.id, b.id, a.id]);
  assert.equal(new Set(ids).size, 3);
});

test("2단계 C: 두 탭이 동일 ID를 추가해도 persisted에는 하나만 남는다", () => {
  const seed = createRuntime();
  const [a, b] = seed.api.QUESTION_SET.slice(0, 2);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a]) });
  const tab1 = createRuntime({}, { localStorage: storage });
  const tab2 = createRuntime({}, { localStorage: storage });
  tab1.api.init();
  tab2.api.init();
  tab1.api.pushWrongNote(b);
  tab2.api.pushWrongNote(b);
  const ids = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)).map(q => q.id);
  assert.equal(ids.filter(id => id === b.id).length, 1);
  assert.deepEqual(new Set(ids), new Set([a.id, b.id]));
});

test("2단계 D: clear 이후 stale 탭 add는 삭제 전 목록을 부활시키지 않는다", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET.slice(0, 3);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a, b]) });
  const clearTab = createRuntime({}, { localStorage: storage });
  const staleTab = createRuntime({}, { localStorage: storage });
  clearTab.api.init();
  staleTab.api.init();
  clearTab.api.clearWrongNotes();
  staleTab.api.pushWrongNote(c);
  assert.deepEqual(
    JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)).map(q => q.id),
    [c.id]
  );
});

test("2단계 E: add 이후 명시적 clear는 최종 persisted를 빈 배열로 만든다", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET.slice(0, 3);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a, b]) });
  const addTab = createRuntime({}, { localStorage: storage });
  const clearTab = createRuntime({}, { localStorage: storage });
  addTab.api.init();
  clearTab.api.init();
  addTab.api.pushWrongNote(c);
  clearTab.api.clearWrongNotes();
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)), []);
});

test("2단계 F: 두 stale 탭의 clear/clear는 예외 없이 빈 배열을 유지한다", () => {
  const seed = createRuntime();
  const [a, b] = seed.api.QUESTION_SET.slice(0, 2);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a, b]) });
  const tab1 = createRuntime({}, { localStorage: storage });
  const tab2 = createRuntime({}, { localStorage: storage });
  tab1.api.init();
  tab2.api.init();
  assert.doesNotThrow(() => tab1.api.clearWrongNotes());
  assert.doesNotThrow(() => tab2.api.clearWrongNotes());
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)), []);
});

test("2단계 H: unit/label만 다른 legacy note도 canonical 값으로 저장한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const legacy = { ...question, unit: "pct", label: "legacy label" };
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: json([legacy]) });
  runtime.api.loadWrongNotes();
  const persisted = JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.wrongs))[0];
  assert.equal(runtime.api.state.wrongNotes[0].unit, question.unit);
  assert.equal(runtime.api.state.wrongNotes[0].label, question.label);
  assert.equal(persisted.unit, question.unit);
  assert.equal(persisted.label, question.label);
});

test("2단계 I: legacy bgm 값과 명시적 bgmLevel 우선순위를 보존한다", () => {
  const seed = createRuntime();
  const cases = [
    [{ bgm: false, sfx: false }, 0, true],
    [{ bgm: true, vibrate: false }, 3, true],
    [{ bgm: false, bgmLevel: 4, sfx: true, vibrate: true }, 4, false],
    [{ bgm: false, bgmLevel: -1, sfx: true, vibrate: true }, 3, false]
  ];
  cases.forEach(([storedSettings, expectedLevel, shouldMigrate]) => {
    const raw = json(storedSettings);
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: raw });
    runtime.api.loadSettings();
    assert.equal(runtime.api.state.settings.bgmLevel, expectedLevel);
    if (shouldMigrate) {
      assert.deepEqual(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.settings)), plain(runtime.api.state.settings));
      assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.settings)), "bgm"), false);
    } else {
      assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), raw);
    }
  });
});

test("2단계 J: stale valid-shaped note는 active pool에서 격리되고 add 시 보존된다", () => {
  const seed = createRuntime();
  const [a, c] = seed.api.QUESTION_SET.slice(0, 2);
  const stale = {
    id: "legacy__unknown__stage__item",
    examType: "포장검사",
    crop: "사라진 작물",
    stage: "원원종",
    item: "사라진 항목",
    answer: "1.0",
    unit: "%",
    label: "legacy stale"
  };
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: json([stale, a]) });
  runtime.api.init();
  assert.deepEqual(plain(runtime.api.state.wrongNotes.map(q => q.id)), [a.id]);
  assert.deepEqual(plain(runtime.api.state.preservedWrongNotes), [stale]);
  runtime.api.startWrongPracticeMode();
  assert.deepEqual(plain(runtime.api.state.pool.map(q => q.id)), [a.id]);
  runtime.api.pushWrongNote(c);
  const persisted = JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.wrongs));
  assert.equal(persisted.some(q => q && q.id === stale.id), true);
  assert.equal(persisted.some(q => q && q.id === c.id), true);
});

test("2단계 L: markup 문자열은 오답 카드에서 HTML이 아닌 텍스트로만 처리된다", () => {
  const seed = createRuntime();
  const active = seed.api.QUESTION_SET[0];
  const markup = '<img src=x onerror="globalThis.injected=true"><svg onload="globalThis.injected=true">';
  const stale = {
    id: "legacy-markup",
    examType: "포장검사",
    crop: markup,
    stage: "원원종",
    item: markup,
    answer: "1.0",
    unit: "%",
    label: markup
  };
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.wrongs]: json([stale, active])
  });
  runtime.api.init();
  runtime.api.renderWrongPage();
  assert.equal(runtime.element("wrong-list").children.length, 1);
  assert.equal(collectText(runtime.element("wrong-list")).includes(markup), false);
  const card = runtime.api.makeNoteItem(stale);
  assert.equal(card.innerHTML, "");
  assert.equal(card.children.every(child => child.innerHTML === ""), true);
  assert.equal(collectText(card).includes(markup), true);
});

test("2단계 M: legacy BGM migration setItem throw도 init을 막지 않는다", () => {
  const seed = createRuntime();
  const raw = json({ bgm: false, sfx: true, vibrate: true });
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.settings]: raw },
    { throwOnSet: true }
  );
  assert.doesNotThrow(() => runtime.api.init());
  assert.equal(runtime.api.state.settings.bgmLevel, 0);
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), raw);
  assert.equal(runtime.setCalls(), 1);
});

test("3단계 A/B/C: countdown 전에는 0/10·00:00이고 실제 clock으로 stopwatch가 시작된다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.tries, 0);
  assert.equal(runtime.api.state.wrong, 0);
  assert.equal(runtime.element("status-1-val").textContent, "00:00");
  assert.equal(runtime.element("status-2-val").textContent, "0 / 10");
  assert.equal(runtime.api.state.stopwatchStarted, false);

  runtime.advance(2100);
  runtime.runInterval(700, 3);
  assert.equal(runtime.api.state.stopwatchStarted, true);
  assert.equal(runtime.api.state.spinning, true);
  assert.equal(runtime.api.getElapsedSeconds(), 0);

  runtime.advance(10900);
  assert.equal(runtime.api.getElapsedSeconds(), 10);
  runtime.runInterval(250);
  assert.equal(runtime.element("status-1-val").textContent, "00:10");
  runtime.advance(200);
  assert.equal(runtime.api.getElapsedSeconds(), 11);
  runtime.runInterval(250);
  assert.equal(runtime.element("status-1-val").textContent, "00:11");
});

test("3단계 D: hidden 시간은 stopwatch elapsed에서 제외한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.runEnded = false;
  runtime.api.startStopwatch();
  runtime.advance(10000);
  runtime.setHidden(true);
  assert.equal(runtime.api.getElapsedSeconds(), 10);
  runtime.advance(30000);
  assert.equal(runtime.api.getElapsedSeconds(), 10);
  runtime.setHidden(false);
  runtime.advance(5000);
  assert.equal(runtime.api.getElapsedSeconds(), 15);
});

test("3단계 E: 실전 오답은 correct를 유지하고 저장한 뒤 다음 문제로 이동한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 3;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.element("ans").value = "999999";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 3);
  assert.equal(runtime.api.state.tries, 1);
  assert.equal(runtime.api.state.wrong, 1);
  assert.equal(runtime.api.state.wrongNotes[0].id, question.id);
  runtime.runTimeout(850);
  assert.equal(runtime.api.state.curQuestion.id, question.id);
  assert.equal(runtime.api.state.spinning, true);
});

test("3단계 F/G/K: 10번째 정답 순간 정수 초를 freeze하고 10/14 결과를 표시한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.wrong = 4;
  runtime.api.state.tries = 13;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.advance(181900);
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.tries, 14);
  assert.equal(runtime.api.state.runEnded, true);
  assert.equal(runtime.api.state.completionElapsedSeconds, 181);
  assert.equal(runtime.element("pbar").style.width, "100%");
  assert.equal(runtime.element("r-correct").textContent, "03:01");
  assert.equal(runtime.element("r-tries").textContent, "14");
  assert.equal(runtime.element("r-acc").textContent, "71%");
  assert.equal(runtime.element("r-wrong").textContent, "4");
  runtime.advance(10000);
  assert.equal(runtime.api.getElapsedSeconds(), 181);
});

test("3단계 H/I/J/K: 최고기록은 정수 초 우선, 동초에는 tries 우선이다", () => {
  const runtime = createRuntime();
  const betterTime = { elapsedSeconds: 181, tries: 25 };
  const slowerBase = { elapsedSeconds: 182, tries: 15 };
  assert.equal(runtime.api.isBetterCompletionRecord(betterTime, slowerBase), true);
  assert.equal(
    runtime.api.isBetterCompletionRecord(
      { elapsedSeconds: 181, tries: 18 },
      { elapsedSeconds: 181, tries: 20 }
    ),
    true
  );
  assert.equal(
    runtime.api.isBetterCompletionRecord(
      { elapsedSeconds: 181, tries: 18 },
      { elapsedSeconds: 181, tries: 18 }
    ),
    false
  );
  assert.equal(
    runtime.api.isBetterCompletionRecord(
      { elapsedSeconds: Math.floor(181900 / 1000), tries: 18 },
      { elapsedSeconds: Math.floor(181100 / 1000), tries: 18 }
    ),
    false
  );
});

test("3단계 L: 기존 60초 bestTimeAttack raw는 새 기록과 분리해 보존한다", () => {
  const seed = createRuntime();
  const oldBest = json({ correct: 12, tries: 15, acc: 80 });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.best]: oldBest });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.wrong = 8;
  runtime.api.state.tries = 18;
  runtime.api.state.elapsedMs = 181900;
  runtime.api.finishTimeMode();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.best), oldBest);
  assert.deepEqual(
    JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.completionBest)),
    { elapsedSeconds: 181, tries: 18 }
  );
});

for (const [name, value] of [
  ["invalid JSON", "{not-json"],
  ["null", json(null)],
  ["empty object", json({})],
  ["invalid fields", json({ elapsedSeconds: "181", tries: 10 })]
]) {
  test(`3단계 M: completion best ${name}은 load에서 원문을 보존한다`, () => {
    const seed = createRuntime();
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.completionBest]: value });
    runtime.api.init();
    assert.equal(runtime.api.state.bestCompletion, null);
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), value);
    assert.equal(runtime.element("page-home").classList.contains("active"), true);
  });
}

test("3단계 N: completion best setItem throw에도 완료 결과와 앱 사용이 유지된다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.wrong = 4;
  runtime.api.state.tries = 14;
  runtime.api.state.elapsedMs = 208900;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.element("r-correct").textContent, "03:28");
  assert.equal(runtime.element("r-tries").textContent, "14");
  assert.equal(runtime.element("r-acc").textContent, "71%");
  assert.equal(runtime.element("r-wrong").textContent, "4");
});

test("R1A A: stale 탭의 더 느린 기록은 persisted best를 후퇴시키지 않는다", () => {
  const storage = createStorage();
  const runtimeA = createRuntime({}, { localStorage: storage });
  const runtimeB = createRuntime({}, { localStorage: storage });
  runtimeA.api.init();
  runtimeB.api.init();

  finishCompletion(runtimeA, 30, 15);
  const writesAfterA = storage.setCalls();
  finishCompletion(runtimeB, 40, 15);

  assert.deepEqual(JSON.parse(storage.raw(runtimeA.api.STORAGE_KEYS.completionBest)), { elapsedSeconds: 30, tries: 15 });
  assert.deepEqual(plain(runtimeB.api.state.bestCompletion), { elapsedSeconds: 30, tries: 15 });
  assert.equal(runtimeB.element("new-badge").classList.contains("hidden"), true);
  assert.equal(storage.setCalls(), writesAfterA);
});

test("R1A B: stale 탭의 더 빠른 기록은 persisted best를 갱신한다", () => {
  const storage = createStorage();
  const runtimeA = createRuntime({}, { localStorage: storage });
  const runtimeB = createRuntime({}, { localStorage: storage });
  runtimeA.api.init();
  runtimeB.api.init();

  finishCompletion(runtimeA, 40, 15);
  finishCompletion(runtimeB, 30, 15);

  assert.deepEqual(JSON.parse(storage.raw(runtimeA.api.STORAGE_KEYS.completionBest)), { elapsedSeconds: 30, tries: 15 });
  assert.deepEqual(plain(runtimeB.api.state.bestCompletion), { elapsedSeconds: 30, tries: 15 });
  assert.equal(runtimeB.element("new-badge").classList.contains("hidden"), false);
});

test("R1A C: 같은 초의 더 많은 tries는 persisted best를 유지한다", () => {
  const seed = createRuntime();
  const raw = json({ elapsedSeconds: 30, tries: 15 });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.completionBest]: raw });
  runtime.api.init();
  const writesBefore = runtime.setCalls();

  finishCompletion(runtime, 30, 16);

  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), raw);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 30, tries: 15 });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
  assert.equal(runtime.setCalls(), writesBefore);
});

test("R1A D: 같은 초의 더 적은 tries는 persisted best를 갱신한다", () => {
  const seed = createRuntime();
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.completionBest]: json({ elapsedSeconds: 30, tries: 18 })
  });
  runtime.api.init();

  finishCompletion(runtime, 30, 16);

  assert.deepEqual(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.completionBest)), { elapsedSeconds: 30, tries: 16 });
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 30, tries: 16 });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), false);
});

test("R1A E: exact tie는 persisted raw를 overwrite하지 않는다", () => {
  const seed = createRuntime();
  const raw = '{ "elapsedSeconds": 30, "tries": 16 }';
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.completionBest]: raw });
  runtime.api.init();
  const writesBefore = runtime.setCalls();

  finishCompletion(runtime, 30, 16);

  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), raw);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 30, tries: 16 });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
  assert.equal(runtime.setCalls(), writesBefore);
});

test("R1A F: persisted best가 더 좋으면 stale state를 persisted 값으로 동기화한다", () => {
  const seed = createRuntime();
  const raw = json({ elapsedSeconds: 30, tries: 15 });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.completionBest]: raw });
  runtime.api.init();
  runtime.api.state.bestCompletion = { elapsedSeconds: 40, tries: 15 };
  const writesBefore = runtime.setCalls();

  finishCompletion(runtime, 35, 15);

  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), raw);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 30, tries: 15 });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
  assert.equal(runtime.setCalls(), writesBefore);
});

test("R1A G: malformed persisted best는 완료 시에도 crash나 destructive rewrite가 없다", () => {
  const seed = createRuntime();
  const raw = "{not-json";
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.completionBest]: raw });
  runtime.api.init();

  assert.doesNotThrow(() => finishCompletion(runtime, 35, 15));
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), raw);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 35, tries: 15 });
});

test("R1A H: completion best getItem failure는 완료 흐름을 중단하지 않는다", () => {
  const seed = createRuntime();
  const raw = json({ elapsedSeconds: 30, tries: 15 });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.completionBest]: raw }, { throwOnGet: true });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  assert.doesNotThrow(() => finishCompletion(runtime, 35, 15));
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.completionBest), raw);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 35, tries: 15 });
});

test("R1A I: monotonic completion best 갱신은 legacy best raw를 변경하지 않는다", () => {
  const seed = createRuntime();
  const legacyRaw = json({ correct: 12, tries: 15, acc: 80 });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.best]: legacyRaw });
  runtime.api.init();

  finishCompletion(runtime, 35, 15);

  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.best), legacyRaw);
  assert.deepEqual(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.completionBest)), { elapsedSeconds: 35, tries: 15 });
});

test("R1A J: single-tab best는 35초에서 30초로 갱신되고 40초로 후퇴하지 않는다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const key = runtime.api.STORAGE_KEYS.completionBest;

  finishCompletion(runtime, 35, 15);
  assert.deepEqual(JSON.parse(runtime.raw(key)), { elapsedSeconds: 35, tries: 15 });
  finishCompletion(runtime, 30, 15);
  assert.deepEqual(JSON.parse(runtime.raw(key)), { elapsedSeconds: 30, tries: 15 });
  finishCompletion(runtime, 40, 15);

  assert.deepEqual(JSON.parse(runtime.raw(key)), { elapsedSeconds: 30, tries: 15 });
  assert.deepEqual(plain(runtime.api.state.bestCompletion), { elapsedSeconds: 30, tries: 15 });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
});

test("3단계 O: 다시 도전은 이전 stopwatch와 완료 상태를 초기화한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.wrong = 9;
  runtime.api.state.tries = 19;
  runtime.api.state.elapsedMs = 99000;
  runtime.api.finishTimeMode();
  runtime.api.startTimeMode();
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.wrong, 0);
  assert.equal(runtime.api.state.tries, 0);
  assert.equal(runtime.api.state.runEnded, false);
  assert.equal(runtime.api.state.completionElapsedSeconds, null);
  assert.equal(runtime.api.state.stopwatchStarted, false);
  assert.equal(runtime.element("status-1-val").textContent, "00:00");
  assert.equal(runtime.element("status-2-val").textContent, "0 / 10");
  assert.equal(runtime.intervalCount(250), 0);
  assert.equal(runtime.intervalCount(700), 1);
});

test("3단계 P/Q: 연습·오답연습과 manual STOP·가중 선택 구조를 유지한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: json([question]) });
  runtime.api.init();
  runtime.api.startWrongPracticeMode();
  assert.equal(runtime.api.state.mode, "wrong-practice");
  assert.equal(runtime.api.state.spinning, true);
  runtime.api.stopSpin();
  assert.equal(runtime.api.state.spinning, false);
  assert.equal(runtime.api.state.curQuestion.id, question.id);
  assert.match(APP_SOURCE, /getStageWeight\(q\.stage\) \* getCropWeight\(q\.crop\)/);
  assert.match(APP_SOURCE, /state\.curQuestion = restoredQuestion \|\| pickQuestion\(\);/);
  assert.doesNotMatch(APP_SOURCE, /setTimeout\([^)]*stopSpin/);
});

function makeCheckpoint(runtime, overrides = {}) {
  const question = runtime.api.QUESTION_SET[0];
  return {
    version: runtime.api.TIME_CHECKPOINT_VERSION,
    runId: "fixture-run",
    correct: 3,
    tries: 5,
    wrong: 2,
    combo: 0,
    maxCombo: 0,
    elapsedMs: 12345,
    phase: "spin",
    questionId: question.id,
    recentWrongIds: [question.id],
    ...overrides
  };
}

test("4단계 A: 체크포인트가 없으면 기존 실전 시작 버튼만 표시한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.element("btn-home-time").click();
  assert.equal(runtime.api.state.timeCheckpoint, null);
  assert.equal(runtime.element("btn-time-intro-start").classList.contains("hidden"), false);
  assert.equal(runtime.element("time-resume-card").classList.contains("hidden"), true);
  assert.equal(runtime.element("time-resume-actions").classList.contains("hidden"), true);
});

test("4단계 B/C: 첫 실제 round부터 spin 체크포인트를 저장하고 reload 요약을 복원한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  assert.equal(runtime.raw(runtime.api.STORAGE_KEYS.inProgress), undefined);
  runtime.runInterval(700, 3);
  const saved = JSON.parse(runtime.raw(runtime.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.phase, "spin");
  assert.equal(saved.correct, 0);
  assert.equal(saved.elapsedMs, 0);
  assert.equal(saved.questionId, runtime.api.state.curQuestion.id);

  const reloaded = createRuntime({
    [runtime.api.STORAGE_KEYS.inProgress]: json(saved)
  });
  reloaded.api.init();
  reloaded.element("btn-home-time").click();
  assert.equal(reloaded.element("btn-time-intro-start").classList.contains("hidden"), true);
  assert.equal(reloaded.element("time-resume-card").classList.contains("hidden"), false);
  assert.equal(reloaded.element("time-resume-summary").textContent.includes("3"), false);
  assert.equal(reloaded.element("time-resume-summary").textContent.includes("0 / 10"), true);
});

test("4단계 D/E: spin 이어하기는 countdown 없이 같은 문제를 다시 회전시킨다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { phase: "spin" });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  assert.equal(runtime.api.state.curQuestion.id, checkpoint.questionId);
  assert.equal(runtime.api.state.spinning, true);
  assert.equal(runtime.api.state.correct, 3);
  assert.equal(runtime.api.state.tries, 5);
  assert.equal(runtime.api.state.wrong, 2);
  assert.equal(runtime.api.state.recentWrongs[0].id, checkpoint.questionId);
  assert.equal(runtime.intervalCount(700), 0);
  assert.equal(runtime.intervalCount(250), 1);
});

test("4단계 C: 앱을 닫아둔 시간은 제외하고 resume 이후 active 시간만 더한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, {
    correct: 7,
    tries: 9,
    wrong: 2,
    elapsedMs: 154321
  });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  }, { nowMs: 1800000 });
  runtime.api.init();
  runtime.element("btn-home-time").click();
  assert.equal(runtime.element("time-resume-summary").textContent, "정답 7 / 10 · 플레이 시간 02:34");
  runtime.api.resumeTimeMode();
  assert.equal(runtime.api.buildTimeCheckpoint().elapsedMs, 154321);
  runtime.advance(5000);
  assert.equal(runtime.api.buildTimeCheckpoint().elapsedMs, 159321);
});

test("4단계 F: answer 이어하기는 같은 문제와 입력 단계를 복원한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { phase: "answer" });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  assert.equal(runtime.api.state.curQuestion.id, checkpoint.questionId);
  assert.equal(runtime.api.state.spinning, false);
  assert.equal(runtime.api.state.scored, false);
  assert.equal(runtime.element("input-row").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), false);
  assert.equal(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.inProgress)).phase, "answer");
});

test("4단계 G: feedback 이어하기는 이미 채점된 문제를 재채점하지 않고 다음 round로 간다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { phase: "feedback" });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  assert.equal(runtime.api.state.correct, checkpoint.correct);
  assert.equal(runtime.api.state.tries, checkpoint.tries);
  assert.equal(runtime.api.state.wrong, checkpoint.wrong);
  assert.equal(runtime.api.state.spinning, true);
  assert.notEqual(runtime.api.state.curQuestion.id, checkpoint.questionId);
  assert.equal(JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.inProgress)).phase, "spin");
});

test("4단계 G2: 복원한 recent wrong은 완료 결과의 이번 판 오답에 유지된다", () => {
  const seed = createRuntime();
  const [q1, q2, q3] = seed.api.QUESTION_SET;
  const checkpoint = makeCheckpoint(seed, {
    correct: 9,
    tries: 11,
    wrong: 2,
    elapsedMs: 30000,
    phase: "answer",
    questionId: q3.id,
    recentWrongIds: [q1.id, q2.id]
  });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  runtime.element("ans").value = q3.answer;
  runtime.api.evaluateAnswer();
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.api.state.recentWrongs.length, 2);
  assert.equal(runtime.element("result-wrong-list").children.length, 2);
});

test("4단계 G3: recent wrong의 미존재 ID는 checkpoint 전체를 깨지 않고 해당 항목만 격리한다", () => {
  const seed = createRuntime();
  const [question] = seed.api.QUESTION_SET;
  const checkpoint = makeCheckpoint(seed, {
    recentWrongIds: [question.id, "missing-question-id"]
  });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  assert.deepEqual(plain(runtime.api.state.recentWrongs.map(q => q.id)), [question.id]);
});

test("4단계 H/I: hidden 및 pagehide 저장은 비활성 시간을 누적하지 않는다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  runtime.advance(10000);
  runtime.setHidden(true);
  let saved = JSON.parse(runtime.raw(runtime.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.elapsedMs, 10000);
  runtime.advance(30000);
  runtime.setHidden(false);
  runtime.advance(5000);
  runtime.triggerPageHide();
  saved = JSON.parse(runtime.raw(runtime.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.elapsedMs, 15000);
  assert.equal(runtime.api.getElapsedSeconds(), 15);
});

test("4단계 J: 확인한 실전 종료는 현재 phase를 저장하고 홈에서 이어갈 수 있다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  runtime.api.stopSpin();
  const questionId = runtime.api.state.curQuestion.id;
  runtime.api.state.correct = 7;
  runtime.api.state.tries = 9;
  runtime.api.state.wrong = 2;
  runtime.api.saveTimeCheckpoint("answer");
  runtime.advance(4200);
  runtime.api.handleQuitPlay();
  const saved = JSON.parse(runtime.raw(runtime.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.phase, "answer");
  assert.equal(saved.questionId, questionId);
  assert.equal(saved.elapsedMs, 4200);
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  runtime.element("btn-home-time").click();
  assert.equal(runtime.element("time-resume-summary").textContent, "정답 7 / 10 · 플레이 시간 00:04");
  assert.equal(runtime.element("btn-time-resume").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-time-new").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-time-intro-start").classList.contains("hidden"), true);
});

test("4단계 K: 실전 종료 확인 취소는 진행과 저장값을 변경하지 않는다", () => {
  const runtime = createRuntime({}, { confirmResult: false });
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  const before = runtime.raw(runtime.api.STORAGE_KEYS.inProgress);
  runtime.api.handleQuitPlay();
  assert.equal(runtime.api.state.runEnded, false);
  assert.equal(runtime.api.state.stopwatchRunning, true);
  assert.equal(runtime.raw(runtime.api.STORAGE_KEYS.inProgress), before);
  assert.equal(runtime.element("page-play").classList.contains("active"), true);
});

test("4단계 L: 새로 시작 확인 취소는 체크포인트를 보존한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed);
  const raw = json(checkpoint);
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.inProgress]: raw },
    { confirmResult: false }
  );
  runtime.api.init();
  runtime.api.startNewTimeModeFromCheckpoint();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), raw);
  assert.equal(runtime.api.state.timeCheckpoint.questionId, checkpoint.questionId);
  assert.equal(runtime.intervalCount(700), 0);
});

test("4단계 M: 새로 시작 확인은 기존 체크포인트를 삭제하고 0/10 countdown을 시작한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed);
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.startNewTimeModeFromCheckpoint();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
  assert.equal(runtime.api.state.timeCheckpoint, null);
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.tries, 0);
  assert.equal(runtime.intervalCount(700), 1);
});

test("4단계 N/O: 완료는 체크포인트를 삭제하고 removeItem 실패에도 결과를 표시한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { correct: 9, tries: 11, wrong: 2 });
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) },
    { throwOnRemove: true }
  );
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.tries = 12;
  runtime.api.state.wrong = 2;
  runtime.api.state.elapsedMs = 50000;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.api.state.timeCheckpoint, null);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.removeCalls(), 1);
  const reloaded = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: runtime.raw(seed.api.STORAGE_KEYS.inProgress)
  });
  reloaded.api.init();
  assert.equal(reloaded.api.state.timeCheckpoint, null);
});

for (const [name, raw] of [
  ["invalid JSON", "{bad-json"],
  ["null", json(null)],
  ["empty object", json({})],
  ["array", json([])],
  ["string", json("checkpoint")],
  ["number", json(7)],
  ["wrong version", json({ version: 999 })],
  ["completed correct", json(makeCheckpoint(createRuntime(), { correct: 10, tries: 12 }))],
  ["invalid counters", json(makeCheckpoint(createRuntime(), { tries: 1 }))],
  ["negative wrong", json(makeCheckpoint(createRuntime(), { wrong: -1 }))],
  ["negative elapsed", json(makeCheckpoint(createRuntime(), { elapsedMs: -1 }))],
  ["invalid phase", json(makeCheckpoint(createRuntime(), { phase: "countdown" }))],
  ["missing question", json(makeCheckpoint(createRuntime(), { questionId: "" }))],
  ["unknown question", json(makeCheckpoint(createRuntime(), { questionId: "missing" }))],
  ["invalid recent wrongs", json(makeCheckpoint(createRuntime(), { recentWrongIds: "bad" }))]
]) {
  test(`4단계 P: invalid checkpoint ${name}은 원문을 보존하고 이어하기를 숨긴다`, () => {
    const seed = createRuntime();
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: raw });
    runtime.api.init();
    runtime.element("btn-home-time").click();
    assert.equal(runtime.api.state.timeCheckpoint, null);
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), raw);
    assert.equal(runtime.element("btn-time-intro-start").classList.contains("hidden"), false);
    assert.equal(runtime.element("time-resume-actions").classList.contains("hidden"), true);
  });
}

test("4단계 Q: checkpoint setItem throw에도 round·채점·다음 문제·종료가 계속된다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  runtime.api.startTimeMode();
  assert.doesNotThrow(() => runtime.runInterval(700, 3));
  assert.equal(runtime.api.state.spinning, true);
  assert.doesNotThrow(() => runtime.api.stopSpin());
  const question = runtime.api.state.curQuestion;
  runtime.element("ans").value = "999999";
  assert.doesNotThrow(() => runtime.api.evaluateAnswer());
  assert.equal(runtime.api.state.wrong, 1);
  assert.doesNotThrow(() => runtime.runTimeout(850));
  assert.equal(runtime.api.state.spinning, true);
  runtime.api.state.correct = 10;
  runtime.api.state.tries = 11;
  runtime.api.state.wrong = 1;
  runtime.api.state.curQuestion = question;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
});

test("4단계 O2: checkpoint setItem throw에도 quit은 홈으로 이동한다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  assert.doesNotThrow(() => runtime.api.handleQuitPlay());
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
  assert.equal(runtime.api.state.runEnded, true);
});

test("4단계 R: 완료 후 다시 도전은 checkpoint 없이 0/10 countdown부터 시작한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { correct: 9, tries: 11, wrong: 2 });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 10;
  runtime.api.state.tries = 12;
  runtime.api.state.wrong = 2;
  runtime.api.state.elapsedMs = 45000;
  runtime.api.finishTimeMode();
  runtime.api.startTimeMode();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.tries, 0);
  assert.equal(runtime.api.state.elapsedMs, 0);
  assert.equal(runtime.intervalCount(700), 1);
});

test("4단계 T: resume run 완료도 completion best의 초 우선·동초 tries 우선 규칙을 유지한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[2];
  const checkpoint = makeCheckpoint(seed, {
    correct: 9,
    tries: 12,
    wrong: 3,
    elapsedMs: 61000,
    phase: "answer",
    questionId: question.id,
    recentWrongIds: []
  });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint),
    [seed.api.STORAGE_KEYS.completionBest]: json({ elapsedSeconds: 61, tries: 20 })
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();
  assert.deepEqual(
    JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.completionBest)),
    { elapsedSeconds: 61, tries: 13 }
  );
});

test("4단계 U: resume 중 오답도 persisted wrongNotes 최신값과 병합한다", () => {
  const seed = createRuntime();
  const [existing, current] = seed.api.QUESTION_SET;
  const checkpoint = makeCheckpoint(seed, {
    phase: "answer",
    questionId: current.id,
    recentWrongIds: []
  });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint),
    [seed.api.STORAGE_KEYS.wrongs]: json([existing])
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  runtime.element("ans").value = "999999";
  runtime.api.evaluateAnswer();
  assert.deepEqual(
    JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.wrongs)).map(q => q.id),
    [current.id, existing.id]
  );
});

test("4단계 R: practice와 wrong-practice는 실전 체크포인트를 생성하지 않는다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: json([question]) });
  runtime.api.init();
  runtime.api.startPracticeMode();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
  runtime.api.startWrongPracticeMode();
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
});

test("5단계 A: 정수와 소수 표현은 숫자값이 같으면 정답이다", () => {
  for (const input of ["14", "14.0", "14.00", "014", "014.000"]) {
    assert.equal(runtimeForScoring().api.isAnswerCorrect(input, "14"), true, input);
  }
  for (const input of ["14.1", "13.999"]) {
    assert.equal(runtimeForScoring().api.isAnswerCorrect(input, "14"), false, input);
  }
});

test("5단계 B/C: trailing zero와 작은 소수는 숫자값 기준으로 비교한다", () => {
  const runtime = runtimeForScoring();
  for (const input of ["0.1", "0.10", "0.100", "00.10"]) {
    assert.equal(runtime.api.isAnswerCorrect(input, "0.1"), true, input);
  }
  for (const input of ["0.01", "0.11", "0.1001"]) {
    assert.equal(runtime.api.isAnswerCorrect(input, "0.1"), false, input);
  }
  for (const input of ["0.01", "0.010", "00.01", "000.0100"]) {
    assert.equal(runtime.api.isAnswerCorrect(input, "0.01"), true, input);
  }
  for (const input of ["0.1", "0.001"]) {
    assert.equal(runtime.api.isAnswerCorrect(input, "0.01"), false, input);
  }
});

test("5단계 D/E: 숫자 형식 밖의 입력과 실제 다른 값은 오답이다", () => {
  const runtime = runtimeForScoring();
  for (const input of ["", " ", "abc", "14abc", "1e1", "1E1", "-1", "+1", ".1", "1.", "NaN", "Infinity"]) {
    assert.equal(runtime.api.isAnswerCorrect(input, "14"), false, input);
  }
  assert.equal(runtime.api.isAnswerCorrect("0.1000001", "0.1"), false);
});

test("5단계 F: canonical answer와 안내·placeholder 문구를 보존한다", () => {
  const runtime = runtimeForScoring();
  const question = { examType: "종자검사", stage: "원종", crop: "벼", item: "발아율", answer: "0.10", unit: "%" };
  assert.equal(runtime.api.isAnswerCorrect("0.1", question.answer), true);
  assert.match(runtime.api.formatFeedback(question, true), /0\.10%/);
  assert.equal(runtime.api.getAnswerGuideText(question), "");
  assert.equal(runtime.api.getAnswerPlaceholder(question), "숫자 입력");
  assert.doesNotMatch(APP_SOURCE, /소수 첫째 자리까지 입력|소수 둘째 자리까지 입력/);
  assert.match(fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8"), /play-answer-guide\{visibility:hidden/);
});

test("5단계 G: 실전모드 9정답 상태에서 14.0에 14를 입력하면 정상 완료한다", () => {
  const runtime = runtimeForScoring();
  const question = runtime.api.QUESTION_SET.find(q => q.answer === "14.0");
  assert.ok(question);
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.tries = 9;
  runtime.api.state.wrong = 0;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.element("ans").value = "14";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.tries, 10);
  assert.equal(runtime.api.state.runEnded, true);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
});

test("5단계 H: 실전모드에서 실제 다른 숫자는 correct를 늘리지 않고 오답 흐름을 유지한다", () => {
  const runtime = runtimeForScoring();
  const question = runtime.api.QUESTION_SET.find(q => q.answer === "14.0");
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.element("ans").value = "14.1";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.wrong, 1);
  assert.equal(runtime.api.state.tries, 1);
  assert.equal(runtime.api.state.wrongNotes[0].id, question.id);
  runtime.runTimeout(850);
  assert.equal(runtime.api.state.spinning, true);
});

test("5단계 I/J: practice와 wrong-practice도 동일한 숫자 동등 판정을 사용한다", () => {
  const question = runtimeForScoring().api.QUESTION_SET.find(q => q.answer === "0.10");
  const practice = runtimeForScoring();
  practice.api.init();
  practice.api.state.mode = "practice";
  practice.api.state.pool = [question];
  practice.api.state.curQuestion = question;
  practice.element("ans").value = "0.1";
  practice.api.evaluateAnswer();
  assert.equal(practice.api.state.correct, 1);

  const wrong = runtimeForScoring({ [runtimeForScoring().api.STORAGE_KEYS.wrongs]: json([question]) });
  wrong.api.init();
  wrong.api.startWrongPracticeMode();
  wrong.api.state.curQuestion = question;
  wrong.api.state.pool = [question];
  wrong.element("ans").value = "0.1";
  wrong.api.evaluateAnswer();
  assert.equal(wrong.api.state.correct, 1);
});

test("5단계 K: answer phase resume에서도 0.10에 0.1을 한 번만 채점한다", () => {
  const seed = runtimeForScoring();
  const question = seed.api.QUESTION_SET.find(q => q.answer === "0.10");
  const checkpoint = makeCheckpoint(seed, {
    correct: 0,
    tries: 0,
    wrong: 0,
    phase: "answer",
    questionId: question.id,
    recentWrongIds: []
  });
  const runtime = runtimeForScoring({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  runtime.element("ans").value = "0.1";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 1);
  assert.equal(runtime.api.state.tries, 1);
  assert.equal(runtime.api.state.wrong, 0);
});

function runtimeForScoring(initialStorage = {}) {
  return createRuntime(initialStorage);
}

test("6단계 A: decimal guide는 레이아웃 공간을 차지하지 않고 짧은 화면 보정이 존재한다", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  assert.match(css, /#page-play \.play-answer-guide\{[\s\S]*?display:none !important;[\s\S]*?min-height:0 !important;/);
  assert.match(css, /@media \(max-width:700px\) and \(max-height:640px\)\{[\s\S]*?--answer-zone-h:280px !important;/);
  assert.match(css, /@media \(max-width:700px\) and \(max-height:620px\)\{[\s\S]*?--answer-zone-h:260px !important;/);
});

test("6단계 B: answer phase는 390→800→390 전환에도 문제·입력·점수를 보존하며 입력 정책만 동기화한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const checkpoint = makeCheckpoint(seed, {
    correct: 7,
    tries: 9,
    wrong: 2,
    phase: "answer",
    questionId: question.id
  });
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) },
    { viewportWidth: 390 }
  );
  runtime.api.init();
  runtime.api.resumeTimeMode();
  runtime.element("ans").value = "12.3";

  assert.equal(runtime.element("ans").readOnly, true);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
  const before = {
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong
  };

  runtime.resizeTo(800);
  assert.equal(runtime.element("ans").readOnly, false);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), true);
  assert.equal(runtime.element("ans").value, "12.3");
  assert.deepEqual(plain({
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong
  }), before);

  runtime.resizeTo(390);
  assert.equal(runtime.element("ans").readOnly, true);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
  assert.equal(runtime.element("ans").value, "12.3");

  const desktop = createRuntime(
    { [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) },
    { viewportWidth: 800 }
  );
  desktop.api.init();
  desktop.api.resumeTimeMode();
  assert.equal(desktop.element("ans").readOnly, false);
  assert.equal(desktop.element("mobile-keypad").classList.contains("hidden"), true);
});

test("6단계 C: spin phase resize는 현재 문제·점수·룰렛 interval을 바꾸지 않고 STOP을 유지한다", () => {
  const runtime = createRuntime({}, { viewportWidth: 390 });
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  const before = {
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong,
    intervals: runtime.intervalCount()
  };

  runtime.resizeTo(800);
  runtime.resizeTo(390);
  assert.equal(runtime.api.state.spinning, true);
  assert.equal(runtime.element("btn-stop").classList.contains("hidden"), false);
  assert.deepEqual(plain({
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong,
    intervals: runtime.intervalCount()
  }), before);
  runtime.api.stopSpin();
  assert.equal(runtime.api.state.runPhase, "answer");
});

test("6단계 D: feedback phase resize는 채점과 다음-round 예약을 중복하지 않는다", () => {
  const runtime = createRuntime({}, { viewportWidth: 390 });
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  runtime.api.stopSpin();
  runtime.element("ans").value = runtime.api.state.curQuestion.answer;
  runtime.api.evaluateAnswer();
  const before = {
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong,
    nextTimeouts: runtime.timeoutCount(850)
  };

  runtime.resizeTo(800);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), true);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), true);
  runtime.resizeTo(390);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), false);
  assert.deepEqual(plain({
    questionId: runtime.api.state.curQuestion.id,
    correct: runtime.api.state.correct,
    tries: runtime.api.state.tries,
    wrong: runtime.api.state.wrong,
    nextTimeouts: runtime.timeoutCount(850)
  }), before);
});

test("7단계 A: 네 홈 이미지 버튼의 semantic과 단일 click handler를 보존한다", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const [id, label] of [
    ["btn-home-time", "실전모드"],
    ["btn-home-practice", "연습모드"],
    ["btn-home-wrong", "오답노트"],
    ["btn-home-settings", "설정"]
  ]) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*aria-label="${label}"`));
    assert.equal((APP_SOURCE.match(new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("click"`, "g")) || []).length, 1);
  }
  assert.match(html, /<div class="home-stage">[\s\S]*id="btn-home-time"[\s\S]*id="btn-home-practice"[\s\S]*id="btn-home-wrong"[\s\S]*id="btn-home-settings"/);
});

test("7단계 B: 홈은 941:1672 contain stage와 겹치지 않는 동일 좌표계 버튼을 사용한다", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const marker = css.lastIndexOf("/* Stage 7 home coordinate-system stabilization */");
  assert.ok(marker > css.lastIndexOf("object-fit:cover"));
  const stageCss = css.slice(marker);
  assert.match(stageCss, /#page-home \.home-stage\{[\s\S]*?aspect-ratio:941 \/ 1672 !important;/);
  assert.match(stageCss, /#page-home \.home-bg-image\{[\s\S]*?object-fit:contain !important;/);
  assert.match(stageCss, /#page-home \.home-btn-large\{[\s\S]*?min-height:0 !important;[\s\S]*?aspect-ratio:797 \/ 225 !important;/);
  assert.match(stageCss, /#page-home \.home-btn-small\{[\s\S]*?min-height:0 !important;[\s\S]*?aspect-ratio:955 \/ 261 !important;/);

  const rects = [
    { id: "time", x: .17, y: .6015, w: .66, h: .66 * 941 / 1672 * 225 / 797 },
    { id: "practice", x: .17, y: .7141, w: .66, h: .66 * 941 / 1672 * 225 / 797 },
    { id: "wrong", x: .17, y: .8268, w: .31, h: .31 * 941 / 1672 * 261 / 955 },
    { id: "settings", x: .52, y: .8268, w: .31, h: .31 * 941 / 1672 * 261 / 955 }
  ];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlapWidth = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const overlapHeight = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.equal(overlapWidth * overlapHeight, 0, `${a.id}/${b.id}`);
    }
  }
});

test("8단계 A/B/C/D/E: 정답 combo 증가·3연속 feedback·오답 reset·maxCombo 보존", () => {
  const runtime = runtimeForScoring();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;

  const answer = value => {
    runtime.api.state.scored = false;
    runtime.element("ans").value = value;
    runtime.api.evaluateAnswer();
  };

  answer(question.answer);
  assert.equal(runtime.api.state.combo, 1);
  assert.equal(runtime.api.state.maxCombo, 1);
  assert.doesNotMatch(runtime.element("feedback").innerHTML, /연속/);
  answer(question.answer);
  assert.equal(runtime.api.state.combo, 2);
  assert.equal(runtime.api.state.maxCombo, 2);
  assert.doesNotMatch(runtime.element("feedback").innerHTML, /연속/);
  answer(question.answer);
  assert.equal(runtime.api.state.combo, 3);
  assert.equal(runtime.api.state.maxCombo, 3);
  assert.match(runtime.element("feedback").innerHTML, /🔥 3연속!/);

  answer("999999");
  assert.equal(runtime.api.state.combo, 0);
  assert.equal(runtime.api.state.maxCombo, 3);
  assert.doesNotMatch(runtime.element("feedback").innerHTML, /연속/);
  answer(question.answer);
  assert.equal(runtime.api.state.combo, 1);
  assert.equal(runtime.api.state.maxCombo, 3);
  assert.doesNotMatch(runtime.element("feedback").innerHTML, /연속/);
});

test("8단계 E/H: 10번째 정답도 combo/maxCombo를 갱신하고 결과에 최대 연속을 표시한다", () => {
  const runtime = runtimeForScoring();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.tries = 9;
  runtime.api.state.wrong = 0;
  runtime.api.state.combo = 4;
  runtime.api.state.maxCombo = 4;
  runtime.api.startStopwatch();
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.combo, 5);
  assert.equal(runtime.api.state.maxCombo, 5);
  assert.equal(runtime.element("r-max-combo").textContent, "5");
  assert.equal(runtime.api.state.runEnded, true);
});

test("8단계 I/J/K: practice·wrong-practice도 동일한 combo 흐름을 사용하고 새 run은 0부터 시작한다", () => {
  const seed = runtimeForScoring();
  const question = seed.api.QUESTION_SET[0];
  for (const mode of ["practice", "wrong-practice"]) {
    const runtime = runtimeForScoring({ [seed.api.STORAGE_KEYS.wrongs]: json([question]) });
    runtime.api.init();
    runtime.api.state.mode = mode;
    runtime.api.state.pool = [question];
    runtime.api.state.curQuestion = question;
    runtime.element("ans").value = question.answer;
    runtime.api.evaluateAnswer();
    assert.equal(runtime.api.state.combo, 1, mode);
    runtime.api.state.scored = false;
    runtime.element("ans").value = question.answer;
    runtime.api.evaluateAnswer();
    runtime.api.state.scored = false;
    runtime.element("ans").value = question.answer;
    runtime.api.evaluateAnswer();
    assert.equal(runtime.api.state.combo, 3, mode);
    assert.match(runtime.element("feedback").innerHTML, /🔥 3연속!/);
    runtime.api.state.combo = 7;
    runtime.api.state.maxCombo = 8;
    runtime.api.resetRunCommon();
    assert.equal(runtime.api.state.combo, 0, mode);
    assert.equal(runtime.api.state.maxCombo, 0, mode);
  }
});

test("8단계 I/J: 실전·연습·오답연습 시작과 다시 도전은 combo/maxCombo를 0으로 초기화한다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];

  const time = createRuntime();
  time.api.init();
  time.api.state.combo = 6;
  time.api.state.maxCombo = 8;
  time.api.startTimeMode();
  assert.equal(time.api.state.combo, 0);
  assert.equal(time.api.state.maxCombo, 0);

  const practice = createRuntime();
  practice.api.init();
  practice.api.state.combo = 4;
  practice.api.state.maxCombo = 4;
  practice.api.resetRunCommon();
  assert.equal(practice.api.state.combo, 0);
  assert.equal(practice.api.state.maxCombo, 0);

  const wrong = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: json([question]) });
  wrong.api.init();
  wrong.api.state.combo = 4;
  wrong.api.state.maxCombo = 5;
  wrong.api.startWrongPracticeMode();
  assert.equal(wrong.api.state.combo, 0);
  assert.equal(wrong.api.state.maxCombo, 0);
});

test("8단계 M/N/O/P: v2 checkpoint가 phase별 combo/maxCombo를 복원하고 feedback 후 중복 채점하지 않는다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const checkpoint = makeCheckpoint(seed, {
    version: 2,
    runId: undefined,
    correct: 5,
    tries: 7,
    wrong: 2,
    combo: 2,
    maxCombo: 3,
    phase: "spin",
    questionId: question.id
  });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  runtime.api.init();
  runtime.api.resumeTimeMode();
  assert.equal(runtime.api.state.combo, 2);
  assert.equal(runtime.api.state.maxCombo, 3);
  assert.equal(runtime.api.state.curQuestion.id, question.id);

  const answerCheckpoint = { ...checkpoint, phase: "answer" };
  const answerRuntime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(answerCheckpoint) });
  answerRuntime.api.init();
  answerRuntime.api.resumeTimeMode();
  answerRuntime.element("ans").value = question.answer;
  answerRuntime.api.evaluateAnswer();
  assert.equal(answerRuntime.api.state.combo, 3);
  assert.equal(answerRuntime.api.state.maxCombo, 3);
  assert.match(answerRuntime.element("feedback").innerHTML, /🔥 3연속!/);

  const feedbackCheckpoint = { ...checkpoint, combo: 4, maxCombo: 4, phase: "feedback" };
  const feedbackRuntime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(feedbackCheckpoint) });
  feedbackRuntime.api.init();
  feedbackRuntime.api.resumeTimeMode();
  assert.equal(feedbackRuntime.api.state.combo, 4);
  assert.equal(feedbackRuntime.api.state.maxCombo, 4);
  assert.equal(feedbackRuntime.api.state.correct, 5);
  assert.equal(feedbackRuntime.api.state.tries, 7);

  const wrongFeedback = { ...feedbackCheckpoint, combo: 0, maxCombo: 4 };
  const wrongRuntime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(wrongFeedback) });
  wrongRuntime.api.init();
  wrongRuntime.api.resumeTimeMode();
  assert.equal(wrongRuntime.api.state.combo, 0);
  assert.equal(wrongRuntime.api.state.maxCombo, 4);
});

test("8단계 Q: legacy v1 checkpoint는 combo 0으로 resume하고 다음 저장부터 현재 버전이 된다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const legacy = {
    version: 1,
    correct: 5,
    tries: 7,
    wrong: 2,
    elapsedMs: 12345,
    phase: "spin",
    questionId: question.id,
    recentWrongIds: []
  };
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(legacy) });
  runtime.api.init();
  assert.equal(runtime.api.state.timeCheckpoint.version, 3);
  assert.match(runtime.api.state.timeCheckpoint.runId, /^legacy-/);
  assert.equal(runtime.api.state.timeCheckpoint.combo, 0);
  assert.equal(runtime.api.state.timeCheckpoint.maxCombo, 0);
  runtime.api.resumeTimeMode();
  const saved = JSON.parse(runtime.raw(seed.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.version, 3);
  assert.equal(saved.runId, runtime.api.state.runId);
  assert.equal(saved.combo, 0);
  assert.equal(saved.maxCombo, 0);
});

test("8단계 R/S/T: malformed v2 combo는 crash 없이 격리하고 별도 all-time combo key를 만들지 않는다", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  for (const overrides of [
    { combo: -1, maxCombo: 0 },
    { combo: 4, maxCombo: 3 },
    { combo: 3, maxCombo: 3, correct: 2 },
    { combo: 2, maxCombo: 8, correct: 5 }
  ]) {
    const checkpoint = makeCheckpoint(seed, overrides);
    const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
    assert.doesNotThrow(() => runtime.api.init());
    assert.equal(runtime.api.state.timeCheckpoint, null);
  }
  assert.deepEqual(Object.keys(seed.api.STORAGE_KEYS).sort(), ["best", "completionBest", "inProgress", "settings", "wrongs"]);
  assert.equal(seed.api.TIME_CHECKPOINT_VERSION, 3);
  assert.equal(seed.api.normalizeTimeCheckpoint({ version: 1 }), null);
});
test("Stage 9: settings BGM/SFX/vibrate edits stay in a draft until save", () => {
  const seed = createRuntime();
  const stored = json({ bgmLevel: 3, sfx: true, vibrate: true });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: stored });
  runtime.api.init();
  runtime.element("btn-home-settings").click();
  assert.deepEqual(plain(runtime.api.state.settingsDraft), { bgmLevel: 3, sfx: true, vibrate: true });
  runtime.element("btn-bgm-up").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("toggle-sfx").checked = false;
  runtime.element("toggle-vibrate").checked = false;
  runtime.api.syncSettingsDraftFromUI();
  assert.deepEqual(plain(runtime.api.state.settings), { bgmLevel: 3, sfx: true, vibrate: true });
  assert.deepEqual(plain(runtime.api.state.settingsDraft), { bgmLevel: 5, sfx: false, vibrate: false });
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), stored);
});

test("Stage 9: settings close and backdrop discard draft and restore committed BGM", () => {
  const seed = createRuntime();
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: json({ bgmLevel: 3, sfx: true, vibrate: true }) });
  runtime.api.init();
  runtime.element("btn-home-settings").click();
  runtime.element("btn-bgm-up").click();
  assert.equal(runtime.element("bgm-home").volume, 0.55);
  runtime.element("btn-settings-close").click();
  assert.equal(runtime.api.state.settingsDraft, null);
  assert.equal(runtime.api.state.settings.bgmLevel, 3);
  assert.equal(runtime.element("bgm-volume-level").textContent, "3");
  assert.equal(runtime.element("bgm-home").volume, 0.42);
  runtime.element("btn-home-settings").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("page-settings").click();
  assert.equal(runtime.api.state.settingsDraft, null);
  assert.equal(runtime.api.state.settings.bgmLevel, 3);
  assert.equal(runtime.element("page-settings").classList.contains("active"), false);
  assert.equal(runtime.element("bgm-home").volume, 0.42);
});

test("Stage 9: settings save commits normalized draft and survives reload", () => {
  const seed = createRuntime();
  const storage = createStorage({ [seed.api.STORAGE_KEYS.settings]: json({ bgmLevel: 3, sfx: true, vibrate: true }) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.element("btn-home-settings").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("toggle-sfx").checked = false;
  runtime.element("toggle-vibrate").checked = false;
  runtime.api.syncSettingsDraftFromUI();
  runtime.element("btn-settings-save").click();
  assert.deepEqual(plain(runtime.api.state.settings), { bgmLevel: 5, sfx: false, vibrate: false });
  assert.equal(runtime.api.state.settingsDraft, null);
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.settings)), { bgmLevel: 5, sfx: false, vibrate: false });
  const reloaded = createRuntime({}, { localStorage: storage });
  reloaded.api.init();
  assert.deepEqual(plain(reloaded.api.state.settings), { bgmLevel: 5, sfx: false, vibrate: false });
});

test("Stage 9: legacy bgm false still migrates to committed level zero without a draft", () => {
  const seed = createRuntime();
  const raw = json({ bgm: false, sfx: true, vibrate: true });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: raw });
  runtime.api.init();
  assert.equal(runtime.api.state.settings.bgmLevel, 0);
  assert.equal(runtime.api.state.settingsDraft, null);
  runtime.element("btn-home-settings").click();
  assert.equal(runtime.api.state.settingsDraft.bgmLevel, 0);
  runtime.element("btn-bgm-up").click();
  runtime.element("btn-settings-close").click();
  assert.equal(runtime.api.state.settings.bgmLevel, 0);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), json({ bgmLevel: 0, sfx: true, vibrate: true }));
});

test("10A A: all real modals expose dialog semantics linked to existing titles", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const [modalId, titleId] of [
    ["page-time-intro", "time-intro-title"],
    ["page-practice-setup", "practice-setup-title"],
    ["page-wrong", "wrong-title"],
    ["page-settings", "settings-title"]
  ]) {
    assert.match(html, new RegExp(`<section[^>]*id="${modalId}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="${titleId}"`));
    assert.match(html, new RegExp(`<h2[^>]*id="${titleId}"[^>]*>`));
  }
});

test("10A B/C/D/E/M: settings open moves focus inside and X/backdrop/Escape restore its opener", () => {
  for (const closeMethod of ["x", "backdrop", "escape"]) {
    const runtime = createRuntime();
    runtime.api.init();
    const opener = runtime.element("btn-home-settings");
    opener.focus();
    opener.click();
    assert.equal(runtime.activeElement(), runtime.element("btn-settings-close"), closeMethod);
    if (closeMethod === "x") runtime.element("btn-settings-close").click();
    else if (closeMethod === "backdrop") runtime.element("page-settings").click();
    else runtime.triggerKeydown("Escape");
    assert.equal(runtime.element("page-settings").classList.contains("active"), false, closeMethod);
    assert.equal(runtime.activeElement(), opener, closeMethod);
  }
});

test("10A F/G/H: Tab and Shift+Tab wrap within the active modal", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.element("btn-home-settings").focus();
  runtime.element("btn-home-settings").click();
  const first = runtime.element("btn-settings-close");
  const last = runtime.element("btn-settings-save");
  last.focus();
  const tab = runtime.triggerKeydown("Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(runtime.activeElement(), first);
  first.focus();
  const shiftTab = runtime.triggerKeydown("Tab", { shiftKey: true });
  assert.equal(shiftTab.defaultPrevented, true);
  assert.equal(runtime.activeElement(), last);
  runtime.element("btn-home-time").focus();
  runtime.triggerKeydown("Tab");
  assert.equal(runtime.activeElement(), first);
});

test("10A I: settings Escape discards draft and restores committed state, storage, and BGM", () => {
  const seed = createRuntime();
  const committed = json({ bgmLevel: 3, sfx: true, vibrate: true });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.settings]: committed });
  runtime.api.init();
  runtime.element("btn-home-settings").focus();
  runtime.element("btn-home-settings").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("btn-bgm-up").click();
  runtime.element("toggle-sfx").checked = false;
  runtime.element("toggle-vibrate").checked = false;
  runtime.api.syncSettingsDraftFromUI();
  runtime.triggerKeydown("Escape");
  assert.equal(runtime.api.state.settingsDraft, null);
  assert.deepEqual(plain(runtime.api.state.settings), { bgmLevel: 3, sfx: true, vibrate: true });
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.settings), committed);
  assert.equal(runtime.element("bgm-home").volume, 0.42);
});

test("10A J: active modal blocks background Enter STOP and submit", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.element("page-home").classList.remove("active");
  runtime.element("page-play").classList.add("active");
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.spinning = true;
  runtime.api.state.runEnded = false;
  runtime.api.openModal("wrong");
  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.spinning, true);
  runtime.api.state.spinning = false;
  runtime.api.state.scored = false;
  runtime.element("ans").value = question.answer;
  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.tries, 0);
});

test("10A K/L: Escape closes only one modal and normal opening keeps at most one active", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.element("btn-home-settings").focus();
  runtime.element("btn-home-settings").click();
  runtime.api.openModal("wrong");
  const activeBefore = ["page-time-intro", "page-practice-setup", "page-wrong", "page-settings"]
    .filter(id => runtime.element(id).classList.contains("active"));
  assert.deepEqual(activeBefore, ["page-wrong"]);
  runtime.triggerKeydown("Escape");
  const activeAfter = ["page-time-intro", "page-practice-setup", "page-wrong", "page-settings"]
    .filter(id => runtime.element(id).classList.contains("active"));
  assert.deepEqual(activeAfter, []);
  assert.equal(runtime.element("page-home").classList.contains("active"), true);
});

test("10A N: unavailable opener is skipped without throwing", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const opener = runtime.element("btn-home-wrong");
  opener.focus();
  opener.click();
  opener.disabled = true;
  assert.doesNotThrow(() => runtime.element("btn-wrong-close").click());
  assert.equal(runtime.element("page-wrong").classList.contains("active"), false);
  opener.disabled = false;
  opener.focus();
  opener.click();
  opener.remove();
  assert.doesNotThrow(() => runtime.triggerKeydown("Escape"));
});

test("10A P: gameplay Enter still performs STOP and submit when no modal is active", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.element("page-home").classList.remove("active");
  runtime.element("page-play").classList.add("active");
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.spinning = true;
  runtime.api.state.runEnded = false;
  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.spinning, false);
  runtime.api.state.scored = false;
  runtime.element("ans").value = question.answer;
  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.tries, 1);
  assert.equal(runtime.api.state.correct, 1);
});

test("10B A/B/C/D/K: answer, question, and feedback expose the required live and name semantics", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="ans"[^>]*aria-label="정답 입력"[^>]*aria-invalid="false"/);
  assert.match(html, /id="q-text"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="feedback"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.doesNotMatch(html, /id="status-1-val"[^>]*aria-live/);
  assert.doesNotMatch(html, /id="status-2-val"[^>]*aria-live/);
});

test("10B E/F/G/H/J: aria-invalid follows invalid, wrong, correct, numeric-equivalent, and next-question states", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET.find(q => q.answer === "0.10") || runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;

  runtime.element("ans").value = "bad";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.element("ans").getAttribute("aria-invalid"), "true");

  runtime.api.state.scored = false;
  runtime.element("ans").value = "999999";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.element("ans").getAttribute("aria-invalid"), "true");

  runtime.api.state.scored = false;
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();
  assert.equal(runtime.element("ans").getAttribute("aria-invalid"), "false");

  if (question.answer === "0.10") {
    runtime.api.state.scored = false;
    runtime.element("ans").value = "0.1";
    runtime.api.evaluateAnswer();
    assert.equal(runtime.element("ans").getAttribute("aria-invalid"), "false");
  }
  runtime.runTimeout(1100);
  assert.equal(runtime.element("ans").getAttribute("aria-invalid"), "false");
});

test("10B I: combo feedback remains visible and included in the live region", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  for (let i = 0; i < 3; i += 1) {
    runtime.api.state.scored = false;
    runtime.element("ans").value = question.answer;
    runtime.api.evaluateAnswer();
  }
  assert.match(runtime.element("feedback").innerHTML, /3연속/);
  assert.equal(runtime.element("feedback").getAttribute("role"), null);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="feedback"[^>]*role="status"/);
});

test("10B L/M/N: settings switches have names and a keyboard-visible focus indicator", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  assert.match(html, /id="toggle-sfx"[^>]*aria-label="효과음"/);
  assert.match(html, /id="toggle-vibrate"[^>]*aria-label="진동"/);
  assert.match(css, /\.switch input:focus-visible \+ \.slider\{/);
  assert.match(css, /outline-offset:3px/);
});

test("10B O/P/Q/R/S/T: accessibility updates preserve settings, modal, gameplay, and checkpoint contracts", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "practice";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.element("btn-home-settings").focus();
  runtime.element("btn-home-settings").click();
  runtime.element("toggle-sfx").checked = false;
  runtime.api.syncSettingsDraftFromUI();
  runtime.triggerKeydown("Escape");
  assert.equal(runtime.api.state.settings.sfx, true);
  assert.equal(runtime.api.state.settingsDraft, null);

  runtime.api.state.scored = false;
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 1);
  assert.equal(runtime.api.state.combo, 1);
  assert.equal(runtime.api.state.timeCheckpoint, null);
});

test("10C A: viewport enables safe-area coverage without disabling zoom", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/);
  assert.doesNotMatch(html, /user-scalable=no/);
});

test("10C B/C: play, result, and modal shells use all four safe-area insets without changing Stage 7 home coordinates", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const marker = css.lastIndexOf("/* Stage 10C safe-area and touch-target stabilization */");
  const stage10c = css.slice(marker);
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(stage10c, new RegExp(`env\\(safe-area-inset-${side},0px\\)`));
  }
  assert.match(css, /aspect-ratio:941 \/ 1672 !important;/);
  assert.match(css, /#page-home #btn-home-time\{top:60\.15% !important;\}/);
  assert.match(css, /#page-home #btn-home-practice\{top:71\.41% !important;\}/);
  assert.match(css, /#page-home #btn-home-wrong,\s*#page-home #btn-home-settings\{\s*top:82\.68% !important;/);
});

test("10C D/E/F: touch-target rules preserve primary actions and raise short-height keypad minimums", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const marker = css.lastIndexOf("/* Stage 10C safe-area and touch-target stabilization */");
  const stage10c = css.slice(marker);
  assert.match(stage10c, /\.modal-close,\s*\.volume-btn\{[\s\S]*?min-width:44px;[\s\S]*?min-height:44px;/);
  assert.match(stage10c, /#btn-settings-save,\s*#btn-result-retry\{\s*min-height:44px;/);
  assert.match(stage10c, /\.setting-card\{flex-shrink:0;\}/);
  assert.match(stage10c, /#btn-settings-save\{flex-shrink:0;\}/);
  assert.match(stage10c, /#page-play \.top-home-btn\{[\s\S]*?min-height:44px !important;/);
  assert.match(stage10c, /#page-play #btn-stop,\s*#page-play #btn-submit\{\s*min-height:44px !important;/);
  assert.match(stage10c, /@media \(max-width:700px\) and \(max-height:640px\)\{[\s\S]*?#page-play \.keypad-btn\{[\s\S]*?min-height:40px !important;/);
  assert.match(stage10c, /@media \(max-width:700px\) and \(max-height:620px\)\{[\s\S]*?#page-play \.keypad-btn\{[\s\S]*?min-height:36px !important;/);
  assert.match(css, /\.switch input:focus-visible \+ \.slider\{/);
});

function completeOwnedTimeRun(runtime, elapsedSeconds = 25, tries = 10) {
  runtime.api.init();
  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);
  const runId = runtime.api.state.runId;
  runtime.api.state.correct = runtime.api.COMPLETION_TARGET;
  runtime.api.state.wrong = tries - runtime.api.COMPLETION_TARGET;
  runtime.api.state.tries = tries;
  runtime.api.state.completionElapsedSeconds = elapsedSeconds;
  runtime.api.state.runEnded = false;
  runtime.api.finishTimeMode();
  return runId;
}

test("R1B A: 다른 runId의 runtime은 persisted checkpoint를 삭제하지 못한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { runId: "run-a" });
  const raw = json(checkpoint);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: raw });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.state.runId = "run-b";

  assert.equal(runtime.api.clearTimeCheckpoint("run-b"), false);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), raw);
});

test("R1B B: 같은 owner의 명시적 clear는 checkpoint를 제거한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { runId: "run-a" });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  assert.equal(runtime.api.clearTimeCheckpoint("run-a"), true);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
});

test("R1B C: stale clear의 owner 재확인 사이 새 run으로 바뀌면 새 checkpoint를 보호한다", () => {
  const seed = createRuntime();
  const checkpointA = makeCheckpoint(seed, { runId: "run-a" });
  const checkpointC = makeCheckpoint(seed, { runId: "run-c", correct: 4, tries: 6 });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpointA) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  let switched = false;
  storage.setHooks({
    afterGet(key) {
      if (!switched && key === seed.api.STORAGE_KEYS.inProgress) {
        switched = true;
        storage.setRaw(key, json(checkpointC));
      }
    }
  });

  const result = runtime.api.invalidateOwnedTimeCheckpoint("run-a");
  assert.equal(result.invalidated, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress)), checkpointC);
});

test("R1B D: 다른 owner가 있는 checkpoint slot에는 자동 저장으로 덮어쓰지 않는다", () => {
  const seed = createRuntime();
  const checkpointA = makeCheckpoint(seed, { runId: "run-a" });
  const raw = json(checkpointA);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: raw });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.runId = "run-b";
  runtime.api.state.stopwatchStarted = true;
  runtime.api.state.runEnded = false;
  runtime.api.state.curQuestion = runtime.api.QUESTION_SET[0];
  runtime.api.state.runPhase = "spin";

  assert.equal(runtime.api.saveTimeCheckpoint("spin"), false);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), raw);
});

test("R1B E: 확인한 새로 시작은 같은 owner를 재검증해 takeover하고 새 runId를 만든다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { runId: "run-a" });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  runtime.api.startNewTimeModeFromCheckpoint();
  assert.notEqual(runtime.api.state.runId, "run-a");
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
  runtime.runInterval(700, 3);
  const saved = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress));
  assert.equal(saved.runId, runtime.api.state.runId);
  assert.equal(saved.version, 3);
});

test("R1B F: resume은 checkpoint runId를 그대로 이어받고 새 identity를 만들지 않는다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { runId: "run-a", phase: "answer" });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  assert.equal(runtime.api.resumeTimeMode(), true);
  assert.equal(runtime.api.state.runId, "run-a");
  assert.equal(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress)).runId, "run-a");
});

test("R1B G: v1 checkpoint는 결정적 legacy runId를 가진 v3로 정규화된다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { version: 1, runId: undefined, combo: undefined, maxCombo: undefined });
  const raw = json(checkpoint);
  const first = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: raw });
  const second = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: raw });
  first.api.init();
  second.api.init();

  assert.equal(first.api.state.timeCheckpoint.version, 3);
  assert.match(first.api.state.timeCheckpoint.runId, /^legacy-/);
  assert.equal(first.api.state.timeCheckpoint.runId, second.api.state.timeCheckpoint.runId);
  assert.equal(first.api.state.timeCheckpoint.combo, 0);
  assert.equal(first.api.state.timeCheckpoint.maxCombo, 0);
});

test("R1B H: v2 checkpoint는 combo와 진행값을 보존한 v3 ownership으로 migration된다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { version: 2, runId: undefined, combo: 2, maxCombo: 3 });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  runtime.api.init();

  assert.equal(runtime.api.state.timeCheckpoint.version, 3);
  assert.match(runtime.api.state.timeCheckpoint.runId, /^legacy-/);
  assert.equal(runtime.api.state.timeCheckpoint.combo, 2);
  assert.equal(runtime.api.state.timeCheckpoint.maxCombo, 3);
  assert.equal(runtime.api.state.timeCheckpoint.correct, checkpoint.correct);
});

test("R1B I: 신규 run의 첫 checkpoint는 v3 runId를 포함한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  const runId = runtime.api.state.runId;
  runtime.runInterval(700, 3);
  const saved = JSON.parse(runtime.raw(runtime.api.STORAGE_KEYS.inProgress));

  assert.equal(saved.version, 3);
  assert.equal(saved.runId, runId);
  assert.match(runId, /^test-run-/);
});

test("R1B J: malformed 및 future checkpoint raw는 시작과 자동 저장에서도 비파괴 보존된다", () => {
  const seed = createRuntime();
  const futureRaw = json({ version: 99, runId: "future-run", payload: "keep" });
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: futureRaw });
  runtime.api.init();
  assert.equal(runtime.api.state.timeCheckpoint, null);
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);

  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), futureRaw);
  assert.equal(runtime.api.state.spinning, true);
});

test("R1B K: 30초 write가 뒤늦게 25초를 덮어도 storage event reconciliation이 25초를 복구한다", () => {
  const seed = createRuntime();
  const key = seed.api.STORAGE_KEYS.completionBest;
  const storage = createStorage({ [key]: json({ elapsedSeconds: 40, tries: 15 }) });
  const runtimeA = createRuntime({}, { localStorage: storage });
  const runtimeB = createRuntime({}, { localStorage: storage });
  runtimeA.api.init();
  runtimeB.api.init();
  let injected = false;
  storage.setHooks({
    afterGet(readKey) {
      if (!injected && readKey === key) {
        injected = true;
        finishCompletion(runtimeB, 25, 15);
      }
    }
  });

  finishCompletion(runtimeA, 30, 15);
  assert.equal(JSON.parse(storage.raw(key)).elapsedSeconds, 30);
  runtimeA.triggerStorage(key, json({ elapsedSeconds: 25, tries: 15 }));
  assert.deepEqual(JSON.parse(storage.raw(key)), { elapsedSeconds: 25, tries: 15 });
  assert.deepEqual(plain(runtimeA.api.state.bestCompletion), { elapsedSeconds: 25, tries: 15 });
  assert.equal(runtimeA.element("new-badge").classList.contains("hidden"), true);
});

test("R1B L: 반대 interleaving에서도 더 빠른 25초가 최종 persisted best다", () => {
  const seed = createRuntime();
  const key = seed.api.STORAGE_KEYS.completionBest;
  const storage = createStorage({ [key]: json({ elapsedSeconds: 40, tries: 15 }) });
  const runtimeA = createRuntime({}, { localStorage: storage });
  const runtimeB = createRuntime({}, { localStorage: storage });
  runtimeA.api.init();
  runtimeB.api.init();
  let injected = false;
  storage.setHooks({
    afterGet(readKey) {
      if (!injected && readKey === key) {
        injected = true;
        finishCompletion(runtimeB, 30, 15);
      }
    }
  });

  finishCompletion(runtimeA, 25, 15);
  assert.deepEqual(JSON.parse(storage.raw(key)), { elapsedSeconds: 25, tries: 15 });
});

test("R1B M: 같은 초의 concurrent race는 더 적은 tries를 storage event로 복구한다", () => {
  const seed = createRuntime();
  const key = seed.api.STORAGE_KEYS.completionBest;
  const storage = createStorage({ [key]: json({ elapsedSeconds: 30, tries: 20 }) });
  const runtimeA = createRuntime({}, { localStorage: storage });
  const runtimeB = createRuntime({}, { localStorage: storage });
  runtimeA.api.init();
  runtimeB.api.init();
  let injected = false;
  storage.setHooks({
    afterGet(readKey) {
      if (!injected && readKey === key) {
        injected = true;
        finishCompletion(runtimeB, 30, 15);
      }
    }
  });

  finishCompletion(runtimeA, 30, 16);
  runtimeA.triggerStorage(key, json({ elapsedSeconds: 30, tries: 15 }));
  assert.deepEqual(JSON.parse(storage.raw(key)), { elapsedSeconds: 30, tries: 15 });
});

test("R1B N: storage event는 better best만 반영하고 worse 및 unrelated key로 후퇴하지 않는다", () => {
  const seed = createRuntime();
  const key = seed.api.STORAGE_KEYS.completionBest;
  const storage = createStorage({ [key]: json({ elapsedSeconds: 30, tries: 15 }) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  storage.setRaw(key, json({ elapsedSeconds: 25, tries: 15 }));
  runtime.triggerStorage(key, storage.raw(key));
  assert.equal(runtime.api.state.bestCompletion.elapsedSeconds, 25);
  storage.setRaw(key, json({ elapsedSeconds: 40, tries: 15 }));
  runtime.triggerStorage(key, storage.raw(key));
  assert.deepEqual(JSON.parse(storage.raw(key)), { elapsedSeconds: 25, tries: 15 });
  runtime.triggerStorage(seed.api.STORAGE_KEYS.settings, json({ bgmLevel: 0 }));
  assert.equal(runtime.api.state.bestCompletion.elapsedSeconds, 25);
});

test("R1B O: best save와 owner checkpoint remove가 모두 성공하면 정상 완료한다", () => {
  const storage = createStorage();
  const runtime = createRuntime({}, { localStorage: storage });
  completeOwnedTimeRun(runtime, 25, 15);

  assert.deepEqual(JSON.parse(storage.raw(runtime.api.STORAGE_KEYS.completionBest)), { elapsedSeconds: 25, tries: 15 });
  assert.equal(storage.raw(runtime.api.STORAGE_KEYS.inProgress), undefined);
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), false);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
});

test("R1B P: best save 실패와 checkpoint remove 성공은 결과를 유지하고 성공 badge 대신 실패를 표시한다", () => {
  const seed = createRuntime();
  const storage = createStorage({}, {
    shouldThrowOnSet: key => key === seed.api.STORAGE_KEYS.completionBest
  });
  const runtime = createRuntime({}, { localStorage: storage });

  assert.doesNotThrow(() => completeOwnedTimeRun(runtime, 25, 15));
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.completionBest), undefined);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
  assert.match(runtime.element("r-best").textContent, /기록 저장 실패/);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
});

test("R1B Q: best save 성공과 remove 실패는 terminal fallback으로 완료 checkpoint 재개를 막는다", () => {
  const storage = createStorage({}, { throwOnRemove: true });
  const runtime = createRuntime({}, { localStorage: storage });
  const runId = completeOwnedTimeRun(runtime, 25, 15);
  const terminal = JSON.parse(storage.raw(runtime.api.STORAGE_KEYS.inProgress));

  assert.deepEqual(terminal, { version: 3, runId, terminal: true });
  const reloaded = createRuntime({}, { localStorage: storage });
  reloaded.api.init();
  assert.equal(reloaded.api.state.timeCheckpoint, null);
});

test("R1B R: remove와 terminal write가 실패해도 persisted best의 완료 marker가 stale resume를 차단한다", () => {
  const seed = createRuntime();
  const storage = createStorage({}, {
    throwOnRemove: true,
    shouldThrowOnSet(key, value) {
      if (key !== seed.api.STORAGE_KEYS.inProgress) return false;
      try { return JSON.parse(value).terminal === true; } catch (e) { return false; }
    }
  });
  const runtime = createRuntime({}, { localStorage: storage });
  const runId = completeOwnedTimeRun(runtime, 25, 15);
  const staleCheckpoint = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress));
  const best = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.completionBest));

  assert.equal(staleCheckpoint.runId, runId);
  assert.equal(best.completedRunId, runId);
  const reloaded = createRuntime({}, { localStorage: storage });
  reloaded.api.init();
  reloaded.element("btn-home-time").click();
  assert.equal(reloaded.api.state.timeCheckpoint, null);
  assert.equal(reloaded.element("btn-time-intro-start").classList.contains("hidden"), false);
});

test("R1B S: best save 실패와 remove 실패는 terminal을 남기고 UI도 저장 성공을 주장하지 않는다", () => {
  const seed = createRuntime();
  const storage = createStorage({}, {
    throwOnRemove: true,
    shouldThrowOnSet: key => key === seed.api.STORAGE_KEYS.completionBest
  });
  const runtime = createRuntime({}, { localStorage: storage });
  const runId = completeOwnedTimeRun(runtime, 25, 15);

  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress)), { version: 3, runId, terminal: true });
  assert.equal(runtime.element("new-badge").classList.contains("hidden"), true);
  assert.match(runtime.element("r-best").textContent, /기록 저장 실패/);
  const reloaded = createRuntime({}, { localStorage: storage });
  reloaded.api.init();
  assert.equal(reloaded.api.state.timeCheckpoint, null);
});

test("R1B T: run A completion은 storage에 먼저 들어온 run B checkpoint를 지우지 않는다", () => {
  const seed = createRuntime();
  const storage = createStorage();
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.startTimeMode();
  runtime.runInterval(700, 3);
  const runA = runtime.api.state.runId;
  const checkpointB = makeCheckpoint(seed, { runId: "run-b", correct: 6, tries: 8 });
  storage.setRaw(seed.api.STORAGE_KEYS.inProgress, json(checkpointB));
  runtime.api.state.correct = 10;
  runtime.api.state.wrong = 0;
  runtime.api.state.tries = 10;
  runtime.api.state.completionElapsedSeconds = 25;
  runtime.api.finishTimeMode();

  assert.notEqual(runA, checkpointB.runId);
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress)), checkpointB);
});

// R1C wrong-note durability regression coverage.

function createWrongFailureStorage(seed, initialNotes, failureCount) {
  let failures = failureCount;
  return createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json(initialNotes) }, {
    shouldThrowOnSet(key) {
      if (key !== seed.api.STORAGE_KEYS.wrongs || failures <= 0) return false;
      failures -= 1;
      return true;
    }
  });
}

function wrongIds(runtime) {
  return plain(runtime.api.state.wrongNotes.map(item => item.id));
}

function storedWrongIds(storage, seed) {
  return JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)).map(item => item.id);
}

test("R1C A: a failed wrong-note add is retained and flushed with the next add", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a], 1);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.pushWrongNote(b), false);
  assert.deepEqual(wrongIds(runtime), [b.id, a.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds.map(item => item.id)), [b.id]);
  assert.equal(runtime.api.pushWrongNote(c), true);
  assert.deepEqual(wrongIds(runtime), [c.id, b.id, a.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [c.id, b.id, a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds), []);
  assert.equal(runtime.api.state.pendingWrongNoteClear, null);
});

test("R1C B: multiple failed adds are all flushed in newest-first order", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [], 2);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.pushWrongNote(a), false);
  assert.equal(runtime.api.pushWrongNote(b), false);
  assert.equal(runtime.api.pushWrongNote(c), true);
  assert.deepEqual(wrongIds(runtime), [c.id, b.id, a.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [c.id, b.id, a.id]);
});

test("R1C C: retrying the same failed add does not create duplicates", () => {
  const seed = createRuntime();
  const a = seed.api.QUESTION_SET[0];
  const storage = createWrongFailureStorage(seed, [], 1);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.pushWrongNote(a), false);
  assert.equal(runtime.api.pushWrongNote(a), true);
  assert.deepEqual(wrongIds(runtime), [a.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds), []);
});

test("R1C D: a pending add merges with another tab's later persisted add", () => {
  const seed = createRuntime();
  const [a, b, c, d] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a], 1);
  const tabA = createRuntime({}, { localStorage: storage });
  const tabB = createRuntime({}, { localStorage: storage });
  tabA.api.init();
  tabB.api.init();
  assert.equal(tabA.api.pushWrongNote(b), false);
  assert.equal(tabB.api.pushWrongNote(c), true);
  assert.equal(tabA.api.pushWrongNote(d), true);
  assert.deepEqual(storedWrongIds(storage, seed), [d.id, b.id, c.id, a.id]);
  assert.deepEqual(wrongIds(tabA), [d.id, b.id, c.id, a.id]);
});

test("R1C E: a failed clear prevents cleared notes from returning on the next add", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a, b], 1);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.clearWrongNotes();
  assert.deepEqual(wrongIds(runtime), []);
  assert.ok(runtime.api.state.pendingWrongNoteClear);
  assert.deepEqual(storedWrongIds(storage, seed), [a.id, b.id]);
  assert.equal(runtime.api.pushWrongNote(c), true);
  assert.deepEqual(wrongIds(runtime), [c.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [c.id]);
  assert.equal(runtime.api.state.pendingWrongNoteClear, null);
});

test("R1C F: repeating clear retries and completes a previously failed clear", () => {
  const seed = createRuntime();
  const [a, b] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a, b], 1);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.clearWrongNotes();
  runtime.api.clearWrongNotes();
  assert.deepEqual(wrongIds(runtime), []);
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)), []);
  assert.equal(runtime.api.state.pendingWrongNoteClear, null);
});

test("R1C G: a normal clear empties memory and storage without pending intent", () => {
  const seed = createRuntime();
  const a = seed.api.QUESTION_SET[0];
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a]) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.clearWrongNotes();
  assert.deepEqual(wrongIds(runtime), []);
  assert.deepEqual(JSON.parse(storage.raw(seed.api.STORAGE_KEYS.wrongs)), []);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds), []);
  assert.equal(runtime.api.state.pendingWrongNoteClear, null);
});

test("R1C H: failed clear plus repeated failed adds flushes only post-clear notes", () => {
  const seed = createRuntime();
  const [a, b, c, d] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a, b], 2);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.clearWrongNotes();
  assert.equal(runtime.api.pushWrongNote(c), false);
  assert.equal(runtime.api.pushWrongNote(d), true);
  assert.deepEqual(wrongIds(runtime), [d.id, c.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [d.id, c.id]);
  assert.equal(runtime.api.state.pendingWrongNoteClear, null);
});

test("R1C I: malformed persisted raw remains non-destructive while pending adds stay in memory", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a], 1);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.pushWrongNote(b);
  storage.setRaw(seed.api.STORAGE_KEYS.wrongs, "{bad-json");
  assert.doesNotThrow(() => runtime.api.pushWrongNote(c));
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.wrongs), "{bad-json");
  assert.deepEqual(wrongIds(runtime), [c.id, b.id, a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds.map(item => item.id)), [c.id, b.id]);
});

test("R1C J: getItem failure does not discard an existing pending add", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  let setFailures = 1;
  let failGets = false;
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([a]) }, {
    shouldThrowOnGet(key) { return failGets && key === seed.api.STORAGE_KEYS.wrongs; },
    shouldThrowOnSet(key) {
      if (key !== seed.api.STORAGE_KEYS.wrongs || setFailures <= 0) return false;
      setFailures -= 1;
      return true;
    }
  });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.pushWrongNote(b);
  failGets = true;
  assert.doesNotThrow(() => runtime.api.pushWrongNote(c));
  assert.deepEqual(wrongIds(runtime), [c.id, b.id, a.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds.map(item => item.id)), [c.id, b.id]);
});

test("R1C K: repeated setItem failures retain every pending add in memory", () => {
  const seed = createRuntime();
  const [a, b, c, d] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a], 3);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.pushWrongNote(b);
  runtime.api.pushWrongNote(c);
  runtime.api.pushWrongNote(d);
  assert.deepEqual(wrongIds(runtime), [d.id, c.id, b.id, a.id]);
  assert.deepEqual(plain(runtime.api.state.pendingWrongNoteAdds.map(item => item.id)), [d.id, c.id, b.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [a.id]);
});

test("R1C L: legacy aliases canonicalize and dedupe during wrong-note persistence", () => {
  const seed = createRuntime();
  const canonical = seed.api.QUESTION_SET.find(item => item.crop === "라이밀(트리티케일)");
  assert.ok(canonical);
  const legacy = { ...canonical, id: "legacy-id", crop: "트리티케일(사료용)" };
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: json([legacy]) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.pushWrongNote(canonical), true);
  assert.deepEqual(wrongIds(runtime), [canonical.id]);
  assert.deepEqual(storedWrongIds(storage, seed), [canonical.id]);
});

test("R1C M: wrong-note retries do not mutate unrelated storage keys", () => {
  const seed = createRuntime();
  const [a, b, c] = seed.api.QUESTION_SET;
  const settingsRaw = json({ bgmLevel: 3, sfx: true, vibrate: true });
  const bestRaw = json({ elapsedSeconds: 20, tries: 16, completedRunId: "best-run" });
  const checkpointRaw = json(makeCheckpoint(seed, { version: 3, runId: "active-run" }));
  const storage = createWrongFailureStorage(seed, [a], 1);
  storage.setRaw(seed.api.STORAGE_KEYS.settings, settingsRaw);
  storage.setRaw(seed.api.STORAGE_KEYS.completionBest, bestRaw);
  storage.setRaw(seed.api.STORAGE_KEYS.inProgress, checkpointRaw);
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.pushWrongNote(b);
  runtime.api.pushWrongNote(c);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.settings), settingsRaw);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.completionBest), bestRaw);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), checkpointRaw);
});

test("R1C N: wrong-note write failure does not break the R1B checkpoint feedback transition", () => {
  const seed = createRuntime();
  const storage = createStorage({}, {
    shouldThrowOnSet: key => key === seed.api.STORAGE_KEYS.wrongs
  });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);
  runtime.api.stopSpin();
  runtime.element("ans").value = "999999";
  assert.doesNotThrow(() => runtime.api.evaluateAnswer());
  assert.equal(runtime.api.state.runPhase, "feedback");
  assert.equal(runtime.api.state.wrong, 1);
  assert.ok(runtime.api.state.nextTimeout);
  const checkpoint = JSON.parse(storage.raw(seed.api.STORAGE_KEYS.inProgress));
  assert.equal(checkpoint.version, 3);
  assert.equal(checkpoint.runId, runtime.api.state.runId);
  assert.equal(checkpoint.phase, "feedback");
});

test("R1C O: a correct wrong-practice answer does not auto-delete its note", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const raw = json([question]);
  const storage = createStorage({ [seed.api.STORAGE_KEYS.wrongs]: raw });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  runtime.api.startWrongPracticeMode();
  assert.equal(runtime.api.state.mode, "wrong-practice");
  assert.equal(runtime.api.state.spinning, true);
  runtime.api.stopSpin();
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();
  assert.deepEqual(wrongIds(runtime), [question.id]);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.wrongs), raw);
});

test("R1C multi-tab clear policy: remote notes added after a failed clear survive the next local flush", () => {
  const seed = createRuntime();
  const [a, b, c, d] = seed.api.QUESTION_SET;
  const storage = createWrongFailureStorage(seed, [a, b], 1);
  const clearTab = createRuntime({}, { localStorage: storage });
  const addTab = createRuntime({}, { localStorage: storage });
  clearTab.api.init();
  addTab.api.init();
  clearTab.api.clearWrongNotes();
  assert.equal(addTab.api.pushWrongNote(c), true);
  assert.equal(clearTab.api.pushWrongNote(d), true);
  assert.deepEqual(storedWrongIds(storage, seed), [d.id, c.id]);
  assert.deepEqual(wrongIds(clearTab), [d.id, c.id]);
});

test("R1D A: nine correct answers remain active and can advance to another round", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.wrong = 4;
  runtime.api.state.tries = 13;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.element("ans").value = "999999";
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 9);
  assert.equal(runtime.api.state.runEnded, false);
  assert.equal(runtime.element("page-result").classList.contains("active"), false);
  assert.equal(runtime.timeoutCount(850), 1);
  runtime.runTimeout(850);
  assert.equal(runtime.api.state.spinning, true);
});

test("R1D B/C/Q: the tenth correct answer completes immediately with 10/14 accuracy and final combo", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.wrong = 4;
  runtime.api.state.tries = 13;
  runtime.api.state.combo = 4;
  runtime.api.state.maxCombo = 4;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.advance(12345);
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.tries, 14);
  assert.equal(runtime.api.state.wrong, 4);
  assert.equal(runtime.api.state.combo, 5);
  assert.equal(runtime.api.state.maxCombo, 5);
  assert.equal(runtime.api.state.runEnded, true);
  assert.equal(runtime.api.state.completionElapsedSeconds, 12);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.element("r-tries").textContent, "14");
  assert.equal(runtime.element("r-acc").textContent, "71%");
  assert.equal(runtime.element("r-max-combo").textContent, "5");
  assert.equal(runtime.timeoutCount(850), 0);
  assert.equal(runtime.api.state.spinning, false);
});

test("R1D D/E/F/G: generic keys are active while old Completion15 data stays inert", () => {
  const seed = createRuntime();
  const oldBestKey = "seedTraining_v1_2_bestCompletion15";
  const oldCheckpointKey = "seedTraining_v1_2_inProgressCompletion15";
  const oldBestRaw = json({ elapsedSeconds: 20, tries: 15 });
  const oldCheckpointRaw = json(makeCheckpoint(seed, {
    correct: 14,
    tries: 16,
    wrong: 2,
    runId: "old-fifteen-run"
  }));
  const storage = createStorage({
    [oldBestKey]: oldBestRaw,
    [oldCheckpointKey]: oldCheckpointRaw
  });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();

  assert.equal(runtime.api.COMPLETION_TARGET, 10);
  assert.equal(runtime.api.STORAGE_KEYS.completionBest, "seedTraining_v1_2_bestCompletion");
  assert.equal(runtime.api.STORAGE_KEYS.inProgress, "seedTraining_v1_2_inProgressCompletion");
  assert.equal(Object.keys(plain(runtime.api.STORAGE_KEYS)).length, 5);
  assert.equal(runtime.api.state.bestCompletion, null);
  assert.equal(runtime.api.state.timeCheckpoint, null);
  runtime.element("btn-home-time").click();
  assert.equal(runtime.element("btn-time-intro-start").classList.contains("hidden"), false);
  assert.equal(runtime.element("time-resume-actions").classList.contains("hidden"), true);

  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);
  assert.ok(storage.raw(runtime.api.STORAGE_KEYS.inProgress));
  finishCompletion(runtime, 30, 14);
  assert.deepEqual(JSON.parse(storage.raw(runtime.api.STORAGE_KEYS.completionBest)), {
    elapsedSeconds: 30,
    tries: 14
  });
  assert.equal(storage.raw(oldBestKey), oldBestRaw);
  assert.equal(storage.raw(oldCheckpointKey), oldCheckpointRaw);
});

test("R1D H: a 9-correct v3 checkpoint resumes the same run and completes on the next correct answer", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET[0];
  const checkpoint = makeCheckpoint(seed, {
    correct: 9,
    tries: 13,
    wrong: 4,
    combo: 2,
    maxCombo: 3,
    phase: "answer",
    questionId: question.id,
    runId: "ten-target-run"
  });
  const storage = createStorage({ [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) });
  const runtime = createRuntime({}, { localStorage: storage });
  runtime.api.init();
  assert.equal(runtime.api.state.timeCheckpoint.runId, checkpoint.runId);
  assert.equal(runtime.api.resumeTimeMode(), true);
  assert.equal(runtime.api.state.runId, checkpoint.runId);
  assert.equal(runtime.element("status-2-val").textContent, "9 / 10");
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.runEnded, true);
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(storage.raw(seed.api.STORAGE_KEYS.inProgress), undefined);
});

test("R1D I: a correct=10 checkpoint is not a resumable in-progress checkpoint", () => {
  const seed = createRuntime();
  const raw = json(makeCheckpoint(seed, { correct: 10, tries: 12, wrong: 2 }));
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.inProgress]: raw });
  runtime.api.init();
  runtime.element("btn-home-time").click();
  assert.equal(runtime.api.state.timeCheckpoint, null);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.inProgress), raw);
  assert.equal(runtime.element("btn-time-intro-start").classList.contains("hidden"), false);
  assert.equal(runtime.element("time-resume-actions").classList.contains("hidden"), true);
});

test("R1D R/S: numeric-equivalent tenth answer completes while wrong-note persistence remains independent", () => {
  const seed = createRuntime();
  const question = seed.api.QUESTION_SET.find(item => item.answer === "14.0");
  const existingWrong = seed.api.QUESTION_SET.find(item => item.id !== question.id);
  const wrongRaw = json([existingWrong]);
  const runtime = createRuntime({ [seed.api.STORAGE_KEYS.wrongs]: wrongRaw });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 9;
  runtime.api.state.tries = 9;
  runtime.api.state.wrong = 0;
  runtime.api.state.scored = false;
  runtime.element("ans").value = "14";
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 10);
  assert.equal(runtime.api.state.runEnded, true);
  assert.deepEqual(wrongIds(runtime), [existingWrong.id]);
  assert.equal(runtime.raw(seed.api.STORAGE_KEYS.wrongs), wrongRaw);
});

test("R2 A: 700px remains mobile and 701px switches the current answer phase to desktop input", () => {
  const runtime = createRuntime({}, { viewportWidth: 700 });
  runtime.api.init();
  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);

  assert.equal(runtime.element("ans").readOnly, true);
  assert.equal(runtime.element("btn-stop").classList.contains("hidden"), false);
  runtime.api.stopSpin();
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), false);

  runtime.resizeTo(701);
  assert.equal(runtime.element("ans").readOnly, false);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), true);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), false);

  runtime.resizeTo(700);
  assert.equal(runtime.element("ans").readOnly, true);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
});

test("R2 B: 701px desktop flow supports Enter for STOP and answer submission", () => {
  const runtime = createRuntime({}, { viewportWidth: 701 });
  runtime.api.init();
  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);

  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.runPhase, "answer");
  assert.equal(runtime.element("ans").readOnly, false);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), true);

  runtime.element("ans").value = runtime.api.state.curQuestion.answer;
  runtime.triggerKeydown("Enter");
  assert.equal(runtime.api.state.runPhase, "feedback");
  assert.equal(runtime.api.state.correct, 1);
  assert.equal(runtime.api.state.tries, 1);
});

test("R2 C: 667px mobile controls remain usable through spin, answer, feedback, and next round", () => {
  const runtime = createRuntime({}, { viewportWidth: 667 });
  runtime.api.init();
  assert.equal(runtime.api.startTimeMode(), true);
  runtime.runInterval(700, 3);
  assert.equal(runtime.element("btn-stop").classList.contains("hidden"), false);

  runtime.element("btn-stop").click();
  assert.equal(runtime.api.state.runPhase, "answer");
  assert.equal(runtime.element("ans").readOnly, true);
  assert.equal(runtime.element("mobile-keypad").classList.contains("hidden"), false);
  assert.equal(runtime.element("btn-submit").classList.contains("hidden"), false);

  runtime.element("ans").value = runtime.api.state.curQuestion.answer;
  runtime.element("btn-submit").click();
  assert.equal(runtime.api.state.runPhase, "feedback");
  assert.equal(runtime.api.state.correct, 1);
  assert.equal(runtime.timeoutCount(850), 1);

  runtime.runTimeout(850);
  assert.equal(runtime.api.state.runPhase, "spin");
  assert.equal(runtime.element("btn-stop").classList.contains("hidden"), false);
});

test("R2 D: short-landscape CSS uses a bounded two-column play layout without changing Stage 7 home geometry", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const marker = css.lastIndexOf("/* R2 short-landscape gameplay containment */");
  const stage7 = css.indexOf("/* Stage 7 home coordinate-system stabilization */");
  const stage10c = css.indexOf("/* Stage 10C safe-area and touch-target stabilization */");
  assert.ok(marker > stage7);
  assert.ok(marker > stage10c);
  const r2 = css.slice(marker);

  assert.match(r2, /@media \(max-width:700px\) and \(max-height:400px\) and \(orientation:landscape\)\{/);
  assert.match(r2, /#app\{max-width:none;\}/);
  assert.match(r2, /grid-template-columns:minmax\(0,1fr\) minmax\(276px,44%\) !important;/);
  assert.match(r2, /grid-template-rows:auto minmax\(0,1fr\) minmax\(54px,62px\) !important;/);
  assert.match(r2, /#page-play \.answer-zone\{[\s\S]*?grid-column:2 !important;[\s\S]*?grid-row:2 \/ 4 !important;[\s\S]*?height:100% !important;[\s\S]*?min-height:0 !important;/);
  assert.doesNotMatch(r2, /#page-home|home-stage|btn-home-/);

  for (const [width, height] of [[667, 375], [700, 390]]) {
    const contentWidth = width - 20;
    const contentHeight = height - 10;
    const columnGap = 8;
    const rowGap = 3;
    const topbarHeight = 45;
    const questionHeight = 54;
    const answerWidth = Math.max(276, contentWidth * .44);
    const rouletteWidth = contentWidth - columnGap - answerWidth;
    const heroHeight = contentHeight - topbarHeight - questionHeight - rowGap * 2;
    const answerHeight = heroHeight + rowGap + questionHeight;
    assert.ok(rouletteWidth >= 350, `${width}x${height} roulette width`);
    assert.ok(answerWidth >= 276, `${width}x${height} answer width`);
    assert.ok(answerHeight >= 315, `${width}x${height} answer height`);
  }
});

test("R1D copy and namespace audit: active product code has no Completion15 contract", () => {
  const app = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(app, /Completion15|completion15|bestCompletion15|inProgressCompletion15|15문제|15개 정답|15정답/);
  assert.doesNotMatch(html, /15문제|15개|15정답|0 \/ 15/);
  assert.match(app, /const COMPLETION_TARGET = 10;/);
  assert.match(html, /정답 10개를 맞히면 실전모드가 종료됩니다\./);
});
