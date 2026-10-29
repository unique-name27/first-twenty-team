// The sandbox (sandbox.ts) wired to the app: the browser's store, the clock, the sync engine, the dev sign-in
// and the app's own Import, download and Pretend today is.
import { navigateTo } from '@/app/router'
import { setDemoClock } from '@/features/settings/DataTab'
import { getClockOverride, setClockOverride, toISODate } from '@/lib/dates'
import { downloadFile } from '@/lib/files'
import { newId } from '@/lib/id'
import { backupFileName } from '@/store/backup'
import { holdPersisting, useDB } from '@/store/db'
import { replaceWorkspace, syncNow, useSyncStatus } from '@/sync'
import { autoconnectBusy } from '../autoconnect'
import { createSandbox } from './sandbox'

export const sandbox = createSandbox({
  store: { getState: () => useDB.getState(), setState: (next) => useDB.setState(next) },
  getClock: getClockOverride,
  setClock: setClockOverride,
  syncNow,
  holdPersisting,
  blocked: () => {
    if (autoconnectBusy()) return 'The dev sign-in is still connecting this browser. Try again in a moment.'
    // These holds are reconsidered on every store change, even on a pretend date: the swap would move them.
    const hold = useSyncStatus.getState().hold
    if (hold === 'sample' || hold === 'replaced') return 'Syncing is paused for this browser (see the banner at the top). Sort that out first, then open the simulated company.'
    return null
  },
  connected: () => useSyncStatus.getState().mode === 'server',
  replaceWorkspace: async (db, label) => {
    const done = await replaceWorkspace(db, label)
    return done.ok ? { ok: true } : { ok: false, message: done.message }
  },
  replaceLocal: (db, label) => useDB.getState().replace(db, label),
  // Named for the real date: the clock still shows the simulated one while this runs.
  download: (db) => downloadFile(backupFileName(db.company.name, toISODate(new Date())), JSON.stringify(db, null, 2), 'application/json;charset=utf-8'),
  pretendToday: setDemoClock,
  newWorkspaceId: () => newId('ws'),
  go: (hash) => navigateTo(hash),
})
