
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const ENGINE = "NovaDesk Natural Language Engine 5.1";

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

// ================= DATABASE =================

function readDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Database error:", error);
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

// ================= RESPONSE =================

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  if (type.startsWith("application/json")) {
    res.end(JSON.stringify(body));
  } else {
    res.end(body);
  }
}

// ================= LANGUAGE PROCESSING =================

const STOP_WORDS = new Set([
  "কি", "কী", "কে", "কেন", "কখন",
  "কিভাবে", "কীভাবে", "কোথায়", "কোথায়",
  "নাম", "বল", "বলো", "জানাও",
  "হলো", "হল", "হয়", "হয়",
  "এর", "র", "টা", "টি", "একটি",
  "আমার", "তোমার", "আপনার",
  "এটা", "সেটা", "এই", "সেই",
  "এবং", "আর", "তাহলে"
]);

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/য়/g, "য়")
    .replace(/[?？!！।,،.ঃ:;'"“”‘’()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const suffixes = [
  "গুলো", "গুলি", "সমূহ",
  "য়ের", "ের", "দের",
  "কে", "তে", "টা", "টি",
  "রা", "ে", "য়", "র"
];

function stem(word) {
  for (const suffix of suffixes) {
    if (
      word.length > suffix.length + 2 &&
      word.endsWith(suffix)
    ) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function words(text) {
  return normalize(text)
    .match(/[a-z0-9\u0980-\u09ff]+/g) || [];
}

function meaningfulWords(text) {
  return words(text)
    .map(stem)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function overlap(a, b) {
  const A = new Set(meaningfulWords(a));
  const B = new Set(meaningfulWords(b));

  if (!A.size || !B.size) return 0;

  let matches = 0;

  for (const word of A) {
    if (B.has(word)) matches++;
  }

  return matches / A.size;
}

function finishSentence(text) {
  text = String(text || "").trim();

  if (!text) return "";

  if (!/[।.!?]$/.test(text)) {
    text += "।";
  }

  return text;
}

// ================= IDENTITY UNDERSTANDING 5.1 =================

function identityAnswer(question) {
  const q = normalize(question);

  // NovaDesk নিজের নাম সম্পর্কে প্রশ্ন
  const nameQuestions = [
    /^তোমার নাম(টা)? (কি|কী)$/,
    /^তুমি কে$/,
    /^তোমার পরিচয় (কি|কী)$/,
    /^তোমাকে কি নামে ডাকা হয়$/,
    /^তোমাকে কী নামে ডাকা হয়$/,
    /^তোমার নাম বলো$/,
    /^তোমার নাম জানাও$/,
    /^নিজের নাম বলো$/
  ];

  if (nameQuestions.some(pattern => pattern.test(q))) {
    return "আমার নাম NovaDesk AI।";
  }

  // NovaDesk AI নামটি কার, তা জানতে চাওয়া
  if (
    /novadesk\s*ai/.test(q) &&
    /কার নাম|কোন নাম/.test(q)
  ) {
    return "NovaDesk AI আমার নাম।";
  }

  if (
    /novadesk\s*ai/.test(q) &&
    /(এটা|ইহা|নাম)/.test(q) &&
    /(তোমার|আপনার)/.test(q)
  ) {
    return "NovaDesk AI আমার নাম।";
  }

  // ব্যবহারকারীর নাম জানতে চাওয়া
  if (
    /^আমার নাম (কি|কী)$/.test(q) ||
    /^আমি কে$/.test(q) ||
    /^আমার পরিচয় (কি|কী)$/.test(q)
  ) {
    return "তোমার নাম আমি এখনো জানি না। তুমি আমাকে তোমার নাম শেখাতে পারো।";
  }

  return null;
}

// ================= QUESTION TYPE =================

function questionType(question) {
  const q = normalize(question);

  if (/কোথায়|কোন জায়গায়|কোন স্থানে/.test(q)) {
    return "location";
  }

  if (/কখন|কোন সময়ে/.test(q)) {
    return "time";
  }

  if (/কেন/.test(q)) {
    return "reason";
  }

  if (/কিভাবে|কীভাবে/.test(q)) {
    return "method";
  }

  if (/কে\b/.test(q)) {
    return "person";
  }

  return "general";
}

// ================= KNOWLEDGE MATCHING =================

function findKnowledge(question, rows) {
  let best = null;
  let bestScore = 0;

  const queryWords = meaningfulWords(question);

  if (!queryWords.length) return null;

  for (const item of rows) {
    const titleScore = overlap(question, item.title);
    const contentScore = overlap(question, item.content);

    const score = Math.max(
      titleScore * 0.85 + contentScore * 0.15,
      contentScore * 0.90 + titleScore * 0.10
    );

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (bestScore < 0.45) return null;

  return best;
}

// ================= ANSWER GENERATION =================

function generateAnswer(question, item) {
  if (!item) {
    return "এই বিষয়ে আমাকে এখনো শেখানো হয়নি। AI Training থেকে তথ্যটি শেখালে আমি পরে সেটি ব্যবহার করতে পারব।";
  }

  const title = String(item.title || "").trim();
  const content = String(item.content || "").trim();

  if (!title || !content) {
    return content || title;
  }

  const type = questionType(question);

  if (type === "location") {
    const locationWords = [
      "পুকুর", "বিল", "হাওর", "জলাশয়",
      "নদী", "সাগর", "সমুদ্র", "দেশে",
      "গ্রামে", "শহরে", "এলাকায়",
      "জন্মায়", "অবস্থিত", "থাকে",
      "বাস", "বসবাস"
    ];

    const hasLocation = locationWords.some(word =>
      normalize(content).includes(normalize(word))
    );

    if (!hasLocation && !normalize(title).includes("কোথায়")) {
      return "এই তথ্যের অবস্থান সম্পর্কে আমাকে এখনো শেখানো হয়নি।";
    }
  }

  const titleScore = overlap(question, title);
  const contentScore = overlap(question, content);

  const isCompleteSentence =
    content.length > 25 &&
    /[।.!?]/.test(content);

  if (isCompleteSentence) {
    return content;
  }

  if (titleScore >= contentScore) {
    return finishSentence(`${title} হলো ${content}`);
  }

  if (contentScore > titleScore) {
    return finishSentence(`${content} হলো ${title}`);
  }

  return finishSentence(content);
}

// ================= CHAT ENGINE =================

function localAnswer(question, rows) {
  const q = normalize(question);

  if (!q) {
    return "তুমি কী জানতে চাও? আমাকে একটি প্রশ্ন করো।";
  }

  // পরিচয় যাচাই সবার আগে
  const identity = identityAnswer(question);

  if (identity) {
    return identity;
  }

  if (
    q.includes("আসসালামু") ||
    q.includes("সালাম")
  ) {
    return "ওয়ালাইকুম আসসালাম! কেমন আছো?";
  }

  if (q.includes("কেমন আছ")) {
    return "আমি ভালো আছি! তুমি কেমন আছো?";
  }

  if (q.includes("ধন্যবাদ")) {
    return "তোমাকে স্বাগতম!";
  }

  if (q.includes("সময়")) {
    return "সার্ভারের বর্তমান সময়: " +
      new Date().toLocaleString("bn-BD", {
        timeZone: "Asia/Dhaka"
      });
  }

  const item = findKnowledge(question, rows);

  if (item) {
    return generateAnswer(question, item);
  }

  return "এই প্রশ্নের নির্ভরযোগ্য উত্তর আমার শেখানো তথ্যে নেই। AI Training-এ বিষয়টি শেখাতে পারো।";
}

// ================= WEB SEARCH =================

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

    if (!r.ok) {
      throw new Error("Search service returned " + r.status);
    }

    const html = await r.text();
    const results = [];

    const regex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;

    while (
      (match = regex.exec(html)) &&
      results.length < 6
    ) {
      const clean = text =>
        text
          .replace(/<[^>]*>/g, "")
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

// ================= REQUEST BODY =================

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

// ================= STATIC FILES =================

function serveStatic(req, res, pathname) {
  const requested =
    pathname === "/" ? "index.html" : pathname.slice(1);

  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(root, requested);

  if (!file.startsWith(root + path.sep)) {
    return send(res, 403, { error: "Forbidden" });
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      return send(
        res,
        404,
        "Not found",
        "text/plain; charset=utf-8"
      );
    }

    const ext = path.extname(file).toLowerCase();

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    send(
      res,
      200,
      data,
      types[ext] || "application/octet-stream"
    );
  });
}

// ================= SERVER =================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  const u = new URL(req.url, "http://localhost");

  try {

    // Health check
    if (
      u.pathname === "/api/health" &&
      req.method === "GET"
    ) {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: ENGINE,
        knowledgeCount: readDB().length
      });
    }

    // Get training data
    if (
      u.pathname === "/api/knowledge" &&
      req.method === "GET"
    ) {
      return send(res, 200, readDB());
    }

    // Save training data
    if (
      u.pathname === "/api/knowledge" &&
      req.method === "POST"
    ) {
      const b = await bodyJSON(req);

      const title = String(b.title || "").trim();
      const content = String(b.content || "").trim();

      if (!title || !content) {
        return send(res, 400, {
          error: "শিরোনাম ও তথ্য লিখুন"
        });
      }

      const rows = readDB();

      const item = {
        id: Date.now().toString(36) +
          Math.random().toString(36).slice(2, 7),
        title: title.slice(0, 160),
        content: content.slice(0, 5000),
        createdAt: new Date().toISOString()
      };

      rows.push(item);
      writeDB(rows);

      return send(res, 201, item);
    }

    // Delete training data
    if (
      u.pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
      const id = decodeURIComponent(
        u.pathname.split("/").pop()
      );

      const rows = readDB();
      const updated = rows.filter(x => x.id !== id);

      if (updated.length === rows.length) {
        return send(res, 404, {
          ok: false,
          error: "তথ্য পাওয়া যায়নি"
        });
      }

      writeDB(updated);

      return send(res, 200, {
        ok: true,
        message: "তথ্য মুছে ফেলা হয়েছে"
      });
    }

    // Chat
    if (
      u.pathname === "/api/chat" &&
      req.method === "POST"
    ) {
      const b = await bodyJSON(req);
      const q = String(b.message || "").slice(0, 1000);

      const reply = localAnswer(q, readDB());

      return send(res, 200, {
        ok: true,
        reply,
        answer: reply,
        mode: ENGINE
      });
    }

    // Web search
    if (
      u.pathname === "/api/search" &&
      req.method === "GET"
    ) {
      const q = (
        u.searchParams.get("q") || ""
      ).slice(0, 200);

      if (!q.trim()) {
        return send(res, 400, {
          error: "সার্চের বিষয় লিখুন"
        });
      }

      const results = await searchWeb(q);

      return send(res, 200, {
        ok: true,
        query: q,
        results,
        note: "ফলাফল DuckDuckGo সার্চ থেকে এসেছে।"
      });
    }

    // Website
    if (
      !u.pathname.startsWith("/api/") &&
      req.method === "GET"
    ) {
      return serveStatic(req, res, u.pathname);
    }

    return send(res, 404, {
      error: "API route পাওয়া যায়নি"
    });

  } catch (error) {
    console.error("Server error:", error);

    return send(res, 500, {
      ok: false,
      error: "সার্ভার সমস্যা",
      detail: error.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `NovaDesk ${ENGINE} running on port ${PORT}`
  );
});
