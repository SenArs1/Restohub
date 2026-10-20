import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IikoClient } from '../server/iiko.js';

async function fakeIiko(t) {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/1/access_token') {
      return send(403, { errorDescription: 'This API key does not support /api/1/access_token. Please use /api/v2/access_token instead.' });
    }
    if (req.url === '/api/v2/access_token') return send(200, { token: 'v2-token' });
    if (req.url === '/api/1/organizations') return send(200, { organizations: [{ id: 'o', name: 'Madi Cake' }] });
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

test('ключ нового формата: токен через /api/v2/access_token', async (t) => {
  const { url, seen } = await fakeIiko(t);
  const client = new IikoClient({ apiLogin: 'key', clientSecret: 'secret', appId: 'app', apiUrl: url });
  assert.deepEqual(await client.organizations(), [{ id: 'o', name: 'Madi Cake' }]);
  assert.deepEqual(seen[0], { url: '/api/v2/access_token', body: { apiKey: 'key', clientSecret: 'secret', appId: 'app' }, auth: undefined });
  assert.equal(seen[1].auth, 'Bearer v2-token');
});

test('ключ нового формата без секрета: понятная ошибка', async (t) => {
  const { url } = await fakeIiko(t);
  const client = new IikoClient({ apiLogin: 'key', apiUrl: url });
  await assert.rejects(client.getToken(), /IIKO_CLIENT_SECRET и IIKO_APP_ID/);
});
