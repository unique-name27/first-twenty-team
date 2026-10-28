import './themes/fonts'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { initSync, isServedPage } from './sync'
import { SERVICE_WORKER_URL } from './sync/protocol'

// Optional server sync (docs/SYNC.md). Runs before the first render so changes made on load are told
// apart from the saved copy. A no-op unless this browser connected to a server before.
initSync()

// Development only (docs/DEV.md): with `npm run stack`, signs this browser in to the dev server's sample
// company. Vite replaces import.meta.env.DEV with false in a build, so the branch and the module go.
if (import.meta.env.DEV) void import('./dev/autoconnect').then((m) => m.startAutoconnect())

/**
 * The server's offline worker (docs/SERVER.md): keeps the app page, so the app still opens from this
 * browser's copy, with its queued changes, while the server cannot be reached. Only for a page the First
 * Twenty server served (it adds the SERVED_MARKER meta tag: isServedPage): never from a file, the artifact
 * viewer or the Vite dev server. Browsers allow workers only on https and localhost.
 */
function registerOfflineWorker(): void {
  try {
    if (!isServedPage()) return
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return
    if (!('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }).catch(() => {
        /* no offline copy: the app works as before while the server answers */
      })
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  } catch {
    /* a browser without workers, or one that blocks them */
  }
}
registerOfflineWorker()

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
