export interface WheelPush {
  band: WheelBand;
  hue: number;   // 0.00 = red, 0.33 = green, 0.66 = blue
  sat: number;   // 0..1
  lum: number;   // -1..1
}
