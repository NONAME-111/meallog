/* steps.js - 日別歩数の取り込み。値は加算せず日別合計を置き換える。 */
(function (global) {
  'use strict';
  var S = global.Store;
  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    var parts = date.split('-').map(Number);
    if (parts[0] < 1900) return false;
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return S.ymd(d) === date && date <= S.ymd(new Date());
  }
  function parse(text, date) {
    var value = String(text == null ? '' : text).trim(), map = {};
    if (!value) throw new Error('歩数データを貼り付けてください');
    // ショートカットが作ったURLも、そのまま貼り付けられる。
    if (/^https?:\/\//i.test(value)) {
      var u;
      try { u = new URL(value); } catch (e) { throw new Error('URLの形式が正しくありません'); }
      date = u.searchParams.get('date') || date;
      value = u.searchParams.get('steps') || '';
    }
    if (/^\d+$/.test(value)) value = (date || S.ymd(new Date())) + ':' + value;
    var parts = value.split(/[\r\n,]+/).filter(function (v) { return v.trim(); });
    if (!parts.length || parts.length > 366) throw new Error('日付と歩数を1日ずつ、366日以内で入力してください');
    parts.forEach(function (part) {
      var match = /^\s*(\d{4}-\d{2}-\d{2})\s*:\s*(\d+)\s*$/.exec(part);
      if (!match || !validDate(match[1])) throw new Error('日付は今日以前の YYYY-MM-DD、歩数は0以上の整数で入力してください');
      var n = Number(match[2]);
      if (!Number.isSafeInteger(n)) throw new Error('歩数の値が大きすぎます');
      if (Object.prototype.hasOwnProperty.call(map, match[1])) throw new Error('同じ日付が重複しています: ' + match[1]);
      map[match[1]] = n;
    });
    return Object.keys(map).sort().map(function (d) { return { date: d, steps: map[d] }; });
  }
  function importText(text, date) {
    var rows;
    try { rows = parse(text, date); } catch (e) { return Promise.reject(e); }
    return S.Body.importSteps(rows);
  }
  function openImport(initial) {
    var A = global.App;
    var body = A.openSheet('歩数を取り込む',
      '<div class="step-method"><b>ヘルスケアの「書き出す」は使いません</b>' +
      '<p class="small">いちばん簡単なのは、ヘルスケアに表示された歩数をカラダ画面の歩数欄へ直接入力する方法です。</p>' +
      '<ol class="step-guide"><li>ヘルスケアを開き、右下の「検索」→「アクティビティ」→「歩数」を開く</li>' +
      '<li>上部を「日」にして、今日の合計歩数を確認する</li>' +
      '<li>この画面を閉じ、カラダ画面の「歩数」欄へ数字だけ入力する</li></ol></div>' +
      '<details class="step-shortcut"><summary>ショートカットでコピーする設定手順</summary>' +
      '<p class="small">Webアプリはヘルスケアを直接読めないため、次のアクションを上から順に追加します。iOSにより名称が少し違う場合があります。</p>' +
      '<ol class="step-guide"><li>「ショートカット」アプリで右上の＋を押す</li>' +
      '<li>「ヘルスケアサンプルを検索」を追加し、種類を「歩数」、開始日を「今日」にする</li>' +
      '<li>「ヘルスケアサンプルの詳細を取得」を追加し、詳細を「値」にする</li>' +
      '<li>「統計を計算」を追加し、「合計」を選ぶ</li>' +
      '<li>「現在の日付」→「日付をフォーマット」を追加し、カスタム形式を <code>yyyy-MM-dd</code> にする</li>' +
      '<li>「テキスト」を追加し、日付と合計の変数を <code>日付:歩数</code> の順で置く</li>' +
      '<li>「クリップボードにコピー」を追加して実行し、下の欄へ貼り付ける</li></ol>' +
      '<p class="tiny muted">例: <code>2026-09-07:8432</code>。iPhoneとApple Watchの値が重複する場合は、検索条件で記録元を1つに絞るか、上の直接入力を使ってください。</p>' +
      '<p class="tiny"><a href="https://support.apple.com/ja-jp/guide/shortcuts/apd3c845e881/ios" target="_blank" rel="noopener">Apple公式: 検索アクションの使い方</a></p></details>' +
      '<label class="fld"><span>日付と歩数</span><textarea id="stepsText" rows="5" placeholder="2026-09-05:8432&#10;2026-09-06:7210">' +
      A.esc(initial || '') + '</textarea></label>' +
      '<p class="small muted" id="stepsPreview" aria-live="polite"></p>' +
      '<button class="btn wide" id="stepsSave" disabled>取り込む</button>' +
      '<p class="tiny muted">複数日を一度に貼り付けられます。同じ日の歩数は最新の合計に置き換わります。いつも記録しているホーム画面のミールログで操作してください。</p>');
    var input = body.querySelector('#stepsText'), button = body.querySelector('#stepsSave');
    function preview() {
      try {
        var rows = parse(input.value);
        body.querySelector('#stepsPreview').textContent = rows.length + '日分 (' + rows[0].date + ' ～ ' + rows[rows.length - 1].date + ')';
        button.disabled = false;
      } catch (e) {
        body.querySelector('#stepsPreview').textContent = input.value.trim() ? e.message : '';
        button.disabled = true;
      }
    }
    input.addEventListener('input', preview);
    button.addEventListener('click', function () {
      button.disabled = true;
      importText(input.value).then(function (n) {
        A.closeSheet(); A.toast(n + '日分の歩数を取り込みました'); A.render();
      }).catch(function (e) { A.toast('取り込めませんでした: ' + e.message); preview(); });
    });
    preview();
  }
  function receiveUrl() {
    var url = new URL(global.location.href);
    if (!url.searchParams.has('steps')) return Promise.resolve(0);
    var text = url.searchParams.get('steps'), date = url.searchParams.get('date');
    // 成功前には消さない。保存に失敗した場合、再読み込みで再試行できる。
    return importText(text, date).then(function (count) {
      url.searchParams.delete('steps'); url.searchParams.delete('date');
      global.history.replaceState(global.history.state, '', url.pathname + url.search + url.hash);
      return count;
    });
  }
  global.Steps = { parse: parse, importText: importText, openImport: openImport, receiveUrl: receiveUrl };
})(window);
