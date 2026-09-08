/* ui-body.js - カラダ記録タブ(体重・体脂肪・任意項目・お通じ・トイレ) */
(function (global) {
  'use strict';
  var Views = global.Views || (global.Views = {});
  var S = global.Store, N = global.Nutrition;

  function A() { return global.App; }

  function blank(date) {
    return { date: date, weight: null, bodyFat: null, steps: null, custom: {}, bowel: '', toilet: [], mealTimes: {}, memo: '' };
  }

  function render(view, state) {
    return Promise.all([
      S.Body.get(state.date),
      A().targetsFor(state.date),
      S.Body.all()
    ]).then(function (r) {
      var rec = r[0] || blank(state.date);
      if (!rec.custom) rec.custom = {};
      if (!rec.toilet) rec.toilet = [];
      var st = r[1].settings, tg = r[1].tg;
      var history = r[2];

      view.innerHTML =
        weightCard(rec, st, tg, history) +
        customCard(rec, st) +
        '<div class="card elimination-card">' + bowelCard(rec) + toiletCard(rec, st, history) + '</div>' +
        memoCard(rec);
      bind(view, state, rec, st, history);
    });
  }

  /* ---- 体重・体脂肪 ---- */
  function weightCard(rec, st, tg, history) {
    var h = st.heightCm || 0;
    var bmi = (rec.weight && h) ? (rec.weight / Math.pow(h / 100, 2)) : null;
    var prev = null;
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i].date < rec.date && history[i].weight) { prev = history[i]; break; }
    }
    var diff = (prev && rec.weight) ? (rec.weight - prev.weight) : null;
    var toGoal = (st.goalWeight && rec.weight) ? (rec.weight - st.goalWeight) : null;
    var hasAnySteps = history.some(function (x) {
      return typeof x.steps === 'number' && isFinite(x.steps);
    });

    return '<div class="card"><h3>体重・体脂肪</h3>' +
      '<div class="grid2">' +
        '<label class="fld"><span>体重 (kg)</span><input type="number" inputmode="decimal" step="0.1" ' +
          'id="bWeight" value="' + (rec.weight == null ? '' : rec.weight) + '"></label>' +
        '<label class="fld"><span>体脂肪率 (%)</span><input type="number" inputmode="decimal" step="0.1" ' +
          'id="bFat" value="' + (rec.bodyFat == null ? '' : rec.bodyFat) + '"></label>' +
      '</div>' +
      '<label class="fld"><span>歩数</span><input type="number" inputmode="numeric" ' +
        'id="bSteps" value="' + (rec.steps == null ? '' : rec.steps) + '"></label>' +
      '<button class="btn sub sm" data-stepimport="1">歩数を取り込む</button>' +
      '<div class="step-import-help">ヘルスケアから書き出したZIPを選び、複数日分を一括で取り込みます。</div>' +
      (!hasAnySteps ? '<div class="step-first">まだ歩数を取り込んでいません。ボタンを押して、ヘルスケアの一括書き出し手順を確認してください。</div>' : '') +
      '<div class="small muted">' +
        (bmi ? 'BMI ' + N.fmt(bmi) + '（' + bmiLabel(bmi) + '）' : 'BMIは身長の設定後に表示されます') +
        (diff != null ? ' ／ 前回比 ' + (diff > 0 ? '+' : '') + N.fmt(diff) + ' kg' : '') +
        (toGoal != null ? ' ／ 目標まで ' + N.fmt(Math.max(0, toGoal)) + ' kg' : '') +
      '</div>' +
      '<div class="tiny muted" style="margin-top:6px">推定基礎代謝 ' + tg._bmr +
        ' kcal ／ 消費目安 ' + tg._tdee + ' kcal ／ 目標摂取 ' + tg.kcal.goal + ' kcal</div>' +
      '</div>';
  }

  function bmiLabel(b) {
    if (b < 18.5) return 'やせ';
    if (b < 25) return '普通';
    if (b < 30) return '肥満1度';
    if (b < 35) return '肥満2度';
    return '肥満3度以上';
  }

  /* ---- 任意項目 ---- */
  function customCard(rec, st) {
    var fields = st.customFields || [];
    var h = '<div class="card"><div class="row between" style="margin-bottom:8px">' +
      '<h3 style="margin:0">任意項目</h3>' +
      '<button class="btn sub sm" data-editfields="1">項目を編集</button></div>';
    if (!fields.length) {
      h += '<div class="empty">「項目を編集」から、記録したいもの（筋トレの回数など）を追加できます</div>';
    } else {
      fields.forEach(function (f) {
        var val = rec.custom[f.id];
        if (f.type === 'bool') {
          h += '<div class="row between" style="padding:7px 0">' +
            '<span>' + A().esc(f.label) + '</span>' +
            '<span><button class="chip' + (val === true ? ' on' : '') + '" data-cf="' + A().esc(f.id) +
            '" data-cv="true">あり</button>' +
            '<button class="chip' + (val === false ? ' on' : '') + '" data-cf="' + A().esc(f.id) +
            '" data-cv="false">なし</button></span></div>';
        } else if (f.type === 'count') {
          h += '<div class="row between" style="padding:7px 0">' +
            '<span>' + A().esc(f.label) + '</span>' +
            '<span class="row" style="gap:6px">' +
            '<button class="btn sub sm" data-cstep="' + A().esc(f.id) + '" data-d="-1">−</button>' +
            '<b style="min-width:52px;text-align:center">' + (val || 0) + ' ' + A().esc(f.unit || '') + '</b>' +
            '<button class="btn sub sm" data-cstep="' + A().esc(f.id) + '" data-d="1">＋</button>' +
            '</span></div>';
        } else {
          h += '<label class="fld"><span>' + A().esc(f.label) +
            (f.unit ? ' (' + A().esc(f.unit) + ')' : '') + '</span>' +
            '<input type="number" inputmode="decimal" step="0.1" data-cnum="' + A().esc(f.id) +
            '" value="' + (val == null ? '' : val) + '"></label>';
        }
      });
    }
    return h + '</div>';
  }

  /* ---- お通じ ---- */
  function bowelCard(rec) {
    var opts = [['yes', 'あり'], ['no', 'なし']];
    return '<section class="bowel-section"><div class="bowel-row"><h3>お通じ</h3><div class="bowel-choices">' +
      opts.map(function (o) {
        return '<button class="chip' + (rec.bowel === o[0] ? ' on' : '') +
          '" data-bowel="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<button class="calendar-open" data-bowelcalendar="1" aria-label="お通じカレンダーを開く">📅 <span>履歴</span></button>' +
      '</div></section>';
  }

  /* ---- トイレ(ワンタップ) ---- */
  function toiletCard(rec, st, history) {
    var types = (st.toiletTypes || []).filter(function (t) { return t !== '大'; });
    if (!types.length) types = ['小'];
    var counts = {};
    types.forEach(function (t) { counts[t] = 0; });
    rec.toilet.forEach(function (x) {
      if (counts[x.type] == null) counts[x.type] = 0;
      counts[x.type]++;
    });
    var h = '<section class="toilet-section"><h3>トイレ</h3><div class="toilet-actions">';
    types.forEach(function (t) {
      h += '<button class="toilet-add" data-toilet="' + A().esc(t) + '"><span>＋ ' + A().esc(t) + 'を記録</span>' +
        '<span class="toilet-count">' + (counts[t] || 0) + ' 回</span></button>';
    });
    h += '</div>';
    if (rec.toilet.length) {
      var list = rec.toilet.slice().sort(function (a, b) { return a.t < b.t ? -1 : 1; });
      var timeline = toiletTimeline(rec, history);
      h += '<div style="margin-top:10px">';
      list.forEach(function (x, i) {
        var at = -1, previous = null;
        for (var ti = 0; ti < timeline.length; ti++) {
          if (timeline[ti].item === x && timeline[ti].date === rec.date) { at = ti; break; }
        }
        for (var pi = at - 1; pi >= 0; pi--) {
          if (timeline[pi].type === x.type) { previous = timeline[pi]; break; }
        }
        var interval = previous ? toiletInterval(previous.date, previous.t, rec.date, x.t) : '';
        h += '<div class="log-line"><span>' + A().esc(x.t) + ' ・ ' + A().esc(x.type) +
          (interval ? ' <span class="toilet-interval">（前回から ' + interval + '）</span>' : '') + '</span>' +
          '<button class="tiny muted" data-delToilet="' + i + '" style="text-decoration:underline">削除</button></div>';
      });
      h += '</div>';
    } else {
      h += '<div class="empty" style="margin-top:6px">ボタンを押すと、その時刻で記録されます</div>';
    }
    return h + '</section>';
  }

  function toiletTimeline(rec, history) {
    var rows = (history || []).filter(function (row) { return row.date !== rec.date; });
    rows.push(rec);
    var out = [];
    rows.forEach(function (row) {
      (row.toilet || []).forEach(function (item, index) {
        var stamp = toiletStamp(row.date, item.t);
        if (stamp == null) return;
        out.push({ date: row.date, t: item.t, type: item.type, item: item, index: index, stamp: stamp });
      });
    });
    return out.sort(function (a, b) {
      return a.stamp - b.stamp || a.index - b.index;
    });
  }

  function toiletStamp(date, time) {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    var tm = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
    if (!dm || !tm) return null;
    var h = Number(tm[1]), min = Number(tm[2]);
    if (h >= 24 || min >= 60) return null;
    var d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), h, min, 0, 0);
    return isFinite(d.getTime()) ? d.getTime() : null;
  }

  function toiletInterval(previousDate, previousTime, currentDate, currentTime) {
    // 日付を含む絶対時刻で比較し、前日以前の「小」からの間隔も表示する。
    var from = toiletStamp(previousDate, previousTime);
    var to = toiletStamp(currentDate, currentTime);
    if (from == null || to == null || to < from) return '';
    var diff = Math.round((to - from) / 60000);
    var days = Math.floor(diff / 1440);
    diff %= 1440;
    var hours = Math.floor(diff / 60), mins = diff % 60;
    return (days ? days + '日' : '') + (hours ? hours + '時間' : '') +
      (mins || (!days && !hours) ? mins + '分' : '');
  }

  function memoCard(rec) {
    return '<div class="card"><h3>メモ</h3>' +
      '<textarea id="bMemo" rows="3" placeholder="体調・生理・服薬など">' +
      A().esc(rec.memo || '') + '</textarea></div>';
  }

  /* ---------------- 保存とイベント ---------------- */
  function bind(view, state, rec, st, history) {
    function save(patch, rerender) {
      var restoreScroll = rerender ? window.scrollY : null;
      for (var k in patch) rec[k] = patch[k];
      rec.date = state.date;
      return S.Body.put(rec).then(function () {
        if (rerender) A().render({ restoreScroll: restoreScroll });
      });
    }

    var w = view.querySelector('#bWeight'), f = view.querySelector('#bFat');
    w.addEventListener('change', function () {
      var v = parseFloat(w.value);
      save({ weight: isFinite(v) ? v : null }, true);
    });
    f.addEventListener('change', function () {
      var v = parseFloat(f.value);
      save({ bodyFat: isFinite(v) ? v : null }, false);
    });
    var sp = view.querySelector('#bSteps');
    if (sp) sp.addEventListener('change', function () {
      var v = parseInt(sp.value, 10);
      save({ steps: isFinite(v) ? v : null }, false);
    });
    view.querySelector('#bMemo').addEventListener('change', function (e) {
      save({ memo: e.target.value }, false);
    });

    view.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-bowel],[data-toilet],[data-delToilet],[data-cf],[data-cstep],[data-editfields],[data-bowelcalendar],[data-stepimport]');
      if (!t) return;

      if (t.hasAttribute('data-bowelcalendar')) return openBowelCalendar(state, history);
      if (t.hasAttribute('data-stepimport')) return global.Steps.openImport();
      if (t.hasAttribute('data-editfields')) return editFields(state, st);

      if (t.hasAttribute('data-bowel')) {
        var bowel = t.getAttribute('data-bowel');
        return save({ bowel: rec.bowel === bowel ? '' : bowel }, true);
      }
      if (t.hasAttribute('data-toilet')) {
        var d = new Date();
        var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
        rec.toilet.push({ t: hh + ':' + mm, type: t.getAttribute('data-toilet') });
        return save({}, true);
      }
      if (t.hasAttribute('data-delToilet')) {
        var list = rec.toilet.slice().sort(function (a, b) { return a.t < b.t ? -1 : 1; });
        var target = list[parseInt(t.getAttribute('data-delToilet'), 10)];
        rec.toilet = rec.toilet.filter(function (x) { return x !== target; });
        return save({}, true);
      }
      if (t.hasAttribute('data-cf')) {
        var id = t.getAttribute('data-cf');
        var v = (t.getAttribute('data-cv') === 'true');
        rec.custom[id] = (rec.custom[id] === v) ? undefined : v;
        return save({}, true);
      }
      if (t.hasAttribute('data-cstep')) {
        var id2 = t.getAttribute('data-cstep');
        var d2 = parseInt(t.getAttribute('data-d'), 10);
        rec.custom[id2] = Math.max(0, (rec.custom[id2] || 0) + d2);
        return save({}, true);
      }
    });

    Array.prototype.forEach.call(view.querySelectorAll('[data-cnum]'), function (inp) {
      inp.addEventListener('change', function () {
        var v = parseFloat(inp.value);
        rec.custom[inp.getAttribute('data-cnum')] = isFinite(v) ? v : undefined;
        save({}, false);
      });
    });
  }

  function openBowelCalendar(state, history) {
    // bodyタブ描画時に取得済みの全履歴を再利用。月送りでDBを読み直さない。
    var yes = {}, recorded = {};
    history.forEach(function (r) {
      if (r.bowel === 'yes') yes[r.date] = true;
      if (r.bowel === 'yes' || r.bowel === 'no') recorded[r.date] = r.bowel;
    });
    var base = S.parseYmd(state.date), month = new Date(base.getFullYear(), base.getMonth(), 1);
    var today = S.ymd(new Date());
    var body = A().openSheet('お通じカレンダー', '<div id="bowelCalendar"></div>');
    var host = body.querySelector('#bowelCalendar');
    function draw() {
      var year = month.getFullYear(), m = month.getMonth();
      var count = new Date(year, m + 1, 0).getDate(), cells = '';
      for (var i = 0; i < month.getDay(); i++) cells += '<span class="cal-blank"></span>';
      for (var d = 1; d <= count; d++) {
        var date = S.ymd(new Date(year, m, d)), had = !!yes[date], no = recorded[date] === 'no';
        cells += '<button class="cal-day' + (date === state.date ? ' selected' : '') +
          (date === today ? ' today' : '') + (had ? ' has-bowel' : '') +
          '" data-caldate="' + date + '" aria-label="' + date + ' お通じ' +
          (had ? 'あり' : no ? 'なし' : '未記録') + '"' +
          (date === state.date ? ' aria-current="date"' : '') + '><span>' + d +
          '</span><span class="cal-mark">' + (had ? '✓' : no ? '−' : '') + '</span></button>';
      }
      host.innerHTML = '<div class="cal-header"><button class="btn sub sm" data-month="-1" aria-label="前の月">‹</button>' +
        '<b>' + year + '年 ' + (m + 1) + '月</b><button class="btn sub sm" data-month="1" aria-label="次の月">›</button></div>' +
        '<div class="cal-grid cal-week">' + ['日','月','火','水','木','金','土'].map(function (day) { return '<span>' + day + '</span>'; }).join('') +
        '</div><div class="cal-grid">' + cells + '</div><p class="small muted">✓ あり　− なし　空欄 未記録<br>日付を押すと、その日の記録に移動します。</p>';
    }
    host.addEventListener('click', function (e) {
      var nav = e.target.closest('[data-month]'), day = e.target.closest('[data-caldate]');
      if (nav) { month.setMonth(month.getMonth() + Number(nav.dataset.month)); draw(); }
      if (day) { A().closeSheet(); A().setDate(day.dataset.caldate); }
    });
    draw();
  }

  /* ---------------- 任意項目の編集 ---------------- */
  function editFields(state, st) {
    var fields = (st.customFields || []).slice();
    var body = A().openSheet('任意項目の編集', '<div id="fList"></div>' +
      '<button class="btn line wide" id="addField" style="margin-top:6px">＋ 項目を追加</button>' +
      '<button class="btn wide" id="saveFields" style="margin-top:10px">保存する</button>' +
      '<div class="tiny muted" style="margin-top:10px">タイプ: 「回数」は＋−ボタンで数える項目（筋トレなど）、' +
      '「あり/なし」は2択、「数値」は自由入力（睡眠時間・血圧など）。</div>');

    function draw() {
      body.querySelector('#fList').innerHTML = fields.map(function (f, i) {
        return '<div class="card">' +
          '<label class="fld"><span>項目名</span><input type="text" data-fl="' + i + '" value="' +
            A().esc(f.label) + '"></label>' +
          '<div class="grid2">' +
          '<label class="fld"><span>タイプ</span><select data-ft="' + i + '">' +
            opt('count', '回数', f.type) + opt('bool', 'あり/なし', f.type) + opt('number', '数値', f.type) +
          '</select></label>' +
          '<label class="fld"><span>単位</span><input type="text" data-fu="' + i + '" value="' +
            A().esc(f.unit || '') + '"></label></div>' +
          '<button class="btn sub sm" data-fd="' + i + '">この項目を削除</button></div>';
      }).join('') || '<div class="empty">項目がありません</div>';
    }
    function opt(v, label, cur) {
      return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    }

    body.addEventListener('click', function (e) {
      var d = e.target.closest('[data-fd]');
      if (d) {
        fields.splice(parseInt(d.getAttribute('data-fd'), 10), 1);
        sync(); draw();
      }
    });
    body.querySelector('#addField').addEventListener('click', function () {
      sync();
      fields.push({ id: S.uid(), label: '', type: 'count', unit: '回' });
      draw();
    });
    function sync() {
      Array.prototype.forEach.call(body.querySelectorAll('[data-fl]'), function (inp) {
        fields[+inp.getAttribute('data-fl')].label = inp.value;
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-ft]'), function (sel) {
        fields[+sel.getAttribute('data-ft')].type = sel.value;
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-fu]'), function (inp) {
        fields[+inp.getAttribute('data-fu')].unit = inp.value;
      });
    }
    body.querySelector('#saveFields').addEventListener('click', function () {
      sync();
      var clean = fields.filter(function (f) { return f.label.trim(); });
      clean.forEach(function (f) { if (!f.id) f.id = S.uid(); });
      S.Settings.save({ customFields: clean }).then(function () {
        return A().reloadSettings();
      }).then(function () {
        A().closeSheet(); A().toast('保存しました'); A().render();
      });
    });
    draw();
  }

  Views.body = { render: render };
})(window);
