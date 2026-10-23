// An offer's base pay as text: '$187,000 a year', or an hourly rate with its cents ('$28.75 an hour'),
// so a rate just under the minimum wage is never rounded up to look legal. Both go through the
// privacy blur.
import type { Offer } from '@/domain/types'
import { money2 } from '@/lib/format'
import { Money, Private } from '@/ui'

export function OfferPay({ offer }: { offer: Pick<Offer, 'payType' | 'salary' | 'hourlyRate'> }) {
  return offer.payType === 'hourly' ? (
    <>
      <Private>{money2(offer.hourlyRate)}</Private> an hour
    </>
  ) : (
    <>
      <Money value={offer.salary} /> a year
    </>
  )
}
