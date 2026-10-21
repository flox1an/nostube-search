import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Nostube Search',
  description: 'Run, configure and understand the Nostr video search engine',
  base: '/nostube-search/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['agents/**'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Configuration', link: '/guide/configuration' },
      { text: 'How it works', link: '/guide/search-engine' },
      { text: 'API', link: '/reference/api' },
    ],
    sidebar: [
      {
        text: 'Run Nostube Search',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Operations', link: '/guide/operations' },
        ],
      },
      {
        text: 'Understand and integrate',
        items: [
          { text: 'How the search engine works', link: '/guide/search-engine' },
          { text: 'HTTP API', link: '/reference/api' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/flox1an/nostube-search' }],
    editLink: {
      pattern: 'https://github.com/flox1an/nostube-search/edit/main/docs/:path',
    },
    search: { provider: 'local' },
  },
})
