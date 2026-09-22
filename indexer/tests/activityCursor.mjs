// activityCursor.mjs — 프로세스별 SSE cursor와 search.done authoritative stats 검증.
import assert from "node:assert/strict";

const moduleUrl = new URL("../dist/activity.js", import.meta.url);
const activityA = await import(`${moduleUrl.href}?process=a-${Date.now()}`);
const cursorA = activityA.getActivityCursor();
assert.equal(cursorA.seq, 0);

let published;
const unsubscribe = activityA.subscribeActivity((event) => { published = event; });
activityA.emitActivity({
  type: "search.start", id: "cursor-test", client: "test", query: "cursor",
  workspaces: [], mode: "fts", topN: 1,
});
activityA.emitActivity({
  type: "search.done", id: "cursor-test", client: "test", hits: 0, ms: 3,
  cached: false, mode: "fts", warnings: 0, approxTokens: 0,
});
unsubscribe();

assert.equal(published.type, "search.done");
assert.deepEqual(published.stats, activityA.getStats());
assert.equal(activityA.getActivityCursor().seq, 2);
assert.equal(activityA.getActivityCursor().streamId, cursorA.streamId);

// 200건을 넘으면 평균은 최근 200건만 사용하며 이미 발행한 통계는 바뀌지 않는다.
for (let i = 0; i < 200; i += 1) {
  activityA.emitActivity({
    type: "search.done", id: `latency-${i}`, client: "test", hits: 0, ms: 20,
    cached: false, mode: "fts", warnings: 0, approxTokens: 0,
  });
}
assert.equal(activityA.getStats().total, 201);
assert.equal(activityA.getStats().avgMs, 20);
assert.equal(activityA.getRecentEvents().at(-1).stats.avgMs, 20);
assert.equal(published.stats.total, 1);
assert.equal(published.stats.byClient.test.count, 1);

const activityB = await import(`${moduleUrl.href}?process=b-${Date.now()}`);
const cursorB = activityB.getActivityCursor();
assert.equal(cursorB.seq, 0);
assert.notEqual(cursorB.streamId, cursorA.streamId);

console.log("[activityCursor] stream reset and authoritative search.done stats passed");
