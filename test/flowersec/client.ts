import {
  connectPrivateLoopbackV1,
  parsePrivateLoopbackArtifactV1,
  createPrivateLoopbackArtifactLeaseV1,
  type ByteStream,
} from '@floegence/flowersec-core/browser';
import { MediaSender } from '../../src/host/media-carrier.js';
const qualify = async () => {
  let spent = false;
  const artifact = parsePrivateLoopbackArtifactV1(
    await (await fetch('artifact')).text(),
  );
  const lease = createPrivateLoopbackArtifactLeaseV1(artifact, async () => {
    if (spent) throw Error('Lease reused');
    spent = true;
  });
  const session = await connectPrivateLoopbackV1(lease, {
    origin: location.origin,
  });
  const control = await session.openStream('qualification/control');
  const writeAll = async (stream: ByteStream, bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) {
      const count = await stream.write(bytes.subarray(offset));
      if (count < 1) throw Error('Zero write');
      offset += count;
    }
  };
  const ping = async (value = 1) => {
    const start = performance.now();
    await control.write(new Uint8Array([value]), {
      signal: AbortSignal.timeout(4000),
    });
    const response = await control.read({ signal: AbortSignal.timeout(4000) });
    if (response?.length !== 1 || response[0] !== value)
      throw Error('Mismatched control acknowledgement');
    return performance.now() - start;
  };
  const p95 = (values: number[]) =>
    values.toSorted((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
  const baseline = [];
  for (let i = 0; i < 25; i++) baseline.push(await ping());
  await ping(2);
  const media = await session.openStream('qualification/media');
  let written = 0,
    maxChunk = 0,
    consumed = 0,
    keyframes = 0;
  const sender = new MediaSender(
    async (chunk) => {
      maxChunk = Math.max(maxChunk, chunk.length);
      let offset = 0;
      while (offset < chunk.length) {
        const n = await media.write(chunk.subarray(offset));
        if (n < 1) throw Error('Zero write');
        offset += n;
        written += n;
      }
    },
    () => keyframes++,
    {
      windowBytes: 128 * 1024,
      windowPackets: 4,
      queuedBytes: 256 * 1024,
      queuedPackets: 4,
      ageMs: 100,
    },
  );
  let closing = false;
  let mediaError: unknown;
  const acknowledgement = (async () => {
    let buffer = new Uint8Array(8),
      offset = 0;
    while (true) {
      const bytes = await media.read();
      if (!bytes) return;
      for (const value of bytes) {
        buffer[offset++] = value;
        if (offset === 8) {
          consumed = Number(new DataView(buffer.buffer).getBigUint64(0));
          sender.acknowledge(consumed);
          offset = 0;
        }
      }
    }
  })().catch((error) => {
    if (!closing) mediaError = error;
  });
  let sequence = 0;
  const payload = new Uint8Array(48 * 1024);
  const produce = () =>
    sender.push({
      header: {
        version: 1,
        target: 'source',
        view: 'authorized-view',
        stream: 'video',
        node: 1,
        track: 'video',
        codec: 'vp8',
        timestamp_us: ++sequence * 40000,
        duration_us: 40000,
        keyframe: true,
        width: 160,
        height: 90,
        bytes: payload.length,
      },
      data: payload,
    });
  const timer = setInterval(produce, 4);
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await delay(180);
    const stalledAt = written;
    await delay(180);
    const stalledBytes = written,
      stalledStable = stalledAt === written;
    const loaded = [];
    const resource = await session.openStream('qualification/resource');
    let resourceError: unknown;
    const resourceWrite = (async () => {
      const chunk = new Uint8Array(16 * 1024);
      for (let i = 0; i < 512; i++) await writeAll(resource, chunk);
      await resource.closeWrite();
    })().catch((error) => {
      resourceError = error;
    });
    for (let i = 0; i < 40; i++) loaded.push(await ping());
    await resourceWrite;
    if (resourceError) throw resourceError;
    let received = new Uint8Array(8),
      offset = 0;
    while (offset < 8) {
      const data = await resource.read();
      if (!data) throw Error('Missing resource receipt');
      received.set(data, offset);
      offset += data.length;
    }
    const resourceBytes = Number(new DataView(received.buffer).getBigUint64(0));
    await resource.close();
    await ping(3);
    const deadline = performance.now() + 4000;
    while (consumed < 8 && performance.now() < deadline) await delay(10);
    const resumed = consumed >= 8;
    const stalled = await session.openStream('qualification/stalled');
    let canceled = false,
      finished = false;
    const writer = (async () => {
      try {
        const chunk = new Uint8Array(16 * 1024);
        for (let i = 0; i < 4096; i++) await writeAll(stalled, chunk);
      } catch {
        canceled = true;
      } finally {
        finished = true;
      }
    })();
    await delay(100);
    const blocked = !finished;
    const resetAt = performance.now();
    await stalled.reset();
    await Promise.race([
      writer,
      delay(3000).then(() => {
        if (!finished) throw Error('Canceled writer did not settle');
      }),
    ]);
    const cancelMs = performance.now() - resetAt;
    for (let i = 0; i < 10; i++) loaded.push(await ping());
    if (mediaError) throw mediaError;
    return {
      baselineP95: p95(baseline),
      loadedP95: p95(loaded),
      stalledStable,
      stalledBytes,
      maxChunk,
      resourceBytes,
      resumed,
      blocked,
      canceled,
      cancelMs,
      keyframes,
    };
  } finally {
    closing = true;
    clearInterval(timer);
    sender.close();
    await session.close();
    await acknowledgement;
  }
};

Object.assign(window, { qualify });
