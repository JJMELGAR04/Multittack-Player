// Generates a synthetic multitrack song with a KNOWN tempo and structure, used
// by the engine tests and the E2E test. Nothing here is real music; it only
// needs to behave like a band arrangement (repeated verses/choruses, a
// distinct bridge, a click track, sections with different energy).
//
// Usage: node tools/generate-test-song.mjs <output-dir>
// Output: <dir>/song/{Click,Drums,Bass,Keys,Lead}.wav + <dir>/song/manifest.json
//         <dir>/short/{Tone,Pulse}.wav (2 short stems at 48 kHz for quick tests)
//         <dir>/Prueba 96bpm.zip (the song as a zip; the drums file is named
//         "llmmD.wav" on purpose, to test that the user is asked what it is)
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node tools/generate-test-song.mjs <output-dir>");
  process.exit(2);
}

const VERSION = 5; // bump when the generated material changes
const SR = 44100;
const BPM = 96;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;

const STRUCTURE = [
  { kind: "intro", bars: 4, chords: ["C", "G", "Am", "F"] },
  { kind: "verse", bars: 8, chords: ["Am", "F", "C", "G", "Am", "F", "C", "G"] },
  { kind: "chorus", bars: 8, chords: ["F", "G", "Em", "Am", "F", "G", "C", "C"] },
  { kind: "verse", bars: 8, chords: ["Am", "F", "C", "G", "Am", "F", "C", "G"] },
  { kind: "chorus", bars: 8, chords: ["F", "G", "Em", "Am", "F", "G", "C", "C"] },
  { kind: "bridge", bars: 8, chords: ["Dm", "Bb", "Dm", "Bb", "Eb", "Bb", "D", "D"] },
  { kind: "chorus", bars: 8, chords: ["F", "G", "Em", "Am", "F", "G", "C", "C"] },
  { kind: "outro", bars: 4, chords: ["C", "F", "C", "C"] },
];

const NOTE = { C: 0, "C#": 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, "F#": 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
function chordNotes(name) {
  const minor = name.endsWith("m");
  const root = NOTE[minor ? name.slice(0, -1) : name];
  return [root, root + (minor ? 3 : 4), root + 7];
}
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Deterministic noise.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

const totalBars = STRUCTURE.reduce((s, x) => s + x.bars, 0);
const LEN = Math.ceil((totalBars * BAR + 1.0) * SR);

function track(channels) {
  return Array.from({ length: channels }, () => new Float32Array(LEN));
}

function writeWav(path, chans, sampleRate = SR) {
  const n = chans[0].length;
  const ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * ch * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  writeFileSync(path, buf);
}

function addTone(dst, start, dur, hz, amp, { decay = 0, harmonics = [1], attack = 0.005, release = 0.02, pan = 0 } = {}) {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  const gains = dst.length === 2 ? [amp * Math.cos((pan + 1) * Math.PI / 4), amp * Math.sin((pan + 1) * Math.PI / 4)] : [amp];
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    let env = Math.min(1, t / attack) * Math.min(1, (dur - t) / release);
    if (decay > 0) env *= Math.exp(-t / decay);
    let v = 0;
    harmonics.forEach((h, k) => (v += (Math.sin(2 * Math.PI * hz * (k + 1) * t) * h)));
    for (let c = 0; c < dst.length; c++) dst[c][s0 + i] += v * env * gains[c];
  }
}

function addNoise(dst, start, dur, amp, decay, { hp = 0 } = {}) {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  let prev = 0;
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    let v = rnd();
    if (hp) { const x = v; v = x - prev; prev = x; }
    const env = Math.exp(-t / decay);
    for (let c = 0; c < dst.length; c++) dst[c][s0 + i] += v * amp * env;
  }
}

function addKick(dst, start, amp) {
  const s0 = Math.floor(start * SR);
  let phase = 0;
  for (let i = 0; i < 0.35 * SR && s0 + i < LEN; i++) {
    const t = i / SR;
    const hz = 50 + 90 * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * hz) / SR;
    const v = Math.sin(phase) * Math.exp(-t / 0.12) * amp;
    for (let c = 0; c < dst.length; c++) dst[c][s0 + i] += v;
  }
}

function generateSong(dir) {
  const click = track(1), drums = track(2), bass = track(1), keys = track(2), lead = track(2);
  const sections = [];
  let bar = 0;

  for (const sec of STRUCTURE) {
    sections.push({ kind: sec.kind, startSec: bar * BAR, bars: sec.bars });
    const energy = { intro: 0.35, verse: 0.6, chorus: 1.0, bridge: 0.7, outro: 0.3 }[sec.kind];

    for (let b = 0; b < sec.bars; b++, bar++) {
      const t0 = bar * BAR;
      const notes = chordNotes(sec.chords[b]);

      // Click: every beat, accented downbeat.
      for (let beat = 0; beat < 4; beat++)
        addTone(click, t0 + beat * BEAT, 0.05, beat === 0 ? 1600 : 1000, beat === 0 ? 0.6 : 0.4, { decay: 0.012, attack: 0.0005 });

      // Keys: sustained chord, brighter in the bridge.
      const harm = sec.kind === "bridge" ? [1, 0.7, 0.5, 0.4, 0.3] : [1, 0.3, 0.1];
      notes.forEach((n, k) =>
        addTone(keys, t0, BAR, midiHz(60 + n), 0.09 * (0.5 + energy * 0.5), { harmonics: harm, attack: 0.08, release: 0.15, pan: k - 1 }));

      if (sec.kind !== "intro" && sec.kind !== "outro") {
        // Bass: root eighths (quarters in the bridge).
        const step = sec.kind === "bridge" ? BEAT : BEAT / 2;
        for (let t = 0; t < BAR - 1e-6; t += step)
          addTone(bass, t0 + t, step * 0.9, midiHz(36 + notes[0]), 0.35 * energy, { harmonics: [1, 0.5, 0.25], decay: 0.4 });

        // Drums.
        if (sec.kind === "bridge") {
          addKick(drums, t0, 0.7);
          addNoise(drums, t0 + 2 * BEAT, 0.2, 0.25, 0.05, { hp: 1 });
        } else {
          for (let beat = 0; beat < 4; beat++) {
            if (beat % 2 === 0) addKick(drums, t0 + beat * BEAT, 0.6 + 0.3 * energy);
            else addNoise(drums, t0 + beat * BEAT, 0.25, 0.35 * energy, 0.07);
            for (let h = 0; h < 2; h++) addNoise(drums, t0 + beat * BEAT + h * BEAT / 2, 0.06, 0.12 * energy, 0.015, { hp: 1 });
          }
          if (sec.kind === "chorus" && b === 0) addNoise(drums, t0, 1.5, 0.3, 0.5, { hp: 1 }); // crash
        }

        // Lead melody in choruses only.
        if (sec.kind === "chorus") {
          const melody = [notes[2], notes[1], notes[0], notes[1]];
          melody.forEach((n, k) => addTone(lead, t0 + k * BEAT, BEAT * 0.95, midiHz(72 + n), 0.12, { harmonics: [1, 0.4, 0.2], attack: 0.02 }));
        }
      }
    }
  }

  mkdirSync(dir, { recursive: true });
  writeWav(join(dir, "Click.wav"), click);
  writeWav(join(dir, "Drums.wav"), drums);
  writeWav(join(dir, "Bass.wav"), bass);
  writeWav(join(dir, "Keys.wav"), keys);
  writeWav(join(dir, "Lead.wav"), lead);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: VERSION, bpm: BPM, sampleRate: SR, barSec: BAR, durationSec: LEN / SR, sections }, null, 2),
  );
}

// Two short stems at 48 kHz: a sine and a pulse train with an impulse every
// 0.5 s at exact sample positions (used for sync / seek precision tests).
function generateShort(dir) {
  const sr = 48000, len = sr * 8;
  const tone = new Float32Array(len), pulse = new Float32Array(len);
  for (let i = 0; i < len; i++) tone[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr);
  for (let i = 0; i < len; i += sr / 2) pulse[i] = 0.9;
  mkdirSync(dir, { recursive: true });
  writeWav(join(dir, "Tone.wav"), [tone], sr);
  writeWav(join(dir, "Pulse.wav"), [pulse], sr);
}

// Minimal zip writer (stored, no compression) - enough for test fixtures.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function writeZip(path, entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, ...central, end]));
}

function generateZip(dir) {
  const song = join(dir, "song");
  const entries = [
    ["Click.wav", "Prueba/Click.wav"],
    ["Drums.wav", "Prueba/llmmD.wav"], // meaningless name: the importer must ask
    ["Bass.wav", "Prueba/Bass.wav"],
    ["Keys.wav", "Prueba/Keys.wav"],
    ["Lead.wav", "Prueba/Lead.wav"],
  ].map(([src, name]) => ({ name, data: readFileSync(join(song, src)) }));
  entries.push({ name: "__MACOSX/Prueba/._Click.wav", data: Buffer.from("junk") });
  entries.push({ name: "Prueba/LEEME.txt", data: Buffer.from("not audio") });
  writeZip(join(dir, "Prueba 96bpm.zip"), entries);
}

const manifest = join(outDir, "song", "manifest.json");
if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === VERSION) {
  console.log(`test audio up to date in ${outDir}`);
} else {
  generateSong(join(outDir, "song"));
  generateShort(join(outDir, "short"));
  generateZip(outDir);
  console.log(`generated test audio in ${outDir}`);
}
