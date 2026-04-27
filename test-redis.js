const Redis = require('ioredis');

const url = "rediss://default:gQAAAAAAAXA4AAIgcDJhNmU2MWFmZWExMTE0MDNmOWZmMjhhMjVkY2M4NzNiMw@national-termite-94264.upstash.io:6379";
console.log("Connecting to Redis...");
const redis = new Redis(url, { maxRetriesPerRequest: 3 });

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
  process.exit(1);
});

redis.on('connect', () => {
  console.log('Connected successfully!');
  redis.ping().then(res => {
    console.log('PING ->', res);
    process.exit(0);
  });
});
