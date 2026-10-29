(() => {
  'use strict';

  // ---- Sozlamalar ----
  const POLL_MS = 2000; // oxirgi rasmni tekshirish oralig'i
  const POLL_HIDDEN_MS = 10000; // sahifa orqa fonda bo'lganda
  const MAX_BACKOFF_MS = 10000; // xatolikda qayta urinish oralig'ining yuqori chegarasi
  const DEVICES_EVERY_TICKS = 5; // qurilmalar ro'yxatini har 5-tekshiruvda yangilaymiz
  const REQUEST_TIMEOUT_MS = 10000; // Render uyg'onayotganda so'rov osilib qolmasligi uchun
  const STALE_AFTER_S = 20; // shuncha soniya yangi rasm kelmasa ogohlantiramiz
  const STORAGE_KEY = 'esp32cam.device';

  const $ = (id) => document.getElementById(id);
  const el = {
    select: $('device-select'),
    banner: $('banner'),
    main: $('main-image'),
    placeholder: $('placeholder'),
    zoom: $('zoom-btn'),
    download: $('download-link'),
    pill: $('status-pill'),
    received: $('info-received'),
    age: $('info-age'),
    size: $('info-size'),
    dims: $('info-dims'),
    uptime: $('info-uptime'),
    gallery: $('gallery'),
    galleryEmpty: $('gallery-empty'),
    limitCount: $('limit-count'),
    limitMb: $('limit-mb'),
    lightbox: $('lightbox'),
    lbImage: $('lb-image'),
    lbCaption: $('lb-caption'),
    lbPosition: $('lb-position'),
    lbPrev: $('lb-prev'),
    lbNext: $('lb-next'),
    lbDownload: $('lb-download'),
    lbClose: $('lb-close'),
  };

  const state = {
    devices: [],
    selected: null, // tanlangan device_id
    latest: null, // { image, serverTimeMs, receivedAtMs, perfAt }
    shownImageId: null, // asosiy ramkada ko'rsatilayotgan rasm
    loadingImageId: null, // oldindan yuklanayotgan rasm
    gallery: [],
    galleryForImageId: null,
    serverError: null, // { kind, status } yoki null
    loadedOnce: false,
    needDevices: false,
    tick: 0,
    failures: 0,
    pollAgain: false,
    selectKey: '',
    lightboxId: null,
  };

  class ApiError extends Error {
    constructor(kind, status, message) {
      super(message);
      this.kind = kind; // 'network' | 'server' | 'client'
      this.status = status;
    }
  }

  // ---- Yordamchi funksiyalar ----
  const pad = (n) => String(n).padStart(2, '0');

  function formatLocal(date) {
    return (
      `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatTime(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} bayt`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d} kun ${h} soat`;
    if (h > 0) return `${h} soat ${m} daqiqa`;
    if (m > 0) return `${m} daqiqa ${s} soniya`;
    return `${s} soniya`;
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* saqlash ishlamasa ham sahifa ishlayveradi */
    }
  }

  /** Rasm yoshi (ms). Server vaqti bo'yicha hisoblanadi, shuning uchun telefon soati noto'g'ri bo'lsa ham to'g'ri chiqadi. */
  function currentAgeMs() {
    const l = state.latest;
    if (!l || Number.isNaN(l.serverTimeMs) || Number.isNaN(l.receivedAtMs)) return null;
    return Math.max(0, l.serverTimeMs - l.receivedAtMs + (performance.now() - l.perfAt));
  }

  // ---- Tarmoq ----
  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        data = null; // masalan, Render uyg'onayotganda HTML sahifa qaytishi mumkin
      }
      return { status: res.status, ok: res.ok, data };
    } catch (err) {
      throw new ApiError('network', 0, err && err.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  function serverFailure(r) {
    return new ApiError(r.status >= 500 || r.status === 0 ? 'server' : 'client', r.status, 'bad response');
  }

  async function refreshDevices() {
    const r = await getJson('/api/devices');
    if (!r.ok || !r.data || !Array.isArray(r.data.devices)) throw serverFailure(r);
    state.devices = r.data.devices;
    state.loadedOnce = true;
    if (r.data.limits) {
      el.limitCount.textContent = String(r.data.limits.max_images_per_device);
      el.limitMb.textContent = String(Math.round(r.data.limits.max_total_bytes / (1024 * 1024)));
    }
    chooseDevice();
    renderDeviceSelect();
  }

  async function refreshLatest() {
    const device = state.selected;
    const r = await getJson(`/api/latest?device_id=${encodeURIComponent(device)}`);
    if (device !== state.selected) return; // kutish paytida foydalanuvchi boshqa qurilmani tanladi

    if (r.status === 404) {
      // Hali rasm yo'q yoki server qayta ishga tushib, qurilma yo'qolgan.
      state.latest = null;
      state.needDevices = true;
      if (state.shownImageId) clearImage();
      if (state.gallery.length > 0) {
        state.gallery = [];
        state.galleryForImageId = null;
        renderGallery();
      }
      return;
    }
    if (!r.ok || !r.data || !r.data.image) throw serverFailure(r);

    const image = r.data.image;
    state.latest = {
      image,
      serverTimeMs: Date.parse(r.data.server_time),
      receivedAtMs: Date.parse(image.received_at),
      perfAt: performance.now(),
    };

    // Faqat image_id o'zgargandagina rasm yangilanadi.
    if (image.image_id !== state.shownImageId && image.image_id !== state.loadingImageId) {
      showImage(image);
    }
    if (image.image_id !== state.galleryForImageId) {
      await refreshGallery(device, image.image_id);
    }
  }

  async function refreshGallery(device, forImageId) {
    const r = await getJson(`/api/images?device_id=${encodeURIComponent(device)}`);
    if (device !== state.selected) return;
    if (!r.ok || !r.data || !Array.isArray(r.data.images)) return; // keyingi tekshiruvda qayta uriniladi
    state.gallery = r.data.images;
    state.galleryForImageId = forImageId;
    renderGallery();
  }

  // ---- Qurilma tanlash ----
  function chooseDevice() {
    const ids = state.devices.map((d) => d.device_id);
    if (state.selected && ids.includes(state.selected)) return;

    let next = null;
    const saved = safeStorageGet(STORAGE_KEY);
    if (saved && ids.includes(saved)) {
      next = saved;
    } else if (state.devices.length > 0) {
      const recent = state.devices.reduce((best, d) =>
        Date.parse(d.last_received_at) > Date.parse(best.last_received_at) ? d : best
      );
      next = recent.device_id;
    }
    if (next !== state.selected) selectDevice(next, false);
  }

  function selectDevice(deviceId, remember) {
    state.selected = deviceId;
    state.latest = null;
    state.gallery = [];
    state.galleryForImageId = null;
    state.loadingImageId = null;
    clearImage();
    renderGallery();
    if (remember && deviceId) safeStorageSet(STORAGE_KEY, deviceId);
  }

  // ---- Asosiy rasm ----
  function showImage(image) {
    state.loadingImageId = image.image_id;
    const probe = new Image();
    probe.decoding = 'async';
    probe.onload = () => {
      if (state.loadingImageId !== image.image_id) return; // eskirgan so'rov
      state.loadingImageId = null;
      state.shownImageId = image.image_id;
      el.main.src = image.image_url;
      el.main.hidden = false;
      el.placeholder.hidden = true;
      el.zoom.disabled = false;
      el.download.href = `${image.image_url}?download=1`;
      el.download.setAttribute('download', '');
      el.download.classList.remove('is-disabled');
      el.download.removeAttribute('aria-disabled');
    };
    probe.onerror = () => {
      // Keyingi tekshiruvda qayta uriniladi.
      if (state.loadingImageId === image.image_id) state.loadingImageId = null;
    };
    probe.src = image.image_url;
  }

  function clearImage() {
    state.shownImageId = null;
    el.main.hidden = true;
    el.main.removeAttribute('src');
    el.placeholder.hidden = false;
    el.zoom.disabled = true;
    el.download.removeAttribute('href');
    el.download.removeAttribute('download');
    el.download.classList.add('is-disabled');
    el.download.setAttribute('aria-disabled', 'true');
  }

  // ---- Chizish ----
  function renderDeviceSelect() {
    const ids = state.devices.map((d) => d.device_id);
    const key = `${ids.join('|')}#${state.selected}`;
    if (key === state.selectKey) return;
    state.selectKey = key;

    el.select.replaceChildren();
    if (ids.length === 0) {
      const option = document.createElement('option');
      option.textContent = 'Qurilma hali yo\'q';
      el.select.append(option);
      el.select.disabled = true;
      return;
    }
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      el.select.append(option);
    }
    el.select.value = state.selected;
    el.select.disabled = false;
  }

  function setPill(kind, text) {
    el.pill.className = `pill pill-${kind}`;
    el.pill.textContent = text;
  }

  let bannerKey = '';
  function setBanner(kind, title, detail) {
    const key = `${kind}|${title}|${detail}`;
    if (key === bannerKey) return; // aria-live qayta o'qib chiqmasligi uchun
    bannerKey = key;
    if (!kind) {
      el.banner.hidden = true;
      el.banner.replaceChildren();
      return;
    }
    el.banner.className = `banner banner-${kind}`;
    const small = document.createElement('small');
    small.textContent = detail;
    el.banner.replaceChildren(document.createTextNode(title), small);
    el.banner.hidden = false;
  }

  function describeServerError(error) {
    if (error.kind === 'server') {
      return {
        title: error.status > 0 ? `Server xatosi (HTTP ${error.status})` : 'Server xatosi',
        detail:
          "Bepul Render serveri uyg'onayotgan bo'lishi mumkin (taxminan bir daqiqagacha). Sahifa o'zi qayta urinadi.",
      };
    }
    if (error.kind === 'client') {
      return {
        title: `Server kutilmagan javob qaytardi (HTTP ${error.status})`,
        detail: "Sahifani yangilab ko'ring. Sahifa o'zi ham qayta urinadi.",
      };
    }
    return {
      title: "Serverga ulanib bo'lmadi",
      detail:
        "Internet aloqasini tekshiring. Server uyg'onayotgan bo'lsa, bir daqiqacha kuting — sahifa o'zi qayta urinadi.",
    };
  }

  /** Har soniyada ham, har tekshiruvdan keyin ham chaqiriladi (tarmoqsiz). */
  function render() {
    const latest = state.latest;
    const ageMs = currentAgeMs();
    const stale = ageMs !== null && ageMs > STALE_AFTER_S * 1000;

    if (latest) {
      const image = latest.image;
      el.received.textContent = Number.isNaN(latest.receivedAtMs) ? '—' : formatLocal(new Date(latest.receivedAtMs));
      el.received.title = `${image.received_at} (UTC)`;
      el.size.textContent = formatBytes(image.bytes);
      el.dims.textContent = image.width && image.height ? `${image.width}×${image.height}` : '—';
      el.uptime.textContent = Number.isFinite(image.uptime_ms) ? formatDuration(image.uptime_ms) : '—';
      el.age.textContent = ageMs === null ? '—' : `${formatDuration(ageMs)} oldin`;
    } else {
      el.received.textContent = '—';
      el.received.removeAttribute('title');
      el.size.textContent = '—';
      el.dims.textContent = '—';
      el.uptime.textContent = '—';
      el.age.textContent = '—';
    }

    if (state.serverError) {
      const { title, detail } = describeServerError(state.serverError);
      setBanner('error', title, detail);
      setPill('error', "Server bilan aloqa yo'q");
    } else if (stale) {
      setBanner(
        'warn',
        'Qurilmadan yangi rasm kelmayapti',
        "Qurilma o'chgan, Wi-Fi uzilgan yoki server qayta ishga tushgan bo'lishi mumkin."
      );
      setPill('warn', 'Rasm kelmayapti');
    } else if (latest) {
      setBanner(null, '', '');
      setPill('ok', 'Onlayn');
    } else {
      setBanner(null, '', '');
      setPill('idle', state.loadedOnce ? 'Rasm kutilmoqda' : 'Yuklanmoqda…');
    }

    if (!state.shownImageId) {
      if (state.serverError && !state.loadedOnce) {
        el.placeholder.textContent = "Serverga ulanib bo'lmadi.";
      } else if (!state.loadedOnce) {
        el.placeholder.textContent = 'Yuklanmoqda…';
      } else {
        el.placeholder.textContent =
          "Hali rasm kelmagan. Qurilma birinchi rasmni yuborgach, u shu yerda ko'rinadi.";
      }
    }
  }

  function buildThumb(image) {
    const li = document.createElement('li');
    li.dataset.id = image.image_id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    const when = new Date(image.received_at);
    button.setAttribute('aria-label', `Rasmni kattalashtirish: ${formatLocal(when)}`);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = image.image_url;

    const meta = document.createElement('span');
    meta.className = 'thumb-meta';
    meta.textContent = `${formatTime(when)} · ${formatBytes(image.bytes)}`;

    button.append(img, meta);
    li.append(button);
    return li;
  }

  function renderGallery() {
    const existing = new Map();
    for (const li of Array.from(el.gallery.children)) existing.set(li.dataset.id, li);

    const items = state.gallery.map((image, index) => {
      let li = existing.get(image.image_id);
      if (li) {
        existing.delete(image.image_id);
      } else {
        li = buildThumb(image);
      }
      li.classList.toggle('is-latest', index === 0);
      return li;
    });
    el.gallery.replaceChildren(...items); // mavjud <img> lar qayta yuklanmaydi
    el.galleryEmpty.hidden = state.gallery.length > 0;
    refreshLightboxNav();
  }

  // ---- Kattalashtirish oynasi ----
  function openLightbox(imageId) {
    if (!el.lightbox.open) el.lightbox.showModal(); // avval ochiladi, so'ng navigatsiya yangilanadi
    showInLightbox(imageId);
  }

  function findImageMeta(imageId) {
    const fromGallery = state.gallery.find((i) => i.image_id === imageId);
    if (fromGallery) return fromGallery;
    if (state.latest && state.latest.image.image_id === imageId) return state.latest.image;
    return null;
  }

  function showInLightbox(imageId) {
    state.lightboxId = imageId;
    const meta = findImageMeta(imageId);
    el.lbImage.classList.remove('is-zoomed');
    el.lbImage.src = `/images/${imageId}`;
    el.lbCaption.textContent = meta
      ? `${formatLocal(new Date(meta.received_at))} · ${formatBytes(meta.bytes)}${
          meta.width && meta.height ? ` · ${meta.width}×${meta.height}` : ''
        }`
      : '';
    el.lbDownload.href = `/images/${imageId}?download=1`;
    el.lbDownload.setAttribute('download', '');
    refreshLightboxNav();
  }

  function refreshLightboxNav() {
    if (!el.lightbox.open || !state.lightboxId) return;
    const index = state.gallery.findIndex((i) => i.image_id === state.lightboxId);
    el.lbPosition.textContent = index >= 0 ? `${index + 1}/${state.gallery.length}` : '';
    el.lbPrev.disabled = index <= 0;
    el.lbNext.disabled = index < 0 || index >= state.gallery.length - 1;
  }

  function stepLightbox(delta) {
    const index = state.gallery.findIndex((i) => i.image_id === state.lightboxId);
    if (index < 0) return;
    const target = state.gallery[index + delta];
    if (target) showInLightbox(target.image_id);
  }

  // ---- Hodisalar ----
  el.select.addEventListener('change', () => {
    selectDevice(el.select.value, true);
    renderDeviceSelect();
    render();
    state.pollAgain = true;
    wake();
  });

  el.zoom.addEventListener('click', () => {
    if (state.shownImageId) openLightbox(state.shownImageId);
  });

  el.gallery.addEventListener('click', (event) => {
    const li = event.target.closest('li[data-id]');
    if (li) openLightbox(li.dataset.id);
  });

  el.lbPrev.addEventListener('click', () => stepLightbox(-1)); // yangiroq
  el.lbNext.addEventListener('click', () => stepLightbox(1)); // eskiroq
  el.lbClose.addEventListener('click', () => el.lightbox.close());
  el.lbImage.addEventListener('click', () => el.lbImage.classList.toggle('is-zoomed'));
  el.lbImage.addEventListener('error', () => {
    el.lbCaption.textContent = "Bu rasm serverdan o'chirilgan (eski rasmlar RAMdan siqib chiqariladi).";
  });
  el.lightbox.addEventListener('click', (event) => {
    if (event.target === el.lightbox) el.lightbox.close(); // orqa fonga bosilsa yopiladi
  });
  el.lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') stepLightbox(-1);
    if (event.key === 'ArrowRight') stepLightbox(1);
  });
  el.lightbox.addEventListener('close', () => {
    state.lightboxId = null;
    el.lbImage.removeAttribute('src');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.pollAgain = true;
      wake();
    }
  });

  // ---- So'rovlar sikli: har doim bitta so'rov, bir-birining ustiga tushmaydi ----
  let wakeResolver = null;

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakeResolver = null;
        resolve();
      }
      wakeResolver = done;
    });
  }

  function wake() {
    if (wakeResolver) wakeResolver();
  }

  async function tick() {
    state.tick += 1;
    try {
      if (!state.selected || state.needDevices || state.tick % DEVICES_EVERY_TICKS === 1) {
        state.needDevices = false;
        await refreshDevices();
      }
      if (state.selected) await refreshLatest();
      state.failures = 0;
      state.serverError = null;
    } catch (err) {
      state.failures += 1;
      state.serverError =
        err instanceof ApiError ? { kind: err.kind, status: err.status } : { kind: 'client', status: 0 };
      if (!(err instanceof ApiError)) console.error(err);
    }
    render();
  }

  async function loop() {
    for (;;) {
      state.pollAgain = false;
      const startedAt = performance.now();
      await tick();
      if (state.pollAgain) continue;

      let delay;
      if (state.failures > 0) {
        delay = Math.min(MAX_BACKOFF_MS, POLL_MS * state.failures);
      } else {
        const base = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
        delay = Math.max(250, base - (performance.now() - startedAt));
      }
      await sleep(delay);
    }
  }

  // Rasm yoshi va "yangi rasm kelmayapti" holati tarmoqsiz, har soniyada yangilanadi.
  setInterval(render, 1000);

  clearImage();
  renderGallery();
  render();
  loop();
})();
