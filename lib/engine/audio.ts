// Main-thread AAC encoding for the clip soundtrack. Runs on the page (not the
// worker) because WebKit exposes AudioEncoder on Window before workers; the
// worker just muxes the ready-made chunks.

export interface EncodedSound {
  chunks: { data: Uint8Array; type: 'key' | 'delta'; timestamp: number; duration: number }[];
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig from the encoder — the muxer needs it for the esds box. */
  description?: Uint8Array;
}

/**
 * Loop/trim the PCM to totalSeconds with fade-in/out and AAC-encode it.
 * Returns null when the browser can't encode audio.
 */
export async function encodeSoundtrack(
  channels: Float32Array[],
  sampleRate: number,
  totalSeconds: number,
): Promise<EncodedSound | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  if (!channels.length || !channels[0].length) return null;

  const ch = channels.length;
  const srcLen = channels[0].length;
  const total = Math.ceil(totalSeconds * sampleRate);
  const fadeIn = Math.round(0.3 * sampleRate);
  const fadeOut = Math.min(total, Math.round(1.5 * sampleRate));

  const out: EncodedSound = { chunks: [], sampleRate, numberOfChannels: ch };
  let failed: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.chunks.push({
        data,
        type: chunk.type === 'key' ? 'key' : 'delta',
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? Math.round((1024 / sampleRate) * 1_000_000),
      });
      const desc = meta?.decoderConfig?.description;
      if (desc && !out.description) {
        const view = ArrayBuffer.isView(desc)
          ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
          : new Uint8Array(desc as ArrayBuffer);
        out.description = view.slice(); // independent copy, safe to transfer
      }
    },
    error: (e) => {
      failed = e;
    },
  });

  try {
    encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: ch, bitrate: 128_000 });
    const CHUNK = 4800;
    for (let off = 0; off < total; off += CHUNK) {
      if (failed) throw failed;
      const n = Math.min(CHUNK, total - off);
      const data = new Float32Array(ch * n);
      for (let c = 0; c < ch; c++) {
        const src = channels[c];
        for (let i = 0; i < n; i++) {
          const gi = off + i;
          let v = src[gi % srcLen]; // loop if the clip outlasts the track
          if (gi < fadeIn) v *= gi / fadeIn;
          const fromEnd = total - gi;
          if (fromEnd < fadeOut) v *= fromEnd / fadeOut;
          data[c * n + i] = v;
        }
      }
      const frame = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: ch,
        timestamp: Math.round((off / sampleRate) * 1_000_000),
        data,
      });
      encoder.encode(frame);
      frame.close();
    }
    await encoder.flush();
    encoder.close();
  } catch {
    try {
      encoder.close();
    } catch {
      // already closed
    }
    return null;
  }
  if (failed || out.chunks.length === 0) return null;
  // Safari's encoder may omit decoderConfig.description; without an
  // AudioSpecificConfig in the mp4's esds box, iOS players won't decode the
  // track (Chrome tolerates it). Synthesize the 2-byte AAC-LC config.
  if (!out.description) out.description = audioSpecificConfig(sampleRate, ch);
  return out;
}

const AAC_FREQ_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
};

function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const freqIndex = AAC_FREQ_INDEX[sampleRate] ?? 4;
  // 5 bits object type (2 = AAC-LC) · 4 bits freq index · 4 bits channels · 3 bits zero
  const bits = (2 << 11) | (freqIndex << 7) | (channels << 3);
  return new Uint8Array([bits >> 8, bits & 0xff]);
}
