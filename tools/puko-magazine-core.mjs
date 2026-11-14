// Shared by the offline review HTML and the existing Node runners.
// Warnings draw attention; only missing/invalid final values prevent confirmation.
export const PukoMagazine = (() => {
  const norm = x => String(x || '').normalize('NFKC').replace(/[\s　]+/gu, ' ').trim();
  const kana = x => norm(x).replace(/[ァ-ヶ]/gu, c => String.fromCharCode(c.charCodeAt(0) - 96));
  const compact = x => kana(x).replace(/\s/gu, '');
  const text = x => typeof x === 'string' && x.trim() === x && x.length > 0 && !/[\x00-\x1f\x7f|\[\]#]/u.test(x);
  const fileTitle = r => r.fileTitle || r.relativePath.split('/').at(-1).replace(/\.md$/u, '');
  const location = r => r.relativePath?.startsWith('03 シリーズ 出版社順/')
    ? {kind:'series',publisher:r.relativePath.split('/').slice(0,3).join('/'),label:'シリーズ名'}
    : {kind:'magazine',publisher:'',label:'誌名'};
  const grouped = r => /^(02 市販雑誌 雑誌名順|03 シリーズ 出版社順)\//u.test(r.relativePath || '');
  const legacyMatches = (rule, r) => rule.match === undefined && grouped(r) && rule.kind === location(r).kind && rule.publisher === location(r).publisher && (norm(fileTitle(r)) === norm(rule.titlePrefix) || norm(fileTitle(r)).startsWith(norm(rule.titlePrefix) + ' '));
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
    const loc=location(record), label=loc.label;
    if (!decision || !text(decision.groupName)) return '採用する'+label+'を入力してください。';
    if (!text(decision.readingPrefix) || !readingRow(decision.readingPrefix)) return label+'の読みを特定できません。その部分の読みを確認してください。';
    if (!compact(record.titleReading).startsWith(compact(decision.readingPrefix))) return label+'の読みが採用する書名読みの先頭と一致しません。';
    const row = record.relativePath.split('/')[1];
    if (loc.kind==='magazine' && row !== '数字・英語' && row !== readingRow(decision.readingPrefix)) return '誌名読みと原典の行フォルダが異なります。本人による移動と既存のID引継ぎが必要です。';
    return '';
  }
  function review(record, settings, confirmed = [], selection = {}) {
    const loc=location(record), split=extract(fileTitle(record)), rules=settings?.records || [];
    const sameScope=r=>r.kind===loc.kind && (r.publisher || '')===loc.publisher;
    const items=rules.filter(r=>r.match==='item' && sameScope(r) && r.basis?.opacId===record.opacId);
    const legacy=rules.filter(r=>legacyMatches(r,record));
    const previous=items.length===1 ? items[0] : legacy.length===1 ? legacy[0] : null;
    // Reuse a uniquely named, explicitly confirmed series within its publisher.
    // This only proposes an affiliation; every volume still needs confirmation.
    const knownNames=loc.kind==='series' ? [...new Set([...rules.filter(r=>r.match==='item'),...confirmed]
      .filter(r=>sameScope(r) && text(r.groupName) && (norm(fileTitle(record))===norm(r.groupName) || norm(fileTitle(record)).startsWith(norm(r.groupName)+' ')))
      .map(r=>r.groupName))] : [];
    const suggestedName=previous?.groupName || split.candidateName || (knownNames.length===1 ? knownNames[0] : '');
    const groupName=selection.useSuggested===false ? String(selection.manualName || '').trim() : suggestedName;
    const catalog=[...rules,...confirmed].filter(r=>sameScope(r) && norm(r.groupName)===norm(groupName));
    const readings=[...new Map(catalog.filter(r=>r.readingPrefix).map(r=>[compact(r.readingPrefix),r.readingPrefix])).values()];
    const automaticReading=readings.length===1 ? readings[0] : norm(groupName)===norm(split.candidateName) ? extractReading(record,split) : '';
    const readingPrefix=selection.readingManual ? String(selection.readingPrefix || '').trim() : automaticReading;
    const warnings=[];
    if (!previous && split.warning && !(knownNames.length===1 && !split.candidateName)) warnings.push(split.warning.replaceAll('誌名',loc.label).replaceAll('号数','番号'));
    if (knownNames.length>1 && !previous && !split.candidateName) warnings.push('過去の本人確定名が複数一致します。'+loc.label+'を本人が指定してください。');
    if (legacy.length>1 && !items.length) warnings.push('過去の接頭辞条件が重複しています。最長一致では選びません。この冊の所属を確認してください。');
    if (previous && split.candidateName && norm(previous.groupName)!==norm(split.candidateName)) warnings.push('過去の本人確定所属「'+previous.groupName+'」と今回の抽出候補「'+split.candidateName+'」が異なります。');
    if (readings.length>1) warnings.push('同じ'+loc.label+'に複数の確定読みがあります。今回の読みを確認してください。');
    if (previous && groupName && norm(previous.groupName)!==norm(groupName)) warnings.push('この冊の所属変更：'+previous.groupName+' → '+groupName);
    const reused=previous || (!split.candidateName && knownNames.length===1);
    const raw=fileTitle(record),remainder=groupName&&raw.startsWith(groupName)?raw.slice(groupName.length).trim():split.remainder;
    return {kind:loc.kind,publisher:loc.publisher,suggestedName,groupName,readingPrefix,remainder,rawCandidate:split.candidateName,warnings,
      origin:selection.useSuggested===false ? '本人入力' : reused ? '過去の本人確定を再利用' : '自動抽出した候補',
      error:decisionError(record,{groupName,readingPrefix})};
  }
  return {norm, compact, extract, extractReading, readingRow, legacyMatches, decisionError, review};
})();

// Shared state helpers for the existing offline review and fixed preparation.
// No filesystem access, source writes, confirmation synthesis, or network calls.
export const PukoReading = (() => {
  const clone = x => structuredClone(x);
  function stop(code, details = {}) {
    const e = new Error(code + ': ' + JSON.stringify(details));
    e.code = code; e.details = details; throw e;
  }
  const stable = x => {
    if (Array.isArray(x)) return x.map(stable);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort()
      .filter(k => x[k] !== undefined).map(k => [k, stable(x[k])]));
    return x;
  };
  const key = x => JSON.stringify(stable(x));
  const stem = p => p.split('/').at(-1).replace(/\.md$/u, '');
  const active = c => c.confirmed === true && c.needsSourceReview !== true;
  const refs = d => d.books.map((b, i) => [b.index ?? i + 1, b.relativePath, b.sha256, b.formalOpacId ?? null]);
  const referenceKey = d => key({batchId: d.batchId, refs: refs(d), settings: d.magazineSettings ?? null});
  const metadata = new Set(['著者', '出版社', '出版年', '初版・底本の発行年', 'シリーズ']);
  const readingFields = new Set(['書名読み', 'タイトル読み']);
  const sourceFields = ['index','relativePath','sha256','title','titleReading','authors','publishers','series','labels',
    'publicationYear','firstEditionYear','isbns','targetTitle','formalOpacId','opacId','sourceAudit','referenceBinding',
    'referenceChange','magazineReview','indexGroupReview','indexGroupResolved','indexGroupIssue'];
  const pathPattern = /^(?:(?:01 一般書籍|02 市販雑誌 雑誌名順)\/(?:あ|か|さ|た|な|は|ま|や|ら|わ|数字・英語)|03 シリーズ 出版社順\/(?:あ|か|さ|た|な|は|ま|や|ら|わ|数字・英語)\/[^/]+|05 古典 著者出生地分類\/(?:日本古典 1853年以前|東洋古典 1840年以前|西洋古典 1769年以前|東洋法典|西洋法典))\/[^/]+\.md$/u;
  function validateCandidate(d, expected = null) {
    if (d?.version !== 3 || !/^[A-F0-9]{12}$/u.test(d.batchId || '') || !Array.isArray(d.books) ||
        d.books.length < 1 || d.books.length > 100) stop('CANDIDATE_SHAPE_INVALID');
    const seen = new Set();
    for (const [i,b] of d.books.entries()) {
      if ((b.index !== undefined && b.index !== i+1) || typeof b.relativePath !== 'string' ||
          !pathPattern.test(b.relativePath) || /[\\\x00-\x1f]/u.test(b.relativePath) ||
          b.relativePath.split('/').some(p => p === '.' || p === '..') ||
          !/^[0-9a-f]{64}$/iu.test(b.sha256 || '') || seen.has(b.relativePath.toLowerCase())) stop('CANDIDATE_TARGET_INVALID',{index:i+1});
      seen.add(b.relativePath.toLowerCase());
    }
    if (expected && (d.batchId !== expected.batchId || d.batchNumber !== expected.batchNumber || d.books.length !== expected.books.length ||
        key(d.selectionBasis ?? refs(d).map(r=>r.slice(1,3))) !== key(expected.selectionBasis ?? refs(expected).map(r=>r.slice(1,3))))) stop('SELECTION_CHANGED');
    return d;
  }
  function inspectSections(raw) {
    const opaque = reason => ({version:1,status:'opaque',reason});
    const lines = String(raw).replace(/^\uFEFF/u,'').replace(/\r\n?/gu,'\n').split('\n');
    if (lines[0] !== '---') return opaque('frontmatter形式未対応');
    const end = lines.indexOf('---',1); if (end < 1) return opaque('frontmatter終端不明');
    const fm = lines.slice(1,end);
    if (/[&*!]|<<\s*:/u.test(fm.join('\n'))) return opaque('項目間依存等の可能性');
    const fields = Object.create(null), other = []; let current = null;
    for (const line of fm) {
      const m = line.match(/^([^\s#:'"][^:#]*):[ \t]*(.*)$/u);
      if (m) {
        current = m[1].trim();
        if (Object.hasOwn(fields,current)) return opaque('項目重複:'+current);
        fields[current] = [line];
      } else if (!line.trim() || line.trimStart().startsWith('#')) other.push(line);
      else if (/^[ \t]/u.test(line) && current !== null) fields[current].push(line);
      else return opaque('項目構造未対応');
    }
    return {version:1,status:'supported',fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.join('\n')])),
      remainder:JSON.stringify([other,lines.slice(end+1)])};
  }
  function classify(before, after) {
    if (before.relativePath.split('/')[0] !== after.relativePath.split('/')[0]) stop('SOURCE_CATEGORY_CHANGED',{index:before.index});
    const reasons=[];
    if (stem(before.relativePath) !== stem(after.relativePath) || before.title !== after.title) reasons.push('書名・原典ファイル名の変更');
    if (after.relativePath.startsWith('03 ') && before.relativePath.split('/').slice(0,3).join('/') !== after.relativePath.split('/').slice(0,3).join('/')) reasons.push('出版社フォルダの変更');
    if (before.sha256 !== after.sha256) {
      const a=before.sourceAudit,b=after.sourceAudit;
      if (a?.version!==1 || b?.version!==1 || a.status!=='supported' || b.status!=='supported') reasons.push('変更範囲を自動識別できない');
      else {
        if(a.remainderSha256!==b.remainderSha256) reasons.push('本文等の変更');
        for(const k of new Set([...Object.keys(a.fieldHashes),...Object.keys(b.fieldHashes)]))
          if(a.fieldHashes[k]!==b.fieldHashes[k] && !metadata.has(k) && !readingFields.has(k)) reasons.push('原典項目の変更:'+k);
      }
    }
    return {needsSourceReview:reasons.length>0,reasons:[...new Set(reasons)]};
  }
  function magazineState(i, data, choices) {
    const b=data.books[i],c=choices[i];
    const confirmed=choices.flatMap((x,j)=>j!==i && active(x) && x.magazineDecision ? [x.magazineDecision] : []);
    const selection=c.confirmed && c.magazineDecision ? {useSuggested:false,manualName:c.magazineDecision.groupName,
      readingManual:true,readingPrefix:c.magazineDecision.readingPrefix} : c.magazine;
    const result=PukoMagazine.review({...b,fileTitle:stem(b.relativePath),titleReading:c.reading},data.magazineSettings,confirmed,selection||{});
    if(c.confirmed && c.magazineOrigin) result.origin=c.magazineOrigin;
    return result;
  }
  function formMagazine(i,data,choices) {
    const c=choices[i]; if(!c.confirmed || !c.magazineDecision) return clone(c.magazine);
    const s=magazineState(i,data,choices);
    return {useSuggested:s.groupName===s.suggestedName,manualName:s.groupName,
      readingManual:c.magazine?.readingManual===true,readingPrefix:s.readingPrefix};
  }
  function projection(c) {
    const x=clone(c);delete x.relativePath;delete x.sourceSha256;delete x.newFilename;delete x.targetTitle;
    x.needsSourceReview=x.needsSourceReview===true;
    return x;
  }
  function assertPreserved(before,after,expectedPending) {
    const a=projection(before),b=projection(after);delete a.needsSourceReview;delete b.needsSourceReview;
    if(key(a)!==key(b)) stop('CONFIRMED_VALUES_CHANGED');
    if(after.needsSourceReview!==expectedPending) stop('SOURCE_REVIEW_STATE_CHANGED');
  }
  function refreshChoices(oldData,choices,fresh) {
    validateCandidate(fresh,oldData);
    if(fresh.referenceUpdate?.version!==1 || fresh.referenceUpdate.fromKey!==referenceKey(oldData) ||
        key(fresh.referenceUpdate.from)!==key(refs(oldData))) stop('REFERENCE_PARENT_MISMATCH');
    if(!Array.isArray(fresh.referenceUpdate.changes) || fresh.referenceUpdate.changes.length!==choices.length) stop('REFERENCE_CHANGE_COUNT_INVALID');
    const next=choices.map((c,i)=>{
      const observed=classify(oldData.books[i],fresh.books[i]),declared=fresh.referenceUpdate.changes[i];
      if(declared.index!==i+1 || key(observed)!==key({needsSourceReview:declared.needsSourceReview,reasons:declared.reasons})) stop('REFERENCE_CHANGE_INVALID',{index:i+1});
      const n=clone(c);n.newFilename=stem(fresh.books[i].relativePath);
      n.needsSourceReview=c.needsSourceReview===true || observed.needsSourceReview;
      assertPreserved(c,n,n.needsSourceReview);return n;
    });
    for(let i=0;i<next.length;i++) {
      const b=fresh.books[i],c=next[i],row=b.relativePath.split('/')[1];
      if(b.relativePath.startsWith('02 ') || b.relativePath.startsWith('03 ')) {
        const a=magazineState(i,oldData,choices),z=magazineState(i,fresh,next);
        if(a.groupName!==z.groupName) stop('GROUP_SELECTION_WOULD_CHANGE',{index:i+1,before:a.groupName,after:z.groupName});
        if(b.relativePath.startsWith('02 ') && z.readingPrefix && row!=='数字・英語' && PukoMagazine.readingRow(z.readingPrefix)!==row) stop('REFERENCE_ROW_MISMATCH',{index:i+1,path:b.relativePath});
      } else if(b.relativePath.startsWith('01 ') && row!=='数字・英語' && c.reading &&
          PukoMagazine.readingRow(c.reading) && PukoMagazine.readingRow(c.reading)!==row) stop('REFERENCE_ROW_MISMATCH',{index:i+1,path:b.relativePath});
      if(b.titleReading && b.titleReading!==c.reading) stop('SOURCE_READING_CONFLICT',{index:i+1,source:b.titleReading,adopted:c.reading});
    }
    return next;
  }
  function snapshot(data) {
    return {version:1,batchId:data.batchId,batchNumber:data.batchNumber,selectionBasis:clone(data.selectionBasis ?? refs(data).map(r=>r.slice(1,3))),
      magazineSettings:clone(data.magazineSettings ?? {version:1,records:[]}),
      workflow:clone(data.workflow ?? null),referenceUpdate:clone(data.referenceUpdate ?? null),books:data.books.map(b=>Object.fromEntries(sourceFields.filter(k=>b[k]!==undefined).map(k=>[k,clone(b[k])])))};
  }
  function restoreSnapshot(embedded,s) {
    if(s?.version!==1 || s.batchId!==embedded.batchId || s.batchNumber!==embedded.batchNumber ||
        key(s.selectionBasis)!==key(embedded.selectionBasis ?? refs(embedded).map(r=>r.slice(1,3)))) stop('RESTORE_REFERENCE_CONFLICT');
    const d={...clone(embedded),selectionBasis:clone(s.selectionBasis),magazineSettings:clone(s.magazineSettings),workflow:clone(s.workflow),referenceUpdate:clone(s.referenceUpdate ?? null),
      books:embedded.books.map((b,i)=>({...clone(b),...clone(s.books?.[i])}))};
    if(s.books?.length!==embedded.books.length) stop('RESTORE_REFERENCE_COUNT_INVALID');
    return validateCandidate(d,embedded);
  }
  return {clone,key,stop,stem,active,refs,referenceKey,validateCandidate,inspectSections,classify,magazineState,formMagazine,
    projection,assertPreserved,refreshChoices,snapshot,restoreSnapshot};
})();
