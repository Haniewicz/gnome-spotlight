import {
  test, run, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import {
  resolveEdgeFade,
  EDGE_FADE_RAMP_PX,
  EDGE_FADE_SHADER,
  EDGE_FADE_HEIGHT_PX,
  EDGE_FADE_BLUR_PX,
} from '../../lib/edge-fade.js';

test('no overflow disables both edges', () => {
  const fade = resolveEdgeFade({ value: 0, pageSize: 500, upper: 500 });
  assertFalse(fade.overflow);
  assertEqual(fade.topStrength, 0);
  assertEqual(fade.bottomStrength, 0);
  // Sub-pixel rounding noise is not hidden content either.
  const noise = resolveEdgeFade({ value: 0, pageSize: 500, upper: 500.4 });
  assertFalse(noise.overflow);
});

test('at the very top only the bottom edge blurs', () => {
  const fade = resolveEdgeFade({ value: 0, pageSize: 400, upper: 900 });
  assertTrue(fade.overflow);
  assertEqual(fade.topStrength, 0);
  assertEqual(fade.bottomStrength, 1);
  assertEqual(fade.maxScroll, 500);
});

test('at the very bottom only the top edge blurs', () => {
  const fade = resolveEdgeFade({ value: 500, pageSize: 400, upper: 900 });
  assertEqual(fade.topStrength, 1);
  assertEqual(fade.bottomStrength, 0);
});

test('both edges can be partially faded at the same time', () => {
  // maxScroll shorter than 2 * ramp: the two ramps overlap.
  const maxScroll = EDGE_FADE_RAMP_PX + 10;
  const middle = resolveEdgeFade({
    value: maxScroll / 2,
    pageSize: 400,
    upper: 400 + maxScroll,
  });
  assertTrue(middle.topStrength > 0 && middle.topStrength < 1);
  assertTrue(middle.bottomStrength > 0 && middle.bottomStrength < 1);
  assertTrue(Math.abs(middle.topStrength - middle.bottomStrength) <= 0.001);
});

test('the top edge ramps in with the scroll distance', () => {
  const slightlyScrolled = resolveEdgeFade({
    value: EDGE_FADE_RAMP_PX / 2,
    pageSize: 400,
    upper: 900,
  });
  assertTrue(Math.abs(slightlyScrolled.topStrength - 0.5) <= 0.001);
  assertEqual(slightlyScrolled.bottomStrength, 1);
});

test('short overflow gives proportionally weaker edges', () => {
  const short = resolveEdgeFade({ value: 0, pageSize: 100, upper: 110 });
  assertTrue(short.overflow);
  assertTrue(Math.abs(short.bottomStrength - 10 / EDGE_FADE_RAMP_PX) <= 0.001);
  assertEqual(short.topStrength, 0);
});

test('invalid adjustment values are clamped', () => {
  const fade = resolveEdgeFade({
    value: Number.NaN,
    pageSize: -5,
    upper: 'nope',
  });
  assertFalse(fade.overflow);
  assertEqual(fade.topStrength, 0);
  assertEqual(fade.bottomStrength, 0);

  const negative = resolveEdgeFade({ value: -20, pageSize: 100, upper: 200 });
  assertEqual(negative.topStrength, 0);
  assertEqual(negative.bottomStrength, 1);
});

test('shader exposes the tuning uniforms used by the effect', () => {
  for (const uniform of ['top_strength', 'bottom_strength', 'fade_height',
    'blur_px', 'alpha_at_edge']) {
    assertTrue(EDGE_FADE_SHADER.includes(`uniform float ${uniform}`));
  }
  assertTrue(EDGE_FADE_HEIGHT_PX > 0);
  assertTrue(EDGE_FADE_BLUR_PX > 0);
});

run('edge-fade.test.js');
