// Puts the simulator panel into the app (docs/DEV.md, "The simulator panel"): a page at #sim, a link under the
// navigation and the banner shown while a simulated company is open in the app. main.tsx calls it only behind
// import.meta.env.DEV, so a build never registers anything (src/dev/guard.test.ts).
import { registerDevNav, registerDevPage, setDevBanner } from '@/app/devSlots'
import { SandboxBanner } from './SandboxBanner'
import { SimPage } from './SimPage'

export function registerSimulator(): void {
  registerDevPage('sim', { component: SimPage, title: 'Simulator (dev)' })
  registerDevNav({ view: 'sim', label: 'Simulator (dev)', href: '#sim', icon: 'zap' })
  setDevBanner(SandboxBanner)
}
