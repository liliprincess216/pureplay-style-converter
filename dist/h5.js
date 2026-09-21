// Keep the H5 scroll bridge separate from the converter's horizontal gestures.
const frame = document.querySelector('#generatorFrame');

function connectGenerator() {
  const doc = frame.contentDocument;
  const child = frame.contentWindow;
  if (!doc?.body || doc.documentElement.dataset.h5Connected) return;
  doc.documentElement.dataset.h5Connected = 'true';

  // The converter owns horizontal gestures; the outer H5 owns vertical gestures.
  const style = doc.createElement('style');
  style.textContent = 'html, body, .state-screen { touch-action: none; }';
  doc.head.appendChild(style);

  let gesture = null;
  let ignoreClickUntil = 0;
  function start(id, x, y) {
    gesture = { id, x, y, lastY: y, axis: null };
  }
  function move(id, x, y, event) {
    if (!gesture || gesture.id !== id) return;
    const dx = Math.abs(x - gesture.x);
    const dy = Math.abs(y - gesture.y);
    if (!gesture.axis && Math.max(dx, dy) >= 8) {
      if (dy > dx * 1.08) gesture.axis = 'y';
      else if (dx > dy * 1.08) gesture.axis = 'x';
    }
    if (gesture.axis === 'y') {
      if (event.cancelable) event.preventDefault();
      // Screen coordinates stay stable while the iframe moves with the page.
      window.scrollBy(0, gesture.lastY - y);
      ignoreClickUntil = performance.now() + 500;
    }
    gesture.lastY = y;
  }
  function finish(id) {
    if (gesture?.id !== id) return;
    if (gesture.axis === 'y') ignoreClickUntil = performance.now() + 500;
    gesture = null;
  }

  if ('PointerEvent' in child) {
    doc.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.pointerType === 'mouse') return;
      start(event.pointerId, event.screenX, event.screenY);
      try { event.target.setPointerCapture(event.pointerId); } catch {}
    }, { capture: true, passive: true });
    doc.addEventListener('pointermove', event => {
      move(event.pointerId, event.screenX, event.screenY, event);
    }, { capture: true, passive: false });
    doc.addEventListener('pointerup', event => finish(event.pointerId), true);
    doc.addEventListener('pointercancel', event => finish(event.pointerId), true);
  } else {
    doc.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) { gesture = null; return; }
      const touch = event.touches[0];
      start(touch.identifier, touch.screenX, touch.screenY);
    }, { capture: true, passive: true });
    doc.addEventListener('touchmove', event => {
      if (event.touches.length !== 1) { gesture = null; return; }
      const touch = event.touches[0];
      move(touch.identifier, touch.screenX, touch.screenY, event);
    }, { capture: true, passive: false });
    for (const type of ['touchend', 'touchcancel']) {
      doc.addEventListener(type, event => {
        for (const touch of event.changedTouches) finish(touch.identifier);
      }, { capture: true, passive: true });
    }
  }

  doc.addEventListener('click', event => {
    if (performance.now() >= ignoreClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  doc.addEventListener('wheel', event => {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    window.scrollBy(0, event.deltaY * unit);
  }, { passive: false });
  doc.addEventListener('keydown', event => {
    const steps = { ArrowUp: -40, ArrowDown: 40, PageUp: -innerHeight, PageDown: innerHeight };
    if (!(event.key in steps)) return;
    event.preventDefault();
    window.scrollBy(0, steps[event.key]);
  });
}

frame.addEventListener('load', connectGenerator);
if (frame.contentDocument?.readyState === 'complete') connectGenerator();
