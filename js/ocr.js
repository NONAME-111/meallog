/* ocr.js - 栄養成分表示をアプリの中で読み取る(v50)
   流れ: カメラで撮影(または写真を選ぶ) → 読み取る範囲を枠で囲む → 文字認識 → 手入力画面の読み取り欄へ。
   文字認識は PaddleOCR の PP-OCRv5 mobile を ONNX Runtime Web(WASM)で端末の中で動かす。
   写真はどこにも送らない。
   ・v37 でやめた Tesseract は、光沢のある袋で日本語が「の ング の ジン メア」のように崩れた。
     PP-OCRv5 は写真の中の文字に強く、かな・漢字・英数字を1つのモデルで読める
   ・部品は合計約33MB。初めて読み取るときに取りに行き、Service Worker の別の控え
     (版を上げても消さない)に残すので、2回目からは圏外でも動く
   ・前処理と後処理は PaddleOCR の設定(inference.yml)に合わせた。
     文字の位置: 長辺640〜960px・BGR・ImageNetの平均と分散で正規化 → DB後処理(0.3 / 0.6 / 1.5)
     文字の読み: 高さ48px・(x/255-0.5)/0.5 → CTC(0番が区切り、辞書の後ろに空白)
   ・確かめ用のページ: app/work/ocr-test.html, ocr-test2.html(合成した表示)、ocr-real.html(利用者の実機の写真
     label1.webp。v51で直した行間の狭い表示)。どれも公開しない */
(function (global) {
  'use strict';

  var ORT_DIR = 'vendor/ort-1.23.2/';
  var MODEL_DIR = 'vendor/ppocrv5/';
  // 読み込みの進み具合に使う大きさ(サーバーが大きさを返さないときの目安)
  var PARTS = {
    wasm: { url: ORT_DIR + 'ort-wasm-simd-threaded.wasm', size: 11905541 },
    det: { url: MODEL_DIR + 'det.onnx', size: 4748769 },
    rec: { url: MODEL_DIR + 'rec.onnx', size: 16517247 }
  };

  // 文字の位置を探すときの長辺。大きい絵は960まで縮め、小さい絵は640まで広げる(その間はそのまま)。
  // 長辺960に必ずそろえると、小さく囲んだときに無駄に重くなる
  var DET_MAX = 960, DET_MIN = 640;
  var THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.5, MIN_SIZE = 3;
  var REC_H = 48, REC_W = 320, REC_MAX_W = 3200;
  var DROP_SCORE = 0.3;        // これより自信の低い読みは捨てる(雑音の行)
  var MAX_BOXES = 80;          // 広く囲みすぎたときに延々と読まないための上限

  /* ---------- 部品の読み込み ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('読み込めませんでした: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function fetchBytes(url, onChunk) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (buf) {
          onChunk(buf.byteLength);
          return new Uint8Array(buf);
        });
      }
      var reader = res.body.getReader(), parts = [], total = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var out = new Uint8Array(total), pos = 0;
            parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
            return out;
          }
          parts.push(r.value);
          total += r.value.length;
          onChunk(r.value.length);
          return pump();
        });
      }
      return pump();
    });
  }

  var engine = null, enginePromise = null, listeners = [], loadedBytes = 0;
  var TOTAL_BYTES = PARTS.wasm.size + PARTS.det.size + PARTS.rec.size;

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(loadedBytes, TOTAL_BYTES); } catch (e) { void e; }
    });
  }

  /* 部品を読み込んで、文字認識を使える状態にする。何度呼んでも読み込みは1回 */
  function prepare(onProgress) {
    if (engine) return Promise.resolve(engine);
    if (onProgress) listeners.push(onProgress);
    if (enginePromise) return enginePromise;
    loadedBytes = 0;
    var bump = function (n) { loadedBytes += n; emit(); };
    enginePromise = Promise.all([
      global.ort ? Promise.resolve() : loadScript(ORT_DIR + 'ort.wasm.min.js'),
      fetchBytes(PARTS.wasm.url, bump),
      fetchBytes(PARTS.det.url, bump),
      fetchBytes(PARTS.rec.url, bump),
      fetch(MODEL_DIR + 'dict.txt').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' dict.txt');
        return r.text();
      })
    ]).then(function (r) {
      var ort = global.ort;
      if (!ort || !ort.InferenceSession) throw new Error('ONNX Runtime を読み込めませんでした');
      // GitHub Pages では複数スレッドを使えない(cross-origin isolation の見出しを付けられない)
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';   // 「CPUの種類が分からない」などの注意書きを出さない
      ort.env.wasm.wasmPaths = new URL(ORT_DIR, document.baseURI).href;
      ort.env.wasm.wasmBinary = r[1];
      var opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      // 2つ同時に作ると一時的にメモリを倍食うので、順に作る
      return ort.InferenceSession.create(r[2], opt).then(function (det) {
        return ort.InferenceSession.create(r[3], opt).then(function (rec) {
          var lines = r[4].replace(/\r/g, '').split('\n');
          if (lines.length && lines[lines.length - 1] === '') lines.pop();
          // 0番は区切り(blank)、辞書の後ろに空白が1つ付く(use_space_char)
          engine = { ort: ort, det: det, rec: rec, chars: [''].concat(lines, [' ']) };
          return engine;
        });
      });
    }).then(function (e) {
      listeners = [];
      return e;
    }, function (err) {
      enginePromise = null;
      listeners = [];
      throw err;
    });
    return enginePromise;
  }

  function makeCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
  }

  /* ---------- 文字の位置を探す ---------- */
  function detect(eng, src) {
    var w0 = src.width, h0 = src.height, long = Math.max(w0, h0);
    var ratio = long > DET_MAX ? DET_MAX / long : (long < DET_MIN ? DET_MIN / long : 1);
    // 縦横とも32の倍数にそろえる(モデルの都合)
    var w = Math.max(32, Math.round(w0 * ratio / 32) * 32);
    var h = Math.max(32, Math.round(h0 * ratio / 32) * 32);
    var cv = makeCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;
    cv.width = cv.height = 1;
    var plane = w * h, data = new Float32Array(plane * 3);
    // PaddleOCR は BGR の並びのまま ImageNet の平均・分散で割る(順番の癖も合わせる)
    for (var i = 0, p = 0; i < plane; i++, p += 4) {
      data[i] = (px[p + 2] / 255 - 0.485) / 0.229;
      data[plane + i] = (px[p + 1] / 255 - 0.456) / 0.224;
      data[2 * plane + i] = (px[p] / 255 - 0.406) / 0.225;
    }
    var feeds = {};
    feeds[eng.det.inputNames[0]] = new eng.ort.Tensor('float32', data, [1, 3, h, w]);
    return eng.det.run(feeds).then(function (out) {
      var prob = out[eng.det.outputNames[0]].data;
      var sx = w0 / w, sy = h0 / h;
      return dbBoxes(prob, w, h).map(function (b) {
        // 元の写真の大きさへ戻す(縦横の倍率はほぼ同じなので、傾きはそのまま)
        var c = Math.abs(Math.cos(b.angle)), s = Math.abs(Math.sin(b.angle));
        return {
          cx: b.cx * sx, cy: b.cy * sy, angle: b.angle, score: b.score,
          w: b.w * (c * sx + s * sy), h: b.h * (s * sx + c * sy)
        };
      });
    });
  }

  /* DB後処理: 確率の地図を0.3で2値にし、つながった塊ごとに傾いた長方形を当てる */
  function dbBoxes(prob, w, h) {
    var n = w * h, label = new Uint8Array(n), stack = new Int32Array(n), boxes = [];
    for (var s = 0; s < n; s++) {
      if (label[s] || prob[s] <= THRESH) continue;
      // 行ごとの左端・右端だけ覚える(凸包はそれで決まる)
      var rowMin = {}, rowMax = {}, count = 0, top = 0;
      stack[top++] = s;
      label[s] = 1;
      while (top) {
        var q = stack[--top], x = q % w, y = (q - x) / w;
        count++;
        if (!(y in rowMin) || x < rowMin[y]) rowMin[y] = x;
        if (!(y in rowMax) || x > rowMax[y]) rowMax[y] = x;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx;
            if ((!dx && !dy) || nx < 0 || nx >= w) continue;
            var r = ny * w + nx;
            if (!label[r] && prob[r] > THRESH) { label[r] = 1; stack[top++] = r; }
          }
        }
      }
      if (count < 4) continue;
      var pts = [];
      Object.keys(rowMin).forEach(function (key) {
        var yy = +key;
        pts.push([rowMin[yy], yy]);
        if (rowMax[yy] !== rowMin[yy]) pts.push([rowMax[yy], yy]);
      });
      var rect = minAreaRect(pts);
      if (!rect || Math.min(rect.w, rect.h) < MIN_SIZE) continue;
      rect.score = rectScore(prob, w, h, rect);
      if (rect.score < BOX_THRESH) continue;
      // 文字の芯だけが検出されるので、周りへ広げる(pyclipper の膨らませと同じ量)
      var d = rect.w * rect.h * UNCLIP / (2 * (rect.w + rect.h));
      rect.w += 2 * d;
      rect.h += 2 * d;
      if (Math.min(rect.w, rect.h) < MIN_SIZE + 2) continue;
      boxes.push(rect);
    }
    return boxes;
  }

  function convexHull(pts) {
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    var cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /* 面積が最小になる傾いた長方形。向きは横書きに合わせ、長方形の「横」は -45°〜45° の向きにとる */
  function minAreaRect(pts) {
    var hull = convexHull(pts);
    if (!hull.length) return null;
    var best = null;
    var tryAngle = function (a) {
      var c = Math.cos(a), s = Math.sin(a);
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var k = 0; k < hull.length; k++) {
        var u = hull[k][0] * c + hull[k][1] * s, v = -hull[k][0] * s + hull[k][1] * c;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area - 1e-9) {
        best = { area: area, a: a, minU: minU, maxU: maxU, minV: minV, maxV: maxV };
      }
    };
    tryAngle(0);
    for (var i = 0; i < hull.length; i++) {
      var p = hull[i], q = hull[(i + 1) % hull.length];
      if (p[0] === q[0] && p[1] === q[1]) continue;
      tryAngle(Math.atan2(q[1] - p[1], q[0] - p[0]));
    }
    var a = best.a, w = best.maxU - best.minU, h = best.maxV - best.minV;
    var cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
    var cx = cu * Math.cos(a) - cv * Math.sin(a), cy = cu * Math.sin(a) + cv * Math.cos(a);
    // 向きを -45°〜45° にそろえる(90°回すと縦と横が入れ替わる)
    while (a > Math.PI / 4) { a -= Math.PI / 2; var t = w; w = h; h = t; }
    while (a <= -Math.PI / 4) { a += Math.PI / 2; var t2 = w; w = h; h = t2; }
    // 1画素の点の集まりなので、端から端まで含むよう1画素ぶん足す
    return { cx: cx, cy: cy, w: w + 1, h: h + 1, angle: a };
  }

  /* 長方形の中の確率の平均(box_score_fast と同じ考え方) */
  function rectScore(prob, w, h, r) {
    var c = Math.cos(r.angle), s = Math.sin(r.angle);
    var hw = r.w / 2, hh = r.h / 2;
    var ex = Math.abs(hw * c) + Math.abs(hh * s), ey = Math.abs(hw * s) + Math.abs(hh * c);
    var x0 = Math.max(0, Math.floor(r.cx - ex)), x1 = Math.min(w - 1, Math.ceil(r.cx + ex));
    var y0 = Math.max(0, Math.floor(r.cy - ey)), y1 = Math.min(h - 1, Math.ceil(r.cy + ey));
    var sum = 0, cnt = 0;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - r.cx, dy = y - r.cy;
        var u = dx * c + dy * s, v = -dx * s + dy * c;
        if (Math.abs(u) <= hw && Math.abs(v) <= hh) { sum += prob[y * w + x]; cnt++; }
      }
    }
    return cnt ? sum / cnt : 0;
  }

  function medianAngle(boxes) {
    var angles = boxes.map(function (b) { return b.angle; }).sort(function (a, b) { return a - b; });
    return angles[Math.floor(angles.length / 2)];
  }

  /* 行の間が狭い表示では、膨らませた箱に上下の行の字が半分ずつ入り込んで読みが崩れた
     (「エネルギー」→「工ネ」「羊一」、「48g」→「488」。2026-10-25 利用者の実機の写真)。
     上下に重なる行があるときは、行の中心どうしの真ん中で箱を切る(この写真では高さ0.65倍で全部読めた)。
     左右に並ぶ箱(見出しと数値)は重ならないので切らない */
  function tightenLines(boxes) {
    if (boxes.length < 2) return boxes;
    var a = medianAngle(boxes), c = Math.cos(a), s = Math.sin(a);
    var info = boxes.map(function (b) {
      var rx = b.cx * c + b.cy * s;
      return { ry: -b.cx * s + b.cy * c, x1: rx - b.w / 2, x2: rx + b.w / 2 };
    });
    return boxes.map(function (b, i) {
      var me = info[i], top = me.ry - b.h / 2, bottom = me.ry + b.h / 2;
      info.forEach(function (o, j) {
        if (j === i) return;
        var overlap = Math.min(me.x2, o.x2) - Math.max(me.x1, o.x1);
        if (overlap < 0.3 * Math.min(me.x2 - me.x1, o.x2 - o.x1)) return;
        // 同じ高さで重なる箱(二重に見つかった箱など)は上下の行ではない
        if (Math.abs(o.ry - me.ry) < 0.4 * Math.min(b.h, boxes[j].h)) return;
        var mid = (me.ry + o.ry) / 2;
        if (o.ry < me.ry) top = Math.max(top, mid);
        else bottom = Math.min(bottom, mid);
      });
      var h = bottom - top;
      if (h >= b.h - 0.5) return b;
      if (h < b.h * 0.5) { var keep = (b.h * 0.5 - h) / 2; top -= keep; bottom += keep; h = b.h * 0.5; }
      var shift = (top + bottom) / 2 - me.ry;
      return { cx: b.cx - shift * s, cy: b.cy + shift * c, w: b.w, h: h, angle: b.angle, score: b.score };
    });
  }

  /* 傾いた長方形を、まっすぐな横長の絵として切り出す */
  function cropBox(src, b) {
    var w = Math.max(1, Math.round(b.w)), h = Math.max(1, Math.round(b.h));
    var cv = makeCanvas(w, h), ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-b.angle);
    ctx.translate(-b.cx, -b.cy);
    ctx.drawImage(src, 0, 0);
    if (h / w < 1.5) return cv;
    // 縦に長い(縦書き)ときは横に寝かせる(PaddleOCR と同じく左へ90°)
    var rot = makeCanvas(h, w), rc = rot.getContext('2d');
    rc.translate(0, w);
    rc.rotate(-Math.PI / 2);
    rc.drawImage(cv, 0, 0);
    return rot;
  }

  /* ---------- 1行ずつ文字を読む ---------- */
  function recognize(eng, crop) {
    var ratio = crop.width / crop.height;
    var imgW = Math.min(REC_MAX_W, Math.floor(REC_H * Math.max(REC_W / REC_H, ratio)));
    var rw = Math.max(1, Math.min(imgW, Math.ceil(REC_H * ratio)));
    var cv = makeCanvas(rw, REC_H), ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(crop, 0, 0, rw, REC_H);
    var px = ctx.getImageData(0, 0, rw, REC_H).data;
    /* 小さい字を高さ48pxへ引き伸ばすとぼけて、圧縮の荒い写真では字が「区切り」に負けて抜けた
       (「炭水化物」→「炭化物」。合成画像で実測)。引き伸ばすときだけ輪郭を立てる */
    if (crop.height < REC_H * 0.9) px = sharpen(px, rw, REC_H);
    var plane = REC_H * imgW, data = new Float32Array(plane * 3);   // 右の余白は0のまま
    for (var y = 0; y < REC_H; y++) {
      for (var x = 0; x < rw; x++) {
        var i = y * imgW + x, p = (y * rw + x) * 4;
        data[i] = px[p + 2] / 127.5 - 1;
        data[plane + i] = px[p + 1] / 127.5 - 1;
        data[2 * plane + i] = px[p] / 127.5 - 1;
      }
    }
    var feeds = {};
    feeds[eng.rec.inputNames[0]] = new eng.ort.Tensor('float32', data, [1, 3, REC_H, imgW]);
    return eng.rec.run(feeds).then(function (out) {
      var t = out[eng.rec.outputNames[0]];
      // 右の余白の分は確からしさの計算に入れない
      return ctcDecode(t.data, t.dims[1], t.dims[2], eng.chars, Math.ceil(t.dims[1] * rw / imgW));
    });
  }

  /* 自信の低い行は、箱の高さを変えて読み直し、いちばん確からしい読みを採る。
     確からしさは「各時点のいちばん高い確率」の対数の平均(lp)。字が「区切り」に負けて抜けた読みは
     その時点の確率が低いので、字を数えるだけの平均(conf)より読み比べに向く(実機の写真で確かめた) */
  var RETRY_LP = -0.05, RETRY_H = [0.8, 1.2];
  function recognizeBest(eng, src, b) {
    return recognize(eng, cropBox(src, b)).then(function (first) {
      if (first.lp >= RETRY_LP) return first;
      var best = first;
      return RETRY_H.reduce(function (chain, f) {
        return chain.then(function () {
          var alt = { cx: b.cx, cy: b.cy, w: b.w, h: b.h * f, angle: b.angle, score: b.score };
          return recognize(eng, cropBox(src, alt)).then(function (r) { if (r.lp > best.lp) best = r; });
        });
      }, Promise.resolve()).then(function () { return best; });
    });
  }

  /* 4近傍のラプラシアンで輪郭を立てる(元の値 + (4×中心 − 上下左右)) */
  function sharpen(px, w, h) {
    var out = new Uint8ClampedArray(px.length);
    for (var y = 0; y < h; y++) {
      var up = (y > 0 ? y - 1 : y) * w, dn = (y < h - 1 ? y + 1 : y) * w, row = y * w;
      for (var x = 0; x < w; x++) {
        var lf = x > 0 ? x - 1 : x, rt = x < w - 1 ? x + 1 : x, i = (row + x) * 4;
        for (var c = 0; c < 3; c++) {
          out[i + c] = 5 * px[i + c] - px[(up + x) * 4 + c] - px[(dn + x) * 4 + c] -
            px[(row + lf) * 4 + c] - px[(row + rt) * 4 + c];
        }
        out[i + 3] = 255;
      }
    }
    return out;
  }

  function ctcDecode(probs, steps, classes, chars, used) {
    var text = '', last = -1, sum = 0, n = 0, logSum = 0;
    used = Math.max(1, Math.min(steps, used || steps));
    for (var t = 0; t < steps; t++) {
      var off = t * classes, best = 0, bestP = probs[off];
      for (var c = 1; c < classes; c++) {
        var v = probs[off + c];
        if (v > bestP) { bestP = v; best = c; }
      }
      if (t < used) logSum += Math.log(Math.max(bestP, 1e-6));
      if (best !== 0 && best !== last) {
        text += chars[best] || '';
        sum += bestP;
        n++;
      }
      last = best;
    }
    return { text: text, conf: n ? sum / n : 0, lp: logSum / used };
  }

  /* ---------- 読んだ断片を行にまとめる ----------
     見出し(たんぱく質)と数値(3.2g)は別々の箱で見つかることが多い。
     同じ高さの箱を左から並べて1行にすると、解析側(nutrition-label.js)がそのまま読める */
  function assemble(items) {
    if (!items.length) return '';
    // 写真が傾いていると、同じ行の右端が下の行に見える。中央値の傾きでならしてから分ける
    var a = medianAngle(items.map(function (it) { return it.box; })), c = Math.cos(a), s = Math.sin(a);
    items.forEach(function (it) {
      var b = it.box;
      it.ry = -b.cx * s + b.cy * c;
      it.rx = b.cx * c + b.cy * s;
      it.lh = Math.min(b.w, b.h);
    });
    items.sort(function (p, q) { return p.ry - q.ry; });
    var rows = [];
    items.forEach(function (it) {
      var row = null;
      for (var k = rows.length - 1; k >= 0 && k >= rows.length - 3; k--) {
        if (Math.abs(it.ry - rows[k].ry) <= 0.5 * Math.min(it.lh, rows[k].lh)) { row = rows[k]; break; }
      }
      if (!row) { row = { ry: it.ry, lh: it.lh, items: [] }; rows.push(row); }
      row.items.push(it);
      row.ry = row.items.reduce(function (sum, x) { return sum + x.ry; }, 0) / row.items.length;
    });
    return rows.map(function (row) {
      row.items.sort(function (p, q) { return p.rx - q.rx; });
      return row.items.map(function (x) { return x.text; }).join(' ');
    }).join('\n');
  }

  function pause() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* 絵(canvas)の文字を読む。onStage('load', 読んだバイト, 全体) / ('detect') / ('rec', i, n)
     読み取り中に閉じて開き直すと2つ重なることがあるので、1つずつ順に流す
     (同じモデルを同時に動かさない) */
  var queue = Promise.resolve();
  function read(src, onStage) {
    var job = queue.then(function () { return readNow(src, onStage); });
    queue = job.catch(function () { return null; });
    return job;
  }

  function readNow(src, onStage) {
    var stage = onStage || function () {};
    return prepare(function (got, total) { stage('load', got, total); }).then(function (eng) {
      stage('detect');
      return pause().then(function () { return detect(eng, src); }).then(function (boxes) {
        // 上から順に読む(上限を超えたら下は捨てる)
        boxes.sort(function (p, q) { return p.cy - q.cy || p.cx - q.cx; });
        boxes = tightenLines(boxes.slice(0, MAX_BOXES));
        var items = [], i = 0;
        function next() {
          if (i >= boxes.length) return Promise.resolve();
          var b = boxes[i++];
          stage('rec', i, boxes.length);
          // 1行ごとに画面へ制御を返し、進み具合の表示を更新させる
          return pause().then(function () {
            return recognizeBest(eng, src, b);
          }).then(function (r) {
            if (r.text.trim() && r.conf >= DROP_SCORE) items.push({ text: r.text, conf: r.conf, lp: r.lp, box: b });
            return next();
          });
        }
        return next().then(function () {
          return { text: assemble(items), items: items, boxes: boxes };
        });
      });
    });
  }

  /* ---------- 撮影と範囲の指定 ----------
     カメラは barcode.js の映像を使い回す(別々に getUserMedia を呼ぶと許可を二度聞かれる)。
     枠の位置は「表示している絵の中の割合」で持つ。映像も写真も同じ object-fit: contain で
     出すので、撮る前に合わせた枠が、撮った写真の同じ場所にそのまま重なる */
  var RECT_KEY = 'meallog.ocrRect';
  var MIN_PX = 44;             // 枠の最小の大きさ(角を指でつかめる大きさ)
  var MAX_PHOTO = 2400;        // 写真から選んだときの長辺(1,200万画素のままだと重い)
  var ui = null, cur = null;   // cur = { resolve, mode: live|edit|busy, source, fw, fh, rect }

  function byId(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function loadRect() {
    try {
      var r = JSON.parse(global.localStorage.getItem(RECT_KEY) || 'null');
      if (r && r.w >= 0.05 && r.h >= 0.05 && r.x >= 0 && r.y >= 0 &&
          r.x + r.w <= 1.001 && r.y + r.h <= 1.001) return r;
    } catch (e) { void e; }
    return { x: 0.08, y: 0.2, w: 0.84, h: 0.5 };
  }
  function saveRect(r) {
    try { global.localStorage.setItem(RECT_KEY, JSON.stringify(r)); } catch (e) { void e; }
  }

  function initUi() {
    if (ui) return;
    ui = {
      root: byId('labelCam'), stage: byId('lcamStage'), video: byId('lcamVideo'), shot: byId('lcamShot'),
      crop: byId('lcamCrop'), msg: byId('lcamMsg'), live: byId('lcamLive'), edit: byId('lcamEdit'),
      busy: byId('lcamBusy'), busyMsg: byId('lcamBusyMsg'), file: byId('lcamFile')
    };
    byId('lcamClose').addEventListener('click', function () { finish(null); });
    byId('lcamShutter').addEventListener('click', capture);
    byId('lcamPick').addEventListener('click', function () { ui.file.click(); });
    byId('lcamRetake').addEventListener('click', function () { if (cur && cur.mode === 'edit') toLive(); });
    byId('lcamRead').addEventListener('click', readRect);
    ui.file.addEventListener('change', onFile);
    // 映像の大きさは再生が始まってから分かる
    ['loadedmetadata', 'resize'].forEach(function (ev) {
      ui.video.addEventListener(ev, function () {
        if (!cur || cur.mode !== 'live' || !ui.video.videoWidth) return;
        cur.fw = ui.video.videoWidth;
        cur.fh = ui.video.videoHeight;
        drawCrop();
      });
    });
    global.addEventListener('resize', function () { if (cur) drawCrop(); });
    // 別のアプリへ行くとカメラは手放される(barcode.js)。戻ってきたら映し直す
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && cur && cur.mode === 'live') toLive();
    });
    bindDrag();
  }

  function setMsg(text) { ui.msg.textContent = text || ''; }
  function setBusy(text) {
    ui.busy.hidden = !text;
    ui.busyMsg.textContent = text || '';
  }

  /* 表示中の絵が、枠(ステージ)の中のどこに収まっているか(object-fit: contain と同じ計算) */
  function fitBox() {
    var sw = ui.stage.clientWidth, sh = ui.stage.clientHeight;
    if (!cur || !cur.fw || !cur.fh) return { x: 0, y: 0, w: sw, h: sh };
    var s = Math.min(sw / cur.fw, sh / cur.fh), w = cur.fw * s, h = cur.fh * s;
    return { x: (sw - w) / 2, y: (sh - h) / 2, w: w, h: h };
  }

  function drawCrop() {
    var f = fitBox(), r = cur.rect, st = ui.crop.style;
    st.left = (f.x + r.x * f.w) + 'px';
    st.top = (f.y + r.y * f.h) + 'px';
    st.width = (r.w * f.w) + 'px';
    st.height = (r.h * f.h) + 'px';
  }

  /* 角をつかむと大きさ、枠の中をつかむと位置、枠の外をなぞると新しく囲み直す */
  function bindDrag() {
    var drag = null;
    function pt(e) {
      var b = ui.stage.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    }
    ui.stage.addEventListener('pointerdown', function (e) {
      if (!cur || cur.mode === 'busy' || drag) return;
      var f = fitBox(), p = pt(e), r = cur.rect;
      var box = { x1: f.x + r.x * f.w, y1: f.y + r.y * f.h, x2: f.x + (r.x + r.w) * f.w, y2: f.y + (r.y + r.h) * f.h };
      var handle = e.target.closest ? e.target.closest('[data-h]') : null;
      var kind = handle ? handle.getAttribute('data-h')
        : (p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2 ? 'move' : 'draw');
      drag = { kind: kind, f: f, start: p, box: box, moved: false, id: e.pointerId };
      try { ui.stage.setPointerCapture(e.pointerId); } catch (err) { void err; }
      e.preventDefault();
    });
    ui.stage.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var p = pt(e), f = drag.f, b = drag.box;
      var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true;
      var L = f.x, T = f.y, R = f.x + f.w, B = f.y + f.h;
      var x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
      if (drag.kind === 'move') {
        var w = x2 - x1, h = y2 - y1;
        x1 = clamp(x1 + dx, L, R - w); y1 = clamp(y1 + dy, T, B - h);
        x2 = x1 + w; y2 = y1 + h;
      } else if (drag.kind === 'draw') {
        x1 = clamp(Math.min(drag.start.x, p.x), L, R); x2 = clamp(Math.max(drag.start.x, p.x), L, R);
        y1 = clamp(Math.min(drag.start.y, p.y), T, B); y2 = clamp(Math.max(drag.start.y, p.y), T, B);
        if (x2 - x1 < MIN_PX || y2 - y1 < MIN_PX) return;   // 小さいうちは前の枠のまま
      } else {
        // 角: nw / ne / sw / se
        if (drag.kind.charAt(1) === 'w') x1 = clamp(b.x1 + dx, L, x2 - MIN_PX);
        else x2 = clamp(b.x2 + dx, x1 + MIN_PX, R);
        if (drag.kind.charAt(0) === 'n') y1 = clamp(b.y1 + dy, T, y2 - MIN_PX);
        else y2 = clamp(b.y2 + dy, y1 + MIN_PX, B);
      }
      cur.rect = { x: (x1 - L) / f.w, y: (y1 - T) / f.h, w: (x2 - x1) / f.w, h: (y2 - y1) / f.h };
      drawCrop();
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      // カメラで撮るときの枠は次回も同じ位置から始める(写真は構図がまちまちなので覚えない)
      if (moved && cur && cur.source === 'camera') saveRect(cur.rect);
    }
    ui.stage.addEventListener('pointerup', end);
    ui.stage.addEventListener('pointercancel', end);
  }

  function camera() { return global.Barcode && global.Barcode.camera; }
  function stopCam() { var cam = camera(); if (cam) cam.detach(ui.video); }

  function toLive() {
    cur.mode = 'live';
    cur.source = 'camera';
    cur.rect = loadRect();
    cur.fw = ui.video.videoWidth || 0;
    cur.fh = ui.video.videoHeight || 0;
    ui.shot.hidden = true;
    ui.video.hidden = false;
    ui.live.hidden = false;
    ui.edit.hidden = true;
    setBusy(null);
    drawCrop();
    setMsg('カメラを起動中…');
    var cam = camera();
    if (!cam) { setMsg('カメラを使えません。「写真から選ぶ」をお試しください'); return; }
    cam.attach(ui.video).then(function () {
      if (!cur || cur.mode !== 'live') return;
      cur.fw = ui.video.videoWidth || cur.fw;
      cur.fh = ui.video.videoHeight || cur.fh;
      drawCrop();
      setMsg('栄養成分表示を写して撮影してください。枠は角を動かして広げられます');
    }).catch(function (err) {
      if (!cur || cur.mode !== 'live') return;
      setMsg('カメラを使えません（' + cam.shortErr(err) + '）。「写真から選ぶ」をお試しください');
    });
  }

  function toEdit() {
    cur.mode = 'edit';
    cur.fw = ui.shot.width;
    cur.fh = ui.shot.height;
    ui.video.hidden = true;
    ui.shot.hidden = false;
    ui.live.hidden = true;
    ui.edit.hidden = false;
    drawCrop();
    setMsg('読み取る表を枠で囲んでください（角で大きさ・中で位置。枠の外をなぞると囲み直せます）');
  }

  function capture() {
    if (!cur || cur.mode !== 'live') return;
    var v = ui.video;
    if (!v.videoWidth) { setMsg('カメラの準備ができるまでお待ちください'); return; }
    ui.shot.width = v.videoWidth;
    ui.shot.height = v.videoHeight;
    ui.shot.getContext('2d').drawImage(v, 0, 0);
    stopCam();
    toEdit();
  }

  function onFile() {
    var f = ui.file.files && ui.file.files[0];
    ui.file.value = '';
    if (!f || !cur || cur.mode === 'busy') return;
    var url = URL.createObjectURL(f), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      if (!cur) return;
      useImage(img, img.naturalWidth, img.naturalHeight);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      if (cur) setMsg('この写真は開けませんでした');
    };
    img.src = url;
  }

  // 写真(または確かめ用の絵)を読み取り画面に出す
  function useImage(img, w, h) {
    var s = Math.min(1, MAX_PHOTO / Math.max(w, h));
    ui.shot.width = Math.max(1, Math.round(w * s));
    ui.shot.height = Math.max(1, Math.round(h * s));
    ui.shot.getContext('2d').drawImage(img, 0, 0, ui.shot.width, ui.shot.height);
    stopCam();
    cur.source = 'photo';
    // 写真は構図がまちまちなので、枠は絵のほぼ全体から始める
    cur.rect = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
    toEdit();
  }

  function mb(n) { return (n / 1e6).toFixed(1); }

  function readRect() {
    if (!cur || cur.mode !== 'edit' || !global.LabelOcr) return;
    var r = cur.rect, W = ui.shot.width, H = ui.shot.height;
    var x = clamp(Math.floor(r.x * W), 0, W - 1), y = clamp(Math.floor(r.y * H), 0, H - 1);
    var w = clamp(Math.ceil(r.w * W), 1, W - x), h = clamp(Math.ceil(r.h * H), 1, H - y);
    var crop = makeCanvas(w, h);
    crop.getContext('2d').drawImage(ui.shot, x, y, w, h, 0, 0, w, h);
    var mine = cur;
    mine.mode = 'busy';
    setBusy(engine ? '読み取り中…' : '文字認識を準備中…');
    read(crop, function (stage, a, b) {
      if (cur !== mine) return;
      if (stage === 'load') setBusy('文字認識の部品を読み込み中（初回だけ）\n' + mb(a) + ' / ' + mb(b) + ' MB');
      else if (stage === 'detect') setBusy('文字を探しています…');
      else if (stage === 'rec') setBusy('読み取り中… ' + a + ' / ' + b);
    }).then(function (res) {
      crop.width = crop.height = 1;
      if (cur !== mine) return;   // 途中で閉じられた
      if (!res.text.trim()) {
        mine.mode = 'edit';
        setBusy(null);
        setMsg('文字が見つかりませんでした。枠を表に合わせ直すか、撮り直してください');
        return;
      }
      finish(res.text);
    }).catch(function (err) {
      crop.width = crop.height = 1;
      if (cur !== mine) return;
      mine.mode = 'edit';
      setBusy(null);
      setMsg('読み取れませんでした（' + ((err && err.message) || err) + '）。' +
        (engine ? 'もう一度お試しください' : '初回は部品の読み込みが要ります。通信できる場所でもう一度お試しください'));
    });
  }

  function finish(text) {
    if (!cur) return;
    var done = cur;
    cur = null;
    stopCam();
    setBusy(null);
    ui.root.hidden = true;
    ui.shot.width = ui.shot.height = 1;   // 写真のメモリを手放す
    document.body.classList.remove('lcam-open');
    done.resolve(text || null);
  }

  /* 開く。読んだ文字(読めなければ null)で終わる Promise を返す */
  function open() {
    initUi();
    if (cur) return cur.promise;
    var resolveFn;
    var promise = new Promise(function (r) { resolveFn = r; });
    cur = { resolve: resolveFn, promise: promise, mode: 'live', source: 'camera', fw: 0, fh: 0, rect: loadRect() };
    ui.root.hidden = false;
    document.body.classList.add('lcam-open');
    toLive();
    // 構えているあいだに部品を読み込んでおく(初回は約33MB。失敗は読み取るときに伝える)
    if (!engine) prepare().catch(function () { return null; });
    return promise;
  }

  global.LabelCam = {
    open: open,
    // 机上で確かめるための入口(カメラの無い環境で、写真を選んだのと同じ状態にする)
    _useImage: function (img) {
      if (!cur) open();
      useImage(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    },
    _state: function () { return cur && { mode: cur.mode, source: cur.source, rect: cur.rect, fw: cur.fw, fh: cur.fh }; },
    _read: readRect
  };

  global.LabelOcr = {
    prepare: prepare,
    read: read,
    ready: function () { return !!engine; },
    totalBytes: TOTAL_BYTES,
    // 机上で確かめるための入口
    _detect: function (src) { return prepare().then(function (e) { return detect(e, src); }); },
    _recognize: function (crop) { return prepare().then(function (e) { return recognize(e, crop); }); },
    _cropBox: cropBox,
    _tightenLines: tightenLines,
    _engine: function () { return engine; },
    _assemble: assemble,
    _minAreaRect: minAreaRect
  };
})(window);
