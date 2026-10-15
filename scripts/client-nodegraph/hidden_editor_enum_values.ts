/**
 * Client enum values still found in sampled graphs but no longer listed by the
 * current editor enum (internal elemental reactions such as Burned / AntiFire
 * were dropped from the dropdown in the 2026-10 editor build). Keyed by editor
 * enum id.
 */
export const HIDDEN_EDITOR_ENUM_VALUES: Readonly<Record<number, readonly number[]>> = {
  200039: [
    4704, 4709, 4710, 4711, 4713, 4714, 4715, 4721, 4722, 4723, 4724, 4725, 4726, 4732, 4738, 4739
  ]
}
