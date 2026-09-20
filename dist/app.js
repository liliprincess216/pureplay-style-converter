const W = 960;
const H = 1280;

const emptyScreen = document.querySelector('#emptyScreen');
const loadingScreen = document.querySelector('#loadingScreen');
const readyScreen = document.querySelector('#readyScreen');
const fileInput = document.querySelector('#fileInput');
const viewport = document.querySelector('#swipeViewport');
const pageTrack = document.querySelector('#pageTrack');
const originalCanvas = document.querySelector('#originalCanvas');
const resultCanvas = document.querySelector('#resultCanvas');
const transitionCanvas = document.querySelector('#bandCanvas');
const toast = document.querySelector('#toast');

const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
const resultCtx = resultCanvas.getContext('2d', { willReadFrequently: true });
const transitionCtx = transitionCanvas.getContext('2d');

const state = {
  page: 0,
  ready: false,
  busy: false,
  originalBitmap: null,
  foregroundBitmap: null,
  foregroundCanvas: null,
  backgroundCanvas: null,
  blendCanvas: null,
  crop: null,
  drag: null,
  dragFrame: 0,
  animation: 0,
  progress: 0,
  introPending: false,
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
  readyScreen.hidden = mode !== 'ready';
  viewport.hidden = mode === 'upload';
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
  const boostedS = clamp(s * (1.2 + strength * .18) + .04, 0, .9);
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
  const cells = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * W / cols), x1 = Math.floor((gx + 1) * W / cols);
      const y0 = Math.floor(gy * H / rows), y1 = Math.floor((gy + 1) * H / rows);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 6) {
        for (let x = x0; x < x1; x += 6) {
          const i = (y * W + x) * 4;
          if (mask[i + 3] > 72) continue;
          r += source[i]; g += source[i + 1]; b += source[i + 2]; n++;
        }
      }
      cells.push(n ? [r / n, g / n, b / n, n] : [0, 0, 0, 0]);
    }
  }

  for (let pass = 0; pass < cols + rows; pass++) {
    let changed = false;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const index = gy * cols + gx;
        if (cells[index][3]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const next = cells[ny * cols + nx];
          if (!next[3]) continue;
          r += next[0]; g += next[1]; b += next[2]; n++;
        }
        if (n) {
          cells[index] = [r / n, g / n, b / n, .01];
          changed = true;
        }
      }
    }
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

function bestRegionSplit(cells, cols, region) {
  const width = region.x1 - region.x0;
  const height = region.y1 - region.y0;
  const area = width * height;
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
    const balance = Math.min(areaA, areaB) / Math.max(areaA, areaB);
    const contrast = colorDistance(regionMean(cells, cols, a), regionMean(cells, cols, b));
    const score = contrast * (.58 + balance * .42) * Math.sqrt(area);
    if (!best || score > best.score) best = { axis, at, a, b, score };
  };
  if (width >= 4) for (let x = region.x0 + 2; x <= region.x1 - 2; x++) test('x', x);
  if (height >= 4) for (let y = region.y0 + 2; y <= region.y1 - 2; y++) test('y', y);
  return best;
}

function buildCoveringFrames(source, mask) {
  const cols = 12, rows = 16;
  const cells = buildCells(source, mask, cols, rows);
  const regions = [{ x0: 0, y0: 0, x1: cols, y1: rows }];
  const target = 7;

  while (regions.length < target) {
    let choice = null;
    for (let i = 0; i < regions.length; i++) {
      const split = bestRegionSplit(cells, cols, regions[i]);
      if (!split) continue;
      if (!choice || split.score > choice.split.score) choice = { index: i, split };
    }
    if (!choice) break;
    regions.splice(choice.index, 1, choice.split.a, choice.split.b);
  }

  return regions.map(region => {
    const x = Math.floor(region.x0 * W / cols);
    const y = Math.floor(region.y0 * H / rows);
    const right = Math.floor(region.x1 * W / cols);
    const bottom = Math.floor(region.y1 * H / rows);
    return { x, y, w: right - x, h: bottom - y };
  });
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

function paintHorizontalFrame(ctx, source, mask, frame, frameIndex) {
  const step = frame.h > 400 ? 4 : 3;
  const rows = [];
  let fallback = [128, 128, 128];
  for (let y = frame.y; y < frame.y + frame.h; y += step) {
    fallback = sampleRowColor(source, mask, frame, y, fallback);
    rows.push({ y, color: vivid(fallback, .8 + (frameIndex % 3) * .08) });
  }
  if (!rows.length) return;

  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    const length = i - start;
    const edge = i === rows.length || colorDistance(rows[i - 1].color, rows[i].color) > 24;
    const maxLength = 8 + (frameIndex * 5 + start) % 11;
    if ((edge && length >= 2) || length >= maxLength || i === rows.length) {
      const group = rows.slice(start, i);
      const color = group.reduce((acc, row) => {
        acc[0] += row.color[0]; acc[1] += row.color[1]; acc[2] += row.color[2]; return acc;
      }, [0, 0, 0]).map(value => Math.round(value / group.length));
      const top = group[0].y;
      const bottom = i < rows.length ? rows[i].y : frame.y + frame.h;
      ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
      ctx.fillRect(frame.x, top, frame.w, Math.max(1, bottom - top));
      start = i;
    }
  }
}

function renderPurePlay(foregroundCanvas) {
  const source = originalCtx.getImageData(0, 0, W, H).data;
  const mask = foregroundCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const frames = buildCoveringFrames(source, mask);
  const backgroundCanvas = makeCanvas();
  const backgroundCtx = backgroundCanvas.getContext('2d');

  backgroundCtx.fillStyle = '#d6d2ca';
  backgroundCtx.fillRect(0, 0, W, H);
  frames.forEach((frame, index) => paintHorizontalFrame(backgroundCtx, source, mask, frame, index));

  state.backgroundCanvas = backgroundCanvas;
  state.foregroundCanvas = foregroundCanvas;
  state.blendCanvas = makeCanvas();

  resultCtx.clearRect(0, 0, W, H);
  resultCtx.drawImage(backgroundCanvas, 0, 0);
  resultCtx.drawImage(foregroundCanvas, 0, 0);
}

async function generate(file) {
  if (state.busy) return;
  state.busy = true;
  state.ready = false;
  state.introPending = false;
  setUi('loading');
  placePage(0);

  try {
    const normalized = await normalizeInput(file);
    state.originalBitmap?.close?.();
    state.foregroundBitmap?.close?.();
    state.originalBitmap = normalized.bitmap;

    const provisionalCrop = centeredCrop(state.originalBitmap, { x: state.originalBitmap.width / 2, y: state.originalBitmap.height / 2 });
    drawCrop(originalCtx, state.originalBitmap, provisionalCrop);

    state.foregroundBitmap = await removeBackground(normalized.blob);
    const focus = findSubjectBounds(state.foregroundBitmap);
    state.crop = centeredCrop(state.originalBitmap, focus);
    drawCrop(originalCtx, state.originalBitmap, state.crop);

    const foregroundCanvas = makeCanvas();
    drawCrop(foregroundCanvas.getContext('2d'), state.foregroundBitmap, state.crop);
    await new Promise(requestAnimationFrame);
    renderPurePlay(foregroundCanvas);

    state.ready = true;
    state.introPending = true;
    renderTransition(0);
    placePage(0);
    setUi('ready');
  } catch (error) {
    console.error(error);
    showToast('生成失败，请检查网络后重试');
    setUi('upload');
  } finally {
    state.busy = false;
  }
}

function renderTransition(progress) {
  const p = clamp(progress, 0, 1);
  if (!state.backgroundCanvas || !state.foregroundCanvas) return;

  transitionCtx.clearRect(0, 0, W, H);
  transitionCtx.drawImage(originalCanvas, 0, 0, W, H);

  const layer = state.blendCanvas;
  const layerCtx = layer.getContext('2d');
  layerCtx.globalCompositeOperation = 'source-over';
  layerCtx.clearRect(0, 0, W, H);

  const stretch = 1 + .72 * (1 - p);
  const stretchedWidth = W * stretch;
  const stretchedX = W - stretchedWidth;
  layerCtx.drawImage(state.backgroundCanvas, 0, 0, W, H, stretchedX, 0, stretchedWidth, H);

  const boundary = W * (1 - p);
  const blendWidth = 52 + 108 * (1 - p);
  layerCtx.globalCompositeOperation = 'destination-in';
  const gradient = layerCtx.createLinearGradient(boundary - blendWidth, 0, boundary, 0);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,1)');
  layerCtx.fillStyle = gradient;
  layerCtx.fillRect(boundary - blendWidth, 0, blendWidth, H);
  layerCtx.fillStyle = '#000';
  layerCtx.fillRect(boundary, 0, W - boundary, H);
  layerCtx.globalCompositeOperation = 'source-over';

  transitionCtx.drawImage(layer, 0, 0);
  transitionCtx.drawImage(state.foregroundCanvas, 0, 0);
}

function placePage(page) {
  state.page = page ? 1 : 0;
  state.progress = state.page;
  pageTrack.style.transform = state.page
    ? 'translate3d(-50%,0,0)'
    : 'translate3d(0,0,0)';
  transitionCanvas.classList.remove('is-visible');
}

function showTransition(progress) {
  state.progress = clamp(progress, 0, 1);
  pageTrack.style.transform = 'translate3d(0,0,0)';
  transitionCanvas.classList.add('is-visible');
  renderTransition(state.progress);
}

function animateTo(from, target, onComplete) {
  cancelAnimationFrame(state.animation);
  state.animation = 0;
  setUi('image');
  const started = performance.now();
  const distance = Math.abs(target - from);
  const duration = 280 + distance * 220;
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
  state.introPending = false;
  setUi('image');
  if (!animate) placePage(target);
  else animateTo(state.progress, target);
}

const SWIPE_SLOP = 8;
const AXIS_RATIO = 1.08;

function viewportWidth() {
  return Math.max(1, viewport.getBoundingClientRect().width || window.innerWidth);
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
    introWasVisible: state.uiMode === 'ready',
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

function restoreIntroIfNeeded(drag) {
  if (drag.introWasVisible && state.introPending && state.page === 0) {
    setUi('ready');
  }
}

function abortGesture(animateBack = false) {
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  cancelAnimationFrame(state.dragFrame);
  state.dragFrame = 0;

  if (animateBack && drag.axis === 'x') {
    animateTo(drag.progress, drag.originPage, () => restoreIntroIfNeeded(drag));
  } else {
    placePage(drag.originPage);
    restoreIntroIfNeeded(drag);
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
    if (drag.introWasVisible) setUi('image');
    showTransition(drag.startProgress);
  }

  if (drag.axis !== 'x') return false;
  if (nativeEvent?.cancelable) nativeEvent.preventDefault();

  const now = performance.now();
  const dt = Math.max(1, now - drag.lastTime);
  const instantaneousVelocity = -(x - drag.lastX) / dt;
  drag.velocity = drag.velocity * .68 + instantaneousVelocity * .32;
  drag.lastX = x;
  drag.lastTime = now;
  drag.progress = clamp(drag.startProgress - dx / viewportWidth(), 0, 1);
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
    restoreIntroIfNeeded(drag);
    return;
  }

  showTransition(drag.progress);
  if (cancelled) {
    animateTo(drag.progress, drag.originPage, () => restoreIntroIfNeeded(drag));
    return;
  }

  let target = drag.progress >= .5 ? 1 : 0;
  if (Math.abs(drag.velocity) > .35) {
    target = drag.velocity > 0 ? 1 : 0;
  } else if (Math.abs(drag.progress - drag.startProgress) < .08) {
    target = drag.originPage;
  }

  if (target === 1) state.introPending = false;
  animateTo(drag.progress, target, () => restoreIntroIfNeeded(drag));
}

function onPointerDown(event) {
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

viewport.addEventListener('pointerdown', onPointerDown, { passive: true });
window.addEventListener('pointermove', onPointerMove, { passive: false });
window.addEventListener('pointerup', onPointerUp, { passive: false });
window.addEventListener('pointercancel', event => {
  if (state.drag?.source === 'pointer' && state.drag.id === event.pointerId) abortGesture(true);
}, { passive: true });
viewport.addEventListener('lostpointercapture', event => {
  if (state.drag?.source === 'pointer' && state.drag.id === event.pointerId) abortGesture(true);
});

viewport.addEventListener('touchstart', onTouchStart, { passive: true });
window.addEventListener('touchmove', onTouchMove, { passive: false });
window.addEventListener('touchend', onTouchEnd, { passive: false });
window.addEventListener('touchcancel', () => abortGesture(true), { passive: true });
window.addEventListener('blur', () => abortGesture(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) abortGesture(true);
});

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
