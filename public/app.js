// public/app.js
import { applyBidi } from "/bidi.js";

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
 * small hand-rolled DOM pass, not a substitute for one -- it targets the
 * vectors that actually execute when HTML is assigned via innerHTML:
 *   - <script> elements are inert once parsed via innerHTML per the HTML spec
 *     (verified), but are still stripped for cleanliness/defense in depth.
 *   - event-handler attributes (onerror, onload, onclick, ...) DO fire once
 *     in the DOM (e.g. onerror on a broken <img>) -- stripped from every element.
 *   - <iframe src="javascript:...">, <object>, <embed> can execute or load
 *     content on insertion with no user interaction -- the elements are removed
 *     outright, there is no legitimate use of them in a chat transcript.
 *   - <a href="javascript:...">/<img src="javascript:...">) -- scheme-checked
 *     and stripped.
 * This is best-effort, not exhaustive; if the no-dependency constraint is ever
 * relaxed, swap this for DOMPurify.
 */
const UNSAFE_ELEMENTS = "script, style, iframe, object, embed, link, meta, base, form";
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data|file):/i;

/** True if `raw` resolves to a script-executing URL scheme once whitespace
 *  (a common obfuscation, e.g. "java\tscript:") is stripped -- browsers ignore
 *  embedded whitespace when parsing a URL scheme, so a naive regex on the raw
 *  string would miss that bypass. */
function isDangerousUrl(raw) {
  return DANGEROUS_SCHEME.test(String(raw ?? "").replace(/\s+/g, ""));
}

function sanitize(root) {
  for (const el of root.querySelectorAll(UNSAFE_ELEMENTS)) el.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.hasAttribute("href") && isDangerousUrl(el.getAttribute("href"))) {
      el.removeAttribute("href");
    }
    if (el.hasAttribute("src") && isDangerousUrl(el.getAttribute("src"))) {
      el.removeAttribute("src");
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

function toolNode(block, key) {
  const d = document.createElement("details");
  d.className = "tool";
  d.dataset.key = key;
  const summary = document.createElement("summary");
  summary.textContent = `${block.name}${block.summary ? " · " + block.summary : ""}`;
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

function turnNode(turn) {
  const section = document.createElement("section");
  section.className = "turn";
  section.id = `turn-${turn.index}`;

  if (turn.userText) {
    const u = document.createElement("div");
    u.className = "user";
    u.setAttribute("dir", "auto"); // rule 1, for the non-markdown user block
    u.textContent = turn.userText;
    section.append(u);
  }

  // No thinking rendering: verified thinking content is never persisted (all
  // 3817 blocks in the corpus are "" with only an encrypted signature) --
  // transcript.ts's own parser never even pushes a "thinking" block for
  // real data, since `if (b.thinking)` is false for an empty string.
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
  return section;
}

const atBottom = () =>
  window.innerHeight + window.scrollY >= document.body.offsetHeight - 120;

async function renderIndex() {
  const sessions = await (await fetch("/api/sessions")).json();
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  app.replaceChildren();
  for (const [project, list] of byProject) {
    const h = document.createElement("h2");
    h.textContent = project;
    h.setAttribute("dir", "auto");
    app.append(h);
    for (const s of list) {
      const a = document.createElement("a");
      a.className = "session-row";
      a.href = `/s/${s.id}`;
      const title = document.createElement("div");
      title.setAttribute("dir", "auto");
      title.textContent = s.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.setAttribute("dir", "auto");
      meta.textContent = `${s.turnCount} turns · ${new Date(s.mtimeMs).toLocaleString()}`;
      a.append(title, meta);
      app.append(a);
    }
  }
}

let currentSession = null;
// True once the reader has clicked "load earlier turns" for the currently
// open thread -- see the SSE handler below for why this matters.
let pagedBack = false;

async function renderThread(id) {
  currentSession = id;
  pagedBack = false;
  const data = await (await fetch(`/api/session/${encodeURIComponent(id)}`)).json();
  if (data.error) {
    app.textContent = "session not found";
    return;
  }
  const h = document.createElement("h1");
  h.setAttribute("dir", "auto");
  h.textContent = data.meta.title;
  const sub = document.createElement("div");
  sub.className = "muted";
  sub.setAttribute("dir", "auto"); // rule 1: project names are file paths but can embed non-Latin text
  sub.textContent = data.meta.project;
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
    meta.setAttribute("dir", "auto");
    meta.textContent = `${hit.project} · ${hit.title} · turn ${hit.turn}`;
    const snip = document.createElement("div");
    snip.setAttribute("dir", "auto"); // rule 1 applies to snippets too
    // matchStart/matchEnd are UTF-16 offsets computed server-side (search.ts)
    // with an explicit guard against landing inside a surrogate pair, so
    // slicing here can't split one -- verified against search.test.ts.
    snip.append(
      document.createTextNode(hit.snippet.slice(0, hit.matchStart))
    );
    const mark = document.createElement("mark");
    mark.textContent = hit.snippet.slice(hit.matchStart, hit.matchEnd);
    snip.append(mark, document.createTextNode(hit.snippet.slice(hit.matchEnd)));
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
    row.className = "session-row";
    row.href = a.href;
    row.innerHTML = `<div dir="auto">${esc(a.name)}</div>
      <div class="meta" dir="auto">${esc(a.project)} · ${new Date(a.mtimeMs).toLocaleString()}</div>`;
    app.append(row);
  }
}

function route() {
  const p = location.pathname;
  if (p.startsWith("/s/")) return renderThread(decodeURIComponent(p.slice(3)));
  if (p === "/search") return renderSearch();
  if (p === "/artifacts") return renderArtifacts();
  return renderIndex();
}

// Intercept internal links so navigation does not reload the page.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a");
  if (!a || a.target || !a.href.startsWith(location.origin)) return;
  if (a.pathname.startsWith("/artifact/")) return; // real navigation to the file
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  route();
});
window.addEventListener("popstate", route);

// Live updates. Re-render only when the change concerns the open session.
//
// A naive "always renderThread()" here has two real costs, both from tearing
// down and rebuilding the entire turn list on every event:
//   - a reader who has scrolled up to reread history gets silently yanked:
//     their scroll position and any expanded <details> for a tool call
//     vanish into a freshly rebuilt DOM.
//   - a reader who clicked "load earlier turns" loses that extra history:
//     renderThread() always re-fetches just the last-50-turns window, with
//     no memory of how far back they had paged.
// Neither is acceptable for the primary use case (watching a live session
// while occasionally scrolling back to check something), so: skip the
// refresh entirely unless the reader is at the bottom AND hasn't paged back,
// and re-open whatever <details> were open before the rebuild.
new EventSource("/events").onmessage = async (e) => {
  const { sessionId } = JSON.parse(e.data);
  if (sessionId !== currentSession) return;
  if (pagedBack || !atBottom()) return;

  const openKeys = new Set(
    [...document.querySelectorAll(".tool[open]")].map((d) => d.dataset.key)
  );
  await renderThread(sessionId);
  for (const d of document.querySelectorAll(".tool")) {
    if (openKeys.has(d.dataset.key)) d.open = true;
  }
  window.scrollTo(0, document.body.scrollHeight);
};

route();
