// Where keyboard focus goes after an offer action re-renders the candidate's Offer panel: the panel's
// next step (the primary button marked data-next-action), else the panel heading. The control that was
// pressed often unmounts (Mark sent, Make offer), and focus must never drop to <body>.
import type { ID } from '@/domain/types'

/** The id of the Offer panel heading for an application (SubPanel titleId). */
export function offerTitleId(applicationId: ID): string {
  return `offer-title-${applicationId}`
}

/** The Offer panel's next action for an application, else its heading; null when the panel is not on screen. */
export function offerFocusTarget(applicationId: ID): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-next-action="${CSS.escape(applicationId)}"]`) ?? document.getElementById(offerTitleId(applicationId))
}
