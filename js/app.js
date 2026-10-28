/* app.js - 画面遷移・共通ヘルパー・起動処理 */
(function (global) {
  'use strict';

  var Views = global.Views || (global.Views = {});
  var S = global.Store;

  var state = {
    date: S.ymd(new Date()),
    today: S.ymd(new Date()),
    tab: 'meal',
    settings: null,
    weightCache: null
  };

  /* ---------- 共通ヘルパー ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function version() {
    var meta = document.querySelector('meta[name="application-version"]');
    return meta ? meta.getAttribute('content') : '';
  }

  var toastTimer = 0;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  /* シートは1枚を描き替えて使い回すので、「前の画面」は再描画する関数を
     積んで覚えておく(数量入力から検索一覧へ戻り、続けて何品も追加できるように) */
  var sheetStack = [];

  /* opts.fill: 高さを固定し、中身側でスクロール範囲を決める(食品追加の一覧など)
     opts.tall: 一覧が後から読み込まれて伸び縮みする画面。fill と同じ形にして、中身を
       スクロール用の枠(.sheet-scroll)で包む。高さの決まっていないシートの中身が後から増えると、
       iPhoneではシートがスクロールせず後ろの画面が動いた(2026-10-25 バーコードを登録の画面)。
       毎日使えている食品追加の一覧と同じ作り(高さ固定のシート＋中のスクロール枠)にそろえる */
  function openSheet(title, html, opts) {
    opts = opts || {};
    var sheet = document.getElementById('sheet');
    document.getElementById('sheetTitle').textContent = title || '';
    // 中身の入れ物は画面ごとに作り直す。同じ要素の overflow や高さを切り替えて使い回すと
    // スクロールの状態が前の画面から残ることがあり、入れ物に付けたリスナーも積み上がる
    var old = document.getElementById('sheetBody');
    var body = old.cloneNode(false);
    old.parentNode.replaceChild(body, old);
    body.innerHTML = opts.tall ? '<div class="sheet-scroll">' + (html || '') + '</div>' : (html || '');
    var act = document.getElementById('sheetAction');
    act.hidden = !opts.action;
    act.textContent = opts.action || '保存';
    act.onclick = opts.onAction || null;
    // 前の画面が積まれていれば、ヘッダは「閉じる」ではなく「戻る」にする
    var cl = sheet.querySelector('.sheet-close');
    if (cl) {
      var back = sheetStack.length > 0;
      cl.dataset.close = back ? 'back' : '1';
      cl.textContent = back ? '‹ 戻る' : '閉じる';
    }
    var panel = sheet.querySelector('.sheet-panel');
    var fixed = !!(opts.fill || opts.tall);
    panel.classList.toggle('fill', fixed);
    body.classList.toggle('fill', fixed);
    sheet.hidden = false;
    // シートが開いている間はフロートの追加ボタンを隠す
    document.body.classList.add('sheet-open');
    return body;
  }

  function closeSheet() {
    sheetStack = [];
    document.getElementById('sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    document.getElementById('sheetBody').innerHTML = '';
    var act = document.getElementById('sheetAction');
    act.hidden = true; act.onclick = null;
  }

  function pushSheet(restore) {
    if (typeof restore === 'function') sheetStack.push(restore);
  }

  // 戻り先を1つ捨てる(通り過ぎたい中間画面がある場合)
  function dropSheet() { sheetStack.pop(); }

  // 1つ前のシートへ戻る。積んでいなければ閉じる。
  function backSheet() {
    var restore = sheetStack.pop();
    if (!restore) { closeSheet(); return false; }
    restore();
    return true;
  }

  function sheetOpen() { return !document.getElementById('sheet').hidden; }

  /* 日付表示 */
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function dateLabel(ymd) {
    var today = S.ymd(new Date());
    var d = S.parseYmd(ymd);
    var base = (d.getMonth() + 1) + '/' + d.getDate() + '(' + WD[d.getDay()] + ')';
    if (ymd === today) return '今日 ' + base;
    if (ymd === S.shiftYmd(today, -1)) return '昨日 ' + base;
    if (ymd === S.shiftYmd(today, 1)) return '明日 ' + base;
    return d.getFullYear() + '/' + base;
  }

  /* 設定と体重(目標計算に使う) */
  function reloadSettings() {
    return S.Settings.get().then(function (st) { state.settings = st; return st; });
  }

  function weightFor(date) {
    return S.Body.latestWeight(date).then(function (rec) {
      return (rec && rec.weight) || null;
    });
  }

  function targetsFor(date) {
    return Promise.all([
      state.settings ? Promise.resolve(state.settings) : reloadSettings(),
      weightFor(date)
    ]).then(function (r) {
      var w = r[1] || 60;
      return { tg: global.Nutrition.targets(r[0], w), weight: r[1], settings: r[0] };
    });
  }

  /* ---------- 描画 ---------- */
  var rendering = false, pending = false, pendingScroll = null;

  function maxInputDate() {
    return S.shiftYmd(S.ymd(new Date()), 1);
  }

  function updateDateControls() {
    document.getElementById('dateLabel').textContent = dateLabel(state.date);
    var next = document.getElementById('dateNext');
    var blocked = state.date >= maxInputDate();
    next.disabled = blocked;
    next.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  }

  function render(opts) {
    opts = opts || {};
    var restoreScroll = typeof opts.restoreScroll === 'number' ? opts.restoreScroll : null;
    // 描画中の要求は、現在の #view を先に空にせず次回へまとめる。
    if (rendering) {
      pending = true;
      if (restoreScroll != null) pendingScroll = restoreScroll;
      return Promise.resolve();
    }
    // 各画面は #view に click リスナーを付けるので、描画のたびに要素ごと差し替えて
    // リスナーが積み上がらないようにする
    var old = document.getElementById('view');
    var view = old.cloneNode(false);
    old.parentNode.replaceChild(view, old);

    var v = Views[state.tab];
    updateDateControls();
    if (!v) {
      view.innerHTML = '<div class="card">画面が見つかりません</div>';
      return Promise.resolve();
    }
    rendering = true;
    return Promise.resolve(v.render(view, state)).catch(function (err) {
      // 端末内のデータベースへの接続が切れたときなどは、読み込み直せば戻ることが多い(v53)
      view.innerHTML = '<div class="card"><b>表示エラー</b><div class="small muted">' +
        esc(String((err && err.message) || err)) + '</div>' +
        '<button class="btn wide" style="margin-top:10px" onclick="location.reload()">読み込み直す</button></div>';
    }).then(function () {
      rendering = false;
      if (pending) {
        var nextScroll = pendingScroll != null ? pendingScroll : restoreScroll;
        pending = false; pendingScroll = null;
        return render(nextScroll == null ? {} : { restoreScroll: nextScroll });
      }
      if (restoreScroll != null) {
        requestAnimationFrame(function () {
          window.scrollTo(0, Math.max(0, restoreScroll));
        });
      }
    });
  }

  function renderPreservingScroll() {
    return render({ restoreScroll: window.scrollY });
  }

  function setTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    S.Settings.save({ lastTab: tab });
    window.scrollTo(0, 0);
    render();
  }

  function setDate(ymd) {
    ymd = String(ymd || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || S.ymd(S.parseYmd(ymd)) !== ymd) {
      toast('日付の形式が正しくありません');
      return false;
    }
    if (ymd > maxInputDate()) {
      toast('入力・表示できる未来日は明日までです');
      updateDateControls();
      return false;
    }
    state.date = ymd;
    render();
    return true;
  }

  /* ---------- iPhoneの「連絡先を自動入力」を出さない ----------
     iPhoneのSafariは、入力欄の name・id・見出し・入力例から「連絡先の欄」かどうかを推測し、
     キーボードの上に「連絡先を自動入力」を出す。栄養素の数字欄にも出ていた(2026-10-16 利用者報告)。
     食品名の id="mName" などが名前欄に見え、画面全体が連絡先の入力と見なされたとみられる。
     autocomplete="off" はこの推測には使われない(Webの報告どおり)。name に search を含む欄は
     推測の対象外になるので、name の無い入力欄すべてに付ける(このアプリに連絡先を入れる欄は無い)。
     ・ダッシュは使わない(name のダッシュで電話番号欄と推測された報告がある)
     ・<form> を使っていないので、決定キーが「検索」に変わることはない
     ・読み取り欄(data-autofill="keep")は除く。今のiOSでは「テキストをスキャン」が入力欄の
       メニューの「自動入力」の中にあるので、そこには触らない */
  var quietSeq = 0;
  function quietOne(el) {
    if (el.getAttribute('data-autofill') === 'keep') return;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (/^(hidden|file|checkbox|radio|range|button|submit|reset|image|color)$/.test(type)) return;
    if (!el.getAttribute('name')) el.setAttribute('name', 'search' + (++quietSeq));
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
  }
  function quietAutofill(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches('input, textarea')) quietOne(root);
    Array.prototype.forEach.call(root.querySelectorAll('input, textarea'), quietOne);
  }
  function watchInputs() {
    quietAutofill(document.body);
    // 画面は描き替えて使い回すので、あとから足された欄にも、押される前に付ける
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, quietAutofill);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- 起動 ---------- */
  function boot() {
    watchInputs();
    document.getElementById('datePrev').addEventListener('click', function () {
      setDate(S.shiftYmd(state.date, -1));
    });
    document.getElementById('dateNext').addEventListener('click', function () {
      setDate(S.shiftYmd(state.date, 1));
    });
    document.getElementById('dateLabel').addEventListener('click', function () {
      var body = openSheet('日付を選ぶ',
        '<label class="fld"><span>日付</span><input type="date" id="pickDate" value="' +
        esc(state.date) + '" max="' + maxInputDate() + '"></label>' +
        '<button class="btn wide" id="pickToday">今日に戻る</button>');
      body.querySelector('#pickDate').addEventListener('change', function (e) {
        if (e.target.value) { closeSheet(); setDate(e.target.value); }
      });
      body.querySelector('#pickToday').addEventListener('click', function () {
        closeSheet(); setDate(S.ymd(new Date()));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab'), function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });

    document.getElementById('sheet').addEventListener('click', function (e) {
      if (!e.target.dataset || !e.target.dataset.close) return;
      if (e.target.dataset.close === 'back') backSheet();
      else closeSheet();
    });

    // 日付をまたいで開きっぱなしだった場合だけ「今日」に追従する。
    // 過去の記録を見ている最中に勝手に today へ飛ばさないこと。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      var today = S.ymd(new Date());
      if (today !== state.today) {
        if (state.date === state.today && !sheetOpen()) state.date = today;
        state.today = today;
      }
      render();
    });

    var liverMigration = null, fruitMigration = null;
    // 日付の上に版を小さく出す(更新が届いたかを、設定の一番下まで見に行かずに確かめられる)
    var hdrVer = document.getElementById('hdrVer');
    if (hdrVer) hdrVer.textContent = version();
    /* 起動の手順はどれか1つが失敗しても先へ進め、必ず画面を描く(v53)。
       v52までは移行や設定の読み出しが失敗すると(iPhoneでデータベースへの接続が切れたときなど)、
       記録画面が描かれないまま止まっていた */
    var soft = function (p) { return p.catch(function (e) { void e; return null; }); };
    soft(S.migrateToilet()).then(function () {
      return soft(S.migrateExerciseGoal());
    }).then(function () {
      // 初回オフライン等で成分表を読めない場合も起動は続け、次回また試す。
      return soft(S.migrateChickenLiver());
    }).then(function (result) {
      liverMigration = result;
      // 記録済みの果物にビタミンなどを補う(一度だけ)。成分表を読めない場合は次回また試す
      return soft(S.migrateFruitEstimate());
    }).then(function (result) {
      fruitMigration = result;
      // 設定が読めないときは記録画面で起動し、一度だけの重い後片付け(食べなかった埋め)は次回に回す
      return reloadSettings().catch(function () { return { lastTab: 'meal', skipBackfilled: 1 }; });
    }).then(function (st) {
      state.tab = st.lastTab || 'meal';
      Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab'), function (b) {
        b.classList.toggle('is-active', b.dataset.tab === state.tab);
      });
      render();
      if (liverMigration && liverMigration.changed) {
        toast('保存済みの鶏レバー ' + liverMigration.changed + '件を再較正しました', 4200);
      }
      if (fruitMigration && fruitMigration.changed) {
        toast('果物の記録 ' + fruitMigration.changed + '件にビタミンなどを補いました', 4200);
      }
      // 前の版の推定値(全食品の中央値など)を今の決まりで計算し直す(一度だけ)。
      // 件数が多いので画面を出してから裏で動かす。読めなかった場合は次回また試す
      S.migrateEstimateCleanup().then(function (r) {
        if (r && r.changed) {
          toast('前の版の推定値を整理しました（' + r.changed + '件。値が不明に戻したもの ' +
            r.cleared + '件）', 6000);
          if (!sheetOpen()) render();
        }
      }).catch(function (e) { void e; }).then(function () {
        // 商品マスタに足した食品を、記録済みの分にも当てる(版ごとに一度)。整理が終わってから動かす
        return S.migrateProductFill();
      }).then(function (p) {
        if (!p || !p.changed) return;
        toast('記録済みの ' + p.changed + '件に、商品の栄養成分を補いました', 5000);
        if (!sheetOpen()) render();
      }).catch(function (e) { void e; });
      global.Steps.receiveUrl().then(function (count) {
        if (count) { toast(count + '日分の歩数を取り込みました', 3500); render(); }
      }).catch(function (e) { toast('歩数を取り込めませんでした: ' + e.message, 5000); });
      /* 食品DB(成分表 約1MB)・推定の辞書・かなの読み表・商品マスタは、画面を出してから裏で読む。
         記録画面の色分けが成分表を待つので、まず成分表から。残りは少し間を置いて1つずつ読み、
         起動直後に重い処理が重なって操作が固まらないようにする(v53) */
      setTimeout(function () {
        global.Foods.load().catch(function (e) {
          toast('食品データベースの読み込みに失敗しました');
          void e;
        }).then(function () {
          return global.Estimate.load().catch(function (e) { void e; });
        }).then(function () {
          // かな検索用の読み表と、商品ごとの栄養マスタ(どちらも無くても動く)
          global.Foods.loadYomi();
          global.Foods.loadProducts();
        });
      }, 300);
      // 取り込んだ過去日の未記録を「食べなかった」で一度だけ埋める
      if (!st.skipBackfilled) {
        S.backfillSkipped().then(function (res) {
          return S.Settings.save({ skipBackfilled: 1 }).then(function () { return res; });
        }).then(function (res) {
          if (res && res.added) {
            toast('過去 ' + res.days + ' 日分の未記録を「食べなかった」にしました', 3200);
            reloadSettings().then(render);
          }
        }).catch(function (e) { void e; });
      }
    });

    // localhost は開発用なのでキャッシュを挟まない(公開URLでのみPWA化する)
    var isDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if ('serviceWorker' in navigator && !isDev) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js').catch(function (e) { void e; });
      });
    } else if (isDev && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        rs.forEach(function (r) { r.unregister(); });
      }).catch(function (e) { void e; });
    }
  }

  global.App = {
    state: state, render: render, renderPreservingScroll: renderPreservingScroll,
    setTab: setTab, setDate: setDate, maxInputDate: maxInputDate,
    esc: esc, toast: toast, openSheet: openSheet, closeSheet: closeSheet,
    pushSheet: pushSheet, backSheet: backSheet, dropSheet: dropSheet,
    reloadSettings: reloadSettings, weightFor: weightFor, targetsFor: targetsFor,
    dateLabel: dateLabel, version: version
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
