// Slots a development build can fill: a page at a route the route table does not have, a banner beside the
// sync banners and a link under the main navigation. Nothing in the app registers here. Code in src/dev does,
// and main.tsx loads it only behind import.meta.env.DEV, so in a build every slot stays empty and renders
// nothing. A page that should ship moves into ROUTES (src/app/routes.tsx) instead.
import type { ComponentType } from 'react'
import { create } from 'zustand'
import type { IconName } from '@/ui'
import type { PageProps } from './routes'

/** A page for a route view, with the browser tab title it gives. */
export type DevPage = { component: ComponentType<PageProps>; title: string }

/** A link under the main navigation (the rail and the phone menu). */
export type DevNavItem = { view: string; label: string; href: string; icon: IconName }

type Slots = {
  pages: Readonly<Record<string, DevPage>>
  banner: ComponentType | null
  nav: readonly DevNavItem[]
}

const useSlots = create<Slots>(() => ({ pages: {}, banner: null, nav: [] }))

/** Shows `page` at #<view> when the route table has no page there. Registering a view again replaces it. */
export function registerDevPage(view: string, page: DevPage): void {
  useSlots.setState((s) => ({ pages: { ...s.pages, [view]: page } }))
}

/** The page registered for a route view, or null. */
export function useDevPage(view: string): DevPage | null {
  return useSlots((s) => s.pages[view] ?? null)
}

/** The banner the Shell shows beside the sync banners (null: none). */
export function setDevBanner(banner: ComponentType | null): void {
  useSlots.setState({ banner })
}

export function useDevBanner(): ComponentType | null {
  return useSlots((s) => s.banner)
}

/** Adds a link under the main navigation; a link for the same view replaces it. */
export function registerDevNav(item: DevNavItem): void {
  useSlots.setState((s) => ({ nav: [...s.nav.filter((n) => n.view !== item.view), item] }))
}

export function useDevNav(): readonly DevNavItem[] {
  return useSlots((s) => s.nav)
}

/** What the slots hold now, outside React (tests). */
export function devSlots(): Slots {
  return useSlots.getState()
}
