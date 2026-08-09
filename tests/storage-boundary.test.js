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
  weightedPick,
  pickQuestion,
  stopSpin,
  handleQuitPlay,
  saveSettings,
  pushWrongNote,
  clearWrongNotes,
  startWrongPracticeMode,
  renderWrongPage,
  makeNoteItem,
  isAnswerCorrect,
  getAnswerGuideText,
  getAnswerPlaceholder,
  formatFeedback,
  syncPlayControlsForViewport
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
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  click() {
    (this.listeners.get("click") || []).forEach(listener => listener({ target: this }));
  }
  setAttribute() {}
  appendChild(child) { this.children.push(child); return child; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() {}
  blur() {}
  focus() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

function createStorage(initialStorage = {}, options = {}) {
  const values = new Map(Object.entries(initialStorage));
  let setCalls = 0;
  let removeCalls = 0;
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      setCalls += 1;
      if (options.throwOnSet) throw new Error("forced setItem failure");
      values.set(key, String(value));
    },
    removeItem(key) {
      removeCalls += 1;
      if (options.throwOnRemove) throw new Error("forced removeItem failure");
      values.delete(key);
    },
    raw(key) { return values.get(key); },
    setCalls() { return setCalls; },
    removeCalls() { return removeCalls; }
  };
}

function createRuntime(initialStorage = {}, options = {}) {
  const elements = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  let nextTimerId = 1;
  let nowMs = options.nowMs || 0;
  let viewportWidth = options.viewportWidth || 1000;

  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  ["page-home", "page-play", "page-result"].forEach(getElement);

  const document = {
    hidden: false,
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
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".base-page") {
        return [getElement("page-home"), getElement("page-play"), getElement("page-result")];
      }
      return [];
    }
  };

  const localStorage = options.localStorage || createStorage(initialStorage, options);

  const context = vm.createContext({
    console,
    document,
    localStorage,
    navigator: { vibrate() {} },
    window: {
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
  assert.deepEqual(plain(runtime.api.state.bestCompletion15), { elapsedSeconds: 208, tries: 18 });
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
  runtime.api.state.correct = 15;
  runtime.api.state.wrong = 5;
  runtime.api.state.tries = 20;
  runtime.api.state.elapsedMs = 208900;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.element("r-correct").textContent, "03:28");
  assert.equal(runtime.element("r-tries").textContent, "20");
  assert.equal(runtime.element("r-acc").textContent, "75%");
  assert.equal(runtime.element("r-wrong").textContent, "5");
  assert.deepEqual(plain(runtime.api.state.bestCompletion15), { elapsedSeconds: 208, tries: 20 });
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

test("3단계 A/B/C: countdown 전에는 0/15·00:00이고 실제 clock으로 stopwatch가 시작된다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.startTimeMode();
  assert.equal(runtime.api.state.correct, 0);
  assert.equal(runtime.api.state.tries, 0);
  assert.equal(runtime.api.state.wrong, 0);
  assert.equal(runtime.element("status-1-val").textContent, "00:00");
  assert.equal(runtime.element("status-2-val").textContent, "0 / 15");
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

test("3단계 F/G/K: 15번째 정답 순간 정수 초를 freeze하고 15/20 결과를 표시한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  const question = runtime.api.QUESTION_SET[0];
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 14;
  runtime.api.state.wrong = 5;
  runtime.api.state.tries = 19;
  runtime.api.state.runEnded = false;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.advance(181900);
  runtime.element("ans").value = question.answer;
  runtime.api.evaluateAnswer();

  assert.equal(runtime.api.state.correct, 15);
  assert.equal(runtime.api.state.tries, 20);
  assert.equal(runtime.api.state.runEnded, true);
  assert.equal(runtime.api.state.completionElapsedSeconds, 181);
  assert.equal(runtime.element("pbar").style.width, "100%");
  assert.equal(runtime.element("r-correct").textContent, "03:01");
  assert.equal(runtime.element("r-tries").textContent, "20");
  assert.equal(runtime.element("r-acc").textContent, "75%");
  assert.equal(runtime.element("r-wrong").textContent, "5");
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
  runtime.api.state.correct = 15;
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
    assert.equal(runtime.api.state.bestCompletion15, null);
    assert.equal(runtime.raw(seed.api.STORAGE_KEYS.completionBest), value);
    assert.equal(runtime.element("page-home").classList.contains("active"), true);
  });
}

test("3단계 N: completion best setItem throw에도 완료 결과와 앱 사용이 유지된다", () => {
  const runtime = createRuntime({}, { throwOnSet: true });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 15;
  runtime.api.state.wrong = 5;
  runtime.api.state.tries = 20;
  runtime.api.state.elapsedMs = 208900;
  assert.doesNotThrow(() => runtime.api.finishTimeMode());
  assert.equal(runtime.element("page-result").classList.contains("active"), true);
  assert.equal(runtime.element("r-correct").textContent, "03:28");
  assert.equal(runtime.element("r-tries").textContent, "20");
  assert.equal(runtime.element("r-acc").textContent, "75%");
  assert.equal(runtime.element("r-wrong").textContent, "5");
});

test("3단계 O: 다시 도전은 이전 stopwatch와 완료 상태를 초기화한다", () => {
  const runtime = createRuntime();
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 15;
  runtime.api.state.wrong = 4;
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
  assert.equal(runtime.element("status-2-val").textContent, "0 / 15");
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
    correct: 3,
    tries: 5,
    wrong: 2,
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
  assert.equal(reloaded.element("time-resume-summary").textContent.includes("0 / 15"), true);
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
  assert.equal(runtime.element("time-resume-summary").textContent, "정답 7 / 15 · 플레이 시간 02:34");
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
    correct: 14,
    tries: 16,
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
  assert.equal(runtime.element("time-resume-summary").textContent, "정답 7 / 15 · 플레이 시간 00:04");
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

test("4단계 M: 새로 시작 확인은 기존 체크포인트를 삭제하고 0/15 countdown을 시작한다", () => {
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
  const checkpoint = makeCheckpoint(seed, { correct: 14, tries: 16, wrong: 2 });
  const runtime = createRuntime(
    { [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint) },
    { throwOnRemove: true }
  );
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 15;
  runtime.api.state.tries = 17;
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
  ["completed correct", json(makeCheckpoint(createRuntime(), { correct: 15, tries: 17 }))],
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
  runtime.api.state.correct = 15;
  runtime.api.state.tries = 16;
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

test("4단계 R: 완료 후 다시 도전은 checkpoint 없이 0/15 countdown부터 시작한다", () => {
  const seed = createRuntime();
  const checkpoint = makeCheckpoint(seed, { correct: 14, tries: 16, wrong: 2 });
  const runtime = createRuntime({
    [seed.api.STORAGE_KEYS.inProgress]: json(checkpoint)
  });
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.correct = 15;
  runtime.api.state.tries = 17;
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
    correct: 14,
    tries: 17,
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
    { elapsedSeconds: 61, tries: 18 }
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

test("5단계 G: 실전모드 14번째 상태에서 14.0에 14를 입력하면 정상 완료한다", () => {
  const runtime = runtimeForScoring();
  const question = runtime.api.QUESTION_SET.find(q => q.answer === "14.0");
  assert.ok(question);
  runtime.api.init();
  runtime.api.state.mode = "time";
  runtime.api.state.pool = [question];
  runtime.api.state.curQuestion = question;
  runtime.api.state.correct = 14;
  runtime.api.state.tries = 14;
  runtime.api.state.wrong = 0;
  runtime.api.state.scored = false;
  runtime.api.startStopwatch();
  runtime.element("ans").value = "14";
  runtime.api.evaluateAnswer();
  assert.equal(runtime.api.state.correct, 15);
  assert.equal(runtime.api.state.tries, 15);
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
