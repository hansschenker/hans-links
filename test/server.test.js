const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HISTORY_FILE_PATTERN,
  extractLinks,
  extractUrls,
  historyDateFromFileName,
  serializeDailyLinks,
  serializeLink,
} = require('../server');

function historyHtml(data) {
  const payload = Buffer.from(encodeURIComponent(JSON.stringify(data)), 'utf8').toString('base64');
  return `<script>const decodedString = safeDecode('${payload}');</script>`;
}

test('recognizes supported history filenames', () => {
  assert.equal(HISTORY_FILE_PATTERN.test('history-2026-10-21.html'), true);
  assert.equal(HISTORY_FILE_PATTERN.test('history_2026-10-21.html'), true);
  assert.equal(HISTORY_FILE_PATTERN.test('history-2026-1-2.html'), false);
});

test('extracts and cleans browser history links', () => {
  const links = extractLinks(historyHtml([
    { title: '<b>A, useful</b>\npage', url: 'https://example.com/path' },
    { title: 'Unsafe', url: 'javascript:alert(1)' },
  ]));

  assert.deepEqual(links, [{ title: 'A, useful page', url: 'https://example.com/path' }]);
});

test('finds saved URLs and serializes a link', () => {
  const text = '[Title](https://example.com/one)\nSecond, https://example.com/two\n';
  assert.deepEqual([...extractUrls(text)], ['https://example.com/one', 'https://example.com/two']);
  assert.equal(
    serializeLink({ title: 'Hello, [world]', url: 'https://example.com/' }),
    '[Hello, \\[world\\]](https://example.com/)',
  );
  assert.equal(
    serializeLink({ title: '', url: 'https://example.com/no-title' }),
    '[https://example.com/no-title](https://example.com/no-title)',
  );
});

test('gets the import date from a supported history filename', () => {
  assert.equal(historyDateFromFileName('history_2026-10-26.html'), '2026-10-26');
  assert.equal(historyDateFromFileName('history-2026-10-21.html'), '2026-10-21');
  assert.equal(historyDateFromFileName('other.html'), null);
});

test('groups imported links under source dates with the newest date first', () => {
  assert.equal(
    serializeDailyLinks([
      { title: 'Older', url: 'https://example.com/older', sourceFile: 'history_2026-10-21.html' },
      { title: 'Newest', url: 'https://example.com/newest', sourceFile: 'history-2026-10-26.html' },
      { title: 'Same day', url: 'https://example.com/same-day', sourceFile: 'history_2026-10-26.html' },
    ]),
    [
      '## 2026-10-26',
      '',
      '[Newest](https://example.com/newest)',
      '[Same day](https://example.com/same-day)',
      '',
      '## 2026-10-21',
      '',
      '[Older](https://example.com/older)',
    ].join('\n'),
  );
});
