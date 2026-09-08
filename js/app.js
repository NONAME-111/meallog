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

  function openSheet(title, html, opts) {
    opts = opts || {};
    var sheet = document.getElementById('sheet');
    document.getElementById('sheetTitle').textContent = title || '';
    var body = document.getElementById('sheetBody');
    body.innerHTML = html || '';
    body.scrollTop = 0;
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
      view.innerHTML = '<div class="card"><b>表示エラー</b><div class="small muted">' +
        esc(String((err && err.message) || err)) + '</div></div>';
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

  /* ---------- 起動 ---------- */
  function boot() {
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

    var liverMigration = null;
    S.migrateToilet().then(function () {
      return S.migrateExerciseGoal();
    }).then(function () {
      // 初回オフライン等で成分表を読めない場合も起動は続け、次回また試す。
      return S.migrateChickenLiver().catch(function () { return null; });
    }).then(function (result) {
      liverMigration = result;
      return reloadSettings();
    }).then(function (st) {
      state.tab = st.lastTab || 'meal';
      Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab'), function (b) {
        b.classList.toggle('is-active', b.dataset.tab === state.tab);
      });
      render();
      if (liverMigration && liverMigration.changed) {
        toast('保存済みの鶏レバー ' + liverMigration.changed + '件を再較正しました', 4200);
      }
      global.Steps.receiveUrl().then(function (count) {
        if (count) { toast(count + '日分の歩数を取り込みました', 3500); render(); }
      }).catch(function (e) { toast('歩数を取り込めませんでした: ' + e.message, 5000); });
      // 食品DBは先読みしておく
      global.Foods.load().catch(function (e) {
        toast('食品データベースの読み込みに失敗しました');
        void e;
      });
      // かな検索用の読み表と、商品ごとの栄養マスタ(どちらも無くても動く)
      global.Foods.loadYomi();
      global.Foods.loadProducts();
      global.Estimate.load().catch(function (e) { void e; });
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
