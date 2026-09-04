(() => {
  "use strict";

  const root = document.getElementById("section-live");
  if (!root) return;

  const ui = window.grepletUI || {};
  const escapeHtml = typeof ui.escapeHtml === "function"
    ? ui.escapeHtml
    : (value) => String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[char]);
  const byId = (id) => document.getElementById(id);
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const formatNumber = (value) => number(value).toLocaleString("ko-KR");
  const now = () => Date.now();

  const SEARCH_ORDER = ["request", "cache", "embed", "vector", "fts", "rerank", "result"];
  const SEARCH_STAGE_NODE = {
    cache: "cache", embed: "embed", vector: "vector", fts: "fts",
    rerank: "rerank", glob: "result", sort: "result",
  };
  const SEARCH_NODE_LABEL = {
    request: "요청", cache: "캐시", embed: "임베딩", vector: "벡터",
    fts: "FTS", rerank: "RRF", result: "결과",
  };
  const INDEX_ORDER = ["scan", "extract", "embed", "store", "fts"];
  const INDEX_STAGE_NODE = {
    check: "scan", scan: "scan", delete: "extract", extract: "extract",
    embed: "embed", store: "store", manifest: "store", fts: "fts", optimize: "fts",
  };
  const INDEX_NODE_LABEL = {
    scan: "스캔", extract: "추출", embed: "임베딩", store: "저장", fts: "FTS",
  };

  const elements = {
    connection: byId("liveConnection"),
    connectionText: byId("liveConnectionText"),
    activeCount: byId("liveActiveCount"),
    pause: byId("livePause"),
    session: byId("liveSession"),
    filterBadge: byId("liveFilterBadge"),
    lanes: byId("liveLanes"),
    feed: byId("activityFeed"),
    liveStatus: byId("liveStatus"),
    kpiTotal: byId("kpiTotal"),
    kpiAvg: byId("kpiAvg"),
    kpiCache: byId("kpiCache"),
    kpiQps: byId("kpiQps"),
    kpiApproxTokens: byId("kpiApproxTokens"),
    sparkCalls: byId("sparkCalls"),
    sparkMs: byId("sparkMs"),
    sparkCallsValue: byId("sparkCallsValue"),
    sparkMsValue: byId("sparkMsValue"),
    indexState: byId("indexState"),
    indexProgressWrap: byId("indexProgressWrap"),
    indexProgress: byId("indexProgress"),
    indexProgressStage: byId("indexProgressStage"),
    indexProgressText: byId("indexProgressText"),
    usageToggle: byId("usageToggle"),
    usageBody: byId("usageBody"),
    usageDays: byId("usageDays"),
    usageFeed: byId("usageFeed"),
  };

  const searchNodeElements = new Map(
    Array.from(root.querySelectorAll("[data-search-node]"), (element) => [element.dataset.searchNode, element]),
  );
  const searchEdgeElements = new Map(
    Array.from(root.querySelectorAll("[data-search-edge]"), (element) => [element.dataset.searchEdge, element]),
  );
  const indexNodeElements = new Map(
    Array.from(root.querySelectorAll("[data-index-node]"), (element) => [element.dataset.indexNode, element]),
  );
  const indexEdgeElements = new Map(
    Array.from(root.querySelectorAll("[data-index-edge]"), (element) => [element.dataset.indexEdge, element]),
  );

  const nodeRefs = new Map(SEARCH_ORDER.map((node) => [node, new Map()]));
  const edgeRefs = new Map(
    SEARCH_ORDER.slice(0, -1).map((node, index) => [`${node}:${SEARCH_ORDER[index + 1]}`, new Set()]),
  );
  const doneNodes = new Map();
  const activeSearches = new Map();
  const lanes = new Map();
  const laneOrder = [];
  const laneRows = new Map();
  const feedRows = new Map();
  const feedExitReady = new Set();
  const buckets = new Map();

  let feedRecords = [];
  let currentIndexJob = null;
  let lastSeq = 0;
  let eventSource = null;
  let reconnectTimer = 0;
  let reconnectTicker = 0;
  let reconnectAttempt = 0;
  let helloReceived = false;
  let activeEstimate = 0;
  let paused = false;
  let flushFallbackTimer = 0;
  let hidden = document.hidden;
  let rafId = 0;
  let announcement = "";
  const renderQueue = new Set();
  const pausedRenderQueue = [];
  const connectionState = { kind: "retry", text: "재연결 중 0s" };
  const SESSION_STORAGE_KEY = "greplet.live.session";
  const SESSION_OPTIONS_MAX = 50;
  const knownSessions = new Map();
  let sessionFilter = "";
  try {
    sessionFilter = window.localStorage.getItem(SESSION_STORAGE_KEY) || "";
  } catch (_) {
    sessionFilter = "";
  }
  const USAGE_DAYS_STORAGE_KEY = "greplet.live.usageDays";
  const USAGE_FETCH_THROTTLE_MS = 10000;
  let usageDays = 7;
  try {
    const stored = Number(window.localStorage.getItem(USAGE_DAYS_STORAGE_KEY));
    if (stored === 7 || stored === 30 || stored === 90) usageDays = stored;
  } catch (_) {
    usageDays = 7;
  }
  let lastUsageFetchTs = 0;

  function abbreviateNumber(value) {
    const n = number(value);
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function usageClientsText(byClient) {
    const entries = Object.entries(byClient || {}).sort((a, b) => b[1].approxTokens - a[1].approxTokens);
    if (entries.length === 0) return "—";
    return entries.map(([client, usage]) => `${client} ${abbreviateNumber(usage.approxTokens)}`).join(" · ");
  }

  function renderUsage(usageData) {
    if (!elements.usageFeed) return;
    const days = (usageData && Array.isArray(usageData.days)) ? usageData.days : [];
    if (usageData && usageData.disabled) {
      elements.usageFeed.innerHTML = '<tr class="feed-placeholder"><td colspan="8">활동 로그가 꺼져 있습니다(GREPLET_ACTIVITY_LOG=off).</td></tr>';
      return;
    }
    if (days.length === 0) {
      elements.usageFeed.innerHTML = '<tr class="feed-placeholder"><td colspan="8">사용량 데이터가 없습니다.</td></tr>';
      return;
    }
    elements.usageFeed.innerHTML = days
      .slice()
      .reverse()
      .map((day) => `
        <tr>
          <td>${escapeHtml(day.date)}</td>
          <td class="num">${formatNumber(day.searches)}</td>
          <td class="num">${formatNumber(day.hits)}</td>
          <td class="num">${formatNumber(day.approxTokens)}</td>
          <td class="num">${formatNumber(day.avgMs)}</td>
          <td class="num">${formatNumber(day.cached)}</td>
          <td class="num">${formatNumber(day.errors)}</td>
          <td class="usage-clients" title="${escapeHtml(usageClientsText(day.byClient))}">${escapeHtml(usageClientsText(day.byClient))}</td>
        </tr>
      `)
      .join("");
  }

  async function fetchUsage(force) {
    const nowTs = now();
    if (!force && nowTs - lastUsageFetchTs < USAGE_FETCH_THROTTLE_MS) return;
    lastUsageFetchTs = nowTs;
    try {
      const res = await fetch(`/api/usage?days=${usageDays}`);
      if (!res.ok) return;
      const data = await res.json();
      renderUsage(data);
    } catch (_) {
      // 네트워크 실패는 조용히 무시(다음 인터벌에서 재시도)
    }
  }

  if (elements.usageDays) {
    elements.usageDays.value = String(usageDays);
    elements.usageDays.addEventListener("change", () => {
      usageDays = Number(elements.usageDays.value) || 7;
      try {
        window.localStorage.setItem(USAGE_DAYS_STORAGE_KEY, String(usageDays));
      } catch (_) {
        // localStorage 사용 불가 환경은 무시
      }
      fetchUsage(true);
    });
  }

  if (elements.usageToggle && elements.usageBody) {
    elements.usageToggle.addEventListener("click", () => {
      const expanded = elements.usageToggle.getAttribute("aria-expanded") === "true";
      elements.usageToggle.setAttribute("aria-expanded", String(!expanded));
      elements.usageBody.hidden = expanded;
    });
  }

  const statsState = {
    total: 0,
    sumMs: 0,
    cacheHits: 0,
    qpsTimes: [],
    approxTokensTotal: 0,
  };

  function sessionKey(client, session) {
    return `${client || "unknown"}|${session || ""}`;
  }

  function parseSessionKey(key) {
    const index = key.indexOf("|");
    if (index < 0) return [key, ""];
    return [key.slice(0, index), key.slice(index + 1)];
  }

  if (sessionFilter && !knownSessions.has(sessionFilter)) {
    const [client, session] = parseSessionKey(sessionFilter);
    knownSessions.set(sessionFilter, { client, session, lastTs: 0, count: 0 });
  }

  function trimKnownSessions() {
    if (knownSessions.size <= SESSION_OPTIONS_MAX) return;
    const entries = Array.from(knownSessions.entries()).sort((a, b) => a[1].lastTs - b[1].lastTs);
    for (const [key] of entries) {
      if (knownSessions.size <= SESSION_OPTIONS_MAX) break;
      if (key === sessionFilter) continue;
      knownSessions.delete(key);
    }
  }

  function noteSession(client, session, tsMs) {
    const key = sessionKey(client, session);
    const ts = Number.isFinite(tsMs) ? tsMs : now();
    const existing = knownSessions.get(key);
    if (existing) {
      if (ts > existing.lastTs) existing.lastTs = ts;
      existing.count += 1;
    } else {
      knownSessions.set(key, { client: client || "unknown", session: session || "", lastTs: ts, count: 1 });
    }
    trimKnownSessions();
    scheduleRender("sessionOptions");
  }

  function noteSessionFromRecord(record) {
    const ts = Date.parse(record.ts);
    noteSession(record.client, record.session, Number.isFinite(ts) ? ts : now());
  }

  function sessionOptionLabel(entry) {
    return entry.session
      ? `${entry.client} · ${entry.session.slice(0, 8)}`
      : `${entry.client} · (세션 없음)`;
  }

  function renderSessionOptions() {
    const select = elements.session;
    if (!select) return;
    const entries = Array.from(knownSessions.entries()).sort((a, b) => b[1].lastTs - a[1].lastTs);
    const limited = entries.slice(0, SESSION_OPTIONS_MAX);
    if (sessionFilter && !limited.some(([key]) => key === sessionFilter) && knownSessions.has(sessionFilter)) {
      limited.push([sessionFilter, knownSessions.get(sessionFilter)]);
    }
    const optionsHtml = limited.map(([key, entry]) =>
      `<option value="${escapeHtml(key)}">${escapeHtml(sessionOptionLabel(entry))}</option>`
    ).join("");
    select.innerHTML = `<option value="">전체</option>${optionsHtml}`;
    select.value = sessionFilter;
  }

  function updateFilterBadge() {
    if (!elements.filterBadge) return;
    if (!sessionFilter) {
      elements.filterBadge.hidden = true;
      elements.filterBadge.textContent = "";
      return;
    }
    const entry = knownSessions.get(sessionFilter);
    const label = entry ? sessionOptionLabel(entry) : sessionFilter;
    elements.filterBadge.hidden = false;
    elements.filterBadge.textContent = `필터: ${label}`;
  }

  function laneMatchesFilter(lane) {
    return !sessionFilter || sessionKey(lane.client, lane.session) === sessionFilter;
  }

  function filteredFeedRecords() {
    if (!sessionFilter) return feedRecords;
    return feedRecords.filter((record) => sessionKey(record.client, record.session) === sessionFilter);
  }

  function filteredActiveSearchCount() {
    if (!sessionFilter) return Math.max(activeEstimate, activeSearches.size);
    let count = 0;
    for (const search of activeSearches.values()) {
      if (sessionKey(search.client, search.session) === sessionFilter) count += 1;
    }
    return count;
  }

  function computeFilteredBuckets() {
    const map = new Map();
    filteredFeedRecords().forEach((record) => {
      const parsed = Date.parse(record.ts);
      const key = bucketKey(Number.isFinite(parsed) ? parsed : now());
      const bucket = map.get(key) || { calls: 0, sumMs: 0 };
      bucket.calls += 1;
      bucket.sumMs += number(record.ms);
      map.set(key, bucket);
    });
    return map;
  }

  function scheduleRender(...parts) {
    if (paused) {
      for (const part of parts) {
        pausedRenderQueue.push(part);
        if (pausedRenderQueue.length > 200) pausedRenderQueue.shift();
      }
      return;
    }
    parts.forEach((part) => renderQueue.add(part));
    if (!rafId) {
      rafId = requestAnimationFrame(flushRender);
      // rAF 가 안 불리는 환경(헤드리스·프레임 미생성)에서도 갱신이 멈추지 않도록 타이머 폴백
      flushFallbackTimer = window.setTimeout(flushRender, 100);
    }
  }

  function flushRender() {
    if (rafId) cancelAnimationFrame(rafId);
    window.clearTimeout(flushFallbackTimer);
    rafId = 0;
    flushFallbackTimer = 0;
    if (paused) return;
    const pending = new Set(renderQueue);
    renderQueue.clear();
    const all = pending.has("all");
    const wants = (part) => all || pending.has(part);
    if (wants("connection")) renderConnection();
    if (wants("nodes")) renderSearchNodes();
    if (wants("sessionOptions")) renderSessionOptions();
    if (wants("lanes")) renderLanes();
    if (wants("stats")) renderStats();
    if (wants("index")) renderIndexPipeline();
    if (wants("feed")) renderFeed();
    if (wants("announcement")) elements.liveStatus.innerHTML = escapeHtml(announcement);
    if (wants("sparks")) drawSparklines();
  }

  function setConnection(kind, text) {
    connectionState.kind = kind;
    connectionState.text = text;
    scheduleRender("connection");
  }

  function renderConnection() {
    elements.connection.classList.toggle("connected", connectionState.kind === "connected");
    elements.connection.classList.toggle("disconnected", connectionState.kind === "disconnected");
    elements.connectionText.textContent = connectionState.text;
  }

  function addNodeRef(search, node, status) {
    if (!nodeRefs.has(node)) return;
    const refs = nodeRefs.get(node);
    const next = status === "fallback" ? "fallback" : status === "skip" ? "skip" : "active";
    const priority = { skip: 1, active: 2, fallback: 3 };
    const previous = refs.get(search.id);
    refs.set(search.id, !previous || priority[next] > priority[previous] ? next : previous);
    search.nodes.add(node);
  }

  function addFlow(search, from, to) {
    const fromIndex = SEARCH_ORDER.indexOf(from);
    const toIndex = SEARCH_ORDER.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    if (toIndex > fromIndex) {
      for (let index = fromIndex; index < toIndex; index += 1) {
        const key = `${SEARCH_ORDER[index]}:${SEARCH_ORDER[index + 1]}`;
        const refs = edgeRefs.get(key);
        if (refs) {
          refs.add(search.id);
          search.edges.add(key);
        }
      }
      return;
    }
    const key = `${from}:${to}`;
    const refs = edgeRefs.get(key);
    if (refs) {
      refs.add(search.id);
      search.edges.add(key);
    }
  }

  function moveSearch(search, node, status) {
    if (search.currentNode && search.currentNode !== node) addFlow(search, search.currentNode, node);
    addNodeRef(search, node, status);
    search.currentNode = node;
  }

  function renderSearchNodes() {
    for (const [node, element] of searchNodeElements) {
      const statuses = Array.from(nodeRefs.get(node).values());
      const activeCount = statuses.length;
      const hasActive = statuses.includes("active");
      const hasFallback = statuses.includes("fallback");
      const onlySkipped = activeCount > 0 && statuses.every((status) => status === "skip");
      const isDone = number(doneNodes.get(node)) > now();
      element.classList.toggle("active", hasActive && !hasFallback);
      element.classList.toggle("fallback", hasFallback);
      element.classList.toggle("skip", onlySkipped);
      element.classList.toggle("done", isDone);
      const badge = element.querySelector(".node-count");
      badge.hidden = activeCount === 0;
      badge.textContent = String(activeCount);
    }
    for (const [edge, element] of searchEdgeElements) {
      element.classList.toggle("flow", edgeRefs.get(edge).size > 0);
    }
    elements.activeCount.textContent = String(filteredActiveSearchCount());
  }

  function createSearchFromStart(event) {
    return {
      id: String(event.id),
      client: String(event.client || "unknown"),
      session: String(event.session || ""),
      query: String(event.query || ""),
      workspaces: Array.isArray(event.workspaces) ? event.workspaces.map(String) : [],
      mode: String(event.mode || "hybrid"),
      topN: number(event.topN),
      startedAt: Date.parse(event.ts) || now(),
      currentNode: null,
      nodes: new Set(),
      edges: new Set(),
      estimateTracked: false,
      doneReceived: false,
    };
  }

  function ensureSearch(id, event) {
    if (activeSearches.has(id)) return activeSearches.get(id);
    const search = createSearchFromStart({
      id,
      client: event.client || "unknown",
      session: event.session || "",
      query: event.query || "(진행 중인 검색)",
      workspaces: event.workspaces || [],
      mode: event.mode || "hybrid",
      topN: event.topN || 0,
      ts: event.ts,
    });
    activeSearches.set(id, search);
    addLane(search);
    return search;
  }

  function addLane(search) {
    lanes.set(search.id, {
      id: search.id,
      client: search.client,
      session: search.session,
      query: search.query,
      mode: search.mode,
      startedAt: search.startedAt,
      stage: "request",
      doneAt: 0,
      hits: 0,
      approxTokens: 0,
      leaving: false,
    });
    const existingIndex = laneOrder.indexOf(search.id);
    if (existingIndex >= 0) laneOrder.splice(existingIndex, 1);
    laneOrder.unshift(search.id);
    const visible = laneOrder.filter((id) => lanes.has(id) && !lanes.get(id).leaving);
    while (visible.length > 4) {
      const id = visible.pop();
      markLaneLeaving(id, 120);
    }
  }

  function markLaneLeaving(id, delay) {
    const lane = lanes.get(id);
    if (!lane || lane.leaving) return;
    lane.leaving = true;
    scheduleRender("lanes");
    window.setTimeout(() => {
      lanes.delete(id);
      const index = laneOrder.indexOf(id);
      if (index >= 0) laneOrder.splice(index, 1);
      scheduleRender("lanes");
    }, delay);
  }

  function renderLanes() {
    const desired = laneOrder.filter((id) => lanes.has(id) && laneMatchesFilter(lanes.get(id)));
    if (desired.length === 0) {
      elements.lanes.innerHTML = '<p class="live-empty">검색 요청을 기다리는 중</p>';
      laneRows.clear();
      return;
    }
    const placeholder = elements.lanes.querySelector(".live-empty");
    if (placeholder) placeholder.remove();
    const desiredSet = new Set(desired);
    for (const [id, row] of laneRows) {
      if (!desiredSet.has(id)) {
        row.remove();
        laneRows.delete(id);
      }
    }
    desired.forEach((id, index) => {
      const lane = lanes.get(id);
      let row = laneRows.get(id);
      if (!row) {
        row = document.createElement("div");
        row.className = "search-lane";
        row.style.animationDelay = `${Math.min(index * 30, 90)}ms`;
        laneRows.set(id, row);
      }
      const elapsedMs = Math.max(0, (lane.doneAt || now()) - lane.startedAt);
      const progress = lane.doneAt ? 1 : Math.min(.94, Math.max(.06, elapsedMs / 3500));
      const stageText = lane.doneAt ? `완료 · ${formatNumber(lane.hits)}건 · ≈${formatNumber(lane.approxTokens || 0)} tok` : SEARCH_NODE_LABEL[lane.stage] || "진행 중";
      row.classList.toggle("complete", Boolean(lane.doneAt));
      row.classList.toggle("leaving", lane.leaving);
      row.innerHTML = `
        <div class="lane-head">
          <span class="lane-query" title="${escapeHtml(lane.query)}">${escapeHtml(lane.query || "(빈 쿼리)")}</span>
          <span class="lane-client">${escapeHtml(lane.client)}</span>
        </div>
        <div class="lane-meta"><span>${escapeHtml(stageText)} · ${escapeHtml(lane.mode)}</span><span>${(elapsedMs / 1000).toFixed(1)}s</span></div>
        <div class="lane-progress" aria-hidden="true"><span style="transform:scaleX(${progress.toFixed(3)})"></span></div>
      `;
      elements.lanes.appendChild(row);
    });
  }

  function cleanupSearch(id) {
    const search = activeSearches.get(id);
    if (search) {
      search.nodes.forEach((node) => nodeRefs.get(node).delete(id));
      search.edges.forEach((edge) => edgeRefs.get(edge).delete(id));
      activeSearches.delete(id);
    }
    if (search && search.estimateTracked) activeEstimate = Math.max(0, activeEstimate - 1);
    scheduleRender("nodes", "stats");
  }

  function normalizeRecord(record, fallbackId) {
    return {
      id: String(record.id || fallbackId),
      ts: String(record.ts || new Date().toISOString()),
      client: String(record.client || "unknown"),
      session: String(record.session || ""),
      query: String(record.query || ""),
      workspaces: Array.isArray(record.workspaces) ? record.workspaces.map(String) : [],
      mode: String(record.mode || "hybrid"),
      hits: number(record.hits),
      ms: number(record.ms),
      cached: Boolean(record.cached),
      warnings: number(record.warnings),
      approxTokens: number(record.approxTokens),
      error: record.error ? String(record.error) : "",
    };
  }

  function setFeed(records) {
    const seen = new Set();
    feedRecords = [];
    (Array.isArray(records) ? records : []).forEach((record, index) => {
      const normalized = normalizeRecord(record, `recent-${index}-${record.ts || ""}`);
      if (!seen.has(normalized.id) && feedRecords.length < 50) {
        seen.add(normalized.id);
        feedRecords.push(normalized);
      }
    });
  }

  function prependFeed(record) {
    feedRecords = [record, ...feedRecords.filter((item) => item.id !== record.id)].slice(0, 50);
  }

  function shortQuery(query) {
    const chars = Array.from(query);
    return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : query;
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function statusBadges(record) {
    const badges = [];
    if (record.cached) {
      badges.push('<span class="feed-badge cached"><svg aria-hidden="true"><use href="#i-cache" /></svg>cached</span>');
    }
    if (record.warnings > 0) {
      badges.push(`<span class="feed-badge warn"><svg aria-hidden="true"><use href="#i-warning" /></svg>warn ${formatNumber(record.warnings)}</span>`);
    }
    if (record.error) {
      badges.push(`<span class="feed-badge error" title="${escapeHtml(record.error)}"><svg aria-hidden="true"><use href="#i-error" /></svg>error</span>`);
    }
    if (badges.length === 0) {
      badges.push('<span class="feed-badge clear"><svg aria-hidden="true"><use href="#i-check" /></svg>완료</span>');
    }
    return badges.join("");
  }

  function feedRowHtml(record) {
    const workspaces = record.workspaces.length ? record.workspaces.join(" · ") : "—";
    const sessionText = record.session ? record.session.slice(0, 8) : "—";
    return `
      <td class="activity-time"><time datetime="${escapeHtml(record.ts)}">${escapeHtml(formatTime(record.ts))}</time></td>
      <td class="activity-client">${escapeHtml(record.client)}</td>
      <td class="activity-session" title="${escapeHtml(record.session || "")}">${escapeHtml(sessionText)}</td>
      <td class="activity-query" title="${escapeHtml(record.query)}">${escapeHtml(shortQuery(record.query) || "(hidden)")}</td>
      <td class="activity-mode">${escapeHtml(record.mode)}</td>
      <td class="activity-workspaces" title="${escapeHtml(workspaces)}">${escapeHtml(workspaces)}</td>
      <td class="num">${formatNumber(record.hits)}</td>
      <td class="num">${formatNumber(record.approxTokens)}</td>
      <td class="num">${formatNumber(Math.round(record.ms))}</td>
      <td><span class="feed-statuses">${statusBadges(record)}</span></td>
    `;
  }

  function renderFeed() {
    const records = filteredFeedRecords();
    if (records.length === 0) {
      const message = sessionFilter ? "선택한 세션의 검색이 없습니다." : "아직 완료된 검색이 없습니다.";
      elements.feed.innerHTML = `<tr class="feed-placeholder"><td colspan="10">${escapeHtml(message)}</td></tr>`;
      feedRows.clear();
      return;
    }
    const placeholder = elements.feed.querySelector(".feed-placeholder");
    if (placeholder) placeholder.remove();
    const desiredIds = new Set(records.map((record) => record.id));
    for (const [id, row] of feedRows) {
      if (!desiredIds.has(id)) {
        if (feedExitReady.has(id)) {
          row.remove();
          feedRows.delete(id);
          feedExitReady.delete(id);
        } else if (row.dataset.removing !== "true") {
          row.dataset.removing = "true";
          row.classList.add("leaving");
          window.setTimeout(() => {
            feedExitReady.add(id);
            scheduleRender("feed");
          }, 120);
        }
      }
    }
    records.forEach((record, index) => {
      let row = feedRows.get(record.id);
      if (!row) {
        row = document.createElement("tr");
        row.dataset.feedId = record.id;
        row.style.animationDelay = `${index * 30}ms`;
        feedRows.set(record.id, row);
      }
      feedExitReady.delete(record.id);
      delete row.dataset.removing;
      row.classList.remove("leaving");
      row.innerHTML = feedRowHtml(record);
      elements.feed.appendChild(row);
    });
  }

  function applyServerStats(stats, recent) {
    const total = number(stats && stats.total);
    const rate = number(stats && stats.cacheHitRate);
    statsState.total = total;
    statsState.sumMs = number(stats && stats.avgMs) * total;
    statsState.cacheHits = total * (rate <= 1 ? rate : rate / 100);
    statsState.approxTokensTotal = number(stats && stats.approxTokensTotal);
    const timestampNow = now();
    const cutoff = timestampNow - 60000;
    const targetCount = Math.max(0, Math.round(number(stats && stats.qps1m) * 60));
    const recentTimes = (Array.isArray(recent) ? recent : [])
      .map((record) => Date.parse(record.ts))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= timestampNow)
      .sort((a, b) => b - a)
      .slice(0, targetCount);
    const missing = Math.max(0, targetCount - recentTimes.length);
    for (let index = 0; index < missing; index += 1) {
      recentTimes.push(timestampNow - (((index + 1) / (missing + 1)) * 59000));
    }
    statsState.qpsTimes = recentTimes;
    activeEstimate = number(stats && stats.active);
  }

  function renderStats() {
    if (sessionFilter) {
      const records = filteredFeedRecords();
      const total = records.length;
      const sumMs = records.reduce((sum, record) => sum + record.ms, 0);
      const cacheHits = records.filter((record) => record.cached).length;
      const cutoff = now() - 60000;
      const qpsCount = records.filter((record) => {
        const ts = Date.parse(record.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      }).length;
      const average = total > 0 ? sumMs / total : 0;
      const cacheRate = total > 0 ? (cacheHits / total) * 100 : 0;
      const approxTokensSum = records.reduce((sum, record) => sum + record.approxTokens, 0);
      elements.kpiTotal.textContent = formatNumber(total);
      elements.kpiAvg.textContent = formatNumber(Math.round(average));
      elements.kpiCache.textContent = `${cacheRate.toFixed(1)}%`;
      elements.kpiQps.textContent = (qpsCount / 60).toFixed(2);
      elements.kpiApproxTokens.textContent = formatNumber(approxTokensSum);
      elements.activeCount.textContent = String(filteredActiveSearchCount());
      updateFilterBadge();
      return;
    }
    const cutoff = now() - 60000;
    statsState.qpsTimes = statsState.qpsTimes.filter((timestamp) => timestamp >= cutoff);
    const average = statsState.total > 0 ? statsState.sumMs / statsState.total : 0;
    const cacheRate = statsState.total > 0 ? (statsState.cacheHits / statsState.total) * 100 : 0;
    const qps = statsState.qpsTimes.length / 60;
    elements.kpiTotal.textContent = formatNumber(statsState.total);
    elements.kpiAvg.textContent = formatNumber(Math.round(average));
    elements.kpiCache.textContent = `${cacheRate.toFixed(1)}%`;
    elements.kpiQps.textContent = qps.toFixed(2);
    elements.kpiApproxTokens.textContent = formatNumber(statsState.approxTokensTotal);
    elements.activeCount.textContent = String(filteredActiveSearchCount());
    updateFilterBadge();
  }

  function bucketKey(timestamp) {
    return Math.floor(timestamp / 10000);
  }

  function addBucketRecord(timestamp, ms) {
    const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    const key = bucketKey(Number.isFinite(parsed) ? parsed : now());
    const bucket = buckets.get(key) || { calls: 0, sumMs: 0 };
    bucket.calls += 1;
    bucket.sumMs += number(ms);
    buckets.set(key, bucket);
    const oldest = bucketKey(now()) - 29;
    for (const existing of buckets.keys()) {
      if (existing < oldest) buckets.delete(existing);
    }
  }

  function populateBuckets(records) {
    buckets.clear();
    (Array.isArray(records) ? records : []).forEach((record) => addBucketRecord(record.ts, record.ms));
  }

  function polylinePoints(values) {
    const max = Math.max(1, ...values);
    return values.map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 160;
      const y = 34 - (value / max) * 30;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }

  function drawSparklines() {
    if (paused || hidden) return;
    const current = bucketKey(now());
    const source = sessionFilter ? computeFilteredBuckets() : buckets;
    const calls = [];
    const averageMs = [];
    for (let offset = 29; offset >= 0; offset -= 1) {
      const bucket = source.get(current - offset) || { calls: 0, sumMs: 0 };
      calls.push(bucket.calls);
      averageMs.push(bucket.calls ? bucket.sumMs / bucket.calls : 0);
    }
    elements.sparkCalls.setAttribute("points", polylinePoints(calls));
    elements.sparkMs.setAttribute("points", polylinePoints(averageMs));
    elements.sparkCallsValue.textContent = `${formatNumber(calls[calls.length - 1])}회 / 10초`;
    elements.sparkMsValue.textContent = `${formatNumber(Math.round(averageMs[averageMs.length - 1]))} ms`;
  }

  function indexJobFromRecord(job) {
    const currentNode = INDEX_STAGE_NODE[job.stage] || null;
    const nodes = new Set();
    if (currentNode) {
      const currentIndex = INDEX_ORDER.indexOf(currentNode);
      INDEX_ORDER.slice(0, currentIndex + 1).forEach((node) => nodes.add(node));
    }
    return {
      id: String(job.id || job.jobId || "running-index"),
      slug: String(job.slug || "unknown"),
      status: "running",
      currentNode,
      nodes,
      progress: job.progress ? {
        stage: String(job.stage || "embed"),
        done: number(job.progress.done),
        total: number(job.progress.total),
      } : null,
      error: "",
    };
  }

  function renderIndexPipeline() {
    for (const element of indexNodeElements.values()) {
      element.classList.remove("active", "done", "error", "fallback", "skip");
    }
    for (const element of indexEdgeElements.values()) element.classList.remove("flow");
    if (!currentIndexJob) {
      elements.indexState.className = "index-state";
      elements.indexState.textContent = "대기 중";
      elements.indexProgressWrap.hidden = true;
      return;
    }
    const job = currentIndexJob;
    const currentIndex = INDEX_ORDER.indexOf(job.currentNode);
    job.nodes.forEach((node) => {
      const element = indexNodeElements.get(node);
      if (!element) return;
      if (job.status === "failed" && node === job.currentNode) element.classList.add("error");
      else if (job.status === "running" && node === job.currentNode) element.classList.add("active");
      else element.classList.add("done");
    });
    if (job.status === "running" && currentIndex > 0) {
      const edge = indexEdgeElements.get(`${INDEX_ORDER[currentIndex - 1]}:${INDEX_ORDER[currentIndex]}`);
      if (edge) edge.classList.add("flow");
    }
    const stageLabel = INDEX_NODE_LABEL[job.currentNode] || "준비";
    elements.indexState.className = `index-state ${job.status}`;
    elements.indexState.textContent = job.status === "done"
      ? `${job.slug} · 완료`
      : job.status === "failed"
        ? `${job.slug} · 실패`
        : `${job.slug} · ${stageLabel}`;
    if (job.progress && job.progress.total > 0) {
      elements.indexProgressWrap.hidden = false;
      elements.indexProgressStage.textContent = INDEX_NODE_LABEL[INDEX_STAGE_NODE[job.progress.stage]] || stageLabel;
      elements.indexProgress.max = job.progress.total;
      elements.indexProgress.value = Math.min(job.progress.done, job.progress.total);
      elements.indexProgress.textContent = `${job.progress.done} / ${job.progress.total}`;
      elements.indexProgressText.textContent = `${formatNumber(job.progress.done)} / ${formatNumber(job.progress.total)}`;
    } else {
      elements.indexProgressWrap.hidden = true;
    }
  }

  function refreshLegacyPanels() {
    ["refreshWorkspaces", "refreshJobs"].forEach((name) => {
      if (typeof ui[name] === "function") Promise.resolve(ui[name]()).catch(() => {});
    });
  }

  function handleSearchStart(event) {
    const search = createSearchFromStart(event);
    activeSearches.set(search.id, search);
    moveSearch(search, "request", "enter");
    addLane(search);
    noteSession(search.client, search.session, search.startedAt);
    if (helloReceived) {
      activeEstimate += 1;
      search.estimateTracked = true;
    }
    scheduleRender("nodes", "lanes", "stats");
  }

  function handleSearchStage(event) {
    const id = String(event.id);
    const search = ensureSearch(id, event);
    const node = SEARCH_STAGE_NODE[event.stage];
    if (!node) return;
    moveSearch(search, node, event.status);
    const lane = lanes.get(id);
    if (lane) lane.stage = node;
    scheduleRender("nodes", "lanes");
  }

  function handleSearchDone(event) {
    const id = String(event.id);
    const existingSearch = activeSearches.get(id);
    const search = existingSearch || createSearchFromStart({
      id,
      client: event.client,
      session: event.session,
      query: "(검색 내용 없음)",
      workspaces: [],
      mode: event.mode,
      ts: event.ts,
    });
    if (!existingSearch) {
      search.estimateTracked = helloReceived && activeEstimate > 0;
      activeSearches.set(id, search);
    }
    search.doneReceived = true;
    moveSearch(search, "result", "enter");
    doneNodes.set("result", now() + 650);
    const lane = lanes.get(id);
    if (lane) {
      lane.stage = "result";
      lane.doneAt = now();
      lane.hits = number(event.hits);
      lane.approxTokens = number(event.approxTokens);
      window.setTimeout(() => markLaneLeaving(id, 120), 1500);
    }
    const record = normalizeRecord({
      id,
      ts: event.ts,
      client: event.client || search.client,
      session: event.session || search.session,
      query: search.query,
      workspaces: search.workspaces,
      mode: event.mode || search.mode,
      hits: event.hits,
      ms: event.ms,
      cached: event.cached,
      warnings: event.warnings,
      approxTokens: event.approxTokens,
      error: event.error,
    }, id);
    prependFeed(record);
    noteSessionFromRecord(record);
    statsState.total += 1;
    statsState.sumMs += record.ms;
    if (record.cached) statsState.cacheHits += 1;
    statsState.approxTokensTotal += record.approxTokens;
    statsState.qpsTimes.push(now());
    addBucketRecord(record.ts, record.ms);
    announcement = `검색 완료: ${record.client} · ${formatNumber(record.hits)}건 · ${formatNumber(record.ms)}ms`;
    scheduleRender("nodes", "lanes", "feed", "stats", "sparks", "announcement");
    window.setTimeout(() => cleanupSearch(id), 200);
    window.setTimeout(() => {
      if (number(doneNodes.get("result")) <= now()) {
        doneNodes.delete("result");
        scheduleRender("nodes");
      }
    }, 700);
  }

  function handleIndexStart(event) {
    currentIndexJob = {
      id: String(event.jobId),
      slug: String(event.slug || "unknown"),
      status: "running",
      currentNode: null,
      nodes: new Set(),
      progress: null,
      error: "",
    };
    scheduleRender("index");
  }

  function ensureIndexJob(event) {
    const id = String(event.jobId);
    if (!currentIndexJob || currentIndexJob.id !== id) handleIndexStart(event);
    return currentIndexJob;
  }

  function handleIndexStage(event) {
    const job = ensureIndexJob(event);
    const node = INDEX_STAGE_NODE[event.stage];
    if (!node) return;
    job.currentNode = node;
    job.nodes.add(node);
    job.progress = null;
    scheduleRender("index");
  }

  function handleIndexProgress(event) {
    const job = ensureIndexJob(event);
    const node = INDEX_STAGE_NODE[event.stage];
    if (node) {
      job.currentNode = node;
      job.nodes.add(node);
    }
    job.progress = { stage: String(event.stage), done: number(event.done), total: number(event.total) };
    scheduleRender("index");
  }

  function finishIndex(event, failed) {
    const job = ensureIndexJob(event);
    job.status = failed ? "failed" : "done";
    job.error = failed ? String(event.error || "알 수 없는 오류") : "";
    if (!failed && job.currentNode) job.nodes.add(job.currentNode);
    announcement = failed
      ? `인덱싱 실패: ${job.slug} · ${job.error}`
      : `인덱싱 완료: ${job.slug} · ${formatNumber(event.chunks)}청크`;
    scheduleRender("index", "announcement");
    refreshLegacyPanels();
    const completedId = job.id;
    window.setTimeout(() => {
      if (currentIndexJob && currentIndexJob.id === completedId) {
        currentIndexJob = null;
        scheduleRender("index");
      }
    }, 1800);
  }

  function processActivity(event) {
    const seq = number(event.seq);
    if (seq && seq <= lastSeq) return;
    if (seq) lastSeq = Math.max(lastSeq, seq);
    switch (event.type) {
      case "search.start": handleSearchStart(event); break;
      case "search.stage": handleSearchStage(event); break;
      case "search.done": handleSearchDone(event); fetchUsage(false); break;
      case "index.start": handleIndexStart(event); break;
      case "index.stage": handleIndexStage(event); break;
      case "index.progress": handleIndexProgress(event); break;
      case "index.done": finishIndex(event, false); break;
      case "index.failed": finishIndex(event, true); break;
      default: break;
    }
  }

  function processSseEvent(message) {
    try {
      const event = JSON.parse(message.data);
      if (!event.seq && message.lastEventId) event.seq = number(message.lastEventId);
      processActivity(event);
    } catch (_) {
      setConnection("disconnected", "끊김");
    }
  }

  function handleHello(payload) {
    helloReceived = true;
    applyServerStats(payload.stats || {}, payload.recent || []);
    activeSearches.forEach((search) => {
      search.estimateTracked = !search.doneReceived;
    });
    setFeed(payload.recent || []);
    feedRecords.forEach(noteSessionFromRecord);
    populateBuckets(payload.recent || []);
    lastSeq = Math.max(lastSeq, number(payload.seq));
    const runningJob = (Array.isArray(payload.jobs) ? payload.jobs : []).find((job) => job.state === "running");
    currentIndexJob = runningJob ? indexJobFromRecord(runningJob) : currentIndexJob && currentIndexJob.status === "running" ? currentIndexJob : null;
    reconnectAttempt = 0;
    window.clearInterval(reconnectTicker);
    setConnection("connected", "연결됨");
    scheduleRender("all");
  }

  function processHello(message) {
    try {
      handleHello(JSON.parse(message.data));
    } catch (_) {
      setConnection("disconnected", "끊김");
    }
  }

  function showRetryCountdown(delay) {
    const deadline = now() + delay;
    window.clearInterval(reconnectTicker);
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline - now()) / 1000));
      setConnection("retry", `재연결 중 ${seconds}s`);
    };
    update();
    reconnectTicker = window.setInterval(update, 250);
  }

  function connect() {
    window.clearTimeout(reconnectTimer);
    if (!("EventSource" in window)) {
      setConnection("disconnected", "끊김");
      return;
    }
    const url = `/api/events${lastSeq ? `?after=${encodeURIComponent(lastSeq)}` : ""}`;
    const source = new EventSource(url);
    eventSource = source;
    [
      "search.start", "search.stage", "search.done", "index.start", "index.stage",
      "index.progress", "index.done", "index.failed",
    ].forEach((type) => source.addEventListener(type, processSseEvent));
    source.addEventListener("hello", processHello);
    source.onerror = () => {
      if (eventSource !== source) return;
      source.close();
      eventSource = null;
      const delay = Math.min(30000, 1000 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      showRetryCountdown(delay);
      reconnectTimer = window.setTimeout(connect, delay);
    };
  }

  function demoEventFactory() {
    let seq = 0;
    return (event) => processActivity({ ...event, seq: ++seq, ts: new Date().toISOString() });
  }

  function startDemo() {
    const emit = demoEventFactory();
    const demoNow = now();
    handleHello({
      stats: { total: 1284, avgMs: 86, p95Ms: 164, cacheHitRate: .347, qps1m: .22, active: 0, byClient: {}, errors: 2, approxTokensTotal: 187420 },
      recent: [
        { id: "recent-a", ts: new Date(demoNow - 24000).toISOString(), client: "mcp:codex", query: "SearchStageEvent가 발생하는 위치", workspaces: ["greplet"], mode: "hybrid", hits: 8, ms: 74, cached: false, warnings: 0, approxTokens: 212 },
        { id: "recent-b", ts: new Date(demoNow - 51000).toISOString(), client: "cli", query: "LanceDB FTS 인덱스 생성", workspaces: ["greplet"], mode: "fts", hits: 6, ms: 42, cached: true, warnings: 0, approxTokens: 156 },
        { id: "recent-c", ts: new Date(demoNow - 86000).toISOString(), client: "mcp:claude", query: "PDF 암호 해제 후 페이지 청킹 로직", workspaces: ["greplet", "manuals"], mode: "hybrid", hits: 10, ms: 131, cached: false, warnings: 1, approxTokens: 298 },
      ],
      jobs: [],
      seq: 0,
    });

    const demoUsageDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(demoNow - (6 - i) * 86400000);
      const searches = 120 + i * 34 + (i % 3) * 10;
      const approxTokens = searches * (140 + i * 6);
      return {
        date: d.toISOString().slice(0, 10),
        searches,
        hits: searches * 5,
        approxTokens,
        avgMs: 70 + (i % 4) * 12,
        cached: Math.round(searches * 0.35),
        errors: i % 5 === 0 ? 1 : 0,
        byClient: {
          "cli:codex": { searches: Math.round(searches * 0.4), approxTokens: Math.round(approxTokens * 0.4) },
          "mcp:claude": { searches: Math.round(searches * 0.35), approxTokens: Math.round(approxTokens * 0.35) },
          "mcp:codex": { searches: Math.round(searches * 0.25), approxTokens: Math.round(approxTokens * 0.25) },
        },
      };
    });
    renderUsage({
      days: demoUsageDays,
      total: demoUsageDays.reduce(
        (acc, day) => ({ searches: acc.searches + day.searches, approxTokens: acc.approxTokens + day.approxTokens, byClient: {} }),
        { searches: 0, approxTokens: 0, byClient: {} },
      ),
    });

    const clients = ["mcp:claude", "mcp:codex", "cli"];
    const queries = [
      "검색 결과 캐시 무효화 조건을 찾아줘",
      "RRF rerank 후보 풀 계산 경로",
      "manifest 원자적 저장 처리",
      "벡터 검색 실패 시 FTS 폴백",
    ];
    let searchCounter = 0;
    const runSearch = () => {
      const index = searchCounter++;
      const id = `demo-search-${index}`;
      const client = clients[index % clients.length];
      const query = queries[index % queries.length];
      const mode = index % 4 === 2 ? "fts" : "hybrid";
      emit({ type: "search.start", id, client, query, workspaces: ["greplet"], mode, topN: 8 });
      const stages = mode === "fts"
        ? [["cache", "enter"], ["embed", "skip"], ["vector", "skip"], ["fts", "enter"], ["rerank", "skip"]]
        : [["cache", "enter"], ["embed", "enter"], ["vector", "enter"], ["fts", index % 5 === 3 ? "fallback" : "enter"], ["rerank", "enter"]];
      stages.forEach(([stage, status], stageIndex) => {
        window.setTimeout(() => emit({ type: "search.stage", id, workspace: "greplet", stage, status }), 240 * (stageIndex + 1));
      });
      window.setTimeout(() => emit({
        type: "search.done", id, client, hits: 6 + (index % 5), ms: 58 + ((index * 37) % 120),
        cached: index % 4 === 1, mode, warnings: index % 5 === 3 ? 1 : 0,
        approxTokens: 140 + ((index * 53) % 260),
      }), 1540);
    };
    window.setTimeout(runSearch, 350);
    window.setInterval(runSearch, 3000);

    const jobId = "demo-index-1";
    window.setTimeout(() => emit({ type: "index.start", jobId, slug: "greplet", force: false }), 900);
    [["scan", 1400], ["extract", 2200], ["embed", 3000]].forEach(([stage, delay]) => {
      window.setTimeout(() => emit({ type: "index.stage", jobId, slug: "greplet", stage }), delay);
    });
    [[720, 5000, 3500], [1960, 5000, 4200], [3580, 5000, 4900]].forEach(([done, total, delay]) => {
      window.setTimeout(() => emit({ type: "index.progress", jobId, slug: "greplet", stage: "embed", done, total }), delay);
    });
    window.setTimeout(() => emit({ type: "index.stage", jobId, slug: "greplet", stage: "store" }), 5500);
    window.setTimeout(() => emit({ type: "index.progress", jobId, slug: "greplet", stage: "store", done: 4200, total: 5000 }), 6000);
    window.setTimeout(() => emit({ type: "index.stage", jobId, slug: "greplet", stage: "fts" }), 6650);
    window.setTimeout(() => emit({ type: "index.done", jobId, slug: "greplet", ms: 6840, added: 12, changed: 4, deleted: 1, chunks: 5000 }), 7550);
  }

  if (elements.session) {
    elements.session.addEventListener("change", () => {
      sessionFilter = elements.session.value;
      try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, sessionFilter);
      } catch (_) {
        // localStorage 사용 불가 환경은 무시
      }
      scheduleRender("all");
    });
  }

  elements.pause.addEventListener("click", () => {
    paused = !paused;
    document.body.classList.toggle("live-paused", paused);
    elements.pause.setAttribute("aria-pressed", String(paused));
    elements.pause.querySelector("use").setAttribute("href", paused ? "#i-play" : "#i-pause");
    elements.pause.querySelector("span").textContent = paused ? "Resume" : "Pause";
    if (paused) {
      announcement = "라이브 화면 일시정지";
      elements.liveStatus.innerHTML = escapeHtml(announcement);
    } else {
      pausedRenderQueue.forEach((part) => renderQueue.add(part));
      pausedRenderQueue.length = 0;
      announcement = "라이브 화면 다시 시작";
      renderQueue.add("announcement");
      scheduleRender("all");
    }
  });

  document.addEventListener("visibilitychange", () => {
    hidden = document.hidden;
    document.body.classList.toggle("live-hidden", hidden);
    if (!hidden) scheduleRender("all", "sparks");
  });

  window.setInterval(() => {
    if (!paused && !hidden) scheduleRender("lanes", "stats", "sparks");
  }, 1000);

  document.body.classList.toggle("live-hidden", hidden);
  scheduleRender("all");
  if (new URLSearchParams(window.location.search).get("demo") === "1") startDemo();
  else {
    connect();
    fetchUsage(true);
    window.setInterval(() => fetchUsage(true), 60000);
  }
})();
