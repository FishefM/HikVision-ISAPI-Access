const axios = require('axios');

console.log('Sending request via Axios with Chrome User-Agent and headers...');
axios.get('https://multihivesoft.com/api/attendance/scan/cda21c1ff7a426acadf323eb0261da3949c98ffb00f2c016f1ecbb29c57f4d56', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  },
  timeout: 10000
})
  .then(res => {
    console.log('Axios Success with headers!');
    console.log('Status:', res.status);
    console.log('Data:', res.data);
  })
  .catch(err => {
    console.error('Axios Error with headers:', err.message);
  });
