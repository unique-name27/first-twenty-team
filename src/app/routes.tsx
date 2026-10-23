// Route table: the first hash segment picks the page. Each feature folder owns its pages.
// See ARCHITECTURE.md (Routes) for every route and which feature owns it.
import type { ComponentType } from 'react'
import { CompPage } from '@/features/comp'
import { CompliancePage } from '@/features/compliance'
import { CandidatePage, HiringPage, JobPage } from '@/features/hiring'
import { HomePage } from '@/features/home'
import { MePage } from '@/features/me'
import { ChecklistPage, ContractorPage, PeoplePage, PersonPage } from '@/features/people'
import { InvitePage, SettingsPage } from '@/features/settings'
import type { Route } from './router'

export type PageProps = { route: Route }

export const ROUTES: Record<string, ComponentType<PageProps>> = {
  home: HomePage,
  hiring: HiringPage,
  job: JobPage,
  candidate: CandidatePage,
  people: PeoplePage,
  person: PersonPage,
  checklist: ChecklistPage,
  contractor: ContractorPage,
  comp: CompPage,
  compliance: CompliancePage,
  me: MePage,
  settings: SettingsPage,
  // An invite link from Settings, Server (#invite.<token>): any role, no section.
  invite: InvitePage,
}

/** Old or shorthand routes that redirect: #timeoff -> #people.timeoff, #plan -> #comp.plan. */
export const ALIASES: Record<string, string[]> = {
  timeoff: ['people', 'timeoff'],
  plan: ['comp', 'plan'],
  onboarding: ['people', 'checklists'],
  pay: ['comp'],
}
