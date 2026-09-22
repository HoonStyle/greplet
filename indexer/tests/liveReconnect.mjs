import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "..", "public", "live.js");

class FakeClassList {
  #values = new Set();
  add(...values) { values.forEach((value) => this.#values.add(value)); }
  remove(...values) { values.forEach((value) => this.#values.delete(value)); }
  toggle(value, force) {
    const next = force === undefined ? !this.#values.has(value) : Boolean(force);
    if (next) this.#values.add(value); else this.#values.delete(value);
    return next;
  }
  contains(value) { return this.#values.has(value); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.hidden = false;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((entry) => entry !== child); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatch(type, event = {}) { this.listeners.get(type)?.({ target: this, ...event }); }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  querySelector(selector) {
    if (selector === ".live-empty") return this.children.find((child) => child.classList.contains("live-empty")) || null;
    return new FakeElement();
  }
  querySelectorAll() { return []; }
}

function makeHarness() {
  const ids = [
    "section-live", "liveConnection", "liveConnectionText", "liveActiveCount", "livePause",
    "liveSession", "liveFilterBadge", "liveLanes", "activityFeed", "liveStatus", "kpiTotal",
    "kpiAvg", "kpiCache", "kpiQps", "kpiApproxTokens", "sparkCalls", "sparkMs",
    "sparkCallsValue", "sparkMsValue", "indexState", "indexProgressWrap", "indexProgress",
    "indexProgressStage", "indexProgressText", "usageToggle", "usageBody", "usageDays", "usageFeed",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const root = elements.get("section-live");
  elements.get("livePause").querySelector = (selector) => new FakeElement(selector);

  let nextTimer = 1;
  const timers = new Map();
  const schedule = (fn, delay = 0, repeat = false) => {
    const id = nextTimer++;
    timers.set(id, { fn, delay, repeat });
    return id;
  };
  const runTimers = () => {
    const pending = [...timers.entries()];
    for (const [id, timer] of pending) {
      if (!timers.has(id)) continue;
      if (!timer.repeat) timers.delete(id);
      timer.fn();
    }
  };
  const rafs = new Map();
  const eventSources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; eventSources.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    close() { this.closed = true; }
    emit(type, data, lastEventId = "") {
      this.listeners.get(type)?.({ data: JSON.stringify({ type, ...data }), lastEventId });
    }
    fail() { this.onerror?.(new Error("connection lost")); }
  }
  const now = Date.parse("2026-09-22T00:00:00.000Z");
  const document = {
    hidden: false,
    body: new FakeElement("body"),
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new FakeElement(tag),
    addEventListener: () => {},
  };
  const window = {
    document,
    localStorage: { getItem: () => "", setItem: () => {} },
    location: { search: "" },
    EventSource: FakeEventSource,
    setTimeout: (fn, delay) => schedule(fn, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: (id) => timers.delete(id),
    fetch: async () => ({ ok: false }),
  };
  const context = vm.createContext({
    window,
    document,
    EventSource: FakeEventSource,
    fetch: window.fetch,
    URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    requestAnimationFrame: (fn) => { const id = nextTimer++; rafs.set(id, fn); return id; },
    cancelAnimationFrame: (id) => rafs.delete(id),
    console,
  });
  const original = fs.readFileSync(sourcePath, "utf8");
  const hook = `window.__liveTest = {\n` +
    `  handleHello, processActivity, flushRender,\n` +
    `  state: () => ({ lastSeq, activeSearches, lanes, nodeRefs, currentIndexJob, statsState, feedRecords })\n` +
    `};\n`;
  const instrumented = original.replace(/\n\}\)\(\);\s*$/, `\n  ${hook}})();\n`);
  if (instrumented === original) throw new Error("live.js IIFE terminator not found");
  vm.runInContext(instrumented, context, { filename: sourcePath });
  for (const fn of rafs.values()) fn();
  rafs.clear();
  return { window, elements, eventSources, runTimers, rafs, test: window.__liveTest };
}

const h = makeHarness();
assert.equal(h.eventSources.length, 1, "initial connection is opened");
const first = h.eventSources[0];
first.emit("hello", {
  streamId: "server-a", seq: 1000,
  stats: { total: 10, avgMs: 12, cacheHitRate: 0, active: 1, qps1m: 0 },
  recent: [], jobs: [{ id: "job-a", slug: "repo-a", state: "running", stage: "embed" }],
});
first.emit("search.start", { seq: 1001, id: "stale-search", client: "test", query: "stale" });
first.emit("search.stage", { seq: 1002, id: "stale-search", stage: "vector", status: "enter" });
first.emit("index.start", { seq: 1003, jobId: "job-a", slug: "repo-a" });
assert.equal(h.test.state().activeSearches.size, 1, "SSE search.start creates a stale active search");
first.fail();
h.runTimers();
assert.equal(h.eventSources.length, 2, "reconnect creates a new EventSource");
const second = h.eventSources[1];
assert.match(second.url, /\/api\/events\?after=1003/, "retry resumes after the last sequence");

// An old source must not mutate state after a replacement source is active.
first.emit("search.done", { seq: 1004, id: "obsolete", client: "old", ms: 1, hits: 1 });
assert.equal(h.test.state().lastSeq, 1003, "obsolete source callback does not advance the sequence");
second.emit("hello", {
  streamId: "server-b", seq: 0,
  stats: { total: 100, avgMs: 20, cacheHitRate: 0, active: 0, qps1m: 0, approxTokensTotal: 7 },
  recent: [], jobs: [],
});
h.test.flushRender();
assert.equal(h.test.state().lastSeq, 0, "restart resets sequence to the new server snapshot");
assert.equal(h.test.state().activeSearches.size, 0, "restart drops stale searches");
assert.equal(h.test.state().lanes.size, 0, "restart drops stale lanes");
assert.equal([...h.test.state().nodeRefs.values()].reduce((count, refs) => count + refs.size, 0), 0, "restart drops stale node references");
assert.equal(h.test.state().currentIndexJob, null, "restart drops stale index jobs");
assert.equal(h.elements.get("liveActiveCount").textContent, "0");
assert.equal(h.elements.get("indexState").textContent, "대기 중");

second.emit("search.start", { seq: 1, id: "same-server-stale", client: "new", query: "will finish during reconnect" });
second.emit("hello", {
  streamId: "server-b", seq: 1,
  stats: { total: 100, avgMs: 20, cacheHitRate: 0, active: 0, qps1m: 0, approxTokensTotal: 7 },
  recent: [{ id: "same-server-stale", ts: "2026-09-22T00:00:00.000Z", client: "new", query: "done", ms: 20 }],
  jobs: [],
});
assert.equal(h.test.state().activeSearches.size, 0, "same-server snapshot clears searches completed before reconnect");
second.emit("search.start", { seq: 2, id: "new-search", client: "new", query: "new" });
second.emit("search.done", {
  seq: 3, id: "new-search", client: "new", ms: 9999, hits: 3,
  stats: { total: 101, avgMs: 20, cacheHitRate: 0, active: 0, qps1m: 1 / 60, approxTokensTotal: 8 },
});
h.test.flushRender();
assert.equal(h.elements.get("kpiTotal").textContent, "101", "a post-restart completion increments the snapshot total");
assert.equal(h.elements.get("kpiAvg").textContent, "20", "server average remains authoritative after a completion event");
const totalAfterDone = h.test.state().statsState.total;
second.emit("search.done", { seq: 3, id: "duplicate", client: "new", ms: 1, hits: 1 });
h.test.flushRender();
assert.equal(h.test.state().statsState.total, totalAfterDone, "duplicate sequence does not increment statistics");

console.log("live reconnect regression: ok");
