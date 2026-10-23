// The nav item marked as the current page (aria-current) for each route view.
import { describe, expect, it } from 'vitest'
import type { Viewer } from '@/domain/types'
import { activeNavKey } from './nav'

const admin: Viewer = { role: 'admin', person: undefined, personId: null }
const employee: Viewer = { role: 'employee', person: undefined, personId: null }

describe('the current nav item', () => {
  it('is the section a view belongs to, detail pages included', () => {
    expect(activeNavKey('hiring', admin)).toBe('hiring')
    expect(activeNavKey('candidate', admin)).toBe('hiring')
    expect(activeNavKey('person', admin)).toBe('people')
    expect(activeNavKey('settings', admin)).toBe('settings')
  })

  it("is Home on the home page, Me for an employee, and Home for a view it does not know", () => {
    expect(activeNavKey('home', admin)).toBe('home')
    expect(activeNavKey('', employee)).toBe('me')
    expect(activeNavKey('nowhere', admin)).toBe('home')
  })

  it("is none on an invite link's page, which belongs to no section", () => {
    expect(activeNavKey('invite', admin)).toBeNull()
    expect(activeNavKey('invite', employee)).toBeNull()
  })
})
