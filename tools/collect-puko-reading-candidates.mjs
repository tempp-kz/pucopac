#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_BATCH_SIZE = 10
const DEFAULT_DAILY_LIMIT = 50
const DEFAULT_DELAY_MS = 30_000
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_URL_LENGTH = 7_000
const MAX_RECORDS = 200

class StopCollectionError extends Error {
  constructor(message) {
    super(message)
    this.name = "StopCollectionError"
  }
}

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) fail(`不明な引数です: ${token}`)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) fail(`${token} の値がありません`)
    result[key] = value
    index += 1
  }
  for (const required of ["inventory", "output", "cache", "state"]) {
    if (!result[required]) fail(`--${required} を指定してください`)
  }
  const numberArg = (name, fallback, minimum) => {
    const value = Number.parseInt(result[name] || `${fallback}`, 10)
    if (!Number.isFinite(value) || value < minimum) fail(`--${name} の値が不正です`)
    return value
  }
  return {
    inventory: path.resolve(result.inventory),
    output: path.resolve(result.output),
    cache: path.resolve(result.cache),
    state: path.resolve(result.state),
    execute: result.execute === "true",
    batchSize: numberArg("batch-size", DEFAULT_BATCH_SIZE, 1),
    dailyLimit: numberArg("daily-request-limit", DEFAULT_DAILY_LIMIT, 1),
    delayMs: numberArg("delay-ms", DEFAULT_DELAY_MS, 30_000),
    offlineResponse: result["offline-response"] ? path.resolve(result["offline-response"]) : "",
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function unique(values) {
  return [
    ...new Set(values.filter((value) => value !== undefined && value !== null && value !== "")),
  ]
}

function compactText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[!-/:-@[-`{-~「」『』【】〔〕〈〉《》“”‘’・･、。…‥―—‐−〜～]/g, "")
}

function compactTitle(value) {
  return compactText(value)
}

function mainTitle(value) {
  return String(value ?? "").split(/\s+(?::|：)\s+/, 1)[0]
}

function compactAuthor(value) {
  return compactText(value)
    .replace(/\d{3,4}(?:-\d{0,4})?/g, "")
    .replace(/(?:編著|共著|著|編|訳|監修|校注|注釈|解説|述|撰|選|原作|文|絵)+$/g, "")
}

function compactPublisher(value) {
  return compactText(value).replace(/株式会社|有限会社/g, "")
}

function sameBibliographicIdentity(book, result) {
  const sameList = (left, right, normalizer) =>
    JSON.stringify((left || []).map(normalizer)) === JSON.stringify((right || []).map(normalizer))
  const sourceSeries = [...(book.series || []), ...(book.labels || [])]
  const resultSeries = [...(result.series || []), ...(result.labels || [])]
  return (
    compactTitle(book.title) === compactTitle(result.title) &&
    sameList(book.authors, result.authors, compactAuthor) &&
    sameList(book.publishers, result.publishers, compactPublisher) &&
    String(book.publicationYear || "") === String(result.publicationYear || "") &&
    String(book.firstEditionYear || "") === String(result.firstEditionYear || "") &&
    sameList(sourceSeries, resultSeries, compactText)
  )
}

function yearValue(value) {
  const match = String(value ?? "").match(/(?:18|19|20)\d{2}/)
  return match ? Number.parseInt(match[0], 10) : null
}

function katakanaToHiragana(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
}

function cleanTitleReading(value) {
  return katakanaToHiragana(value)
    .replace(/[\s　]+/g, " ")
    .trim()
}

function cleanAuthorReading(value) {
  return katakanaToHiragana(value)
    .replace(/[,，、]\s*(?:18|19|20)\d{2}(?:-(?:18|19|20)?\d{0,4})?\s*$/g, "")
    .replace(/(?:18|19|20)\d{2}(?:-(?:18|19|20)?\d{0,4})?\s*$/g, "")
    .replace(/[,，、]/g, " ")
    .replace(/[\s　]+/g, " ")
    .trim()
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&amp;/g, "&")
}

function stripMarkup(value) {
  return decodeXml(String(value ?? "").replace(/<[^>]+>/g, "")).trim()
}

function tagFragments(fragment, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "g")
  return [...fragment.matchAll(pattern)].map((match) => match[1])
}

function xmlValues(fragment, tagName) {
  return tagFragments(fragment, tagName).map(stripMarkup).filter(Boolean)
}

function firstXmlValue(fragment, tagName) {
  return xmlValues(fragment, tagName)[0] || ""
}

function firstAttribute(fragment, tagName, attributeName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedAttribute = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = fragment.match(
    new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttribute}="([^"]+)"[^>]*>`, "i"),
  )
  return match ? decodeXml(match[1]).trim() : ""
}

function parseNdlOpenSearch(xml) {
  const items = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const fragment = match[1]
    const identifierMatch = fragment.match(
      /<dc:identifier[^>]*xsi:type="dcndl:NDLBibID"[^>]*>([\s\S]*?)<\/dc:identifier>/,
    )
    items.push({
      source: "NDL",
      sourceUrl: firstXmlValue(fragment, "link"),
      identifier: identifierMatch ? decodeXml(identifierMatch[1]).trim() : "",
      title: firstXmlValue(fragment, "dc:title") || firstXmlValue(fragment, "title"),
      titleReading: firstXmlValue(fragment, "dcndl:titleTranscription"),
      creators: xmlValues(fragment, "dc:creator"),
      creatorReadings: xmlValues(fragment, "dcndl:creatorTranscription"),
      publishers: xmlValues(fragment, "dc:publisher"),
      dates: unique([...xmlValues(fragment, "dc:date"), ...xmlValues(fragment, "dcterms:issued")]),
      series: xmlValues(fragment, "dcndl:seriesTitle"),
    })
  }
  const totalMatch = xml.match(/<openSearch:totalResults>(\d+)<\/openSearch:totalResults>/)
  return { totalResults: totalMatch ? Number.parseInt(totalMatch[1], 10) : items.length, items }
}

function parseNdlSru(xml) {
  const diagnostic = firstXmlValue(xml, "diag:message") || firstXmlValue(xml, "message")
  if (/Too Many Requests|同時アクセス数の上限|リクエストの制限/u.test(xml)) {
    throw new StopCollectionError("NDL側のアクセス制限を検出したため、再試行せず停止しました")
  }
  if (/^Record does not exist$/iu.test(diagnostic.trim())) {
    return { totalResults: 0, items: [] }
  }
  if (diagnostic) fail(`NDL SRU診断: ${diagnostic}`)
  const totalMatch = xml.match(/<(?:\w+:)?numberOfRecords>(\d+)<\/(?:\w+:)?numberOfRecords>/)
  const totalResults = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0
  const items = []
  for (const recordData of tagFragments(xml, "recordData")) {
    const decoded = decodeXml(recordData)
    const bibMatch = decoded.match(/<dcndl:BibResource\b[^>]*>[\s\S]*?<\/dcndl:BibResource>/)
    if (!bibMatch) continue
    const bib = bibMatch[0]
    const titleBlock = tagFragments(bib, "dc:title")[0] || ""
    const title = firstXmlValue(titleBlock, "rdf:value") || firstXmlValue(bib, "dcterms:title")
    const titleReading = firstXmlValue(titleBlock, "dcndl:transcription")
    const creators = []
    const creatorReadings = []
    for (const creatorBlock of tagFragments(bib, "dcterms:creator")) {
      const name = firstXmlValue(creatorBlock, "foaf:name")
      if (!name) continue
      creators.push(name)
      creatorReadings.push(firstXmlValue(creatorBlock, "dcndl:transcription"))
    }
    if (!creators.length) creators.push(...xmlValues(bib, "dc:creator"))
    const publishers = tagFragments(bib, "dcterms:publisher")
      .map((publisherBlock) => firstXmlValue(publisherBlock, "foaf:name"))
      .filter(Boolean)
    const identifierMatch = bib.match(
      /<dcterms:identifier[^>]*NDLBibID[^>]*>([\s\S]*?)<\/dcterms:identifier>/,
    )
    const sourceUrl = firstAttribute(bib, "dcndl:BibResource", "rdf:about").replace(
      /#material$/,
      "",
    )
    items.push({
      source: "NDL",
      sourceUrl,
      identifier: identifierMatch ? stripMarkup(identifierMatch[1]) : "",
      title,
      titleReading,
      creators,
      creatorReadings,
      publishers,
      dates: unique([...xmlValues(bib, "dcterms:date"), ...xmlValues(bib, "dcterms:issued")]),
      series: tagFragments(bib, "dcndl:seriesTitle")
        .map((seriesBlock) => firstXmlValue(seriesBlock, "rdf:value") || stripMarkup(seriesBlock))
        .filter(Boolean),
    })
  }
  return { totalResults, items }
}

function candidateFacts(book, candidate) {
  const sourceTitle = compactTitle(book.title)
  const candidateTitle = compactTitle(candidate.title)
  const titleExact = Boolean(sourceTitle && candidateTitle && sourceTitle === candidateTitle)
  const titleMainExact = Boolean(
    !titleExact && sourceTitle && sourceTitle === compactTitle(mainTitle(candidate.title)),
  )
  const titlePartial = Boolean(
    !titleExact &&
    !titleMainExact &&
    sourceTitle.length >= 4 &&
    candidateTitle.length >= 4 &&
    (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle)),
  )
  const sourceAuthors = book.authors.map(compactAuthor).filter(Boolean)
  const candidateAuthors = candidate.creators.map(compactAuthor).filter(Boolean)
  const matchedAuthors = sourceAuthors.filter((sourceAuthor) =>
    candidateAuthors.some(
      (candidateAuthor) =>
        sourceAuthor === candidateAuthor ||
        (sourceAuthor.length >= 3 && candidateAuthor.includes(sourceAuthor)) ||
        (candidateAuthor.length >= 3 && sourceAuthor.includes(candidateAuthor)),
    ),
  )
  const authorMatched = sourceAuthors.length > 0 && matchedAuthors.length > 0
  const sourcePublishers = book.publishers.map(compactPublisher).filter(Boolean)
  const candidatePublishers = candidate.publishers.map(compactPublisher).filter(Boolean)
  const publisherMatched = sourcePublishers.some((sourcePublisher) =>
    candidatePublishers.some(
      (candidatePublisher) =>
        sourcePublisher === candidatePublisher ||
        sourcePublisher.includes(candidatePublisher) ||
        candidatePublisher.includes(sourcePublisher),
    ),
  )
  const sourceYears = unique([book.publicationYear, book.firstEditionYear].map(yearValue))
  const candidateYears = unique(candidate.dates.map(yearValue))
  const yearMatched = sourceYears.some((year) => candidateYears.includes(year))
  const yearNear = sourceYears.some((year) =>
    candidateYears.some((candidateYear) => Math.abs(year - candidateYear) <= 2),
  )
  const sourceSeries = [...book.series, ...book.labels].map(compactText).filter(Boolean)
  const candidateSeries = candidate.series.map(compactText).filter(Boolean)
  const seriesMatched = sourceSeries.some((sourceValue) =>
    candidateSeries.some(
      (candidateValue) =>
        sourceValue === candidateValue ||
        sourceValue.includes(candidateValue) ||
        candidateValue.includes(sourceValue),
    ),
  )
  let score = 0
  if (titleExact) score += 55
  else if (titleMainExact) score += 52
  else if (titlePartial) score += 25
  if (authorMatched) score += 25
  if (publisherMatched) score += 10
  if (yearMatched) score += 10
  else if (yearNear) score += 4
  if (seriesMatched) score += 5
  if (candidate.titleReading) score += 2
  return {
    score,
    titleExact,
    titleMainExact,
    titlePartial,
    authorMatched,
    matchedAuthorCount: matchedAuthors.length,
    publisherMatched,
    yearMatched,
    yearNear,
    seriesMatched,
  }
}

function rankedCandidates(book, candidates) {
  return candidates
    .map((candidate) => ({ ...candidate, facts: candidateFacts(book, candidate) }))
    .filter(
      (candidate) =>
        candidate.facts.titleExact ||
        candidate.facts.titleMainExact ||
        candidate.facts.titlePartial,
    )
    .sort((left, right) => right.facts.score - left.facts.score)
}

function isStrongCandidate(book, candidate, nextCandidate) {
  if (!candidate?.titleReading) return false
  const facts = candidate.facts
  if ((!facts.titleExact && !facts.titleMainExact) || !facts.authorMatched) return false
  const hasPublisherOrYear = facts.publisherMatched || facts.yearMatched
  const sourceHasSupportingData =
    book.publishers.length > 0 || Boolean(yearValue(book.publicationYear))
  if (sourceHasSupportingData && !hasPublisherOrYear) return false
  if (nextCandidate && candidate.facts.score - nextCandidate.facts.score < 8) return false
  return true
}

function authorProposals(book, candidate) {
  const proposals = []
  const pairs = candidate.creators.map((creator, index) => ({
    name: creator,
    normalized: compactAuthor(creator),
    reading: cleanAuthorReading(candidate.creatorReadings[index] || ""),
  }))
  for (const author of book.authors) {
    const normalized = compactAuthor(author)
    const pair = pairs.find(
      (candidateAuthor) =>
        candidateAuthor.reading &&
        (candidateAuthor.normalized === normalized ||
          (normalized.length >= 3 && candidateAuthor.normalized.includes(normalized)) ||
          (candidateAuthor.normalized.length >= 3 &&
            normalized.includes(candidateAuthor.normalized))),
    )
    if (pair) {
      proposals.push({
        name: author,
        reading: pair.reading,
        source: candidate.source,
        sourceUrl: candidate.sourceUrl,
      })
    }
  }
  return proposals
}

function compactCandidate(candidate) {
  if (!candidate) return null
  return {
    source: candidate.source,
    sourceUrl: candidate.sourceUrl,
    identifier: candidate.identifier,
    title: candidate.title,
    titleReading: cleanTitleReading(candidate.titleReading),
    creators: candidate.creators,
    creatorReadings: candidate.creatorReadings.map(cleanAuthorReading),
    publishers: candidate.publishers,
    dates: candidate.dates,
    series: candidate.series,
    facts: candidate.facts,
  }
}

function makeProposal(book, candidates) {
  const top = candidates[0]
  const next = candidates[1]
  if (isStrongCandidate(book, top, next)) {
    return {
      titleReading: cleanTitleReading(top.titleReading),
      source: "NDL",
      sourceUrl: top.sourceUrl,
      confidence: "high",
      reason: "NDLで書名・著者が一致し、出版社または出版年も一致",
      authorProposals: authorProposals(book, top),
    }
  }
  if (top?.titleReading && top.facts.authorMatched && top.facts.score >= 50) {
    return {
      titleReading: cleanTitleReading(top.titleReading),
      source: "NDL",
      sourceUrl: top.sourceUrl,
      confidence: "review",
      reason: "NDLに読み候補がありますが、書誌同定条件が不足または競合しています",
      authorProposals: authorProposals(book, top),
    }
  }
  return {
    titleReading: "",
    source: "",
    sourceUrl: "",
    confidence: "unresolved",
    reason: "NDL書誌から一意な読みを確定できませんでした",
    authorProposals: [],
  }
}

function makeBookResult(book, candidates, queryUrl, totalResults, method, errors = []) {
  const ranked = rankedCandidates(book, candidates)
  return {
    relativePath: book.relativePath,
    sha256: book.sha256,
    title: book.title,
    authors: book.authors,
    publishers: book.publishers,
    publicationYear: book.publicationYear,
    firstEditionYear: book.firstEditionYear,
    series: book.series,
    labels: book.labels,
    collectionMethod: method,
    ndl: {
      queryUrl,
      totalResults,
      candidates: ranked.slice(0, 5).map(compactCandidate),
    },
    cinii: null,
    proposal: makeProposal(book, ranked),
    errors,
  }
}

function aggregateAuthorCandidates(inventoryAuthors, bookResults) {
  const observations = new Map()
  for (const result of bookResults) {
    for (const proposal of result.proposal.authorProposals) {
      const key = compactAuthor(proposal.name)
      if (!key) continue
      const list = observations.get(key) || []
      list.push(proposal)
      observations.set(key, list)
    }
  }
  return inventoryAuthors
    .filter((author) => !author.reading)
    .map((author) => {
      const entries = observations.get(compactAuthor(author.name)) || []
      const grouped = new Map()
      for (const entry of entries) {
        const key = compactText(entry.reading)
        if (!key) continue
        const group = grouped.get(key) || {
          reading: entry.reading,
          count: 0,
          sources: new Set(),
          sourceUrls: new Set(),
        }
        group.count += 1
        group.sources.add(entry.source)
        group.sourceUrls.add(entry.sourceUrl)
        grouped.set(key, group)
      }
      const candidates = [...grouped.values()]
        .map((group) => ({
          reading: group.reading,
          count: group.count,
          sources: [...group.sources],
          sourceUrls: [...group.sourceUrls],
        }))
        .sort((left, right) => right.count - left.count)
      return {
        relativePath: author.relativePath,
        sha256: author.sha256,
        name: author.name,
        existingReading: author.reading,
        candidates,
        proposedReading: candidates.length === 1 ? candidates[0].reading : "",
        confidence:
          candidates.length === 1 ? "high" : candidates.length > 1 ? "review" : "unresolved",
      }
    })
}

function orderedResults(selectedBooks, resultMap) {
  return selectedBooks.map((book) => resultMap.get(book.relativePath)).filter(Boolean)
}

function writeOutput(outputFile, inventory, selectedBooks, resultMap, complete, stopReason = "") {
  const bookResults = orderedResults(selectedBooks, resultMap)
  const authorCandidates = aggregateAuthorCandidates(inventory.authors, bookResults)
  const output = {
    version: 2,
    generatedAt: new Date().toISOString(),
    inventoryGeneratedAt: inventory.generatedAt,
    complete,
    stopReason,
    counts: {
      selectedBooks: selectedBooks.length,
      processedBooks: bookResults.length,
      highConfidenceTitleReadings: bookResults.filter((item) => item.proposal.confidence === "high")
        .length,
      reviewTitleReadings: bookResults.filter((item) => item.proposal.confidence === "review")
        .length,
      unresolvedTitleReadings: bookResults.filter(
        (item) => item.proposal.confidence === "unresolved",
      ).length,
      blankAuthors: authorCandidates.length,
      highConfidenceAuthorReadings: authorCandidates.filter((item) => item.confidence === "high")
        .length,
      reviewAuthorReadings: authorCandidates.filter((item) => item.confidence === "review").length,
      unresolvedAuthorReadings: authorCandidates.filter((item) => item.confidence === "unresolved")
        .length,
    },
    books: bookResults,
    authors: authorCandidates,
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8")
  return output
}

function queryUrl(base, parameters) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
  return url.toString()
}

function cqlQuoted(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function buildBatchUrl(books) {
  const titles = unique(books.map((book) => book.title))
    .map(cqlQuoted)
    .join(" ")
  const authors = unique(books.flatMap((book) => book.authors.slice(0, 2)))
    .map(cqlQuoted)
    .join(" ")
  let query = `dpid = "iss-ndl-opac" AND title any ${titles}`
  if (authors) query += ` AND creator any ${authors}`
  return queryUrl("https://ndlsearch.ndl.go.jp/api/sru", {
    operation: "searchRetrieve",
    version: "1.2",
    query,
    recordSchema: "dcndl_v3",
    recordPacking: "string",
    onlyBib: "true",
    startRecord: "1",
    maximumRecords: `${MAX_RECORDS}`,
  })
}

function buildBatches(books, requestedSize) {
  const batches = []
  let current = []
  for (const book of books) {
    const proposed = [...current, book]
    if (
      current.length &&
      (proposed.length > requestedSize || buildBatchUrl(proposed).length > MAX_URL_LENGTH)
    ) {
      batches.push(current)
      current = [book]
    } else {
      current = proposed
    }
  }
  if (current.length) batches.push(current)
  return batches
}

function splitBatch(batch) {
  if (batch.length <= 1) return [batch, []]
  const midpoint = Math.ceil(batch.length / 2)
  return [batch.slice(0, midpoint), batch.slice(midpoint)]
}
function cacheFileFor(cacheDirectory, url) {
  const digest = crypto.createHash("sha256").update(url).digest("hex")
  return path.join(cacheDirectory, `${digest}.json`)
}

function cacheResponse(cacheDirectory, url, body) {
  fs.mkdirSync(cacheDirectory, { recursive: true })
  fs.writeFileSync(
    cacheFileFor(cacheDirectory, url),
    `${JSON.stringify({ url, fetchedAt: new Date().toISOString(), body })}\n`,
    "utf8",
  )
}

function cachedResponse(cacheDirectory, url) {
  const cacheFile = cacheFileFor(cacheDirectory, url)
  if (!fs.existsSync(cacheFile)) return ""
  return JSON.parse(fs.readFileSync(cacheFile, "utf8")).body || ""
}

function tokyoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function loadState(stateFile) {
  let state = { date: tokyoDate(), requestsToday: 0, totalRequests: 0, lastRequestAt: "" }
  if (fs.existsSync(stateFile)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }
    } catch {
      fail(`通信状態ファイルを読めません: ${stateFile}`)
    }
  }
  if (state.date !== tokyoDate()) state = { ...state, date: tokyoDate(), requestsToday: 0 }
  return state
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

async function fetchNdl(url, args, state) {
  const cached = cachedResponse(args.cache, url)
  if (cached) return { body: cached, fromCache: true }
  if (state.requestsToday >= args.dailyLimit) {
    throw new StopCollectionError(`本日の上限 ${args.dailyLimit} リクエストに達しました`)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  let response
  let body = ""
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/xml, text/xml;q=0.9, */*;q=0.1",
        "User-Agent":
          "PukoReadingAudit/2.0 (personal non-commercial catalog; sequential batch lookup)",
      },
      signal: controller.signal,
    })
    body = await response.text()
  } catch (error) {
    throw new StopCollectionError(`通信エラーのため再試行せず停止しました: ${error.message}`)
  } finally {
    clearTimeout(timeout)
  }
  state.requestsToday += 1
  state.totalRequests += 1
  state.lastRequestAt = new Date().toISOString()
  saveState(args.state, state)
  if (
    response.status === 429 ||
    response.status === 503 ||
    /Too Many Requests|同時アクセス数の上限/u.test(body)
  ) {
    throw new StopCollectionError("NDL側のアクセス制限を検出したため、再試行せず停止しました")
  }
  if (!response.ok)
    throw new StopCollectionError(`NDLがHTTP ${response.status}を返したため停止しました`)
  cacheResponse(args.cache, url, body)
  const jitter = Math.floor(Math.random() * 5_001)
  await sleep(args.delayMs + jitter)
  return { body, fromCache: false }
}

function loadExistingOutput(outputFile, selectedByPath, resultMap) {
  if (!fs.existsSync(outputFile)) return 0
  let output
  try {
    output = JSON.parse(fs.readFileSync(outputFile, "utf8"))
  } catch {
    fail(`既存の候補ファイルを読めません: ${outputFile}`)
  }
  let count = 0
  for (const result of output.books || []) {
    const book = selectedByPath.get(result.relativePath)
    if (!book || !sameBibliographicIdentity(book, result) || !result.proposal) continue
    resultMap.set(result.relativePath, result)
    count += 1
  }
  return count
}

function recoverLegacyNdlCache(cacheDirectory, selectedBooks, resultMap) {
  if (!fs.existsSync(cacheDirectory)) return 0
  const byKey = new Map()
  for (const book of selectedBooks) {
    const key = `${compactTitle(book.title)}\u0000${compactAuthor(book.authors[0] || "")}`
    const list = byKey.get(key) || []
    list.push(book)
    byKey.set(key, list)
  }
  let recovered = 0
  for (const name of fs.readdirSync(cacheDirectory)) {
    if (!name.endsWith(".json")) continue
    let cached
    try {
      cached = JSON.parse(fs.readFileSync(path.join(cacheDirectory, name), "utf8"))
    } catch {
      continue
    }
    let url
    try {
      url = new URL(cached.url || "")
    } catch {
      continue
    }
    if (url.hostname !== "ndlsearch.ndl.go.jp" || url.pathname !== "/api/opensearch") continue
    const key = `${compactTitle(url.searchParams.get("title"))}\u0000${compactAuthor(url.searchParams.get("creator"))}`
    const books = byKey.get(key) || []
    if (!books.length || !cached.body) continue
    const parsed = parseNdlOpenSearch(cached.body)
    for (const book of books) {
      if (resultMap.has(book.relativePath)) continue
      resultMap.set(
        book.relativePath,
        makeBookResult(book, parsed.items, cached.url, parsed.totalResults, "legacy-NDL-cache"),
      )
      recovered += 1
    }
  }
  return recovered
}

function printCounts(output) {
  console.log(`  処理済み: ${output.counts.processedBooks}/${output.counts.selectedBooks}件`)
  console.log(`  確定候補: ${output.counts.highConfidenceTitleReadings}件`)
  console.log(`  要確認: ${output.counts.reviewTitleReadings}件`)
  console.log(`  未解決: ${output.counts.unresolvedTitleReadings}件`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.inventory)) fail(`書誌一覧がありません: ${args.inventory}`)
  const inventory = JSON.parse(fs.readFileSync(args.inventory, "utf8"))
  if (
    inventory.version !== 1 ||
    !Array.isArray(inventory.books) ||
    !Array.isArray(inventory.authors)
  ) {
    fail("対応していない書誌一覧形式です")
  }
  const generalKanaBookPattern =
    /^01 一般書籍\/(?:あ|か|さ|た|な|は|ま|や|ら|わ)\/[^/]+\.md$/u

  const selectedBooks = inventory.books.filter(
    (book) =>
      !book.titleReading &&
      generalKanaBookPattern.test(book.relativePath),
  )
  if (args.offlineResponse) {
    const parsed = parseNdlSru(fs.readFileSync(args.offlineResponse, "utf8"))
    const matched = selectedBooks
      .map((book) =>
        makeBookResult(book, parsed.items, "offline-test", parsed.totalResults, "offline-test"),
      )
      .filter((result) => result.ndl.candidates.length)
    console.log(
      JSON.stringify(
        {
          totalResults: parsed.totalResults,
          parsedItems: parsed.items.length,
          matchedBooks: matched.map((result) => ({
            title: result.title,
            confidence: result.proposal.confidence,
            reading: result.proposal.titleReading,
            sourceUrl: result.proposal.sourceUrl,
          })),
        },
        null,
        2,
      ),
    )
    return
  }
  const selectedByPath = new Map(selectedBooks.map((book) => [book.relativePath, book]))
  const resultMap = new Map()
  const fromOutput = loadExistingOutput(args.output, selectedByPath, resultMap)
  const fromCache = recoverLegacyNdlCache(args.cache, selectedBooks, resultMap)
  const remaining = selectedBooks.filter((book) => !resultMap.has(book.relativePath))
  const batches = buildBatches(remaining, args.batchSize)

  console.log("読み候補収集の安全確認")
  console.log("  対象範囲: 01 一般書籍 / あ〜わ の直下")
  console.log(`  対象: ${selectedBooks.length}件`)
  console.log(`  既存候補から再利用: ${fromOutput}件`)
  console.log(`  旧NDLキャッシュから追加再利用: ${fromCache}件`)
  console.log(`  未処理: ${remaining.length}件`)
  console.log(`  初期NDLバッチ: ${batches.length}件（最大${args.batchSize}冊/バッチ）`)
  console.log(
    `  ${MAX_RECORDS}件を超える検索結果はバッチを自動分割し、1冊でも超える場合は未解決にします`,
  )
  console.log(`  このツールの1日通信上限: ${args.dailyLimit}回`)
  console.log(
    `  通信間隔: ${Math.round(args.delayMs / 1000)}〜${Math.round(args.delayMs / 1000) + 5}秒`,
  )

  if (!args.execute) {
    console.log("")
    console.log("今回は通信していません。通信を実行する場合は -Execute を付けて実行してください。")
    return
  }

  const state = loadState(args.state)
  console.log(`  本日すでに行った新規通信: ${state.requestsToday}回`)
  if (!batches.length) {
    const output = writeOutput(args.output, inventory, selectedBooks, resultMap, true)
    console.log("すべて処理済みです。原典は変更していません。")
    printCounts(output)
    return
  }

  let stopReason = ""
  let splitCount = 0
  let completedUnits = 0

  async function processBatch(batch) {
    const url = buildBatchUrl(batch)
    const response = await fetchNdl(url, args, state)
    const parsed = parseNdlSru(response.body)

    if (parsed.totalResults > MAX_RECORDS) {
      if (batch.length > 1) {
        const [left, right] = splitBatch(batch)
        splitCount += 1
        console.warn(
          `自動分割: ${batch.length}冊の検索結果が${parsed.totalResults}件のため ` +
            `${left.length}冊 + ${right.length}冊に分割します` +
            (response.fromCache ? "（保存済み応答）" : ""),
        )
        await processBatch(left)
        if (right.length) await processBatch(right)
        return
      }

      const book = batch[0]
      const overflowReason =
        `NDL検索結果が${parsed.totalResults}件で取得上限${MAX_RECORDS}件を超えたため、` +
        "候補を確定しません"

      const overflowResult = makeBookResult(
        book,
        [],
        url,
        parsed.totalResults,
        "NDL-SRU-overflow",
        [overflowReason],
      )
      overflowResult.proposal.reason = overflowReason
      resultMap.set(book.relativePath, overflowResult)

      completedUnits += 1
      const output = writeOutput(args.output, inventory, selectedBooks, resultMap, false)
      console.log(
        `[処理単位 ${completedUnits}] 1冊を未解決として保存 / ` +
          `確定 ${output.counts.highConfidenceTitleReadings} / ` +
          `要確認 ${output.counts.reviewTitleReadings} / ` +
          `未解決 ${output.counts.unresolvedTitleReadings}` +
          (response.fromCache ? "（保存済み応答）" : ""),
      )
      return
    }

    for (const book of batch) {
      resultMap.set(
        book.relativePath,
        makeBookResult(book, parsed.items, url, parsed.totalResults, "NDL-SRU-batch"),
      )
    }

    completedUnits += 1
    const output = writeOutput(args.output, inventory, selectedBooks, resultMap, false)
    console.log(
      `[処理単位 ${completedUnits}] ${batch.length}冊を処理 / ` +
        `確定 ${output.counts.highConfidenceTitleReadings} / ` +
        `要確認 ${output.counts.reviewTitleReadings} / ` +
        `未解決 ${output.counts.unresolvedTitleReadings}` +
        (response.fromCache ? "（保存済み応答）" : ""),
    )
  }

  for (const batch of batches) {
    try {
      await processBatch(batch)
    } catch (error) {
      if (error instanceof StopCollectionError) {
        stopReason = error.message
        break
      }
      throw error
    }
  }

  console.log(`  自動分割: ${splitCount}回`)
  const complete = resultMap.size === selectedBooks.length
  const output = writeOutput(args.output, inventory, selectedBooks, resultMap, complete, stopReason)
  console.log("")
  if (complete) console.log("読み候補の収集が完了しました。原典は変更していません。")
  else console.log(`安全停止: ${stopReason || "本日の処理を終了しました"}`)
  printCounts(output)
  console.log(`  出力先: ${args.output}`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
