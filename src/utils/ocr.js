'use strict';

/**
 * OCR module — timetable image → structured schedule entries
 *
 * Strategy:
 *  PRIMARY  : Google Gemini Vision (gemini-1.5-flash) — handles colored calendar
 *             grids that completely defeat Tesseract. Requires GEMINI_API_KEY.
 *  FALLBACK : Tesseract.js — used only when Gemini key is absent.
 *
 * Required env var (recommended):
 *   GEMINI_API_KEY   — free at aistudio.google.com, 1 500 free calls/day
 */

const fs   = require('fs');
const path = require('path');
const stringSimilarity = require('string-similarity');

const VALID_COURSES = [
  "Advanced Analytical Skills in Communication",
  "The WORD in the World: Linguistics for Managers",
  "Narrative of Things (NOT): A Narrative-System's Thinking Approach",
  "Ethics of Technology and Its Relevance for Business",
  "Economics of Development",
  "The Economics of Business Policy",
  "Decisions & Games",
  "Markets in Macroeconomics",
  "Options, Futures & Derivatives",
  "Investment Analysis & Portfolio Management",
  "Private Equity and Venture Capital (PEVC)",
  "Strategic Cost Management",
  "Behavioural Finance",
  "Introduction to Fintech",
  "Strategic Human Resource Management in Services",
  "Management Consulting",
  "Sales and Distribution Management",
  "International Marketing",
  "B2B Marketing",
  "Services Marketing",
  "Strategic Brand Management",
  "Internal Marketing",
  "Digital & Social Media Marketing",
  "Pricing Decisions",
  "Business Analytics for Managerial Decisions",
  "Social Network Analytics",
  "High-Tech Product Management in Practice",
  "Healthcare in the Digital Age",
  "Living Systems",
  "Organisational Leadership: Inspiration, Dilemmas & Action",
  "Management of Creativity",
  "Management of Change",
  "Designing Corporate Citizenship Initiatives",
  "Social Innovation",
  "Project Management",
  "Logistics and Supply Chain Management",
  "Constraint Management",
  "Operations Research Modeling",
  "Politics of Development",
  "Country Risk Analysis",
  "Managing the Legal & Regulatory Environment of Indian Business",
  "Mergers, Acquisitions and Divestments: Economic & Financial Aspects of Corporate Control",
  "Corporate Governance: An International Perspective",
  "Mainstreaming Sustainability in Business Practice",
  "IDT",
];

// ── Helpers shared by both strategies ────────────────────────────────────────

const DAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function parseDayName(str) {
  if (!str) return null;
  return DAY_MAP[str.toLowerCase().trim()] ?? null;
}

function normalizeTime(str) {
  if (!str) return null;
  const cleaned = str.replace(/\s+/g, '').toUpperCase();
  const match   = cleaned.match(/^(\d{1,2})[:.]?(\d{2})\s*(AM|PM)?$/);
  if (!match) return null;
  let [, h, m, meridiem] = match;
  h = parseInt(h, 10); m = parseInt(m, 10);
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function resolveSubject(rawText) {
  const fuzzy = stringSimilarity.findBestMatch(rawText, VALID_COURSES);
  if (fuzzy.bestMatch.rating >= 0.35) return fuzzy.bestMatch.target;
  if (rawText.length >= 8) {
    const rawLower = rawText.toLowerCase();
    const prefixMatch = VALID_COURSES.find(course => {
      const cl = course.toLowerCase();
      return cl.startsWith(rawLower) ||
             rawLower.startsWith(cl.slice(0, Math.max(rawText.length - 3, 8)));
    });
    if (prefixMatch) return prefixMatch;
  }
  return rawText;
}

function add90Mins(startStr) {
  let [h, m] = startStr.split(':').map(Number);
  m += 90; h += Math.floor(m / 60); m %= 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── STRATEGY 1: Google Gemini Vision ─────────────────────────────────────────

const GEMINI_PROMPT = `You are parsing a weekly class timetable image for an Indian management school.
Extract every class session visible in the grid.

Return ONLY a valid JSON array (no markdown, no explanation) where each element is:
{
  "subject": "<exact subject name as it appears in the image>",
  "day": "<full English day name, e.g. Monday>",
  "start_time": "<HH:MM in 24-hour format>",
  "end_time": "<HH:MM in 24-hour format>"
}

Rules:
- Use 24-hour time (e.g. 14:30 not 2:30 PM).
- If end_time is not visible, add 90 minutes to start_time.
- Only include cells that have a subject name; skip empty cells.
- Return [] if no sessions are found.`;

async function parseWithGemini(imagePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null; // signal to fall back to Tesseract

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType    = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64Image } },
        { text: GEMINI_PROMPT },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  };

  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const json    = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[OCR/Gemini] Raw response:', rawText.slice(0, 300));

  // Strip markdown code fences if Gemini wraps the JSON
  const cleaned = rawText.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();

  let sessions;
  try {
    sessions = JSON.parse(cleaned);
  } catch (_) {
    // Try to extract the first [...] array from the text
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error('Gemini returned non-JSON output: ' + rawText.slice(0, 200));
    sessions = JSON.parse(arrMatch[0]);
  }

  if (!Array.isArray(sessions)) return { entries: [], rawWordCount: 0 };

  const seen    = new Set();
  const entries = [];

  for (const s of sessions) {
    const dow = parseDayName(s.day);
    if (dow === null) { console.log(`[OCR/Gemini] Skipping unknown day: "${s.day}"`); continue; }

    const start = normalizeTime(s.start_time);
    if (!start)  { console.log(`[OCR/Gemini] Skipping bad time: "${s.start_time}"`); continue; }

    const end = normalizeTime(s.end_time) || add90Mins(start);

    // Fuzzy-match the subject to the master course list
    const subject  = resolveSubject((s.subject || '').trim());
    const dedupKey = `${dow}_${start}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    console.log(`[OCR/Gemini] ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} ${start}–${end}: "${s.subject}" → "${subject}"`);
    entries.push({ subject, day_of_week: dow, start_time: start, end_time: end });
  }

  return { entries, rawWordCount: sessions.length };
}

// ── STRATEGY 2: Tesseract fallback ───────────────────────────────────────────

async function parseWithTesseract(imagePath) {
  const { createWorker } = require('tesseract.js');
  const sharp            = require('sharp');

  const SCALE         = 2.5;
  const MAX_OUTPUT_PX = 4000;
  const MIN_INPUT_PX  = 300;
  const MIN_CONF      = 30;
  const FUZZY_THR     = 0.35;

  // Pre-process
  const meta = await sharp(imagePath).metadata();
  const { width = 0, height = 0 } = meta;
  if (width < MIN_INPUT_PX || height < MIN_INPUT_PX) {
    return { entries: [], reason: 'IMAGE_TOO_SMALL', message: `Image too small (${width}×${height}px).` };
  }
  const scale      = Math.min(SCALE, MAX_OUTPUT_PX / Math.max(width, height));
  const processedPath = imagePath.replace(/(\.\w+)$/, '_processed.png');
  await sharp(imagePath)
    .resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' })
    .greyscale().normalize().sharpen({ sigma: 1.5 })
    .png({ quality: 100 }).toFile(processedPath);

  let result;
  try {
    const worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const { data } = await worker.recognize(processedPath);
    await worker.terminate();
    const words = (data.words || []).filter(w => w.confidence >= MIN_CONF);

    // --- (existing grid-parse logic, condensed) ---
    let dayWords = [];
    for (const w of words) {
      const clean = w.text.replace(/[^a-zA-Z]/g, '').toLowerCase();
      const dow   = parseDayName(clean);
      if (dow !== null) dayWords.push({ dow, xCenter: (w.bbox.x0+w.bbox.x1)/2, yCenter: (w.bbox.y0+w.bbox.y1)/2 });
    }
    dayWords.sort((a,b) => a.yCenter - b.yCenter);
    const headerY = dayWords[0]?.yCenter ?? 0;
    dayWords = dayWords.filter(d => Math.abs(d.yCenter - headerY) < 80*scale);
    const days = [];
    for (const d of dayWords) { if (!days.find(x => x.dow === d.dow)) days.push(d); }
    days.sort((a,b) => a.xCenter - b.xCenter);
    if (!days.length) return { entries: [], reason: 'NO_DAYS_DETECTED', message: 'Could not find day labels.' };

    let times = [];
    for (const w of words) {
      const m = w.text.match(/\d{1,2}[:.]?\d{2}/);
      if (m) { const t = normalizeTime(m[0]); if (t) times.push({ time: t, yCenter: (w.bbox.y0+w.bbox.y1)/2, xCenter: (w.bbox.x0+w.bbox.x1)/2 }); }
    }
    if (times.length) { times.sort((a,b) => a.xCenter - b.xCenter); const lx = times[0].xCenter; times = times.filter(t => t.xCenter < lx+120*scale); }
    times.sort((a,b) => a.yCenter - b.yCenter);
    const uTimes = [];
    for (const t of times) { if (!uTimes.length || t.yCenter - uTimes[uTimes.length-1].yCenter > 30*scale) uTimes.push(t); }
    times = uTimes;
    if (!times.length) return { entries: [], reason: 'NO_TIMES_DETECTED', message: 'Could not find time labels.' };

    const grid = new Map();
    for (const w of words) {
      const wx = (w.bbox.x0+w.bbox.x1)/2, wy = (w.bbox.y0+w.bbox.y1)/2;
      if (days.some(d => Math.abs(wx-d.xCenter)<15*scale && Math.abs(wy-d.yCenter)<15*scale)) continue;
      if (times.some(t => Math.abs(wx-t.xCenter)<15*scale && Math.abs(wy-t.yCenter)<15*scale)) continue;
      if (wy < headerY - 20*scale) continue;
      let cd = days[0], md = Math.abs(wx-cd.xCenter);
      for (const d of days) { const dist = Math.abs(wx-d.xCenter); if (dist < md) { md = dist; cd = d; } }
      let ct = null, mt = Infinity;
      for (const t of times) { if (wy >= t.yCenter) { const d = wy-t.yCenter; if (d < mt) { mt = d; ct = t; } } }
      if (!ct) for (const t of times) { const d = Math.abs(wy-t.yCenter); if (d < mt) { mt = d; ct = t; } }
      if (mt > 200*scale || md > 350*scale) continue;
      const key = `${cd.dow}_${ct.time}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(w);
    }

    const seen = new Set(); const entries = [];
    for (const [key, cw] of grid.entries()) {
      cw.sort((a,b) => { const ay=(a.bbox.y0+a.bbox.y1)/2, by=(b.bbox.y0+b.bbox.y1)/2; return Math.abs(ay-by) > 15 ? ay-by : a.bbox.x0-b.bbox.x0; });
      const raw = cw.map(w => w.text).join(' ').trim().replace(/\.{2,}$|…$/, '').trim();
      if (!raw || raw.length < 2) continue;
      const subject = resolveSubject(raw);
      const [dowStr, timeStr] = key.split('_');
      if (seen.has(key)) continue; seen.add(key);
      entries.push({ subject, day_of_week: parseInt(dowStr, 10), start_time: timeStr, end_time: add90Mins(timeStr) });
    }
    result = { entries, rawWordCount: words.length };
  } finally {
    try { fs.unlinkSync(processedPath); } catch (_) {}
  }
  return result;
}

// ── Public interface ──────────────────────────────────────────────────────────

async function parseTimetableImage(imagePath) {
  const OCR_TIMEOUT_MS = 120_000;

  const run = async () => {
    // Try Gemini first (much more accurate for calendar grids)
    if (process.env.GEMINI_API_KEY) {
      console.log('[OCR] Using Gemini Vision strategy...');
      const geminiResult = await parseWithGemini(imagePath);
      if (geminiResult !== null) return geminiResult;
    }
    // Fall back to Tesseract
    console.log('[OCR] Gemini key not set — falling back to Tesseract...');
    return parseWithTesseract(imagePath);
  };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error('OCR timed out.'), { code: 'OCR_TIMEOUT' })), OCR_TIMEOUT_MS)
  );

  return Promise.race([run(), timeout]).catch(err => {
    console.error(`[OCR] Failed: ${err.code || 'OCR_ERROR'} — ${err.message}`);
    return { entries: [], reason: err.code || 'OCR_ERROR', message: err.message };
  });
}

module.exports = { parseTimetableImage, normalizeTime, parseDayName, VALID_COURSES };
