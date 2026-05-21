/**
 * @module dateParser
 * @description Parses relative and natural date expressions into ISO-8601 format.
 * Handles expressions like "today", "yesterday", "last Friday", "2 days ago", etc.
 */

/**
 * Day-of-week mapping (case-insensitive match).
 */
const DAYS_OF_WEEK = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Normalize a date expression to ISO-8601 (YYYY-MM-DD).
 * @param {string} dateStr - Raw date string from AI extraction.
 * @param {Date} [referenceDate] - Reference date for relative calculations (defaults to now).
 * @returns {{ date: string|null, confidence: number }}
 */
function parseDate(dateStr, referenceDate = new Date()) {
  if (!dateStr || typeof dateStr !== 'string') {
    return { date: null, confidence: 0 };
  }

  const input = dateStr.trim().toLowerCase();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return { date: input, confidence: 1.0 };
  }

  // Common date formats: DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY
  const slashDate = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashDate) {
    const [, a, b, year] = slashDate;
    // Assume DD/MM/YYYY for Pakistan locale
    const day = parseInt(a, 10);
    const month = parseInt(b, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(parseInt(year, 10), month - 1, day);
      return { date: formatISO(d), confidence: 0.9 };
    }
  }

  const ref = new Date(referenceDate);

  // "today"
  if (input === 'today' || input === 'aaj' || input === 'this morning' || input === 'this evening') {
    return { date: formatISO(ref), confidence: 0.98 };
  }

  // "yesterday" / "kal" (past context)
  if (input === 'yesterday' || input === 'kal') {
    ref.setDate(ref.getDate() - 1);
    return { date: formatISO(ref), confidence: 0.97 };
  }

  // "tomorrow"
  if (input === 'tomorrow') {
    ref.setDate(ref.getDate() + 1);
    return { date: formatISO(ref), confidence: 0.95 };
  }

  // "N days/weeks/months ago"
  const agoMatch = input.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+ago$/);
  if (agoMatch) {
    const num = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    if (unit.startsWith('day')) {
      ref.setDate(ref.getDate() - num);
    } else if (unit.startsWith('week')) {
      ref.setDate(ref.getDate() - num * 7);
    } else if (unit.startsWith('month')) {
      ref.setMonth(ref.getMonth() - num);
    }
    return { date: formatISO(ref), confidence: 0.92 };
  }

  // "last week" / "this week"
  if (input === 'last week') {
    ref.setDate(ref.getDate() - 7);
    return { date: formatISO(ref), confidence: 0.8 };
  }
  if (input === 'this week') {
    return { date: formatISO(ref), confidence: 0.75 };
  }

  // "last month"
  if (input === 'last month') {
    ref.setMonth(ref.getMonth() - 1);
    return { date: formatISO(ref), confidence: 0.75 };
  }

  // "last <dayOfWeek>" e.g. "last friday"
  const lastDayMatch = input.match(/^last\s+(\w+)$/);
  if (lastDayMatch) {
    const targetDay = DAYS_OF_WEEK[lastDayMatch[1]];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let diff = currentDay - targetDay;
      if (diff <= 0) diff += 7;
      ref.setDate(ref.getDate() - diff);
      return { date: formatISO(ref), confidence: 0.9 };
    }
  }

  // "this <dayOfWeek>"
  const thisDayMatch = input.match(/^this\s+(\w+)$/);
  if (thisDayMatch) {
    const targetDay = DAYS_OF_WEEK[thisDayMatch[1]];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let diff = targetDay - currentDay;
      if (diff < 0) diff += 7;
      ref.setDate(ref.getDate() + diff);
      return { date: formatISO(ref), confidence: 0.85 };
    }
  }

  // Try native Date.parse as fallback
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) {
    return { date: formatISO(new Date(parsed)), confidence: 0.7 };
  }

  return { date: null, confidence: 0 };
}

/**
 * Format a Date object into ISO-8601 date string (YYYY-MM-DD).
 */
function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { parseDate, formatISO };
