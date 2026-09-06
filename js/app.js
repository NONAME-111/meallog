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
    return body;
  }

  function closeSheet() {
    sheetStack = [];
    document.getElementById('sheet').hidden = true;
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
  var rendering = false, pending = false;
  function render() {
    // 各画面は #view に click リスナーを付けるので、描画のたびに要素ごと差し替えて
    // リスナーが積み上がらないようにする
    var old = document.getElementById('view');
    var view = old.cloneNode(false);
    old.parentNode.replaceChild(view, old);

    var v = Views[state.tab];
    document.getElementById('dateLabel').textContent = dateLabel(state.date);
    if (!v) { view.innerHTML = '<div class="card">画面が見つかりません</div>'; return; }
    // 描画中に次の要求が来たら捨てずに積んでおき、終わったら最新状態で描き直す
    if (rendering) { pending = true; return; }
    rendering = true;
    Promise.resolve(v.render(view, state)).catch(function (err) {
      view.innerHTML = '<div class="card"><b>表示エラー</b><div class="small muted">' +
        esc(String((err && err.message) || err)) + '</div></div>';
    }).then(function () {
      rendering = false;
      if (pending) { pending = false; render(); }
    });
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
    state.date = ymd;
    render();
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
        esc(state.date) + '"></label>' +
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

    S.migrateToilet().then(reloadSettings).then(function (st) {
      state.tab = st.lastTab || 'meal';
      Array.prototype.forEach.call(document.querySelectorAll('#tabbar .tab'), function (b) {
        b.classList.toggle('is-active', b.dataset.tab === state.tab);
      });
      render();
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
    state: state, render: render, setTab: setTab, setDate: setDate,
    esc: esc, toast: toast, openSheet: openSheet, closeSheet: closeSheet,
    pushSheet: pushSheet, backSheet: backSheet, dropSheet: dropSheet,
    reloadSettings: reloadSettings, weightFor: weightFor, targetsFor: targetsFor,
    dateLabel: dateLabel
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
