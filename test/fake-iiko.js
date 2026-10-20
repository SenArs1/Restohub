// Фейковый iikoCloud для интеграционных тестов. Состояние меняется через state.
import { createServer } from 'node:http';
import { externalMenu, ORG } from './fixtures.js';

export async function startFakeIiko(t) {
  const state = { price: 420, nomPrice: 420, down: false, stop: [], calls: [] };
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push(req.url);
    if (state.down) { res.writeHead(503); return res.end('{}'); }
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/img/cake.jpg') { res.writeHead(200); return res.end('JPEG'); }
    if (req.url === '/api/1/access_token') return send({ token: 'tkn' });
    if (req.headers.authorization !== 'Bearer tkn') { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/api/1/organizations') return send({ organizations: [{ id: ORG, name: 'Madi Cake' }] });
    if (req.url === '/api/2/menu') return send({ externalMenus: [{ id: 'menu-1', name: 'Madi Cake' }], priceCategories: [] });
    if (req.url === '/api/1/nomenclature') {
      return send({ products: [{ id: 'p-1', name: 'Медовик', sizePrices: [{ sizeId: null, price: { currentPrice: state.nomPrice } }] }] });
    }
    if (req.url === '/api/1/stop_lists') {
      return send({ terminalGroupStopLists: [{ organizationId: ORG, items: [{ terminalGroupId: 'tg', items: state.stop.map((productId) => ({ productId, balance: 0 })) }] }] });
    }
    if (req.url === '/api/2/menu/by_id') {
      const m = externalMenu(state.price);
      m.itemCategories[0].items[0].itemSizes[0].buttonImageUrl = `${url}/img/cake.jpg`;
      return send(m);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => srv.close());
  return { url, state };
}

export const testConfig = (dataDir, apiUrl) => ({
  demo: false, dataDir, publicDir: new URL('../public', import.meta.url).pathname, cacheImages: true,
  restaurantName: 'Madi Cake', currency: '₽', idleSeconds: 90, syncIntervalMin: 60, stopListIntervalSec: 60,
  adminToken: 'tok', cookieSecure: false,
  iiko: { apiLogin: 'key', apiUrl, organizationName: 'Madi Cake', externalMenuName: 'Madi Cake' },
});
