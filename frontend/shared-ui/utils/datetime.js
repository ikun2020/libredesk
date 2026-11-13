import { differenceInMinutes, differenceInHours, differenceInDays, differenceInMonths, differenceInYears } from 'date-fns'

export function getRelativeTime (timestamp, now = new Date()) {
  try {
    const mins = differenceInMinutes(now, timestamp)
    const hours = differenceInHours(now, timestamp)
    const days = differenceInDays(now, timestamp)
    const months = differenceInMonths(now, timestamp)
    const years = differenceInYears(now, timestamp)

    if (mins === 0) return 'now'
    if (mins < 60) return `${mins}m`
    if (hours < 24) return `${hours}h`
    if (days < 31) return `${days}d`
    if (months < 12) return `${months}mo`
    return `${years}y`
  } catch (error) {
    console.error('Error parsing time', error, 'timestamp', timestamp)
    return ''
  }
}

export const formatDuration = (seconds, showSeconds = true) => {
  const totalSeconds = Math.floor(seconds)
  if (totalSeconds < 60) return `${totalSeconds}s`
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  const hours = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60
  return `${hours}h ${mins}m ${showSeconds ? `${secs}s` : ''}`
}

const timestampFormatters = new Map()

function getTimestampFormatter (timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC'
  if (timestampFormatters.has(zone)) return timestampFormatters.get(zone)

  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
  } catch {
    // Missing or obsolete zone settings must not silently use the agent's zone.
    formatter = getTimestampFormatter('UTC')
  }
  if (timestampFormatters.size >= 16) timestampFormatters.delete(timestampFormatters.keys().next().value)
  timestampFormatters.set(zone, formatter)
  return formatter
}

function timestampParts (time, timeZone) {
  if (time === null || time === undefined || time === '') return null
  const date = time instanceof Date ? time : new Date(time)
  if (!Number.isFinite(date.getTime())) return null
  return Object.fromEntries(getTimestampFormatter(timeZone).formatToParts(date).map(({ type, value }) => [type, value]))
}

export const formatDate = (time, timeZone = 'UTC') => {
  const parts = timestampParts(time, timeZone)
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : ''
}

export const formatTime = (time, timeZone = 'UTC') => {
  const parts = timestampParts(time, timeZone)
  return parts ? `${parts.hour}:${parts.minute}` : ''
}

export const formatFullTimestamp = (time, timeZone = 'UTC') => {
  const parts = timestampParts(time, timeZone)
  return parts ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` : ''
}

export const formatMessageTimestamp = formatFullTimestamp

export const isSameDayInTimeZone = (first, second, timeZone = 'UTC') => {
  const date = formatDate(first, timeZone)
  return date !== '' && date === formatDate(second, timeZone)
}
