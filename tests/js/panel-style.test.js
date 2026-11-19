import {
  test, run, assertEqual, assertTrue, assertFalse, assertDeepEqual,
} from './harness.js';
import {
  resolvePanelStyle,
  resolveBlurVeilStyle,
  resolveBlurVeilAlpha,
  clampPanelOpacity,
  clampBlurRadius,
  BLUR_SURFACE_STYLE,
  PANEL_BORDER_WIDTH,
  PANEL_BORDER_RGBA,
  PANEL_RGB,
  DEFAULT_PANEL_OPACITY,
  DEFAULT_BLUR_RADIUS,
} from '../../lib/panel-style.js';

function alphaOf(background) {
  const match = new RegExp(`^rgba\\(${PANEL_RGB},([0-9.]+)\\)$`).exec(background);
  if (!match)
    throw new Error(`unexpected background: ${background}`);
  return Number(match[1]);
}

test('defaults use the 0.93 panel background and no blur', () => {
  const style = resolvePanelStyle();
  assertEqual(style.background, 'rgba(26,27,34,0.93)');
  assertEqual(style.blurRadius, DEFAULT_BLUR_RADIUS);
  assertFalse(style.requiresBlur);
  assertTrue(Math.abs(alphaOf(style.background) - DEFAULT_PANEL_OPACITY) <= 0.01);
});

test('opacity lower and upper bounds map into rgba()', () => {
  const transparent = resolvePanelStyle({ opacity: 0.5 });
  const opaque = resolvePanelStyle({ opacity: 1.0 });
  assertTrue(Math.abs(alphaOf(transparent.background) - 0.5) <= 0.01);
  assertTrue(Math.abs(alphaOf(opaque.background) - 1.0) <= 0.01);
});

test('opacity outside 0.5-1.0 is clamped', () => {
  assertEqual(alphaOf(resolvePanelStyle({ opacity: 0.1 }).background), 0.5);
  assertEqual(alphaOf(resolvePanelStyle({ opacity: 2 }).background), 1);
});

test('invalid opacity falls back to the default', () => {
  assertEqual(clampPanelOpacity(undefined), DEFAULT_PANEL_OPACITY);
  assertEqual(clampPanelOpacity(Number.NaN), DEFAULT_PANEL_OPACITY);
  assertTrue(Math.abs(
    alphaOf(resolvePanelStyle({ opacity: 'nope' }).background) -
      DEFAULT_PANEL_OPACITY
  ) <= 0.01);
});

test('blur radius bounds are 0 and 48', () => {
  assertEqual(resolvePanelStyle({ blurEnabled: true, blurRadius: 0 }).blurRadius, 0);
  assertEqual(resolvePanelStyle({ blurEnabled: true, blurRadius: 48 }).blurRadius, 48);
  assertEqual(clampBlurRadius(-10), 0);
  assertEqual(clampBlurRadius(100), 48);
});

test('blur radius rounds and falls back to the default', () => {
  assertEqual(resolvePanelStyle({ blurEnabled: true, blurRadius: 32.6 }).blurRadius, 33);
  assertEqual(clampBlurRadius(undefined), DEFAULT_BLUR_RADIUS);
  assertEqual(clampBlurRadius(Number.NaN), DEFAULT_BLUR_RADIUS);
});

test('blur off never requires a blur effect', () => {
  const style = resolvePanelStyle({
    opacity: 0.8,
    blurEnabled: false,
    blurRadius: 32,
  });
  assertFalse(style.requiresBlur);
  assertEqual(style.blurRadius, 32);
});

test('blur on requires a blur effect and keeps the radius', () => {
  const style = resolvePanelStyle({
    opacity: 0.8,
    blurEnabled: true,
    blurRadius: 32,
  });
  assertTrue(style.requiresBlur);
  assertEqual(style.blurRadius, 32);
});

test('the style object exposes only the documented fields', () => {
  assertDeepEqual(
    Object.keys(resolvePanelStyle()).sort(),
    ['background', 'blurRadius', 'requiresBlur']
  );
});

test('the veil alpha follows 1 - opacity + 0.15', () => {
  assertTrue(Math.abs(resolveBlurVeilAlpha(0.93) - 0.22) <= 0.001);
  assertTrue(Math.abs(resolveBlurVeilAlpha(0.5) - 0.65) <= 0.001);
});

test('blur veil paints a delicate 1 px border inside the rounded surface', () => {
  const style = resolveBlurVeilStyle({ veilAlpha: 0.22, radius: 18 });
  assertTrue(style.includes('background-color: rgba(26,27,34,0.22)'));
  assertTrue(style.includes(
    `border: ${PANEL_BORDER_WIDTH}px solid rgba(${PANEL_BORDER_RGBA})`
  ));
  assertTrue(style.includes('border-radius: 18px'));
  // Obwódka ma być delikatna, a nie drugi mocny kształt przy blurze.
  assertEqual(PANEL_BORDER_WIDTH, 1);
  const alpha = Number(/rgba\(255,255,255,([0-9.]+)\)/.exec(style)?.[1]);
  assertTrue(alpha > 0 && alpha <= 0.2);
  // Bez box-shadow: cień to kolejny łuk rysowany przez St.
  assertFalse(style.includes('box-shadow'));
});

test('blur veil style clamps alpha and rounds the radius', () => {
  assertTrue(resolveBlurVeilStyle({ veilAlpha: 2, radius: 18.6 })
    .includes('rgba(26,27,34,1)'));
  assertTrue(resolveBlurVeilStyle({ veilAlpha: -1, radius: 18.6 })
    .includes('rgba(26,27,34,0)'));
  assertTrue(resolveBlurVeilStyle({ veilAlpha: 0.3, radius: 18.6 })
    .includes('border-radius: 19px'));
  assertTrue(resolveBlurVeilStyle({})
    .includes('border-radius: 18px'));
});

test('blur surface style clears every competing rounded shape', () => {
  // Regresja rogów przy blurze: modal nie może malować drugiego zaokrąglonego
  // kształtu obok zamaskowanego backdropu. Tło, obramowanie, promień ORAZ cień
  // muszą być wyczyszczone — pozostawiony box-shadow/border-radius z CSS to
  // drugi łuk (St rysuje cień programowo), który zostawia skrawki w rogach.
  assertTrue(BLUR_SURFACE_STYLE.includes('background-color: transparent'));
  assertTrue(BLUR_SURFACE_STYLE.includes('border: none'));
  assertTrue(BLUR_SURFACE_STYLE.includes('box-shadow: none'));
  assertTrue(BLUR_SURFACE_STYLE.includes('border-radius: 0'));
});

run('panel-style.test.js');