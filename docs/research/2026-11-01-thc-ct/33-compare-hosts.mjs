// Compare each host's complete gzip for the same day. Pass the bucket path
// as listed, since its directories do not always match the file's own date.
import { createHash } from 'node:crypto';
import { USER_AGENT } from '../../../scripts/lib/user-agent.mjs';

const [path, ...extra] = process.argv.slice(2);
const day = /^\d{4}\/\d{1,2}\/(\d{4}-\d{2}-\d{2})\.txt\.gz$/.exec(path)?.[1];
if (!day || extra.length > 0) {
  console.error('usage: node docs/research/2026-11-01-thc-ct/33-compare-hosts.mjs BUCKET_PATH');
  process.exit(2);
}

async function hashFile(host, url) {
  const response = await fetch(url, {
    headers: { 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(900_000),
  });
  const encoding = response.headers.get('content-encoding');
  if (response.status !== 200 || !response.body || (encoding && encoding !== 'identity')) {
    throw new Error(`${host}: HTTP ${response.status}, content encoding ${encoding}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  const length = response.headers.get('content-length');
  if (length === null || bytes !== Number(length) || bytes === 0) {
    throw new Error(`${host}: Content-Length ${length}, received ${bytes} B`);
  }
  return { host, bytes, sha256: hash.digest('hex') };
}

try {
  const cs2 = await hashFile('cs2', `https://cs2.ip.thc.org/${day}.txt.gz`);
  const bucket = await hashFile('hf', `https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/${path}?download=true`);
  const equal = cs2.bytes === bucket.bytes && cs2.sha256 === bucket.sha256;
  console.log(JSON.stringify({ day, path, cs2, bucket, equal }));
  if (!equal) process.exitCode = 1;
} catch (error) {
  console.error(`compare hosts: ${error.message}`);
  process.exitCode = 2;
} finally {
  console.error(`conditions ${JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: process.platform })}`);
}
