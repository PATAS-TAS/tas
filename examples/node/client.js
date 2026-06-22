const https = require('https');

const API_KEY = process.env.TAS_API_KEY || 'your-api-key';
const BASE_URL = process.env.TAS_BASE_URL || 'https://tas.fly.dev';

function classify(text, lang = 'en') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text, lang });
    const url = new URL(`${BASE_URL}/v1/classify`);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

classify('Earn $1000/day working from home! Click https://scam.com')
  .then(result => {
    console.log(`Spam: ${result.spam}`);
    console.log(`Score: ${result.score}`);
    console.log(`Reasons:`, result.reasons);
  })
  .catch(console.error);

