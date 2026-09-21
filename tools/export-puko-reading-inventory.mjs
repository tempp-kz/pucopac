#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const PUBLIC_BOOK_ROOTS = [
  "01 一般書籍",
  "03 シリーズ 出版社順",
  "05 古典 著者出生地分類",
  "07 外国語書籍",
]
const AUTHOR_ROOT = "11 著者"

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) fail(`不明な引数です: ${token}`)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) fail(`${token} の値がありません`)
    args[key] = value
    index += 1
  }
  if (!args.source) fail("--source を指定してください")
  if (!args.output) fail("--output を指定してください")
  return args
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n")
}

function normalizedRelative(from, to) {
  return path.relative(from, to).split(path.sep).join("/")
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

function listMarkdownFiles(root) {
  const files = []
  if (!fs.existsSync(root)) return files
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

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function splitFrontmatter(text, filePath) {
  const lines = normalizeNewlines(text).split("\n")
  if (lines[0]?.trim() !== "---") return []
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end < 0) fail(`frontmatter の終端 --- がありません: ${filePath}`)
  return lines.slice(1, end)
}

function yamlScalar(value) {
  let result = String(value).trim()
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
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern)
    if (!match) continue
    if (match[1].trim()) values.push(yamlScalar(match[1]))
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      if (/^[^\s#][^:]*:/.test(lines[nested])) break
      const listItem = lines[nested].match(/^\s*-\s*(.+)$/)
      if (listItem) values.push(yamlScalar(listItem[1]))
    }
    break
  }
  return values.filter(Boolean)
}

function firstYamlValue(lines, keys) {
  for (const key of keys) {
    const values = getYamlValues(lines, key)
    if (values.length) return values[0]
  }
  return ""
}

function allYamlValues(lines, keys) {
  const values = []
  for (const key of keys) values.push(...getYamlValues(lines, key))
  return [...new Set(values)]
}

function normalizeIsbn(value) {
  const normalized = String(value).toUpperCase().replace(/[^0-9X]/g, "")
  return /^(?:\d{9}[0-9X]|\d{13})$/.test(normalized) ? normalized : ""
}

function titleFor(frontmatter, sourcePath) {
  return (
    firstYamlValue(frontmatter, ["aliases", "title"]) ||
    path.basename(sourcePath, path.extname(sourcePath))
  )
}

function makeBook(sourceRoot, sourcePath) {
  const sourceText = fs.readFileSync(sourcePath, "utf8")
  const frontmatter = splitFrontmatter(sourceText, sourcePath)
  const rawIsbns = allYamlValues(frontmatter, ["ISBN", "ISBN-10", "ISBN-13", "isbn"])
  const isbns = [...new Set(rawIsbns.map(normalizeIsbn).filter(Boolean))]
  return {
    relativePath: normalizedRelative(sourceRoot, sourcePath),
    sha256: sha256(sourceText),
    title: titleFor(frontmatter, sourcePath),
    titleReading: firstYamlValue(frontmatter, ["書名読み", "タイトル読み"]),
    authors: getYamlValues(frontmatter, "著者"),
    publishers: getYamlValues(frontmatter, "出版社"),
    series: getYamlValues(frontmatter, "シリーズ"),
    labels: getYamlValues(frontmatter, "レーベル名"),
    publicationYear: firstYamlValue(frontmatter, ["出版年"]),
    firstEditionYear: firstYamlValue(frontmatter, ["初版・底本の発行年"]),
    isbns,
  }
}

function makeAuthor(sourceRoot, sourcePath) {
  const sourceText = fs.readFileSync(sourcePath, "utf8")
  const frontmatter = splitFrontmatter(sourceText, sourcePath)
  return {
    relativePath: normalizedRelative(sourceRoot, sourcePath),
    sha256: sha256(sourceText),
    name: titleFor(frontmatter, sourcePath),
    reading: firstYamlValue(frontmatter, ["ふりがな"]),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceRoot = path.resolve(args.source)
  const outputFile = path.resolve(args.output)

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    fail(`変換元フォルダが存在しません: ${sourceRoot}`)
  }
  if (isSameOrInside(outputFile, sourceRoot)) {
    fail("書誌一覧の出力先を原典フォルダの外にしてください")
  }

  const bookFiles = PUBLIC_BOOK_ROOTS.flatMap((root) =>
    listMarkdownFiles(path.join(sourceRoot, root)),
  ).sort((left, right) => normalizedRelative(sourceRoot, left).localeCompare(
    normalizedRelative(sourceRoot, right),
    "ja",
  ))
  const authorFiles = listMarkdownFiles(path.join(sourceRoot, AUTHOR_ROOT)).sort((left, right) =>
    normalizedRelative(sourceRoot, left).localeCompare(normalizedRelative(sourceRoot, right), "ja"),
  )

  const books = bookFiles.map((sourcePath) => makeBook(sourceRoot, sourcePath))
  const authors = authorFiles.map((sourcePath) => makeAuthor(sourceRoot, sourcePath))
  const inventory = {
    version: 1,
    generatedAt: new Date().toISOString(),
    publicBookRoots: PUBLIC_BOOK_ROOTS,
    authorRoot: AUTHOR_ROOT,
    counts: {
      books: books.length,
      booksWithoutTitleReading: books.filter((book) => !book.titleReading).length,
      authors: authors.length,
      authorsWithoutReading: authors.filter((author) => !author.reading).length,
    },
    books,
    authors,
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, `${JSON.stringify(inventory, null, 2)}\n`, "utf8")

  console.log("読み照合用の書誌一覧を作成しました。原典は変更していません。")
  console.log(`  書籍: ${inventory.counts.books}件`)
  console.log(`  書名読みが空欄: ${inventory.counts.booksWithoutTitleReading}件`)
  console.log(`  著者: ${inventory.counts.authors}件`)
  console.log(`  著者ふりがなが空欄: ${inventory.counts.authorsWithoutReading}件`)
  console.log(`  出力先: ${outputFile}`)
}

main()
