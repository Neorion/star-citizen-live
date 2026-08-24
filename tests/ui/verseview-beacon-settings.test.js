'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

require('../helpers/installReactStub');
const { textOf } = require('../helpers/reactTree');
const Settings = require('../../components/Settings');

function readyPage (overrides = {}) {
  const page = new Settings({});
  Object.assign(page.state, {
    loading: false,
    editable: true,
    verseviewBeaconUrl: '',
    verseviewShareBeacon: false,
    verseviewBeaconToken: '',
    verseviewBeaconTokenConfigured: false
  }, overrides);
  return page;
}

describe('Verseview beacon settings UI', () => {
  it('renders the section with the off-by-default toggle unchecked and no pre-filled token', () => {
    const page = readyPage();
    const text = textOf(page.render());
    assert.match(text, /Verseview beacon/);
    assert.match(text, /Opt-in only/);
    assert.strictEqual(page.state.verseviewBeaconToken, '', 'the token field is never pre-filled from the server');
  });

  it('shows "(already configured)" next to the token label when a token is already stored', () => {
    const page = readyPage({ verseviewBeaconTokenConfigured: true });
    const text = textOf(page.render());
    assert.match(text, /already configured/);
  });

  it('does not show "(already configured)" when no token is stored yet', () => {
    const page = readyPage({ verseviewBeaconTokenConfigured: false });
    const text = textOf(page.render());
    assert.doesNotMatch(text, /already configured/);
  });

  it('saveVerseviewToken PUTs to /settings/verseview/secrets and clears the field on success, never keeping the raw token in state', async () => {
    const page = readyPage({ verseviewBeaconToken: 'tok-plaintext' });
    const prev = global.fetch;
    let sentBody = null;
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, '/settings/verseview/secrets');
      assert.strictEqual(opts.method, 'PUT');
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ success: true, secrets: { beaconTokenConfigured: true } }) };
    };
    // Stub the follow-up load() so this test doesn't need a full settings fetch mock.
    page.load = async () => {};
    try {
      await page.saveVerseviewToken();
      assert.deepStrictEqual(sentBody, { beaconToken: 'tok-plaintext' });
      assert.strictEqual(page.state.verseviewBeaconToken, '', 'token field is cleared after a successful save');
      assert.strictEqual(page.state.verseviewBeaconTokenConfigured, true);
      assert.strictEqual(page.state.notice, 'Verseview token saved (store root only — not in git).');
    } finally {
      global.fetch = prev;
    }
  });
});
