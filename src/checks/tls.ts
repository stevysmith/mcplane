import { connect } from 'node:tls';
import type { Check } from '../types.js';

/** Some review networks only speak TLS 1.2. */
export function tls12Check(url: string): Promise<Check> {
  const host = new URL(url).hostname;
  return new Promise((resolve) => {
    const sock = connect({ host, port: 443, servername: host, maxVersion: 'TLSv1.2', timeout: 8000 }, () => {
      sock.end();
      resolve({ id: 'server.tls12', level: 'pass', title: 'A TLS 1.2 client can connect' });
    });
    const bad = (why: string) =>
      resolve({ id: 'server.tls12', level: 'warn', title: 'A TLS 1.2 client can connect', detail: why, fix: 'Allow TLS 1.2; some corporate and review proxies cannot do TLS 1.3.' });
    sock.on('error', (e) => bad(e.message));
    sock.on('timeout', () => {
      sock.destroy();
      bad('timed out');
    });
  });
}
