import { afterEach, describe, expect, it } from 'vitest'
import process from 'node:process'
import { formatDate, formatTime, formatFullTimestamp, formatMessageTimestamp, isSameDayInTimeZone } from './datetime.js'

const originalTimeZone = process.env.TZ
afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
})

describe('absolute timestamps in an explicit time zone', () => {
  it('uses Shanghai time rather than the agent browser time zone', () => {
    process.env.TZ = 'America/Los_Angeles'
    const timestamp = '2026-11-13T16:18:00Z'
    expect(formatMessageTimestamp(timestamp, 'Asia/Shanghai')).toBe('2026-11-14 00:18')
    expect(formatFullTimestamp(timestamp, 'Asia/Shanghai')).toBe('2026-11-14 00:18')
    expect(formatFullTimestamp(timestamp, 'UTC')).toBe('2026-11-13 16:18')
  })

  it('uses 00 at midnight and 24-hour afternoon times', () => {
    expect(formatTime('2026-11-13T16:00:00Z', 'Asia/Shanghai')).toBe('00:00')
    expect(formatFullTimestamp('2026-11-14T06:05:00Z', 'Asia/Shanghai')).toBe('2026-11-14 14:05')
  })

  it('compares calendar days in the same zone used to display messages', () => {
    const beforeMidnight = '2026-11-13T15:59:00Z'
    const afterMidnight = '2026-11-13T16:01:00Z'
    expect(isSameDayInTimeZone(beforeMidnight, afterMidnight, 'Asia/Shanghai')).toBe(false)
    expect(isSameDayInTimeZone(beforeMidnight, afterMidnight, 'UTC')).toBe(true)
    expect(formatDate(afterMidnight, 'Asia/Shanghai')).toBe('2026-11-14')
    expect(isSameDayInTimeZone(afterMidnight, '2026-11-14T01:00:00Z', 'Asia/Shanghai')).toBe(true)
  })

  it('respects daylight saving transitions instead of using a fixed offset', () => {
    expect(formatFullTimestamp('2026-03-08T06:59:00Z', 'America/New_York')).toBe('2026-03-08 01:59')
    expect(formatFullTimestamp('2026-03-08T07:01:00Z', 'America/New_York')).toBe('2026-03-08 03:01')
  })

  it('uses UTC for missing and invalid settings, and trims a valid setting', () => {
    process.env.TZ = 'Asia/Kolkata'
    const timestamp = new Date('2026-11-13T16:18:00Z')
    for (const zone of [undefined, null, '', ' ', 'Invalid/Zone']) {
      expect(formatFullTimestamp(timestamp, zone)).toBe('2026-11-13 16:18')
    }
    expect(formatFullTimestamp(timestamp, ' Asia/Shanghai ')).toBe('2026-11-14 00:18')
  })

  it('does not display epoch dates for absent timestamps or throw on invalid dates', () => {
    for (const timestamp of [null, undefined, '', 'invalid', new Date(NaN)]) {
      expect(formatFullTimestamp(timestamp, 'Asia/Shanghai')).toBe('')
      expect(formatDate(timestamp, 'Asia/Shanghai')).toBe('')
      expect(isSameDayInTimeZone(timestamp, timestamp, 'Asia/Shanghai')).toBe(false)
    }
  })
})
