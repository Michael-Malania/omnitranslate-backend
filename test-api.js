const http = require('http');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- 1. Testing Health ---');
  let res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/health',
    method: 'GET'
  });
  console.log('Health:', res.status, res.data);

  console.log('\n--- 2. Testing Developer Login (malaniamichael@gmail.com) ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'malaniamichael@gmail.com',
    displayName: 'Michael Malania',
    photoUrl: 'https://lh3.googleusercontent.com/a/default-user',
    platform: 'desktop'
  });
  console.log('Developer Login:', res.status, JSON.stringify(res.data, null, 2));

  console.log('\n--- 3. Testing Regular User Login (test.learner@gmail.com) ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'test.learner@gmail.com',
    displayName: 'Test Learner',
    platform: 'mobile'
  });
  console.log('User Login:', res.status, JSON.stringify(res.data, null, 2));

  console.log('\n--- 4. Testing Usage Recording for Free User (1st translation) ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/usage/record',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'test.learner@gmail.com',
    seconds: 5,
    chars: 120,
    platform: 'mobile'
  });
  console.log('Usage Record:', res.status, JSON.stringify(res.data, null, 2));

  console.log('\n--- 5. Testing Profile Query (Free User) ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/user/profile?email=test.learner@gmail.com',
    method: 'GET'
  });
  console.log('Profile Query:', res.status, JSON.stringify(res.data, null, 2));

  console.log('\n--- 6. Testing Developer Bypass Toggle ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/user/toggle-developer-bypass',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'malaniamichael@gmail.com',
    enabled: true
  });
  console.log('Developer Bypass Toggle:', res.status, JSON.stringify(res.data, null, 2));

  console.log('\n--- 7. Testing Platform Aggregate Metrics (Render Postgres) ---');
  res = await request({
    host: 'localhost',
    port: 5050,
    path: '/api/metrics/summary',
    method: 'GET'
  });
  console.log('Platform Metrics:', res.status, JSON.stringify(res.data, null, 2));
}

runTests().catch(console.error);
