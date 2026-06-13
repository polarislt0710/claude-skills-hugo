const http = require('http');
const https = require('https');
const { URL } = require('url');

function baseUrl() {
  return process.env.CRONICLE_BASE_URL || 'http://127.0.0.1:3012';
}
function apiKey() {
  return process.env.CRONICLE_API_KEY || '';
}

function call(endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + endpoint);
    const payload = JSON.stringify(body);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-API-Key': apiKey(),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`Cronicle ${endpoint} HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.code && parsed.code !== 0) {
              return reject(new Error(`Cronicle ${endpoint} code=${parsed.code}: ${parsed.description || data.slice(0, 200)}`));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Cronicle ${endpoint} bad JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('Cronicle request timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  createEvent: (e) => call('/api/app/create_event/v1', e),
  updateEvent: (e) => call('/api/app/update_event/v1', e),
  deleteEvent: (id) => call('/api/app/delete_event/v1', { id }),
  listEvents: () => call('/api/app/get_schedule/v1', { limit: 200, offset: 0 }),
  getEvent: (id) => call('/api/app/get_event/v1', { id }),
  runEvent: (id) => call('/api/app/run_event/v1', { id }),
  hasKey: () => Boolean(apiKey()),
};
