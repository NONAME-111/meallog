/* ui-meal.js - 食事記録タブ */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  var SLOTS = [
    { key: 'breakfast', name: '朝食', icon: '🌅' },
    { key: 'lunch', name: '昼食', icon: '☀️' },
    { key: 'dinner', name: '夕食', icon: '🌙' },
    { key: 'snack', name: '間食', icon: '🍪' }
  ];

  function A() { return global.App; }

  /* ---------------- 一覧描画 ---------------- */
  function render(view, state) {
    return S.Entries.byDate(state.date).then(function (entries) {
      return Promise.all([
        entries,
        S.Exercise.byDate(state.date),
        A().targetsFor(state.date),
        S.dayTotals(state.date, entries)
      ]);
    }).then(function (r) {
      var entries = r[0], exercises = r[1], tinfo = r[2], dt = r[3];
      var tg = tinfo.tg;
      var totals = dt.totals;
      var burned = exercises.reduce(function (a, x) { return a + (x.kcal || 0); }, 0);

      var html = summaryHtml(totals, tg, burned);
      SLOTS.forEach(function (sl) {
        html += slotHtml(sl, entries.filter(function (e) { return e.slot === sl.key; }));
      });
      html += exerciseHtml(exercises, burned);
      html += '<div class="tiny muted" style="padding:4px 2px 0">栄養値の出典: ' +
        A().esc(F.source() || '日本食品標準成分表(八訂)増補2023年 / 文部科学省') + '</div>';
      view.innerHTML = html;
      bind(view, state);
    });
  }

  function summaryHtml(t, tg, burned) {
    var kcal = Math.round(t.kcal || 0);
    var goal = tg.kcal.goal;
    var net = kcal - burned;
    var pct = goal ? Math.min(100, Math.round(net / goal * 100)) : 0;
    var over = net > goal;
    var rest = goal - net;
    return '' +
      '<div class="summary">' +
        '<div class="sum-main">' +
          '<div><span class="sum-kcal">' + kcal + '</span><span class="sum-unit">kcal</span></div>' +
          '<div class="sum-goal">目標 ' + goal + ' kcal</div>' +
        '</div>' +
        '<div class="bar' + (over ? ' over' : '') + '"><i style="width:' + pct + '%"></i></div>' +
        '<div class="sum-goal">' +
          (burned ? '運動 -' + burned + ' kcal ／ ' : '') +
          (over ? 'あと ' + Math.abs(rest) + ' kcal オーバー' : 'あと ' + rest + ' kcal') +
        '</div>' +
        '<div class="pfc">' +
          pfcCell('P たんぱく質', t.protein, tg.protein.goal, 'g') +
          pfcCell('F 脂質', t.fat, tg.fat.goal, 'g') +
          pfcCell('C 炭水化物', t.carb, tg.carb.goal, 'g') +
        '</div>' +
      '</div>';
  }

  function pfcCell(label, v, goal, unit) {
    return '<div><b>' + Math.round(v || 0) + '<span style="font-size:10px">/' + goal + unit + '</span></b>' +
      '<span>' + label + '</span></div>';
  }

  function slotHtml(sl, items) {
    var kcal = items.reduce(function (a, e) { return a + ((e.nutrients && e.nutrients.kcal) || 0); }, 0);
    var h = '<div class="card" data-slot="' + sl.key + '">' +
      '<div class="slot-head"><span class="slot-name">' + sl.icon + ' ' + sl.name + '</span>' +
      '<span class="slot-kcal">' + Math.round(kcal) + ' kcal</span></div>';
    if (!items.length) {
      h += '<div class="empty">記録がありません</div>';
    } else {
      items.forEach(function (e) {
        var n = e.nutrients || {};
        h += '<div class="item" data-entry="' + A().esc(e.id) + '">' +
          '<div class="grow"><div class="item-name ellip">' + A().esc(e.name) + '</div>' +
          '<div class="item-sub">' + A().esc(amountText(e)) +
          ' ・ P' + N.fmt(n.protein || 0) + ' F' + N.fmt(n.fat || 0) + ' C' + N.fmt(n.carb || 0) + '</div></div>' +
          '<div class="item-kcal">' + Math.round(n.kcal || 0) + '</div></div>';
      });
    }
    h += '<div class="add-row">' +
      '<button class="btn sub sm" data-add="' + sl.key + '">＋ 食品を追加</button>' +
      '<button class="btn sub sm" data-scan="' + sl.key + '">📷 バーコード</button>' +
      '</div></div>';
    return h;
  }

  function amountText(e) {
    var u = e.unit || 'g';
    if (u === 'g') return Math.round(e.amount) + ' g';
    return (Math.round(e.amount * 100) / 100) + ' ' + u;
  }

  function exerciseHtml(list, burned) {
    var h = '<div class="card"><div class="slot-head"><span class="slot-name">🏃 運動</span>' +
      '<span class="slot-kcal">-' + Math.round(burned) + ' kcal</span></div>';
    if (!list.length) h += '<div class="empty">記録がありません</div>';
    else list.forEach(function (x) {
      h += '<div class="item" data-ex="' + A().esc(x.id) + '"><div class="grow">' +
        '<div class="item-name ellip">' + A().esc(x.name) + '</div>' +
        '<div class="item-sub">' + Math.round(x.minutes) + ' 分</div></div>' +
        '<div class="item-kcal">-' + Math.round(x.kcal) + '</div></div>';
    });
    h += '<div class="add-row"><button class="btn sub sm" data-addex="1">＋ 運動を追加</button></div></div>';
    return h;
  }

  /* ---------------- イベント ---------------- */
  function bind(view, state) {
    view.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-add],[data-scan],[data-entry],[data-addex],[data-ex]');
      if (!t) return;
      if (t.dataset.add) return openAdd(state, t.dataset.add);
      if (t.dataset.scan) return scanFlow(state, t.dataset.scan);
      if (t.dataset.entry) return openEntry(state, t.dataset.entry);
      if (t.dataset.addex) return openExercise(state, null);
      if (t.dataset.ex) return openExercise(state, t.dataset.ex);
    });
  }

  /* ---------------- 追加シート ---------------- */
  function openAdd(state, slot) {
    var html = '' +
      '<div class="seg" id="addSeg">' +
        '<button class="on" data-src="common">よく使う</button>' +
        '<button data-src="seibun">成分表</button>' +
        '<button data-src="my">マイ食品</button>' +
        '<button data-src="hist">履歴</button>' +
      '</div>' +
      '<div class="row" style="margin-bottom:10px">' +
        '<input type="text" id="q" placeholder="食品名で検索（例: ごはん、鶏むね）" autocomplete="off">' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-bottom:10px">' +
        '<button class="btn line sm grow" id="btnScan">📷 バーコード</button>' +
        '<button class="btn line sm grow" id="btnManual">✏️ 手入力で登録</button>' +
      '</div>' +
      '<div id="results"></div>';
    var body = A().openSheet(slotName(slot) + 'に追加', html);
    var q = body.querySelector('#q');
    var results = body.querySelector('#results');
    var src = 'common';

    function show(list, kind) {
      if (!list.length) {
        results.innerHTML = '<div class="empty">' +
          (kind === 'seibun' ? '該当する食品がありません' : 'まだ登録がありません') + '</div>';
        return;
      }
      results.innerHTML = list.map(function (x) { return resRow(x, kind); }).join('');
    }

    function showCommon(data, text) {
      var items = data.items;
      if (text) {
        var n = F.norm(text);
        items = items.filter(function (x) {
          return F.norm(x.label).indexOf(n) !== -1 || F.norm(x.src).indexOf(n) !== -1;
        });
        show(items, 'common');
        return;
      }
      var html2 = '';
      data.cats.forEach(function (c) {
        var group = items.filter(function (x) { return x.cat === c; });
        if (!group.length) return;
        html2 += '<div class="tiny muted" style="margin:12px 0 2px;font-weight:700">' +
          A().esc(c) + '</div>' + group.map(function (x) { return resRow(x, 'common'); }).join('');
      });
      results.innerHTML = html2;
    }

    function doSearch() {
      var text = q.value.trim();
      if (src === 'common') {
        F.loadCommon().then(function (data) { showCommon(data, text); });
      } else if (src === 'seibun') {
        if (!text) { results.innerHTML = '<div class="empty">食品名を入力してください</div>'; return; }
        F.search(text, { limit: 80 }).then(function (list) { show(list, 'seibun'); });
      } else if (src === 'my') {
        S.MyFoods.all().then(function (list) {
          if (text) {
            var n = F.norm(text);
            list = list.filter(function (x) { return F.norm(x.name + (x.brand || '')).indexOf(n) !== -1; });
          }
          show(list, 'my');
        });
      } else {
        S.Entries.recent(80).then(function (list) {
          if (text) {
            var n = F.norm(text);
            list = list.filter(function (x) { return F.norm(x.name).indexOf(n) !== -1; });
          }
          show(list, 'hist');
        });
      }
    }

    var timer = 0;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(doSearch, 180);
    });
    body.querySelector('#addSeg').addEventListener('click', function (e) {
      var b = e.target.closest('[data-src]');
      if (!b) return;
      src = b.dataset.src;
      Array.prototype.forEach.call(body.querySelectorAll('#addSeg button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      doSearch();
    });
    body.querySelector('#btnScan').addEventListener('click', function () { scanFlow(state, slot); });
    body.querySelector('#btnManual').addEventListener('click', function () {
      openManual(state, slot, null);
    });

    results.addEventListener('click', function (e) {
      var row = e.target.closest('[data-pick]');
      if (!row) return;
      var kind = row.dataset.kind, id = row.dataset.pick;
      if (kind === 'common') {
        F.loadCommon().then(function (data) {
          var it = data.items.filter(function (x) { return x.label === id; })[0];
          if (!it) return;
          F.byId(it.id).then(function (f) {
            if (!f) return;
            var pick = fromSeibun(f);
            pick.name = it.label;
            pick.defaultAmount = it.g;
            pick.note = f.n;
            openAmount(state, slot, pick);
          });
        });
      } else if (kind === 'seibun') {
        F.byId(id).then(function (f) { if (f) openAmount(state, slot, fromSeibun(f)); });
      } else if (kind === 'my') {
        S.MyFoods.get(id).then(function (m) { if (m) openAmount(state, slot, fromMyFood(m)); });
      } else {
        S.Entries.byDate(row.dataset.date).then(function (rows) {
          var src2 = rows.filter(function (x) { return x.id === id; })[0];
          if (src2) openAmount(state, slot, fromEntry(src2));
        });
      }
    });

    doSearch();
    setTimeout(function () { q.focus(); }, 60);
  }

  function slotName(k) {
    for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].key === k) return SLOTS[i].name;
    return '食事';
  }

  function resRow(x, kind) {
    if (kind === 'common') {
      return '<button class="res" data-pick="' + A().esc(x.label) + '" data-kind="common">' +
        '<b>' + A().esc(x.label) + '</b><span>' + x.g + 'g ・ ' + x.kcal + ' kcal ／ ' +
        A().esc(x.src) + '</span></button>';
    }
    if (kind === 'seibun') {
      return '<button class="res" data-pick="' + A().esc(x.id) + '" data-kind="seibun">' +
        '<b>' + A().esc(x.n) + '</b><span>' + A().esc(F.groupName(x.g)) +
        ' ・ 100gあたり ' + Math.round(x.kcal) + ' kcal</span></button>';
    }
    if (kind === 'my') {
      var per = x.basis === 'serving' ? ('1' + (x.servingLabel || '食') + 'あたり') : '100gあたり';
      return '<button class="res" data-pick="' + A().esc(x.id) + '" data-kind="my">' +
        '<b>' + A().esc(x.name) + '</b><span>' + (x.brand ? A().esc(x.brand) + ' ・ ' : '') +
        per + ' ' + Math.round((x.nutrients && x.nutrients.kcal) || 0) + ' kcal' +
        (x.barcode ? ' ・ バーコード登録済' : '') + '</span></button>';
    }
    return '<button class="res" data-pick="' + A().esc(x.id) + '" data-kind="hist" data-date="' +
      A().esc(x.date) + '"><b>' + A().esc(x.name) + '</b><span>' + A().esc(amountText(x)) +
      ' ・ ' + Math.round((x.nutrients && x.nutrients.kcal) || 0) + ' kcal ・ ' + A().esc(x.date) +
      '</span></button>';
  }

  /* ---- 選択された食品を共通形式へ ---- */
  function fromSeibun(f) {
    return {
      name: f.n, basis: '100g', per: f, unit: 'g', defaultAmount: 100,
      ref: { type: 'seibun', id: f.id }, note: F.groupName(f.g)
    };
  }
  function fromMyFood(m) {
    return {
      name: m.name, basis: m.basis || '100g', per: m.nutrients,
      unit: m.basis === 'serving' ? (m.servingLabel || '食') : 'g',
      defaultAmount: m.basis === 'serving' ? 1 : 100,
      ref: { type: 'my', id: m.id }, note: m.brand || ''
    };
  }
  function fromEntry(e) {
    // 履歴からのコピー: 記録済みの栄養値をそのまま単位量に戻す
    var amount = e.amount || 1;
    var per = {};
    var factor = (e.unit === 'g') ? (100 / amount) : (1 / amount);
    for (var k in (e.nutrients || {})) {
      if (typeof e.nutrients[k] === 'number') per[k] = e.nutrients[k] * factor;
    }
    return {
      name: e.name, basis: (e.unit === 'g') ? '100g' : 'serving', per: per,
      unit: e.unit || 'g', defaultAmount: amount, ref: e.ref || { type: 'manual' }, note: ''
    };
  }

  /* ---------------- 数量入力シート ---------------- */
  function openAmount(state, slot, pick, existingId) {
    var isG = (pick.basis === '100g');
    var quick = isG ? [30, 50, 80, 100, 150, 200, 250] : [0.5, 1, 1.5, 2, 3];
    var html = '' +
      '<div class="card"><b>' + A().esc(pick.name) + '</b>' +
      (pick.note ? '<div class="tiny muted">' + A().esc(pick.note) + '</div>' : '') + '</div>' +
      '<div class="card">' +
        '<label class="fld"><span>' + (isG ? '重さ (g)' : '個数 (' + A().esc(pick.unit) + ')') + '</span>' +
        '<input type="number" id="amt" inputmode="decimal" step="' + (isG ? '1' : '0.1') + '" value="' +
        pick.defaultAmount + '"></label>' +
        '<div id="chips">' + quick.map(function (v) {
          return '<button class="chip" data-q="' + v + '">' + v + (isG ? 'g' : '') + '</button>';
        }).join('') + '</div>' +
        '<hr class="sep">' +
        '<div id="preview"></div>' +
      '</div>' +
      '<button class="btn wide" id="save">' + (existingId ? '更新する' : 'この内容で記録する') + '</button>' +
      (existingId ? '<button class="btn sub wide" id="del" style="margin-top:8px">削除する</button>' : '');

    var body = A().openSheet(existingId ? '記録を編集' : slotName(slot) + 'に追加', html);
    var amt = body.querySelector('#amt');
    var prev = body.querySelector('#preview');

    function calc() {
      var a = parseFloat(amt.value);
      if (!isFinite(a) || a < 0) a = 0;
      var out = {};
      var r = isG ? (a / 100) : a;
      for (var k in pick.per) {
        if (typeof pick.per[k] === 'number') out[k] = F.round(pick.per[k] * r, 3);
      }
      out.sugar = F.sugarOf(out);
      return { amount: a, n: out };
    }

    function draw() {
      var c = calc();
      var n = c.n;
      prev.innerHTML = '<div class="row between"><b style="font-size:22px">' +
        Math.round(n.kcal || 0) + ' kcal</b><span class="small muted">' +
        (isG ? Math.round(c.amount) + ' g' : c.amount + ' ' + A().esc(pick.unit)) + '</span></div>' +
        '<div class="small muted" style="margin-top:6px">たんぱく質 ' + N.fmt(n.protein || 0) +
        'g ・ 脂質 ' + N.fmt(n.fat || 0) + 'g ・ 炭水化物 ' + N.fmt(n.carb || 0) +
        'g ・ 食塩 ' + N.fmt(n.salt || 0) + 'g</div>';
    }

    amt.addEventListener('input', draw);
    body.querySelector('#chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-q]');
      if (!b) return;
      amt.value = b.dataset.q;
      draw();
    });
    body.querySelector('#save').addEventListener('click', function () {
      var c = calc();
      if (!c.amount) { A().toast('数量を入力してください'); return; }
      var rec = {
        id: existingId || undefined,
        date: state.date, slot: slot, name: pick.name,
        amount: c.amount, unit: pick.unit, nutrients: c.n, ref: pick.ref
      };
      S.Entries.put(rec).then(function () {
        if (pick.ref && pick.ref.type === 'my') S.MyFoods.touch(pick.ref.id);
        A().closeSheet();
        A().toast('記録しました');
        A().render();
      });
    });
    var delBtn = body.querySelector('#del');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('この記録を削除しますか？')) return;
        S.Entries.remove(existingId).then(function () {
          A().closeSheet(); A().toast('削除しました'); A().render();
        });
      });
    }
    draw();
  }

  /* ---------------- 記録の編集 ---------------- */
  function openEntry(state, id) {
    S.Entries.byDate(state.date).then(function (rows) {
      var e = rows.filter(function (x) { return x.id === id; })[0];
      if (!e) return;
      openAmount(state, e.slot, fromEntry(e), e.id);
    });
  }

  /* ---------------- 手入力登録 ---------------- */
  function openManual(state, slot, preset) {
    preset = preset || {};
    var html = '' +
      '<div class="card">' +
        '<label class="fld"><span>食品名</span><input type="text" id="mName" value="' +
          A().esc(preset.name || '') + '" placeholder="例: セブン ゆで卵"></label>' +
        '<label class="fld"><span>メーカー・ブランド(任意)</span><input type="text" id="mBrand" value="' +
          A().esc(preset.brand || '') + '"></label>' +
        '<label class="fld"><span>入力の基準</span><select id="mBasis">' +
          '<option value="serving">1個・1食あたり</option>' +
          '<option value="100g">100gあたり</option>' +
        '</select></label>' +
        '<label class="fld" id="servWrap"><span>単位の呼び方</span>' +
          '<input type="text" id="mServ" value="' + A().esc(preset.servingLabel || '個') + '" placeholder="個 / 袋 / 食"></label>' +
      '</div>' +
      '<div class="card"><h3>栄養成分</h3>' +
        num('mKcal', 'エネルギー (kcal)', preset.kcal) +
        '<div class="grid2">' + num('mP', 'たんぱく質 (g)', preset.protein) + num('mF', '脂質 (g)', preset.fat) + '</div>' +
        '<div class="grid2">' + num('mC', '炭水化物 (g)', preset.carb) + num('mSalt', '食塩相当量 (g)', preset.salt) + '</div>' +
        '<div class="grid2">' + num('mFib', '食物繊維 (g)', preset.fiber) + num('mSat', '飽和脂肪酸 (g)', preset.satfat) + '</div>' +
        '<div class="tiny muted">パッケージの栄養成分表示をそのまま入力してください。空欄は0として扱います。</div>' +
      '</div>' +
      (preset.barcode ? '<div class="card small">バーコード <b>' + A().esc(preset.barcode) +
        '</b><div class="tiny muted">保存すると次回から自動で呼び出せます</div></div>' : '') +
      '<button class="btn wide" id="mSave">保存して記録する</button>';

    var body = A().openSheet('食品を手入力', html);
    var basis = body.querySelector('#mBasis');
    if (preset.basis) basis.value = preset.basis;
    function toggleServ() {
      body.querySelector('#servWrap').style.display = (basis.value === 'serving') ? '' : 'none';
    }
    basis.addEventListener('change', toggleServ);
    toggleServ();

    body.querySelector('#mSave').addEventListener('click', function () {
      var name = body.querySelector('#mName').value.trim();
      if (!name) { A().toast('食品名を入力してください'); return; }
      var nut = {
        kcal: v(body, '#mKcal'), protein: v(body, '#mP'), fat: v(body, '#mF'),
        carb: v(body, '#mC'), salt: v(body, '#mSalt'), fiber: v(body, '#mFib'),
        satfat: v(body, '#mSat')
      };
      var rec = {
        name: name, brand: body.querySelector('#mBrand').value.trim(),
        basis: basis.value, servingLabel: body.querySelector('#mServ').value.trim() || '個',
        barcode: preset.barcode ? String(preset.barcode) : '',
        nutrients: nut
      };
      S.MyFoods.put(rec).then(function (saved) {
        A().toast('マイ食品に保存しました');
        openAmount(state, slot, fromMyFood(saved));
      });
    });
  }

  function num(id, label, val) {
    return '<label class="fld"><span>' + label + '</span><input type="number" inputmode="decimal" ' +
      'step="0.1" id="' + id + '" value="' + (val == null ? '' : val) + '"></label>';
  }
  function v(body, sel) {
    var x = parseFloat(body.querySelector(sel).value);
    return isFinite(x) ? x : 0;
  }

  /* ---------------- バーコード ---------------- */
  function scanFlow(state, slot) {
    global.Barcode.scan().then(function (code) {
      if (!code) return;
      return S.MyFoods.byBarcode(code).then(function (my) {
        if (my) {
          // (1) 登録済み: 前回入力した内容でそのまま呼び出す
          A().toast('登録済みの商品を読み込みました');
          openAmount(state, slot, fromMyFood(my));
          return;
        }
        // (2) 未登録: Web検索で商品情報を仮表示 -> 編集して保存
        A().toast('商品情報を検索中…');
        return global.Barcode.lookup(code).then(function (p) {
          if (p && (p.name || p.hasNutrition)) {
            openLookupResult(state, slot, code, p);
          } else {
            openBarcodeUnknown(state, slot, code);
          }
        });
      });
    });
  }

  /* Web検索で見つからなかったとき: 既存のマイ食品に紐づけるか、新規に手入力する */
  function openBarcodeUnknown(state, slot, code) {
    var html = '<div class="card"><b>商品情報が見つかりませんでした</b>' +
      '<div class="tiny muted" style="margin-top:6px">バーコード ' + A().esc(code) +
      '<br>公開データベースには日本の商品がまだ少ないため、初回だけ内容を登録してください。' +
      '一度登録すれば、次からはこのバーコードを読むだけで呼び出せます。</div></div>' +
      '<button class="btn wide" id="bNew">内容を手入力して登録</button>' +
      '<div class="card" style="margin-top:12px"><h3>登録済みのマイ食品に紐づける</h3>' +
      '<input type="text" id="bq" placeholder="食品名で絞り込み" autocomplete="off">' +
      '<div id="blist" style="margin-top:8px"></div></div>';
    var body = A().openSheet('バーコードを登録', html);

    body.querySelector('#bNew').addEventListener('click', function () {
      openManual(state, slot, { barcode: code, basis: 'serving' });
    });

    var list = body.querySelector('#blist');
    function draw(text) {
      S.MyFoods.all().then(function (rows) {
        var items = rows.filter(function (x) { return !x.barcode; });
        if (text) {
          var n = F.norm(text);
          items = items.filter(function (x) { return F.norm(x.name).indexOf(n) !== -1; });
        }
        items = items.slice(0, 40);
        list.innerHTML = items.length
          ? items.map(function (m) {
              var per = m.basis === 'serving' ? ('1' + (m.servingLabel || '食')) : '100g';
              return '<button class="res" data-link="' + A().esc(m.id) + '"><b>' + A().esc(m.name) +
                '</b><span>' + per + 'あたり ' + Math.round((m.nutrients && m.nutrients.kcal) || 0) +
                ' kcal</span></button>';
            }).join('')
          : '<div class="empty">該当するマイ食品がありません</div>';
      });
    }
    var timer = 0;
    body.querySelector('#bq').addEventListener('input', function (e) {
      clearTimeout(timer);
      var v = e.target.value.trim();
      timer = setTimeout(function () { draw(v); }, 180);
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-link]');
      if (!b) return;
      S.MyFoods.get(b.getAttribute('data-link')).then(function (m) {
        if (!m) return;
        m.barcode = String(code);
        return S.MyFoods.put(m).then(function (saved) {
          A().toast('このバーコードに紐づけました');
          openAmount(state, slot, fromMyFood(saved));
        });
      });
    });
    draw('');
  }

  function openLookupResult(state, slot, code, p) {
    var n = p.per100 || {};
    var html = '<div class="card">' +
      (p.image ? '<img src="' + A().esc(p.image) + '" alt="" style="max-height:110px;border-radius:8px;margin-bottom:8px">' : '') +
      '<b>' + A().esc(p.name || '(商品名なし)') + '</b>' +
      (p.brand ? '<div class="small muted">' + A().esc(p.brand) + '</div>' : '') +
      '<div class="tiny muted" style="margin-top:6px">バーコード ' + A().esc(code) +
      ' ・ 出典 ' + A().esc(p.source) + '</div></div>' +
      '<div class="card"><h3>取得できた成分（100gあたり）</h3>' +
      (p.hasNutrition
        ? '<div class="small">エネルギー ' + fv(n.kcal, 'kcal') + '／たんぱく質 ' + fv(n.protein, 'g') +
          '／脂質 ' + fv(n.fat, 'g') + '／炭水化物 ' + fv(n.carb, 'g') + '／食塩 ' + fv(n.salt, 'g') + '</div>'
        : '<div class="small muted">成分データは登録されていませんでした</div>') +
      '<div class="tiny muted" style="margin-top:8px">この情報は利用者投稿型のデータベースによるものです。' +
      'パッケージの表示と違う場合は次の画面で修正してください。</div></div>' +
      '<button class="btn wide" id="useIt">この内容を編集して登録</button>';
    var body = A().openSheet('商品が見つかりました', html);
    body.querySelector('#useIt').addEventListener('click', function () {
      openManual(state, slot, {
        name: p.name, brand: p.brand, barcode: code, basis: '100g',
        kcal: n.kcal, protein: n.protein, fat: n.fat, carb: n.carb,
        salt: n.salt, fiber: n.fiber, satfat: n.satfat
      });
    });
  }

  function fv(v2, u) { return (v2 == null ? '—' : N.fmt(v2) + u); }

  /* ---------------- 運動 ---------------- */
  function openExercise(state, id) {
    Promise.all([
      id ? S.Exercise.byDate(state.date) : Promise.resolve([]),
      A().weightFor(state.date)
    ]).then(function (r) {
      var cur = id ? r[0].filter(function (x) { return x.id === id; })[0] : null;
      var w = r[1] || 60;
      var html = '<div class="card">' +
        '<label class="fld"><span>種目</span><select id="exKind">' +
        N.METS.map(function (m, i) {
          return '<option value="' + i + '">' + m.name + '（' + m.met + ' METs）</option>';
        }).join('') + '<option value="-1">その他（自分で入力）</option></select></label>' +
        '<label class="fld" id="exNameWrap" style="display:none"><span>種目名</span>' +
        '<input type="text" id="exName"></label>' +
        '<div class="grid2">' +
        '<label class="fld"><span>時間 (分)</span><input type="number" inputmode="numeric" id="exMin" value="' +
        (cur ? cur.minutes : 30) + '"></label>' +
        '<label class="fld"><span>METs</span><input type="number" inputmode="decimal" step="0.1" id="exMet" value="' +
        (cur ? cur.met : 3.5) + '"></label>' +
        '</div>' +
        '<div class="row between"><span class="small muted">消費カロリー（体重 ' + w + ' kg で計算）</span>' +
        '<b id="exKcal">0 kcal</b></div></div>' +
        '<button class="btn wide" id="exSave">' + (cur ? '更新する' : '記録する') + '</button>' +
        (cur ? '<button class="btn sub wide" id="exDel" style="margin-top:8px">削除する</button>' : '');
      var body = A().openSheet(cur ? '運動を編集' : '運動を追加', html);
      var sel = body.querySelector('#exKind'), min = body.querySelector('#exMin'),
        met = body.querySelector('#exMet'), out = body.querySelector('#exKcal'),
        nameWrap = body.querySelector('#exNameWrap'), nameIn = body.querySelector('#exName');

      if (cur) {
        var idx = -1;
        N.METS.forEach(function (m, i) { if (m.name === cur.name) idx = i; });
        sel.value = String(idx);
        if (idx === -1) { nameWrap.style.display = ''; nameIn.value = cur.name; }
      }
      function calc() {
        var kc = N.burnedKcal(parseFloat(met.value) || 0, parseFloat(min.value) || 0, w);
        out.textContent = kc + ' kcal';
        return kc;
      }
      sel.addEventListener('change', function () {
        var i = parseInt(sel.value, 10);
        if (i >= 0) { met.value = N.METS[i].met; nameWrap.style.display = 'none'; }
        else { nameWrap.style.display = ''; }
        calc();
      });
      min.addEventListener('input', calc);
      met.addEventListener('input', calc);
      body.querySelector('#exSave').addEventListener('click', function () {
        var i = parseInt(sel.value, 10);
        var name = (i >= 0) ? N.METS[i].name : (nameIn.value.trim() || '運動');
        var rec = {
          id: cur ? cur.id : undefined, date: state.date, name: name,
          minutes: parseFloat(min.value) || 0, met: parseFloat(met.value) || 0, kcal: calc()
        };
        S.Exercise.put(rec).then(function () {
          A().closeSheet(); A().toast('記録しました'); A().render();
        });
      });
      var d = body.querySelector('#exDel');
      if (d) d.addEventListener('click', function () {
        if (!confirm('この運動記録を削除しますか？')) return;
        S.Exercise.remove(cur.id).then(function () {
          A().closeSheet(); A().toast('削除しました'); A().render();
        });
      });
      calc();
    });
  }

  Views.meal = { render: render };
})(window);
