'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { beaconPayload } = require('../../functions/beaconPost');

describe('beaconPost', () => {
  describe('beaconPayload', () => {
    it('trims a destination and wraps it as location_code', () => {
      const payload = beaconPayload('  Lorville  ');
      assert.deepStrictEqual(payload, { location_code: 'Lorville' });
    });

    it('passes through an untrimmed QT waypoint codename unchanged aside from trimming', () => {
      const payload = beaconPayload('rs_ext_cru-leo1');
      assert.deepStrictEqual(payload, { location_code: 'rs_ext_cru-leo1' });
    });

    it('returns null for an empty string', () => {
      assert.strictEqual(beaconPayload(''), null);
    });

    it('returns null for whitespace-only input', () => {
      assert.strictEqual(beaconPayload('   '), null);
    });

    it('returns null for null', () => {
      assert.strictEqual(beaconPayload(null), null);
    });

    it('returns null for undefined', () => {
      assert.strictEqual(beaconPayload(undefined), null);
    });

    it('does not validate or map the destination — passes through whatever string it is given', () => {
      // Verseview's own exact-match lookup is authoritative; this module must
      // not invent a mapping table or fuzzy-match layer.
      const payload = beaconPayload('SomeUnknownPlaceNameXYZ');
      assert.deepStrictEqual(payload, { location_code: 'SomeUnknownPlaceNameXYZ' });
    });
  });
});
