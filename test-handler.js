const handler = require('./api/index.js');
const req = { url: '/', method: 'GET', headers: {} };
const res = {
  statusCode: 200,
  setHeader: (k, v) => console.log('Set header', k, v),
  end: (msg) => console.log('Response ended:', msg),
  status: function(code) { this.statusCode = code; return this; },
  json: function(obj) { console.log('JSON Response:', obj); }
};
handler(req, res);
