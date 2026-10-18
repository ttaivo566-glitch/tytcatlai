function initScanner() {
  const api = { onResult: null };
  const $ = id => document.getElementById(id);
  const video = $('video'), work = $('work'), ctx = work.getContext('2d', { willReadFrequently: true });
  const cam = $('cam'), hint = $('hint'), toastEl = $('toast');
  const small = document.createElement('canvas'); small.width = small.height = 32;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const resEl = document.createElement('div'); resEl.className = 'res'; cam.appendChild(resEl);

  let stream = null, track = null, scanning = false, loopId = 0;
  let lastLum = 0, lum = 128, startedAt = 0, lastInvalid = 0, current = null, ac = null, si = 0;

  function setHint(msg, level) { hint.textContent = msg; hint.className = 'hint ' + (level || ''); cam.className = 'cam ' + (level || ''); }
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('show'), 1400); }
  function unlockAudio() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {} }
  document.addEventListener('touchend', unlockAudio, { once: true });

  /* ---------- Camera ---------- */
  async function startCamera() {
    unlockAudio();
    $('start').style.display = 'none';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext)
      return showStart('Cần mở bằng đường dẫn HTTPS (ví dụ GitHub Pages) để dùng camera.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return showStart(denied ? 'Chưa được cấp quyền camera. Vào Cài đặt › Chrome › Camera để cho phép, rồi bấm lại.'
                              : 'Không mở được camera: ' + (e && e.message || e));
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    setupCaps();
    video.onloadedmetadata = video.onresize = () => { resEl.textContent = video.videoWidth + '×' + video.videoHeight; };
    resEl.textContent = video.videoWidth + '×' + video.videoHeight;
    if (typeof jsQR !== 'function' && !window.ZXing) { setHint('Không tải được thư viện quét — kiểm tra mạng rồi tải lại trang', 'bad'); return; }
    resumeScan();
  }
  function showStart(msg) { $('startMsg').textContent = msg; $('start').style.display = 'flex'; setHint('Camera chưa sẵn sàng', 'bad'); }
  $('startBtn').onclick = startCamera;
  let torchOn = false;
  $('torch').onclick = async () => {
    try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('torch').classList.toggle('on', torchOn); }
    catch (e) { torchOn = false; }
  };

  /* ---------- Zoom & lấy nét ---------- */
  let zoomD = 1, zoomHW = null, manualZoom = false, lastZoomAt = 0, lastFocusAt = 0;
  const zb = document.createElement('div'); zb.className = 'zoom';
  zb.innerHTML = '<button data-z="1" class="on">1×</button><button data-z="2">2×</button><button data-z="3">3×</button>';
  cam.appendChild(zb);
  zb.querySelectorAll('button').forEach(b => b.onclick = e => { e.stopPropagation(); manualZoom = true; setZoom(+b.dataset.z); });

  function setupCaps() {
    try {
      const c = track.getCapabilities ? track.getCapabilities() : {};
      if (c.torch) $('torch').style.display = 'block';
      zoomHW = c.zoom && c.zoom.max > 1 ? { min: c.zoom.min || 1, max: c.zoom.max } : null;
    } catch (e) { zoomHW = null; }
    refocus();
  }
  function refocus() {
    lastFocusAt = performance.now();
    if (!track || !track.applyConstraints) return;
    try { track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch (e) {}
  }
  async function setZoom(z) {
    lastZoomAt = performance.now();
    zb.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.z === z));
    if (zoomHW) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: Math.min(zoomHW.max, Math.max(zoomHW.min, z)) }] });
        zoomD = 1; video.style.transform = ''; return;
      } catch (e) { zoomHW = null; }
    }
    zoomD = z; video.style.transform = z > 1 ? 'scale(' + z + ')' : '';
  }
  cam.addEventListener('click', refocus);

  /* ---------- Decoders ---------- */
  let zr = null, zh = null;
  function zxReady() {
    if (zr) return true;
    if (!window.ZXing) return false;
    try {
      zr = new ZXing.QRCodeReader();
      zh = new Map();
      zh.set(ZXing.DecodeHintType.TRY_HARDER, true);
      zh.set(ZXing.DecodeHintType.CHARACTER_SET, 'UTF-8');
    } catch (e) { zr = null; }
    return !!zr;
  }

  // Giãn tương phản (2%–98%) + chuyển xám + làm nét (unsharp): giúp QR nhỏ, mờ, thiếu sáng
  function enhance(d, w, h, sharp) {
    const n = w * h, hist = new Uint32Array(256); let g = new Uint8Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) { const v = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; g[j] = v; hist[v]++; }
    let lo = 0, hi = 255, a = 0; const t = n * .02;
    while (lo < 255 && (a += hist[lo]) < t) lo++;
    a = 0; while (hi > 0 && (a += hist[hi]) < t) hi--;
    const k = 255 / Math.max(1, hi - lo);
    for (let j = 0; j < n; j++) { const v = (g[j] - lo) * k; g[j] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (sharp) {
      const o = new Uint8Array(g);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, v = 5 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        o[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      g = o;
    }
    for (let i = 0, j = 0; j < n; i += 4, j++) d[i] = d[i + 1] = d[i + 2] = g[j];
  }

  // Các chiến lược quét xoay vòng. crop = tỉ lệ vùng giữa khung (so với cạnh ngắn),
  // up = phóng to ảnh trước khi giải mã (cho QR nhỏ), enh = tăng tương phản, sharp = làm nét
  const STRATS = [
    { e: 'js', crop: .45, maxW: 1000 },
    { e: 'zx', crop: .45, maxW: 1000 },
    { e: 'js', crop: .3,  up: 2, enh: 1, sharp: 1 },
    { e: 'js', crop: .7,  maxW: 1000 },
    { e: 'zx', crop: .3,  up: 2, enh: 1 },
    { e: 'js', crop: 0,   maxW: 1100 },
    { e: 'js', crop: .45, maxW: 1000, enh: 1, inv: 1 },
    { e: 'zx', crop: 0,   maxW: 1280, enh: 1 },
    { e: 'js', crop: 0,   maxW: 640 }
  ];

  function fixUtf8(s) {
    try {
      if (!/[\u00c0-\u00ff]/.test(s)) return s;
      const b = Uint8Array.from(s, c => c.charCodeAt(0));
      if (Array.from(s).some(c => c.charCodeAt(0) > 255)) return s;
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) { return s; }
  }

  function attempt(st) {
    const vw = video.videoWidth, vh = video.videoHeight, m = Math.min(vw, vh);
    const crop = st.crop ? Math.min(1, st.crop / zoomD) : (zoomD > 1 ? 1 / zoomD : 0);
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (crop) { sw = sh = Math.round(m * crop); sx = (vw - sw) / 2; sy = (vh - sh) / 2; }
    const scale = st.up ? Math.min(st.up, 1000 / sw) : Math.min(1, st.maxW / sw);
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);

    if (st.e === 'js') {
      if (typeof jsQR !== 'function') return null;
      const img = ctx.getImageData(0, 0, w, h);
      if (st.enh) enhance(img.data, w, h, st.sharp);
      const r = jsQR(img.data, w, h, { inversionAttempts: st.inv ? 'attemptBoth' : 'dontInvert' });
      if (!r) return null;
      let text = r.data;
      try { if (r.binaryData) text = new TextDecoder('utf-8').decode(Uint8Array.from(r.binaryData)); } catch (e) {}
      return { text };
    }
    if (!zxReady()) return null;
    if (st.enh) { const img = ctx.getImageData(0, 0, w, h); enhance(img.data, w, h, st.sharp); ctx.putImageData(img, 0, 0); }
    try {
      const src = new ZXing.HTMLCanvasElementLuminanceSource(work);
      const r = zr.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src)), zh);
      return r ? { text: r.getText() } : null;
    } catch (e) { return null; }
  }

  /* ---------- Vòng quét ---------- */
  function resumeScan() {
    current = null; scanning = true; startedAt = performance.now();
    manualZoom = false; setZoom(1); refocus();
    video.play().catch(() => {});
    setHint('Đưa mã QR trên CCCD vào khung', '');
    loop(++loopId);
  }

  async function loop(id) {
    while (scanning && id === loopId) {
      await new Promise(r => requestAnimationFrame(r));
      if (video.readyState < 2 || !video.videoWidth) continue;
      const t = performance.now();
      measureLight(t);
      let r = null;
      try { r = attempt(STRATS[si++ % STRATS.length]); } catch (e) {}
      if (!scanning || id !== loopId) return;
      if (r && r.text) handleQR(r.text, t); else idleHint(t);
    }
  }

  function measureLight(t) {
    if (t - lastLum < 300) return; lastLum = t;
    try {
      sctx.drawImage(video, 0, 0, 32, 32);
      const d = sctx.getImageData(0, 0, 32, 32).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
      lum = s / (d.length / 4);
    } catch (e) {}
  }

  function idleHint(t) {
    if (t - lastFocusAt > 2500) refocus();
    const s = (t - startedAt) / 1000;
    if (!manualZoom && s > 3 && t - lastZoomAt > 3000) setZoom(zoomHW ? (lastZ = lastZ % 3 + 1) : (lastZ = lastZ % 3 + 1));
    if (t - lastInvalid < 1500 && lastInvalid) return;
    if (lum < 55) return setHint('Quá tối — bật đèn hoặc di chuyển ra chỗ sáng hơn', 'bad');
    if (lum > 215) return setHint('Quá sáng/chói — nghiêng thẻ để tránh phản chiếu', 'warn');
    if (s > 3) return setHint('Giữ thẻ cách camera 15–20 cm cho nét, giữ yên. Đang tự phóng to (' + (zoomD > 1 ? zoomD : (zb.querySelector('.on') || {}).dataset.z) + '×)', 'warn');
    setHint('Đưa mã QR trên CCCD vào khung', '');
  }
  let lastZ = 1;

  function handleQR(text, t) {
    const d = parseCCCD(fixUtf8(String(text)));
    if (!d) { lastInvalid = t; setHint('Mã QR này không phải QR của CCCD', 'warn'); return; }
    success(d);
  }

  /* ---------- Phân tích dữ liệu ---------- */
  function parseCCCD(text) {
    const p = String(text).split('|').map(s => s.trim());
    if (p.length < 4 || !/^\d{9,12}$/.test(p[0])) return null;
    let dob = p[3];
    if (/^\d{8}$/.test(dob)) dob = dob.slice(0, 2) + '/' + dob.slice(2, 4) + '/' + dob.slice(4);
    return { id: p[0], name: p[2], dob };
  }

  function success(d) {
    scanning = false; loopId++; current = d;
    video.pause();
    set('v-id', d.id); set('v-name', d.name); set('v-dob', d.dob);
    setHint('Đã quét xong — kiểm tra rồi bấm Gửi', 'ok');
    api.onResult && api.onResult(d);
    beep();
  }
  function set(id, v) { const e = $(id); e.textContent = v || '—'; e.classList.toggle('empty', !v); }
  function beep() {
    try {
      unlockAudio();
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
    scanning = false; try { loopId++; } catch (e) {}
    document.removeEventListener('visibilitychange', onVis);
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }

  const onVis = () => {
    if (document.hidden) { scanning = false; loopId++; return; }
    if (!stream || current) return;
    if (track && track.readyState === 'ended') { stream = null; startCamera(); } else resumeScan();
  };
  document.addEventListener('visibilitychange', onVis);

  api.stop = stop; api.reset = redo;
  startCamera();
  return api;
}
