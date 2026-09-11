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
          trashCard(st) +
          dataCard() +
          aboutCard();
        bind(view, st);
      });
  }

  /* 記録が消えたときの受け皿。何がいつ何によって消えたかを見せ、1件ずつ戻せる */
  function trashCard(st) {
    var list = (st.trash || []).filter(function (x) { return x && x.rec; });
    if (!list.length) return '';
    var slots = { breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食' };
    return '<div class="card"><h3>最近削除した記録</h3>' +
      '<div class="small muted" style="margin-bottom:8px">消した記録を ' + list.length +
      ' 件、控えとして預かっています。心当たりのないものがあれば、ここから戻せます。</div>' +
      list.slice(0, 40).map(function (x) {
        var r = x.rec, n = (r.nutrients && r.nutrients.kcal) || 0;
        var when = new Date(x.at);
        return '<div class="log-line"><span class="grow ellip">' +
          '<b>' + A().esc(r.name || '(名前なし)') + '</b>' +
          '<span class="tiny muted"> ' + A().esc(r.date || '') + ' ' +
          A().esc(slots[r.slot] || r.slot || '') + ' ・ ' + Math.round(n) + ' kcal<br>' +
          ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2) +
          ' に ' + A().esc(x.why || '削除') + '</span></span>' +
          '<button class="btn sub sm" data-untrash="' + x.at + '">戻す</button></div>';
      }).join('') +
      '<button class="btn sub wide" id="btnTrashClear" style="margin-top:10px">控えを消す</button></div>';
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
      '<label class="fld"><span>1日の運動目標 (kcal相当)</span>' +
        '<input type="number" inputmode="numeric" id="sExercise" min="1" step="10" value="' +
        (st.exerciseKcalGoal || 322) + '"></label>' +
      '<div class="tiny muted">歩数由来の記録は重ねず、歩数換算を優先します。歩数以外の運動は加算します。</div>' +
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
    return '<div class="small" style="margin-top:8px;color:var(--accent-text)">このペースなら約 ' +
      (Math.round(months * 10) / 10) + " か月後（" + (d.getFullYear()) + '年' + (d.getMonth() + 1) +
      '月ごろ）に目標体重に到達する計算です。</div>';
  }

  /* 400件あるので、名前で絞り込めるようにする。入力のたびに一覧だけ描き替え、
     入力欄そのものは触らない(触るとiPhoneでフォーカスとキーボードが飛ぶ) */
  var myFoods = [], myFilter = '';

  function myFoodRows() {
    var q = F.norm(myFilter.trim());
    var hit = q ? myFoods.filter(function (m) {
      return F.norm(m.name).indexOf(q) !== -1 ||
        (m.brand && F.norm(m.brand).indexOf(q) !== -1) ||
        (m.barcode && String(m.barcode).indexOf(myFilter.trim()) !== -1);
    }) : myFoods;
    if (!myFoods.length) {
      return '<div class="empty">手入力やバーコード登録した食品がここに並びます</div>';
    }
    if (!hit.length) return '<div class="empty">「' + A().esc(myFilter) + '」に一致する食品がありません</div>';
    var h = q ? '<div class="tiny muted" style="margin-bottom:4px">' + hit.length + ' 件</div>' : '';
    h += hit.slice(0, 50).map(function (m) {
      var per = m.basis === 'serving' ? ('1' + (m.servingLabel || '食')) : '100g';
      return '<div class="row between" style="padding:8px 0;border-top:1px solid var(--line)">' +
        '<span class="grow ellip"><b class="small">' + A().esc(m.name) + '</b>' +
        '<span class="tiny muted"> ' + (m.brand ? A().esc(m.brand) + ' ・ ' : '') + per + 'あたり ' +
        Math.round((m.nutrients && m.nutrients.kcal) || 0) + ' kcal' +
        (m.barcode ? ' ・ ' + A().esc(m.barcode) : '') + '</span></span>' +
        '<button class="tiny" data-delmy="' + A().esc(m.id) + '" ' +
        'style="color:var(--judge-bad);text-decoration:underline;flex:none">削除</button></div>';
    }).join('');
    if (hit.length > 50) h += '<div class="tiny muted" style="margin-top:6px">ほか ' + (hit.length - 50) + ' 件</div>';
    return h;
  }

  function myFoodCard(my) {
    myFoods = my || [];
    return '<div class="card"><div class="row between" style="margin-bottom:8px">' +
      '<h3 style="margin:0">マイ食品（' + myFoods.length + '件）</h3></div>' +
      (myFoods.length
        ? '<input type="text" id="myFoodQ" placeholder="食品名・ブランド・バーコードで絞り込み" ' +
          'autocomplete="off" value="' + A().esc(myFilter) + '">'
        : '') +
      '<div id="myFoodList" style="margin-top:6px">' + myFoodRows() + '</div></div>';
  }

  function dataCard() {
    return '<div class="card"><h3>データの管理</h3>' +
      '<div class="small muted" style="margin-bottom:10px">記録はすべてこの端末の中だけに保存されています。' +
      '機種変更やブラウザのデータ削除に備えて、ときどき書き出しておくことをおすすめします。</div>' +
      '<button class="btn line wide" id="btnExport">データを書き出す（JSON）</button>' +
      '<button class="btn line wide" id="btnImport" style="margin-top:8px">データを取り込む</button>' +
      '<input type="file" id="fileImport" accept="application/json,.json" hidden>' +
      '<hr class="sep">' +
      '<div class="small muted" style="margin-bottom:8px">外食チェーンのメニューなど、まとまった食品データを' +
      'CSVでマイ食品に取り込めます。1行目に見出し（名前, 単位, エネルギー, たんぱく質, 脂質, 炭水化物, ' +
      '食塩相当量, 食物繊維, 飽和脂肪酸, ブランド, バーコード）を入れてください。名前とエネルギーだけでも可。</div>' +
      '<button class="btn line wide" id="btnCsv">食品データをCSVで取り込む</button>' +
      '<input type="file" id="fileCsv" accept=".csv,text/csv" hidden>' +
      '<hr class="sep">' +
      '<div class="small muted" style="margin-bottom:8px">カロリーしかない過去の記録にも、' +
      '商品データと日本食品標準成分表から、欠けているPFC・ビタミン・ミネラルを補えます。' +
      '実測値は変更せず、推定した項目には印を付けます。件数が多いと数十秒かかります。</div>' +
      '<button class="btn line wide" id="btnEnrich">記録に栄養素を補う</button>' +
      '<div class="tiny muted" id="enrichProgress" role="status" hidden style="margin-top:8px"></div>' +
      '<button class="btn sub wide" id="btnWipe" style="margin-top:14px;color:var(--danger-text)">すべての記録を消す</button>' +
      '</div>';
  }

  function aboutCard() {
    return '<div class="card"><h3>このアプリについて</h3>' +
      '<div class="small">ミールログ <b>' + A().esc(A().version()) + '</b></div>' +
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
    on(view, '#sExercise', 'change', function (e) {
      var v = parseInt(e.target.value, 10);
      save({ exerciseKcalGoal: isFinite(v) && v > 0 ? v : 322 });
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
    on(view, '#btnCsv', 'click', function () { view.querySelector('#fileCsv').click(); });
    on(view, '#btnEnrich', 'click', doEnrich);
    on(view, '#fileCsv', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) doCsvImport(f);
    });
    view.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-untrash]');
      if (!b) return;
      S.Entries.restoreTrash(Number(b.dataset.untrash)).then(function (rec) {
        A().toast(rec ? (rec.name + ' を戻しました') : '戻せませんでした');
        A().render();
      });
    });
    on(view, '#btnTrashClear', 'click', function () {
      if (!confirm('消した記録の控えを捨てますか？（戻せなくなります）')) return;
      S.Entries.clearTrash().then(function () { A().toast('控えを消しました'); A().render(); });
    });

    var myQ = view.querySelector('#myFoodQ');
    if (myQ) {
      var myTimer = 0;
      myQ.addEventListener('input', function () {
        clearTimeout(myTimer);
        myTimer = setTimeout(function () {
          myFilter = myQ.value;
          var box = view.querySelector('#myFoodList');
          if (box) box.innerHTML = myFoodRows();
        }, 150);
      });
    }

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
        // 古いバックアップを取り込んだ直後にも、再起動を待たず設定移行を適用する。
        return S.migrateToilet();
      }).then(function () {
        return S.migrateExerciseGoal();
      }).then(function () {
        // バックアップ側の完了フラグが古い記録と食い違っていても再検査する。
        return S.Settings.save({ chickenLiver11232Migrated: 0 });
      }).then(function () {
        return S.migrateChickenLiver().catch(function () { return null; });
      }).then(function () {
        return A().reloadSettings();
      }).then(function () {
        A().toast('取り込みました'); A().render();
      }).catch(function (err) {
        A().toast('取り込みに失敗: ' + ((err && err.message) || err));
      });
    };
    reader.readAsText(file);
  }

  /* ---------------- 記録に栄養素を補う ---------------- */
  function doEnrich() {
    var button = document.getElementById('btnEnrich');
    var progress = document.getElementById('enrichProgress');
    if (button) { button.disabled = true; button.textContent = '補完しています…'; }
    if (progress) { progress.hidden = false; progress.textContent = '食品データを準備しています…'; }
    A().toast('栄養素の補完を始めます…');

    function setProgress(done, total, label) {
      if (!progress) return;
      progress.textContent = label + ' ' + done.toLocaleString() + ' / ' + total.toLocaleString() + '件';
    }

    function nextFrame() {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    function mergeProduct(e, isMyFood) {
      var unit = isMyFood
        ? (e.basis === 'serving' ? (e.servingLabel || '食') : 'g')
        : (e.unit || 'g');
      var amount = isMyFood ? (e.basis === '100g' ? 100 : 1) : (e.amount || 1);
      var result = global.Foods.mergeProduct(e.name, e.nutrients || {}, unit, amount,
        (e.est && e.est.keys) || []);
      if (result.changed) {
        e.nutrients = result.nutrients;
        if (e.est && e.est.keys) {
          var remaining = e.est.keys.filter(function (key) {
            return (result.appliedKeys || []).indexOf(key) === -1;
          });
          if (remaining.length) e.est = Object.assign({}, e.est, { keys: remaining });
          else delete e.est;
        }
      }
      return result.changed;
    }

    function mergeLinked(e, linkedMap) {
      var linked = linkedMap && linkedMap[global.Foods.norm(e.name)];
      if (!linked) return false;
      var unit = linked.basis === 'serving' ? (linked.servingLabel || '食') : 'g';
      if (unit !== (e.unit || 'g')) return false;
      var factor = unit === 'g' ? (e.amount || 0) / 100 : (e.amount || 0);
      if (!(factor > 0)) return false;
      var out = {}, old = e.nutrients || {}, oldEst = (e.est && e.est.keys) || [];
      for (var k in old) out[k] = old[k];
      var linkedEst = (linked.est && linked.est.keys) || [], nextEst = oldEst.slice(), changed = false;
      for (var key in (linked.nutrients || {})) {
        if (typeof linked.nutrients[key] !== 'number') continue;
        var oldIsEstimate = nextEst.indexOf(key) !== -1;
        if (typeof out[key] === 'number' && !oldIsEstimate) continue;
        out[key] = Math.round(linked.nutrients[key] * factor * 1000) / 1000;
        changed = true;
        var pos = nextEst.indexOf(key), linkIsEstimate = linkedEst.indexOf(key) !== -1;
        if (linkIsEstimate && pos === -1) nextEst.push(key);
        if (!linkIsEstimate && pos !== -1) nextEst.splice(pos, 1);
      }
      if (changed) {
        e.nutrients = out;
        if (nextEst.length) {
          e.est = Object.assign({}, e.est || linked.est || {}, { keys: nextEst });
        } else delete e.est;
        e.ref = { type: 'my', id: linked.id };
      }
      return changed;
    }

    function enrichRecord(e, isMyFood, linkedMap) {
      var linkedChanged = !isMyFood && mergeLinked(e, linkedMap);
      var changed = mergeProduct(e, isMyFood);
      changed = linkedChanged || changed;
      var unit = isMyFood
        ? (e.basis === 'serving' ? (e.servingLabel || '食') : 'g')
        : (e.unit || 'g');
      var amount = isMyFood ? (e.basis === '100g' ? 100 : 1) : (e.amount || 1);
      return global.Estimate.fill(e.name, e.nutrients || {}, {
        unit: unit, amount: amount, est: e.est || null
      }).then(function (filled) {
        if (filled) {
          e.nutrients = filled.nutrients;
          e.est = filled.est;
          changed = true;
        }
        return changed;
      });
    }

    function processBatches(records, isMyFood, label, writeBatch, linkedMap) {
      var total = records.length, index = 0, changed = 0;
      function oneBatch() {
        if (index >= total) return Promise.resolve(changed);
        var slice = records.slice(index, index + 100);
        return Promise.all(slice.map(function (rec) {
          return enrichRecord(rec, isMyFood, linkedMap).then(function (didChange) {
            if (didChange) changed++;
            return didChange ? rec : null;
          });
        })).then(function (rows) {
          var updates = rows.filter(Boolean);
          return updates.length ? writeBatch(updates) : null;
        }).then(function () {
          index += slice.length;
          setProgress(index, total, label);
          return nextFrame().then(oneBatch);
        });
      }
      return oneBatch();
    }

    Promise.all([
      global.Foods.loadProducts(),
      S.Entries.range('2000-01-01', '2100-12-31'),
      S.MyFoods.all(),
      global.Estimate.load()
    ]).then(function (r) {
      var entries = r[1].filter(S.notSkip), myfoods = r[2];
      var linkedMap = {};
      myfoods.forEach(function (m) { if (m.linked) linkedMap[global.Foods.norm(m.name)] = m; });
      return processBatches(entries, false, '食事記録', function (rows) {
        return S.Entries.putMany(rows);
      }, linkedMap).then(function (entryFilled) {
        return processBatches(myfoods, true, 'マイ食品', function (rows) {
          return S.MyFoods.putMany(rows);
        }).then(function (myFilled) {
          return { entries: entryFilled, myfoods: myFilled };
        });
      });
    }).then(function (result) {
      if (!result) return;
      if (progress) progress.textContent = '完了: 食事記録 ' + result.entries.toLocaleString() +
        '件、マイ食品 ' + result.myfoods.toLocaleString() + '件を補完しました。';
      A().toast('栄養素の補完が完了しました', 3600);
      A().render();
    }).catch(function (err) {
      if (progress) progress.textContent = '失敗: ' + ((err && err.message) || err);
      A().toast('失敗しました: ' + ((err && err.message) || err));
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = '記録に栄養素を補う'; }
    });
  }

  /* ---------------- 食品データのCSV取り込み ---------------- */
  var COL_ALIASES = {
    name: ['名前', '商品名', 'メニュー名', 'メニュー', '品名', '食品名', 'name'],
    brand: ['ブランド', '店舗', 'メーカー', 'チェーン', 'brand'],
    servingLabel: ['単位', '分量', '一食', '1食', 'serving', 'unit'],
    kcal: ['エネルギー', 'カロリー', 'kcal', 'エネルギー(kcal)', '熱量'],
    protein: ['たんぱく質', 'タンパク質', 'たん白質', '蛋白質', 'protein'],
    fat: ['脂質', 'fat'],
    carb: ['炭水化物', 'carb', 'carbohydrate'],
    sugarOnly: ['糖質'],
    fiber: ['食物繊維', 'fiber'],
    salt: ['食塩相当量', '食塩', '塩分', 'salt'],
    satfat: ['飽和脂肪酸', 'satfat'],
    barcode: ['バーコード', 'JAN', 'JANコード', 'barcode']
  };

  /* ダブルクォートに対応した簡易CSVパーサ */
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else q = false;
        } else cell += c;
      } else if (c === '"') {
        q = true;
      } else if (c === ',') {
        row.push(cell); cell = '';
      } else if (c === '\n') {
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else if (c !== '\r') {
        cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function decodeText(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
    } catch (e) {
      // 日本のサイト由来のCSVはShift_JISのことが多い
      return new TextDecoder('shift_jis').decode(buf).replace(/^﻿/, '');
    }
  }

  function normHeader(s) {
    return String(s || '').toLowerCase()
      .replace(/[（(].*?[)）]/g, '')
      .replace(/[\s　_・]/g, '')
      .trim();
  }

  function mapColumns(header) {
    var map = {};
    header.forEach(function (h, i) {
      var n = normHeader(h);
      if (!n) return;
      Object.keys(COL_ALIASES).forEach(function (key) {
        if (map[key] != null) return;
        for (var j = 0; j < COL_ALIASES[key].length; j++) {
          if (n === normHeader(COL_ALIASES[key][j])) { map[key] = i; return; }
        }
      });
    });
    return map;
  }

  function csvNum(v) {
    if (v == null) return null;
    var s = String(v).replace(/[^0-9.\-]/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function doCsvImport(file) {
    file.arrayBuffer().then(function (buf) {
      var rows = parseCsv(decodeText(new Uint8Array(buf)));
      if (rows.length < 2) { A().toast('データ行がありません'); return; }
      var map = mapColumns(rows[0]);
      if (map.name == null) {
        A().toast('「名前」の列が見つかりません');
        return;
      }
      var items = [];
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        var name = (row[map.name] || '').trim();
        if (!name) continue;
        var carb = map.carb != null ? csvNum(row[map.carb]) : null;
        if (carb == null && map.sugarOnly != null) carb = csvNum(row[map.sugarOnly]);
        var nut = {
          kcal: map.kcal != null ? (csvNum(row[map.kcal]) || 0) : 0,
          protein: map.protein != null ? (csvNum(row[map.protein]) || 0) : 0,
          fat: map.fat != null ? (csvNum(row[map.fat]) || 0) : 0,
          carb: carb || 0,
          fiber: map.fiber != null ? (csvNum(row[map.fiber]) || 0) : 0,
          salt: map.salt != null ? (csvNum(row[map.salt]) || 0) : 0,
          satfat: map.satfat != null ? (csvNum(row[map.satfat]) || 0) : 0
        };
        items.push({
          name: name,
          brand: map.brand != null ? (row[map.brand] || '').trim() : '',
          basis: 'serving',
          servingLabel: (map.servingLabel != null ? (row[map.servingLabel] || '').trim() : '') || '食',
          barcode: map.barcode != null ? (row[map.barcode] || '').trim() : '',
          nutrients: nut
        });
      }
      if (!items.length) { A().toast('取り込める行がありませんでした'); return; }
      if (!confirm(items.length + ' 件をマイ食品に追加します。よろしいですか？\n\n例: ' +
        items.slice(0, 3).map(function (x) { return x.name + '（' + Math.round(x.nutrients.kcal) + 'kcal）'; }).join('、'))) return;

      var i = 0;
      (function next() {
        if (i >= items.length) {
          A().toast(items.length + ' 件を取り込みました');
          A().render();
          return;
        }
        S.MyFoods.put(items[i++]).then(next);
      })();
    }).catch(function (err) {
      A().toast('読み込みに失敗: ' + ((err && err.message) || err));
    });
  }

  Views.settings = { render: render };
})(window);
