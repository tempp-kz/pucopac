// Shared by the offline review HTML and the existing Node runners.
// Warnings draw attention; only missing/invalid final values prevent confirmation.
export const PukoMagazine = (() => {
  const norm = x => String(x || '').normalize('NFKC').replace(/[\s　]+/gu, ' ').trim();
  const kana = x => norm(x).replace(/[ァ-ヶ]/gu, c => String.fromCharCode(c.charCodeAt(0) - 96));
  const compact = x => kana(x).replace(/\s/gu, '');
  const text = x => typeof x === 'string' && x.trim() === x && x.length > 0 && !/[\x00-\x1f\x7f|\[\]#]/u.test(x);
  const fileTitle = r => r.fileTitle || r.relativePath.split('/').at(-1).replace(/\.md$/u, '');
  const isMagazine = r => r.relativePath?.startsWith('02 市販雑誌 雑誌名順/');
  const legacyMatches = (rule, r) => rule.match === undefined && rule.kind === 'magazine' && rule.publisher === '' && isMagazine(r) && (norm(fileTitle(r)) === norm(rule.titlePrefix) || norm(fileTitle(r)).startsWith(norm(rule.titlePrefix) + ' '));
  function readingRow(reading) {
    let c = [...kana(reading).replace(/^[\s「」『』【】〔〕〈〉《》（）()［］・、。…―—〜～]+/u, '')][0];
    if (!c) return null;
    c = c.normalize('NFD')[0];
    c = ({'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お','っ':'つ','ゃ':'や','ゅ':'ゆ','ょ':'よ','ゎ':'わ','ゐ':'い','ゑ':'え'})[c] || c;
    const i = ['あいうえお','かきくけこ','さしすせそ','たちつてと','なにぬねの','はひふへほ','まみむめも','やゆよ','らりるれろ','わをん'].findIndex(s => s.includes(c));
    return i < 0 ? null : ['あ','か','さ','た','な','は','ま','や','ら','わ'][i];
  }
  function extract(raw) {
    const title = String(raw), firstDigit = title.search(/[0-9０-９]/u);
    const m = title.match(/^(.+?)(\s+)(第\s*)?([0-9０-９]+(?:[-‐‑–—.．][0-9０-９]+)*)(?=$|[\s年月巻号集編部])/u);
    if (!m) return {candidateName:'', remainder:title, token:null, ordinal:false, warning:firstDigit < 0 ? '号数に相当する数字がなく、誌名の境界を確認できません。誌名を入力してください。' : '誌名と号数の区切りを確認できません。空白なしの連結などを確認し、誌名を入力してください。'};
    const name = m[1].trim(), remainder = title.slice(m[1].length).trim();
    const earlierNumber = /[0-9０-９]/u.test(name);
    const adjacentNumber = /^\s+(?:第\s*)?[0-9０-９]/u.test(title.slice(m[0].length));
    return {candidateName:name, remainder, token:norm(m[4]), ordinal:!!m[3], warning:earlierNumber || adjacentNumber ? '番号の候補が複数あります。表示した誌名候補と番号の境界を確認してください。' : ''};
  }
  function extractReading(record, split) {
    if (!split.token) return '';
    const reading = norm(record.titleReading), matches = [...reading.matchAll(/\d+(?:[-‐‑–—.]\d+)*/gu)].filter(m => m[0] === split.token);
    if (matches.length !== 1) return '';
    let result = reading.slice(0, matches[0].index).trim();
    if (split.ordinal) {
      if (!/(?:ダイ|だい)\s*$/u.test(result)) return '';
      result = result.replace(/(?:ダイ|だい)\s*$/u, '').trim();
    }
    return result;
  }
  function decisionError(record, decision) {
    if (!decision || !text(decision.groupName)) return '採用する誌名を入力してください。';
    if (!text(decision.readingPrefix) || !readingRow(decision.readingPrefix)) return '誌名の読みを特定できません。その部分の読みを確認してください。';
    if (!compact(record.titleReading).startsWith(compact(decision.readingPrefix))) return '誌名の読みが採用する書名読みの先頭と一致しません。';
    const row = record.relativePath.split('/')[1];
    if (row !== '数字・英語' && row !== readingRow(decision.readingPrefix)) return '誌名読みと原典の行フォルダが異なります。本人による移動と既存のID引継ぎが必要です。';
    return '';
  }
  function review(record, settings, confirmed = [], selection = {}) {
    const split = extract(fileTitle(record)), rules = settings?.records || [];
    const items = rules.filter(r => r.match === 'item' && r.kind === 'magazine' && r.basis?.opacId === record.opacId);
    const legacy = rules.filter(r => legacyMatches(r, record));
    const previous = items.length === 1 ? items[0] : legacy.length === 1 ? legacy[0] : null;
    const suggestedName = previous?.groupName || split.candidateName;
    const groupName = selection.useSuggested === false ? String(selection.manualName || '').trim() : suggestedName;
    const catalog = [...rules, ...confirmed].filter(r => r.kind === 'magazine' && norm(r.groupName) === norm(groupName));
    const readings = [...new Map(catalog.filter(r => r.readingPrefix).map(r => [compact(r.readingPrefix), r.readingPrefix])).values()];
    const automaticReading = readings.length === 1 ? readings[0] : norm(groupName) === norm(split.candidateName) ? extractReading(record, split) : '';
    const readingPrefix = selection.readingManual ? String(selection.readingPrefix || '').trim() : automaticReading;
    const warnings = [];
    if (!previous && split.warning) warnings.push(split.warning);
    if (legacy.length > 1 && !items.length) warnings.push('過去の接頭辞条件が重複しています。最長一致では選びません。この冊の所属を確認してください。');
    if (previous && split.candidateName && norm(previous.groupName) !== norm(split.candidateName)) warnings.push('過去の本人確定所属「' + previous.groupName + '」と今回の抽出候補「' + split.candidateName + '」が異なります。');
    const differentSeries = (record.series || []).filter(x => norm(x) && norm(x) !== norm(split.candidateName || groupName));
    if (differentSeries.length) warnings.push('原典のシリーズ欄：' + differentSeries.join('／') + '。誌名候補との表記が異なります。候補を採用することも、別の誌名へ修正することもできます。');
    if (readings.length > 1) warnings.push('同じ誌名に複数の確定読みがあります。今回の読みを確認してください。');
    if (previous && groupName && norm(previous.groupName) !== norm(groupName)) warnings.push('この冊の所属変更：' + previous.groupName + ' → ' + groupName);
    const reused = previous || readings.length === 1;
    const raw=fileTitle(record),remainder=groupName&&raw.startsWith(groupName)?raw.slice(groupName.length).trim():split.remainder;
    return {suggestedName, groupName, readingPrefix, remainder, rawCandidate:split.candidateName, warnings,
      origin:selection.useSuggested === false ? '本人入力' : reused ? '過去の本人確定を再利用' : '自動抽出した候補',
      error:decisionError(record, {groupName, readingPrefix})};
  }
  return {norm, compact, extract, extractReading, readingRow, legacyMatches, decisionError, review};
})();
