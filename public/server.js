
// =====================================================
// NovaDesk AI - Natural Language Engine 1.2
// Secure Admin + Google Drive + Safe Module Loader
// =====================================================

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const TOKEN_FILE = path.join(DATA_DIR, "google-token.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MODULES_DIR = path.join(__dirname, "modules");
const MODULE_MANIFEST = path.join(MODULES_DIR, "trusted-modules.json");

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  "https://novadeskai-1.onrender.com/api/drive/callback";

const ADMIN_KEY = process.env.NOVADESK_ADMIN_KEY || "";
const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET || "";

const ENGINE_VERSION = "1.2";
const MAX_BODY_SIZE = 20 * 1024 * 1024;
const MAX_LOCAL_BACKUPS = 30;
const SESSION_DURATION = 8 * 60 * 60 * 1000;

let knowledge = [];
let loadedModules = [];
let lastBackupTime = null;
let lastBackupError = null;
let autoBackupTimer = null;

const adminSessions = new Map();
const loginAttempts = new Map();

// =====================================================
// BASIC HELPERS
// =====================================================

function makeId() {
  return crypto.randomUUID();
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.mkdirSync(MODULES_DIR, { recursive: true });
}

function sendJSON(res, status, data, extraHeaders = {}) {
  if (res.writableEnded) return;

  const output = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(output),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  res.end(output);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  if (res.writableEnded) return;

  res.writeHead(status, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff"
  });

  res.end(text);
}

function writeFileAtomic(filePath, content) {
  const tempPath = filePath + "." + makeId() + ".tmp";

  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}

    throw error;
  }
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;

    req.on("data", chunk => {
      if (finished) return;

      size += chunk.length;

      if (size > MAX_BODY_SIZE) {
        finished = true;
        reject(new Error("অনুরোধের তথ্য ২০ MB-এর বেশি হতে পারবে না।"));
        req.resume();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (finished) return;
      finished = true;

      const body = Buffer.concat(chunks).toString("utf8");

      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON তথ্য সঠিক নয়।"));
      }
    });

    req.on("error", error => {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  if (first.length !== second.length) return false;

  return crypto.timingSafeEqual(first, second);
}

// =====================================================
// ADMIN AUTHENTICATION
// =====================================================

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");

    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return "";
}

function createAdminSession() {
  const token = crypto.randomBytes(32).toString("hex");

  adminSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION
  });

  return token;
}

function isAdmin(req) {
  const token = getCookie(req, "novadesk_admin");

  if (!token) return false;

  const session = adminSessions.get(token);

  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }

  return true;
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    sendJSON(res, 503, {
      ok: false,
      error: "NOVADESK_ADMIN_KEY Environment Variable সেট করা নেই।"
    });

    return false;
  }

  if (!isAdmin(req)) {
    sendJSON(res, 401, {
      ok: false,
      error: "Admin Login প্রয়োজন।"
    });

    return false;
  }

  return true;
}

function adminLogin(req, res, body) {
  if (!ADMIN_KEY) {
    sendJSON(res, 503, {
      ok: false,
      error: "Admin Key configure করা হয়নি।"
    });

    return;
  }

  const ip = req.socket.remoteAddress || "unknown";
  const attempt = loginAttempts.get(ip) || {
    count: 0,
    blockedUntil: 0
  };

  if (Date.now() < attempt.blockedUntil) {
    sendJSON(res, 429, {
      ok: false,
      error: "অনেকবার ভুল চেষ্টা হয়েছে। কিছুক্ষণ পরে চেষ্টা করুন।"
    });

    return;
  }

  if (!safeEqual(body.key, ADMIN_KEY)) {
    attempt.count++;

    if (attempt.count >= 5) {
      attempt.count = 0;
      attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
    }

    loginAttempts.set(ip, attempt);

    sendJSON(res, 401, {
      ok: false,
      error: "Admin Key সঠিক নয়।"
    });

    return;
  }

  loginAttempts.delete(ip);

  const token = createAdminSession();

  sendJSON(res, 200, {
    ok: true,
    message: "Admin Login সফল হয়েছে।"
  }, {
    "Set-Cookie":
      "novadesk_admin=" + encodeURIComponent(token) +
      "; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=28800"
  });
}

function adminLogout(req, res) {
  const token = getCookie(req, "novadesk_admin");

  if (token) adminSessions.delete(token);

  sendJSON(res, 200, {
    ok: true,
    message: "Logout সম্পন্ন হয়েছে।"
  }, {
    "Set-Cookie":
      "novadesk_admin=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0"
  });
}

// =====================================================
// TRUSTED MODULE LOADER
// =====================================================

function loadModules() {
  loadedModules = [];

  try {
    fs.mkdirSync(MODULES_DIR, { recursive: true });

    if (!fs.existsSync(MODULE_MANIFEST)) {
      console.log("No trusted module manifest. Modules disabled.");
      return true;
    }

    const manifest = JSON.parse(
      fs.readFileSync(MODULE_MANIFEST, "utf8")
    );

    if (!manifest || !Array.isArray(manifest.modules)) {
      console.warn("Invalid trusted module manifest.");
      return false;
    }

    for (const file of manifest.modules) {
      if (
        typeof file !== "string" ||
        !/^[a-zA-Z0-9_-]+\.js$/.test(file)
      ) {
        console.warn("Invalid module filename skipped.");
        continue;
      }

      const modulePath = path.resolve(MODULES_DIR, file);

      if (!modulePath.startsWith(path.resolve(MODULES_DIR) + path.sep)) {
        continue;
      }

      if (!fs.existsSync(modulePath)) continue;

      try {
        delete require.cache[require.resolve(modulePath)];

        const moduleExport = require(modulePath);

        if (!moduleExport ||
            typeof moduleExport.processChat !== "function") {
          continue;
        }

        loadedModules.push({
          name: moduleExport.name || file,
          processChat: moduleExport.processChat
        });

        console.log("Trusted module loaded:", file);
      } catch (error) {
        console.error("Module error:", file, error.message);
      }
    }

    return true;
  } catch (error) {
    console.error("Module loader error:", error.message);
    loadedModules = [];
    return false;
  }
}

// =====================================================
// DATABASE
// =====================================================

function loadKnowledge() {
  if (!fs.existsSync(DB_FILE)) {
    knowledge = [];
    return;
  }

  const raw = fs.readFileSync(DB_FILE, "utf8");

  if (!raw.trim()) {
    knowledge = [];
    return;
  }

  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    knowledge = parsed;
  } else if (parsed && Array.isArray(parsed.knowledge)) {
    knowledge = parsed.knowledge;
  } else {
    throw new Error("Knowledge database-এর format সঠিক নয়।");
  }

  knowledge = knowledge.map(item => ({
    id: item.id || makeId(),
    question: String(item.question || item.title || ""),
    answer: String(item.answer || item.content || ""),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  }));
}

function createLocalBackup() {
  if (!fs.existsSync(DB_FILE)) return null;

  const filename =
    "knowledge-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    ".json";

  const destination = path.join(BACKUP_DIR, filename);

  fs.copyFileSync(DB_FILE, destination);

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(name => name.endsWith(".json"))
    .map(name => ({
      name,
      time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time);

  for (const oldFile of files.slice(MAX_LOCAL_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, oldFile.name));
  }

  return filename;
}

function saveKnowledge(options = {}) {
  if (options.backup !== false) {
    createLocalBackup();
  }

  const data = JSON.stringify({
    name: "NovaDesk",
    version: ENGINE_VERSION,
    updatedAt: new Date().toISOString(),
    knowledge
  }, null, 2);

  writeFileAtomic(DB_FILE, data);

  if (options.drive !== false) {
    scheduleDriveBackup();
  }
}

function findQuestion(question) {
  const normalized = normalize(question);

  return knowledge.find(item =>
    normalize(item.question) === normalized
  );
}

// =====================================================
// TRAINING
// =====================================================

function addKnowledge(question, answer) {
  question = String(question || "").trim();
  answer = String(answer || "").trim();

  if (!question || !answer) {
    return {
      ok: false,
      error: "প্রশ্ন ও উত্তর দুটোই দিতে হবে।"
    };
  }

  const existing = findQuestion(question);

  if (existing) {
    return {
      ok: false,
      duplicate: true,
      message: "এই প্রশ্নটি আগে থেকেই শেখানো আছে।",
      item: existing
    };
  }

  const now = new Date().toISOString();

  const item = {
    id: makeId(),
    question,
    answer,
    createdAt: now,
    updatedAt: now
  };

  knowledge.push(item);

  return { ok: true, item };
}

function parseTrainingText(text) {
  const result = [];
  const lines = String(text || "").replace(/\r/g, "").split("\n");

  let question = "";
  let answer = "";

  function savePair() {
    if (question.trim() && answer.trim()) {
      result.push({
        question: question.trim(),
        answer: answer.trim()
      });
    }

    question = "";
    answer = "";
  }

  for (const originalLine of lines) {
    const line = originalLine.trim();

    if (!line) continue;

    const qMatch = line.match(
      /^(?:প্রশ্ন|question|q)\s*[:：=-]\s*(.*)$/i
    );

    const aMatch = line.match(
      /^(?:উত্তর|answer|ans|a)\s*[:：=-]\s*(.*)$/i
    );

    if (qMatch) {
      savePair();
      question = qMatch[1].trim();
      continue;
    }

    if (aMatch) {
      answer = aMatch[1].trim();
      continue;
    }

    if (question && !answer) {
      question += " " + line;
    } else if (question && answer) {
      answer += " " + line;
    }
  }

  savePair();
  return result;
}

function importTraining(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Training তথ্য সঠিক নয়।" };
  }

  let items = [];

  if (Array.isArray(data.items)) {
    items = data.items;
  } else if (Array.isArray(data.knowledge)) {
    items = data.knowledge;
  } else if (typeof data.text === "string") {
    items = parseTrainingText(data.text);
  } else if (
    (data.question || data.title) &&
    (data.answer || data.content)
  ) {
    items = [{
      question: data.question || data.title,
      answer: data.answer || data.content
    }];
  }

  let added = 0;
  let duplicate = 0;
  let invalid = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") {
      invalid++;
      continue;
    }

    const result = addKnowledge(
      item.question || item.title,
      item.answer || item.content
    );

    if (result.ok) added++;
    else if (result.duplicate) duplicate++;
    else invalid++;
  }

  if (added > 0) saveKnowledge();

  return {
    ok: true,
    total: items.length,
    added,
    duplicate,
    invalid,
    knowledgeCount: knowledge.length
  };
}

// =====================================================
// CHAT ENGINE
// =====================================================

function tokenize(text) {
  return normalize(text)
    .split(" ")
    .filter(word => word.length > 1);
}

function findBestAnswer(question) {
  const query = normalize(question);

  if (!query) return null;

  const exact = findQuestion(question);

  if (exact) {
    return {
      answer: exact.answer,
      item: exact,
      score: 1
    };
  }

  const queryWords = tokenize(query);

  if (!queryWords.length) return null;

  let best = null;
  let bestScore = 0;

  for (const item of knowledge) {
    const storedWords = tokenize(item.question);

    if (!storedWords.length) continue;

    let matched = 0;

    for (const word of queryWords) {
      if (storedWords.includes(word)) matched++;
    }

    const score = matched /
      Math.max(queryWords.length, storedWords.length);

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (best && bestScore >= 0.55) {
    return {
      answer: best.answer,
      item: best,
      score: bestScore
    };
  }

  return null;
}

function naturalAnswer(question) {
  const text = String(question || "").trim();
  const lower = normalize(text);

  if (!text) {
    return "তুমি কী জানতে চাও? আমাকে একটি প্রশ্ন করো।";
  }

  if (/^(hi|hello|হাই|হ্যালো|সালাম|আসসালামু আলাইকুম)$/.test(lower)) {
    return "ওয়ালাইকুম আসসালাম! আমি NovaDesk AI। তোমাকে কীভাবে সাহায্য করতে পারি?";
  }

  if (lower.includes("তোমার নাম") || lower.includes("তুমি কে")) {
    return "আমার নাম NovaDesk AI। আমি শেখানো তথ্যের ভিত্তিতে উত্তর দেওয়ার জন্য তৈরি।";
  }

  if (lower.includes("কেমন আছ")) {
    return "আমি ভালো আছি। তুমি কেমন আছ?";
  }

  if (lower.includes("ধন্যবাদ")) {
    return "তোমাকে স্বাগতম!";
  }

  if (lower.includes("তুমি কি পারো")) {
    return "আমি শেখানো তথ্য থেকে উত্তর দিতে পারি, প্রশ্ন খুঁজতে পারি এবং নতুন তথ্য শিখতে পারি।";
  }

  return "এই প্রশ্নের উত্তর এখনো আমার শেখানো তথ্যের মধ্যে নেই। আমাকে প্রশ্নটির সঠিক উত্তর শেখাতে পারো।";
}

function runChatModules(question, result) {
  let response = result.answer;

  for (const module of loadedModules) {
    try {
      const output = module.processChat({
        question,
        response,
        learned: result.learned,
        matchedQuestion: result.matchedQuestion || null
      });

      if (typeof output === "string" && output.trim()) {
        response = output.trim();
      }
    } catch (error) {
      console.error("Module processing error:", module.name, error.message);
    }
  }

  return response;
}

function chat(question) {
  const result = findBestAnswer(question);

  let output;

  if (result) {
    output = {
      ok: true,
      answer: result.answer,
      mode: result.score === 1 ? "exact" : "learned",
      learned: true,
      matchedQuestion: result.item.question
    };
  } else {
    output = {
      ok: true,
      answer: naturalAnswer(question),
      mode: "natural",
      learned: false
    };
  }

  output.answer = runChatModules(question, output);
  return output;
}

// =====================================================
// GOOGLE OAUTH
// =====================================================

function googleConfigured() {
  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REDIRECT_URI &&
    OAUTH_STATE_SECRET
  );
}

function signState(value) {
  if (!OAUTH_STATE_SECRET) {
    throw new Error("OAUTH_STATE_SECRET configure করা হয়নি।");
  }

  return crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(value)
    .digest("hex");
}

function makeOAuthState() {
  const payload = Buffer.from(JSON.stringify({
    time: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex")
  })).toString("base64url");

  return payload + "." + signState(payload);
}

function verifyOAuthState(state) {
  try {
    const parts = String(state || "").split(".");

    if (parts.length !== 2) return false;

    const expected = signState(parts[0]);

    if (!safeEqual(parts[1], expected)) return false;

    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    );

    const age = Date.now() - payload.time;

    return (
      typeof payload.time === "number" &&
      age >= 0 &&
      age < 10 * 60 * 1000 &&
      typeof payload.nonce === "string"
    );
  } catch {
    return false;
  }
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;

  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  const previous = loadTokens() || {};

  const merged = {
    ...previous,
    ...tokens
  };

  if (!merged.refresh_token && previous.refresh_token) {
    merged.refresh_token = previous.refresh_token;
  }

  writeFileAtomic(TOKEN_FILE, JSON.stringify(merged, null, 2));
}

function googleLoginURL() {
  const state = makeOAuthState();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state
  });

  return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}

async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code"
  });

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description || data.error || "Google login failed"
    );
  }

  saveTokens({
    ...data,
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000
  });
}

async function getGoogleAccessToken() {
  let tokens = loadTokens();

  if (!tokens || !tokens.access_token) {
    throw new Error("Google Drive সংযুক্ত করা হয়নি।");
  }

  if (
    tokens.expiry_date &&
    Date.now() < tokens.expiry_date - 60000
  ) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error("Google refresh token পাওয়া যায়নি। আবার সংযোগ করুন।");
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
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
      body
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description || "Google token refresh failed"
    );
  }

  saveTokens({
    ...data,
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000
  });

  tokens = loadTokens();
  return tokens.access_token;
}

async function driveRequest(url, options = {}) {
  const token = await getGoogleAccessToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token
    }
  });

  const responseText = await response.text();

  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message || data.error || "Google Drive request failed"
    );
  }

  return data;
}

// =====================================================
// GOOGLE DRIVE BACKUP
// =====================================================

async function findDriveBackup() {
  const query = encodeURIComponent(
    "name='NovaDesk_Backup.json' and trashed=false"
  );

  const fields = encodeURIComponent(
    "files(id,name,mimeType,modifiedTime,size)"
  );

  const data = await driveRequest(
    "https://www.googleapis.com/drive/v3/files?q=" +
    query + "&fields=" + fields +
    "&orderBy=modifiedTime desc&pageSize=10"
  );

  const files = data.files || [];
  return files.length ? files[0] : null;
}

async function uploadDriveBackup() {
  if (!googleConfigured()) {
    throw new Error("Google OAuth configuration পাওয়া যায়নি।");
  }

  const backup = {
    name: "NovaDesk",
    version: ENGINE_VERSION,
    exportedAt: new Date().toISOString(),
    knowledge
  };

  const json = JSON.stringify(backup, null, 2);
  const existing = await findDriveBackup();

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
    json + "\r\n" +
    "--" + boundary + "--";

  const url = existing
    ? "https://www.googleapis.com/upload/drive/v3/files/" +
      existing.id + "?uploadType=multipart"
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

  const result = await driveRequest(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      "Content-Type": "multipart/related; boundary=" + boundary
    },
    body
  });

  lastBackupTime = new Date().toISOString();
  lastBackupError = null;

  return result;
}

async function downloadDriveBackup() {
  const file = await findDriveBackup();

  if (!file) {
    throw new Error("Google Drive-এ NovaDesk_Backup.json পাওয়া যায়নি।");
  }

  const data = await driveRequest(
    "https://www.googleapis.com/drive/v3/files/" +
    file.id + "?alt=media"
  );

  return { file, data };
}

function scheduleDriveBackup() {
  if (!googleConfigured() || !loadTokens()) return;

  clearTimeout(autoBackupTimer);

  autoBackupTimer = setTimeout(async () => {
    try {
      await uploadDriveBackup();
      console.log("NovaDesk: Google Drive backup completed.");
    } catch (error) {
      lastBackupError = error.message;
      console.error("Drive backup failed:", error.message);
    }
  }, 15000);
}

// =====================================================
// DRIVE RESTORE - MERGE ONLY
// =====================================================

async function restoreDriveBackup() {
  const downloaded = await downloadDriveBackup();
  let data = downloaded.data;

  if (typeof data === "string") {
    data = JSON.parse(data);
  }

  const incoming = Array.isArray(data)
    ? data
    : data && data.knowledge;

  if (!Array.isArray(incoming)) {
    throw new Error("Drive backup-এর তথ্য সঠিক নয়।");
  }

  const validItems = [];

  for (const item of incoming) {
    if (!item || typeof item !== "object") continue;

    const question = String(item.question || item.title || "").trim();
    const answer = String(item.answer || item.content || "").trim();

    if (question && answer) {
      validItems.push({ question, answer });
    }
  }

  let added = 0;
  let duplicate = 0;
  let invalid = incoming.length - validItems.length;

  for (const item of validItems) {
    const result = addKnowledge(item.question, item.answer);

    if (result.ok) added++;
    else if (result.duplicate) duplicate++;
    else invalid++;
  }

  if (added > 0) {
    saveKnowledge({ drive: false });
  }

  return {
    ok: true,
    added,
    duplicate,
    invalid,
    total: knowledge.length,
    message: "পুরোনো তথ্য না মুছে নতুন তথ্য যুক্ত করা হয়েছে।"
  };
}

// =====================================================
// WEB SEARCH
// =====================================================

async function searchWeb(query) {
  const url =
    "https://html.duckduckgo.com/html/?q=" +
    encodeURIComponent(query);

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!response.ok) {
    throw new Error("অনলাইন সার্চ করা যায়নি।");
  }

  const html = await response.text();
  const results = [];

  const regex =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(html)) !== null && results.length < 8) {
    const title = match[2]
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .trim();

    let link = match[1];

    try {
      const parsed = new URL(link, "https://duckduckgo.com");
      const redirect = parsed.searchParams.get("uddg");
      if (redirect) link = redirect;
    } catch {}

    if (title && /^https?:\/\//i.test(link)) {
      results.push({ title, url: link });
    }
  }

  return results;
}

// =====================================================
// STATIC FILES
// =====================================================

const MIME_TYPES = {
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

function serveStatic(pathname, res) {
  let requested;

  try {
    requested = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, "Invalid URL");
    return;
  }

  if (requested === "/") requested = "/index.html";

  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(publicRoot, "." + requested);

  if (!filePath.startsWith(publicRoot + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "পৃষ্ঠা পাওয়া যায়নি।");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();

  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff"
  });

  fs.createReadStream(filePath).pipe(res);
}

// =====================================================
// API ROUTER
// =====================================================

async function handleRequest(req, res) {
  const parsedURL = new URL(
    req.url,
    "http://" + (req.headers.host || "localhost")
  );

  const pathname = parsedURL.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ADMIN LOGIN
  if (pathname === "/api/admin/login" && req.method === "POST") {
    const body = await readJSONBody(req);
    adminLogin(req, res, body);
    return;
  }

  // ADMIN LOGOUT
  if (pathname === "/api/admin/logout" && req.method === "POST") {
    adminLogout(req, res);
    return;
  }

  // ADMIN STATUS
  if (pathname === "/api/admin/status" && req.method === "GET") {
    sendJSON(res, 200, {
      ok: true,
      authenticated: isAdmin(req),
      configured: Boolean(ADMIN_KEY)
    });
    return;
  }

  // HEALTH
  if (pathname === "/api/health" && req.method === "GET") {
    sendJSON(res, 200, {
      ok: true,
      name: "NovaDesk",
      ai: "NovaDesk AI Engine " + ENGINE_VERSION,
      knowledgeCount: knowledge.length,
      moduleCount: loadedModules.length,
      modules: loadedModules.map(module => module.name),
      driveConfigured: googleConfigured(),
      driveConnected: Boolean(loadTokens()),
      adminConfigured: Boolean(ADMIN_KEY)
    });
    return;
  }

  // PUBLIC CHAT
  if (pathname === "/api/chat" && req.method === "POST") {
    const body = await readJSONBody(req);
    const question = body.question || body.message || body.text || "";

    sendJSON(res, 200, chat(question));
    return;
  }

  // PUBLIC SEARCH
  if (pathname === "/api/search" && req.method === "GET") {
    const query = parsedURL.searchParams.get("q") || "";

    if (!query.trim()) {
      sendJSON(res, 400, {
        ok: false,
        error: "সার্চ করার জন্য কিছু লিখুন।"
      });
      return;
    }

    const results = await searchWeb(query);

    sendJSON(res, 200, {
      ok: true,
      query,
      results
    });
    return;
  }

  // ALL ROUTES BELOW REQUIRE ADMIN LOGIN
  const adminRoutes = [
    "/api/knowledge",
    "/api/train",
    "/api/drive/status",
    "/api/drive/connect",
    "/api/drive/backup-info",
    "/api/drive/backup",
    "/api/drive/restore",
    "/api/backups",
    "/api/export"
  ];

  const isKnowledgeDelete =
    pathname.startsWith("/api/knowledge/") &&
    req.method === "DELETE";

  const needsAdmin =
    adminRoutes.includes(pathname) || isKnowledgeDelete;

  if (needsAdmin && !requireAdmin(req, res)) {
    return;
  }

  // KNOWLEDGE LIST
  if (pathname === "/api/knowledge" && req.method === "GET") {
    sendJSON(res, 200, {
      ok: true,
      knowledge,
      total: knowledge.length
    });
    return;
  }

  // ADD OR BULK TRAINING
  if (pathname === "/api/knowledge" && req.method === "POST") {
    const body = await readJSONBody(req);
    sendJSON(res, 200, importTraining(body));
    return;
  }

  // BULK TRAINING ALIAS
  if (pathname === "/api/train" && req.method === "POST") {
    const body = await readJSONBody(req);
    sendJSON(res, 200, importTraining(body));
    return;
  }

  // DELETE KNOWLEDGE
  if (isKnowledgeDelete) {
    const id = pathname.slice("/api/knowledge/".length);
    const oldLength = knowledge.length;

    knowledge = knowledge.filter(item => item.id !== id);

    if (knowledge.length === oldLength) {
      sendJSON(res, 404, {
        ok: false,
        error: "তথ্যটি পাওয়া যায়নি।"
      });
      return;
    }

    saveKnowledge();

    sendJSON(res, 200, {
      ok: true,
      message: "তথ্য মুছে ফেলা হয়েছে।",
      knowledgeCount: knowledge.length
    });
    return;
  }

  // DRIVE STATUS
  if (pathname === "/api/drive/status" && req.method === "GET") {
    let backup = null;
    let backupError = null;

    if (loadTokens()) {
      try {
        backup = await findDriveBackup();
      } catch (error) {
        backupError = error.message;
      }
    }

    sendJSON(res, 200, {
      ok: true,
      configured: googleConfigured(),
      connected: Boolean(loadTokens()),
      backupExists: Boolean(backup),
      backupName: backup ? backup.name : null,
      modifiedTime: backup ? backup.modifiedTime : null,
      lastBackupTime,
      lastBackupError,
      backupCheckError: backupError
    });
    return;
  }

  // GOOGLE LOGIN
  if (pathname === "/api/drive/connect" && req.method === "GET") {
    if (!googleConfigured()) {
      sendJSON(res, 500, {
        ok: false,
        error: "Google OAuth Environment Variables পাওয়া যায়নি।"
      });
      return;
    }

    res.writeHead(302, { Location: googleLoginURL() });
    res.end();
    return;
  }

  // GOOGLE OAUTH CALLBACK
  if (pathname === "/api/drive/callback" && req.method === "GET") {
    const code = parsedURL.searchParams.get("code");
    const state = parsedURL.searchParams.get("state");
    const error = parsedURL.searchParams.get("error");

    if (error) {
      sendText(res, 400, "Google অনুমতি দেয়নি: " + error);
      return;
    }

    if (!code || !verifyOAuthState(state)) {
      sendText(res, 400, "Google OAuth verification ব্যর্থ হয়েছে।");
      return;
    }

    await exchangeGoogleCode(code);

    res.writeHead(302, { Location: "/?drive=connected" });
    res.end();
    return;
  }

  // DRIVE BACKUP INFO
  if (pathname === "/api/drive/backup-info" && req.method === "GET") {
    const downloaded = await downloadDriveBackup();
    let data = downloaded.data;

    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    const incoming = Array.isArray(data)
      ? data
      : data && data.knowledge;

    if (!Array.isArray(incoming)) {
      sendJSON(res, 200, {
        ok: true,
        exists: true,
        valid: false,
        message: "ব্যাকআপের format সঠিক নয়।"
      });
      return;
    }

    sendJSON(res, 200, {
      ok: true,
      exists: true,
      valid: true,
      name: downloaded.file.name,
      modifiedTime: downloaded.file.modifiedTime,
      size: downloaded.file.size || null,
      knowledgeCount: incoming.length,
      exportedAt: data.exportedAt || null,
      message: "ব্যাকআপ ফাইল পাওয়া গেছে এবং পড়া সম্ভব হয়েছে।"
    });
    return;
  }

  // DRIVE BACKUP
  if (pathname === "/api/drive/backup" && req.method === "POST") {
    const result = await uploadDriveBackup();

    sendJSON(res, 200, {
      ok: true,
      message: "Google Drive backup সম্পন্ন হয়েছে।",
      fileId: result.id,
      knowledgeCount: knowledge.length
    });
    return;
  }

  // DRIVE RESTORE
  if (pathname === "/api/drive/restore" && req.method === "POST") {
    sendJSON(res, 200, await restoreDriveBackup());
    return;
  }

  // LOCAL BACKUP LIST
  if (pathname === "/api/backups" && req.method === "GET") {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(name => name.endsWith(".json"))
      .map(name => {
        const filePath = path.join(BACKUP_DIR, name);
        const stat = fs.statSync(filePath);

        return {
          name,
          size: stat.size,
          modifiedTime: stat.mtime
        };
      })
      .sort((a, b) =>
        new Date(b.modifiedTime) - new Date(a.modifiedTime)
      );

    sendJSON(res, 200, { ok: true, backups: files });
    return;
  }

  // EXPORT
  if (pathname === "/api/export" && req.method === "GET") {
    sendJSON(res, 200, {
      name: "NovaDesk",
      version: ENGINE_VERSION,
      exportedAt: new Date().toISOString(),
      knowledge
    });
    return;
  }

  // NOT FOUND
  if (pathname.startsWith("/api/")) {
    sendJSON(res, 404, {
      ok: false,
      error: "API route পাওয়া যায়নি"
    });
    return;
  }

  serveStatic(pathname, res);
}

// =====================================================
// SERVER START
// =====================================================

async function startServer() {
  ensureDirectories();

  try {
    loadKnowledge();
  } catch (error) {
    console.error("Database load failed:", error.message);
    console.error("পুরোনো knowledge.json পরিবর্তন করা হয়নি।");
    process.exit(1);
    return;
  }

  loadModules();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error("Request error:", error);

      if (!res.headersSent) {
        sendJSON(res, 500, {
          ok: false,
          error: error.message || "সার্ভারে সমস্যা হয়েছে।"
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log("==================================");
    console.log("NovaDesk AI Engine " + ENGINE_VERSION);
    console.log("Server running on port:", PORT);
    console.log("Knowledge count:", knowledge.length);
    console.log("Modules loaded:", loadedModules.length);
    console.log("Google Drive configured:", googleConfigured());
    console.log("Admin configured:", Boolean(ADMIN_KEY));
    console.log("==================================");
  });
}

startServer();
