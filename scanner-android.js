function initScanner() {
  const api = { onResult: null };
  const $ = id => document.getElementById(id);
  const video = $('video'), work = $('work'), ctx = work.getContext('2d', { willReadFrequently: true });
  const cam = $('cam'), hint = $('hint'), toastEl = $('toast');
  const small = document.createElement('canvas'); small.width = small.height = 32;
  const sctx = small.getContext('2d', { willReadFrequently: true });

  let stream = null, track = null, detector = null, scanning = false, busy = false;
  let lastScan = 0, lastLum = 0, lum = 128, lastSeenQR = 0, lastInvalid = 0, startedAt = 0, current = null;

  try { if ('BarcodeDetector' in window) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }

  function setHint(msg, level) {
    hint.textContent = msg; hint.className = 'hint ' + (level || '');
    cam.className = 'cam ' + (level || '');
  }
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  /* ---------- Camera ---------- */
  async function startCamera() {
    $('start').style.display = 'none';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      return showStart('Cần mở bằng đường dẫn HTTPS (ví dụ GitHub Pages) để dùng camera.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return showStart(denied ? 'Chưa được cấp quyền camera. Cho phép camera cho trang này trong cài đặt Chrome rồi bấm lại.'
                              : 'Không mở được camera: ' + (e && e.message || e));
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous'))
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      if (caps.torch) $('torch').style.display = 'block';
    } catch (e) {}
    startedAt = performance.now();
    resumeScan();
  }
  function showStart(msg) {
    $('startMsg').textContent = msg; $('start').style.display = 'flex';
    setHint('Camera chưa sẵn sàng', 'bad');
  }
  $('startBtn').onclick = startCamera;

  let torchOn = false;
  $('torch').onclick = async () => {
    try {
      torchOn = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      $('torch').classList.toggle('on', torchOn);
    } catch (e) { torchOn = false; }
  };

  /* ---------- Scan loop ---------- */
  function resumeScan() {
    current = null; scanning = true; lastSeenQR = 0; startedAt = performance.now();
    video.play().catch(() => {});
    setHint('Đưa mã QR trên CCCD vào khung', '');
    requestAnimationFrame(tick);
  }

  function measureLight(t) {
    if (t - lastLum < 300) return;
    lastLum = t;
    try {
      sctx.drawImage(video, 0, 0, 32, 32);
      const d = sctx.getImageData(0, 0, 32, 32).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
      lum = s / (d.length / 4);
    } catch (e) {}
  }

  async function detect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    if (detector) {
      try {
        const r = await detector.detect(video);
        if (r && r.length) {
          const p = r[0].cornerPoints || [];
          let w = 0;
          if (p.length === 4) w = Math.max(Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y));
          return { text: r[0].rawValue, ratio: w / Math.min(vw, vh) };
        }
        return null;
      } catch (e) { detector = null; }
    }
    if (typeof jsQR !== 'function') return null;
    const w = Math.min(vw, 960), h = Math.round(vh * w / vw);
    if (work.width !== w) { work.width = w; work.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (!r) return null;
    const L = r.location;
    const qw = Math.max(Math.hypot(L.topRightCorner.x - L.topLeftCorner.x, L.topRightCorner.y - L.topLeftCorner.y),
                        Math.hypot(L.bottomRightCorner.x - L.topRightCorner.x, L.bottomRightCorner.y - L.topRightCorner.y));
    let text = r.data;
    try { if (r.binaryData) text = new TextDecoder('utf-8').decode(Uint8Array.from(r.binaryData)); } catch (e) {}
    return { text, ratio: qw / Math.min(w, h) };
  }

  async function tick(t) {
    if (!scanning) return;
    requestAnimationFrame(tick);
    if (busy || video.readyState < 2) return;
    if (t - lastScan < (detector ? 50 : 80)) return;
    lastScan = t; busy = true;
    try {
      measureLight(t);
      const r = await detect();
      if (!scanning) return;
      if (r && r.text) handleQR(r, t); else idleHint(t);
    } catch (e) {} finally { busy = false; }
  }

  function idleHint(t) {
    if (t - lastSeenQR < 700 && lastSeenQR) return;
    if (lum < 55) return setHint('Quá tối — bật đèn hoặc di chuyển ra chỗ sáng hơn', 'bad');
    if (lum > 215) return setHint('Quá sáng/chói — nghiêng thẻ để tránh phản chiếu', 'warn');
    if (t - startedAt > 3000) return setHint('Chưa thấy mã QR — giữ thẻ cách camera khoảng 10–20 cm, giữ chắc tay', 'warn');
    setHint('Đưa mã QR trên CCCD vào khung', '');
  }

  function handleQR(r, t) {
    const data = parseCCCD(r.text);
    if (!data) {
      lastSeenQR = t;
      if (t - lastInvalid > 1500) { lastInvalid = t; setHint('Mã QR này không phải QR của CCCD', 'warn'); }
      return;
    }
    if (r.ratio && r.ratio < 0.12) { lastSeenQR = t; return setHint('Đưa thẻ lại gần hơn', 'warn'); }
    if (r.ratio > 0.85) { lastSeenQR = t; return setHint('Đưa thẻ ra xa hơn một chút', 'warn'); }
    success(data);
  }

  /* ---------- Parse ---------- */
  function parseCCCD(text) {
    const p = String(text).split('|').map(s => s.trim());
    if (p.length < 4 || !/^\d{9,12}$/.test(p[0])) return null;
    let dob = p[3];
    if (/^\d{8}$/.test(dob)) dob = dob.slice(0, 2) + '/' + dob.slice(2, 4) + '/' + dob.slice(4);
    return { id: p[0], name: p[2], dob };
  }

  function success(d) {
    scanning = false; current = d;
    video.pause();
    set('v-id', d.id); set('v-name', d.name); set('v-dob', d.dob);
    setHint('Đã quét xong — kiểm tra rồi bấm Gửi', 'ok');
    api.onResult && api.onResult(d);
    try { navigator.vibrate && navigator.vibrate(80); } catch (e) {}
    beep();
  }
  function set(id, v) { const e = $(id); e.textContent = v || '—'; e.classList.toggle('empty', !v); }

  let ac;
  function beep() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 1100; g.gain.value = .08; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + .09);
    } catch (e) {}
  }

  function redo() {
    set('v-id', ''); set('v-name', ''); set('v-dob', '');
    if (stream && track && track.readyState === 'live') resumeScan(); else startCamera();
  }
  function stop() {
    scanning = false; 
    document.removeEventListener('visibilitychange', onVis);
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }

  const onVis = () => {
    if (document.hidden) { scanning = false; }
    else if (stream && !current) { resumeScan(); }
  };
  document.addEventListener('visibilitychange', onVis);

  api.stop = stop; api.reset = redo;
  startCamera();
  return api;
}
