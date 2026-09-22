const HOST = "https://91crdj.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CATEGORIES = [
  { name: "成人短剧", tid: "duanju",    source: "api",  scope: "category", key: "duanju",        pages: 3 },
  { name: "成人漫剧", tid: "manju",     source: "api",  scope: "category", key: "dongman-sm",    pages: 3 },
  { name: "真人剧",   tid: "zhenrenju", source: "api",  scope: "category", key: "zhibo-huifang", pages: 3 },
  { name: "成人视频", tid: "shipin",    source: "api",  scope: "category", key: "videos",        pages: 3 },
  { name: "热播榜",   tid: "paihang",   source: "html", scope: "",         key: "",              pages: 3 },
];

const SUBREQUEST_BUDGET = 45;
const CHANNEL_TTL = 600;
const FETCH_TIMEOUT = 20000;
const CARD_SLICE = 4000;

const HAS_CACHE = (() => {
  try { return typeof caches !== "undefined" && !!caches.default; } catch (e) { return false; }
})();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/live.m3u" || path === "/m3u") return await handleM3uList(url);
      if (path === "/play") return await handlePlayRedirect(url);
      if (path === "/debug") return await handleDebug(url);
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      return helpPage(url);
    } catch (err) {
      console.error("worker error:", err && err.stack ? err.stack : String(err));
      return new Response("Worker error: " + (err && err.message ? err.message : String(err)) + "\n",
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  }
};

function stripTags(t) {
  return String(t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function unescapeUrl(u) {
  return String(u || "").replace(/&amp;/g, "&").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

function attrValue(s) {
  return String(s == null ? "" : s).replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

function firstMatch(s, re) {
  const m = String(s || "").match(re);
  return m ? m[1] : "";
}

async function getEx(url, opts) {
  const ajax = !opts || opts.ajax !== false;
  const timeout = (opts && opts.timeout) || FETCH_TIMEOUT;
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const headers = { "User-Agent": UA, "Referer": HOST + "/" };
    if (ajax) headers["X-Requested-With"] = "fetch";
    const r = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    const text = r.ok ? await r.text() : "";
    return { ok: r.ok, status: r.status, bytes: text.length, text, ms: Date.now() - started, error: "" };
  } catch (e) {
    return { ok: false, status: 0, bytes: 0, text: "", ms: Date.now() - started,
             error: (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url, opts) {
  return (await getEx(url, opts)).text;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let k = 0; k < n; k++) {
    runners.push((async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

async function cacheGetText(keyUrl) {
  if (!HAS_CACHE) return null;
  try {
    const hit = await caches.default.match(new Request(keyUrl));
    if (!hit) return null;
    return await hit.text();
  } catch (e) {
    return null;
  }
}

async function cachePutText(keyUrl, body, ttl) {
  if (!HAS_CACHE) return;
  try {
    await caches.default.put(new Request(keyUrl), new Response(body, {
      headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8", "Cache-Control": "public, max-age=" + ttl }
    }));
  } catch (e) {
  }
}

function parseCards(html) {
  const out = [];
  if (!html) return out;
  const blocks = String(html).split('class="card"');
  for (let i = 1; i < blocks.length; i++) {
    const head = blocks[i].slice(0, CARD_SLICE);

    const href = firstMatch(head, /href="([^"]+)"/);
    if (!href) continue;
    const seg = href.split("?")[0].replace(/\/+$/, "").split("/");
    if (seg.length < 5) continue;

    const id = firstMatch(head, /data-track-item-id="(\d+)"/);
    if (!id) continue;

    const title = stripTags(firstMatch(head, /<h3[^>]*>([\s\S]*?)<\/h3>/)) ||
                  firstMatch(head, /data-track-item-name="([^"]*)"/) || id;

    const pic = firstMatch(head, /data-src="(https?:\/\/[^"]+)"/);
    const flag = stripTags(firstMatch(head, /class="eps-flag"[^>]*>([^<]*)</));
    const epStr = firstMatch(flag, /(\d+)\s*[集话章]/);
    const ep = epStr ? Math.max(1, parseInt(epStr, 10)) : 1;

    out.push({
      id,
      title,
      cover: pic ? unescapeUrl(pic) : "",
      ep: isNaN(ep) ? 1 : ep,
      route: seg[3]
    });
  }
  return out;
}

function pageCountOf(html) {
  const n = parseInt(firstMatch(html, /data-pages="(\d+)"/), 10);
  return Math.max(1, isNaN(n) ? 1 : n);
}

function apiUrl(cat, page, sort) {
  return HOST + "/api/list/fragment?scope=" + encodeURIComponent(cat.scope) +
    "&key=" + encodeURIComponent(cat.key) +
    "&sort=" + encodeURIComponent(sort) + "&page=" + page;
}

function htmlUrl(cat, page) {
  return page === 1 ? (HOST + "/" + cat.tid + "/")
    : (HOST + "/" + cat.tid + "/page/" + page + "/");
}

async function fetchCategory(cat, pages, sort, budget) {
  const info = { name: cat.name, tid: cat.tid, source: cat.source, status: 0, bytes: 0,
                 cards: 0, pages: 0, epSum: 0, fallback: "", error: "" };

  const useApiFirst = cat.source === "api";
  const primary = useApiFirst
    ? { url: (p) => apiUrl(cat, p, sort), ajax: true, tag: "api" }
    : { url: (p) => htmlUrl(cat, p), ajax: false, tag: "html" };
  const secondary = useApiFirst
    ? { url: (p) => htmlUrl(cat, p), ajax: false, tag: "html" }
    : { url: (p) => apiUrl(cat, p, sort), ajax: true, tag: "api" };

  if (budget.left <= 0) { info.error = "budget exhausted"; return { items: [], info }; }
  budget.left--;
  let first = await getEx(primary.url(1), { ajax: primary.ajax });
  info.status = first.status;
  info.bytes = first.bytes;
  info.error = first.error;
  let items = parseCards(first.text);
  let src = primary;

  if (!items.length && budget.left > 0) {
    budget.left--;
    const alt = await getEx(secondary.url(1), { ajax: secondary.ajax });
    const altItems = parseCards(alt.text);
    if (altItems.length) {
      info.fallback = secondary.tag;
      info.status = alt.status;
      info.bytes = alt.bytes;
      info.error = alt.error;
      first = alt;
      items = altItems;
      src = secondary;
    }
  }

  const want = Math.min(Math.max(1, pageCountOf(first.text)), Math.max(1, pages));
  const todo = [];
  for (let p = 2; p <= want; p++) {
    if (budget.left <= 0) break;
    budget.left--;
    todo.push(p);
  }
  if (todo.length) {
    const rest = await mapLimit(todo, 6, async (p) =>
      parseCards((await getEx(src.url(p), { ajax: src.ajax })).text));
    for (const part of rest) items = items.concat(part);
  }

  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    uniq.push(it);
  }

  info.cards = uniq.length;
  info.pages = want;
  info.epSum = uniq.reduce((a, b) => a + b.ep, 0);
  return { items: uniq, info };
}

async function buildChannels(cats, pages, sort) {
  const budget = { left: SUBREQUEST_BUDGET };
  const channels = [];
  const report = [];
  for (const cat of cats) {
    const use = pages > 0 ? pages : cat.pages;
    const { items, info } = await fetchCategory(cat, use, sort, budget);
    report.push(info);
    for (const it of items) {
      for (let ep = 1; ep <= it.ep; ep++) {
        channels.push({
          group: cat.name,
          tvgId: it.id + "_" + ep,
          name: it.title + " 第" + String(ep).padStart(2, "0") + "集",
          cover: it.cover,
          vid: it.id,
          ep
        });
      }
    }
  }
  return { channels, report, used: SUBREQUEST_BUDGET - budget.left };
}

function extinf(ch, playUrl) {
  const parts = ["#EXTINF:-1",
    'tvg-id="' + attrValue(ch.tvgId) + '"',
    'tvg-name="' + attrValue(ch.name) + '"'];
  if (ch.cover) parts.push('tvg-logo="' + attrValue(ch.cover) + '"');
  parts.push('group-title="' + attrValue(ch.group) + '"');
  return parts.join(" ") + "," + String(ch.name || "").replace(/[\r\n]+/g, " ") + "\n" + playUrl;
}

function renderPlaylist(channels, origin) {
  const lines = ["#EXTM3U"];
  for (const ch of channels) {
    lines.push(extinf(ch, origin + "/play?id=" + ch.vid + "&ep=" + ch.ep));
  }
  return lines.join("\n") + "\n";
}

function pickCategories(param) {
  if (!param) return CATEGORIES;
  const want = new Set(String(param).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const got = CATEGORIES.filter((c) => want.has(c.tid.toLowerCase()) || want.has(c.name));
  return got.length ? got : CATEGORIES;
}

async function handleM3uList(url) {
  const cats = pickCategories(url.searchParams.get("cats"));
  const raw = parseInt(url.searchParams.get("pages") || "", 10);
  const pages = isNaN(raw) ? 0 : Math.max(0, Math.min(raw, 60));
  const sort = url.searchParams.get("sort") === "hot" ? "hot" : "new";
  const refresh = url.searchParams.get("refresh") === "1";
  const origin = url.origin;

  const cacheKey = "https://91crdj-m3u.cache/playlist?origin=" + encodeURIComponent(origin) +
    "&cats=" + cats.map((c) => c.tid).join(",") + "&pages=" + pages + "&sort=" + sort;

  if (!refresh) {
    const cached = await cacheGetText(cacheKey);
    if (cached) return m3uResponse(cached, "HIT", null);
  }

  const started = Date.now();
  const { channels, report, used } = await buildChannels(cats, pages, sort);
  const ms = Date.now() - started;

  const okCats = report.filter((r) => r.cards > 0).length;
  const body = renderPlaylist(channels, origin);

  const healthy = channels.length > 0 && okCats === cats.length;
  if (healthy) await cachePutText(cacheKey, body, CHANNEL_TTL);
  if (!channels.length) console.error("build empty. report=" + JSON.stringify(report));

  return m3uResponse(body, refresh ? "REFRESH" : (healthy ? "MISS" : "BYPASS"), {
    cats: okCats + "/" + cats.length,
    channels: channels.length,
    subreq: used,
    ms
  });
}

function m3uResponse(body, cacheState, diag) {
  const headers = {
    "Content-Type": "audio/x-mpegurl; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300",
    "X-Cache": cacheState
  };
  if (diag) {
    headers["X-Cats-OK"] = String(diag.cats);
    headers["X-Channels"] = String(diag.channels);
    headers["X-Subrequests"] = String(diag.subreq);
    headers["X-Build-Ms"] = String(diag.ms);
  }
  return new Response(body, { headers });
}

async function handleDebug(url) {
  const cats = pickCategories(url.searchParams.get("cats"));
  const raw = parseInt(url.searchParams.get("pages") || "", 10);
  const pages = isNaN(raw) ? 0 : Math.max(0, Math.min(raw, 60));
  const started = Date.now();
  const { channels, report, used } = await buildChannels(cats, pages, "new");
  const ms = Date.now() - started;

  const lines = [];
  lines.push("91crdj Worker 诊断  " + new Date().toISOString());
  lines.push("origin   : " + url.origin);
  lines.push("HAS_CACHE: " + HAS_CACHE + "   (false 说明 Cache API 不可用，每次都会重建)");
  lines.push("耗时     : " + ms + " ms   （免费版 CPU 额度 10ms，超了会报 1102）");
  lines.push("子请求   : " + used + " / " + SUBREQUEST_BUDGET + "   （免费版硬上限 50）");
  lines.push("频道总数 : " + channels.length);
  lines.push("");
  lines.push("分类明细：");
  lines.push("  " + "分类".padEnd(10) + "来源".padEnd(8) + "HTTP".padEnd(7) +
             "字节".padEnd(9) + "作品".padEnd(7) + "页数".padEnd(7) + "集数".padEnd(7) + "备注");
  for (const r of report) {
    lines.push("  " + r.name.padEnd(9) + r.source.padEnd(8) + String(r.status).padEnd(7) +
      String(r.bytes).padEnd(9) + String(r.cards).padEnd(7) + String(r.pages).padEnd(7) +
      String(r.epSum).padEnd(7) + (r.fallback ? ("改用" + r.fallback) : "") +
      (r.error ? (" " + r.error) : ""));
  }
  lines.push("");
  if (!channels.length) {
    lines.push("结论：一个频道都没抓到。");
    lines.push("  0 作品的分类数：" + report.filter((r) => r.cards === 0).length + "/" + report.length);
    if (report.every((r) => r.status !== 200)) {
      lines.push("  所有分类 HTTP 非 200 -> 源站很可能拒绝了 Cloudflare Worker 的出口请求。");
    } else if (report.some((r) => r.status === 200 && r.bytes > 0)) {
      lines.push("  有分类 HTTP 200 且有字节但解析出 0 卡片 -> 源站改版，解析规则需要更新。");
    }
    lines.push("  可访问 " + url.origin + "/live.m3u?refresh=1 强制重建后重试。");
  } else {
    lines.push("结论：正常。订阅地址 " + url.origin + "/live.m3u");
  }
  return new Response(lines.join("\n") + "\n",
    { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function resolveStream(vodId, ep) {
  const j = await get(HOST + "/videos/" + vodId + "/episodes/" + ep + "/playback", { timeout: 15000 });
  if (j) {
    try {
      const o = JSON.parse(j);
      if (o && o.status === 1 && o.data && o.data.src) {
        const src = unescapeUrl(o.data.src);
        if (/^https?:\/\//.test(src)) return src;
      }
    } catch (e) {
    }
  }
  const html = await get(HOST + "/videos/" + vodId + "/episodes/" + ep + "/", { ajax: false });
  const src = unescapeUrl(firstMatch(html, /"src"\s*:\s*"(https?:\/\/[^"]+?)"/));
  if (/^https?:\/\//.test(src)) return src;
  return "";
}

async function handlePlayRedirect(url) {
  const vodId = (url.searchParams.get("id") || "").trim();
  const ep = (url.searchParams.get("ep") || "1").trim() || "1";
  if (!/^\d+$/.test(vodId) || !/^\d+$/.test(ep)) {
    return new Response("Missing or invalid id/ep parameter", { status: 400 });
  }
  const streamUrl = await resolveStream(vodId, ep);
  if (!streamUrl) return new Response("Stream Not Found", { status: 404 });

  return new Response(null, {
    status: 302,
    headers: { "Location": streamUrl, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
  });
}

function helpPage(url) {
  const text = [
    "91crdj 短剧 M3U 剧集展平版 运行正常",
    "",
    "订阅地址 : " + url.origin + "/live.m3u",
    ""
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
