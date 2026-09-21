import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const [sourceRoot, contentRoot, baselinePath] = process.argv.slice(2)

const PUBLIC_ROOTS = [
  "01 一般書籍",
  "03 シリーズ 出版社順",
  "05 古典 著者出生地分類",
  "07 外国語書籍",
  "11 著者",
]

const GENERAL_ROOT = "01 一般書籍"
const SERIES_ROOT = "03 シリーズ 出版社順"
const AUTHOR_ROOT = "11 著者"
const KANA_ROWS = new Set(["あ","か","さ","た","な","は","ま","や","ら","わ","数字・英語"])

const NDC_CLASSES = new Map([
  ["0", "000 総記（雑誌除）"],
  ["1", "100 哲学"],
  ["2", "200 歴史"],
  ["3", "300 社会科学"],
  ["4", "400 自然科学"],
  ["5", "500 技術・工学"],
  ["6", "600 産業"],
  ["7", "700 芸術・美術"],
  ["8", "800 言語"],
  ["9", "900 文学"],
])

function fail(message) {
  throw new Error(message)
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function listMd(root) {
  const out = []
  if (!fs.existsSync(root)) return out

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full)
    }
  }

  visit(root)
  return out
}

function splitFrontmatter(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (lines[0]?.trim() !== "---") return []
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
  if (end < 0) return []
  return lines.slice(1, end)
}

function yamlScalar(value) {
  let s = value.trim()

  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1)
  }

  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1")
  return s.trim()
}

function yamlValues(lines, key) {
  const result = []
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^${escaped}:\\s*(.*)$`)

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue

    if (m[1].trim()) result.push(yamlScalar(m[1]))

    for (let j = i + 1; j < lines.length; j++) {
      if (/^[^\s#][^:]*:/.test(lines[j])) break
      const item = lines[j].match(/^\s*-\s*(.+)$/)
      if (item) result.push(yamlScalar(item[1]))
    }
    break
  }

  return result.filter(Boolean)
}

function ndcCodes(values) {
  const out = []
  for (const value of values) {
    const normalized = String(value)
      .trim()
      .replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xfee0))
    const m = normalized.match(/^(\d{3})/)
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

function rootOf(relativePath) {
  return PUBLIC_ROOTS.find(root => relativePath.startsWith(`${root}/`)) ?? null
}

function folderOf(relativePath) {
  const root = rootOf(relativePath)
  if (!root) return null
  const rest = relativePath.slice(root.length + 1)
  const slash = rest.indexOf("/")
  return slash < 0 ? null : rest.slice(0, slash)
}

function metaFromText(relativePath, text) {
  const fm = splitFrontmatter(text)
  const type = relativePath.startsWith(`${AUTHOR_ROOT}/`) ? "author" : "book"

  return {
    relativePath,
    type,
    root: rootOf(relativePath),
    folder: folderOf(relativePath),
    title: path.posix.basename(relativePath, path.posix.extname(relativePath)),
    authors: type === "book" ? yamlValues(fm, "著者") : [],
    titleReading:
      type === "book"
        ? yamlValues(fm, "書名読み")[0] ||
          yamlValues(fm, "タイトル読み")[0] ||
          ""
        : "",
    authorReading:
      type === "author"
        ? yamlValues(fm, "ふりがな")[0] || ""
        : "",
    ndcCodes:
      type === "book"
        ? ndcCodes(yamlValues(fm, "NDC"))
        : [],
  }
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameSet(a, b) {
  const aa = [...new Set(a)].sort()
  const bb = [...new Set(b)].sort()
  return sameArray(aa, bb)
}

function ndcDigits(meta) {
  return [...new Set(meta?.ndcCodes.map(code => code[0]) ?? [])].sort()
}

function indexPath(meta) {
  if (!meta) return null
  if (meta.root !== GENERAL_ROOT && meta.root !== AUTHOR_ROOT) return null
  if (!KANA_ROWS.has(meta.folder)) return null

  const parts = meta.relativePath.split("/")
  if (parts.length !== 3) return null

  return `${meta.root}/${meta.folder}/index.md`
}

function seriesLocation(meta) {
  if (!meta || meta.root !== SERIES_ROOT) return null
  const p = meta.relativePath.split("/")
  if (p.length < 4) return null
  return {
    row: p[1],
    publisher: p[2],
  }
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))

if (!baseline || baseline.version !== 1 || !Array.isArray(baseline.records)) {
  fail("baseline形式が不正です")
}

const previous = new Map(
  baseline.records.map(record => [record.relativePath, record])
)

const current = new Map()

for (const root of PUBLIC_ROOTS) {
  const dir = path.join(sourceRoot, root)

  for (const file of listMd(dir)) {
    const relativePath = rel(sourceRoot, file)
    const text = fs.readFileSync(file, "utf8")

    current.set(relativePath, {
      relativePath,
      sha256: sha256(file),
      meta: metaFromText(relativePath, text),
    })
  }
}

const newPaths = [...current.keys()]
  .filter(p => !previous.has(p))
  .sort()

const missingPaths = [...previous.keys()]
  .filter(p => !current.has(p))
  .sort()

const changedPaths = [...current.keys()]
  .filter(p => previous.has(p) && previous.get(p).sha256 !== current.get(p).sha256)
  .sort()

const missingByHash = new Map()
const newByHash = new Map()

for (const p of missingPaths) {
  const h = previous.get(p).sha256
  if (!missingByHash.has(h)) missingByHash.set(h, [])
  missingByHash.get(h).push(p)
}

for (const p of newPaths) {
  const h = current.get(p).sha256
  if (!newByHash.has(h)) newByHash.set(h, [])
  newByHash.get(h).push(p)
}

const renames = []
const ambiguous = []
const matchedOld = new Set()
const matchedNew = new Set()

for (const [hash, oldList] of missingByHash) {
  const newList = newByHash.get(hash)
  if (!newList) continue

  if (oldList.length === 1 && newList.length === 1) {
    renames.push({
      from: oldList[0],
      to: newList[0],
      sha256: hash,
    })
  } else {
    ambiguous.push({ hash, oldList, newList })
  }

  oldList.forEach(p => matchedOld.add(p))
  newList.forEach(p => matchedNew.add(p))
}

const actualNew = newPaths.filter(p => !matchedNew.has(p))
const deletions = missingPaths.filter(p => !matchedOld.has(p))

const currentAuthors = new Map()
for (const { meta } of current.values()) {
  if (meta.type === "author") {
    currentAuthors.set(meta.title, meta.relativePath)
  }
}

const oldAuthors = new Map()
for (const record of baseline.records) {
  if (record.relativePath.startsWith(`${AUTHOR_ROOT}/`)) {
    const title = path.posix.basename(
      record.relativePath,
      path.posix.extname(record.relativePath)
    )
    oldAuthors.set(title, record.relativePath)
  }
}

const writeTargets = new Set()
const deleteTargets = new Set()
const warnings = []
let fullBuildRecommended = false

function addTarget(p) {
  if (p) writeTargets.add(p)
}

function addAuthorTargets(names) {
  for (const name of new Set(names)) {
    const p = currentAuthors.get(name) ?? oldAuthors.get(name)
    if (p) {
      addTarget(p)
    } else {
      warnings.push(`著者ファイルを特定できません: ${name}`)
    }
  }
}

function addNdcTargets(meta) {
  for (const digit of ndcDigits(meta)) {
    const label = NDC_CLASSES.get(digit)
    if (label) addTarget(`NDC/${label}.md`)
  }
}

function currentSeriesRecords() {
  return [...current.values()]
    .map(item => item.meta)
    .filter(meta => meta.root === SERIES_ROOT)
}

function targetSeriesRoot() {
  const target = `${SERIES_ROOT}/index.md`
  const existsNow = currentSeriesRecords().length > 0

  if (existsNow) {
    addTarget(target)
    deleteTargets.delete(target)
  } else {
    writeTargets.delete(target)
    deleteTargets.add(target)
  }
}

function targetSeriesRow(row) {
  const target = `${SERIES_ROOT}/${row}/index.md`

  const existsNow = currentSeriesRecords()
    .some(meta => {
      const loc = seriesLocation(meta)
      return loc && loc.row === row
    })

  if (existsNow) {
    addTarget(target)
    deleteTargets.delete(target)
  } else {
    writeTargets.delete(target)
    deleteTargets.add(target)
  }
}

function targetSeriesPublisher(row, publisher) {
  const target = `${SERIES_ROOT}/${row}/${publisher}/index.md`

  const existsNow = currentSeriesRecords()
    .some(meta => {
      const loc = seriesLocation(meta)
      return (
        loc &&
        loc.row === row &&
        loc.publisher === publisher
      )
    })

  if (existsNow) {
    addTarget(target)
    deleteTargets.delete(target)
  } else {
    writeTargets.delete(target)
    deleteTargets.add(target)
  }
}

function addSeriesTargetsForNew(meta) {
  const loc = seriesLocation(meta)
  if (!loc) return

  targetSeriesRoot()
  targetSeriesRow(loc.row)
  targetSeriesPublisher(loc.row, loc.publisher)
}

function addSeriesTargetsForMove(oldMeta, newMeta) {
  const oldLoc = seriesLocation(oldMeta)
  const newLoc = seriesLocation(newMeta)

  if (!oldLoc && !newLoc) return

  if (!oldLoc || !newLoc) {
    targetSeriesRoot()

    if (oldLoc) {
      targetSeriesRow(oldLoc.row)
      targetSeriesPublisher(oldLoc.row, oldLoc.publisher)
    }

    if (newLoc) {
      targetSeriesRow(newLoc.row)
      targetSeriesPublisher(newLoc.row, newLoc.publisher)
    }

    return
  }

  targetSeriesPublisher(oldLoc.row, oldLoc.publisher)
  targetSeriesPublisher(newLoc.row, newLoc.publisher)

  if (
    oldLoc.row !== newLoc.row ||
    oldLoc.publisher !== newLoc.publisher
  ) {
    targetSeriesRoot()
    targetSeriesRow(oldLoc.row)
    targetSeriesRow(newLoc.row)
  }
}

function readOldMeta(relativePath) {
  const file = path.join(contentRoot, ...relativePath.split("/"))

  if (!fs.existsSync(file)) {
    warnings.push(`旧公開ファイルがありません: ${relativePath}`)
    fullBuildRecommended = true
    return null
  }

  return metaFromText(
    relativePath,
    fs.readFileSync(file, "utf8")
  )
}

function planChange(oldMeta, newMeta, kind) {
  if (newMeta) addTarget(newMeta.relativePath)

  const pathChanged =
    oldMeta && newMeta &&
    oldMeta.relativePath !== newMeta.relativePath

  const titleChanged =
    oldMeta && newMeta &&
    oldMeta.title !== newMeta.title

  const authorsChanged =
    oldMeta && newMeta &&
    !sameSet(oldMeta.authors, newMeta.authors)

  const ndcChanged =
    oldMeta && newMeta &&
    !sameSet(oldMeta.ndcCodes, newMeta.ndcCodes)

  const titleReadingChanged =
    oldMeta && newMeta &&
    oldMeta.titleReading !== newMeta.titleReading

  const authorReadingChanged =
    oldMeta && newMeta &&
    oldMeta.authorReading !== newMeta.authorReading

  if (kind === "new") {
    addTarget("index.md")

    if (newMeta.type === "book") {
      addAuthorTargets(newMeta.authors)
      addNdcTargets(newMeta)

      const idx = indexPath(newMeta)
      if (idx) addTarget(idx)

      addSeriesTargetsForNew(newMeta)
    } else {
      const idx = indexPath(newMeta)
      if (idx) addTarget(idx)
    }

    return
  }

  if (!oldMeta || !newMeta) return

  if (pathChanged) {
    deleteTargets.add(oldMeta.relativePath)

    if (
      oldMeta.root !== newMeta.root ||
      oldMeta.folder !== newMeta.folder
    ) {
      addTarget("index.md")
    }
  }

  if (newMeta.type === "book") {
    if (authorsChanged || pathChanged || titleChanged) {
      addAuthorTargets([
        ...oldMeta.authors,
        ...newMeta.authors,
      ])
    }

    if (
      ndcChanged ||
      authorsChanged ||
      pathChanged ||
      titleChanged
    ) {
      addNdcTargets(oldMeta)
      addNdcTargets(newMeta)
    }

    const oldIndex = indexPath(oldMeta)
    const newIndex = indexPath(newMeta)

    if (
      titleReadingChanged ||
      authorsChanged ||
      pathChanged ||
      titleChanged
    ) {
      addTarget(oldIndex)
      addTarget(newIndex)
    }

    if (
      !sameSet(ndcDigits(oldMeta), ndcDigits(newMeta))
    ) {
      addTarget("index.md")
    }

    if (pathChanged || titleChanged) {
      addSeriesTargetsForMove(oldMeta, newMeta)
    }
  } else {
    if (
      authorReadingChanged ||
      pathChanged ||
      titleChanged
    ) {
      addTarget(indexPath(oldMeta))
      addTarget(indexPath(newMeta))
    }
  }
}

for (const p of changedPaths) {
  const oldMeta = readOldMeta(p)
  const newMeta = current.get(p).meta
  planChange(oldMeta, newMeta, "change")
}

for (const p of actualNew) {
  planChange(null, current.get(p).meta, "new")
}

for (const item of renames) {
  const oldMeta = readOldMeta(item.from)
  const newMeta = current.get(item.to).meta
  planChange(oldMeta, newMeta, "rename")
}

console.log("=== IMPACT PLANNER ===")
console.log(`CURRENT_SOURCE=${current.size}`)
console.log(`BASELINE=${previous.size}`)
console.log("")
console.log(`CHANGED_SAME_PATH=${changedPaths.length}`)
console.log(`NEW_SOURCES=${actualNew.length}`)
console.log(`RENAME_MOVE_CANDIDATES=${renames.length}`)
console.log(`DELETION_CANDIDATES=${deletions.length}`)
console.log(`AMBIGUOUS_HASH_GROUPS=${ambiguous.length}`)
console.log("")

if (changedPaths.length) {
  console.log("=== CHANGED ===")
  for (const p of changedPaths) console.log(`CHANGED: ${p}`)
  console.log("")
}

if (actualNew.length) {
  console.log("=== NEW ===")
  for (const p of actualNew) console.log(`NEW: ${p}`)
  console.log("")
}

if (renames.length) {
  console.log("=== RENAME / MOVE ===")
  for (const r of renames) {
    console.log(`FROM: ${r.from}`)
    console.log(`TO:   ${r.to}`)
  }
  console.log("")
}

if (deletions.length) {
  console.log("=== DELETION CANDIDATES ===")
  for (const p of deletions) console.log(`MISSING: ${p}`)
  console.log("")
}

if (ambiguous.length) {
  console.log("=== AMBIGUOUS ===")
  for (const a of ambiguous) {
    console.log(`SHA256=${a.hash}`)
    for (const p of a.oldList) console.log(`OLD: ${p}`)
    for (const p of a.newList) console.log(`NEW: ${p}`)
  }
  console.log("")
}

console.log(`WRITE_TARGETS=${writeTargets.size}`)
for (const p of [...writeTargets].sort()) {
  console.log(`WRITE: ${p}`)
}

console.log("")
console.log(`DELETE_TARGETS=${deleteTargets.size}`)
for (const p of [...deleteTargets].sort()) {
  console.log(`DELETE: ${p}`)
}

console.log("")
console.log(`WARNINGS=${warnings.length}`)
for (const w of warnings) console.log(`WARNING: ${w}`)

console.log("")
console.log(`FULL_BUILD_RECOMMENDED=${fullBuildRecommended}`)
console.log(
  `PLAN_STATUS=${
    ambiguous.length
      ? "STOP_AMBIGUOUS"
      : deletions.length
        ? "STOP_DELETION"
        : fullBuildRecommended
          ? "FULL_BUILD"
          : "DIFF_PLAN_OK"
  }`
)