// public/app.js
import { applyBidi, setBlockDir } from "/bidi.js";

const app = document.getElementById("app");
const TOOL_LIMIT = 4096; // spec: truncate tool output; largest observed is 46KB

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/**
 * marked.parse() is fed straight into innerHTML below, and transcript text is
 * not trusted input: it is the user's own data, but it can contain text
 * quoted *from elsewhere* (fetched web pages, tool/command output, a pasted
 * error log) that a prompt injection could shape into an XSS payload —
 * verified marked v15 passes raw HTML straight through unchanged (`<script>`
 * and `<img onerror=...>` both survive `marked.parse()` byte for byte), and
 * does not vet link/image URL schemes either (`javascript:` URLs pass
 * through both `[text](url)` and `![alt](url)`).
 *
 * The server binds to 127.0.0.1 only and this is a single-user local reading
 * tool, which caps the blast radius (no other user can reach this page), but
 * "low severity" is not "no severity": an injected payload could still fetch()
 * out to an attacker-controlled host from the browser and exfiltrate other
 * sessions' content, which is worse than the injection itself. A zero-dependency
 * constraint rules out pulling in a real sanitizer (DOMPurify), so this is a
 * small hand-rolled DOM pass, not a substitute for one. It is a pragmatic
 * denylist against the vectors known to matter for this corpus -- not an
 * exhaustive allowlist-based sanitizer, and it should not be read as covering
 * every possible HTML injection vector:
 *   - <script> elements are inert once parsed via innerHTML per the HTML spec
 *     (verified), but are still stripped for cleanliness/defense in depth.
 *   - event-handler attributes (onerror, onload, onclick, ...) DO fire once
 *     in the DOM (e.g. onerror on a broken <img>) -- stripped from every element.
 *   - <iframe src="javascript:...">, <object>, <embed> can execute or load
 *     content on insertion with no user interaction -- the elements are removed
 *     outright, there is no legitimate use of them in a chat transcript.
 *   - URL-bearing attributes (href, xlink:href on SVG <a>, formaction on
 *     <button>, poster on <video>, and src on everything except <img>) are
 *     scheme-checked and stripped of javascript:/vbscript:/data:/file:.
 *   - src on <img> gets one narrow exception: data:image/* (excluding
 *     data:image/svg+xml, which can carry an <svg onload=...> payload) is
 *     permitted, because a data: URI loaded as an image source cannot execute
 *     script -- only a *navigable* context (href, iframe) is dangerous -- and
 *     the corpus has 88 real pasted screenshots rendered exactly this way.
 * This is best-effort, not exhaustive; if the no-dependency constraint is ever
 * relaxed, swap this for DOMPurify.
 */
const UNSAFE_ELEMENTS = "script, style, iframe, object, embed, link, meta, base, form";
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data|file):/i;
// Attributes other than `src` that can carry a navigable/executable URL.
// xlink:href is namespaced -- el.hasAttribute("href") does not match an SVG
// <a xlink:href="..."> at all, so it needs its own check.
const URL_ATTRS = ["href", "xlink:href", "formaction", "poster"];
// data:image/<type>[;params], excluding svg+xml (can embed <script>/onload).
const SAFE_IMG_DATA_URL = /^data:image\/(?!svg\+xml\b)[^;,]+[;,]/i;

/** True if `raw` resolves to a script-executing URL scheme once whitespace
 *  (a common obfuscation, e.g. "java\tscript:") is stripped -- browsers ignore
 *  embedded whitespace when parsing a URL scheme, so a naive regex on the raw
 *  string would miss that bypass. */
function isDangerousUrl(raw) {
  return DANGEROUS_SCHEME.test(String(raw ?? "").replace(/\s+/g, ""));
}

/** True if `raw` is a data: URI for a (non-SVG) raster image -- safe as an
 *  <img src>, since it cannot execute script, only display a bitmap. */
function isSafeImgDataUrl(raw) {
  return SAFE_IMG_DATA_URL.test(String(raw ?? "").replace(/\s+/g, ""));
}

function sanitize(root) {
  for (const el of root.querySelectorAll(UNSAFE_ELEMENTS)) el.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    for (const name of URL_ATTRS) {
      if (el.hasAttribute(name) && isDangerousUrl(el.getAttribute(name))) {
        el.removeAttribute(name);
      }
    }
    if (el.hasAttribute("src")) {
      const src = el.getAttribute("src");
      const imgDataException = el.tagName === "IMG" && isSafeImgDataUrl(src);
      if (!imgDataException && isDangerousUrl(src)) el.removeAttribute("src");
    }
  }
}

/** Markdown -> HTML, sanitized, then the six bidi rules. Every render path
 *  that shows markdown-formatted text goes through here. */
function md(text) {
  const div = document.createElement("div");
  div.innerHTML = marked.parse(text ?? "", { breaks: true });
  sanitize(div);
  applyBidi(div);
  return div;
}

/** Truncate without splitting a trailing UTF-16 surrogate pair (same guard
 *  search.ts applies server-side to snippet boundaries). */
function safeSlice(s, n) {
  if (n < s.length && s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff) n -= 1;
  return s.slice(0, n);
}

/** A button that copies `getText()` and reports the outcome in its own label.
 *  navigator.clipboard needs a secure context; 127.0.0.1 is one (the server
 *  binds nowhere else), so the catch covers permission denial, not http://. */
function copyButton(label, getText) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "copy-btn";
  b.setAttribute("dir", "ltr");
  b.textContent = label;
  let reset;
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.dataset.state = "ok";
      b.textContent = "copied";
    } catch {
      b.dataset.state = "err";
      b.textContent = "copy failed";
    }
    clearTimeout(reset); // repeat clicks must not race each other's restore
    reset = setTimeout(() => {
      delete b.dataset.state;
      b.textContent = label;
    }, 1400);
  };
  return b;
}

function toolNode(block, key) {
  const d = document.createElement("details");
  d.className = "tool";
  d.dataset.key = key;
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = block.name;
  summary.append(name);
  if (block.summary) {
    const sum = document.createElement("span");
    sum.className = "tool-sum";
    sum.textContent = block.summary;
    // dir="auto" (first-strong), deliberately NOT the Rule 1 ratio: a summary is
    // an English label that often quotes an Arabic literal ("Filter the وصل
    // أمانة hits"). At ~40% Arabic the ratio flips it to rtl and the label reads
    // back to front. First-strong keeps the label's own direction.
    sum.setAttribute("dir", "auto");
    summary.append(sum);
  }
  d.append(summary);

  const body = document.createElement("div");
  body.className = "body";

  const input = document.createElement("pre");
  input.setAttribute("dir", "ltr");
  input.textContent = JSON.stringify(block.input, null, 2);
  body.append(input);

  if (block.result != null) {
    const full = String(block.result);
    const out = document.createElement("pre");
    out.setAttribute("dir", "ltr");
    out.textContent = safeSlice(full, TOOL_LIMIT);
    body.append(out);
    if (full.length > TOOL_LIMIT) {
      const more = document.createElement("button");
      more.className = "show-more";
      more.textContent = `show all ${full.length.toLocaleString()} chars`;
      more.onclick = () => {
        out.textContent = full;
        more.remove();
      };
      body.append(more);
    }
  }
  d.append(body);
  return d;
}

/** "TURN 12 · 14:03", linked to its own anchor so a turn can be cited. */
function turnMetaNode(turn) {
  const meta = document.createElement("div");
  meta.className = "turn-meta";
  meta.setAttribute("dir", "ltr"); // a number and a clock time, never RTL
  const link = document.createElement("a");
  link.href = `#turn-${turn.index}`;
  link.textContent = `turn ${turn.index}`;
  meta.append(link);
  if (turn.timestamp) {
    const when = new Date(turn.timestamp);
    if (!Number.isNaN(when.valueOf())) {
      meta.append(
        ` · ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      );
    }
  }
  return meta;
}

function turnNode(turn) {
  const section = document.createElement("section");
  section.className = "turn";
  section.id = `turn-${turn.index}`;
  section.append(turnMetaNode(turn));

  if (turn.userText) {
    const u = document.createElement("div");
    u.className = "user";
    u.textContent = turn.userText;
    setBlockDir(u); // rule 1, for the non-markdown user block
    section.append(u);
  }

  // No thinking rendering: verified thinking content is never persisted (a
  // direct scan of the corpus found 3,968 thinking blocks, all "" with only
  // an encrypted signature -- re-measured 2026-07-20; the corpus grows, so
  // treat the exact figure as indicative, not exact) -- transcript.ts's own
  // parser never even pushes a "thinking" block for real data, since
  // `if (b.thinking)` is false for an empty string.
  turn.blocks.forEach((b, i) => {
    if (b.kind === "text") section.append(md(b.text));
    else if (b.kind === "tool") section.append(toolNode(b, `${turn.index}-${i}`));
    else if (b.kind === "image") {
      const p = document.createElement("div");
      p.className = "placeholder";
      p.textContent = "[image]";
      section.append(p);
    } else if (b.kind === "unknown") {
      const p = document.createElement("div");
      p.className = "placeholder";
      p.textContent = `unrendered entry type: ${b.entryType}`;
      section.append(p);
    }
  });

  // Copy the response as the markdown it was written in, not as rendered text:
  // the usual destination is another editor or a message box. Tool calls and
  // their output are excluded -- they are the machinery, not the answer.
  const responseText = turn.blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n");
  if (responseText) {
    const actions = document.createElement("div");
    actions.className = "turn-actions";
    actions.append(copyButton("copy response", () => responseText));
    section.append(actions);
  }
  return section;
}

const atBottom = () =>
  window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;

function sessionRow(s) {
  const a = document.createElement("a");
  a.className = "session-row";
  a.href = `/s/${s.id}`;
  const title = document.createElement("div");
  title.textContent = s.title;
  setBlockDir(title);
  // The row is one block: its meta line aligns with its title rather than
  // resolving its own direction, or an Arabic row reads right-then-left.
  a.setAttribute("dir", title.getAttribute("dir"));
  const meta = document.createElement("div");
  meta.className = "meta";
  // Always LTR: a count and a date are Latin/numeric, and inside an RTL row
  // base-RTL ordering throws the leading count to the far end ("turns · … 5").
  // CSS re-aligns it to the row's edge without touching that order.
  meta.setAttribute("dir", "ltr");
  meta.textContent =
    `${s.provider === "codex" ? "Codex" : "Claude"} · ` +
    `${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} · ` +
    new Date(s.activityMs).toLocaleString();
  a.append(title, meta);
  return a;
}

function groupHeading(text) {
  const h = document.createElement("h2");
  h.className = "group";
  h.textContent = text;
  setBlockDir(h);
  return h;
}

/** Sentinel for "no project filter"; not a real projectPath, so it can never
 *  collide with one. */
const ALL_PROJECTS = "*";

/** One entry in the project rail. The path is split so the directory reads
 *  quietly and the project name carries the weight. */
function projectLink(projectPath, label, count, isActive) {
  // "all" needs its own URL: a bare "/" carries no project param and would fall
  // straight back into the default-to-newest-project rule below.
  const a = document.createElement("a");
  a.href = `/?project=${encodeURIComponent(projectPath)}`;
  a.title = label; // the rail truncates long paths; hover gives the whole one
  a.classList.toggle("active", isActive);
  if (isActive) a.setAttribute("aria-current", "true");
  const cut = label.lastIndexOf("/");
  if (cut > 0) {
    const dir = document.createElement("span");
    dir.className = "p-dir";
    dir.textContent = label.slice(0, cut + 1);
    a.append(dir);
  }
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = cut > 0 ? label.slice(cut + 1) : label;
  a.append(name);
  const n = document.createElement("span");
  n.className = "count";
  n.setAttribute("dir", "ltr");
  n.textContent = String(count);
  a.append(n);
  setBlockDir(a); // a project path can embed non-Latin directory names
  return a;
}

// /api/sessions parses every transcript on the machine -- measured at ~720ms
// for 225 sessions here -- so re-fetching it just to change the project filter
// put a dead pause on every click. The payload is cached and redrawn instantly;
// a background revalidate replaces it only if it actually changed.
let sessionsCache = null;
let revalidating = false;

async function renderIndex() {
  if (sessionsCache) {
    drawIndex(sessionsCache);
    revalidateSessions();
    return;
  }
  sessionsCache = await (await fetch("/api/sessions")).json();
  drawIndex(sessionsCache);
}

async function revalidateSessions() {
  if (revalidating) return;
  revalidating = true;
  try {
    const fresh = await (await fetch("/api/sessions")).json();
    if (JSON.stringify(fresh) === JSON.stringify(sessionsCache)) return;
    sessionsCache = fresh;
    // The reader may have navigated away during the fetch; only redraw an index
    // that is still on screen.
    if (location.pathname === "/") drawIndex(fresh);
  } finally {
    revalidating = false;
  }
}

// Sessions are grouped under a project rail rather than one flat scroll: a
// machine with dozens of projects makes a flat list unnavigable. The selection
// lives in the URL (?project=...) so it survives back/forward and can be shared.
function drawIndex(sessions) {
  // Insertion order is the API's order, which is newest-activity-first: the
  // rail therefore lists the projects you touched most recently at the top.
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.projectPath)) {
      byProject.set(s.projectPath, { label: s.project, list: [] });
    }
    byProject.get(s.projectPath).list.push(s);
  }
  const groups = [...byProject.entries()];

  const wanted = new URLSearchParams(location.search).get("project");
  // Default to the most recently active project rather than to everything:
  // showing all of it is the scroll problem this rail exists to remove.
  const active =
    wanted === ALL_PROJECTS || byProject.has(wanted)
      ? wanted
      : groups[0]?.[0] ?? ALL_PROJECTS;

  const layout = document.createElement("div");
  layout.className = "index-layout";

  const rail = document.createElement("aside");
  rail.className = "projects";
  rail.setAttribute("aria-label", "projects");
  rail.append(
    projectLink(ALL_PROJECTS, "all sessions", sessions.length, active === ALL_PROJECTS)
  );
  for (const [path, g] of groups) {
    rail.append(projectLink(path, g.label, g.list.length, path === active));
  }

  const pane = document.createElement("div");
  pane.className = "sessions-pane";
  if (active === ALL_PROJECTS) {
    for (const [, g] of groups) {
      pane.append(groupHeading(g.label));
      for (const s of g.list) pane.append(sessionRow(s));
    }
  } else {
    const g = byProject.get(active);
    pane.append(groupHeading(g.label));
    for (const s of g.list) pane.append(sessionRow(s));
  }

  layout.append(rail, pane);
  app.replaceChildren(layout);
}

let currentSession = null;
// True once the reader has clicked "load earlier turns" for the currently
// open thread -- see the SSE handler below for why this matters.
let pagedBack = false;
// mtime of the session as of the last render, so a tab returning from hidden
// can tell "something changed while I wasn't listening" from "nothing did".
// Last activity *inside* the transcript, not the file's mtime: an idle session
// still open in a `claude` process gets its file rewritten periodically, and
// comparing mtimes made every one of those look like new activity.
let lastActivityMs = 0;

async function renderThread(id) {
  currentSession = id;
  pagedBack = false;
  hidePendingIndicator();
  const data = await (await fetch(`/api/session/${encodeURIComponent(id)}`)).json();
  if (data.error) {
    app.textContent = "session not found";
    return;
  }
  lastActivityMs = data.meta.activityMs;
  const h = document.createElement("h1");
  h.textContent = data.meta.title;
  setBlockDir(h);
  const sub = document.createElement("div");
  sub.className = "muted path";
  sub.textContent = `${data.meta.project} · ${data.meta.provider === "codex" ? "Codex" : "Claude"}`;
  setBlockDir(sub); // rule 1: project names are file paths but can embed non-Latin text
  app.replaceChildren(h, sub);

  if (data.hasMore) {
    const more = document.createElement("button");
    more.className = "show-more";
    more.textContent = "load earlier turns";
    more.onclick = async () => {
      pagedBack = true;
      const first = data.turns[0].index;
      const older = await (
        await fetch(`/api/session/${encodeURIComponent(id)}?before=${first}`)
      ).json();
      const anchor = more.nextSibling;
      for (const t of older.turns) app.insertBefore(turnNode(t), anchor);
      if (!older.hasMore) more.remove();
      data.turns = older.turns.concat(data.turns);
    };
    app.append(more);
  }

  for (const t of data.turns) app.append(turnNode(t));

  if (location.hash) {
    document.querySelector(location.hash)?.scrollIntoView();
  } else {
    window.scrollTo(0, document.body.scrollHeight);
  }
}

async function renderSearch() {
  const q = new URLSearchParams(location.search).get("q") ?? "";
  const box = document.createElement("input");
  box.type = "search";
  box.value = q;
  box.placeholder = "search all sessions — يعمل بالعربية أيضا";
  box.setAttribute("dir", "auto");
  box.onkeydown = (e) => {
    if (e.key === "Enter") {
      history.pushState({}, "", `/search?q=${encodeURIComponent(box.value)}`);
      route();
    }
  };
  app.replaceChildren(box);
  box.focus();
  if (!q) return;

  const hits = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  const count = document.createElement("p");
  count.setAttribute("dir", "auto");
  count.className = "muted";
  count.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}`;
  app.append(count);

  for (const hit of hits) {
    const a = document.createElement("a");
    a.className = "session-row";
    a.href = `/s/${hit.sessionId}#turn-${hit.turn}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${hit.project} · ${hit.title} · turn ${hit.turn}`;
    setBlockDir(meta);
    const snip = document.createElement("div");
    // matchStart/matchEnd are UTF-16 offsets computed server-side (search.ts)
    // with an explicit guard against landing inside a surrogate pair, so
    // slicing here can't split one -- verified against search.test.ts.
    snip.append(
      document.createTextNode(hit.snippet.slice(0, hit.matchStart))
    );
    const mark = document.createElement("mark");
    mark.textContent = hit.snippet.slice(hit.matchStart, hit.matchEnd);
    snip.append(mark, document.createTextNode(hit.snippet.slice(hit.matchEnd)));
    setBlockDir(snip); // rule 1 applies to snippets too -- after the text is in
    a.append(meta, snip);
    app.append(a);
  }
}

async function renderArtifacts() {
  const items = await (await fetch("/api/artifacts")).json();
  app.replaceChildren();
  if (!items.length) {
    app.innerHTML = `<p class="muted">No artifacts yet. Ask Claude to make one.</p>`;
    return;
  }
  for (const a of items) {
    const row = document.createElement("a");
    row.className = "session-row artifact";
    row.href = a.href;
    row.innerHTML = `<div dir="auto">${esc(a.name)}</div>
      <div class="meta" dir="auto">${esc(a.project)} · ${new Date(a.mtimeMs).toLocaleString()}</div>`;
    app.append(row);
  }
}

/** Mark the nav entry the current page belongs to. A thread belongs to
 *  "sessions", which is where the reader arrived from. */
function markActiveNav() {
  const p = location.pathname;
  const current = p === "/search" || p === "/artifacts" ? p : "/";
  for (const a of document.querySelectorAll("header.top nav a")) {
    a.classList.toggle("active", a.getAttribute("href") === current);
  }
}

function route() {
  markActiveNav();
  const p = location.pathname;
  // Only the index carries a side rail, and only it needs the wider column.
  app.classList.toggle("wide", p === "/");
  if (p.startsWith("/s/")) return renderThread(decodeURIComponent(p.slice(3)));
  // Leaving the thread view entirely: no open session left to receive live
  // updates for, so drop any stale pending-update state along with it.
  currentSession = null;
  hidePendingIndicator();
  if (p === "/search") return renderSearch();
  if (p === "/artifacts") return renderArtifacts();
  return renderIndex();
}

// Intercept internal links so navigation does not reload the page.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a");
  if (!a || a.target || !a.href.startsWith(location.origin)) return;
  if (a.pathname.startsWith("/artifact/")) return; // real navigation to the file
  // Same-page anchors (turn markers) must not be routed: pushState-ing "#turn-3"
  // and re-rendering would tear down the very turn being jumped to.
  if (a.getAttribute("href")?.startsWith("#")) return;
  // /live is a server-side redirect to the newest session. Routing it client
  // side just re-rendered the index under a /live URL, so the link never worked.
  if (a.pathname === "/live") return;
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  route();
});
window.addEventListener("popstate", route);

// Live updates. Re-render only when the change concerns the open session.
//
// renderThread() rebuilds the whole turn list from the last-50-turns window,
// which costs a reader their scroll position, their expanded <details>, and
// any history they paged back to. So refresh immediately only when they are
// at the bottom AND haven't paged back.
//
// A suppressed event must not be *discarded* — that drops live updates with
// no way back short of a reload. It instead raises a "new activity" pill,
// cleared by scrolling to the bottom (same !pagedBack gate) or by clicking
// it, which always refreshes: an explicit click is a fair moment to also
// give up paged-back history.
const updatePill = document.createElement("button");
updatePill.id = "update-pill";
updatePill.type = "button";
updatePill.hidden = true;
document.body.append(updatePill);

let pendingUpdateCount = 0;

function showPendingIndicator() {
  pendingUpdateCount += 1;
  updatePill.textContent =
    pendingUpdateCount === 1 ? "new activity ↓" : `${pendingUpdateCount} new updates ↓`;
  updatePill.hidden = false;
}

function hidePendingIndicator() {
  pendingUpdateCount = 0;
  updatePill.hidden = true;
}

async function refreshLiveThread(sessionId) {
  const openKeys = new Set(
    [...document.querySelectorAll(".tool[open]")].map((d) => d.dataset.key)
  );
  await renderThread(sessionId); // also clears pendingUpdateCount/hides the pill
  for (const d of document.querySelectorAll(".tool")) {
    if (openKeys.has(d.dataset.key)) d.open = true;
  }
  window.scrollTo(0, document.body.scrollHeight);
}

updatePill.onclick = () => {
  if (currentSession) refreshLiveThread(currentSession);
};

window.addEventListener("scroll", () => {
  if (pendingUpdateCount > 0 && !pagedBack && currentSession && atBottom()) {
    refreshLiveThread(currentSession);
  }
});

function onLiveEvent(e) {
  const { sessionId } = JSON.parse(e.data);
  if (sessionId !== currentSession) return;
  if (pagedBack || !atBottom()) {
    showPendingIndicator();
    return;
  }
  refreshLiveThread(sessionId);
}

// One EventSource holds a TCP connection open for as long as it is alive, and
// browsers cap HTTP/1.1 at six connections per origin. Opening it once at
// module scope therefore meant six open tabs consumed the entire budget and
// every later request to this origin -- including the navigation that loads a
// seventh tab -- queued forever with no error and no timeout: the page simply
// hung. So the stream is scoped to visibility instead. A hidden tab renders
// nothing, so it has no use for the socket it is holding.
//
// This only became reachable once the SSE heartbeat landed: before it, Bun's
// 10s idleTimeout tore down each idle stream and released its socket, so the
// budget drained on its own every 10s. Keeping streams alive fixed lost
// updates and turned that self-draining leak into permanent occupancy.
let liveStream = null;

function openLiveStream() {
  if (liveStream) return; // visibilitychange can fire repeatedly
  liveStream = new EventSource("/events");
  liveStream.onmessage = onLiveEvent;
}

function closeLiveStream() {
  liveStream?.close();
  liveStream = null;
}

// Changes that land while the stream is closed are broadcast to nobody, which
// is exactly the lost-update failure the heartbeat exists to prevent -- so a
// tab coming back re-syncs rather than waiting for the next event, which for a
// session that has since gone quiet would never arrive. The refresh is gated
// on the same paged-back/at-bottom rules as the live path, so returning to a
// tab never yanks a reader who had scrolled back.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    closeLiveStream();
    return;
  }
  openLiveStream();
  if (!currentSession) return;
  if (!pagedBack && atBottom()) {
    refreshLiveThread(currentSession);
    return;
  }
  // Scrolled back: raise the pill only if the session actually moved, or every
  // tab switch would cry "new activity" at a reader who has missed nothing.
  const seen = lastActivityMs;
  const meta = await (
    await fetch(`/api/session/${encodeURIComponent(currentSession)}`)
  ).json();
  if (!meta.error && meta.meta.activityMs > seen) showPendingIndicator();
});

if (!document.hidden) openLiveStream();

route();
