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

// =====================================
// DATABASE ENGINE
// =====================================

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

// =====================================
// HTTP RESPONSE
// =====================================

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  if (status === 204) return res.end();

  res.end(
    type.startsWith("application/json")
      ? JSON.stringify(data)
      : data
  );
}

// =====================================
// LANGUAGE NORMALIZATION
// =====================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/য়/g, "য়")
    .replace(/[?!।,،;:ঃ"“”'‘’()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "আমি", "আমার", "আমাকে", "আমরা", "আমাদের",
  "তুমি", "তোমার", "তোমাকে", "তোমরা",
  "আপনি", "আপনার", "আমাকে",
  "কি", "কী", "কেন", "কিভাবে", "কেমন",
  "কোন", "কোথায়", "কোথায়", "কখন",
  "হলো", "হয়", "হয়", "হবে", "ছিল",
  "একটি", "একটা", "এর", "ও", "এবং",
  "বলো", "বল", "জানাও", "করো", "দাও",
  "নাকি", "তাহলে", "সম্পর্কে", "নাম",
  "জানতে", "চাই", "বুঝিয়ে", "বুঝাও",
  "হচ্ছে", "করতে", "পারে", "পারো",
  "থেকে", "জন্য", "সাথে", "দিকে",
  "যে", "এই", "সেই", "তার", "তাদের",
  "একটু", "আমারও", "তোমারও"
]);

function words(text) {
  return normalize(text)
    .match(/[a-z0-9\u0980-\u09ff]+/g)
    ?.filter(w => w.length > 1 && !STOP_WORDS.has(w)) || [];
}

// কাছাকাছি অর্থের কিছু প্রচলিত শব্দ
const ALIASES = {
  "জাতীয়": "জাতীয়",
  "জাতীয়": "জাতীয়",
  "পুষ্প": "ফুল",
  "ফ্লাওয়ার": "ফুল",
  "নাম": "পরিচয়",
  "পরিচিতি": "পরিচয়",
  "বাসস্থান": "বাড়ি",
  "গৃহ": "বাড়ি",
  "দেশ": "দেশ",
  "বাংলাদেশের": "বাংলাদেশ",
  "বাংলাদেশে": "বাংলাদেশ",
  "বাংলাদেশ": "বাংলাদেশ",
  "শিখতে": "শেখা",
  "শেখাও": "শেখা",
  "শেখানো": "শেখা"
};

function expandWords(text) {
  const result = new Set(words(text));

  for (const word of [...result]) {
    if (ALIASES[word]) {
      result.add(ALIASES[word]);
    }
  }

  return result;
}

// =====================================
// WORD SIMILARITY ENGINE
// =====================================

function similarity(a, b) {
  const A = expandWords(a);
  const B = expandWords(b);

  if (!A.size || !B.size) return 0;

  let matched = 0;

  for (const word of A) {
    if (B.has(word)) matched++;
  }

  const precision = matched / A.size;
  const recall = matched / B.size;

  return (2 * precision * recall) /
    (precision + recall || 1);
}

function overlapScore(question, text) {
  const q = expandWords(question);
  const t = expandWords(text);

  if (!q.size || !t.size) return 0;

  let count = 0;

  for (const word of q) {
    if (t.has(word)) count++;
  }

  return count / q.size;
}

// =====================================
// KNOWLEDGE SEARCH ENGINE
// =====================================

function findKnowledge(question, rows) {
  const q = normalize(question);

  let best = null;
  let bestScore = 0;

  for (const item of rows) {
    const title = normalize(item.title);
    const content = normalize(item.content);

    let score = 0;

    // শিরোনামের সঙ্গে মিল
    score += similarity(q, title) * 0.65;

    // বিষয়বস্তুর সঙ্গে মিল
    score += similarity(q, content) * 0.20;

    // প্রশ্নের শব্দ শিরোনামে আছে কি না
    score += overlapScore(q, title) * 0.15;

    // সরাসরি শিরোনাম মিল
    if (q === title) score = 1;

    if (title.length > 2 && q.includes(title)) {
      score = Math.max(score, 0.95);
    }

    // পরিচয় সম্পর্কিত প্রশ্ন
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

  return bestScore >= 0.28 ? best : null;
}

// =====================================
// SENTENCE ENGINE
// =====================================

const responseCycle = new Map();

function cleanSentence(text) {
  return String(text || "")
    .trim()
    .replace(/^[\s।.!?]+|[\s।.!?]+$/g, "")
    .trim();
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[।!?])\s+|\n+/)
    .map(cleanSentence)
    .filter(Boolean);
}

// প্রশ্ন অনুযায়ী সবচেয়ে প্রাসঙ্গিক বাক্য খোঁজা
function rankSentences(question, content) {
  const sentences = splitSentences(content);

  if (!sentences.length) return [];

  const ranked = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: similarity(question, sentence)
  }));

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const useful = ranked.filter(x => x.score > 0);

  if (!useful.length) {
    return sentences.slice(0, 2);
  }

  return useful
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map(x => x.sentence);
}

// বাক্যকে স্বাভাবিকভাবে শেষ করা
function finishSentence(text) {
  const value = cleanSentence(text);

  if (!value) return "";

  if (/[।!?]$/.test(value)) return value;

  return value + "।";
}

// =====================================
// NATURAL RESPONSE GENERATOR
// =====================================

function makeSentence(title, content) {
  const t = cleanSentence(title);
  const c = cleanSentence(content);

  if (!c) return "";

  const titleWords = expandWords(t);
  const contentWords = expandWords(c);

  // তথ্যের মধ্যে শিরোনামের বিষয় আগে থেকেই থাকলে
  const containsTitle = [...titleWords].some(w =>
    contentWords.has(w)
  );

  if (containsTitle || c.length > 90) {
    return finishSentence(c);
  }

  // ছোট তথ্যকে পূর্ণ বাক্যে রূপান্তর
  return finishSentence(t + " হলো " + c);
}

function generateSentences(question, item) {
  const title = cleanSentence(item.title);
  const content = cleanSentence(item.content);
  const q = normalize(question);

  const relevant = rankSentences(question, content);

  const mainSentence = relevant.length
    ? relevant.map(finishSentence).join(" ")
    : makeSentence(title, content);

  if (!mainSentence) return [];

  const answers = [];

  // পরিচয়
  if (/নাম|পরিচয়/.test(normalize(title))) {
    answers.push(
      "আমার নাম " + content + "।",
      "আমি " + content + "।",
      "আমাকে " + content + " বলে ডাকতে পারো।",
      "আমার পরিচয় হলো " + content + "।"
    );

    return [...new Set(answers)];
  }

  // বিভিন্ন ধরনের বাক্য
  answers.push(
    mainSentence,
    "আমার শেখা তথ্য অনুযায়ী, " + mainSentence,
    "সহজভাবে বললে, " + mainSentence,
    "তোমার প্রশ্নের উত্তর হলো, " + mainSentence,
    "অবশ্যই! " + mainSentence
  );

  if (/কেন|কারণ/.test(q)) {
    answers.push(
      "এর কারণ সম্পর্কে আমার শেখা তথ্য হলো: " + mainSentence
    );
  }

  if (/বলো|জানাও|ব্যাখ্যা|বুঝাও/.test(q)) {
    answers.push(
      "বিষয়টি একটু সহজ করে বলি। " + mainSentence
    );
  }

  return [...new Set(answers)];
}

function generateAnswer(question, item) {
  const answers = generateSentences(question, item);

  if (!answers.length) {
    return finishSentence(item.content);
  }

  const key = String(item.id || item.title);
  const index = responseCycle.get(key) || 0;

  responseCycle.set(key, index + 1);

  return answers[index % answers.length];
}

// =====================================
// CONVERSATION ENGINE
// =====================================

function basicConversation(question) {
  const q = normalize(question);

  if (/^(হ্যালো|হাই|হেই|hello|hi)$/.test(q)) {
    return "হ্যালো! আমি NovaDesk AI। তোমার সঙ্গে কথা বলতে প্রস্তুত। কী নিয়ে কথা বলতে চাও?";
  }

  if (/আসসালামু/.test(q)) {
    return "ওয়ালাইকুম আসসালাম! কেমন আছো? আজ কী বিষয়ে কথা বলবে?";
  }

  if (/কেমন আছো|কেমন আছেন|ভালো আছো/.test(q)) {
    return "আমি ভালো আছি! তোমার প্রশ্নের উত্তর দিতে এবং নতুন তথ্য শিখতে প্রস্তুত আছি। তুমি কেমন আছো?";
  }

  if (/ধন্যবাদ|থ্যাংকস|thank you/.test(q)) {
    return "তোমাকে স্বাগতম! তোমার কাজে আসতে পেরে ভালো লাগল।";
  }

  if (/তুমি কি পারো|কি করতে পারো|তোমার কাজ কি/.test(q)) {
    return "আমি শেখানো তথ্য খুঁজে উত্তর দিতে, নতুন তথ্য সংরক্ষণ করতে, সাধারণ কথোপকথন করতে এবং বাক্য সাজিয়ে দিতে পারি।";
  }

  if (/তুমি কে|তোমার নাম|তোমার পরিচয়/.test(q)) {
    return "আমি NovaDesk AI, একটি নিজস্ব নিয়মভিত্তিক ভাষা ও জ্ঞান ইঞ্জিন।";
  }

  if (/সময়|কয়টা বাজে|কটা বাজে/.test(q)) {
    return "বাংলাদেশের বর্তমান সময়: " +
      new Date().toLocaleString("bn-BD", {
        timeZone: "Asia/Dhaka",
        hour: "numeric",
        minute: "numeric"
      });
  }

  return null;
}

// =====================================
// MAIN AI ENGINE
// =====================================

function localAnswer(question, rows) {
  const q = normalize(question);

  if (!q) {
    return "একটু বিস্তারিত লিখবে?";
  }

  // সাধারণ কথোপকথন
  const conversation = basicConversation(q);

  if (conversation) return conversation;

  // শেখানো তথ্য অনুসন্ধান
  const item = findKnowledge(question, rows);

  if (item) {
    return generateAnswer(question, item);
  }

  // অজানা প্রশ্ন
  return "এই বিষয়ে আমার শেখানো তথ্য এখনো পাওয়া যায়নি। তুমি AI Training থেকে বিষয়টি শেখাতে পারো। আমি শেখানো তথ্য ব্যবহার করে উত্তর তৈরি করার চেষ্টা করব।";
}

// =====================================
// REQUEST BODY
// =====================================

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

// =====================================
// WEB SEARCH ENGINE
// =====================================

async function searchWeb(q) {
  const url =
    "https://html.duckduckgo.com/html/?q=" +
    encodeURIComponent(q);

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 NovaDesk/2.0"
      },
      signal: controller.signal
    });

    if (!r.ok) {
      throw new Error("Search service error");
    }

    const html = await r.text();
    const results = [];

    const clean = s =>
      s.replace(/<[^>]*>/g, "")
       .replace(/&amp;/g, "&")
       .replace(/&quot;/g, '"')
       .replace(/&#x27;/g, "'")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .trim();

    const re =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;

    while ((match = re.exec(html)) && results.length < 6) {
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

// =====================================
// SERVER
// =====================================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  const u = new URL(req.url, "http://localhost");

  try {

    // HEALTH CHECK
    if (u.pathname === "/api/health") {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: "Natural Language Engine 3.0",
        features: [
          "Knowledge Search",
          "Word Similarity",
          "Sentence Generation",
          "Context Matching",
          "Natural Responses"
        ]
      });
    }

    // GET KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, readDB());
    }

    // SAVE KNOWLEDGE
    if (u.pathname === "/api/knowledge" && req.method === "POST") {
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

      return send(res, 201, {
        ok: true,
        message: "তথ্য সফলভাবে শেখানো হয়েছে",
        item
      });
    }

    // DELETE KNOWLEDGE
    if (
      u.pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
      const id = decodeURIComponent(
        u.pathname.split("/").pop()
      );

      const rows = readDB();
      const filtered = rows.filter(x => x.id !== id);

      writeDB(filtered);

      return send(res, 200, {
        ok: true,
        deleted: rows.length !== filtered.length
      });
    }

    // CHAT
    if (u.pathname === "/api/chat" && req.method === "POST") {
      const b = await bodyJSON(req);

      const question = String(b.message || "").slice(0, 1000);

      if (!question.trim()) {
        return send(res, 400, {
          error: "প্রশ্ন লিখুন"
        });
      }

      const rows = readDB();
      const answer = localAnswer(question, rows);

      return send(res, 200, {
        ok: true,
        answer,
        reply: answer,
        mode: "Nova Natural Language Engine 3.0",
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

    if (
      file !== publicDir &&
      !file.startsWith(publicDir + path.sep)
    ) {
      return send(res, 403, {
        error: "Forbidden"
      });
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

  } catch (error) {
    console.error("NovaDesk Error:", error);

    send(res, 500, {
      ok: false,
      error: "সার্ভার সমস্যা",
      detail: error.message
    });
  }
});

// =====================================
// START SERVER
// =====================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("NovaDesk Engine 3.0 running on port " + PORT);
});
