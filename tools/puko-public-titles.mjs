import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = message => { throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const title = value => typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);

// JSON.parse alone silently accepts duplicate keys. Reject them before use.
function parseUnique(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    if (text[i] !== '"') fail('PUBLIC_TITLES_JSON_STRING');
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('PUBLIC_TITLES_JSON_UNTERMINATED');
  };
  const value = () => {
    ws();
    if (text[i] === '{') {
      const keys = new Set(); i++; ws();
      if (text[i] === '}') { i++; return; }
      while (i < text.length) {
        ws(); const key = string(); ws();
        if (keys.has(key)) fail('PUBLIC_TITLES_DUPLICATE_KEY=' + key);
        keys.add(key);
        if (text[i++] !== ':') fail('PUBLIC_TITLES_JSON_COLON');
        value(); ws();
        if (text[i] === '}') { i++; return; }
        if (text[i++] !== ',') fail('PUBLIC_TITLES_JSON_COMMA');
      }
      fail('PUBLIC_TITLES_JSON_OBJECT');
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (i < text.length) {
        value(); ws(); if (text[i] === ']') { i++; return; }
        if (text[i++] !== ',') fail('PUBLIC_TITLES_JSON_ARRAY');
      }
      fail('PUBLIC_TITLES_JSON_ARRAY');
    }
    if (text[i] === '"') { string(); return; }
    const start = i;
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    if (start === i) fail('PUBLIC_TITLES_JSON_VALUE');
    JSON.parse(text.slice(start, i));
  };
  value(); ws(); if (i !== text.length) fail('PUBLIC_TITLES_JSON_TRAILING');
  return JSON.parse(text);
}

export function validateTitles(data) {
  if (!object(data) || data.version !== 1 || !object(data.records) ||
      Object.keys(data).some(key => !['version', 'records'].includes(key))) fail('PUBLIC_TITLES_SCHEMA');
  for (const [id, value] of Object.entries(data.records)) {
    if (!/^B[0-9]{6}$/.test(id) || !title(value)) fail('PUBLIC_TITLES_INVALID=' + id);
  }
  return data;
}
export function readTitles(file) {
  if (!fs.lstatSync(file).isFile()) fail('PUBLIC_TITLES_NOT_REGULAR_FILE');
  return validateTitles(parseUnique(fs.readFileSync(file, 'utf8')));
}
export function validateResolved(data, records) {
  validateTitles(data);
  const byId = new Map();
  for (const row of records) {
    if (byId.has(row.opacId)) fail('PUBLIC_TITLES_DUPLICATE_RESOLVED_ID=' + row.opacId);
    byId.set(row.opacId, row);
  }
  for (const id of Object.keys(data.records)) {
    if (byId.get(id)?.type !== 'book') fail('PUBLIC_TITLES_UNRESOLVED_ID=' + id);
  }
}
export function rejectSourceRenames(config, batch) {
  if ((config.filenameRenames ?? 0) !== 0 || (config.rowMoves ?? 0) !== 0 ||
      (config.postApplyIdMoves ?? 0) !== 0) fail('SOURCE_RENAME_OR_MOVE_FORBIDDEN');
  for (const row of batch.books ?? []) {
    if (row.filenameChange !== false ||
        ['rowMove','moveTo','destinationPath','newRelativePath'].some(key => Boolean(row[key]))) {
      fail('SOURCE_RENAME_OR_MOVE_FORBIDDEN=' + row.index);
    }
  }
}
export function applyDirectives(formal, batch, records) {
  validateResolved(formal, records);
  rejectSourceRenames({}, batch);
  if (batch.kind !== 'puko-title-reading-final-review' || !Array.isArray(batch.books)) fail('PUBLIC_TITLES_BATCH');
  const result = {version: 1, records: {...formal.records}};
  const paths = new Map(records.map(row => [row.relativePath, row]));
  const seen = new Set();
  for (const book of batch.books) {
    if (seen.has(book.relativePath) || book.humanConfirmed !== true || typeof book.usePublicTitle !== 'boolean') fail('PUBLIC_TITLES_DIRECTIVE_INVALID');
    seen.add(book.relativePath);
    const record = paths.get(book.relativePath);
    if (!record || record.type !== 'book' || !/^B[0-9]{6}$/.test(record.opacId)) fail('PUBLIC_TITLES_BOOK_UNRESOLVED=' + book.index);
    if (book.usePublicTitle) {
      if (!title(book.publicTitle)) fail('PUBLIC_TITLES_DIRECTIVE_EMPTY_OR_INVALID=' + book.index);
      result.records[record.opacId] = book.publicTitle;
    }
    // OFF deliberately does not delete, reset or rewrite an existing setting.
  }
  return validateTitles(result);
}
export function assertPreviewTitles(formal, preview, batch, idMap) {
  if (idMap.version !== 1 || !object(idMap.records)) fail('PUBLIC_TITLES_ID_MAP');
  const records = Object.entries(idMap.records).map(([relativePath, opacId]) => ({
    relativePath, opacId, type: relativePath.startsWith('11 著者/') ? 'author' : 'book',
  }));
  const expected = applyDirectives(formal, batch, records);
  validateResolved(preview, records);
  const keys = Object.keys(expected.records).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(preview.records).sort()) ||
      keys.some(id => expected.records[id] !== preview.records[id])) fail('PUBLIC_TITLES_PREVIEW_DIRECTIVES_MISMATCH');
  return expected;
}
export function displayTitle(sourceFile, relativePath, opacId, settings) {
  if (Object.hasOwn(settings.records, opacId)) return settings.records[opacId];
  // Match the existing builder's legacy read semantics; never write the source.
  const text = fs.readFileSync(sourceFile, 'utf8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const scalar = value => {
    let out = value.trim();
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) out = out.slice(1,-1);
    return out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'$2').replace(/\[\[([^\]]+)\]\]/g,'$1').trim();
  };
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    for (let i=1; i<end; i++) {
      const match = lines[i].match(/^公開書名:\s*(.*)$/);
      if (!match) continue;
      if (match[1].trim() && scalar(match[1])) return scalar(match[1]);
      for (let j=i+1; j<end; j++) {
        if (/^[^\s#][^:]*:/.test(lines[j])) break;
        const item=lines[j].match(/^\s*-\s*(.+)$/);
        if (item && scalar(item[1])) return scalar(item[1]);
      }
      break;
    }
  }
  return path.posix.basename(relativePath, '.md');
}
export function writeTitles(file, data) {
  validateTitles(data);
  const bytes = JSON.stringify(data, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temp, bytes, {flag: 'wx'});
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
