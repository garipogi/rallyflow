/**
 * Ceremony sound effects, synthesized on the fly with WebAudio: no audio files, nothing from the
 * network. Created on the organizer's click (Start ceremony), so the browser never blocks it and the
 * room never hears a surprise. Only the organizer window plays sound (both windows share one
 * computer, and so one speaker).
 */
export class CeremonySound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rollTimer: number | null = null;
  private rollNext = 0;
  private rollStart = 0;
  private rollLength = 0;
  private muted = false;

  /** Call from a click handler. */
  start(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.8;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;
    master.connect(limiter).connect(ctx.destination);
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.master = master;
    this.noise = buffer;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    if (muted) this.stopRoll();
  }

  pause(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  close(): void {
    this.stopRoll();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private ready(): { ctx: AudioContext; out: GainNode; noise: AudioBuffer } | null {
    if (!this.ctx || !this.master || !this.noise || this.muted) return null;
    return { ctx: this.ctx, out: this.master, noise: this.noise };
  }

  private noiseHit(at: number, opts: { type: BiquadFilterType; freq: number; q?: number; gain: number; decay: number; attack?: number }): void {
    const r = this.ready();
    if (!r) return;
    const src = r.ctx.createBufferSource();
    src.buffer = r.noise;
    const filter = r.ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q ?? 0.8;
    const env = r.ctx.createGain();
    const attack = opts.attack ?? 0.002;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + opts.decay);
    src.connect(filter).connect(env).connect(r.out);
    src.start(at, Math.random() * 1.5);
    src.stop(at + attack + opts.decay + 0.05);
  }

  private tone(at: number, freq: number, opts: { type?: OscillatorType; gain: number; decay: number; attack?: number; to?: number; filter?: number }): void {
    const r = this.ready();
    if (!r) return;
    const osc = r.ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.decay);
    const env = r.ctx.createGain();
    const attack = opts.attack ?? 0.005;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(opts.gain, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + opts.decay);
    let node: AudioNode = osc;
    if (opts.filter) {
      const lp = r.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = opts.filter;
      node = osc.connect(lp);
    }
    node.connect(env).connect(r.out);
    osc.start(at);
    osc.stop(at + attack + opts.decay + 0.05);
  }

  /** A soft whoosh as a title card arrives. */
  whoosh(): void {
    const r = this.ready();
    if (!r) return;
    const at = r.ctx.currentTime;
    const src = r.ctx.createBufferSource();
    src.buffer = r.noise;
    const bp = r.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, at);
    bp.frequency.exponentialRampToValueAtTime(3200, at + 0.55);
    const env = r.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.35, at + 0.25);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
    src.connect(bp).connect(env).connect(r.out);
    src.start(at);
    src.stop(at + 0.75);
    this.tone(at + 0.05, 880, { type: 'triangle', gain: 0.08, decay: 0.6 });
    this.tone(at + 0.12, 1318, { type: 'triangle', gain: 0.06, decay: 0.7 });
  }

  /**
   * Snare drumroll that speeds up and swells over `lengthMs`, then keeps rolling (sustain) until
   * stopRoll(): the host reveals when the room is ready.
   */
  drumroll(lengthMs: number): void {
    const r = this.ready();
    if (!r) return;
    this.stopRoll();
    this.rollStart = r.ctx.currentTime + 0.05;
    this.rollNext = this.rollStart;
    this.rollLength = Math.max(1, lengthMs / 1000);
    let count = 0;
    const schedule = (): void => {
      const now = this.ctx?.currentTime ?? 0;
      while (this.rollNext < now + 0.25) {
        const p = Math.min(1, (this.rollNext - this.rollStart) / this.rollLength);
        const interval = 0.13 - 0.095 * p + (Math.random() - 0.5) * 0.006;
        const gain = 0.08 + 0.32 * p * p;
        this.noiseHit(this.rollNext, { type: 'bandpass', freq: 1900 + Math.random() * 300, q: 0.7, gain, decay: 0.07 });
        if (count % 4 === 0) this.tone(this.rollNext, 92, { gain: 0.1 + 0.25 * p, decay: 0.22, to: 70 });
        count++;
        this.rollNext += interval;
      }
    };
    schedule();
    this.rollTimer = window.setInterval(schedule, 60);
  }

  stopRoll(): void {
    if (this.rollTimer !== null) window.clearInterval(this.rollTimer);
    this.rollTimer = null;
  }

  /** Cymbal crash, a boom and a brass "ta-da"; applause follows. */
  reveal(big = false): void {
    const r = this.ready();
    if (!r) return;
    this.stopRoll();
    const at = r.ctx.currentTime + 0.02;
    this.noiseHit(at, { type: 'highpass', freq: 5200, gain: big ? 0.6 : 0.45, decay: big ? 3 : 2.2 });
    this.noiseHit(at, { type: 'bandpass', freq: 9000, q: 0.5, gain: 0.25, decay: 1.4 });
    this.tone(at, 70, { gain: 0.7, decay: 0.9, to: 38 });
    const chord = big ? [261.6, 329.6, 392, 523.3, 659.3] : [329.6, 415.3, 493.9, 659.3];
    // Ta-da: two short pickups then the held chord.
    chord.forEach((f, i) => {
      this.tone(at + 0.08, f, { type: 'sawtooth', gain: 0.05, decay: 0.12, filter: 2400 });
      this.tone(at + 0.22, f, { type: 'sawtooth', gain: 0.07, decay: (big ? 2.2 : 1.5) + i * 0.05, attack: 0.03, filter: 2600 });
    });
    this.applause(at + 0.9, big ? 4.5 : 3);
  }

  /** A thump as a podium step rises. */
  thump(pitch = 1): void {
    const r = this.ready();
    if (!r) return;
    const at = r.ctx.currentTime;
    this.tone(at, 110 * pitch, { gain: 0.45, decay: 0.35, to: 60 * pitch });
    this.noiseHit(at, { type: 'lowpass', freq: 900, gain: 0.2, decay: 0.15 });
    this.tone(at + 0.02, 523.3 * pitch, { type: 'triangle', gain: 0.08, decay: 0.5 });
  }

  /** Crowd applause: many short claps that swell and fade. */
  applause(at: number, seconds: number): void {
    const r = this.ready();
    if (!r) return;
    const claps = Math.round(seconds * 55);
    for (let i = 0; i < claps; i++) {
      const t = Math.random() * seconds;
      const swell = Math.sin(Math.PI * Math.min(1, t / seconds)) ** 0.6;
      this.noiseHit(at + t, { type: 'bandpass', freq: 900 + Math.random() * 1700, q: 1.2, gain: 0.04 + 0.11 * swell * Math.random(), decay: 0.04 + Math.random() * 0.03 });
    }
  }
}
