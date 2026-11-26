'use strict';

/**
 * Converts the value written to a single-parameter setValue state into the value sent to the API.
 *
 * ioBroker stores state values as primitives, so a Schedule or other object parameter arrives as a
 * JSON string. The API rejects it with "The parameter should be an object", so JSON objects and
 * arrays are parsed. Numeric strings become numbers, as before. Booleans stay booleans, because
 * Number(true) would send 1 to boolean parameters such as setActive.
 *
 * @param {ioBroker.StateValue} value value of the setValue state
 * @returns {any} value for the request body
 */
function parseCommandValue(value) {
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (typeof value === 'boolean' || value === null || value === '') {
    return value;
  }
  if (!isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

module.exports = { parseCommandValue };
