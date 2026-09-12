#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const PUBLIC_ROOTS = [
  "01 一般書籍",
  "03 シリーズ 出版社順",
  "05 古典 著者出生地分類",
  "07 外国語書籍",
  "11 著者",
]

const AUTHOR_ROOT = "11 著者"
const CLASSICS_ROOT = "05 古典 著者出生地分類"
const ALLOWED_OUTPUT_NAMES = new Set(["content-preview", "content"])

function fail(message) {
  throw new Error(message)
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
    fail("content を置き換える場合は --publish が必要です。試験時は content-preview を使ってください")
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
  return line
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
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
    "aliases",
    "title",
    "ID",
    "OPAC_ID",
    "初版・底本の発行年",
    "内部区分",
    "AI生成",
  ])
  const retained = removeYamlFields(originalLines, removedFields)
    .map(removeObsidianLinkSyntax)
    .filter((line, index, array) => !(line.trim() === "" && array[index - 1]?.trim() === ""))

  const result = [`title: ${yamlQuote(title)}`, `OPAC_ID: ${opacId}`]
  if (retained.length) result.push(...retained)
  result.push(`内部区分: ${yamlQuote(internalDir || ".")}`, "AI生成: true")
  return `---\n${result.join("\n").replace(/\n+$/g, "")}\n---`
}

function makeIndex(records) {
  const books = records.filter((record) => record.type === "book")
  const authors = records.filter((record) => record.type === "author")
  const lines = [
    "---",
    'title: "ぷ庫OPAC"',
    "---",
    "",
    "# ぷ庫OPAC",
    "",
    "個人図書館の蔵書検索用OPACです。",
    "",
    "> 書誌・分類・概要等はNotebookLMを用いて所蔵資料から作成しており、誤りを含む可能性があります。書籍本文・図版は公開していません。",
    "",
    "## 書籍",
  ]

  const roots = PUBLIC_ROOTS.filter(
    (root) => root !== AUTHOR_ROOT && books.some((book) => book.relativePath.startsWith(`${root}/`)),
  )
  for (const root of roots) {
    lines.push("", `### ${root}`)
    for (const book of books.filter((item) => item.relativePath.startsWith(`${root}/`))) {
      const target = book.relativePath.replace(/\.md$/i, "")
      const authorText = book.authors.length ? ` — ${book.authors.join("、")}` : ""
      lines.push(`- [[${target}|${book.title}]]${authorText}`)
    }
  }

  lines.push("", "## 著者")
  for (const author of authors) {
    const target = author.relativePath.replace(/\.md$/i, "")
    lines.push(`- [[${target}|${author.title}]]`)
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
  transformedBody = withTitle(transformedBody, record.title).trimEnd()
  const works = booksByAuthor.get(record.title) || []
  const workLines = works.length
    ? works.map((book) => `- [[${book.relativePath.replace(/\.md$/i, "")}|${book.title}]]`)
    : ["該当する公開書籍はありません。"]
  transformedBody += `\n\n##### 著書一覧\n\n${workLines.join("\n")}\n`

  const internalDir = path.posix.dirname(record.relativePath)
  return `${formatFrontmatter(frontmatter, record.title, record.opacId, internalDir)}\n\n${transformedBody}`
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
  sourceFiles.sort((a, b) => normalizedRelative(sourceRoot, a).localeCompare(normalizedRelative(sourceRoot, b), "ja"))
  if (!sourceFiles.length) fail("公開対象のmdが見つかりません")

  const beforeHashes = new Map(sourceFiles.map((file) => [file, sha256File(file)]))
  const idMap = readIdMap(idMapPath)
  const records = sourceFiles.map((sourcePath) => {
    const sourceText = fs.readFileSync(sourcePath, "utf8")
    const relativePath = normalizedRelative(sourceRoot, sourcePath)
    const { frontmatter } = splitFrontmatter(sourceText, sourcePath)
    const aliases = getYamlValues(frontmatter, "aliases")
    const type = relativePath.startsWith(`${AUTHOR_ROOT}/`) ? "author" : "book"
    const title = aliases[0] || path.basename(sourcePath, path.extname(sourcePath))
    const authors = type === "book" ? getYamlValues(frontmatter, "著者") : []
    const opacId = ensureId(idMap, relativePath, type === "author" ? "A" : "B")
    return { sourcePath, sourceText, relativePath, type, title, authors, opacId }
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

  const stats = { tocsRemoved: 0, classicIntrosRemoved: 0, warnings: [] }
  try {
    for (const record of records) {
      const transformed = record.type === "author"
        ? transformAuthor(record, booksByAuthor)
        : transformBook(record, stats)
      writeUtf8(path.join(stageRoot, ...record.relativePath.split("/")), transformed)
    }
    writeUtf8(path.join(stageRoot, "index.md"), makeIndex(records))

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
    if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true })
    throw error
  }

  const changedSources = sourceFiles.filter((file) => beforeHashes.get(file) !== sha256File(file))
  if (changedSources.length) {
    fail(`変換元ファイルの変化を検出しました: ${changedSources.join(", ")}`)
  }

  const bookCount = records.filter((record) => record.type === "book").length
  const authorCount = records.filter((record) => record.type === "author").length
  console.log("ぷ庫OPAC用データを生成しました。")
  console.log(`  書籍: ${bookCount}件`)
  console.log(`  著者: ${authorCount}件`)
  console.log(`  目次を除外: ${stats.tocsRemoved}件`)
  console.log(`  古典の冒頭説明を除外: ${stats.classicIntrosRemoved}件`)
  console.log(`  出力先: ${outputRoot}`)
  console.log("  変換元: ハッシュ照合済み（変更なし）")
  for (const warning of stats.warnings) console.warn(`警告: ${warning}`)
}

try {
  main()
} catch (error) {
  console.error(`エラー: ${error.message}`)
  process.exitCode = 1
}
