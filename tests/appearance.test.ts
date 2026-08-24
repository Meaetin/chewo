import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  deriveRim,
  deriveSurfaces,
  deriveTextRamp,
  hexToHsl,
  inkOn,
  isLightBase,
  DEFAULT_APPEARANCE
} from '../src/shared/appearance'
import { PRESETS } from '../src/shared/presets'

const lightness = (hex: string): number => hexToHsl(hex).l

describe('isLightBase', () => {
  it('reads the shipped dark presets as dark and the light ones as light', () => {
    expect(isLightBase(DEFAULT_APPEARANCE.base)).toBe(false)
    expect(isLightBase('#2e3440')).toBe(false)
    expect(isLightBase('#ffffff')).toBe(true)
    expect(isLightBase('#eff1f5')).toBe(true)
    expect(isLightBase('#fdf6e3')).toBe(true)
  })
})

describe('deriveSurfaces', () => {
  it('reproduces the stock graphite ramp from the default base', () => {
    const { surfaces, line1, line2 } = deriveSurfaces('#141414')
    expect(surfaces).toEqual(['#141414', '#181818', '#1e1e1e', '#252525', '#2c2c2c', '#343434'])
    expect(line1).toBe('#3a3a3a')
    expect(line2).toBe('#484848')
  })

  it('runs the ramp downward on a light base, so raised surfaces darken', () => {
    const { surfaces, line1, line2 } = deriveSurfaces('#ffffff')
    const ls = surfaces.map(lightness)
    expect(ls).toEqual([...ls].sort((a, b) => b - a))
    expect(ls[0]).toBe(100)
    expect(lightness(line1)).toBeLessThan(ls[5])
    expect(lightness(line2)).toBeLessThan(lightness(line1))
  })

  it('holds chroma steady down a light ramp instead of carrying HSL saturation', () => {
    // Solarized's own next surface below base3 (#fdf6e3) is base2 (#eee8d5).
    // Carrying s=87% unchanged would put the whole ramp far past it.
    const { surfaces } = deriveSurfaces('#fdf6e3')
    for (const hex of surfaces.slice(1)) {
      expect(hexToHsl(hex).s).toBeLessThan(hexToHsl('#fdf6e3').s)
    }
    expect(hexToHsl(surfaces[5]).s).toBeLessThan(45)
  })

  it('leaves a dark tinted ramp at constant saturation (Nord does the same)', () => {
    const { surfaces } = deriveSurfaces('#2e3440')
    const s = hexToHsl('#2e3440').s
    for (const hex of surfaces) expect(Math.abs(hexToHsl(hex).s - s)).toBeLessThan(1)
  })
})

describe('deriveTextRamp', () => {
  it('is cream on a dark base and ink on a light one', () => {
    expect(lightness(deriveTextRamp('#141414').primary)).toBeGreaterThan(80)
    expect(lightness(deriveTextRamp('#ffffff').primary)).toBeLessThan(20)
  })

  // The floors are a shade under the graphite default's own readings
  // (14.4 / 7.7 / 4.3 / 2.5) because the hue pull moves each anchor by hue at
  // a fixed HSL lightness, and hue carries luminance with it — a cream base
  // lands its tertiary at 3.9 rather than 4.3. The ordering is the real test.
  it('keeps the same contrast hierarchy either way round', () => {
    for (const base of ['#141414', '#ffffff', '#f4f5f7', '#eff1f5', '#fdf6e3']) {
      const canvas = deriveSurfaces(base).surfaces[1]
      const t = deriveTextRamp(base)
      expect(contrastRatio(t.primary, canvas)).toBeGreaterThan(13)
      expect(contrastRatio(t.secondary, canvas)).toBeGreaterThan(6.5)
      expect(contrastRatio(t.tertiary, canvas)).toBeGreaterThan(3.8)
      expect(contrastRatio(t.primary, canvas)).toBeGreaterThan(contrastRatio(t.secondary, canvas))
      expect(contrastRatio(t.secondary, canvas)).toBeGreaterThan(contrastRatio(t.tertiary, canvas))
      expect(contrastRatio(t.tertiary, canvas)).toBeGreaterThan(contrastRatio(t.faint, canvas))
    }
  })
})

describe('deriveRim', () => {
  it('gives a light base the alpha a dark one would blow out', () => {
    expect(deriveRim('#141414')).toContain('0.05')
    expect(deriveRim('#ffffff')).toContain('0.7')
  })
})

describe('inkOn', () => {
  it('keeps near-black ink on the emerald the dark presets were built around', () => {
    expect(lightness(inkOn('#3bbf8b'))).toBeLessThan(20)
  })

  it('flips to near-white on a deep accent rather than failing quietly', () => {
    expect(lightness(inkOn('#0969da'))).toBeGreaterThan(80)
    expect(lightness(inkOn('#1e66f5'))).toBeGreaterThan(80)
  })

  it('always beats 4.5:1 against every shipped accent', () => {
    for (const p of PRESETS) {
      expect(contrastRatio(p.appearance.accent, inkOn(p.appearance.accent))).toBeGreaterThan(4.5)
    }
  })
})

describe('presets', () => {
  it('has unique ids and at least one light theme', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length)
    expect(PRESETS.filter((p) => isLightBase(p.appearance.base)).length).toBeGreaterThan(0)
  })

  // The two ends of the ANSI ramp are low contrast by definition — the stock
  // graphite preset's own `black` sits at 1.1:1 on its canvas — so the bar is
  // for the twelve chromatic slots, which are where output is actually read.
  const ANSI_ENDS = new Set(['black', 'brightBlack', 'white', 'brightWhite'])

  // The accent, the project highlight and the live indicator are three
  // *signals*, not a harmonious triad: you-are-here, this-container-is-open,
  // an-agent-is-working. Picked out of one palette family they come out
  // neighbours — five of the seven presets once put live within 30° of the
  // accent, the default among them (emerald h156 against a cyan h185) — and a
  // running session then reads as a slightly bluer version of a focused one.
  const hueGap = (a: string, b: string): number => {
    const d = Math.abs(hexToHsl(a).h - hexToHsl(b).h) % 360
    return Math.min(d, 360 - d)
  }

  it('keeps the three accents at least 45 degrees apart in every preset', () => {
    for (const p of PRESETS) {
      const { accent, accentSecondary, accentTertiary } = p.appearance
      const pairs: Array<[string, string, string]> = [
        ['accent/secondary', accent, accentSecondary],
        ['accent/tertiary', accent, accentTertiary],
        ['secondary/tertiary', accentSecondary, accentTertiary]
      ]
      for (const [label, a, b] of pairs) {
        expect(hueGap(a, b), `${p.id} ${label} (${a} vs ${b})`).toBeGreaterThanOrEqual(45)
      }
    }
  })

  // Hues already spoken for in styles.css and shared by every preset, so a
  // secondary or tertiary landing on one makes two different things the same
  // colour: danger/diff-del (h5), the Claude badge (h17), warning (h38),
  // diff-add (h135) and the Codex badge (h214).
  const CLAIMED: Array<[string, number]> = [
    ['danger', 5],
    ['badge-claude', 17],
    ['warning', 38],
    ['diff-add', 135],
    ['badge-codex', 214]
  ]

  it('keeps them clear of the hues the fixed status colors already own', () => {
    for (const p of PRESETS) {
      for (const role of ['accentSecondary', 'accentTertiary'] as const) {
        const hex = p.appearance[role]
        for (const [name, hue] of CLAIMED) {
          const d = Math.abs(hexToHsl(hex).h - hue) % 360
          expect(Math.min(d, 360 - d), `${p.id} ${role} (${hex}) vs ${name}`).toBeGreaterThan(25)
        }
      }
    }
  })

  it('keeps the project and live colors readable on their own canvas', () => {
    for (const p of PRESETS) {
      const canvas = deriveSurfaces(p.appearance.base).surfaces[1]
      for (const role of ['accent', 'accentSecondary', 'accentTertiary'] as const) {
        expect(
          contrastRatio(p.appearance[role], canvas),
          `${p.id} ${role} (${p.appearance[role]}) on ${canvas}`
        ).toBeGreaterThan(4.5)
      }
    }
  })

  it('keeps every chromatic ANSI slot at 3:1 on its own canvas', () => {
    for (const p of PRESETS.filter((x) => isLightBase(x.appearance.base))) {
      const canvas = deriveSurfaces(p.appearance.base).surfaces[1]
      for (const [slot, hex] of Object.entries(p.appearance.terminal)) {
        if (ANSI_ENDS.has(slot)) continue
        expect(
          contrastRatio(hex, canvas),
          `${p.id} terminal.${slot} (${hex}) on ${canvas}`
        ).toBeGreaterThan(3)
      }
    }
  })

  it('keeps every editor and notes color at 3:1 on its own canvas', () => {
    for (const p of PRESETS.filter((x) => isLightBase(x.appearance.base))) {
      const canvas = deriveSurfaces(p.appearance.base).surfaces[1]
      for (const group of ['editor', 'notes'] as const) {
        for (const [slot, hex] of Object.entries(p.appearance[group])) {
          expect(
            contrastRatio(hex, canvas),
            `${p.id} ${group}.${slot} (${hex}) on ${canvas}`
          ).toBeGreaterThan(3)
        }
      }
    }
  })
})
