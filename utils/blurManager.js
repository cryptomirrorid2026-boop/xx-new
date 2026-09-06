// ============================================================
//   UTILS / BLURMANAGER.JS  v3 — PowerBlur Edition
//   Three-mode watermark blur engine:
//     1. Manual Templates (% or fixed PX mode)
//     2. OCR Text Detection (Tesseract.js) — auto-detects keywords
//     3. Template Matching (Pure JS) — finds logo visually
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');
const { inpaintBox } = require('./lamaInpaint');

const BLUR_DATA_PATH       = path.join(__dirname, '../data/blur-settings.json');
const TEMPLATES_DIR        = path.join(__dirname, '../data/source-templates');
const OCR_SETTINGS_PATH    = path.join(__dirname, '../data/ocr-settings.json');
const MATCH_SETTINGS_PATH  = path.join(__dirname, '../data/match-settings.json');

// Tesseract lazy-loaded to avoid heavy startup cost
let tesseractWorker = null;
let tesseractReady  = false;
let tesseractLoading = false;

// ─── OCR Engine Init ──────────────────────────────────────────
async function getOcrWorker() {
  if (tesseractReady && tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    // Wait until ready
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (tesseractReady) { clearInterval(interval); resolve(); }
      }, 200);
    });
    return tesseractWorker;
  }

  tesseractLoading = true;
  try {
    const { createWorker } = require('tesseract.js');
    tesseractWorker = await createWorker('eng', 1, {
      logger: () => {},       // Silence progress logs
      errorHandler: () => {},
    });
    tesseractReady  = true;
    tesseractLoading = false;
    logger.info('✅ Tesseract OCR worker siap.');
  } catch (err) {
    tesseractLoading = false;
    logger.error('❌ Gagal init Tesseract OCR:', err.message);
    return null;
  }
  return tesseractWorker;
}

// ─── Settings Helpers ────────────────────────────────────────
function loadJson(filePath, defaultVal = {}) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return defaultVal;
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    logger.error(`Error saving ${path.basename(filePath)}:`, err.message);
    return false;
  }
}

// ─── Template Matching (Pure JS, no native deps) ─────────────
/**
 * Compute normalised cross-correlation between source and template
 * using greyscale raw pixel buffers. Returns {x, y, score}.
 * score: 1.0 = perfect match.
 *
 * Strategy: downsample both images for speed, then run sliding window.
 */
async function findTemplateInImage(srcBuffer, tplBuffer, threshold = 0.80) {
  try {
    const MAX_DIM = 400; // Maximum dimension for matching (speed vs accuracy)

    // 1. Load source image to greyscale, capped at MAX_DIM
    const srcMeta = await sharp(srcBuffer).metadata();
    const srcScaleW = Math.min(1, MAX_DIM / srcMeta.width);
    const srcScaleH = Math.min(1, MAX_DIM / srcMeta.height);
    const srcScale  = Math.min(srcScaleW, srcScaleH);
    const srcW = Math.round(srcMeta.width  * srcScale);
    const srcH = Math.round(srcMeta.height * srcScale);

    const srcRaw = await sharp(srcBuffer)
      .resize(srcW, srcH, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();

    // 2. Load template image to greyscale, capped proportionally
    const tplMeta = await sharp(tplBuffer).metadata();
    const tplScale = srcScale; // Same scale as source for accurate size mapping
    const tplW = Math.max(1, Math.round(tplMeta.width  * tplScale));
    const tplH = Math.max(1, Math.round(tplMeta.height * tplScale));

    if (tplW >= srcW || tplH >= srcH) {
      logger.warn('Template Matching: Template lebih besar dari source image, skip.');
      return null;
    }

    const tplRaw = await sharp(tplBuffer)
      .resize(tplW, tplH, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();

    // 3. Precompute template mean and sum of squares (for NCC)
    let tplMean = 0;
    for (let i = 0; i < tplRaw.length; i++) tplMean += tplRaw[i];
    tplMean /= tplRaw.length;

    let tplSumSq = 0;
    for (let i = 0; i < tplRaw.length; i++) {
      const d = tplRaw[i] - tplMean;
      tplSumSq += d * d;
    }
    const tplStd = Math.sqrt(tplSumSq);
    if (tplStd === 0) return null; // Empty or uniform template

    // 4. Sliding window NCC
    let bestScore = -Infinity;
    let bestX = 0;
    let bestY = 0;

    const stepX = Math.max(1, Math.floor(tplW / 4));   // Step = 25% of template width (speed)
    const stepY = Math.max(1, Math.floor(tplH / 4));

    for (let sy = 0; sy <= srcH - tplH; sy += stepY) {
      for (let sx = 0; sx <= srcW - tplW; sx += stepX) {
        // Compute window mean
        let winSum = 0;
        for (let ty = 0; ty < tplH; ty++) {
          for (let tx = 0; tx < tplW; tx++) {
            winSum += srcRaw[(sy + ty) * srcW + (sx + tx)];
          }
        }
        const winMean = winSum / tplRaw.length;

        // Compute NCC
        let crossCorr = 0;
        let winSumSq  = 0;
        for (let ty = 0; ty < tplH; ty++) {
          for (let tx = 0; tx < tplW; tx++) {
            const sVal = srcRaw[(sy + ty) * srcW + (sx + tx)] - winMean;
            const tVal = tplRaw[ty * tplW + tx] - tplMean;
            crossCorr += sVal * tVal;
            winSumSq  += sVal * sVal;
          }
        }
        const winStd = Math.sqrt(winSumSq);
        if (winStd === 0) continue;

        const score = crossCorr / (tplStd * winStd);
        if (score > bestScore) {
          bestScore = score;
          bestX = sx;
          bestY = sy;
        }
      }
    }

    logger.info(`Template Matching: Best NCC score = ${bestScore.toFixed(3)} @ (${bestX},${bestY})`);

    if (bestScore < threshold) {
      logger.info(`Template Matching: Score ${bestScore.toFixed(3)} < threshold ${threshold}, tidak ditemukan.`);
      return null;
    }

    // 5. Map back to original image coordinates (with padding)
    const padPx = 8; // Extra padding around matched area
    const origX = Math.max(0, Math.round(bestX / srcScale) - padPx);
    const origY = Math.max(0, Math.round(bestY / srcScale) - padPx);
    const origW = Math.round(tplMeta.width)  + padPx * 2;
    const origH = Math.round(tplMeta.height) + padPx * 2;

    return { x: origX, y: origY, w: origW, h: origH, score: bestScore };
  } catch (err) {
    logger.error('Template Matching error:', err.message);
    return null;
  }
}

// ─── Main BlurManager Class ───────────────────────────────────
class BlurManager {
  constructor() {
    this.data         = {};
    this.ocrSettings  = {};
    this.matchSettings = {};
    this.load();
  }

  load() {
    this.data         = loadJson(BLUR_DATA_PATH, {});
    this.ocrSettings  = loadJson(OCR_SETTINGS_PATH,   { enabled: false, keywords: [], blurPadding: 20 });
    this.matchSettings = loadJson(MATCH_SETTINGS_PATH, { enabled: false, threshold: 0.80, blurStrength: 50 });
  }

  save() {
    return saveJson(BLUR_DATA_PATH, this.data);
  }

  // ── Blur template CRUD ──────────────────────────────────────
  getAll() { return this.data; }

  getChannel(channelId) {
    const specific = this.data[channelId];
    if (specific && specific.enabled) return specific;
    return this.data['GLOBAL'] || { enabled: false, templates: [] };
  }

  setChannel(channelId, { enabled, templates }) {
    this.data[channelId] = { enabled: !!enabled, templates: templates || [] };
    return this.save();
  }

  removeChannel(channelId) {
    if (this.data[channelId]) {
      delete this.data[channelId];
      return this.save();
    }
    return false;
  }

  isOcrEnabled() {
    if (process.env.ENABLE_AI_WATERMARK === 'false') return false;
    return !!this.ocrSettings?.enabled;
  }

  hasAnyBlur(channelId) {
    const config = this.getChannel(channelId);
    if (config && config.enabled && config.templates && config.templates.length > 0) return true;
    if (this.isOcrEnabled() && this.ocrSettings && this.ocrSettings.keywords && this.ocrSettings.keywords.length > 0) return true;
    if (this.matchSettings && this.matchSettings.enabled) return true;
    return false;
  }

  // ── OCR Settings ─────────────────────────────────────────────
  getOcrSettings()  { return this.ocrSettings; }

  setOcrSettings(settings) {
    this.ocrSettings = { ...this.ocrSettings, ...settings };
    return saveJson(OCR_SETTINGS_PATH, this.ocrSettings);
  }

  // ── Template Matching Settings ────────────────────────────────
  getMatchSettings() { return this.matchSettings; }

  setMatchSettings(settings) {
    this.matchSettings = { ...this.matchSettings, ...settings };
    return saveJson(MATCH_SETTINGS_PATH, this.matchSettings);
  }

  // ── List uploaded source template files ───────────────────────
  listSourceTemplates() {
    try {
      if (!fs.existsSync(TEMPLATES_DIR)) return [];
      return fs.readdirSync(TEMPLATES_DIR)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map(f => ({ name: f, path: path.join(TEMPLATES_DIR, f) }));
    } catch { return []; }
  }

  deleteSourceTemplate(filename) {
    const filePath = path.join(TEMPLATES_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  // ── Find best aspect-ratio template ──────────────────────────
  findBestTemplate(channelId, width, height) {
    const config = this.getChannel(channelId);
    if (!config.enabled || !config.templates || config.templates.length === 0) return null;

    const targetRatio = width / height;
    let bestTemplate = null;
    let minDiff = Infinity;

    for (const template of config.templates) {
      if (!template.boxes || template.boxes.length === 0) continue;
      const diff = Math.abs(targetRatio - (template.aspectRatio || 1));
      if (diff < minDiff) { minDiff = diff; bestTemplate = template; }
    }

    if (bestTemplate) {
      logger.info(`Blur Template ditemukan: "${bestTemplate.name}" (Diff: ${minDiff.toFixed(3)})`);
    }
    return bestTemplate;
  }

  // ─── CORE: Build blur composite operations for a box ─────────
  async _buildBlurOp(imageBuffer, mainW, mainH, box, blurStrength = 50) {
    const anchor = box.anchor || 'top-left';
    const mode   = box.mode   || 'percent'; // 'percent' or 'pixel'

    let bw, bh, bx, by;

    if (mode === 'pixel') {
      // FIXED PIXEL MODE: size in px, offset from anchor corner
      bw = Math.floor(box.w);
      bh = Math.floor(box.h);
      const offX = Math.floor(box.x); // offset px from anchor
      const offY = Math.floor(box.y);

      if (anchor === 'bottom-right') {
        bx = mainW - offX - bw;
        by = mainH - offY - bh;
      } else if (anchor === 'bottom-left') {
        bx = offX;
        by = mainH - offY - bh;
      } else if (anchor === 'top-right') {
        bx = mainW - offX - bw;
        by = offY;
      } else { // top-left
        bx = offX;
        by = offY;
      }
    } else {
      // PERCENTAGE MODE (legacy)
      bw = Math.floor((box.w / 100) * mainW);
      bh = Math.floor((box.h / 100) * mainH);

      if (anchor === 'bottom-right') {
        bx = mainW - Math.floor((box.x / 100) * mainW) - bw;
        by = mainH - Math.floor((box.y / 100) * mainH) - bh;
      } else if (anchor === 'bottom-left') {
        bx = Math.floor((box.x / 100) * mainW);
        by = mainH - Math.floor((box.y / 100) * mainH) - bh;
      } else if (anchor === 'top-right') {
        bx = mainW - Math.floor((box.x / 100) * mainW) - bw;
        by = Math.floor((box.y / 100) * mainH);
      } else {
        bx = Math.floor((box.x / 100) * mainW);
        by = Math.floor((box.y / 100) * mainH);
      }
    }

    // Clamp to image bounds
    bx = Math.max(0, Math.min(bx, mainW - 1));
    by = Math.max(0, Math.min(by, mainH - 1));
    const finalW = Math.max(1, Math.min(bw, mainW - bx));
    const finalH = Math.max(1, Math.min(bh, mainH - by));

    // Calculate bounding box object for region scanning
    const boundingBox = { left: bx, top: by, width: finalW, height: finalH };
    
    // If it's just for scanning (no visual modification), return the bbox
    if (box.action === 'scan-ocr' || box.action === 'scan-match') {
      return boundingBox;
    }

    let region;
    if (box.action === 'ai-redraw') {
      // Smart Background Fill: Sample a 10x10 area strictly OUTSIDE the watermark (above it)
      const sampleSize = 10;
      let sampleX = bx;
      let sampleY = Math.max(0, by - sampleSize);
      // Jika mentok atas, ambil dari bawahnya
      if (by < sampleSize) sampleY = Math.min(mainH - sampleSize, by + finalH);
      const sampleW = Math.min(sampleSize, mainW - sampleX);
      const sampleH = Math.min(sampleSize, mainH - sampleY);
      
      region = await sharp(imageBuffer)
        .extract({ left: sampleX, top: sampleY, width: sampleW, height: sampleH })
        .resize(1, 1, { fit: 'fill' }) // exact background average color
        .resize(finalW, finalH, { fit: 'fill' }) // expand to full watermark block
        .toBuffer();
    } else {
      // default: 'blur'
      region = await sharp(imageBuffer)
        .extract(boundingBox)
        .blur(blurStrength)
        .toBuffer();
    }

    // Apply SVG Feather Mask to region for smooth edge blend
    const rx = Math.min(10, Math.floor(Math.min(finalW, finalH) / 4));
    const fr = Math.min(5, Math.floor(Math.min(finalW, finalH) / 3));
    if (fr >= 1 && finalW > 6 && finalH > 6) {
      try {
        const svgMask = Buffer.from(`
          <svg width="${finalW}" height="${finalH}">
            <defs>
              <filter id="f" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="${fr}" />
              </filter>
            </defs>
            <rect x="${fr}" y="${fr}" width="${Math.max(1, finalW - fr * 2)}" height="${Math.max(1, finalH - fr * 2)}" rx="${rx}" ry="${rx}" fill="#ffffff" filter="url(#f)" />
          </svg>
        `);
        region = await sharp(region)
          .composite([{ input: svgMask, blend: 'dest-in' }])
          .toBuffer();
      } catch (e) {}
    }

    return { input: region, left: bx, top: by };
  }

  /**
   * Blend a region buffer onto imageBuffer using a smooth Gaussian SVG Alpha Feather Mask.
   * Eliminates hard rectangular box borders and makes blur/redraw blend seamlessly!
   */
  async _compositeWithFeather(imageBuffer, regionBuffer, x0, y0, bw, bh, featherRadius = 5) {
    if (bw <= 4 || bh <= 4) {
      return sharp(imageBuffer).composite([{ input: regionBuffer, left: x0, top: y0 }]).toBuffer();
    }

    const rx = Math.min(10, Math.floor(Math.min(bw, bh) / 4));
    const fr = Math.min(featherRadius, Math.floor(Math.min(bw, bh) / 3));

    try {
      if (fr >= 1 && bw > 6 && bh > 6) {
        const svgMask = Buffer.from(`
          <svg width="${bw}" height="${bh}">
            <defs>
              <filter id="f" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="${fr}" />
              </filter>
            </defs>
            <rect x="${fr}" y="${fr}" width="${Math.max(1, bw - fr * 2)}" height="${Math.max(1, bh - fr * 2)}" rx="${rx}" ry="${rx}" fill="#ffffff" filter="url(#f)" />
          </svg>
        `);

        const maskedRegion = await sharp(regionBuffer)
          .resize(bw, bh, { fit: 'fill' })
          .composite([{ input: svgMask, blend: 'dest-in' }])
          .toBuffer();

        return sharp(imageBuffer)
          .composite([{ input: maskedRegion, left: x0, top: y0 }])
          .toBuffer();
      }
    } catch (err) {
      logger.warn('Feather mask composite error, fallback ke standard composite:', err.message);
    }

    return sharp(imageBuffer)
      .composite([{ input: regionBuffer, left: x0, top: y0 }])
      .toBuffer();
  }

  // ─── MAIN applyBlur ──────────────────────────────────────────
  async applyBlur(imageBuffer, channelId) {
    // Jika semua fitur blur, template, & AI OCR nonaktif, langsung return tanpa decoding Sharp
    if (!this.hasAnyBlur(channelId)) {
      return imageBuffer;
    }

    // Only process images
    try {
      const metadata = await sharp(imageBuffer).metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'].includes(metadata.format)) {
        return imageBuffer;
      }

      const mainW = metadata.width;
      const mainH = metadata.height;
      const compositeOps = [];
      
      let ocrRegions = [];
      let matchRegions = [];

      // ── Step 1: Manual Template Boxes (% or px mode) ──────────
      const config = this.getChannel(channelId);
      if (config.enabled) {
        const template = this.findBestTemplate(channelId, mainW, mainH);
        if (template && template.boxes && template.boxes.length > 0) {
          let appliedCount = 0;
          for (const box of template.boxes) {
            try {
              const op = await this._buildBlurOp(imageBuffer, mainW, mainH, box, 50);
              
              if (box.action === 'scan-ocr') {
                ocrRegions.push(op);
              } else if (box.action === 'scan-match') {
                matchRegions.push(op);
              } else {
                compositeOps.push(op);
                appliedCount++;
              }
            } catch (e) {
              logger.warn('Blur box error (manual):', e.message);
            }
          }
          if (appliedCount > 0) logger.info(`Manual Edit: ${appliedCount} box(es) diterapkan.`);
        }
      }

      // ── Apply manual composite ops first ───────────────────────
      if (compositeOps.length > 0) {
        logger.info(`PowerBlur: Menerapkan ${compositeOps.length} area blur manual.`);
        imageBuffer = await sharp(imageBuffer).composite(compositeOps).toBuffer();
      }

      // ── Step 2: OCR Text Detection ─────────────────────────────
      if (this.isOcrEnabled() && this.ocrSettings.keywords && this.ocrSettings.keywords.length > 0) {
        try {
          imageBuffer = await this._applyOcrBlur(imageBuffer, mainW, mainH, ocrRegions);
        } catch (err) {
          logger.error('OCR Blur step error:', err.message);
        }
      }

      // ── Step 3: Template Matching (Logo Detection) ─────────────
      if (this.matchSettings.enabled) {
        try {
          imageBuffer = await this._applyTemplateMatchBlur(imageBuffer, mainW, mainH, matchRegions);
        } catch (err) {
          logger.error('Template Match Blur step error:', err.message);
        }
      }

      return imageBuffer;
    } catch (err) {
      logger.error('applyBlur fatal error:', err.message);
      return imageBuffer;
    }
  }

  // ─── OCR Step Implementation ─────────────────────────────────
  async _applyOcrBlur(imageBuffer, mainW, mainH, ocrRegions = []) {
    let appliedCount = 0;
    const worker = await getOcrWorker();
    if (!worker) return imageBuffer;

    try {
      // If no specific regions, scan full image only for faster processing
      let regionsToScan = ocrRegions.length > 0 ? ocrRegions : [];
      if (regionsToScan.length === 0) {
          regionsToScan.push({ left: 0, top: 0, width: mainW, height: mainH }); // Full image
      }
      
      const userKeywords = this.ocrSettings.keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
      const defaultAutoPatterns = [
        'tradingview',
        'created with',
        '/tradingview\\.com/i',
        '/mirror\\s*ori/i',
        '/08\\d{2,4}[-\\s]?\\d{3,5}[-\\s]?\\d{3,5}/', // Phone/WA numbers e.g. 089 777 54040
        '/wa\\s*:\\s*[\\d\\s]+/i',
        '/@\\w{3,20}/i',
      ];

      const keywordsSet = new Set([...userKeywords, ...defaultAutoPatterns]);
      const keywords = [...keywordsSet];
      const padding   = this.ocrSettings.blurPadding || 20;
      const matched   = new Set(); // deduplicate
      
      if (keywords.length === 0) return imageBuffer;

      for (const region of regionsToScan) {
        let ocrBuffer = imageBuffer;
        const regionW = region.width || mainW;
        const regionH = region.height || mainH;
        const offsetX = region.left || 0;
        const offsetY = region.top || 0;

        let regionScale = 2000 / Math.max(regionW, regionH);
        if (regionW === mainW && regionH === mainH) {
            regionScale = Math.max(1.0, Math.min(2.5, regionScale));
            if (Math.max(mainW, mainH) > 3000) regionScale = 2500 / Math.max(mainW, mainH);
        } else {
            regionScale = Math.max(1.5, Math.min(3.5, regionScale));
        }

        if (regionW !== mainW || regionH !== mainH) {
          ocrBuffer = await sharp(imageBuffer)
            .extract({ left: offsetX, top: offsetY, width: regionW, height: regionH })
            .toBuffer();
        }
        
        const scaledW = Math.round(regionW * regionScale);
        const scaledH = Math.round(regionH * regionScale);

        // Pass 1: Normal Contrast
        const ocrPass1 = await sharp(ocrBuffer)
          .resize(scaledW, scaledH)
          .greyscale()
          .normalize()
          .toBuffer();

        // Pass 2: High-Contrast Binarization (specifically boosts low-contrast dark watermarks on black background)
        const ocrPass2 = await sharp(ocrBuffer)
          .resize(scaledW, scaledH)
          .greyscale()
          .linear(3.0, -90)
          .toBuffer();

        const [res1, res2] = await Promise.all([
          worker.recognize(ocrPass1).catch(() => ({ data: { words: [] } })),
          worker.recognize(ocrPass2).catch(() => ({ data: { words: [] } }))
        ]);

        const validWords = [
          ...(res1?.data?.words || []),
          ...(res2?.data?.words || [])
        ].filter(w => (w.text || '').trim().length > 0 && w.confidence >= 8);
      
        let reconstructed = "";
        const charToWordMap = [];
        let reconstructedSpaced = "";
        const charToWordMapSpaced = [];

        for (const w of validWords) {
          const text = w.text.toLowerCase();
          for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (!/\s/.test(char)) {
              reconstructed += char;
              charToWordMap.push(w);
            }
          }
          const textSpaced = w.text + " ";
          for (let i = 0; i < textSpaced.length; i++) {
            reconstructedSpaced += textSpaced[i].toLowerCase();
            charToWordMapSpaced.push(w);
          }
        }

        for (const kw of keywords) {
          const wordsToBlurGlobal = new Set();

          // Robust regex parsing (supports flags like /i, /g, etc.)
          let isRegex = false;
          let regexObj = null;
          if (kw.startsWith('/')) {
            const lastSlash = kw.lastIndexOf('/');
            if (lastSlash > 0) {
              const pattern = kw.slice(1, lastSlash);
              const flags = kw.slice(lastSlash + 1);
              try {
                regexObj = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
                isRegex = true;
              } catch (e) {}
            }
          }

          if (isRegex && regexObj) {
            try {
              let match;
              while ((match = regexObj.exec(reconstructedSpaced)) !== null) {
                for (let i = match.index; i < match.index + match[0].length; i++) {
                  if (charToWordMapSpaced[i]) wordsToBlurGlobal.add(charToWordMapSpaced[i]);
                }
              }
            } catch (e) {}
          } else {
            const normalizedKw = kw.toLowerCase().replace(/\s+/g, '');
            if (normalizedKw.length > 0) {
              // Stricter error tolerance for short keywords, but more forgiving for long phrases
              const maxErrors = normalizedKw.length <= 4 ? 0 : 
                                normalizedKw.length <= 8 ? 1 : 
                                Math.floor(normalizedKw.length / 4);
              const m = normalizedKw.length;
              const n = reconstructed.length;
              let dp = new Array(m + 1).fill(0).map((_, idx) => idx);
              
              for (let i = 1; i <= n; i++) {
                  let nextDp = new Array(m + 1).fill(0);
                  nextDp[0] = 0;
                  for (let j = 1; j <= m; j++) {
                      const cost = reconstructed[i - 1] === normalizedKw[j - 1] ? 0 : 1;
                      nextDp[j] = Math.min(dp[j] + 1, nextDp[j - 1] + 1, dp[j - 1] + cost);
                  }
                  if (nextDp[m] <= maxErrors) {
                      const estimatedStart = Math.max(0, i - m);
                      for (let k = estimatedStart; k < i; k++) {
                        if (charToWordMap[k]) wordsToBlurGlobal.add(charToWordMap[k]);
                      }
                      nextDp = new Array(m + 1).fill(0).map((_, idx) => idx);
                  }
                  dp = nextDp;
              }
            }
          }

          if (wordsToBlurGlobal.size > 0) {
            const clusters = [];
            for (const w of wordsToBlurGlobal) {
              let added = false;
              for (const cluster of clusters) {
                // Tighter cluster distance (40px instead of 250px) to prevent chain-reaction merging
                const cx0 = cluster.minX - 40;
                const cy0 = cluster.minY - 40;
                const cx1 = cluster.maxX + 40;
                const cy1 = cluster.maxY + 40;
                if (w.bbox.x0 <= cx1 && w.bbox.x1 >= cx0 && w.bbox.y0 <= cy1 && w.bbox.y1 >= cy0) {
                  cluster.words.push(w);
                  cluster.minX = Math.min(cluster.minX, w.bbox.x0);
                  cluster.minY = Math.min(cluster.minY, w.bbox.y0);
                  cluster.maxX = Math.max(cluster.maxX, w.bbox.x1);
                  cluster.maxY = Math.max(cluster.maxY, w.bbox.y1);
                  added = true;
                  break;
                }
              }
              if (!added) {
                clusters.push({ words: [w], minX: w.bbox.x0, minY: w.bbox.y0, maxX: w.bbox.x1, maxY: w.bbox.y1 });
              }
            }

            for (const cluster of clusters) {
              const textHeight = Math.ceil((cluster.maxY - cluster.minY) / regionScale);
              const effectivePadding = Math.min(padding, Math.max(3, Math.round(textHeight * 0.35)));

              let x0 = Math.max(0, Math.floor(cluster.minX / regionScale) - effectivePadding) + offsetX;
              let y0 = Math.max(0, Math.floor(cluster.minY / regionScale) - effectivePadding) + offsetY;
              let localX1 = Math.ceil(cluster.maxX / regionScale) + effectivePadding;
              let localY1 = Math.ceil(cluster.maxY / regionScale) + effectivePadding;
              let x1 = Math.min(mainW, localX1 + offsetX);
              let y1 = Math.min(mainH, localY1 + offsetY);
              let bw = x1 - x0;
              let bh = y1 - y0;

              if (bw < 2 || bh < 2) continue;

              // ── TradingView Smart Auto-Coverage Rules ─────────────────────
              const isTradingViewHeader = y0 <= mainH * 0.12 && (kw.includes('tradingview') || kw.includes('created') || kw.includes('utc'));
              const isTradingViewLogo = y0 >= mainH * 0.85 && x0 <= mainW * 0.45 && (kw.includes('tradingview') || kw.includes('17'));
              const isLowerChartWatermark = y0 >= mainH * 0.60;

              if (isTradingViewHeader) {
                // Expand to cover full top-left TradingView title bar
                x0 = 0;
                y0 = 0;
                bw = Math.min(mainW, Math.round(mainW * 0.68));
                bh = Math.max(bh, Math.round(mainH * 0.055));
                logger.info(`🎯 TradingView Header Auto-Clean Triggered @ [0,0,${bw}x${bh}]`);
              } else if (isTradingViewLogo) {
                // Expand to cover bottom-left TradingView logo
                x0 = 0;
                y0 = Math.round(mainH * 0.92);
                bw = Math.min(mainW, Math.round(mainW * 0.35));
                bh = Math.round(mainH * 0.08);
                logger.info(`🎯 TradingView Logo Auto-Clean Triggered @ [0,${y0},${bw}x${bh}]`);
              } else if (isLowerChartWatermark) {
                // Expand width horizontally & height slightly to cover low-contrast multi-line dark watermarks
                x0 = Math.max(0, Math.floor(x0 - mainW * 0.15));
                bw = Math.min(mainW - x0, Math.ceil(bw + mainW * 0.30));
                y0 = Math.max(0, Math.floor(y0 - bh * 0.5));
                bh = Math.min(mainH - y0, Math.ceil(bh * 2.0));
                logger.info(`🎯 Lower Chart Watermark Zone Expansion Triggered @ [${x0},${y0},${bw}x${bh}]`);
              }

              // Aggressive deduplication: if we already matched something within ~40px of this spot, skip it
              const keyX = Math.round(x0 / 40) * 40;
              const keyY = Math.round(y0 / 40) * 40;
              let isDuplicate = false;
              for (let dx = -40; dx <= 40; dx += 40) {
                  for (let dy = -40; dy <= 40; dy += 40) {
                      if (matched.has(`${keyX + dx}_${keyY + dy}`)) isDuplicate = true;
                  }
              }
              if (isDuplicate) continue;
              matched.add(`${keyX}_${keyY}`);

              logger.info(`OCR Smart Match (Clustered): "${kw}" @ [${x0},${y0},${bw}x${bh}] (pad: ${effectivePadding}px)`);

              const action = this.ocrSettings.action || 'blur';
              let regionData;
              
              if (action === 'lama-inpaint' && appliedCount < 1) {
                try {
                  const res = await inpaintBox(imageBuffer, { x: x0, y: y0, width: bw, height: bh }, 40);
                  regionData = res.buffer;
                  x0 = res.left;
                  y0 = res.top;
                } catch (e) {
                  logger.error(`LaMa Inpaint error: ${e.message}. Fallback ke blur biasa.`);
                  regionData = await sharp(imageBuffer)
                    .extract({ left: x0, top: y0, width: bw, height: bh })
                    .blur(Math.max(15, Math.min(50, Math.round(bh * 0.7))))
                    .toBuffer();
                }
              } else if (action === 'lama-inpaint') {
                // Box berikutnya gunakan blur instan agar forward tidak delay
                regionData = await sharp(imageBuffer)
                  .extract({ left: x0, top: y0, width: bw, height: bh })
                  .blur(Math.max(15, Math.min(50, Math.round(bh * 0.7))))
                  .toBuffer();
              } else if (action === 'ai-redraw') {
                const sampleSize = Math.max(5, Math.min(15, Math.floor(bh / 2)));
                let sampleX = x0;
                let sampleY = Math.max(0, y0 - sampleSize);
                if (y0 < sampleSize) sampleY = Math.min(mainH - sampleSize, y0 + bh);
                const sampleW = Math.min(sampleSize, mainW - sampleX);
                const sampleH = Math.min(sampleSize, mainH - sampleY);
                
                regionData = await sharp(imageBuffer)
                  .extract({ left: sampleX, top: sampleY, width: sampleW, height: sampleH })
                  .resize(1, 1, { fit: 'fill' })
                  .resize(bw, bh, { fit: 'fill' })
                  .toBuffer();
              } else if (action === 'pixelate') {
                const pW = Math.max(3, Math.floor(bw / 10));
                const pH = Math.max(3, Math.floor(bh / 10));
                regionData = await sharp(imageBuffer)
                  .extract({ left: x0, top: y0, width: bw, height: bh })
                  .resize(pW, pH, { fit: 'fill' })
                  .resize(bw, bh, { fit: 'fill', kernel: 'nearest' })
                  .toBuffer();
              } else {
                const blurRadius = Math.max(15, Math.min(50, Math.round(bh * 0.7)));
                regionData = await sharp(imageBuffer)
                  .extract({ left: x0, top: y0, width: bw, height: bh })
                  .blur(blurRadius)
                  .toBuffer();
              }
              
              // Apply with SVG Gaussian Feathering for ultra-smooth edge blending
              imageBuffer = await this._compositeWithFeather(imageBuffer, regionData, x0, y0, bw, bh, 5);
              appliedCount++;
            }
          }
        }

      } // end regions loop

      if (appliedCount === 0) logger.info('OCR: Tidak ada kata kunci ditemukan di gambar ini.');
      else logger.info(`PowerBlur: Menerapkan ${appliedCount} area blur dari OCR.`);
    } catch (err) {
      logger.error('OCR recognition error:', err.message);
    }

    return imageBuffer;
  }

  // ─── Template Matching Step Implementation ────────────────────
  async _applyTemplateMatchBlur(imageBuffer, mainW, mainH, matchRegions = []) {
    let appliedCount = 0;
    const templates = this.listSourceTemplates();
    if (templates.length === 0) {
      logger.info('Template Matching: Tidak ada source template yang diupload.');
      return imageBuffer;
    }

    const threshold    = this.matchSettings.threshold   || 0.80;
    const blurStrength = this.matchSettings.blurStrength || 50;
    
    let regionsToScan = matchRegions.length > 0 ? matchRegions : [{ left: 0, top: 0, width: mainW, height: mainH }];

    for (const region of regionsToScan) {
      let scanBuffer = imageBuffer;
      const offsetX = region.left || 0;
      const offsetY = region.top || 0;
      
      if (region.width !== mainW || region.height !== mainH) {
        scanBuffer = await sharp(imageBuffer).extract(region).toBuffer();
      }

      for (const tpl of templates) {
        try {
          const tplBuffer = fs.readFileSync(tpl.path);
          const result = await findTemplateInImage(scanBuffer, tplBuffer, threshold);

          if (result) {
            // Map result back to global coordinates
            const globalX = result.x + offsetX;
            const globalY = result.y + offsetY;
            logger.info(`Template Match FOUND: "${tpl.name}" score=${result.score.toFixed(3)} @ [${globalX},${globalY},${result.w}x${result.h}]`);

            // Clamp to image bounds
            const bx = Math.max(0, globalX);
            const by = Math.max(0, globalY);
            const bw = Math.min(result.w, mainW - bx);
            const bh = Math.min(result.h, mainH - by);

            if (bw < 2 || bh < 2) continue;

            const action = this.matchSettings.action || 'blur';
            let regionData;
            
            if (action === 'lama-inpaint') {
              try {
                const res = await inpaintBox(imageBuffer, { x: bx, y: by, width: bw, height: bh }, 40);
                regionData = res.buffer;
              } catch (e) {
                regionData = await sharp(imageBuffer)
                  .extract({ left: bx, top: by, width: bw, height: bh })
                  .blur(blurStrength)
                  .toBuffer();
              }
            } else if (action === 'ai-redraw') {
              const sampleSize = 10;
              let sampleX = bx;
              let sampleY = Math.max(0, by - sampleSize);
              if (by < sampleSize) sampleY = Math.min(mainH - sampleSize, by + bh);
              const sampleW = Math.min(sampleSize, mainW - sampleX);
              const sampleH = Math.min(sampleSize, mainH - sampleY);
              
              regionData = await sharp(imageBuffer)
                .extract({ left: sampleX, top: sampleY, width: sampleW, height: sampleH })
                .resize(1, 1, { fit: 'fill' })
                .resize(bw, bh, { fit: 'fill' })
                .toBuffer();
            } else if (action === 'pixelate') {
              const pW = Math.max(4, Math.floor(bw / 10));
              const pH = Math.max(4, Math.floor(bh / 10));
              regionData = await sharp(imageBuffer)
                .extract({ left: bx, top: by, width: bw, height: bh })
                .resize(pW, pH, { fit: 'fill' })
                .resize(bw, bh, { fit: 'fill', kernel: 'nearest' })
                .toBuffer();
            } else {
              regionData = await sharp(imageBuffer)
                .extract({ left: bx, top: by, width: bw, height: bh })
                .blur(blurStrength)
                .toBuffer();
            }

            imageBuffer = await this._compositeWithFeather(imageBuffer, regionData, bx, by, bw, bh, 6);
            appliedCount++;
          }
        } catch (err) {
          logger.warn(`Template Matching error for "${tpl.name}":`, err.message);
        }
      }
    }

    if (appliedCount > 0) logger.info(`Template Matching: Menerapkan ${appliedCount} area blur dari deteksi template.`);
    return imageBuffer;
  }
}

module.exports = new BlurManager();
