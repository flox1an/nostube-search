---
layout: home

hero:
  name: Nostube Search
  text: Find videos on Nostr
  tagline: A self-hosted video search engine with MeiliSearch, automatic relay indexing and an HTTP API. Run your own instance and understand how results are built.
  actions:
    - theme: brand
      text: Run the search engine
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/search-engine
    - theme: alt
      text: GitHub
      link: https://github.com/flox1an/nostube-search

features:
  - title: Get running
    details: Start the API and background indexer with Docker Compose, or run the TypeScript application locally.
    link: /guide/getting-started
  - title: Configure your instance
    details: Choose source relays, indexing intervals, safety policies, cache settings and API limits.
    link: /guide/configuration
  - title: Operate it safely
    details: Check indexing progress, trigger a rolling rebuild, preserve persistent data and protect administrative services.
    link: /guide/operations
  - title: Understand search
    details: Follow signed Nostr events through metadata extraction, enrichment, indexing, ranking and safety filtering.
    link: /guide/search-engine
  - title: Integrate the API
    details: Use full-text search, tag browsing, people search, completions and related-video recommendations.
    link: /reference/api
---
