function pad2(value: number): string
{
  return String(value).padStart(2, "0");
}

/**
 * Formats an ISO datetime-like string to local time in "YYYY-MM-DD HH:mm".
 * Falls back to the original input if parsing fails.
 */
export function formatDateTime(isoString: string): string
{
  if (!isoString)
  {
    return "";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime()))
  {
    return isoString;
  }

  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Formats a datetime range as "YYYY-MM-DD HH:mm → YYYY-MM-DD HH:mm".
 * If both values resolve to the same minute, returns a single datetime.
 */
export function formatDateTimeRange(firstDateTime: string, lastDateTime: string): string
{
  const first = formatDateTime(firstDateTime);
  const last = formatDateTime(lastDateTime);
  if (!first && !last)
  {
    return "";
  }
  if (!first)
  {
    return last;
  }
  if (!last)
  {
    return first;
  }
  if (first === last)
  {
    return first;
  }
  return `${first} → ${last}`;
}