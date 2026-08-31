import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBulkRecipients, clampBulkCampaignBatchSize, parseBulkRecipients } from './bulkRecipients.ts';

test('parses one recipient per line, trimming whitespace and dropping blanks', () => {
  const text = '  +62 812-3456-78  \n\n628987654321@c.us\n   \n1203630000@g.us';
  assert.deepEqual(parseBulkRecipients(text), ['62812345678@c.us', '628987654321@c.us', '1203630000@g.us']);
});

test('normalizes bare phone numbers to @c.us chat IDs', () => {
  assert.deepEqual(parseBulkRecipients('+1 (555) 010-2233'), ['15550102233@c.us']);
});

test('passes full chat IDs through untouched', () => {
  assert.deepEqual(parseBulkRecipients('123@lid\n4567890-1234@g.us'), ['123@lid', '4567890-1234@g.us']);
});

test('de-dupes entries that normalize to the same chat ID', () => {
  const text = '+62 812 3456 78\n62812345678\n62812345678@c.us';
  assert.deepEqual(parseBulkRecipients(text), ['62812345678@c.us']);
});

test('drops lines with neither an @ nor any digits instead of sending "@c.us"', () => {
  assert.deepEqual(parseBulkRecipients('not-a-number\n---\n628123456789'), ['628123456789@c.us']);
});

test('returns an empty list for empty input', () => {
  assert.deepEqual(parseBulkRecipients(''), []);
  assert.deepEqual(parseBulkRecipients('  \n \n'), []);
});

test('clamps campaign batch size to the 10-30 UI range', () => {
  assert.equal(clampBulkCampaignBatchSize(1), 10);
  assert.equal(clampBulkCampaignBatchSize(10), 10);
  assert.equal(clampBulkCampaignBatchSize(24.9), 24);
  assert.equal(clampBulkCampaignBatchSize(30), 30);
  assert.equal(clampBulkCampaignBatchSize(99), 30);
  assert.equal(clampBulkCampaignBatchSize(Number.NaN), 10);
});

test('chunks recipients by the clamped campaign batch size', () => {
  const recipients = Array.from({ length: 35 }, (_, index) => `${index + 1}@c.us`);

  assert.deepEqual(
    chunkBulkRecipients(recipients, 12).map(chunk => chunk.length),
    [12, 12, 11],
  );
  assert.deepEqual(
    chunkBulkRecipients(recipients, 50).map(chunk => chunk.length),
    [30, 5],
  );
});
