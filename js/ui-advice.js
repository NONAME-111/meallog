/* ui-advice.js - 栄養採点とアドバイスのタブ */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  function A() { return global.App; }

  /* 採点する期間。1日=その日だけ、7/30日=その日までの平均。 */
  var PERIODS = [
    { key: 1, label: '当日' },
    { key: 7, label: '過去7日' },
    { key: 30, label: '過去30日' }
  ];
  var period = 1;

  function render(view, state) {
    return (period === 1 ? renderDay(view, state) : renderRange(view, state, period))
      .then(function () { bindSeg(view, state); });
  }

  function segHtml() {
    return '<div class="seg" id="periodSeg">' + PERIODS.map(function (p) {
      return '<button' + (p.key === period ? ' class="on"' : '') +
        ' data-p="' + p.key + '">' + p.label + '</button>';
    }).join('') + '</div>';
  }

  function bindSeg(view, state) {
    var seg = view.querySelector('#periodSeg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('[data-p]');
        if (!b) return;
        period = parseInt(b.dataset.p, 10);
        A().render();
      });
    }
    view.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-rich]');
      if (b) showRichFoods(b.getAttribute('data-rich'));
    });
    void state;
  }

  /* ---------------- 当日 ---------------- */
  function renderDay(view, state) {
    return S.Entries.byDate(state.date).then(function (all) {
      var entries = all.filter(S.notSkip);
      return Promise.all([all, entries, A().targetsFor(state.date), S.dayTotals(state.date, all)]);
    }).then(function (r) {
      var all = r[0], entries = r[1], tg = r[2].tg, dt = r[3];
      var totals = dt.totals;
      if (typeof totals.sugar !== 'number') {
        var sugar = F.sugarOf(totals);
        if (sugar != null) totals.sugar = sugar;
      }
      var sc = N.score(totals, tg, { coverage: dt.coverage, estimated: dt.estimated });
      var hasEntries = entries.length > 0;
      if (!hasEntries) { sc.total = 0; sc.insufficient = false; }
      var cmts = N.comments(sc, tg, { hasEntries: hasEntries });

      var slots = {};
      entries.forEach(function (e) {
        slots[e.slot] = (slots[e.slot] || 0) + ((e.nutrients && e.nutrients.kcal) || 0);
      });
      // 「食べなかった」と記録した食事は、未記録として数えない
      var missing = ['breakfast', 'lunch', 'dinner'].filter(function (k) {
        return !slots[k] && !S.Entries.isSkipped(all, k);
      });

      view.innerHTML =
        segHtml() +
        scoreCard(sc, hasEntries, missing, '') +
        importedCard(dt.imported) +
        commentCard(cmts) +
        detailCard(sc) +
        allNutrientsCard(totals, tg, dt.coverage, dt.estimated);
    });
  }

  /* ---------------- 過去7日 / 過去30日 ---------------- */
  function renderRange(view, state, days) {
    var to = state.date;
    var from = S.shiftYmd(to, -(days - 1));
    var list = [];
    for (var d = from; d <= to; d = S.shiftYmd(d, 1)) list.push(d);

    return Promise.all([
      S.Entries.range(from, to),
      A().targetsFor(to)
    ]).then(function (r) {
      var rows = r[0], tg = r[1].tg;
      var byDay = {};
      rows.forEach(function (e) { (byDay[e.date] = byDay[e.date] || []).push(e); });

      // 日ごとの合計を出す(取り込み済みの日次集計も dayTotals が面倒を見る)
      return Promise.all(list.map(function (d) {
        return S.dayTotals(d, byDay[d] || []).then(function (dt) {
          var real = (byDay[d] || []).filter(S.notSkip);
          return {
            date: d, totals: dt.totals, coverage: dt.coverage, estimated: dt.estimated,
            tracked: real.length > 0 || (byDay[d] || []).length > 0
          };
        });
      })).then(function (daysData) {
        var tracked = daysData.filter(function (x) { return x.tracked; });
        if (!tracked.length) {
          view.innerHTML = segHtml() +
            '<div class="card"><div class="empty">この期間に記録がありません</div></div>';
          return;
        }
        // 記録した日だけで平均する(記録していない日を0として引きずらないため)
        var avg = {}, coverageNumerator = {}, estimatedNumerator = {}, coveredKcal = 0;
        tracked.forEach(function (x) {
          for (var k in x.totals) {
            if (typeof x.totals[k] === 'number') avg[k] = (avg[k] || 0) + x.totals[k];
          }
          var dayKcal = (typeof x.totals.kcal === 'number' && x.totals.kcal > 0) ? x.totals.kcal : 0;
          coveredKcal += dayKcal;
          Object.keys(x.coverage || {}).forEach(function (key) {
            coverageNumerator[key] = (coverageNumerator[key] || 0) + x.coverage[key] * dayKcal;
          });
          Object.keys(x.estimated || {}).forEach(function (key2) {
            estimatedNumerator[key2] = (estimatedNumerator[key2] || 0) + x.estimated[key2] * dayKcal;
          });
        });
        for (var k2 in avg) avg[k2] = F.round(avg[k2] / tracked.length, 2);
        if (typeof avg.sugar !== 'number') {
          var sugar2 = F.sugarOf(avg);
          if (sugar2 != null) avg.sugar = sugar2;
        }
        var avgCoverage = {}, avgEstimated = {};
        F.KEYS.concat(['sugar']).forEach(function (key3) {
          avgCoverage[key3] = coveredKcal ? (coverageNumerator[key3] || 0) / coveredKcal : 0;
          avgEstimated[key3] = coveredKcal ? (estimatedNumerator[key3] || 0) / coveredKcal : 0;
        });

        var sc = N.score(avg, tg, { coverage: avgCoverage, estimated: avgEstimated });
        var cmts = N.comments(sc, tg, { hasEntries: true });
        var note = days + '日のうち ' + tracked.length + ' 日分の平均です' +
          (tracked.length < days ? '（記録のない ' + (days - tracked.length) + ' 日は除いています）' : '');

        view.innerHTML =
          segHtml() +
          scoreCard(sc, true, [], note) +
          dailyScoreCard(daysData, tg) +
          commentCard(cmts) +
          detailCard(sc) +
          allNutrientsCard(avg, tg, avgCoverage, avgEstimated);
      });
    });
  }

  /* 期間中の日ごとの点数 */
  function dailyScoreCard(daysData, tg) {
    var h = '<div class="card"><h3>日ごとの点数</h3><div class="daybars">';
    daysData.forEach(function (x) {
      if (!x.tracked) {
        h += '<div class="daybar"><i style="height:0"></i><span class="tiny muted">—</span></div>';
        return;
      }
      var t = N.score(x.totals, tg, { coverage: x.coverage, estimated: x.estimated }).total;
      if (t == null) {
        h += '<div class="daybar" title="' + A().esc(x.date) + ' データ不足">' +
          '<i style="height:2%;background:var(--line)"></i><span class="tiny muted">?</span></div>';
        return;
      }
      var col = t >= 80 ? 'var(--green)' : (t >= 60 ? 'var(--orange)' : 'var(--red)');
      h += '<div class="daybar" title="' + A().esc(x.date) + ' ' + t + '点">' +
        '<i style="height:' + Math.max(2, t) + '%;background:' + col + '"></i>' +
        '<span class="tiny muted">' + (+x.date.slice(8, 10)) + '</span></div>';
    });
    return h + '</div><div class="tiny muted" style="margin-top:6px">' +
      '棒の高さがその日の点数、下の数字は日付です。「—」は記録のない日です。</div></div>';
  }

  /* ---- 点数 ---- */
  function scoreCard(sc, hasEntries, missing, note) {
    var t = sc.total;
    var dataShort = hasEntries && t == null;
    var shown = dataShort ? 0 : (t || 0);
    var color = dataShort ? 'var(--tx3)'
      : t >= 80 ? 'var(--green)' : (t >= 60 ? 'var(--orange)' : 'var(--red)');
    var label = !hasEntries ? '未記録' : dataShort ? 'データ不足'
      : t >= 90 ? '素晴らしい' : t >= 80 ? 'とても良い' : t >= 70 ? '良い'
      : t >= 60 ? 'もう少し' : t >= 40 ? '改善の余地あり' : '要改善';
    return '<div class="card"><div class="score-ring">' +
      ring(shown, color) +
      '<div><div class="score-num" style="color:' + color + '">' + (dataShort ? '—' : t) +
      (dataShort ? '' : '<small> / 100点</small>') + '</div>' +
      '<div class="small muted">' + label + '</div></div></div>' +
      (dataShort ? '<div class="tiny muted">主要な採点項目の半分以上で、記録の60%に栄養データが届いていません。</div>' : '') +
      (sc.hasEstimated ? '<div class="tiny muted">この点数には食品成分表からの推定値を含みます。</div>' : '') +
      (note ? '<div class="tiny muted">' + A().esc(note) + '</div>' : '') +
      (missing.length && hasEntries
        ? '<div class="tiny muted">' + missing.map(jpSlot).join('・') +
          'が未記録です。食べなかった場合は記録タブで「食べなかった」を押しておくと、' +
          '採点の精度が上がります。</div>'
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
      if (d.excluded) {
        h += '<div class="nut-row" style="align-items:flex-start">' +
          '<span class="nut-name">' + m[0] + '</span>' +
          '<span class="small muted grow">データ不足のため採点対象外（記録カロリーの' +
          Math.round((d.coverage || 0) * 100) + '%）</span></div>';
        return;
      }
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
        '<span class="nut-val">' + (d.estimated > 0 ? '約' : '') + N.fmt(d.intake) + '/' + N.fmt(lim) + '</span>' +
        '</div>' +
        (d.estimated > 0 ? '<div class="tiny muted" style="margin:-4px 0 6px 104px">推定を含む（記録カロリーの' +
          Math.round(d.estimated * 100) + '%）</div>' : '') +
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

  function allNutrientsCard(totals, tg, coverage, estimated) {
    var h = '<div class="card"><h3>栄養素の摂取量</h3>';
    SHOW_ALL.forEach(function (k) {
      var m = F.meta(k);
      var t = tg[k];
      var known = typeof totals[k] === 'number' && isFinite(totals[k]);
      var v = known ? totals[k] : null;
      var cov = coverage && typeof coverage[k] === 'number' ? coverage[k] : (known ? 1 : 0);
      var est = estimated && typeof estimated[k] === 'number' ? estimated[k] : 0;
      var approximate = known && (est > 0 || cov < 0.999);
      var goalTxt = t ? (N.fmt(t.max || t.goal) + (t.kind === 'max' ? ' 以下' : (t.kind === 'min' ? ' 以上' : ''))) : '—';
      h += '<div class="row between" style="padding:5px 0;border-top:1px solid var(--line)">' +
        '<span class="small">' + m[0] + '</span>' +
        '<span class="small"><b>' + (approximate ? '約' : '') + (known ? N.fmt(v) : '—') + '</b> ' + m[1] +
        (est > 0 ? ' <span class="tiny muted">推定</span>' : '') +
        (known && cov < 0.60 ? ' <span class="tiny muted">データ不足</span>' : '') +
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
