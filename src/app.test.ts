//
// Same constraint as bidi.test.ts: there is no DOM in Bun's test environment
// and jsdom would breach the zero-dependency rule, so these assert source
// contracts rather than behaviour. What they actually protect is the socket
// budget below -- a regression here is invisible until six tabs are open, so
// a textual guard beats no guard. Real behaviour is verified in a browser.
import { test, expect } from "bun:test";

const app = () => Bun.file("public/app.js").text();

// Regression: an EventSource holds one TCP connection open for the life of
// the page, and browsers cap HTTP/1.1 at six connections per origin. A
// module-scope `new EventSource(...)` therefore means six open tabs exhaust
// the origin, and every later request -- including a fresh page load -- queues
// forever with no error. Verified empirically: with six streams open a
// fetch() to the same origin made zero progress in 5s, and completed in
// 758ms the moment they were closed.
test("app.js does not open the live stream unconditionally at module scope", async () => {
  const src = await app();
  expect(src).not.toMatch(/^\s*new EventSource\(/m);
});

test("app.js closes the live stream when the tab is hidden", async () => {
  const src = await app();
  expect(src).toContain("visibilitychange");
  expect(src).toContain("document.hidden");
  expect(src).toMatch(/liveStream\?\.close\(\)|liveStream\.close\(\)/);
});

// Dropping the stream is only safe if the tab re-syncs on the way back:
// changes that land while it is closed are broadcast to nobody, exactly the
// lost-update failure the SSE heartbeat exists to prevent.
test("app.js reopens the stream and re-syncs when the tab becomes visible", async () => {
  const src = await app();
  expect(src).toMatch(/openLiveStream\(\)/);
  // activityMs, not mtimeMs: an idle session still open in a `claude` process
  // has its file rewritten periodically, so an mtime comparison raised the
  // "new activity" pill for readers who had missed nothing.
  expect(src).toContain("activityMs");
});

// The reader-protection rules the live path already follows must survive the
// visibility path too, or returning to a tab yanks a scrolled-back reader.
test("the visibility re-sync respects the paged-back / at-bottom gate", async () => {
  const src = await app();
  const handler = src.slice(src.indexOf("visibilitychange"));
  expect(handler).toContain("pagedBack");
  expect(handler).toContain("atBottom()");
});

// The copy button exists to move a response into an editor, so it must copy the
// source markdown of the text blocks -- not innerText of the rendered DOM, and
// not the tool calls interleaved with them.
test("the response copy button copies markdown text blocks only", async () => {
  const src = await app();
  expect(src).toContain("navigator.clipboard.writeText");
  const turn = src.slice(src.indexOf("function turnNode"), src.indexOf("const atBottom"));
  expect(turn).toMatch(/kind === "text"/);
  expect(turn).not.toContain("innerText");
});

// /api/sessions parses every transcript on disk (measured ~720ms for 225
// sessions), so refetching it to switch the project filter puts that pause on
// every click of the rail. Drawing must run off the cache.
test("the index draws from a cached session list, not a fetch per filter", async () => {
  const src = await app();
  expect(src).toContain("sessionsCache");
  const draw = src.slice(src.indexOf("function drawIndex"), src.indexOf("let currentSession"));
  expect(draw).not.toContain("fetch(");
});

// The selected project belongs in the URL, or back/forward and a shared link
// both land on whatever the default happens to be.
test("the project rail keeps its selection in the URL", async () => {
  const src = await app();
  expect(src).toContain("?project=");
  expect(src).toMatch(/URLSearchParams\(location\.search\)\.get\("project"\)/);
});

// Same-page anchors and /live must fall through to the browser: routing either
// one re-renders the page instead of doing what the link says.
test("the link interceptor lets hash anchors and /live through", async () => {
  const src = await app();
  const handler = src.slice(src.indexOf('addEventListener("click"'));
  expect(handler).toContain('startsWith("#")');
  expect(handler).toContain('a.pathname === "/live"');
});
