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

  /* パッケージ表示には載らない栄養素。似た食材から按分して補う対象。 */
  var MICRO = ['chol', 'k', 'ca', 'mg', 'fe', 'zn', 'vita', 'vitd', 'vite',
    'vitb1', 'vitb2', 'niacin', 'vitb6', 'vitb12', 'folate', 'vitc'];

  /* 名前が検索語に当たるか。かなだけで入力されたときは漢字を読み下して照合する。 */
  function nameHit(name, q, kana) {
    var n = F.norm(name);
    return n.indexOf(q) !== -1 || (kana && F.kanaContains(n, q));
  }

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

      // カロリーしか持たない食品が混ざっていて、日次集計の補完も無い日は
      // PFCが0のままになるので、その理由を出す
      var real = entries.filter(S.notSkip);
      var noPfc = real.filter(function (e) { return !hasPfc(e.nutrients); }).length;
      var html = summaryHtml(totals, tg, burned,
        (!dt.imported && noPfc) ? noPfc : 0, real.length);
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

  function summaryHtml(t, tg, burned, noPfc, total) {
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
        (noPfc
          ? '<div class="sum-note">' + noPfc + '／' + total +
            '品はカロリーしか登録されていないため、PFCに反映されていません。' +
            'その食品をタップ →「栄養素を入力」で補えます。</div>'
          : '') +
      '</div>';
  }

  /* 取り込んだ過去データなど、カロリーしか持たない食品があるので、
     「値が無い」を 0 と見せないための判定 */
  function hasPfc(n) {
    n = n || {};
    return typeof n.protein === 'number' || typeof n.fat === 'number' ||
      typeof n.carb === 'number';
  }

  function pfcCell(label, v, goal, unit) {
    return '<div><b>' + Math.round(v || 0) + '<span style="font-size:10px">/' + goal + unit + '</span></b>' +
      '<span>' + label + '</span></div>';
  }

  function slotHtml(sl, allItems) {
    var skipped = allItems.some(S.isSkip);
    var items = allItems.filter(S.notSkip);
    var kcal = items.reduce(function (a, e) { return a + ((e.nutrients && e.nutrients.kcal) || 0); }, 0);
    var h = '<div class="card" data-slot="' + sl.key + '">' +
      '<div class="slot-head"><span class="slot-name">' + sl.icon + ' ' + sl.name + '</span>' +
      '<span class="slot-kcal">' + (skipped ? '食べなかった' : Math.round(kcal) + ' kcal') +
      '</span></div>';
    if (skipped) {
      h += '<div class="empty">この食事は食べませんでした</div>' +
        '<div class="add-row"><button class="btn sub sm" data-unskip="' + sl.key +
        '">記録できるように戻す</button></div></div>';
      return h;
    }
    if (!items.length) {
      h += '<div class="empty">記録がありません</div>';
    } else {
      items.forEach(function (e) {
        var n = e.nutrients || {};
        var pfc = hasPfc(n)
          ? ' ・ P' + N.fmt(n.protein || 0) + ' F' + N.fmt(n.fat || 0) + ' C' + N.fmt(n.carb || 0)
          : ' ・ <span class="muted">P— F— C—（栄養素は未登録）</span>';
        h += '<div class="item" data-entry="' + A().esc(e.id) + '">' +
          '<div class="grow"><div class="item-name ellip">' + A().esc(e.name) + '</div>' +
          '<div class="item-sub">' + A().esc(amountText(e)) + pfc + '</div></div>' +
          '<div class="item-kcal">' + Math.round(n.kcal || 0) + '</div></div>';
      });
    }
    h += '<div class="add-row">' +
      '<button class="btn sub sm" data-add="' + sl.key + '">＋ 食品を追加</button>' +
      '<button class="btn sub sm" data-scan="' + sl.key + '">📷 バーコード</button>' +
      '</div>' +
      (items.length ? '' :
        '<div class="add-row"><button class="btn sub sm" data-skip="' + sl.key +
        '">🚫 食べなかった</button></div>') +
      '</div>';
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
      var t = ev.target.closest(
        '[data-add],[data-scan],[data-entry],[data-addex],[data-ex],[data-skip],[data-unskip]');
      if (!t) return;
      if (t.dataset.skip) {
        return S.Entries.setSkipped(state.date, t.dataset.skip, true).then(function () {
          A().toast(slotName(t.dataset.skip) + 'を「食べなかった」にしました');
          A().render();
        });
      }
      if (t.dataset.unskip) {
        return S.Entries.setSkipped(state.date, t.dataset.unskip, false).then(function () {
          A().render();
        });
      }
      if (t.dataset.add) return openAdd(state, t.dataset.add);
      if (t.dataset.scan) return scanFlow(state, t.dataset.scan);
      if (t.dataset.entry) return openEntry(state, t.dataset.entry);
      if (t.dataset.addex) return openExercise(state, null);
      if (t.dataset.ex) return openExercise(state, t.dataset.ex);
    });
  }

  /* ---------------- 追加シート ----------------
     区分は「よく使う(実際に食べた回数順)／セット(自分で組み合わせた食事)／履歴」の3つ。
     検索欄に文字を入れたときは区分をまたいで横断検索し、食材(成分表)もここに出す。 */
  var SRC_TABS = [
    { key: 'used', label: 'よく使う' },
    { key: 'combo', label: 'セット' },
    { key: 'hist', label: '履歴' }
  ];

  function openAdd(state, slot, opts) {
    opts = opts || {};
    var st = (A().state.settings) || {};
    var src = opts.src || st.lastAddSrc || 'used';
    if (!SRC_TABS.filter(function (t) { return t.key === src; }).length) src = 'used';
    var histSlot = (opts.histSlot != null) ? opts.histSlot : (st.lastHistSlot || '');

    var html = '' +
      '<div class="seg" id="addSeg">' +
        SRC_TABS.map(function (t) {
          return '<button' + (t.key === src ? ' class="on"' : '') +
            ' data-src="' + t.key + '">' + t.label + '</button>';
        }).join('') +
      '</div>' +
      '<div class="row" style="margin-bottom:10px">' +
        '<input type="text" id="q" placeholder="食品名で検索（例: とりむね、なす、ごはん）" ' +
        'autocomplete="off" value="' + A().esc(opts.query || '') + '">' +
      '</div>' +
      '<div id="slotFilter" class="chips-row"' + (src === 'hist' ? '' : ' hidden') + '>' +
        [{ key: '', label: '全部' }].concat(SLOTS.map(function (s2) {
          return { key: s2.key, label: s2.icon + ' ' + s2.name };
        })).map(function (f) {
          return '<button class="chip' + (f.key === histSlot ? ' on' : '') +
            '" data-hslot="' + f.key + '">' + f.label + '</button>';
        }).join('') +
      '</div>' +
      '<div class="row" style="gap:8px;margin:10px 0">' +
        '<button class="btn line sm grow" id="btnScan">📷 バーコード</button>' +
        '<button class="btn line sm grow" id="btnManual">✏️ 手入力で登録</button>' +
      '</div>' +
      '<div id="results"></div>';

    var body = A().openSheet(slotName(slot) + 'に追加', html);
    var q = body.querySelector('#q');
    var results = body.querySelector('#results');
    var slotFilter = body.querySelector('#slotFilter');

    /* 1文字打つたびに18,000件超の記録をIndexedDBから読み直すと重いので、
       このシートを開いているあいだは結果を使い回す。
       記録を足したあとは openAdd 自体が作り直されるため、自然に新しくなる。 */
    var memo = {};
    function once(k, fn) {
      if (!memo[k]) memo[k] = fn();
      return memo[k];
    }
    function usedList() { return once('used', function () { return S.Entries.topUsed(400); }); }
    function histList() {
      return once('hist:' + histSlot, function () {
        return S.Entries.recent(400, { slot: histSlot || null });
      });
    }
    function comboList() { return once('combos', function () { return S.Combos.all(); }); }

    // 数量入力などから戻ってきたときに、同じ場所を開き直すための関数
    function restorer() {
      openAdd(state, slot, { src: src, query: q.value, histSlot: histSlot });
    }

    /* 成分表に無い商品名・チェーン名のために、WEB検索して取り込む導線を出す */
    function webRow(text) {
      if (!text) return '';
      return '<button class="btn line wide" data-web="1" style="margin-top:14px">' +
        '🔎 「' + A().esc(text) + '」をWEBで検索して取り込む</button>' +
        '<div class="tiny muted" style="margin-top:6px">成分表に載っていない市販品・外食メニューは、' +
        'こちらから商品データベースを検索できます。</div>';
    }

    function group(title, hint, rows) {
      if (!rows) return '';
      return '<div class="tiny muted" style="margin:14px 0 4px;font-weight:700">' + A().esc(title) +
        (hint ? '<span style="font-weight:400"> ・ ' + A().esc(hint) + '</span>' : '') + '</div>' + rows;
    }

    /* ---- 区分ごとの一覧(検索欄が空のとき) ---- */
    function browse() {
      if (src === 'used') {
        usedList().then(function (all) {
          var list = all.slice(0, 60);
          if (!list.length) {
            results.innerHTML = '<div class="empty">まだ記録がありません。<br>' +
              '食べたものを記録していくと、ここによく食べる順で並びます。</div>';
            return;
          }
          results.innerHTML =
            '<div class="tiny muted" style="margin-bottom:4px">実際に食べた回数の多い順</div>' +
            list.map(function (x) { return resRow(x, 'used'); }).join('');
        });
        return;
      }
      if (src === 'combo') {
        comboList().then(function (list) {
          var head = '<button class="btn line wide" id="newCombo" style="margin-bottom:10px">' +
            '＋ 新しいセットを作る</button>' +
            '<div class="tiny muted" style="margin-bottom:8px">' +
            'いつも一緒に食べる組み合わせを1つにまとめておけます' +
            '（例:「魚定食」= さば1切れ + ごはん150g + 豆腐 + 納豆）。' +
            '選ぶと中身をまとめて記録します。</div>';
          results.innerHTML = head + (list.length
            ? list.map(function (x) { return resRow(x, 'combo'); }).join('')
            : '<div class="empty">まだセットがありません</div>');
        });
        return;
      }
      histList().then(function (all2) {
        var list = all2.slice(0, 80);
        results.innerHTML = list.length
          ? list.map(function (x) { return resRow(x, 'hist'); }).join('')
          : '<div class="empty">' + (histSlot ? slotName(histSlot) + 'の' : '') +
            '記録がありません</div>';
      });
    }

    /* ---- 横断検索(検索欄に文字があるとき) ---- */
    function searchAll(text) {
      var n = F.norm(text);
      var kana = F.isKanaQuery(n);
      return Promise.all([
        F.searchCommon(text, { limit: 24 }),
        usedList(),
        histList(),
        comboList(),
        F.search(text, { limit: 24 })
      ]).then(function (r) {
        var commons = r[0];
        var used = r[1].filter(function (x) { return nameHit(x.name, n, kana); }).slice(0, 12);
        var usedNames = {};
        used.forEach(function (x) { usedNames[x.name] = 1; });
        var hist = r[2].filter(function (x) {
          return nameHit(x.name, n, kana) && !usedNames[x.name];
        }).slice(0, 20);
        var combos = r[3].filter(function (x) { return nameHit(x.name, n, kana); });
        // 友好名で出したものと同じ食品番号は、生の成分表側からは省く
        var shown = {};
        commons.forEach(function (c) { shown[c.id] = 1; });
        var seibun = r[4].filter(function (f) { return !shown[f.id]; }).slice(0, 16);

        var html2 = '';
        if (combos.length) {
          html2 += group('セット', '', combos.map(function (x) { return resRow(x, 'combo'); }).join(''));
        }
        if (used.length) {
          html2 += group('よく使う', '食べた回数順',
            used.map(function (x) { return resRow(x, 'used'); }).join(''));
        }
        if (commons.length) {
          html2 += group('食材', '1食分の目安つき',
            commons.map(function (x) { return resRow(x, 'common'); }).join(''));
        }
        if (hist.length) {
          html2 += group('履歴' + (histSlot ? '（' + slotName(histSlot) + '）' : ''), '',
            hist.map(function (x) { return resRow(x, 'hist'); }).join(''));
        }
        if (seibun.length) {
          html2 += group('成分表のほかの候補', '素材そのものの100gあたり',
            seibun.map(function (x) { return resRow(x, 'seibun'); }).join(''));
        }
        results.innerHTML = (html2 || '<div class="empty">該当する食品がありません</div>') + webRow(text);
      });
    }

    function doSearch() {
      var text = q.value.trim();
      if (!text) { browse(); return; }
      searchAll(text);
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
      slotFilter.hidden = (src !== 'hist');
      S.Settings.save({ lastAddSrc: src }).then(function () { return A().reloadSettings(); });
      doSearch();
    });

    slotFilter.addEventListener('click', function (e) {
      var b = e.target.closest('[data-hslot]');
      if (!b) return;
      histSlot = b.dataset.hslot;
      Array.prototype.forEach.call(slotFilter.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      S.Settings.save({ lastHistSlot: histSlot }).then(function () { return A().reloadSettings(); });
      doSearch();
    });

    body.querySelector('#btnScan').addEventListener('click', function () {
      A().pushSheet(restorer); scanFlow(state, slot);
    });
    body.querySelector('#btnManual').addEventListener('click', function () {
      A().pushSheet(restorer); openManual(state, slot, null);
    });

    results.addEventListener('click', function (e) {
      if (e.target.closest('#newCombo')) {
        A().pushSheet(restorer); openComboEdit(state, slot, null);
        return;
      }
      if (e.target.closest('[data-web]')) {
        A().pushSheet(restorer); openWebSearch(state, slot, q.value.trim());
        return;
      }
      var row = e.target.closest('[data-pick]');
      if (!row) return;
      var kind = row.dataset.kind, id = row.dataset.pick;
      A().pushSheet(restorer);

      if (kind === 'common') {
        F.commonById(id).then(function (it) {
          if (!it) { A().backSheet(); return; }
          F.byId(it.id).then(function (f) {
            if (!f) { A().backSheet(); return; }
            var pick = fromSeibun(f);
            pick.name = it.label;
            pick.defaultAmount = it.g;
            pick.note = it.unitLabel ? (it.unitLabel + ' ' + it.g + 'g ・ ' + f.n) : f.n;
            openAmount(state, slot, pick);
          });
        });
      } else if (kind === 'seibun') {
        F.byId(id).then(function (f) {
          if (f) openAmount(state, slot, fromSeibun(f)); else A().backSheet();
        });
      } else if (kind === 'combo') {
        S.Combos.get(id).then(function (c) {
          if (c) openComboUse(state, slot, c); else A().backSheet();
        });
      } else if (kind === 'used') {
        // 実績: 直近に食べたときの記録をそのまま複製する
        S.Entries.recent(400).then(function (rows) {
          var e2 = rows.filter(function (x) { return x.name === id; })[0];
          if (!e2) { A().backSheet(); return; }
          var pick = fromEntry(e2);
          pick.defaultAmount = parseFloat(row.dataset.amt) || pick.defaultAmount;
          openAmount(state, slot, pick);
        });
      } else {
        S.Entries.byDate(row.dataset.date).then(function (rows) {
          var src2 = rows.filter(function (x) { return x.id === id; })[0];
          if (src2) openAmount(state, slot, fromEntry(src2)); else A().backSheet();
        });
      }
    });

    doSearch();
    if (!opts.query) setTimeout(function () { q.focus(); }, 60);
  }

  function slotName(k) {
    for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].key === k) return SLOTS[i].name;
    return '食事';
  }

  function resRow(x, kind) {
    if (kind === 'common') {
      return '<button class="res" data-pick="' + A().esc(x.key) + '" data-kind="common">' +
        '<b>' + A().esc(x.label) + '</b><span>' +
        (x.unitLabel ? A().esc(x.unitLabel) + ' ' : '') + x.g + 'g ・ ' + x.kcal + ' kcal ／ ' +
        A().esc(x.src) + '</span></button>';
    }
    if (kind === 'seibun') {
      return '<button class="res" data-pick="' + A().esc(x.id) + '" data-kind="seibun">' +
        '<b>' + A().esc(x.n) + '</b><span>' + A().esc(F.groupName(x.g)) +
        ' ・ 100gあたり ' + Math.round(x.kcal) + ' kcal</span></button>';
    }
    if (kind === 'used') {
      // 代表の分量にそろえてカロリーを出す(最後に食べた量とは限らないため)
      var last = x.latest || {};
      var n2 = last.nutrients || {};
      var f2 = (last.amount ? (x.topAmount / last.amount) : 1);
      return '<button class="res" data-pick="' + A().esc(x.name) + '" data-kind="used" data-amt="' +
        A().esc(String(x.topAmount)) + '"><b>' + A().esc(x.name) + '</b><span>' +
        x.count + '回 ・ ' + amountText({ amount: x.topAmount, unit: x.topUnit }) +
        ' ' + Math.round((n2.kcal || 0) * f2) + ' kcal ・ 最後 ' + A().esc(x.last) +
        '</span></button>';
    }
    if (kind === 'combo') {
      var kc = comboTotals(x).kcal;
      return '<button class="res" data-pick="' + A().esc(x.id) + '" data-kind="combo">' +
        '<b>🍱 ' + A().esc(x.name) + '</b><span>' + (x.items || []).length + '品 ・ ' +
        Math.round(kc) + ' kcal ・ ' +
        A().esc((x.items || []).map(function (i) { return i.name; }).join(' / ').slice(0, 40)) +
        '</span></button>';
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

  /* ---------------- セット(自分で組み合わせた食事) ---------------- */
  function comboTotals(c) {
    return F.sum((c.items || []).map(function (i) { return i.nutrients; }));
  }

  /* セットを選んだとき: 中身を確認してまとめて記録する */
  function openComboUse(state, slot, c) {
    var t = comboTotals(c);
    var html = '<div class="card"><b>🍱 ' + A().esc(c.name) + '</b>' +
      '<div class="tiny muted" style="margin-top:4px">' + (c.items || []).length + '品 ・ 合計 ' +
      Math.round(t.kcal || 0) + ' kcal</div></div>' +
      '<div class="card">' + (c.items || []).map(function (i) {
        return '<div class="item"><div class="grow"><div class="item-name ellip">' +
          A().esc(i.name) + '</div><div class="item-sub">' + A().esc(amountText(i)) + '</div></div>' +
          '<div class="item-kcal">' + Math.round((i.nutrients && i.nutrients.kcal) || 0) +
          '</div></div>';
      }).join('') + '</div>' +
      '<button class="btn wide" id="useCombo">' + A().esc(slotName(slot)) + 'にまとめて記録する</button>' +
      '<button class="btn sub wide" id="editCombo" style="margin-top:8px">このセットを編集する</button>' +
      '<button class="btn sub wide" id="delCombo" style="margin-top:8px">このセットを削除する</button>';

    var body = A().openSheet('セット', html);
    body.querySelector('#useCombo').addEventListener('click', function () {
      var seq = Date.now();
      var jobs = (c.items || []).map(function (i, idx) {
        return S.Entries.put({
          date: state.date, slot: slot, name: i.name, amount: i.amount, unit: i.unit,
          nutrients: i.nutrients, ref: i.ref || { type: 'combo', id: c.id }, seq: seq + idx
        });
      });
      Promise.all(jobs).then(function () {
        return S.Combos.touch(c.id);
      }).then(function () {
        A().backSheet();
        A().toast(c.name + ' を記録しました（' + (c.items || []).length + '品）');
        A().render();
      });
    });
    body.querySelector('#editCombo').addEventListener('click', function () {
      openComboEdit(state, slot, c);
    });
    body.querySelector('#delCombo').addEventListener('click', function () {
      if (!confirm('セット「' + c.name + '」を削除しますか？\n（記録済みの食事は消えません）')) return;
      S.Combos.remove(c.id).then(function () {
        A().toast('削除しました');
        A().backSheet();
      });
    });
  }

  /* セットを作る/編集する */
  function openComboEdit(state, slot, combo) {
    var draft = {
      id: (combo && combo.id) || null,
      name: (combo && combo.name) || '',
      items: (combo && combo.items) ? combo.items.slice() : []
    };

    function draw() {
      var t = F.sum(draft.items.map(function (i) { return i.nutrients; }));
      var html = '<div class="card">' +
        '<label class="fld"><span>セットの名前</span>' +
        '<input type="text" id="cName" placeholder="例: 魚定食" value="' +
        A().esc(draft.name) + '"></label></div>' +
        '<div class="card"><h3>中身（' + draft.items.length + '品 ・ 合計 ' +
        Math.round(t.kcal || 0) + ' kcal）</h3>' +
        (draft.items.length
          ? draft.items.map(function (i, idx) {
            return '<div class="item"><div class="grow"><div class="item-name ellip">' +
              A().esc(i.name) + '</div><div class="item-sub">' + A().esc(amountText(i)) + '</div></div>' +
              '<div class="item-kcal">' + Math.round((i.nutrients && i.nutrients.kcal) || 0) + '</div>' +
              '<button class="chip" data-rm="' + idx + '" style="margin-left:8px">削除</button></div>';
          }).join('')
          : '<div class="empty">「＋ 食品を追加」で中身を入れてください</div>') +
        '<div class="add-row"><button class="btn sub sm" id="cAdd">＋ 食品を追加</button></div></div>' +
        '<button class="btn wide" id="cSave">セットを保存する</button>';

      var body = A().openSheet(draft.id ? 'セットを編集' : '新しいセット', html);
      var nameInput = body.querySelector('#cName');
      nameInput.addEventListener('input', function () { draft.name = nameInput.value; });

      body.querySelector('#cAdd').addEventListener('click', function () {
        draft.name = nameInput.value;
        // 中身を選ぶあいだ、この編集画面を戻り先として積んでおく
        A().pushSheet(draw);
        openComboPick(state, function (item) {
          draft.items.push(item);
          // 数量シートが積んだ「食品を選ぶ」の戻り先は通り過ぎて、編集画面へ戻る
          A().dropSheet();
          A().backSheet();
        });
      });

      body.querySelector('.card + .card').addEventListener('click', function (e) {
        var b = e.target.closest('[data-rm]');
        if (!b) return;
        draft.name = nameInput.value;
        draft.items.splice(+b.dataset.rm, 1);
        draw();
      });

      body.querySelector('#cSave').addEventListener('click', function () {
        draft.name = nameInput.value.trim();
        if (!draft.name) { A().toast('セットの名前を入れてください'); return; }
        if (!draft.items.length) { A().toast('中身を1品以上入れてください'); return; }
        S.Combos.put({
          id: draft.id || undefined, name: draft.name, items: draft.items,
          useCount: (combo && combo.useCount) || 0, usedAt: (combo && combo.usedAt) || 0
        }).then(function () {
          A().toast('セット「' + draft.name + '」を保存しました');
          A().backSheet();
        });
      });
    }

    draw();
  }

  /* セットの中身を1品選ぶ(記録はせず、呼び出し元へ渡す) */
  function openComboPick(state, onPick) {
    var html = '<div class="row" style="margin-bottom:10px">' +
      '<input type="text" id="cq" placeholder="食品名で検索（例: さば、ごはん、納豆）" autocomplete="off">' +
      '</div><div id="cres"></div>';
    var body = A().openSheet('セットに入れる食品', html);
    var q = body.querySelector('#cq');
    var out = body.querySelector('#cres');

    function show() {
      var text = q.value.trim();
      if (!text) {
        S.Entries.topUsed(40).then(function (list) {
          out.innerHTML = '<div class="tiny muted" style="margin-bottom:4px">よく食べる順</div>' +
            (list.length ? list.map(function (x) { return resRow(x, 'used'); }).join('')
              : '<div class="empty">記録がありません</div>');
        });
        return;
      }
      Promise.all([
        F.searchCommon(text, { limit: 20 }),
        S.Entries.topUsed(400),
        F.search(text, { limit: 20 })
      ]).then(function (r) {
        var n = F.norm(text);
        var kana = F.isKanaQuery(n);
        var used = r[1].filter(function (x) { return nameHit(x.name, n, kana); }).slice(0, 10);
        var shown = {};
        r[0].forEach(function (c) { shown[c.id] = 1; });
        var seibun = r[2].filter(function (f) { return !shown[f.id]; }).slice(0, 14);
        out.innerHTML =
          (used.length ? used.map(function (x) { return resRow(x, 'used'); }).join('') : '') +
          (r[0].length ? r[0].map(function (x) { return resRow(x, 'common'); }).join('') : '') +
          (seibun.length ? seibun.map(function (x) { return resRow(x, 'seibun'); }).join('') : '') ||
          '<div class="empty">該当する食品がありません</div>';
      });
    }

    var timer = 0;
    q.addEventListener('input', function () {
      clearTimeout(timer); timer = setTimeout(show, 180);
    });

    out.addEventListener('click', function (e) {
      var row = e.target.closest('[data-pick]');
      if (!row) return;
      var kind = row.dataset.kind, id = row.dataset.pick;
      function toAmount(pick) {
        A().pushSheet(function () { openComboPick(state, onPick); });
        openAmount(state, null, pick, null, onPick);
      }
      if (kind === 'common') {
        F.commonById(id).then(function (it) {
          if (!it) return;
          F.byId(it.id).then(function (f) {
            if (!f) return;
            var pick = fromSeibun(f);
            pick.name = it.label; pick.defaultAmount = it.g;
            pick.note = it.unitLabel ? (it.unitLabel + ' ' + it.g + 'g') : f.n;
            toAmount(pick);
          });
        });
      } else if (kind === 'seibun') {
        F.byId(id).then(function (f) { if (f) toAmount(fromSeibun(f)); });
      } else {
        S.Entries.recent(400).then(function (rows) {
          var e2 = rows.filter(function (x) { return x.name === id; })[0];
          if (!e2) return;
          var pick = fromEntry(e2);
          pick.defaultAmount = parseFloat(row.dataset.amt) || pick.defaultAmount;
          toAmount(pick);
        });
      }
    });

    show();
    setTimeout(function () { q.focus(); }, 60);
  }

  /* ---- 選択された食品を共通形式へ ---- */
  function fromSeibun(f) {
    return {
      name: f.n, basis: '100g', per: f, unit: 'g', defaultAmount: 100,
      ref: { type: 'seibun', id: f.id }, note: F.groupName(f.g)
    };
  }
  function fromMyFood(m) {
    // マイ食品も、足りない栄養素があれば商品マスタで補う
    {
      var pm = F.productFor(m.name);
      if (pm && pm.nut) {
        var merged = {};
        for (var k in (m.nutrients || {})) merged[k] = m.nutrients[k];
        for (var k2 in pm.nut) {
          if (typeof pm.nut[k2] === 'number' && typeof merged[k2] !== 'number') merged[k2] = pm.nut[k2];
        }
        m = { name: m.name, basis: m.basis, servingLabel: m.servingLabel,
          brand: m.brand, id: m.id, nutrients: merged };
      }
    }
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
    // 商品マスタに載っている食品なら、足りない栄養素を補う。
    // PFCが入っていてもビタミン・ミネラルは抜けていることが多いので、
    // 「PFCが無いときだけ」ではなく常に見にいく。記録済みの値は上書きしない。
    var m = F.productFor(e.name);
    if (m && m.nut && m.u === (e.unit || 'g')) {
      for (var k2 in m.nut) {
        if (typeof m.nut[k2] === 'number' && typeof per[k2] !== 'number') per[k2] = m.nut[k2];
      }
    }
    return {
      name: e.name, basis: (e.unit === 'g') ? '100g' : 'serving', per: per,
      unit: e.unit || 'g', defaultAmount: amount, ref: e.ref || { type: 'manual' }, note: ''
    };
  }

  /* ---------------- 数量入力シート ---------------- */
  function openAmount(state, slot, pick, existingId, onPick) {
    var isG = (pick.basis === '100g');
    var lacksPfc = !hasPfc(pick.per);
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
      (lacksPfc
        ? '<div class="card"><b>栄養素が登録されていません</b>' +
          '<div class="small muted" style="margin-top:6px">この食品はカロリーだけの登録なので、' +
          'たんぱく質・脂質・炭水化物に反映されません。パッケージの表示を見て入力しておくと、' +
          '次からはこの食品にも栄養素が付きます。</div>' +
          '<button class="btn line wide" id="fillNut" style="margin-top:10px">' +
          '栄養素を入力する</button></div>'
        : '') +
      '<button class="btn wide" id="save">' +
      (onPick ? 'セットに入れる' : (existingId ? '更新する' : 'この内容で記録する')) + '</button>' +
      (existingId ? '<button class="btn sub wide" id="del" style="margin-top:8px">削除する</button>' : '');

    var body = A().openSheet(
      onPick ? 'セットに入れる分量' : (existingId ? '記録を編集' : slotName(slot) + 'に追加'), html);
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
    var fill = body.querySelector('#fillNut');
    if (fill) {
      fill.addEventListener('click', function () {
        A().pushSheet(function () { openAmount(state, slot, pick, existingId, onPick); });
        openManual(state, slot, {
          name: pick.name,
          basis: isG ? '100g' : 'serving',
          servingLabel: isG ? '' : pick.unit,
          kcal: pick.per && pick.per.kcal
        }, existingId);
      });
    }

    body.querySelector('#save').addEventListener('click', function () {
      var c = calc();
      if (!c.amount) { A().toast('数量を入力してください'); return; }
      // セットの中身を選んでいるときは記録せず、呼び出し元へ1品として返す
      if (onPick) {
        onPick({
          name: pick.name, amount: c.amount, unit: pick.unit,
          nutrients: c.n, ref: pick.ref
        });
        return;
      }
      var rec = {
        id: existingId || undefined,
        date: state.date, slot: slot, name: pick.name,
        amount: c.amount, unit: pick.unit, nutrients: c.n, ref: pick.ref
      };
      S.Entries.put(rec).then(function () {
        if (pick.ref && pick.ref.type === 'my') S.MyFoods.touch(pick.ref.id);
        A().render();
        // 続けて何品も足せるよう、閉じずに1つ前(検索一覧)へ戻る
        if (existingId) { A().closeSheet(); A().toast('更新しました'); }
        else { A().backSheet(); A().toast(pick.name + ' を記録しました'); }
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
  function openManual(state, slot, preset, existingId) {
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
        num('mKcal', 'エネルギー (kcal)', preset.kcal, 0) +
        '<div class="grid2">' + num('mP', 'たんぱく質 (g)', preset.protein) + num('mF', '脂質 (g)', preset.fat) + '</div>' +
        '<div class="grid2">' + num('mC', '炭水化物 (g)', preset.carb) + num('mSalt', '食塩相当量 (g)', preset.salt) + '</div>' +
        '<div class="grid2">' + num('mFib', '食物繊維 (g)', preset.fiber) + num('mSat', '飽和脂肪酸 (g)', preset.satfat) + '</div>' +
        '<div class="tiny muted">パッケージの栄養成分表示をそのまま入力してください。空欄は0として扱います。</div>' +
      '</div>' +
      '<div class="card"><h3>その他の栄養素（任意）</h3>' +
        '<div class="small muted">パッケージの表示にはビタミン・ミネラルが載っていません。' +
        '似た食材を1つ選んでおくと、重さに応じて按分して補い、採点に反映されます。</div>' +
        '<div id="refBox" style="margin-top:10px"></div>' +
      '</div>' +
      (preset.barcode ? '<div class="card small">バーコード <b>' + A().esc(preset.barcode) +
        '</b><div class="tiny muted">保存すると次回から自動で呼び出せます</div></div>' : '') +
      '<button class="btn wide" id="mSave">保存して記録する</button>';

    var body = A().openSheet('食品を手入力', html);
    var basis = body.querySelector('#mBasis');
    if (preset.basis) basis.value = preset.basis;

    /* ---- 似た食材からの補完 ---- */
    var refFood = preset.refFood || null;      // 成分表の1品目(まるごと)
    var refGrams = preset.refGrams || null;    // 1単位あたりの重さ

    // いま入力されている内容を持ったまま別画面へ行って戻るためのもの
    function snapshot() {
      return {
        name: body.querySelector('#mName').value,
        brand: body.querySelector('#mBrand').value,
        basis: basis.value,
        servingLabel: body.querySelector('#mServ').value,
        barcode: preset.barcode || '',
        kcal: body.querySelector('#mKcal').value,
        protein: body.querySelector('#mP').value, fat: body.querySelector('#mF').value,
        carb: body.querySelector('#mC').value, salt: body.querySelector('#mSalt').value,
        fiber: body.querySelector('#mFib').value, satfat: body.querySelector('#mSat').value,
        refFood: refFood, refGrams: refGrams
      };
    }

    function drawRef() {
      var box = body.querySelector('#refBox');
      if (!refFood) {
        box.innerHTML = '<button class="btn line wide" id="mPickRef">似た食材を選ぶ</button>';
      } else {
        var isG = basis.value === '100g';
        box.innerHTML = '<div class="row between" style="align-items:flex-start;gap:8px">' +
          '<div class="grow"><b class="small">' + A().esc(refFood.n) + '</b>' +
          '<div class="tiny muted">' + A().esc(F.groupName(refFood.g)) + ' から補います</div></div>' +
          '<button class="chip" id="mClearRef">やめる</button></div>' +
          (isG
            ? '<div class="tiny muted" style="margin-top:8px">100gあたりで入力しているので、' +
              'そのまま100g分を補います。</div>'
            : '<label class="fld" style="margin-top:10px"><span>1' +
              A().esc(body.querySelector('#mServ').value.trim() || '個') +
              'あたりの重さ (g)</span><input type="number" id="mRefG" inputmode="decimal" ' +
              'step="1" value="' + (refGrams == null ? '' : refGrams) + '" placeholder="例: 110"></label>');
      }
      var pick = box.querySelector('#mPickRef');
      if (pick) {
        pick.addEventListener('click', function () {
          // シートは1枚を描き替えて使い回すので、離れる前に入力内容を控えておく
          var snap = snapshot();
          A().pushSheet(function () { openManual(state, slot, snap, existingId); });
          pickSeibun(function (f) {
            snap.refFood = f;
            // 選ぶ前に積んだ戻り先は使わず、選んだ食材を持たせて開き直す
            // (closeSheet はスタックごと消えるので使わない)
            A().dropSheet();
            openManual(state, slot, snap, existingId);
          });
        });
      }
      var clr = box.querySelector('#mClearRef');
      if (clr) {
        clr.addEventListener('click', function () { refFood = null; refGrams = null; drawRef(); });
      }
      var rg = box.querySelector('#mRefG');
      if (rg) {
        rg.addEventListener('input', function () {
          var x = parseFloat(rg.value);
          refGrams = isFinite(x) && x > 0 ? x : null;
        });
      }
    }
    drawRef();
    function toggleServ() {
      body.querySelector('#servWrap').style.display = (basis.value === 'serving') ? '' : 'none';
    }
    basis.addEventListener('change', function () { toggleServ(); drawRef(); });
    toggleServ();

    body.querySelector('#mSave').addEventListener('click', function () {
      var name = body.querySelector('#mName').value.trim();
      if (!name) { A().toast('食品名を入力してください'); return; }
      var nut = {
        kcal: v(body, '#mKcal'), protein: v(body, '#mP'), fat: v(body, '#mF'),
        carb: v(body, '#mC'), salt: v(body, '#mSalt'), fiber: v(body, '#mFib'),
        satfat: v(body, '#mSat')
      };
      // 似た食材が選ばれていれば、重さに応じてビタミン・ミネラルを按分して足す
      var refG = (basis.value === '100g') ? 100 : refGrams;
      if (refFood && refG > 0) {
        MICRO.forEach(function (k) {
          var v2 = refFood[k];
          if (typeof v2 !== 'number' || typeof nut[k] === 'number') return;
          nut[k] = Math.round(v2 * refG / 100 * 1000) / 1000;
        });
      }
      var rec = {
        name: name, brand: body.querySelector('#mBrand').value.trim(),
        basis: basis.value, servingLabel: body.querySelector('#mServ').value.trim() || '個',
        barcode: preset.barcode ? String(preset.barcode) : '',
        nutrients: nut,
        refFood: refFood ? refFood.id : '', refGrams: refG || null
      };
      S.MyFoods.put(rec).then(function (saved) {
        A().toast('マイ食品に保存しました');
        // 既存の記録に栄養素を足しに来た場合は、同じ記録を更新する(増やさない)
        openAmount(state, slot, fromMyFood(saved), existingId);
      });
    });
  }

  function num(id, label, val, digits) {
    return '<label class="fld"><span>' + label + '</span><input type="number" inputmode="decimal" ' +
      'step="0.1" id="' + id + '" value="' + (val == null ? '' : round(val, digits)) + '"></label>';
  }
  // Web検索やバーコードから来る値は 1食分から100gあたりへ割り戻した生の小数なので、
  // フォームには 127.692307692308 のような数字を出さないよう丸める
  function round(val, digits) {
    var x = parseFloat(val);
    if (!isFinite(x)) return '';
    var p = Math.pow(10, digits == null ? 2 : digits);
    return String(Math.round(x * p) / p);
  }
  function v(body, sel) {
    var x = parseFloat(body.querySelector(sel).value);
    return isFinite(x) ? x : 0;
  }

  /* 成分表から1品目だけ選ぶ(栄養素の補完元にするため。記録はしない) */
  function pickSeibun(onPick) {
    var html = '<div class="row" style="margin-bottom:10px">' +
      '<input type="text" id="sq" placeholder="似ている食材を検索（例: とりむね、じゃがいも）" ' +
      'autocomplete="off"></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">ビタミン・ミネラルの補完にだけ使います。' +
      'カロリーやPFCは手入力した値のままです。</div>' +
      '<div id="sres"></div>';
    var body = A().openSheet('似た食材を選ぶ', html);
    var q = body.querySelector('#sq');
    var out = body.querySelector('#sres');
    var cache = {};

    function show() {
      var text = q.value.trim();
      if (!text) { out.innerHTML = '<div class="empty">食材名を入れてください</div>'; return; }
      Promise.all([F.searchCommon(text, { limit: 12 }), F.search(text, { limit: 24 })])
        .then(function (r) {
          var ids = {};
          var rows = [];
          r[0].forEach(function (c) { ids[c.id] = 1; });
          return F.load().then(function (db) {
            var byId = {};
            db.foods.forEach(function (f) { byId[f.id] = f; });
            r[0].forEach(function (c) { if (byId[c.id]) rows.push(byId[c.id]); });
            r[1].forEach(function (f) { if (!ids[f.id]) rows.push(f); });
            rows.forEach(function (f) { cache[f.id] = f; });
            out.innerHTML = rows.length
              ? rows.slice(0, 30).map(function (f) {
                return '<button class="res" data-sid="' + A().esc(f.id) + '"><b>' +
                  A().esc(f.n) + '</b><span>' + A().esc(F.groupName(f.g)) +
                  ' ・ 100gあたり ' + Math.round(f.kcal || 0) + ' kcal</span></button>';
              }).join('')
              : '<div class="empty">該当する食材がありません</div>';
          });
        });
    }

    var timer = 0;
    q.addEventListener('input', function () {
      clearTimeout(timer); timer = setTimeout(show, 180);
    });
    out.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sid]');
      if (!b) return;
      var f = cache[b.dataset.sid];
      if (f) onPick(f);
    });
    setTimeout(function () { q.focus(); }, 60);
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

  /* ---------------- 商品名でのWEB検索して取り込む ---------------- */
  function openWebSearch(state, slot, query) {
    var html = '<div class="row" style="margin-bottom:10px">' +
      '<input type="text" id="wq" placeholder="商品名・チェーン名（例: サラダチキン）" ' +
      'value="' + A().esc(query || '') + '" autocomplete="off">' +
      '</div>' +
      '<button class="btn wide" id="wgo">検索する</button>' +
      '<div id="wres" style="margin-top:12px"></div>';
    var body = A().openSheet('WEBで検索して取り込む', html);
    var input = body.querySelector('#wq');
    var out = body.querySelector('#wres');

    function run() {
      var text = input.value.trim();
      if (!text) { out.innerHTML = '<div class="empty">検索する言葉を入れてください</div>'; return; }
      out.innerHTML = '<div class="empty">検索中…</div>';
      global.Barcode.searchByName(text, { limit: 30 }).then(function (list) {
        if (!list.length) { out.innerHTML = notFoundHtml(text); return; }
        out.innerHTML = '<div class="tiny muted" style="margin-bottom:6px">' +
          'Open Food Facts の検索結果（利用者投稿型のデータベースです。' +
          'パッケージの表示と違う場合は次の画面で修正できます）</div>' +
          list.map(function (p, i) {
            var n = p.per100 || {};
            return '<button class="res" data-wi="' + i + '"><b>' +
              A().esc(p.name || '(商品名なし)') + '</b><span>' +
              (p.brand ? A().esc(p.brand) + ' ・ ' : '') +
              (n.kcal != null ? '100gあたり ' + Math.round(n.kcal) + ' kcal' : '栄養値なし') +
              (p.quantity ? ' ・ ' + A().esc(p.quantity) : '') + '</span></button>';
          }).join('');
        out._list = list;
      });
    }

    function notFoundHtml(text) {
      return '<div class="card"><b>見つかりませんでした</b>' +
        '<div class="small muted" style="margin-top:8px">' +
        '公開データベースには日本の外食チェーンや一部の市販品がまだ十分に登録されていません。' +
        '以下のいずれかで登録できます。</div>' +
        '<div class="small" style="margin-top:10px">' +
        '・パッケージや店頭の栄養成分表示を見て「手入力で登録」<br>' +
        '・チェーンが公開している栄養成分をCSVにして、設定タブの「食品データをCSVで取り込む」から一括登録' +
        '</div></div>' +
        '<button class="btn wide" id="wmanual">「' + A().esc(text) + '」を手入力で登録</button>';
    }

    body.querySelector('#wgo').addEventListener('click', run);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    });
    out.addEventListener('click', function (e) {
      if (e.target.closest('#wmanual')) {
        openManual(state, slot, { name: input.value.trim(), basis: 'serving' });
        return;
      }
      var b = e.target.closest('[data-wi]');
      if (!b || !out._list) return;
      var p = out._list[+b.getAttribute('data-wi')];
      if (!p) return;
      var n = p.per100 || {};
      openManual(state, slot, {
        name: p.name || input.value.trim(), brand: p.brand, barcode: p.code || '',
        basis: '100g', kcal: n.kcal, protein: n.protein, fat: n.fat,
        carb: n.carb, salt: n.salt, fiber: n.fiber, satfat: n.satfat
      });
    });

    if (query) run();
    else setTimeout(function () { input.focus(); }, 60);
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
