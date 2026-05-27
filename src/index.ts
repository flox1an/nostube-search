import './api/server.js'
import { main as runIndexer } from './indexer/index.js'

runIndexer().catch(err => {
  console.error('Indexer fatal error:', err)
  process.exit(1)
})
