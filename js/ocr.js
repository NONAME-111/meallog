/* ocr.js - パッケージの栄養成分表示をカメラで撮って読み取る。

   iOSの「テキストをスキャン」はキーボードの機能で、Webページから呼び出す手段が無い。
   実機のメニューにも出ないという報告があったため、アプリ側で完結させる:
     カメラを開く → 写真の中の栄養成分表示の範囲を指でなぞる → 読み取る → 各欄へ入れる
   文字認識は Tesseract を初回だけ読み込む(数MB)。写真は端末内だけで処理し、保存も送信もしない。 */
(function (global) {
  'use strict';

  var TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var LANG = 'jpn';

  var el = null, current = null, loadP = null;

  function esc(s) { return global.App ? global.App.esc(s) : String(s); }

  /* ---- Tesseractの読み込み(初回だけ) ---- */
  function loadTesseract(onProgress) {
    if (global.Tesseract) return Promise.resolve(true);
    if (loadP) return loadP;
    if (onProgress) onProgress('文字認識の準備をしています…（初回だけ数MBの読み込みがあります）');
    loadP = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = TESSERACT_JS;
      s.async = true;
      s.onload = function () { resolve(!!global.Tesseract); };
      s.onerror = function () { loadP = null; resolve(false); };
      document.head.appendChild(s);
    });
    return loadP;
  }

  /* ---- 画面 ---- */
  function build() {
    if (el) return el;
    var root = document.createElement('div');
    root.className = 'ocr';
    root.hidden = true;
    root.innerHTML =
      '<div class="ocr-head">' +
        '<button class="ocr-btn" data-ocr="close">閉じる</button>' +
        '<span class="ocr-title">栄養成分表示を読み取る</span>' +
        '<button class="ocr-btn" data-ocr="retake">撮り直す</button>' +
      '</div>' +
      '<div class="ocr-stage" id="ocrStage">' +
        '<img id="ocrShot" alt="撮影した写真">' +
        '<div class="ocr-sel" id="ocrSel" hidden></div>' +
      '</div>' +
      '<div class="ocr-foot">' +
        '<p class="ocr-msg" id="ocrMsg" role="status" aria-live="polite"></p>' +
        '<button class="btn wide" data-ocr="run" id="ocrRun" disabled>この範囲を読み取る</button>' +
      '</div>' +
      '<input type="file" id="ocrFile" accept="image/*" capture="environment" hidden>';
    document.body.appendChild(root);
    el = {
      root: root,
      stage: root.querySelector('#ocrStage'),
      img: root.querySelector('#ocrShot'),
      sel: root.querySelector('#ocrSel'),
      msg: root.querySelector('#ocrMsg'),
      run: root.querySelector('#ocrRun'),
      file: root.querySelector('#ocrFile')
    };
    bind();
    return el;
  }

  function setMsg(t) { if (el) el.msg.textContent = t || ''; }

  function finish(text) {
    if (!current) return;
    var done = current;
    current = null;
    if (el) {
      el.root.hidden = true;
      if (el.img.src) { try { URL.revokeObjectURL(el.img.src); } catch (e) { void e; } }
      el.img.removeAttribute('src');
      el.sel.hidden = true;
      el.run.disabled = true;
      setMsg('');
    }
    done.resolve(text || null);
  }

  /* ---- 範囲指定(指でなぞる) ---- */
  var sel = null;   // 画像の表示座標での {x, y, w, h}

  function drawSel() {
    if (!sel || sel.w < 8 || sel.h < 8) { el.sel.hidden = true; el.run.disabled = true; return; }
    var box = el.img.getBoundingClientRect(), stage = el.stage.getBoundingClientRect();
    el.sel.hidden = false;
    el.sel.style.left = (box.left - stage.left + sel.x) + 'px';
    el.sel.style.top = (box.top - stage.top + sel.y) + 'px';
    el.sel.style.width = sel.w + 'px';
    el.sel.style.height = sel.h + 'px';
    el.run.disabled = false;
  }

  function pointIn(ev) {
    var box = el.img.getBoundingClientRect();
    var p = ev.touches ? ev.touches[0] : ev;
    return {
      x: Math.max(0, Math.min(box.width, p.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, p.clientY - box.top))
    };
  }

  function bind() {
    el.root.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ocr]');
      if (!b) return;
      if (b.dataset.ocr === 'close') return finish(null);
      if (b.dataset.ocr === 'retake') return el.file.click();
      if (b.dataset.ocr === 'run') return run();
    });

    el.file.addEventListener('change', function () {
      var f = el.file.files && el.file.files[0];
      el.file.value = '';
      if (!f) { if (!el.img.getAttribute('src')) finish(null); return; }
      if (el.img.src) { try { URL.revokeObjectURL(el.img.src); } catch (e) { void e; } }
      el.img.src = URL.createObjectURL(f);
      sel = null; el.sel.hidden = true; el.run.disabled = true;
      setMsg('読み取りたい「栄養成分表示」の範囲を、指でなぞって囲んでください');
    });

    // 画像の上をなぞって範囲を作る
    var start = null;
    function down(ev) {
      if (!el.img.getAttribute('src')) return;
      ev.preventDefault();
      start = pointIn(ev);
      sel = { x: start.x, y: start.y, w: 0, h: 0 };
      drawSel();
    }
    function move(ev) {
      if (!start) return;
      ev.preventDefault();
      var p = pointIn(ev);
      sel = {
        x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y)
      };
      drawSel();
    }
    function up() {
      if (!start) return;
      start = null;
      if (sel && sel.w >= 8 && sel.h >= 8) {
        setMsg('この範囲でよければ「この範囲を読み取る」を押してください。やり直すときはもう一度なぞってください');
      }
    }
    el.stage.addEventListener('touchstart', down, { passive: false });
    el.stage.addEventListener('touchmove', move, { passive: false });
    el.stage.addEventListener('touchend', up);
    el.stage.addEventListener('mousedown', down);
    el.stage.addEventListener('mousemove', move);
    global.addEventListener('mouseup', up);
  }

  /* ---- 切り出しと下ごしらえ ---- */
  function cropCanvas() {
    var img = el.img;
    var box = img.getBoundingClientRect();
    var scale = img.naturalWidth / box.width;   // 表示座標 → 元画像の座標
    var area = sel || { x: 0, y: 0, w: box.width, h: box.height };
    var sx = Math.round(area.x * scale), sy = Math.round(area.y * scale);
    var sw = Math.max(1, Math.round(area.w * scale)), sh = Math.max(1, Math.round(area.h * scale));

    // 小さすぎると読めないので、横1600px程度まで拡大する
    var target = Math.min(2400, Math.max(sw, Math.min(1600, sw * 3)));
    var k = target / sw;
    var cv = document.createElement('canvas');
    cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

    // 白黒にしてコントラストを伸ばす。パッケージは光沢で濃淡が浅いことが多い
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    var px = d.data, lo = 255, hi = 0, i;
    for (i = 0; i < px.length; i += 4) {
      var g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      px[i] = px[i + 1] = px[i + 2] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    var span = Math.max(1, hi - lo);
    for (i = 0; i < px.length; i += 4) {
      var v = Math.max(0, Math.min(255, ((px[i] - lo) * 255 / span) | 0));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  function run() {
    el.run.disabled = true;
    loadTesseract(setMsg).then(function (ok) {
      if (!ok) {
        setMsg('文字認識を読み込めませんでした。通信状況を確かめるか、下の欄に貼り付けてください');
        el.run.disabled = false;
        return null;
      }
      setMsg('読み取っています… 0%');
      var cv = cropCanvas();
      return global.Tesseract.recognize(cv, LANG, {
        logger: function (m) {
          if (m && m.status === 'recognizing text') {
            setMsg('読み取っています… ' + Math.round((m.progress || 0) * 100) + '%');
          } else if (m && m.status) {
            setMsg('準備しています…（' + m.status + '）');
          }
        }
      }).then(function (r) {
        var text = (r && r.data && r.data.text) || '';
        if (!text.replace(/\s/g, '')) {
          setMsg('文字を読み取れませんでした。明るい場所で、表の部分だけを大きく囲んでみてください');
          el.run.disabled = false;
          return null;
        }
        finish(text);
        return text;
      });
    }).catch(function (e) {
      setMsg('読み取れませんでした: ' + ((e && e.message) || e));
      el.run.disabled = false;
    });
  }

  /* ---- 入口 ---- */
  function capture() {
    build();
    return new Promise(function (resolve) {
      current = { resolve: resolve };
      el.root.hidden = false;
      sel = null; el.sel.hidden = true; el.run.disabled = true;
      el.img.removeAttribute('src');
      setMsg('カメラを開きます。パッケージの栄養成分表示を、まっすぐ大きく写してください');
      el.file.click();
    });
  }

  global.Ocr = { capture: capture, _cropCanvas: cropCanvas, _loadTesseract: loadTesseract };
})(window);
