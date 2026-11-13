import {
  test, run, assertEqual, assertTrue, assertDeepEqual,
} from './harness.js';
import {
  clampRadius,
  cloneOffset,
  planPanelBlur,
  MIN_BLUR_RADIUS,
  MAX_BLUR_RADIUS,
  DEFAULT_BLUR_RADIUS,
} from '../../lib/panel-blur.js';

test('clone offset subtracts the panel origin', () => {
  assertDeepEqual(
    cloneOffset({ panelX: 210, panelY: 144 }),
    { x: -210, y: -144 }
  );
  assertDeepEqual(cloneOffset({ panelX: 0, panelY: 0 }), { x: 0, y: 0 });
  assertDeepEqual(
    cloneOffset({ panelX: -12.5, panelY: 20 }),
    { x: 12.5, y: -20 }
  );
});

test('clone offset falls back to zero for missing or invalid values', () => {
  assertDeepEqual(cloneOffset(), { x: 0, y: 0 });
  assertDeepEqual(
    cloneOffset({ panelX: undefined, panelY: Number.NaN }),
    { x: 0, y: 0 }
  );
});

test('clampRadius accepts the documented 0 and 48 bounds', () => {
  assertEqual(clampRadius(0), 0);
  assertEqual(clampRadius(48), 48);
  assertEqual(clampRadius(MIN_BLUR_RADIUS), 0);
  assertEqual(clampRadius(MAX_BLUR_RADIUS), 48);
});

test('clampRadius clamps values outside the bounds', () => {
  assertEqual(clampRadius(-10), 0);
  assertEqual(clampRadius(-0.4), 0);
  assertEqual(clampRadius(100), 48);
  assertEqual(clampRadius(32.6), 33);
});

test('clampRadius falls back to the default radius', () => {
  assertEqual(clampRadius(undefined), DEFAULT_BLUR_RADIUS);
  assertEqual(clampRadius(Number.NaN), DEFAULT_BLUR_RADIUS);
  assertEqual(clampRadius('nope'), DEFAULT_BLUR_RADIUS);
});

test('blur off plans no clone', () => {
  assertDeepEqual(
    planPanelBlur({ enabled: false, radius: 32, panelX: 10, panelY: 20 }),
    { clone: false }
  );
});

test('unavailable blur effect plans no clone and reports it', () => {
  assertDeepEqual(
    planPanelBlur({ enabled: true, available: false, radius: 32 }),
    { clone: false, unavailable: true }
  );
});

test('blur on plans a clone with clamped radius and negative offset', () => {
  const plan = planPanelBlur({
    enabled: true,
    available: true,
    radius: 90,
    panelX: 100,
    panelY: 50,
  });
  assertTrue(plan.clone);
  assertEqual(plan.radius, 48);
  assertDeepEqual(plan.offset, { x: -100, y: -50 });
});

run('panel-blur.test.js');