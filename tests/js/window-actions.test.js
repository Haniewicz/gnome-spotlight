import {
  test, run, assertDeepEqual, assertEqual, assertFalse, assertTrue,
} from './harness.js';
import {
  planTile, planCenter, clampToWorkArea,
} from '../../lib/window-actions.js';
import {
  buildActionMenu, createPopupActionMenu, handleActionMenuKeyPress,
} from '../../lib/ui/actions.js';

function assertRect(actual, expected) {
  assertDeepEqual(actual, expected);
}

test('planTile left halves an even work area', () => {
  assertRect(
    planTile({ x: 0, y: 0, width: 1920, height: 1080 }, 'left'),
    { x: 0, y: 0, width: 960, height: 1080 }
  );
});

test('planTile right starts where the left half ends', () => {
  assertRect(
    planTile({ x: 0, y: 0, width: 1920, height: 1080 }, 'right'),
    { x: 960, y: 0, width: 960, height: 1080 }
  );
});

test('planTile odd width has no gap or overlap', () => {
  const area = { x: 0, y: 0, width: 1921, height: 1080 };
  const left = planTile(area, 'left');
  const right = planTile(area, 'right');

  assertEqual(left.width, 960);
  // Brak szczeliny i braku nakładania: prawa połówka zaczyna się dokładnie tam,
  // gdzie kończy się lewa, a szerokości sumują się do szerokości obszaru roboczego.
  assertEqual(right.x, 960);
  assertEqual(right.width, 961);
  assertEqual(left.width + right.width, area.width);
  assertEqual(left.x + left.width, right.x);
});

test('planTile respects a monitor with a negative origin', () => {
  const area = { x: -1920, y: 40, width: 1920, height: 1040 };
  assertRect(planTile(area, 'left'), {
    x: -1920, y: 40, width: 960, height: 1040,
  });
  assertRect(planTile(area, 'right'), {
    x: -960, y: 40, width: 960, height: 1040,
  });
});

test('planTile handles a secondary monitor above the primary one', () => {
  const area = { x: 0, y: -1080, width: 2560, height: 1080 };
  assertRect(planTile(area, 'right'), {
    x: 1280, y: -1080, width: 1280, height: 1080,
  });
});

test('planTile keeps non-zero monitor coordinates and odd heights', () => {
  const area = { x: 2560, y: 0, width: 1367, height: 769 };
  const left = planTile(area, 'left');
  const right = planTile(area, 'right');

  assertEqual(left.x, 2560);
  assertEqual(left.width, 683);
  assertEqual(right.x, left.x + left.width);
  assertEqual(right.width, 684);
  assertEqual(left.width + right.width, 1367);
  assertEqual(left.height, 769);
  assertEqual(right.y, 0);
});

test('planTile tolerates zero-sized and invalid work areas', () => {
  assertRect(planTile({ x: 10, y: 20, width: 0, height: 0 }, 'right'), {
    x: 10, y: 20, width: 0, height: 0,
  });
  assertRect(planTile({ x: 5, y: 6, width: -10, height: -20 }, 'left'), {
    x: 5, y: 6, width: 0, height: 0,
  });
  assertRect(planTile(null, 'left'), {
    x: 0, y: 0, width: 0, height: 0,
  });
});

test('planCenter uses half of the work area by default', () => {
  assertRect(
    planCenter({ x: 100, y: 50, width: 1000, height: 800 }),
    { x: 350, y: 250, width: 500, height: 400 }
  );
});

test('planCenter honours explicit ratios and centres the remainder', () => {
  assertRect(
    planCenter(
      { x: -1000, y: 20, width: 1001, height: 701 },
      { widthRatio: 0.5, heightRatio: 0.5 }
    ),
    { x: -750, y: 195, width: 500, height: 350 }
  );
});

test('planCenter clamps ratios outside 0..1', () => {
  assertRect(
    planCenter(
      { x: 30, y: 40, width: 800, height: 600 },
      { widthRatio: 2, heightRatio: -1 }
    ),
    { x: 30, y: 340, width: 800, height: 0 }
  );
});

test('clampToWorkArea trims a rectangle crossing the left/top edges', () => {
  assertRect(
    clampToWorkArea(
      { x: -50, y: -20, width: 100, height: 100 },
      { x: 0, y: 0, width: 1000, height: 800 }
    ),
    { x: 0, y: 0, width: 50, height: 80 }
  );
});

test('clampToWorkArea keeps a rectangle inside a negative-origin monitor', () => {
  assertRect(
    clampToWorkArea(
      { x: -2100, y: -50, width: 300, height: 200 },
      { x: -1920, y: -100, width: 1920, height: 1080 }
    ),
    { x: -1920, y: -50, width: 120, height: 200 }
  );
});

test('clampToWorkArea collapses a fully outside rectangle at the edge', () => {
  const area = { x: 100, y: 100, width: 200, height: 200 };
  assertRect(
    clampToWorkArea({ x: 500, y: 500, width: 50, height: 50 }, area),
    { x: 300, y: 300, width: 0, height: 0 }
  );
});

test('clampToWorkArea returns the work area for a larger rectangle', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  assertRect(
    clampToWorkArea({ x: -10, y: -10, width: 3000, height: 2000 }, area),
    area
  );
});

test('enabled:false in the action model becomes an insensitive item', () => {
  const items = buildActionMenu({
    actions: {
      menu: [
        { id: 'tile-left', label: 'Przytnij w lewo', enabled: true, callback: () => {} },
        { id: 'close', label: 'Zamknij', enabled: false, callback: () => {} },
      ],
    },
  });

  assertEqual(items.length, 2);
  assertFalse(items[0].disabled);
  assertTrue(items[1].disabled);

  class FakeMenuItem {
    constructor(label) {
      this.label = label;
      this.sensitive = true;
      this.handlers = {};
    }

    connect(name, callback) {
      this.handlers[name] = callback;
      return 1;
    }

    setSensitive(sensitive) {
      this.sensitive = sensitive;
    }
  }

  class FakeMenu {
    constructor() {
      this.box = { add_style_class_name: () => {} };
      this.items = [];
      this.closed = false;
      this.actor = {
        handlers: {},
        connect(name, callback) {
          this.handlers[name] = callback;
          return 1;
        },
      };
    }

    addMenuItem(item) {
      this.items.push(item);
    }

    close() {
      this.closed = true;
    }
  }

  const created = createPopupActionMenu(
    { PopupMenu: FakeMenu, PopupMenuItem: FakeMenuItem },
    { Side: { TOP: 1 } },
    {},
    items
  );

  assertTrue(created.popupItems[0].sensitive);
  assertFalse(created.popupItems[1].sensitive);
  assertFalse(Boolean(created.popupItems[1].handlers.activate));
});

test('Escape is consumed by the action menu and does not reach the modal', () => {
  class FakeMenu {
    constructor() {
      this.closed = false;
    }

    close() {
      this.closed = true;
    }
  }

  const menu = new FakeMenu();
  const escape = handleActionMenuKeyPress(menu, { get_key_symbol: () => 0xff1b });
  assertTrue(escape, 'Escape should be handled by the menu');
  assertTrue(menu.closed, 'the popup should close');

  const other = new FakeMenu();
  const down = handleActionMenuKeyPress(other, { get_key_symbol: () => 0xff54 });
  assertFalse(down, 'other keys should propagate');
  assertFalse(other.closed, 'other keys must not close the popup');
});

run('window-actions.test.js');