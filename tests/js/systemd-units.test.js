import {
  test, run, assertDeepEqual, assertEqual,
} from './harness.js';
import {
  formatUnitAction,
  rankUnits,
} from '../../lib/systemd-units.js';

function unit(name, description = '') {
  return {
    Name: name,
    Description: description,
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
  };
}

test('rankUnits matches the query in Name and Description case-insensitively', () => {
  const units = [
    unit('spotify.service', 'Muzyka'),
    unit('network.service', 'Spotify connect'),
    unit('other.service', 'Coś innego'),
  ];

  assertDeepEqual(
    rankUnits(units, 'SPOTIFY').map(entry => entry.Name),
    ['network.service', 'spotify.service']
  );
});

test('rankUnits sorts matched units by Name', () => {
  const units = [
    unit('zeta.service', 'spot'),
    unit('alpha.service', 'spot'),
    unit('middle.service', 'spot'),
  ];

  assertDeepEqual(
    rankUnits(units, 'spot').map(entry => entry.Name),
    ['alpha.service', 'middle.service', 'zeta.service']
  );
});

test('rankUnits removes duplicate names and keeps the first unit', () => {
  const first = unit('same.service', 'pierwszy');
  const second = unit('same.service', 'drugi');
  const parsed = rankUnits([first, second], '');

  assertEqual(parsed.length, 1);
  assertEqual(parsed[0], first);
});

test('rankUnits returns at most eight entries', () => {
  const units = Array.from({ length: 12 }, (_, index) =>
    unit(`unit-${String(index).padStart(2, '0')}.service`, 'spot'));
  const parsed = rankUnits(units, '');

  assertEqual(parsed.length, 8);
  assertEqual(parsed[0].Name, 'unit-00.service');
  assertEqual(parsed[7].Name, 'unit-07.service');
});

test('an empty query lists all valid units and defensive input is safe', () => {
  assertEqual(rankUnits([unit('b.service'), unit('a.service')], '').length, 2);
  assertDeepEqual(rankUnits(null, 'spot'), []);
  assertDeepEqual(rankUnits([null, {}, unit('')], 'spot'), []);
});

test('formatUnitAction builds the systemctl argv for every supported verb', () => {
  const service = unit('spotify.service');
  for (const verb of ['start', 'stop', 'restart', 'status']) {
    const action = formatUnitAction(service, verb);
    assertDeepEqual(action.argv, ['systemctl', '--user', verb, 'spotify.service']);
    assertEqual(typeof action.label, 'string');
    assertEqual(action.label.includes('spotify.service'), true);
  }
});

test('formatUnitAction rejects an unknown verb or a nameless unit', () => {
  assertEqual(formatUnitAction(unit('a.service'), 'enable'), null);
  assertEqual(formatUnitAction(unit(''), 'start'), null);
  assertEqual(formatUnitAction(null, 'start'), null);
});

run('systemd-units.test.js');
