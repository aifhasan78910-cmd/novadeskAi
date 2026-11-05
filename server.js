
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const TOKEN_FILE = path.join(DATA_DIR, "google-tokens.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const ENGINE = "NovaDesk Natural Language Engine 5.4";
const DRIVE_BACKUP_NAME = "NovaDesk_Backup.json";
const MAX_BODY = 20 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, "[]", "utf8");
}

// ================= DATABASE =================

function readDB() {
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error("Knowledge database format is invalid");
  }

  return data;
}

function createLocalBackup() {
  if (!fs.existsSync(DB_FILE)) return null;

  try {
    const current = fs.readFileSync(DB_FILE, "utf8");
    JSON.parse(current);

    const filename =
      "knowledge-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".json";

    const backupPath = path.join(BACKUP_DIR, filename);

    fs.writeFileSync(backupPath, current, "utf8");

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(name => name.endsWith(".json"))
      .map(name => ({
        name,
        time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    for (const old of files.slice(20)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    }

    return backupPath;
  } catch (error) {
    console.error("Local backup failed:", error.message);
    throw error;
  }
}

function writeDB(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Invalid database data");
  }

  createLocalBackup();

  const tempFile = DB_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(rows, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, DB_FILE);
}

// ================= COMMON HELPERS =================

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  if (status === 204) return res.end();

  if (type.startsWith("application/json")) {
    res.end(JSON.stringify(body));
  } else {
    res.end(body);
  }
}

async function bodyJSON(req) {
  let data = "";

  for await (const chunk of req) {
    data += chunk.toString("utf8");

    if (Buffer.byteLength(data, "utf8") > MAX_BODY) {
      throw new Error("Request too large");
    }
  }

  return data ? JSON.parse(data) : {};
}

function makeId() {
  return Date.now().toString(36) +
    crypto.randomBytes(6).toString("hex");
}

function cleanText(value, max = 10000) {
  return String(value || "").trim().slice(0, max);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/য়/g, "য়")
    .replace(/[?？!！।,،.ঃ:;'"“”‘’()[]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ================= LANGUAGE ENGINE =================

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

const SUFFIXES = [
  "গুলো", "গুলি", "সমূহ",
  "য়ের", "ের", "দের",
  "কে", "তে", "টা", "টি",
  "রা", "ে", "য়", "র"
];

function stem(word) {
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }

  return word;
}

function words(text) {
  return normalize(text).match(/[a-z0-9\u0980-\u09ff]+/g) || [];
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

  if (text && !/[।.!?]$/.test(text)) {
    text += "।";
  }

  return text;
}

function identityAnswer(question) {
  const q = normalize(question);

  if (
    /^তোমার নাম(টা)? (কি|কী)$/.test(q) ||
    /^তুমি কে$/.test(q) ||
    /^তোমার পরিচয় (কি|কী)$/.test(q) ||
    /^তোমার নাম বলো$/.test(q) ||
    /^নিজের নাম বলো$/.test(q)
  ) {
    return "আমার নাম NovaDesk AI।";
  }

  if (
    /^আমার নাম (কি|কী)$/.test(q) ||
    /^আমি কে$/.test(q)
  ) {
    return "তোমার নাম আমি এখনো জানি না। তুমি আমাকে তোমার নাম শেখাতে পারো।";
  }

  return null;
}

function questionType(question) {
  const q = normalize(question);

  if (/কোথায়|কোন জায়গায়|কোন স্থানে/.test(q)) return "location";
  if (/কখন|কোন সময়ে/.test(q)) return "time";
  if (/কেন/.test(q)) return "reason";
  if (/কিভাবে|কীভাবে/.test(q)) return "method";

  return "general";
}

function findKnowledge(question, rows) {
  let best = null;
  let bestScore = 0;

  for (const item of rows) {
    const title = overlap(question, item.title);
    const content = overlap(question, item.content);

    const score = Math.max(
      title * 0.85 + content * 0.15,
      content * 0.90 + title * 0.10
    );

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= 0.45 ? best : null;
}

function generateAnswer(question, item) {
  if (!item) {
    return "এই বিষয়ে আমাকে এখনো শেখানো হয়নি। AI Training থেকে তথ্যটি শেখাতে পারো।";
  }

  const title = cleanText(item.title);
  const content = cleanText(item.content);

  if (!title || !content) return content || title;

  if (content.length > 25 && /[।.!?]/.test(content)) {
    return content;
  }

  const titleScore = overlap(question, title);
  const contentScore = overlap(question, content);

  if (titleScore >= contentScore) {
    return finishSentence(`${title} হলো ${content}`);
  }

  return finishSentence(content);
}

function localAnswer(question, rows) {
  const q = normalize(question);

  if (!q) return "তুমি কী জানতে চাও? আমাকে একটি প্রশ্ন করো।";

  const identity = identityAnswer(question);
  if (identity) return identity;

  if (q.includes("আসসালামু") || q.includes("সালাম")) {
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

  return generateAnswer(question, findKnowledge(question, rows));
}

// ================= TRAINING =================

function makeKnowledgeItem(title, content) {
  return {
    id: makeId(),
    title: cleanText(title, 500),
    content: cleanText(content, 10000),
    createdAt: new Date().toISOString()
  };
}

function parseBulkText(input) {
  const text = String(input || "").trim();
  if (!text) return [];

  const blocks = text.split(/\n\s*\n+/);
  const items = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

    let question = "";
    let answer = "";

    for (const line of lines) {
      const q = line.match(
        /^(প্রশ্ন|প্রশ্নটি|Q|Question)\s*[:：-]\s*(.+)$/i
      );

      const a = line.match(
        /^(উত্তর|উত্তরটি|A|Answer)\s*[:：-]\s*(.+)$/i
      );

      if (q) question = q[2].trim();
      else if (a) answer = a[2].trim();
    }

    if (question && answer) {
      items.push({
        title: question,
        content: answer
      });
    } else if (lines.length >= 2) {
      items.push({
        title: lines[0],
        content: lines.slice(1).join("\n")
      });
    }
  }

  return items;
}

function normalizeTrainingItems(input) {
  if (Array.isArray(input)) {
    return input.map(item => ({
      title: cleanText(item.title || item.question, 500),
      content: cleanText(item.content || item.answer, 10000)
    })).filter(item => item.title && item.content);
  }

  return parseBulkText(input);
}

function sameKnowledge(a, b) {
  return normalize(a.title) === normalize(b.title) &&
    normalize(a.content) === normalize(b.content);
}

function mergeKnowledge(existing, incoming) {
  const result = [...existing];
  let added = 0;
  let skipped = 0;

  // দ্রুত Duplicate শনাক্ত করার জন্য Set
  const known = new Set(
    result.map(item =>
      normalize(item.title) + "||" + normalize(item.content)
    )
  );

  for (const item of incoming) {
    if (!item.title || !item.content) {
      skipped++;
      continue;
    }

    const key =
      normalize(item.title) + "||" + normalize(item.content);

    if (known.has(key)) {
      skipped++;
      continue;
    }

    result.push(makeKnowledgeItem(item.title, item.content));
    known.add(key);
    added++;
  }

  return { rows: result, added, skipped };
}

// ================= GOOGLE DRIVE OAUTH =================

function driveConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI &&
    process.env.OAUTH_STATE_SECRET
  );
}

function isDriveConnected() {
  if (!fs.existsSync(TOKEN_FILE)) return false;

  try {
    const tokens = JSON.parse(
      fs.readFileSync(TOKEN_FILE, "utf8")
    );

    return Boolean(tokens.refresh_token);
  } catch {
    return false;
  }
}

function saveTokens(tokens) {
  let previous = {};

  if (fs.existsSync(TOKEN_FILE)) {
    try {
      previous = JSON.parse(
        fs.readFileSync(TOKEN_FILE, "utf8")
      );
    } catch {}
  }

  const saved = {
    ...previous,
    ...tokens,
    refresh_token: tokens.refresh_token || previous.refresh_token
  };

  const temp = TOKEN_FILE + ".tmp";

  fs.writeFileSync(
    temp,
    JSON.stringify(saved, null, 2),
    "utf8"
  );

  fs.renameSync(temp, TOKEN_FILE);
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error("Google Drive এখনো সংযুক্ত করা হয়নি");
  }

  return JSON.parse(
    fs.readFileSync(TOKEN_FILE, "utf8")
  );
}

function makeOAuthState() {
  const payload = Buffer.from(JSON.stringify({
    time: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", process.env.OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function verifyOAuthState(state) {
  if (!state || !driveConfigured()) return false;

  const parts = state.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", process.env.OAUTH_STATE_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    return Number.isFinite(data.time) &&
      Date.now() - data.time < 10 * 60 * 1000 &&
      Date.now() >= data.time &&
      typeof data.nonce === "string";
  } catch {
    return false;
  }
}

function oauthURL() {
  const url = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth"
  );

  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/drive.file"
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", makeOAuthState());

  return url.toString();
}

async function exchangeCode(code) {
  const form = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code"
  });

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.error ||
      "Google authorization failed"
    );
  }

  saveTokens({
    ...data,
    expiry_date:
      Date.now() + (Number(data.expires_in || 3600) * 1000)
  });
}

async function getAccessToken() {
  const tokens = loadTokens();

  if (
    tokens.access_token &&
    tokens.expiry_date &&
    Date.now() < tokens.expiry_date - 60000
  ) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error(
      "Google refresh token পাওয়া যায়নি। আবার Connect করতে হবে।"
    );
  }

  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token"
  });

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.error ||
      "Google token refresh failed"
    );
  }

  saveTokens({
    ...data,
    expiry_date:
      Date.now() + (Number(data.expires_in || 3600) * 1000)
  });

  return data.access_token;
}

async function driveRequest(url, options = {}) {
  const token = await getAccessToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token
    }
  });

  const responseText = await response.text();
  let data;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { message: responseText };
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      data.error_description ||
      "Google Drive request failed: " + response.status
    );
  }

  return data;
}
 
async function findDriveBackup() {
  const query = encodeURIComponent(
    "name = '" + DRIVE_BACKUP_NAME + "' and trashed = false"
  );

  const url =
    "https://www.googleapis.com/drive/v3/files" +
    "?q=" + query +
    "&spaces=drive" +
    "&pageSize=10" +
    "&fields=files(id,name,modifiedTime)";

  const data = await driveRequest(url);
  return data.files?.[0] || null;
}

// ================= GOOGLE DRIVE BACKUP =================

async function uploadDriveBackup() {
  const rows = readDB();

  // খালি ডেটা দিয়ে পুরোনো Backup overwrite করা যাবে না
  if (rows.length === 0) {
    throw new Error(
      "লোকাল Training Data খালি। নিরাপত্তার জন্য Google Drive Backup overwrite করা হয়নি।"
    );
  }

  const backup = {
    app: "NovaDesk",
    version: 1,
    exportedAt: new Date().toISOString(),
    knowledge: rows
  };

  const oldFile = await findDriveBackup();
  const boundary =
    "novadesk_" + crypto.randomBytes(12).toString("hex");

  const metadata = oldFile
    ? {}
    : {
        name: DRIVE_BACKUP_NAME,
        mimeType: "application/json"
      };

  const body =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(backup, null, 2) + "\r\n" +
    "--" + boundary + "--";

  const base = oldFile
    ? "https://www.googleapis.com/upload/drive/v3/files/" + oldFile.id
    : "https://www.googleapis.com/upload/drive/v3/files";

  const url =
    base + "?uploadType=multipart&fields=id,name,modifiedTime";

  return driveRequest(url, {
    method: oldFile ? "PATCH" : "POST",
    headers: {
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    body
  });
}

async function downloadDriveBackup() {
  const file = await findDriveBackup();

  if (!file) {
    throw new Error("Google Drive-এ NovaDesk Backup পাওয়া যায়নি");
  }

  const url =
    "https://www.googleapis.com/drive/v3/files/" +
    file.id +
    "?alt=media";

  const token = await getAccessToken();

  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token
    }
  });

  if (!response.ok) {
    throw new Error("Google Drive Backup ডাউনলোড করা যায়নি");
  }

  const data = await response.json();

  const rows = Array.isArray(data)
    ? data
    : data.knowledge;

  if (!Array.isArray(rows)) {
    throw new Error("Drive Backup-এর তথ্য সঠিক নয়");
  }

  // Restore-এর আগে প্রতিটি রেকর্ড যাচাই
  for (const item of rows) {
    if (
      !item ||
      typeof item.title !== "string" ||
      typeof item.content !== "string" ||
      !item.title.trim() ||
      !item.content.trim()
    ) {
      throw new Error("Drive Backup-এ ভুল বা অসম্পূর্ণ তথ্য রয়েছে");
    }
  }

  return rows;
}

// ================= AUTOMATIC DRIVE BACKUP =================

let backupTimer = null;
let backupRunning = false;

function scheduleDriveBackup() {
  if (!isDriveConnected()) return;

  if (backupTimer) {
    clearTimeout(backupTimer);
  }

  backupTimer = setTimeout(async () => {
    if (backupRunning) return;

    backupRunning = true;

    try {
      await uploadDriveBackup();
      console.log("Automatic Google Drive backup completed");
    } catch (error) {
      console.error(
        "Automatic Drive backup failed:",
        error.message
      );
    } finally {
      backupRunning = false;
    }
  }, 5000);

  if (backupTimer.unref) {
    backupTimer.unref();
  }
}

// ================= WEB SEARCH =================

async function searchWeb(q) {
  const url =
    "https://html.duckduckgo.com/html/?q=" +
    encodeURIComponent(q);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 NovaDesk/1.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        "Search service returned " + response.status
      );
    }

    const html = await response.text();
    const results = [];

    const regex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let match;

    while ((match = regex.exec(html)) && results.length < 6) {
      const clean = text => text
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

// ================= STATIC FILES =================

function serveStatic(res, pathname) {
  const requested =
    pathname === "/" ? "index.html" : pathname.slice(1);

  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(root, requested);

  if (
    file !== path.join(root, "index.html") &&
    !file.startsWith(root + path.sep)
  ) {
    return send(res, 403, {
      error: "Forbidden"
    });
  }

  fs.readFile(file, (error, data) => {
    if (error) {
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

// ================= API SERVER =================

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;

  try {
    // Health
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        name: "NovaDesk",
        ai: ENGINE,
        knowledgeCount: readDB().length,
        driveConfigured: driveConfigured(),
        driveConnected: isDriveConnected()
      });
    }

    // Training list
    if (pathname === "/api/knowledge" && req.method === "GET") {
      return send(res, 200, readDB());
    }

    // Single training
    if (pathname === "/api/knowledge" && req.method === "POST") {
      const b = await bodyJSON(req);
      const title = cleanText(b.title, 500);
      const content = cleanText(b.content, 10000);

      if (!title || !content) {
        return send(res, 400, {
          error: "শিরোনাম ও তথ্য লিখুন"
        });
      }

      const rows = readDB();
      const item = makeKnowledgeItem(title, content);

      rows.push(item);
      writeDB(rows);
      scheduleDriveBackup();

      return send(res, 201, {
        ok: true,
        item,
        knowledgeCount: rows.length
      });
    }

    // Bulk training
    if (pathname === "/api/knowledge/bulk" && req.method === "POST") {
      const b = await bodyJSON(req);

      const incoming = normalizeTrainingItems(
        b.items || b.knowledge || b.text || ""
      );

      if (!incoming.length) {
        return send(res, 400, {
          ok: false,
          error: "প্রশ্ন-উত্তরের সঠিক ফরম্যাট পাওয়া যায়নি"
        });
      }

      const rows = readDB();
      const merged = mergeKnowledge(rows, incoming);

      if (merged.added > 0) {
        writeDB(merged.rows);
        scheduleDriveBackup();
      }

      return send(res, 200, {
        ok: true,
        added: merged.added,
        skipped: merged.skipped,
        knowledgeCount: merged.rows.length,
        message: merged.added + "টি নতুন তথ্য যোগ হয়েছে"
      });
    }

    // Export knowledge
    if (pathname === "/api/knowledge/export" && req.method === "GET") {
      return send(res, 200, {
        app: "NovaDesk",
        exportedAt: new Date().toISOString(),
        knowledge: readDB()
      });
    }

    // Delete one training item
    if (
      pathname.startsWith("/api/knowledge/") &&
      req.method === "DELETE"
    ) {
      const id = decodeURIComponent(pathname.split("/").pop());
      const rows = readDB();
      const updated = rows.filter(item => item.id !== id);

      if (updated.length === rows.length) {
        return send(res, 404, {
          ok: false,
          error: "তথ্য পাওয়া যায়নি"
        });
      }

      writeDB(updated);
      scheduleDriveBackup();

      return send(res, 200, {
        ok: true,
        message: "তথ্য মুছে ফেলা হয়েছে",
        knowledgeCount: updated.length
      });
    }

    // Chat
    if (pathname === "/api/chat" && req.method === "POST") {
      const b = await bodyJSON(req);
      const question = cleanText(b.message, 1000);
      const reply = localAnswer(question, readDB());

      return send(res, 200, {
        ok: true,
        reply,
        answer: reply,
        mode: ENGINE
      });
        }
                  
// Web search
if (pathname === "/api/search" && req.method === "GET") {
  const q = cleanText(u.searchParams.get("q"), 200);

  if (!q) {
    return send(res, 400, { error: "সার্চের বিষয় লিখুন" });
  }

  const results = await searchWeb(q);

  return send(res, 200, {
    ok: true,
    query: q,
    results,
    note: "ফলাফল DuckDuckGo সার্চ থেকে এসেছে।"
  });
}

// Google Drive connect
if (pathname === "/api/drive/connect" && req.method === "GET") {
  if (!driveConfigured()) {
    return send(res, 400, {
      ok: false,
      error: "Google OAuth Environment Variables পাওয়া যায়নি"
    });
  }

  res.writeHead(302, {
    Location: oauthURL(),
    "Cache-Control": "no-store"
  });

  return res.end();
}

// Google Drive callback
if (pathname === "/api/drive/callback" && req.method === "GET") {
  const error = u.searchParams.get("error");
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");

  if (error) {
    return send(res, 400, {
      ok: false,
      error: "Google অনুমতি দেয়নি: " + error
    });
  }

  if (!verifyOAuthState(state) || !code) {
    return send(res, 400, {
      ok: false,
      error: "OAuth State ভুল বা মেয়াদ শেষ"
    });
  }

  await exchangeCode(code);

  res.writeHead(302, {
    Location: "/?drive=connected",
    "Cache-Control": "no-store"
  });

  return res.end();
}

// Drive status
if (pathname === "/api/drive/status" && req.method === "GET") {
  return send(res, 200, {
    ok: true,
    configured: driveConfigured(),
    connected: isDriveConnected(),
    backupName: DRIVE_BACKUP_NAME
  });
}

// Manual Drive backup
if (pathname === "/api/drive/backup" && req.method === "POST") {
  if (!isDriveConnected()) {
    return send(res, 400, {
      ok: false,
      error: "আগে Google Drive Connect করতে হবে"
    });
  }

  const result = await uploadDriveBackup();

  return send(res, 200, {
    ok: true,
    message: "Google Drive Backup সফল হয়েছে",
    file: result,
    knowledgeCount: readDB().length
  });
}

// Restore from Drive: merge, never replace
if (pathname === "/api/drive/restore" && req.method === "POST") {
  if (!isDriveConnected()) {
    return send(res, 400, {
      ok: false,
      error: "আগে Google Drive Connect করতে হবে"
    });
  }

  const cloudRows = await downloadDriveBackup();
  const localRows = readDB();
  const merged = mergeKnowledge(localRows, cloudRows);

  if (merged.added > 0) {
    writeDB(merged.rows);
  }

  return send(res, 200, {
    ok: true,
    message: "Drive Backup থেকে তথ্য যুক্ত হয়েছে। পুরোনো তথ্য রাখা হয়েছে।",
    added: merged.added,
    skipped: merged.skipped,
    knowledgeCount: merged.rows.length
  });
}

// Website
if (!pathname.startsWith("/api/") && req.method === "GET") {
  return serveStatic(res, pathname);
}

return send(res, 404, {
  ok: false,
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
  console.log(`NovaDesk ${ENGINE} running on port ${PORT}`);
});
