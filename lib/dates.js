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

module.exports = { MONTHS, monthIndex, isRealDate };
