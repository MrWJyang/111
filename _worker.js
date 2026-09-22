const BASE = "https://huangguodrama.ai";

// =========================
// CORS
// =========================
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*"
};

// =========================
// M3U Headers
// =========================
const M3U_HEADERS = {
  ...CORS_HEADERS,

  // 比 audio/x-mpegurl 对一些播放器更兼容
  "Content-Type": "application/x-mpegURL; charset=utf-8",

  // 调试阶段禁止缓存，避免 Cloudflare 返回旧 M3U
  "Cache-Control": "no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

// =========================
// 普通文本 Headers
// =========================
const TEXT_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0"
};

// =========================
// 分类
// =========================
const CATEGORIES = [
  {
    name: "精选推荐",
    path: "/discover/",
    pages: 3
  },
  {
    name: "AI短剧",
    path: "/ai-duanju/",
    pages: 3
  },
  {
    name: "AI漫剧",
    path: "/ai-manju/",
    pages: 3
  },
  {
    name: "AI魔改",
    path: "/ai-mogai/",
    pages: 3
  }
];

// =========================
// Worker
// =========================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // OPTIONS
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS
        });
      }

      // =========================
      // M3U
      // =========================
      if (
        pathname === "/live.m3u" ||
        pathname === "/m3u" ||
        pathname === "/"
      ) {
        return await handleM3U(request);
      }

      // =========================
      // 播放
      // /play?id=1027&ep=1
      // =========================
      if (pathname === "/play") {
        return await handlePlay(request);
      }

      // =========================
      // 信息
      // /info?id=1027
      // =========================
      if (pathname === "/info") {
        return await handleInfo(request);
      }

      // =========================
      // DEBUG M3U
      // =========================
      if (pathname === "/debug.m3u") {
        return await handleDebugM3U(request);
      }

      // =========================
      // 健康检查
      // =========================
      if (pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "huangguo-m3u",
            time: new Date().toISOString()
          }, null, 2),
          {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-cache"
            }
          }
        );
      }

      return new Response("Not Found", {
        status: 404,
        headers: TEXT_HEADERS
      });

    } catch (error) {
      console.error("Worker error:", error);

      return new Response(
        "Worker Error\n\n" +
        (error?.stack || error?.message || String(error)),
        {
          status: 500,
          headers: TEXT_HEADERS
        }
      );
    }
  }
};


// ============================================================
// M3U
// ============================================================

async function handleM3U(request) {
  try {
    const dramas = await getAllDramas();

    const currentUrl = new URL(request.url);

    const m3u = buildM3U(
      dramas,
      currentUrl.origin
    );

    return new Response(m3u, {
      status: 200,
      headers: M3U_HEADERS
    });

  } catch (error) {
    console.error("M3U Error:", error);

    // 注意：
    // 如果这里返回 HTML / JSON，APTV 会直接认为不是 M3U。
    // 所以错误时也返回一个合法的 M3U。
    const errorM3U =
      "#EXTM3U\n" +
      `#EXTINF:-1 tvg-name="M3U生成失败",M3U生成失败\n` +
      `${new URL(request.url).origin}/health\n`;

    return new Response(errorM3U, {
      status: 200,
      headers: M3U_HEADERS
    });
  }
}


// ============================================================
// DEBUG M3U
// ============================================================

async function handleDebugM3U(request) {
  const currentUrl = new URL(request.url);

  const lines = [
    "#EXTM3U",
    "",
    "# ================================",
    "# 黄果短剧 M3U DEBUG",
    "# ================================",
    "",
    `# Worker: ${currentUrl.origin}`,
    `# Time: ${new Date().toISOString()}`,
    ""
  ];

  return new Response(lines.join("\n"), {
    status: 200,
    headers: M3U_HEADERS
  });
}


// ============================================================
// 构建 M3U
// ============================================================

function buildM3U(dramas, origin) {
  const lines = [];

  // ========================================================
  // 最标准的 M3U 文件头
  //
  // 不再使用：
  // #EXTM3U name="黄果短剧全集展平源"
  //
  // 避免部分播放器解析扩展属性时出现兼容性问题。
  // ========================================================
  lines.push("#EXTM3U");

  for (const drama of dramas) {
    const id = drama.id;

    const title = cleanText(
      drama.title || `短剧 ${id}`
    );

    const cover = normalizeUrl(
      drama.cover || ""
    );

    const group = cleanText(
      drama.group || "精选推荐"
    );

    const episodeCount = Number(
      drama.episodeCount || 0
    );

    if (!episodeCount || episodeCount < 1) {
      continue;
    }

    for (let ep = 1; ep <= episodeCount; ep++) {
      const episodeTitle =
        `${title} 第${String(ep).padStart(2, "0")}集`;

      // ====================================================
      // tvg-id
      //
      // 每一集使用唯一 ID。
      // 如果以后需要 EPG，也比较方便。
      // ====================================================
      const tvgId = `${id}_${ep}`;

      // ====================================================
      // M3U EXTINF
      // ====================================================
      let extinf =
        `#EXTINF:-1` +
        ` tvg-id="${escapeM3UAttribute(tvgId)}"` +
        ` tvg-name="${escapeM3UAttribute(episodeTitle)}"` +
        ` tvg-logo="${escapeM3UAttribute(cover)}"` +
        ` group-title="${escapeM3UAttribute(group)}"` +
        `,${escapeM3UTitle(episodeTitle)}`;

      lines.push(extinf);

      // ====================================================
      // 播放地址
      //
      // APTV 最终访问：
      //
      // /play?id=1027&ep=1
      //
      // Worker 再 302 到真实 MP4/M3U8。
      // ====================================================
      const playUrl =
        `${origin}/play?id=${encodeURIComponent(id)}` +
        `&ep=${encodeURIComponent(ep)}`;

      lines.push(playUrl);
    }
  }

  // 最后必须有换行
  return lines.join("\n") + "\n";
}


// ============================================================
// 获取全部短剧
// ============================================================

async function getAllDramas() {
  const map = new Map();

  for (const category of CATEGORIES) {
    for (let page = 1; page <= category.pages; page++) {
      try {
        const url =
          page === 1
            ? `${BASE}${category.path}`
            : `${BASE}${category.path}?page=${page}`;

        console.log(
          `Fetching category: ${url}`
        );

        const html = await fetchText(url);

        if (!html) {
          continue;
        }

        const ids = parseDetailLinks(html);

        for (const id of ids) {
          if (!map.has(id)) {
            map.set(id, {
              id,
              group: category.name
            });
          }
        }

      } catch (error) {
        console.error(
          `Category error: ${category.name}`,
          error
        );
      }
    }
  }

  const dramas = [];

  for (const item of map.values()) {
    try {
      const detail = await getDetailInfo(
        item.id
      );

      if (!detail) {
        continue;
      }

      dramas.push({
        ...detail,
        group: item.group
      });

    } catch (error) {
      console.error(
        `Detail error: ${item.id}`,
        error
      );
    }
  }

  return dramas;
}


// ============================================================
// 解析详情页链接
// ============================================================

function parseDetailLinks(html) {
  const ids = new Set();

  const regex =
    /\/detail\/(\d+)\/?/g;

  let match;

  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1]);
  }

  return Array.from(ids);
}


// ============================================================
// 获取详情
// ============================================================

async function getDetailInfo(id) {
  const url = `${BASE}/detail/${id}/`;

  const html = await fetchText(url);

  if (!html) {
    return null;
  }

  const title =
    extractTitle(html) ||
    `短剧 ${id}`;

  const cover =
    extractCover(html);

  const episodeCount =
    extractEpisodeCount(html, id);

  return {
    id,
    title,
    cover,
    episodeCount
  };
}


// ============================================================
// 提取标题
// ============================================================

function extractTitle(html) {
  // og:title
  let match = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );

  if (match) {
    return cleanText(
      decodeHtmlEntities(match[1])
    );
  }

  // title
  match = html.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

  if (match) {
    return cleanText(
      decodeHtmlEntities(match[1])
    );
  }

  // h1
  match = html.match(
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  );

  if (match) {
    return cleanText(
      stripHtml(match[1])
    );
  }

  return "";
}


// ============================================================
// 提取封面
// ============================================================

function extractCover(html) {
  let match = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
  );

  if (match) {
    return normalizeUrl(
      decodeHtmlEntities(match[1])
    );
  }

  // img src
  match = html.match(
    /<img[^>]+src=["']([^"']+)["']/i
  );

  if (match) {
    return normalizeUrl(
      decodeHtmlEntities(match[1])
    );
  }

  return "";
}


// ============================================================
// 提取集数
// ============================================================

function extractEpisodeCount(html, id) {
  let maxEp = 0;

  const patterns = [
    /更新至\s*(\d+)\s*集/gi,
    /已上线\s*(\d+)\s*集/gi,
    /(\d+)\s*集全部上线/gi,
    /上线\s*(\d+)\s*集/gi
  ];

  for (const regex of patterns) {
    let match;

    while ((match = regex.exec(html)) !== null) {
      const n = Number(match[1]);

      if (n > maxEp) {
        maxEp = n;
      }
    }
  }

  // ========================================================
  // 从 video URL 中找最大集数
  //
  // /video/123/ep-12/
  // /video/123/ep12/
  // /video/123/p12/
  // ========================================================

  const videoPatterns = [
    new RegExp(
      `/video/${id}/ep-(\\d+)`,
      "gi"
    ),

    new RegExp(
      `/video/${id}/ep(\\d+)`,
      "gi"
    ),

    new RegExp(
      `/video/${id}/p(\\d+)`,
      "gi"
    )
  ];

  for (const regex of videoPatterns) {
    let match;

    while ((match = regex.exec(html)) !== null) {
      const n = Number(match[1]);

      if (n > maxEp) {
        maxEp = n;
      }
    }
  }

  return maxEp;
}


// ============================================================
// 播放
// ============================================================

async function handlePlay(request) {
  try {
    const url = new URL(request.url);

    const id =
      url.searchParams.get("id");

    const ep =
      url.searchParams.get("ep");

    if (!id || !ep) {
      return new Response(
        "Missing id or ep",
        {
          status: 400,
          headers: TEXT_HEADERS
        }
      );
    }

    console.log(
      `Play request: id=${id}, ep=${ep}`
    );

    const mediaUrl =
      await findMediaUrl(id, ep);

    if (!mediaUrl) {
      return new Response(
        `Media URL not found\nid=${id}\nep=${ep}`,
        {
          status: 404,
          headers: TEXT_HEADERS
        }
      );
    }

    console.log(
      `Redirecting to: ${mediaUrl}`
    );

    // ======================================================
    // 302 到真实视频地址
    // ======================================================

    return Response.redirect(
      mediaUrl,
      302
    );

  } catch (error) {
    console.error(
      "Play error:",
      error
    );

    return new Response(
      "Play error\n\n" +
      (error?.stack ||
       error?.message ||
       String(error)),
      {
        status: 500,
        headers: TEXT_HEADERS
      }
    );
  }
}


// ============================================================
// 查找真实媒体地址
// ============================================================

async function findMediaUrl(id, ep) {
  const candidates = [
    `/video/${id}/ep-${ep}/`,
    `/video/${id}/ep${ep}/`,
    `/video/${id}/p${ep}/`
  ];

  // 第一集额外尝试
  if (String(ep) === "1") {
    candidates.push(
      `/video/${id}/`
    );
  }

  for (const path of candidates) {
    try {
      const url = `${BASE}${path}`;

      console.log(
        `Trying video page: ${url}`
      );

      const html =
        await fetchText(url);

      if (!html) {
        continue;
      }

      const mediaUrl =
        extractMediaUrl(html);

      if (mediaUrl) {
        console.log(
          `Found media: ${mediaUrl}`
        );

        return mediaUrl;
      }

    } catch (error) {
      console.error(
        `Video page error: ${path}`,
        error
      );
    }
  }

  return null;
}


// ============================================================
// 提取媒体 URL
// ============================================================

function extractMediaUrl(html) {

  // ========================================================
  // 1. <video src="">
  // ========================================================

  let match = html.match(
    /<video[^>]+src=["']([^"']+)["']/i
  );

  if (match) {
    const url =
      normalizeUrl(
        decodeHtmlEntities(match[1])
      );

    if (isMediaUrl(url)) {
      return url;
    }
  }

  // ========================================================
  // 2. <source src="">
  // ========================================================

  match = html.match(
    /<source[^>]+src=["']([^"']+)["']/i
  );

  if (match) {
    const url =
      normalizeUrl(
        decodeHtmlEntities(match[1])
      );

    if (isMediaUrl(url)) {
      return url;
    }
  }

  // ========================================================
  // 3. og:video
  // ========================================================

  const ogPatterns = [
    /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i
  ];

  for (const regex of ogPatterns) {
    match = html.match(regex);

    if (match) {
      const url =
        normalizeUrl(
          decodeHtmlEntities(match[1])
        );

      if (isMediaUrl(url)) {
        return url;
      }
    }
  }

  // ========================================================
  // 4. JSON / JS 字段
  // ========================================================

  const fieldNames = [
    "videoSrc",
    "videoUrl",
    "playUrl",
    "mediaUrl",
    "src",
    "data-play-src"
  ];

  for (const field of fieldNames) {

    const regex = new RegExp(
      `["']${escapeRegExp(field)}["']\\s*:\\s*["']([^"']+)["']`,
      "i"
    );

    match = html.match(regex);

    if (match) {
      const url =
        normalizeUrl(
          decodeHtmlEntities(match[1])
        );

      if (isMediaUrl(url)) {
        return url;
      }
    }
  }

  // ========================================================
  // 5. videoInitialData
  // ========================================================

  match = html.match(
    /<script[^>]+id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (match) {
    const scriptText = match[1];

    const url =
      extractUrlFromText(
        scriptText
      );

    if (url) {
      return url;
    }
  }

  // ========================================================
  // 6. 页面中直接搜索 MP4 / M3U8
  // ========================================================

  const urls =
    html.match(
      /https?:\/\/[^"'\\\s<>]+/gi
    ) || [];

  for (let url of urls) {

    url =
      decodeHtmlEntities(url)
        .replace(/\\u0026/g, "&")
        .replace(/\\u002F/g, "/")
        .replace(/\\\//g, "/");

    if (isMediaUrl(url)) {
      return url;
    }
  }

  return null;
}


// ============================================================
// 从文本中提取 URL
// ============================================================

function extractUrlFromText(text) {
  const urls =
    text.match(
      /https?:\/\/[^"'\\\s<>]+/gi
    ) || [];

  for (let url of urls) {

    url =
      decodeHtmlEntities(url)
        .replace(/\\u0026/g, "&")
        .replace(/\\u002F/g, "/")
        .replace(/\\\//g, "/");

    if (isMediaUrl(url)) {
      return url;
    }
  }

  return null;
}


// ============================================================
// 判断是否为媒体 URL
// ============================================================

function isMediaUrl(url) {
  if (!url) {
    return false;
  }

  const value =
    url.toLowerCase();

  return (
    value.includes(".mp4") ||
    value.includes(".m3u8") ||
    value.includes("/trailers/") ||
    value.includes("/video/")
  );
}


// ============================================================
// fetch HTML
// ============================================================

async function fetchText(url) {
  const response =
    await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control":
          "no-cache"
      }
    });

  if (!response.ok) {
    console.error(
      `HTTP ${response.status}: ${url}`
    );

    return "";
  }

  return await response.text();
}


// ============================================================
// URL 标准化
// ============================================================

function normalizeUrl(url) {
  if (!url) {
    return "";
  }

  url =
    decodeHtmlEntities(url)
      .trim()
      .replace(/\\u0026/g, "&")
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/");

  if (url.startsWith("//")) {
    return "https:" + url;
  }

  if (url.startsWith("/")) {
    return BASE + url;
  }

  if (
    url.startsWith("http://") ||
    url.startsWith("https://")
  ) {
    return url;
  }

  return url;
}


// ============================================================
// M3U 属性转义
// ============================================================

function escapeM3UAttribute(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}


// ============================================================
// M3U 标题转义
// ============================================================

function escapeM3UTitle(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}


// ============================================================
// HTML 清理
// ============================================================

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


// ============================================================
// 文本清理
// ============================================================

function cleanText(value) {
  return stripHtml(
    decodeHtmlEntities(
      String(value ?? "")
    )
  );
}


// ============================================================
// HTML 实体
// ============================================================

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}


// ============================================================
// 正则转义
// ============================================================

function escapeRegExp(value) {
  return String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// ============================================================
// Info
// ============================================================

async function handleInfo(request) {
  try {
    const url =
      new URL(request.url);

    const id =
      url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({
          error: "missing id"
        }, null, 2),
        {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type":
              "application/json; charset=utf-8"
          }
        }
      );
    }

    const detail =
      await getDetailInfo(id);

    if (!detail) {
      return new Response(
        JSON.stringify({
          error: "not found",
          id
        }, null, 2),
        {
          status: 404,
          headers: {
            ...CORS_HEADERS,
            "Content-Type":
              "application/json; charset=utf-8"
          }
        }
      );
    }

    // 第一集真实地址
    const mediaUrl =
      await findMediaUrl(id, 1);

    return new Response(
      JSON.stringify({
        ...detail,
        mediaUrl: mediaUrl || null
      }, null, 2),
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type":
            "application/json; charset=utf-8",
          "Cache-Control":
            "no-cache, no-store, must-revalidate"
        }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error?.message ||
          String(error)
      }, null, 2),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type":
            "application/json; charset=utf-8"
        }
      }
    );
  }
}