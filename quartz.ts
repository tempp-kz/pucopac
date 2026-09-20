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
      ],
    }
  },
}

const config = await loadQuartzConfig()
config.plugins.transformers.push(searchableProperties)
export default config
export const layout = await loadQuartzLayout()
