const W = 960;
const H = 1280;

const emptyScreen = document.querySelector('#emptyScreen');
const loadingScreen = document.querySelector('#loadingScreen');
const fileInput = document.querySelector('#fileInput');
const viewport = document.querySelector('#swipeViewport');
const originalCanvas = document.querySelector('#originalCanvas');
const resultReveal = document.querySelector('#resultReveal');
const resultAnchor = document.querySelector('#resultAnchor');
const resultBackgroundCanvas = document.querySelector('#resultBackgroundCanvas');
const foregroundCanvas = document.querySelector('#foregroundCanvas');
const resultCanvas = document.querySelector('#resultCanvas');
const readyOverlay = document.querySelector('#readyOverlay');
const reuploadButton = document.querySelector('#reuploadButton');
const downloadButton = document.querySelector('#downloadButton');
const toast = document.querySelector('#toast');

const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
const resultBackgroundCtx = resultBackgroundCanvas.getContext('2d');
const foregroundCtx = foregroundCanvas.getContext('2d', { willReadFrequently: true });
const resultCtx = resultCanvas.getContext('2d', { willReadFrequently: true });

const state = {
  page: 0,
  ready: false,
  hasVisitedResult: false,
  busy: false,
  originalBitmap: null,
  foregroundBitmap: null,
  foregroundCanvas,
  backgroundCanvas: resultBackgroundCanvas,
  crop: null,
  drag: null,
  dragFrame: 0,
  animation: 0,
  progress: 0,
  viewportWidth: Math.max(1, window.innerWidth),
  feather: 96,
  uiMode: 'upload',
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function makeCanvas(width = W, height = H) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setUi(mode) {
  state.uiMode = mode;
  emptyScreen.hidden = mode !== 'upload';
  loadingScreen.hidden = mode !== 'loading';
  viewport.hidden = mode !== 'image';
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (!s) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

function vivid(color, strength = 1) {
  const [h, s, l] = rgbToHsl(...color);
  const boostedS = s < .025 ? 0 : clamp(s * (1.2 + strength * .18) + .025, 0, .9);
  const boostedL = l < .3 ? l + .055 : l > .8 ? l - .035 : l + .045 * strength;
  return hslToRgb(h, boostedS, clamp(boostedL, .07, .91)).map(Math.round);
}

async function decodeImage(blob) {
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

async function normalizeInput(file) {
  const bitmap = await decodeImage(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return { bitmap, blob: file };
  const canvas = makeCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
  bitmap.close();
  return { bitmap: await decodeImage(blob), blob };
}

async function removeBackground(blob) {
  const module = await import('https://esm.sh/@imgly/background-removal@1.7.0?bundle');
  const remove =
    (typeof module.default === 'function' && module.default) ||
    (typeof module.removeBackground === 'function' && module.removeBackground) ||
    (typeof module.default?.default === 'function' && module.default.default);
  if (!remove) throw new Error('未找到背景移除模块');
  const foregroundBlob = await remove(blob, {
    model: 'isnet_quint8',
    device: 'cpu',
    output: { format: 'image/png', quality: 1, type: 'foreground' },
  });
  return decodeImage(foregroundBlob);
}

let personDetectorPromise;

async function hasVisiblePerson(bitmap) {
  if (!personDetectorPromise) {
    personDetectorPromise = (async () => {
      const { FilesetResolver, ObjectDetector } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
      );
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      return ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite',
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        categoryAllowlist: ['person'],
        scoreThreshold: .4,
      });
    })().catch(error => {
      personDetectorPromise = null;
      throw error;
    });
  }
  const detector = await personDetectorPromise;
  const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
  const image = makeCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  image.getContext('2d').drawImage(bitmap, 0, 0, image.width, image.height);
  const result = detector.detect(image);
  return result.detections.some(detection => {
    const box = detection.boundingBox;
    return detection.categories.some(category => category.categoryName === 'person' && category.score >= .4)
      && box && box.width * box.height >= image.width * image.height * .008;
  });
}

function findSubjectBounds(bitmap) {
  const scale = Math.min(1, 420 / Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0, count = 0;
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      if (data[(y * canvas.width + x) * 4 + 3] > 45) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
      }
    }
  }
  if (!count) return { x: bitmap.width / 2, y: bitmap.height / 2 };
  return { x: ((minX + maxX) / 2) / scale, y: ((minY + maxY) / 2) / scale };
}

function centeredCrop(bitmap, focus) {
  const ratio = W / H;
  let sw = bitmap.width;
  let sh = sw / ratio;
  if (sh > bitmap.height) {
    sh = bitmap.height;
    sw = sh * ratio;
  }
  return {
    x: clamp(focus.x - sw / 2, 0, bitmap.width - sw),
    y: clamp(focus.y - sh * .48, 0, bitmap.height - sh),
    w: sw,
    h: sh,
  };
}

function drawCrop(ctx, bitmap, crop) {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
}

function buildCells(source, mask, cols, rows) {
  let cells = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * W / cols), x1 = Math.floor((gx + 1) * W / cols);
      const y0 = Math.floor(gy * H / rows), y1 = Math.floor((gy + 1) * H / rows);
      let r = 0, g = 0, b = 0, rr = 0, gg = 0, bb = 0, n = 0, samples = 0;
      for (let y = y0; y < y1; y += 5) {
        for (let x = x0; x < x1; x += 5) {
          samples++;
          const i = (y * W + x) * 4;
          if (mask[i + 3] > 72) continue;
          const red = source[i], green = source[i + 1], blue = source[i + 2];
          r += red; g += green; b += blue;
          rr += red * red; gg += green * green; bb += blue * blue;
          n++;
        }
      }
      if (n) {
        const meanR = r / n, meanG = g / n, meanB = b / n;
        const variance = Math.max(0, (
          rr / n - meanR * meanR +
          gg / n - meanG * meanG +
          bb / n - meanB * meanB
        ) / 3);
        cells.push([meanR, meanG, meanB, n, variance, n / Math.max(1, samples)]);
      } else {
        cells.push([0, 0, 0, 0, 0, 0]);
      }
    }
  }

  for (let pass = 0; pass < cols + rows; pass++) {
    let changed = false;
    const nextCells = cells.map(cell => cell.slice());
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const index = gy * cols + gx;
        if (cells[index][3]) continue;
        let r = 0, g = 0, b = 0, variance = 0, n = 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const neighbor = cells[ny * cols + nx];
          if (!neighbor[3]) continue;
          r += neighbor[0]; g += neighbor[1]; b += neighbor[2]; variance += neighbor[4]; n++;
        }
        if (n) {
          nextCells[index] = [r / n, g / n, b / n, .01, variance / n, 0];
          changed = true;
        }
      }
    }
    cells = nextCells;
    if (!changed) break;
  }
  return cells;
}

function regionMean(cells, cols, region) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const c = cells[y * cols + x];
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [128, 128, 128];
}

function regionStats(cells, cols, region) {
  const mean = regionMean(cells, cols, region);
  let spread = 0, texture = 0, validRatio = 0, n = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const cell = cells[y * cols + x];
      spread += colorDistance(cell, mean);
      texture += Math.sqrt(cell[4] || 0);
      validRatio += cell[5] || 0;
      n++;
    }
  }
  return {
    mean,
    spread: n ? spread / n : 0,
    texture: n ? texture / n : 0,
    validRatio: n ? validRatio / n : 0,
  };
}

function bestRegionSplit(cells, cols, region) {
  const width = region.x1 - region.x0;
  const height = region.y1 - region.y0;
  const area = width * height;
  const stats = regionStats(cells, cols, region);
  let best = null;
  const test = (axis, at) => {
    const a = axis === 'x'
      ? { ...region, x1: at }
      : { ...region, y1: at };
    const b = axis === 'x'
      ? { ...region, x0: at }
      : { ...region, y0: at };
    const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
    const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (Math.min(areaA, areaB) < 6) return;
    const balance = Math.min(areaA, areaB) / Math.max(areaA, areaB);
    const contrast = colorDistance(regionMean(cells, cols, a), regionMean(cells, cols, b));
    const axisBias = axis === 'x' ? 1.18 : 1;
    const score = Math.max(1, contrast) * (.58 + balance * .42) * Math.sqrt(area) * (1 + stats.spread / 90) * axisBias;
    if (!best || score > best.score) best = { axis, at, a, b, score, contrast, spread: stats.spread };
  };
  if (width >= 4) for (let x = region.x0 + 2; x <= region.x1 - 2; x++) test('x', x);
  if (height >= 4) for (let y = region.y0 + 2; y <= region.y1 - 2; y++) test('y', y);
  return best;
}

function imageSeed(source, mask) {
  let hash = 2166136261;
  for (let y = 0; y < H; y += 32) {
    for (let x = 0; x < W; x += 32) {
      const i = (y * W + x) * 4;
      hash ^= source[i] + source[i + 1] * 3 + source[i + 2] * 7 + mask[i + 3] * 11;
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function gridComplexity(cells, cols, rows) {
  let edge = 0, edgeCount = 0, texture = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = cells[y * cols + x];
      texture += Math.sqrt(cell[4] || 0);
      if (x + 1 < cols) {
        edge += colorDistance(cell, cells[y * cols + x + 1]);
        edgeCount++;
      }
      if (y + 1 < rows) {
        edge += colorDistance(cell, cells[(y + 1) * cols + x]);
        edgeCount++;
      }
    }
  }
  const edgeMean = edgeCount ? edge / edgeCount : 0;
  const textureMean = texture / Math.max(1, cells.length);
  return clamp(((edgeMean - 7) / 30) * .65 + ((textureMean - 5) / 38) * .35, 0, 1);
}

function clampFrame(x, y, w, h) {
  const left = clamp(Math.round(x), 0, W - 1);
  const top = clamp(Math.round(y), 0, H - 1);
  const right = clamp(Math.round(x + w), left + 1, W);
  const bottom = clamp(Math.round(y + h), top + 1, H);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function frameIoU(a, b) {
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w), bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (!intersection) return 0;
  return intersection / (a.w * a.h + b.w * b.h - intersection);
}

function cellBoundaryScore(cells, cols, rows, x, y) {
  const current = cells[y * cols + x];
  const distanceAt = (nx, ny) => {
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return 0;
    return colorDistance(current, cells[ny * cols + nx]);
  };
  const horizontal = Math.max(distanceAt(x - 1, y), distanceAt(x + 1, y));
  const vertical = Math.max(distanceAt(x, y - 1), distanceAt(x, y + 1));
  return { horizontal, vertical, score: Math.max(horizontal, vertical) + (horizontal + vertical) * .28 };
}

function buildLayeredFrames(source, mask) {
  const cols = 30, rows = 40;
  const cells = buildCells(source, mask, cols, rows);
  const complexity = gridComplexity(cells, cols, rows);
  const seed = imageSeed(source, mask);
  const random = seededRandom(seed);
  const regions = [{ x0: 0, y0: 0, x1: cols, y1: rows }];
  const detailTarget = 30
    + Math.round(20 * Math.min(1, complexity / .4))
    + Math.round(8 * Math.max(0, (complexity - .4) / .6));
  const leafTarget = 10 + Math.round(complexity * 4);

  while (regions.length < leafTarget) {
    let choice = null;
    for (let i = 0; i < regions.length; i++) {
      const split = bestRegionSplit(cells, cols, regions[i]);
      if (!split) continue;
      if (!choice || split.score > choice.split.score) choice = { index: i, split };
    }
    if (!choice) break;
    if (regions.length >= 6 && choice.split.contrast < 12 && choice.split.spread < 10) break;
    regions.splice(choice.index, 1, choice.split.a, choice.split.b);
  }

  while (regions.length < leafTarget) {
    let largestIndex = 0;
    for (let index = 1; index < regions.length; index++) {
      const area = (regions[index].x1 - regions[index].x0) * (regions[index].y1 - regions[index].y0);
      const largest = (regions[largestIndex].x1 - regions[largestIndex].x0) * (regions[largestIndex].y1 - regions[largestIndex].y0);
      if (area > largest) largestIndex = index;
    }
    const region = regions[largestIndex];
    const width = region.x1 - region.x0, height = region.y1 - region.y0;
    if (Math.max(width, height) < 4) break;
    const canSplitX = width >= 4;
    const canSplitY = height >= 4;
    const splitX = canSplitX && (!canSplitY || width >= height * .55 || random() < .72);
    if (splitX) {
      const at = clamp(Math.round(region.x0 + width * (.44 + random() * .12)), region.x0 + 2, region.x1 - 2);
      regions.splice(largestIndex, 1, { ...region, x1: at }, { ...region, x0: at });
    } else if (canSplitY) {
      const at = clamp(Math.round(region.y0 + height * (.44 + random() * .12)), region.y0 + 2, region.y1 - 2);
      regions.splice(largestIndex, 1, { ...region, y1: at }, { ...region, y0: at });
    } else {
      break;
    }
  }

  const cellW = W / cols, cellH = H / rows;
  const leafFrames = regions.map((region, index) => {
    const padX = cellW * (.3 + random() * 1.15);
    const padY = cellH * (.2 + random() * .8);
    const frame = clampFrame(
      region.x0 * cellW - padX,
      region.y0 * cellH - padY,
      (region.x1 - region.x0) * cellW + padX * 2,
      (region.y1 - region.y0) * cellH + padY * 2,
    );
    const stats = regionStats(cells, cols, region);
    const areaRatio = frame.w * frame.h / (W * H);
    const centerY = (frame.y + frame.h * .55) / H;
    return {
      ...frame,
      role: 'structure',
      salience: stats.spread + stats.texture * .45,
      localComplexity: stats.spread + stats.texture * .35,
      layer: centerY * .38 + (1 - areaRatio) * .42 + clamp(stats.spread / 120, 0, 1) * .2 + index * .0001,
    };
  });

  const candidates = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const boundary = cellBoundaryScore(cells, cols, rows, x, y);
      candidates.push({
        x,
        y,
        ...boundary,
        texture: Math.sqrt(cells[y * cols + x][4] || 0),
        tie: random(),
      });
    }
  }
  const candidatePools = {
    vertical: [...candidates].sort((a, b) => (
      b.horizontal * 1.2 + b.vertical * .16 + b.texture * .18
    ) - (
      a.horizontal * 1.2 + a.vertical * .16 + a.texture * .18
    ) || a.tie - b.tie),
    horizontal: [...candidates].sort((a, b) => (
      b.vertical * 1.2 + b.horizontal * .16 + b.texture * .12
    ) - (
      a.vertical * 1.2 + a.horizontal * .16 + a.texture * .12
    ) || a.tie - b.tie),
    block: [...candidates].sort((a, b) => b.score - a.score || a.tie - b.tie),
  };

  const overlayTarget = Math.max(0, detailTarget - leafFrames.length);
  const verticalTarget = Math.min(
    overlayTarget,
    Math.max(12, Math.round(overlayTarget * (.68 + (1 - complexity) * .04))),
  );
  const horizontalTarget = Math.min(
    overlayTarget - verticalTarget,
    Math.round(overlayTarget * .2),
  );
  const typeTargets = {
    vertical: verticalTarget,
    horizontal: horizontalTarget,
    block: overlayTarget - verticalTarget - horizontalTarget,
  };
  const overlays = [];
  const selectedSeeds = { vertical: [], horizontal: [], block: [] };
  const xBands = new Map();

  const makeFrame = (type, candidate, ordinal) => {
    let widthCells, heightCells;
    if (type === 'vertical') {
      const tower = ordinal % 5 === 0;
      widthCells = 1.35 + random() * (tower ? 1.65 : 2.85);
      heightCells = (tower ? 12 : 7) + random() * (tower ? 14 : 16);
      heightCells = Math.max(heightCells, widthCells * 2.2);
    } else if (type === 'horizontal') {
      widthCells = 6 + random() * 12;
      heightCells = 1.5 + random() * 3;
    } else {
      widthCells = 3 + random() * 6;
      heightCells = 3 + random() * 7;
    }

    const width = Math.min(W, Math.max(44, Math.round(widthCells * cellW)));
    const height = Math.min(H, Math.max(52, Math.round(heightCells * cellH)));
    const centerX = (candidate.x + .5 + (random() * 2 - 1) * .45) * cellW;
    const centerY = (candidate.y + .5 + (random() * 2 - 1) * .45) * cellH;
    return clampFrame(
      clamp(centerX - width / 2, 0, W - width),
      clamp(centerY - height / 2, 0, H - height),
      width,
      height,
    );
  };

  const appendType = (type, target) => {
    const pool = candidatePools[type];
    let attempt = 0;
    while (selectedSeeds[type].length < target && attempt < pool.length * 3) {
      const pass = Math.floor(attempt / pool.length);
      const candidate = pool[attempt % pool.length];
      const ordinal = selectedSeeds[type].length;
      const frame = makeFrame(type, candidate, ordinal + pass * target);
      const relaxed = pass > 0;
      attempt++;

      if (type === 'vertical' && (frame.h / frame.w < 1.8 || frame.w > W * .22 || frame.h < H * .12)) continue;
      if (!relaxed && selectedSeeds[type].some(seedPoint => Math.hypot(seedPoint.x - candidate.x, seedPoint.y - candidate.y) < 2.6)) continue;
      if (overlays.some(existing => frameIoU(frame, existing) > (relaxed ? .86 : existing.role === `${type}-detail` ? .68 : .84))) continue;
      if (overlays.some(existing => existing.x === frame.x && existing.y === frame.y && existing.w === frame.w && existing.h === frame.h)) continue;

      if (type === 'vertical') {
        const band = Math.min(9, Math.floor((frame.x + frame.w / 2) / W * 10));
        const count = xBands.get(band) || 0;
        if (!relaxed && count >= 4) continue;
        xBands.set(band, count + 1);
      }

      const areaRatio = frame.w * frame.h / (W * H);
      const typeBias = type === 'vertical' ? .08 : type === 'horizontal' ? .025 : .045;
      overlays.push({
        ...frame,
        role: `${type}-detail`,
        salience: candidate.score,
        localComplexity: candidate.score + candidate.texture * .28,
        layer: ((frame.y + frame.h * .58) / H) * .4
          + (1 - areaRatio) * .34
          + clamp(candidate.score / 180, 0, 1) * .18
          + typeBias
          + overlays.length * .00001,
      });
      selectedSeeds[type].push(candidate);
    }
  };

  appendType('vertical', typeTargets.vertical);
  appendType('horizontal', typeTargets.horizontal);
  appendType('block', typeTargets.block);

  const details = [...leafFrames, ...overlays]
    .sort((a, b) => a.layer - b.layer || b.w * b.h - a.w * a.h);
  return {
    seed,
    complexity,
    detailTarget,
    leafCount: leafFrames.length,
    overlayCount: overlays.length,
    verticalCount: overlays.filter(frame => frame.role === 'vertical-detail').length,
    frames: [
      { x: 0, y: 0, w: W, h: H, role: 'foundation', salience: 0, localComplexity: complexity * 100, layer: -1 },
      ...details,
    ],
  };
}

function sampleRowColor(source, mask, frame, y, fallback) {
  const reds = [], greens = [], blues = [];
  for (let oy = -2; oy <= 2; oy += 2) {
    const sy = clamp(y + oy, frame.y, frame.y + frame.h - 1);
    for (let x = frame.x + 3; x < frame.x + frame.w; x += 10) {
      const i = (sy * W + x) * 4;
      if (mask[i + 3] > 72) continue;
      reds.push(source[i]); greens.push(source[i + 1]); blues.push(source[i + 2]);
    }
  }
  if (!reds.length) return fallback;
  reds.sort((a, b) => a - b); greens.sort((a, b) => a - b); blues.sort((a, b) => a - b);
  const middle = Math.floor(reds.length / 2);
  return [reds[middle], greens[middle], blues[middle]];
}

function framePalette(source, mask, frame) {
  const bins = new Map();
  const stepX = Math.max(8, Math.floor(frame.w / 20));
  const stepY = Math.max(8, Math.floor(frame.h / 24));
  for (let y = frame.y + 2; y < frame.y + frame.h; y += stepY) {
    for (let x = frame.x + 2; x < frame.x + frame.w; x += stepX) {
      const i = (y * W + x) * 4;
      if (mask[i + 3] > 72) continue;
      const red = source[i], green = source[i + 1], blue = source[i + 2];
      const key = `${red >> 5}-${green >> 5}-${blue >> 5}`;
      const bin = bins.get(key) || [0, 0, 0, 0];
      bin[0] += red; bin[1] += green; bin[2] += blue; bin[3]++;
      bins.set(key, bin);
    }
  }
  return [...bins.values()]
    .sort((a, b) => b[3] - a[3])
    .slice(0, 6)
    .map(bin => [bin[0] / bin[3], bin[1] / bin[3], bin[2] / bin[3]]);
}

function mixColor(a, b, amount) {
  return [0, 1, 2].map(index => a[index] * (1 - amount) + b[index] * amount);
}

function paletteVariant(color, random, accent = false) {
  let [h, s, l] = rgbToHsl(...color);
  const hueRange = accent ? 10 / 360 : 4 / 360;
  const saturationRange = accent ? .16 : .08;
  const lightnessRange = accent ? .12 : .05;
  h = (h + (random() * 2 - 1) * hueRange + 1) % 1;
  s = clamp(s + (random() * 2 - 1) * saturationRange, .05, .94);
  l = clamp(l + (random() * 2 - 1) * lightnessRange, .06, .94);
  return hslToRgb(h, s, l).map(Math.round);
}

function frameTone(color, frameIndex, role) {
  let [h, s, l] = rgbToHsl(...color);
  const strength = role === 'vertical-detail'
    ? 1
    : role === 'horizontal-detail'
      ? .86
      : role === 'block-detail'
        ? .8
        : .62;
  const signed = (Math.imul(frameIndex + 3, 37) % 13) - 6;
  h = (h + signed * strength / 360 + 1) % 1;
  s = clamp(s + (((frameIndex * 5) % 7) - 3) * .012 * strength, .05, .94);
  l = clamp(l + (((frameIndex * 3) % 5) - 2) * .018 * strength, .06, .94);
  return hslToRgb(h, s, l).map(Math.round);
}

function paintHorizontalFrame(ctx, source, mask, frame, frameIndex, seed) {
  const frameSeed = (
    seed ^
    Math.imul(frame.x + 1, 73856093) ^
    Math.imul(frame.y + 1, 19349663) ^
    Math.imul(frame.w + 1, 83492791) ^
    Math.imul(frame.h + 1, 2654435761) ^
    Math.imul(frameIndex + 1, 1597334677)
  ) >>> 0;
  const random = seededRandom(frameSeed);
  const palette = framePalette(source, mask, frame);
  let fallback = palette[0] || [128, 128, 128];
  const complexity = clamp(frame.localComplexity / 90, 0, 1);
  const accentChance = .34 - complexity * .12;
  const guideStep = 10;
  const rowGuide = [];
  for (let guideY = frame.y; guideY < frame.y + frame.h; guideY += guideStep) {
    fallback = sampleRowColor(
      source,
      mask,
      frame,
      Math.min(frame.y + frame.h - 1, guideY + Math.floor(guideStep / 2)),
      fallback,
    );
    rowGuide.push(fallback);
  }
  let y = frame.y;
  let previousColor = null;
  let count = 0;
  let maxHeight = 0;

  while (y < frame.y + frame.h) {
    const remaining = frame.y + frame.h - y;
    const accent = random() < accentChance;
    const thickness = Math.min(
      remaining,
      accent ? 2 + Math.floor(random() * 2) : 3 + Math.floor(random() * 3),
      5,
    );
    const guideIndex = Math.min(rowGuide.length - 1, Math.floor((y - frame.y) / guideStep));
    const sampled = rowGuide[guideIndex] || fallback;
    const paletteColor = palette.length ? palette[Math.floor(random() * palette.length)] : sampled;
    const blended = mixColor(sampled, paletteColor, accent ? .5 : .16);
    const framed = frameTone(
      vivid(blended, .82 + (frameIndex % 4) * .06),
      frameIndex,
      frame.role,
    );
    let color = paletteVariant(framed, random, accent);
    if (previousColor && colorDistance(previousColor, color) < 7) {
      color = paletteVariant(color, random, true);
      if (colorDistance(previousColor, color) < 7) {
        const [hue, saturation, lightness] = rgbToHsl(...previousColor);
        color = hslToRgb(hue, saturation, clamp(lightness + (lightness > .5 ? -.09 : .09), .06, .94)).map(Math.round);
      }
    }
    previousColor = color;
    ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
    ctx.fillRect(frame.x, y, frame.w, thickness);
    count++;
    maxHeight = Math.max(maxHeight, thickness);
    y += thickness;
  }

  return { count, maxHeight };
}

function topHistogramKeys(counts, limit = 4) {
  const top = [];
  for (let key = 0; key < counts.length; key++) {
    if (!counts[key]) continue;
    top.push(key);
    top.sort((a, b) => counts[b] - counts[a]);
    if (top.length > limit) top.length = limit;
  }
  return top;
}

function analyzeFullWidthRows(source, mask) {
  const step = 4;
  const profiles = [];
  let fallback = {
    color: [128, 128, 128],
    palette: [[128, 128, 128]],
    shares: [1],
    spread: 0,
  };

  for (let centerY = Math.floor(step / 2); centerY < H; centerY += step) {
    const counts = new Uint16Array(512);
    const sumR = new Uint32Array(512);
    const sumG = new Uint32Array(512);
    const sumB = new Uint32Array(512);
    let totalR = 0, totalG = 0, totalB = 0, total = 0;

    for (let y = Math.max(0, centerY - 1); y <= Math.min(H - 1, centerY + 1); y += 2) {
      for (let x = 2; x < W; x += 7) {
        const index = (y * W + x) * 4;
        if (mask[index + 3] > 32) continue;
        const red = source[index], green = source[index + 1], blue = source[index + 2];
        const key = ((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5);
        counts[key]++;
        sumR[key] += red; sumG[key] += green; sumB[key] += blue;
        totalR += red; totalG += green; totalB += blue; total++;
      }
    }

    const ranked = topHistogramKeys(counts);
    if (total && ranked.length) {
      const globalMean = [totalR / total, totalG / total, totalB / total];
      const palette = ranked.map(key => [
        sumR[key] / counts[key],
        sumG[key] / counts[key],
        sumB[key] / counts[key],
      ]);
      const shares = ranked.map(key => counts[key] / total);
      let color = mixColor(globalMean, palette[0], clamp(.48 + shares[0] * .48, .54, .78));
      if (palette[1] && shares[0] < .3 && shares[1] >= .1) {
        color = mixColor(color, palette[1], .16);
      }
      let spread = 0;
      for (let key = 0; key < counts.length; key++) {
        if (!counts[key]) continue;
        const bin = [sumR[key] / counts[key], sumG[key] / counts[key], sumB[key] / counts[key]];
        spread += colorDistance(bin, globalMean) * counts[key];
      }
      fallback = { color, palette, shares, spread: spread / total };
    }

    profiles.push({
      y: centerY,
      color: fallback.color.slice(),
      palette: fallback.palette.map(color => color.slice()),
      shares: fallback.shares.slice(),
      spread: fallback.spread,
      edge: 0,
    });
  }

  const rawColors = profiles.map(profile => profile.color.slice());
  for (let index = 0; index < profiles.length; index++) {
    const current = rawColors[index];
    const before = rawColors[Math.max(0, index - 1)];
    const after = rawColors[Math.min(rawColors.length - 1, index + 1)];
    const beforeDistance = colorDistance(current, before);
    const afterDistance = colorDistance(current, after);
    if (beforeDistance < 28 && afterDistance < 28) {
      profiles[index].color = mixColor(mixColor(before, after, .5), current, .68);
    } else if (beforeDistance < 20) {
      profiles[index].color = mixColor(current, before, .12);
    } else if (afterDistance < 20) {
      profiles[index].color = mixColor(current, after, .12);
    }
  }

  for (let index = 0; index < profiles.length; index++) {
    const current = profiles[index].color;
    const before = profiles[Math.max(0, index - 1)].color;
    const after = profiles[Math.min(profiles.length - 1, index + 1)].color;
    const beforeDistance = colorDistance(current, before);
    const afterDistance = colorDistance(current, after);
    profiles[index].edge = Math.max(beforeDistance, afterDistance)
      + Math.abs(afterDistance - beforeDistance) * .18;
  }

  return { step, profiles };
}

function planSingleFrameBands(analysis, seed) {
  const { step, profiles } = analysis;
  const random = seededRandom(seed ^ 0x97E54A31);
  const quantile = (values, amount) => {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * amount))] || 0;
  };
  const edges = profiles.map(profile => profile.edge);
  const q50 = quantile(edges, .5);
  const q78 = quantile(edges, .78);
  const q95 = quantile(edges, .95);
  const candidates = profiles
    .map((profile, index) => ({
      index,
      y: profile.y,
      edge: profile.edge,
      tie: random(),
    }))
    .filter(candidate => candidate.edge >= Math.max(1.2, q78));

  const clusters = [];
  for (const candidate of candidates) {
    const last = clusters[clusters.length - 1];
    if (!last || candidate.y - last.lastY > 12) {
      clusters.push({
        firstY: candidate.y,
        lastY: candidate.y,
        strongest: candidate,
      });
    } else {
      last.lastY = candidate.y;
      if (candidate.edge > last.strongest.edge) last.strongest = candidate;
    }
  }

  const targetWindowCount = clamp(Math.round(8 + (q95 - q50) / 10), 8, 14);
  let selected = clusters
    .map(cluster => ({
      ...cluster,
      strength: clamp((cluster.strongest.edge - q50) / Math.max(1, q95 - q50), 0, 1),
    }))
    .sort((a, b) => b.strongest.edge - a.strongest.edge || a.strongest.tie - b.strongest.tie)
    .slice(0, targetWindowCount);

  if (selected.length < 6) {
    const fallbackPeaks = profiles
      .map((profile, index) => ({ index, y: profile.y, edge: profile.edge, tie: random() }))
      .sort((a, b) => b.edge - a.edge || a.tie - b.tie);
    for (const peak of fallbackPeaks) {
      if (selected.length >= 6) break;
      if (peak.edge < 2) break;
      if (selected.some(cluster => Math.abs(cluster.strongest.y - peak.y) < 48)) continue;
      selected.push({
        firstY: peak.y,
        lastY: peak.y,
        strongest: peak,
        strength: clamp((peak.edge - q50) / Math.max(1, q95 - q50), 0, 1),
      });
    }
  }

  const windows = selected
    .map(cluster => {
      let start = clamp(cluster.firstY - 10, 0, H);
      let end = clamp(cluster.lastY + 14, 0, H);
      if (end - start > 58) {
        start = clamp(cluster.strongest.y - 28, 0, H - 1);
        end = clamp(start + 58, start + 1, H);
      }
      return {
        start: Math.round(start),
        end: Math.round(end),
        center: cluster.strongest.y,
        strength: cluster.strength,
      };
    })
    .sort((a, b) => a.start - b.start);

  for (let index = 1; index < windows.length; index++) {
    const before = windows[index - 1];
    const current = windows[index];
    if (current.start >= before.end) continue;
    const midpoint = clamp(Math.round((before.center + current.center) / 2), before.start + 1, current.end - 1);
    before.end = midpoint;
    current.start = midpoint;
  }

  const bands = [];
  let y = 0;
  let windowIndex = 0;

  const microHeight = () => {
    const roll = random();
    if (roll < .46) return 1 + Math.floor(random() * 3);
    if (roll < .81) return 4 + Math.floor(random() * 4);
    if (roll < .96) return 8 + Math.floor(random() * 5);
    return 13 + Math.floor(random() * 8);
  };

  while (y < H) {
    while (windowIndex < windows.length && windows[windowIndex].end <= y) windowIndex++;
    const window = windows[windowIndex];
    const insideWindow = Boolean(window && y >= window.start && y < window.end);
    const segmentEnd = insideWindow ? window.end : Math.min(H, window?.start ?? H);
    const remaining = segmentEnd - y;

    if (remaining <= 0) {
      y++;
      continue;
    }

    let height;
    if (insideWindow) {
      height = Math.min(remaining, microHeight());
    } else {
      height = remaining;
    }

    bands.push({
      x: 0,
      y,
      w: W,
      h: height,
      role: insideWindow ? 'micro' : 'field',
      strength: insideWindow ? window.strength : 0,
      windowIndex: insideWindow ? windowIndex : -1,
    });
    y += height;
  }

  const denseBands = [];
  const spreadScale = Math.max(18, quantile(profiles.map(profile => profile.spread), .9));
  const edgeScale = Math.max(12, q95);
  const activityAt = y => {
    const index = clamp(Math.floor(y / step), 0, profiles.length - 1);
    let activity = 0;
    let weightSum = 0;
    for (let offset = -2; offset <= 2; offset++) {
      const profile = profiles[clamp(index + offset, 0, profiles.length - 1)];
      const weight = 3 - Math.abs(offset);
      activity += (clamp(profile.spread / spreadScale, 0, 1) * .65
        + clamp(profile.edge / edgeScale, 0, 1) * .35) * weight;
      weightSum += weight;
    }
    return activity / weightSum;
  };
  const stableExtent = (top, bottom) => {
    const startIndex = clamp(Math.floor(top / step), 0, profiles.length - 1);
    const startColor = profiles[startIndex].color;
    for (let index = startIndex + 1; index < profiles.length; index++) {
      const profile = profiles[index];
      const boundary = index * step;
      if (boundary >= bottom) break;
      // Width ends at a measured colour change, not a fixed pixel ceiling.
      if (colorDistance(profile.color, startColor) > 24
          || profile.edge > Math.max(10, q78 * 1.4)) {
        return Math.max(1, boundary - top);
      }
    }
    return bottom - top;
  };
  for (const [group, band] of bands.entries()) {
    const bottom = band.y + band.h;
    for (let top = band.y; top < bottom;) {
      // Source colour diversity and vertical edges decide local density.
      // Randomness only varies the rhythm within that measured density.
      const activity = clamp(activityAt(top) + (band.role === 'micro' ? .15 : 0), 0, 1);
      const roll = random();
      const span = band.role === 'field' ? stableExtent(top, bottom) : bottom - top;
      const requestedHeight = roll < .16 + activity * .65
        ? 1 + Math.floor(random() * 3)
        : roll < .38 + activity * .58
          ? 4 + Math.floor(random() * 11)
          : Math.max(1, Math.round(span * (.55 + random() * .45)));
      const height = Math.min(span, requestedHeight);
      denseBands.push({
        ...band,
        y: top,
        h: height,
        group,
        groupY: band.y,
        groupHeight: band.h,
        activity,
      });
      top += height;
    }
  }

  return { bands: denseBands, windows };
}

function scanFullWidthBand(source, mask, band) {
  const counts = new Uint32Array(512);
  const sumR = new Uint32Array(512);
  const sumG = new Uint32Array(512);
  const sumB = new Uint32Array(512);
  let totalR = 0, totalG = 0, totalB = 0, total = 0;

  for (let y = band.y; y < band.y + band.h; y += 2) {
    for (let x = 0; x < W; x += 3) {
      const index = (y * W + x) * 4;
      if (mask[index + 3] > 32) continue;
      const red = source[index], green = source[index + 1], blue = source[index + 2];
      const key = ((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5);
      counts[key]++;
      sumR[key] += red; sumG[key] += green; sumB[key] += blue;
      totalR += red; totalG += green; totalB += blue; total++;
    }
  }

  if (total < 48) return null;
  const ranked = topHistogramKeys(counts, 32);

  const binColor = key => [
    sumR[key] / counts[key],
    sumG[key] / counts[key],
    sumB[key] / counts[key],
  ];
  // Combine neighbouring histogram bins into real colour families. A slight
  // change in which side of a bin boundary wins must not create a bright line.
  const families = [];
  for (const key of ranked) {
    const color = binColor(key);
    const count = counts[key];
    const [hue, saturation] = rgbToHsl(...color);
    const family = families.find(entry => {
      const [otherHue, otherSaturation] = rgbToHsl(...entry.color);
      const hueDistance = Math.min(Math.abs(hue - otherHue), 1 - Math.abs(hue - otherHue));
      return colorDistance(entry.color, color) < 22
        && (Math.max(saturation, otherSaturation) < .14 || hueDistance < .07);
    });
    if (family) {
      family.color = mixColor(family.color, color, count / (family.count + count));
      family.count += count;
    } else {
      families.push({ color, count });
    }
  }
  families.sort((a, b) => b.count - a.count);
  const palette = families.slice(0, 8).map(entry => entry.color);
  const shares = families.slice(0, 8).map(entry => entry.count / total);
  const base = palette[0];
  return { base, palette, shares };
}

function preserveSourceTone(color) {
  return color.map(value => Math.round(clamp(value, 0, 255)));
}

function buildStripeTexture(seed) {
  const random = seededRandom(seed ^ 0x63B9D257);
  const texture = new Float32Array(H);
  const density = new Float32Array(H);
  // Irregular quiet and dense passages, with multiple neighbouring stripes
  // sharing one tonal movement rather than isolated random accent colours.
  for (let y = 0; y < H;) {
    const length = 34 + Math.floor(random() * 112);
    const strength = .5 + random() * .85;
    density.fill(strength, y, Math.min(H, y + length));
    y += length;
  }
  for (const [minimum, range, amplitude] of [[24, 68, 7], [5, 17, 11], [1, 4, 3.5]]) {
    let previous = 0;
    for (let y = 0; y < H;) {
      const length = minimum + Math.floor(random() * range);
      const value = (random() * 2 - 1) * amplitude;
      const tone = value * .82 + previous * .18;
      for (let row = y; row < Math.min(H, y + length); row++) {
        texture[row] += tone * density[row];
      }
      previous = tone;
      y += length;
    }
  }
  return texture;
}

function resolveBandColor(sample, band, groupColor, window, texture, palette, seed) {
  // Fine samples belong to a broad colour field; they are not independent
  // randomly coloured lines. Keep only measured, same-family variation.
  const nearest = sample.palette.reduce((best, color) =>
    colorDistance(color, groupColor) < colorDistance(best, groupColor) ? color : best,
  sample.palette[0] || groupColor);
  const distance = colorDistance(nearest, groupColor);
  let color = mixColor(groupColor, nearest, distance < 32 ? .55 : .08);

  const center = Math.min(H - 1, band.y + Math.floor(band.h / 2));
  const brightness = color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
  const tone = texture[center] * clamp(brightness / 65, 0, 1);
  // Retain the source hue and black point while making the nested layers
  // visible even where the source is a nearly uniform sky or wall.
  color = color.map(channel => channel + tone);

  const random = seededRandom(seed ^ Math.imul(band.y + 1, 2246822519));
  const choose = entries => {
    let target = random() * entries.reduce((sum, entry) => sum + entry.weight, 0);
    return (entries.find(entry => (target -= entry.weight) <= 0) || entries[entries.length - 1]).color;
  };
  const localColors = sample.palette.map((value, index) => ({
    color: value,
    share: sample.shares[index],
    weight: Math.sqrt(sample.shares[index]) * (1 + rgbToHsl(...value)[1] * 1.8),
  })).filter(entry => entry.share >= .018 && colorDistance(entry.color, groupColor) > 22);
  const borrowedColors = palette.filter(entry => colorDistance(entry.color, groupColor) > 48);
  const roll = random();
  const borrowChance = band.h <= 8 ? .045 + band.activity * .10 : .015;
  if (borrowedColors.length && roll < borrowChance) {
    color = choose(borrowedColors);
  } else if (localColors.length && roll < borrowChance + .16 + band.activity * .34) {
    // Preserve minority colours such as foliage directly instead of mixing
    // them back into the dominant sky, concrete or shadow colour.
    color = choose(localColors);
  }

  // A narrow, source-backed dark detail at a real boundary preserves wires,
  // rails and shadows without scattering contrasting lines across the sky.
  if (window && window.strength > .3
      && band.y < window.center + 2 && band.y + band.h > window.center - 2) {
    const luminance = value => value[0] * .2126 + value[1] * .7152 + value[2] * .0722;
    const dark = sample.palette
      .filter((value, index) => sample.shares[index] >= .035
        && luminance(value) < luminance(groupColor) - 30)
      .sort((a, b) => luminance(a) - luminance(b))[0];
    if (dark) color = dark;
  }
  return preserveSourceTone(color);
}

function buildSingleFramePlan(source, mask) {
  const seed = imageSeed(source, mask);
  const analysis = analyzeFullWidthRows(source, mask);
  const planned = planSingleFrameBands(analysis, seed);
  return {
    seed,
    analysis,
    bands: planned.bands,
    windows: planned.windows,
    frames: [{ x: 0, y: 0, w: W, h: H, role: 'foundation' }],
  };
}

function paintSingleFrameBackground(ctx, source, mask, plan) {
  const samples = plan.bands.map(band => scanFullWidthBand(source, mask, band));
  const firstValid = samples.find(Boolean) || {
    base: [128, 128, 128],
    palette: [[128, 128, 128]],
    shares: [1],
  };

  for (let index = 0; index < samples.length; index++) {
    if (samples[index]) continue;
    let distance = 1;
    while (!samples[index] && (index - distance >= 0 || index + distance < samples.length)) {
      samples[index] = samples[index - distance] || samples[index + distance] || null;
      distance++;
    }
    samples[index] ||= firstValid;
  }

  const groupColors = new Map();
  let previousColor = null;
  for (const band of plan.bands) {
    if (groupColors.has(band.group)) continue;
    const sample = scanFullWidthBand(source, mask, {
      y: band.groupY, h: band.groupHeight,
    }) || firstValid;
    let color = sample.palette[0];
    if (previousColor) {
      // Stabilise competing near-equal modes, but allow a new dominant source
      // colour to take over. Never average dark and light families together.
      const candidates = sample.palette.filter((value, index) =>
        sample.shares[index] >= sample.shares[0] * .8);
      color = candidates.reduce((best, value) =>
        colorDistance(value, previousColor) < colorDistance(best, previousColor) ? value : best,
      color);
    }
    groupColors.set(band.group, color);
    previousColor = color;
  }

  const heights = [];
  const records = [];
  const texture = buildStripeTexture(plan.seed);
  const palette = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    sample.palette.forEach((color, colorIndex) => {
      const share = sample.shares[colorIndex] || 0;
      if (share < .025) return;
      const weight = Math.sqrt(share) * plan.bands[index].h;
      const existing = palette.find(entry => colorDistance(entry.color, color) < 24);
      if (existing) existing.weight += weight;
      else palette.push({ color, weight });
    });
  }
  palette.sort((a, b) => b.weight - a.weight);
  const borrowedPalette = palette.slice(0, 24).map(entry => ({
    color: entry.color,
    weight: Math.sqrt(entry.weight) * (1 + rgbToHsl(...entry.color)[1]),
  }));
  for (let index = 0; index < plan.bands.length; index++) {
    const band = plan.bands[index];
    const window = band.windowIndex >= 0 ? plan.windows[band.windowIndex] : null;
    const color = resolveBandColor(samples[index], band, groupColors.get(band.group), window, texture, borrowedPalette, plan.seed);
    ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
    ctx.fillRect(0, band.y, W, band.h);
    heights.push(band.h);
    records.push({ ...band, color });
  }

  return {
    records,
    count: records.length,
    minHeight: Math.min(...heights),
    maxHeight: Math.max(...heights),
    meanHeight: H / Math.max(1, records.length),
    uniqueHeights: new Set(heights).size,
    fineCount: heights.filter(height => height <= 13).length,
    mediumCount: heights.filter(height => height > 13 && height < 40).length,
    broadCount: heights.filter(height => height >= 40).length,
    microCount: records.filter(record => record.role === 'micro').length,
    fieldCount: records.filter(record => record.role === 'field').length,
  };
}

function renderPurePlay(foregroundCanvas) {
  const source = originalCtx.getImageData(0, 0, W, H).data;
  const mask = foregroundCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const plan = buildSingleFramePlan(source, mask);
  resultBackgroundCtx.clearRect(0, 0, W, H);
  const stripes = paintSingleFrameBackground(resultBackgroundCtx, source, mask, plan);

  state.renderStats = {
    seed: plan.seed,
    frameCount: plan.frames.length,
    detailCount: 0,
    stripeCount: stripes.count,
    minStripeHeight: stripes.minHeight,
    maxStripeHeight: stripes.maxHeight,
    meanStripeHeight: stripes.meanHeight,
    uniqueStripeHeights: stripes.uniqueHeights,
    fineStripeCount: stripes.fineCount,
    mediumStripeCount: stripes.mediumCount,
    broadStripeCount: stripes.broadCount,
    microStripeCount: stripes.microCount,
    fieldStripeCount: stripes.fieldCount,
    boundaryWindowCount: plan.windows.length,
  };

  state.backgroundCanvas = resultBackgroundCanvas;
  state.foregroundCanvas = foregroundCanvas;

  resultCtx.clearRect(0, 0, W, H);
  resultCtx.drawImage(resultBackgroundCanvas, 0, 0);
  resultCtx.drawImage(foregroundCanvas, 0, 0);
  return { plan, stripes };
}

async function generate(file) {
  if (state.busy) return;
  state.busy = true;
  state.ready = false;
  state.hasVisitedResult = false;
  setUi('loading');
  placePage(0);

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    const normalized = await normalizeInput(file);
    state.originalBitmap?.close?.();
    state.foregroundBitmap?.close?.();
    state.foregroundBitmap = null;
    foregroundCtx.clearRect(0, 0, W, H);
    state.originalBitmap = normalized.bitmap;

    const provisionalCrop = centeredCrop(state.originalBitmap, { x: state.originalBitmap.width / 2, y: state.originalBitmap.height / 2 });
    drawCrop(originalCtx, state.originalBitmap, provisionalCrop);

    // Salient-object removal also extracts buildings. Only preserve that
    // foreground when a separate person detector confirms a visible person.
    const hasPerson = await hasVisiblePerson(state.originalBitmap);
    if (hasPerson) {
      state.foregroundBitmap = await removeBackground(normalized.blob);
      const focus = findSubjectBounds(state.foregroundBitmap);
      state.crop = centeredCrop(state.originalBitmap, focus);
      drawCrop(originalCtx, state.originalBitmap, state.crop);
      drawCrop(foregroundCtx, state.foregroundBitmap, state.crop);
    } else {
      state.crop = provisionalCrop;
      // Empty alpha mask makes the entire photo available to background
      // sampling and leaves no object overlay in the transition or download.
      foregroundCtx.clearRect(0, 0, W, H);
    }
    await new Promise(requestAnimationFrame);
    renderPurePlay(foregroundCanvas);

    state.ready = true;
    placePage(0);
    setUi('image');
    viewport.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    showToast('生成失败，请检查网络后重试');
    setUi('upload');
  } finally {
    state.busy = false;
  }
}

function updateViewportMetrics() {
  const width = Math.max(1, viewport.getBoundingClientRect().width || window.innerWidth);
  state.viewportWidth = width;
  state.feather = clamp(width * .23, 76, 112);
  resultReveal.style.setProperty('--feather', `${state.feather}px`);
}

function renderProgress(progress) {
  const p = clamp(progress, 0, 1);
  state.progress = p;

  const revealX = -state.viewportWidth * (1 - p);
  const stretch = 1 + .085 * (1 - p);

  resultReveal.style.transform = `translate3d(${revealX}px,0,0)`;
  resultAnchor.style.transform = `translate3d(${-revealX}px,0,0)`;
  resultBackgroundCanvas.style.transform = `scale3d(${stretch},1,1)`;
  resultReveal.classList.toggle('is-original', p <= .0001);
  resultReveal.classList.toggle('is-result', p >= .9999);
}

function hideEndpointUi() {
  readyOverlay.hidden = true;
  viewport.classList.remove('has-result-actions', 'has-reupload-action');
  downloadButton.tabIndex = -1;
  reuploadButton.tabIndex = -1;
}

function syncEndpointUi() {
  if (!state.ready) {
    hideEndpointUi();
    return;
  }

  const showReady = state.page === 0 && !state.hasVisitedResult;
  const showReupload = state.page === 0 && state.hasVisitedResult;
  const showDownload = state.page === 1;

  readyOverlay.hidden = !showReady;
  viewport.classList.toggle('has-reupload-action', showReupload);
  viewport.classList.toggle('has-result-actions', showDownload);
  reuploadButton.tabIndex = showReupload ? 0 : -1;
  downloadButton.tabIndex = showDownload ? 0 : -1;
}

function placePage(page) {
  state.page = page ? 1 : 0;
  renderProgress(state.page);
  if (state.page === 1) state.hasVisitedResult = true;
  syncEndpointUi();
}

function showTransition(progress) {
  hideEndpointUi();
  renderProgress(progress);
}

function animateTo(from, target, onComplete) {
  cancelAnimationFrame(state.animation);
  state.animation = 0;
  setUi('image');
  hideEndpointUi();
  const started = performance.now();
  const distance = Math.abs(target - from);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduceMotion ? 1 : 240 + distance * 220;
  const tick = now => {
    const t = clamp((now - started) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const progress = from + (target - from) * eased;
    showTransition(progress);
    if (t < 1) state.animation = requestAnimationFrame(tick);
    else {
      state.animation = 0;
      placePage(target);
      onComplete?.();
    }
  };
  state.animation = requestAnimationFrame(tick);
}

function setPage(page, animate = false) {
  const target = page ? 1 : 0;
  if (!state.ready) return;
  setUi('image');
  if (!animate) placePage(target);
  else animateTo(state.progress, target);
}

const SWIPE_SLOP = 8;
const AXIS_RATIO = 1.08;

function viewportWidth() {
  return Math.max(1, state.viewportWidth);
}

function beginGesture(id, x, y, source) {
  if (!state.ready || state.busy || state.drag) return false;
  cancelAnimationFrame(state.animation);
  state.animation = 0;
  const now = performance.now();
  state.drag = {
    id,
    source,
    axis: 'pending',
    startX: x,
    startY: y,
    startTime: now,
    lastX: x,
    lastTime: now,
    velocity: 0,
    originPage: state.page,
    startProgress: state.progress,
    progress: state.progress,
  };
  return true;
}

function queueGestureFrame() {
  if (state.dragFrame) return;
  state.dragFrame = requestAnimationFrame(() => {
    state.dragFrame = 0;
    if (state.drag?.axis === 'x') showTransition(state.drag.progress);
  });
}

function abortGesture(animateBack = false) {
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  cancelAnimationFrame(state.dragFrame);
  state.dragFrame = 0;

  if (animateBack && drag.axis === 'x') {
    animateTo(drag.progress, drag.originPage);
  } else {
    placePage(drag.originPage);
  }
}

function moveGesture(x, y, nativeEvent) {
  const drag = state.drag;
  if (!drag) return false;

  const dx = x - drag.startX;
  const dy = y - drag.startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (drag.axis === 'pending') {
    if (Math.max(absX, absY) < SWIPE_SLOP) return false;
    if (absY > absX * AXIS_RATIO) {
      abortGesture(false);
      return false;
    }
    if (absX <= absY * AXIS_RATIO) return false;

    drag.axis = 'x';
    showTransition(drag.startProgress);
  }

  if (drag.axis !== 'x') return false;
  if (nativeEvent?.cancelable) nativeEvent.preventDefault();

  const now = performance.now();
  const dt = Math.max(1, now - drag.lastTime);
  const instantaneousVelocity = (x - drag.lastX) / dt;
  drag.velocity = drag.velocity * .68 + instantaneousVelocity * .32;
  drag.lastX = x;
  drag.lastTime = now;
  drag.progress = clamp(drag.startProgress + dx / viewportWidth(), 0, 1);
  queueGestureFrame();
  return true;
}

function finishGesture(x, y, nativeEvent, cancelled = false) {
  if (!state.drag) return;
  if (!cancelled) moveGesture(x, y, nativeEvent);
  const drag = state.drag;
  if (!drag) return;

  state.drag = null;
  cancelAnimationFrame(state.dragFrame);
  state.dragFrame = 0;

  if (drag.axis !== 'x') {
    placePage(drag.originPage);
    return;
  }

  showTransition(drag.progress);
  if (cancelled) {
    animateTo(drag.progress, drag.originPage);
    return;
  }

  let target = drag.progress >= .5 ? 1 : 0;
  if (Math.abs(drag.velocity) > .35) {
    target = drag.velocity > 0 ? 1 : 0;
  } else if (Math.abs(drag.progress - drag.startProgress) < .08) {
    target = drag.originPage;
  }

  animateTo(drag.progress, target);
}

function onPointerDown(event) {
  if (event.target.closest?.('button')) return;
  if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if (!beginGesture(event.pointerId, event.clientX, event.clientY, 'pointer')) return;
  try { viewport.setPointerCapture(event.pointerId); } catch {}
}

function onPointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.source !== 'pointer' || drag.id !== event.pointerId) return;
  moveGesture(event.clientX, event.clientY, event);
}

function onPointerUp(event) {
  const drag = state.drag;
  if (!drag || drag.source !== 'pointer' || drag.id !== event.pointerId) return;
  finishGesture(event.clientX, event.clientY, event);
  try { viewport.releasePointerCapture(event.pointerId); } catch {}
}

function findTouch(list, id) {
  for (let index = 0; index < list.length; index++) {
    if (list[index].identifier === id) return list[index];
  }
  return null;
}

function onTouchStart(event) {
  if (event.target.closest?.('button')) return;
  if (event.touches.length !== 1 || state.drag) return;
  const touch = event.changedTouches[0];
  beginGesture(touch.identifier, touch.clientX, touch.clientY, 'touch');
}

function onTouchMove(event) {
  const drag = state.drag;
  if (!drag || drag.source !== 'touch') return;
  if (event.touches.length > 1) {
    abortGesture(true);
    return;
  }
  const touch = findTouch(event.touches, drag.id);
  if (touch) moveGesture(touch.clientX, touch.clientY, event);
}

function onTouchEnd(event) {
  const drag = state.drag;
  if (!drag || drag.source !== 'touch') return;
  const touch = findTouch(event.changedTouches, drag.id);
  if (touch) finishGesture(touch.clientX, touch.clientY, event);
}

emptyScreen.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  await generate(file);
  fileInput.value = '';
});

function downloadResult() {
  if (!state.ready || state.page !== 1) return;
  resultCanvas.toBlob(blob => {
    if (!blob) {
      showToast('下载失败，请重试');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `纯玩照片-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, 'image/png');
}

downloadButton.addEventListener('pointerdown', event => event.stopPropagation());
downloadButton.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
downloadButton.addEventListener('click', downloadResult);
reuploadButton.addEventListener('pointerdown', event => event.stopPropagation());
reuploadButton.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
reuploadButton.addEventListener('click', () => fileInput.click());

if ('PointerEvent' in window) {
  viewport.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp, { passive: false });
  window.addEventListener('pointercancel', event => {
    if (state.drag?.source === 'pointer' && state.drag.id === event.pointerId) abortGesture(true);
  }, { passive: true });
  viewport.addEventListener('lostpointercapture', event => {
    if (state.drag?.source === 'pointer' && state.drag.id === event.pointerId) abortGesture(true);
  });
} else {
  viewport.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: false });
  window.addEventListener('touchcancel', () => abortGesture(true), { passive: true });
}

viewport.addEventListener('keydown', event => {
  if (!state.ready || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  event.preventDefault();
  setPage(event.key === 'ArrowRight' ? 1 : 0, true);
});

window.addEventListener('resize', () => {
  updateViewportMetrics();
  renderProgress(state.progress);
});
window.addEventListener('blur', () => abortGesture(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) abortGesture(true);
});

updateViewportMetrics();
placePage(0);

function registerWebMCP() {
  const context = navigator.modelContext;
  if (!context?.registerTool) return;
  try {
    context.registerTool({
      name: 'show_pureplay_page',
      description: '在纯玩照片生成器中显示原图页或结果页。',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'string', enum: ['original', 'result'] } },
        required: ['page'],
      },
      execute: async ({ page }) => {
        if (page === 'result' && !state.ready) return { content: [{ type: 'text', text: '结果仍在生成中。' }] };
        setPage(page === 'result' ? 1 : 0, true);
        return { content: [{ type: 'text', text: `已显示${page === 'result' ? '结果' : '原图'}页。` }] };
      },
    });
  } catch (error) {
    console.debug('WebMCP unavailable', error);
  }
}

registerWebMCP();
