/* ui-advice.js - 栄養採点とアドバイスのタブ */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, F = global.Foods, N = global.Nutrition;

  function A() { return global.App; }

  var PERIODS = [
    { key: 1, label: '当日' }, { key: 7, label: '過去7日' }, { key: 30, label: '過去30日' }
  ];
  var period = 1;
  var openGroups = { pfc: true };

  var GROUPS = [
    { key: 'kcal', icon: '🔥', label: 'カロリー', weight: 20, scored: ['kcal'], extra: [] },
    { key: 'pfc', icon: '🍚', label: 'PFCバランス', weight: 28,
      scored: ['protein', 'fat', 'sugar'], extra: ['carb'] },
    { key: 'quality', icon: '🧂', label: '塩分・脂質の質', weight: 16,
      scored: ['salt', 'satfat'], extra: ['monofat', 'polyfat', 'n3', 'n6', 'chol'] },
    { key: 'micro', icon: '🥬', label: 'ビタミン・ミネラル', weight: 36,
      scored: ['fiber', 'ca', 'fe', 'vita', 'vitb1', 'vitb2', 'vitc'],
      extra: ['k', 'mg', 'zn', 'vitd', 'vite', 'niacin', 'vitb6', 'vitb12', 'folate'] },
    { key: 'exercise', icon: '🏃', label: '運動', weight: 10, scored: ['exercise'], extra: [] }
  ];

  function render(view, state) {
    return (period === 1 ? renderDay(view, state) : renderRange(view, state, period))
      .then(function () { bind(view, state); });
  }

  function segHtml() {
    return '<div class="seg" id="periodSeg">' + PERIODS.map(function (p) {
      return '<button' + (p.key === period ? ' class="on"' : '') +
        ' data-p="' + p.key + '">' + p.label + '</button>';
    }).join('') + '</div>';
  }

  function bind(view) {
    var seg = view.querySelector('#periodSeg');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]');
      if (!b) return;
      period = parseInt(b.dataset.p, 10); A().render();
    });
    view.addEventListener('click', function (ev) {
      var group = ev.target.closest('[data-score-group]');
      if (group) {
        var key = group.getAttribute('data-score-group');
        openGroups[key] = !openGroups[key];
        A().render();
        return;
      }
      var rich = ev.target.closest('[data-rich]');
      if (rich) showRichFoods(rich.getAttribute('data-rich'));
    });
  }

  function activityFor(exercises, body) {
    exercises = exercises || [];
    var exerciseKcal = exercises.reduce(function (sum, x) {
      return sum + (typeof x.kcal === 'number' && isFinite(x.kcal) ? x.kcal : 0);
    }, 0);
    var hasExercise = exercises.length > 0;
    var hasSteps = !!(body && typeof body.steps === 'number' && isFinite(body.steps));
    var steps = hasSteps ? Math.max(0, body.steps) : null;
    var stepKcal = hasSteps ? steps * 0.025 : 0; // 8,000歩 ≒ 200kcal
    return {
      hasData: hasExercise || hasSteps,
      value: F.round(exerciseKcal + stepKcal, 1),
      exerciseKcal: F.round(exerciseKcal, 1), stepKcal: F.round(stepKcal, 1), steps: steps
    };
  }

  function addActivity(totals, coverage, estimated, activity) {
    totals = Object.assign({}, totals || {});
    coverage = Object.assign({}, coverage || {});
    estimated = Object.assign({}, estimated || {});
    if (activity.hasData) totals.exercise = activity.value;
    else delete totals.exercise;
    coverage.exercise = activity.hasData ? 1 : 0;
    estimated.exercise = 0;
    return { totals: totals, coverage: coverage, estimated: estimated };
  }

  function renderDay(view, state) {
    return S.Entries.byDate(state.date).then(function (all) {
      var entries = all.filter(S.notSkip);
      return Promise.all([
        all, entries, A().targetsFor(state.date), S.dayTotals(state.date, all),
        S.Exercise.byDate(state.date), S.Body.get(state.date)
      ]);
    }).then(function (r) {
      var all = r[0], entries = r[1], tg = r[2].tg, dt = r[3];
      var activity = activityFor(r[4], r[5]);
      var data = addActivity(dt.totals, dt.coverage, dt.estimated, activity);
      if (typeof data.totals.sugar !== 'number') {
        var sugar = F.sugarOf(data.totals); if (sugar != null) data.totals.sugar = sugar;
      }
      var sc = N.score(data.totals, tg, { coverage: data.coverage, estimated: data.estimated });
      var hasEntries = entries.length > 0;
      if (!hasEntries) { sc.total = 0; sc.insufficient = false; }
      var cmts = N.comments(sc, tg, { hasEntries: hasEntries });
      var slots = {};
      entries.forEach(function (e) { slots[e.slot] = (slots[e.slot] || 0) + ((e.nutrients && e.nutrients.kcal) || 0); });
      var missing = ['breakfast', 'lunch', 'dinner'].filter(function (key) {
        return !slots[key] && !S.Entries.isSkipped(all, key);
      });
      view.innerHTML = segHtml() + scoreCard(sc, hasEntries, missing, '') + commentCard(cmts) +
        importedCard(dt.imported) + groupedCard(sc, data.totals, tg, data.coverage, data.estimated, activity);
    });
  }

  function renderRange(view, state, days) {
    var to = state.date, from = S.shiftYmd(to, -(days - 1)), dates = [];
    for (var d = from; d <= to; d = S.shiftYmd(d, 1)) dates.push(d);
    return Promise.all([
      S.Entries.range(from, to), A().targetsFor(to), S.Exercise.range(from, to), S.Body.all()
    ]).then(function (r) {
      var rows = r[0], tg = r[1].tg, byDay = {}, exByDay = {}, bodyByDay = {};
      rows.forEach(function (e) { (byDay[e.date] = byDay[e.date] || []).push(e); });
      r[2].forEach(function (e) { (exByDay[e.date] = exByDay[e.date] || []).push(e); });
      r[3].forEach(function (b) { if (b.date >= from && b.date <= to) bodyByDay[b.date] = b; });
      return Promise.all(dates.map(function (date) {
        return S.dayTotals(date, byDay[date] || []).then(function (dt) {
          var real = (byDay[date] || []).filter(S.notSkip);
          var activity = activityFor(exByDay[date] || [], bodyByDay[date]);
          var data = addActivity(dt.totals, dt.coverage, dt.estimated, activity);
          if (typeof data.totals.sugar !== 'number') {
            var sugar = F.sugarOf(data.totals); if (sugar != null) data.totals.sugar = sugar;
          }
          return {
            date: date, totals: data.totals, coverage: data.coverage, estimated: data.estimated,
            activity: activity, tracked: real.length > 0 || (byDay[date] || []).length > 0
          };
        });
      })).then(function (daysData) {
        var tracked = daysData.filter(function (x) { return x.tracked; });
        if (!tracked.length) {
          view.innerHTML = segHtml() + '<div class="card"><div class="empty">この期間に記録がありません</div></div>';
          return;
        }
        var avg = {}, coverageNumerator = {}, estimatedNumerator = {}, coveredKcal = 0;
        tracked.forEach(function (x) {
          for (var k in x.totals) {
            if (k !== 'exercise' && typeof x.totals[k] === 'number') avg[k] = (avg[k] || 0) + x.totals[k];
          }
          var dayKcal = typeof x.totals.kcal === 'number' && x.totals.kcal > 0 ? x.totals.kcal : 0;
          coveredKcal += dayKcal;
          Object.keys(x.coverage || {}).forEach(function (key) {
            if (key !== 'exercise') coverageNumerator[key] = (coverageNumerator[key] || 0) + x.coverage[key] * dayKcal;
          });
          Object.keys(x.estimated || {}).forEach(function (key) {
            if (key !== 'exercise') estimatedNumerator[key] = (estimatedNumerator[key] || 0) + x.estimated[key] * dayKcal;
          });
        });
        for (var key2 in avg) avg[key2] = F.round(avg[key2] / tracked.length, 2);
        var avgCoverage = {}, avgEstimated = {};
        F.KEYS.concat(['sugar']).forEach(function (key) {
          avgCoverage[key] = coveredKcal ? (coverageNumerator[key] || 0) / coveredKcal : 0;
          avgEstimated[key] = coveredKcal ? (estimatedNumerator[key] || 0) / coveredKcal : 0;
        });
        var activeDays = tracked.filter(function (x) { return x.activity.hasData; });
        var rangeActivity = {
          hasData: activeDays.length > 0,
          value: activeDays.length ? F.round(activeDays.reduce(function (s, x) { return s + x.activity.value; }, 0) / activeDays.length, 1) : 0,
          exerciseKcal: activeDays.length ? F.round(activeDays.reduce(function (s, x) { return s + x.activity.exerciseKcal; }, 0) / activeDays.length, 1) : 0,
          stepKcal: activeDays.length ? F.round(activeDays.reduce(function (s, x) { return s + x.activity.stepKcal; }, 0) / activeDays.length, 1) : 0,
          steps: null, days: activeDays.length, totalDays: tracked.length
        };
        if (rangeActivity.hasData) avg.exercise = rangeActivity.value;
        avgCoverage.exercise = activeDays.length / tracked.length;
        avgEstimated.exercise = 0;
        var sc = N.score(avg, tg, { coverage: avgCoverage, estimated: avgEstimated });
        var cmts = N.comments(sc, tg, { hasEntries: true });
        var note = days + '日のうち ' + tracked.length + ' 日分の平均です' +
          (tracked.length < days ? '（記録のない ' + (days - tracked.length) + ' 日は除いています）' : '');
        view.innerHTML = segHtml() + scoreCard(sc, true, [], note) + commentCard(cmts) +
          dailyScoreCard(daysData, tg) + groupedCard(sc, avg, tg, avgCoverage, avgEstimated, rangeActivity);
      });
    });
  }

  function dailyScoreCard(daysData, tg) {
    var h = '<div class="card"><h3>日ごとの点数</h3><div class="daybars">';
    daysData.forEach(function (x) {
      if (!x.tracked) {
        h += '<div class="daybar"><i style="height:0"></i><span class="tiny muted">—</span></div>'; return;
      }
      var t = N.score(x.totals, tg, { coverage: x.coverage, estimated: x.estimated }).total;
      if (t == null) {
        h += '<div class="daybar" title="' + A().esc(x.date) + ' データ不足"><i style="height:2%;background:var(--line)"></i><span class="tiny muted">?</span></div>'; return;
      }
      var color = t >= 80 ? 'var(--green)' : (t >= 60 ? 'var(--orange)' : 'var(--red)');
      h += '<div class="daybar" title="' + A().esc(x.date) + ' ' + t + '点"><i style="height:' +
        Math.max(2, t) + '%;background:' + color + '"></i><span class="tiny muted">' + (+x.date.slice(8, 10)) + '</span></div>';
    });
    return h + '</div><div class="tiny muted" style="margin-top:6px">棒の高さがその日の点数、下の数字は日付です。「—」は記録のない日です。</div></div>';
  }

  function scoreCard(sc, hasEntries, missing, note) {
    var t = sc.total, dataShort = hasEntries && t == null, shown = dataShort ? 0 : (t || 0);
    var color = dataShort ? 'var(--tx3)' : t >= 80 ? 'var(--green)' : (t >= 60 ? 'var(--orange)' : 'var(--red)');
    var label = !hasEntries ? '未記録' : dataShort ? 'データ不足' : t >= 90 ? '素晴らしい' :
      t >= 80 ? 'とても良い' : t >= 70 ? '良い' : t >= 60 ? 'もう少し' : t >= 40 ? '改善の余地あり' : '要改善';
    return '<div class="card score-card"><div class="score-ring">' + ring(shown, color) +
      '<div><div class="score-num" style="color:' + color + '">' + (dataShort ? '—' : t) +
      (dataShort ? '' : '<small> / 100点</small>') + '</div><div class="small muted">' + label + '</div></div></div>' +
      (dataShort ? '<div class="tiny muted">主要な採点項目の半分以上で栄養データが不足しています。</div>' : '') +
      (sc.hasEstimated ? '<div class="tiny muted">この点数には食品成分表からの推定値を含みます。</div>' : '') +
      (note ? '<div class="tiny muted">' + A().esc(note) + '</div>' : '') +
      (missing.length && hasEntries ? '<div class="tiny muted">' + missing.map(jpSlot).join('・') +
        'が未記録です。食べなかった場合は記録タブで「食べなかった」を押すと採点の精度が上がります。</div>' : '') + '</div>';
  }

  function jpSlot(key) { return { breakfast: '朝食', lunch: '昼食', dinner: '夕食' }[key] || key; }
  function ring(t, color) {
    var r = 34, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, t)) / 100);
    return '<svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="' + r +
      '" fill="none" stroke="var(--line)" stroke-width="8"/><circle cx="42" cy="42" r="' + r +
      '" fill="none" stroke="' + color + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' +
      c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 42 42)"/></svg>';
  }

  function importedCard(imp) {
    if (!imp) return '';
    var src = imp.source || '取り込みデータ';
    return '<div class="card"><h3>' + A().esc(src) + 'の記録</h3>' +
      (imp.score != null ? '<div class="row between"><span class="small">当時の健康度</span><b>' + imp.score + ' 点</b></div>' : '') +
      (imp.advice ? '<div class="small" style="margin-top:8px;color:var(--tx2)">' + A().esc(imp.advice) + '</div>' : '') +
      '<div class="tiny muted" style="margin-top:8px">この日の栄養素は、記録した食品にカロリーしか無いため' +
      A().esc(src) + 'の日次集計で補っています。</div></div>';
  }

  function commentCard(comments) {
    if (!comments.length) return '';
    return '<div class="card advice-card"><h3>アドバイス</h3>' + comments.map(function (c) {
      return '<div class="advice-li"><span>' + c.icon + '</span><span>' + A().esc(c.text) + '</span></div>';
    }).join('') + '</div>';
  }

  function groupedCard(sc, totals, tg, coverage, estimated, activity) {
    var byKey = {};
    sc.detail.forEach(function (d) { byKey[d.key] = d; });
    var h = '<div class="card score-groups"><div class="row between"><h3>採点と摂取量</h3>' +
      '<span class="tiny muted">区分をタップして展開</span></div>';
    GROUPS.forEach(function (group) {
      var opened = !!openGroups[group.key], sum = 0, included = 0;
      group.scored.forEach(function (key) {
        var d = byKey[key]; if (!d || d.excluded) return;
        sum += d.sc * d.weight; included += d.weight;
      });
      var points = included ? sum / included * group.weight : null;
      var pct = points == null ? 0 : points / group.weight * 100;
      var color = points == null ? 'muted' : pct >= 80 ? 'ok' : pct >= 60 ? 'high' : 'bad';
      h += '<section class="score-group"><button class="score-group-head" data-score-group="' + group.key +
        '" aria-expanded="' + opened + '"><span class="score-group-title"><span>' + group.icon + '</span><b>' +
        group.label + '</b></span><span class="score-group-result ' + color + '">' +
        (points == null ? '対象外' : N.fmt(points) + ' / ' + group.weight + '点') +
        ' <i>' + (opened ? '⌃' : '⌄') + '</i></span></button>' +
        '<div class="score-group-bar"><i class="' + color + '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>';
      if (opened) {
        h += '<div class="score-group-body">';
        group.scored.concat(group.extra).forEach(function (key) {
          h += nutrientRow(key, byKey[key], totals, tg, coverage, estimated, activity);
        });
        if (group.key === 'exercise' && (!activity || !activity.hasData)) {
          h += '<div class="exercise-connect">歩数を連携すると運動も採点されます。記録タブで運動を追加することもできます。</div>';
        }
        h += '</div>';
      }
      h += '</section>';
    });
    return h + '<div class="tiny muted score-source">目標値は「日本人の食事摂取基準(2025年版)」の18〜64歳の推奨量・目安量・目標量が基準です。</div></div>';
  }

  function nutrientRow(key, detail, totals, tg, coverage, estimated, activity) {
    var meta = F.meta(key), target = tg[key], value = detail ? detail.intake : totals[key];
    var known = typeof value === 'number' && isFinite(value);
    var cov = detail ? detail.coverage : (coverage && typeof coverage[key] === 'number' ? coverage[key] : (known ? 1 : 0));
    var est = detail ? detail.estimated : (estimated && estimated[key]) || 0;
    var limit = target ? (target.max || target.goal) : null;
    var ratio = known && limit ? value / limit : 0;
    var cls = 'ok';
    if (!known || (detail && detail.excluded)) cls = 'muted';
    else if (target && target.kind === 'min') cls = ratio >= 1 ? 'ok' : (ratio >= 0.7 ? 'low' : 'bad');
    else if (target && target.kind === 'max') cls = ratio <= 1 ? 'ok' : (ratio <= 1.3 ? 'high' : 'bad');
    else if (target) cls = Math.abs(ratio - 1) <= 0.1 ? 'ok' : (Math.abs(ratio - 1) <= 0.25 ? 'high' : 'bad');
    var clickable = detail && !detail.excluded && detail.kind === 'min' && detail.ratio < 1 && key !== 'exercise';
    var tag = clickable ? 'button' : 'div';
    var h = '<' + tag + ' class="nut-detail' + (clickable ? ' tappable' : '') + '"' +
      (clickable ? ' data-rich="' + key + '"' : '') + '><div class="nut-detail-top"><span class="nut-name">' +
      A().esc(meta[0]) + '</span><span class="nut-val"><b>' + (est > 0 ? '約' : '') +
      (known ? N.fmt(value) : '—') + '</b> ' + A().esc(meta[1]);
    if (target) h += ' <span class="muted">/ ' + N.fmt(limit) + (target.kind === 'min' ? '以上' : target.kind === 'max' ? '以下' : '') + '</span>';
    h += '</span></div>';
    if (target) h += '<div class="nut-bar"><i class="' + cls + '" style="width:' +
      Math.max(0, Math.min(100, ratio * 100)) + '%"></i></div>';
    h += '<div class="nut-flags">' + (detail && detail.excluded ? '<span>採点対象外</span>' : '') +
      (key !== 'exercise' && cov < 0.999 ? '<span>カバー ' + Math.round(cov * 100) + '%</span>' : '') +
      (est > 0 ? '<span>推定 ' + Math.round(est * 100) + '%</span>' : '') +
      (clickable ? '<span class="rich-hint">多い食品を見る ›</span>' : '') + '</div>';
    if (key === 'exercise' && activity && activity.hasData) {
      h += '<div class="tiny muted activity-breakdown">運動記録 ' + N.fmt(activity.exerciseKcal) +
        ' kcal ＋ 歩数由来 ' + N.fmt(activity.stepKcal) + ' kcal' +
        (activity.steps != null ? '（' + Math.round(activity.steps).toLocaleString() + '歩）' :
          activity.days != null ? '（データあり ' + activity.days + '/' + activity.totalDays + '日）' : '') + '</div>';
    }
    return h + '</' + tag + '>';
  }

  function showRichFoods(key) {
    var meta = F.meta(key);
    A().openSheet(meta[0] + 'が多い食品', '<div class="empty">検索中…</div>');
    F.load().then(function (db) {
      var list = db.foods.filter(function (food) { return food[key] != null && food[key] > 0 && food.kcal != null; });
      list.sort(function (a, b) { return b[key] - a[key]; });
      var html = '<div class="tiny muted" style="margin-bottom:8px">100gあたりの含有量が多い順（食品成分表より）</div>' +
        list.slice(0, 40).map(function (food) {
          return '<div class="res"><b>' + A().esc(food.n) + '</b><span>' + meta[0] + ' ' + N.fmt(food[key]) + ' ' +
            meta[1] + ' ／ ' + Math.round(food.kcal) + ' kcal ／ ' + A().esc(F.groupName(food.g)) + '</span></div>';
        }).join('');
      document.getElementById('sheetBody').innerHTML = html;
    });
  }

  Views.advice = { render: render };
})(window);
