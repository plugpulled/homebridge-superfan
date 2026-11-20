import Bonjour from 'bonjour-service';
import { isIPv4 } from 'node:net';

/** True when an mDNS instance name belongs to the fan, e.g. "fan_<deviceId>" or "fan_<deviceId> (2)". */
export function matchesFan(serviceName: string, deviceId: string): boolean {
  const base = serviceName.toLowerCase().replace(/\s+\(\d+\)$/, '');
  return base === `fan_${deviceId.toLowerCase()}`;
}

/**
 * Browse `_http._tcp` for the fan and return its first IPv4 address, or undefined after the timeout.
 * Never throws: socket errors (e.g. port 5353 unavailable) resolve to undefined.
 */
export function findFanViaMdns(
  deviceId: string,
  timeoutMs = 5_000,
  createBonjour: () => Bonjour = () => new Bonjour(),
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let bonjour: Bonjour | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (host: string | undefined): void => {
      if (timer) clearTimeout(timer);
      try {
        bonjour?.destroy();
      } catch {
        // ignore
      }
      bonjour = undefined;
      resolve(host);
    };
    try {
      bonjour = createBonjour();
      // bonjour-service never listens for errors on its multicast-dns socket; an unhandled
      // 'error' event (EADDRINUSE/EACCES) would crash the whole Homebridge process.
      (bonjour as unknown as { server?: { mdns?: NodeJS.EventEmitter } }).server?.mdns?.on('error', () => finish(undefined));
      bonjour.find({ type: 'http' }, (service) => {
        if (!matchesFan(service.name, deviceId)) return;
        const ipv4 = [...(service.addresses ?? []), service.referer?.address ?? ''].find((a) => isIPv4(a));
        if (ipv4) finish(ipv4);
      });
      timer = setTimeout(() => finish(undefined), timeoutMs);
    } catch {
      finish(undefined);
    }
  });
}

/** Pick a fan's host: config override, then cloud-reported IP, then mDNS, then the last host that worked. */
export async function resolveHost(o: {
  override?: string;
  cloudHost?: string;
  lastHost?: string;
  mdns: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  if (o.override) return o.override;
  if (o.cloudHost) return o.cloudHost;
  return (await o.mdns()) ?? o.lastHost;
}
