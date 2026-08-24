'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const verseviewConfig = require('../../functions/verseviewConfig');

function tmpDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('verseviewConfig', () => {
  it('readSecretsFile returns {} when no file exists yet', () => {
    const dir = tmpDir('sc-verseview-cfg-none-');
    try {
      assert.deepStrictEqual(verseviewConfig.readSecretsFile(dir), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeSecretsFile persists the token and readSecretsFile reads it back', () => {
    const dir = tmpDir('sc-verseview-cfg-write-');
    try {
      const summary = verseviewConfig.writeSecretsFile(dir, { beaconToken: 'tok-xyz' });
      assert.strictEqual(summary.beaconTokenConfigured, true);
      assert.deepStrictEqual(verseviewConfig.readSecretsFile(dir), { beaconToken: 'tok-xyz' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an empty string clears the token', () => {
    const dir = tmpDir('sc-verseview-cfg-clear-');
    try {
      verseviewConfig.writeSecretsFile(dir, { beaconToken: 'tok-xyz' });
      const summary = verseviewConfig.writeSecretsFile(dir, { beaconToken: '' });
      assert.strictEqual(summary.beaconTokenConfigured, false);
      assert.deepStrictEqual(verseviewConfig.readSecretsFile(dir), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omitting the key leaves an existing token unchanged', () => {
    const dir = tmpDir('sc-verseview-cfg-omit-');
    try {
      verseviewConfig.writeSecretsFile(dir, { beaconToken: 'tok-xyz' });
      verseviewConfig.writeSecretsFile(dir, {});
      assert.deepStrictEqual(verseviewConfig.readSecretsFile(dir), { beaconToken: 'tok-xyz' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws without a settingsDir', () => {
    assert.throws(() => verseviewConfig.writeSecretsFile(null, { beaconToken: 'x' }), /settingsDir required/);
  });
});
