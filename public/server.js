
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const TOKEN_FILE = path.join(DATA_DIR, "google-token.json");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET;

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

function loadKnowledge() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

    if (!Array.isArray(data)) {
      throw new Error("Knowledge database is not an array");
    }

    return data;
  } catch (error) {
    console.error("DATABASE ERROR:", error);
    throw new Error(
      "Knowledge database could not be loaded. Original file preserved."
    );
  }
}

let knowledge = loadKnowledge();

function createLocalBackup() {
  if (!fs.existsSync(DB_FILE)) return null;

  const filename =
    "knowledge-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".json";

  const destination = path.join(BACKUP_DIR, filename);

  fs.copyFileSync(DB_FILE, destination);

  return filename;
}

function saveKnowledge() {
  const temporaryFile = DB_FILE + ".tmp";

  try {
    createLocalBackup();

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(knowledge, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );

    fs.renameSync(temporaryFile, DB_FILE);
  } catch (error) {
    if (fs.existsSync(temporaryFile)) {
      fs.unlinkSync(temporaryFile);
    }

    throw error;
  }
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

function redirect(res, destination) {
  res.writeHead(302, { Location: destination });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let failed = false;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > 20 * 1024 * 1024) {
        failed = true;
        reject(new Error("Request too large. Maximum 20 MB."));
        req.resume();
        return;
      }

      if (!failed) body += chunk;
    });

    req.on("end", () => {
      if (failed) return;

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
  "এবং", "আর", "তাহলে"
]);

function words(text) {
  return normalize(text)
    .split(" ")
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;

  const set = new Set(b);
  let matches = 0;

  for (const word of new Set(a)) {
    if (set.has(word)) matches++;
  }

  return matches / Math.max(1, Math.min(
    new Set(a).size,
    new Set(b).size
  ));
}

function finishSentence(text) {
  text = String(text || "").trim();

  if (!text) return "";

  if (!/[।.!?]$/.test(text)) text += "।";

  return text;
}

// Improved knowledge matching
function findKnowledge(question) {
  const normalizedQuestion = normalize(question);
  const queryWords = words(question);

  if (!normalizedQuestion) return null;

  // Exact title match first
  const exact = knowledge.find(item =>
    normalize(item.title) === normalizedQuestion
  );

  if (exact) return exact;

  if (!queryWords.length) return null;

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const item of knowledge) {
    const titleWords = words(item.title);
    const contentWords = words(item.content);

    const titleScore = overlap(queryWords, titleWords);
    const contentScore = overlap(queryWords, contentWords);

    const uniqueQuery = new Set(queryWords);
    const uniqueTitle = new Set(titleWords);

    let matched = 0;

    for (const word of uniqueQuery) {
      if (uniqueTitle.has(word)) matched++;
    }

    const coverage =
      matched / Math.max(1, uniqueQuery.size);

    let score =
      titleScore * 0.55 +
      coverage * 0.40 +
      contentScore * 0.05;

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = item;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  // Avoid weak and ambiguous matches
  if (bestScore < 0.65) return null;
  if (bestScore - secondScore < 0.08) return null;

  return best;
}

function generateAnswer(question, item) {
  if (!item) {
    return "এই বিষয়ে আমাকে এখনো শেখানো হয়নি। AI Training থেকে তথ্যটি শেখাতে পারো।";
  }

  return finishSentence(item.content);
}

function localAnswer(question) {
  const q = normalize(question);

  if (!q) {
    return "তুমি কী জানতে চাও? আমাকে একটি প্রশ্ন করো।";
  }

  if (q.includes("আসসালামু") || q.includes("সালাম")) {
    return "ওয়ালাইকুম আসসালাম! কেমন আছো?";
  }

  if (q.includes("তোমার নাম") || q.includes("তুমি কে")) {
    return "আমি NovaDesk AI। আমি শেখানো তথ্য ও নিজস্ব নিয়মের সাহায্যে উত্তর তৈরি করি।";
  }

  if (q.includes("কেমন আছ")) {
    return "আমি ভালো আছি! তুমি কেমন আছো?";
  }

  if (q.includes("ধন্যবাদ")) {
    return "তোমাকে স্বাগতম!";
  }

  if (q.includes("সময়") || q.includes("সময়")) {
    return "এখনকার সময়: " +
      new Date().toLocaleTimeString("bn-BD");
  }

  const item = findKnowledge(question);

  if (item) return generateAnswer(question, item);

  return "এই বিষয়ে আমার শেখানো তথ্য এখনো নেই। AI Training থেকে আমাকে শেখাতে পারো।";
}

// Bulk training parser
function parseTrainingText(text) {
  const blocks = String(text || "")
    .split(/\n\s*\n/)
    .filter(Boolean);

  const items = [];

  for (const block of blocks) {
    const q = block.match(/প্রশ্ন\s*[:：]\s*(.+)/i);
    const a = block.match(/উত্তর\s*[:：]\s*([\s\S]+)/i);

    if (q && a) {
      items.push({
        title: q[1].trim(),
        content: a[1].trim()
      });
    }
  }

  return items;
}

function addBulkItems(items) {
  let imported = 0;
  let duplicates = 0;
  let invalid = 0;

  const existing = new Map();

  for (const item of knowledge) {
    const key = normalize(item.title);
    if (key && !existing.has(key)) existing.set(key, item);
  }

  const conflicts = [];

  for (const raw of items) {
    const title = String(raw.title || raw.question || "").trim();
    const content = String(raw.content || raw.answer || "").trim();

    if (!title || !content) {
      invalid++;
      continue;
    }

    const key = normalize(title);

    if (existing.has(key)) {
      duplicates++;

      const old = existing.get(key);

      if (normalize(old.content) !== normalize(content)) {
        conflicts.push({
          question: title,
          message: "এই প্রশ্নের জন্য আগে থেকেই অন্য উত্তর রয়েছে। পুরোনো উত্তর রাখা হয়েছে।"
        });
      }

      continue;
    }

    const item = {
      id: crypto.randomUUID(),
      title,
      content,
      createdAt: new Date().toISOString()
    };

    knowledge.push(item);
    existing.set(key, item);
    imported++;
  }

  return { imported, duplicates, invalid, conflicts };
}

// Google Drive OAuth
const oauthStates = new Map();

function driveConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REDIRECT_URI &&
    OAUTH_STATE_SECRET
  );
}

function saveTokens(tokens) {
  let previous = {};

  if (fs.existsSync(TOKEN_FILE)) {
    try {
      previous = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch {}
  }

  const combined = {
    ...previous,
    ...tokens,
    refresh_token:
      tokens.refresh_token || previous.refresh_token
  };

  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(combined, null, 2),
    { encoding: "utf8", mode: 0o600 }
  );
}

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;

    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function isDriveConnected() {
  const tokens = loadTokens();
  return Boolean(tokens && tokens.refresh_token);
}

function createOAuthState() {
  const state = crypto.randomBytes(32).toString("hex");

  oauthStates.set(state, Date.now());

  return state;
}

function verifyOAuthState(state) {
  const created = oauthStates.get(state);

  if (!created) return false;

  oauthStates.delete(state);

  return Date.now() - created < 10 * 60 * 1000;
}

function googleConnectURL() {
  const state = createOAuthState();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state
  });

  return "https://accounts.google.com/o/oauth2/v2/auth?" +
    params.toString();
}

async function exchangeGoogleCode(code) {
  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Google OAuth failed");
  }

  saveTokens(data);
  return data;
}

async function getAccessToken() {
  const tokens = loadTokens();

  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google Drive is not connected");
  }

  if (
    tokens.access_token &&
    tokens.expiry_date &&
    Date.now() < tokens.expiry_date - 60000
  ) {
    return tokens.access_token;
  }

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Token refresh failed");
  }

  saveTokens({
    ...data,
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000
  });

  return data.access_token;
}

async function driveRequest(url, options = {}) {
  const accessToken = await getAccessToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + accessToken,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error("Google Drive error: " + errorText.slice(0, 1000));
  }

  return response;
}

async function findDriveBackup() {
  const q = encodeURIComponent(
    "name = 'NovaDesk_Backup.json' and trashed = false"
  );

  const url =
    "https://www.googleapis.com/drive/v3/files?q=" +
    q +
    "&fields=files(id,name,modifiedTime)&pageSize=10";

  const response = await driveRequest(url);
  const data = await response.json();

  return data.files && data.files.length
    ? data.files[0]
    : null;
}

async function uploadDriveBackup() {
  if (!isDriveConnected()) {
    throw new Error("Google Drive is not connected");
  }

  const backupData = {
    app: "NovaDesk AI",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    knowledgeCount: knowledge.length,
    knowledge
  };

  const boundary = "novadesk_" + crypto.randomBytes(12).toString("hex");

  const metadata = {
    name: "NovaDesk_Backup.json",
    mimeType: "application/json"
  };

  const body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(backupData) + "\r\n" +
    "--" + boundary + "--";

  const existing = await findDriveBackup();

  const endpoint = existing
    ? "https://www.googleapis.com/upload/drive/v3/files/" +
      existing.id + "?uploadType=multipart"
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const response = await driveRequest(endpoint, {
    method: existing ? "PATCH" : "POST",
    headers: {
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    body
  });

  return await response.json();
}

async function downloadDriveBackup() {
  const file = await findDriveBackup();

  if (!file) {
    throw new Error("Google Drive backup file not found");
  }

  const response = await driveRequest(
    "https://www.googleapis.com/drive/v3/files/" +
    file.id + "?alt=media"
  );

  return await response.json();
}

// Automatic debounced backup
let backupTimer = null;

function scheduleDriveBackup() {
  if (backupTimer) clearTimeout(backupTimer);

  backupTimer = setTimeout(async () => {
    if (!isDriveConnected()) return;

    try {
      const result = await uploadDriveBackup();
      console.log("Automatic Drive backup completed:", result.id);
    } catch (error) {
      console.error("Automatic Drive backup failed:", error.message);
    }
  }, 15000);
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
  const requestedPath =
    pathname === "/" ? "index.html" : pathname.slice(1);

  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  const publicRoot = path.resolve(PUBLIC_DIR) + path.sep;

  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexFile = path.join(PUBLIC_DIR, "index.html");

    if (!fs.existsSync(indexFile)) {
      res.writeHead(404);
      return res.end("File not found");
    }

    return serveFile(res, indexFile);
  }

  serveFile(res, filePath);
}

function serveFile(res, filePath) {
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
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = await response.text();
    const results = [];

    const regex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null && results.length < 8) {
      const clean = value =>
        value.replace(/<[^>]*>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

      results.push({
        title: clean(match[2]),
        url: match[1]
      });
    }

    return results;
  } catch (error) {
    console.error("Search error:", error.message);
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

  let pathname;

  try {
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch {
    return send(res, 400, { ok: false, error: "Invalid URL" });
  }

  try {
    // Health
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: "NovaDesk Natural Language Engine 5.1",
        knowledgeCount: knowledge.length,
        driveConfigured: driveConfigured(),
        driveConnected: isDriveConnected()
      });
    }

    // Knowledge list
    if (pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        knowledge
      });
    }

    // Add one item
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

      const duplicate = knowledge.find(
        item => normalize(item.title) === normalize(title)
      );

      if (duplicate) {
        return send(res, 409, {
          ok: false,
          error: "এই প্রশ্নটি আগে থেকেই শেখানো আছে।",
          item: duplicate
        });
      }

      const item = {
        id: crypto.randomUUID(),
        title,
        content,
        createdAt: new Date().toISOString()
      };

      knowledge.push(item);
      saveKnowledge();
      scheduleDriveBackup();

      return send(res, 200, {
        ok: true,
        message: "তথ্য সফলভাবে শেখানো হয়েছে।",
        item,
        knowledgeCount: knowledge.length
      });
    }

    // Bulk training
    if (pathname === "/api/knowledge/bulk" && req.method === "POST") {
      const body = await readBody(req);

      let items = [];

      if (Array.isArray(body.items)) {
        items = body.items;
      } else if (Array.isArray(body.knowledge)) {
        items = body.knowledge;
      } else if (typeof body.text === "string") {
        items = parseTrainingText(body.text);
      } else {
        return send(res, 400, {
          ok: false,
          error: "items অথবা text দিতে হবে।"
        });
      }

      const result = addBulkItems(items);

      if (result.imported > 0) {
        saveKnowledge();
        scheduleDriveBackup();
      }

      return send(res, 200, {
        ok: true,
        message: "Bulk training completed",
        ...result,
        knowledgeCount: knowledge.length
      });
    }

    // Export knowledge
    if (pathname === "/api/knowledge/export" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        exportedAt: new Date().toISOString(),
        knowledgeCount: knowledge.length,
        knowledge
      });
    }

    // Delete knowledge
    if (
      pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
      const id = pathname.slice("/api/knowledge/".length);

      const oldLength = knowledge.length;

      knowledge = knowledge.filter(item => item.id !== id);

      if (knowledge.length === oldLength) {
        return send(res, 404, {
          ok: false,
          error: "তথ্যটি পাওয়া যায়নি।"
        });
      }

      saveKnowledge();
      scheduleDriveBackup();

      return send(res, 200, {
        ok: true,
        message: "তথ্য মুছে ফেলা হয়েছে।",
        knowledgeCount: knowledge.length
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
        mode: "NovaDesk Natural Language Engine 5.1"
      });
    }

    // Google Drive connection
    if (pathname === "/api/drive/connect" && req.method === "GET") {
      if (!driveConfigured()) {
        return send(res, 400, {
          ok: false,
          error: "Google OAuth Environment Variables missing"
        });
      }

      return redirect(res, googleConnectURL());
    }

    // Google OAuth callback
    if (pathname === "/api/drive/callback" && req.method === "GET") {
      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      const oauthError = parsedUrl.searchParams.get("error");

      if (oauthError) {
        return send(res, 400, {
          ok: false,
          error: "Google authorization failed: " + oauthError
        });
      }

      if (!code || !state || !verifyOAuthState(state)) {
        return send(res, 400, {
          ok: false,
          error: "Invalid or expired OAuth state"
        });
      }

      await exchangeGoogleCode(code);

      return redirect(res, "/?drive=connected");
    }

    // Drive status
    if (pathname === "/api/drive/status" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        configured: driveConfigured(),
        connected: isDriveConnected()
      });
    }

    // Manual Drive backup
    if (pathname === "/api/drive/backup" && req.method === "POST") {
      if (!isDriveConnected()) {
        return send(res, 400, {
          ok: false,
          error: "আগে Google Drive Connect করো।"
        });
      }

      const result = await uploadDriveBackup();

      return send(res, 200, {
        ok: true,
        message: "Google Drive backup successful",
        fileId: result.id,
        knowledgeCount: knowledge.length
      });
    }

    // Safe Drive restore: merge only, never replace
    if (pathname === "/api/drive/restore" && req.method === "POST") {
      if (!isDriveConnected()) {
        return send(res, 400, {
          ok: false,
          error: "আগে Google Drive Connect করো।"
        });
      }

      const backup = await downloadDriveBackup();

      if (!backup || !Array.isArray(backup.knowledge)) {
        return send(res, 400, {
          ok: false,
          error: "Drive backup format is invalid"
        });
      }

      // Save current data before restore
      const localBackup = createLocalBackup();

      const result = addBulkItems(backup.knowledge);

      if (result.imported > 0) {
        saveKnowledge();
      }

      return send(res, 200, {
        ok: true,
        message: "Restore merge completed. Existing local data was preserved.",
        localBackup,
        ...result,
        knowledgeCount: knowledge.length
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
