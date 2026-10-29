/**
 * @file  filmcraft/timebase.ts
 * @module FilmCraftTimebase
 *
 * @description
 * Exact-rational time arithmetic for FilmCraft's integer tick timebase.
 *
 * FilmCraft represents all timeline positions as unsigned 64-bit ticks from a
 * single, global "super-clock" whose frequency is 254_016_000_000 Hz. This
 * value was chosen so that the following conversions are exact integers (no
 * rounding whatsoever):
 *
 *   - one second to 24, 25, 30, 48, 50, 60, 100, 120, and 1000 fps frames
 *   - one second to 44100, 48000, 88200, 96000, 176400, 192000 audio samples
 *   - one second to NTSC fractional rates 24000/1001, 30000/1001, 60000/1001
 *
 * Because the denominator of the "seconds per tick" rational divides every
 * plausible frame/sample period, positions can be held exactly in this
 * class and only floored/rounded at the moment they are serialized into a
 * JSON-RPC command.
 *
 * IMPORTANT: this module must compile with `"target": "ES2020"` or later
 * (BigInt literals), and `"lib": ["ES2020"]` at minimum.
 */

/* ------------------------------------------------------------------ */
/*  Global constants                                                   */
/* ------------------------------------------------------------------ */

/** The FilmCraft super-clock frequency: ticks per second of timeline time. */
export const TICKS_PER_SECOND: bigint = 254_016_000_000n;

/** Largest integer safely representable by a JS Number (2^53 - 1). */
const MAX_SAFE: bigint = 9_007_199_254_740_991n;

/* ------------------------------------------------------------------ */
/*  Rational numbers on BigInt                                         */
/* ------------------------------------------------------------------ */

/** Euclidean GCD supporting negative operands (BigInt flavour). */
function gcdBig(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Exact rational number `n / d`, always stored in lowest terms with a
 * strictly positive denominator. Immutable.
 */
export class Rational {
  public readonly n: bigint;
  public readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new Error("Rational: zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = n === 0n ? 1n : gcdBig(n, d);
    this.n = n / g;
    this.d = d / g;
  }

  /** Construct from integers (accepts `number` for ergonomics). */
  public static of(n: bigint | number, d: bigint | number = 1n): Rational {
    return new Rational(BigInt(n), BigInt(d));
  }

  /**
   * Parse a decimal string ("1.5", "-0.250", "100") exactly — every digit
   * becomes a numerator digit and the fraction length becomes the scale.
   * Never routes through Number, so no binary floating-point error.
   */
  public static fromDecimalString(s: string): Rational {
    const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(s.trim());
    if (!m) throw new Error(`Rational.fromDecimalString: not a decimal: ${s}`);
    const [, sign, ip, fp = ""] = m;
    const digits = (ip === "" ? "0" : ip) + fp;
    const scale = 10n ** BigInt(fp.length);
    const sgn = sign === "-" ? -1n : 1n;
    return new Rational(BigInt(digits) * sgn, scale);
  }

  public add(o: Rational): Rational { return new Rational(this.n * o.d + o.n * this.d, this.d * o.d); }
  public sub(o: Rational): Rational { return new Rational(this.n * o.d - o.n * this.d, this.d * o.d); }
  public mul(o: Rational): Rational { return new Rational(this.n * o.n, this.d * o.d); }
  public div(o: Rational): Rational { return new Rational(this.n * o.d, this.d * o.n); }
  public neg(): Rational { return new Rational(-this.n, this.d); }
  public cmp(o: Rational): -1 | 0 | 1 {
    const lhs = this.n * o.d, rhs = o.n * this.d;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }
  public eq(o: Rational): boolean { return this.cmp(o) === 0; }

  /** Truncation toward negative infinity, using exact BigInt division. */
  public toBigIntFloor(): bigint {
    if (this.n >= 0n) return this.n / this.d;
    const pos = -this.n;
    const q = pos / this.d, r = pos % this.d;
    return r === 0n ? -q : -(q + 1n);
  }

  /** Round half away from zero — the convention FilmCraft uses at the wire. */
  public toBigIntRound(): bigint {
    const q = this.n / this.d;
    const r = this.n % this.d;
    const twice = (r < 0n ? -r : r) * 2n;
    if (twice >= this.d) return q + (this.n < 0n ? -1n : 1n);
    return q;
  }

  /** Lossy. Use only for display or when feeding a `seconds` parameter. */
  public toNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  public toString(): string {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }
}

/* ------------------------------------------------------------------ */
/*  Frame-rate constants                                               */
/* ------------------------------------------------------------------ */

export interface FrameRate { readonly num: number; readonly den: number; }

export const FPS = {
  F23_976: { num: 24_000, den: 1_001 } as FrameRate,   // NTSC film
  F24:     { num: 24,     den: 1     } as FrameRate,
  F25:     { num: 25,     den: 1     } as FrameRate,   // PAL
  F29_97:  { num: 30_000, den: 1_001 } as FrameRate,   // NTSC video
  F30:     { num: 30,     den: 1     } as FrameRate,
  F50:     { num: 50,     den: 1     } as FrameRate,
  F59_94:  { num: 60_000, den: 1_001 } as FrameRate,
  F60:     { num: 60,     den: 1     } as FrameRate,
} as const;

/* ------------------------------------------------------------------ */
/*  Timebase adapter                                                   */
/* ------------------------------------------------------------------ */

/**
 * The sequence's "coordinate system": the tick scalar plus the fps and audio
 * sample rate declared in the FilmCraft sequence settings. All conversions
 * flow through this object so there is exactly one place in the codebase
 * that knows the frames-per-second is 24000/1001 and not 23.976.
 */
export class Timebase {
  public readonly ticksPerSecond: bigint = TICKS_PER_SECOND;
  public readonly fps: Rational;
  /** Whole-number audio sample rate in Hz (Filmscraft uses integers here). */
  public readonly sampleRate: bigint;
  /** Exact ticks in one video frame = TICKS_PER_SECOND * den / num. */
  public readonly ticksPerFrame: Rational;
  /** Exact ticks in one audio sample = TICKS_PER_SECOND / sampleRate. */
  public readonly ticksPerSample: Rational;

  public constructor(fps: FrameRate | number | Rational, sampleRate: number | bigint) {
    if (fps instanceof Rational) this.fps = fps;
    else if (typeof fps === "number") this.fps = Rational.of(fps);
    else this.fps = Rational.of(fps.num, fps.den);

    this.sampleRate = BigInt(sampleRate);
    this.ticksPerFrame = Rational.of(TICKS_PER_SECOND).div(this.fps);
    this.ticksPerSample = Rational.of(TICKS_PER_SECOND).div(Rational.of(this.sampleRate));
  }

  /* ---------- seconds ⇄ ticks ---------- */

  /** Accepts a decimal string, a Number, or an exact Rational. */
  public secondsToTicks(s: number | string | Rational): bigint {
    const r =
      s instanceof Rational ? s :
      typeof s === "string" ? Rational.fromDecimalString(s) :
      Rational.of(Math.round(s * 1e9), 1_000_000_000); // ns precision fallback
    return r.mul(Rational.of(TICKS_PER_SECOND)).toBigIntRound();
  }

  public ticksToSeconds(t: bigint): Rational {
    return Rational.of(t).div(Rational.of(TICKS_PER_SECOND));
  }

  /* ---------- frames ⇄ ticks ---------- */

  /** Exact for whole frames; returns the tick that frame `f` begins on. */
  public frameToTicks(f: number | bigint): bigint {
    return Rational.of(BigInt(f)).mul(this.ticksPerFrame).toBigIntRound();
  }

  /** Floor of ticks/ticksPerFrame — i.e., the frame containing `t`. */
  public ticksToFrame(t: bigint): bigint {
    return Rational.of(t).div(this.ticksPerFrame).toBigIntFloor();
  }

  /* ---------- audio samples ⇄ ticks ---------- */

  public sampleToTicks(s: number | bigint): bigint {
    return Rational.of(BigInt(s)).mul(this.ticksPerSample).toBigIntRound();
  }

  public ticksToSample(t: bigint): bigint {
    return Rational.of(t).div(this.ticksPerSample).toBigIntFloor();
  }

  /* ---------- SMPTE timecode ⇄ ticks ---------- */

  /**
   * Parse `HH:MM:SS:FF` (non-drop) or `HH:MM:SS;FF` (drop-frame, valid at
   * 29.97 and 59.94). Drop-frame only affects how the *label* maps to a
   * frame number; the underlying position is still an integer tick.
   */
  public timecodeToTicks(tc: string): bigint {
    const drop = tc.includes(";");
    const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2,3})$/.exec(tc);
    if (!m) throw new Error(`Invalid timecode: ${tc}`);
    const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]), ff = Number(m[5]);
    if (mm >= 60 || ss >= 60) throw new Error(`Invalid timecode fields: ${tc}`);

    // Nominal integer frame rate (24, 25, 30, 50, 60) for the SMPTE grid.
    const nominal = Math.round(Number(this.fps.n) / Number(this.fps.d));
    let totalFrames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;

    if (drop) {
      // SMPTE 12M drop-frame: skip `round(nominal/15)` frame counts each
      // minute except every tenth minute.
      const dropPerMin = Math.round(nominal / 15);
      const totalMin = hh * 60 + mm;
      totalFrames -= dropPerMin * (totalMin - Math.floor(totalMin / 10));
    }
    // frameToTicks then applies the exact NTSC 1001/30000 factor.
    return this.frameToTicks(totalFrames);
  }

  /* ---------- wire-safety helpers ---------- */

  /**
   * Convert a tick count to a wire-safe JSON Number, throwing if the
   * value would silently lose precision. 2^53 ticks ≈ 35,000 seconds ≈
   * 9h 48m of timeline — longer sessions should be split, or the
   * parameter should be sent as a decimal string accepted by FilmCraft's
   * `timecode` field.
   */
  public toWire(t: bigint): number {
    if (t > MAX_SAFE || t < -MAX_SAFE) {
      throw new Error(
        `Tick value ${t} exceeds JSON-safe range (${MAX_SAFE}); ` +
        `split the sequence or emit a timecode string instead.`,
      );
    }
    return Number(t);
  }
}
