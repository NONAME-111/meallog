/* barcode.js - カメラでのバーコード読取と、商品情報のWeb検索
   読取: BarcodeDetector(対応端末) -> ZXing(iOS Safari等) の順にフォールバック
   商品情報: Open Food Facts (無料・CORS対応) */
(function (global) {
  'use strict';

  var el = {};
  var stream = null, rafId = 0, zxTimer = 0, zxReader = null, detector = null;
  var current = null;   // {resolve, done}

  function $(id) { return document.getElementById(id); }

  function init() {
    if (el.root) return;
    el.root = $('scanner');
    el.video = $('scanVideo');
    el.msg = $('scanMsg');
    el.close = $('scanClose');
    el.photo = $('scanPhoto');
    el.file = $('scanFile');

    el.close.addEventListener('click', function () { finish(null); });
    el.photo.addEventListener('click', function () { el.file.click(); });
    el.file.addEventListener('change', function () {
      var f = el.file.files && el.file.files[0];
      el.file.value = '';
      if (!f) return;
      setMsg('画像を解析中…');
      decodeImageFile(f).then(function (code) {
        if (code) finish(code);
        else setMsg('読み取れませんでした。もう一度お試しください');
      }).catch(function () { setMsg('読み取れませんでした'); });
    });
  }

  function setMsg(t) { if (el.msg) el.msg.textContent = t; }

  /* 読取ライブラリ(336KB)は初回スキャン時にだけ読み込む */
  var zxingP = null;
  function loadZXing() {
    if (global.ZXing) return Promise.resolve(true);
    if (zxingP) return zxingP;
    zxingP = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'vendor/zxing.min.js';
      s.async = true;
      s.onload = function () { resolve(!!global.ZXing); };
      s.onerror = function () { zxingP = null; resolve(false); };
      document.head.appendChild(s);
    });
    return zxingP;
  }

  /* ---- 起動 ---- */
  function scan() {
    init();
    return new Promise(function (resolve) {
      current = { resolve: resolve, done: false };
      el.root.hidden = false;
      setMsg('カメラを起動中…');
      startCamera().then(function () {
        setMsg('バーコードを枠内に');
        startLoop();
      }).catch(function (err) {
        setMsg('カメラを使えません（' + shortErr(err) + '）。「写真で読取」をお試しください');
      });
    });
  }

  function shortErr(err) {
    var n = (err && err.name) || '';
    if (n === 'NotAllowedError') return 'カメラの許可が必要です';
    if (n === 'NotFoundError') return 'カメラが見つかりません';
    if (!global.isSecureContext) return 'HTTPSでないため使えません';
    return n || 'エラー';
  }

  // 使い終わってもすぐには止めず、この時間だけ保持する(そのあいだは再許可を聞かれない)
  var KEEP_MS = 5 * 60 * 1000;
  var releaseTimer = 0;

  function live() {
    return !!(stream && stream.getVideoTracks().some(function (t) {
      return t.readyState === 'live';
    }));
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('unsupported'));
    }
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }

    // 前回のストリームが生きていれば、それを使い回す(許可ダイアログを出さないため)
    if (live()) {
      stream.getTracks().forEach(function (t) { t.enabled = true; });
      el.video.srcObject = stream;
      el.video.setAttribute('playsinline', '');
      return el.video.play();
    }

    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (s) {
      stream = s;
      el.video.srcObject = s;
      el.video.setAttribute('playsinline', '');
      return el.video.play();
    });
  }

  // 本当にカメラを手放す(次に開くときは許可を聞かれる)
  function releaseCamera() {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { void e; } });
      stream = null;
    }
    if (el.video) el.video.srcObject = null;
  }

  function stopCamera() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (zxTimer) { clearTimeout(zxTimer); zxTimer = 0; }
    zxReader = null;
    if (el.video) {
      try { el.video.pause(); } catch (e) { void e; }
      el.video.srcObject = null;
    }
    if (!stream) return;
    // 映像は止めるが、トラックは生かしたままにして許可を保持する
    stream.getTracks().forEach(function (t) { t.enabled = false; });
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseCamera, KEEP_MS);
  }

  // アプリを離れているあいだカメラを掴んだままにしない
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') releaseCamera();
  });

  function finish(code) {
    if (!current || current.done) return;
    current.done = true;
    stopCamera();
    if (el.root) el.root.hidden = true;
    var r = current.resolve;
    current = null;
    r(code || null);
  }

  /* ---- 検出ループ ---- */
  var FORMATS_BD = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf', 'code_39'];

  function startLoop() {
    if (global.BarcodeDetector) {
      try {
        detector = new global.BarcodeDetector({ formats: FORMATS_BD });
        loopNative();
        return;
      } catch (e) { detector = null; }
    }
    // iOS Safari には BarcodeDetector が無いのでZXingを使う
    setMsg('読取ライブラリを準備中…');
    loadZXing().then(function (ok) {
      if (!current || current.done) return;
      if (!ok) { setMsg('読取ライブラリを読み込めませんでした'); return; }
      setMsg('バーコードを枠内に');
      loopZXing();
    });
  }

  function loopNative() {
    var tick = function () {
      if (!current || current.done) return;
      detector.detect(el.video).then(function (list) {
        if (list && list.length) {
          var v = String(list[0].rawValue || '').trim();
          if (v) { vibrate(); finish(v); return; }
        }
        rafId = requestAnimationFrame(tick);
      }).catch(function () {
        rafId = requestAnimationFrame(tick);
      });
    };
    rafId = requestAnimationFrame(tick);
  }

  /* このZXingビルドの BrowserMultiFormatReader には decodeFromCanvas 等が無いため、
     MultiFormatReader を直接使って1フレームずつ読む。 */
  function makeReader() {
    var Z = global.ZXing;
    var hints = new Map();
    var F = Z.BarcodeFormat;
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF, F.CODE_39
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var mfr = new Z.MultiFormatReader();
    mfr.setHints(hints);
    return mfr;
  }

  function decodeCanvas(cv, reader) {
    try {
      var Z = global.ZXing;
      var lum = new Z.HTMLCanvasElementLuminanceSource(cv);
      var bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(lum));
      var res = reader.decode(bmp);
      return res ? String(res.getText() || '').trim() : null;
    } catch (e) {
      return null;
    } finally {
      try { reader.reset(); } catch (e2) { void e2; }
    }
  }

  function loopZXing() {
    if (!global.ZXing) { setMsg('読取ライブラリを読み込めませんでした'); return; }
    zxReader = makeReader();
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d', { willReadFrequently: true });

    var tick = function () {
      if (!current || current.done) return;
      var v = el.video;
      if (v && v.videoWidth) {
        var scale = Math.min(1, 1280 / v.videoWidth);
        cv.width = Math.round(v.videoWidth * scale);
        cv.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        var code = decodeCanvas(cv, zxReader);
        if (code) { vibrate(); finish(code); return; }
      }
      zxTimer = setTimeout(tick, 180);
    };
    tick();
  }

  function vibrate() {
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { void e; }
  }

  /* ---- 静止画から読取 ---- */
  function decodeImageFile(file) {
    var url = URL.createObjectURL(file);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = url;
    }).then(function (img) {
      if (global.BarcodeDetector) {
        try {
          var bd = new global.BarcodeDetector({ formats: FORMATS_BD });
          return bd.detect(img).then(function (list) {
            return (list && list.length) ? String(list[0].rawValue) : loadZXing().then(function () { return decodeImageZXing(img); });
          }).catch(function () { return loadZXing().then(function () { return decodeImageZXing(img); }); });
        } catch (e) { return loadZXing().then(function () { return decodeImageZXing(img); }); }
      }
      return loadZXing().then(function () { return decodeImageZXing(img); });
    }).then(function (code) {
      URL.revokeObjectURL(url);
      return code;
    }, function (e) {
      URL.revokeObjectURL(url);
      throw e;
    });
  }

  function decodeImageZXing(img) {
    if (!global.ZXing) return null;
    var reader = makeReader();
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    // 撮影画像は大きいことがあるので、いくつかの縮尺で試す
    var sizes = [1600, 1000, 2400];
    for (var i = 0; i < sizes.length; i++) {
      var sc = Math.min(1, sizes[i] / Math.max(img.naturalWidth, img.naturalHeight));
      cv.width = Math.round(img.naturalWidth * sc);
      cv.height = Math.round(img.naturalHeight * sc);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      var code = decodeCanvas(cv, reader);
      if (code) return code;
    }
    return null;
  }

  /* ---- 商品情報のWeb検索(Open Food Facts) ---- */
  var OFF_FIELDS = 'code,product_name,product_name_ja,generic_name_ja,brands,quantity,serving_size,nutriments,image_front_small_url';

  function lookup(code) {
    var url = 'https://world.openfoodfacts.org/api/v2/product/' +
      encodeURIComponent(code) + '.json?fields=' + OFF_FIELDS;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || j.status !== 1 || !j.product) return null;
        return normalizeOff(j.product, code);
      })
      .catch(function () { return null; });
  }

  /* ---- 商品名でのWeb検索(Open Food Facts) ---- */
  function searchByName(query, opts) {
    opts = opts || {};
    var q = String(query || '').trim();
    if (!q) return Promise.resolve([]);
    var url = 'https://world.openfoodfacts.org/cgi/search.pl' +
      '?search_terms=' + encodeURIComponent(q) +
      '&search_simple=1&action=process&json=1&page_size=' + (opts.limit || 24) +
      '&fields=' + OFF_FIELDS;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = (j && j.products) || [];
        return list.map(function (p) { return normalizeOff(p, p.code || ''); })
          .filter(function (p) { return p.name || p.hasNutrition; })
          .sort(function (a, b) {
            // 栄養値があるものと、日本語名のものを上に
            var sa = (a.hasNutrition ? 2 : 0) + (hasJa(a.name) ? 1 : 0);
            var sb = (b.hasNutrition ? 2 : 0) + (hasJa(b.name) ? 1 : 0);
            return sb - sa;
          });
      })
      .catch(function () { return []; });
  }

  function hasJa(s) {
    return /[ぁ-んァ-ヶ一-龠]/.test(String(s || ''));
  }

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function normalizeOff(p, code) {
    var nu = p.nutriments || {};
    var kcal = num(nu['energy-kcal_100g']);
    if (kcal == null && num(nu['energy_100g']) != null) {
      kcal = Math.round(num(nu['energy_100g']) / 4.184);
    }
    var salt = num(nu['salt_100g']);
    if (salt == null && num(nu['sodium_100g']) != null) {
      salt = Math.round(num(nu['sodium_100g']) * 2.54 * 100) / 100;
    }
    var per100 = {
      kcal: kcal,
      protein: num(nu['proteins_100g']),
      fat: num(nu['fat_100g']),
      satfat: num(nu['saturated-fat_100g']),
      carb: num(nu['carbohydrates_100g']),
      fiber: num(nu['fiber_100g']),
      salt: salt
    };
    var has = Object.keys(per100).some(function (k) { return per100[k] != null; });
    var name = p.product_name_ja || p.generic_name_ja || p.product_name || '';
    return {
      code: code,
      name: String(name).trim(),
      brand: String(p.brands || '').split(',')[0].trim(),
      quantity: p.quantity || '',
      servingSize: p.serving_size || '',
      per100: per100,
      hasNutrition: has,
      image: p.image_front_small_url || '',
      source: 'Open Food Facts'
    };
  }

  global.Barcode = {
    scan: scan, lookup: lookup, searchByName: searchByName,
    cancel: function () { finish(null); }
  };
})(window);
