import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rejectSourceRenames } from './puko-public-titles.mjs';
import { PukoMagazine } from './puko-magazine-core.mjs';

const fail = message => { throw Error(message); };
export const ROOTS = {general:'01 一般書籍',magazine:'02 市販雑誌 雑誌名順',series:'03 シリーズ 出版社順',classic:'05 古典 著者出生地分類'};
export const CLASSIC_FOLDERS = ['日本古典 1853年以前','東洋古典 1840年以前','西洋古典 1769年以前','東洋法典','西洋法典'];
const rows = ['あ','か','さ','た','な','は','ま','や','ら','わ','数字・英語'];
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim() === x && x.length > 0 && !/[\x00-\x1f\x7f|\[\]#]/u.test(x);
const norm = x => String(x).normalize('NFKC').replace(/[\s　]+/gu,' ').trim();
export const normalizeGroupReading = x => norm(x).replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-96));
const compact = x => normalizeGroupReading(x).replace(/\s/gu,'');
const starts = (value,prefix) => norm(value) === norm(prefix) || norm(value).startsWith(norm(prefix)+' ');
export const naturalCompare = (a,b) => String(a).localeCompare(String(b),'ja',{numeric:true,sensitivity:'base'});
export const stableBookCompare = (a,b) => naturalCompare(a.title,b.title) || String(a.title).localeCompare(String(b.title),'ja') || String(a.opacId).localeCompare(String(b.opacId),'en');

export function bookLocation(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.split('/').some(x=>!x || x==='.' || x==='..') || !relativePath.endsWith('.md')) fail('BOOK_PATH_INVALID='+relativePath);
  const p=relativePath.split('/');
  const kind=Object.keys(ROOTS).find(k=>ROOTS[k]===p[0]);
  if (!kind || (kind==='series' ? p.length!==4 || !rows.includes(p[1]) : p.length!==3) ||
      (kind==='classic' ? !CLASSIC_FOLDERS.includes(p[1]) : !rows.includes(p[1]))) fail('BOOK_PATH_UNSUPPORTED='+relativePath);
  return {kind,row:p[1],publisher:kind==='series'?p.slice(0,3).join('/'):'',fileTitle:p.at(-1).slice(0,-3)};
}
export function readingRow(reading) {
  let c=[...normalizeGroupReading(reading).replace(/^[\s「」『』【】〔〕〈〉《》（）()［］・、。…―—〜～]+/u,'')][0];
  if (!c) return null;
  c=c.normalize('NFD')[0];
  c=({'ぁ':'あ','ぃ':'い','ぅ':'う','ぇ':'え','ぉ':'お','っ':'つ','ゃ':'や','ゅ':'ゆ','ょ':'よ','ゎ':'わ','ゐ':'い','ゑ':'え'})[c]||c;
  const i=['あいうえお','かきくけこ','さしすせそ','たちつてと','なにぬねの','はひふへほ','まみむめも','やゆよ','らりるれろ','わをん'].findIndex(s=>s.includes(c));
  return i<0 ? null : rows[i];
}

// Reject duplicate JSON keys, including nested keys, before JSON.parse can discard them.
function parseUnique(raw) {
  const s=raw.replace(/^\uFEFF/,''); let i=0;
  const ws=()=>{while(i<s.length&&/\s/u.test(s[i]))i++;};
  const str=()=>{const start=i++;while(i<s.length){if(s[i]==='\\'){i+=2;continue;}if(s[i++]==='"')return JSON.parse(s.slice(start,i));}fail('INDEX_GROUP_JSON_STRING');};
  const value=()=>{ws();if(s[i]==='{'){i++;ws();const seen=new Set();if(s[i]==='}'){i++;return;}while(i<s.length){if(s[i]!=='"')fail('INDEX_GROUP_JSON_KEY');const k=str();if(seen.has(k))fail('INDEX_GROUP_DUPLICATE_KEY='+k);seen.add(k);ws();if(s[i++]!==':')fail('INDEX_GROUP_JSON_COLON');value();ws();if(s[i]==='}'){i++;return;}if(s[i++]!==',')fail('INDEX_GROUP_JSON_COMMA');ws();}fail('INDEX_GROUP_JSON_OBJECT');}else if(s[i]==='['){i++;ws();if(s[i]===']'){i++;return;}while(i<s.length){value();ws();if(s[i]===']'){i++;return;}if(s[i++]!==',')fail('INDEX_GROUP_JSON_COMMA');}fail('INDEX_GROUP_JSON_ARRAY');}else if(s[i]==='"'){str();}else{const start=i;while(i<s.length&&!/[\s,}\]]/u.test(s[i]))i++;if(i===start)fail('INDEX_GROUP_JSON_VALUE');JSON.parse(s.slice(start,i));}};
  value();ws();if(i!==s.length)fail('INDEX_GROUP_JSON_TRAILING');return JSON.parse(s);
}
const ruleKey = r => r.match==='item' ? JSON.stringify([r.kind,'item',r.basis.opacId]) : JSON.stringify([r.kind,r.publisher,r.titlePrefix]);
export function validateGroups(data) {
  if (!plain(data) || ![1,2].includes(data.version) || !Array.isArray(data.records) || Object.keys(data).some(k=>!['version','records'].includes(k))) fail('INDEX_GROUP_SCHEMA');
  const keys=new Set();
  for(const r of data.records) {
    if (r?.match==='item') {
      if(data.version!==2 || Object.keys(r).some(k=>!['match','kind','publisher','groupName','readingPrefix','basis','batchId','confirmedAt'].includes(k)) || !['magazine','series'].includes(r.kind) || (r.kind==='magazine' ? r.publisher!=='' : typeof r.publisher!=='string' || !r.publisher.startsWith(ROOTS.series+'/') || r.publisher.split('/').length!==3 || !rows.includes(r.publisher.split('/')[1])) || !text(r.groupName) || !text(r.readingPrefix) || !readingRow(r.readingPrefix) || !plain(r.basis) || Object.keys(r.basis).length!==1 || !/^B[0-9]{6}$/u.test(r.basis.opacId) || !/^[A-F0-9]{12}$/u.test(r.batchId) || typeof r.confirmedAt!=='string' || !Number.isFinite(Date.parse(r.confirmedAt)))fail('INDEX_GROUP_ITEM_INVALID');
      if(keys.has(ruleKey(r)))fail('INDEX_GROUP_DUPLICATE_SCOPE');keys.add(ruleKey(r));continue;
    }
    if (!plain(r) || Object.keys(r).some(k=>!['kind','publisher','titlePrefix','groupName','readingPrefix','basis','batchId','confirmedAt'].includes(k)) || !['magazine','series'].includes(r.kind) ||
        !text(r.titlePrefix) || !text(r.groupName) || !text(r.readingPrefix) || !readingRow(r.readingPrefix) ||
        (r.kind==='magazine' ? r.publisher!=='' : typeof r.publisher!=='string' || !r.publisher.startsWith(ROOTS.series+'/') || r.publisher.split('/').length!==3 || !rows.includes(r.publisher.split('/')[1])) ||
        !plain(r.basis) || Object.keys(r.basis).length!==1 || !/^B[0-9]{6}$/u.test(r.basis.opacId) || !/^[A-F0-9]{12}$/u.test(r.batchId) || typeof r.confirmedAt!=='string' || !Number.isFinite(Date.parse(r.confirmedAt))) fail('INDEX_GROUP_RULE_INVALID');
    if(keys.has(ruleKey(r)))fail('INDEX_GROUP_DUPLICATE_SCOPE');keys.add(ruleKey(r));
  }
  return data;
}
export function readGroups(file) {
  if(!fs.lstatSync(file).isFile()) fail('INDEX_GROUP_NOT_REGULAR_FILE');
  return validateGroups(parseUnique(fs.readFileSync(file,'utf8')));
}
export function writeGroups(file,data) {
  validateGroups(data);fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
const scopeMatches = (rule,record) => {
  let loc;try{loc=bookLocation(record.relativePath);}catch{return false;}
  return rule.match==='item' ? loc.kind===rule.kind && loc.publisher===rule.publisher && record.opacId===rule.basis.opacId : loc.kind===rule.kind && loc.publisher===rule.publisher && starts(record.fileTitle||loc.fileTitle,rule.titlePrefix);
};
export function validateGroupBasis(data,records) {
  validateGroups(data);const ids=new Map();
  for(const r of records){if(ids.has(r.opacId))fail('INDEX_GROUP_DUPLICATE_ID='+r.opacId);ids.set(r.opacId,r);}
  for(const r of data.records) {
    const basis=ids.get(r.basis.opacId);
    if(!basis || !scopeMatches(r,basis) || !basis.titleReading || !compact(basis.titleReading).startsWith(compact(r.readingPrefix))) fail('INDEX_GROUP_BASIS_CONFLICT='+r.basis.opacId);
  }
}
export function applyGroupDirectives(formal,batch,records) {
  validateGroups(formal);rejectSourceRenames({},batch);
  if(batch.version===2)for(const b of batch.books||[])if(b.relativePath?.startsWith(ROOTS.magazine+'/')&&!b.indexGroupDecision)fail('INDEX_GROUP_FINAL_MISSING_OR_INVALID='+b.index);
  const result=structuredClone(formal), byPath=new Map(records.map(r=>[r.relativePath,r]));
  const adopted=new Map();
  for(const b of batch.books||[]) {
    if(b.indexGroupDecision==null)continue;
    const d=b.indexGroupDecision,r=byPath.get(b.relativePath);
    if(batch.version===2 && (b.relativePath.startsWith(ROOTS.magazine+'/') || (b.relativePath.startsWith(ROOTS.series+'/') && !Object.hasOwn(d,'titlePrefix')))) {
      if(b.humanConfirmed!==true || !r || !plain(d) || Object.keys(d).some(k=>!(b.relativePath.startsWith(ROOTS.series+'/')?['kind','publisher','groupName','readingPrefix']:['kind','groupName','readingPrefix']).includes(k)) || d.kind!==bookLocation(b.relativePath).kind || (d.kind==='series' && d.publisher!==bookLocation(b.relativePath).publisher))fail('INDEX_GROUP_UNAPPROVED='+b.index);
      const error=PukoMagazine.decisionError({...r,titleReading:b.titleReading},d);
      if(error)fail('INDEX_GROUP_DIRECTIVE_CONFLICT='+b.index+': '+error);
      const rule={match:'item',kind:d.kind,publisher:bookLocation(b.relativePath).publisher,groupName:d.groupName,readingPrefix:d.readingPrefix,basis:{opacId:r.opacId},batchId:batch.batchId,confirmedAt:batch.confirmedAt};
      const existing=result.records.findIndex(x=>x.match==='item' && x.basis.opacId===r.opacId);
      if(existing<0)result.records.push(rule);else result.records[existing]=rule;
      result.version=2;continue;
    }
    if(b.humanConfirmed!==true || !r || !plain(d) || Object.keys(d).some(k=>!['kind','publisher','titlePrefix','groupName','readingPrefix'].includes(k)))fail('INDEX_GROUP_UNAPPROVED='+b.index);
    const rule={...d,basis:{opacId:r.opacId},batchId:batch.batchId,confirmedAt:batch.confirmedAt};
    validateGroups({version:1,records:[rule]});
    if(!scopeMatches(rule,r) || !compact(b.titleReading).startsWith(compact(rule.readingPrefix)))fail('INDEX_GROUP_DIRECTIVE_CONFLICT='+b.index);
    const key=ruleKey(rule), previous=adopted.get(key);
    const same=(x,y)=>['kind','publisher','titlePrefix','groupName','readingPrefix'].every(k=>x[k]===y[k]);
    if(previous && !same(previous,rule))fail('INDEX_GROUP_BATCH_CONFLICT='+key);
    adopted.set(key,previous||rule);
    const existing=result.records.find(x=>ruleKey(x)===key);
    if(existing && !same(existing,rule))fail('INDEX_GROUP_EXISTING_DECISION_CONFLICT='+key);
    if(!existing)result.records.push(previous||rule);
  }
  result.records.sort((a,b)=>ruleKey(a).localeCompare(ruleKey(b),'ja'));
  validateGroupBasis(result,records);return result;
}
export function assertPreviewGroups(formal,preview,batch,records) {
  const expected=applyGroupDirectives(formal,batch,records);
  validateGroupBasis(preview,records);
  const canonical=d=>JSON.stringify([...d.records].sort((a,b)=>ruleKey(a).localeCompare(ruleKey(b),'ja')));
  if(canonical(expected)!==canonical(preview))fail('INDEX_GROUP_PREVIEW_DIRECTIVES_MISMATCH');
  return expected;
}

function numbered(record) {
  const t=norm(record.fileTitle), m=t.match(/^(.+?)\s+(第\s*)?(\d+(?:[-‐‑–—.]\d+)*)(?=$|[\s年月巻号集編部])/u);
  if(!m)return null;
  const prefix=m[1], token=m[3];
  const all=[...norm(record.titleReading).matchAll(/\d+(?:[-‐‑–—.]\d+)*/gu)].filter(x=>x[0]===token);
  if(all.length!==1)return {groupName:prefix,reading:null,reason:'READING_BOUNDARY'};
  let reading=norm(record.titleReading).slice(0,all[0].index).trim();
  if(m[2]) {if(!/(?:ダイ|だい)\s*$/u.test(reading))return {groupName:prefix,reading:null,reason:'ORDINAL_READING'};reading=reading.replace(/(?:ダイ|だい)\s*$/u,'').trim();}
  return {groupName:prefix,reading,reason:reading?null:'READING_BOUNDARY'};
}
export function resolveIndexGroups(records,settings) {
  validateGroupBasis(settings,records);const result=new Map(), pending=[];
  for(const record of records) {
    let loc;try{loc=bookLocation(record.relativePath);}catch{continue;}
    if(!['magazine','series'].includes(loc.kind) || !record.titleReading)continue;
    const item=settings.records.find(r=>r.match==='item'&&scopeMatches(r,record));
    const rules=item?[item]:settings.records.filter(r=>r.match===undefined&&scopeMatches(r,record));
    if(rules.length>1)fail('INDEX_GROUP_AMBIGUOUS_PREFIX='+record.relativePath);
    let group;
    if(rules.length===1)group={groupName:rules[0].groupName,reading:rules[0].readingPrefix};
    else {
      const candidate=PukoMagazine.review(record,settings);
      group=candidate.groupName?{groupName:candidate.groupName,reading:candidate.readingPrefix||null}:null;
    }
    if(group?.reading) result.set(record.relativePath,{...group,...loc});
    else pending.push({record,loc,group});
  }
  for(const {record,loc,group} of pending) {
    const matches=[...result.values()].filter(x=>x.kind===loc.kind&&x.publisher===loc.publisher&&group?.groupName&&norm(x.groupName)===norm(group.groupName));
    const readings=[...new Set(matches.map(x=>normalizeGroupReading(x.reading)))];
    if(readings.length===1)result.set(record.relativePath,{...loc,groupName:group.groupName,reading:matches[0].reading});
    else fail('INDEX_GROUP_REVIEW_REQUIRED='+record.relativePath+': '+(group?.groupName?'誌名・シリーズ名の読みの区切りを本人確認':'誌名・シリーズ名を本人確認'));
  }
  const readings=new Map();
  for(const [relative,g] of result) {
    const record=records.find(r=>r.relativePath===relative), key=JSON.stringify([g.kind,g.publisher,norm(g.groupName)]), reading=compact(g.reading);
    if(!reading || !compact(record.titleReading).startsWith(reading))fail('INDEX_GROUP_READING_PREFIX_CONFLICT='+relative);
    if(readings.has(key)&&readings.get(key)!==reading)fail('INDEX_GROUP_READING_CONFLICT='+relative);
    readings.set(key,reading);
    if(g.kind==='magazine' && g.row!=='数字・英語' && readingRow(g.reading)!==g.row)fail('MAGAZINE_ROW_MISMATCH='+relative+': 誌名読み='+g.reading+' / 原典行='+g.row+'。本人による移動とID引継ぎが必要です');
  }
  return result;
}

export function validateBatchShape(batch,config) {
  rejectSourceRenames(config,batch);
  const n=config.indexRange??(config.targets===100?100:NaN),m=config.targets,e=config.excludedIndexes??[];
  if(![1,2].includes(batch.version) || batch.kind!=='puko-title-reading-final-review' || !/^[A-F0-9]{12}$/u.test(batch.batchId) || batch.batchId!==config.batchId || !Number.isInteger(n)||n<1||n>100||!Number.isInteger(m)||m<1||m>n||!Array.isArray(e)||e.length!==n-m||new Set(e).size!==e.length||e.some(x=>!Number.isInteger(x)||x<1||x>n)||!Array.isArray(batch.books)||batch.books.length!==m)fail('BATCH_COUNT_OR_ID_INVALID');
  if(batch.groupDecisionVersion!==undefined && batch.groupDecisionVersion!==1)fail('GROUP_DECISION_VERSION_INVALID');
  if(batch.groupDecisionVersion===1)for(const b of batch.books)if(['magazine','series'].includes(bookLocation(b.relativePath).kind)&&!b.indexGroupDecision)fail('INDEX_GROUP_FINAL_MISSING_OR_INVALID='+b.index);
  const indexes=new Set(),paths=new Set();
  for(const b of batch.books){bookLocation(b.relativePath);if(!Number.isInteger(b.index)||b.index<1||b.index>n||e.includes(b.index)||indexes.has(b.index)||paths.has(b.relativePath)||b.humanConfirmed!==true||!text(b.titleReading)||!/^[a-f0-9]{64}$/iu.test(b.sourceSha256))fail('BATCH_TARGET_INVALID='+b.index);indexes.add(b.index);paths.add(b.relativePath);}
  for(const b of batch.books){
    if(b.needsSourceReview!==undefined && typeof b.needsSourceReview!=='boolean')fail('SOURCE_REVIEW_STATE_INVALID='+b.index);
    if(b.needsSourceReview===true)fail('SOURCE_REVIEW_PENDING='+b.index);
  }
  if(batch.version===2)for(const b of batch.books){
    const loc=bookLocation(b.relativePath),d=b.indexGroupDecision;
    if(loc.kind==='magazine' || (loc.kind==='series' && d && !Object.hasOwn(d,'titlePrefix'))){
      const fields=loc.kind==='series'?['kind','publisher','groupName','readingPrefix']:['kind','groupName','readingPrefix'];
      if(!plain(d)||d.kind!==loc.kind||Object.keys(d).some(k=>!fields.includes(k))||(loc.kind==='series'&&d.publisher!==loc.publisher)||PukoMagazine.decisionError({...b,fileTitle:loc.fileTitle},d))fail('INDEX_GROUP_FINAL_MISSING_OR_INVALID='+b.index);
    }
  }
  return {selected:n,excluded:e.length,applied:m};
}

// The existing runner calls this read-only preflight before planning/writing readings.
// It is not a new user-operated step. It also supplies common parsers to the auditors.
export function readSourceRecord(source,relativePath,opacId) {
  const file=path.resolve(source,...relativePath.split('/'));
  const rel=path.relative(path.resolve(source),file);if(rel.startsWith('..')||path.isAbsolute(rel))fail('SOURCE_ESCAPE');
  const raw=fs.readFileSync(file,'utf8'), lines=raw.replace(/^\uFEFF/,'').replace(/\r\n?/gu,'\n').split('\n');
  const end=lines[0]==='---'?lines.indexOf('---',1):-1;
  const scalar=x=>{let s=x.trim();if(s.startsWith('"')&&s.endsWith('"')){try{s=JSON.parse(s);}catch{s=s.slice(1,-1);}}else if(s.startsWith("'")&&s.endsWith("'"))s=s.slice(1,-1).replace(/''/gu,"'");return s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu,'$2').replace(/\[\[([^\]]+)\]\]/gu,'$1').trim();};
  const values=name=>{const out=[];for(let i=1;i<end;i++){const m=lines[i].match(new RegExp('^'+name+':\\s*(.*)$','u'));if(!m)continue;if(m[1].trim().startsWith('[')&&m[1].trim().endsWith(']')){out.push(...m[1].trim().slice(1,-1).split(',').map(scalar).filter(Boolean));}else if(m[1].trim())out.push(scalar(m[1]));else for(let j=i+1;j<end;j++){const item=lines[j].match(/^\s*-\s*(.+)$/u);if(item)out.push(scalar(item[1]));else if(/^\S/u.test(lines[j]))break;}}return out;};
  return {relativePath,opacId,type:relativePath.startsWith('11 著者/')?'author':'book',fileTitle:path.posix.basename(relativePath,'.md'),titleReading:values('書名読み')[0]||values('タイトル読み')[0]||'',series:values('シリーズ'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
}
export function sourceRecords(source,idMap) {
  const paths=[];
  const walk=dir=>{if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.isFile()&&e.name.endsWith('.md'))paths.push(path.relative(source,file).split(path.sep).join('/'));}};
  for(const root of Object.values(ROOTS))walk(path.join(source,root));
  const used=new Set(Object.values(idMap.records));let temp=999999;
  return paths.sort().map(p=>{while(used.has('B'+String(temp).padStart(6,'0')))temp--;const id=idMap.records[p]||'B'+String(temp--).padStart(6,'0');used.add(id);return readSourceRecord(source,p,id);});
}

// Captured inventory/settings enrich the existing review; no decisions are saved here.
export function prepareGroupReview(candidate,inventory) {
  const formal=inventory.indexGroupSettings;validateGroups(formal);
  const all=(inventory.books||[]).filter(b=>Object.values(ROOTS).some(root=>b.relativePath?.startsWith(root+'/'))).map((b,i)=>({...b,fileTitle:path.posix.basename(b.relativePath,'.md'),opacId:b.opacId||'B'+String(900000+i).padStart(6,'0'),type:'book',series:b.series||[]}));
  const byPath=new Map(all.map(b=>[b.relativePath,b]));const result=structuredClone(candidate);
  result.magazineSettings=structuredClone(formal);
  for(const b of result.books) {
    const loc=bookLocation(b.relativePath);if(!['magazine','series'].includes(loc.kind))continue;
    const base=byPath.get(b.relativePath);if(!base||base.sha256?.toLowerCase()!==b.sha256?.toLowerCase())fail('INDEX_GROUP_INVENTORY_TARGET_MISMATCH='+b.relativePath);
    const proposed=b.reviewAid?.suggestions?.[0]?.reading||b.proposal?.titleReading||'';
    let carriedId=null;
    if(b.referenceBinding?.opacId){
      const link=b.referenceBinding,ctx=inventory.idContext;
      const old=ctx?.baselineRecords?.filter(r=>r.relativePath===link.idOldPath);
      if(link.index!==b.index || link.newPath!==b.relativePath || link.newSha256!==b.sha256 ||
          ctx?.idMapRecords?.[link.idOldPath]!==link.opacId || old?.length!==1 ||
          old[0].opacId!==link.opacId || old[0].sha256.toLowerCase()!==link.baselineOldSha256 ||
          (ctx.idMapRecords[b.relativePath]!==undefined && ctx.idMapRecords[b.relativePath]!==link.opacId) ||
          (link.idOldPath!==b.relativePath && (inventory.books||[]).some(r=>r.relativePath===link.idOldPath)))fail('REVIEW_ID_BINDING_INVALID='+b.index);
      carriedId=link.opacId;
    }
    const target={...base,opacId:carriedId||base.opacId,titleReading:proposed},context=all.map(x=>x.relativePath===b.relativePath?target:x);
    b.opacId=target.opacId;b.magazineReview=PukoMagazine.review(target,formal);
    delete b.indexGroupReview;delete b.indexGroupIssue;delete b.indexGroupResolved;
  }
  return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv[2]==='--workflow'){
    const {runWorkflowAction}=await import('./puko-reading-workflow.mjs');
    const input=parseUnique(fs.readFileSync(0,'utf8'));
    const result=runWorkflowAction(process.argv[3],input,{bookLocation,readingRow,prepareGroupReview,validateBatchShape,applyGroupDirectives,resolveIndexGroups});
    process.stdout.write(JSON.stringify(result));
  } else if(process.argv[2]==='--prepare-review'){const input=parseUnique(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(prepareGroupReview(input.candidate,input.inventory)));} else {
  const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
  const source=args.get('--source'),repo=args.get('--repo'),batch=JSON.parse(fs.readFileSync(args.get('--batch'),'utf8').replace(/^\uFEFF/,'')),config=JSON.parse(fs.readFileSync(args.get('--config'),'utf8').replace(/^\uFEFF/,''));
  validateBatchShape(batch,config);
  const map=JSON.parse(fs.readFileSync(path.join(repo,'data/opac-id-map.json'),'utf8').replace(/^\uFEFF/,''));
  // Apply precedes the existing path-only ID migration. Resolve declared pending
  // human moves in memory so a saved group's basis ID remains resolvable here.
  const pendingMap=structuredClone(map);
  if(config.migrationJsonSha256!==undefined) {
    const migrationFile=path.join(path.dirname(args.get('--config')),'migration.json'),bytes=fs.readFileSync(migrationFile);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==config.migrationJsonSha256)fail('INDEX_GROUP_MIGRATION_SHA_MISMATCH');
    const migration=parseUnique(bytes.toString('utf8'));
    if(migration.batchId!==batch.batchId || !Array.isArray(migration.moves) || migration.moves.length!==(config.preApplyIdMoves||0)+(config.postApplyIdMoves||0))fail('INDEX_GROUP_MIGRATION_INVALID');
    for(const move of migration.moves){
      if(!String(move.opacId).startsWith('B') || !Object.values(ROOTS).some(root=>move.newPath?.startsWith(root+'/')))continue;
      bookLocation(move.oldPath);bookLocation(move.newPath);
      if(map.records[move.oldPath]===move.opacId && map.records[move.newPath]===undefined){delete pendingMap.records[move.oldPath];pendingMap.records[move.newPath]=move.opacId;}
      else if(map.records[move.newPath]!==move.opacId || map.records[move.oldPath]!==undefined)fail('INDEX_GROUP_PENDING_ID_CONFLICT='+move.opacId);
    }
  }

  // New books need not have an assigned ID until Preview; deterministic temporary IDs
  // are only used in memory for preflight, never persisted or published.
  const records=sourceRecords(source,pendingMap),byPath=new Map(records.map(r=>[r.relativePath,r]));let temporary=999999;
  for(const b of batch.books){let r=byPath.get(b.relativePath);if(!r){r=readSourceRecord(source,b.relativePath,'B'+String(temporary--).padStart(6,'0'));records.push(r);}if(r.sha256!==b.sourceSha256.toLowerCase())fail('SOURCE_SHA_MISMATCH='+b.index);r.titleReading=b.titleReading;const loc=bookLocation(b.relativePath);if(loc.kind==='general'&&loc.row!=='数字・英語'&&readingRow(b.titleReading)!==loc.row)fail('GENERAL_ROW_MISMATCH='+b.relativePath);}
  const settings=applyGroupDirectives(readGroups(path.join(repo,'data/opac-index-groups.json')),batch,records);
  resolveIndexGroups(records,settings);console.log('INDEX_GROUP_PREFLIGHT=PASS');
  }
}
