export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (payload.message) await handleTelegramMessage(payload.message, env);
      } catch (e) {
        console.error("Error parsing Telegram payload:", e);
      }
    }
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    switch (event.cron) {
      case "*/3 * * * *":
        ctx.waitUntil(processAllSources(env));
        break;
      case "1 0 * * *":
        await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, "🔄 ریست روزانه شمارنده");
        ctx.waitUntil(resetApiUsage(env));
        break;
    }
  },
};

// ═══════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════
const API_DELAY_MS = 5000;
const ADMIN_CHAT_ID = 6290676072;
const RLM = "\u200F";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════
//  SPAM / QUALITY FILTER
// ═══════════════════════════════════════
const SPAM_KEYWORDS = [
  "casino", "betting", "gambling", "poker", "slot",
  "escort", "porn", "xxx", "onlyfans",
  "forex", "crypto signal", "binary option",
  "weight loss", "diet pill", "keto",
  "roller shutter", "plumbing", "roofing",
  "led light", "tri-proof", "solar panel",
  "seo service", "backlink", "guest post",
  "loan", "payday", "credit score",
  "現金網", "赔率", "彩金", "投注",
  "buy followers", "free iphone",
];

const TECH_KEYWORDS = [
  "programming", "developer", "software", "code", "api",
  "javascript", "typescript", "python", "rust", "go",
  "react", "vue", "angular", "svelte", "next",
  "node", "deno", "bun", "docker", "kubernetes",
  "aws", "cloud", "devops", "ci/cd", "git",
  "database", "sql", "nosql", "redis", "postgres",
  "machine learning", "ai", "llm", "gpt", "neural",
  "web", "frontend", "backend", "fullstack",
  "security", "vulnerability", "cve", "encryption",
  "linux", "open source", "framework", "library",
  "algorithm", "data structure", "system design",
  "startup", "saas", "microservice", "serverless",
  "blockchain", "web3", "compiler", "interpreter",
  "cpu", "gpu", "memory", "performance", "benchmark",
  "testing", "debug", "deploy", "monitoring",
];

function isSpamPost(post) {
  const text = `${post.title} ${post.author} ${post.brief || ""} ${(post.tags || []).join(" ")}`.toLowerCase();

  // Check spam keywords
  for (const keyword of SPAM_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      console.log(`[SPAM] Blocked: "${post.title}" (matched: ${keyword})`);
      return true;
    }
  }

  // For Hashnode/Reddit: require at least one tech keyword
  if (post._source === "HASHNODE" || post._source === "REDDIT") {
    const hasTech = TECH_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
    if (!hasTech) {
      console.log(`[FILTER] No tech relevance: "${post.title}"`);
      return true;
    }
  }

  return false;
}

// ═══════════════════════════════════════
//  SOURCES
// ═══════════════════════════════════════
const SOURCES = [
  { name: "DEV_TO",       fetcher: fetchDevToPosts,       icon: "⚫",  label: "Dev.to",       accent: "⬛" },
  { name: "HACKER_NEWS",  fetcher: fetchHackerNewsPosts,  icon: "🟠",  label: "Hacker News",  accent: "🟧" },
  { name: "HASHNODE",     fetcher: fetchHashnodePosts,    icon: "🔵",  label: "Hashnode",     accent: "🟦" },
  { name: "REDDIT",       fetcher: fetchRedditPosts,      icon: "🔴",  label: "Reddit",       accent: "🟥" },
  { name: "TWITTER",      fetcher: fetchTwitterPosts,     icon: "𝕏",   label: "X (Twitter)",  accent: "⬜" },
];

async function processAllSources(env) {
  for (const source of SOURCES) {
    try {
      await processSource(source, env);
    } catch (e) {
      console.error(`[${source.name}] Fatal error:`, e);
    }
  }
}

async function ensurePostTrackerTable(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS PostTracker (
        source_name TEXT PRIMARY KEY,
        last_timestamp TEXT NOT NULL
      )`
    ).run();
    return true;
  } catch (e) {
    console.error("Error creating PostTracker table:", e);
    return false;
  }
}

async function getLastTimestamp(sourceName, env) {
  try {
    await ensurePostTrackerTable(env);
    const result = await env.DB.prepare(
      "SELECT last_timestamp FROM PostTracker WHERE source_name = ?"
    ).bind(sourceName).first();
    return result?.last_timestamp;
  } catch (e) {
    console.error(`Error reading timestamp for ${sourceName}:`, e);
    return null;
  }
}

async function setLastTimestamp(sourceName, timestamp, env) {
  try {
    await ensurePostTrackerTable(env);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO PostTracker (source_name, last_timestamp) VALUES (?, ?)"
    ).bind(sourceName, timestamp).run();
    return true;
  } catch (e) {
    console.error(`Error writing timestamp for ${sourceName}:`, e);
    return false;
  }
}

async function processSource(source, env) {
  const posts = await source.fetcher();
  if (!posts || posts.length === 0) {
    // Update timestamp even if no posts fetched (to track last check)
    await setLastTimestamp(source.name, new Date().toISOString(), env);
    return;
  }

  const defaultTime = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();
  const lastTimestamp = await getLastTimestamp(source.name, env) || defaultTime;

  let newPosts = posts.filter(
    (p) => p.isoTimestamp && p.isoTimestamp > lastTimestamp
  );
  if (newPosts.length === 0) {
    // Update timestamp even if no new posts (to track last check)
    await setLastTimestamp(source.name, new Date().toISOString(), env);
    return;
  }

  newPosts.sort(
    (a, b) =>
      new Date(a.isoTimestamp).getTime() - new Date(b.isoTimestamp).getTime()
  );
  console.log(`[${source.name}] Found ${newPosts.length} new post(s).`);

  // Track the last successfully sent post timestamp
  let lastSentTimestamp = lastTimestamp;
  let hasSentAny = false;

  for (const post of newPosts) {
    // Tag source info
    post._source = source.name;
    post._icon = source.icon;
    post._label = source.label;
    post._accent = source.accent;

    // ── Spam Filter ──
    if (isSpamPost(post)) {
      console.log(`[${source.name}] Spam filtered: "${post.title?.substring(0, 50)}..."`);
      continue; // Skip spam - don't update timestamp
    }

    // ── Summarize ──
    const result = await summarizeWithGroq(post, env);

    // ── Send ──
    const sent = result.error
      ? await sendPostToTelegram(post, null, env)
      : await sendPostToTelegram(post, result.summary, env);

    if (sent) {
      // Only update timestamp if post was successfully sent
      lastSentTimestamp = post.isoTimestamp;
      hasSentAny = true;
      console.log(`[${source.name}] Sent: "${post.title?.substring(0, 50)}..."`);
    } else {
      console.error(`[${source.name}] Failed to send: "${post.title?.substring(0, 50)}..."`);
      // Don't update timestamp on failure - will retry next cron
    }

    await delay(API_DELAY_MS);
  }

  // Save the timestamp of last successfully sent post
  if (hasSentAny) {
    const saved = await setLastTimestamp(source.name, lastSentTimestamp, env);
    if (saved) {
      console.log(`[${source.name}] Updated timestamp to: ${lastSentTimestamp}`);
    }
  } else {
    console.log(`[${source.name}] No posts sent, timestamp unchanged.`);
  }
}

// ═══════════════════════════════════════
//  FETCHERS
// ═══════════════════════════════════════

async function fetchDevToPosts() {
  const res = await fetch("https://dev.to/latest", {
    headers: { "User-Agent": "Cloudflare Worker" },
  });
  if (!res.ok) return [];

  let posts = [];
  let cur = {};

  const rewriter = new HTMLRewriter()
    .on("div.crayons-story", {
      element() { cur = { tags: [], image: null }; },
    })
    .on("img.crayons-article__cover__image__feed", {
      element(el) { if (cur) cur.image = el.getAttribute("src"); },
    })
    .on("h2.crayons-story__title a", {
      element(el) {
        if (cur) cur.link = new URL(el.getAttribute("href"), "https://dev.to").href;
      },
      text(t) { if (cur) cur.title = (cur.title || "") + t.text; },
    })
    .on("time", {
      element(el) { if (cur) cur.isoTimestamp = el.getAttribute("datetime"); },
    })
    .on("button.profile-preview-card__trigger", {
      text(t) { if (cur) cur.author = (cur.author || "") + t.text; },
    })
    .on("div.crayons-story__tags a", {
      text(t) { if (cur && t.text) cur.tags.push(t.text.replace("#", "").trim()); },
    })
    .on("div.crayons-story__bottom", {
      element() {
        if (cur?.link && cur?.isoTimestamp) {
          cur.title = cur.title?.trim();
          cur.author = cur.author?.trim();
          posts.push(cur);
          cur = {};
        }
      },
    });

  await rewriter.transform(res).arrayBuffer();
  return posts;
}

async function fetchHackerNewsPosts() {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok) return [];
  const ids = (await res.json()).slice(0, 8);
  const posts = [];

  for (const id of ids) {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (!r.ok) continue;
      const item = await r.json();
      if (item?.url && item?.title) {
        posts.push({
          title: item.title,
          link: item.url,
          author: item.by || "Unknown",
          isoTimestamp: new Date(item.time * 1000).toISOString(),
          tags: ["HackerNews"],
          image: null,
        });
      }
    } catch (_) {}
  }
  return posts;
}

async function fetchHashnodePosts() {
  const query = `query {
    feed(first: 5, filter: { type: RECENT }) {
      edges { node {
        title brief slug
        coverImage { url }
        publishedAt
        author { name }
        tags { name slug }
      }}
    }
  }`;

  const res = await fetch("https://gql.hashnode.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.data?.feed) return [];

  return data.data.feed.edges.map(({ node }) => ({
    title: node.title,
    link: `https://hashnode.com/${node.slug}`,
    author: node.author.name,
    isoTimestamp: node.publishedAt,
    tags: node.tags?.map((t) => t.name) || ["Hashnode"],
    image: node.coverImage?.url || null,
    brief: node.brief,
  }));
}

async function fetchRedditPosts() {
  const subs = ["programming", "technology", "webdev"];
  const posts = [];

  for (const sub of subs) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=5`, {
        headers: { "User-Agent": "TelegramBot/1.0" },
      });
      if (!r.ok) continue;
      const data = await r.json();

      for (const { data: p } of data.data.children) {
        if (p.stickied) continue;

        let image = null;
        if (p.post_hint === "image" || p.url?.match(/\.(jpg|jpeg|png|webp)$/i)) {
          image = p.url;
        } else if (p.thumbnail?.startsWith("http")) {
          image = p.thumbnail;
        }

        posts.push({
          title: p.title,
          link: `https://www.reddit.com${p.permalink}`,
          author: `u/${p.author}`,
          isoTimestamp: new Date(p.created_utc * 1000).toISOString(),
          tags: ["Reddit", sub],
          image,
        });
      }
    } catch (e) {
      console.error(`Reddit /${sub}:`, e);
    }
  }
  return posts;
}

async function fetchTwitterPosts() {
  const instances = [
    "https://nitter.poast.org",
    "https://nitter.cz",
    "https://nitter.net",
    "https://nitter.privacydev.net",
  ];
  const q = "%23programming+OR+%23javascript";

  for (const base of instances) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${base}/search/rss?f=tweets&q=${q}&e-filter=replies`, {
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (!r.ok) continue;

      const txt = await r.text();
      const items = txt.match(/<item>[\s\S]*?<\/item>/g) || [];
      if (!items.length) continue;

      const posts = [];
      for (const item of items.slice(0, 5)) {
        const get = (tag) => item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
        const title = get("title")?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        const link = get("link");
        const date = get("pubDate");
        if (!title || !link || !date) continue;

        let image = null;
        const desc = get("description");
        if (desc) {
          const imgM = desc.match(/<img src="(.*?)"/);
          if (imgM) image = imgM[1];
        }

        posts.push({
          title,
          link,
          author: get("dc:creator") || "X User",
          isoTimestamp: new Date(date).toISOString(),
          tags: ["X", "Twitter"],
          image,
        });
      }

      console.log(`Twitter: ${posts.length} from ${base}`);
      return posts;
    } catch (_) {}
  }
  return [];
}

// ═══════════════════════════════════════
//  AI SUMMARIZATION
// ═══════════════════════════════════════

async function summarizeWithGroq(post, env) {
  let content = post.brief || "";
  if (!content) content = await scrapePostContent(post.link);
  if (!content || content.length < 100) {
    return { error: true };
  }

  const { results: keys } = await env.DB.prepare(
    "SELECT id, api_key FROM ApiKeys ORDER BY usage_count ASC"
  ).all();

  if (!keys?.length) return { error: true };

  const prompt = `تو یک خلاصه‌نویس حرفه‌ای اخبار تکنولوژی برای کانال تلگرام فارسی هستی.

مقاله زیر را خلاصه کن. قوانین را دقیقاً رعایت کن:

📐 قوانین فرمت:
- فقط از تگ‌های HTML تلگرام استفاده کن: <b> و <code> و <i>
- هر کلمه انگلیسی، اسم ابزار، فناوری یا برند را داخل <code> بذار
- هر نکته با یک ایموجی مرتبط شروع بشه
- بین ۴ تا ۶ نکته بنویس
- هر نکته حداکثر ۲ خط باشه
- هرگز از مارک‌داون استفاده نکن (نه ** نه ## نه [])
- هرگز از تگ <a> استفاده نکن
- فارسی روان و جذاب بنویس، خشک نباشه

📋 قوانین محتوا:
- اول بگو چیه و چرا مهمه
- بعد جزئیات فنی کلیدی
- در آخر نتیجه‌گیری یا پیشنهاد عملی

محتوای مقاله:
${content.substring(0, 6000)}`;

  const messages = [
    {
      role: "system",
      content: "تو خلاصه‌نویس اخبار تکنولوژی هستی. خروجی فقط HTML تلگرام باشه. هرگز مارک‌داون ننویس.",
    },
    { role: "user", content: prompt },
  ];

  for (const key of keys) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "moonshotai/kimi-k2-instruct-0905",
          messages,
          max_tokens: 800,
          temperature: 0.3,
        }),
      });

      if (r.ok) {
        await env.DB.prepare("UPDATE ApiKeys SET usage_count = usage_count + 1 WHERE id = ?")
          .bind(key.id)
          .run();
        const data = await r.json();
        let summary = data.choices[0].message.content;
        summary = cleanSummary(summary);
        return { error: false, summary };
      }
    } catch (e) {
      console.error("Groq error:", e);
    }
  }
  return { error: true };
}

function cleanSummary(text) {
  // 1) Convert leftover markdown to HTML
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/^#{1,3}\s*/gm, "");

  // 2) Remove disallowed HTML tags (keep b, i, code, pre, a)
  const allowed = /<\/?(b|i|a|code|pre)\b[^>]*>/gi;
  text = text.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/gi, (m) =>
    allowed.test(m) ? m : ""
  );

  // 3) Remove empty lines stacking
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ═══════════════════════════════════════
//  MESSAGE BUILDER
// ═══════════════════════════════════════

function esc(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function timeAgo(iso) {
  if (!iso) return "❌ هرگز";
  const date = new Date(iso);
  const timeMs = date.getTime();
  if (isNaN(timeMs)) return "❌ نامعتبر";
  const diff = Math.floor((Date.now() - timeMs) / 60000);
  if (diff < 1) return "همین الان";
  if (diff < 60) return `${diff} دقیقه پیش`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h} ساعت پیش`;
  return `${Math.floor(h / 24)} روز پیش`;
}

function buildTags(tags) {
  if (!tags?.length) return "";
  return tags
    .map((t) => t.replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, "").trim())
    .filter(Boolean)
    .map((t) => `#${t}`)
    .join("  ");
}

function buildFullMessage(post, summary) {
  const line = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";
  const tags = buildTags(post.tags);
  const time = timeAgo(post.isoTimestamp);

  let msg = "";

  // ── Header ──
  msg += `${RLM}${post._icon}  <b>${esc(post.title)}</b>\n`;
  msg += `${RLM}${line}\n\n`;

  // ── Summary ──
  if (summary) {
    msg += summary
      .split("\n")
      .map((l) => `${RLM}${l}`)
      .join("\n");
    msg += "\n\n";
  } else {
    msg += `${RLM}📄 <i>خلاصه‌ای برای این مطلب در دسترس نیست.</i>\n\n`;
  }

  // ── Footer ──
  msg += `${RLM}${line}\n`;
  msg += `${RLM}📌 <b>${post._label}</b>  ·  👤 <i>${esc(post.author)}</i>  ·  🕐 <i>${time}</i>\n\n`;
  msg += `${RLM}📎  <a href="${post.link}">مطالعه متن کامل مقاله</a>\n\n`;

  if (tags) {
    msg += `${RLM}${tags}`;
  }

  return msg;
}

function buildShortCaption(post) {
  const tags = buildTags(post.tags);
  const time = timeAgo(post.isoTimestamp);

  let cap = "";
  cap += `${RLM}${post._icon}  <b>${esc(post.title)}</b>\n\n`;
  cap += `${RLM}📌 ${post._label}  ·  👤 ${esc(post.author)}  ·  🕐 ${time}\n\n`;
  cap += `${RLM}📎  <a href="${post.link}">مطالعه متن کامل</a>\n\n`;
  if (tags) cap += `${RLM}${tags}`;
  return cap;
}

// ═══════════════════════════════════════
//  SEND TO TELEGRAM
// ═══════════════════════════════════════

async function sendPostToTelegram(post, summary, env) {
  if (post.image) {
    // ── With Image ──
    const caption = buildShortCaption(post);
    const photoSent = await sendPhoto(env.BOT_TOKEN, env.CHAT_ID, post.image, caption);

    if (!photoSent) {
      // Photo failed → send full text instead
      const msg = buildFullMessage(post, summary);
      return await sendMessage(env.BOT_TOKEN, env.CHAT_ID, msg);
    }

    // Send summary as reply if exists
    if (summary) {
      await delay(800);
      const sumMsg = summary
        .split("\n")
        .map((l) => `${RLM}${l}`)
        .join("\n");
      const text = `${RLM}📝  <b>خلاصه مطلب:</b>\n\n${sumMsg}`;
      return await sendMessage(env.BOT_TOKEN, env.CHAT_ID, text);
    }
    return true;
  } else {
    // ── Without Image ──
    const msg = buildFullMessage(post, summary);
    return await sendMessage(env.BOT_TOKEN, env.CHAT_ID, msg);
  }
}

// ═══════════════════════════════════════
//  TELEGRAM API
// ═══════════════════════════════════════

async function sendMessage(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("TG sendMessage fail:", err);

      // If HTML parse error, try sending without parse_mode
      if (err.includes("can't parse entities")) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text.replace(/<[^>]+>/g, ""),
            disable_web_page_preview: false,
          }),
        });
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error("sendMessage error:", e);
    return false;
  }
}

async function sendPhoto(token, chatId, photoUrl, caption) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });
    if (!r.ok) {
      console.error("TG sendPhoto fail:", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("sendPhoto error:", e);
    return false;
  }
}

// ═══════════════════════════════════════
//  SCRAPER
// ═══════════════════════════════════════

async function scrapePostContent(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    if (!r.ok) return null;

    let content = "";
    await new HTMLRewriter()
      .on("div.crayons-article__body", { text(t) { content += t.text; } })
      .on("article", { text(t) { content += t.text; } })
      .on("main", { text(t) { content += t.text; } })
      .transform(r)
      .arrayBuffer();

    return content.trim() || null;
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════
//  ADMIN COMMANDS
// ═══════════════════════════════════════

async function handleTelegramMessage(message, env) {
  if (message.chat.id !== ADMIN_CHAT_ID) return;
  const text = message.text?.trim();
  if (!text) return;

  const parts = text.split(" ");
  const cmd = parts[0];

  const commands = {
    "/usage": () => cmdUsage(env),
    "/force": () => cmdForce(env),
    "/status": () => cmdStatus(env),
    "/help": () => cmdHelp(env),
    "/test": () => cmdTest(env),
    "/add": () => cmdAddTimestamp(parts, env),
  };

  if (commands[cmd]) await commands[cmd]();
}

async function cmdUsage(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, usage_count FROM ApiKeys ORDER BY id"
  ).all();

  let msg = `${RLM}📊  <b>مصرف API امروز</b>\n\n`;
  let total = 0;
  if (results) {
    for (const r of results) {
      const bar = "█".repeat(Math.min(r.usage_count, 20)) || "░";
      msg += `${RLM}  <code>${r.id}</code>  ${bar}  ${r.usage_count}\n`;
      total += r.usage_count;
    }
  }
  msg += `\n${RLM}📈 مجموع: <b>${total}</b>`;
  await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, msg);
}

async function cmdForce(env) {
  await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, "🚀 اسکرپ دستی شروع شد...");
  const start = Date.now();
  await processAllSources(env);
  const dur = ((Date.now() - start) / 1000).toFixed(1);
  await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, `✅ تمام شد (${dur}s)`);
}

async function cmdStatus(env) {
  let msg = `${RLM}🤖  <b>وضعیت منابع</b>\n\n`;

  for (const src of SOURCES) {
    try {
      const result = await env.DB.prepare(
        "SELECT last_timestamp FROM PostTracker WHERE source_name = ?"
      ).bind(src.name).first();
      const ts = result?.last_timestamp;
      const ago = ts ? timeAgo(ts) : "❌ هرگز";
      msg += `${RLM}  ${src.icon}  <b>${src.label}</b>:  ${ago}\n`;
    } catch (e) {
      msg += `${RLM}  ${src.icon}  <b>${src.label}</b>:  ❌ خطا\n`;
    }
  }

  await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, msg);
}

async function cmdHelp(env) {
  const msg = `${RLM}🛠  <b>دستورات ادمین</b>

${RLM}  /usage  →  آمار مصرف API
${RLM}  /force  →  اسکرپ دستی فوری
${RLM}  /status →  آخرین وضعیت منابع
${RLM}  /test   →  ارسال پست آزمایشی
${RLM}  /help   →  همین پیام`;

  await sendMessage(env.BOT_TOKEN, ADMIN_CHAT_ID, msg);
}

async function cmdTest(env) {
  const testPost = {
    title: "Test Post: Hello World!",
    link: "https://example.com",
    author: "Test Bot",
    isoTimestamp: new Date().toISOString(),
    tags: ["test", "debug"],
    image: null,
    _source: "TEST",
    _icon: "🧪",
    _label: "Test",
    _accent: "⬜",
  };

  const testSummary = `🧪 این یک <b>پست آزمایشی</b> است برای بررسی فرمت خروجی

🔧 ابزار <code>Cloudflare Workers</code> برای اجرای این بات استفاده می‌شود

📡 خلاصه‌سازی با <code>Groq API</code> و مدل <code>Kimi K2</code> انجام می‌شود

✅ اگر این پیام را درست می‌بینید، همه چیز کار می‌کند!`;

  await sendPostToTelegram(testPost, testSummary, env);
}

async function resetApiUsage(env) {
  await env.DB.prepare("UPDATE ApiKeys SET usage_count = 0").run();
}
