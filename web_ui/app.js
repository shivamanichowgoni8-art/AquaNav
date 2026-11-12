/**
 * AquaNav Cloud Station - Client-Side Edge-AI & Ground Control
 * Runs TensorFlow.js + COCO-SSD (lite_mobilenet_v2) directly in the browser
 * on any standard laptop or smartphone (no RTX GPU required).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIGURATION & MARINE DOMAIN MAPPINGS
  // ---------------------------------------------------------------------------
  let apiBaseUrl = localStorage.getItem('aquanav_api_url') || '';
  let currentSource = 'esp32'; // 'esp32' | 'webcam' | 'gallery'
  let facingMode = 'environment'; // Default to mobile rear camera; falls back cleanly on laptop
  let activeCommand = 'S';
  let sirenActive = false;
  let autonomousMode = false;
  let liveOilScanEnabled = false;
  let lastAutoDispatchTs = 0;
  let lastAutoCmd = 'S';

  // Vision Model State
  let cocoModel = null;
  let isModelLoading = true;
  let isInferring = false;
  let webcamStream = null;
  let webcamAnimId = null;
  let esp32PollTimer = null;
  let isEsp32Fetching = false;
  let latestLiveDetections = [];
  let latestSpectralResult = { oilPct: 0, algaePct: 0, algaeStatus: 'CLEAR', surfaceBoxes: [] };

  // FPS & Latency Tracking
  let lastFrameTime = performance.now();
  let smoothedFps = 0;
  let lastLatencyMs = 0;

  // Review Gallery State
  let reviewSamplesCatalog = [];
  let activeGalleryImg = null;
  let activeGalleryTitle = '';
  let activeGallerySampleId = null;

  // Vision Rules (Matching AquaNav Precision Calibration)
  const IGNORED_CLASSES = new Set(['cell phone']);
  const BOOSTED_SOLID_WASTE = new Set(['bottle', 'cup', 'wine glass', 'bowl']);
  const BOOSTED_MIN_CONF = 0.25;
  const OTHER_WASTE_MIN_CONF = 0.45;
  const PERSON_MIN_CONF = 0.48;
  const OBSTACLE_MIN_CONF = 0.45;

  const CATEGORY_COLORS = {
    A: { hex: '#FF3B30', textDark: false, name: 'Solid Waste' },
    B: { hex: '#AF52DE', textDark: false, name: 'Oil / Foam' },
    C: { hex: '#34C759', textDark: false, name: 'Algae / Bio' },
    D: { hex: '#FFCC00', textDark: true, name: 'Marine Life' },
    E: { hex: '#007AFF', textDark: false, name: 'Obstacle / Person' },
  };

  const COCO_MARINE_MAPPINGS = {
    bottle: { label: 'PLASTIC BOTTLE / CUP', cat: 'A' },
    cup: { label: 'PLASTIC BOTTLE / CUP', cat: 'A' },
    'wine glass': { label: 'PLASTIC BOTTLE / CUP', cat: 'A' },
    vase: { label: 'PLASTIC BOTTLE / CUP', cat: 'A' },
    bowl: { label: 'FLOATING CONTAINER', cat: 'A' },
    frisbee: { label: 'FLOATING DEBRIS', cat: 'A' },
    book: { label: 'FLOATING DEBRIS', cat: 'A' },
    handbag: { label: 'PLASTIC BAG / WRAPPER', cat: 'A' },
    backpack: { label: 'PLASTIC BAG / WRAPPER', cat: 'A' },
    umbrella: { label: 'PLASTIC BAG / WRAPPER', cat: 'A' },
    suitcase: { label: 'FLOATING DEBRIS', cat: 'A' },
    banana: { label: 'ORGANIC WASTE', cat: 'A' },
    apple: { label: 'ORGANIC WASTE', cat: 'A' },
    orange: { label: 'ORGANIC WASTE', cat: 'A' },
    sandwich: { label: 'ORGANIC WASTE', cat: 'A' },
    fork: { label: 'SOLID DEBRIS', cat: 'A' },
    knife: { label: 'SOLID DEBRIS', cat: 'A' },
    spoon: { label: 'SOLID DEBRIS', cat: 'A' },
    scissors: { label: 'SOLID DEBRIS', cat: 'A' },
    toothbrush: { label: 'SOLID DEBRIS', cat: 'A' },
    remote: { label: 'E-WASTE DEBRIS', cat: 'A' },
    mouse: { label: 'E-WASTE DEBRIS', cat: 'A' },
    keyboard: { label: 'E-WASTE DEBRIS', cat: 'A' },
    laptop: { label: 'E-WASTE DEBRIS', cat: 'A' },
    'potted plant': { label: 'ALGAE / AQUATIC PLANT', cat: 'C' },
    bird: { label: 'MARINE LIFE (AVOID)', cat: 'D' },
    person: { label: 'PERSON / SWIMMER', cat: 'E' },
    boat: { label: 'VESSEL / OBSTACLE', cat: 'E' },
    surfboard: { label: 'VESSEL / OBSTACLE', cat: 'E' },
    car: { label: 'SUBMERGED OBSTACLE', cat: 'E' },
    truck: { label: 'SUBMERGED OBSTACLE', cat: 'E' },
    bench: { label: 'SUBMERGED DEBRIS', cat: 'E' },
    cat: { label: 'ANIMAL OBSTACLE', cat: 'E' },
    dog: { label: 'ANIMAL OBSTACLE', cat: 'E' },
  };

  // ---------------------------------------------------------------------------
  // DOM REFERENCES
  // ---------------------------------------------------------------------------
  const engineStatusSub = document.getElementById('engineStatusSub');
  const connectionPill = document.getElementById('connectionPill');
  const connectionText = document.getElementById('connectionText');
  const sourceBadge = document.getElementById('sourceBadge');
  const hudFps = document.getElementById('hudFps');
  const hudLatency = document.getElementById('hudLatency');
  const hudObjects = document.getElementById('hudObjects');

  const visionCanvas = document.getElementById('visionCanvas');
  const visionCtx = visionCanvas.getContext('2d');
  const webcamVideo = document.getElementById('webcamVideo');
  const btnFlipCamera = document.getElementById('btnFlipCamera');

  const autoModeBanner = document.getElementById('autoModeBanner');
  const autoModeBannerText = document.getElementById('autoModeBannerText');
  const autoModeToggle = document.getElementById('autoModeToggle');
  const oilScanToggle = document.getElementById('oilScanToggle');

  const reviewActiveBanner = document.getElementById('reviewActiveBanner');
  const reviewActiveBannerText = document.getElementById('reviewActiveBannerText');
  const btnReturnToLive = document.getElementById('btnReturnToLive');
  const btnExitReviewOverlay = document.getElementById('btnExitReviewOverlay');

  const solidWasteVal = document.getElementById('solidWasteVal');
  const oilSpillVal = document.getElementById('oilSpillVal');
  const algaeStatusVal = document.getElementById('algaeStatusVal');
  const targetLockBar = document.getElementById('targetLockBar');
  const targetLockText = document.getElementById('targetLockText');

  const failsafeCard = document.getElementById('failsafeCard');
  const failsafeIcon = document.getElementById('failsafeIcon');
  const failsafeTitle = document.getElementById('failsafeTitle');
  const failsafeDesc = document.getElementById('failsafeDesc');

  const telemetrySourceBadge = document.getElementById('telemetrySourceBadge');
  const leakBadge = document.getElementById('leakBadge');
  const distanceVal = document.getElementById('distanceVal');
  const distanceBar = document.getElementById('distanceBar');
  const gpsCoordVal = document.getElementById('gpsCoordVal');
  const batteryVal = document.getElementById('batteryVal');
  const lastCmdBadge = document.getElementById('lastCmdBadge');
  const recordCount = document.getElementById('recordCount');
  const toastMessage = document.getElementById('toastMessage');

  const btnForward = document.getElementById('btnForward');
  const btnLeft = document.getElementById('btnLeft');
  const btnStop = document.getElementById('btnStop');
  const btnRight = document.getElementById('btnRight');
  const btnReverse = document.getElementById('btnReverse');
  const btnSiren = document.getElementById('btnSiren');

  const scenariosGrid = document.getElementById('scenariosGrid');
  const reviewSampleCount = document.getElementById('reviewSampleCount');
  const customImageInput = document.getElementById('customImageInput');
  const reviewActionHint = document.getElementById('reviewActionHint');

  const btnSettings = document.getElementById('btnSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const apiUrlInput = document.getElementById('apiUrlInput');
  const btnSaveApiUrl = document.getElementById('btnSaveApiUrl');
  const btnResetApiUrl = document.getElementById('btnResetApiUrl');

  // Offscreen canvas for lightweight spectral surface analysis
  const spectralCanvas = document.createElement('canvas');
  spectralCanvas.width = 160;
  spectralCanvas.height = 120;
  const spectralCtx = spectralCanvas.getContext('2d', { willReadFrequently: true });

  // ---------------------------------------------------------------------------
  // 3-FRAME PERSISTENCE SMOOTHING BUFFER (Eliminates Bottle Flicker)
  // ---------------------------------------------------------------------------
  function computeIoU(boxA, boxB) {
    const xA = Math.max(boxA[0], boxB[0]);
    const yA = Math.max(boxA[1], boxB[1]);
    const xB = Math.min(boxA[2], boxB[2]);
    const yB = Math.min(boxA[3], boxB[3]);
    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const areaA = Math.max(1, (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]));
    const areaB = Math.max(1, (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]));
    return interArea / (areaA + areaB - interArea);
  }

  class MultiObjectTrackBuffer {
    constructor() {
      this.tracks = new Map();
      this.nextId = 1;
      this.emaAlpha = 0.65;
      this.iouThresh = 0.28;
      this.distThresh = 70;
    }

    reset() {
      this.tracks.clear();
      this.nextId = 1;
    }

    updateAndFilter(detections, frameW, frameH) {
      const matchedTrackIds = new Set();
      const unmatched = [];

      for (const det of detections) {
        let bestId = null;
        let bestScore = -1;

        for (const [tid, track] of this.tracks.entries()) {
          if (matchedTrackIds.has(tid) || track.category !== det.category) continue;
          const iou = computeIoU(det.box, track.box);
          const dist = Math.hypot(det.centroid[0] - track.centroid[0], det.centroid[1] - track.centroid[1]);

          if (iou >= this.iouThresh || dist <= this.distThresh) {
            const score = iou + Math.max(0, 1 - dist / this.distThresh) * 0.25;
            if (score > bestScore) {
              bestScore = score;
              bestId = tid;
            }
          }
        }

        if (bestId !== null) {
          const track = this.tracks.get(bestId);
          const a = this.emaAlpha;
          track.box = [
            a * det.box[0] + (1 - a) * track.box[0],
            a * det.box[1] + (1 - a) * track.box[1],
            a * det.box[2] + (1 - a) * track.box[2],
            a * det.box[3] + (1 - a) * track.box[3],
          ];
          track.confidence = a * det.confidence + (1 - a) * track.confidence;
          track.className = det.className;
          track.rawClass = det.rawClass;
          track.centroid = [
            (track.box[0] + track.box[2]) / 2,
            (track.box[1] + track.box[3]) / 2,
          ];
          track.hits += 1;
          track.misses = 0;
          track.hitWindow.push(true);
          if (track.hitWindow.length > 3) track.hitWindow.shift();
          matchedTrackIds.add(bestId);
        } else {
          unmatched.push(det);
        }
      }

      for (const [tid, track] of this.tracks.entries()) {
        if (!matchedTrackIds.has(tid)) {
          track.misses += 1;
          track.hitWindow.push(false);
          if (track.hitWindow.length > 3) track.hitWindow.shift();
          if (track.misses >= 3) {
            this.tracks.delete(tid);
          }
        }
      }

      for (const det of unmatched) {
        this.tracks.set(this.nextId, {
          id: this.nextId,
          box: [...det.box],
          confidence: det.confidence,
          className: det.className,
          category: det.category,
          rawClass: det.rawClass,
          centroid: [...det.centroid],
          hits: 1,
          misses: 0,
          hitWindow: [true],
        });
        this.nextId += 1;
      }

      const confirmed = [];
      for (const track of this.tracks.values()) {
        const hitCount = track.hitWindow.filter(Boolean).length;
        const isPerson = track.rawClass === 'person';
        // 3-frame persistence for solid waste: stays locked across brief occlusions/tilts
        const isConfirmed =
          isPerson ||
          (track.category === 'A' && track.hits >= 1 && track.misses <= 2) ||
          hitCount >= 2;

        if (!isConfirmed) continue;

        const bx1 = Math.round(track.box[0]);
        const by1 = Math.round(track.box[1]);
        const bx2 = Math.round(track.box[2]);
        const by2 = Math.round(track.box[3]);
        const cx = (bx1 + bx2) / 2;
        const cy = (by1 + by2) / 2;
        const area = Math.max(1, (bx2 - bx1) * (by2 - by1));

        confirmed.push({
          trackId: track.id,
          box: [bx1, by1, bx2, by2],
          className: track.className,
          category: track.category,
          confidence: track.confidence,
          rawClass: track.rawClass,
          centroid: [cx, cy],
          areaRatio: area / Math.max(1, frameW * frameH),
          offsetX: (cx - frameW / 2) / (frameW / 2),
          normY2: by2 / Math.max(1, frameH),
        });
      }
      return confirmed;
    }
  }

  const trackBuffer = new MultiObjectTrackBuffer();

  // ---------------------------------------------------------------------------
  // API HELPERS
  // ---------------------------------------------------------------------------
  function getEndpoint(path) {
    if (!apiBaseUrl) return path;
    return `${apiBaseUrl.replace(/\/+$/, '')}${path}`;
  }

  async function apiGet(path) {
    const resp = await fetch(getEndpoint(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  async function apiPost(path, body) {
    const resp = await fetch(getEndpoint(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  function showToast(msg, isError = false) {
    if (!toastMessage) return;
    toastMessage.textContent = msg;
    toastMessage.style.color = isError ? 'var(--danger-red)' : 'var(--accent-cyan)';
    setTimeout(() => {
      toastMessage.textContent = 'Ready for cloud edge-AI operations.';
      toastMessage.style.color = 'var(--text-secondary)';
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // TENSORFLOW.JS + COCO-SSD MODEL LOADER
  // ---------------------------------------------------------------------------
  async function initVisionModel() {
    try {
      isModelLoading = true;
      if (typeof tf !== 'undefined') {
        await tf.ready();
      }
      if (typeof cocoSsd === 'undefined') {
        throw new Error('COCO-SSD CDN script not loaded');
      }
      cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      isModelLoading = false;
      const backend = typeof tf !== 'undefined' ? tf.getBackend().toUpperCase() : 'JS';
      if (engineStatusSub) {
        engineStatusSub.textContent = `Browser Edge-AI | TF.js (${backend}) + COCO-SSD Ready`;
      }
      showToast('Browser Edge-AI (COCO-SSD) loaded and ready.');
    } catch (err) {
      isModelLoading = false;
      if (engineStatusSub) {
        engineStatusSub.textContent = 'Browser Edge-AI | Model Offline (Check CDN)';
      }
      console.error('COCO-SSD load failed:', err);
      showToast(`AI model load error: ${err.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // DETECTION FILTERING & MARINE CLASSIFICATION
  // ---------------------------------------------------------------------------
  function filterAndMapPredictions(predictions, frameW, frameH) {
    const mapped = [];
    const totalArea = Math.max(1, frameW * frameH);

    for (const pred of predictions) {
      const rawClass = String(pred.class || '').toLowerCase().trim();
      const score = Number(pred.score || 0);

      // Rule: Completely ignore 'cell phone' detections
      if (IGNORED_CLASSES.has(rawClass)) continue;

      const mapping = COCO_MARINE_MAPPINGS[rawClass];
      if (!mapping) continue;

      // Per-class confidence gating (boosted 0.25 for bottles/cups/bowls)
      let minConf = OBSTACLE_MIN_CONF;
      if (BOOSTED_SOLID_WASTE.has(rawClass)) {
        minConf = BOOSTED_MIN_CONF;
      } else if (mapping.cat === 'A') {
        minConf = OTHER_WASTE_MIN_CONF;
      } else if (rawClass === 'person') {
        minConf = PERSON_MIN_CONF;
      }

      if (score < minConf) continue;

      const [x, y, w, h] = pred.bbox;
      const x1 = Math.max(0, x);
      const y1 = Math.max(0, y);
      const x2 = Math.min(frameW, x + w);
      const y2 = Math.min(frameH, y + h);
      const bw = x2 - x1;
      const bh = y2 - y1;
      if (bw < 14 || bh < 14) continue;

      const areaRatio = (bw * bh) / totalArea;
      // Reject giant full-frame background false positives
      if (mapping.cat === 'A' && areaRatio > 0.55) continue;

      mapped.push({
        box: [x1, y1, x2, y2],
        className: mapping.label,
        category: mapping.cat,
        confidence: score,
        rawClass,
        centroid: [(x1 + x2) / 2, (y1 + y2) / 2],
        areaRatio,
        offsetX: ((x1 + x2) / 2 - frameW / 2) / (frameW / 2),
        normY2: y2 / Math.max(1, frameH),
      });
    }

    return mapped;
  }

  // Lightweight browser-side spectral surface analyzer (Oil Sheen, Emulsified Oil, Algae)
  function analyzeSurfaceSpectral(sourceEl, frameW, frameH, excludeBoxes, requireWaterGate = true) {
    const sw = spectralCanvas.width;
    const sh = spectralCanvas.height;
    try {
      spectralCtx.drawImage(sourceEl, 0, 0, sw, sh);
    } catch (_) {
      return { oilPct: 0, algaePct: 0, algaeStatus: 'CLEAR', surfaceBoxes: [] };
    }

    const imgData = spectralCtx.getImageData(0, 0, sw, sh);
    const data = imgData.data;
    const totalPx = sw * sh;
    const scaleX = frameW / sw;
    const scaleY = frameH / sh;

    // Mask out solid object boxes
    const excluded = new Uint8Array(totalPx);
    for (const box of excludeBoxes) {
      const sx1 = Math.max(0, Math.floor((box[0] - 8) / scaleX));
      const sy1 = Math.max(0, Math.floor((box[1] - 8) / scaleY));
      const sx2 = Math.min(sw - 1, Math.ceil((box[2] + 8) / scaleX));
      const sy2 = Math.min(sh - 1, Math.ceil((box[3] + 8) / scaleY));
      for (let py = sy1; py <= sy2; py++) {
        for (let px = sx1; px <= sx2; px++) {
          excluded[py * sw + px] = 1;
        }
      }
    }

    let rainbowPx = 0;
    let cyanSlickPx = 0;
    let tanSlickPx = 0;
    let algaePx = 0;
    let waterLikePx = 0;
    let validPx = 0;

    // Bounding boxes for coarse surface detections
    const bounds = {
      oil: { minX: sw, minY: sh, maxX: 0, maxY: 0, count: 0 },
      algae: { minX: sw, minY: sh, maxX: 0, maxY: 0, count: 0 },
    };

    const hues = new Float32Array(totalPx);
    const sats = new Float32Array(totalPx);
    const vals = new Float32Array(totalPx);

    for (let i = 0; i < totalPx; i++) {
      const idx = i * 4;
      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d > 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      hues[i] = h * 360;
      sats[i] = max === 0 ? 0 : d / max;
      vals[i] = max;
    }

    for (let y = 2; y < sh - 2; y++) {
      for (let x = 2; x < sw - 2; x++) {
        const i = y * sw + x;
        if (excluded[i]) continue;
        validPx++;

        const h = hues[i];
        const s = sats[i];
        const v = vals[i];

        // Water-like region: blue/cyan/pond-green, dark water, or low-saturation clear tray water
        const isBlueWater = h >= 145 && h <= 245 && s >= 0.12 && v >= 0.12;
        const isDarkWater = v <= 0.35 && s <= 0.42;
        const isLowSatWater = s <= 0.24 && v >= 0.18 && v <= 0.94;
        if (isBlueWater || isDarkWater || isLowSatWater) {
          waterLikePx++;
        }

        // Skip specular lamp glare & near-black voids from slick pixels
        if ((v > 0.96 && s < 0.12) || v < 0.14) continue;

        // Emulsified milky cyan slick (high-brightness milky sheen, excludes clean teal ocean)
        if (h >= 175 && h <= 215 && s >= 0.12 && s <= 0.36 && v >= 0.58 && v <= 0.90) {
          cyanSlickPx++;
          if (x < bounds.oil.minX) bounds.oil.minX = x;
          if (y < bounds.oil.minY) bounds.oil.minY = y;
          if (x > bounds.oil.maxX) bounds.oil.maxX = x;
          if (y > bounds.oil.maxY) bounds.oil.maxY = y;
          bounds.oil.count++;
        }

        // Swirling tan / amber / brown-grey slick ribbons (cooking oil droplets or crude ribbons)
        if (h >= 18 && h <= 52 && s >= 0.16 && s <= 0.50 && v >= 0.30 && v <= 0.82) {
          tanSlickPx++;
          if (x < bounds.oil.minX) bounds.oil.minX = x;
          if (y < bounds.oil.minY) bounds.oil.minY = y;
          if (x > bounds.oil.maxX) bounds.oil.maxX = x;
          if (y > bounds.oil.maxY) bounds.oil.maxY = y;
          bounds.oil.count++;
        }

        // Local hue variance for iridescent rainbow sheen (thin oil film under lamp or sunlight)
        let hSum = 0;
        let hSq = 0;
        for (let dy = -2; dy <= 2; dy += 2) {
          for (let dx = -2; dx <= 2; dx += 2) {
            const nh = hues[(y + dy) * sw + (x + dx)];
            hSum += nh;
            hSq += nh * nh;
          }
        }
        const hMean = hSum / 9;
        const hStd = Math.sqrt(Math.max(0, hSq / 9 - hMean * hMean));
        if (hStd >= 24 && s >= 0.16 && v >= 0.18 && v <= 0.90) {
          rainbowPx++;
          if (x < bounds.oil.minX) bounds.oil.minX = x;
          if (y < bounds.oil.minY) bounds.oil.minY = y;
          if (x > bounds.oil.maxX) bounds.oil.maxX = x;
          if (y > bounds.oil.maxY) bounds.oil.maxY = y;
          bounds.oil.count++;
        }

        // Filamentous yellow-green algae bloom (H 48-135, S >= 0.24, V >= 0.22)
        if (h >= 48 && h <= 135 && s >= 0.24 && v >= 0.22) {
          algaePx++;
          if (x < bounds.algae.minX) bounds.algae.minX = x;
          if (y < bounds.algae.minY) bounds.algae.minY = y;
          if (x > bounds.algae.maxX) bounds.algae.maxX = x;
          if (y > bounds.algae.maxY) bounds.algae.maxY = y;
          bounds.algae.count++;
        }
      }
    }

    const waterRatioPct = validPx > 0 ? (waterLikePx / validPx) * 100 : 0;
    const isMostlyWater = waterRatioPct >= 55.0;

    const oilPctRaw = ((rainbowPx + cyanSlickPx * 0.75 + tanSlickPx * 0.75) / totalPx) * 100;
    const algaePctRaw = (algaePx / totalPx) * 100;

    // Calibrated confidence: reaches >= 0.85 only when frame is mostly water AND oil slick >= 2.5%
    const oilConfidence = Math.min(
      0.98,
      0.72 + (isMostlyWater ? 0.08 : 0.0) + Math.min(0.18, oilPctRaw * 0.02)
    );

    const surfaceBoxes = [];
    const oilFlagged = (!requireWaterGate || isMostlyWater) && oilPctRaw >= 2.5 && oilConfidence >= 0.85 && bounds.oil.count > 45;
    const oilPct = oilFlagged ? Math.min(95.0, oilPctRaw) : 0.0;
    const algaePct = (!requireWaterGate || isMostlyWater) && algaePctRaw >= 5.0 ? Math.min(95.0, algaePctRaw) : 0.0;

    if (oilFlagged) {
      const x1 = Math.round(bounds.oil.minX * scaleX);
      const y1 = Math.round(bounds.oil.minY * scaleY);
      const x2 = Math.round(bounds.oil.maxX * scaleX);
      const y2 = Math.round(bounds.oil.maxY * scaleY);
      const oilLabel = rainbowPx >= cyanSlickPx && rainbowPx >= tanSlickPx
        ? 'OIL SPILL (RAINBOW SHEEN)'
        : 'OIL SPILL / SLICK';
      surfaceBoxes.push({
        box: [x1, y1, x2, y2],
        className: oilLabel,
        category: 'B',
        confidence: Number(oilConfidence.toFixed(2)),
        rawClass: 'oil_spill',
        centroid: [(x1 + x2) / 2, (y1 + y2) / 2],
        areaRatio: ((x2 - x1) * (y2 - y1)) / Math.max(1, frameW * frameH),
        offsetX: ((x1 + x2) / 2 - frameW / 2) / (frameW / 2),
        normY2: y2 / Math.max(1, frameH),
      });
    }

    let algaeStatus = 'CLEAR';
    if (algaePct >= 12.0) algaeStatus = 'BLOOM ALERT';
    else if (algaePct >= 5.0) algaeStatus = 'MODERATE';

    if (algaePct >= 5.0 && bounds.algae.count > 50) {
      const x1 = Math.round(bounds.algae.minX * scaleX);
      const y1 = Math.round(bounds.algae.minY * scaleY);
      const x2 = Math.round(bounds.algae.maxX * scaleX);
      const y2 = Math.round(bounds.algae.maxY * scaleY);
      surfaceBoxes.push({
        box: [x1, y1, x2, y2],
        className: 'ALGAE / BIO-SCUM',
        category: 'C',
        confidence: Math.min(0.93, 0.70 + algaePct / 150),
        rawClass: 'algae',
        centroid: [(x1 + x2) / 2, (y1 + y2) / 2],
        areaRatio: ((x2 - x1) * (y2 - y1)) / Math.max(1, frameW * frameH),
        offsetX: ((x1 + x2) / 2 - frameW / 2) / (frameW / 2),
        normY2: y2 / Math.max(1, frameH),
      });
    }

    return { oilPct, algaePct, algaeStatus, surfaceBoxes };
  }

  // ---------------------------------------------------------------------------
  // TARGET LOCK, NAVIGATION RECOMMENDATION & HUD RENDERING
  // ---------------------------------------------------------------------------
  function evaluateSceneAnalytics(detections, spectral) {
    const solidWaste = detections.filter((d) => d.category === 'A');
    const personDets = detections.filter((d) => d.rawClass === 'person');
    const obstacleDets = detections.filter((d) => d.category === 'E' && d.rawClass !== 'person');

    // Pick highest-priority solid waste target (largest area or highest confidence)
    let targetLock = null;
    if (solidWaste.length > 0) {
      targetLock = [...solidWaste].sort((a, b) => b.areaRatio - a.areaRatio)[0];
    }

    // Visual collision warning for person / obstacle in safety corridor
    // NOTE: Visual warning ONLY — never locks out manual navigation buttons!
    let collisionHazard = false;
    let collisionDesc = '';
    for (const p of personDets) {
      if (Math.abs(p.offsetX) <= 0.55 || p.normY2 >= 0.45) {
        collisionHazard = true;
        collisionDesc = 'PERSON / SWIMMER IN CORRIDOR';
        break;
      }
    }
    if (!collisionHazard) {
      for (const ob of obstacleDets) {
        if (Math.abs(ob.offsetX) <= 0.38 && ob.normY2 >= 0.45) {
          collisionHazard = true;
          collisionDesc = ob.className;
          break;
        }
      }
    }

    // Recommended steering command
    let recCmd = 'S';
    if (collisionHazard) {
      recCmd = 'S';
    } else if (targetLock) {
      if (targetLock.areaRatio >= 0.24) {
        recCmd = 'F'; // Close in to skim
      } else if (targetLock.offsetX < -0.18) {
        recCmd = 'L';
      } else if (targetLock.offsetX > 0.18) {
        recCmd = 'R';
      } else {
        recCmd = 'F';
      }
    }

    // Update UI Cards
    if (hudObjects) hudObjects.textContent = `OBJECTS: ${detections.length}`;
    if (solidWasteVal) {
      solidWasteVal.textContent = `${solidWaste.length} item${solidWaste.length === 1 ? '' : 's'}`;
    }
    if (oilSpillVal) oilSpillVal.textContent = `${spectral.oilPct.toFixed(1)}%`;
    if (algaeStatusVal) {
      algaeStatusVal.textContent = `${spectral.algaeStatus} (${spectral.algaePct.toFixed(1)}%)`;
    }

    if (targetLockBar && targetLockText) {
      if (collisionHazard) {
        targetLockBar.className = 'target-lock-bar hazard';
        targetLockText.textContent = `[!] VISUAL CAUTION: ${collisionDesc} (Manual Override Active)`;
      } else if (targetLock) {
        targetLockBar.className = 'target-lock-bar locked';
        const off = targetLock.offsetX;
        const posStr = off < -0.06 ? `L${Math.abs(off).toFixed(2)}` : off > 0.06 ? `R${off.toFixed(2)}` : 'CTR';
        const confPct = Math.round(targetLock.confidence * 100);
        targetLockText.textContent = `🎯 Lock: ${targetLock.className} (${confPct}%) [${posStr}] -> [${recCmd}]`;
      } else {
        targetLockBar.className = 'target-lock-bar clear';
        targetLockText.textContent = '✅ PATH CLEAR — NOMINAL NAVIGATION';
      }
    }

    // Update Auto Banner text
    if (autonomousMode && autoModeBannerText) {
      if (collisionHazard) {
        autoModeBannerText.textContent = `AUTO PAUSED: ${collisionDesc}`;
      } else if (targetLock) {
        const sign = targetLock.offsetX > 0 ? '+' : '';
        autoModeBannerText.textContent = `AUTO INTERCEPTING: ${targetLock.className} (${sign}${targetLock.offsetX.toFixed(2)} -> ${recCmd})`;
      } else {
        autoModeBannerText.textContent = 'AUTONOMOUS BRAIN ARMED | SCANNING SURFACE';
      }
    }

    return { targetLock, collisionHazard, collisionDesc, recCmd };
  }

  function drawHudOverlay(ctx, w, h, detections, targetLock) {
    // Draw detection bounding boxes
    for (const det of detections) {
      const [x1, y1, x2, y2] = det.box;
      const bw = x2 - x1;
      const bh = y2 - y1;
      const style = CATEGORY_COLORS[det.category] || CATEGORY_COLORS.A;
      const confPct = Math.round(det.confidence * 100);
      const label = `${det.className} ${confPct}%`;

      ctx.save();
      ctx.strokeStyle = style.hex;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x1, y1, bw, bh);

      // Corner ticks
      const tick = Math.min(14, bw * 0.25, bh * 0.25);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x1, y1 + tick); ctx.lineTo(x1, y1); ctx.lineTo(x1 + tick, y1);
      ctx.moveTo(x2 - tick, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + tick);
      ctx.moveTo(x1, y2 - tick); ctx.lineTo(x1, y2); ctx.lineTo(x1 + tick, y2);
      ctx.moveTo(x2 - tick, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - tick);
      ctx.stroke();

      // Label pill
      ctx.font = '700 12px "JetBrains Mono", monospace';
      const textW = ctx.measureText(label).width;
      const pillH = 20;
      const pillY = y1 >= pillH + 2 ? y1 - pillH - 2 : y1 + 2;
      ctx.fillStyle = style.hex;
      ctx.fillRect(x1, pillY, textW + 10, pillH);
      ctx.fillStyle = style.textDark ? '#0f172a' : '#ffffff';
      ctx.fillText(label, x1 + 5, pillY + 14);
      ctx.restore();
    }

    // Draw target steering vector & crosshair
    if (targetLock) {
      const [cx, cy] = targetLock.centroid;
      const originX = w / 2;
      const originY = h - 18;

      ctx.save();
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(cx, cy);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Subtle center corridor guide
    ctx.save();
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.65);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.restore();
  }

  function drawStandbyCanvas(title, subtitle) {
    const w = 640;
    const h = 480;
    if (visionCanvas.width !== w || visionCanvas.height !== h) {
      visionCanvas.width = w;
      visionCanvas.height = h;
    }

    visionCtx.fillStyle = '#070b13';
    visionCtx.fillRect(0, 0, w, h);

    // Subtle tactical grid
    visionCtx.strokeStyle = 'rgba(6, 182, 212, 0.08)';
    visionCtx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      visionCtx.beginPath(); visionCtx.moveTo(x, 0); visionCtx.lineTo(x, h); visionCtx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      visionCtx.beginPath(); visionCtx.moveTo(0, y); visionCtx.lineTo(w, y); visionCtx.stroke();
    }

    // Center radar ring
    visionCtx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
    visionCtx.lineWidth = 1.5;
    visionCtx.beginPath();
    visionCtx.arc(w / 2, h / 2, 70, 0, Math.PI * 2);
    visionCtx.stroke();

    visionCtx.fillStyle = '#06b6d4';
    visionCtx.font = '700 16px "JetBrains Mono", monospace';
    visionCtx.textAlign = 'center';
    visionCtx.fillText(title, w / 2, h / 2 - 6);

    visionCtx.fillStyle = '#94a3b8';
    visionCtx.font = '500 12px "Inter", sans-serif';
    visionCtx.fillText(subtitle, w / 2, h / 2 + 20);
    visionCtx.textAlign = 'left';
  }

  function maybeDispatchAutonomousCommand(recCmd) {
    if (!autonomousMode || currentSource === 'gallery') return;
    const now = performance.now();
    if (recCmd !== lastAutoCmd || now - lastAutoDispatchTs >= 350) {
      lastAutoCmd = recCmd;
      lastAutoDispatchTs = now;
      sendCommand(recCmd, true);
    }
  }

  // ---------------------------------------------------------------------------
  // SOURCE 1: DEVICE CAMERA (LAPTOP WEBCAM / PHONE REAR CAMERA)
  // ---------------------------------------------------------------------------
  async function startWebcamSource() {
    stopAllVideoSources();
    currentSource = 'webcam';
    trackBuffer.reset();
    sourceBadge.textContent = 'DEVICE CAM';
    btnFlipCamera.style.display = 'inline-block';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      drawStandbyCanvas('CAMERA API UNAVAILABLE', 'Use HTTPS or localhost to access laptop/phone camera.');
      showToast('Camera API requires HTTPS or localhost.', true);
      return;
    }

    try {
      drawStandbyCanvas('INITIALIZING CAMERA...', 'Requesting browser video permissions');
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (_) {
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      webcamVideo.srcObject = webcamStream;
      await webcamVideo.play();

      const vw = webcamVideo.videoWidth || 640;
      const vh = webcamVideo.videoHeight || 480;
      visionCanvas.width = vw;
      visionCanvas.height = vh;

      const renderLoop = async () => {
        if (currentSource !== 'webcam') return;

        const now = performance.now();
        const dt = now - lastFrameTime;
        lastFrameTime = now;
        if (dt > 0) {
          const instFps = 1000 / dt;
          smoothedFps = smoothedFps ? smoothedFps * 0.85 + instFps * 0.15 : instFps;
        }

        if (webcamVideo.readyState >= 2) {
          const w = webcamVideo.videoWidth || 640;
          const h = webcamVideo.videoHeight || 480;
          if (visionCanvas.width !== w || visionCanvas.height !== h) {
            visionCanvas.width = w;
            visionCanvas.height = h;
          }

          visionCtx.drawImage(webcamVideo, 0, 0, w, h);

          if (cocoModel && !isInferring) {
            isInferring = true;
            const t0 = performance.now();
            cocoModel
              .detect(webcamVideo, 20, BOOSTED_MIN_CONF)
              .then((preds) => {
                lastLatencyMs = performance.now() - t0;
                const filtered = filterAndMapPredictions(preds, w, h);
                const tracked = trackBuffer.updateAndFilter(filtered, w, h);
                const spectral = liveOilScanEnabled
                  ? analyzeSurfaceSpectral(
                      webcamVideo,
                      w,
                      h,
                      tracked.map((d) => d.box),
                      true
                    )
                  : { oilPct: 0, algaePct: 0, algaeStatus: 'CLEAR', surfaceBoxes: [] };
                latestLiveDetections = [...tracked, ...spectral.surfaceBoxes];
                const analytics = evaluateSceneAnalytics(latestLiveDetections, spectral);
                maybeDispatchAutonomousCommand(analytics.recCmd);
              })
              .catch((err) => console.warn('Webcam detect error:', err))
              .finally(() => {
                isInferring = false;
              });
          }

          const target = latestLiveDetections.find((d) => d.category === 'A') || null;
          drawHudOverlay(visionCtx, w, h, latestLiveDetections, target);
          if (hudFps) hudFps.textContent = `FPS: ${smoothedFps.toFixed(1)}`;
          if (hudLatency) hudLatency.textContent = `LAT: ${lastLatencyMs.toFixed(1)} ms`;
        }

        webcamAnimId = requestAnimationFrame(renderLoop);
      };

      webcamAnimId = requestAnimationFrame(renderLoop);
    } catch (err) {
      drawStandbyCanvas('CAMERA ACCESS DENIED', err.message || 'Check browser camera permissions');
      showToast(`Camera error: ${err.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // SOURCE 2: ESP32-S3 CLOUD STREAM (/api/esp32/latest.jpg)
  // ---------------------------------------------------------------------------
  async function startEsp32Source() {
    stopAllVideoSources();
    currentSource = 'esp32';
    trackBuffer.reset();
    sourceBadge.textContent = 'ESP32-S3 STREAM';
    btnFlipCamera.style.display = 'none';

    const pollFrame = async () => {
      if (currentSource !== 'esp32') return;
      if (isEsp32Fetching) return;
      isEsp32Fetching = true;

      try {
        const t0 = performance.now();
        const url = getEndpoint(`/api/esp32/latest.jpg?t=${Date.now()}`);
        const resp = await fetch(url, { cache: 'no-store' });

        if (currentSource !== 'esp32') return;

        if (resp.status === 200) {
          const blob = await resp.blob();
          const bitmap = await createImageBitmap(blob);
          const w = bitmap.width || 320;
          const h = bitmap.height || 240;

          if (visionCanvas.width !== w || visionCanvas.height !== h) {
            visionCanvas.width = w;
            visionCanvas.height = h;
          }

          visionCtx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close();

          if (cocoModel) {
            const preds = await cocoModel.detect(visionCanvas, 20, BOOSTED_MIN_CONF);
            const filtered = filterAndMapPredictions(preds, w, h);
            const tracked = trackBuffer.updateAndFilter(filtered, w, h);
            const spectral = liveOilScanEnabled
              ? analyzeSurfaceSpectral(
                  visionCanvas,
                  w,
                  h,
                  tracked.map((d) => d.box),
                  true
                )
              : { oilPct: 0, algaePct: 0, algaeStatus: 'CLEAR', surfaceBoxes: [] };
            latestLiveDetections = [...tracked, ...spectral.surfaceBoxes];
            const analytics = evaluateSceneAnalytics(latestLiveDetections, spectral);
            maybeDispatchAutonomousCommand(analytics.recCmd);
            drawHudOverlay(visionCtx, w, h, latestLiveDetections, analytics.targetLock);
          }

          lastLatencyMs = performance.now() - t0;
          const now = performance.now();
          const dt = now - lastFrameTime;
          lastFrameTime = now;
          if (dt > 0) smoothedFps = 1000 / dt;

          if (hudFps) hudFps.textContent = `FPS: ${smoothedFps.toFixed(1)}`;
          if (hudLatency) hudLatency.textContent = `LAT: ${lastLatencyMs.toFixed(1)} ms`;
        } else {
          drawStandbyCanvas(
            'ESP32-S3 CLOUD UPLINK STANDBY',
            'Waiting for boat frames on POST /api/esp32/frame — or switch to Device Cam / Gallery'
          );
          if (hudFps) hudFps.textContent = 'FPS: --';
          if (hudLatency) hudLatency.textContent = 'LAT: -- ms';
        }
      } catch (err) {
        drawStandbyCanvas('ESP32-S3 STREAM RECONNECTING', 'Checking cloud relay /api/esp32/latest.jpg...');
      } finally {
        isEsp32Fetching = false;
      }
    };

    pollFrame();
    esp32PollTimer = setInterval(pollFrame, 110);
  }

  // ---------------------------------------------------------------------------
  // SOURCE 3: REVIEW GALLERY & STATIC IMAGE SCANNER
  // ---------------------------------------------------------------------------
  async function runStaticImageInference(imgEl, title) {
    const w = imgEl.naturalWidth || imgEl.width || 640;
    const h = imgEl.naturalHeight || imgEl.height || 480;
    visionCanvas.width = w;
    visionCanvas.height = h;
    visionCtx.drawImage(imgEl, 0, 0, w, h);

    // Wait briefly if COCO-SSD is still finishing initial CDN load
    if (isModelLoading) {
      if (reviewActionHint) reviewActionHint.textContent = 'Loading TensorFlow.js COCO-SSD model...';
      while (isModelLoading) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const t0 = performance.now();
    let objectDets = [];
    if (cocoModel) {
      const preds = await cocoModel.detect(imgEl, 20, BOOSTED_MIN_CONF);
      objectDets = filterAndMapPredictions(preds, w, h);
    }

    const excludeBoxes = objectDets.map((d) => d.box);
    const spectral = analyzeSurfaceSpectral(imgEl, w, h, excludeBoxes);
    const allDets = [...objectDets, ...spectral.surfaceBoxes];
    const latency = performance.now() - t0;

    // Re-draw clean base image then HUD overlay
    visionCtx.drawImage(imgEl, 0, 0, w, h);
    const analytics = evaluateSceneAnalytics(allDets, spectral);
    drawHudOverlay(visionCtx, w, h, allDets, analytics.targetLock);
    highlightNavCommand(analytics.recCmd);

    if (hudFps) hudFps.textContent = `FPS: ${(1000 / Math.max(1, latency)).toFixed(1)}`;
    if (hudLatency) hudLatency.textContent = `LAT: ${latency.toFixed(1)} ms`;

    if (reviewActionHint) {
      const solidCount = objectDets.filter((d) => d.category === 'A').length;
      reviewActionHint.textContent = `${title}: ${solidCount} waste item(s), ${spectral.oilPct.toFixed(1)}% oil, ${spectral.algaePct.toFixed(1)}% algae -> Recommended: [${analytics.recCmd}]`;
    }
  }

  function setGalleryModeUI(active, bannerTitle = 'REVIEW GALLERY ACTIVE') {
    if (active) {
      currentSource = 'gallery';
      sourceBadge.textContent = 'REVIEW GALLERY';
      btnFlipCamera.style.display = 'none';
      if (reviewActiveBanner) reviewActiveBanner.style.display = 'flex';
      if (reviewActiveBannerText) reviewActiveBannerText.textContent = bannerTitle;
      if (btnReturnToLive) btnReturnToLive.style.display = 'inline-block';
      updateSegmentedButtons('gallery');
    } else {
      if (reviewActiveBanner) reviewActiveBanner.style.display = 'none';
      if (btnReturnToLive) btnReturnToLive.style.display = 'none';
      document.querySelectorAll('.scenario-pill').forEach((p) => p.classList.remove('active'));
      highlightNavCommand(null);
    }
  }

  async function selectScenario(sample) {
    stopAllVideoSources();
    activeGallerySampleId = sample.id;
    activeGalleryTitle = sample.title;
    setGalleryModeUI(true, `REVIEW: ${sample.title.toUpperCase()}`);

    document.querySelectorAll('.scenario-pill').forEach((p) => {
      p.classList.toggle('active', p.getAttribute('data-id') === sample.id);
    });

    if (reviewActionHint) {
      reviewActionHint.textContent = `Running browser AI on: ${sample.title}...`;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      activeGalleryImg = img;
      runStaticImageInference(img, sample.title);
      showToast(`Analyzed: ${sample.badge}`);
    };
    img.onerror = () => {
      drawStandbyCanvas('SAMPLE IMAGE LOAD ERROR', sample.id);
      showToast(`Failed to load sample ${sample.id}`, true);
    };
    img.src = getEndpoint(`/api/samples/${encodeURIComponent(sample.id)}`);
  }

  function stopAllVideoSources() {
    if (webcamAnimId !== null) {
      cancelAnimationFrame(webcamAnimId);
      webcamAnimId = null;
    }
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      webcamStream = null;
      webcamVideo.srcObject = null;
    }
    if (esp32PollTimer !== null) {
      clearInterval(esp32PollTimer);
      esp32PollTimer = null;
    }
    latestLiveDetections = [];
  }

  function updateSegmentedButtons(src) {
    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-src') === src);
    });
  }

  function switchSource(src) {
    updateSegmentedButtons(src);
    if (src === 'webcam') {
      setGalleryModeUI(false);
      startWebcamSource();
    } else if (src === 'gallery') {
      if (reviewSamplesCatalog.length > 0) {
        selectScenario(reviewSamplesCatalog[0]);
      } else {
        setGalleryModeUI(true, 'SELECT A SCENARIO BELOW');
        drawStandbyCanvas('REVIEW GALLERY MODE', 'Select any scenario pill or upload an image below');
      }
    } else {
      setGalleryModeUI(false);
      startEsp32Source();
    }
  }

  // ---------------------------------------------------------------------------
  // TELEMETRY POLLING (5 Hz) & MOTOR COMMANDS
  // ---------------------------------------------------------------------------
  async function fetchTelemetry() {
    try {
      const data = await apiGet('/api/telemetry');
      setConnectionStatus(true);
      updateTelemetryUI(data);
    } catch (_) {
      setConnectionStatus(false);
    }
  }

  function setConnectionStatus(connected) {
    if (connected) {
      connectionPill.className = 'status-pill connected';
      connectionText.textContent = 'ONLINE';
    } else {
      connectionPill.className = 'status-pill disconnected';
      connectionText.textContent = 'OFFLINE';
    }
  }

  function updateTelemetryUI(t) {
    if (telemetrySourceBadge) {
      telemetrySourceBadge.textContent = t.esp32_online ? 'ESP32 LIVE' : 'SIMULATED';
    }

    // Failsafe banner
    if (t.failsafe_active) {
      failsafeCard.className = 'failsafe-card hazard';
      failsafeIcon.textContent = '🚨';
      failsafeTitle.textContent = 'SAFETY LOCKOUT ENGAGED';
      failsafeDesc.textContent = t.failsafe_reason || 'Hazard detected. Motors halted.';
    } else {
      failsafeCard.className = 'failsafe-card secure';
      failsafeIcon.textContent = '🛡️';
      failsafeTitle.textContent = 'PATH CLEAR — NOMINAL NAVIGATION';
      failsafeDesc.textContent = 'Corridor clear. All telemetry parameters within safe marine thresholds.';
    }

    // Hull water leak
    if (t.water_leak) {
      leakBadge.className = 'badge-danger';
      leakBadge.textContent = '⚠️ HULL LEAK!';
    } else {
      leakBadge.className = 'badge-success';
      leakBadge.textContent = 'SECURE (DRY)';
    }

    // Bow ultrasonic distance
    const dist = t.distance_cm;
    if (dist != null && dist < 900) {
      distanceVal.textContent = `${Number(dist).toFixed(1)} cm`;
      const normPct = Math.min(100, Math.max(0, (dist / 150) * 100));
      distanceBar.style.width = `${normPct}%`;
      if (dist < 25) {
        distanceBar.style.backgroundColor = 'var(--danger-red)';
        distanceVal.style.color = 'var(--danger-red)';
      } else if (dist < 50) {
        distanceBar.style.backgroundColor = 'var(--warning-amber)';
        distanceVal.style.color = 'var(--warning-amber)';
      } else {
        distanceBar.style.backgroundColor = 'var(--success-green)';
        distanceVal.style.color = 'var(--text-primary)';
      }
    } else {
      distanceVal.textContent = '-- cm';
      distanceBar.style.width = '0%';
    }

    // GPS & Battery
    if (gpsCoordVal && t.lat != null && t.lon != null) {
      gpsCoordVal.textContent = `GPS: ${Number(t.lat).toFixed(5)}, ${Number(t.lon).toFixed(5)}`;
    }
    if (batteryVal && t.battery_v != null) {
      batteryVal.textContent = `BAT: ${Number(t.battery_v).toFixed(2)} V`;
    }

    if (recordCount) {
      recordCount.textContent = `${t.record_count || 0} records`;
    }

    // Sync siren & autonomous toggles
    sirenActive = Boolean(t.siren);
    if (btnSiren) {
      btnSiren.textContent = sirenActive ? '🔕 Silence Warning Siren' : '🔊 Sound Acoustic Warning Siren';
    }

    autonomousMode = Boolean(t.auto);
    if (autoModeToggle) autoModeToggle.checked = autonomousMode;
    if (autoModeBanner) {
      autoModeBanner.style.display = autonomousMode ? 'flex' : 'none';
    }

    // Command indicator
    const cmdMap = {
      F: 'FORWARD (W)',
      B: 'REVERSE (S)',
      L: 'LEFT (A)',
      R: 'RIGHT (D)',
      S: 'STOPPED',
    };
    const lastCmd = t.command || activeCommand;
    if (lastCmdBadge) {
      lastCmdBadge.textContent = cmdMap[lastCmd] || `CMD ${lastCmd}`;
    }
  }

  async function sendCommand(cmd, silent = false) {
    activeCommand = cmd;
    try {
      await apiPost('/api/command', { cmd });
      if (!silent) showToast(`Command sent: ${cmd}`);
    } catch (err) {
      if (!silent) showToast(`Command error: ${err.message}`, true);
    }
  }

  function highlightNavCommand(cmd) {
    [btnForward, btnLeft, btnRight, btnStop, btnReverse].forEach((b) => {
      if (b) b.classList.remove('highlight-auto');
    });
    if (!cmd) return;
    if (cmd === 'S' && btnStop) btnStop.classList.add('highlight-auto');
    else if (cmd === 'F' && btnForward) btnForward.classList.add('highlight-auto');
    else if (cmd === 'L' && btnLeft) btnLeft.classList.add('highlight-auto');
    else if (cmd === 'R' && btnRight) btnRight.classList.add('highlight-auto');
    else if (cmd === 'B' && btnReverse) btnReverse.classList.add('highlight-auto');
  }

  // ---------------------------------------------------------------------------
  // EVENT LISTENERS (D-PAD, KEYBOARD, GALLERY, UPLOAD, SETTINGS)
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const cmd = btn.getAttribute('data-cmd');
      if (cmd) sendCommand(cmd);
    });
  });

  if (btnSiren) {
    btnSiren.addEventListener('click', async () => {
      const nextSiren = !sirenActive;
      try {
        await apiPost('/api/command', { siren: nextSiren });
        sirenActive = nextSiren;
        showToast(nextSiren ? 'Acoustic Siren ARMED' : 'Acoustic Siren SILENCED');
      } catch (err) {
        showToast(`Siren toggle failed: ${err.message}`, true);
      }
    });
  }

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = btn.getAttribute('data-src');
      switchSource(src);
      showToast(`Switched source to ${src.toUpperCase()}`);
    });
  });

  if (btnFlipCamera) {
    btnFlipCamera.addEventListener('click', () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      if (currentSource === 'webcam') startWebcamSource();
    });
  }

  if (oilScanToggle) {
    oilScanToggle.addEventListener('change', (e) => {
      liveOilScanEnabled = e.target.checked;
      if (!liveOilScanEnabled) {
        latestLiveDetections = latestLiveDetections.filter((d) => d.category !== 'B' && d.category !== 'C');
        evaluateSceneAnalytics(latestLiveDetections, {
          oilPct: 0,
          algaePct: 0,
          algaeStatus: 'CLEAR',
          surfaceBoxes: [],
        });
      }
      showToast(`Live Oil Scan: ${liveOilScanEnabled ? 'ON (Mostly-Water + 85% Conf)' : 'OFF'}`);
    });
  }

  if (autoModeToggle) {
    autoModeToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      autonomousMode = enabled;
      try {
        await apiPost('/api/command', { auto: enabled });
        showToast(`Autonomous Steering: ${enabled ? 'ENABLED' : 'DISABLED'}`);
      } catch (err) {
        showToast(`Auto toggle failed: ${err.message}`, true);
      }
    });
  }

  if (btnReturnToLive) {
    btnReturnToLive.addEventListener('click', () => switchSource('esp32'));
  }
  if (btnExitReviewOverlay) {
    btnExitReviewOverlay.addEventListener('click', () => switchSource('esp32'));
  }

  if (customImageInput) {
    customImageInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      stopAllVideoSources();
      setGalleryModeUI(true, `UPLOAD: ${file.name.toUpperCase()}`);

      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          activeGalleryImg = img;
          runStaticImageInference(img, file.name);
          showToast(`Analyzed upload: ${file.name}`);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
      customImageInput.value = '';
    });
  }

  document.getElementById('btnExport').addEventListener('click', () => {
    window.location.href = getEndpoint('/api/export');
    showToast('Downloading telemetry CSV...');
  });

  // Keyboard controls (WASD, Arrows, Space/Esc/X) — never locked out
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (key === 'w' || e.key === 'ArrowUp') {
      e.preventDefault(); sendCommand('F');
    } else if (key === 's' || e.key === 'ArrowDown') {
      e.preventDefault(); sendCommand('B');
    } else if (key === 'a' || e.key === 'ArrowLeft') {
      e.preventDefault(); sendCommand('L');
    } else if (key === 'd' || e.key === 'ArrowRight') {
      e.preventDefault(); sendCommand('R');
    } else if (e.key === ' ' || e.key === 'Escape' || key === 'x') {
      e.preventDefault(); sendCommand('S');
    }
  });

  // Settings Modal
  btnSettings.addEventListener('click', () => {
    apiUrlInput.value = apiBaseUrl || window.location.origin;
    settingsModal.classList.add('open');
  });
  btnCloseModal.addEventListener('click', () => settingsModal.classList.remove('open'));
  btnResetApiUrl.addEventListener('click', () => {
    localStorage.removeItem('aquanav_api_url');
    apiBaseUrl = '';
    apiUrlInput.value = window.location.origin;
    settingsModal.classList.remove('open');
    showToast('Reset API URL to default origin.');
    switchSource(currentSource);
  });
  btnSaveApiUrl.addEventListener('click', () => {
    const val = apiUrlInput.value.trim();
    if (val) {
      localStorage.setItem('aquanav_api_url', val);
      apiBaseUrl = val;
    } else {
      localStorage.removeItem('aquanav_api_url');
      apiBaseUrl = '';
    }
    settingsModal.classList.remove('open');
    showToast(`Saved API URL: ${apiBaseUrl || 'Default Origin'}`);
    switchSource(currentSource);
  });

  // ---------------------------------------------------------------------------
  // REVIEW GALLERY LOADER & STARTUP
  // ---------------------------------------------------------------------------
  async function loadReviewSamples() {
    try {
      const res = await apiGet('/api/samples');
      reviewSamplesCatalog = res.samples || [];
      if (reviewSampleCount) reviewSampleCount.textContent = `${reviewSamplesCatalog.length} SCENARIOS`;

      if (scenariosGrid) {
        scenariosGrid.innerHTML = '';
        for (const s of reviewSamplesCatalog) {
          const catClass = `cat-${(s.cat || 'a').toLowerCase()}`;
          const pill = document.createElement('button');
          pill.className = 'scenario-pill';
          pill.setAttribute('data-id', s.id);
          pill.innerHTML = `
            <div class="scenario-pill-header">
              <span class="scenario-pill-title">${s.title}</span>
              <span class="scenario-pill-badge ${catClass}">${s.badge}</span>
            </div>
            <span class="scenario-pill-desc">${s.scenario}</span>
          `;
          pill.addEventListener('click', () => selectScenario(s));
          scenariosGrid.appendChild(pill);
        }
      }
    } catch (err) {
      console.warn('Failed to load review samples:', err);
    }
  }

  // Boot Sequence
  initVisionModel();
  loadReviewSamples();
  startEsp32Source();
  fetchTelemetry();
  setInterval(fetchTelemetry, 200);
})();

