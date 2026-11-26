'use strict';

const { expect } = require('chai');
const { parseCommandValue } = require('./commandValue');

describe('parseCommandValue', () => {
  it('parses a schedule JSON string into an object', () => {
    const schedule = { mon: [{ start: '04:00', end: '21:00', mode: 'normal' }] };
    expect(parseCommandValue(JSON.stringify(schedule))).to.deep.equal(schedule);
  });

  it('parses a JSON array string into an array', () => {
    expect(parseCommandValue('[1,2]')).to.deep.equal([1, 2]);
  });

  it('keeps invalid JSON as text', () => {
    expect(parseCommandValue('{not json')).to.equal('{not json');
  });

  it('converts numeric strings to numbers', () => {
    expect(parseCommandValue('19')).to.equal(19);
    expect(parseCommandValue(19)).to.equal(19);
  });

  it('keeps booleans as booleans', () => {
    expect(parseCommandValue(true)).to.equal(true);
    expect(parseCommandValue(false)).to.equal(false);
  });

  it('keeps plain text and empty values unchanged', () => {
    expect(parseCommandValue('standby')).to.equal('standby');
    expect(parseCommandValue('')).to.equal('');
    expect(parseCommandValue(null)).to.equal(null);
  });
});
