import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';

/** Test-only ICE candidate relay. Drop real RTP packets without depending on
 * DevTools HTTP throttling, which may leave loopback WebRTC unaffected. */
export async function mediaNetwork() {
  const sockets = [createSocket('udp4'), createSocket('udp4')];
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve)),
    ),
  );
  const endpoints: Array<{ host: string; port: number } | undefined> = [];
  let dropping = false;
  let received = 0;
  let packets = 0;
  let dropped = 0;
  for (let side = 0; side < 2; side++) {
    sockets[side]!.on('message', (packet, remote) => {
      endpoints[side] = { host: remote.address, port: remote.port };
      packets++;
      const target = endpoints[1 - side];
      if (!target) return;
      // RTP/RTCP has version 2. ICE/STUN and DTLS remain available so this
      // fixture isolates a media outage from control or authentication loss.
      if ((packet[0]! & 0xc0) === 0x80) {
        received++;
        if (dropping) {
          dropped++;
          return;
        }
      }
      sockets[1 - side]!.send(packet, target.port, target.host);
    });
  }
  return {
    rewrite(sdp: string, side: number) {
      let candidate: string[] | undefined;
      const lines = sdp.split('\r\n').filter((line) => {
        if (!line.startsWith('a=candidate:')) return true;
        const fields = line.split(' ');
        if (
          !candidate &&
          fields[2]?.toLowerCase() === 'udp' &&
          /^\d+\.\d+\.\d+\.\d+$/.test(fields[4]!)
        )
          candidate = fields;
        return false;
      });
      assert.ok(
        candidate,
        'The isolated fixture must gather a UDP IPv4 ICE candidate',
      );
      candidate[4] = '127.0.0.1';
      candidate[5] = String((sockets[1 - side]!.address() as AddressInfo).port);
      // The fixture has one bundled video m-line.
      lines.splice(lines.length - 1, 0, candidate.join(' '));
      return lines.join('\r\n');
    },
    drop(active: boolean) {
      dropping = active;
    },
    stats() {
      return { received, dropped, packets, endpoints };
    },
    close() {
      for (const socket of sockets) socket.close();
    },
  };
}
