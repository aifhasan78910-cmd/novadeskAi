
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

function loadKnowledge() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Knowledge database error:", error);
    return [];
  }
}

let knowledge = loadKnowledge();

function saveKnowledge() {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(knowledge, null, 2),
    "utf8"
  );
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[?？!！।,،.ঃ:;'"“”‘’()[\]{}]/g, " ")
    .replace(/[য়]/g, "য়")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "কি", "কী", "কে", "কেন", "কোথায়", "কোথায়",
  "কখন", "কিভাবে", "কীভাবে", "নাম", "বল",
  "বলো", "হলো", "হল", "হয়", "হয়",
  "এর", "র", "টা", "টি", "একটি",
  "আমার", "তোমার", "আপনার", "এটা",
  "সেটা", "এই", "সেই", "এক", "ও",
  "এবং", "আর", "তাহলে", "কি?"
]);

function words(text) {
  return normalize(text)
    .split(" ")
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

function getOverlap(a, b) {
  if (!a.length || !b.length) return 0;

  const setB = new Set(b);
  let matches = 0;

  for (const word of a) {
    if (setB.has(word)) matches++;
  }

  return matches / Math.max(1, Math.min(a.length, b.length));
}

function finishSentence(text) {
  text = String(text || "").trim();

  if (!text) return "";

  if (!/[।.!?]$/.test(text)) {
    text += "।";
  }

  return text;
}

function findKnowledge(question) {
  const queryWords = words(question);

  if (!queryWords.length) return null;

  let best = null;
  let bestScore = 0;

  for (const item of knowledge) {
    const titleWords = words(item.title);
    const contentWords = words(item.content);

    const titleScore = getOverlap(queryWords, titleWords);
    const contentScore = getOverlap(queryWords, contentWords);

    let score = titleScore * 0.65 + contentScore * 0.35;

    // Exact word match receives extra priority.
    if (
      queryWords.some(word => titleWords.includes(word))
    ) {
      score += 0.20;
    }

    if (
      queryWords.some(word => contentWords.includes(word))
    ) {
      score += 0.25;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.35 ? best : null;
}

function generateAnswer(question, item) {
  if (!item) {
    return "এই বিষয়ে আমাকে এখনো শেখানো হয়নি। AI Training থেকে এই তথ্যটি শেখাতে পারো।";
  }

  const title = String(item.title || "").trim();
  const content = String(item.content || "").trim();

  if (!title || !content) {
    return content || title || "এই তথ্যটি সম্পূর্ণ নয়।";
  }

  const qWords = words(question);
  const titleWords = words(title);
  const contentWords = words(content);

  const titleMatch = getOverlap(qWords, titleWords);
  const contentMatch = getOverlap(qWords, contentWords);

  // Question asks about the title.
  if (titleMatch >= contentMatch) {
    if (content.length < 70 && !/[।.!?]/.test(content)) {
      return finishSentence(`${title} হলো ${content}`);
    }

    return finishSentence(content);
  }

  // Question asks about the entity/value in the content.
  if (contentMatch > titleMatch) {
    if (content.length < 70 && !/[।.!?]/.test(content)) {
      return finishSentence(`${content} হলো ${title}`);
    }

    return finishSentence(content);
  }

  return finishSentence(content);
}

function localAnswer(question) {
  const q = normalize(question);

  if (!q) {
    return "তুমি কী জানতে চাও? আমাকে একটি প্রশ্ন করো।";
  }

  if (
    q.includes("আসসালামু") ||
    q.includes("সালাম")
  ) {
    return "ওয়ালাইকুম আসসালাম! কেমন আছো?";
  }

  if (
    q.includes("তোমার নাম") ||
    q.includes("তুমি কে")
  ) {
    return "আমি NovaDesk AI। আমি শেখানো তথ্য ও নিজস্ব নিয়মের সাহায্যে উত্তর তৈরি করি।";
  }

  if (
    q.includes("কেমন আছ")
  ) {
    return "আমি ভালো আছি! তুমি কেমন আছো?";
  }

  if (
    q.includes("ধন্যবাদ")
  ) {
    return "তোমাকে স্বাগতম!";
  }

  if (
    q.includes("সময়") ||
    q.includes("সময়")
  ) {
    return "এখনকার সময়: " +
      new Date().toLocaleTimeString("bn-BD");
  }

  const item = findKnowledge(question);

  if (item) {
    return generateAnswer(question, item);
  }

  return "এই বিষয়ে আমার শেখানো তথ্য এখনো নেই। তুমি AI Training থেকে আমাকে শেখাতে পারো।";
}

function getMimeType(file) {
  const ext = path.extname(file).toLowerCase();

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  return types[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);

  let filePath = path.resolve(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) &&
      filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("File not found");
  }

  res.writeHead(200, {
    "Content-Type": getMimeType(filePath)
  });

  fs.createReadStream(filePath).pipe(res);
}

async function searchWeb(query) {
  try {
    const url =
      "https://html.duckduckgo.com/html/?q=" +
      encodeURIComponent(query);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await response.text();

    const results = [];
    const regex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null && results.length < 8) {
      const clean = value =>
        value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");

      results.push({
        title: clean(match[2]),
        url: match[1]
      });
    }

    return results;
  } catch (error) {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    return res.end();
  }

  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = decodeURIComponent(parsedUrl.pathname);

  try {
    // Health
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: "NovaDesk Sentence Generator 4.0",
        knowledgeCount: knowledge.length
      });
    }

    // Get knowledge
    if (pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        knowledge
      });
    }

    // Add knowledge
    if (pathname === "/api/knowledge" && req.method === "POST") {
      const body = await readBody(req);

      const title = String(body.title || "").trim();
      const content = String(body.content || "").trim();

      if (!title || !content) {
        return send(res, 400, {
          ok: false,
          error: "শিরোনাম এবং তথ্য দুটোই দিতে হবে।"
        });
      }

      const item = {
        id: Date.now().toString(),
        title,
        content,
        createdAt: new Date().toISOString()
      };

      knowledge.push(item);
      saveKnowledge();

      return send(res, 200, {
        ok: true,
        message: "তথ্য সফলভাবে শেখানো হয়েছে।",
        item
      });
    }

    // Delete knowledge
    if (
      pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
      const id = pathname.split("/").pop();

      const oldLength = knowledge.length;

      knowledge = knowledge.filter(item => item.id !== id);

      if (knowledge.length === oldLength) {
        return send(res, 404, {
          ok: false,
          error: "তথ্যটি পাওয়া যায়নি।"
        });
      }

      saveKnowledge();

      return send(res, 200, {
        ok: true,
        message: "তথ্য মুছে ফেলা হয়েছে।"
      });
    }

    // Chat
    if (pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody(req);
      const message = String(body.message || "").trim();

      if (!message) {
        return send(res, 400, {
          ok: false,
          error: "একটি প্রশ্ন লিখো।"
        });
      }

      const reply = localAnswer(message);

      return send(res, 200, {
        ok: true,
        reply,
        answer: reply,
        mode: "NovaDesk Sentence Generator 4.0"
      });
    }

    // Web search
    if (pathname === "/api/search" && req.method === "GET") {
      const query = parsedUrl.searchParams.get("q") || "";

      if (!query.trim()) {
        return send(res, 400, {
          ok: false,
          error: "সার্চ করার জন্য কিছু লিখো।"
        });
      }

      const results = await searchWeb(query);

      return send(res, 200, {
        ok: true,
        query,
        results
      });
    }

    // Static website
    if (!pathname.startsWith("/api/") && req.method === "GET") {
      return serveStatic(req, res, pathname);
    }

    return send(res, 404, {
      ok: false,
      error: "API route পাওয়া যায়নি।"
    });

  } catch (error) {
    console.error("Server error:", error);

    return send(res, 500, {
      ok: false,
      error: "Server error",
      details: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NovaDesk running on ${HOST}:${PORT}`);
});
