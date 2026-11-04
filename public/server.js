const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "knowledge.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeDB(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows.slice(-3000), null, 2), "utf8");
}
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function words(s) {
  return (String(s || "").toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) || [])
    .filter(w => w.length > 1);
}
function overlap(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
function localAnswer(q, rows) {
  const ranked = rows.map(r => ({...r, score: overlap(q, r.title + " " + r.content)}))
    .sort((a,b) => b.score-a.score);
  if (ranked[0] && ranked[0].score >= 0.18) {
    return "আমার শেখানো তথ্য অনুযায়ী: " + ranked[0].content;
  }
  const tokens = words(q);
  if (/তোমার নাম|তুমি কে/.test(q)) return "আমি NovaDesk—নিজস্ব নিয়ম ও শেখানো তথ্যের ভিত্তিতে উত্তর দিই।";
  if (/হ্যালো|হাই|আসসালামু/.test(q)) return "হ্যালো! কী জানতে চাও? চাইলে আমাকে নতুন তথ্য শেখাতে পারো।";
  if (/সময়/.test(q)) return "সার্ভারের বর্তমান সময়: " + new Date().toLocaleString("bn-BD", {timeZone:"Asia/Dhaka"});
  if (tokens.length) return "এই প্রশ্নের নির্ভরযোগ্য উত্তর আমার শেখানো তথ্যে নেই। AI Lab-এ বিষয়টি শেখালে পরে সেই তথ্য ব্যবহার করতে পারব।";
  return "একটু বিস্তারিত লিখবে?";
}
async function searchWeb(q) {
  // DuckDuckGo HTML সার্চ; এটি বাহ্যিক সার্চ সেবা, AI মডেল নয়।
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(url, { headers: {"User-Agent":"Mozilla/5.0 NovaDesk/1.0"}, signal: controller.signal });
    if (!r.ok) throw new Error("Search service returned " + r.status);
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < 6) {
      const clean = s => s.replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").trim();
      out.push({url:m[1], title:clean(m[2]), snippet:clean(m[3])});
    }
    return out;
  } finally { clearTimeout(timer); }
}
async function bodyJSON(req) {
  let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 1e6) throw new Error("Request too large"); }
  return data ? JSON.parse(data) : {};
}
const server = http.createServer(async (req,res) => {
  if (req.method === "OPTIONS") return send(res,204,{});
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/api/health") return send(res,200,{ok:true, name:"NovaDesk", ai:"নিজস্ব নিয়মভিত্তিক"});
    if (u.pathname === "/api/knowledge" && req.method === "GET") return send(res,200,readDB());
    if (u.pathname === "/api/knowledge" && req.method === "POST") {
      const b = await bodyJSON(req);
      if (!String(b.title||"").trim() || !String(b.content||"").trim()) return send(res,400,{error:"শিরোনাম ও তথ্য লিখুন"});
      const rows = readDB();
      const item = {id:Date.now().toString(36)+Math.random().toString(36).slice(2,7), title:String(b.title).slice(0,160), content:String(b.content).slice(0,5000), createdAt:new Date().toISOString()};
      rows.push(item); writeDB(rows); return send(res,201,item);
    }
    if (u.pathname.startsWith("/api/knowledge/") && req.method === "DELETE") {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      writeDB(readDB().filter(x=>x.id!==id)); return send(res,200,{ok:true});
    }
    if (u.pathname === "/api/chat" && req.method === "POST") {
      const b = await bodyJSON(req); const q = String(b.message||"").slice(0,1000);
      return send(res,200,{answer:localAnswer(q,readDB()), mode:"নিজস্ব নিয়মভিত্তিক AI"});
    }
    if (u.pathname === "/api/search" && req.method === "GET") {
      const q = (u.searchParams.get("q")||"").slice(0,200);
      if (!q.trim()) return send(res,400,{error:"সার্চের বিষয় লিখুন"});
      const results = await searchWeb(q);
      return send(res,200,{query:q, results, note:"ফলাফল বাহ্যিক DuckDuckGo সার্চ থেকে এসেছে; NovaDesk নিজে AI দিয়ে ওয়েবপেজ যাচাই করেনি।"});
    }
    const requested = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname.slice(1));
    const file = path.resolve(__dirname, "public", requested);
    if (!file.startsWith(path.resolve(__dirname, "public") + path.sep)) return send(res,403,{error:"Forbidden"});
    fs.readFile(file,(err,data)=>{
      if (err) return send(res,404,"Not found","text/plain; charset=utf-8");
      const ext=path.extname(file);
      const type=ext===".html"?"text/html; charset=utf-8":ext===".css"?"text/css":ext===".js"?"text/javascript":"application/octet-stream";
      send(res,200,data.toString("utf8"),type);
    });
  } catch(e) { send(res,500,{error:"সার্ভার সমস্যা", detail:e.message}); }
});
server.listen(PORT,()=>console.log("NovaDesk running on port "+PORT));