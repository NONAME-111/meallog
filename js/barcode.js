/* barcode.js - カメラでのバーコード読取と、商品情報のWeb検索
   読取: BarcodeDetector(対応端末) -> ZXing(iOS Safari等) の順にフォールバック
   商品情報: Open Food Facts (無料・CORS対応) */
(function (global) {
  'use strict';

  var el = {};
  var stream = null, zx = null, rafId = 0, detector = null;
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

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('unsupported'));
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

  function stopCamera() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (zx) { try { zx.reset(); } catch (e) { void e; } zx = null; }
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { void e; } });
      stream = null;
    }
    if (el.video) el.video.srcObject = null;
  }

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
    loopZXing();
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

  function loopZXing() {
    if (!global.ZXing) { setMsg('読取ライブラリを読み込めませんでした'); return; }
    var hints = new Map();
    var F = global.ZXing.BarcodeFormat;
    hints.set(global.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF, F.CODE_39
    ]);
    hints.set(global.ZXing.DecodeHintType.TRY_HARDER, true);
    zx = new global.ZXing.BrowserMultiFormatReader(hints, 250);
    zx.decodeFromVideoElement(el.video, function (result, err) {
      if (result && current && !current.done) {
        var v = String(result.getText() || '').trim();
        if (v) { vibrate(); finish(v); }
      }
      void err;
    }).catch(function () { setMsg('読取を開始できませんでした'); });
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
            return (list && list.length) ? String(list[0].rawValue) : decodeImageZXing(img);
          }).catch(function () { return decodeImageZXing(img); });
        } catch (e) { return decodeImageZXing(img); }
      }
      return decodeImageZXing(img);
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
    var reader = new global.ZXing.BrowserMultiFormatReader();
    var cv = document.createElement('canvas');
    var max = 1600;
    var sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    cv.width = Math.round(img.naturalWidth * sc);
    cv.height = Math.round(img.naturalHeight * sc);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    try {
      var res = reader.decodeFromCanvas(cv);
      return res ? String(res.getText()) : null;
    } catch (e) {
      return null;
    }
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

  global.Barcode = { scan: scan, lookup: lookup, cancel: function () { finish(null); } };
})(window);
