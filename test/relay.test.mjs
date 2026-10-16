/**
 * Tests for the relay client.
 *
 * `lib/relay.js` reads no config and holds no state, so it can be exercised
 * with nothing but a stubbed `fetch` — no DSH host, no network, no API key:
 *
 *     npm test
 *
 * The response-shape cases are the point of this file. The plugin deliberately
 * does not assume which of the three shapes a relay returns, and these tests
 * are what keep that promise honest.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { RelayError, requestImage } from '../lib/relay.js';

/** A realistic 1x1 PNG header plus filler, used wherever bytes are needed. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Build a minimal `Response` stand-in.
 *
 * @param {object} spec - response shape.
 * @param {number} [spec.status] - HTTP status.
 * @param {string} [spec.statusText] - HTTP status text.
 * @param {string} [spec.contentType] - value for the content-type header.
 * @param {Buffer|string} [spec.body] - body bytes.
 * @returns {object} an object satisfying what `requestImage` uses.
 */
function fakeResponse({ status = 200, statusText = 'OK', contentType = '', body = Buffer.alloc(0) }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** Install a fetch stub that records the calls it received. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return calls;
}

/** The minimal arguments `requestImage` needs. */
const base = { baseUrl: 'https://relay.test/v1', model: 'm', apiKey: 'k', prompt: 'p' };

test('raw image bytes are returned as-is', async () => {
  const calls = stubFetch(() => fakeResponse({ contentType: 'image/png', body: PNG_BYTES }));
  const out = await requestImage(base);

  assert.equal(out.shape, 'binary');
  assert.equal(out.ext, '.png');
  assert.deepEqual(out.bytes, PNG_BYTES);
  assert.equal(calls[0].url, 'https://relay.test/v1/images/generations');
});

test('a trailing slash in baseUrl does not double up', async () => {
  const calls = stubFetch(() => fakeResponse({ contentType: 'image/png', body: PNG_BYTES }));
  await requestImage({ ...base, baseUrl: 'https://relay.test/v1/' });
  assert.equal(calls[0].url, 'https://relay.test/v1/images/generations');
});

test('the request body is exactly model/prompt/size', async () => {
  const calls = stubFetch(() => fakeResponse({ contentType: 'image/png', body: PNG_BYTES }));
  await requestImage({ ...base, size: '1024x1024' });

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'm',
    prompt: 'p',
    size: '1024x1024',
  });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
});

test('size is omitted when not supplied', async () => {
  const calls = stubFetch(() => fakeResponse({ contentType: 'image/png', body: PNG_BYTES }));
  await requestImage(base);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)), ['model', 'prompt']);
});

test('JSON b64_json is decoded', async () => {
  const encoded = PNG_BYTES.toString('base64');
  stubFetch(() =>
    fakeResponse({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: encoded }] }) }),
  );
  const out = await requestImage(base);

  assert.equal(out.shape, 'b64_json');
  assert.deepEqual(out.bytes, PNG_BYTES);
});

test('a data: URL in b64_json is tolerated', async () => {
  const encoded = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  stubFetch(() =>
    fakeResponse({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: encoded }] }) }),
  );
  const out = await requestImage(base);

  assert.equal(out.shape, 'b64_json');
  assert.deepEqual(out.bytes, PNG_BYTES);
});

test('a JSON url is downloaded', async () => {
  const calls = stubFetch((url) =>
    url === 'https://cdn.test/a.png'
      ? fakeResponse({ contentType: 'image/png', body: PNG_BYTES })
      : fakeResponse({ contentType: 'application/json', body: JSON.stringify({ data: [{ url: 'https://cdn.test/a.png' }] }) }),
  );
  const out = await requestImage(base);

  assert.equal(out.shape, 'url');
  assert.deepEqual(out.bytes, PNG_BYTES);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://cdn.test/a.png');
});

test('JSON detected by first byte, not just content-type', async () => {
  const encoded = PNG_BYTES.toString('base64');
  stubFetch(() =>
    fakeResponse({ contentType: 'text/plain', body: JSON.stringify({ data: [{ b64_json: encoded }] }) }),
  );
  const out = await requestImage(base);
  assert.equal(out.shape, 'b64_json');
});

test('a non-2xx response becomes a coded RelayError quoting the body', async () => {
  stubFetch(() =>
    fakeResponse({ status: 401, statusText: 'Unauthorized', contentType: 'application/json', body: '{"error":"bad key"}' }),
  );
  await assert.rejects(requestImage(base), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, 'HTTP_401');
    assert.equal(error.status, 401);
    assert.match(error.message, /401 Unauthorized/);
    assert.match(error.message, /bad key/);
    return true;
  });
});

test('an empty body is rejected', async () => {
  stubFetch(() => fakeResponse({ contentType: 'image/png', body: Buffer.alloc(0) }));
  await assert.rejects(requestImage(base), (error) => error.code === 'EMPTY_BODY');
});

test('unparsable JSON is reported, not thrown raw', async () => {
  stubFetch(() => fakeResponse({ contentType: 'application/json', body: '{not json' }));
  await assert.rejects(requestImage(base), (error) => error.code === 'BAD_JSON');
});

test('JSON without data[0] is reported', async () => {
  stubFetch(() => fakeResponse({ contentType: 'application/json', body: JSON.stringify({ data: [] }) }));
  await assert.rejects(requestImage(base), (error) => error.code === 'NO_DATA');
});

test('JSON with neither b64_json nor url is reported', async () => {
  stubFetch(() => fakeResponse({ contentType: 'application/json', body: JSON.stringify({ data: [{}] }) }));
  await assert.rejects(requestImage(base), (error) => error.code === 'NO_IMAGE');
});

test('an unknown content type is reported with the type and a body excerpt', async () => {
  stubFetch(() => fakeResponse({ contentType: 'text/html', body: '<html>proxy error</html>' }));
  await assert.rejects(requestImage(base), (error) => {
    assert.equal(error.code, 'UNKNOWN_SHAPE');
    assert.match(error.message, /text\/html/);
    assert.match(error.message, /proxy error/);
    return true;
  });
});

test('a transport failure becomes NETWORK', async () => {
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };
  await assert.rejects(requestImage(base), (error) => {
    assert.equal(error.code, 'NETWORK');
    assert.match(error.message, /socket hang up/);
    return true;
  });
});

test('an abort is rethrown untouched, so callers can tell cancel from timeout', async () => {
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(requestImage(base), (error) => error.name === 'AbortError');
});
