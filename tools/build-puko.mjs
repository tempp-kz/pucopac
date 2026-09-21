#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PUBLIC_ROOTS = [
  "01 一般書籍",
  "03 シリーズ 出版社順",
  "05 古典 著者出生地分類",
  "07 外国語書籍",
  "11 著者",
]

const AUTHOR_ROOT = "11 著者"
const CLASSICS_ROOT = "05 古典 著者出生地分類"
const GENERAL_BOOK_ROOT = "01 一般書籍"
const SERIES_ROOT = "03 シリーズ 出版社順"
const ALLOWED_OUTPUT_NAMES = new Set(["content-preview", "content"])
const KANA_FOLDERS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ"]
const KANA_HEADINGS = {
  あ: ["あ", "い", "う", "え", "お"],
  か: ["か", "き", "く", "け", "こ"],
  さ: ["さ", "し", "す", "せ", "そ"],
  た: ["た", "ち", "つ", "て", "と"],
  な: ["な", "に", "ぬ", "ね", "の"],
  は: ["は", "ひ", "ふ", "へ", "ほ"],
  ま: ["ま", "み", "む", "め", "も"],
  や: ["や", "ゆ", "よ"],
  ら: ["ら", "り", "る", "れ", "ろ"],
  わ: ["わ", "を", "ん"],
}
const KANA_BASE = new Map([
  ["ぁ", "あ"],
  ["ぃ", "い"],
  ["ぅ", "う"],
  ["ゔ", "う"],
  ["ぇ", "え"],
  ["ぉ", "お"],
  ["が", "か"],
  ["ぎ", "き"],
  ["ぐ", "く"],
  ["げ", "け"],
  ["ご", "こ"],
  ["ざ", "さ"],
  ["じ", "し"],
  ["ず", "す"],
  ["ぜ", "せ"],
  ["ぞ", "そ"],
  ["だ", "た"],
  ["ぢ", "ち"],
  ["っ", "つ"],
  ["づ", "つ"],
  ["で", "て"],
  ["ど", "と"],
  ["ば", "は"],
  ["ぱ", "は"],
  ["び", "ひ"],
  ["ぴ", "ひ"],
  ["ぶ", "ふ"],
  ["ぷ", "ふ"],
  ["べ", "へ"],
  ["ぺ", "へ"],
  ["ぼ", "ほ"],
  ["ぽ", "ほ"],
  ["ゃ", "や"],
  ["ゅ", "ゆ"],
  ["ょ", "よ"],
  ["ゎ", "わ"],
  ["ゐ", "い"],
  ["ゑ", "え"],
])
const NDC_CLASSES = [
  { code: "000", digit: "0", label: "総記（雑誌除）" },
  { code: "100", digit: "1", label: "哲学" },
  { code: "200", digit: "2", label: "歴史" },
  { code: "300", digit: "3", label: "社会科学" },
  { code: "400", digit: "4", label: "自然科学" },
  { code: "500", digit: "5", label: "技術・工学" },
  { code: "600", digit: "6", label: "産業" },
  { code: "700", digit: "7", label: "芸術・美術" },
  { code: "800", digit: "8", label: "言語" },
  { code: "900", digit: "9", label: "文学" },
]

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const NDC_LABELS_PATH = path.join(REPO_ROOT, "data", "ndc10-labels.json")
const NDC_LABELS = JSON.parse(fs.readFileSync(NDC_LABELS_PATH, "utf8")).labels

function fail(message) {
  throw new Error(message)
}

function ndcLabel(code) {
  const label = NDC_LABELS[code]
  if (!label) fail(`NDC分類名が見つかりません: ${code}`)
  return label
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === "--publish") {
      args.publish = true
      continue
    }
    if (!token.startsWith("--")) fail(`不明な引数です: ${token}`)
    const key = token.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith("--")) fail(`${token} の値がありません`)
    args[key] = value
    i += 1
  }
  if (!args.source) fail("--source を指定してください")
  if (!args.output) fail("--output を指定してください")
  if (!args["id-map"]) fail("--id-map を指定してください")
  return args
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n")
}

function normalizedRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/")
}

function isSameOrInside(candidate, parent) {
  const rel = path.relative(parent, candidate)
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
}

function assertSafePaths(sourceRoot, outputRoot, idMapPath, publish) {
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    fail(`変換元フォルダが存在しません: ${sourceRoot}`)
  }

  const outputName = path.basename(outputRoot)
  if (!ALLOWED_OUTPUT_NAMES.has(outputName)) {
    fail(`出力先の末尾は content-preview または content にしてください: ${outputRoot}`)
  }
  if (outputName === "content" && !publish) {
    fail(
      "content を置き換える場合は --publish が必要です。試験時は content-preview を使ってください",
    )
  }

  if (isSameOrInside(outputRoot, sourceRoot) || isSameOrInside(sourceRoot, outputRoot)) {
    fail("変換元と出力先が重なっています。原本保護のため中止しました")
  }
  if (isSameOrInside(idMapPath, sourceRoot)) {
    fail("ID対応表が変換元の中にあります。原本保護のため中止しました")
  }
}

function listMarkdownFiles(root) {
  const files = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath)
    }
  }
  visit(root)
  return files
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function splitFrontmatter(text, filePath) {
  const normalized = normalizeNewlines(text)
  const lines = normalized.split("\n")
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: [], body: normalized, hadFrontmatter: false }
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end < 0) fail(`frontmatter の終端 --- がありません: ${filePath}`)
  return {
    frontmatter: lines.slice(1, end),
    body: lines.slice(end + 1).join("\n"),
    hadFrontmatter: true,
  }
}

function yamlScalar(value) {
  let result = value.trim()
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1)
  }
  result = result.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
  result = result.replace(/\[\[([^\]]+)\]\]/g, "$1")
  return result.trim()
}

function getYamlValues(lines, key) {
  const values = []
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const keyPattern = new RegExp(`^${escaped}:\\s*(.*)$`)
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyPattern)
    if (!match) continue
    if (match[1].trim()) values.push(yamlScalar(match[1]))
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^[^\s#][^:]*:/.test(lines[j])) break
      const listItem = lines[j].match(/^\s*-\s*(.+)$/)
      if (listItem) values.push(yamlScalar(listItem[1]))
    }
    break
  }
  return values.filter(Boolean)
}

function removeYamlFields(lines, fields) {
  const result = []
  let skipping = false
  for (const line of lines) {
    const topLevel = line.match(/^([^\s#][^:]*):/)
    if (topLevel) {
      skipping = fields.has(topLevel[1].trim())
      if (skipping) continue
    }
    if (!skipping) result.push(line)
  }
  return result
}

function removeObsidianLinkSyntax(line) {
  return line.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
}

function removeTocSection(body) {
  const lines = normalizeNewlines(body).split("\n")
  const result = []
  let skipping = false
  let removed = false
  for (const line of lines) {
    if (/^\s*■\s*目次一覧\s*$/.test(line)) {
      skipping = true
      removed = true
      continue
    }
    if (skipping && /^\s*■\s*\S/.test(line)) skipping = false
    if (!skipping) result.push(line)
  }
  return { body: result.join("\n"), removed }
}

function removeClassicIntro(body) {
  const lines = normalizeNewlines(body).split("\n")
  const rangeIndex = lines.findIndex((line) => /^\s*■\s*レンジ\s*$/.test(line))
  if (rangeIndex < 0) return { body, removed: false, missingRange: true }
  const removed = lines.slice(0, rangeIndex).some((line) => line.trim() !== "")
  return { body: lines.slice(rangeIndex).join("\n"), removed, missingRange: false }
}

function removeMarkdownSection(body, sectionTitle) {
  const lines = normalizeNewlines(body).split("\n")
  const result = []
  let skipping = false
  let skippedLevel = 0
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!skipping && heading && heading[2] === sectionTitle) {
      skipping = true
      skippedLevel = heading[1].length
      continue
    }
    if (skipping && heading && heading[1].length <= skippedLevel) skipping = false
    if (!skipping) result.push(line)
  }
  return result.join("\n")
}

function removeDataviewBlocks(body) {
  const lines = normalizeNewlines(body).split("\n")
  const result = []
  let skipping = false
  for (const line of lines) {
    if (!skipping && /^```dataview\s*$/i.test(line.trim())) {
      skipping = true
      continue
    }
    if (skipping && /^```\s*$/.test(line.trim())) {
      skipping = false
      continue
    }
    if (!skipping) result.push(line)
  }
  return result.join("\n")
}

function withTitle(body, title) {
  const trimmed = normalizeNewlines(body).trim()
  if (/^#\s+/.test(trimmed)) return `${trimmed}\n`
  if (!trimmed) return `# ${title}\n`
  return `# ${title}\n\n${trimmed}\n`
}

function yamlQuote(value) {
  return JSON.stringify(String(value))
}

function readIdMap(idMapPath) {
  if (!fs.existsSync(idMapPath)) return { version: 1, records: {} }
  const parsed = JSON.parse(fs.readFileSync(idMapPath, "utf8"))
  if (!parsed || parsed.version !== 1 || typeof parsed.records !== "object") {
    fail(`ID対応表の形式が不正です: ${idMapPath}`)
  }
  return parsed
}

function nextId(records, prefix) {
  let max = 0
  for (const value of Object.values(records)) {
    const match = String(value).match(new RegExp(`^${prefix}(\\d+)$`))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}${String(max + 1).padStart(6, "0")}`
}

function ensureId(idMap, relativePath, prefix) {
  if (idMap.records[relativePath]) return idMap.records[relativePath]
  const id = nextId(idMap.records, prefix)
  idMap.records[relativePath] = id
  return id
}

function writeUtf8(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, { encoding: "utf8" })
}

function formatFrontmatter(originalLines, title, opacId, internalDir) {
  const removedFields = new Set([
    "title",
    "ID",
    "OPAC_ID",
    "初版・底本の発行年",
    "内部区分",
    "AI生成",
  ])
  const retained = removeYamlFields(originalLines, removedFields)
    .map((line) => removeObsidianLinkSyntax(line).trimEnd())
    .filter((line, index, array) => !(line.trim() === "" && array[index - 1]?.trim() === ""))

  const result = [`title: ${yamlQuote(title)}`, `OPAC_ID: ${opacId}`]
  if (retained.length) result.push(...retained)
  result.push(`内部区分: ${yamlQuote(internalDir || ".")}`, "AI生成: true")
  return `---\n${result.join("\n").replace(/\n+$/g, "")}\n---`
}

function markdownTable(cells, columns = 3) {
  const lines = [
    `| ${Array(columns).fill("").join(" | ")} |`,
    `| ${Array(columns).fill("---").join(" | ")} |`,
  ]
  for (let index = 0; index < cells.length; index += columns) {
    const row = cells.slice(index, index + columns)
    while (row.length < columns) row.push("")
    lines.push(`| ${row.join(" | ")} |`)
  }
  return lines
}

function directFolder(relativePath, root) {
  if (!relativePath.startsWith(`${root}/`)) return null
  const remainder = relativePath.slice(root.length + 1)
  const slash = remainder.indexOf("/")
  return slash < 0 ? null : remainder.slice(0, slash)
}

function sortedFolders(folderCounts) {
  return [...folderCounts.keys()].sort((left, right) => {
    const leftKana = KANA_FOLDERS.indexOf(left)
    const rightKana = KANA_FOLDERS.indexOf(right)
    if (leftKana >= 0 && rightKana >= 0) return leftKana - rightKana
    if (leftKana >= 0) return -1
    if (rightKana >= 0) return 1
    return left.localeCompare(right, "ja")
  })
}

function folderLabel(folder) {
  return KANA_FOLDERS.includes(folder) ? `${folder}行` : folder
}

function normalizeNdcValue(value) {
  return String(value)
    .trim()
    .replace(/[０-９]/g, (character) => String(character.charCodeAt(0) - 0xfee0))
}

function ndcCodesFor(values) {
  const codes = []
  for (const value of values) {
    const normalized = normalizeNdcValue(value)
    const match = normalized.match(/^(\d{3})/)
    if (match && !codes.includes(match[1])) codes.push(match[1])
  }
  return codes
}

function ndcClassFor(codes) {
  for (const code of codes) {
    const ndcClass = NDC_CLASSES.find((item) => item.digit === code[0])
    if (ndcClass) return ndcClass
  }
  return null
}

function naturalCompare(left, right) {
  return left.localeCompare(right, "ja", { numeric: true, sensitivity: "base" })
}

function katakanaToHiragana(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
}

function normalizeReading(value) {
  return katakanaToHiragana(value)
    .replace(/^[\s　「」『』【】〔〕〈〉《》（）()［］\[\]｛｝{}・･、。…‥―—‐−〜～]+/u, "")
    .replace(/[\s　]+/g, " ")
    .trim()
}

function readingHeading(reading) {
  const normalized = normalizeReading(reading)
  if (!normalized) return null
  const initial = [...normalized][0]
  return KANA_BASE.get(initial) || initial
}

function readingParts(reading) {
  return normalizeReading(reading)
    .split(/[\s\u3000・･=＝.．/／]+/u)
    .filter(Boolean)
}

function isForeignStyleAuthorTitle(title) {
  return /^[ァ-ヿA-Za-zＡ-Ｚａ-ｚ]/u.test(String(title).trim())
}

function readingPlacement(record, row) {
  const reading = readingValue(record)
  if (!reading) return null

  const headings = new Set(KANA_HEADINGS[row])
  const normalized = normalizeReading(reading)
  if (record.type !== "author") {
    const heading = readingHeading(normalized)
    return headings.has(heading) ? { heading, sortKey: normalized } : null
  }

  const candidates = readingParts(normalized)
    .map((part) => ({ part, heading: readingHeading(part) }))
    .filter(({ heading }) => headings.has(heading))
  if (!candidates.length) return null

  const candidate = isForeignStyleAuthorTitle(record.title)
    ? candidates[candidates.length - 1]
    : candidates[0]
  return {
    heading: candidate.heading,
    sortKey: `${normalizeReading(candidate.part)} ${normalized}`,
  }
}

function directRowRecords(records, root, row) {
  const prefix = `${root}/${row}/`
  return records.filter((record) => {
    if (!record.relativePath.startsWith(prefix)) return false
    return !record.relativePath.slice(prefix.length).includes("/")
  })
}

function readingValue(record) {
  return record.type === "author" ? record.authorReading : record.titleReading
}

function compareByReading(left, right) {
  const byReading = naturalCompare(left.sortKey, right.sortKey)
  if (byReading !== 0) return byReading
  return naturalCompare(left.record.title, right.record.title)
}

function readingIndexEntry(record) {
  const target = record.relativePath.replace(/\.md$/i, "")
  if (record.type === "author") return `- [[${target}|${record.title}]]`
  const authorText = record.authors.length ? ` — ${record.authors.join("、")}` : ""
  return `- [[${target}|${record.title}]]${authorText}`
}

function makeReadingRowPage(root, row, records, stats) {
  const rowRecords = directRowRecords(records, root, row)
  if (!rowRecords.length) return null

  const headings = KANA_HEADINGS[row]
  const groups = new Map(headings.map((heading) => [heading, []]))
  const unconfirmed = []
  for (const record of rowRecords) {
    const reading = readingValue(record)
    const placement = readingPlacement(record, row)
    if (placement) {
      groups.get(placement.heading).push({ record, sortKey: placement.sortKey })
    } else {
      unconfirmed.push(record)
      if (reading) {
        stats.readingWarnings.push(
          `${record.relativePath}: 読み「${reading}」から${row}行の索引語を特定できません`,
        )
      }
    }
  }

  const confirmedCount = rowRecords.length - unconfirmed.length
  const itemLabel = root === AUTHOR_ROOT ? "名" : "冊"
  const readingLabel = root === AUTHOR_ROOT ? "ふりがな" : "書名読み"
  const title = `${root === AUTHOR_ROOT ? "著者" : "一般書籍"} ${folderLabel(row)}`
  const lines = [
    "---",
    `title: ${yamlQuote(title)}`,
    "cssclasses:",
    "  - puko-custom-folder-index",
    "---",
    "",
    `# ${title}`,
    "",
    `**${rowRecords.length}${itemLabel}**（読み確認済み ${confirmedCount}${itemLabel}・未確認 ${unconfirmed.length}${itemLabel}）`,
    "",
    `${readingLabel}を確認できたものを先頭のかな別に掲載し、空欄または行と一致しないものを末尾に掲載しています。`,
  ]

  for (const heading of headings) {
    const headingRecords = groups.get(heading).sort(compareByReading)
    if (!headingRecords.length) continue
    lines.push("", `## ${heading}　${headingRecords.length}${itemLabel}`, "")
    lines.push(...headingRecords.map(({ record }) => readingIndexEntry(record)))
  }

  if (unconfirmed.length) {
    unconfirmed.sort((left, right) => naturalCompare(left.title, right.title))
    lines.push("", `## 読み未確認　${unconfirmed.length}${itemLabel}`, "")
    lines.push(...unconfirmed.map(readingIndexEntry))
  }

  lines.push("")
  return { content: lines.join("\n"), confirmedCount, unconfirmedCount: unconfirmed.length }
}

function unicodeCompare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function seriesLocation(record) {
  if (!record.relativePath.startsWith(`${SERIES_ROOT}/`)) return null
  const parts = record.relativePath.split("/")
  if (parts.length < 4) return null
  return { row: parts[1], publisher: parts[2] }
}

function seriesDisplayTitle(record) {
  return path.posix.basename(record.relativePath, path.posix.extname(record.relativePath))
}

function publisherGroups(records) {
  const groups = new Map()
  for (const record of records) {
    const location = seriesLocation(record)
    if (!location) continue
    const rowGroups = groups.get(location.row) || new Map()
    const books = rowGroups.get(location.publisher) || []
    books.push(record)
    rowGroups.set(location.publisher, books)
    groups.set(location.row, rowGroups)
  }
  return groups
}

function publisherCells(row, rowGroups) {
  return [...rowGroups.entries()]
    .sort(([left], [right]) => unicodeCompare(left, right))
    .map(([publisher, books]) => {
      const target = `${SERIES_ROOT}/${row}/${publisher}/`
      return `[[${target}\\|${publisher}]]　${books.length}件`
    })
}

function makeSeriesRootPage(seriesBooks) {
  const groups = publisherGroups(seriesBooks)
  const lines = [
    "---",
    'title: "03 シリーズ・出版社順"',
    "cssclasses:",
    "  - puko-custom-folder-index",
    "---",
    "",
    "# 03 シリーズ・出版社順",
    "",
    `**${seriesBooks.length}件**`,
    "",
    "出版社を行別に掲載しています。出版社名から、その出版社のシリーズ所蔵一覧へ移動できます。",
  ]
  for (const row of sortedFolders(
    new Map([...groups].map(([name, values]) => [name, values.size])),
  )) {
    const rowGroups = groups.get(row)
    lines.push("", `## ${folderLabel(row)}`, "", ...markdownTable(publisherCells(row, rowGroups)))
  }
  lines.push("")
  return lines.join("\n")
}

function makeSeriesRowPage(row, rowGroups) {
  const bookCount = [...rowGroups.values()].reduce((sum, books) => sum + books.length, 0)
  const title = `${folderLabel(row)}の出版社`
  return [
    "---",
    `title: ${yamlQuote(title)}`,
    "cssclasses:",
    "  - puko-custom-folder-index",
    "---",
    "",
    `# ${title}`,
    "",
    `**${bookCount}件・${rowGroups.size}出版社**`,
    "",
    ...markdownTable(publisherCells(row, rowGroups)),
    "",
  ].join("\n")
}

function makePublisherPage(publisher, books) {
  const sortedBooks = [...books].sort((left, right) =>
    naturalCompare(seriesDisplayTitle(left), seriesDisplayTitle(right)),
  )
  const lines = [
    "---",
    `title: ${yamlQuote(publisher)}`,
    "cssclasses:",
    "  - puko-custom-folder-index",
    "---",
    "",
    `# ${publisher}`,
    "",
    `**${sortedBooks.length}件**`,
    "",
  ]
  for (const book of sortedBooks) {
    const target = book.relativePath.replace(/\.md$/i, "")
    lines.push(`- [[${target}|${seriesDisplayTitle(book)}]]`)
  }
  lines.push("")
  return lines.join("\n")
}

function makeRootSection(records, root) {
  const rootRecords = records.filter((record) => record.relativePath.startsWith(`${root}/`))
  if (!rootRecords.length) return []

  const folderCounts = new Map()
  for (const record of rootRecords) {
    const folder = directFolder(record.relativePath, root)
    if (folder) folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1)
  }

  const lines = ["", `### [[${root}/|${root}]]　${rootRecords.length}件`]
  const cells = sortedFolders(folderCounts).map((folder) => {
    const target = `${root}/${folder}/`
    return `[[${target}\\|${folderLabel(folder)}]]　${folderCounts.get(folder)}件`
  })
  if (cells.length) lines.push("", ...markdownTable(cells))
  return lines
}

function makeIndex(records) {
  const books = records.filter((record) => record.type === "book")
  const authors = records.filter((record) => record.type === "author")
  const classifiedBooks = books.filter((book) => book.ndcClass)
  const lines = [
    "---",
    'title: "ぷ庫OPAC"',
    "---",
    "",
    "# ぷ庫OPAC",
    "",
    "ここは個人図書館の蔵書検索用OPACです。",
    "目的：僕の資料検索（外出時・創作資料検索時）",
    "仕様：",
    "",
    "> ・書誌・分類・概要等はNotebookLMを用いて所蔵資料から作成しており、誤りを含む可能性があります。",
    ">",
    "> 　参考：NotebookLMによるデータ作成過程",
    ">",
    "> 　https://note.com/tempp/n/n427ab4ea2324",
    ">",
    "> ・出版年は手持ち蔵書の出版年で、増版の場合はその版の出版年を記載しています。",
    ">",
    "> ・雑誌は特殊なものが含まれるため、公開していません。",
    ">",
    "> ・書籍本文・図版は公開していません。",
    "",
    "現在の作業進捗状況：",
    "",
    "　2026/9/20　2818冊/10136冊（内1203冊は非公開雑誌）",
    "",
    "おまけ：",
    "",
    "小説wiki：https://tempp-kz.github.io/tempp/",
    "",
    "## 所蔵区分から探す",
  ]

  for (const root of PUBLIC_ROOTS) {
    const rootRecords = root === AUTHOR_ROOT ? authors : books
    lines.push(...makeRootSection(rootRecords, root))
  }

  lines.push(
    "",
    "## NDCから探す",
    "",
    "| 集計 | 冊数 |",
    "| --- | ---: |",
    `| 合計冊数 | ${books.length} |`,
    `| 分類済冊数 | ${classifiedBooks.length} |`,
  )
  for (const ndcClass of NDC_CLASSES) {
    const count = books.filter((book) =>
      book.ndcCodes.some((code) => code.startsWith(ndcClass.digit)),
    ).length
    lines.push(
      `| [[NDC/${ndcClass.code} ${ndcClass.label}\\|${ndcClass.code}]]　${ndcClass.label} | ${count} |`,
    )
  }
  lines.push("")
  return lines.join("\n")
}

function makeNdcPage(ndcClass, books) {
  const title = `NDC ${ndcClass.code} ${ndcClass.label}`
  const lines = [
    "---",
    `title: ${yamlQuote(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
    `公開書籍のうち、NDCの先頭1桁が「${ndcClass.digit}」のものを掲載しています。`,
    "",
    `**${books.length}件**`,
  ]

  const groups = new Map()
  for (const book of books) {
    for (const code of book.ndcCodes.filter((value) => value.startsWith(ndcClass.digit))) {
      const codeBooks = groups.get(code) || []
      codeBooks.push(book)
      groups.set(code, codeBooks)
    }
  }
  const codes = [...groups.keys()].sort((left, right) => Number(left) - Number(right))
  if (codes.length) {
    lines.push("", "## このページの分類", "")
    for (const code of codes) {
      const label = ndcLabel(code)
      const heading = `NDC: ${code}　${label}　${groups.get(code).length}件`
      lines.push(`- [[#${heading}|NDC: ${code}　${label}]]　${groups.get(code).length}件`)
    }
  }

  for (const code of codes) {
    const codeBooks = [...groups.get(code)].sort((left, right) =>
      naturalCompare(left.title, right.title),
    )
    const label = ndcLabel(code)
    lines.push("", `## NDC: ${code}　${label}　${codeBooks.length}件`, "")
    for (const book of codeBooks) {
      const target = book.relativePath.replace(/\.md$/i, "")
      const authorText = book.authors.length ? ` — ${book.authors.join("、")}` : ""
      lines.push(`- [[${target}|${book.title}]]${authorText}（NDC: ${code}）`)
    }
  }

  lines.push("")
  return lines.join("\n")
}

function transformBook(record, stats) {
  const { frontmatter, body } = splitFrontmatter(record.sourceText, record.sourcePath)
  let transformedBody = body
  if (record.relativePath.startsWith(`${CLASSICS_ROOT}/`)) {
    const classic = removeClassicIntro(transformedBody)
    transformedBody = classic.body
    if (classic.removed) stats.classicIntrosRemoved += 1
    if (classic.missingRange) stats.warnings.push(`■ レンジがない古典: ${record.relativePath}`)
  }
  const toc = removeTocSection(transformedBody)
  transformedBody = withTitle(toc.body, record.title)
  if (toc.removed) stats.tocsRemoved += 1

  const internalDir = path.posix.dirname(record.relativePath)
  return `${formatFrontmatter(frontmatter, record.title, record.opacId, internalDir)}\n\n${transformedBody}`
}

function transformAuthor(record, booksByAuthor) {
  const { frontmatter, body } = splitFrontmatter(record.sourceText, record.sourcePath)
  let transformedBody = removeDataviewBlocks(body)
  transformedBody = removeMarkdownSection(transformedBody, "著書一覧")
  transformedBody = transformedBody.replace(/^(ふりがな|生まれ年|国籍|属性):[ \t]+$/gm, "$1:")
  transformedBody = withTitle(transformedBody, record.title).trimEnd()
  const works = booksByAuthor.get(record.title) || []
  const workLines = works.length
    ? works.map((book) => `- [[${book.relativePath.replace(/\.md$/i, "")}|${book.title}]]`)
    : ["該当する公開書籍はありません。"]
  transformedBody += `\n\n##### 著書一覧\n\n${workLines.join("\n")}\n`

  const internalDir = path.posix.dirname(record.relativePath)
  return `${formatFrontmatter(frontmatter, record.title, record.opacId, internalDir)}\n\n${transformedBody}`
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function auditStage(records, stageRoot, idMap) {
  const issues = []
  const expectedPaths = records.map((record) => record.relativePath)
  const expectedSet = new Set(expectedPaths)
  const idMapPaths = Object.keys(idMap.records)

  if (idMapPaths.length !== records.length) {
    issues.push(`原典数とIDマップ数が一致しません: source=${records.length} idMap=${idMapPaths.length}`)
  }

  for (const relativePath of idMapPaths) {
    if (!expectedSet.has(relativePath)) {
      issues.push(`IDマップに現在の原典が存在しないパスがあります: ${relativePath}`)
    }
  }

  const seenIds = new Map()

  for (const record of records) {
    const mappedId = idMap.records[record.relativePath]

    if (mappedId !== record.opacId) {
      issues.push(
        `IDマップと生成レコードのOPAC_IDが一致しません: ${record.relativePath} map=${mappedId || "<none>"} record=${record.opacId}`,
      )
    }

    if (seenIds.has(record.opacId)) {
      issues.push(
        `OPAC_IDが重複しています: ${record.opacId} / ${seenIds.get(record.opacId)} / ${record.relativePath}`,
      )
    } else {
      seenIds.set(record.opacId, record.relativePath)
    }

    const publicPath = path.join(stageRoot, ...record.relativePath.split("/"))
    if (!fs.existsSync(publicPath)) {
      issues.push(`公開書誌レコードがありません: ${record.relativePath}`)
      continue
    }

    const publicText = fs.readFileSync(publicPath, "utf8")
    const publicParts = splitFrontmatter(publicText, publicPath)
    const sourceParts = splitFrontmatter(record.sourceText, record.sourcePath)

    const publicIds = getYamlValues(publicParts.frontmatter, "OPAC_ID")
    if (publicIds.length !== 1 || publicIds[0] !== record.opacId) {
      issues.push(
        `公開側OPAC_IDが不正です: ${record.relativePath} expected=${record.opacId} actual=${publicIds.join(",") || "<none>"}`,
      )
    }

    for (const key of ["関連キーワード", "固有名詞"]) {
      const sourceValues = getYamlValues(sourceParts.frontmatter, key)
      const publicValues = getYamlValues(publicParts.frontmatter, key)

      if (!sameValues(sourceValues, publicValues)) {
        issues.push(
          `${key}が原典と公開側で一致しません: ${record.relativePath}`,
        )
      }
    }

    if (record.type === "book") {
      const publicNdcCodes = ndcCodesFor(
        getYamlValues(publicParts.frontmatter, "NDC"),
      )

      if (!sameValues(record.ndcCodes, publicNdcCodes)) {
        issues.push(
          `NDC先頭3桁が原典と公開側で一致しません: ${record.relativePath} source=${record.ndcCodes.join(",")} public=${publicNdcCodes.join(",")}`,
        )
      }
    }

    for (const line of publicParts.frontmatter) {
      const keyMatch = line.match(/^([^\s#][^:]*):/)
      if (keyMatch && keyMatch[1].trim().startsWith("初版・底本")) {
        issues.push(
          `公開側に初版・底本項目が残っています: ${record.relativePath} / ${keyMatch[1].trim()}`,
        )
      }
    }

    if (
      normalizeNewlines(publicParts.body)
        .split("\n")
        .some((line) => /^\s*■\s*目次一覧\s*$/.test(line))
    ) {
      issues.push(`公開側に目次一覧が残っています: ${record.relativePath}`)
    }
  }

  let publicRecordCount = 0
  for (const stagedPath of listMarkdownFiles(stageRoot)) {
    const stagedText = fs.readFileSync(stagedPath, "utf8")
    const { frontmatter } = splitFrontmatter(stagedText, stagedPath)
    const ids = getYamlValues(frontmatter, "OPAC_ID")

    if (ids.length > 0) publicRecordCount += 1
  }

  if (publicRecordCount !== records.length) {
    issues.push(
      `公開書誌レコード数が原典数と一致しません: source=${records.length} public=${publicRecordCount}`,
    )
  }

  if (issues.length) {
    const limit = 50
    const shown = issues.slice(0, limit)
    const omitted =
      issues.length > limit
        ? `\n- ほか ${issues.length - limit}件`
        : ""

    fail(
      `ステージ監査に失敗しました（${issues.length}件）:\n- ${shown.join("\n- ")}${omitted}`,
    )
  }

  return {
    sourceCount: records.length,
    idMapCount: idMapPaths.length,
    publicRecordCount,
    uniqueIdCount: seenIds.size,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceRoot = path.resolve(args.source)
  const outputRoot = path.resolve(args.output)
  const idMapPath = path.resolve(args["id-map"])
  assertSafePaths(sourceRoot, outputRoot, idMapPath, Boolean(args.publish))

  const sourceFiles = []
  for (const publicRoot of PUBLIC_ROOTS) {
    const rootPath = path.join(sourceRoot, publicRoot)
    if (!fs.existsSync(rootPath)) continue
    sourceFiles.push(...listMarkdownFiles(rootPath))
  }
  sourceFiles.sort((a, b) =>
    normalizedRelative(sourceRoot, a).localeCompare(normalizedRelative(sourceRoot, b), "ja"),
  )
  if (!sourceFiles.length) fail("公開対象のmdが見つかりません")

  const beforeHashes = new Map(sourceFiles.map((file) => [file, sha256File(file)]))
  const idMap = readIdMap(idMapPath)
  const records = sourceFiles.map((sourcePath) => {
    const sourceText = fs.readFileSync(sourcePath, "utf8")
    const relativePath = normalizedRelative(sourceRoot, sourcePath)
    const { frontmatter } = splitFrontmatter(sourceText, sourcePath)
    const type = relativePath.startsWith(`${AUTHOR_ROOT}/`) ? "author" : "book"
    const title = path.basename(sourcePath, path.extname(sourcePath))
    const authors = type === "book" ? getYamlValues(frontmatter, "著者") : []
    const titleReading =
      type === "book"
        ? getYamlValues(frontmatter, "書名読み")[0] ||
          getYamlValues(frontmatter, "タイトル読み")[0] ||
          ""
        : ""
    const authorReading = type === "author" ? getYamlValues(frontmatter, "ふりがな")[0] || "" : ""
    const ndcValues = type === "book" ? getYamlValues(frontmatter, "NDC") : []
    const ndcCodes = type === "book" ? ndcCodesFor(ndcValues) : []
    const ndcClass = type === "book" ? ndcClassFor(ndcCodes) : null
    const opacId = ensureId(idMap, relativePath, type === "author" ? "A" : "B")
    return {
      sourcePath,
      sourceText,
      relativePath,
      type,
      title,
      titleReading,
      authorReading,
      authors,
      ndcValues,
      ndcCodes,
      ndcClass,
      opacId,
    }
  })

  records.sort((a, b) => a.title.localeCompare(b.title, "ja"))
  const booksByAuthor = new Map()
  for (const book of records.filter((record) => record.type === "book")) {
    for (const author of book.authors) {
      if (!booksByAuthor.has(author)) booksByAuthor.set(author, [])
      booksByAuthor.get(author).push(book)
    }
  }

  const parent = path.dirname(outputRoot)
  fs.mkdirSync(parent, { recursive: true })
  const stageRoot = path.join(parent, `.puko-staging-${process.pid}-${Date.now()}`)
  const backupRoot = path.join(parent, `.puko-backup-${process.pid}-${Date.now()}`)
  fs.mkdirSync(stageRoot, { recursive: false })

  const stats = {
    tocsRemoved: 0,
    classicIntrosRemoved: 0,
    warnings: [],
    readingWarnings: [],
    readingIndexPageCount: 0,
    bookReadingsConfirmed: 0,
    bookReadingsUnconfirmed: 0,
    authorReadingsConfirmed: 0,
    authorReadingsUnconfirmed: 0,
  }
  try {
    for (const record of records) {
      const transformed =
        record.type === "author"
          ? transformAuthor(record, booksByAuthor)
          : transformBook(record, stats)
      writeUtf8(path.join(stageRoot, ...record.relativePath.split("/")), transformed)
    }
    writeUtf8(path.join(stageRoot, "index.md"), makeIndex(records))
    const books = records.filter((record) => record.type === "book")
    const authors = records.filter((record) => record.type === "author")
    for (const row of KANA_FOLDERS) {
      const bookIndex = makeReadingRowPage(GENERAL_BOOK_ROOT, row, books, stats)
      if (bookIndex) {
        writeUtf8(path.join(stageRoot, GENERAL_BOOK_ROOT, row, "index.md"), bookIndex.content)
        stats.readingIndexPageCount += 1
        stats.bookReadingsConfirmed += bookIndex.confirmedCount
        stats.bookReadingsUnconfirmed += bookIndex.unconfirmedCount
      }

      const authorIndex = makeReadingRowPage(AUTHOR_ROOT, row, authors, stats)
      if (authorIndex) {
        writeUtf8(path.join(stageRoot, AUTHOR_ROOT, row, "index.md"), authorIndex.content)
        stats.readingIndexPageCount += 1
        stats.authorReadingsConfirmed += authorIndex.confirmedCount
        stats.authorReadingsUnconfirmed += authorIndex.unconfirmedCount
      }
    }

    let seriesIndexPageCount = 0
    const seriesBooks = books.filter((book) => book.relativePath.startsWith(`${SERIES_ROOT}/`))
    if (seriesBooks.length) {
      const groups = publisherGroups(seriesBooks)
      writeUtf8(path.join(stageRoot, SERIES_ROOT, "index.md"), makeSeriesRootPage(seriesBooks))
      seriesIndexPageCount += 1
      for (const [row, rowGroups] of groups) {
        writeUtf8(
          path.join(stageRoot, SERIES_ROOT, row, "index.md"),
          makeSeriesRowPage(row, rowGroups),
        )
        seriesIndexPageCount += 1
        for (const [publisher, publisherBooks] of rowGroups) {
          writeUtf8(
            path.join(stageRoot, SERIES_ROOT, row, publisher, "index.md"),
            makePublisherPage(publisher, publisherBooks),
          )
          seriesIndexPageCount += 1
        }
      }
    }
    for (const ndcClass of NDC_CLASSES) {
      const classBooks = books.filter((book) =>
        book.ndcCodes.some((code) => code.startsWith(ndcClass.digit)),
      )
      writeUtf8(
        path.join(stageRoot, "NDC", `${ndcClass.code} ${ndcClass.label}.md`),
        makeNdcPage(ndcClass, classBooks),
      )
    }
    stats.seriesIndexPageCount = seriesIndexPageCount

    const auditResult = auditStage(records, stageRoot, idMap)

    const changedSources = sourceFiles.filter(
      (file) => beforeHashes.get(file) !== sha256File(file),
    )
    if (changedSources.length) {
      fail(`変換元ファイルの変化を検出しました: ${changedSources.join(", ")}`)
    }

    console.log(
      `  ステージ監査: 原典 ${auditResult.sourceCount}件 / ID ${auditResult.idMapCount}件 / 公開書誌 ${auditResult.publicRecordCount}件 / 一意ID ${auditResult.uniqueIdCount}件`,
    )

    fs.mkdirSync(path.dirname(idMapPath), { recursive: true })
    writeUtf8(idMapPath, `${JSON.stringify(idMap, null, 2)}\n`)

    if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, backupRoot)
    try {
      fs.renameSync(stageRoot, outputRoot)
    } catch (error) {
      if (fs.existsSync(backupRoot)) fs.renameSync(backupRoot, outputRoot)
      throw error
    }
    if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true })
  } catch (error) {
    console.error(`BUILD_ORIGINAL_ERROR: ${error?.stack || error}`)
    if (fs.existsSync(stageRoot)) {
      try {
        fs.rmSync(stageRoot, { recursive: true, force: true })
      } catch (cleanupError) {
        console.error(`BUILD_CLEANUP_ERROR: ${cleanupError?.stack || cleanupError}`)
      }
    }
    throw error
  }

  const bookCount = records.filter((record) => record.type === "book").length
  const authorCount = records.filter((record) => record.type === "author").length
  const ndcClassifiedCount = records.filter(
    (record) => record.type === "book" && record.ndcClass,
  ).length
  console.log("ぷ庫OPAC用データを生成しました。")
  console.log(`  書籍: ${bookCount}件`)
  console.log(`  著者: ${authorCount}件`)
  console.log(`  NDC分類済: ${ndcClassifiedCount}件`)
  console.log(`  シリーズ索引: ${stats.seriesIndexPageCount || 0}件`)
  console.log(`  読み索引: ${stats.readingIndexPageCount}件`)
  console.log(
    `  一般書籍の書名読み: 確認済み ${stats.bookReadingsConfirmed}件 / 未確認 ${stats.bookReadingsUnconfirmed}件`,
  )
  console.log(
    `  著者ふりがな: 確認済み ${stats.authorReadingsConfirmed}件 / 未確認 ${stats.authorReadingsUnconfirmed}件`,
  )
  console.log(`  目次を除外: ${stats.tocsRemoved}件`)
  console.log(`  古典の冒頭説明を除外: ${stats.classicIntrosRemoved}件`)
  console.log(`  出力先: ${outputRoot}`)
  console.log("  変換元: ハッシュ照合済み（変更なし）")
  for (const warning of stats.warnings) console.warn(`警告: ${warning}`)
  for (const warning of stats.readingWarnings) console.warn(`読み警告: ${warning}`)
}

try {
  main()
} catch (error) {
  console.error(`エラー: ${error.message}`)
  process.exitCode = 1
}
