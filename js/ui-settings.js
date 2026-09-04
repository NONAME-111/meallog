/* ui-settings.js - 設定タブ(プロフィール・目標・マイ食品・データ管理) */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  function A() { return global.App; }

  function render(view, state) {
    return Promise.all([S.Settings.get(), A().weightFor(state.date), S.MyFoods.all()])
      .then(function (r) {
        var st = r[0], w = r[1], my = r[2];
        var tg = N.targets(st, w || 60);
        view.innerHTML =
          profileCard(st) +
          goalCard(st, w, tg) +
          myFoodCard(my) +
          toiletCard(st) +
          dataCard() +
          aboutCard();
        bind(view, st);
      });
  }

  function profileCard(st) {
    return '<div class="card"><h3>プロフィール</h3>' +
      '<label class="fld"><span>性別（推奨量の計算に使います）</span><select id="sSex">' +
        opt('male', '男性', st.sex) + opt('female', '女性', st.sex) + '</select></label>' +
      '<div class="grid2">' +
        '<label class="fld"><span>生年月日</span><input type="date" id="sBirth" value="' +
          A().esc(st.birth || '') + '"></label>' +
        '<label class="fld"><span>身長 (cm)</span><input type="number" inputmode="decimal" step="0.1" ' +
          'id="sHeight" value="' + (st.heightCm || '') + '"></label>' +
      '</div>' +
      '<label class="fld"><span>身体活動レベル</span><select id="sAct">' +
        opt('1.5', '低い（座り仕事が中心）', String(st.activity)) +
        opt('1.75', 'ふつう（立ち仕事や通勤あり）', String(st.activity)) +
        opt('2', '高い（力仕事や運動習慣あり）', String(st.activity)) +
      '</select></label></div>';
  }

  function goalCard(st, w, tg) {
    return '<div class="card"><h3>目標</h3>' +
      '<div class="grid2">' +
        '<label class="fld"><span>目標体重 (kg)</span><input type="number" inputmode="decimal" step="0.1" ' +
          'id="sGoalW" value="' + (st.goalWeight == null ? '' : st.goalWeight) + '"></label>' +
        '<label class="fld"><span>減量ペース (kg/月)</span><input type="number" inputmode="decimal" step="0.1" ' +
          'id="sPace" value="' + (st.paceKgPerMonth == null ? '' : st.paceKgPerMonth) + '"></label>' +
      '</div>' +
      '<label class="fld"><span>1日の目標カロリー</span>' +
        '<input type="number" inputmode="numeric" id="sKcal" placeholder="自動計算: ' + tg.kcal.goal +
        '" value="' + (st.manualKcal || '') + '"></label>' +
      '<div class="small muted">現在の体重 ' + (w ? N.fmt(w) + ' kg' : '未記録') +
        ' から、推定基礎代謝 <b>' + tg._bmr + ' kcal</b>、1日の消費目安 <b>' + tg._tdee +
        ' kcal</b>、目標摂取 <b>' + tg.kcal.goal + ' kcal</b> と計算しています。' +
        '空欄にすると自動計算に戻ります。</div>' +
      predictLine(st, w) +
      '</div>';
  }

  function predictLine(st, w) {
    if (!st.goalWeight || !w || w <= st.goalWeight) return '';
    var pace = st.paceKgPerMonth || 2;
    if (pace <= 0) return '';
    var months = (w - st.goalWeight) / pace;
    var d = new Date();
    d.setMonth(d.getMonth() + Math.ceil(months));
    return '<div class="small" style="margin-top:8px;color:var(--green)">このペースなら約 ' +
      (Math.round(months * 10) / 10) + " か月後（" + (d.getFullYear()) + '年' + (d.getMonth() + 1) +
      '月ごろ）に目標体重に到達する計算です。</div>';
  }

  function myFoodCard(my) {
    var h = '<div class="card"><div class="row between" style="margin-bottom:8px">' +
      '<h3 style="margin:0">マイ食品（' + my.length + '件）</h3></div>';
    if (!my.length) {
      h += '<div class="empty">手入力やバーコード登録した食品がここに並びます</div>';
    } else {
      my.slice(0, 30).forEach(function (m) {
        var per = m.basis === 'serving' ? ('1' + (m.servingLabel || '食')) : '100g';
        h += '<div class="row between" style="padding:8px 0;border-top:1px solid var(--line)">' +
          '<span class="grow ellip"><b class="small">' + A().esc(m.name) + '</b>' +
          '<span class="tiny muted"> ' + per + 'あたり ' +
          Math.round((m.nutrients && m.nutrients.kcal) || 0) + ' kcal' +
          (m.barcode ? ' ・ ' + A().esc(m.barcode) : '') + '</span></span>' +
          '<button class="tiny" data-delmy="' + A().esc(m.id) + '" ' +
          'style="color:var(--red);text-decoration:underline;flex:none">削除</button></div>';
      });
      if (my.length > 30) h += '<div class="tiny muted" style="margin-top:6px">ほか ' + (my.length - 30) + ' 件</div>';
    }
    return h + '</div>';
  }

  function toiletCard(st) {
    return '<div class="card"><h3>トイレ記録のボタン</h3>' +
      '<label class="fld"><span>ボタン名（カンマ区切り）</span>' +
      '<input type="text" id="sToilet" value="' + A().esc((st.toiletTypes || []).join(',')) + '"></label>' +
      '<div class="tiny muted">例: 小,大 ／ 例: 小,大,軟便</div></div>';
  }

  function dataCard() {
    return '<div class="card"><h3>データの管理</h3>' +
      '<div class="small muted" style="margin-bottom:10px">記録はすべてこの端末の中だけに保存されています。' +
      '機種変更やブラウザのデータ削除に備えて、ときどき書き出しておくことをおすすめします。</div>' +
      '<button class="btn line wide" id="btnExport">データを書き出す（JSON）</button>' +
      '<button class="btn line wide" id="btnImport" style="margin-top:8px">データを取り込む</button>' +
      '<input type="file" id="fileImport" accept="application/json,.json" hidden>' +
      '<button class="btn sub wide" id="btnWipe" style="margin-top:14px;color:var(--red)">すべての記録を消す</button>' +
      '</div>';
  }

  function aboutCard() {
    return '<div class="card"><h3>このアプリについて</h3>' +
      '<div class="small">ミールログ <b>Claude ver01</b></div>' +
      '<div class="tiny muted" style="margin-top:6px">' +
      '栄養成分の出典: ' + A().esc(F.source() || '日本食品標準成分表(八訂)増補2023年 / 文部科学省') +
      '（収載 ' + F.count() + ' 品目）<br>' +
      '目標量の基準: 日本人の食事摂取基準(2025年版)<br>' +
      '商品情報の検索: Open Food Facts（利用者投稿型データベース）<br><br>' +
      'このアプリは健康管理の補助を目的としたもので、医療上の助言ではありません。' +
      '治療中の方や妊娠・授乳中の方は、医師・管理栄養士の指示を優先してください。</div></div>';
  }

  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (String(cur) === v ? ' selected' : '') + '>' + label + '</option>';
  }

  /* ---------------- イベント ---------------- */
  function bind(view, st) {
    function save(patch) {
      return S.Settings.save(patch)
        .then(function () { return A().reloadSettings(); })
        .then(function () { A().render(); });
    }

    on(view, '#sSex', 'change', function (e) { save({ sex: e.target.value }); });
    on(view, '#sBirth', 'change', function (e) { save({ birth: e.target.value }); });
    on(view, '#sHeight', 'change', function (e) {
      save({ heightCm: parseFloat(e.target.value) || null });
    });
    on(view, '#sAct', 'change', function (e) { save({ activity: parseFloat(e.target.value) }); });
    on(view, '#sGoalW', 'change', function (e) {
      var v = parseFloat(e.target.value);
      save({ goalWeight: isFinite(v) ? v : null });
    });
    on(view, '#sPace', 'change', function (e) {
      var v = parseFloat(e.target.value);
      save({ paceKgPerMonth: isFinite(v) ? v : 0 });
    });
    on(view, '#sKcal', 'change', function (e) {
      var v = parseInt(e.target.value, 10);
      save({ manualKcal: isFinite(v) && v > 0 ? v : null });
    });
    on(view, '#sToilet', 'change', function (e) {
      var list = e.target.value.split(',').map(function (x) { return x.trim(); })
        .filter(function (x) { return x; });
      save({ toiletTypes: list.length ? list : ['小', '大'] });
    });

    view.addEventListener('click', function (ev) {
      var d = ev.target.closest('[data-delmy]');
      if (d) {
        if (!confirm('このマイ食品を削除しますか？（過去の記録は残ります）')) return;
        S.MyFoods.remove(d.getAttribute('data-delmy')).then(function () {
          A().toast('削除しました'); A().render();
        });
      }
    });

    on(view, '#btnExport', 'click', doExport);
    on(view, '#btnImport', 'click', function () { view.querySelector('#fileImport').click(); });
    on(view, '#fileImport', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) doImport(f);
    });
    on(view, '#btnWipe', 'click', function () {
      if (!confirm('すべての食事・体重・運動・マイ食品の記録を削除します。よろしいですか？')) return;
      if (!confirm('本当に削除しますか？この操作は取り消せません。')) return;
      S.wipeAll().then(function () { A().toast('削除しました'); A().render(); });
    });

    void st;
  }

  function on(root, sel, ev, fn) {
    var el = root.querySelector(sel);
    if (el) el.addEventListener(ev, fn);
  }

  /* ---------------- 書き出し / 取り込み ---------------- */
  function doExport() {
    S.exportAll().then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'meallog-' + S.ymd(new Date()) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
      A().toast('書き出しました（' + (data.entries.length) + '件の食事記録）');
    });
  }

  function doImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (e) {
        A().toast('ファイルを読み取れませんでした');
        return;
      }
      var counts = (data.entries || []).length + '件の食事、' +
        (data.body || []).length + '件のカラダ記録';
      var mode = confirm(counts + ' を取り込みます。\n\n[OK] 今のデータに追加する\n[キャンセル] 中止')
        ? 'merge' : null;
      if (!mode) return;
      S.importAll(data, mode).then(function () {
        return A().reloadSettings();
      }).then(function () {
        A().toast('取り込みました'); A().render();
      }).catch(function (err) {
        A().toast('取り込みに失敗: ' + ((err && err.message) || err));
      });
    };
    reader.readAsText(file);
  }

  Views.settings = { render: render };
})(window);
