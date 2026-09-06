/* nutrition-label.js - iOSの「テキストをスキャン」で得た栄養成分表示を解析する */
(function (global) {
  'use strict';

  var RULES = [
    { key: 'kcal', names: ['エネルギー', '熱量'], unit: 'kcal' },
    { key: 'protein', names: ['たんぱく質', '蛋白質', 'タンパク質'], unit: 'g' },
    { key: 'fat', names: ['脂質'], unit: 'g' },
    { key: 'carb', names: ['炭水化物'], unit: 'g' },
    { key: '_labelSugar', names: ['糖質'], unit: 'g' },
    { key: 'fiber', names: ['食物繊維'], unit: 'g' },
    { key: 'salt', names: ['食塩相当量'], unit: 'g' },
    { key: 'sodium', names: ['ナトリウム'], unit: 'mg' },
    { key: 'satfat', names: ['飽和脂肪酸'], unit: 'g' },
    { key: 'monofat', names: ['一価不飽和脂肪酸', '一価不飽和'], unit: 'g' },
    { key: 'polyfat', names: ['多価不飽和脂肪酸', '多価不飽和'], unit: 'g' },
    { key: 'n3', names: ['n-3系脂肪酸', 'オメガ3脂肪酸'], unit: 'g' },
    { key: 'n6', names: ['n-6系脂肪酸', 'オメガ6脂肪酸'], unit: 'g' },
    { key: 'chol', names: ['コレステロール'], unit: 'mg' },
    { key: 'k', names: ['カリウム'], unit: 'mg' },
    { key: 'ca', names: ['カルシウム', '\\bCa\\b'], unit: 'mg' },
    { key: 'mg', names: ['マグネシウム', '\\bMg\\b'], unit: 'mg' },
    { key: 'fe', names: ['鉄分?', '\\bFe\\b'], unit: 'mg' },
    { key: 'zn', names: ['亜鉛', '\\bZn\\b'], unit: 'mg' },
    { key: 'vita', names: ['ビタミン\\s*A'], unit: 'ug' },
    { key: 'vitd', names: ['ビタミン\\s*D'], unit: 'ug' },
    { key: 'vite', names: ['ビタミン\\s*E'], unit: 'mg' },
    { key: 'vitb1', names: ['ビタミン\\s*B\\s*1'], unit: 'mg' },
    { key: 'vitb2', names: ['ビタミン\\s*B\\s*2'], unit: 'mg' },
    { key: 'niacin', names: ['ナイアシン'], unit: 'mg' },
    { key: 'vitb6', names: ['ビタミン\\s*B\\s*6'], unit: 'mg' },
    { key: 'vitb12', names: ['ビタミン\\s*B\\s*12'], unit: 'ug' },
    { key: 'folate', names: ['葉酸'], unit: 'ug' },
    { key: 'vitc', names: ['ビタミン\\s*C'], unit: 'mg' }
  ];

  function normalize(text) {
    text = String(text || '');
    if (text.normalize) text = text.normalize('NFKC');
    return text
      .replace(/[µμ]/g, 'u')
      .replace(/[：]/g, ':')
      .replace(/[，,]/g, '')
      .replace(/[−–—]/g, '-')
      .replace(/キロカロリー/gi, 'kcal');
  }

  function midpoint(a, b) {
    var x = parseFloat(a), y = b == null ? null : parseFloat(b);
    if (!isFinite(x)) return null;
    return y !== null && isFinite(y) ? (x + y) / 2 : x;
  }

  function convert(value, from, to) {
    from = String(from || '').toLowerCase().replace('mcg', 'ug');
    to = String(to || '').toLowerCase();
    if (from === to) return value;
    var inMg;
    if (from === 'g') inMg = value * 1000;
    else if (from === 'mg') inMg = value;
    else if (from === 'ug') inMg = value / 1000;
    else return null;
    if (to === 'g') return inMg / 1000;
    if (to === 'mg') return inMg;
    if (to === 'ug') return inMg * 1000;
    return null;
  }

  function readRule(text, rule) {
    var value = '([0-9]+(?:\\.[0-9]+)?)';
    var range = '(?:\\s*(?:~|〜|～|-|から)\\s*' + value + ')?';
    var units = '(kcal|g|mg|ug|mcg)';
    var re = new RegExp('(?:' + rule.names.join('|') + ')\\s*[:：]?\\s*' +
      value + range + '\\s*' + units, 'i');
    var m = text.match(re);
    if (!m) return null;
    var n = midpoint(m[1], m[2]);
    if (n == null) return null;
    if (rule.unit === 'kcal') return String(m[3]).toLowerCase() === 'kcal' ? n : null;
    return convert(n, m[3], rule.unit);
  }

  function portion(text) {
    var hundred = text.match(/(?:栄養成分表示\s*)?100\s*g\s*(?:当たり|あたり)/i);
    if (hundred) return { basis: '100g', servingLabel: '', grams: 100 };
    var m = text.match(/(?:栄養成分表示\s*)?(?:1\s*)?(日分|袋|本|個|食|パック|包|粒|錠|枚|杯|人前)\s*(?:[（(]\s*([0-9]+(?:\.[0-9]+)?)\s*g\s*[）)])?\s*(?:当たり|あたり)/i);
    if (!m) return { basis: null, servingLabel: null, grams: null };
    return { basis: 'serving', servingLabel: m[1], grams: m[2] ? parseFloat(m[2]) : null };
  }

  function parse(text) {
    var normalized = normalize(text);
    var nutrients = {}, foundKeys = [];
    RULES.forEach(function (rule) {
      var value = readRule(normalized, rule);
      if (value == null || !isFinite(value) || value < 0) return;
      if (rule.key === 'sodium') {
        if (typeof nutrients.salt !== 'number') {
          nutrients.salt = Math.round((value * 2.54 / 1000) * 100000) / 100000;
          foundKeys.push('salt');
        }
        return;
      }
      if (rule.key === '_labelSugar') {
        nutrients._labelSugar = Math.round(value * 100000) / 100000;
        return;
      }
      if (typeof nutrients[rule.key] === 'number') return;
      nutrients[rule.key] = Math.round(value * 100000) / 100000;
      foundKeys.push(rule.key);
    });
    // 炭水化物の表示が無い商品では、糖質と食物繊維を合算する。
    // 3項目すべてがあるときは、メーカー表示の「炭水化物」を優先する。
    if (typeof nutrients.carb !== 'number' && typeof nutrients._labelSugar === 'number') {
      nutrients.carb = Math.round((nutrients._labelSugar +
        (typeof nutrients.fiber === 'number' ? nutrients.fiber : 0)) * 100000) / 100000;
      foundKeys.push('carb');
    }
    delete nutrients._labelSugar;
    var p = portion(normalized);
    return {
      nutrients: nutrients, foundKeys: foundKeys,
      basis: p.basis, servingLabel: p.servingLabel, grams: p.grams
    };
  }

  global.NutritionLabel = { parse: parse, normalize: normalize };
})(window);
