import { initCliI18n, type Lang } from '../i18n/index.js'
import { ensureDataDirs } from './data.js'
import { renderMarkdownToAnsi } from './markdown_render.js'
import { shouldShowNotice, splitMarkdownFrontmatter } from './notice_frontmatter.js'
import { getSelfVersion } from './pkg.js'
import { loadState, saveState, type CliState } from './state.js'
import { createUi } from './ui.js'
import { findLatestUpdate } from './update_changelog.js'

const ui = createUi()

type CheckKey = 'update' | 'notice'

const URLS: Record<CheckKey, Record<Lang, string>> = {
  update: {
    'en-US': 'https://github.com/josStorer/genshin-ts/raw/refs/heads/master/Changelog.md',
    'zh-CN': 'https://github.com/josStorer/genshin-ts/raw/refs/heads/master/Changelog_ZH.md'
  },
  notice: {
    'en-US': 'https://github.com/josStorer/genshin-ts/raw/refs/heads/master/Announcement.md',
    'zh-CN': 'https://github.com/josStorer/genshin-ts/raw/refs/heads/master/Announcement_ZH.md'
  }
}

function getBucket(state: CliState, key: CheckKey) {
  return key === 'update' ? state.updateCheck : state.noticeCheck
}

function setBucket(state: CliState, key: CheckKey, next: { lastAt?: number; streak?: number }) {
  if (key === 'update') state.updateCheck = next
  else state.noticeCheck = next
}

export async function maybeCheckRemoteMarkdown(key: CheckKey, lang: Lang) {
  ensureDataDirs()
  const { t } = initCliI18n(lang)

  const state = loadState()
  const bucket = getBucket(state, key) ?? {}
  const lastAt = bucket.lastAt ?? 0
  const cooldownMs = 2 * 3600 * 1000
  const cooledDown = Date.now() - lastAt >= cooldownMs
  const streak = cooledDown ? 0 : (bucket.streak ?? 0)
  const now = Date.now()

  const minIntervalMs = 5 * 60 * 1000
  if (now - lastAt < minIntervalMs) return

  if (streak >= 3) return

  setBucket(state, key, { lastAt: now, streak: streak + 1 })
  saveState(state)

  const url = URLS[key][lang]
  ui.info(key === 'update' ? t('checkUpdate') : t('checkNotice'))
  const { fetchText } = await import('./net.js')
  const md = await fetchText(url)

  const rendered = (() => {
    if (key === 'notice') {
      const { meta, body } = splitMarkdownFrontmatter(md)
      const ver = getSelfVersion()
      if (!shouldShowNotice(meta, Date.now(), ver)) return ''
      return renderMarkdownToAnsi(body)
    }

    const hit = findLatestUpdate(md, getSelfVersion())
    if (!hit) return ''
    ui.warn(`${t('updateFound')}: v${hit.latest}`)
    return renderMarkdownToAnsi(hit.snippet)
  })()

  if (rendered.length) {
    process.stdout.write(rendered + '\n')
  }
}
