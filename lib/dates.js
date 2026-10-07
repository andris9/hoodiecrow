'use strict';

// Month names of the RFC 3501 section 9 date-month rule, in the case they are sent in
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Returns the index of a month name, ignoring case like all ABNF strings
 *
 * @param {String} name Three letter month name, e.g. "jan"
 * @return {Number} 0 for January to 11 for December, or -1 for an unknown name
 */
function monthIndex(name) {
    const value = String(name || '').toLowerCase();
    return MONTHS.findIndex(month => month.toLowerCase() === value);
}

/**
 * Checks if day, month and year make a real date
 *
 * @param {Number|String} day Day of the month
 * @param {Number} month Month index, 0 for January
 * @param {Number|String} year Full year
 * @return {Boolean} true if the date exists
 */
function isRealDate(day, month, year) {
    day = Number(day);
    year = Number(year);
    if (month < 0 || month > 11 || !Number.isInteger(day) || day < 1) {
        return false;
    }
    return day <= new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Converts day, month and year to a comparable YYYY-MM-DD string
 *
 * @param {Number|String} day Day of the month
 * @param {Number} month Month index, 0 for January
 * @param {Number|String} year Full year
 * @return {String|Boolean} the date, or false for an impossible date
 */
function dateKey(day, month, year) {
    if (!isRealDate(day, month, year)) {
        return false;
    }
    return String(year).padStart(4, '0') + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/**
 * Parses a date-time value of the RFC 3501 section 9 form, like an INTERNALDATE ("14-Sep-2013 21:22:28 -0300").
 * A value with only the date part is accepted as well, its time fields are left undefined
 *
 * @param {String} value Date-time value
 * @return {Object|null} `{ day, month, year, hours, minutes, seconds, zone }` with the month index, or null
 */
function parseDateTime(value) {
    const match = (value || '').toString().match(/^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}))?/);
    if (!match || !isRealDate(match[1], monthIndex(match[2]), match[3])) {
        return null;
    }
    const time = match[4] === undefined ? {} : { hours: Number(match[4]), minutes: Number(match[5]), seconds: Number(match[6]), zone: match[7] };
    return Object.assign({ day: Number(match[1]), month: monthIndex(match[2]), year: Number(match[3]) }, time);
}

/**
 * Parses the date-time of a Date header (RFC 5322 section 3.3, with the obsolete forms of section 4.3: comments,
 * two and three digit years, zone names). SEARCH uses only the date as written (RFC 3501 section 6.4.4), SORT
 * normalizes date and time to UTC with toTimestamp (RFC 5256 section 2.2), so both read the header with this
 *
 * @param {String} header Value of the Date header
 * @return {Object|null} `{ day, month, year, hours, minutes, seconds, zone }` with the month index, or null if the
 *   header has no valid date. The time fields are undefined when the header has no time
 */
function parseHeaderDate(header) {
    const match = (header || '')
        .toString()
        .replace(/\([^()]*\)/g, ' ')
        .match(/^\s*(?:[A-Za-z]+\s*,)?\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})(?:\s+(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?(?:\s+([+-]\d{4}|[A-Za-z]+))?)?/);
    if (!match) {
        return null;
    }
    let year = Number(match[3]);
    // RFC 5322 section 4.3: two digit years below 50 are 20xx, three digit years add 1900
    if (match[3].length === 2) {
        year += year < 50 ? 2000 : 1900;
    } else if (match[3].length === 3) {
        year += 1900;
    }
    const day = Number(match[1]);
    const month = monthIndex(match[2]);
    if (!isRealDate(day, month, year)) {
        return null;
    }
    const time = match[4] === undefined ? {} : { hours: Number(match[4]), minutes: Number(match[5]), seconds: Number(match[6] || 0), zone: match[7] };
    return Object.assign({ day, month, year }, time);
}

// RFC 5322 section 4.3 obsolete zones, military zones are treated as "-0000"
const ZONES = { UT: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

/**
 * Converts date and time parts to milliseconds since the epoch, adjusted by the time zone. An unknown zone is UTC
 *
 * @param {Object} date `{ day, month, year, hours, minutes, seconds, zone }`, see parseDateTime and parseHeaderDate
 * @return {Number} timestamp
 */
function toTimestamp(date) {
    const zone = date.zone || '';
    let offset = 0;
    if (/^[+-]\d{4}$/.test(zone)) {
        const sign = zone.charAt(0) === '-' ? -1 : 1;
        const zoneHours = Number(zone.substr(1, 2));
        const zoneMinutes = Number(zone.substr(3, 2));
        if (zoneMinutes < 60) {
            offset = sign * (zoneHours * 60 + zoneMinutes);
        }
    } else if (Object.hasOwn(ZONES, zone.toUpperCase())) {
        offset = ZONES[zone.toUpperCase()] * 60;
    }
    return Date.UTC(date.year, date.month, date.day, date.hours || 0, date.minutes || 0, date.seconds || 0) - offset * 60 * 1000;
}

module.exports = { MONTHS, monthIndex, isRealDate, dateKey, parseDateTime, parseHeaderDate, toTimestamp };
