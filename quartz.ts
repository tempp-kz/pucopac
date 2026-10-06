import { loadQuartzConfig, loadQuartzLayout } from "./quartz/plugins/loader/config-loader"
import { componentRegistry } from "./quartz/components/registry"
import type { QuartzTransformerPluginInstance } from "./quartz/plugins/types"
import type { QuartzPluginData } from "./quartz/plugins/vfile"
import type { Root } from "hast"
import type { VFile } from "vfile"

const titleCollator = new Intl.Collator("ja-JP", {
  numeric: true,
  sensitivity: "base",
})

function titleForSort(file: QuartzPluginData): string {
  return (file.frontmatter?.title ?? "").normalize("NFKC")
}

componentRegistry.setOptionOverrides("@quartz-community/folder-page", {
  sort: (left: QuartzPluginData, right: QuartzPluginData) => {
    const leftIsFolder = left.slug?.endsWith("/index") ?? false
    const rightIsFolder = right.slug?.endsWith("/index") ?? false

    if (leftIsFolder && !rightIsFolder) return -1
    if (!leftIsFolder && rightIsFolder) return 1

    const byTitle = titleCollator.compare(titleForSort(left), titleForSort(right))
    if (byTitle !== 0) return byTitle

    return titleCollator.compare(left.slug ?? "", right.slug ?? "")
  },
})

const SEARCH_EXCLUDED_PROPERTIES = new Set([
  "title",
  "内部区分",
  "AI生成",
  "cssclasses",
  "modified",
  "quartz-properties",
  "quartzProperties",
  "quartz-properties-collapse",
  "quartzPropertiesCollapse",
])

function searchableValues(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(searchableValues)
  if (typeof value === "object") return Object.values(value).flatMap(searchableValues)
  return [String(value)]
}

function escapeSearchText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

const searchableProperties: QuartzTransformerPluginInstance = {
  name: "PukoSearchableProperties",
  htmlPlugins() {
    return [
      () => (_tree: Root, file: VFile) => {
        const frontmatter = file.data.frontmatter ?? {}
        const terms = Object.entries(frontmatter).flatMap(([key, value]) => {
          if (SEARCH_EXCLUDED_PROPERTIES.has(key)) return []
          const values = searchableValues(value)
            .map((item) => item.trim())
            .filter(Boolean)
          if (!values.length) return []
          return [key, ...values]
        })
        if (!terms.length) return

        const searchableText = escapeSearchText(terms.join(" "))
        file.data.text = `${file.data.text ?? ""}\n${searchableText}`
      },
    ]
  },
  externalResources() {
    return {
      css: [
        {
          content: `
.puko-property-lookup {
  color: var(--secondary);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 0.15em;
}

.puko-property-lookup:hover,
.puko-property-lookup:focus-visible {
  color: var(--tertiary);
  text-decoration-style: solid;
}

#puko-random-book p {
  margin: 0.6em 0;
}

#puko-random-refresh {
  border: 1px solid var(--secondary);
  border-radius: 0.35rem;
  background: var(--light);
  color: var(--secondary);
  cursor: pointer;
  font: inherit;
  padding: 0.25em 0.8em;
}

#puko-random-refresh:hover,
#puko-random-refresh:focus-visible {
  background: var(--highlight);
}

#puko-random-refresh:disabled {
  cursor: wait;
  opacity: 0.6;
}

.explorer .puko-kouzu-wiki > a {
  color: var(--secondary);
  font-family: var(--headerFont);
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.5rem;
}
`,
          inline: true,
        },
      ],
      js: [
        {
          loadTime: "afterDOMReady",
          contentType: "inline",
          script: `
const pukoReverseLookupProperties = new Set(["関連キーワード", "固有名詞"])

function initializePukoPropertyLookup() {
  for (const row of document.querySelectorAll(".note-properties-row")) {
    const key = row.querySelector(".note-properties-key")?.textContent?.trim()
    if (!key || !pukoReverseLookupProperties.has(key)) continue

    for (const value of row.querySelectorAll(".note-properties-text")) {
      if (value.dataset.pukoLookupReady === "true") continue
      const term = value.textContent?.trim()
      if (!term) continue

      value.dataset.pukoLookupReady = "true"
      value.classList.add("puko-property-lookup")
      value.setAttribute("role", "button")
      value.setAttribute("tabindex", "0")
      value.setAttribute("title", "同じ「" + term + "」を持つ書誌を検索")

      const lookup = () => {
        const buttons = [...document.querySelectorAll(".search-button")]
        const button = buttons.find((candidate) => candidate.offsetParent !== null) ?? buttons[0]
        if (!(button instanceof HTMLElement)) return
        button.click()

        requestAnimationFrame(() => {
          const container = button.closest(".search")
          const input = container?.querySelector(".search-bar")
          if (!(input instanceof HTMLInputElement)) return
          input.value = term
          input.dispatchEvent(new Event("input", { bubbles: true }))
          input.focus()
        })
      }

      value.addEventListener("click", lookup)
      value.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        lookup()
      })
    }
  }
}

const schedulePukoPropertyLookup = () => requestAnimationFrame(initializePukoPropertyLookup)
document.addEventListener("nav", schedulePukoPropertyLookup)
document.addEventListener("render", schedulePukoPropertyLookup)
`,
        },
        {
          loadTime: "afterDOMReady",
          contentType: "inline",
          script: `
function pukoTopField(content, name) {
  const match = content.match(new RegExp("^" + name + "::[ \\t]*(.+)$", "m"))
  return match ? match[1].trim() : "記載なし"
}

async function renderPukoRandomBook(target, button) {
  button.disabled = true
  try {
    const data = await fetchData
    if (!target.isConnected) return
    const excluded = new Set([target.dataset.excludeNew, target.dataset.excludeReading])
    const roots = ["01 一般書籍/", "02 市販雑誌 雑誌名順/", "03 シリーズ 出版社順/", "05 古典 著者出生地分類/", "07 外国語書籍/"]
    const books = Object.values(data).filter((entry) =>
      entry && typeof entry.filePath === "string" &&
      roots.some((root) => entry.filePath.startsWith(root)) &&
      !entry.filePath.endsWith("/index.md") &&
      !excluded.has(entry.filePath) &&
      typeof entry.content === "string" &&
      /^概要::[ \\t]*.+$/m.test(entry.content) &&
      /^読みやすさ::[ \\t]*.+$/m.test(entry.content)
    )
    if (!books.length) {
      target.textContent = "対象の書誌がありません。"
      return
    }
    const otherBooks = books.filter((entry) => entry.filePath !== target.dataset.currentPath)
    const choices = otherBooks.length ? otherBooks : books
    const bytes = new Uint32Array(1)
    crypto.getRandomValues(bytes)
    const book = choices[bytes[0] % choices.length]
    const title = document.createElement("a")
    title.textContent = book.title
    const urlPath = book.slug.split("/").map(encodeURIComponent).join("/")
    title.href = new URL(urlPath, new URL("./", location.href)).href
    const summary = document.createElement("p")
    summary.textContent = "概要：" + pukoTopField(book.content, "概要")
    const reading = document.createElement("p")
    reading.textContent = "読みやすさ：" + pukoTopField(book.content, "読みやすさ")
    target.replaceChildren(title, summary, reading)
    target.dataset.currentPath = book.filePath
  } catch {
    if (target.isConnected) target.textContent = "ランダム書誌を読み込めませんでした。"
  } finally {
    if (button.isConnected) button.disabled = false
  }
}

function initializePukoRandomBook() {
  const target = document.getElementById("puko-random-book")
  const button = document.getElementById("puko-random-refresh")
  if (!target || !button) return
  button.addEventListener("click", () => renderPukoRandomBook(target, button))
  void renderPukoRandomBook(target, button)
}

document.addEventListener("nav", initializePukoRandomBook)
`,
        },
        {
          loadTime: "afterDOMReady",
          contentType: "inline",
          script: `
const pukoWikiObservers = new WeakMap()

function placePukoWikiLink(list) {
  let item = list.querySelector(":scope > li.puko-kouzu-wiki")
  if (!item) {
    item = document.createElement("li")
    item.className = "puko-kouzu-wiki"
    const link = document.createElement("a")
    link.className = "nav-file-title tree-item-self"
    link.href = "https://tempp-kz.github.io/tempp/"
    link.textContent = "■神津wiki"
    item.append(link)
  }
  const link = item.querySelector("a")
  if (link) {
    link.target = "_blank"
    link.rel = "noopener noreferrer"
  }

  const end = list.querySelector(":scope > li.overflow-end")
  if (end) {
    if (end !== list.lastElementChild) list.append(end)
    if (item.nextElementSibling !== end) list.insertBefore(item, end)
  } else if (item !== list.lastElementChild) {
    list.append(item)
  }
}

function initializePukoWikiLink() {
  for (const list of document.querySelectorAll(".explorer .explorer-content > ul.explorer-ul")) {
    placePukoWikiLink(list)
    if (pukoWikiObservers.has(list)) continue
    const observer = new MutationObserver(() => placePukoWikiLink(list))
    observer.observe(list, { childList: true })
    pukoWikiObservers.set(list, observer)
    window.addCleanup(() => observer.disconnect())
  }
}

document.addEventListener("nav", initializePukoWikiLink)
document.addEventListener("render", initializePukoWikiLink)
`,
        },
      ],
    }
  },
}

const config = await loadQuartzConfig()
config.plugins.transformers.push(searchableProperties)
export default config
export const layout = await loadQuartzLayout()
