
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
  "কি", "কী", "কেন", "কিভাবে", "কেমন",
  "কোন", "কোথায়", "কোথায়", "কখন",
  "হলো", "হয়", "হয়", "হবে", "ছিল",
  "একটি", "একটা", "এর", "ও", "এবং",
  "বলো", "বল", "জানাও", "করো", "দাও",
  "নাকি", "তাহলে", "সম্পর্কে", "নাম",
  "জানতে", "চাই", "বুঝিয়ে", "বুঝাও"
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

    if (q === title) score = 1;

    // শিরোনাম সরাসরি প্রশ্নের মধ্যে থাকলে
    if (title && q.includes(title)) {
      score = Math.max(score, 0.95);
    }

    // প্রশ্নের গুরুত্বপূর্ণ শব্দ শিরোনামে থাকলে
    const titleWords = words(title);
    const questionWords = words(q);

    if (titleWords.length && questionWords.length) {
      const matched = titleWords.filter(w =>
        questionWords.includes(w)
      ).length;

      const titleMatch = matched / titleWords.length;

      score = Math.max(score, titleMatch * 0.9);
    }

    // বিষয়বস্তুর সঙ্গে মিল
    const contentScore = similarity(q, content);
    score = Math.max(score, contentScore * 0.65);

    // নাম ও পরিচয়
    if (
      /নাম|পরিচয়/.test(title) &&
      /নাম|পরিচয়|তুমি কে|তোমাকে কি বলে/.test(q)
    ) {
      score = Math.max(score, 0.95);
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.35 ? best : null;
}

// =================================
// SENTENCE GENERATOR
// =================================

const responseCycle = new Map();

function cleanSentence(text) {
  return String(text || "")
    .trim()
    .replace(/[।.!?]+$/g, "")
    .trim();
}

function makeSentence(title, content) {
  const t = cleanSentence(title);
  const c = cleanSentence(content);

  if (!c) return "";

  // তথ্যটি আগে থেকেই পূর্ণ বাক্য হলে
  const contentWords = words(c);
  const titleWords = words(t);

  const startsLikeTitle =
    titleWords.length > 0 &&
    titleWords.every(w => contentWords.includes(w));

  if (startsLikeTitle) {
    return c + "।";
  }

  // শিরোনাম ও তথ্য দিয়ে নতুন বাক্য
  return t + " হলো " + c + "।";
}

function generateSentences(question, item) {
  const title = cleanSentence(item.title);
  const content = cleanSentence(item.content);

  const q = normalize(question);
  const t = normalize(title);

  const answers = [];

  // নাম ও পরিচয়ের উত্তর
  if (/নাম|পরিচয়/.test(t)) {
    answers.push(
      "আমার নাম " + content + "।",
      "আমি " + content + "।",
      "আমাকে " + content + " বলে ডাকতে পারো।",
      "আমার পরিচয় হলো " + content + "।"
    );

    return answers;
  }

  // শিরোনাম থেকে তথ্যভিত্তিক বাক্য
  const mainSentence = makeSentence(title, content);

  answers.push(
    mainSentence,
    "আমার শেখা তথ্য অনুযায়ী, " + mainSentence,
    "সহজভাবে বললে, " + mainSentence,
    "তোমার প্রশ্নের উত্তর হলো, " + mainSentence
  );

  // প্রশ্নের ধরন অনুযায়ী অতিরিক্ত উত্তর
  if (/কী|কি|কোন|কে|নাম/.test(q)) {
    answers.push(
      title + " সম্পর্কে জানতে চেয়েছ। উত্তর হলো " +
      content + "।"
    );
  }

  if (/বলো|জানাও|বুঝাও|ব্যাখ্যা/.test(q)) {
    answers.push(
      "অবশ্যই! " + mainSentence
    );
  }

  return [...new Set(answers)];
}

function generateAnswer(question, item) {
  const answers = generateSentences(question, item);

  if (!answers.length) {
    return String(item.content || "উত্তর পাওয়া যায়নি।");
  }

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

  if (!q) {
    return "একটু বিস্তারিত লিখবে?";
  }

  // পরিচয়
  if (/তোমার নাম|তুমি কে|তোমার পরিচয়/.test(q)) {
    const item = rows.find(x =>
      /নাম|পরিচয়/.test(normalize(x.title))
    );

    if (item) {
      return generateAnswer(q, item);
    }

    return "আমি NovaDesk AI, তোমার ডিজিটাল সহকারী।";
  }

  // শুভেচ্ছা
  if (/হ্যালো|হাই|আসসালামু/.test(q)) {
    return "ওয়ালাইকুম আসসালাম! কেমন আছো? কী বিষয়ে কথা বলতে চাও?";
  }

  // সময়
  if (/সময়|কয়টা বাজে|কটা বাজে/.test(q)) {
    return "বাংলাদেশের বর্তমান সময়: " +
      new Date().toLocaleString("bn-BD", {
        timeZone: "Asia/Dhaka"
      });
  }

  // শেখানো তথ্য খোঁজা
  const item = findKnowledge(question, rows);

  if (item) {
    return generateAnswer(question, item);
  }

  return "এই বিষয়ে আমার শেখানো তথ্য এখনো নেই। তুমি AI Training থেকে আমাকে এই বিষয়টি শেখাতে পারো।";
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

    if (!r.ok) {
      throw new Error("Search service error");
    }

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
        ai: "Sentence Generator 2.0"
      });
    }

    // GET KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, readDB());
    }

    // SAVE KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "POST") {
      const b = await bodyJSON(req);

      if (
        !String(b.title || "").trim() ||
        !String(b.content || "").trim()
      ) {
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
    if (
      u.pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
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
        mode: "Nova Sentence Generator 2.0",
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
          res,
          404,
          "Not found",
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("NovaDesk running on port " + PORT);
});
