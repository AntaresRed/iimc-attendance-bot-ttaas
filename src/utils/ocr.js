'use strict';

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
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

// ─── Constants ────────────────────────────────────────────────────────────────
const SCALE           = 2.5;   // upscale factor for preprocessImage
const MAX_OUTPUT_PX   = 4000;  // cap to avoid OOM on very large images (#4)
const MIN_INPUT_PX    = 300;   // reject images that are too small to OCR reliably (#3)
const MIN_CONFIDENCE  = 30;    // discard Tesseract words below this confidence (#8)
const FUZZY_THRESHOLD = 0.35;  // minimum similarity score for a course match (#10)
const MIN_PREFIX_LEN  = 8;     // minimum chars needed for prefix-match strategy (#10)
const OCR_TIMEOUT_MS  = 90_000; // max time allowed for the entire OCR pipeline (#17)

// ─── Image pre-processing ─────────────────────────────────────────────────────

/**
 * Validates that the image is large enough to OCR and returns its metadata.
 * Throws a structured error if the image is too small. (#3)
 */
async function validateImage(inputPath) {
  const meta = await sharp(inputPath).metadata();
  const { width = 0, height = 0 } = meta;
  if (width < MIN_INPUT_PX || height < MIN_INPUT_PX) {
    const err = new Error(`Image too small (${width}×${height}px). Minimum is ${MIN_INPUT_PX}px on each side.`);
    err.code = 'IMAGE_TOO_SMALL';
    throw err;
  }
  return meta;
}

/**
 * Pre-processes the image for better OCR accuracy:
 * - Scales up (capped at MAX_OUTPUT_PX so we don't OOM on large images) (#3, #4)
 * - Converts to grayscale + auto-contrast + sharpen
 */
async function preprocessImage(inputPath) {
  const outputPath = inputPath.replace(/(\.\w+)$/, '_processed.png');
  const meta = await validateImage(inputPath);

  // Calculate scale so output never exceeds MAX_OUTPUT_PX (#4)
  const maxDim = Math.max(meta.width, meta.height);
  const scale  = Math.min(SCALE, MAX_OUTPUT_PX / maxDim);

  await sharp(inputPath)
    .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: 'lanczos3' })
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1.5 })
    .png({ quality: 100 })
    .toFile(outputPath);

  return { outputPath, scale };
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

/**
 * Runs Tesseract OCR with PSM 11 (sparse text — best for calendar grids).
 * Words with confidence below MIN_CONFIDENCE are filtered out. (#8)
 */
async function runOCR(imagePath) {
  const worker = await createWorker('eng');
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const { data } = await worker.recognize(imagePath);
  await worker.terminate();

  // Filter out low-confidence noise words (#8)
  const words = (data.words || []).filter(w => w.confidence >= MIN_CONFIDENCE);
  return { text: data.text, words, lines: data.lines };
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function normalizeTime(str) {
  if (!str) return null;
  const cleaned = str.replace(/\s+/g, '').toUpperCase();
  const match = cleaned.match(/^(\d{1,2})[:.]?(\d{2})\s*(AM|PM)?$/);
  if (!match) return null;
  let [, h, m, meridiem] = match;
  h = parseInt(h, 10);
  m = parseInt(m, 10);
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

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

// ─── Subject resolution ───────────────────────────────────────────────────────

/**
 * Resolves a raw OCR string to the best matching course name.
 * Strategy 1: fuzzy similarity  — works when OCR reads most of the name.
 * Strategy 2: prefix containment — works when name is heavily truncated.
 * Thresholds raised to avoid false positive matches (#10).
 */
function resolveSubject(rawText) {
  const fuzzy = stringSimilarity.findBestMatch(rawText, VALID_COURSES);
  if (fuzzy.bestMatch.rating >= FUZZY_THRESHOLD) return fuzzy.bestMatch.target;

  // Only attempt prefix match if the raw text is long enough to be meaningful (#10)
  if (rawText.length >= MIN_PREFIX_LEN) {
    const rawLower = rawText.toLowerCase();
    const prefixMatch = VALID_COURSES.find(course => {
      const cl = course.toLowerCase();
      return cl.startsWith(rawLower) ||
             rawLower.startsWith(cl.slice(0, Math.max(rawText.length - 3, MIN_PREFIX_LEN)));
    });
    if (prefixMatch) return prefixMatch;
  }

  return rawText; // keep raw as fallback — user will see it in the OCR preview
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Runs OCR on a timetable calendar PNG and returns structured schedule entries.
 *
 * Returns one of:
 *   { entries: [...], rawWordCount: N }                       — success
 *   { entries: [], reason: 'IMAGE_TOO_SMALL', message: '…' } — image validation failed
 *   { entries: [], reason: 'NO_DAYS_DETECTED',  message: '…' }
 *   { entries: [], reason: 'NO_TIMES_DETECTED', message: '…' } (#6)
 *   { entries: [], reason: 'OCR_TIMEOUT',        message: '…' } (#17)
 */
async function parseTimetableImage(imagePath) {
  // Wrap entire process in a timeout (#17)
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => {
      const err = new Error('OCR timed out after 90 seconds.');
      err.code = 'OCR_TIMEOUT';
      reject(err);
    }, OCR_TIMEOUT_MS)
  );

  return Promise.race([_parseTimetableImage(imagePath), timeoutPromise])
    .catch(err => {
      const reason = err.code || 'OCR_ERROR';
      console.error(`[OCR] Failed: ${reason} — ${err.message}`);
      return {
        entries: [],
        reason,
        message: err.message,
      };
    });
}

async function _parseTimetableImage(imagePath) {
  let processedPath = null;
  try {
    const { outputPath, scale } = await preprocessImage(imagePath);
    processedPath = outputPath;

    const { words } = await runOCR(processedPath);
    if (!words || words.length === 0) {
      return { entries: [], reason: 'NO_TEXT_FOUND', message: 'Tesseract could not extract any text.' };
    }

    // ── 1. Detect Day column headers ──────────────────────────────────────────
    let dayWords = [];
    for (const w of words) {
      const clean = w.text.replace(/[^a-zA-Z]/g, '').toLowerCase();
      const dow = parseDayName(clean);
      if (dow !== null) {
        dayWords.push({
          dow,
          xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
          yCenter: (w.bbox.y0 + w.bbox.y1) / 2,
        });
      }
    }

    dayWords.sort((a, b) => a.yCenter - b.yCenter);
    const headerY = dayWords.length > 0 ? dayWords[0].yCenter : 0;
    dayWords = dayWords.filter(d => Math.abs(d.yCenter - headerY) < 80 * scale);

    const days = [];
    for (const d of dayWords) {
      if (!days.find(x => x.dow === d.dow)) days.push(d);
    }
    days.sort((a, b) => a.xCenter - b.xCenter);
    console.log(`[OCR] Days: ${days.map(d => `dow${d.dow}@x${Math.round(d.xCenter)}`).join(', ')}`);

    if (days.length === 0) {
      return { entries: [], reason: 'NO_DAYS_DETECTED', message: 'Could not find any day labels (Mon/Tue…) in the image.' };
    }

    // ── 2. Detect Time row labels ──────────────────────────────────────────────
    let times = [];
    for (const w of words) {
      const m = w.text.match(/\d{1,2}[:.]?\d{2}/);
      if (m) {
        const norm = normalizeTime(m[0]);
        if (norm) {
          times.push({
            time: norm,
            yCenter: (w.bbox.y0 + w.bbox.y1) / 2,
            xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
          });
        }
      }
    }

    if (times.length > 0) {
      times.sort((a, b) => a.xCenter - b.xCenter);
      const leftX = times[0].xCenter;
      times = times.filter(t => t.xCenter < leftX + 120 * scale);
    }

    times.sort((a, b) => a.yCenter - b.yCenter);
    const uniqueTimes = [];
    for (const t of times) {
      if (!uniqueTimes.length || t.yCenter - uniqueTimes[uniqueTimes.length - 1].yCenter > 30 * scale) {
        uniqueTimes.push(t);
      }
    }
    times = uniqueTimes;
    console.log(`[OCR] Times: ${times.map(t => `${t.time}@y${Math.round(t.yCenter)}`).join(', ')}`);

    if (times.length === 0) {
      return { entries: [], reason: 'NO_TIMES_DETECTED', message: 'Could not find any time labels (e.g. 09:00) in the image.' };
    }

    // ── 3. Assign words to grid cells ─────────────────────────────────────────
    const grid = new Map();

    for (const w of words) {
      const wx = (w.bbox.x0 + w.bbox.x1) / 2;
      const wy = (w.bbox.y0 + w.bbox.y1) / 2;

      if (days.some(d => Math.abs(wx - d.xCenter) < 15 * scale && Math.abs(wy - d.yCenter) < 15 * scale)) continue;
      if (times.some(t => Math.abs(wx - t.xCenter) < 15 * scale && Math.abs(wy - t.yCenter) < 15 * scale)) continue;

      if (days.length && wy < headerY - 20 * scale) continue;
      if (times.length && wx < times[0].xCenter - 20 * scale) continue;
      if (!days.length || !times.length) continue;

      let closestDay = days[0];
      let minDayDist = Math.abs(wx - closestDay.xCenter);
      for (const d of days) {
        const dist = Math.abs(wx - d.xCenter);
        if (dist < minDayDist) { minDayDist = dist; closestDay = d; }
      }

      let closestTime = null;
      let minTimeDist = Infinity;
      for (const t of times) {
        if (wy >= t.yCenter) {
          const dist = wy - t.yCenter;
          if (dist < minTimeDist) { minTimeDist = dist; closestTime = t; }
        }
      }
      if (!closestTime) {
        for (const t of times) {
          const dist = Math.abs(wy - t.yCenter);
          if (dist < minTimeDist) { minTimeDist = dist; closestTime = t; }
        }
      }

      if (minTimeDist > 200 * scale) continue;
      if (minDayDist  > 350 * scale) continue;

      const key = `${closestDay.dow}_${closestTime.time}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(w);
    }

    console.log(`[OCR] Grid cells: ${[...grid.keys()].join(', ')}`);

    // ── 4. Build entries ───────────────────────────────────────────────────────
    const add90Mins = (startStr) => {
      let [h, m] = startStr.split(':').map(Number);
      m += 90;
      h += Math.floor(m / 60);
      m = m % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // Use a Set to deduplicate by (day_of_week, start_time) (#7, #27)
    const seen = new Set();
    const entries = [];

    for (const [key, cellWords] of grid.entries()) {
      cellWords.sort((a, b) => {
        const ay = (a.bbox.y0 + a.bbox.y1) / 2;
        const by = (b.bbox.y0 + b.bbox.y1) / 2;
        if (Math.abs(ay - by) > 15) return ay - by;
        return a.bbox.x0 - b.bbox.x0;
      });

      const rawText = cellWords.map(w => w.text).join(' ').trim()
        .replace(/\.{2,}$/, '')
        .replace(/…$/, '')
        .trim();

      if (!rawText || rawText.length < 2) continue;

      const subject = resolveSubject(rawText);
      console.log(`[OCR] Cell ${key}: raw="${rawText}" → "${subject}"`);

      const [dowStr, timeStr] = key.split('_');

      // Deduplicate: skip if we already have an entry for this day+time (#7, #27)
      const dedupKey = `${dowStr}_${timeStr}`;
      if (seen.has(dedupKey)) {
        console.log(`[OCR] Skipping duplicate cell ${dedupKey}`);
        continue;
      }
      seen.add(dedupKey);

      entries.push({
        subject,
        day_of_week: parseInt(dowStr, 10),
        start_time:  timeStr,
        end_time:    add90Mins(timeStr),
      });
    }

    return { entries, rawWordCount: words.length };

  } finally {
    if (processedPath && fs.existsSync(processedPath)) {
      fs.unlinkSync(processedPath);
    }
  }
}

module.exports = { parseTimetableImage, normalizeTime, parseDayName, VALID_COURSES };
