import { describe, expect, it } from 'vitest'
import { buildICS } from './ics'

const unfold = (s: string) => s.replace(/\r\n /g, '')

describe('buildICS', () => {
  it('writes a timed event in UTC with its link, organizer and attendees', () => {
    const ics = unfold(
      buildICS([
        {
          uid: 'i-1',
          title: 'Intro call',
          start: '2026-10-13T17:00:00.000Z',
          end: '2026-10-13T17:30:00.000Z',
          location: 'https://meet.example.com/room',
          url: 'https://meet.example.com/room',
          organizer: { name: 'Maya Raman', email: 'maya@ledgerlark.com' },
          attendees: [{ name: 'Alex Kim', email: 'alex@example.com' }],
        },
      ]),
    )
    expect(ics).toContain('DTSTART:20261013T170000Z\r\nDTEND:20261013T173000Z')
    expect(ics).toContain('LOCATION:https://meet.example.com/room')
    expect(ics).toContain('URL:https://meet.example.com/room')
    expect(ics).toContain('ORGANIZER;CN=Maya Raman:mailto:maya@ledgerlark.com')
    expect(ics).toContain('ATTENDEE;CN=Alex Kim;RSVP=TRUE:mailto:alex@example.com')
  })

  it('leaves out an organizer or attendee with no email address instead of writing an empty mailto', () => {
    const ics = buildICS([
      {
        uid: 'i-2',
        title: 'Intro call',
        start: '2026-10-13T17:00:00.000Z',
        organizer: { name: 'Avery Chen', email: '' },
        attendees: [
          { name: 'Avery Chen', email: ' ' },
          { name: 'Alex Kim', email: 'alex@example.com' },
        ],
      },
    ])
    expect(ics).not.toContain('ORGANIZER')
    expect(ics).not.toContain('Avery Chen')
    expect(ics).toContain('ATTENDEE;CN=Alex Kim;RSVP=TRUE:mailto:alex@example.com')
    expect(ics).not.toContain('URL:')
  })

  it('publishes by default, with no SEQUENCE or STATUS unless given', () => {
    const ics = buildICS([{ uid: 'i-3', title: 'Intro call', start: '2026-10-13T17:00:00.000Z' }])
    expect(ics).toContain('METHOD:PUBLISH\r\n')
    expect(ics).not.toContain('SEQUENCE:')
    expect(ics).not.toContain('STATUS:')
  })

  it('writes a cancellation with METHOD:CANCEL, the same UID, a higher SEQUENCE and STATUS:CANCELLED', () => {
    const ics = buildICS([{ uid: 'i-3-candidate', title: 'Cancelled: Intro call', start: '2026-10-13T17:00:00.000Z', sequence: 1, status: 'CANCELLED' }], 'Interview', {
      method: 'CANCEL',
    })
    expect(ics).toContain('METHOD:CANCEL\r\n')
    expect(ics).not.toContain('METHOD:PUBLISH')
    expect(ics).toContain('UID:i-3-candidate@first-twenty\r\n')
    expect(ics).toContain('SEQUENCE:1\r\n')
    expect(ics).toContain('STATUS:CANCELLED\r\n')
  })
})
