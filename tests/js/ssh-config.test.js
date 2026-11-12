import {
  test, run, assertDeepEqual, assertEqual,
} from './harness.js';
import { parseSshConfig } from '../../lib/ssh-config.js';

test('a single host block exposes every requested field', () => {
  const config = [
    'Host prod',
    '  HostName prod.example.com',
    '  User deploy',
    '  Port 2222',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'prod',
    hostName: 'prod.example.com',
    user: 'deploy',
    port: 2222,
  }]);
});

test('several aliases on one Host line share the block options', () => {
  const config = [
    'Host web web-prod',
    '  HostName web.example.com',
    '  User www',
    '  Port 2200',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config).map(entry => entry.alias), [
    'web',
    'web-prod',
  ]);
  for (const entry of parseSshConfig(config)) {
    assertEqual(entry.hostName, 'web.example.com');
    assertEqual(entry.user, 'www');
    assertEqual(entry.port, 2200);
  }
});

test('missing HostName/User/Port fall back to alias, empty user and port 22', () => {
  assertDeepEqual(parseSshConfig('Host bastion\n'), [{
    alias: 'bastion',
    hostName: 'bastion',
    user: '',
    port: 22,
  }]);
});

test('comments, blank lines and inline comments are ignored', () => {
  const config = [
    '# leading comment',
    '',
    '   ',
    'Host dev # inline host comment',
    '  HostName dev.internal # inline option comment',
    '  Port 2022',
  ].join('\r\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'dev',
    hostName: 'dev.internal',
    user: '',
    port: 2022,
  }]);
});

test('Host * and wildcard patterns are skipped without leaking options', () => {
  const config = [
    'Host *',
    '  User root',
    '  Port 9999',
    'Host web',
    '  HostName web.example.com',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'web',
    hostName: 'web.example.com',
    user: '',
    port: 22,
  }]);
});

test('wildcard and negated aliases are skipped, concrete aliases survive', () => {
  const config = [
    'Host web *.internal !forbidden db?',
    '  HostName shared.example.com',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config).map(entry => entry.alias), ['web']);
});

test('the last value wins for repeated options and repeated Host blocks', () => {
  const config = [
    'Host prod',
    '  HostName old.example.com',
    '  User deploy',
    '  Port 2200',
    'Host prod',
    '  HostName new.example.com',
    '  Port 2222',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'prod',
    hostName: 'new.example.com',
    user: 'deploy',
    port: 2222,
  }]);
});

test('Match blocks never assign options to the preceding Host', () => {
  const config = [
    'Host keep',
    '  HostName keep.example.com',
    '  User keep-user',
    'Match host example.com',
    '  User conditional',
    '  Port 4444',
    'Host other',
    '  HostName other.example.com',
  ].join('\n');

  const parsed = parseSshConfig(config);
  assertDeepEqual(parsed.map(entry => entry.alias), ['keep', 'other']);
  assertEqual(parsed[0].user, 'keep-user');
  assertEqual(parsed[0].port, 22);
  assertEqual(parsed[1].user, '');
});

test('quoted values keep spaces and hash characters', () => {
  const config = [
    'Host quoted',
    '  HostName "prod#1.example.com"',
    '  User "deploy user"',
    '  Port 2222',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'quoted',
    hostName: 'prod#1.example.com',
    user: 'deploy user',
    port: 2222,
  }]);
});

test('keyword=value syntax is accepted like whitespace syntax', () => {
  const config = [
    'Host=equals',
    'HostName=equals.example.com',
    'User=deploy',
    'Port=2201',
  ].join('\n');

  assertDeepEqual(parseSshConfig(config), [{
    alias: 'equals',
    hostName: 'equals.example.com',
    user: 'deploy',
    port: 2201,
  }]);
});

test('invalid or empty input degrades to an empty list', () => {
  assertDeepEqual(parseSshConfig(''), []);
  assertDeepEqual(parseSshConfig(null), []);
  assertDeepEqual(parseSshConfig('Port 2222\nUser root\n'), []);
});

run('ssh-config.test.js');
