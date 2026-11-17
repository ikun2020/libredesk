export function compareMessageEditTimes (left, right) {
  if (!left || !right) return Number(Boolean(left)) - Number(Boolean(right))
  const wholeMilliseconds = Date.parse(left) - Date.parse(right)
  if (wholeMilliseconds) return wholeMilliseconds
  const fraction = value => Number((value.match(/\.(\d+)/)?.[1] || '').padEnd(9, '0').slice(3, 9))
  return fraction(left) - fraction(right)
}
