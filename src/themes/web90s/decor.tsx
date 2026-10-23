// Decorations for the web90s look (docs/LOOKS.md, "Decor slots"). Optional components the shell renders
// while this look is active: Banner (top of the main column), Footer (bottom of it) and
// Headcount({ count, incoming }) in place of the rail's tally meter. Decor never covers content,
// never takes focus, respects reduced motion and carries no information that is not shown elsewhere.
//
// 1990s web: a Java-applet style ticker welcoming people to the intranet, a footer with a visitor
// counter (the real headcount), "best viewed with", webring and "last updated" lines and a row of
// 88x31 badges, and an odometer in the rail. All of it is aria-hidden flavor; the motion stops under
// reduced motion (styles in web90s.css).
import { format } from 'date-fns'
import { headcountOn } from '@/domain/people'
import { parseDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import type { HeadcountDecorProps, LookDecor } from '../registry'

/** A row of odometer wheels, zero padded: 14 -> 000014. */
function Odometer({ value, digits = 6 }: { value: number; digits?: number }) {
  const text = String(Math.max(0, Math.floor(value))).padStart(digits, '0')
  return (
    <span className="ft-w90-odo">
      {Array.from(text).map((d, i) => (
        <span key={i} className="ft-w90-odo__digit">
          {d}
        </span>
      ))}
    </span>
  )
}

/** A slow scrolling notice, like a 1997 ticker applet. Pauses on hover and while keyboard focus is in the page. */
function Banner() {
  const company = useDB((s) => s.db.company.name)
  const weekday = format(parseDate(today()), 'EEEE')
  return (
    <div className="ft-w90-ticker" aria-hidden>
      <span className="ft-w90-ticker__new">NEW!</span>
      <span className="ft-w90-ticker__track">
        <span className="ft-w90-ticker__text">
          Welcome to the {company} intranet! &nbsp;::&nbsp; Have a great {weekday} &nbsp;::&nbsp; Thanks for stopping by
        </span>
      </span>
    </div>
  )
}

/** The bottom of every page: hit counter, browser badge line, webring and last updated date. */
function Footer() {
  const db = useDB((s) => s.db)
  const visitors = headcountOn(db)
  const updated = format(parseDate(today()), 'MMMM d, yyyy')
  return (
    <div className="ft-w90-footer" aria-hidden>
      <hr className="ft-w90-footer__rule" />
      <p className="ft-w90-footer__counter">
        <span>You are visitor #</span>
        <Odometer value={visitors} />
      </p>
      <p>Best viewed with Netscape Navigator 4.0 at 800x600</p>
      <p className="ft-w90-footer__small">
        [ Previous ] [ Random ] [ Next ] &nbsp; This site is a member of the Small Business HR webring
      </p>
      <p className="ft-w90-footer__small">
        <span className="ft-w90-construction" />
        Last updated {updated}
        <span className="ft-w90-footer__new">NEW!</span>
      </p>
      <p className="ft-w90-footer__badges">
        {BADGES.map((b) => (
          <span key={b.top} className={`ft-w90-badge88 ft-w90-badge88--${b.tone}`}>
            <span className="ft-w90-badge88__top">{b.top}</span>
            <span className="ft-w90-badge88__bottom">{b.bottom}</span>
          </span>
        ))}
      </p>
    </div>
  )
}

/** 88x31 "web button" badges, drawn in CSS. Plain text, not links, never focusable. */
const BADGES = [
  { top: 'Netscape', bottom: 'NOW!', tone: 'navy' },
  { top: 'Made with', bottom: 'Notepad', tone: 'teal' },
  { top: 'Best at', bottom: '800 x 600', tone: 'black' },
] as const

/** The rail's headcount as a hit counter. The number and its label stay above it. */
function Headcount({ count }: HeadcountDecorProps) {
  return (
    <div className="ft-w90-hc" aria-hidden>
      <Odometer value={count} />
      <span className="ft-w90-hc__caption">on staff</span>
    </div>
  )
}

export const decor: LookDecor = { Banner, Footer, Headcount }
