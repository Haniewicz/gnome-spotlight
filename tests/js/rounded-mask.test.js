import {
  test, run, assertEqual, assertTrue, assertLess,
} from './harness.js';
import {
  maskCoverage,
  clampMaskRadius,
  ROUNDED_MASK_SHADER,
} from '../../lib/ui/rounded-mask.js';

const WIDTH = 200;
const HEIGHT = 100;
const RADIUS = 18;

test('maskCoverage is zero in the pixel outside the rounded corner', () => {
  const coverage = maskCoverage({
    x: 1,
    y: 1,
    width: WIDTH,
    height: HEIGHT,
    radius: RADIUS,
  });
  assertLess(coverage, 0.01);
});

test('maskCoverage is one at the centre of the panel', () => {
  const coverage = maskCoverage({
    x: WIDTH / 2,
    y: HEIGHT / 2,
    width: WIDTH,
    height: HEIGHT,
    radius: RADIUS,
  });
  assertEqual(coverage, 1);
});

test('maskCoverage is about one half on the rounded edge', () => {
  const coverage = maskCoverage({
    x: 0,
    y: HEIGHT / 2,
    width: WIDTH,
    height: HEIGHT,
    radius: RADIUS,
  });
  assertLess(Math.abs(coverage - 0.5), 0.02);
});

test('maskCoverage keeps straight edges fully covered', () => {
  assertEqual(maskCoverage({
    x: WIDTH / 2,
    y: 10,
    width: WIDTH,
    height: HEIGHT,
    radius: RADIUS,
  }), 1);
  assertEqual(maskCoverage({
    x: 10,
    y: HEIGHT / 4,
    width: WIDTH,
    height: HEIGHT,
    radius: RADIUS,
  }), 1);
});

test('mask shader exposes the radius uniform and smooth edge', () => {
  assertTrue(ROUNDED_MASK_SHADER.includes('uniform float radius'));
  assertTrue(ROUNDED_MASK_SHADER.includes('smoothstep'));
});

test('clampMaskRadius accepts 0 and the CSS default 18', () => {
  assertEqual(clampMaskRadius(0, WIDTH, HEIGHT), 0);
  assertEqual(clampMaskRadius(18, WIDTH, HEIGHT), 18);
});

test('clampMaskRadius caps at half of the shorter side', () => {
  assertEqual(clampMaskRadius(100, WIDTH, HEIGHT), HEIGHT / 2);
  assertEqual(
    clampMaskRadius(100, { width: WIDTH, height: HEIGHT }),
    HEIGHT / 2
  );
  assertTrue(clampMaskRadius(100, HEIGHT, WIDTH) <= HEIGHT / 2);
});

test('clampMaskRadius ignores invalid and negative values', () => {
  assertEqual(clampMaskRadius(-4, WIDTH, HEIGHT), 0);
  assertEqual(clampMaskRadius(Number.NaN, WIDTH, HEIGHT), 0);
  assertEqual(clampMaskRadius(18, 0, 0), 0);
});

run('rounded-mask.test.js');