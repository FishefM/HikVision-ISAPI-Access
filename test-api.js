const axios = require('axios');

const targetUrl = process.env.TEST_API_URL || 'http://localhost:3000/api/mock-external-api/allow';
console.log(`Sending request via Axios to ${targetUrl}...`);
axios.get(targetUrl, {
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
