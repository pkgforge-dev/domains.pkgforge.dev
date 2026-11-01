// DOM-024 close, read with no credential: state:latest's manifest and its artifact type, and the state- tags.
import { ghcrReader } from '@domains/ghcr';
const r = ghcrReader({ userAgent: 'domains.pkgforge.dev DOM-024 prove' });
const m = await r.getManifest('pkgforge-dev/domains.pkgforge.dev/state', 'latest');
const j = m.json as { artifactType?: string; mediaType?: string; layers?: { annotations?: Record<string, string>; size: number }[]; annotations?: Record<string, string> };
console.log(`state:latest ${m.digest} from ${m.from} mediaType ${j.mediaType} artifactType ${j.artifactType}`);
for (const l of j.layers ?? []) console.log(`  layer ${l.annotations?.['org.opencontainers.image.title']} ${l.size}`);
for (const [k, v] of Object.entries(j.annotations ?? {})) console.log(`  annotation ${k}=${v.slice(0, 120)}`);
