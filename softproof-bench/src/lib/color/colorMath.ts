/**
 * CIE color math for the sampler: LittleCMS double Lab is authoritative for
 * transformed values; these helpers format Lab and compute CIEDE2000 (with
 * parametric weights kL=kC=kH=1).
 */

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Radian/degree helpers used by CIEDE2000. */
const rad2deg = (r: number) => (r * 180) / Math.PI;
const deg2rad = (d: number) => (d * Math.PI) / 180;

/**
 * CIEDE2000 colour difference, Sharma et al. formulation.
 * Inputs are CIELAB D50 values as produced by LittleCMS.
 */
export function deltaE2000(l1: Lab, l2: Lab, kL = 1, kC = 1, kH = 1): number {
  const { L: L1, a: a1, b: b1 } = l1;
  const { L: L2, a: a2, b: b2 } = l2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    let d = h2p - h1p;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    dhp = d;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      hbarp = hbarp < 360 ? hbarp + 180 : hbarp - 180;
    }
    hbarp /= 2;
  } else {
    hbarp = hbarp; // sum of the two (one zero), per spec
  }

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(deg2rad(2 * dTheta)) * RC;

  return Math.sqrt(
    (dLp / (kL * SL)) ** 2 +
      (dCp / (kC * SC)) ** 2 +
      (dHp / (kH * SH)) ** 2 +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
}

function hueAngle(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = rad2deg(Math.atan2(b, a));
  return h >= 0 ? h : h + 360;
}

export function labToStr({ L, a, b }: Lab): string {
  return `L* ${L.toFixed(2)}  a* ${a.toFixed(2)}  b* ${b.toFixed(2)}`;
}

export function fromTriple(t: number[]): Lab {
  return { L: t[0], a: t[1], b: t[2] };
}

/** Hex display for raw 8-bit RGB samples. */
export function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}
