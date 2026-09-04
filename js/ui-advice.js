/* ui-advice.js - 栄養採点とアドバイスのタブ */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  function A() { return global.App; }

  function render(view, state) {
    return S.Entries.byDate(state.date).then(function (entries) {
      return Promise.all([entries, A().targetsFor(state.date), S.dayTotals(state.date, entries)]);
    }).then(function (r) {
      var entries = r[0], tg = r[1].tg, dt = r[2];
      var totals = dt.totals;
      totals.sugar = totals.sugar || F.sugarOf(totals) || 0;
      var sc = N.score(totals, tg);
      var hasEntries = entries.length > 0;
      if (!hasEntries) sc.total = 0;
      var cmts = N.comments(sc, tg, { hasEntries: hasEntries });

      var slots = {};
      entries.forEach(function (e) {
        slots[e.slot] = (slots[e.slot] || 0) + ((e.nutrients && e.nutrients.kcal) || 0);
      });
      var missing = ['breakfast', 'lunch', 'dinner'].filter(function (k) { return !slots[k]; });

      view.innerHTML =
        scoreCard(sc, hasEntries, missing) +
        importedCard(dt.imported) +
        commentCard(cmts) +
        detailCard(sc) +
        allNutrientsCard(totals, tg);

      view.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-rich]');
        if (b) showRichFoods(b.getAttribute('data-rich'));
      });
    });
  }

  /* ---- 点数 ---- */
  function scoreCard(sc, hasEntries, missing) {
    var t = sc.total;
    var color = t >= 80 ? 'var(--green)' : (t >= 60 ? 'var(--orange)' : 'var(--red)');
    var label = !hasEntries ? '未記録'
      : t >= 90 ? '素晴らしい' : t >= 80 ? 'とても良い' : t >= 70 ? '良い'
      : t >= 60 ? 'もう少し' : t >= 40 ? '改善の余地あり' : '要改善';
    return '<div class="card"><div class="score-ring">' +
      ring(t, color) +
      '<div><div class="score-num" style="color:' + color + '">' + t +
      '<small> / 100点</small></div>' +
      '<div class="small muted">' + label + '</div></div></div>' +
      (missing.length && hasEntries
        ? '<div class="tiny muted">' + missing.map(jpSlot).join('・') +
          'が未記録です。すべて記録すると採点の精度が上がります。</div>'
        : '') +
      '</div>';
  }

  function jpSlot(k) {
    return { breakfast: '朝食', lunch: '昼食', dinner: '夕食' }[k] || k;
  }

  function ring(t, color) {
    var r = 34, c = 2 * Math.PI * r;
    var off = c * (1 - Math.max(0, Math.min(100, t)) / 100);
    return '<svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">' +
      '<circle cx="42" cy="42" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="8"/>' +
      '<circle cx="42" cy="42" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="8" ' +
      'stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) +
      '" transform="rotate(-90 42 42)"/></svg>';
  }

  /* ---- 取り込み元(あすけん等)の記録 ---- */
  function importedCard(imp) {
    if (!imp) return '';
    var src = imp.source || '取り込みデータ';
    return '<div class="card"><h3>' + A().esc(src) + 'の記録</h3>' +
      (imp.score != null
        ? '<div class="row between"><span class="small">当時の健康度</span><b>' + imp.score + ' 点</b></div>'
        : '') +
      (imp.advice
        ? '<div class="small" style="margin-top:8px;color:var(--tx2)">' + A().esc(imp.advice) + '</div>'
        : '') +
      '<div class="tiny muted" style="margin-top:8px">この日の栄養素は、記録した食品にカロリーしか無いため' +
      A().esc(src) + 'の日次集計で補っています。</div></div>';
  }

  /* ---- コメント ---- */
  function commentCard(cmts) {
    if (!cmts.length) return '';
    return '<div class="card"><h3>アドバイス</h3>' +
      cmts.map(function (c) {
        return '<div class="advice-li"><span>' + c.icon + '</span><span>' + A().esc(c.text) + '</span></div>';
      }).join('') + '</div>';
  }

  /* ---- 採点内訳 ---- */
  function detailCard(sc) {
    var h = '<div class="card"><h3>採点の内訳</h3>';
    sc.detail.forEach(function (d) {
      var m = F.meta(d.key);
      var lim = d.max || d.goal;
      var pct = d.kind === 'max' ? (d.intake / lim) : (d.intake / d.goal);
      var w = Math.max(0, Math.min(100, pct * 100));
      var cls = 'ok';
      if (d.kind === 'min') cls = pct >= 1 ? 'ok' : (pct >= 0.7 ? 'low' : 'bad');
      else if (d.kind === 'max') cls = pct <= 1 ? 'ok' : (pct <= 1.3 ? 'high' : 'bad');
      else cls = Math.abs(pct - 1) <= 0.1 ? 'ok' : (Math.abs(pct - 1) <= 0.25 ? 'high' : 'bad');
      var clickable = (d.kind === 'min' && pct < 1);
      h += '<div class="nut-row">' +
        '<span class="nut-name">' + m[0] + '</span>' +
        '<span class="nut-bar"><i class="' + cls + '" style="width:' + w.toFixed(0) + '%"></i>' +
        (d.kind === 'range' ? '<u style="left:100%"></u>' : '') + '</span>' +
        '<span class="nut-val">' + N.fmt(d.intake) + '/' + N.fmt(lim) + '</span>' +
        '</div>' +
        (clickable ? '<div style="margin:-4px 0 6px 104px"><button class="tiny" data-rich="' + d.key +
          '" style="color:var(--green);text-decoration:underline">' + m[0] + 'が多い食品を見る</button></div>' : '');
    });
    return h + '</div>';
  }

  /* ---- 全栄養素 ---- */
  var SHOW_ALL = [
    'kcal', 'protein', 'fat', 'satfat', 'carb', 'sugar', 'fiber', 'salt', 'chol',
    'k', 'ca', 'mg', 'fe', 'zn',
    'vita', 'vitd', 'vite', 'vitb1', 'vitb2', 'niacin', 'vitb6', 'vitb12', 'folate', 'vitc'
  ];

  function allNutrientsCard(totals, tg) {
    var h = '<div class="card"><h3>栄養素の摂取量</h3>';
    SHOW_ALL.forEach(function (k) {
      var m = F.meta(k);
      var t = tg[k];
      var v = totals[k] || 0;
      var goalTxt = t ? (N.fmt(t.max || t.goal) + (t.kind === 'max' ? ' 以下' : (t.kind === 'min' ? ' 以上' : ''))) : '—';
      h += '<div class="row between" style="padding:5px 0;border-top:1px solid var(--line)">' +
        '<span class="small">' + m[0] + '</span>' +
        '<span class="small"><b>' + N.fmt(v) + '</b> ' + m[1] +
        ' <span class="muted tiny">/ ' + goalTxt + '</span></span></div>';
    });
    h += '<div class="tiny muted" style="margin-top:8px">目標値は「日本人の食事摂取基準(2025年版)」' +
      'の18〜64歳の推奨量・目安量・目標量を基準にしています。妊娠・授乳中や治療中の方は医師の指示を優先してください。</div>';
    return h + '</div>';
  }

  /* ---- その栄養素が多い食品 ---- */
  function showRichFoods(key) {
    var m = F.meta(key);
    A().openSheet(m[0] + 'が多い食品', '<div class="empty">検索中…</div>');
    F.load().then(function (db) {
      var list = db.foods.filter(function (f) {
        return f[key] != null && f[key] > 0 && f.kcal != null;
      });
      list.sort(function (a, b) { return b[key] - a[key]; });
      var top = list.slice(0, 40);
      var html = '<div class="tiny muted" style="margin-bottom:8px">100gあたりの含有量が多い順（食品成分表より）</div>';
      html += top.map(function (f) {
        return '<div class="res"><b>' + A().esc(f.n) + '</b><span>' +
          m[0] + ' ' + N.fmt(f[key]) + ' ' + m[1] + ' ／ ' + Math.round(f.kcal) + ' kcal ／ ' +
          A().esc(F.groupName(f.g)) + '</span></div>';
      }).join('');
      document.getElementById('sheetBody').innerHTML = html;
    });
  }

  Views.advice = { render: render };
})(window);
