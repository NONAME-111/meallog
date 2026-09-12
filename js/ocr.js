/* ocr.js - パッケージの栄養成分表示をカメラで撮って読み取る。

   実機で検証した結果、読み取りの主役を入れ替えた。

   ・Tesseract(ブラウザで動く文字認識)は、印刷物のスキャンなら読めるが、
     光沢のある袋を手で撮った写真では日本語がほぼ崩れる。
     実機の出力例: 「の ング の ジン メア」「ジジ ンプ クン ンー タク 名 名 衣」。
     切り出し位置は合っていて(「(1袋 50g 当 たり)」「食塩 相当 重 0.6g」は読めている)、
     認識の質そのものが足りていない。
   ・iPhoneには Live Text(Appleの文字認識)が入っていて、こちらは同じ写真をきれいに読む。
     Webページから自動では呼べないが、写真を長押しして選ぶことはできる。

   そこで、写真を長押しして選ぶ方式を既定にし、Tesseractは「自動で試す」に格下げした。
   写真は端末内だけで処理し、保存も送信もしない。 */
(function (global) {
  'use strict';

  var TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var LANG = 'jpn';

  var el = null, current = null, loadP = null;
  var shotFile = null;      // 撮った写真そのもの。切り出しの元にする
  var sel = null;           // なぞって決めた範囲(画像の表示座標)

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
        '<ol class="ocr-steps" id="ocrSteps">' +
          '<li>上の写真の<b>栄養成分表示を長押し</b>する</li>' +
          '<li>文字が選ばれたら、端をドラッグして<b>表全体を囲む</b></li>' +
          '<li><b>「コピー」</b>を押して、下のボタンへ</li>' +
        '</ol>' +
        '<p class="ocr-msg" id="ocrMsg" role="status" aria-live="polite"></p>' +
        '<button class="btn wide" data-ocr="paste" id="ocrPaste">コピーした文字を貼り付けて反映</button>' +
        '<button class="btn sub wide" data-ocr="auto" id="ocrAuto">自動で読み取ってみる</button>' +
        '<button class="btn wide" data-ocr="run" id="ocrRun" hidden disabled>この範囲を読み取る</button>' +
      '</div>' +
      '<input type="file" id="ocrFile" accept="image/*" capture="environment" hidden>';
    document.body.appendChild(root);
    el = {
      root: root,
      stage: root.querySelector('#ocrStage'),
      img: root.querySelector('#ocrShot'),
      sel: root.querySelector('#ocrSel'),
      steps: root.querySelector('#ocrSteps'),
      msg: root.querySelector('#ocrMsg'),
      paste: root.querySelector('#ocrPaste'),
      auto: root.querySelector('#ocrAuto'),
      run: root.querySelector('#ocrRun'),
      file: root.querySelector('#ocrFile')
    };
    bind();
    return el;
  }

  function setMsg(t) { if (el) el.msg.textContent = t || ''; }

  /* 長押しで選ぶ画面(既定) と、なぞって自動で読む画面 の切り替え */
  function setMode(mode) {
    el.root.classList.toggle('auto', mode === 'auto');
    el.steps.hidden = mode === 'auto';
    el.paste.hidden = mode === 'auto';
    el.auto.hidden = mode === 'auto';
    el.run.hidden = mode !== 'auto';
    if (mode === 'auto') {
      sel = null; el.sel.hidden = true; el.run.disabled = true;
      setMsg('読み取りたい「栄養成分表示」の範囲を、指でなぞって囲んでください');
    } else {
      el.sel.hidden = true;
      setMsg('');
    }
  }

  function finish(text) {
    if (!current) return;
    var done = current;
    current = null;
    if (el) {
      el.root.hidden = true;
      if (el.img.src) { try { URL.revokeObjectURL(el.img.src); } catch (e) { void e; } }
      el.img.removeAttribute('src');
      el.sel.hidden = true;
      setMsg('');
    }
    done.resolve(text || null);
  }

  /* ---- 範囲指定(自動読み取りのときだけ) ---- */
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
      if (b.dataset.ocr === 'paste') return pasteFromClipboard();
      if (b.dataset.ocr === 'auto') return setMode('auto');
      if (b.dataset.ocr === 'run') return run();
    });

    el.file.addEventListener('change', function () {
      var f = el.file.files && el.file.files[0];
      el.file.value = '';
      if (!f) { if (!el.img.getAttribute('src')) finish(null); return; }
      if (el.img.src) { try { URL.revokeObjectURL(el.img.src); } catch (e) { void e; } }
      shotFile = f;
      el.img.src = URL.createObjectURL(f);
      setMode('select');
    });

    // 自動読み取りのときだけ、なぞって範囲を作る
    var start = null;
    function down(ev) {
      if (!el.img.getAttribute('src')) return;
      if (!el.root.classList.contains('auto')) return;   // 長押しで文字を選ばせる
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
        setMsg('この範囲でよければ「この範囲を読み取る」を押してください');
      }
    }
    el.stage.addEventListener('touchstart', down, { passive: false });
    el.stage.addEventListener('touchmove', move, { passive: false });
    el.stage.addEventListener('touchend', up);
    el.stage.addEventListener('mousedown', down);
    el.stage.addEventListener('mousemove', move);
    global.addEventListener('mouseup', up);
  }

  /* ---- コピーした文字を受け取る ---- */
  function looksLikeLabel(text) {
    var t = String(text || '');
    return /[0-9]/.test(t) && /(kcal|kca|カロリー|熱量|エネルギー|たんぱく|蛋白|脂質|炭水化物|食塩)/i.test(t);
  }

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setMsg('この端末では自動で貼り付けできません。閉じてから「読み取った文字」の欄に貼り付けてください');
      return;
    }
    setMsg('コピーした文字を読み込んでいます…');
    navigator.clipboard.readText().then(function (text) {
      if (!text || !text.trim()) {
        setMsg('コピーされた文字がありません。写真を長押しして文字を選び、「コピー」を押してください');
        return;
      }
      if (!looksLikeLabel(text)) {
        setMsg('栄養成分表示らしい文字が見つかりません。表の部分をもう一度選んでコピーしてください');
        return;
      }
      finish(text);
    }).catch(function () {
      setMsg('貼り付けを許可してください。できないときは、閉じてから「読み取った文字」の欄に直接貼り付けられます');
    });
  }

  /* ---- 切り出し(自動読み取り用) ---- */

  /* iPhoneの写真はExifで回転が入る。img の naturalWidth と canvas の drawImage で
     向きの扱いが食い違うと、まったく別の場所を切り出してしまう。
     createImageBitmap で向きを確定させてから使う。 */
  function sourceImage() {
    if (!shotFile || !global.createImageBitmap) return Promise.resolve(el.img);
    return global.createImageBitmap(shotFile, { imageOrientation: 'from-image' })
      .catch(function () { return el.img; });
  }

  /* 切り出して拡大し、白黒にする。
     2値化までは掛けない。Tesseractは内部で領域ごとにしきい値を決めるので、
     こちらで1つのしきい値に潰すとかえって崩れる(実機で確認済み)。 */
  function cropCanvas(src) {
    var box = el.img.getBoundingClientRect();
    var area = sel || { x: 0, y: 0, w: box.width, h: box.height };
    // 画面上の位置は「割合」で持つ。元画像の寸法が何であれずれない
    var fx = area.x / Math.max(1, box.width), fy = area.y / Math.max(1, box.height);
    var fw = area.w / Math.max(1, box.width), fh = area.h / Math.max(1, box.height);
    var baseW = src.width || src.naturalWidth, baseH = src.height || src.naturalHeight;
    var sx = Math.round(fx * baseW), sy = Math.round(fy * baseH);
    var sw = Math.max(1, Math.round(fw * baseW)), sh = Math.max(1, Math.round(fh * baseH));

    var target = Math.min(2600, Math.max(sw, Math.min(2000, sw * 3)));
    var k = target / sw;
    var cv = document.createElement('canvas');
    cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    var px = d.data, i, g;
    for (i = 0; i < px.length; i += 4) {
      g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  function run() {
    el.run.disabled = true;
    loadTesseract(setMsg).then(function (ok) {
      if (!ok) {
        setMsg('文字認識を読み込めませんでした。写真を長押しして選ぶ方法をお使いください');
        el.run.disabled = false;
        return null;
      }
      setMsg('読み取っています… 0%');
      return sourceImage().then(function (src) {
        var cv = cropCanvas(src);
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
          finish(text);
          return text;
        });
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
      setMode('select');
      el.img.removeAttribute('src');
      setMsg('カメラを開きます。栄養成分表示を、まっすぐ大きく写してください');
      el.file.click();
    });
  }

  global.Ocr = { capture: capture, _cropCanvas: cropCanvas, _loadTesseract: loadTesseract };
})(window);
