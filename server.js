/**
 * Bhumi Setu — demo backend
 * ---------------------------------------------------------------
 * A small, dependency-free Node.js server (built-in `http` module
 * only — no `npm install` required) that serves the site and the
 * two endpoints the front end actually calls:
 *
 *   POST /api/validate   { parcelId, ownerName, surveyNumber }
 *                         -> { status, record?, confidence? }
 *
 *   POST /api/contact     { name, email, phone, district, subject, message }
 *                         -> { id }
 *
 * A couple of read-only extras are included for convenience:
 *
 *   GET  /api/records            list all sample parcels
 *   GET  /api/records/:parcelId  fetch one sample parcel
 *   GET  /api/contact            list stored contact messages (demo/admin use)
 *   GET  /api/stats              simple counts
 *
 * This is a local demonstration only. The "database" is two JSON
 * files in /data, there is no authentication, and none of this is
 * connected to any real land registry. Run with:
 *
 *   node server.js
 *
 * then open http://localhost:3000
 * ---------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RECORDS_PATH = path.join(ROOT, 'data', 'records.json');
const CONTACTS_PATH = path.join(ROOT, 'data', 'contacts.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// ---------- JSON "database" helpers ----------

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getRecords() {
  return readJSON(RECORDS_PATH, []);
}

// ---------- request/response helpers ----------

function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function badRequest(res, message) {
  sendJSON(res, 400, { ok: false, error: message || 'Bad request' });
}

// ---------- static file serving ----------

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 — not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- matching logic for /api/validate ----------

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSurvey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

// 'skip' | 'exact' | 'partial' | 'mismatch'
function compareName(input, stored) {
  const a = normalizeName(input);
  if (!a) return 'skip';
  const b = normalizeName(stored);
  if (a === b) return 'exact';
  const aWords = a.split(' ').filter((w) => w.length > 1);
  const bWords = b.split(' ');
  const allPresent = aWords.every((w) => bWords.includes(w));
  return allPresent && aWords.length > 0 ? 'partial' : 'mismatch';
}

// 'skip' | 'exact' | 'mismatch'
function compareSurvey(input, stored) {
  const a = normalizeSurvey(input);
  if (!a) return 'skip';
  return a === normalizeSurvey(stored) ? 'exact' : 'mismatch';
}

function scoreMatch(nameResult, surveyResult) {
  let confidence = 50;
  if (nameResult === 'exact') confidence += 25;
  else if (nameResult === 'partial') confidence += 8;
  else if (nameResult === 'mismatch') confidence -= 25;

  if (surveyResult === 'exact') confidence += 25;
  else if (surveyResult === 'mismatch') confidence -= 20;

  return Math.max(5, Math.min(99, confidence));
}

function decideStatus(nameResult, surveyResult) {
  if (nameResult === 'mismatch' || surveyResult === 'mismatch') return 'mismatch';
  if (nameResult === 'partial') return 'needs_review';
  if (nameResult === 'skip' && surveyResult === 'skip') return 'needs_review';
  return 'validated';
}

// ---------- API handlers ----------

function findByParcelId(records, parcelId) {
  const needle = String(parcelId).trim().toLowerCase();
  return records.find((r) => r.parcelId.toLowerCase() === needle);
}

function handleListRecords(req, res) {
  sendJSON(res, 200, { ok: true, results: getRecords() });
}

function handleGetRecord(req, res, parcelId) {
  const record = findByParcelId(getRecords(), parcelId);
  if (!record) return sendJSON(res, 404, { ok: false, error: 'No such parcel' });
  sendJSON(res, 200, { ok: true, record });
}

async function handleValidate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const parcelId = (body.parcelId || '').trim();
  if (!parcelId) return badRequest(res, 'parcelId is required');

  const record = findByParcelId(getRecords(), parcelId);
  if (!record) {
    return sendJSON(res, 200, { ok: true, status: 'not_found' });
  }

  const nameResult = compareName(body.ownerName, record.ownerName);
  const surveyResult = compareSurvey(body.surveyNumber, record.surveyNumber);
  const status = decideStatus(nameResult, surveyResult);
  const confidence = scoreMatch(nameResult, surveyResult);

  sendJSON(res, 200, { ok: true, status, confidence, record });
}

async function handleContactSubmit(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const district = (body.district || '').trim();
  const message = (body.message || '').trim();
  const phone = (body.phone || '').trim();
  const subject = (body.subject || 'General inquiry').trim();

  if (!name || !email || !district || !message) {
    return badRequest(res, 'name, email, district, and message are required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return badRequest(res, 'Please provide a valid email address');
  }

  const contacts = readJSON(CONTACTS_PATH, []);
  const referenceId = 'BS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  contacts.push({
    id: referenceId,
    name,
    email,
    phone,
    district,
    subject,
    message,
    receivedAt: new Date().toISOString()
  });
  writeJSON(CONTACTS_PATH, contacts);

  sendJSON(res, 201, { ok: true, id: referenceId });
}

function handleContactList(req, res) {
  const contacts = readJSON(CONTACTS_PATH, []);
  sendJSON(res, 200, { ok: true, count: contacts.length, results: contacts });
}

function handleStats(req, res) {
  const records = getRecords();
  const contacts = readJSON(CONTACTS_PATH, []);
  sendJSON(res, 200, {
    ok: true,
    parcels: records.length,
    districts: new Set(records.map((r) => r.district)).size,
    messagesReceived: contacts.length
  });
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/records' && req.method === 'GET') {
      return handleListRecords(req, res);
    }
    const recordMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
    if (recordMatch && req.method === 'GET') {
      return handleGetRecord(req, res, decodeURIComponent(recordMatch[1]));
    }
    if (pathname === '/api/validate' && req.method === 'POST') {
      return await handleValidate(req, res);
    }
    if (pathname === '/api/contact' && req.method === 'POST') {
      return await handleContactSubmit(req, res);
    }
    if (pathname === '/api/contact' && req.method === 'GET') {
      return handleContactList(req, res);
    }
    if (pathname === '/api/stats' && req.method === 'GET') {
      return handleStats(req, res);
    }
    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { ok: false, error: 'Unknown API endpoint' });
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    sendJSON(res, 500, { ok: false, error: 'Internal error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Bhumi Setu demo server running at http://localhost:${PORT}`);
});
