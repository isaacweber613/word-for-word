/**
 * Audio as the app makes it, and as a hand-made request could, for the tests: Ogg Opus laid out like the app's OggWriter
 * and WAV like its WavWriter. No other imports, so the unit tests can use it without starting the local run.
 */

/** Ogg's page checksum (polynomial 0x04c11db7, not reflected), as the app's OggWriter.crc. */
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

function oggPage(packets: Buffer[], granule: bigint, seq: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    for (; n >= 255; n -= 255) lacing.push(255);
    lacing.push(n);
  }
  const head = Buffer.alloc(27);
  head.write("OggS", 0);
  head[5] = flags;
  head.writeBigUInt64LE(granule, 6);
  head.writeUInt32LE(0x57464f57, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = lacing.length;
  const page = Buffer.concat([head, Buffer.from(lacing), ...packets]);
  let c = 0;
  for (const b of page) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b) & 0xff]) >>> 0;
  page.writeUInt32LE(c, 22);
  return page;
}

/**
 * [seconds] of Ogg Opus laid out the way the app's OggWriter writes it: the two header pages, then 20 ms packets of
 * [packetBytes] bytes each, 50 to a page. The app's 24 kbit/s is about 60 bytes a packet; its own encoder makes
 * silence about 3 bytes a packet, and a hand-made file can use 1.
 */
export function oggOpus(seconds: number, packetBytes = 60): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0);
  head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(16000, 12);
  const vendor = Buffer.from("Word for Word");
  const tags = Buffer.concat([Buffer.from("OpusTags"), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.alloc(4)]);
  const pages = [oggPage([head], 0n, 0, 2), oggPage([tags], 0n, 1, 0)];
  const packet = Buffer.alloc(packetBytes, 1);
  packet[0] = 9 << 3;   // SILK wideband, one 20 ms frame (RFC 6716 3.1)
  const n = Math.round(seconds * 50);
  let granule = 312n;
  for (let i = 0; i < n; i += 50) {
    const chunk = Array.from({ length: Math.min(50, n - i) }, () => packet);
    granule += BigInt(chunk.length * 960);
    pages.push(oggPage(chunk, granule, pages.length, i + 50 >= n ? 4 : 0));
  }
  return Buffer.concat(pages);
}

/** A 16-bit mono WAV of silence whose header says [rate] samples a second (the app's WavWriter always says 16,000). */
export function wav(seconds: number, rate = 16000): Buffer {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

/**
 * [audio] (a WAV) with the 4 bytes that start an S/PDIF burst (IEC 61937 sync words Pa, Pb) at each of [at] in its sound.
 * Twice in a PCM WAV's first 64 KB of sound, ffmpeg plays the bursts as the compressed sound in them.
 */
export function withSyncs(audio: Buffer, ...at: number[]): Buffer {
  const b = Buffer.from(audio);
  for (const i of at) b.set([0x72, 0xf8, 0x1f, 0x4e], 44 + i);
  return b;
}
