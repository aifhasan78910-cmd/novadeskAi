
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

// =================================
// DATABASE
// =================================

function readDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeDB(rows) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(rows.slice(-3000), null, 2),
    "utf8"
  );
}

// =================================
// RESPONSE
// =================================

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  if (status === 204) return res.end();

  res.end(
    type.startsWith("application/json")
      ? JSON.stringify(body)
      : body
  );
}

// =================================
// LANGUAGE PROCESSING
// =================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[?!।,،;:ঃ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "আমি", "আমার", "আমাকে", "আমরা",
  "তুমি", "তোমার", "তোমাকে", "তোমরা",
  "কি", "কী", "কেন", "কিভাবে",
  "কেমন", "কোন", "কোথায়", "কোথায়",
  "কখন", "হলো", "হয়", "হয়",
  "একটি", "একটা", "এর", "ও", "এবং",
  "বলো", "বল", "জানাও", "করো"
]);

function words(text) {
  return normalize(text)
    .match(/[a-z0-9\u0980-\u09ff]+/g)
    ?.filter(w => w.length > 1 && !STOP_WORDS.has(w)) || [];
}

function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));

  if (!A.size || !B.size) return 0;

  let matched = 0;

  for (const word of A) {
    if (B.has(word)) matched++;
  }

  return matched / Math.max(A.size, B.size);
}

// =================================
// KNOWLEDGE MATCHING
// =================================

function findKnowledge(question, rows) {
  const q = normalize(question);

  let best = null;
  let bestScore = 0;

  for (const item of rows) {
    const title = normalize(item.title);
    const content = normalize(item.content);

    let score = similarity(q, title);

    // শিরোনামের সঙ্গে প্রশ্নের সরাসরি মিল
    if (q === title) score = 1;

    // নাম ও পরিচয় সংক্রান্ত প্রশ্ন
    const asksName =
      /নাম|পরিচয়/.test(title) &&
      /নাম|পরিচয়|তুমি কে|তোমাকে কি বলে/.test(q);

    if (asksName) score = Math.max(score, 0.9);

    // তথ্যের বিষয়বস্তুর সঙ্গে মিল
    const contentScore = similarity(q, content);

    score = Math.max(score, contentScore * 0.8);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.25 ? best : null;
}

// =================================
// SENTENCE GENERATOR
// =================================

const responseCycle = new Map();

function generateSentences(question, item) {
  const title = normalize(item.title);
  const content = String(item.content).trim();

  // পরিচয় ও নাম
  if (/নাম|পরিচয়/.test(title)) {
    return [
      "আমার নাম " + content + "।",
      "আমি " + content + "।",
      "আমাকে " + content + " বলে ডাকতে পারো।",
      "তুমি আমাকে " + content + " নামেই চিনতে পারো।",
      "আমার পরিচয় হলো " + content + "।"
    ];
  }

  // সাধারণ তথ্য
  return [
    content,
    "আমার জানা তথ্য অনুযায়ী, " + content,
    "সহজভাবে বললে, " + content,
    "তোমার প্রশ্নের উত্তর হলো, " + content,
    "এই বিষয়ে আমি বলতে পারি, " + content
  ];
}

function generateAnswer(question, item) {
  const answers = generateSentences(question, item);

  const key = item.id || item.title;
  const index = responseCycle.get(key) || 0;

  responseCycle.set(key, index + 1);

  return answers[index % answers.length];
}

// =================================
// CHAT ENGINE
// =================================

function localAnswer(question, rows) {
  const q = normalize(question);

  if (!q) return "একটু বিস্তারিত লিখবে?";

  // পরিচয়
  if (/তোমার নাম|তুমি কে|তোমার পরিচয়/.test(q)) {
    const item = rows.find(x =>
      /নাম|পরিচয়/.test(normalize(x.title))
    );

    if (item) return generateAnswer(q, item);

    return "আমি NovaDeskAI, তোমার ডিজিটাল সহকারী।";
  }

  // শুভেচ্ছা
  if (/হ্যালো|হাই|আসসালামু/.test(q)) {
    return "হ্যালো! তোমার সঙ্গে কথা বলতে ভালো লাগছে। কী জানতে চাও?";
  }

  // সময়
  if (/সময়|কয়টা বাজে|কটা বাজে/.test(q)) {
    return "সার্ভারের বর্তমান সময়: " +
      new Date().toLocaleString("bn-BD", {
        timeZone: "Asia/Dhaka"
      });
  }

  // শেখানো তথ্য খোঁজা
  const item = findKnowledge(question, rows);

  if (item) {
    return generateAnswer(question, item);
  }

  return "এই বিষয়ে আমার শেখানো তথ্য এখনো নেই। তুমি AI Training থেকে আমাকে শেখাতে পারো।";
}

// =================================
// REQUEST BODY
// =================================

async function bodyJSON(req) {
  let data = "";

  for await (const chunk of req) {
    data += chunk;

    if (data.length > 1e6) {
      throw new Error("Request too large");
    }
  }

  return data ? JSON.parse(data) : {};
}

// =================================
// WEB SEARCH
// =================================

async function searchWeb(q) {
  const url =
    "https://html.duckduckgo.com/html/?q=" +
    encodeURIComponent(q);

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    10000
  );

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 NovaDesk/1.0"
      },
      signal: controller.signal
    });

    if (!r.ok) throw new Error("Search service error");

    const html = await r.text();
    const results = [];

    const re =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;

    while ((match = re.exec(html)) && results.length < 6) {
      const clean = s =>
        s.replace(/<[^>]*>/g, "")
         .replace(/&amp;/g, "&")
         .replace(/&quot;/g, '"')
         .replace(/&#x27;/g, "'")
         .trim();

      results.push({
        url: match[1],
        title: clean(match[2]),
        snippet: clean(match[3])
      });
    }

    return results;

  } finally {
    clearTimeout(timer);
  }
}

// =================================
// SERVER
// =================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  const u = new URL(req.url, "http://localhost");

  try {

    // HEALTH
    if (u.pathname === "/api/health") {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: "Sentence Generator 1.0"
      });
    }

    // GET KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, readDB());
    }

    // SAVE KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "POST") {
      const b = await bodyJSON(req);

      if (!String(b.title || "").trim() ||
          !String(b.content || "").trim()) {
        return send(res, 400, {
          error: "শিরোনাম ও তথ্য লিখুন"
        });
      }

      const rows = readDB();

      const item = {
        id: Date.now().toString(36) +
          Math.random().toString(36).slice(2, 7),

        title: String(b.title).slice(0, 160),
        content: String(b.content).slice(0, 5000),
        createdAt: new Date().toISOString()
      };

      rows.push(item);
      writeDB(rows);

      return send(res, 201, item);
    }

    // DELETE KNOWLEDGE
    if (u.pathname.startsWith("/api/knowledge/") &&
        req.method === "DELETE") {

      const id = decodeURIComponent(
        u.pathname.split("/").pop()
      );

      writeDB(
        readDB().filter(x => x.id !== id)
      );

      return send(res, 200, { ok: true });
    }

    // CHAT
    if (u.pathname === "/api/chat" && req.method === "POST") {
      const b = await bodyJSON(req);

      const q = String(b.message || "").slice(0, 1000);

      if (!q.trim()) {
        return send(res, 400, {
          error: "প্রশ্ন লিখুন"
        });
      }

      const answer = localAnswer(q, readDB());

      return send(res, 200, {
        answer,
        mode: "Nova Sentence Generator 1.0",
        learned: true
      });
    }

    // WEB SEARCH
    if (u.pathname === "/api/search" && req.method === "GET") {
      const q = (u.searchParams.get("q") || "").slice(0, 200);

      if (!q.trim()) {
        return send(res, 400, {
          error: "সার্চের বিষয় লিখুন"
        });
      }

      const results = await searchWeb(q);

      return send(res, 200, {
        query: q,
        results,
        note: "ফলাফল DuckDuckGo সার্চ থেকে এসেছে।"
      });
    }

    // STATIC FILES
    const requested =
      u.pathname === "/" ? "index.html" :
      decodeURIComponent(u.pathname.slice(1));

    const publicDir = path.resolve(__dirname, "public");
    const file = path.resolve(publicDir, requested);

    if (!file.startsWith(publicDir + path.sep)) {
      return send(res, 403, { error: "Forbidden" });
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        return send(
          res, 404, "Not found",
          "text/plain; charset=utf-8"
        );
      }

      const ext = path.extname(file);

      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8"
      };

      send(
        res,
        200,
        data.toString("utf8"),
        types[ext] || "application/octet-stream"
      );
    });

  } catch (e) {
    send(res, 500, {
      error: "সার্ভার সমস্যা",
      detail: e.message
    });
  }
});

server.listen(PORT, () => {
  console.log("NovaDesk running on port " + PORT);
});
